import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { AIProvider, ChatMode } from '../shared/types.js';
import {
  imageAttachments,
  readImageBase64,
  type PreparedAttachment,
} from './uploads.js';
import { usageStmts } from './db.js';

const CLI_BINARY: Record<AIProvider, string> = {
  claude: process.env.CLI_CLAUDE || 'claude',
  chatgpt: process.env.CLI_CODEX || 'codex',
  gemini: process.env.CLI_GEMINI || 'gemini',
  // grok unused — uses direct xAI API instead
  grok: 'unused',
};

const CLI_TIMEOUT_MS = parseInt(process.env.CLI_TIMEOUT_MS || '600000', 10);
const CLI_CWD = process.env.CLI_CWD || process.cwd();

function tempFile(prefix: string): string {
  return join(tmpdir(), `${prefix}-${randomBytes(8).toString('hex')}.txt`);
}

// Per-provider invocation strategy. CLIs are wildly inconsistent so we
// describe each one explicitly:
//   argv      — the command line to spawn (excluding the binary)
//   useStdin  — whether to pipe the prompt to stdin
//   finalize  — optional post-processor; if present, its return value is the
//               final text (we ignore stdout streaming) — used when a CLI
//               writes the clean response to a file we asked for.
interface ProviderConfig {
  argv: string[];
  useStdin: boolean;
  finalize?: () => Promise<string>;
  // If set, this is what we actually feed via stdin (overrides the prompt arg).
  promptOverride?: string;
}

// Render a CLI-friendly transcript header from the conversation history.
// Returns empty string if there's no history. This gets prepended to the
// prompt before we hand it off to the CLI binaries.
function renderHistoryPrefix(history: ChatHistoryTurn[] | undefined): string {
  if (!history || history.length === 0) return '';
  const lines: string[] = ['[Earlier turns in this conversation — for context]'];
  for (const t of history) {
    if (t.role === 'user') {
      lines.push(`User: ${t.content}`);
    } else {
      lines.push(`You: ${t.content}`);
    }
  }
  lines.push('[End of history]');
  lines.push('');
  lines.push('[New message]');
  lines.push('');
  return lines.join('\n');
}

function buildConfig(
  provider: AIProvider,
  model: string,
  prompt: string,
  attachments: PreparedAttachment[],
): ProviderConfig {
  const images = imageAttachments(attachments);

  switch (provider) {
    case 'claude': {
      // Claude Code: -p reads prompt from stdin, --add-dir gives the CLI
      // permission to read each upload directory so file paths embedded in
      // the prompt resolve. We prepend a header listing image paths so the
      // model knows where to look.
      const argv: string[] = ['-p', '--model', model, '--output-format', 'text'];
      const dirs = new Set<string>();
      for (const img of images) dirs.add(dirname(img.path));
      for (const d of dirs) argv.push('--add-dir', d);
      const header = images.length > 0
        ? '請查看以下圖片附件：\n' + images.map((i) => `- ${i.path}`).join('\n') + '\n\n'
        : '';
      return {
        argv,
        useStdin: true,
        promptOverride: header + prompt,
      };
    }

    case 'chatgpt': {
      // OpenAI Codex CLI: -i FILE attaches each image. PDF/text are already
      // inlined in the prompt by buildAttachmentPrefix.
      const outFile = tempFile('codex-out');
      const argv: string[] = [
        'exec',
        '--skip-git-repo-check',
        '--model',
        model,
        '--output-last-message',
        outFile,
      ];
      for (const img of images) argv.push('-i', img.path);
      return {
        argv,
        useStdin: true,
        finalize: async () => {
          try {
            const text = await fs.readFile(outFile, 'utf8');
            return text.trim();
          } finally {
            fs.unlink(outFile).catch(() => {});
          }
        },
      };
    }

    case 'gemini': {
      // Gemini CLI: --include-directories grants the workspace access to each
      // upload directory; we mention paths in the prompt so the model picks
      // them up.
      const argv: string[] = ['-m', model, '--skip-trust'];
      const dirs = new Set<string>();
      for (const img of images) dirs.add(dirname(img.path));
      if (dirs.size > 0) {
        argv.push('--include-directories', Array.from(dirs).join(','));
      }
      const header = images.length > 0
        ? '請查看以下圖片附件：\n' + images.map((i) => `- ${i.path}`).join('\n') + '\n\n'
        : '';
      argv.push('-p', header + prompt);
      return { argv, useStdin: false };
    }

    default:
      throw new Error(`unsupported CLI provider: ${provider}`);
  }
}

