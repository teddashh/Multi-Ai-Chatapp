// Persona matrix — deterministic compressor for "sun × moon × rising
// × MBTI" into a (title, comment) pair without storing a 27,648-row
// table. Title = SUN_PREFIX + MBTI_NOUN. Comment = optional pieces
// from rising/MBTI/moon joined by "，" inside one set of parens.
//
// Source: the four-AI debate exported on 2026-04-30. Gemini's final
// "five-table dictionary" approach won out — it covers every combo
// by composition and reads like the human-written examples (護主的
// 反骨小丑 / 隱藏的王者建築師 etc.) instead of like a Mad Libs.

import type { SignKey } from './constants';

const SUN_PREFIX: Record<SignKey, string> = {
  aries: '暴衝的',
  taurus: '穩如老狗的',
  gemini: '精神分裂的',
  cancer: '溫情護短的',
  leo: '自帶聚光燈的',
  virgo: '像素級挑剔的',
  libra: '選擇障礙的',
  scorpio: '腹黑致命的',
  sagittarius: '隨時會消失的',
  capricorn: '莫得感情的',
  aquarius: '來自外星的',
  pisces: '活在夢裡的',
};

const MBTI_NOUN: Record<string, string> = {
  INTJ: '系統設計師',
  INTP: '邏輯拆解怪',
  ENTJ: '鐵血指揮官',
  ENTP: '反骨辯論家',
  INFJ: '靈魂預言家',
  INFP: '宇宙流浪詩人',
  ENFJ: '精神領袖',
  ENFP: '靈感發電機',
  ISTJ: '秩序守護神',
  ISFJ: '護主神盾',
  ESTJ: '無情推進器',
  ESFJ: '人情世故大總管',
  ISTP: '冷兵器工匠',
  ISFP: '唯美刺客',
  ESTP: '極限玩家',
  ESFP: '氣氛製造機',
};

const RISING_VIBE: Record<SignKey, string> = {
  aries: '看似衝動火爆',
  taurus: '看似遲鈍無害',
  gemini: '看似跟誰都能聊',
  cancer: '看似溫和其實防備心極重',
  leo: '看似氣場輾壓全場',
  virgo: '看似安靜其實在挑毛病',
  libra: '看似完美無瑕的公關',
  scorpio: '看似看透一切的邊緣人',
  sagittarius: '看似是個樂天傻子',
  capricorn: '看似已經上了三十年班',
  aquarius: '看似跟大家不在同個頻道',
  pisces: '看似隨時都在發呆',
};

const MBTI_ACTION: Record<string, string> = {
  INTJ: '實則已經在腦中把你重構了八次',
  INTP: '實則根本沒在聽，正在想宇宙起源',
  ENTJ: '實則隨時準備接管並優化全場',
  ENTP: '實則只是想看你被激怒的樣子',
  INFJ: '實則早就看穿你內心的千瘡百孔',
  INFP: '實則內心正在上演八點檔小劇場',
  ENFJ: '實則正在盤算怎麼把你拉進他的偉大藍圖',
  ENFP: '實則三分鐘後就會換下一個新目標',
  ISTJ: '實則心裡有一個記分板正在默默扣你的分',
  ISFJ: '實則連你愛吃什麼都已經記在備忘錄裡',
  ESTJ: '實則已經幫你排好下半生的 KPI',
  ESFJ: '實則早就把這裡的八卦和人際網絡全摸透了',
  ISTP: '實則正在評估要用什麼物理方式解決眼前的問題',
  ISFP: '實則在心裡覺得你們的品味都很俗氣',
  ESTP: '實則正在找哪裡有樂子可以痛快闖個禍',
  ESFP: '實則只是不想面對現實的任何責任',
};

const MOON_SOFTSPOT: Record<SignKey, string> = {
  aries: '但其實脾氣來得快去得也快，滿好哄的',
  taurus: '但其實只要給他好吃的就會乖乖聽話',
  gemini: '但其實一安靜下來就會覺得空虛焦慮',
  cancer: '但其實只要認定你是自己人，命都可以給你',
  leo: '但其實私底下超需要別人摸頭說好棒棒',
  virgo: '但其實每天晚上都在後悔今天哪句話沒講好',
  libra: '但其實只是不想當壞人，內心憋得很苦',
  scorpio: '但其實你對他的一點點好，他會記一輩子',
  sagittarius: '但其實骨子裡害怕承諾，隨時準備買機票逃跑',
  capricorn: '但其實是因為太怕失敗，只好一直死撐著',
  aquarius: '但其實夜深人靜時也會覺得自己怪得很孤單',
  pisces: '但其實很容易把別人的痛苦當成自己的在扛',
};

export interface PersonaArchetype {
  // Yellow headline string. Returned without "（」 wrappers; caller
  // adds visual styling.
  archetype: string;
  // Note shown in parens after the archetype. Caller renders as
  // "（{note}）". Empty when nothing useful could be composed.
  archetypeNote: string;
}

// Compose archetype from any subset of {sun, moon, rising, mbti}.
// Missing fields just drop their slot; if everything's missing we
// fall back to "未知的神秘人物". Sun/moon/rising are SignKey strings
// (English keys like "leo"); mbti is a 4-letter type, case-insensitive.
export function composePersona(args: {
  sun?: string | null;
  moon?: string | null;
  rising?: string | null;
  mbti?: string | null;
}): PersonaArchetype {
  const sun = args.sun ? (args.sun as SignKey) : null;
  const moon = args.moon ? (args.moon as SignKey) : null;
  const rising = args.rising ? (args.rising as SignKey) : null;
  const mbti = args.mbti ? args.mbti.toUpperCase() : null;

  const allMissing = !sun && !moon && !rising && !mbti;
  if (allMissing) {
    return {
      archetype: '未知的神秘人物',
      archetypeNote: '他的一切都是一個謎，連演算法都不敢亂下定論',
    };
  }

  // Title — sun adjective + MBTI noun. Each side has a fallback so the
  // title still reads clean when half the inputs are missing.
  const sunPart = sun && SUN_PREFIX[sun] ? SUN_PREFIX[sun] : '未知的';
  const mbtiNoun = mbti && MBTI_NOUN[mbti] ? MBTI_NOUN[mbti] : '神祕客';
  const archetype = `${sunPart}${mbtiNoun}`;

  // Comment — up to 3 fragments joined by "，". Order: rising → MBTI
  // action → moon softspot. When the moon line is alone we strip its
  // leading "但" so it reads naturally instead of starting with a
  // dangling conjunction.
  const parts: string[] = [];
  if (rising && RISING_VIBE[rising]) parts.push(RISING_VIBE[rising]);
  if (mbti && MBTI_ACTION[mbti]) parts.push(MBTI_ACTION[mbti]);
  if (moon && MOON_SOFTSPOT[moon]) {
    let m = MOON_SOFTSPOT[moon];
    if (parts.length === 0) {
      m = m.replace(/^但/, '');
    }
    parts.push(m);
  }

  if (parts.length === 0) {
    return {
      archetype,
      archetypeNote: '他的一切都是一個謎，連演算法都不敢亂下定論',
    };
  }

  return { archetype, archetypeNote: parts.join('，') };
}
