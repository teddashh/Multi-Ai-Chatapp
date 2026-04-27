import type { AIProvider, Tier } from './types.js';

// Each tier has, per provider, a default model + the list of models the user
// is allowed to switch to via the dropdown. Higher tiers strictly include
// lower tiers' choices (a super user can pick anything a test user can).
export interface ModelChoices {
  default: string;
  options: string[];
}

const STANDARD: Record<AIProvider, ModelChoices> = {
  claude: {
    default: 'claude-haiku-4-5',
    options: ['claude-haiku-4-5'],
  },
  chatgpt: {
    default: 'gpt-5.4-mini',
    options: ['gpt-5.4-mini', 'gpt-5.4-nano'],
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
    options: ['gpt-5.4', 'gpt-5.4-mini', 'gpt-5-mini'],
  },
  gemini: {
    default: 'gemini-3.1-pro-preview',
    options: ['gemini-3.1-pro-preview', 'gemini-3-pro-preview', 'gemini-3-flash-preview'],
  },
  grok: {
    default: 'grok-4.20-multi-agent-0309',
    options: [
      'grok-4.20-multi-agent-0309',
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
  // gpt-5.5-pro requires API access; ChatGPT-account Codex tops out lower.
  // Default to 5.4 (proven), let user try 5.5 / 5.4-pro via dropdown.
  chatgpt: {
    default: 'gpt-5.4',
    options: ['gpt-5.4', 'gpt-5.5', 'gpt-5.4-pro', 'gpt-5.5-pro', 'gpt-5.4-mini'],
  },
  gemini: {
    default: 'gemini-3.1-pro-preview',
    options: ['gemini-3.1-pro-preview', 'gemini-3-pro-preview', 'gemini-3-flash-preview'],
  },
  grok: {
    default: 'grok-4.20-0309-reasoning',
    options: [
      'grok-4.20-0309-reasoning',
      'grok-4.20-multi-agent-0309',
      'grok-4.20-0309-non-reasoning',
      'grok-4-1-fast-reasoning',
    ],
  },
};

// Admin tier === Super tier model-wise (admin is purely a permission flag,
// not a separate model bracket).
export const TIER_MODELS: Record<Tier, Record<AIProvider, ModelChoices>> = {
  standard: STANDARD,
  pro: PRO,
  super: SUPER,
  admin: SUPER,
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
