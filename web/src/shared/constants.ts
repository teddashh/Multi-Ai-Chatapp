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

export const CHAT_MODES: Record<ChatMode, { name: string; description: string; icon: string }> = {
  free: { name: '自由模式', description: '同時發給四家，各自獨立回答', icon: '⚡' },
  debate: { name: '四方辯證', description: '正方 → 反方 → 判官 → 總結', icon: '⚔️' },
  consult: { name: '多方諮詢', description: '雙源先答 → 審查 → 總結', icon: '🔍' },
  coding: { name: 'Coding 模式', description: '規劃 → 審查 → 實作 → 測試（8 步）', icon: '💻' },
  roundtable: { name: '道理辯證', description: '5 輪辯證螺旋 × 4 人', icon: '🔄' },
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
