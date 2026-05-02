// Gemini 2.5 Flash Image Preview ("Nano Banana") — multimodal image
// generator that accepts reference images via inline_data parts. Used
// for forum infographic generation with a fixed set of character refs
// (Claude / Codex / Gemini / Grok chibi girls) so output stays on-brand.
//
// Docs: https://ai.google.dev/gemini-api/docs/image-generation

const GEMINI_IMAGE_MODEL = 'gemini-2.5-flash-image-preview';

export interface GeminiImageResult {
  bytes: Buffer;
  mimeType: 'image/png';
  modelUsed: string;
}

interface InlineDataPart {
  inline_data?: { mime_type: string; data: string };
  inlineData?: { mimeType: string; data: string };
  text?: string;
}

export async function runGeminiImage(args: {
  prompt: string;
  // PNG/JPEG buffers + their mime types — passed as inline parts so
  // the model can study the style + characters before generating.
  references?: Array<{ bytes: Buffer; mimeType: string }>;
  signal?: AbortSignal;
}): Promise<GeminiImageResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set');

  const parts: InlineDataPart[] = [{ text: args.prompt }];
  for (const ref of args.references ?? []) {
    parts.push({
      inline_data: {
        mime_type: ref.mimeType,
        data: ref.bytes.toString('base64'),
      },
    });
  }

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_IMAGE_MODEL}:generateContent` +
    `?key=${encodeURIComponent(apiKey)}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: { responseModalities: ['IMAGE'] },
    }),
    signal: args.signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Gemini ${res.status}: ${text || res.statusText}`);
  }

  const json = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: InlineDataPart[] } }>;
  };
  const outParts = json.candidates?.[0]?.content?.parts ?? [];
  for (const p of outParts) {
    const data = p.inline_data?.data ?? p.inlineData?.data;
    if (data) {
      return {
        bytes: Buffer.from(data, 'base64'),
        mimeType: 'image/png',
        modelUsed: GEMINI_IMAGE_MODEL,
      };
    }
  }
  throw new Error('Gemini returned no inline image data');
}
