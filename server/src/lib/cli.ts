import { spawn } from 'node:child_process';
import type { AIProvider } from '../shared/types.js';

const CLI_BINARY: Record<AIProvider, string> = {
  claude: process.env.CLI_CLAUDE || 'claude',
  chatgpt: process.env.CLI_CODEX || 'codex',
  gemini: process.env.CLI_GEMINI || 'gemini',
  grok: process.env.CLI_GROK || 'grok',
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
