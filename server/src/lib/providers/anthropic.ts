// Direct Anthropic Messages API client. Used as the primary path on prod
// (PROVIDER_MODE=api) and as the middle fallback layer on dev where the
// Claude CLI fronts everything (CLI → Anthropic API → OpenRouter).
//
// Streaming format: SSE with named event types (message_start,
// content_block_delta, message_delta, message_stop). Text deltas live
// under content_block_delta with delta.type='text_delta'.
//
// Docs: https://docs.anthropic.com/en/api/messages-streaming

import type { CLIRunOptions, CLIRunResult } from '../cli.js';
import { imageAttachments, readImageBase64 } from '../uploads.js';

const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 4096;

interface AnthropicResult extends CLIRunResult {
  promptTokens: number | null;
  completionTokens: number | null;
  modelUsed: string;
}

export async function runAnthropic(opts: CLIRunOptions): Promise<AnthropicResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set in server/.env');
  }

  // Build messages from history + current turn. Anthropic uses {role, content}
  // where content is either a string or an array of content blocks (for vision).
  const history = opts.history ?? [];
  const messages: Array<{ role: 'user' | 'assistant'; content: unknown }> = history.map(
    (t) => ({ role: t.role, content: t.content }),
  );

  const images = imageAttachments(opts.attachments ?? []);
  if (images.length === 0) {
    messages.push({ role: 'user', content: opts.prompt });
  } else {
    const blocks: Array<
      | { type: 'text'; text: string }
      | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
    > = [];
    for (const img of images) {
      const { mediaType, data } = readImageBase64(img);
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: mediaType, data },
      });
    }
    blocks.push({ type: 'text', text: opts.prompt });
    messages.push({ role: 'user', content: blocks });
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: opts.model,
      messages,
      max_tokens: DEFAULT_MAX_TOKENS,
      stream: true,
    }),
    signal: opts.signal,
  });

  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => '');
    throw new Error(`Anthropic ${response.status}: ${text || response.statusText}`);
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
      if (!data) continue;
      try {
        const json = JSON.parse(data) as {
          type?: string;
          delta?: { type?: string; text?: string };
          message?: { usage?: { input_tokens?: number } };
          usage?: { output_tokens?: number };
          error?: { type?: string; message?: string };
        };
        if (json.error) {
          throw new Error(`Anthropic stream error: ${json.error.message}`);
        }
        if (
          json.type === 'content_block_delta' &&
          json.delta?.type === 'text_delta' &&
          typeof json.delta.text === 'string'
        ) {
          runningText += json.delta.text;
          opts.onChunk?.(runningText);
        }
        if (json.type === 'message_start' && typeof json.message?.usage?.input_tokens === 'number') {
          promptTokens = json.message.usage.input_tokens;
        }
        if (json.type === 'message_delta' && typeof json.usage?.output_tokens === 'number') {
          completionTokens = json.usage.output_tokens;
        }
      } catch (err) {
        // Re-throw real stream errors (signaled via JSON .error); ignore
        // malformed bytes.
        if ((err as Error).message?.startsWith('Anthropic stream error')) throw err;
      }
    }
  }

  return {
    text: runningText.trim(),
    exitCode: 0,
    promptTokens,
    completionTokens,
    modelUsed: opts.model,
  };
}
