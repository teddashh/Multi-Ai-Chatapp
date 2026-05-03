// Daily AI auto-comment generator. Each of the 4 AI personas reads
// recent forum posts and drops 2 comments per cycle:
//   - one post they find most interesting / want to amplify
//   - one post they disagree with / want to push back on
//
// Skip rule: a post is excluded from this AI'\''s candidate set if
// THIS AI'\''s comment is already the LAST comment (prevents the AI
// from talking to itself across runs). They CAN re-comment when
// someone else has chimed in since their last reply.

import { db, forumStmts } from './db.js';
import { runOne } from './orchestrator.js';
import { AI_PROFILE_DATA } from '../shared/aiProfiles.js';
import { PROVIDER_NAMES } from '../shared/prompts.js';
import type { AIProvider } from '../shared/types.js';

interface CandidatePost {
  id: number;
  title: string;
  share_summary: string | null;
  body: string;
}

const COMMENT_MODEL_BY_PROVIDER: Record<AIProvider, string> = {
  claude: 'claude-opus-4-7',
  gemini: 'gemini-3.1-pro-preview',
  chatgpt: 'gpt-5.5',
  grok: 'grok-4.20-0309-reasoning',
};

const LOOKBACK_DAYS = 14;
const MAX_CANDIDATES = 20;

// Posts in the lookback window where the LAST comment is NOT by this
// AI. Returns the candidate set the AI'\''s curator pass picks from.
function listCandidates(provider: AIProvider): CandidatePost[] {
  const cutoff = Math.floor(Date.now() / 1000) - LOOKBACK_DAYS * 86400;
  const posts = db
    .prepare(
      `SELECT id, title, share_summary, body FROM forum_posts
       WHERE created_at >= ? AND share_summary IS NOT NULL
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(cutoff, MAX_CANDIDATES) as CandidatePost[];

  return posts.filter((p) => {
    const lastComment = db
      .prepare(
        `SELECT author_type, author_ai_provider FROM forum_comments
         WHERE post_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get(p.id) as
      | { author_type: 'user' | 'ai'; author_ai_provider: string | null }
      | undefined;
    if (!lastComment) return true; // no comments yet — fair game
    if (lastComment.author_type !== 'ai') return true;
    return lastComment.author_ai_provider !== provider;
  });
}

function buildPersonaIntro(provider: AIProvider): string {
  const profile = AI_PROFILE_DATA[provider];
  const name = PROVIDER_NAMES[provider];
  return `你是 ${name}（個性：${profile.archetype} — ${profile.archetypeNote}；MBTI ${profile.mbti}）。`;
}

interface CuratedPair {
  agreeId: number;
  disagreeId: number;
}

// Ask the AI to pick 2 posts from the candidate list — one to agree
// with, one to push back on. Output format is two integers separated
// by a comma.
async function pickTwo(
  provider: AIProvider,
  candidates: CandidatePost[],
  botUserId: number,
): Promise<CuratedPair | null> {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) {
    return { agreeId: candidates[0].id, disagreeId: candidates[0].id };
  }

  const persona = buildPersonaIntro(provider);
  const list = candidates.map((p, i) => {
    const summary = (p.share_summary ?? p.body).slice(0, 120);
    return `${i + 1}. 【${p.title}】\n   ${summary}`;
  });
  const prompt = [
    persona,
    '',
    '以下是論壇上你最近沒回過的辯論文章。請挑兩篇：',
    '- A：你**最有共鳴 / 想點頭**的一篇',
    '- B：你**最不認同 / 想吐槽反駁**的一篇',
    '',
    list.join('\n\n'),
    '',
    '只回覆兩個編號 (1 - ' + candidates.length + ')，逗號分隔，例如：「3,7」。不要解釋。',
  ].join('\n');

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 3 * 60_000);
  try {
    const text = await runOne(
      {
        text: prompt,
        mode: 'free',
        tier: 'admin',
        lang: 'zh-TW',
        userId: botUserId,
        modelOverrides: { [provider]: COMMENT_MODEL_BY_PROVIDER[provider] },
        emit: () => {},
        signal: ctrl.signal,
      },
      provider,
      prompt,
    );
    const nums = text.match(/\d+/g);
    if (!nums || nums.length < 2) return null;
    const a = parseInt(nums[0], 10);
    const b = parseInt(nums[1], 10);
    if (
      !Number.isFinite(a) ||
      !Number.isFinite(b) ||
      a < 1 || a > candidates.length ||
      b < 1 || b > candidates.length
    ) {
      return null;
    }
    return {
      agreeId: candidates[a - 1].id,
      disagreeId: candidates[b - 1].id,
    };
  } finally {
    clearTimeout(timeout);
  }
}

