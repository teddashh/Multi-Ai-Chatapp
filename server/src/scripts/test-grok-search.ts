// Smoke test: hit Grok with a question that REQUIRES the web_search
// tool (something past the training cutoff). Confirms the tool-calling
// loop in runXAIChat actually calls SearXNG and feeds results back.
//
// Usage:  npm run grok:search-test [-- "your question"]

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function loadDotEnv(path: string): void {
  let raw: string;
  try { raw = readFileSync(path, 'utf8'); } catch { return; }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadDotEnv(resolve(process.cwd(), '.env'));

import { runCLI } from '../lib/cli.js';

const question =
  process.argv[2] ??
  'What is the most recent stable version of Node.js? Use web_search to find out.';

console.log('Q:', question);
console.log('Streaming...');
const result = await runCLI({
  provider: 'grok',
  model: 'grok-4-1-fast-non-reasoning',
  prompt: question,
  onChunk: () => process.stdout.write('.'),
});
console.log('\n--- ANSWER ---');
console.log(result.text);
