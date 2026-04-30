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
// Kill the CLI if it produces no stdout for this many ms. Two failure modes
// to balance against:
//   - Gemini-style infinite 429-retry loops (silent forever) — want to
//     fail fast so fallback kicks in.
//   - Claude Code CLI doing WebSearch/WebFetch — Anthropic's hosted tools
//     are slow and the CLI emits NOTHING to stdout while waiting on each
//     search call. A research-heavy turn can chain 2-3 of these.
// 180s gives Claude room to chain slow web searches without killing the
// run, while still bounded enough that genuinely-stuck CLIs surface
// within 3 minutes. Override via env if your fan-out differs.
const CLI_STALL_MS = parseInt(process.env.CLI_STALL_MS || '180000', 10);
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
      // the prompt resolve.
      //
      // --tools needs to ENABLE WebSearch / WebFetch — they are NOT in the
      // default tool set, even though `--allowedTools` would auto-approve
      // them once enabled. Verified against `claude -p` 2.1.x: without
      // listing them in --tools the model literally doesn't see web
      // tools in its catalog and refuses to search. Read/Glob/Grep stay
      // in the list so attachment handling still works.
      // --allowedTools then pre-approves the web tools so headless mode
      // doesn't pause for permission.
      const argv: string[] = [
        '-p',
        '--model',
        model,
        '--output-format',
        'text',
        '--tools',
        'WebSearch WebFetch Read Glob Grep',
        '--allowedTools',
        'WebSearch WebFetch',
      ];
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
      // them up. --approval-mode yolo auto-approves all tools, including
      // GoogleSearch / WebFetch, so the model can browse without an
      // interactive prompt blocking the headless run.
      const argv: string[] = ['-m', model, '--skip-trust', '--approval-mode', 'yolo'];
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
  // User's UI language. Used by direct-API providers to inject a system
  // prompt that locks reply language (gpt-4o-mini in particular tends to
  // drift to Simplified Chinese without explicit instruction). The CLI
  // path ignores this — Claude Code / Codex / Gemini CLIs already handle
  // language detection on their own.
  lang?: 'zh-TW' | 'en';
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
      1,
      null,
      opts.model,
    );
  } catch (err) {
    // Don't let usage logging break a real request.
    console.error('usage_log insert failed', (err as Error).message);
  }
}

// Log a failed call attempt. We don't know real token counts, so output
// columns stay 0 and is_estimated=1. error_code is a short tag like
// "429", "timeout", or "spawn_failed" — enough to drive the admin
// success-rate dashboard without leaking long error strings.
export function recordCallFailure(args: {
  userId?: number;
  provider: AIProvider;
  model: string;
  // The originally-requested model (without any "claude_api:" / "openrouter:"
  // prefix). Used by the user-facing /usage view to keep fallbacks invisible.
  // Defaults to `model` for callers that don't separate the two yet.
  requestedModel?: string;
  mode?: ChatMode;
  promptChars: number;
  errorCode: string;
}): void {
  if (!args.userId) return;
  try {
    usageStmts.insert.run(
      args.userId,
      args.provider,
      args.model,
      args.mode ?? null,
      args.promptChars,
      0,
      null,
      null,
      1,
      0,
      args.errorCode.slice(0, 60),
      args.requestedModel ?? args.model,
    );
  } catch (err) {
    console.error('usage_log failure insert failed', (err as Error).message);
  }
}

// Bucket a raw error message into a short code for the dashboard.
export function classifyError(err: unknown): string {
  const msg = (err as Error)?.message ?? String(err);
  const m = msg.toLowerCase();
  if (m.includes('429') || m.includes('rate limit') || m.includes('quota')) return '429';
  if (m.includes('timeout') || m.includes('timed out') || m.includes('etimedout')) return 'timeout';
  if (m.includes('aborted')) return 'aborted';
  if (m.match(/\b5\d{2}\b/)) return '5xx';
  if (m.includes('401') || m.includes('unauthorized')) return '401';
  if (m.includes('403') || m.includes('forbidden')) return '403';
  if (m.includes('enoent') || m.includes('spawn')) return 'spawn_failed';
  if (m.includes('network') || m.includes('econnrefused') || m.includes('econnreset')) return 'network';
  return 'other';
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

    // Stall watchdog — reset every time the CLI emits stdout. If a streaming
    // provider sits silent for CLI_STALL_MS we kill it so the orchestrator
    // can fall back. Skipped for finalize-style providers (codex) which
    // legitimately produce no streaming stdout for the whole run.
    const stallEnabled = !cfg.finalize;
    let stallTimer: NodeJS.Timeout | null = null;
    const bumpStall = () => {
      if (!stallEnabled) return;
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        aborted = true;
        child.kill('SIGTERM');
        reject(new Error(`${provider} CLI timed out (no output for ${CLI_STALL_MS}ms)`));
      }, CLI_STALL_MS);
    };
    bumpStall();

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
      bumpStall();
      // Stream live chunks only when the provider streams clean text on stdout.
      // Providers with a finalize step (codex) emit noise on stdout — skip it.
      if (!cfg.finalize && onChunk && stdout.length > lastEmittedLen) {
        onChunk(stdout);
        lastEmittedLen = stdout.length;
      }
    });

    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
      // stderr does NOT bump stall — providers like Gemini print 429 retry
      // chatter to stderr forever, and bumping here would defeat the watchdog.
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      if (stallTimer) clearTimeout(stallTimer);
      if (!aborted) reject(new Error(`${provider} CLI spawn failed: ${err.message}`));
    });

    child.on('close', async (code) => {
      clearTimeout(timer);
      if (stallTimer) clearTimeout(stallTimer);
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

// xAI Chat Completions API — OpenAI-compatible. We use it directly because
// xAI hasn't shipped an official Grok CLI yet. Includes a tool-calling
// loop wired to our self-hosted SearXNG so Grok can search the web,
// replacing the deprecated Live Search feature.

import { formatSearchResults, webSearch } from './webSearch.js';

interface XAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface XAIRoundResult {
  text: string;
  toolCalls: XAIToolCall[];
  promptTokens: number | null;
  completionTokens: number | null;
}

const WEB_SEARCH_TOOL = {
  type: 'function' as const,
  function: {
    name: 'web_search',
    description:
      'Search the web for current information when the answer requires up-to-date facts (news, prices, schedules, recent events, anything past the model training cutoff). Returns a numbered list of pages with title, URL, and snippet.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query, in the language most likely to find good results.',
        },
      },
      required: ['query'],
    },
  },
};

