// Persona matrix — deterministic compressor for "sun × moon × rising
// × MBTI" into a (title, comment) pair without storing the full
// 27,648-row table. Each cell now ships 5 variants so the dice button
// can re-roll into a different combination of phrasings (5^5 = 3125
// distinct seeds) while keeping the same astro+MBTI data.
//
// Variant index 0 of every table is the "canonical" phrasing — the one
// users see before they ever touch the dice. Index 1–4 are alternate
// phrasings of the same archetype (台灣語感優先、語意一致、跟前後文
// 還能讀通).
//
// Source: the four-AI debate exported on 2026-04-30 (Gemini's final
// 5-table dictionary), expanded with 4 extra Taiwanese-flavoured
// alternatives per cell.

import type { SignKey } from './constants';

// Each table maps a key → 5 phrases. Index 0 is canonical, 1–4 alts.
const SUN_PREFIX: Record<SignKey, [string, string, string, string, string]> = {
  aries: [
    '暴衝的',
    '一鼓作氣的',
    '永遠搶第一的',
    '熱血上腦的',
    '不爽就直接幹的',
  ],
  taurus: [
    '穩如老狗的',
    '慢工出細活的',
    '不動如山的',
    '死守地盤的',
    '什麼都要慢慢來的',
  ],
  gemini: [
    '一秒變臉的',
    '左右互搏的',
    '永遠在切換頻道的',
    '一心多用的',
    '嘴甜手快腦更快的',
  ],
  cancer: [
    '溫情護短的',
    '把家人擺第一的',
    '心軟到爆的',
    '一觸就掉淚的',
    '自帶家人結界的',
  ],
  leo: [
    '自帶聚光燈的',
    '永遠想當主角的',
    '王者氣場全開的',
    '永遠 C 位的',
    '自信爆棚的',
  ],
  virgo: [
    '像素級挑剔的',
    '凡事都要校稿的',
    '對齊強迫症的',
    '不允許錯字的',
    '默默打分數的',
  ],
  libra: [
    '選擇障礙的',
    '永遠在權衡的',
    '怕得罪人的',
    '一秒一個立場的',
    '凡事都要 PK 一下的',
  ],
  scorpio: [
    '腹黑致命的',
    '心機深沉的',
    '一眼看穿你的',
    '默默記仇的',
    '表面冷靜內心翻江倒海的',
  ],
  sagittarius: [
    '隨時會消失的',
    '永遠想跳上飛機的',
    '不肯被綁住的',
    '一秒收行李就跑的',
    '永遠在路上的',
  ],
  capricorn: [
    '冷面執行長的',
    '工作狂的',
    'KPI 上身的',
    '永遠在加班的',
    '把人生當公司在經營的',
  ],
  aquarius: [
    '來自外星的',
    '跟人類有點差距的',
    '思考頻率不一樣的',
    '永遠在開腦洞的',
    '邏輯清奇的',
  ],
  pisces: [
    '活在夢裡的',
    '永遠在出神的',
    '一秒入戲的',
    '自帶柔焦濾鏡的',
    '隨時準備淚崩的',
  ],
};

