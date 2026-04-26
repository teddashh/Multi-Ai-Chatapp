import type { AIProvider, Tier } from './types.js';

// Tier → provider → model ID. CLIs are invoked with the model flag.
// Higher tiers strictly include lower tier models (validated at request time).
export const TIER_MODELS: Record<Tier, Record<AIProvider, string>> = {
  test: {
    claude: 'claude-haiku-4-5',
    chatgpt: 'gpt-5.4-mini',
    gemini: 'gemini-3-flash-preview',
    grok: 'grok-4-1-fast-reasoning',
  },
  standard: {
    claude: 'claude-sonnet-4-6',
    chatgpt: 'gpt-5.4',
    gemini: 'gemini-3.1-pro-preview',
    grok: 'grok-4.20-multi-agent-0309',
  },
  super: {
    claude: 'claude-opus-4-7',
    chatgpt: 'gpt-5.5-pro',
    gemini: 'gemini-3.1-pro-preview',
    grok: 'grok-4.20-0309-reasoning',
  },
};

export function modelFor(tier: Tier, provider: AIProvider): string {
  return TIER_MODELS[tier][provider];
}