const MAX_TOOL_ITERATIONS = 4;

// One streaming round-trip to xAI. Accumulates content deltas (which we
// forward to onChunk) and tool_call deltas (assembled across the stream
// because xAI sends function.arguments piecewise). Returns whichever the
// model produced — content for a final answer, tool_calls when it wants
// us to run a tool.
async function streamXAIRound(
  apiKey: string,
  messages: unknown[],
  tools: unknown[],
  opts: CLIRunOptions,
): Promise<XAIRoundResult> {
  const response = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: opts.model,
      messages,
      tools,
      stream: true,
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
  let roundText = '';
  let promptTokens: number | null = null;
  let completionTokens: number | null = null;

  // Tool-call deltas come keyed by an `index` and arrive piecewise:
  // first an entry with id + function.name, then function.arguments
  // streamed in chunks. Stitch them back together by index.
  const toolBuilder: Record<
    number,
    { id: string; name: string; arguments: string }
  > = {};

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
          choices?: Array<{
            delta?: {
              content?: string;
              tool_calls?: Array<{
                index?: number;
                id?: string;
                function?: { name?: string; arguments?: string };
              }>;
            };
          }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        const delta = json.choices?.[0]?.delta;
        if (delta?.content) {
          roundText += delta.content;
          // Forward the running round text so the streaming UI updates
          // live. Tool-call-only iterations produce no content so this
          // is silent until the model writes an actual answer.
          opts.onChunk?.(roundText);
        }
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            const slot = toolBuilder[idx] ?? { id: '', name: '', arguments: '' };
            if (tc.id) slot.id = tc.id;
            if (tc.function?.name) slot.name = tc.function.name;
            if (tc.function?.arguments) slot.arguments += tc.function.arguments;
            toolBuilder[idx] = slot;
          }
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

  const toolCalls: XAIToolCall[] = Object.entries(toolBuilder)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([, slot]) => ({
      id: slot.id || `call-${Math.random().toString(36).slice(2, 10)}`,
      type: 'function',
      function: { name: slot.name, arguments: slot.arguments },
    }));

  return { text: roundText, toolCalls, promptTokens, completionTokens };
}

async function runXAIChat(opts: CLIRunOptions): Promise<CLIRunResult> {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) {
    throw new Error('XAI_API_KEY is not set in server/.env');
  }

  // Build the initial message list: history + current user msg (with
  // any image attachments inlined as base64).
  const images = imageAttachments(opts.attachments ?? []);
  const history = opts.history ?? [];
  const messages: unknown[] = history.map((t) => ({
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

  const tools = [WEB_SEARCH_TOOL];
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let sawRealTokens = false;
  let finalText = '';

  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    // Last iteration runs WITHOUT tools so the model is forced to write
    // a final text answer instead of asking for yet another search and
    // returning empty when the budget runs out.
    const isLast = iter === MAX_TOOL_ITERATIONS - 1;
    const roundTools = isLast ? [] : tools;
    const round = await streamXAIRound(apiKey, messages, roundTools, opts);
    if (round.promptTokens !== null) {
      totalPromptTokens += round.promptTokens;
      sawRealTokens = true;
    }
    if (round.completionTokens !== null) {
      totalCompletionTokens += round.completionTokens;
      sawRealTokens = true;
    }

    if (round.toolCalls.length === 0 || isLast) {
      // Final answer reached (or forced on the no-tools last round).
      finalText = round.text.trim();
      break;
    }

    // Push the assistant's tool-call request, then resolve each call by
    // running our SearXNG-backed search and feeding the formatted
    // results back as a `tool` message.
    messages.push({
      role: 'assistant',
      content: round.text || null,
      tool_calls: round.toolCalls,
    });

    for (const tc of round.toolCalls) {
      let result: string;
      try {
        const args = JSON.parse(tc.function.arguments || '{}') as {
          query?: string;
        };
        const query = (args.query ?? '').trim();
        if (!query) {
          result = '(empty query)';
        } else if (tc.function.name === 'web_search') {
          const hits = await webSearch(query, 5, opts.signal);
          result = formatSearchResults(query, hits);
        } else {
          result = `(unknown tool: ${tc.function.name})`;
        }
      } catch (err) {
        result = `Search failed: ${(err as Error).message}`;
      }
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: result,
      });
    }
  }

  recordUsage(
    opts,
    opts.prompt.length,
    finalText.length,
    sawRealTokens ? totalPromptTokens : null,
    sawRealTokens ? totalCompletionTokens : null,
  );
  return { text: finalText, exitCode: 0 };
}
