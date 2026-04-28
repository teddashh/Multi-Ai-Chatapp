// Probe every model in TIER_MODELS with a tiny "say hi" prompt and
// report which ones actually work. Use this after vendor model lists
// drift (new releases, deprecations, etc).
//
// Usage:
//   npm run models:test          # all unique models across all tiers
//   npm run models:test -- grok  # just one provider
//
// Each model gets ~30s before it's considered hung.

import { runCLI } from '../lib/cli.js';
import { TIER_MODELS } from '../shared/models.js';
import type { AIProvider } from '../shared/types.js';

const PROVIDERS: AIProvider[] = ['claude', 'chatgpt', 'gemini', 'grok'];
const PROBE_TIMEOUT_MS = 30_000;
const PROBE_PROMPT = 'Reply with just the word OK.';

interface ProbeResult {
  provider: AIProvider;
  model: string;
  ok: boolean;
  ms: number;
  detail: string;
}

function uniqueModelsByProvider(): Map<AIProvider, string[]> {
  const out = new Map<AIProvider, Set<string>>();
  for (const tier of Object.values(TIER_MODELS)) {
    for (const provider of PROVIDERS) {
      const set = out.get(provider) ?? new Set<string>();
      for (const m of tier[provider].options) set.add(m);
      out.set(provider, set);
    }
  }
  return new Map(
    [...out.entries()].map(([p, s]) => [p, [...s].sort()]),
  );
}

async function probe(provider: AIProvider, model: string): Promise<ProbeResult> {
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const result = await runCLI({
      provider,
      model,
      prompt: PROBE_PROMPT,
      signal: ctrl.signal,
    });
    return {
      provider,
      model,
      ok: true,
      ms: Date.now() - started,
      detail: result.text.slice(0, 60).replace(/\s+/g, ' '),
    };
  } catch (err) {
    return {
      provider,
      model,
      ok: false,
      ms: Date.now() - started,
      detail: (err as Error).message.slice(0, 240),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  const filter = (process.argv[2] ?? '').toLowerCase();
  const allowed: AIProvider[] = filter
    ? (PROVIDERS.filter((p) => p === filter) as AIProvider[])
    : PROVIDERS;
  if (filter && allowed.length === 0) {
    console.error(`unknown provider filter: ${filter}`);
    console.error(`expected one of: ${PROVIDERS.join(', ')}`);
    process.exit(1);
  }

  const byProvider = uniqueModelsByProvider();
  const results: ProbeResult[] = [];
  for (const provider of allowed) {
    const models = byProvider.get(provider) ?? [];
    console.log(`\n=== ${provider} (${models.length} models) ===`);
    for (const model of models) {
      process.stdout.write(`  ${model.padEnd(40)} ... `);
      const r = await probe(provider, model);
      results.push(r);
      const tag = r.ok ? 'OK ' : 'FAIL';
      console.log(`${tag}  ${(r.ms / 1000).toFixed(1)}s  ${r.detail}`);
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(
    `\nSummary: ${results.length - failed.length}/${results.length} OK`,
  );
  if (failed.length > 0) {
    console.log('\nFailing models — drop from TIER_MODELS or check creds:');
    for (const r of failed) {
      console.log(`  ${r.provider} / ${r.model}`);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