const MBTI_NOUN: Record<string, [string, string, string, string, string]> = {
  INTJ: ['系統設計師', '暗影策士', '隱藏的建築師', '沉默的軍師', '鐵腦運算員'],
  INTP: ['邏輯拆解怪', '思想實驗室主任', '走神理論家', '拆機天才', '人類疑問製造機'],
  ENTJ: ['鐵血指揮官', '全場接管者', '戰略執行長', '高壓總裁', '終極操盤手'],
  ENTP: ['反骨辯論家', '嘴砲魔王', '抬槓鬼才', '反骨開麥師', '辯論場常勝軍'],
  INFJ: ['靈魂預言家', '沉默的洞察者', '心靈讀稿機', '默默看穿一切的高僧', '內向先知'],
  INFP: ['宇宙流浪詩人', '內心獨白王', '玻璃心詩人', '八點檔主角', '宇宙級易感仔'],
  ENFJ: ['精神領袖', '全場暖場王', '人氣救世主', '心靈導師', '凝聚人心的隊長'],
  ENFP: [
    '靈感發電機',
    '點子無限怪',
    '三分鐘熱度的天才',
    '永遠在燒新主意的',
    '興趣多到爆的散仙',
  ],
  ISTJ: ['秩序守護神', 'SOP 鐵粉', '細節死守者', '流程穩固守衛', '規則本人'],
  ISFJ: ['護主神盾', '默默照顧大隊長', '後勤天使', '暖心備忘錄', '永遠記得你細節的人'],
  ESTJ: ['無情推進器', 'KPI 化身', '鐵腕主管', '行動派督軍', '結案大師'],
  ESFJ: ['人情世故大總管', '八卦中央處理器', '群組組長', '喬事達人', '溫情管家'],
  ISTP: ['默默動手派', '安靜拆機師', '工具魂職人', '一聲不吭的修理工', '機械直覺天才'],
  ISFP: ['唯美刺客', '美感至上俠', '沉默的藝術家', '隱形美學鑑賞家', '不發一語的設計師'],
  ESTP: ['極限玩家', '闖禍實戰派', '衝動冒險家', '危險邊緣派', '永遠在賭一把的'],
  ESFP: ['氣氛製造機', '派對主場 MC', '全場焦點動物', '即興表演大師', '永遠在拍 IG 的'],
};

const RISING_VIBE: Record<SignKey, [string, string, string, string, string]> = {
  aries: [
    '看似衝動火爆',
    '看似一秒就要爆衝',
    '看似充滿戰鬥力',
    '看似永遠在備戰',
    '看似時時都在燃燒',
  ],
  taurus: [
    '看似遲鈍無害',
    '看似佛系慢活',
    '看似什麼都不在意',
    '看似溫吞老實',
    '看似不太想動',
  ],
  gemini: [
    '看似跟誰都能聊',
    '看似自帶八卦雷達',
    '看似資訊爆炸的腦袋',
    '看似話題永遠接得上',
    '看似嘴皮子特別溜',
  ],
  cancer: [
    '看似溫和其實防備心極重',
    '看似親切但保護殼很厚',
    '看似無害但內建警報',
    '看似柔軟但邊界感強',
    '看似好相處其實精挑細選',
  ],
  leo: [
    '看似氣場輾壓全場',
    '看似永遠是話題中心',
    '看似自帶皇族氣質',
    '看似一進場就 hold 住氣氛',
    '看似走到哪都被看的那位',
  ],
  virgo: [
    '看似安靜其實在挑毛病',
    '看似內斂其實滿腦評語',
    '看似不說話其實默默打分',
    '看似溫順其實檢核中',
    '看似低調其實 QA 上身',
  ],
  libra: [
    '看似完美無瑕的公關',
    '看似誰都喜歡的好人緣',
    '看似面面俱到的場控',
    '看似圓融順暢的調停者',
    '看似完美形象在身上',
  ],
  scorpio: [
    '看似冷眼旁觀的觀察者',
    '看似神秘高冷的第三者',
    '看似什麼都看穿的沈默者',
    '看似冷淡其實正在分析',
    '看似不動聲色的監視鏡',
  ],
  sagittarius: [
    '看似是個樂天傻子',
    '看似神經很大條的快樂人',
    '看似毫無心機的歡樂派',
    '看似不會煩惱任何事',
    '看似一路 high 到底的玩咖',
  ],
  capricorn: [
    '看似已經上了三十年班',
    '看似永遠都很疲憊的大人',
    '看似工作壓力沒完沒了',
    '看似從小就老成的老靈魂',
    '看似心累到不行的職場老兵',
  ],
  aquarius: [
    '看似跟大家不在同個頻道',
    '看似永遠在另一個次元',
    '看似活在自己腦補宇宙',
    '看似聊天總接不上',
    '看似異於常人的思考者',
  ],
  pisces: [
    '看似隨時都在發呆',
    '看似總是恍神中',
    '看似目光永遠在遠方',
    '看似身在心不在',
    '看似溫柔到快融化',
  ],
};

