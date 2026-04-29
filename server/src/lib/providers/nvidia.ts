// NVIDIA NIM hosted-inference client. Same OpenAI-compatible shape as
// OpenRouter, just different base URL. Acts as the LAST stage in the
// fallback chain (CLI → API → OR → NVIDIA → exhausted message) so we
// squeeze value out of the free credits without ever using it for
// happy-path traffic.
//
// Most strong-Chinese models on NVIDIA's catalog are mainland-trained
// (Qwen, DeepSeek, Kimi, GLM) and default to Simplified Chinese even
// when system prompted to use Traditional. We post-process every chunk
// through opencc s2twp (Simplified → Traditional, Taiwan idioms) so
// the user always sees Traditional regardless of what the upstream
// model emits.
//
// Also exposed: chatOnce() for short non-streaming calls (auto session
// title generation). Same opencc treatment.

import * as OpenCC from 'opencc-js';
import type { CLIRunOptions, CLIRunResult } from '../cli.js';
import type { AIProvider } from '../../shared/types.js';
import { imageAttachments, readImageBase64 } from '../uploads.js';
import { languageSystemPrompt } from './openrouter.js';

// Per-family stand-in. NVIDIA carries no Anthropic / xAI weights so we
// pick the closest open-weight cousin. Quality drop is real here — this
// is the absolute last resort, expected to fire only when both the
// vendor API and OpenRouter are unavailable.
const NVIDIA_FALLBACK_MODEL: Record<AIProvider, string> = {
  // Kimi-K2 is one of the better open-weight Chinese conversational
  // models. Better stand-in for Claude than a stock Llama.
  claude: 'moonshotai/kimi-k2-instruct',
  // Open-weight reproduction of OpenAI architecture; closest "GPT-flavored"
  // model on NVIDIA's catalog.
  chatgpt: 'openai/gpt-oss-120b',
  // Gemma is Google's own open-weight family.
  gemini: 'google/gemma-3-27b-it',
  // No xAI presence on NVIDIA; default to the strongest general-purpose
  // open weight.
  grok: 'meta/llama-3.3-70b-instruct',
};

export function nvidiaFallbackModelFor(provider: AIProvider): string {
  return NVIDIA_FALLBACK_MODEL[provider];
}

// Cached converter — opencc setup is non-trivial and we want to do it
// once at module load, not on every chunk. `twp` (vs plain `tw`) does
// phrase-level mapping so 软件→軟體, 视频→影片, 信息→資訊, 设置→設定 —
// proper Taiwan idioms, not just per-char traditional.
const s2twpConverter = OpenCC.Converter({ from: 'cn', to: 'twp' });

// Convert Simplified Chinese to Traditional (Taiwan flavor) when the
// user is on zh-TW. No-op for English. Safe to run on text that's
// already Traditional — opencc maps each char individually and idempotent
// for chars that don't exist in the cn → tw map.
export function ensureTraditional(text: string, lang?: 'zh-TW' | 'en'): string {
  if (lang !== 'zh-TW' || !text) return text;
  try {
    return s2twpConverter(text);
  } catch (err) {
    console.error('[nvidia] opencc convert failed', (err as Error).message);
    return text;
  }
}

interface NvidiaResult extends CLIRunResult {
  promptTokens: number | null;
  completionTokens: number | null;
  modelUsed: string;
}

export async function runNvidia(opts: CLIRunOptions): Promise<NvidiaResult> {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) {
    throw new Error('NVIDIA_API_KEY is not set in server/.env');
  }

  const provider = opts.provider;
  const model = nvidiaFallbackModelFor(provider);

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

  const response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    }),
    signal: opts.signal,
  });

  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => '');
    throw new Error(`NVIDIA ${response.status}: ${text || response.statusText}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let runningRaw = '';
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
          runningRaw += delta.content;
          // Forward the running text in Traditional so the streaming
          // UI never flashes Simplified mid-stream. opencc per-chunk
          // is safe — converter operates char-by-char.
          opts.onChunk?.(ensureTraditional(runningRaw, opts.lang));
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

  return {
    text: ensureTraditional(runningRaw.trim(), opts.lang),
    exitCode: 0,
    promptTokens,
    completionTokens,
    modelUsed: model,
  };
}

// Single-shot chat completion for short utility tasks (session auto-title).
// Always returns Traditional Chinese for zh-TW. No streaming, no history,
// no attachments — keeps the call cheap.
export async function nvidiaChatOnce(args: {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  lang?: 'zh-TW' | 'en';
  maxTokens?: number;
  signal?: AbortSignal;
}): Promise<string> {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) throw new Error('NVIDIA_API_KEY is not set');

  const response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: args.model,
      messages: [
        { role: 'system', content: args.systemPrompt },
        { role: 'user', content: args.userPrompt },
      ],
      max_tokens: args.maxTokens ?? 64,
      stream: false,
    }),
    signal: args.signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`NVIDIA ${response.status}: ${text || response.statusText}`);
  }

  const json = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = json.choices?.[0]?.message?.content?.trim() ?? '';
  return ensureTraditional(text, args.lang);
}
