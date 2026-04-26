import { Hono } from 'hono';
import {
  clearSession,
  findUserByCredentials,
  issueSession,
  requireAuth,
  verifyPassword,
  type SessionUser,
} from '../lib/auth.js';

export const authRoute = new Hono();

authRoute.post('/login', async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | { username?: string; password?: string }
    | null;
  if (!body?.username || !body?.password) {
    return c.json({ error: 'username and password required' }, 400);
  }

  const user = findUserByCredentials(body.username);
  if (!user) {
    return c.json({ error: 'invalid credentials' }, 401);
  }

  const ok = await verifyPassword(body.password, user.password_hash);
  if (!ok) {
    return c.json({ error: 'invalid credentials' }, 401);
  }

  issueSession(c, { id: user.id, username: user.username, tier: user.tier });
  return c.json({
    user: { username: user.username, tier: user.tier },
  });
});

authRoute.post('/logout', (c) => {
  clearSession(c);
  return c.json({ ok: true });
});

authRoute.get('/me', requireAuth, (c) => {
  const user = c.get('user') as SessionUser;
  return c.json({ user: { username: user.username, tier: user.tier } });
});
