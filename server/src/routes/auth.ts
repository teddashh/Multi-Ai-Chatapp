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
import { resetStmts, usageStmts, userStmts, type UserRow } from '../lib/db.js';
import { TIER_MODELS } from '../shared/models.js';
import { estimateCost } from '../shared/prices.js';
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

const VALID_THEMES = new Set([
  'winter',
  'summer',
  'claude',
  'gemini',
  'grok',
  'chatgpt',
]);

function buildUserDTO(user: UserRow) {
  return {
    username: user.username,
    nickname: user.nickname,
    email: user.email,
    tier: user.tier,
    lang: user.lang,
    hasAvatar: !!user.avatar_path,
    theme: user.theme,
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

// Public sign-up — anyone can create a free-tier account and start using
// the cheapest models with a daily quota. Admin can later upgrade them.
authRoute.post('/signup', async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | {
        email?: string;
        password?: string;
        nickname?: string;
      }
    | null;
  if (!body?.email || !body?.password) {
    return c.json({ error: 'email and password required' }, 400);
  }
  if (body.password.length < 6) {
    return c.json({ error: 'password too short (min 6 chars)' }, 400);
  }
  const email = body.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return c.json({ error: 'invalid email' }, 400);
  }
  // Username is just the email — login already accepts either.
  // Check for collision against both username AND email columns.
  const existing = userStmts.findByEmailOrUsername.get(email, email) as
    | UserRow
    | undefined;
  if (existing) {
    return c.json({ error: 'account already exists for this email' }, 409);
  }
  const hash = await hashPassword(body.password);
  userStmts.insert.run(email, hash, 'free');
  userStmts.updateProfile.run(body.nickname?.trim() || null, email, email);

  const fresh = userStmts.findByUsername.get(email) as UserRow;
  // Auto-login: drop a session cookie so the client lands signed in.
  issueSession(c, {
    id: fresh.id,
    username: fresh.username,
    tier: fresh.tier,
    nickname: fresh.nickname,
    email: fresh.email,
    lang: fresh.lang,
    avatarPath: fresh.avatar_path,
  });
  return c.json({
    user: {
      username: fresh.username,
      nickname: fresh.nickname,
      email: fresh.email,
      tier: fresh.tier,
      lang: fresh.lang,
      hasAvatar: !!fresh.avatar_path,
      theme: fresh.theme,
      models: TIER_MODELS[fresh.tier],
    },
  });
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
// User-side edit: only nickname, password, lang, theme, avatar are mutable.
// Identity fields (username, email, real_name) are admin-only.
authRoute.patch('/profile', requireAuth, async (c) => {
  const session = c.get('user');
  const body = (await c.req.json().catch(() => null)) as
    | {
        lang?: 'zh-TW' | 'en';
        nickname?: string | null;
        password?: string | null;
        theme?: string;
      }
    | null;
  if (!body) return c.json({ error: 'invalid body' }, 400);
  const user = userStmts.findById.get(session.id) as UserRow | undefined;
  if (!user) return c.json({ error: 'unauthorized' }, 401);

  if (body.lang === 'zh-TW' || body.lang === 'en') {
    userStmts.updateLang.run(body.lang, user.id);
  }
  if (body.theme && VALID_THEMES.has(body.theme)) {
    userStmts.updateTheme.run(body.theme, user.id);
  }
  if (body.nickname !== undefined) {
    userStmts.updateNicknameEmail.run(
      body.nickname || null,
      user.email,
      user.id,
    );
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

// Self-view of usage stats. Mirrors the admin /usage shape but scoped
// to the caller's own data so users can see what they've consumed.
authRoute.get('/usage', requireAuth, (c) => {
  const session = c.get('user');
  const totals = usageStmts.totalsForUser.get(session.id) as {
    calls: number;
    tokens_in: number;
    tokens_out: number;
    prompt_chars: number;
    completion_chars: number;
  };
  const breakdown = usageStmts.byModelForUser.all(session.id) as Array<{
    provider: string;
    model: string;
    calls: number;
    tokens_in: number;
    tokens_out: number;
    prompt_chars: number;
    completion_chars: number;
    any_estimated: number;
  }>;
  const rows = breakdown.map((b) => ({
    provider: b.provider,
    model: b.model,
    calls: b.calls,
    tokens_in: b.tokens_in,
    tokens_out: b.tokens_out,
    prompt_chars: b.prompt_chars,
    completion_chars: b.completion_chars,
    is_estimated: !!b.any_estimated,
    cost_usd: estimateCost(b.provider, b.model, b.tokens_in, b.tokens_out),
  }));
  const totalCost = rows.reduce((sum, r) => sum + r.cost_usd, 0);
  return c.json({
    totals: { ...totals, cost_usd: totalCost },
    by_model: rows,
  });
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
