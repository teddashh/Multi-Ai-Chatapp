// OpenRouter fallback client. Used by orchestrator.runOne when the primary
// path (CLI in dev, original API in prod) fails with a transient error
// (429 / 5xx / timeout / network). User-facing UX hides this completely —
// the chat bubble just keeps streaming as if the original model wrote it.
//
// Same-family selection follows the user's preference: free where it
// exists, otherwise the cheapest paid SKU from the same vendor on OR.
//
// API: OpenAI-compatible Chat Completions, https://openrouter.ai/api/v1/chat/completions

import type { CLIRunOptions, CLIRunResult } from '../cli.js';
import type { AIProvider } from '../../shared/types.js';
import { imageAttachments, readImageBase64 } from '../uploads.js';

// Per-family fallback model. Picked for "cheap, reliable, same vendor".
// The user never sees these names — they just see the original provider's
// avatar and the streamed text. Edit this map to tune cost/quality.
const OPENROUTER_FALLBACK_MODEL: Record<AIProvider, string> = {
  // Anthropic has no free tier on OR; Haiku is the cheapest Claude.
  claude: 'anthropic/claude-3-haiku',
  // OpenAI cheapest GA model.
  chatgpt: 'openai/gpt-4o-mini',
  // Gemini DOES have a free option on OR; spend nothing first, fall to
  // paid if the free quota is exhausted (handled via OR's `models` array).
  gemini: 'google/gemini-2.0-flash-exp:free',
  // xAI on OR — no free, grok-2-1212 is the cheapest current Grok SKU.
  grok: 'x-ai/grok-2-1212',
};

// OR `models` array is tried in order if the primary `model` 4xx/5xx's.
// Only set for families where we have a "try free, then paid" plan.
const OPENROUTER_MODEL_FALLBACKS: Partial<Record<AIProvider, string[]>> = {
  gemini: ['google/gemini-2.0-flash-exp:free', 'google/gemini-flash-1.5-8b'],
};

export function fallbackModelFor(provider: AIProvider): string {
  return OPENROUTER_FALLBACK_MODEL[provider];
}

interface ORDelta {
  choices?: Array<{ delta?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export async function runOpenRouter(
  opts: CLIRunOptions,
): Promise<CLIRunResult & { promptTokens: number | null; completionTokens: number | null; modelUsed: string }> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY is not set in server/.env');
  }

  const provider = opts.provider;
  const model = fallbackModelFor(provider);
  const fallbacks = OPENROUTER_MODEL_FALLBACKS[provider];

  // Convert per-provider history (turn array) into messages. CLI providers
  // were getting it as a prepended transcript inside the prompt, but for an
  // OpenAI-compatible API we can pass a real messages array instead — better
  // context handling for the fallback model.
  const history = opts.history ?? [];
  const messages: unknown[] = history.map((t) => ({
    role: t.role,
    content: t.content,
  }));

  // Inline images (vision) — OR supports OpenAI-format multimodal content.
  // Office/PDF text was already extracted into opts.prompt by buildAttachmentPrefix
  // upstream, so only raw images need special handling here.
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

  const body: Record<string, unknown> = {
    model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (fallbacks && fallbacks.length > 0) {
    // OR will try each in order if the primary errors out.
    body.models = fallbacks;
  }

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      // Optional but recommended by OR for analytics + rate-limit fairness.
      'HTTP-Referer': process.env.PUBLIC_URL || 'https://ai-sister.com',
      'X-Title': 'AI Sister',
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  });

  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => '');
    throw new Error(`OpenRouter ${response.status}: ${text || response.statusText}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let runningText = '';
  let promptTokens: number | null = null;
  let completionTokens: number | null = null;
  let actualModel: string = model;

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
        const json = JSON.parse(data) as ORDelta & { model?: string };
        if (json.model) actualModel = json.model;
        const delta = json.choices?.[0]?.delta;
        if (delta?.content) {
          runningText += delta.content;
          opts.onChunk?.(runningText);
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

  return {
    text: runningText.trim(),
    exitCode: 0,
    promptTokens,
    completionTokens,
    modelUsed: actualModel,
  };
}

