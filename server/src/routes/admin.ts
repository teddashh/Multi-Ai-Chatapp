import { Hono } from 'hono';
import {
  hashPassword,
  requireSuper,
  type AppVariables,
} from '../lib/auth.js';
import { userStmts } from '../lib/db.js';
import type { Tier } from '../shared/types.js';

export const adminRoute = new Hono<{ Variables: AppVariables }>();

const VALID_TIERS: Tier[] = ['test', 'standard', 'super'];

adminRoute.use('*', requireSuper);

adminRoute.get('/users', (c) => {
  const rows = userStmts.list.all() as Array<{
    id: number;
    username: string;
    tier: Tier;
    created_at: number;
  }>;
  return c.json({ users: rows });
});

adminRoute.post('/users', async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | { username?: string; password?: string; tier?: Tier }
    | null;
  if (!body?.username || !body?.password || !body?.tier) {
    return c.json({ error: 'username, password, tier required' }, 400);
  }
  if (!VALID_TIERS.includes(body.tier)) {
    return c.json({ error: 'invalid tier' }, 400);
  }
  if (userStmts.findByUsername.get(body.username)) {
    return c.json({ error: 'user already exists' }, 409);
  }
  const hash = await hashPassword(body.password);
  userStmts.insert.run(body.username, hash, body.tier);
  return c.json({ ok: true });
});

adminRoute.patch('/users/:username', async (c) => {
  const username = c.req.param('username');
  const body = (await c.req.json().catch(() => null)) as
    | { password?: string; tier?: Tier }
    | null;
  if (!body) return c.json({ error: 'body required' }, 400);

  const existing = userStmts.findByUsername.get(username);
  if (!existing) return c.json({ error: 'user not found' }, 404);

  if (body.password) {
    const hash = await hashPassword(body.password);
    userStmts.updatePassword.run(hash, username);
  }
  if (body.tier) {
    if (!VALID_TIERS.includes(body.tier)) {
      return c.json({ error: 'invalid tier' }, 400);
    }
    userStmts.updateTier.run(body.tier, username);
  }
  return c.json({ ok: true });
});

adminRoute.delete('/users/:username', (c) => {
  const username = c.req.param('username');
  const me = c.get('user');
  if (me.username === username) {
    return c.json({ error: 'cannot delete yourself' }, 400);
  }
  const result = userStmts.delete.run(username);
  if (result.changes === 0) return c.json({ error: 'user not found' }, 404);
  return c.json({ ok: true });
});
