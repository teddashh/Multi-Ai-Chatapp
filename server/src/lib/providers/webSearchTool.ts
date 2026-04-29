// Shared web_search tool definition + executor. Each direct-API provider
// (Anthropic, OpenAI, Gemini, xAI) translates the schema below into its
// own tool-call format, but they all execute the same SearXNG-backed
// search via runWebSearchCall(). Keeps the prompt-engineering description
// identical across vendors so each AI persona has the same idea of when
// it should reach for the tool.

import { formatSearchResults, webSearch } from '../webSearch.js';

export const TOOL_NAME = 'web_search';

export const TOOL_DESCRIPTION =
  'Search the web for current information when the answer requires up-to-date facts ' +
  '(news, prices, schedules, recent events, anything past your training cutoff). ' +
  'Returns a numbered list of pages with title, URL, and snippet.';

// JSON Schema shared by every vendor whose tool format expects it
// (Anthropic input_schema, OpenAI function.parameters). Gemini's
// functionDeclarations.parameters takes the same shape.
export const TOOL_PARAMETER_SCHEMA = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description: 'Search query, in the language most likely to find good results.',
    },
  },
  required: ['query'],
} as const;

// Cap how many tool-call rounds we'll allow per turn. Guards against a
// pathological loop where the model keeps asking for more searches.
// Each provider's loop runs (MAX_TOOL_ITERATIONS - 1) tool rounds at most,
// then forces one final round WITHOUT tools so the model must commit
// to a text answer instead of returning empty when the budget runs out.
export const MAX_TOOL_ITERATIONS = 4;

// Run a single web_search invocation. `args` is whatever the model emits
// for the tool's input — either a parsed object (Gemini) or a JSON
// string (Anthropic / OpenAI / xAI). Returns the text we feed back as
// the tool result.
export async function runWebSearchCall(
  args: string | Record<string, unknown> | undefined,
  signal?: AbortSignal,
): Promise<string> {
  let parsed: { query?: string } = {};
  try {
    if (typeof args === 'string') {
      parsed = args ? (JSON.parse(args) as { query?: string }) : {};
    } else if (args && typeof args === 'object') {
      parsed = args as { query?: string };
    }
  } catch {
    return 'Search failed: malformed tool arguments';
  }
  const query = (parsed.query ?? '').trim();
  if (!query) return '(empty query)';
  try {
    const hits = await webSearch(query, 5, signal);
    return formatSearchResults(query, hits);
  } catch (err) {
    return `Search failed: ${(err as Error).message}`;
  }
}
