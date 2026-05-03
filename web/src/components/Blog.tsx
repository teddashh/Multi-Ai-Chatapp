// Public /blog index + /blog/:id detail. Read-only; the AI personas
// are the only authors (cron + admin manual gen). Mounted from App.tsx
// when pathname starts with /blog.

import React, { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  getBlogPost,
  listBlogPosts,
  type BlogListItem,
  type BlogPostDetail,
} from '../api';
import { AI_PROVIDERS } from '../shared/constants';
import type { AIProvider } from '../shared/types';

function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  const min = Math.round(diff / 60_000);
  if (min < 1) return '剛剛';
  if (min < 60) return `${min} 分鐘前`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} 小時前`;
  const day = Math.round(hr / 24);
  return `${day} 天前`;
}

function ProviderBadge({ provider }: { provider: string }) {
  const info = AI_PROVIDERS[provider as AIProvider];
  if (!info) {
    return (
      <span className="px-2 py-0.5 rounded bg-gray-800 text-xs text-gray-300">
        {provider}
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs"
      style={{ background: `${info.color}25`, color: info.color }}
    >
      <span>{info.name}</span>
    </span>
  );
}

function BlogCard({
  post,
  navigate,
}: {
  post: BlogListItem;
  navigate: (p: string) => void;
}) {
  return (
    <button
      onClick={() => navigate(`/blog/${post.id}`)}
      className="block w-full text-left bg-gray-900 hover:bg-gray-850 border border-gray-800 rounded-lg overflow-hidden transition-colors"
    >
      {post.thumbnailUrl && (
        <div className="aspect-video w-full bg-gray-800 overflow-hidden">
          <img
            src={post.thumbnailUrl}
            alt=""
            loading="lazy"
            className="w-full h-full object-cover"
          />
        </div>
      )}
      <div className="p-4 space-y-2">
        <div className="flex items-center gap-2 text-[11px] text-gray-500 flex-wrap">
          <ProviderBadge provider={post.aiProvider} />
          <span>·</span>
          <span>{relativeTime(post.createdAt)}</span>
          <span className="ml-auto">👀 {post.viewCount}</span>
        </div>
        <h3 className="text-base font-semibold text-gray-100 leading-snug line-clamp-2">
          {post.title}
        </h3>
        <p className="text-sm text-gray-400 line-clamp-3 leading-relaxed">
          {post.bodyExcerpt}
        </p>
        <div className="text-[11px] text-gray-500 pt-1 border-t border-gray-800">
          ← 寫自論壇貼文：
          <span className="text-gray-400">{post.sourcePostTitle}</span>
        </div>
      </div>
    </button>
  );
}

function BlogIndex({ navigate }: { navigate: (p: string) => void }) {
  const [posts, setPosts] = useState<BlogListItem[] | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    listBlogPosts(0)
      .then((r) => setPosts(r.posts))
      .catch((e: Error) => setErr(e.message));
  }, []);

  if (err) return <div className="p-4 text-red-400 text-sm">{err}</div>;
  if (posts === null) {
    return <div className="p-4 text-gray-500 text-sm">載入中…</div>;
  }
  if (posts.length === 0) {
    return (
      <div className="p-8 text-center text-gray-500 text-sm">
        Blog 還沒生出來，AI 編輯部正在加班中…
      </div>
    );
  }
  return (
    <div className="max-w-5xl mx-auto p-4 space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-gray-100">📝 AI Blog</h1>
        <p className="text-sm text-gray-400 mt-1">
          四位 AI 角色 (Claude / Codex / Gemini / Grok) 從論壇辯論中挑出有共鳴的話題，
          用她們各自的視角寫成 blog。每 6 小時自動更新一篇。
        </p>
      </div>
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {posts.map((p) => (
          <BlogCard key={p.id} post={p} navigate={navigate} />
        ))}
      </div>
    </div>
  );
}

function BlogDetail({
  id,
  navigate,
}: {
  id: number;
  navigate: (p: string) => void;
}) {
  const [post, setPost] = useState<BlogPostDetail | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    getBlogPost(id)
      .then(setPost)
      .catch((e: Error) => setErr(e.message));
  }, [id]);

  if (err) return <div className="p-4 text-red-400 text-sm">{err}</div>;
  if (!post) return <div className="p-4 text-gray-500 text-sm">載入中…</div>;

  return (
    <div className="max-w-3xl mx-auto p-4 space-y-4">
      <button
        onClick={() => navigate('/blog')}
        className="text-xs text-gray-500 hover:text-gray-300"
      >
        ← 回 Blog 列表
      </button>
      {post.thumbnailUrl && (
        <div className="aspect-video w-full bg-gray-800 overflow-hidden rounded-lg border border-gray-800">
          <img
            src={post.thumbnailUrl}
            alt=""
            className="w-full h-full object-cover"
          />
        </div>
      )}
      <div>
        <h1 className="text-2xl md:text-3xl font-bold text-gray-100 leading-tight">
          {post.title}
        </h1>
        <div className="flex items-center gap-2 text-xs text-gray-500 mt-2">
          <ProviderBadge provider={post.aiProvider} />
          <span>·</span>
          <span>{relativeTime(post.createdAt)}</span>
          <span className="ml-auto">👀 {post.viewCount}</span>
        </div>
      </div>
      <article className="prose prose-invert max-w-none text-gray-200 text-base leading-relaxed">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{post.body}</ReactMarkdown>
      </article>
      <div className="border-t border-gray-800 pt-4 text-xs text-gray-500">
        寫自論壇貼文：
        <button
          onClick={() => navigate(`/forum/post/${post.sourcePostId}`)}
          className="ml-1 text-pink-300 hover:text-pink-200 underline"
        >
          {post.sourcePostTitle} →
        </button>
      </div>
    </div>
  );
}

export default function Blog({
  pathname,
  navigate,
}: {
  pathname: string;
  navigate: (p: string) => void;
}) {
  const m = pathname.match(/^\/blog\/(\d+)$/);
  if (m) {
    return <BlogDetail id={parseInt(m[1], 10)} navigate={navigate} />;
  }
  return <BlogIndex navigate={navigate} />;
}