const MBTI_ACTION: Record<string, [string, string, string, string, string]> = {
  INTJ: [
    '實則已經在腦中把你重構了八次',
    '實則早就把整盤棋下完三輪',
    '實則默默在背後優化整個系統',
    '實則正盤算如何把你納入長期計畫',
    '實則對話之前已模擬出十種結局',
  ],
  INTP: [
    '實則根本沒在聽，正在想宇宙起源',
    '實則靈魂已經跑到另一個理論',
    '實則正在拆解你的論點找漏洞',
    '實則腦袋裡塞著五十個未完成的問題',
    '實則正在驗證一個你從沒想過的奇怪假設',
  ],
  ENTJ: [
    '實則隨時準備接管並優化全場',
    '實則三秒鐘就排好行動方案',
    '實則正在評估誰值得被提拔',
    '實則已決定接下來的會議節奏',
    '實則默默在主導整場討論',
  ],
  ENTP: [
    '實則只是想看你被激怒的樣子',
    '實則只是想知道你會怎麼反駁',
    '實則正在挖陷阱等你跳',
    '實則只是想撞出新點子',
    '實則嘴上反對心裡爽到爆',
  ],
  INFJ: [
    '實則早就看穿你內心的千瘡百孔',
    '實則已從你語氣中讀出三層情緒',
    '實則默默把你的故事寫進心裡',
    '實則正在讀你話裡的潛台詞',
    '實則早就感覺到你今天怪怪的',
  ],
  INFP: [
    '實則內心正在上演八點檔小劇場',
    '實則一句話被你內心反覆解讀十次',
    '實則默默把對話寫成詩',
    '實則正在揣摩你話背後的傷',
    '實則在心裡演完整部催淚電影',
  ],
  ENFJ: [
    '實則正在盤算怎麼把你拉進他的偉大藍圖',
    '實則正在組織下一場社群活動',
    '實則正計劃讓你變得更好',
    '實則暗中安排把你介紹給對的人',
    '實則想把你的事情全攬下來',
  ],
  ENFP: [
    '實則三分鐘後就會換下一個新目標',
    '實則一邊聊天一邊想新計畫',
    '實則靈感不停從各個方向冒出來',
    '實則同時開了七個專案',
    '實則一句話可以聯想到一百件事',
  ],
  ISTJ: [
    '實則心裡有一個記分板正在默默扣你的分',
    '實則早就把你違規的事都記下來了',
    '實則嚴格按照流程在 cross-check',
    '實則默默核對你說的每件事',
    '實則心中有一條條規則在運作',
  ],
  ISFJ: [
    '實則連你愛吃什麼都已經記在備忘錄裡',
    '實則默默把你的過敏記在心上',
    '實則永遠記得每個人的小細節',
    '實則早就準備好你需要的東西',
    '實則細心到讓你覺得被看見',
  ],
  ESTJ: [
    '實則已經幫你排好下半生的 KPI',
    '實則默默把你的進度條盯死',
    '實則正在算這個 case 的 ROI',
    '實則早就決定誰要被淘汰',
    '實則正把整個流程鐵腕優化',
  ],
  ESFJ: [
    '實則早就把這裡的八卦和人際網絡全摸透了',
    '實則默默維持整個群的和氣',
    '實則記得每個人的恩恩怨怨',
    '實則正在策劃下次聚會',
    '實則默默幫每個人喬好流程',
  ],
  ISTP: [
    '實則正在評估要用什麼物理方式解決眼前的問題',
    '實則默默思考如何手作改造',
    '實則腦中已經拆完整台機器',
    '實則正在計算最省力的解法',
    '實則對工具比對人感興趣',
  ],
  ISFP: [
    '實則在心裡覺得你們的品味都很俗氣',
    '實則默默觀察每個人的色彩搭配',
    '實則對美感的容忍度其實很低',
    '實則一邊聊天一邊調著心裡的色盤',
    '實則對美的東西一秒上癮',
  ],
  ESTP: [
    '實則正在找哪裡有樂子可以痛快闖個禍',
    '實則默默尋找下一個刺激',
    '實則早就鎖定一個冒險目標',
    '實則永遠在尋找下一個刺激體驗',
    '實則一邊講話一邊已經在計畫怎麼玩',
  ],
  ESFP: [
    '實則只是不想面對現實的任何責任',
    '實則只想知道哪裡能讓他發光發熱',
    '實則一秒就能判斷哪個場子比較好玩',
    '實則永遠在拍最好看的角度',
    '實則正在尋找今天最高光的時刻',
  ],
};