export interface ChatHistoryTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface CLIRunOptions {
  provider: AIProvider;
  model: string;
  prompt: string;
  attachments?: PreparedAttachment[];
  onChunk?: (text: string) => void;
  signal?: AbortSignal;
  // When set, runCLI persists a usage_log row on success so the admin
  // dashboard can show per-user / per-model totals.
  userId?: number;
  mode?: ChatMode;
  // Earlier turns of the same session for THIS provider. xAI gets these
  // as a real messages array; CLIs see a transcript prepended to the prompt.
  history?: ChatHistoryTurn[];
}

export interface CLIRunResult {
  text: string;
  exitCode: number;
}

// Heuristic — ~2 chars per token. The previous 3 chars/token figure was
// calibrated against English; this app's prompts are heavily Chinese,
// where 1 character is closer to 1 token (≈ 1.5–2). 2 sits in the
// middle for mixed CJK + markdown + code. Compared against the real
// xAI counts in usage_log this is much closer than 3 was.
function estimateTokens(chars: number): number {
  return Math.max(1, Math.round(chars / 2));
}

// Vision models charge ~1000–2000 tokens per attached image. Without
// this the CLI providers' estimates were drastically under-counting
// image-heavy turns vs Grok (which counts images in its real metering).
const IMAGE_TOKEN_BUDGET = 1500;

function recordUsage(
  opts: CLIRunOptions,
  promptChars: number,
  completionChars: number,
  realTokensIn: number | null,
  realTokensOut: number | null,
): void {
  if (!opts.userId) return;
  const isEstimated = realTokensIn === null || realTokensOut === null;
  const imageCount = imageAttachments(opts.attachments ?? []).length;
  const imageTokens = imageCount * IMAGE_TOKEN_BUDGET;
  const tokensIn =
    realTokensIn ?? estimateTokens(promptChars) + imageTokens;
  const tokensOut = realTokensOut ?? estimateTokens(completionChars);
  try {
    usageStmts.insert.run(
      opts.userId,
      opts.provider,
      opts.model,
      opts.mode ?? null,
      promptChars,
      completionChars,
      tokensIn,
      tokensOut,
      isEstimated ? 1 : 0,
    );
  } catch (err) {
    // Don't let usage logging break a real request.
    console.error('usage_log insert failed', (err as Error).message);
  }
}

