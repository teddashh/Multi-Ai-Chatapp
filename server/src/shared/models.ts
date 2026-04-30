import type { AIProvider, ChatMode, Tier } from './types.js';

// Each tier has, per provider, a default model + the list of models the user
// is allowed to switch to via the dropdown. Higher tiers strictly include
// lower tiers' choices (a super user can pick anything a test user can).
export interface ModelChoices {
  default: string;
  options: string[];
}

// ChatGPT-account Codex only allows three models — gpt-5.4, gpt-5.4-mini,
// and gpt-5.5. The "-pro" / "-nano" / "gpt-5-mini" SKUs need a
// separate API account and respond with "model is not supported when
// using Codex with a ChatGPT account". Verified via scripts/test-models.

// Free tier — single cheapest pick per provider, locked. Free accounts also
// have a per-mode daily quota enforced separately.
const FREE: Record<AIProvider, ModelChoices> = {
  claude: {
    default: 'claude-haiku-4-5',
    options: ['claude-haiku-4-5'],
  },
  chatgpt: {
    default: 'gpt-5.4-mini',
    options: ['gpt-5.4-mini'],
  },
  gemini: {
    default: 'gemini-3.1-flash-lite-preview',
    options: ['gemini-3.1-flash-lite-preview'],
  },
  grok: {
    default: 'grok-4-1-fast-non-reasoning',
    options: ['grok-4-1-fast-non-reasoning'],
  },
};

const STANDARD: Record<AIProvider, ModelChoices> = {
  claude: {
    default: 'claude-haiku-4-5',
    options: ['claude-haiku-4-5'],
  },
  chatgpt: {
    default: 'gpt-5.4-mini',
    options: ['gpt-5.4-mini'],
  },
  gemini: {
    default: 'gemini-3-flash-preview',
    options: ['gemini-3-flash-preview', 'gemini-3.1-flash-lite-preview'],
  },
  grok: {
    default: 'grok-4-1-fast-reasoning',
    options: ['grok-4-1-fast-reasoning', 'grok-4-1-fast-non-reasoning'],
  },
};

const PRO: Record<AIProvider, ModelChoices> = {
  claude: {
    default: 'claude-sonnet-4-6',
    options: ['claude-sonnet-4-6', 'claude-haiku-4-5'],
  },
  chatgpt: {
    default: 'gpt-5.4',
    options: ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini'],
  },
  gemini: {
    default: 'gemini-3.1-pro-preview',
    options: ['gemini-3.1-pro-preview', 'gemini-3-pro-preview', 'gemini-3-flash-preview'],
  },
  grok: {
    default: 'grok-4.20-0309-non-reasoning',
    options: [
      'grok-4.20-0309-non-reasoning',
      'grok-4-1-fast-reasoning',
    ],
  },
};

const SUPER: Record<AIProvider, ModelChoices> = {
  claude: {
    default: 'claude-opus-4-7',
    options: ['claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
  },
  chatgpt: {
    // -pro / o-series / codex SKUs route through openai-responses.ts
    // (different endpoint, same caller surface) so they're safe to
    // expose. Default stays at gpt-5.5 — picking a -pro / o-series is
    // deliberately spending more for that turn.
    default: 'gpt-5.5',
    options: [
      'gpt-5.5-pro',
      'gpt-5.5',
      'gpt-5.4-pro',
      'gpt-5.4',
      'gpt-5.4-mini',
      'o3',
      'o4-mini',
      'gpt-5-codex',
    ],
  },
  gemini: {
    default: 'gemini-3.1-pro-preview',
    options: ['gemini-3.1-pro-preview', 'gemini-3-pro-preview', 'gemini-3-flash-preview'],
  },
  grok: {
    default: 'grok-4.20-0309-reasoning',
    options: [
      'grok-4.20-0309-reasoning',
      'grok-4.20-0309-non-reasoning',
      'grok-4-1-fast-reasoning',
    ],
  },
};

// Admin tier === Super tier model-wise (admin is purely a permission flag,
// not a separate model bracket).
export const TIER_MODELS: Record<Tier, Record<AIProvider, ModelChoices>> = {
  free: FREE,
  standard: STANDARD,
  pro: PRO,
  super: SUPER,
  admin: SUPER,
};

// Per-mode daily quota for free tier. Counts user messages started in
// each mode within the current local day.
export const FREE_DAILY_QUOTA_PER_MODE = 1;

// Models that should only appear in specific modes — filtering at the
// dropdown level keeps users from accidentally sending an o-series
// reasoning request inside a casual free-mode chat (slow + expensive)
// or codex outside the Coding pipeline. Server still resolves whatever
// the client sends; this is UX, not security.
const CODING_ONLY_MODELS = new Set<string>(['gpt-5-codex']);
const REASONING_ONLY_MODELS = new Set<string>(['o3', 'o4-mini']);

export function modelAvailableInMode(model: string, mode: ChatMode): boolean {
  if (CODING_ONLY_MODELS.has(model) && mode !== 'coding') return false;
  if (REASONING_ONLY_MODELS.has(model) && mode !== 'reasoning') return false;
  return true;
}

// The list of models the UI should offer for a given (tier, provider, mode).
// Always a subset of TIER_MODELS[tier][provider].options.
export function availableModelsForMode(
  tier: Tier,
  provider: AIProvider,
  mode: ChatMode,
): string[] {
  return TIER_MODELS[tier][provider].options.filter((m) =>
    modelAvailableInMode(m, mode),
  );
}

// Image-mode model dropdown — separate catalogue from chat models since
// each vendor's image gen API is unrelated. SDXL is everyone's universal
// fallback (Phase C). Verified-against-live-catalog SKU names below.
export const IMAGE_MODELS: Record<AIProvider, string[]> = {
  chatgpt: ['gpt-image-1-high', 'gpt-image-1-medium', 'gpt-image-1-low', 'sdxl'],
  claude: ['flux-1.1-pro-ultra', 'flux-1.1-pro', 'sdxl'],
  gemini: [
    'imagen-4.0-ultra-generate-001',
    'imagen-4.0-generate-001',
    'imagen-4.0-fast-generate-001',
    'gemini-3-pro-image-preview',
    'gemini-3.1-flash-image-preview',
    'gemini-2.5-flash-image',
    'sdxl',
  ],
  grok: ['grok-imagine-image-pro', 'grok-imagine-image', 'sdxl'],
};

export const IMAGE_MODEL_DEFAULTS: Record<AIProvider, string> = {
  chatgpt: 'gpt-image-1-medium',
  claude: 'flux-1.1-pro',
  gemini: 'imagen-4.0-generate-001',
  grok: 'grok-imagine-image',
};

export function defaultModel(tier: Tier, provider: AIProvider): string {
  return TIER_MODELS[tier][provider].default;
}

// Returns the model the user wants to use for this provider, validating against
// what their tier is allowed. Falls back to the tier default on missing/invalid.
export function resolveModel(
  tier: Tier,
  provider: AIProvider,
  override?: string,
): string {
  const choices = TIER_MODELS[tier][provider];
  if (override && choices.options.includes(override)) return override;
  return choices.default;
}
