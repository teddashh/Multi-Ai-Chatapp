// xAI Aurora image generation. OpenAI-compatible /v1/images/generations
// endpoint with model 'grok-imagine-image' (and pro variant).
//
// Catalog (live as of 2026-04-30):
//   grok-imagine-image       — standard
//   grok-imagine-image-pro   — higher quality
//
// Response shape mirrors OpenAI: { data: [{b64_json, mime_type, revised_prompt}], usage }

export interface XAIImageResult {
  bytes: Buffer;
  mimeType: string;
  modelUsed: string;
  revisedPrompt?: string;
}

const KNOWN_MODELS = new Set(['grok-imagine-image', 'grok-imagine-image-pro']);

export function isXAIImageModel(name: string): boolean {
  return KNOWN_MODELS.has(name);
}

export async function runXAIImage(args: {
  prompt: string;
  model: string;
  signal?: AbortSignal;
}): Promise<XAIImageResult> {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) throw new Error('XAI_API_KEY is not set in server/.env');
  if (!isXAIImageModel(args.model)) {
    throw new Error(`unknown xAI image model: ${args.model}`);
  }

  const response = await fetch('https://api.x.ai/v1/images/generations', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: args.model,
      prompt: args.prompt,
      n: 1,
      response_format: 'b64_json',
    }),
    signal: args.signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`xAI Image ${response.status}: ${text || response.statusText}`);
  }

  const json = (await response.json()) as {
    data?: Array<{
      b64_json?: string;
      mime_type?: string;
      revised_prompt?: string;
    }>;
  };
  const item = json.data?.[0];
  if (!item?.b64_json) {
    throw new Error('xAI Image returned no b64_json data');
  }

  return {
    bytes: Buffer.from(item.b64_json, 'base64'),
    mimeType: item.mime_type ?? 'image/png',
    modelUsed: args.model,
    revisedPrompt: item.revised_prompt,
  };
}
