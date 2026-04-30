import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import type { Context, Next } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { userStmts, type UserRow } from './db.js';
import type { Tier } from '../shared/types.js';

export type AppVariables = { user: SessionUser };
export type AppContext = Context<{ Variables: AppVariables }>;

const JWT_SECRET = process.env.JWT_SECRET || '';
if (!JWT_SECRET || JWT_SECRET.length < 16) {
  throw new Error('JWT_SECRET env var must be set to a long random string');
}

const COOKIE_NAME = 'session';
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

export interface SessionUser {
  id: number;
  username: string;
  tier: Tier;
  nickname: string | null;
  email: string | null;
  lang: 'zh-TW' | 'en';
  avatarPath: string | null;
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 12);
}

export async function verifyPassword(
  plain: string,
  hash: string,
): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export function findUserByCredentials(
  username: string,
): UserRow | undefined {
  return userStmts.findByUsername.get(username) as UserRow | undefined;
}

export function issueSession(c: AppContext, user: SessionUser): void {
  const token = jwt.sign(
    { sub: user.id, username: user.username, tier: user.tier },
    JWT_SECRET,
    { expiresIn: SESSION_TTL_SECONDS },
  );
  setCookie(c, COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: process.env.NODE_ENV !== 'development',
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  });
}

export function clearSession(c: AppContext): void {
  deleteCookie(c, COOKIE_NAME, { path: '/' });
}

export async function requireAuth(c: AppContext, next: Next): Promise<Response | void> {
  const token = getCookie(c, COOKIE_NAME);
  if (!token) return c.json({ error: 'unauthorized' }, 401);
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as unknown as {
      sub: number;
      username: string;
      tier: Tier;
    };
    const user = userStmts.findById.get(decoded.sub) as UserRow | undefined;
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    c.set('user', {
      id: user.id,
      username: user.username,
      tier: user.tier,
      nickname: user.nickname,
      email: user.email,
      lang: user.lang,
      avatarPath: user.avatar_path,
    });
    await next();
  } catch {
    return c.json({ error: 'unauthorized' }, 401);
  }
}

// Same JWT path as requireAuth but never 401s — anonymous callers fall
// through with no `user` set on the context. Forum routes use this so
// public read endpoints can populate a per-user `liked` flag when the
// caller is logged in, without locking out anonymous readers.
export async function optionalAuth(c: AppContext, next: Next): Promise<Response | void> {
  const token = getCookie(c, COOKIE_NAME);
  if (!token) return next();
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as unknown as {
      sub: number;
      username: string;
      tier: Tier;
    };
    const user = userStmts.findById.get(decoded.sub) as UserRow | undefined;
    if (user) {
      c.set('user', {
        id: user.id,
        username: user.username,
        tier: user.tier,
        nickname: user.nickname,
        email: user.email,
        lang: user.lang,
        avatarPath: user.avatar_path,
      });
    }
  } catch {
    // bad/expired token — treat as anonymous, no error
  }
  return next();
}

// Admin tier is the gate for /admin endpoints. Super tier just unlocks
// top-end models; it is NOT enough to manage other users.
export async function requireAdmin(c: AppContext, next: Next): Promise<Response | void> {
  return requireAuth(c, async () => {
    const user = c.get('user');
    if (user.tier !== 'admin') {
      throw new ForbiddenError();
    }
    await next();
  }).catch((err) => {
    if (err instanceof ForbiddenError) return c.json({ error: 'forbidden' }, 403);
    throw err;
  });
}

class ForbiddenError extends Error {}
