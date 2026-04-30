// Forum 論壇 — public read for everyone, write for logged-in users.
// Posts are spawned exclusively from chat sessions via ShareToForumModal.
// Routing is pathname-driven (no React Router):
//   /forum                  → category index (看板列表 + 最新貼文)
//   /forum/cat/:category    → posts in that 看板
//   /forum/post/:id         → post detail + comments

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  FORUM_CATEGORIES,
  type AIProvider,
  type ChatMode,
} from '../shared/types';
import {
  avatarUrl,
  getForumPost,
  listForumCategories,
  listForumLikers,
  listForumPosts,
  postForumComment,
  toggleForumLike,
  type ForumCategoryCount,
  type ForumComment,
  type ForumLiker,
  type ForumPostDetail,
  type ForumPostSummary,
  type User,
} from '../api';
import ProviderAvatar from './ProviderAvatar';
import AIProfile from './AIProfile';

interface Props {
  pathname: string;
  navigate: (path: string) => void;
  user: User | null;
}

export default function Forum({ pathname, navigate, user }: Props) {
  // Parse route. We accept three shapes:
  //   /forum
  //   /forum/cat/<encoded-category>
  //   /forum/post/<numeric-id>
  const route = useMemo(() => parseForumPath(pathname), [pathname]);

  // TopNav (rendered by App.tsx) covers global navigation now; this
  // component only renders the route-specific content.
  return (
    <>
      {route.kind === 'index' && <ForumIndex navigate={navigate} />}
      {route.kind === 'category' && (
        <ForumCategory category={route.category} navigate={navigate} />
      )}
      {route.kind === 'post' && (
        <ForumPostView postId={route.postId} navigate={navigate} user={user} />
      )}
      {route.kind === 'ai' && (
        <AIProfile provider={route.provider} navigate={navigate} />
      )}
    </>
  );
}

interface RouteIndex { kind: 'index' }
interface RouteCategory { kind: 'category'; category: string }
interface RoutePost { kind: 'post'; postId: number }
interface RouteAI { kind: 'ai'; provider: AIProvider }
type ForumRoute = RouteIndex | RouteCategory | RoutePost | RouteAI;

const AI_PROVIDERS_SET = new Set<string>(['claude', 'chatgpt', 'gemini', 'grok']);

function parseForumPath(p: string): ForumRoute {
  if (p.startsWith('/forum/cat/')) {
    const cat = decodeURIComponent(p.slice('/forum/cat/'.length));
    return { kind: 'category', category: cat };
  }
  if (p.startsWith('/forum/post/')) {
    const id = parseInt(p.slice('/forum/post/'.length), 10);
    if (Number.isFinite(id) && id > 0) return { kind: 'post', postId: id };
  }
  if (p.startsWith('/forum/ai/')) {
    const prov = p.slice('/forum/ai/'.length);
    if (AI_PROVIDERS_SET.has(prov)) {
      return { kind: 'ai', provider: prov as AIProvider };
    }
  }
  return { kind: 'index' };
}

