// Direct OpenAI Chat Completions API client. The trick here is that the
// user's tier_models lists ChatGPT-account-only SKUs (gpt-5.4-mini, gpt-5.4,
// gpt-5.5) which the official OpenAI API does NOT serve — those are exclusive
// to the Codex CLI's ChatGPT auth path. So we map them to the closest GA
// model on the direct API. The user-visible name in the UI doesn't change;
// only the actual model that answers does.
//
// Docs: https://platform.openai.com/docs/api-reference/chat/streaming

import type { CLIRunOptions, CLIRunResult } from '../cli.js';
import { imageAttachments, readImageBase64 } from '../uploads.js';
import { languageSystemPrompt } from './openrouter.js';

interface OpenAIResult extends CLIRunResult {
  promptTokens: number | null;
  completionTokens: number | null;
  modelUsed: string;
}

// ChatGPT-account model IDs aren't valid on api.openai.com. Map to the
// closest GA model on the direct platform. Cheap-mini → gpt-4o-mini,
// flagship → gpt-4o.
const OPENAI_API_MODEL_MAP: Record<string, string> = {
  'gpt-5.4-mini': 'gpt-4o-mini',
  'gpt-5.4': 'gpt-4o-mini',
  'gpt-5.5': 'gpt-4o',
};

function resolveOpenAIModel(model: string): string {
  return OPENAI_API_MODEL_MAP[model] ?? model;
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

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: apiModel,
      messages,
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
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        const delta = json.choices?.[0]?.delta;
        if (delta?.content) {
          runningText += delta.content;
          opts.onChunk?.(runningText);
        }
        if (typeof json.usage?.prompt_tokens === 'number') promptTokens = json.usage.prompt_tokens;
        if (typeof json.usage?.completion_tokens === 'number') completionTokens = json.usage.completion_tokens;
      } catch {
        // ignore malformed bytes
      }
    }
  }

  return {
    text: runningText.trim(),
    exitCode: 0,
    promptTokens,
    completionTokens,
    modelUsed: apiModel,
  };
}
