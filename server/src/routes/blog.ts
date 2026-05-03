// Public blog routes. Read-only — write path is admin-only via
// /api/admin/blog/generate (manual) or the cron in blogScheduler.ts.

import { Hono } from 'hono';
import { type AppVariables } from '../lib/auth.js';
import { blogStmts, type BlogPostRow, forumStmts, type ForumPostRow } from '../lib/db.js';

export const blogRoute = new Hono<{ Variables: AppVariables }>();

interface BlogListItem {
  id: number;
  title: string;
  bodyExcerpt: string;
  aiProvider: string;
  sourcePostId: number;
  sourcePostTitle: string;
  thumbnailUrl: string | null;
  viewCount: number;
  createdAt: number;
}

function excerptOf(body: string): string {
  const trimmed = body.trim().replace(/\s+/g, ' ');
  return trimmed.length <= 200 ? trimmed : trimmed.slice(0, 200) + '…';
}

function formatItem(row: BlogPostRow): BlogListItem {
  // Source post title for context (the AI'\''s blog often relies on it
  // for the topic). Cheap join — N+1 acceptable at current volumes.
  const source = forumStmts.findPostById.get(row.source_post_id) as
    | ForumPostRow
    | undefined;
  return {
    id: row.id,
    title: row.title,
    bodyExcerpt: excerptOf(row.body),
    aiProvider: row.ai_provider,
    sourcePostId: row.source_post_id,
    sourcePostTitle: source?.title ?? '(已刪除)',
    thumbnailUrl: row.thumbnail_media_id
      ? `/api/forum/media/${row.thumbnail_media_id}`
      : null,
    viewCount: row.view_count,
    createdAt: row.created_at * 1000,
  };
}

const PAGE_SIZE = 20;

blogRoute.get('/', (c) => {
  const offset = Math.max(0, parseInt(c.req.query('offset') ?? '0', 10) || 0);
  const rows = blogStmts.listRecent.all(PAGE_SIZE, offset) as BlogPostRow[];
  return c.json({ posts: rows.map(formatItem), pageSize: PAGE_SIZE });
});

blogRoute.get('/:id', (c) => {
  const id = parseInt(c.req.param('id') ?? '', 10);
  if (!Number.isFinite(id) || id <= 0) {
    return c.json({ error: 'invalid id' }, 400);
  }
  const row = blogStmts.findById.get(id) as BlogPostRow | undefined;
  if (!row) return c.json({ error: 'not found' }, 404);

  // Bump view count — counts every fetch including author/admin
  // refreshes (matches forum_posts.view_count behaviour).
  blogStmts.incViewCount.run(id);
  row.view_count = row.view_count + 1;

  const item = formatItem(row);
  return c.json({
    ...item,
    body: row.body, // full body for detail
  });
});
