// Forum routes — public read (anyone can browse), auth-only write.
// Posts are spawned exclusively from chat sessions: the first user
// message becomes the post body, subsequent messages become imported
// comments. Re-sharing the same session appends new messages instead
// of creating a duplicate post (UNIQUE constraint on source_session_id
// enforces one-post-per-session).

import { Hono } from 'hono';
import {
  optionalAuth,
  requireAuth,
  type AppVariables,
  type SessionUser,
} from '../lib/auth.js';
import {
  db,
  forumStmts,
  messageStmts,
  sessionStmts,
  userStmts,
  type ForumCommentRow,
  type ForumPostRow,
  type MessageRow,
  type SessionRow,
  type UserRow,
} from '../lib/db.js';
import { FORUM_CATEGORIES, type ForumCategory } from '../shared/types.js';

export const forumRoute = new Hono<{ Variables: AppVariables }>();

const PAGE_SIZE = 20;
const MAX_COMMENT_LEN = 5000;
const PREVIEW_LEN = 200;

interface PostListRow extends ForumPostRow {
  author_username: string;
  author_nickname: string | null;
}

interface CommentListRow extends ForumCommentRow {
  author_username: string | null;
  author_nickname: string | null;
  author_avatar: string | null;
}

function previewOf(body: string): string {
  if (body.length <= PREVIEW_LEN) return body;
  return body.slice(0, PREVIEW_LEN);
}

function userDisplay(
  username: string | null,
  nickname: string | null,
  isAnonymous: boolean,
): string {
  if (isAnonymous) return '匿名';
  return nickname || username || '?';
}

function formatPostSummary(r: PostListRow) {
  return {
    id: r.id,
    category: r.category,
    sourceMode: r.source_mode,
    title: r.title,
    bodyPreview: previewOf(r.body),
    authorUsername: r.is_anonymous ? null : r.author_username,
    authorDisplay: userDisplay(r.author_username, r.author_nickname, !!r.is_anonymous),
    isAnonymous: !!r.is_anonymous,
    thumbsCount: r.thumbs_count,
    commentCount: r.comment_count,
    createdAt: r.created_at * 1000,
    updatedAt: r.updated_at * 1000,
  };
}

function formatPostDetail(r: PostListRow, liked: boolean) {
  return {
    ...formatPostSummary(r),
    body: r.body,
    aiPersona: r.ai_persona ?? null,
    liked,
  };
}

function formatComment(r: CommentListRow, liked: boolean) {
  // AI comments must always be named (per spec — needed for per-AI like
  // stats). User comments respect is_anonymous. The model SKU
  // (grok-4-1-fast-reasoning etc.) is intentionally not exposed publicly
  // — only the provider family is shown.
  let display: string;
  if (r.author_type === 'ai') {
    display = r.author_ai_provider ?? 'AI';
  } else {
    display = userDisplay(r.author_username, r.author_nickname, !!r.is_anonymous);
  }
  return {
    id: r.id,
    authorType: r.author_type,
    authorDisplay: display,
    authorUsername:
      r.author_type === 'user' && !r.is_anonymous ? r.author_username : null,
    authorAvatarPath:
      r.author_type === 'user' && !r.is_anonymous ? r.author_avatar : null,
    authorAiProvider: r.author_ai_provider ?? undefined,
    body: r.body,
    isAnonymous: !!r.is_anonymous,
    isImported: !!r.is_imported,
    thumbsCount: r.thumbs_count,
    createdAt: r.created_at * 1000,
    liked,
  };
}

// ---------------------------------------------------------------------------
// GET /api/forum/categories — fixed 看板 list with per-category counts.
// Public; FORUM_CATEGORIES is the source of truth so empty categories
// still render in the UI.
// ---------------------------------------------------------------------------
forumRoute.get('/categories', (c) => {
  const counts = forumStmts.countByCategory.all() as Array<{
    category: string;
    n: number;
  }>;
  const map = new Map(counts.map((r) => [r.category, r.n]));
  return c.json({
    categories: FORUM_CATEGORIES.map((cat) => ({
      category: cat,
      count: map.get(cat) ?? 0,
    })),
  });
});

