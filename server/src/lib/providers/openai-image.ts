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
  // The OpenAI API model id (gpt-image-1 / gpt-image-1-mini / gpt-image-1.5
  // / gpt-image-2). Quality knob is sent as a separate request field when
  // present.
  baseModel: string;
  quality?: 'low' | 'medium' | 'high';
}

// Recognise: gpt-image-1, gpt-image-1.5, gpt-image-2 (with optional
// -low/-medium/-high suffix), and gpt-image-1-mini (no quality).
function parseGptImageModel(name: string): ParsedModel | null {
  if (name === 'gpt-image-1-mini') {
    return { baseModel: 'gpt-image-1-mini' };
  }
  const m = /^(gpt-image-(?:1\.5|1|2))(?:-(low|medium|high))?$/.exec(name);
  if (!m) return null;
  return {
    baseModel: m[1],
    quality: (m[2] as 'low' | 'medium' | 'high' | undefined) ?? undefined,
  };
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

  const body: Record<string, unknown> = {
    model: parsed.baseModel,
    prompt: args.prompt,
    size: args.size ?? '1024x1024',
    n: 1,
  };
  if (parsed.quality) body.quality = parsed.quality;

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

// Reference-image variant via /v1/images/edits — the only OpenAI image
// endpoint that accepts input images. Used as the fallback path for
// forum infographic gen when Gemini fails. Always uses gpt-image-1.
export async function runOpenAIImageEdit(args: {
  prompt: string;
  references: Array<{ bytes: Buffer; mimeType: string; filename: string }>;
  size?: '1024x1024' | '1024x1536' | '1536x1024';
  quality?: 'low' | 'medium' | 'high';
  signal?: AbortSignal;
}): Promise<ImageGenResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set');

  const form = new FormData();
  form.append('model', 'gpt-image-1');
  form.append('prompt', args.prompt);
  form.append('size', args.size ?? '1024x1024');
  form.append('quality', args.quality ?? 'low');
  form.append('n', '1');
  for (const ref of args.references) {
    form.append(
      'image[]',
      new Blob([ref.bytes], { type: ref.mimeType }),
      ref.filename,
    );
  }

  const res = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: args.signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `OpenAI Image Edit ${res.status}: ${text || res.statusText}`,
    );
  }

  const json = (await res.json()) as {
    data?: Array<{ b64_json?: string }>;
  };
  const b64 = json.data?.[0]?.b64_json;
  if (!b64) throw new Error('OpenAI Image Edit returned no b64_json');

  return {
    bytes: Buffer.from(b64, 'base64'),
    mimeType: 'image/png',
    modelUsed: `gpt-image-1-${args.quality ?? 'low'}`,
  };
}
