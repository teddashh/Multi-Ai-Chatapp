import { spawn } from 'node:child_process';
import type { AIProvider } from '../shared/types.js';

const CLI_BINARY: Record<AIProvider, string> = {
  claude: process.env.CLI_CLAUDE || 'claude',
  chatgpt: process.env.CLI_CODEX || 'codex',
  gemini: process.env.CLI_GEMINI || 'gemini',
  // grok unused — uses direct xAI API instead
  grok: 'unused',
};

const CLI_TIMEOUT_MS = parseInt(process.env.CLI_TIMEOUT_MS || '600000', 10);
const CLI_CWD = process.env.CLI_CWD || process.cwd();

// Build the argv for a given provider. The CLIs differ in flags; if any vendor
// changes their CLI surface, this is the single place to tweak.
function buildArgs(provider: AIProvider, model: string): string[] {
  switch (provider) {
    case 'claude':
      // Anthropic Claude Code: -p prompt, --model, text output by default
      return ['-p', '--model', model, '--output-format', 'text'];
    case 'chatgpt':
      // OpenAI Codex CLI: `codex exec` for one-shot, model via --model
      return ['exec', '--model', model, '--quiet'];
    case 'gemini':
      // Google Gemini CLI: -p for prompt mode, -m for model
      return ['-m', model, '-p'];
    case 'grok':
      // xAI Grok CLI (SuperGrok): non-interactive run
      return ['exec', '--model', model];
  }
}

// Some CLIs prefer the prompt as a positional arg; others read it from stdin.
// We pipe it via stdin to avoid shell-escaping issues with multi-line prompts.
const SEND_VIA_STDIN: Record<AIProvider, boolean> = {
  claude: true,
  chatgpt: true,
  gemini: true,
  grok: true,
};

export interface CLIRunOptions {
  provider: AIProvider;
  model: string;
  prompt: string;
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

  const { provider, model, prompt, onChunk, signal } = opts;
  const bin = CLI_BINARY[provider];
  const args = buildArgs(provider, model);

  return new Promise<CLIRunResult>((resolve, reject) => {
    const child = spawn(bin, args, {
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
      // Stream incremental progress to the caller
      if (onChunk && stdout.length > lastEmittedLen) {
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

    child.on('close', (code) => {
      clearTimeout(timer);
      if (aborted) return;
      if (code !== 0) {
        const tail = stderr.trim().slice(-500) || stdout.slice(-500);
        reject(new Error(`${provider} CLI exited ${code}: ${tail}`));
        return;
      }
      resolve({ text: stdout.trim(), exitCode: code ?? 0 });
    });

    if (SEND_VIA_STDIN[provider]) {
      child.stdin.write(prompt);
      child.stdin.end();
    }
  });
}

// xAI's Chat Completions API is OpenAI-compatible. We hit it directly because
// xAI hasn't shipped an official Grok CLI yet.
async function runXAIChat(opts: CLIRunOptions): Promise<CLIRunResult> {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) {
    throw new Error('XAI_API_KEY is not set in server/.env');
  }

  const response = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: opts.model,
      messages: [{ role: 'user', content: opts.prompt }],
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
