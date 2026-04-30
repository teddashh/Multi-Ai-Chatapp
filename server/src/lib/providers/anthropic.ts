// Direct Anthropic Messages API client. Used as the primary path on prod
// (PROVIDER_MODE=api) and as the middle fallback layer on dev where the
// Claude CLI fronts everything (CLI → Anthropic API → OpenRouter).
//
// Tool calling: function-style web_search backed by SearXNG. Anthropic's
// streaming tool format is fiddly — tool_use input is built up across
// `input_json_delta` events under a content_block, and the round ends
// with `message_delta.stop_reason='tool_use'` when the model wants us
// to call something. We mirror the xAI / OpenAI multi-round loop so
// Claude can do up to MAX_TOOL_ITERATIONS searches per turn.
//
// Docs: https://docs.anthropic.com/en/api/messages-streaming
//       https://docs.anthropic.com/en/docs/build-with-claude/tool-use

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

const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 4096;

interface AnthropicResult extends CLIRunResult {
  promptTokens: number | null;
  completionTokens: number | null;
  modelUsed: string;
}

const WEB_SEARCH_TOOL_ANTHROPIC = {
  name: TOOL_NAME,
  description: TOOL_DESCRIPTION,
  input_schema: TOOL_PARAMETER_SCHEMA,
};

interface AnthropicToolUse {
  id: string;
  name: string;
  input: string; // JSON string accumulated across input_json_delta events
}

interface AnthropicRoundResult {
  text: string;
  toolUses: AnthropicToolUse[];
  promptTokens: number | null;
  completionTokens: number | null;
  stopReason: string | null;
}

async function streamAnthropicRound(
  apiKey: string,
  body: unknown,
  opts: CLIRunOptions,
): Promise<AnthropicRoundResult> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
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
  let stopReason: string | null = null;

  // Each content_block_start opens a slot indexed by `index`. text_delta
  // events append to that slot's text; input_json_delta events append
  // to the slot's tool input. We only forward text via onChunk.
  const blocks: Record<
    number,
    { type: 'text' | 'tool_use'; text: string; toolId: string; toolName: string; toolInput: string }
  > = {};

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
          index?: number;
          content_block?: {
            type?: 'text' | 'tool_use';
            id?: string;
            name?: string;
          };
          delta?: {
            type?: string;
            text?: string;
            partial_json?: string;
            stop_reason?: string;
          };
          message?: { usage?: { input_tokens?: number } };
          usage?: { output_tokens?: number };
          error?: { type?: string; message?: string };
        };
        if (json.error) {
          throw new Error(`Anthropic stream error: ${json.error.message}`);
        }
        if (json.type === 'message_start' && typeof json.message?.usage?.input_tokens === 'number') {
          promptTokens = json.message.usage.input_tokens;
        }
        if (json.type === 'content_block_start' && typeof json.index === 'number') {
          const cb = json.content_block;
          if (cb?.type === 'text') {
            blocks[json.index] = { type: 'text', text: '', toolId: '', toolName: '', toolInput: '' };
          } else if (cb?.type === 'tool_use') {
            blocks[json.index] = {
              type: 'tool_use',
              text: '',
              toolId: cb.id ?? '',
              toolName: cb.name ?? '',
              toolInput: '',
            };
          }
        }
        if (json.type === 'content_block_delta' && typeof json.index === 'number') {
          const slot = blocks[json.index];
          if (!slot) continue;
          if (json.delta?.type === 'text_delta' && typeof json.delta.text === 'string') {
            slot.text += json.delta.text;
            runningText += json.delta.text;
            opts.onChunk?.(runningText);
          } else if (json.delta?.type === 'input_json_delta' && typeof json.delta.partial_json === 'string') {
            slot.toolInput += json.delta.partial_json;
          }
        }
        if (json.type === 'message_delta') {
          if (typeof json.delta?.stop_reason === 'string') stopReason = json.delta.stop_reason;
          if (typeof json.usage?.output_tokens === 'number') {
            completionTokens = json.usage.output_tokens;
          }
        }
      } catch (err) {
        if ((err as Error).message?.startsWith('Anthropic stream error')) throw err;
      }
    }
  }

  const toolUses: AnthropicToolUse[] = Object.entries(blocks)
    .filter(([, slot]) => slot.type === 'tool_use')
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([, slot]) => ({
      id: slot.toolId,
      name: slot.toolName,
      input: slot.toolInput,
    }));

  return { text: runningText, toolUses, promptTokens, completionTokens, stopReason };
}

export async function runAnthropic(opts: CLIRunOptions): Promise<AnthropicResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set in server/.env');
  }

  const history = opts.history ?? [];
  // Anthropic uses {role, content} where content is either a string or
  // an array of content blocks (text / image / tool_use / tool_result).
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

  const sysPrompt = languageSystemPrompt(opts.lang);
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let sawRealTokens = false;
  let finalText = '';

  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    const isLast = iter === MAX_TOOL_ITERATIONS - 1;
    const body: Record<string, unknown> = {
      model: opts.model,
      messages,
      max_tokens: DEFAULT_MAX_TOKENS,
      stream: true,
    };
    // Last iteration drops the tool list so the model is forced to
    // commit to a text answer instead of asking for yet another search.
    if (!isLast) body.tools = [WEB_SEARCH_TOOL_ANTHROPIC];
    if (sysPrompt) body.system = sysPrompt;

    const round = await streamAnthropicRound(apiKey, body, opts);
    if (round.promptTokens !== null) {
      totalPromptTokens += round.promptTokens;
      sawRealTokens = true;
    }
    if (round.completionTokens !== null) {
      totalCompletionTokens += round.completionTokens;
      sawRealTokens = true;
    }

    // No tool requested → final answer. Forced final on last iteration.
    if (round.stopReason !== 'tool_use' || round.toolUses.length === 0 || isLast) {
      finalText = round.text.trim();
      break;
    }

    // Append the assistant's tool_use turn (must include both any text
    // it spoke and the tool_use block, in order, so Anthropic accepts
    // the next call).
    const assistantContent: Array<
      | { type: 'text'; text: string }
      | { type: 'tool_use'; id: string; name: string; input: unknown }
    > = [];
    if (round.text) assistantContent.push({ type: 'text', text: round.text });
    for (const tu of round.toolUses) {
      let parsedInput: unknown = {};
      try {
        parsedInput = tu.input ? JSON.parse(tu.input) : {};
      } catch {
        parsedInput = {};
      }
      assistantContent.push({
        type: 'tool_use',
        id: tu.id,
        name: tu.name,
        input: parsedInput,
      });
    }
    messages.push({ role: 'assistant', content: assistantContent });

    // Run each tool and feed the results back as a single user turn.
    const toolResults: Array<{
      type: 'tool_result';
      tool_use_id: string;
      content: string;
    }> = [];
    for (const tu of round.toolUses) {
      const result =
        tu.name === TOOL_NAME
          ? await runWebSearchCall(tu.input, opts.signal)
          : `(unknown tool: ${tu.name})`;
      toolResults.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: result,
      });
    }
    messages.push({ role: 'user', content: toolResults });
  }

  return {
    text: finalText,
    exitCode: 0,
    promptTokens: sawRealTokens ? totalPromptTokens : null,
    completionTokens: sawRealTokens ? totalCompletionTokens : null,
    modelUsed: opts.model,
  };
}
