import { Hono } from 'hono';
import { randomBytes } from 'node:crypto';
import {
  clearSession,
  findUserByCredentials,
  hashPassword,
  issueSession,
  requireAuth,
  verifyPassword,
  type AppVariables,
} from '../lib/auth.js';
import { resetStmts, userStmts, type UserRow } from '../lib/db.js';
import { TIER_MODELS } from '../shared/models.js';
import { sendResetEmail } from '../lib/mail.js';
import {
  isSupportedAvatarMime,
  MAX_AVATAR_BYTES,
  readAvatar,
  saveAvatar,
} from '../lib/uploads.js';

export const authRoute = new Hono<{ Variables: AppVariables }>();

const FAILED_ATTEMPT_LIMIT = 3;
const RESET_TOKEN_TTL_SECONDS = 60 * 60; // 1 hour

function buildUserDTO(user: UserRow) {
  return {
    username: user.username,
    nickname: user.nickname,
    email: user.email,
    tier: user.tier,
    lang: user.lang,
    hasAvatar: !!user.avatar_path,
    models: TIER_MODELS[user.tier],
  };
}

async function issueResetTokenAndEmail(
  user: UserRow,
  reason: 'self_request' | 'auto_lockout',
): Promise<void> {
  if (!user.email) {
    // No email on record — can't send. We log but don't throw, to avoid
    // confirming/denying account existence to the caller of /forgot-password.
    console.warn(`Reset requested for user ${user.username} but no email on file`);
    return;
  }
  // Invalidate any existing tokens for this user, then issue a new one.
  resetStmts.deleteForUser.run(user.id);
  const token = randomBytes(32).toString('hex');
  const expiresAt = Math.floor(Date.now() / 1000) + RESET_TOKEN_TTL_SECONDS;
  resetStmts.insert.run(token, user.id, expiresAt);

  const publicUrl = process.env.PUBLIC_URL || 'https://chat.ted-h.com';
  const resetUrl = `${publicUrl}/?reset=${token}`;
  await sendResetEmail({
    to: user.email,
    nickname: user.nickname || user.username,
    resetUrl,
    reason,
  });
}

authRoute.post('/login', async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | { username?: string; password?: string }
    | null;
  if (!body?.username || !body?.password) {
    return c.json({ error: 'username and password required' }, 400);
  }

  // Allow login by username OR email (so you can use either)
  const user = userStmts.findByEmailOrUsername.get(body.username, body.username) as
    | UserRow
    | undefined;
  if (!user) {
    return c.json({ error: 'invalid credentials' }, 401);
  }

  const now = Math.floor(Date.now() / 1000);
  if (user.locked_until && user.locked_until > now) {
    return c.json(
      {
        error: 'locked',
        message: '帳號已鎖定，請查看 email 重設密碼',
      },
      423,
    );
  }

  const ok = await verifyPassword(body.password, user.password_hash);
  if (!ok) {
    userStmts.bumpFailedAttempts.run(user.id);
    const fresh = userStmts.findById.get(user.id) as UserRow;
    if (fresh.failed_attempts >= FAILED_ATTEMPT_LIMIT) {
      // Lock until next century — only a successful reset clears it.
      userStmts.lockUser.run(now + 365 * 24 * 3600 * 100, user.id);
      try {
        await issueResetTokenAndEmail(fresh, 'auto_lockout');
      } catch (err) {
        console.error('failed to send lockout email', (err as Error).message);
      }
      return c.json(
        {
          error: 'locked',
          message: '連續 3 次密碼錯誤，已寄送密碼重設信到你的 email',
        },
        423,
      );
    }
    return c.json(
      {
        error: 'invalid credentials',
        attemptsRemaining: FAILED_ATTEMPT_LIMIT - fresh.failed_attempts,
      },
      401,
    );
  }

  // Successful login — reset counters.
  userStmts.resetFailedAttempts.run(user.id);

  issueSession(c, {
    id: user.id,
    username: user.username,
    tier: user.tier,
    nickname: user.nickname,
    email: user.email,
    lang: user.lang,
    avatarPath: user.avatar_path,
  });
  return c.json({ user: buildUserDTO(user) });
});

authRoute.post('/logout', (c) => {
  clearSession(c);
  return c.json({ ok: true });
});

authRoute.get('/me', requireAuth, (c) => {
  const session = c.get('user');
  const user = userStmts.findById.get(session.id) as UserRow | undefined;
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  return c.json({ user: buildUserDTO(user) });
});

