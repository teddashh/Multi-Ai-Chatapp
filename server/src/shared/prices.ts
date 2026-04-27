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
  inputPer1M: number; // USD per 1M input tokens
  outputPer1M: number; // USD per 1M output tokens
}

const PRICES: Record<string, ModelPrice> = {
  // Anthropic — refreshed against the official Claude pricing table.
  // 4.5 / 4.6 / 4.7 share the new $5 / $25 Opus tier (cheaper than the
  // older 4.0 / 4.1 generation at $15 / $75).
  'claude-haiku-4-5': { inputPer1M: 1.0, outputPer1M: 5.0 },
  'claude-sonnet-4-6': { inputPer1M: 3.0, outputPer1M: 15.0 },
  'claude-opus-4-7': { inputPer1M: 5.0, outputPer1M: 25.0 },

  // OpenAI Codex — TODO: replace with user-provided table.
  'gpt-5.4-mini': { inputPer1M: 0.15, outputPer1M: 0.6 },
  'gpt-5.4-nano': { inputPer1M: 0.05, outputPer1M: 0.4 },
  'gpt-5.4': { inputPer1M: 2.5, outputPer1M: 10.0 },
  'gpt-5.4-pro': { inputPer1M: 10.0, outputPer1M: 40.0 },
  'gpt-5.5': { inputPer1M: 1.25, outputPer1M: 10.0 },
  'gpt-5.5-pro': { inputPer1M: 5.0, outputPer1M: 20.0 },
  'gpt-5-mini': { inputPer1M: 0.15, outputPer1M: 0.6 },

  // Google Gemini — refreshed against the official Gemini API table.
  // Prompts in this app stay well under the 200K input boundary so we
  // use the cheaper ≤200K bucket for the Pro tiers.
  'gemini-3-flash-preview': { inputPer1M: 0.5, outputPer1M: 3.0 },
  'gemini-3.1-flash-lite-preview': { inputPer1M: 0.25, outputPer1M: 1.5 },
  'gemini-3-pro-preview': { inputPer1M: 2.0, outputPer1M: 12.0 },
  'gemini-3.1-pro-preview': { inputPer1M: 2.0, outputPer1M: 12.0 },

  // xAI Grok — TODO: replace with user-provided table. These are the
  // only ones the operator actually pays per token (everything else
  // is subscription), so accuracy here matters most.
  'grok-4-1-fast-reasoning': { inputPer1M: 0.2, outputPer1M: 0.5 },
  'grok-4-1-fast-non-reasoning': { inputPer1M: 0.2, outputPer1M: 0.5 },
  'grok-4.20-0309-reasoning': { inputPer1M: 3.0, outputPer1M: 15.0 },
  'grok-4.20-0309-non-reasoning': { inputPer1M: 3.0, outputPer1M: 15.0 },
};

const PROVIDER_FALLBACK: Record<string, ModelPrice> = {
  claude: { inputPer1M: 3.0, outputPer1M: 15.0 },
  chatgpt: { inputPer1M: 2.5, outputPer1M: 10.0 },
  gemini: { inputPer1M: 1.25, outputPer1M: 10.0 },
  grok: { inputPer1M: 1.0, outputPer1M: 5.0 },
};

export function priceFor(provider: string, model: string): ModelPrice {
  return PRICES[model] ?? PROVIDER_FALLBACK[provider] ?? { inputPer1M: 0, outputPer1M: 0 };
}

// Cost for a given (tokens_in, tokens_out) usage row, in USD.
export function estimateCost(
  provider: string,
  model: string,
  tokensIn: number,
  tokensOut: number,
): number {
  const p = priceFor(provider, model);
  return (
    (tokensIn / 1_000_000) * p.inputPer1M +
    (tokensOut / 1_000_000) * p.outputPer1M
  );
}