export async function runCLI(opts: CLIRunOptions): Promise<CLIRunResult> {
  // Grok has no usable official CLI yet — use the xAI REST API instead.
  if (opts.provider === 'grok') {
    return runXAIChat(opts);
  }

  const { provider, onChunk, signal } = opts;
  // Prepend the conversation history (if any) so the CLI sees a
  // transcript before the new question. We do this here rather than in
  // buildConfig so the original `opts.prompt` stays untouched for usage
  // logging and so providers that need image headers add them on top.
  const historyPrefix = renderHistoryPrefix(opts.history);
  const prompt = historyPrefix + opts.prompt;
  const cfg = buildConfig(provider, opts.model, prompt, opts.attachments ?? []);
  const stdinPrompt = cfg.promptOverride ?? prompt;
  const bin = CLI_BINARY[provider];

  return new Promise<CLIRunResult>((resolve, reject) => {
    const child = spawn(bin, cfg.argv, {
      cwd: CLI_CWD,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let aborted = false;
    let lastEmittedLen = 0;

    const timer = setTimeout(() => {
      aborted = true;
      child.kill('SIGTERM');
      reject(new Error(`${provider} CLI timed out after ${CLI_TIMEOUT_MS}ms`));
    }, CLI_TIMEOUT_MS);

    if (signal) {
      const onAbort = () => {
        aborted = true;
        child.kill('SIGTERM');
        reject(new Error(`${provider} CLI aborted`));
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      // Stream live chunks only when the provider streams clean text on stdout.
      // Providers with a finalize step (codex) emit noise on stdout — skip it.
      if (!cfg.finalize && onChunk && stdout.length > lastEmittedLen) {
        onChunk(stdout);
        lastEmittedLen = stdout.length;
      }
    });

    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      if (!aborted) reject(new Error(`${provider} CLI spawn failed: ${err.message}`));
    });

    child.on('close', async (code) => {
      clearTimeout(timer);
      if (aborted) return;
      if (code !== 0) {
        const tail = stderr.trim().slice(-500) || stdout.slice(-500);
        reject(new Error(`${provider} CLI exited ${code}: ${tail}`));
        return;
      }
      try {
        const text = cfg.finalize ? await cfg.finalize() : stdout.trim();
        // Surface one final chunk so the SSE stream gets the assembled response
        // for non-streaming providers.
        if (cfg.finalize && onChunk) onChunk(text);
        recordUsage(opts, prompt.length, text.length, null, null);
        resolve({ text, exitCode: code ?? 0 });
      } catch (err) {
        reject(err as Error);
      }
    });

    if (cfg.useStdin) {
      child.stdin.write(stdinPrompt);
    }
    child.stdin.end();
  });
}

// xAI's Chat Completions API is OpenAI-compatible. We hit it directly because
// xAI hasn't shipped an official Grok CLI yet.
async function runXAIChat(opts: CLIRunOptions): Promise<CLIRunResult> {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) {
    throw new Error('XAI_API_KEY is not set in server/.env');
  }

  // Build OpenAI-compatible messages. xAI accepts a proper multi-turn
  // messages array, so we feed the conversation history as real
  // user/assistant turns rather than baking it into a prompt prefix.
  const images = imageAttachments(opts.attachments ?? []);
  const history = opts.history ?? [];
  const messages: Array<unknown> = history.map((t) => ({
    role: t.role,
    content: t.content,
  }));
  if (images.length === 0) {
    messages.push({ role: 'user', content: opts.prompt });
  } else {
    const content: Array<
      | { type: 'text'; text: string }
      | { type: 'image_url'; image_url: { url: string } }
    > = [{ type: 'text', text: opts.prompt }];
    for (const img of images) {
      const { mediaType, data } = readImageBase64(img);
      content.push({
        type: 'image_url',
        image_url: { url: `data:${mediaType};base64,${data}` },
      });
    }
    messages.push({ role: 'user', content });
  }

  const response = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: opts.model,
      messages,
      stream: true,
      // Ask xAI to include real token counts in the final SSE chunk so
      // we can record exact usage instead of estimating.
      stream_options: { include_usage: true },
    }),
    signal: opts.signal,
  });

  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => '');
    throw new Error(`xAI API ${response.status}: ${text || response.statusText}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';
  let promptTokens: number | null = null;
  let completionTokens: number | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let lineEnd: number;
    while ((lineEnd = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, lineEnd).trim();
      buffer = buffer.slice(lineEnd + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const json = JSON.parse(data) as {
          choices?: Array<{ delta?: { content?: string } }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) {
          fullText += delta;
          opts.onChunk?.(fullText);
        }
        if (json.usage) {
          if (typeof json.usage.prompt_tokens === 'number') {
            promptTokens = json.usage.prompt_tokens;
          }
          if (typeof json.usage.completion_tokens === 'number') {
            completionTokens = json.usage.completion_tokens;
          }
        }
      } catch {
        // ignore malformed SSE chunks
      }
    }
  }

  const finalText = fullText.trim();
  recordUsage(
    opts,
    opts.prompt.length,
    finalText.length,
    promptTokens,
    completionTokens,
  );
  return { text: finalText, exitCode: 0 };
}
