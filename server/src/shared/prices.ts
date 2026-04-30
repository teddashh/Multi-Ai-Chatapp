// Per-1M-token pricing for each model. Prices are USD.
//
// IMPORTANT: these are *reference* prices used to compute an estimated
// cost shown in the UI. They are NOT the actual cost the operator pays,
// because most CLI providers (Claude Code / Codex / Gemini CLI) are
// billed on a subscription, not per-token. Only xAI (Grok) goes through
// a metered API and pays for what's logged here.
//
// Numbers may drift — update as needed. If a model isn't listed we
// fall back to the provider's PROVIDER_FALLBACK price.

export interface ModelPrice {
  // Per-token pricing (text models). USD per 1M tokens.
  inputPer1M?: number;
  outputPer1M?: number;
  // Per-image pricing (image-gen models). USD for one generated image.
  // When set, estimateCost ignores token counts and bills tokens_out
  // (number of images) × perImage. Mutually exclusive with the
  // per-token fields in practice.
  perImage?: number;
}

const PRICES: Record<string, ModelPrice> = {
  // Anthropic — refreshed against the official Claude pricing table.
  // 4.5 / 4.6 / 4.7 share the new $5 / $25 Opus tier (cheaper than the
  // older 4.0 / 4.1 generation at $15 / $75).
  'claude-haiku-4-5': { inputPer1M: 1.0, outputPer1M: 5.0 },
  'claude-sonnet-4-6': { inputPer1M: 3.0, outputPer1M: 15.0 },
  'claude-opus-4-7': { inputPer1M: 5.0, outputPer1M: 25.0 },

  // OpenAI / Codex (ChatGPT account) — only these three are available
  // through the Codex CLI with a ChatGPT account. *-pro / *-nano /
  // gpt-5-mini SKUs need a separate OpenAI API account.
  'gpt-5.5': { inputPer1M: 5.0, outputPer1M: 30.0 },
  'gpt-5.4': { inputPer1M: 2.5, outputPer1M: 15.0 },
  'gpt-5.4-mini': { inputPer1M: 0.75, outputPer1M: 4.5 },
  'gpt-5.5-pro': { inputPer1M: 15.0, outputPer1M: 60.0 },
  'gpt-5.4-pro': { inputPer1M: 8.0, outputPer1M: 40.0 },
  'o3': { inputPer1M: 10.0, outputPer1M: 40.0 },
  'o4-mini': { inputPer1M: 1.1, outputPer1M: 4.4 },
  'gpt-5-codex': { inputPer1M: 5.0, outputPer1M: 30.0 },

  // Google Gemini — refreshed against the official Gemini API table.
  // Prompts in this app stay well under the 200K input boundary so we
  // use the cheaper ≤200K bucket for the Pro tiers.
  'gemini-3-flash-preview': { inputPer1M: 0.5, outputPer1M: 3.0 },
  'gemini-3.1-flash-lite-preview': { inputPer1M: 0.25, outputPer1M: 1.5 },
  'gemini-3-pro-preview': { inputPer1M: 2.0, outputPer1M: 12.0 },
  'gemini-3.1-pro-preview': { inputPer1M: 2.0, outputPer1M: 12.0 },

  // xAI Grok — refreshed against the official xAI Chat API table.
  // These are the only ones the operator actually pays per token
  // (everything else is subscription), so the numbers are real.
  'grok-4.20-0309-reasoning': { inputPer1M: 2.0, outputPer1M: 6.0 },
  'grok-4.20-0309-non-reasoning': { inputPer1M: 2.0, outputPer1M: 6.0 },
  'grok-4-1-fast-reasoning': { inputPer1M: 0.2, outputPer1M: 0.5 },
  'grok-4-1-fast-non-reasoning': { inputPer1M: 0.2, outputPer1M: 0.5 },

  // ============================================================
  // Image models — per-generated-image pricing. Numbers are public
  // catalog estimates (USD); refresh when vendor pricing pages change.
  // ============================================================
  // OpenAI gpt-image-1 (quality is a separate API param, encoded as suffix here)
  'gpt-image-1-low': { perImage: 0.02 },
  'gpt-image-1-medium': { perImage: 0.07 },
  'gpt-image-1-high': { perImage: 0.19 },
  'gpt-image-1-mini': { perImage: 0.01 },
  // OpenAI gpt-image-1.5 — newer minor revision, same quality buckets
  'gpt-image-1.5-low': { perImage: 0.025 },
  'gpt-image-1.5-medium': { perImage: 0.08 },
  'gpt-image-1.5-high': { perImage: 0.20 },
  // OpenAI gpt-image-2 — newest, premium pricing
  'gpt-image-2-low': { perImage: 0.04 },
  'gpt-image-2-medium': { perImage: 0.12 },
  'gpt-image-2-high': { perImage: 0.28 },
  'gpt-image-2': { perImage: 0.12 },
  // xAI Aurora
  'grok-imagine-image': { perImage: 0.05 },
  'grok-imagine-image-pro': { perImage: 0.10 },
  // Google Imagen 4 family
  'imagen-4.0-generate-001': { perImage: 0.04 },
  'imagen-4.0-ultra-generate-001': { perImage: 0.06 },
  'imagen-4.0-fast-generate-001': { perImage: 0.02 },
  // Google Gemini image (multimodal output)
  'gemini-3-pro-image-preview': { perImage: 0.04 },
  'gemini-3.1-flash-image-preview': { perImage: 0.03 },
  'gemini-2.5-flash-image': { perImage: 0.04 },
  // Black Forest Labs Flux — used as Anthropic's image partner via API
  'flux-1.1-pro': { perImage: 0.04 },
  'flux-1.1-pro-ultra': { perImage: 0.06 },
  // Universal cheap fallback
  'sdxl': { perImage: 0.003 },

  // Synthetic SKU for the persona-dice feature. Each roll is billed
  // as if it were one tiny LLM call so the user's cost dashboard
  // shows the dice activity. Real LLM is never invoked.
  'persona-dice': { perImage: 0.001 },
};