// Always returns 200 so we don't leak whether the username/email exists.
authRoute.post('/forgot-password', async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | { identifier?: string }
    | null;
  if (!body?.identifier) {
    return c.json({ error: 'identifier required' }, 400);
  }
  const user = userStmts.findByEmailOrUsername.get(body.identifier, body.identifier) as
    | UserRow
    | undefined;
  if (user) {
    try {
      await issueResetTokenAndEmail(user, 'self_request');
    } catch (err) {
      console.error('forgot-password email failed', (err as Error).message);
    }
  }
  return c.json({ ok: true });
});

// === Profile (self) ===
// PATCH lang / nickname / email / password — any subset.
authRoute.patch('/profile', requireAuth, async (c) => {
  const session = c.get('user');
  const body = (await c.req.json().catch(() => null)) as
    | {
        lang?: 'zh-TW' | 'en';
        nickname?: string | null;
        email?: string | null;
        password?: string | null;
      }
    | null;
  if (!body) return c.json({ error: 'invalid body' }, 400);
  const user = userStmts.findById.get(session.id) as UserRow | undefined;
  if (!user) return c.json({ error: 'unauthorized' }, 401);

  if (body.lang === 'zh-TW' || body.lang === 'en') {
    userStmts.updateLang.run(body.lang, user.id);
  }
  if (body.nickname !== undefined || body.email !== undefined) {
    const nick =
      body.nickname === undefined ? user.nickname : (body.nickname || null);
    const email =
      body.email === undefined ? user.email : (body.email || null);
    userStmts.updateNicknameEmail.run(nick, email, user.id);
  }
  if (body.password) {
    if (body.password.length < 6) {
      return c.json({ error: 'password too short (min 6 chars)' }, 400);
    }
    const hash = await hashPassword(body.password);
    userStmts.setOwnPassword.run(hash, user.id);
  }

  const fresh = userStmts.findById.get(user.id) as UserRow;
  return c.json({ user: buildUserDTO(fresh) });
});

authRoute.post('/avatar', requireAuth, async (c) => {
  const session = c.get('user');
  const body = await c.req.parseBody().catch(() => null);
  if (!body) return c.json({ error: 'multipart body required' }, 400);
  const file = body['file'];
  if (!(file instanceof File)) {
    return c.json({ error: 'file required' }, 400);
  }
  if (file.size > MAX_AVATAR_BYTES) {
    return c.json(
      { error: `檔案過大（最大 ${Math.round(MAX_AVATAR_BYTES / 1024 / 1024)}MB）` },
      413,
    );
  }
  if (!isSupportedAvatarMime(file.type)) {
    return c.json({ error: 'unsupported image type' }, 400);
  }
  const buffer = Buffer.from(await file.arrayBuffer());
  const path = saveAvatar(session.id, file.type, buffer);
  userStmts.updateAvatar.run(path, session.id);
  const fresh = userStmts.findById.get(session.id) as UserRow;
  return c.json({ user: buildUserDTO(fresh) });
});

authRoute.delete('/avatar', requireAuth, (c) => {
  const session = c.get('user');
  userStmts.updateAvatar.run(null, session.id);
  const fresh = userStmts.findById.get(session.id) as UserRow;
  return c.json({ user: buildUserDTO(fresh) });
});

// Anyone logged in can fetch any user's avatar (used to show family avatars
// in the UI eventually). Avatars are not secret.
authRoute.get('/avatar/:username', requireAuth, (c) => {
  const username = c.req.param('username') ?? '';
  if (!username) return c.json({ error: 'username required' }, 400);
  const target = userStmts.findByUsername.get(username) as UserRow | undefined;
  if (!target || !target.avatar_path) {
    return c.json({ error: 'not found' }, 404);
  }
  const buf = readAvatar(target.avatar_path);
  if (!buf) return c.json({ error: 'not found' }, 404);
  // Sniff the extension to set Content-Type.
  const ext = target.avatar_path.split('.').pop() || 'png';
  const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`;
  return new Response(buf, {
    headers: {
      'Content-Type': mime,
      'Cache-Control': 'private, max-age=60',
    },
  });
});

authRoute.post('/reset-password', async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | { token?: string; password?: string }
    | null;
  if (!body?.token || !body?.password) {
    return c.json({ error: 'token and password required' }, 400);
  }
  if (body.password.length < 6) {
    return c.json({ error: 'password too short (min 6 chars)' }, 400);
  }

  const now = Math.floor(Date.now() / 1000);
  const row = resetStmts.findValid.get(body.token, now) as
    | { user_id: number }
    | undefined;
  if (!row) {
    return c.json({ error: 'invalid or expired token' }, 400);
  }
  const hash = await hashPassword(body.password);
  userStmts.setPasswordHash.run(hash, row.user_id);
  resetStmts.markUsed.run(body.token);
  return c.json({ ok: true });
});
