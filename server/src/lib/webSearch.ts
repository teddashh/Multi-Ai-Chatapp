// Web search backed by a self-hosted SearXNG instance. SearXNG aggregates
// Google / Bing / DuckDuckGo etc. into a single JSON endpoint, no API key
// or per-query cost. Used by the Grok tool-calling loop in cli.ts; could
// later back a Codex shim too.

export interface SearchResult {
  title: string;
  url: string;
  content: string;
}

interface RawResult {
  title?: string;
  url?: string;
  content?: string;
}

const SEARCH_TIMEOUT_MS = 8000;

export async function webSearch(
  query: string,
  maxResults = 5,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  const base = (process.env.SEARXNG_URL || 'http://localhost:8888').replace(/\/$/, '');
  const url = `${base}/search?q=${encodeURIComponent(query)}&format=json&safesearch=0`;

  // Internal timeout independent of the parent abort signal so a slow
  // SearXNG can't stall the whole xAI tool-call loop.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SEARCH_TIMEOUT_MS);
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener('abort', () => ctrl.abort(), { once: true });
  }

  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) {
      throw new Error(`SearXNG returned ${res.status}`);
    }
    const data = (await res.json()) as { results?: RawResult[] };
    return (data.results ?? [])
      .slice(0, maxResults)
      .map((r) => ({
        title: (r.title ?? '').trim(),
        url: (r.url ?? '').trim(),
        content: (r.content ?? '').trim(),
      }));
  } finally {
    clearTimeout(timer);
  }
}

// Pretty-print results for handing back to the model. Numbered list with
// title, url, snippet — short enough that even 5 results stay well under
// any context limit.
export function formatSearchResults(
  query: string,
  results: SearchResult[],
): string {
  if (results.length === 0) {
    return `No results found for "${query}".`;
  }
  const lines = [`Search results for "${query}":`, ''];
  results.forEach((r, i) => {
    lines.push(`${i + 1}. ${r.title || '(untitled)'} — ${r.url}`);
    if (r.content) lines.push(`   ${r.content}`);
    lines.push('');
  });
  return lines.join('\n').trim();
}
