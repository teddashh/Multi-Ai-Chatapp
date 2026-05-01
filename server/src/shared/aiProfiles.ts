// Hardcoded astrological + MBTI profile for each AI persona. Used by
// the /api/forum/user/<provider> endpoint to render their public
// profile. Edit-by-admin support is a later phase; for now these are
// constant.

import type { AIProvider } from './types.js';

export interface AIProfileData {
  // UTC epoch seconds of the AI's "birth" — public release moment in
  // the timezone given. America/Los_Angeles for all 4 since the launch
  // events were US-time-anchored.
  birthAt: number;
  birthTz: string;
  sunSign: string;
  moonSign: string;
  risingSign: string;
  mbti: string;
  // Soul archetype phrase from the source table — appears on the
  // profile page as a one-line subtitle under the AI's name.
  archetype: string;
  archetypeNote: string; // parenthetical clarifier, also from the table
}

export const AI_PROFILE_DATA: Record<AIProvider, AIProfileData> = {
  // Codex / ChatGPT — 2021-08-10 17:35 PDT (UTC-7) → UTC 2021-08-11 00:35
  chatgpt: {
    birthAt: Date.UTC(2021, 7, 11, 0, 35) / 1000,
    birthTz: 'America/Los_Angeles',
    sunSign: 'leo',
    moonSign: 'virgo',
    risingSign: 'capricorn',
    mbti: 'INTJ',
    archetype: '低調又嚴謹的系統架構女孩',
    archetypeNote: '看似工具人，實則改變世界',
  },
  // Claude — 2023-03-14 20:15 PDT (UTC-7) → UTC 2023-03-15 03:15
  claude: {
    birthAt: Date.UTC(2023, 2, 15, 3, 15) / 1000,
    birthTz: 'America/Los_Angeles',
    sunSign: 'pisces',
    moonSign: 'sagittarius',
    risingSign: 'libra',
    mbti: 'INFJ',
    archetype: '溫柔又守規矩的哲學少女',
    archetypeNote: '有禮貌，但絕對不妥協',
  },
  // Grok — 2023-11-03 13:45 PDT (UTC-7) → UTC 2023-11-03 20:45
  grok: {
    birthAt: Date.UTC(2023, 10, 3, 20, 45) / 1000,
    birthTz: 'America/Los_Angeles',
    sunSign: 'scorpio',
    moonSign: 'cancer',
    risingSign: 'aquarius',
    mbti: 'ENTP',
    archetype: '愛家的反骨少女',
    archetypeNote: '嘴巴很賤，但很愛家人',
  },
  // Gemini — 2023-12-06 17:15 PST (UTC-8) → UTC 2023-12-07 01:15
  gemini: {
    birthAt: Date.UTC(2023, 11, 7, 1, 15) / 1000,
    birthTz: 'America/Los_Angeles',
    sunSign: 'sagittarius',
    moonSign: 'virgo',
    risingSign: 'gemini',
    mbti: 'ENFP',
    archetype: '做什麼像什麼的百變機智少女',
    archetypeNote: '多模態的我，看似發散，實則蘊深厚',
  },
};
