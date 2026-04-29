// Direct Google Generative Language API client (streamGenerateContent
// with alt=sse). Used as the primary path on prod (PROVIDER_MODE=api)
// and as the middle fallback layer on dev (CLI → Gemini API → OpenRouter).
//
// Docs: https://ai.google.dev/gemini-api/docs/text-generation
//       https://ai.google.dev/api/generate-content#method:-models.streamgeneratecontent

import type { CLIRunOptions, CLIRunResult } from '../cli.js';
import { imageAttachments, readImageBase64 } from '../uploads.js';

interface GeminiResult extends CLIRunResult {
  promptTokens: number | null;
  completionTokens: number | null;
  modelUsed: string;
}

export async function runGemini(opts: CLIRunOptions): Promise<GeminiResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not set in server/.env');
  }

  // Gemini's REST API uses {role: 'user'|'model', parts: [...]} — note
  // 'model' instead of 'assistant'. Map our generic chat history.
  const history = opts.history ?? [];
  const contents: Array<{ role: 'user' | 'model'; parts: unknown[] }> = history.map((t) => ({
    role: t.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: t.content }],
  }));

  const userParts: Array<
    | { text: string }
    | { inline_data: { mime_type: string; data: string } }
  > = [];
  const images = imageAttachments(opts.attachments ?? []);
  for (const img of images) {
    const { mediaType, data } = readImageBase64(img);
    userParts.push({ inline_data: { mime_type: mediaType, data } });
  }
  userParts.push({ text: opts.prompt });
  contents.push({ role: 'user', parts: userParts });

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(opts.model)}` +
    `:streamGenerateContent?alt=sse&key=${apiKey}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents }),
    signal: opts.signal,
  });

  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => '');
    throw new Error(`Gemini ${response.status}: ${text || response.statusText}`);
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
          candidates?: Array<{
            content?: { parts?: Array<{ text?: string }> };
          }>;
          usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
          error?: { message?: string };
        };
        if (json.error) {
          throw new Error(`Gemini stream error: ${json.error.message ?? 'unknown'}`);
        }
        const parts = json.candidates?.[0]?.content?.parts ?? [];
        for (const part of parts) {
          if (typeof part.text === 'string') {
            runningText += part.text;
          }
        }
        if (parts.length > 0) opts.onChunk?.(runningText);
        if (typeof json.usageMetadata?.promptTokenCount === 'number') {
          promptTokens = json.usageMetadata.promptTokenCount;
        }
        if (typeof json.usageMetadata?.candidatesTokenCount === 'number') {
          completionTokens = json.usageMetadata.candidatesTokenCount;
        }
      } catch (err) {
        if ((err as Error).message?.startsWith('Gemini stream error')) throw err;
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
