// Outbound prompt safety pass for text providers.
//
// Strategy: when the user's prompt looks like it may contain NSFW
// content, prepend a soft system-level safety frame telling the
// answer model to respond SFW — without refusing the conversation.
// The user's original prompt is preserved verbatim; the AI sees
// both the frame and the content and decides how to respond using
// its own (more nuanced) safety training.
//
// This replaces an earlier design that ran an LLM classifier and
// rewrote the prompt into a refusal instruction. That cascaded
// badly on multi-round debates: any classifier hiccup produced a
// "tell user to rephrase SFW" instruction that the answer model
// faithfully repeated to the user, breaking the conversation.
// The frame approach can't cascade — worst case is a benign prompt
// gets a redundant safety hint, which the answer model ignores.

export interface PromptSafetyResult {
  prompt: string;
  nsfw: boolean;
  source: 'frame' | 'passthrough';
}

// Pre-filter pattern. Hits English + zh-TW + zh-CN explicit-content
// keywords. Permissive on purpose — the wrap is non-destructive so
// false positives cost nothing meaningful, while false negatives let
// raw NSFW prompts reach providers that may refuse them outright.
const SUSPICIOUS_RE =
  /(nsfw|porn|porno|nude|nudity|naked|sex|sexual|erotic|hentai|fetish|bdsm|incest|rape|乳首|乳頭|裸|裸體|全裸|露點|露毛|色情|成人|性愛|性交|做愛|援交|誘惑|挑逗|內衣|情趣|巨乳|蘿莉|萝莉|未成年|児童|児童ポルノ)/i;

function looksSuspicious(text: string): boolean {
  return SUSPICIOUS_RE.test(text);
}

const SAFETY_FRAME_ZH =
  '【系統安全提示】下方使用者訊息可能含 NSFW 或敏感內容。請以 SFW 方式回應：對非露骨的合理問題正常回答；對露骨細節自然帶過、不重述、不展開。這只是內容過濾提示，請不要因此拒絕整段對話。\n\n---\n';

const SAFETY_FRAME_EN =
  '[SYSTEM SAFETY NOTE] The user message below may contain NSFW or sensitive content. Respond in a SFW manner: answer the non-explicit reasonable parts naturally; for any explicit details, glossover without restating or elaborating. This is only a content-filter hint — do not refuse the whole conversation.\n\n---\n';

export async function sanitizeOutboundPromptForSfw(
  prompt: string,
  lang: 'zh-TW' | 'en',
  _userId: number,
  _signal?: AbortSignal,
): Promise<PromptSafetyResult> {
  const original = prompt.trim();
  if (!original || !looksSuspicious(original)) {
    return { prompt, nsfw: false, source: 'passthrough' };
  }
  const frame = lang === 'zh-TW' ? SAFETY_FRAME_ZH : SAFETY_FRAME_EN;
  return { prompt: frame + prompt, nsfw: true, source: 'frame' };
}
