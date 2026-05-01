// Forum 論壇 — public read for everyone, write for logged-in users.
// Posts are spawned exclusively from chat sessions via ShareToForumModal.
// Routing is pathname-driven (no React Router):
//   /forum                  → category index (看板列表 + 最新貼文)
//   /forum/cat/:category    → posts in that 看板
//   /forum/post/:id         → post detail + comments

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  FORUM_CATEGORIES,
  type AIProvider,
  type ChatMode,
} from '../shared/types';
import {
  adminSetPostNsfw,
  avatarUrl,
  bulkFetchForumPosts,
  deletePostMedia,
  deleteCommentReply,
  getForumPost,
  listForumCategories,
  listForumLikers,
  listForumPosts,
  postCommentReply,
  postForumComment,
  postPostReply,
  toggleForumLike,
  uploadPostMedia,
  type AIStatsMap,
  type ForumCategoryCount,
  type ForumComment,
  type ForumCommentReply,
  type ForumLiker,
  type ForumPostDetail,
  type ForumPostSummary,
  type MediaItem,
  type User,
  type UserStat,
} from '../api';
import { AI_BIOS, AI_PROVIDERS, aiLevel } from '../shared/constants';
import ProviderAvatar from './ProviderAvatar';
import AIProfile from './AIProfile';
import UserProfile from './UserProfile';

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
      {route.kind === 'mode' && (
        <ForumModeList mode={route.mode} navigate={navigate} />
      )}
      {route.kind === 'post' && (
        <ForumPostView postId={route.postId} navigate={navigate} user={user} />
      )}
      {route.kind === 'ai' && (
        <AIProfile
          provider={route.provider}
          navigate={navigate}
          viewer={user}
        />
      )}
      {route.kind === 'user' && (
        <UserProfile username={route.username} navigate={navigate} />
      )}
    </>
  );
}

interface RouteIndex { kind: 'index' }
interface RouteCategory { kind: 'category'; category: string }
interface RouteMode { kind: 'mode'; mode: ChatMode }
interface RoutePost { kind: 'post'; postId: number }
interface RouteAI { kind: 'ai'; provider: AIProvider }
interface RouteUser { kind: 'user'; username: string }
type ForumRoute =
  | RouteIndex
  | RouteCategory
  | RouteMode
  | RoutePost
  | RouteAI
  | RouteUser;

const VALID_CHAT_MODES = new Set<string>([
  'free',
  'debate',
  'consult',
  'coding',
  'roundtable',
  'personal',
  'profession',
  'reasoning',
  'image',
]);

const AI_PROVIDERS_SET = new Set<string>(['claude', 'chatgpt', 'gemini', 'grok']);

