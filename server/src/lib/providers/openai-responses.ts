// OpenAI Responses API client (POST /v1/responses).
//
// Different endpoint from /v1/chat/completions, with a different
// request/response shape. Required for:
//   - "-pro" SKUs (gpt-5.5-pro, gpt-5.4-pro, ...)
//   - Reasoning models (o1, o1-pro, o3, o4-mini)
//   - Codex variants (gpt-5-codex, gpt-5.x-codex)
//
// All of those return 404 "This is not a chat model" on the chat
// completions endpoint. The Responses API is OpenAI's newer unified
// surface for these.
//
// Streaming events of interest:
//   response.created                  — opens the round; carries the response.id
//   response.output_item.added        — new item ('message' / 'function_call' / 'reasoning')
//   response.output_text.delta        — running text chunk (.delta is the new bytes)
//   response.function_call_arguments.delta — assemble tool args piecewise
//   response.completed                — usage + final state
//
// Tool continuation: send a follow-up call with previous_response_id +
// input=[{type:'function_call_output', call_id, output}]. Server holds
// the conversation state.
//
// Docs: https://platform.openai.com/docs/api-reference/responses

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

// Responses-API tool format is flatter than chat completions — name /
// description / parameters live at the top level under {type:'function'}.
const FUNCTION_TOOL = {
  type: 'function' as const,
  name: TOOL_NAME,
  description: TOOL_DESCRIPTION,
  parameters: TOOL_PARAMETER_SCHEMA,
};

interface FunctionCallSlot {
  call_id: string;
  name: string;
  arguments: string;
}

interface RoundResult {
  text: string;
  toolCalls: FunctionCallSlot[];
  responseId: string;
  promptTokens: number | null;
  completionTokens: number | null;
}