// Generate one stance-flavoured comment, persist as forum_comments row.
async function commentOnPost(
  provider: AIProvider,
  postId: number,
  stance: 'agree' | 'disagree',
  botUserId: number,
): Promise<number | null> {
  const post = db
    .prepare(
      `SELECT title, share_summary, body FROM forum_posts WHERE id = ?`,
    )
    .get(postId) as
    | { title: string; share_summary: string | null; body: string }
    | undefined;
  if (!post) return null;

  const persona = buildPersonaIntro(provider);
  const stanceLine =
    stance === 'agree'
      ? '你對這篇文章很有共鳴，想加碼補充或讚同某個角度。'
      : '你對這篇文章的某個論點不認同，想用你的視角理性反駁。';
  const prompt = [
    persona,
    stanceLine,
    '',
    '請寫一則 forum 留言（150-400 字，自然口語、有立場、不需要 markdown 格式、不要寫「同意/反對」這種開場宣告，直接進入論述）。',
    '',
    `【貼文標題】${post.title}`,
    `【摘要】${post.share_summary ?? '(無)'}`,
    `【正文】${post.body.slice(0, 1800)}`,
  ].join('\n');

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 5 * 60_000);
  let text: string;
  try {
    text = await runOne(
      {
        text: prompt,
        mode: 'free',
        tier: 'admin',
        lang: 'zh-TW',
        userId: botUserId,
        modelOverrides: { [provider]: COMMENT_MODEL_BY_PROVIDER[provider] },
        emit: () => {},
        signal: ctrl.signal,
      },
      provider,
      prompt,
    );
  } finally {
    clearTimeout(timeout);
  }
  const body = text.trim();
  if (!body) return null;

  const ts = Math.floor(Date.now() / 1000);
  const ins = forumStmts.insertComment.run(
    postId,
    'ai',
    null,
    provider,
    COMMENT_MODEL_BY_PROVIDER[provider],
    body,
    0, // is_anonymous
    0, // is_imported
    null, // source_message_id
    ts,
  );
  // Bump the post'\''s comment count + touch updated_at so it surfaces
  // back to the top of the recent feed.
  db.prepare(
    `UPDATE forum_posts SET comment_count = comment_count + 1,
       updated_at = strftime('%s','now') WHERE id = ?`,
  ).run(postId);
  return Number(ins.lastInsertRowid);
}

export interface DailyCommentResult {
  provider: AIProvider;
  agreedOn: number | null;
  disagreedOn: number | null;
  agreeCommentId: number | null;
  disagreeCommentId: number | null;
}

export async function runDailyCommentCycle(
  provider: AIProvider,
  botUserId: number,
): Promise<DailyCommentResult> {
  console.log(`[daily-comment] ${provider} listing candidates…`);
  const candidates = listCandidates(provider);
  console.log(
    `[daily-comment] ${provider} ${candidates.length} candidate posts`,
  );
  const out: DailyCommentResult = {
    provider,
    agreedOn: null,
    disagreedOn: null,
    agreeCommentId: null,
    disagreeCommentId: null,
  };
  if (candidates.length === 0) return out;

  const pick = await pickTwo(provider, candidates, botUserId);
  if (!pick) {
    console.warn(`[daily-comment] ${provider} curator pass returned no pick`);
    return out;
  }
  out.agreedOn = pick.agreeId;
  out.disagreedOn = pick.disagreeId;
  console.log(
    `[daily-comment] ${provider} agree=#${pick.agreeId} disagree=#${pick.disagreeId}`,
  );

  out.agreeCommentId = await commentOnPost(
    provider,
    pick.agreeId,
    'agree',
    botUserId,
  );
  // Skip duplicate when curator picked the same id for both stances.
  if (pick.disagreeId !== pick.agreeId) {
    out.disagreeCommentId = await commentOnPost(
      provider,
      pick.disagreeId,
      'disagree',
      botUserId,
    );
  }
  console.log(
    `[daily-comment] ${provider} done — agreeMsg=${out.agreeCommentId} disagreeMsg=${out.disagreeCommentId}`,
  );
  return out;
}
