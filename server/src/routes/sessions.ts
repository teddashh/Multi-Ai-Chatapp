import { Hono } from 'hono';
import { requireAuth, type AppVariables } from '../lib/auth.js';
import {
  messageStmts,
  sessionStmts,
  type MessageRow,
  type SessionRow,
} from '../lib/db.js';

export const sessionsRoute = new Hono<{ Variables: AppVariables }>();

sessionsRoute.use('*', requireAuth);

sessionsRoute.get('/', (c) => {
  const user = c.get('user');
  const rows = sessionStmts.listForUser.all(user.id) as Array<{
    id: string;
    title: string;
    mode: string;
    created_at: number;
    updated_at: number;
    msg_count: number;
  }>;
  return c.json({ sessions: rows });
});

sessionsRoute.get('/:id', (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const session = sessionStmts.findOwned.get(id, user.id) as SessionRow | undefined;
  if (!session) return c.json({ error: 'not found' }, 404);
  const messages = messageStmts.listForSession.all(id) as MessageRow[];
  return c.json({
    session,
    messages: messages.map((m) => ({
      id: `${m.id}`,
      role: m.role,
      provider: m.provider ?? undefined,
      modeRole: m.mode_role ?? undefined,
      content: m.content,
      timestamp: m.timestamp * 1000,
    })),
  });
});

sessionsRoute.patch('/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => null)) as { title?: string } | null;
  if (!body?.title) return c.json({ error: 'title required' }, 400);
  const result = sessionStmts.rename.run(body.title.slice(0, 200), id, user.id);
  if (result.changes === 0) return c.json({ error: 'not found' }, 404);
  return c.json({ ok: true });
});

sessionsRoute.delete('/:id', (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const result = sessionStmts.delete.run(id, user.id);
  if (result.changes === 0) return c.json({ error: 'not found' }, 404);
  return c.json({ ok: true });
});