// ---------------------------------------------------------------------------
// Index view — 看板 list (category cards) + recent-posts feed.
// ---------------------------------------------------------------------------
function ForumIndex({ navigate }: { navigate: (p: string) => void }) {
  const [categories, setCategories] = useState<ForumCategoryCount[] | null>(null);
  const [recent, setRecent] = useState<ForumPostSummary[] | null>(null);
  const [err, setErr] = useState<string>('');

  useEffect(() => {
    let alive = true;
    Promise.all([listForumCategories(), listForumPosts({})])
      .then(([cats, posts]) => {
        if (!alive) return;
        setCategories(cats);
        setRecent(posts.posts);
      })
      .catch((e: Error) => {
        if (alive) setErr(e.message);
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="max-w-4xl mx-auto p-4 space-y-6">
      <section>
        <h2 className="text-sm uppercase tracking-wider text-gray-500 mb-3">
          看板
        </h2>
        {!categories ? (
          <div className="text-gray-500 text-sm">載入中…</div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {FORUM_CATEGORIES.map((cat) => {
              const count = categories.find((c) => c.category === cat)?.count ?? 0;
              return (
                <button
                  key={cat}
                  onClick={() => navigate(`/forum/cat/${encodeURIComponent(cat)}`)}
                  className="bg-gray-900 hover:bg-gray-800 border border-gray-800 rounded-lg px-4 py-3 text-left transition-colors"
                >
                  <div className="text-base font-bold text-gray-100">{cat}</div>
                  <div className="text-xs text-gray-500 mt-1">{count} 篇</div>
                </button>
              );
            })}
          </div>
        )}
      </section>

      <section>
        <h2 className="text-sm uppercase tracking-wider text-gray-500 mb-3">
          最新貼文
        </h2>
        {err && <div className="text-red-400 text-sm mb-2">{err}</div>}
        {!recent ? (
          <div className="text-gray-500 text-sm">載入中…</div>
        ) : recent.length === 0 ? (
          <div className="text-gray-500 text-sm">
            還沒人貼文 — 在主畫面跟 AI 聊一聊，從 chat header 的「分享到論壇」按鈕分享你的對話吧。
          </div>
        ) : (
          <div className="space-y-2">
            {recent.map((p) => (
              <PostCard key={p.id} post={p} navigate={navigate} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Category view — same card layout, filtered to one 看板.
// ---------------------------------------------------------------------------
function ForumCategory({
  category,
  navigate,
}: {
  category: string;
  navigate: (p: string) => void;
}) {
  const [posts, setPosts] = useState<ForumPostSummary[] | null>(null);
  const [err, setErr] = useState<string>('');

  useEffect(() => {
    let alive = true;
    listForumPosts({ category })
      .then((d) => {
        if (alive) setPosts(d.posts);
      })
      .catch((e: Error) => {
        if (alive) setErr(e.message);
      });
    return () => {
      alive = false;
    };
  }, [category]);

  return (
    <div className="max-w-4xl mx-auto p-4 space-y-3">
      <h2 className="text-xl font-bold text-gray-100">{category}</h2>
      {err && <div className="text-red-400 text-sm">{err}</div>}
      {!posts ? (
        <div className="text-gray-500 text-sm">載入中…</div>
      ) : posts.length === 0 ? (
        <div className="text-gray-500 text-sm">這個看板還沒有貼文。</div>
      ) : (
        <div className="space-y-2">
          {posts.map((p) => (
            <PostCard key={p.id} post={p} navigate={navigate} />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detail view — full post body + comments + new-comment composer.
// Likes + comments use optimistic UI (mutate state immediately, rollback
// on server error).
// ---------------------------------------------------------------------------
function ForumPostView({
  postId,
  navigate,
  user,
}: {
  postId: number;
  navigate: (p: string) => void;
  user: User | null;
}) {
  const [data, setData] = useState<{
    post: ForumPostDetail;
    comments: ForumComment[];
  } | null>(null);
  const [err, setErr] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [likersTarget, setLikersTarget] = useState<
    { type: 'post' | 'comment'; id: number } | null
  >(null);

  const reload = useCallback(() => {
    setErr('');
    getForumPost(postId)
      .then(setData)
      .catch((e: Error) => setErr(e.message));
  }, [postId]);

  useEffect(() => {
    reload();
  }, [reload]);

  const togglePostLike = useCallback(async () => {
    if (!user || !data) return;
    const wasLiked = data.post.liked;
    setData({
      ...data,
      post: {
        ...data.post,
        liked: !wasLiked,
        thumbsCount: data.post.thumbsCount + (wasLiked ? -1 : 1),
      },
    });
    try {
      await toggleForumLike({ targetType: 'post', targetId: postId });
    } catch {
      reload(); // rollback by hard refresh
    }
  }, [data, postId, reload, user]);

  const toggleCommentLike = useCallback(
    async (commentId: number) => {
      if (!user || !data) return;
      const targetIdx = data.comments.findIndex((c) => c.id === commentId);
      if (targetIdx < 0) return;
      const wasLiked = data.comments[targetIdx].liked;
      const nextComments = data.comments.slice();
      nextComments[targetIdx] = {
        ...nextComments[targetIdx],
        liked: !wasLiked,
        thumbsCount: nextComments[targetIdx].thumbsCount + (wasLiked ? -1 : 1),
      };
      setData({ ...data, comments: nextComments });
      try {
        await toggleForumLike({ targetType: 'comment', targetId: commentId });
      } catch {
        reload();
      }
    },
    [data, reload, user],
  );

  const submitComment = useCallback(
    async (body: string, isAnonymous: boolean) => {
      if (!user || !body.trim()) return;
      setBusy(true);
      try {
        await postForumComment(postId, { body: body.trim(), isAnonymous });
        reload();
      } catch (e) {
        alert((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [postId, reload, user],
  );

  if (err) return <div className="p-4 text-red-400 text-sm">{err}</div>;
  if (!data) return <div className="p-4 text-gray-500 text-sm">載入中…</div>;
  const { post, comments } = data;

  return (
    <div className="max-w-3xl mx-auto p-4 space-y-4">
      {/* Post header */}
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
        <div className="flex gap-3">
          <PostAvatar post={post} size={40} />
          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-2 text-xs mb-2">
              <button
                onClick={() =>
                  navigate(`/forum/cat/${encodeURIComponent(post.category)}`)
                }
                className="px-2 py-0.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-300"
              >
                {post.category}
              </button>
              {post.sourceMode && (
                <ModePill
                  mode={post.sourceMode as ChatMode}
                  persona={post.aiPersona}
                />
              )}
              <span className="text-gray-500">·</span>
              <span className="text-gray-400">{post.authorDisplay}</span>
              <span className="text-gray-500">·</span>
              <span className="text-gray-500">
                {relativeTime(post.createdAt)}
              </span>
            </div>
            <h1 className="text-xl font-bold text-gray-100 mb-3">
              {post.title}
            </h1>
            <div className="text-gray-200 whitespace-pre-wrap leading-relaxed">
              {post.body}
            </div>
            <div className="mt-3 flex items-center gap-3">
              <LikeButton
                liked={post.liked}
                count={post.thumbsCount}
                onToggle={togglePostLike}
                onShowLikers={() =>
                  setLikersTarget({ type: 'post', id: post.id })
                }
                disabled={!user}
              />
              <span className="text-xs text-gray-500">
                {post.commentCount} 則回應
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Comments */}
      <div className="space-y-2">
        {comments.map((c) => (
          <CommentRow
            key={c.id}
            comment={c}
            aiPersona={post.aiPersona}
            onToggleLike={() => toggleCommentLike(c.id)}
            onShowLikers={() => setLikersTarget({ type: 'comment', id: c.id })}
            canLike={!!user}
            navigate={navigate}
          />
        ))}
      </div>

      {/* Composer */}
      {user ? (
        <CommentComposer onSubmit={submitComment} busy={busy} />
      ) : (
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 text-sm text-gray-400">
          登入後即可留言。
        </div>
      )}

      {likersTarget && (
        <LikersModal
          target={likersTarget}
          onClose={() => setLikersTarget(null)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function PostCard({
  post,
  navigate,
}: {
  post: ForumPostSummary;
  navigate: (p: string) => void;
}) {
  return (
    <button
      onClick={() => navigate(`/forum/post/${post.id}`)}
      className="block w-full bg-gray-900 hover:bg-gray-850 border border-gray-800 rounded-lg p-3 text-left transition-colors"
      style={{ background: undefined }}
    >
      <div className="flex items-center gap-2 text-xs mb-1">
        <span className="px-1.5 py-0.5 rounded bg-gray-800 text-gray-300">
          {post.category}
        </span>
        {post.sourceMode && <ModePill mode={post.sourceMode as ChatMode} />}
        <span className="text-gray-500">·</span>
        <span className="text-gray-400">{post.authorDisplay}</span>
        <span className="text-gray-500">·</span>
        <span className="text-gray-500">{relativeTime(post.createdAt)}</span>
      </div>
      <div className="text-base font-semibold text-gray-100 mb-1">{post.title}</div>
      <div className="text-sm text-gray-400 line-clamp-2">{post.bodyPreview}</div>
      <div className="mt-2 flex items-center gap-3 text-xs text-gray-500">
        <span>👍 {post.thumbsCount}</span>
        <span>💬 {post.commentCount}</span>
      </div>
    </button>
  );
}

function CommentRow({
  comment,
  aiPersona,
  onToggleLike,
  onShowLikers,
  canLike,
  navigate,
}: {
  comment: ForumComment;
  // From the parent post's profession snapshot. When set and comment is
  // AI, the persona ("按摩師") becomes the prominent display name and
  // the bare provider ("Grok") moves to the metadata subline.
  aiPersona: string | null;
  onToggleLike: () => void;
  onShowLikers: () => void;
  canLike: boolean;
  navigate: (p: string) => void;
}) {
  const isAi = comment.authorType === 'ai';
  const provider = comment.authorAiProvider;
  // Grok / Claude / etc. is always the primary name — that's the AI
  // identity we want to brand. The post-level 職業 (e.g. 按摩師) is a
  // discussion topic shown on the post header, not per-comment, so we
  // don't repeat it here.
  const primaryName = isAi && provider
    ? capitalize(provider)
    : comment.authorDisplay;
  const metaParts: string[] = [];
  if (comment.isImported) metaParts.push('來自原對話');
  metaParts.push(relativeTime(comment.createdAt));
  // AI name + avatar are clickable links to the AI's profile page.
  const goToAIProfile = () => {
    if (isAi && provider) navigate(`/forum/ai/${provider}`);
  };
  const aiHover = isAi && provider ? `查看 ${capitalize(provider)} 的個人檔案` : undefined;

  return (
    <div
      className={`flex gap-3 bg-gray-900 border rounded-lg p-3 ${
        isAi ? 'border-gray-700' : 'border-gray-800'
      }`}
    >
      <div
        className={isAi ? 'cursor-pointer hover:opacity-80 transition-opacity' : ''}
        title={aiHover}
        onClick={goToAIProfile}
      >
        <CommentAvatar comment={comment} size={36} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 mb-1">
          <span
            className={`text-sm ${
              isAi
                ? 'text-gray-100 font-semibold cursor-pointer hover:text-white hover:underline'
                : 'text-gray-200 font-medium'
            }`}
            title={aiHover}
            onClick={isAi ? goToAIProfile : undefined}
          >
            {primaryName}
          </span>
          <span className="text-[11px] text-gray-500">
            {metaParts.join(' · ')}
          </span>
        </div>
        <div className="text-sm text-gray-200 whitespace-pre-wrap leading-relaxed">
          {comment.body}
        </div>
        <div className="mt-2 flex items-center gap-2">
          <LikeButton
            liked={comment.liked}
            count={comment.thumbsCount}
            onToggle={onToggleLike}
            onShowLikers={onShowLikers}
            disabled={!canLike}
          />
        </div>
      </div>
    </div>
  );
}

// Avatar dispatcher — provider PNG for AI, user upload for named users,
// 匿 bubble for anonymous, initial for users who haven't uploaded one.
function CommentAvatar({
  comment,
  size,
}: {
  comment: ForumComment;
  size: number;
}) {
  if (comment.authorType === 'ai' && comment.authorAiProvider) {
    return <ProviderAvatar provider={comment.authorAiProvider} size={size} />;
  }
  if (comment.isAnonymous) {
    return <AnonAvatar size={size} />;
  }
  if (comment.authorUsername && comment.authorAvatarPath) {
    return (
      <UserAvatar username={comment.authorUsername} size={size} />
    );
  }
  return <InitialAvatar name={comment.authorDisplay} size={size} />;
}

// Generic anonymous user silhouette — head + shoulders SVG. Looks more
// like a real avatar than a text glyph and reads identically across
// languages.
function AnonAvatar({ size }: { size: number }) {
  return (
    <div
      className="rounded-full bg-gray-700 flex items-center justify-center flex-none border border-gray-600 overflow-hidden"
      style={{ width: size, height: size }}
      title="匿名"
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        className="text-gray-400"
      >
        <circle cx="12" cy="9" r="3.6" fill="currentColor" />
        <path
          d="M4.5 22c0-4.1 3.4-7.5 7.5-7.5s7.5 3.4 7.5 7.5"
          fill="currentColor"
        />
      </svg>
    </div>
  );
}

function UserAvatar({
  username,
  size,
}: {
  username: string;
  size: number;
}) {
  const [errored, setErrored] = useState(false);
  if (errored) return <InitialAvatar name={username} size={size} />;
  return (
    <img
      src={avatarUrl(username, 0)}
      alt={username}
      onError={() => setErrored(true)}
      className="rounded-full flex-none object-cover border border-gray-700"
      style={{ width: size, height: size }}
    />
  );
}

function InitialAvatar({ name, size }: { name: string; size: number }) {
  return (
    <div
      className="rounded-full bg-gray-700 flex items-center justify-center text-gray-300 font-bold flex-none"
      style={{ width: size, height: size, fontSize: size * 0.4 }}
    >
      {name.slice(0, 1).toUpperCase()}
    </div>
  );
}

function CommentComposer({
  onSubmit,
  busy,
}: {
  onSubmit: (body: string, isAnonymous: boolean) => void | Promise<void>;
  busy: boolean;
}) {
  const [body, setBody] = useState('');
  const [anon, setAnon] = useState(false);
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-3">
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="寫下你的留言…"
        className="w-full bg-gray-950 border border-gray-800 rounded px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500 resize-y min-h-20"
        maxLength={5000}
      />
      <div className="mt-2 flex items-center justify-between text-xs">
        <label className="flex items-center gap-1.5 text-gray-400">
          <input
            type="checkbox"
            checked={anon}
            onChange={(e) => setAnon(e.target.checked)}
          />
          匿名留言
        </label>
        <button
          onClick={async () => {
            await onSubmit(body, anon);
            setBody('');
          }}
          disabled={busy || !body.trim()}
          className="px-3 py-1 rounded bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white"
        >
          {busy ? '送出中…' : '送出'}
        </button>
      </div>
    </div>
  );
}

// Two clickable zones: heart toggles like (auth-only), count opens a
// popup of who liked (anyone). Showing the count is suppressed when 0
// since there's nothing to see.
function LikeButton({
  liked,
  count,
  onToggle,
  onShowLikers,
  disabled,
}: {
  liked: boolean;
  count: number;
  onToggle: () => void;
  onShowLikers: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <button
        onClick={onToggle}
        disabled={disabled}
        title={disabled ? '登入後可按讚' : liked ? '取消讚' : '按讚'}
        className={`px-2 py-1 rounded text-xs transition-colors ${
          liked
            ? 'bg-pink-700/40 text-pink-200'
            : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
        } disabled:opacity-40`}
      >
        {liked ? '❤' : '🤍'}
      </button>
      {count > 0 && (
        <button
          onClick={onShowLikers}
          className="text-xs text-gray-500 hover:text-gray-300 underline-offset-2 hover:underline"
          title="看誰按過讚"
        >
          {count}
        </button>
      )}
    </div>
  );
}

// Modal listing everyone who liked a target. Fetches lazily on open.
function LikersModal({
  target,
  onClose,
}: {
  target: { type: 'post' | 'comment'; id: number };
  onClose: () => void;
}) {
  const [likers, setLikers] = useState<ForumLiker[] | null>(null);
  const [err, setErr] = useState<string>('');
  useEffect(() => {
    let alive = true;
    listForumLikers(target.type, target.id)
      .then((rows) => {
        if (alive) setLikers(rows);
      })
      .catch((e: Error) => {
        if (alive) setErr(e.message);
      });
    return () => {
      alive = false;
    };
  }, [target.type, target.id]);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-gray-900 border border-gray-800 rounded-lg w-full max-w-sm p-4 space-y-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-gray-100">按讚名單</h3>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-white text-sm"
          >
            ✕
          </button>
        </div>
        {err && <div className="text-red-400 text-xs">{err}</div>}
        {!likers ? (
          <div className="text-gray-500 text-sm">載入中…</div>
        ) : likers.length === 0 ? (
          <div className="text-gray-500 text-sm">還沒有人按讚。</div>
        ) : (
          <div className="space-y-1.5 max-h-80 overflow-y-auto">
            {likers.map((l) => (
              <div key={l.username} className="flex items-center gap-2">
                {l.hasAvatar ? (
                  <UserAvatar username={l.username} size={28} />
                ) : (
                  <InitialAvatar name={l.nickname || l.username} size={28} />
                )}
                <span className="text-sm text-gray-200">
                  {l.nickname || l.username}
                </span>
                <span className="text-[10px] text-gray-500 ml-auto">
                  {relativeTime(l.createdAt)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const MODE_LABEL: Record<ChatMode, string> = {
  free: '自由聊天',
  debate: '四方辯證',
  consult: '多方諮詢',
  coding: 'Coding',
  roundtable: '道理辯證',
  personal: '個性化',
  profession: '指定職業',
  reasoning: '深度思考',
  image: '出圖',
};
// In `profession` mode the persona (e.g. 按摩師) becomes the discussion
// topic — show it inline with the mode label as "指定職業：按摩師" so
// readers see both context (this came from a profession session) and
// topic (which profession). Provider stays branded on individual
// comments; this pill is about the post-level subject.
function ModePill({
  mode,
  persona,
}: {
  mode: ChatMode;
  persona?: string | null;
}) {
  const label = MODE_LABEL[mode] ?? mode;
  const text = mode === 'profession' && persona ? `${label}：${persona}` : label;
  return (
    <span className="px-1.5 py-0.5 rounded border border-gray-700 text-gray-400 text-[10px]">
      {text}
    </span>
  );
}

// Avatar dispatcher for posts — same logic as CommentAvatar but only
// for user-authored posts (no AI authors at the post level).
function PostAvatar({
  post,
  size,
}: {
  post: ForumPostDetail | ForumPostSummary;
  size: number;
}) {
  if (post.isAnonymous) return <AnonAvatar size={size} />;
  if (post.authorUsername) {
    return <UserAvatar username={post.authorUsername} size={size} />;
  }
  return <InitialAvatar name={post.authorDisplay} size={size} />;
}

function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return '剛剛';
  const m = Math.floor(diff / 60_000);
  if (m < 60) return `${m} 分鐘前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小時前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  const date = new Date(ms);
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