async function streamResponsesRound(
  apiKey: string,
  body: unknown,
  opts: CLIRunOptions,
): Promise<RoundResult> {
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  });

  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => '');
    throw new Error(`OpenAI Responses ${response.status}: ${text || response.statusText}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let runningText = '';
  let responseId = '';
  let promptTokens: number | null = null;
  let completionTokens: number | null = null;

  // function_call output items are introduced via response.output_item.added
  // with item.type='function_call'; subsequent
  // response.function_call_arguments.delta events deliver `arguments`
  // piecewise keyed by item_id.
  const fcByItemId: Record<string, FunctionCallSlot> = {};

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
        const ev = JSON.parse(data) as {
          type?: string;
          delta?: string;
          item_id?: string;
          item?: {
            id?: string;
            type?: string;
            call_id?: string;
            name?: string;
          };
          response?: {
            id?: string;
            usage?: { input_tokens?: number; output_tokens?: number };
            error?: { message?: string };
          };
        };
        if (ev.type === 'response.created' && ev.response?.id) {
          responseId = ev.response.id;
        }
        if (ev.type === 'response.output_text.delta' && typeof ev.delta === 'string') {
          runningText += ev.delta;
          opts.onChunk?.(runningText);
        }
        if (ev.type === 'response.output_item.added' && ev.item?.type === 'function_call') {
          fcByItemId[ev.item.id ?? ''] = {
            call_id: ev.item.call_id ?? '',
            name: ev.item.name ?? '',
            arguments: '',
          };
        }
        if (
          ev.type === 'response.function_call_arguments.delta' &&
          ev.item_id &&
          typeof ev.delta === 'string'
        ) {
          const slot = fcByItemId[ev.item_id];
          if (slot) slot.arguments += ev.delta;
        }
        if (ev.type === 'response.completed' && ev.response?.usage) {
          if (typeof ev.response.usage.input_tokens === 'number') {
            promptTokens = ev.response.usage.input_tokens;
          }
          if (typeof ev.response.usage.output_tokens === 'number') {
            completionTokens = ev.response.usage.output_tokens;
          }
        }
        if (ev.type === 'response.failed' && ev.response?.error?.message) {
          throw new Error(`OpenAI Responses failed: ${ev.response.error.message}`);
        }
      } catch (err) {
        if ((err as Error).message?.startsWith('OpenAI Responses failed')) throw err;
      }
    }
  }

  return {
    text: runningText,
    toolCalls: Object.values(fcByItemId),
    responseId,
    promptTokens,
    completionTokens,
  };
}

export async function runOpenAIResponses(opts: CLIRunOptions): Promise<OpenAIResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not set in server/.env');
  }

  // Build initial input from history + current user turn. Responses
  // API accepts a messages-array shape similar to chat completions but
  // uses 'input_text' / 'input_image' for vision content parts.
  const history = opts.history ?? [];
  const inputItems: Array<{ role: string; content: unknown }> = history.map((t) => ({
    role: t.role,
    content: t.content,
  }));

  const images = imageAttachments(opts.attachments ?? []);
  if (images.length === 0) {
    inputItems.push({ role: 'user', content: opts.prompt });
  } else {
    const content: Array<
      | { type: 'input_text'; text: string }
      | { type: 'input_image'; image_url: string }
    > = [{ type: 'input_text', text: opts.prompt }];
    for (const img of images) {
      const { mediaType, data } = readImageBase64(img);
      content.push({
        type: 'input_image',
        image_url: `data:${mediaType};base64,${data}`,
      });
    }
    inputItems.push({ role: 'user', content });
  }

  const sysPrompt = languageSystemPrompt(opts.lang);
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let sawRealTokens = false;
  let finalText = '';
  let prevResponseId: string | null = null;
  let nextInput: unknown = inputItems;

  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    const isLast = iter === MAX_TOOL_ITERATIONS - 1;
    const body: Record<string, unknown> = {
      model: opts.model,
      input: nextInput,
      stream: true,
    };
    // 'instructions' is the Responses-API analogue of the chat
    // completions system message — used here to lock zh-TW output.
    if (sysPrompt) body.instructions = sysPrompt;
    if (!isLast) body.tools = [FUNCTION_TOOL];
    if (prevResponseId) body.previous_response_id = prevResponseId;
    // 深度思考 mode passes 'high' so o-series and -pro variants do
    // their deepest reasoning per turn. Cheaper modes leave it.
    if (opts.reasoningEffort) {
      body.reasoning = { effort: opts.reasoningEffort };
    }

    const round = await streamResponsesRound(apiKey, body, opts);
    if (round.promptTokens !== null) {
      totalPromptTokens += round.promptTokens;
      sawRealTokens = true;
    }
    if (round.completionTokens !== null) {
      totalCompletionTokens += round.completionTokens;
      sawRealTokens = true;
    }

    // No tool requested → final answer (or last iter forces it).
    if (round.toolCalls.length === 0 || isLast) {
      finalText = round.text.trim();
      break;
    }

    // Continue: server-side state via previous_response_id + tool outputs.
    prevResponseId = round.responseId;
    const toolOutputs: unknown[] = [];
    for (const tc of round.toolCalls) {
      const result =
        tc.name === TOOL_NAME
          ? await runWebSearchCall(tc.arguments, opts.signal)
          : `(unknown tool: ${tc.name})`;
      toolOutputs.push({
        type: 'function_call_output',
        call_id: tc.call_id,
        output: result,
      });
    }
    nextInput = toolOutputs;
  }

  return {
    text: finalText,
    exitCode: 0,
    promptTokens: sawRealTokens ? totalPromptTokens : null,
    completionTokens: sawRealTokens ? totalCompletionTokens : null,
    modelUsed: opts.model,
  };
}

// Heuristic: which OpenAI models live on /v1/responses instead of
// /v1/chat/completions. Used by the dispatcher in openai.ts. If a
// future SKU breaks the pattern, add an explicit override here.
export function needsResponsesAPI(model: string): boolean {
  if (model.includes('-pro')) return true;
  if (model.includes('codex')) return true;
  if (/^o\d/.test(model)) return true;
  return false;
}
