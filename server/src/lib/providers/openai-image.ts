// OpenAI image generation (gpt-image-1). One-shot REST call to
// /v1/images/generations — no streaming. Returns a base64 PNG that
// the caller saves to disk and references via a chat_attachments row.
//
// Model name in our IMAGE_MODELS catalog encodes the quality knob
// because OpenAI's API takes it as a separate parameter:
//   gpt-image-1-low    → { model: 'gpt-image-1', quality: 'low'    }  ~$0.020
//   gpt-image-1-medium → { model: 'gpt-image-1', quality: 'medium' }  ~$0.07
//   gpt-image-1-high   → { model: 'gpt-image-1', quality: 'high'   }  ~$0.19
//
// Docs: https://platform.openai.com/docs/api-reference/images/create

export interface ImageGenResult {
  // Raw image bytes (PNG)
  bytes: Buffer;
  mimeType: 'image/png';
  // What the API actually billed (echoed for usage_log)
  modelUsed: string;
  // Token-equivalent rough cost — OpenAI bills per generation, not
  // per token; we record the base output size for the dashboard.
  approxOutputCost?: number;
}

interface ParsedModel {
  baseModel: 'gpt-image-1';
  quality: 'low' | 'medium' | 'high';
}

function parseGptImageModel(name: string): ParsedModel | null {
  if (name === 'gpt-image-1-low') return { baseModel: 'gpt-image-1', quality: 'low' };
  if (name === 'gpt-image-1-medium') return { baseModel: 'gpt-image-1', quality: 'medium' };
  if (name === 'gpt-image-1-high') return { baseModel: 'gpt-image-1', quality: 'high' };
  return null;
}

export function isOpenAIImageModel(name: string): boolean {
  return parseGptImageModel(name) !== null;
}

export async function runOpenAIImage(args: {
  prompt: string;
  model: string;
  size?: '1024x1024' | '1024x1536' | '1536x1024';
  signal?: AbortSignal;
}): Promise<ImageGenResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set in server/.env');

  const parsed = parseGptImageModel(args.model);
  if (!parsed) throw new Error(`unknown OpenAI image model: ${args.model}`);

  const body = {
    model: parsed.baseModel,
    prompt: args.prompt,
    size: args.size ?? '1024x1024',
    quality: parsed.quality,
    n: 1,
  };

  const response = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: args.signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`OpenAI Image ${response.status}: ${text || response.statusText}`);
  }

  const json = (await response.json()) as {
    data?: Array<{ b64_json?: string }>;
  };
  const b64 = json.data?.[0]?.b64_json;
  if (!b64) {
    throw new Error('OpenAI Image returned no b64_json data');
  }

  return {
    bytes: Buffer.from(b64, 'base64'),
    mimeType: 'image/png',
    modelUsed: args.model,
  };
}
