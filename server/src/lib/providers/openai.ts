// Direct OpenAI Chat Completions API client. The trick here is that the
// user's tier_models lists ChatGPT-account-only SKUs (gpt-5.4-mini, gpt-5.4,
// gpt-5.5) which the official OpenAI API does NOT serve — those are exclusive
// to the Codex CLI's ChatGPT auth path. So we map them to the closest GA
// model on the direct API. The user-visible name in the UI doesn't change;
// only the actual model that answered does.
//
// Tool calling: function-style web_search backed by our SearXNG. Same
// pattern as the xAI loop in cli.ts — model can request searches, we
// execute, feed results back, up to MAX_TOOL_ITERATIONS rounds.
//
// Docs: https://platform.openai.com/docs/api-reference/chat/streaming

import type { CLIRunOptions, CLIRunResult } from '../cli.js';
import { imageAttachments, readImageBase64 } from '../uploads.js';
import { languageSystemPrompt } from './openrouter.js';
import {
  MAX_TOOL_ITERATIONS,
  TOOL_DESCRIPTION,
  TOOL_NAME,
  TOOL_PARAMETER_SCHEMA,
  runWebSearchCall,
} from './webSearchTool.js';

interface OpenAIResult extends CLIRunResult {
  promptTokens: number | null;
  completionTokens: number | null;
  modelUsed: string;
}

// Earlier we mapped gpt-5.5 / gpt-5.4 / gpt-5.4-mini → gpt-4o family
// because the Codex CLI hits a "model not supported when using Codex
// with a ChatGPT account" error on those SKUs. That restriction is
// CLI-side only — the *direct* OpenAI API at api.openai.com serves
// gpt-5.x just fine with a regular API key. So no mapping needed any
// more; we pass the user's choice through verbatim and let the API
// 4xx-on-unknown trigger normal fallback if a SKU truly doesn't exist.
const OPENAI_API_MODEL_MAP: Record<string, string> = {};

function resolveOpenAIModel(model: string): string {
  return OPENAI_API_MODEL_MAP[model] ?? model;
}

const WEB_SEARCH_TOOL = {
  type: 'function' as const,
  function: {
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    parameters: TOOL_PARAMETER_SCHEMA,
  },
};

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface OpenAIRoundResult {
  text: string;
  toolCalls: OpenAIToolCall[];
  promptTokens: number | null;
  completionTokens: number | null;
}

async function streamOpenAIRound(
  apiKey: string,
  apiModel: string,
  messages: unknown[],
  opts: CLIRunOptions,
): Promise<OpenAIRoundResult> {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: apiModel,
      messages,
      tools: [WEB_SEARCH_TOOL],
      stream: true,
      stream_options: { include_usage: true },
    }),
    signal: opts.signal,
  });

  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => '');
    throw new Error(`OpenAI ${response.status}: ${text || response.statusText}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let runningText = '';
  let promptTokens: number | null = null;
  let completionTokens: number | null = null;

  // Tool-call deltas come keyed by `index` and are streamed piecewise —
  // assemble them as they arrive.
  const toolBuilder: Record<number, { id: string; name: string; arguments: string }> = {};

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
          runningText += delta.content;
          opts.onChunk?.(runningText);
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
        if (typeof json.usage?.prompt_tokens === 'number') {
          promptTokens = json.usage.prompt_tokens;
        }
        if (typeof json.usage?.completion_tokens === 'number') {
          completionTokens = json.usage.completion_tokens;
        }
      } catch {
        // ignore malformed bytes
      }
    }
  }

  const toolCalls: OpenAIToolCall[] = Object.entries(toolBuilder)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([, slot]) => ({
      id: slot.id || `call-${Math.random().toString(36).slice(2, 10)}`,
      type: 'function',
      function: { name: slot.name, arguments: slot.arguments },
    }));

  return { text: runningText, toolCalls, promptTokens, completionTokens };
}

export async function runOpenAI(opts: CLIRunOptions): Promise<OpenAIResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not set in server/.env');
  }
  const apiModel = resolveOpenAIModel(opts.model);

  const history = opts.history ?? [];
  const messages: unknown[] = [];
  const sysPrompt = languageSystemPrompt(opts.lang);
  if (sysPrompt) messages.push({ role: 'system', content: sysPrompt });
  for (const t of history) {
    messages.push({ role: t.role, content: t.content });
  }

  const images = imageAttachments(opts.attachments ?? []);
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

  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let sawRealTokens = false;
  let finalText = '';

  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    const round = await streamOpenAIRound(apiKey, apiModel, messages, opts);
    if (round.promptTokens !== null) {
      totalPromptTokens += round.promptTokens;
      sawRealTokens = true;
    }
    if (round.completionTokens !== null) {
      totalCompletionTokens += round.completionTokens;
      sawRealTokens = true;
    }

    if (round.toolCalls.length === 0) {
      finalText = round.text.trim();
      break;
    }

    messages.push({
      role: 'assistant',
      content: round.text || null,
      tool_calls: round.toolCalls,
    });

    for (const tc of round.toolCalls) {
      const result =
        tc.function.name === TOOL_NAME
          ? await runWebSearchCall(tc.function.arguments, opts.signal)
          : `(unknown tool: ${tc.function.name})`;
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: result,
      });
    }
  }

  return {
    text: finalText,
    exitCode: 0,
    promptTokens: sawRealTokens ? totalPromptTokens : null,
    completionTokens: sawRealTokens ? totalCompletionTokens : null,
    modelUsed: apiModel,
  };
}
