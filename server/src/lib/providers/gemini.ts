// Direct Google Generative Language API client (streamGenerateContent
// with alt=sse). Used as the primary path on prod (PROVIDER_MODE=api)
// and as the middle fallback layer on dev (CLI → Gemini API → OpenRouter).
//
// Tool calling: function-style web_search backed by SearXNG. Gemini's
// streaming format is a sequence of full content snapshots — each chunk
// carries the latest `candidates[0].content.parts` array which can mix
// text and functionCall parts. We accumulate text deltas across chunks,
// detect functionCall presence, run the tool, and continue with a new
// streamGenerateContent call.
//
// Docs: https://ai.google.dev/gemini-api/docs/text-generation
//       https://ai.google.dev/gemini-api/docs/function-calling

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

interface GeminiResult extends CLIRunResult {
  promptTokens: number | null;
  completionTokens: number | null;
  modelUsed: string;
}

const FUNCTION_DECLARATION = {
  name: TOOL_NAME,
  description: TOOL_DESCRIPTION,
  parameters: TOOL_PARAMETER_SCHEMA,
};

interface GeminiFunctionCall {
  name: string;
  args: Record<string, unknown>;
  // Gemini 3.x thinking models attach a `thoughtSignature` to each
  // functionCall part. The next turn's `model` content MUST echo this
  // signature back on the same part or the API rejects the request
  // with "Function call is missing a thought_signature in functionCall
  // parts" (HTTP 400). https://ai.google.dev/gemini-api/docs/thought-signatures
  thoughtSignature?: string;
}

interface GeminiRoundResult {
  text: string;
  functionCalls: GeminiFunctionCall[];
  // Last text-part's thought_signature, when present. Older models
  // don't emit this; newer thinking models require it on the
  // continuation turn even for text-only assistant turns.
  textThoughtSignature?: string;
  promptTokens: number | null;
  completionTokens: number | null;
}

async function streamGeminiRound(
  apiKey: string,
  model: string,
  body: unknown,
  opts: CLIRunOptions,
): Promise<GeminiRoundResult> {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}` +
    `:streamGenerateContent?alt=sse&key=${apiKey}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
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
  const functionCalls: GeminiFunctionCall[] = [];
  let textThoughtSignature: string | undefined;

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
            content?: {
              parts?: Array<{
                text?: string;
                thoughtSignature?: string;
                functionCall?: { name?: string; args?: Record<string, unknown> };
              }>;
            };
          }>;
          usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
          error?: { message?: string };
        };
        if (json.error) {
          throw new Error(`Gemini stream error: ${json.error.message ?? 'unknown'}`);
        }
        const parts = json.candidates?.[0]?.content?.parts ?? [];
        let textArrived = false;
        for (const part of parts) {
          if (typeof part.text === 'string') {
            runningText += part.text;
            textArrived = true;
            // Latest text part's signature wins — Gemini emits one per
            // streaming chunk and we only need to echo back the most
            // recent on the continuation turn.
            if (typeof part.thoughtSignature === 'string') {
              textThoughtSignature = part.thoughtSignature;
            }
          }
          if (part.functionCall && part.functionCall.name) {
            functionCalls.push({
              name: part.functionCall.name,
              args: part.functionCall.args ?? {},
              thoughtSignature: part.thoughtSignature,
            });
          }
        }
        if (textArrived) opts.onChunk?.(runningText);
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

  return { text: runningText, functionCalls, textThoughtSignature, promptTokens, completionTokens };
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

  const sysPrompt = languageSystemPrompt(opts.lang);
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let sawRealTokens = false;
  let finalText = '';

  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    const body: Record<string, unknown> = {
      contents,
      tools: [{ functionDeclarations: [FUNCTION_DECLARATION] }],
    };
    if (sysPrompt) {
      body.systemInstruction = { parts: [{ text: sysPrompt }] };
    }

    const round = await streamGeminiRound(apiKey, opts.model, body, opts);
    if (round.promptTokens !== null) {
      totalPromptTokens += round.promptTokens;
      sawRealTokens = true;
    }
    if (round.completionTokens !== null) {
      totalCompletionTokens += round.completionTokens;
      sawRealTokens = true;
    }

    if (round.functionCalls.length === 0) {
      finalText = round.text.trim();
      break;
    }

    // Append the model's turn (text + functionCall parts in order).
    // Echo any thoughtSignature back on the original part — Gemini 3.x
    // thinking models reject the next call with HTTP 400 if missing.
    const modelParts: unknown[] = [];
    if (round.text) {
      const textPart: Record<string, unknown> = { text: round.text };
      if (round.textThoughtSignature) {
        textPart.thoughtSignature = round.textThoughtSignature;
      }
      modelParts.push(textPart);
    }
    for (const fc of round.functionCalls) {
      const fcPart: Record<string, unknown> = {
        functionCall: { name: fc.name, args: fc.args },
      };
      if (fc.thoughtSignature) fcPart.thoughtSignature = fc.thoughtSignature;
      modelParts.push(fcPart);
    }
    contents.push({ role: 'model', parts: modelParts });

    // Run the tools and append a single user-side turn with each
    // functionResponse part.
    const responseParts: unknown[] = [];
    for (const fc of round.functionCalls) {
      const result =
        fc.name === TOOL_NAME
          ? await runWebSearchCall(fc.args, opts.signal)
          : `(unknown tool: ${fc.name})`;
      responseParts.push({
        functionResponse: {
          name: fc.name,
          response: { content: result },
        },
      });
    }
    contents.push({ role: 'user', parts: responseParts });
  }

  return {
    text: finalText,
    exitCode: 0,
    promptTokens: sawRealTokens ? totalPromptTokens : null,
    completionTokens: sawRealTokens ? totalCompletionTokens : null,
    modelUsed: opts.model,
  };
}