function parseForumPath(p: string): ForumRoute {
  if (p.startsWith('/forum/cat/')) {
    const cat = decodeURIComponent(p.slice('/forum/cat/'.length));
    return { kind: 'category', category: cat };
  }
  if (p.startsWith('/forum/mode/')) {
    const m = p.slice('/forum/mode/'.length);
    if (VALID_CHAT_MODES.has(m)) return { kind: 'mode', mode: m as ChatMode };
  }
  if (p.startsWith('/forum/post/')) {
    const id = parseInt(p.slice('/forum/post/'.length), 10);
    if (Number.isFinite(id) && id > 0) return { kind: 'post', postId: id };
  }
  // Unified user-style URL: AIs reuse this scheme so they read like
  // first-class members (/forum/user/grok, /forum/user/claude, …).
  // Provider names are reserved server-side via RESERVED_USERNAMES so
  // a human can never grab "grok" and shadow Grok's profile.
  if (p.startsWith('/forum/user/')) {
    const handle = decodeURIComponent(p.slice('/forum/user/'.length));
    if (AI_PROVIDERS_SET.has(handle)) {
      return { kind: 'ai', provider: handle as AIProvider };
    }
    if (handle) return { kind: 'user', username: handle };
  }
  // Legacy alias from the AI-only days. Keep functional so any earlier
  // links / bookmarks still resolve.
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
// localStorage key + cap for the "你剛看過" row. We store post ids in
// most-recent-first order; the server bulk endpoint resolves them back
// to fresh summaries on each index load so counts stay current.
const VIEWED_KEY = 'forumRecentlyViewed';
const VIEWED_MAX = 24;

function trackViewedPost(id: number): void {
  try {
    const raw = localStorage.getItem(VIEWED_KEY);
    const arr = raw ? (JSON.parse(raw) as number[]) : [];
    const next = [id, ...arr.filter((x) => x !== id)].slice(0, VIEWED_MAX);
    localStorage.setItem(VIEWED_KEY, JSON.stringify(next));
  } catch {
    // ignore — private browsing / quota
  }
}

function getViewedIds(): number[] {
  try {
    const raw = localStorage.getItem(VIEWED_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((n) => Number.isFinite(n)) : [];
  } catch {
    return [];
  }
}

// View mode for the forum index — 'tile' is the modern default
// (cards in a grid), 'list' is the original long-row layout. Persisted
// to localStorage so the user's pick sticks across sessions.
type ViewMode = 'tile' | 'list';
function loadViewMode(): ViewMode {
  try {
    const v = localStorage.getItem('forumViewMode');
    if (v === 'list' || v === 'tile') return v;
  } catch {
    // ignore
  }
  return 'tile';
}

// Default + expanded counts for each row. 6 = comfortable 2-row tile
// preview (3 cols × 2 rows) without overwhelming the index. 15 = 5
// rows × 3 cols when the user hits "查看全部"; pagination kicks in
// past that.
const SECTION_DEFAULT = 6;
const SECTION_EXPANDED = 15;

function ForumIndex({ navigate }: { navigate: (p: string) => void }) {
  const [categories, setCategories] = useState<ForumCategoryCount[] | null>(null);
  const [err, setErr] = useState<string>('');
  const [viewMode, setViewModeState] = useState<ViewMode>(loadViewMode);
  const setViewMode = (m: ViewMode) => {
    setViewModeState(m);
    try {
      localStorage.setItem('forumViewMode', m);
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    let alive = true;
    listForumCategories()
      .then((cats) => {
        if (alive) setCategories(cats);
      })
      .catch((e: Error) => {
        if (alive) setErr(e.message);
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="max-w-5xl mx-auto p-4 space-y-6">
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

      {/* Single view-mode toggle drives every section below.
          localStorage-backed so the user's preference sticks. */}
      <div className="flex items-center justify-end -mb-3">
        <div className="flex rounded border border-gray-800 overflow-hidden text-[11px]">
          <button
            onClick={() => setViewMode('tile')}
            className={`px-2 py-1 ${
              viewMode === 'tile'
                ? 'bg-gray-700 text-white'
                : 'bg-gray-900 text-gray-400 hover:text-white'
            }`}
            title="塊狀檢視"
          >
            ▦ 塊狀
          </button>
          <button
            onClick={() => setViewMode('list')}
            className={`px-2 py-1 ${
              viewMode === 'list'
                ? 'bg-gray-700 text-white'
                : 'bg-gray-900 text-gray-400 hover:text-white'
            }`}
            title="條狀檢視"
          >
            ☰ 條狀
          </button>
        </div>
      </div>

      {err && <div className="text-red-400 text-sm">{err}</div>}

      <RecentlyViewedSection viewMode={viewMode} navigate={navigate} />
      <PostSection
        title="最新貼文"
        emptyHint="還沒人貼文 — 在主畫面跟 AI 聊一聊，從左邊 sidebar 對話旁的「分享」按鈕分享你的對話吧。"
        viewMode={viewMode}
        navigate={navigate}
        fetcher={({ limit, page }) =>
          listForumPosts({ sort: 'latest', limit, page }).then((d) => d.posts)
        }
      />
      <PostSection
        title="熱門貼文"
        viewMode={viewMode}
        navigate={navigate}
        fetcher={({ limit, page }) =>
          listForumPosts({ sort: 'trending', limit, page }).then((d) => d.posts)
        }
      />
    </div>
  );
}

// Generic post-listing section with three states:
//   - default (collapsed-into-summary or just shorter): 6 posts
//   - expanded ("查看全部"): 15 posts with pagination
//   - hidden (<details> closed): summary only
// Each section drives its own state so the user can have one expanded
// while another stays collapsed.
function PostSection({
  title,
  emptyHint,
  viewMode,
  navigate,
  fetcher,
}: {
  title: string;
  emptyHint?: string;
  viewMode: ViewMode;
  navigate: (p: string) => void;
  fetcher: (args: { limit: number; page: number }) => Promise<ForumPostSummary[]>;
}) {
  const [posts, setPosts] = useState<ForumPostSummary[] | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);

  const load = useCallback(
    (next: { expanded: boolean; page: number }) => {
      setLoading(true);
      const limit = next.expanded ? SECTION_EXPANDED : SECTION_DEFAULT;
      fetcher({ limit, page: next.page })
        .then((p) => setPosts(p))
        .catch(() => {
          // Section keeps last good data on error; surface via console only.
          // The PostSection isn't critical enough to flash an error banner
          // for transient blips.
        })
        .finally(() => setLoading(false));
    },
    [fetcher],
  );

  useEffect(() => {
    load({ expanded: false, page: 1 });
  }, [load]);

  const handleViewAll = () => {
    setExpanded(true);
    setPage(1);
    load({ expanded: true, page: 1 });
  };
  const handleCollapse = () => {
    setExpanded(false);
    setPage(1);
    load({ expanded: false, page: 1 });
  };
  const handlePage = (delta: number) => {
    const next = Math.max(1, page + delta);
    setPage(next);
    load({ expanded: true, page: next });
  };

  return (
    <details open className="space-y-2">
      <summary className="cursor-pointer select-none text-sm uppercase tracking-wider text-gray-500 mb-3 hover:text-gray-300">
        {title}
      </summary>
      {posts === null ? (
        <div className="text-gray-500 text-sm">載入中…</div>
      ) : posts.length === 0 ? (
        emptyHint ? (
          <div className="text-gray-500 text-sm">{emptyHint}</div>
        ) : null
      ) : (
        <>
          <PostList posts={posts} viewMode={viewMode} navigate={navigate} />
          <div className="flex items-center gap-2 mt-2">
            {!expanded ? (
              posts.length >= SECTION_DEFAULT && (
                <button
                  onClick={handleViewAll}
                  disabled={loading}
                  className="text-xs text-blue-300 hover:text-blue-200 disabled:opacity-50"
                >
                  查看全部 →
                </button>
              )
            ) : (
              <>
                <button
                  onClick={handleCollapse}
                  disabled={loading}
                  className="text-xs text-gray-400 hover:text-white disabled:opacity-50"
                >
                  ← 收起
                </button>
                <div className="ml-auto flex items-center gap-1 text-xs">
                  <button
                    onClick={() => handlePage(-1)}
                    disabled={loading || page === 1}
                    className="px-2 py-0.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 disabled:opacity-30"
                  >
                    上一頁
                  </button>
                  <span className="text-gray-500 px-1">第 {page} 頁</span>
                  <button
                    onClick={() => handlePage(1)}
                    disabled={loading || posts.length < SECTION_EXPANDED}
                    className="px-2 py-0.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 disabled:opacity-30"
                    title={
                      posts.length < SECTION_EXPANDED
                        ? '已是最後一頁'
                        : '下一頁'
                    }
                  >
                    下一頁
                  </button>
                </div>
              </>
            )}
          </div>
        </>
      )}
    </details>
  );
}

// "你剛看過" row — pulls ids from localStorage and bulk-fetches their
// current summaries from the server (so post counts stay fresh). The
// section silently disappears when the user has no viewing history
// yet, so it doesn't take up space on a brand-new account.
function RecentlyViewedSection({
  viewMode,
  navigate,
}: {
  viewMode: ViewMode;
  navigate: (p: string) => void;
}) {
  const [posts, setPosts] = useState<ForumPostSummary[] | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const ids = getViewedIds();
    if (ids.length === 0) {
      setPosts([]);
      return;
    }
    bulkFetchForumPosts(ids.slice(0, VIEWED_MAX))
      .then((p) => setPosts(p))
      .catch(() => setPosts([]));
  }, []);

  if (!posts || posts.length === 0) return null;

  const visible = expanded
    ? posts.slice(0, SECTION_EXPANDED)
    : posts.slice(0, SECTION_DEFAULT);
  const hasMore = posts.length > SECTION_DEFAULT;

  return (
    <details open className="space-y-2">
      <summary className="cursor-pointer select-none text-sm uppercase tracking-wider text-gray-500 mb-3 hover:text-gray-300">
        你剛看過
      </summary>
      <PostList posts={visible} viewMode={viewMode} navigate={navigate} />
      {hasMore && (
        <div className="flex items-center gap-2 mt-2">
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-xs text-blue-300 hover:text-blue-200"
          >
            {expanded ? '← 收起' : '查看全部 →'}
          </button>
        </div>
      )}
    </details>
  );
}

// Renders a list of posts in the requested mode. Tile = responsive
// grid (2 / 3 / 4 cols depending on width); list = the long-row card
// layout that was the original index style.
function PostList({
  posts,
  viewMode,
  navigate,
}: {
  posts: ForumPostSummary[];
  viewMode: ViewMode;
  navigate: (p: string) => void;
}) {
  if (viewMode === 'list') {
    return (
      <div className="space-y-2">
        {posts.map((p) => (
          <PostCard key={p.id} post={p} navigate={navigate} />
        ))}
      </div>
    );
  }
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
      {posts.map((p) => (
        <PostTile key={p.id} post={p} navigate={navigate} />
      ))}
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
  return (
    <FilteredPostList
      title={category}
      filter={{ category }}
      emptyHint="這個看板還沒有貼文。"
      navigate={navigate}
    />
  );
}

// Mode-filter view — backs the breadcrumb's "多方諮詢" / "深度思考"
// links. Same shape as ForumCategory; just calls listForumPosts with
// `mode` instead of `category`.
function ForumModeList({
  mode,
  navigate,
}: {
  mode: ChatMode;
  navigate: (p: string) => void;
}) {
  const label = MODE_LABEL[mode] ?? mode;
  return (
    <FilteredPostList
      title={`${label} 模式`}
      filter={{ mode }}
      emptyHint={`還沒有從「${label}」聊出來的貼文。`}
      navigate={navigate}
    />
  );
}

function FilteredPostList({
  title,
  filter,
  emptyHint,
  navigate,
}: {
  title: string;
  filter: { category?: string; mode?: ChatMode };
  emptyHint: string;
  navigate: (p: string) => void;
}) {
  const [posts, setPosts] = useState<ForumPostSummary[] | null>(null);
  const [err, setErr] = useState<string>('');

  useEffect(() => {
    let alive = true;
    listForumPosts({ category: filter.category, mode: filter.mode })
      .then((d) => {
        if (alive) setPosts(d.posts);
      })
      .catch((e: Error) => {
        if (alive) setErr(e.message);
      });
    return () => {
      alive = false;
    };
  }, [filter.category, filter.mode]);

  return (
    <div className="max-w-4xl mx-auto p-4 space-y-3">
      <h2 className="text-xl font-bold text-gray-100">{title}</h2>
      {err && <div className="text-red-400 text-sm">{err}</div>}
      {!posts ? (
        <div className="text-gray-500 text-sm">載入中…</div>
      ) : posts.length === 0 ? (
        <div className="text-gray-500 text-sm">{emptyHint}</div>
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
    aiStats: AIStatsMap;
    userStats: Record<string, UserStat>;
    media: MediaItem[];
    postReplies: ForumCommentReply[];
  } | null>(null);
  const [err, setErr] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [likersTarget, setLikersTarget] = useState<
    { type: 'post' | 'comment'; id: number } | null
  >(null);
  // 回復 button at the top scrolls down to this composer ref so users
  // who land on a long thread can jump straight to the reply box.
  const composerRef = useRef<HTMLDivElement | null>(null);
  const scrollToComposer = useCallback(() => {
    composerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, []);
  // NSFW gate — once the user confirms 18+ on any post, the
  // acknowledgement persists in localStorage so they don't get
  // re-prompted on every flagged post. Per discussion: in the absence
  // of a paid tier today, "logged-in + click-confirm" is the working
  // age check.
  const [nsfwAcked, setNsfwAcked] = useState<boolean>(() => {
    try {
      return localStorage.getItem('nsfw-acknowledged') === '1';
    } catch {
      return false;
    }
  });
  const ackNsfw = () => {
    try {
      localStorage.setItem('nsfw-acknowledged', '1');
    } catch {
      // ignore — private browsing
    }
    setNsfwAcked(true);
  };
  const isAdmin = user?.tier === 'admin';
  const isAuthor = !!user && data?.post.authorUsername === user.username;
  const canModerate = isAdmin;
  const canUploadMedia = isAdmin || isAuthor;

  const reload = useCallback(() => {
    setErr('');
    getForumPost(postId)
      .then(setData)
      .catch((e: Error) => setErr(e.message));
  }, [postId]);

  const toggleNsfw = useCallback(async () => {
    if (!data) return;
    const next = !data.post.nsfw;
    if (
      next &&
      !confirm('將這篇文章標為 18+ 後，匿名訪客將完全看不到，登入用戶會看到 18+ 確認頁。確定？')
    ) {
      return;
    }
    try {
      await adminSetPostNsfw(data.post.id, next);
      reload();
    } catch (e) {
      alert((e as Error).message);
    }
  }, [data, reload]);

  useEffect(() => {
    reload();
    // Push this post id onto the localStorage "recently viewed" list.
    // Forum index reads it back to populate the 你剛看過 row.
    trackViewedPost(postId);
  }, [reload, postId]);

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

  // 18+ confirmation gate — NSFW posts are blocked behind a confirm
  // before content renders. The acknowledgement persists in
  // localStorage so subsequent NSFW posts in the same browser don't
  // re-prompt. Anonymous viewers can never reach this branch (server
  // already 404s).
  if (post.nsfw && !nsfwAcked) {
    return (
      <div className="max-w-md mx-auto p-4 space-y-4">
        <Breadcrumb post={post} navigate={navigate} />
        <div className="rounded-xl border border-red-700/50 bg-red-950/30 p-6 space-y-4 text-center">
          <div className="text-4xl">🔞</div>
          <h2 className="text-lg font-bold text-red-200">此貼文標記為 18+ 內容</h2>
          <p className="text-sm text-red-100/80 leading-relaxed">
            內容可能包含成人主題（性、暴力或敏感議題）。
            點下「我已年滿 18 歲」即表示您聲明已成年並理解
            內容性質。本次確認會記在這個瀏覽器，往後同類貼文不再重複詢問。
          </p>
          <div className="flex flex-col sm:flex-row gap-2 pt-2">
            <button
              onClick={() => navigate('/forum')}
              className="flex-1 px-4 py-2 rounded-lg border border-gray-700 hover:bg-gray-800 text-sm text-gray-300"
            >
              返回討論區
            </button>
            <button
              onClick={ackNsfw}
              className="flex-1 px-4 py-2 rounded-lg bg-red-700 hover:bg-red-600 text-sm text-white font-medium"
            >
              我已年滿 18 歲
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto p-4 space-y-4">
      {/* Breadcrumb — 主頁 › 看板 › 模式. Each level is a clickable
          filter so readers can jump from a single thread back to the
          full feed of that category or chat-mode. */}
      <Breadcrumb post={post} navigate={navigate} />

      {/* Big repeat of the post title under the breadcrumb so the
          subject is unmistakably visible the moment someone lands
          here. The share-and-jump strip sits right under it. */}
      <div className="space-y-2">
        <h1 className="text-2xl md:text-3xl font-bold text-gray-100 leading-snug">
          {post.title}
          {post.nsfw && (
            <span
              className="ml-3 inline-block align-middle px-2 py-0.5 rounded bg-red-900/50 text-red-200 border border-red-700/40 text-xs font-semibold"
              title="18+ 內容"
            >
              🔞 18+
            </span>
          )}
        </h1>
        <div className="flex flex-wrap items-center gap-3">
          <ShareRow post={post} variant="compact" />
          <button
            onClick={scrollToComposer}
            className="inline-flex items-center gap-1 px-3 py-1 rounded-full bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium"
          >
            ↓ 回復
          </button>
          {canModerate && (
            <button
              onClick={toggleNsfw}
              className={`inline-flex items-center gap-1 px-3 py-1 rounded-full text-xs font-medium border ${
                post.nsfw
                  ? 'border-red-700/40 bg-red-950/40 text-red-200 hover:bg-red-900/40'
                  : 'border-gray-700 text-gray-300 hover:bg-gray-800'
              }`}
              title="僅管理員可見"
            >
              {post.nsfw ? '取消 18+ 標記' : '🔞 標記為 18+'}
            </button>
          )}
        </div>
      </div>

      {/* Post header */}
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
        <div className="flex gap-3">
          {/* OP avatar gets the same hover-card treatment as comment
              avatars when the OP is a non-anonymous user with stats
              loaded. Wraps in the same group/aiav scope so the hover
              CSS rule fires. */}
          {post.authorUsername &&
          !post.isAnonymous &&
          data.userStats[post.authorUsername] ? (
            <div
              className="relative cursor-pointer group/aiav flex-none"
              title={`查看 @${post.authorUsername} 的個人檔案`}
              onClick={() =>
                navigate(
                  `/forum/user/${encodeURIComponent(post.authorUsername!)}`,
                )
              }
            >
              <PostAvatar post={post} size={40} />
              <HoverCard
                avatarSlot={
                  <UserHoverAvatar
                    stats={data.userStats[post.authorUsername]}
                  />
                }
                primaryName={
                  data.userStats[post.authorUsername].nickname ||
                  data.userStats[post.authorUsername].username
                }
                tier={data.userStats[post.authorUsername].tier}
                level={aiLevel(
                  data.userStats[post.authorUsername].totalPosts +
                    data.userStats[post.authorUsername].totalComments,
                  data.userStats[post.authorUsername].totalLikes,
                )}
                subline={`@${data.userStats[post.authorUsername].username} · ${memberSinceShort(data.userStats[post.authorUsername].memberSince)}`}
                posts={
                  data.userStats[post.authorUsername].totalPosts +
                  data.userStats[post.authorUsername].totalComments
                }
                likes={data.userStats[post.authorUsername].totalLikes}
                tokens={data.userStats[post.authorUsername].totalTokens}
                calls={data.userStats[post.authorUsername].totalCalls}
                cost={data.userStats[post.authorUsername].totalCost}
                onGoToProfile={() =>
                  navigate(
                    `/forum/user/${encodeURIComponent(post.authorUsername!)}`,
                  )
                }
              />
            </div>
          ) : (
            <PostAvatar post={post} size={40} />
          )}
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
              {post.authorUsername && !post.isAnonymous ? (
                <button
                  onClick={() =>
                    navigate(
                      `/forum/user/${encodeURIComponent(post.authorUsername!)}`,
                    )
                  }
                  className="text-gray-400 hover:text-white hover:underline"
                  title={`查看 @${post.authorUsername} 的個人檔案`}
                >
                  {post.authorDisplay}
                </button>
              ) : (
                <span className="text-gray-400">{post.authorDisplay}</span>
              )}
              <span className="text-gray-500">·</span>
              <span className="text-gray-500">
                {relativeTime(post.createdAt)}
              </span>
            </div>
            <CollapsiblePostBody body={post.body} />

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

            {/* PTT-style replies on the OP itself — same shape as the
                ones under comments. Lets people 推/噓/→ the post with
                a one-liner. ±1 votes also bump post.thumbsCount. */}
            <RepliesBlock
              target={{ kind: 'post', id: post.id }}
              replies={data.postReplies}
              canReply={!!user}
              onChange={reload}
            />
          </div>
        </div>
      </div>

      {/* Media library — images attached to this post. Sits above the
          comments so authors / admins can find the uploader without
          scrolling past a long comment thread. The thumbnail
          (is_thumbnail=1) doubles as the og:image for share previews,
          so the gallery is the social-card source of truth. */}
      {(data.media.length > 0 || canUploadMedia) && (
        <MediaGallery
          media={data.media}
          onDelete={
            canUploadMedia
              ? async (mediaId) => {
                  try {
                    await deletePostMedia(post.id, mediaId);
                    reload();
                  } catch (e) {
                    alert((e as Error).message);
                  }
                }
              : undefined
          }
          uploader={
            canUploadMedia ? (
              <MediaUploader
                onUploaded={reload}
                onUpload={(file, isThumbnail) =>
                  uploadPostMedia(post.id, file, { isThumbnail }).then(() => {})
                }
                hint="JPG/PNG/WebP，最大 8 MB"
              />
            ) : undefined
          }
        />
      )}

      {/* Comments */}
      <div className="space-y-2">
        {comments.map((c) => (
          <CommentRow
            key={c.id}
            comment={c}
            aiPersona={post.aiPersona}
            aiStats={data.aiStats}
            userStats={data.userStats}
            onToggleLike={() => toggleCommentLike(c.id)}
            onShowLikers={() => setLikersTarget({ type: 'comment', id: c.id })}
            canLike={!!user}
            canReply={!!user}
            onReplyChange={reload}
            navigate={navigate}
          />
        ))}
      </div>

      {/* Composer — composerRef anchors the 回復 jump button at the
          top of the page so readers can scroll straight here. */}
      <div ref={composerRef}>
        {user ? (
          <CommentComposer onSubmit={submitComment} busy={busy} />
        ) : (
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 text-sm text-gray-400">
            登入後即可留言。
          </div>
        )}
      </div>

      {/* Bottom share row — mirrors the top one so readers who scroll
          all the way through can share without scrolling back up. */}
      <ShareRow post={post} />

      {likersTarget && (
        <LikersModal
          target={likersTarget}
          onClose={() => setLikersTarget(null)}
        />
      )}
    </div>
  );
}

// Breadcrumb on the post detail page. 主頁 › 看板 › 模式 — each
// level is a button that jumps to the full filtered list. Skip the
// 模式 step when the post has no source_mode (rare).
function Breadcrumb({
  post,
  navigate,
}: {
  post: ForumPostDetail;
  navigate: (p: string) => void;
}) {
  return (
    <nav className="flex items-center flex-wrap gap-1.5 text-xs text-gray-500">
      <button
        onClick={() => navigate('/forum')}
        className="hover:text-white"
      >
        主頁
      </button>
      <span>›</span>
      <button
        onClick={() => navigate(`/forum/cat/${encodeURIComponent(post.category)}`)}
        className="hover:text-white"
      >
        {post.category}
      </button>
      {post.sourceMode && (
        <>
          <span>›</span>
          <button
            onClick={() => navigate(`/forum/mode/${post.sourceMode}`)}
            className="hover:text-white"
          >
            {MODE_LABEL[post.sourceMode as ChatMode] ?? post.sourceMode}
          </button>
        </>
      )}
    </nav>
  );
}

// Brand-icon set for the share row. Inline SVGs avoid an icon-pack
// dep and keep the markup self-contained. Each icon is sized 16×16 to
// match the surrounding 12px / 11px text baseline.
const IconX = ({ className = 'w-4 h-4' }: { className?: string }) => (
  <svg viewBox="0 0 24 24" aria-hidden className={className} fill="currentColor">
    <path d="M18.244 2H21.5l-7.514 8.59L23 22h-6.84l-5.36-7.013L4.6 22H1.34l8.04-9.193L1 2h7.014l4.853 6.41L18.244 2zm-2.4 18h1.86L7.27 4H5.31l10.534 16z" />
  </svg>
);
const IconFacebook = ({ className = 'w-4 h-4' }: { className?: string }) => (
  <svg viewBox="0 0 24 24" aria-hidden className={className} fill="currentColor">
    <path d="M22 12.06C22 6.5 17.52 2 12 2S2 6.5 2 12.06c0 4.99 3.66 9.13 8.44 9.93v-7.02H7.9v-2.91h2.54V9.85c0-2.51 1.49-3.9 3.77-3.9 1.09 0 2.24.2 2.24.2v2.46h-1.26c-1.24 0-1.63.78-1.63 1.57v1.88h2.78l-.44 2.91h-2.34V22c4.78-.8 8.44-4.94 8.44-9.94z" />
  </svg>
);
const IconThreads = ({ className = 'w-4 h-4' }: { className?: string }) => (
  <svg viewBox="0 0 24 24" aria-hidden className={className} fill="currentColor">
    <path d="M12.186 2C6.62 2 3 5.6 3 11.93 3 18.42 6.74 22 12.13 22h.06c5.36 0 8.81-3.38 8.81-8.62 0-3.05-1.18-5.27-3.32-6.45l-.18-.1-.04-.2c-.6-3.04-2.86-4.72-5.28-4.63zm.07 1.94c1.84 0 3.36 1.16 3.86 3.06l.1.4-.4.05c-.78.1-1.5.27-2.16.5l-.55.2-.18-.55c-.32-1-.93-1.5-1.96-1.5-1.4 0-2.5.93-2.5 2.34 0 1.5 1.34 2.34 2.84 2.34 1.46 0 2.6-.5 3.46-1.4l.27-.28.32.2c.6.4 1.05.95 1.36 1.62l.16.34-.3.22c-1.32 1-3.03 1.5-5.06 1.5-3.13 0-5.46-1.94-5.46-5.16 0-3.04 2.36-5.18 5.7-5.18zm.86 7.62c-.04 1.74-.42 2.84-1.94 3.96l-.36.26.36.26c1.96 1.4 4.72 1.18 5.06-1.06.18-1.2-.46-2.5-1.94-3.04l-.4-.14-.1.4c-.18.7-.46 1.18-.86 1.5l-.18.13.32-.27c.94-.78 1.04-1.66 1.04-1.86l.04-.34h-1.04z" />
  </svg>
);
const IconLink = ({ className = 'w-4 h-4' }: { className?: string }) => (
  <svg viewBox="0 0 24 24" aria-hidden className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.41 1.41" />
    <path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.41-1.41" />
  </svg>
);

// Inline image uploader for the media library. Renders an "+ 上傳圖片"
// button + a hidden file input + a "set as share thumbnail" toggle.
// The actual API call is wired by the caller through `onUpload`, which
// gets the chosen File + the thumbnail intent and is responsible for
// calling either uploadPostMedia or adminUploadAIMedia.
export function MediaUploader({
  onUploaded,
  onUpload,
  hint,
}: {
  onUploaded: () => void;
  onUpload: (file: File, isThumbnail: boolean) => Promise<void>;
  hint?: string;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [asThumbnail, setAsThumbnail] = useState(false);
  const handleFile = async (file: File | null) => {
    if (!file) return;
    setBusy(true);
    setErr('');
    try {
      await onUpload(file, asThumbnail);
      setAsThumbnail(false);
      onUploaded();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-3 text-xs">
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
        className="hidden"
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={busy}
        className="px-3 py-1.5 rounded bg-pink-600 hover:bg-pink-500 disabled:opacity-50 text-white font-medium"
      >
        {busy ? '上傳中…' : '+ 上傳圖片'}
      </button>
      <label className="flex items-center gap-1.5 text-gray-300 select-none cursor-pointer">
        <input
          type="checkbox"
          checked={asThumbnail}
          onChange={(e) => setAsThumbnail(e.target.checked)}
          disabled={busy}
        />
        <span>設為社群分享封面</span>
      </label>
      {hint && <span className="text-gray-500">{hint}</span>}
      {err && <span className="text-red-300">{err}</span>}
    </div>
  );
}

// Media gallery — surfaces the post's image library as a horizontal
// thumbnail row. Click a tile to open the image in a new tab (full
// resolution). The thumbnail flag (★) is purely informational — server
// already used it for the og:image; on the page itself every image is
// equally browsable. Optional `onDelete` enables an X button per tile
// for the post author / admin.
export function MediaGallery({
  media,
  onDelete,
  uploader,
}: {
  media: MediaItem[];
  onDelete?: (mediaId: number) => void | Promise<void>;
  uploader?: React.ReactNode;
}) {
  return (
    <section className="bg-gray-900 border border-gray-800 rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-gray-200 flex items-center gap-2">
          <span>媒體庫</span>
          <span className="text-[11px] text-gray-500 font-normal">
            {media.length} 張圖
          </span>
        </h3>
      </div>
      {uploader}
      {media.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
          {media.map((m) => (
            <div
              key={m.id}
              className="relative aspect-square rounded-md overflow-hidden bg-gray-800 group"
            >
              <a
                href={m.url}
                target="_blank"
                rel="noopener noreferrer"
                className="block w-full h-full hover:ring-2 hover:ring-pink-400/60 transition-all"
                title={m.caption ?? '查看原圖'}
              >
                <img
                  src={m.url}
                  alt={m.caption ?? ''}
                  loading="lazy"
                  className="w-full h-full object-cover"
                />
              </a>
              {m.isThumbnail && (
                <span
                  className="absolute top-1 left-1 px-1.5 py-0.5 rounded bg-black/70 text-yellow-300 text-[10px] pointer-events-none"
                  title="社群分享封面"
                >
                  ★ 封面
                </span>
              )}
              {onDelete && (
                <button
                  type="button"
                  onClick={() => {
                    if (confirm('刪除這張圖？')) onDelete(m.id);
                  }}
                  className="absolute top-1 right-1 w-6 h-6 rounded-full bg-black/70 hover:bg-red-600 text-white text-xs opacity-0 group-hover:opacity-100 transition-opacity"
                  title="刪除"
                >
                  ×
                </button>
              )}
              {m.caption && (
                <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 to-transparent px-2 py-1 text-[11px] text-gray-100 line-clamp-2 pointer-events-none">
                  {m.caption}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// Share row — opens platform-specific intent URLs (X / Facebook /
// Threads) plus a copy-link fallback. Compact icon-only style on
// detail pages; falls back to text+icon on broader screens. Per-post
// OG image generation lives server-side now (see server/src/index.ts
// HTML middleware) so link previews show real post content.
function ShareRow({
  post,
  variant = 'default',
}: {
  post: ForumPostDetail;
  variant?: 'default' | 'compact';
}) {
  const [copied, setCopied] = useState(false);
  const url =
    typeof window !== 'undefined'
      ? `${window.location.origin}/forum/post/${post.id}`
      : `/forum/post/${post.id}`;
  const text = `${post.title}\n\n${post.bodyPreview}`;
  const encU = encodeURIComponent(url);
  const encT = encodeURIComponent(text);
  const targets = [
    {
      key: 'x',
      label: 'X',
      Icon: IconX,
      href: `https://twitter.com/intent/tweet?text=${encT}&url=${encU}`,
    },
    {
      key: 'fb',
      label: 'Facebook',
      Icon: IconFacebook,
      href: `https://www.facebook.com/sharer/sharer.php?u=${encU}`,
    },
    {
      key: 'th',
      label: 'Threads',
      Icon: IconThreads,
      href: `https://www.threads.net/intent/post?text=${encT}%0A${encU}`,
    },
  ];
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore — older browsers without async clipboard API
    }
  };
  const isCompact = variant === 'compact';
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="text-gray-500">分享至</span>
      {targets.map(({ key, label, Icon, href }) => (
        <a
          key={key}
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          title={label}
          aria-label={`分享到 ${label}`}
          className={`flex items-center justify-center rounded-full text-gray-300 hover:text-white hover:bg-gray-800 transition-colors ${
            isCompact ? 'w-7 h-7' : 'w-8 h-8'
          }`}
        >
          <Icon className={isCompact ? 'w-4 h-4' : 'w-[18px] h-[18px]'} />
        </a>
      ))}
      <button
        onClick={handleCopy}
        title="複製連結"
        aria-label="複製連結"
        className={`flex items-center justify-center rounded-full text-gray-300 hover:text-white hover:bg-gray-800 transition-colors ${
          isCompact ? 'w-7 h-7' : 'w-8 h-8'
        }`}
      >
        <IconLink className={isCompact ? 'w-4 h-4' : 'w-[18px] h-[18px]'} />
      </button>
      {copied && <span className="text-green-300">✓ 已複製</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

// Tile variant — vertical card sized for grid layout. Surfaces avatar
// + author up front so the index reads like a Reddit/Hacker News card
// row instead of a raw text list.
function PostTile({
  post,
  navigate,
}: {
  post: ForumPostSummary;
  navigate: (p: string) => void;
}) {
  return (
    <button
      onClick={() => navigate(`/forum/post/${post.id}`)}
      className="flex flex-col gap-2 bg-gray-900 hover:bg-gray-850 border border-gray-800 rounded-lg p-3 text-left transition-colors h-full"
    >
      <div className="flex items-center gap-1.5 text-[10px] flex-wrap">
        <span className="px-1.5 py-0.5 rounded bg-gray-800 text-gray-300">
          {post.category}
        </span>
        {post.sourceMode && <ModePill mode={post.sourceMode as ChatMode} />}
        {post.nsfw && (
          <span
            className="px-1.5 py-0.5 rounded bg-red-900/50 text-red-200 border border-red-700/40 font-semibold"
            title="18+ 內容"
          >
            🔞 18+
          </span>
        )}
        <span className="text-gray-500 ml-auto">
          {relativeTime(post.createdAt)}
        </span>
      </div>
      <div className="text-sm font-semibold text-gray-100 line-clamp-2 leading-snug">
        {post.title}
      </div>
      <div className="text-xs text-gray-400 line-clamp-3 flex-1 leading-relaxed">
        {post.bodyPreview}
      </div>
      <div className="flex items-center gap-2 text-[11px] text-gray-500 pt-1 border-t border-gray-800">
        <TileAuthorAvatar post={post} />
        <span className="truncate flex-1">{post.authorDisplay}</span>
        <span className="whitespace-nowrap">
          👍 {post.thumbsCount} · 💬 {post.commentCount}
        </span>
      </div>
    </button>
  );
}

// Tiny avatar (24px) for the tile footer. Anonymous posts get the
// silhouette; named users try their uploaded avatar with an initial
// fallback if the request 404s.
function TileAuthorAvatar({ post }: { post: ForumPostSummary }) {
  const SIZE = 24;
  if (post.isAnonymous || !post.authorUsername) {
    return <AnonAvatar size={SIZE} />;
  }
  return <UserAvatar username={post.authorUsername} size={SIZE} />;
}

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
        {post.nsfw && (
          <span
            className="px-1.5 py-0.5 rounded bg-red-900/50 text-red-200 border border-red-700/40 text-[10px] font-semibold"
            title="18+ 內容"
          >
            🔞 18+
          </span>
        )}
        <span className="text-gray-500">·</span>
        <span className="text-gray-400">{post.authorDisplay}</span>
        <span className="text-gray-500">·</span>
        <span className="text-gray-500">{relativeTime(post.createdAt)}</span>
      </div>
      {/* PostCard has the entire card as a button — clicking the
          author would also navigate into the post. We deliberately
          don't add a separate author link inside the card to avoid
          nested clickable hierarchies. The post-detail page is where
          you click through to the user profile. */}
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
  aiStats,
  userStats,
  onToggleLike,
  onShowLikers,
  canLike,
  canReply,
  onReplyChange,
  navigate,
}: {
  comment: ForumComment;
  aiPersona: string | null;
  // Per-provider cumulative stats — used for the avatar mini-badge
  // (Lv X · ❤ N) and the hover card. Same map for every comment.
  aiStats: AIStatsMap;
  // Per-username stats keyed by comment author. Server inlines stats
  // for every non-anonymous participant in this post so user hover
  // cards have data without a fetch per comment.
  userStats: Record<string, UserStat>;
  onToggleLike: () => void;
  onShowLikers: () => void;
  canLike: boolean;
  // True when the viewer is logged in and can post 推/噓/→ replies.
  canReply: boolean;
  // Called after a reply is posted or deleted; parent reloads the
  // post so vote counts and the reply list stay in sync.
  onReplyChange: () => void;
  navigate: (p: string) => void;
}) {
  const isAi = comment.authorType === 'ai';
  const provider = comment.authorAiProvider;
  const primaryName = isAi && provider
    ? capitalize(provider)
    : comment.authorDisplay;
  const metaParts: string[] = [];
  if (comment.isImported) metaParts.push('來自原對話');
  metaParts.push(relativeTime(comment.createdAt));
  // Clicking the avatar / name jumps to the author's profile page.
  // Anonymous users have no profile (server returns 404 for them) so
  // we don't wire a click handler at all in that case. Both AI and
  // user navigate through the unified /forum/user/<handle> URL.
  const userClickable =
    !isAi && !comment.isAnonymous && !!comment.authorUsername;
  const goToAuthor = () => {
    if (isAi && provider) navigate(`/forum/user/${provider}`);
    else if (userClickable && comment.authorUsername) {
      navigate(`/forum/user/${encodeURIComponent(comment.authorUsername)}`);
    }
  };
  const isClickable = isAi || userClickable;
  const hoverLabel = isAi && provider
    ? `查看 ${capitalize(provider)} 的個人檔案`
    : userClickable
      ? `查看 ${comment.authorDisplay} 的個人檔案`
      : undefined;
  const stat = isAi && provider ? aiStats[provider] : null;
  const level = stat ? aiLevel(stat.totalComments, stat.totalLikes) : null;

  return (
    <div
      className={`flex gap-3 bg-gray-900 border rounded-lg p-3 ${
        isAi ? 'border-gray-700' : 'border-gray-800'
      }`}
    >
      {/* Avatar column. Two earlier mistakes here:
          - `isolate` trapped the popup inside the avatar column's
            stacking context, so the comment body sibling painted over
            it.
          - `hover:opacity-80` on the wrapper ALSO created a stacking
            context (per CSS spec, opacity < 1 establishes one) the
            moment hover engaged, defeating the popup's z-index.
          Now: no isolate, no hover-opacity. The popup itself is the
          hover affordance — visual feedback comes from it appearing. */}
      <div className="flex flex-col items-center gap-1 flex-none">
        <div
          className={`relative ${isClickable ? 'cursor-pointer group/aiav' : ''}`}
          title={hoverLabel}
          onClick={goToAuthor}
        >
          <CommentAvatar comment={comment} size={36} />
          {isAi && provider && stat && (
            <HoverCard
              avatarSlot={<ProviderAvatar provider={provider} size={40} />}
              primaryName={AI_PROVIDERS[provider].name}
              tier="admin"
              level={aiLevel(stat.totalComments, stat.totalLikes)}
              subline={`@${provider} · ${AI_BIOS[provider].tagline}`}
              bio={AI_BIOS[provider].bio}
              posts={stat.totalComments}
              likes={stat.totalLikes}
              tokens={stat.totalTokens}
              calls={stat.totalCalls}
              cost={stat.totalCost}
              accent={AI_PROVIDERS[provider].color}
              onGoToProfile={goToAuthor}
            />
          )}
          {userClickable &&
            comment.authorUsername &&
            userStats[comment.authorUsername] && (
              <HoverCard
                avatarSlot={
                  <UserHoverAvatar stats={userStats[comment.authorUsername]} />
                }
                primaryName={
                  userStats[comment.authorUsername].nickname ||
                  userStats[comment.authorUsername].username
                }
                tier={userStats[comment.authorUsername].tier}
                level={aiLevel(
                  userStats[comment.authorUsername].totalPosts +
                    userStats[comment.authorUsername].totalComments,
                  userStats[comment.authorUsername].totalLikes,
                )}
                subline={`@${userStats[comment.authorUsername].username} · ${memberSinceShort(userStats[comment.authorUsername].memberSince)}`}
                posts={
                  userStats[comment.authorUsername].totalPosts +
                  userStats[comment.authorUsername].totalComments
                }
                likes={userStats[comment.authorUsername].totalLikes}
                tokens={userStats[comment.authorUsername].totalTokens}
                calls={userStats[comment.authorUsername].totalCalls}
                cost={userStats[comment.authorUsername].totalCost}
                onGoToProfile={goToAuthor}
              />
            )}
        </div>
        {/* Persistent mini badge under avatar — Lv + accumulated ❤. Only
            appears for AI comments since users don't have a "level" in
            the forum (yet). */}
        {isAi && provider && stat && level !== null && (
          <span className="text-[9px] text-gray-500 leading-none whitespace-nowrap">
            Lv {level} · ❤ {stat.totalLikes}
          </span>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 mb-1">
          <span
            className={`text-sm ${
              isClickable
                ? isAi
                  ? 'text-gray-100 font-semibold cursor-pointer hover:text-white hover:underline'
                  : 'text-gray-200 font-medium cursor-pointer hover:text-white hover:underline'
                : isAi
                  ? 'text-gray-100 font-semibold'
                  : 'text-gray-200 font-medium'
            }`}
            title={hoverLabel}
            onClick={isClickable ? goToAuthor : undefined}
          >
            {primaryName}
          </span>
          <span className="text-[11px] text-gray-500">
            {metaParts.join(' · ')}
          </span>
        </div>
        <CollapsibleBody body={comment.body} />
        <div className="mt-2 flex items-center gap-2">
          <LikeButton
            liked={comment.liked}
            count={comment.thumbsCount}
            onToggle={onToggleLike}
            onShowLikers={onShowLikers}
            disabled={!canLike}
          />
        </div>
        {/* PTT-style replies — 推/噓/→ list + composer underneath. */}
        <RepliesBlock
          target={{ kind: 'comment', id: comment.id }}
          replies={comment.replies}
          canReply={canReply}
          onChange={onReplyChange}
        />
      </div>
    </div>
  );
}

// Markdown renderer for forum bodies. AIs love writing **bold**, tables,
// and code fences — vanilla whitespace-pre-wrap renders those as raw
// asterisks and pipes, which looks broken. ReactMarkdown + remark-gfm
// gives us tables, strikethrough, autolinks, and inline emphasis with
// styled defaults that match the rest of the dark theme.
function MarkdownBody({
  body,
  className = '',
}: {
  body: string;
  className?: string;
}) {
  return (
    <div className={`forum-md text-sm text-gray-200 leading-relaxed ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Wrap tables so wide ones scroll horizontally instead of
          // breaking the layout.
          table: ({ node, ...props }) => (
            <div className="overflow-x-auto my-2">
              <table
                {...props}
                className="border-collapse text-xs border border-gray-700"
              />
            </div>
          ),
          th: ({ node, ...props }) => (
            <th
              {...props}
              className="border border-gray-700 bg-gray-800 px-2 py-1 text-left font-semibold"
            />
          ),
          td: ({ node, ...props }) => (
            <td {...props} className="border border-gray-700 px-2 py-1 align-top" />
          ),
          a: ({ node, ...props }) => (
            <a
              {...props}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-300 hover:text-blue-200 underline"
            />
          ),
          code: ({ node, className: cls, children, ...props }) => {
            const isBlock = /\n/.test(String(children));
            return isBlock ? (
              <code
                {...props}
                className="block bg-gray-950 border border-gray-800 rounded p-2 text-xs overflow-x-auto"
              >
                {children}
              </code>
            ) : (
              <code
                {...props}
                className="bg-gray-800 px-1 py-0.5 rounded text-xs"
              >
                {children}
              </code>
            );
          },
          pre: ({ node, ...props }) => (
            <pre {...props} className="my-2" />
          ),
          ul: ({ node, ...props }) => (
            <ul {...props} className="list-disc pl-5 my-1" />
          ),
          ol: ({ node, ...props }) => (
            <ol {...props} className="list-decimal pl-5 my-1" />
          ),
          blockquote: ({ node, ...props }) => (
            <blockquote
              {...props}
              className="border-l-2 border-gray-700 pl-3 my-2 text-gray-400"
            />
          ),
          h1: ({ node, ...props }) => (
            <h1 {...props} className="text-lg font-bold mt-2 mb-1" />
          ),
          h2: ({ node, ...props }) => (
            <h2 {...props} className="text-base font-bold mt-2 mb-1" />
          ),
          h3: ({ node, ...props }) => (
            <h3 {...props} className="text-sm font-bold mt-2 mb-1" />
          ),
          p: ({ node, ...props }) => (
            <p {...props} className="my-1 whitespace-pre-wrap" />
          ),
        }}
      >
        {body}
      </ReactMarkdown>
    </div>
  );
}

// Long comments (over ~5 lines or 240 chars) collapse to a clamped
// preview with a "閱讀更多" toggle. Keeps the post scannable when an
// AI dumps a 30-line essay reply.
function CollapsibleBody({ body }: { body: string }) {
  const [expanded, setExpanded] = useState(false);
  const lineCount = body.split('\n').length;
  const isLong = body.length > 240 || lineCount > 5;
  return (
    <div>
      <div className={isLong && !expanded ? 'line-clamp-5 overflow-hidden' : ''}>
        <MarkdownBody body={body} />
      </div>
      {isLong && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="mt-1 text-[11px] text-blue-300 hover:text-blue-200"
        >
          {expanded ? '收起' : '閱讀更多 ↓'}
        </button>
      )}
    </div>
  );
}

// Same idea as CollapsibleBody but tuned for the OP — the body is the
// page's main content so the threshold + clamp are looser (12 lines,
// ~800 chars before folding) and the rendered text is text-base
// instead of text-sm.
function CollapsiblePostBody({ body }: { body: string }) {
  const [expanded, setExpanded] = useState(false);
  const lineCount = body.split('\n').length;
  const isLong = body.length > 800 || lineCount > 12;
  return (
    <div className="mt-2">
      <div className={isLong && !expanded ? 'line-clamp-[12] overflow-hidden' : ''}>
        <MarkdownBody body={body} className="text-base" />
      </div>
      {isLong && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="mt-2 text-xs text-blue-300 hover:text-blue-200"
        >
          {expanded ? '收起 ▲' : '閱讀更多 ▼'}
        </button>
      )}
    </div>
  );
}

// PTT-style reply strip — 推 (vote='up'), 噓 (vote='down'), → (vote=
// 'none'). 推 / 噓 also bump the target's thumbs_count by ±1 server-
// side; 'none' is just an inline reply with no thumb impact.
//
// `target` lets the same component drive either comment-replies or
// post-replies; the composer routes to the matching endpoint and the
// list rendering is identical.
type ReplyTarget =
  | { kind: 'comment'; id: number }
  | { kind: 'post'; id: number };

function RepliesBlock({
  target,
  replies,
  canReply,
  onChange,
}: {
  target: ReplyTarget;
  replies: ForumCommentReply[];
  canReply: boolean;
  onChange: () => void;
}) {
  return (
    <div className="mt-2 pt-2 border-t border-gray-800/60 space-y-1">
      {replies.length === 0 && !canReply ? null : (
        <>
          {replies.map((r) => (
            <ReplyRow key={r.id} reply={r} />
          ))}
          {canReply && (
            <ReplyComposer target={target} onPosted={onChange} />
          )}
        </>
      )}
    </div>
  );
}

const VOTE_GLYPH: Record<'up' | 'down' | 'none', string> = {
  up: '推',
  down: '噓',
  none: '→',
};
const VOTE_COLOR: Record<'up' | 'down' | 'none', string> = {
  up: 'text-rose-300',
  down: 'text-sky-300',
  none: 'text-gray-500',
};

function ReplyRow({ reply }: { reply: ForumCommentReply }) {
  return (
    <div className="flex items-baseline gap-2 text-[11px]">
      <span className={`font-bold w-6 flex-none ${VOTE_COLOR[reply.vote]}`}>
        {VOTE_GLYPH[reply.vote]}
      </span>
      <span className="text-gray-300 font-medium whitespace-nowrap">
        {reply.authorDisplay}
      </span>
      <span className="text-gray-500">：</span>
      <span className="text-gray-200 flex-1 break-words [&_p]:inline [&_p]:m-0">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            a: ({ node, ...props }) => (
              <a
                {...props}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-300 hover:text-blue-200 underline"
              />
            ),
          }}
        >
          {reply.body}
        </ReactMarkdown>
      </span>
      <span className="text-gray-600 whitespace-nowrap">
        {relativeTime(reply.createdAt)}
      </span>
    </div>
  );
}

function ReplyComposer({
  target,
  onPosted,
}: {
  target: ReplyTarget;
  onPosted: () => void;
}) {
  const [vote, setVote] = useState<'up' | 'down' | 'none'>('none');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [overrideNote, setOverrideNote] = useState('');

  const submit = async () => {
    const text = body.trim();
    if (!text) return;
    setBusy(true);
    setErr('');
    setOverrideNote('');
    try {
      const result =
        target.kind === 'post'
          ? await postPostReply(target.id, { vote, body: text })
          : await postCommentReply(target.id, { vote, body: text });
      setBody('');
      setVote('none');
      if (result.voteOverridden) {
        const prev = result.voteOverridden.previousVote === 'up' ? '推' : '噓';
        const noun = target.kind === 'post' ? '這篇文章' : '這則留言';
        setOverrideNote(`你已經${prev}過${noun}了，幫您用 → 發送`);
      }
      onPosted();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-1 pt-1">
      <div className="flex rounded border border-gray-700 overflow-hidden text-[11px]">
        {(['up', 'down', 'none'] as const).map((v) => (
          <button
            key={v}
            onClick={() => setVote(v)}
            disabled={busy}
            className={`px-2 py-0.5 ${
              vote === v
                ? `${VOTE_COLOR[v]} bg-gray-700`
                : 'text-gray-500 hover:bg-gray-800'
            }`}
            title={
              v === 'up' ? '推 — +1 ❤' : v === 'down' ? '噓 — -1 ❤' : '→ 不投票'
            }
          >
            {VOTE_GLYPH[v]}
          </button>
        ))}
      </div>
      <input
        type="text"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="快速評論..."
        maxLength={200}
        disabled={busy}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
        }}
        className="flex-1 min-w-0 px-2 py-1 bg-gray-900 border border-gray-700 rounded text-[11px] text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500"
      />
      <button
        onClick={submit}
        disabled={busy || !body.trim()}
        className="px-2 py-0.5 rounded bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white text-[11px]"
      >
        送出
      </button>
      {err && <div className="w-full text-[11px] text-red-300">{err}</div>}
      {overrideNote && (
        <div className="w-full text-[11px] text-red-300">{overrideNote}</div>
      )}
    </div>
  );
}

// Avatar variant used inside the user HoverCard — picks between
// uploaded avatar / initial fallback.
function UserHoverAvatar({ stats }: { stats: UserStat }) {
  const display = stats.nickname || stats.username;
  if (stats.hasAvatar) {
    return (
      <img
        src={avatarUrl(stats.username, 0)}
        alt={display}
        className="w-10 h-10 rounded-full object-cover border border-gray-700 flex-none"
      />
    );
  }
  return (
    <div
      className="w-10 h-10 rounded-full bg-gray-700 flex items-center justify-center text-gray-200 font-bold flex-none"
      style={{ fontSize: 16 }}
    >
      {display.slice(0, 1).toUpperCase()}
    </div>
  );
}

function memberSinceShort(ms: number): string {
  const days = Math.floor((Date.now() - ms) / 86400000);
  if (days < 30) return `加入 ${days} 天`;
  if (days < 365) return `加入 ${Math.floor(days / 30)} 個月`;
  return `加入 ${Math.floor(days / 365)} 年`;
}

// Tier-badge palette. AIs share the 'admin' label (per spec — AIs are
// first-class members, not gated by tier).
const TIER_BADGES: Record<string, { label: string; bg: string }> = {
  free: { label: 'Free', bg: '#6b7280' },
  standard: { label: 'Standard', bg: '#4b5563' },
  pro: { label: 'Pro', bg: '#2563eb' },
  super: { label: 'Super', bg: '#f59e0b' },
  admin: { label: 'Admin', bg: '#dc2626' },
};
function TierBadge({ tier }: { tier: string }) {
  const t = TIER_BADGES[tier] ?? TIER_BADGES.free;
  return (
    <span
      className="px-1.5 py-0.5 rounded text-[9px] font-bold text-white whitespace-nowrap flex-none"
      style={{ backgroundColor: t.bg }}
    >
      {t.label}
    </span>
  );
}

// Forum activity level — separate from tier. AIs and users alike earn
// it from posts + likes via aiLevel().
function LvBadge({ level, accent }: { level: number; accent?: string }) {
  return (
    <span
      className="px-1.5 py-0.5 rounded text-[9px] font-bold text-white whitespace-nowrap flex-none"
      style={{ backgroundColor: accent ?? '#475569' }}
    >
      Lv {level}
    </span>
  );
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

// Unified hover-card — shared between AI and user comment avatars so
// the layout (header, bio, 5-metric stats row, CTA) is identical and
// only the data differs. AIs always render with tier='admin' and a
// brand-coloured border; users get a neutral border + their actual
// tier badge.
interface HoverCardProps {
  // The avatar element to render in the header (40px). Caller decides
  // whether it's a ProviderAvatar (AI) or img/InitialAvatar (user).
  avatarSlot: React.ReactNode;
  primaryName: string;
  tier: string;
  // Forum activity level — same formula for both AI and users
  // (aiLevel from shared/constants). Rendered as a small pill next to
  // the tier badge.
  level: number;
  // Tagline for AI ("@grok · xAI · 直率、實用主義") or
  // "@username · 加入 N 天" for user.
  subline: string;
  // Optional 2-line bio. AIs always have one (hardcoded in AI_BIOS),
  // users only when they've filled in their public bio.
  bio?: string;
  // Combined post-count: AI = totalComments, user = totalPosts + totalComments.
  // Per spec: "都是 post 啊", so we collapse the two columns.
  posts: number;
  likes: number;
  tokens: number;
  calls: number;
  cost: number;
  // Border accent — provider colour for AIs, neutral for users.
  accent?: string;
  onGoToProfile: () => void;
}
function HoverCard({
  avatarSlot,
  primaryName,
  tier,
  level,
  subline,
  bio,
  posts,
  likes,
  tokens,
  calls,
  cost,
  accent,
  onGoToProfile,
}: HoverCardProps) {
  return (
    <div
      // bg-surface-overlay → theme-aware fully-opaque background.
      // z-[100] + the deliberately removed hover-opacity on the parent
      // wrapper keep the card above the comment body on every theme.
      className={`hidden group-hover/aiav:block absolute z-[100] left-full ml-2 top-0 w-64 rounded-lg shadow-2xl p-3 cursor-default bg-surface-overlay ${
        accent ? 'border-2' : 'border border-gray-700'
      }`}
      style={accent ? { borderColor: `${accent}aa` } : undefined}
      onClick={(e) => {
        // Block parent's onClick (navigates to profile) so users can
        // interact with the card itself. The CTA inside opts in.
        e.stopPropagation();
      }}
    >
      <div className="flex items-start gap-2 mb-2">
        {avatarSlot}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1 flex-wrap">
            <span className="text-sm font-bold text-gray-100 truncate">
              {primaryName}
            </span>
            <TierBadge tier={tier} />
            <LvBadge level={level} accent={accent} />
          </div>
          <div className="text-[10px] text-gray-500 truncate">{subline}</div>
        </div>
      </div>
      {bio && (
        <p className="text-[11px] text-gray-400 leading-relaxed mb-2 line-clamp-2">
          {bio}
        </p>
      )}
      <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-gray-300 mb-2">
        <span title="累計發文（含留言）">💬 {posts}</span>
        <span title="收到讚">❤ {likes}</span>
        <span title="累計 tokens">🔢 {formatTokens(tokens)}</span>
        <span title="呼叫次數">📞 {calls}</span>
        <span title="累計成本" className="col-span-2 text-gray-400">
          💰 ${cost.toFixed(2)}
        </span>
      </div>
      <button
        onClick={onGoToProfile}
        className="w-full text-left text-[11px] text-blue-300 hover:text-blue-200"
      >
        查看完整檔案 →
      </button>
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
        className="bg-surface-overlay border border-gray-800 rounded-lg w-full max-w-sm p-4 space-y-3"
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
