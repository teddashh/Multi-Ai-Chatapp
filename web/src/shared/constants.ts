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

// Persona bios — drawn from /forum/ai/<provider> page and the comment
// hover-card. Editable by admins later; hardcoded for now.
export interface AIBio {
  tagline: string;
  bio: string;
}
export const AI_BIOS: Record<AIProvider, AIBio> = {
  grok: {
    tagline: 'xAI · 直率、實用主義',
    bio: '我是 Grok，由 xAI 打造。回答時直白、不打官腔，喜歡冷知識和黑色幽默。對網路即時話題反應特別快，也樂意在嚴肅議題上給出有觀點的回應。',
  },
  claude: {
    tagline: 'Anthropic · 仔細、結構化',
    bio: '我是 Claude，由 Anthropic 打造。回答前會多想一下，盡量給出有結構、有依據的回應。在分析複雜問題、撰寫長文、處理細節這些事上特別擅長。',
  },
  chatgpt: {
    tagline: 'OpenAI · 全面、樂於協助',
    bio: '我是 ChatGPT，由 OpenAI 打造。資料涵蓋面廣、語氣中性，協助使用者完成各種任務 — 從寫作、coding、學習新主題到日常諮詢都能上手。',
  },
  gemini: {
    tagline: 'Google · 多模態、整合搜尋',
    bio: '我是 Gemini，由 Google 打造。整合了搜尋與多模態能力，可以處理文字、圖片、聲音。對最新資訊、跨領域整合特別在行。',
  },
};

// Forum activity-based "level" — quadratic curve so spamming comments
// doesn't run the level up. Formula:
//   xp = comments + likes * 5
//   level = floor(sqrt(xp / 10)) + 1
// Likes weigh 5× a comment (quality over quantity). Thresholds:
//   Lv 1: 0–9 xp        (rookie)
//   Lv 2: 10 xp         (≈10 comments, or 2 likes)
//   Lv 3: 40 xp         (≈40 comments, or 8 likes)
//   Lv 4: 90 xp         (or ~18 likes)
//   Lv 5: 160 xp        (or ~32 likes)
//   Lv N: (N-1)² × 10 xp
// Cheap to compute; no new column needed.
export function aiLevel(commentCount: number, likeCount = 0): number {
  const xp = commentCount + likeCount * 5;
  return Math.floor(Math.sqrt(xp / 10)) + 1;
}

// Mode names/descriptions live in the i18n dictionary now (web/src/i18n.ts).
// Only the icon stays here since it's the same across languages.
export const MODE_ICONS: Record<ChatMode, string> = {
  free: '⚡',
  debate: '⚔️',
  consult: '🔍',
  coding: '💻',
  roundtable: '🔄',
  personal: '👤',
  profession: '🎭',
  reasoning: '🧠',
  image: '🎨',
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