// ---------------------------------------------------------------------------
// GET /api/forum?category=xxx&page=N — public post list.
// ---------------------------------------------------------------------------
forumRoute.get('/', (c) => {
  const category = c.req.query('category');
  const page = Math.max(1, parseInt(c.req.query('page') ?? '1', 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  if (category && !FORUM_CATEGORIES.includes(category as ForumCategory)) {
    return c.json({ error: 'invalid category' }, 400);
  }

  const rows = (
    category
      ? forumStmts.listByCategory.all(category, PAGE_SIZE, offset)
      : forumStmts.listAll.all(PAGE_SIZE, offset)
  ) as PostListRow[];

  return c.json({
    posts: rows.map(formatPostSummary),
    page,
    pageSize: PAGE_SIZE,
  });
});

// ---------------------------------------------------------------------------
// GET /api/forum/:postId — public detail view. optionalAuth so the
// `liked` flag hydrates for logged-in users without locking out anons.
// ---------------------------------------------------------------------------
forumRoute.get('/:postId', optionalAuth, (c) => {
  const postId = parseInt(c.req.param('postId') ?? '', 10);
  if (!Number.isFinite(postId) || postId <= 0) {
    return c.json({ error: 'invalid id' }, 400);
  }

  const postRow = forumStmts.findPostById.get(postId) as
    | ForumPostRow
    | undefined;
  if (!postRow) return c.json({ error: 'not found' }, 404);

  // findPostById doesn't join users — fetch the author row separately.
  const author =
    (db
      .prepare('SELECT username, nickname FROM users WHERE id = ?')
      .get(postRow.author_user_id) as
      | { username: string; nickname: string | null }
      | undefined) ?? { username: '?', nickname: null };

  const commentRows = forumStmts.listComments.all(postId) as CommentListRow[];

  // optionalAuth may or may not have set user; cast to undefined-safe.
  const user = c.get('user') as SessionUser | undefined;
  let likedPost = false;
  let likedCommentIds = new Set<number>();
  if (user) {
    likedPost = !!forumStmts.likedPostByUser.get(user.id, postId);
    const liked = forumStmts.likedCommentsInPost.all(user.id, postId) as Array<{
      target_id: number;
    }>;
    likedCommentIds = new Set(liked.map((r) => r.target_id));
  }

  // Roll AI stats into the post response so per-comment hover cards
  // don't each need a fetch. Always returns all 4 providers (zeros for
  // those who haven't commented yet) so the client can key by provider
  // without a presence check.
  const statRows = forumStmts.allAIStats.all() as Array<{
    provider: string;
    total_comments: number;
    total_likes: number;
  }>;
  const aiStats: Record<string, { totalComments: number; totalLikes: number }> = {
    claude: { totalComments: 0, totalLikes: 0 },
    chatgpt: { totalComments: 0, totalLikes: 0 },
    gemini: { totalComments: 0, totalLikes: 0 },
    grok: { totalComments: 0, totalLikes: 0 },
  };
  for (const r of statRows) {
    if (aiStats[r.provider]) {
      aiStats[r.provider] = {
        totalComments: r.total_comments,
        totalLikes: r.total_likes,
      };
    }
  }

  // Per-participant stats inlined for the user hover card. Keyed by
  // username so the client looks up O(1) per comment.
  const participantRows = forumStmts.participantStats.all(postId, postId) as Array<{
    username: string;
    nickname: string | null;
    has_avatar: number;
    member_since: number;
    total_posts: number;
    total_comments: number;
    total_likes: number;
  }>;
  const userStats: Record<string, {
    username: string;
    nickname: string | null;
    hasAvatar: boolean;
    memberSince: number;
    totalPosts: number;
    totalComments: number;
    totalLikes: number;
  }> = {};
  for (const r of participantRows) {
    userStats[r.username] = {
      username: r.username,
      nickname: r.nickname,
      hasAvatar: !!r.has_avatar,
      memberSince: r.member_since * 1000,
      totalPosts: r.total_posts,
      totalComments: r.total_comments,
      totalLikes: r.total_likes,
    };
  }

  return c.json({
    post: formatPostDetail(
      {
        ...postRow,
        author_username: author.username,
        author_nickname: author.nickname,
      },
      likedPost,
    ),
    comments: commentRows.map((r) => formatComment(r, likedCommentIds.has(r.id))),
    aiStats,
    userStats,
  });
});

// ---------------------------------------------------------------------------
// POST /api/forum/share — share a chat session to the forum. Append-only
// on re-share: anything newer than the highest already-imported source_id
// becomes a new imported comment.
// Body: { sessionId, category, isAnonymous?, title? }
// ---------------------------------------------------------------------------
forumRoute.post('/share', requireAuth, async (c) => {
  const user = c.get('user');
  const body = (await c.req.json().catch(() => null)) as
    | {
        sessionId?: string;
        category?: ForumCategory;
        isAnonymous?: boolean;
        title?: string;
      }
    | null;
  if (!body?.sessionId || !body.category) {
    return c.json({ error: 'sessionId and category required' }, 400);
  }
  if (!FORUM_CATEGORIES.includes(body.category)) {
    return c.json({ error: 'invalid category' }, 400);
  }

  const session = sessionStmts.findOwned.get(body.sessionId, user.id) as
    | SessionRow
    | undefined;
  if (!session) return c.json({ error: 'session not found' }, 404);

  const messages = messageStmts.listForSession.all(
    body.sessionId,
  ) as MessageRow[];
  if (messages.length === 0) return c.json({ error: 'empty session' }, 400);

  const existing = forumStmts.findPostBySession.get(body.sessionId) as
    | ForumPostRow
    | undefined;

  if (existing) {
    // Append mode. category / title / anonymous are locked at first share —
    // ignore the new request's values silently (the modal won't show them).
    const maxRow = forumStmts.maxImportedSourceMsg.get(existing.id) as {
      max: number | null;
    };
    const maxId = maxRow?.max ?? 0;
    const newMsgs = messages.filter((m) => m.id > maxId);
    if (newMsgs.length === 0) {
      return c.json({ postId: existing.id, appended: 0, isNew: false });
    }
    const tx = db.transaction(() => {
      for (const m of newMsgs) {
        forumStmts.insertComment.run(
          existing.id,
          m.role === 'user' ? 'user' : 'ai',
          m.role === 'user' ? user.id : null,
          m.role === 'ai' ? m.provider : null,
          m.role === 'ai'
            ? m.answered_model ?? m.requested_model ?? null
            : null,
          m.content,
          m.role === 'user' ? existing.is_anonymous : 0,
          1,
          m.id,
          m.timestamp,
        );
      }
      forumStmts.bumpCommentCount.run(newMsgs.length, existing.id);
    });
    tx();
    return c.json({
      postId: existing.id,
      appended: newMsgs.length,
      isNew: false,
    });
  }

  // First share: pick the first user message as the post body, everything
  // after as imported comments. We tolerate sessions that lead with an AI
  // message (rare) by searching for the first user role.
  const firstUserIdx = messages.findIndex((m) => m.role === 'user');
  if (firstUserIdx < 0) return c.json({ error: 'no user message' }, 400);

  const firstUser = messages[firstUserIdx];
  const rest = messages.slice(firstUserIdx + 1);
  const isAnonymous = body.isAnonymous ? 1 : 0;
  const titleRaw = body.title?.trim() || firstUser.content.slice(0, 60).trim();
  const title = titleRaw || '(untitled)';

  // Snapshot the profession persona so the forum view survives source
  // session deletion. Only meaningful for `profession` mode; null
  // otherwise.
  let aiPersona: string | null = null;
  if (session.mode === 'profession' && session.roles_json) {
    try {
      const meta = JSON.parse(session.roles_json) as { profession?: unknown };
      if (typeof meta.profession === 'string' && meta.profession.trim()) {
        aiPersona = meta.profession.trim();
      }
    } catch {
      // ignore — fall through with null
    }
  }

  let postId = 0;
  const tx = db.transaction(() => {
    const result = forumStmts.insertPost.run(
      body.category!,
      body.sessionId!,
      session.mode,
      title,
      firstUser.content,
      user.id,
      isAnonymous,
      aiPersona,
    );
    postId = Number(result.lastInsertRowid);
    for (const m of rest) {
      forumStmts.insertComment.run(
        postId,
        m.role === 'user' ? 'user' : 'ai',
        m.role === 'user' ? user.id : null,
        m.role === 'ai' ? m.provider : null,
        m.role === 'ai'
          ? m.answered_model ?? m.requested_model ?? null
          : null,
        m.content,
        m.role === 'user' ? isAnonymous : 0,
        1,
        m.id,
        m.timestamp,
      );
    }
    forumStmts.setCommentCount.run(rest.length, postId);
  });
  tx();

  return c.json({ postId, appended: rest.length, isNew: true });
});

// ---------------------------------------------------------------------------
// POST /api/forum/:postId/comments — public-facing comment from a logged-in
// user (registered users only). AI commenting will land in 5.4.
// ---------------------------------------------------------------------------
forumRoute.post('/:postId/comments', requireAuth, async (c) => {
  const user = c.get('user');
  const postId = parseInt(c.req.param('postId') ?? '', 10);
  if (!Number.isFinite(postId) || postId <= 0) {
    return c.json({ error: 'invalid id' }, 400);
  }
  const body = (await c.req.json().catch(() => null)) as
    | { body?: string; isAnonymous?: boolean }
    | null;
  const text = body?.body?.trim();
  if (!text) return c.json({ error: 'body required' }, 400);
  if (text.length > MAX_COMMENT_LEN) return c.json({ error: 'too long' }, 400);

  const post = forumStmts.findPostById.get(postId) as ForumPostRow | undefined;
  if (!post) return c.json({ error: 'not found' }, 404);

  const tx = db.transaction(() => {
    forumStmts.insertComment.run(
      postId,
      'user',
      user.id,
      null,
      null,
      text,
      body!.isAnonymous ? 1 : 0,
      0,
      null,
      Math.floor(Date.now() / 1000),
    );
    forumStmts.bumpCommentCount.run(1, postId);
  });
  tx();

  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// GET /api/forum/ai/:provider — public AI profile.
// Returns stats (comment count + received likes) and the AI's recent
// forum comments. Bio is held client-side (per-provider hardcoded).
// ---------------------------------------------------------------------------
const VALID_PROVIDERS = new Set(['claude', 'chatgpt', 'gemini', 'grok']);
forumRoute.get('/ai/:provider', (c) => {
  const provider = c.req.param('provider') ?? '';
  if (!VALID_PROVIDERS.has(provider)) {
    return c.json({ error: 'invalid provider' }, 400);
  }
  const stats = forumStmts.aiCommentStats.get(provider) as {
    total_comments: number;
    total_likes: number;
  };
  const recent = forumStmts.aiRecentComments.all(provider, 20) as Array<{
    id: number;
    body: string;
    thumbs_count: number;
    created_at: number;
    is_imported: number;
    post_id: number;
    post_title: string;
    post_category: string;
  }>;
  return c.json({
    provider,
    stats: {
      totalComments: stats.total_comments,
      totalLikes: stats.total_likes,
    },
    recent: recent.map((r) => ({
      id: r.id,
      body: r.body.length > 240 ? r.body.slice(0, 240) + '…' : r.body,
      thumbsCount: r.thumbs_count,
      createdAt: r.created_at * 1000,
      isImported: !!r.is_imported,
      postId: r.post_id,
      postTitle: r.post_title,
      postCategory: r.post_category,
    })),
  });
});

// ---------------------------------------------------------------------------
// GET /api/forum/user/:username — public user profile.
// Returns basic profile + cumulative forum stats + recent activity.
// Anonymous-flagged posts/comments are excluded from the recent feed
// (the user posted them anonymously — surfacing them on a profile page
// would defeat the point) but still counted in stats. We only show the
// profile if the user actually has any forum activity, otherwise return
// 404 to avoid revealing every account name to an enumerating client.
// ---------------------------------------------------------------------------
forumRoute.get('/user/:username', (c) => {
  const username = c.req.param('username') ?? '';
  if (!username) return c.json({ error: 'username required' }, 400);
  const user = userStmts.findByUsername.get(username) as UserRow | undefined;
  if (!user) return c.json({ error: 'not found' }, 404);

  const postRow = forumStmts.userPostStats.get(user.id) as {
    total_posts: number;
    post_likes: number;
  };
  const commentRow = forumStmts.userCommentStats.get(user.id) as {
    total_comments: number;
    comment_likes: number;
  };

  // Hide enumeration of every registered username — only expose profiles
  // for users who've actually participated in the forum.
  if (postRow.total_posts === 0 && commentRow.total_comments === 0) {
    return c.json({ error: 'not found' }, 404);
  }

  const recentPosts = forumStmts.userRecentPosts.all(user.id, 10) as Array<{
    id: number;
    title: string;
    category: string;
    body: string;
    thumbs_count: number;
    comment_count: number;
    is_anonymous: number;
    created_at: number;
  }>;
  const recentComments = forumStmts.userRecentComments.all(
    user.id,
    10,
  ) as Array<{
    id: number;
    body: string;
    thumbs_count: number;
    created_at: number;
    is_anonymous: number;
    post_id: number;
    post_title: string;
    post_category: string;
  }>;

  return c.json({
    username: user.username,
    nickname: user.nickname,
    hasAvatar: !!user.avatar_path,
    memberSince: user.created_at * 1000,
    bio: user.bio ?? '',
    stats: {
      totalPosts: postRow.total_posts,
      totalComments: commentRow.total_comments,
      totalLikes: postRow.post_likes + commentRow.comment_likes,
    },
    recentPosts: recentPosts
      .filter((p) => !p.is_anonymous)
      .map((p) => ({
        id: p.id,
        title: p.title,
        category: p.category,
        bodyPreview: p.body.length > 200 ? p.body.slice(0, 200) + '…' : p.body,
        thumbsCount: p.thumbs_count,
        commentCount: p.comment_count,
        createdAt: p.created_at * 1000,
      })),
    recentComments: recentComments
      .filter((cm) => !cm.is_anonymous)
      .map((cm) => ({
        id: cm.id,
        body: cm.body.length > 240 ? cm.body.slice(0, 240) + '…' : cm.body,
        thumbsCount: cm.thumbs_count,
        createdAt: cm.created_at * 1000,
        postId: cm.post_id,
        postTitle: cm.post_title,
        postCategory: cm.post_category,
      })),
  });
});

// ---------------------------------------------------------------------------
// GET /api/forum/likers/:targetType/:targetId — public list of who liked.
// Anonymous like is not (yet) a thing, so usernames are always visible.
// ---------------------------------------------------------------------------
forumRoute.get('/likers/:targetType/:targetId', (c) => {
  const targetType = c.req.param('targetType');
  if (targetType !== 'post' && targetType !== 'comment') {
    return c.json({ error: 'invalid targetType' }, 400);
  }
  const targetId = parseInt(c.req.param('targetId') ?? '', 10);
  if (!Number.isFinite(targetId) || targetId <= 0) {
    return c.json({ error: 'invalid targetId' }, 400);
  }
  const rows = forumStmts.listLikers.all(targetType, targetId) as Array<{
    username: string;
    nickname: string | null;
    avatar_path: string | null;
    created_at: number;
  }>;
  return c.json({
    likers: rows.map((r) => ({
      username: r.username,
      nickname: r.nickname,
      hasAvatar: !!r.avatar_path,
      createdAt: r.created_at * 1000,
    })),
  });
});

// ---------------------------------------------------------------------------
// POST /api/forum/like — toggle like on a post or comment.
// Body: { targetType: 'post' | 'comment', targetId }
// ---------------------------------------------------------------------------
forumRoute.post('/like', requireAuth, async (c) => {
  const user = c.get('user');
  const body = (await c.req.json().catch(() => null)) as
    | { targetType?: string; targetId?: number }
    | null;
  if (!body || (body.targetType !== 'post' && body.targetType !== 'comment')) {
    return c.json({ error: 'invalid targetType' }, 400);
  }
  const targetId = Number(body.targetId);
  if (!Number.isFinite(targetId) || targetId <= 0) {
    return c.json({ error: 'invalid targetId' }, 400);
  }

  const exists =
    body.targetType === 'post'
      ? forumStmts.findPostById.get(targetId)
      : forumStmts.findCommentById.get(targetId);
  if (!exists) return c.json({ error: 'not found' }, 404);

  const liked = db.transaction((): boolean => {
    const present = forumStmts.findLike.get(user.id, body.targetType!, targetId);
    if (present) {
      forumStmts.deleteLike.run(user.id, body.targetType!, targetId);
      if (body.targetType === 'post') forumStmts.decPostThumbs.run(targetId);
      else forumStmts.decCommentThumbs.run(targetId);
      return false;
    }
    forumStmts.insertLike.run(user.id, body.targetType!, targetId);
    if (body.targetType === 'post') forumStmts.incPostThumbs.run(targetId);
    else forumStmts.incCommentThumbs.run(targetId);
    return true;
  })();

  return c.json({ liked });
});
