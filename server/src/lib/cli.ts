import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { AIProvider } from '../shared/types.js';
import {
  imageAttachments,
  readImageBase64,
  type PreparedAttachment,
} from './uploads.js';

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

export interface CLIRunOptions {
  provider: AIProvider;
  model: string;
  prompt: string;
  attachments?: PreparedAttachment[];
  onChunk?: (text: string) => void;
  signal?: AbortSignal;
}

export interface CLIRunResult {
  text: string;
  exitCode: number;
}

export async function runCLI(opts: CLIRunOptions): Promise<CLIRunResult> {
  // Grok has no usable official CLI yet — use the xAI REST API instead.
  if (opts.provider === 'grok') {
    return runXAIChat(opts);
  }

  const { provider, prompt, onChunk, signal } = opts;
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

  // Build OpenAI-compatible messages. If there are images, switch to the
  // structured content array; otherwise pass the prompt as a plain string
  // (slightly cheaper to serialize).
  const images = imageAttachments(opts.attachments ?? []);
  let messages: unknown;
  if (images.length === 0) {
    messages = [{ role: 'user', content: opts.prompt }];
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
    messages = [{ role: 'user', content }];
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
        };
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) {
          fullText += delta;
          opts.onChunk?.(fullText);
        }
      } catch {
        // ignore malformed SSE chunks
      }
    }
  }

  return { text: fullText.trim(), exitCode: 0 };
}