const MOON_SOFTSPOT: Record<SignKey, [string, string, string, string, string]> =
  {
    aries: [
      '但其實脾氣來得快去得也快，滿好哄的',
      '但其實一道歉就秒消氣',
      '但其實情緒像煙火，瞬間就熄',
      '但其實是個很怕被冷落的小孩',
      '但其實只要被需要就會立刻回血',
    ],
    taurus: [
      '但其實只要給他好吃的就會乖乖聽話',
      '但其實只要請吃飯什麼都好說',
      '但其實一張舒服的床就能搞定',
      '但其實只要日常規律他就快樂',
      '但其實內心只想被穩穩抱著',
    ],
    gemini: [
      '但其實一安靜下來就會覺得空虛焦慮',
      '但其實一個人時就忍不住胡思亂想',
      '但其實熱鬧背後極怕被冷落',
      '但其實心裡有個聊天視窗永遠開不完',
      '但其實腦袋停不下來才整天找事做',
    ],
    cancer: [
      '但其實只要認定你是自己人，命都可以給你',
      '但其實會把家人朋友的事比自己還重',
      '但其實只要你開口，他就會無限軟化',
      '但其實對自己人記得每一頓飯每一個生日',
      '但其實表面強硬內心是溫泉',
    ],
    leo: [
      '但其實私底下超需要別人摸頭說好棒棒',
      '但其實沒人讚他他就會悄悄受傷',
      '但其實王者外殼下有一顆需要被肯定的心',
      '但其實一句肯定就能撐他一整週',
      '但其實最害怕的是被忽略',
    ],
    virgo: [
      '但其實每天晚上都在後悔今天哪句話沒講好',
      '但其實在被子裡會反覆 review 自己一整天',
      '但其實對自己最嚴苛',
      '但其實永遠覺得自己還不夠好',
      '但其實表面冷靜內心已經寫滿小紙條檢討',
    ],
    libra: [
      '但其實只是不想當壞人，內心憋得很苦',
      '但其實討好別人到自己很累',
      '但其實心裡有個天平壓得他喘不過氣',
      '但其實永遠在害怕被討厭',
      '但其實笑著答應的事大半是不情願',
    ],
    scorpio: [
      '但其實你對他的一點點好，他會記一輩子',
      '但其實一句溫柔的話就能融化他',
      '但其實一旦信任了就奉獻到底',
      '但其實內心是個極度黏人的家貓',
      '但其實表面冷淡卻記住所有細節',
    ],
    sagittarius: [
      '但其實骨子裡害怕承諾，隨時準備買機票逃跑',
      '但其實怕被綁住會直接消失',
      '但其實熱鬧一陣後就想自己一個人',
      '但其實逃跑的背後是怕被傷害',
      '但其實從不真的願意被關進任何盒子',
    ],
    capricorn: [
      '但其實是因為太怕失敗，只好一直死撐著',
      '但其實一閉眼就在懷疑自己是不是不夠好',
      '但其實默默把所有壓力往身上扛',
      '但其實非常需要有人說「沒關係，慢慢來」',
      '但其實工作狂的外殼裡藏著一個累壞的小孩',
    ],
    aquarius: [
      '但其實夜深人靜時也會覺得自己怪得很孤單',
      '但其實偶爾也會羨慕能融入人群的人',
      '但其實渴望被理解但又不想被看穿',
      '但其實看似冷淡其實藏著真心話',
      '但其實太特別常常讓自己很寂寞',
    ],
    pisces: [
      '但其實很容易把別人的痛苦當成自己的在扛',
      '但其實一遇到難過的事就先替別人哭',
      '但其實內心是個情緒海綿',
      '但其實最怕讓人失望',
      '但其實夢裡的世界比現實更真實',
    ],
  };