const PROVIDER_FALLBACK: Record<string, ModelPrice> = {
  claude: { inputPer1M: 3.0, outputPer1M: 15.0 },
  chatgpt: { inputPer1M: 2.5, outputPer1M: 10.0 },
  gemini: { inputPer1M: 1.25, outputPer1M: 10.0 },
  grok: { inputPer1M: 1.0, outputPer1M: 5.0 },
};

export function priceFor(provider: string, model: string): ModelPrice {
  // Strip the stage prefix (e.g. "claude_api:", "openai_image_api:") that
  // orchestrator attaches when logging non-CLI usage. The prefix isn't
  // part of the SKU's pricing key, so without this strip every fallback
  // /image-gen row was hitting PROVIDER_FALLBACK instead of the exact
  // entry — costs were under/over-counted accordingly.
  const colonIdx = model.indexOf(':');
  const cleanModel = colonIdx >= 0 ? model.slice(colonIdx + 1) : model;
  return PRICES[cleanModel] ?? PROVIDER_FALLBACK[provider] ?? { inputPer1M: 0, outputPer1M: 0 };
}

// Cost for a given (tokens_in, tokens_out) usage row, in USD.
// Image models are billed flat per image — for those, tokens_out
// carries the image count (insertImageUsage logs `1`).
export function estimateCost(
  provider: string,
  model: string,
  tokensIn: number,
  tokensOut: number,
): number {
  const p = priceFor(provider, model);
  if (p.perImage !== undefined) {
    return tokensOut * p.perImage;
  }
  return (
    (tokensIn / 1_000_000) * (p.inputPer1M ?? 0) +
    (tokensOut / 1_000_000) * (p.outputPer1M ?? 0)
  );
}

// Compact label for the model dropdown. Examples:
//   text:  "$5/$30 /M"      (inputPer1M / outputPer1M, per million)
//   image: "$0.07/img"
// Empty string when we have no price info — keeps the option clean
// rather than rendering "$0/$0" when the table doesn't cover the SKU.
export function formatPriceLabel(provider: string, model: string): string {
  const p = priceFor(provider, model);
  if (p.perImage !== undefined) {
    const v = p.perImage;
    const formatted = v < 0.01 ? v.toFixed(3) : v.toFixed(2);
    return `$${formatted}/img`;
  }
  if (p.inputPer1M !== undefined && p.outputPer1M !== undefined) {
    return `$${trim(p.inputPer1M)}/$${trim(p.outputPer1M)} /M`;
  }
  return '';
}

// Drop trailing ".0" so "$5.0" → "$5" — looks cleaner in the dropdown.
function trim(n: number): string {
  return n.toFixed(2).replace(/\.?0+$/, '');
}
