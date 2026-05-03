import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { serveStatic } from '@hono/node-server/serve-static';
import { authRoute } from './routes/auth.js';
import { chatRoute } from './routes/chat.js';
import { adminRoute } from './routes/admin.js';
import { sessionsRoute } from './routes/sessions.js';
import { forumRoute } from './routes/forum.js';
import { blogRoute } from './routes/blog.js';
import { startFallbackDigest } from './lib/fallbackDigest.js';
import { startAutoDebateScheduler } from './lib/autoDebateScheduler.js';
import { startBlogScheduler } from './lib/blogScheduler.js';
import { forumStmts, blogStmts, type BlogPostRow } from './lib/db.js';
import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

const app = new Hono();
app.use('*', logger());

app.route('/api/auth', authRoute);
app.route('/api/chat', chatRoute);
app.route('/api/admin', adminRoute);
app.route('/api/sessions', sessionsRoute);
app.route('/api/forum', forumRoute);
app.route('/api/blog', blogRoute);

app.get('/api/health', (c) => c.json({ ok: true }));

// Serve the built web UI from ../web/dist when present
const webDist = resolve(process.cwd(), '../web/dist');
const indexHtmlPath = resolve(webDist, 'index.html');

// Cache the SPA shell once at boot so the OG-injection middleware
// doesn't hit disk per request. The build outputs a fresh index.html
// each deploy and the service is restarted, so a long-lived cache is
// safe.
let indexHtmlCache: string | null = null;
function getIndexHtml(): string | null {
  if (indexHtmlCache !== null) return indexHtmlCache;
  if (!existsSync(indexHtmlPath)) return null;
  indexHtmlCache = readFileSync(indexHtmlPath, 'utf8');
  return indexHtmlCache;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function trimForOg(s: string, max = 200): string {
  // Strip markdown noise (asterisks, hashes, pipes, code fences) so
  // social previews don't show "**bold**" or "| col |" raw. Just a
  // best-effort cleanup; full markdown parsing isn't worth it here.
  const cleaned = s
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_`#>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

// Render the SPA shell with per-post OG tags so Facebook / X / Threads
// link previews show the actual post title + body excerpt instead of a
// generic site-wide banner. Falls back to the unmodified shell when the
// post id is unknown or the DB lookup fails for any reason.
if (existsSync(webDist)) {
  app.get('/forum/post/:id', (c) => {
    const html = getIndexHtml();
    if (!html) return c.text('Not found', 404);
    const idStr = c.req.param('id');
    const id = parseInt(idStr ?? '', 10);
    if (!Number.isFinite(id) || id <= 0) {
      return c.html(html);
    }
    let post:
      | {
          title: string;
          body: string;
          nsfw: number;
          share_summary: string | null;
        }
      | null = null;
    try {
      post = forumStmts.findPostById.get(id) as
        | {
            title: string;
            body: string;
            nsfw: number;
            share_summary: string | null;
          }
        | undefined
        ?? null;
    } catch {
      post = null;
    }
    if (!post) return c.html(html);
    // Don't leak NSFW post titles / bodies via og:title / og:description
    // to social-media crawlers (they never carry our session cookie).
    // Serve the SPA shell with the site-wide defaults instead.
    if (post.nsfw) return c.html(html);

    const publicUrl = process.env.PUBLIC_URL ?? '';
    const baseUrl = publicUrl ? publicUrl.replace(/\/+$/, '') : '';
    const url = `${baseUrl}/forum/post/${id}`;
    const title = `${post.title} | AI Sister`;
    // Curated share summary wins over the body excerpt — author / admin
    // can write a clean 2-sentence hook so social cards don't mid-
    // sentence-cut into the body. Falls back to the auto-trimmed body
    // when share_summary is NULL.
    const description = post.share_summary
      ? trimForOg(post.share_summary)
      : trimForOg(post.body);

    // Look up a share thumbnail for the post — admin-flagged thumbnail
    // wins, else the first media row by position. Bare-host fallback
    // means the FB / X preview shows the site default rather than no
    // image (easier visual consistency than an empty thumbnail).
    let imageMeta = '';
    try {
      const thumb = forumStmts.thumbnailForPost.get(id) as
        | { id: number }
        | undefined;
      if (thumb && baseUrl) {
        const imgUrl = `${baseUrl}/api/forum/media/${thumb.id}`;
        imageMeta = `
    <meta property="og:image" content="${escapeHtml(imgUrl)}" />
    <meta name="twitter:image" content="${escapeHtml(imgUrl)}" />`;
      }
    } catch {
      // ignore — image is optional, preview still works without one
    }

    const ogBlock = `
    <meta property="og:url" content="${escapeHtml(url)}" />
    <meta property="og:type" content="article" />
    <meta property="og:title" content="${escapeHtml(title)}" />
    <meta property="og:description" content="${escapeHtml(description)}" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${escapeHtml(title)}" />
    <meta name="twitter:description" content="${escapeHtml(description)}" />${imageMeta}`;

    // Strip the site-wide og:title / og:description / og:type and the
    // matching twitter:* tags, then splice the per-post block in just
    // before </head>. This keeps og:site_name + favicons untouched.
    const stripped = html
      .replace(
        /\s*<meta\s+property="og:type"[^>]*\/?>/gi,
        '',
      )
      .replace(/\s*<meta\s+property="og:title"[^>]*\/?>/gi, '')
      .replace(/\s*<meta\s+property="og:description"[^>]*\/?>/gi, '')
      .replace(/\s*<meta\s+name="twitter:card"[^>]*\/?>/gi, '')
      .replace(/\s*<meta\s+name="twitter:title"[^>]*\/?>/gi, '')
      .replace(/\s*<meta\s+name="twitter:description"[^>]*\/?>/gi, '');
    const out = stripped.replace('</head>', `${ogBlock}\n  </head>`);
    return c.html(out);
  });

  // Same OG-injection treatment for /blog/:id detail pages so social
  // shares preview the actual blog title + body excerpt + thumbnail.
  app.get('/blog/:id', (c) => {
    const html = getIndexHtml();
    if (!html) return c.text('Not found', 404);
    const id = parseInt(c.req.param('id') ?? '', 10);
    if (!Number.isFinite(id) || id <= 0) return c.html(html);
    let post: BlogPostRow | null = null;
    try {
      post = (blogStmts.findById.get(id) as BlogPostRow | undefined) ?? null;
    } catch {
      post = null;
    }
    if (!post) return c.html(html);

    const publicUrl = process.env.PUBLIC_URL ?? '';
    const baseUrl = publicUrl ? publicUrl.replace(/\/+$/, '') : '';
    const url = `${baseUrl}/blog/${id}`;
    const title = `${post.title} | AI Sister Blog`;
    const description = trimForOg(post.body);
    let imageMeta = '';
    if (post.thumbnail_media_id && baseUrl) {
      const imgUrl = `${baseUrl}/api/forum/media/${post.thumbnail_media_id}`;
      imageMeta = `
    <meta property="og:image" content="${escapeHtml(imgUrl)}" />
    <meta name="twitter:image" content="${escapeHtml(imgUrl)}" />`;
    }
    const ogBlock = `
    <meta property="og:url" content="${escapeHtml(url)}" />
    <meta property="og:type" content="article" />
    <meta property="og:title" content="${escapeHtml(title)}" />
    <meta property="og:description" content="${escapeHtml(description)}" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${escapeHtml(title)}" />
    <meta name="twitter:description" content="${escapeHtml(description)}" />${imageMeta}`;
    const stripped = html
      .replace(/\s*<meta\s+property="og:type"[^>]*\/?>/gi, '')
      .replace(/\s*<meta\s+property="og:title"[^>]*\/?>/gi, '')
      .replace(/\s*<meta\s+property="og:description"[^>]*\/?>/gi, '')
      .replace(/\s*<meta\s+name="twitter:card"[^>]*\/?>/gi, '')
      .replace(/\s*<meta\s+name="twitter:title"[^>]*\/?>/gi, '')
      .replace(/\s*<meta\s+name="twitter:description"[^>]*\/?>/gi, '');
    return c.html(stripped.replace('</head>', `${ogBlock}\n  </head>`));
  });

  app.use(
    '/*',
    serveStatic({
      root: webDist,
      rewriteRequestPath: (path) => path,
    }),
  );
  // SPA fallback — any unknown path returns index.html
  app.get('*', serveStatic({ root: webDist, path: 'index.html' }));
}

const port = parseInt(process.env.PORT || '3000', 10);
const host = process.env.HOST || '127.0.0.1';

console.log(`Multi-AI Chatapp server listening on http://${host}:${port}`);
serve({ fetch: app.fetch, port, hostname: host });

// Hourly fallback digest scheduler — kicks in only when admin email rows
// exist and there are events in the last hour. First tick is +1h so a
// restart doesn't generate a duplicate digest.
startFallbackDigest();

// Auto-debate cron — every 6h fires one bot-driven 4-AI roundtable in
// a random category, populating the forum without manual intervention.
// Prod-only (no-op when PROVIDER_MODE=cli, i.e. dev). First tick after
// a 5-min boot delay so a restart doesn't fire mid-deploy.
startAutoDebateScheduler();

// Blog cron — every 6h, one of the 4 AI personas (rotating) picks
// an uncovered forum post and writes a blog about it. ~4 blogs/day.
// Prod-only, 8-min boot delay (offset from auto-debate so they don't
// share a tick).
startBlogScheduler();
