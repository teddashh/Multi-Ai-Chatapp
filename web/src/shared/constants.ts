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

// Sign label maps for the astrology section. Stored as English keys
// in the DB; rendered in zh-TW (the app's primary language).
export const SIGN_KEYS = [
  'aries',
  'taurus',
  'gemini',
  'cancer',
  'leo',
  'virgo',
  'libra',
  'scorpio',
  'sagittarius',
  'capricorn',
  'aquarius',
  'pisces',
] as const;
export type SignKey = (typeof SIGN_KEYS)[number];

export const SIGN_ZH: Record<SignKey, string> = {
  aries: '牡羊座',
  taurus: '金牛座',
  gemini: '雙子座',
  cancer: '巨蟹座',
  leo: '獅子座',
  virgo: '處女座',
  libra: '天秤座',
  scorpio: '天蠍座',
  sagittarius: '射手座',
  capricorn: '摩羯座',
  aquarius: '水瓶座',
  pisces: '雙魚座',
};

export const SIGN_GLYPH: Record<SignKey, string> = {
  aries: '♈',
  taurus: '♉',
  gemini: '♊',
  cancer: '♋',
  leo: '♌',
  virgo: '♍',
  libra: '♎',
  scorpio: '♏',
  sagittarius: '♐',
  capricorn: '♑',
  aquarius: '♒',
  pisces: '♓',
};

export function signLabel(key: string | null | undefined): string {
  if (!key) return '';
  const k = key as SignKey;
  return SIGN_ZH[k] ? `${SIGN_GLYPH[k]} ${SIGN_ZH[k]}` : key;
}

// Sun sign from a (month, day) pair. Mirrors the server-side function
// in server/src/shared/astrology.ts; same boundary table.
export function sunSignFromMonthDay(month: number, day: number): SignKey {
  const md = month * 100 + day;
  if (md >= 321 && md <= 419) return 'aries';
  if (md >= 420 && md <= 520) return 'taurus';
  if (md >= 521 && md <= 620) return 'gemini';
  if (md >= 621 && md <= 722) return 'cancer';
  if (md >= 723 && md <= 822) return 'leo';
  if (md >= 823 && md <= 922) return 'virgo';
  if (md >= 923 && md <= 1022) return 'libra';
  if (md >= 1023 && md <= 1121) return 'scorpio';
  if (md >= 1122 && md <= 1221) return 'sagittarius';
  if (md >= 1222 || md <= 119) return 'capricorn';
  if (md >= 120 && md <= 218) return 'aquarius';
  return 'pisces';
}

export const MBTI_TYPES = [
  'INTJ', 'INTP', 'ENTJ', 'ENTP',
  'INFJ', 'INFP', 'ENFJ', 'ENFP',
  'ISTJ', 'ISFJ', 'ESTJ', 'ESFJ',
  'ISTP', 'ISFP', 'ESTP', 'ESFP',
] as const;
export type MBTI = (typeof MBTI_TYPES)[number];

// Curated timezone list for the birth-tz dropdown. Wider than every
// IANA zone (which would be hundreds) but covers the common cases for
// our user base.
export const COMMON_TIMEZONES = [
  'Asia/Taipei',
  'Asia/Shanghai',
  'Asia/Hong_Kong',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Asia/Seoul',
  'America/Los_Angeles',
  'America/Denver',
  'America/Chicago',
  'America/New_York',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Australia/Sydney',
  'UTC',
] as const;

// Days until next birthday (using birth date in user's birth tz).
// Returns 0 when today is the birthday, 1–365 otherwise. Returns null
// when birthAt is missing.
export function daysUntilBirthday(
  birthAt: number | null,
  birthTz: string | null,
): number | null {
  if (!birthAt) return null;
  const tz = birthTz ?? 'UTC';
  // Pull (month, day) of the birth date in the birth timezone.
  const birthFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    month: '2-digit',
    day: '2-digit',
  });
  const birthParts = birthFmt.formatToParts(new Date(birthAt * 1000));
  let bm = 1, bd = 1;
  for (const p of birthParts) {
    if (p.type === 'month') bm = parseInt(p.value, 10);
    else if (p.type === 'day') bd = parseInt(p.value, 10);
  }
  // Today's (year, month, day) in the same tz so "is it the birthday
  // right now in the user's timezone" stays consistent.
  const todayFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const todayParts = todayFmt.formatToParts(new Date());
  let ty = 2000, tm = 1, td = 1;
  for (const p of todayParts) {
    if (p.type === 'year') ty = parseInt(p.value, 10);
    else if (p.type === 'month') tm = parseInt(p.value, 10);
    else if (p.type === 'day') td = parseInt(p.value, 10);
  }
  const today = Date.UTC(ty, tm - 1, td);
  let next = Date.UTC(ty, bm - 1, bd);
  if (next < today) next = Date.UTC(ty + 1, bm - 1, bd);
  return Math.round((next - today) / 86400000);
}

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
