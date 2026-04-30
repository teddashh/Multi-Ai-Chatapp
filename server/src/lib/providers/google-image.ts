// Google image generation. The Gemini API exposes two unrelated
// endpoints depending on which family the model belongs to:
//
//   imagen-4.0-*     → POST /v1beta/models/<model>:predict
//                      body { instances: [{prompt}], parameters: {sampleCount, aspectRatio} }
//                      response.predictions[0].bytesBase64Encoded
//
//   gemini-*-image*  → POST /v1beta/models/<model>:generateContent
//                      (same multimodal endpoint as chat — the response
//                       contains parts[i].inlineData.data with the image)
//
// Both are reachable with the same GEMINI_API_KEY we already use for
// chat. Verified live model list against /v1beta/models?key=...

export interface GoogleImageResult {
  bytes: Buffer;
  mimeType: string;
  modelUsed: string;
}

const IMAGEN_MODELS = new Set([
  'imagen-4.0-generate-001',
  'imagen-4.0-ultra-generate-001',
  'imagen-4.0-fast-generate-001',
]);

const GEMINI_IMAGE_MODELS = new Set([
  'gemini-2.5-flash-image',
  'gemini-3-pro-image-preview',
  'gemini-3.1-flash-image-preview',
]);

export function isGoogleImageModel(name: string): boolean {
  return IMAGEN_MODELS.has(name) || GEMINI_IMAGE_MODELS.has(name);
}

export async function runGoogleImage(args: {
  prompt: string;
  model: string;
  signal?: AbortSignal;
}): Promise<GoogleImageResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set in server/.env');

  if (IMAGEN_MODELS.has(args.model)) {
    return runImagen(apiKey, args);
  }
  if (GEMINI_IMAGE_MODELS.has(args.model)) {
    return runGeminiImage(apiKey, args);
  }
  throw new Error(`unknown Google image model: ${args.model}`);
}

async function runImagen(
  apiKey: string,
  args: { prompt: string; model: string; signal?: AbortSignal },
): Promise<GoogleImageResult> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    args.model,
  )}:predict?key=${apiKey}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      instances: [{ prompt: args.prompt }],
      parameters: { sampleCount: 1, aspectRatio: '1:1' },
    }),
    signal: args.signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Imagen ${response.status}: ${text || response.statusText}`);
  }
  const json = (await response.json()) as {
    predictions?: Array<{ bytesBase64Encoded?: string; mimeType?: string }>;
  };
  const pred = json.predictions?.[0];
  if (!pred?.bytesBase64Encoded) {
    throw new Error('Imagen returned no bytesBase64Encoded');
  }
  return {
    bytes: Buffer.from(pred.bytesBase64Encoded, 'base64'),
    mimeType: pred.mimeType ?? 'image/png',
    modelUsed: args.model,
  };
}

async function runGeminiImage(
  apiKey: string,
  args: { prompt: string; model: string; signal?: AbortSignal },
): Promise<GoogleImageResult> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    args.model,
  )}:generateContent?key=${apiKey}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: args.prompt }] }],
    }),
    signal: args.signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Gemini Image ${response.status}: ${text || response.statusText}`);
  }
  const json = (await response.json()) as {
    candidates?: Array<{
      content?: {
        parts?: Array<{
          inlineData?: { data?: string; mimeType?: string };
        }>;
      };
    }>;
  };
  // Walk the parts looking for the first inlineData payload — text-only
  // safety refusals come back without inline data and we want a clear
  // error rather than a silent empty buffer.
  const parts = json.candidates?.[0]?.content?.parts ?? [];
  for (const part of parts) {
    const data = part.inlineData?.data;
    if (data) {
      return {
        bytes: Buffer.from(data, 'base64'),
        mimeType: part.inlineData?.mimeType ?? 'image/png',
        modelUsed: args.model,
      };
    }
  }
  throw new Error('Gemini Image returned no inlineData (likely safety-blocked)');
}
