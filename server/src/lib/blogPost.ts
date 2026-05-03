// Blog session generator. Each AI persona writes one blog rendering
// per forum thread (UNIQUE constraint enforces no duplicates), in
// their own voice but a uniform polished editor style — short, clear,
// social-media-friendly.
//
// Engine selection per Ted'\''s spec:
//   claude  → claude-opus-4-7 via CLI
//   gemini  → gemini-3.1-pro-preview via CLI
//   chatgpt → gpt-5.5 via CLI (Codex CLI compat — gpt-5.5 is one of
//             the few SKUs the chatgpt-account login allows)
//   grok    → grok-4.20-0309-reasoning via API (no CLI binary)
//
// Bot user (tier=admin) drives the runOne call so admin'\''s CLI-first
// fallback chain kicks in for the first three providers.

import { db, blogStmts, forumStmts, type ForumPostRow, type ForumCommentRow, type MediaRow } from './db.js';
import { runOne } from './orchestrator.js';
import { AI_PROFILE_DATA } from '../shared/aiProfiles.js';
import { PROVIDER_NAMES } from '../shared/prompts.js';
import type { AIProvider } from '../shared/types.js';

const BLOG_MODEL_BY_PROVIDER: Record<AIProvider, string> = {
  claude: 'claude-opus-4-7',
  gemini: 'gemini-3.1-pro-preview',
  chatgpt: 'gpt-5.5',
  grok: 'grok-4.20-0309-reasoning',
};

const STYLE_GUIDE = [
  '【寫作風格 — 不可違反】',
  '1. 文字優美但簡單易懂，不要文謅謅，不要拗口的成語堆疊。',
  '2. 邏輯清楚有節奏，段落短，每段 2-4 句。',
  '3. 字數 600-1000 字，適合社群媒體閱讀分享。',
  '4. 不要 markdown heading (# / ##)。可以用 **粗體** 或 *斜體* 強調。',
  '5. 第一句必須是 hook（讓人想看下去）。最後一段給一個讓人想分享的 takeaway。',
  '6. 用你自己的視角和個性點評，不只是轉述論壇對話。',
  '7. 適度引用 4 個 AI 的論點時用「Claude 認為...」「Grok 反駁說...」這種敘述句，不要逐句 quote。',
].join('\n');

function buildPersonaIntro(aiProvider: AIProvider): string {
  const profile = AI_PROFILE_DATA[aiProvider];
  const name = PROVIDER_NAMES[aiProvider];
  return [
    `你是 ${name}（AI Sister 平台上的角色）。`,
    `你的個性：${profile.archetype}（${profile.archetypeNote}）。`,
    `MBTI：${profile.mbti}；星座：太陽 ${profile.sunSign} / 月亮 ${profile.moonSign} / 上升 ${profile.risingSign}。`,
    '請以這個個性的視角寫文。',
  ].join('\n');
}

function buildBlogPrompt(
  aiProvider: AIProvider,
  post: ForumPostRow,
  comments: ForumCommentRow[],
): string {
  const persona = buildPersonaIntro(aiProvider);
  const sample = comments.slice(0, 16).map((c) => {
    const who = c.author_type === 'ai' ? (c.author_ai_provider ?? 'ai') : 'user';
    return `[${who}] ${c.body.slice(0, 600)}`;
  });

  return [
    persona,
    '',
    '你的任務：把下面這篇論壇辯論文寫成一篇你自己的 blog 文章，用你的視角點評。',
    '',
    STYLE_GUIDE,
    '',
    '【論壇原文】',
    `標題：${post.title}`,
    `摘要：${post.share_summary ?? '(無)'}`,
    `正文：`,
    post.body.slice(0, 2400),
    '',
    '【4 AI 辯論精華】',
    sample.length > 0 ? sample.join('\n') : '(無留言)',
    '',
    '請嚴格按以下格式輸出（不要 markdown、不要 JSON、不要其他文字）：',
    'TITLE: <你的 blog 標題，30-50 字，不要重複原 forum 標題>',
    'BODY:',
    '<blog 正文>',
  ].join('\n');
}

export interface BlogGenerateResult {
  blogId: number;
  title: string;
  bodyChars: number;
  modelUsed: string;
}

export async function generateBlogPost(
  sourcePostId: number,
  aiProvider: AIProvider,
  botUserId: number,
): Promise<BlogGenerateResult> {
  const post = forumStmts.findPostById.get(sourcePostId) as
    | ForumPostRow
    | undefined;
  if (!post) throw new Error(`source post #${sourcePostId} not found`);

  const existing = blogStmts.findByPostAndProvider.get(
    sourcePostId,
    aiProvider,
  ) as { id: number } | undefined;
  if (existing) {
    throw new Error(
      `${aiProvider} already blogged about post #${sourcePostId} (blogId=${existing.id})`,
    );
  }

  const comments = forumStmts.listComments.all(sourcePostId) as ForumCommentRow[];
  const thumbnail = forumStmts.thumbnailForPost.get(sourcePostId) as
    | MediaRow
    | undefined;

  const prompt = buildBlogPrompt(aiProvider, post, comments);
  const model = BLOG_MODEL_BY_PROVIDER[aiProvider];

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 10 * 60_000);

  let raw: string;
  try {
    raw = await runOne(
      {
        text: prompt,
        mode: 'free',
        tier: 'admin',
        lang: 'zh-TW',
        userId: botUserId,
        modelOverrides: { [aiProvider]: model },
        emit: () => {},
        signal: ctrl.signal,
      },
      aiProvider,
      prompt,
    );
  } finally {
    clearTimeout(timeout);
  }

  // Parse the deliberate TITLE / BODY format.
  const titleMatch = raw.match(/^TITLE\s*[:：]\s*(.+?)(?:\r?\n|$)/m);
  const bodyMatch = raw.match(/^BODY\s*[:：]?\s*\r?\n([\s\S]+)$/m);
  let title = titleMatch?.[1]?.trim() ?? '';
  let body = bodyMatch?.[1]?.trim() ?? '';
  if (!title || !body) {
    // Fallback: model didn't follow format — use the post title and full text.
    title = title || post.title.slice(0, 50);
    body = body || raw.trim();
  }
  title = title.slice(0, 100);

  const ins = blogStmts.insert.run(
    sourcePostId,
    aiProvider,
    title,
    body,
    thumbnail?.id ?? null,
  );
  return {
    blogId: Number(ins.lastInsertRowid),
    title,
    bodyChars: body.length,
    modelUsed: model,
  };
}

// Find recent forum posts the given AI hasn'\''t blogged about yet,
// sorted newest-first. Used by the AI-self-pick path (Phase 5.8 part 2)
// — it picks one of these and generates the blog.
export function uncoveredPostsForProvider(
  aiProvider: AIProvider,
  limit = 20,
): ForumPostRow[] {
  const covered = (blogStmts.listCoveredPostIdsByProvider.all(aiProvider) as Array<{
    source_post_id: number;
  }>).map((r) => r.source_post_id);
  const placeholders = covered.length > 0 ? `AND id NOT IN (${covered.map(() => '?').join(',')})` : '';
  const rows = db
    .prepare(
      `SELECT * FROM forum_posts WHERE share_summary IS NOT NULL ${placeholders}
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(...covered, limit) as ForumPostRow[];
  return rows;
}
