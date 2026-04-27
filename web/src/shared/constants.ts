import type {
  AIProvider,
  ChatMode,
  CodingRoles,
  ConsultRoles,
  DebateRoles,
  RoundtableRoles,
} from './types';

export const AI_PROVIDERS: Record<AIProvider, { name: string; color: string }> = {
  chatgpt: { name: 'ChatGPT', color: '#10a37f' },
  claude: { name: 'Claude', color: '#d97706' },
  gemini: { name: 'Gemini', color: '#4285f4' },
  grok: { name: 'Grok', color: '#e11d48' },
};

// Mode names/descriptions live in the i18n dictionary now (web/src/i18n.ts).
// Only the icon stays here since it's the same across languages.
export const MODE_ICONS: Record<ChatMode, string> = {
  free: '⚡',
  debate: '⚔️',
  consult: '🔍',
  coding: '💻',
  roundtable: '🔄',
};

export const DEFAULT_DEBATE_ROLES: DebateRoles = {
  pro: 'chatgpt',
  con: 'claude',
  judge: 'grok',
  summary: 'gemini',
};

export const DEFAULT_CONSULT_ROLES: ConsultRoles = {
  first: 'chatgpt',
  second: 'grok',
  reviewer: 'claude',
  summary: 'gemini',
};

export const DEFAULT_CODING_ROLES: CodingRoles = {
  planner: 'gemini',
  reviewer: 'chatgpt',
  coder: 'claude',
  tester: 'grok',
};

export const DEFAULT_ROUNDTABLE_ROLES: RoundtableRoles = {
  first: 'claude',
  second: 'gemini',
  third: 'grok',
  fourth: 'chatgpt',
};
