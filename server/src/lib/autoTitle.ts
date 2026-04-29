// Auto-generate a session title from the user's first message via the
// NVIDIA NIM hosted catalog. Free credits, runs once per new session,
// background non-streaming call so the user doesn't wait on it.
//
// Cost shape: ~1 NVIDIA call per new session. Llama 3.3 70B at ~0.05
// credits/req → 1000 credits buys ~20k sessions. Plenty of headroom.

import { nvidiaChatOnce } from './providers/nvidia.js';

// Trim quotes / punctuation a title-happy LLM tends to wrap responses in.
function cleanTitle(raw: string): string {
  return raw
    .replace(/^["「『'']+|["」』''。。.!！?？\s]+$/g, '')
    .trim();
}

export async function generateSessionTitle(
  userMessage: string,
  lang: 'zh-TW' | 'en',
): Promise<string | null> {
  if (!process.env.NVIDIA_API_KEY) return null;

  const systemPrompt =
    lang === 'zh-TW'
      ? '你是對話命名助手。根據使用者的訊息，產生一個 8 到 14 字的繁體中文（台灣用語）標題，能讓人一眼看懂這個對話在聊什麼。只輸出標題本身，不要引號、不要句點、不要前綴或結尾文字。'
      : 'You are a conversation titling assistant. From the user message, produce a concise English title of 4-8 words that captures the topic. Output the title only — no quotes, no period, no prefix or suffix text.';

  const userPrompt = userMessage.slice(0, 800);

  try {
    const raw = await nvidiaChatOnce({
      // Llama 3.3 70B is fast (~1-2 sec), cheap, and good enough for an
      // 8-14 char summary. Going smaller (3B) saves credits but the
      // titles felt generic in spot checks.
      model: 'meta/llama-3.3-70b-instruct',
      systemPrompt,
      userPrompt,
      lang,
      maxTokens: 60,
    });
    const title = cleanTitle(raw);
    if (!title) return null;
    // Sanity cap — anything past ~40 chars is the model rambling, not titling.
    if (title.length > 40) return title.slice(0, 40);
    return title;
  } catch (err) {
    console.error('[auto-title] generation failed', (err as Error).message);
    return null;
  }
}
