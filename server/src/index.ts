import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { serveStatic } from '@hono/node-server/serve-static';
import { authRoute } from './routes/auth.js';
import { chatRoute } from './routes/chat.js';
import { adminRoute } from './routes/admin.js';
import { sessionsRoute } from './routes/sessions.js';
import { startFallbackDigest } from './lib/fallbackDigest.js';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

const app = new Hono();
app.use('*', logger());

app.route('/api/auth', authRoute);
app.route('/api/chat', chatRoute);
app.route('/api/admin', adminRoute);
app.route('/api/sessions', sessionsRoute);

app.get('/api/health', (c) => c.json({ ok: true }));

// Serve the built web UI from ../web/dist when present
const webDist = resolve(process.cwd(), '../web/dist');
if (existsSync(webDist)) {
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