export interface PersonaArchetype {
  archetype: string;
  archetypeNote: string;
}

// Persona seed encodes which of the 5 variants is picked for each
// of the 5 cells in the matrix. Pack into a single integer
// (base-5, 5 digits) so the server can store it as a normal INTEGER.
export const PERSONA_SEED_RANGE = 5 * 5 * 5 * 5 * 5; // 3125

interface SeedIndices {
  sun: number;
  moon: number;
  rising: number;
  mbtiNoun: number;
  mbtiAction: number;
}

function decodeSeed(seed: number): SeedIndices {
  const safe = ((seed % PERSONA_SEED_RANGE) + PERSONA_SEED_RANGE) % PERSONA_SEED_RANGE;
  return {
    sun: safe % 5,
    moon: Math.floor(safe / 5) % 5,
    rising: Math.floor(safe / 25) % 5,
    mbtiNoun: Math.floor(safe / 125) % 5,
    mbtiAction: Math.floor(safe / 625) % 5,
  };
}

// Compose archetype from any subset of {sun, moon, rising, mbti}.
// `seed` picks variant indices (0–4) for each cell — same seed →
// same persona. seed=null/undefined falls back to the canonical
// (index 0) phrasing on every cell.
export function composePersona(args: {
  sun?: string | null;
  moon?: string | null;
  rising?: string | null;
  mbti?: string | null;
  seed?: number | null;
}): PersonaArchetype {
  const sun = args.sun ? (args.sun as SignKey) : null;
  const moon = args.moon ? (args.moon as SignKey) : null;
  const rising = args.rising ? (args.rising as SignKey) : null;
  const mbti = args.mbti ? args.mbti.toUpperCase() : null;
  const idx = args.seed != null ? decodeSeed(args.seed) : null;
  const pick = (
    table: string[] | undefined,
    which: keyof SeedIndices,
    fallback: string,
  ): string => {
    if (!table || table.length === 0) return fallback;
    const i = idx ? idx[which] % table.length : 0;
    return table[i];
  };

  const allMissing = !sun && !moon && !rising && !mbti;
  if (allMissing) {
    return {
      archetype: '未知的神秘人物',
      archetypeNote: '他的一切都是一個謎，連演算法都不敢亂下定論',
    };
  }

  const sunPart = sun ? pick(SUN_PREFIX[sun], 'sun', '未知的') : '未知的';
  const mbtiNoun = mbti ? pick(MBTI_NOUN[mbti], 'mbtiNoun', '神祕客') : '神祕客';
  const archetype = `${sunPart}${mbtiNoun}`;

  const parts: string[] = [];
  if (rising) {
    const v = pick(RISING_VIBE[rising], 'rising', '');
    if (v) parts.push(v);
  }
  if (mbti) {
    const v = pick(MBTI_ACTION[mbti], 'mbtiAction', '');
    if (v) parts.push(v);
  }
  if (moon) {
    let v = pick(MOON_SOFTSPOT[moon], 'moon', '');
    if (v) {
      if (parts.length === 0) v = v.replace(/^但/, '');
      parts.push(v);
    }
  }

  if (parts.length === 0) {
    return {
      archetype,
      archetypeNote: '他的一切都是一個謎，連演算法都不敢亂下定論',
    };
  }

  return { archetype, archetypeNote: parts.join('，') };
}
