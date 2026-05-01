import { Hono } from 'hono';
import { randomBytes } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import {
  clearSession,
  findUserByCredentials,
  hashPassword,
  issueSession,
  requireAuth,
  verifyPassword,
  type AppVariables,
} from '../lib/auth.js';
import { db, resetStmts, usageStmts, userStmts, type UserRow } from '../lib/db.js';
import { logAudit } from '../lib/audit.js';
import { IMAGE_MODELS, TIER_MODELS } from '../shared/models.js';
import { formatPriceLabel } from '../shared/prices.js';
import { SIGN_KEY_SET, sunSignFromEpoch } from '../shared/astrology.js';
import type { Tier } from '../shared/types.js';
import { estimateCost } from '../shared/prices.js';
import { sendResetEmail, sendVerifyEmail } from '../lib/mail.js';
import {
  isSupportedAvatarMime,
  MAX_AVATAR_BYTES,
  readAvatar,
  saveAvatar,
} from '../lib/uploads.js';
import { checkAndRecord, clientIp } from '../lib/rateLimit.js';

export const authRoute = new Hono<{ Variables: AppVariables }>();

const FAILED_ATTEMPT_LIMIT = 3;
const RESET_TOKEN_TTL_SECONDS = 60 * 60; // 1 hour
const VERIFY_TOKEN_TTL_SECONDS = 24 * 60 * 60; // 24 hours

// Public signup is open to anyone, so it gets rate-limited per IP. Two
// nested limits: a tight short-window cap to swat scripts, plus a wider
// daily cap so a bad actor can't grind the limit forever.
const SIGNUP_RATE_LIMITS = [
  { windowMs: 60 * 60 * 1000, max: 3 }, // 3 / hour
  { windowMs: 24 * 60 * 60 * 1000, max: 5 }, // 5 / day
];

// Resend verification is even cheaper to spam (each one fires an email),
// so be stricter.
const RESEND_RATE_LIMITS = [
  { windowMs: 5 * 60 * 1000, max: 1 }, // 1 / 5 min per user
];

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
    emailVerified: !!user.email_verified,
    models: TIER_MODELS[user.tier],
    // Per-model compact price label ("$5/$30 /M" or "$0.07/img").
    // Used by chat + image dropdowns so the user can compare cost
    // before picking. Empty string when we don't have a quote.
    priceLabels: priceLabelsForTier(user.tier),
    bio: user.bio ?? '',
    // Birth + astrology + MBTI. Always included on /me (the user
    // viewing themselves sees their own data). Public exposure is
    // gated separately on the /forum/user/:username endpoint based
    // on the show_* flags below.
    birthAt: user.birth_at ?? null,
    birthTz: user.birth_tz ?? null,
    sunSign: user.sun_sign ?? null,
    moonSign: user.moon_sign ?? null,
    risingSign: user.rising_sign ?? null,
    mbti: user.mbti ?? null,
    showBirthday: !!user.show_birthday,
    showBirthTime: !!user.show_birth_time,
    showMbti: !!user.show_mbti,
    showSigns: !!user.show_signs,
    showBirthYear: !!user.show_birth_year,
    personaSeed: user.persona_seed ?? null,
  };
}

// Build the model-name → price-label map shown in dropdowns. Covers
// every chat model the tier exposes plus every image model in the
// global catalog (image mode is not tier-gated today).
function priceLabelsForTier(tier: Tier): Record<string, string> {
  const out: Record<string, string> = {};
  const tm = TIER_MODELS[tier];
  for (const provider of ['chatgpt', 'claude', 'gemini', 'grok'] as const) {
    for (const m of tm[provider].options) {
      out[m] = formatPriceLabel(provider, m);
    }
    for (const m of IMAGE_MODELS[provider]) {
      out[m] = formatPriceLabel(provider, m);
    }
  }
  return out;
}

async function issueVerifyTokenAndEmail(user: UserRow): Promise<void> {
  if (!user.email) return;
  const token = randomBytes(32).toString('hex');
  const expiresAt = Math.floor(Date.now() / 1000) + VERIFY_TOKEN_TTL_SECONDS;
  userStmts.setVerifyToken.run(token, expiresAt, user.id);
  const publicUrl = process.env.PUBLIC_URL || 'https://chat.ted-h.com';
  const verifyUrl = `${publicUrl}/?verify=${token}`;
  await sendVerifyEmail({
    to: user.email,
    nickname: user.nickname || user.username,
    verifyUrl,
  });
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
  // Soft-disabled (停用) accounts can't log in at all — they need to
  // contact support (or use a future 「重新啟用」 flow) to come back.
  // Verify password BEFORE returning the disabled error so we don't
  // leak whether a username exists on a disabled account vs a wrong
  // password.
  if (user.disabled_at) {
    const okIfDisabled = await verifyPassword(body.password, user.password_hash);
    if (!okIfDisabled) {
      return c.json({ error: 'invalid credentials' }, 401);
    }
    return c.json(
      {
        error: 'account_disabled',
        message: '帳號已停用，如需重新啟用請聯絡 hello@ai-sister.com',
      },
      403,
    );
  }

  const ok = await verifyPassword(body.password, user.password_hash);
  if (!ok) {
    userStmts.bumpFailedAttempts.run(user.id);
    logAudit({
      actorUserId: user.id,
      action: 'user_login_fail',
      metadata: { username: user.username },
    });
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
  logAudit({
    actorUserId: user.id,
    action: 'user_login_success',
    metadata: { username: user.username },
  });
  return c.json({ user: buildUserDTO(user) });
});

authRoute.post('/logout', (c) => {
  clearSession(c);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// POST /api/auth/me/disable — soft-disable (停用) the caller's account.
// Distinct from the hard purge below: data is preserved, account simply
// can't be used again until reactivated by support. Requires password to
// guard against accidental clicks. After success the session cookie is
// cleared so future requests fail with 403 account_disabled.
// ---------------------------------------------------------------------------
authRoute.post('/me/disable', requireAuth, async (c) => {
  const user = c.get('user');
  const body = (await c.req.json().catch(() => null)) as
    | { password?: string }
    | null;
  if (!body?.password) return c.json({ error: 'password required' }, 400);
  const userRow = userStmts.findById.get(user.id) as UserRow | undefined;
  if (!userRow) return c.json({ error: 'user not found' }, 404);
  const ok = await verifyPassword(body.password, userRow.password_hash);
  if (!ok) return c.json({ error: 'invalid password' }, 401);

  const now = Math.floor(Date.now() / 1000);
  userStmts.setDisabledById.run(now, user.id);
  logAudit({
    actorUserId: user.id,
    action: 'user_self_disable',
    metadata: { username: user.username },
  });
  clearSession(c);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// DELETE /api/auth/me — hard-purge the caller's account and every row tied
// to it. Documented to users on /data-deletion. Requires re-typing username
// and password as a guardrail against accidental clicks.
//
// Cascade behaviour:
// - chat_sessions.user_id ON DELETE CASCADE → chat_messages cascade through
//   the session FK, chat_attachments cascade through the user FK
// - forum_posts.author_user_id ON DELETE CASCADE → forum_comments cascade
//   through post FK, forum_likes / forum_comment_replies cascade similarly
// - password_resets / usage_log: CASCADE
// - audit_log: SET NULL (deliberately preserved for moderation history)
//
// One thing the schema does NOT cascade-delete: forum_comments where the
// user was a *commenter* (author_user_id is SET NULL there). For a true
// purge we override that with an explicit DELETE inside the transaction.
// ---------------------------------------------------------------------------
authRoute.delete('/me', requireAuth, async (c) => {
  const user = c.get('user');
  const body = (await c.req.json().catch(() => null)) as
    | { password?: string; confirmUsername?: string }
    | null;
  if (!body?.password) return c.json({ error: 'password required' }, 400);
  if (body.confirmUsername !== user.username) {
    return c.json({ error: 'username confirmation does not match' }, 400);
  }

  const userRow = userStmts.findById.get(user.id) as UserRow | undefined;
  if (!userRow) return c.json({ error: 'user not found' }, 404);
  const ok = await verifyPassword(body.password, userRow.password_hash);
  if (!ok) return c.json({ error: 'invalid password' }, 401);

  // Snapshot file paths BEFORE the row deletes — once the rows are gone
  // we lose the ability to look up where the binary content lived.
  const attachments = db
    .prepare('SELECT path FROM chat_attachments WHERE user_id = ?')
    .all(user.id) as Array<{ path: string }>;
  const avatarPath = userRow.avatar_path;

  const purge = db.transaction(() => {
    // Override the SET NULL FK on forum_comments so the user's commentary
    // on OTHER people's posts (which would otherwise survive as orphan
    // anonymous rows) gets hard-deleted too.
    userStmts.deleteForumCommentsByAuthor.run(user.id);
    // Everything else (chat_sessions, chat_messages, chat_attachments,
    // forum_posts and their cascaded children, forum_likes,
    // forum_comment_replies, password_resets, usage_log, audit_log entries
    // referencing this user — admin_user_id and target_user_id both go to
    // NULL via SET NULL after the v6 migration) drops via the user FK
    // cascade.
    db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
  });
  purge();

  // Best-effort filesystem cleanup. Don't fail the request if a single
  // unlink errors — the DB rows are already gone so the data is logically
  // deleted from the user's perspective.
  for (const a of attachments) {
    try {
      unlinkSync(a.path);
    } catch {
      // file may already be missing; ignore
    }
  }
  if (avatarPath) {
    try {
      unlinkSync(avatarPath);
    } catch {
      // ignore
    }
  }

  clearSession(c);
  return c.json({ ok: true });
});

// AI personas use these usernames as their @-handle on the forum
// (/forum/user/grok, etc.). Block humans from grabbing them so the
// route stays unambiguous.
const RESERVED_USERNAMES = new Set([
  'grok',
  'gemini',
  'chatgpt',
  'claude',
  'admin',
  'system',
  'bot',
  'ai',
]);

// Public sign-up — anyone can create a free-tier account and start using
// the cheapest models with a daily quota. Admin can later upgrade them.
authRoute.post('/signup', async (c) => {
  // Rate-limit per source IP first — cheap signups are easy to spam.
  const ip = clientIp(c.req.raw);
  const gate = checkAndRecord(`signup:${ip}`, SIGNUP_RATE_LIMITS);
  if (!gate.ok) {
    return c.json(
      {
        error: 'too_many_requests',
        message: '註冊過於頻繁，請稍後再試。',
        messageEn: 'Too many signup attempts. Please try again later.',
        retryAfterMs: gate.retryAfterMs,
      },
      429,
    );
  }

  const body = (await c.req.json().catch(() => null)) as
    | {
        email?: string;
        password?: string;
        nickname?: string;
        username?: string;
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
  // Optional explicit username; falls back to the email if blank. Length
  // / charset bounded so URLs stay sane and SQL stays predictable.
  const requestedUsername = (body.username ?? '').trim().toLowerCase();
  let username = requestedUsername || email;
  if (requestedUsername) {
    if (!/^[a-z0-9_.-]{3,40}$/.test(requestedUsername)) {
      return c.json(
        { error: '帳號名只能用英數字加 . _ -，長度 3–40' },
        400,
      );
    }
    if (RESERVED_USERNAMES.has(requestedUsername)) {
      return c.json(
        { error: '這個帳號名是保留字，請挑別的' },
        400,
      );
    }
  }

  const existingByEmail = userStmts.findByEmailOrUsername.get(email, email) as
    | UserRow
    | undefined;
  if (existingByEmail) {
    return c.json({ error: 'account already exists for this email' }, 409);
  }
  if (
    requestedUsername &&
    userStmts.findByEmailOrUsername.get(username, username)
  ) {
    return c.json({ error: '這個帳號名已被使用' }, 409);
  }
  const hash = await hashPassword(body.password);
  userStmts.insert.run(username, hash, 'free');
  userStmts.updateProfile.run(body.nickname?.trim() || null, email, username);
  // Free signups must verify before chat will run for them. setVerifyToken
  // also flips email_verified to 0 atomically (see db.ts).
  const fresh0 = userStmts.findByUsername.get(username) as UserRow;
  try {
    await issueVerifyTokenAndEmail(fresh0);
  } catch (err) {
    console.error('verify email send failed', (err as Error).message);
  }
  const fresh = userStmts.findByUsername.get(username) as UserRow;

  // Auto-login: drop a session cookie so the client lands signed in (but
  // the chat surface will show a "verify email" banner).
  issueSession(c, {
    id: fresh.id,
    username: fresh.username,
    tier: fresh.tier,
    nickname: fresh.nickname,
    email: fresh.email,
    lang: fresh.lang,
    avatarPath: fresh.avatar_path,
  });
  logAudit({
    actorUserId: fresh.id,
    action: 'user_signup',
    metadata: { username: fresh.username, email: fresh.email },
  });
  return c.json({ user: buildUserDTO(fresh) });
});

// Click-through verification. Marks the user verified if the token matches
// and isn't expired. Returns the freshly-built DTO so the client can
// dismiss any "please verify" banner without a reload.
authRoute.post('/verify-email', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { token?: string } | null;
  if (!body?.token) return c.json({ error: 'token required' }, 400);
  const row = userStmts.findByVerifyToken.get(body.token) as UserRow | undefined;
  if (!row) return c.json({ error: 'invalid token' }, 400);
  const now = Math.floor(Date.now() / 1000);
  if (row.verify_expires_at && row.verify_expires_at < now) {
    return c.json({ error: 'token expired' }, 400);
  }
  userStmts.markEmailVerified.run(row.id);
  const fresh = userStmts.findByUsername.get(row.username) as UserRow;
  // Auto-login on verify so a user who clicks the link from email lands
  // straight into the app instead of being asked to log in again.
  issueSession(c, {
    id: fresh.id,
    username: fresh.username,
    tier: fresh.tier,
    nickname: fresh.nickname,
    email: fresh.email,
    lang: fresh.lang,
    avatarPath: fresh.avatar_path,
  });
  return c.json({ user: buildUserDTO(fresh) });
});

// Resend the verification email — only available to the logged-in,
// unverified user. Rate-limited per user so spam-clicking can't flood
// their inbox.
authRoute.post('/resend-verify', requireAuth, async (c) => {
  const session = c.get('user');
  const gate = checkAndRecord(`resend-verify:${session.id}`, RESEND_RATE_LIMITS);
  if (!gate.ok) {
    return c.json(
      {
        error: 'too_many_requests',
        message: '請稍候再重新寄送。',
        messageEn: 'Please wait before resending.',
        retryAfterMs: gate.retryAfterMs,
      },
      429,
    );
  }
  const user = userStmts.findById.get(session.id) as UserRow | undefined;
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  if (user.email_verified) {
    return c.json({ ok: true, alreadyVerified: true });
  }
  if (!user.email) {
    return c.json({ error: 'no email on file' }, 400);
  }
  await issueVerifyTokenAndEmail(user);
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
    logAudit({
      actorUserId: user.id,
      action: 'user_password_reset_request',
      metadata: { reason: 'self_request' },
    });
  }
  return c.json({ ok: true });
});

// === Profile (self) ===
// User-side edit: only nickname, password, lang, theme, avatar are mutable.
// Identity fields (username, email, real_name) are admin-only.
// Standard 16 MBTI types. Server-side allowlist so the column never
// holds garbage even if the client UI breaks.
const VALID_MBTI = new Set([
  'INTJ', 'INTP', 'ENTJ', 'ENTP',
  'INFJ', 'INFP', 'ENFJ', 'ENFP',
  'ISTJ', 'ISFJ', 'ESTJ', 'ESFJ',
  'ISTP', 'ISFP', 'ESTP', 'ESFP',
]);

authRoute.patch('/profile', requireAuth, async (c) => {
  const session = c.get('user');
  const body = (await c.req.json().catch(() => null)) as
    | {
        lang?: 'zh-TW' | 'en';
        nickname?: string | null;
        password?: string | null;
        theme?: string;
        bio?: string;
        // Birth + astrology + MBTI (all optional; null = clear).
        birthAt?: number | null;
        birthTz?: string | null;
        sunSign?: string | null;
        moonSign?: string | null;
        risingSign?: string | null;
        mbti?: string | null;
        // Per-field visibility flags.
        showBirthday?: boolean;
        showBirthTime?: boolean;
        showMbti?: boolean;
        showSigns?: boolean;
        showBirthYear?: boolean;
      }
    | null;
  if (!body) return c.json({ error: 'invalid body' }, 400);
  const user = userStmts.findById.get(session.id) as UserRow | undefined;
  if (!user) return c.json({ error: 'unauthorized' }, 401);

  const changed: string[] = [];
  if (body.lang === 'zh-TW' || body.lang === 'en') {
    userStmts.updateLang.run(body.lang, user.id);
    if (body.lang !== user.lang) changed.push('lang');
  }
  if (body.theme && VALID_THEMES.has(body.theme)) {
    userStmts.updateTheme.run(body.theme, user.id);
    if (body.theme !== user.theme) changed.push('theme');
  }
  if (body.nickname !== undefined) {
    userStmts.updateNicknameEmail.run(
      body.nickname || null,
      user.email,
      user.id,
    );
    if ((body.nickname || null) !== user.nickname) changed.push('nickname');
  }
  if (body.bio !== undefined) {
    // Cap to 500 chars server-side; the textarea limits at 500 too
    // but trust nothing the client sends.
    const trimmed = (body.bio ?? '').slice(0, 500).trim();
    userStmts.updateBio.run(trimmed || null, user.id);
    if ((trimmed || null) !== ((user.bio ?? null))) changed.push('bio');
  }
  // Birth / astrology batch — accepts any subset; missing fields
  // preserve their current values. Sun sign is auto-derived when the
  // user provides a birth date (overridable via explicit sunSign in
  // the body). Moon, rising, and MBTI are user-typed always.
  if (
    body.birthAt !== undefined ||
    body.birthTz !== undefined ||
    body.moonSign !== undefined ||
    body.risingSign !== undefined ||
    body.sunSign !== undefined ||
    body.mbti !== undefined
  ) {
    const birthAt =
      body.birthAt === null
        ? null
        : typeof body.birthAt === 'number'
          ? body.birthAt
          : (user.birth_at ?? null);
    const birthTz =
      body.birthTz === null
        ? null
        : typeof body.birthTz === 'string' && body.birthTz.length > 0
          ? body.birthTz
          : (user.birth_tz ?? null);
    let sunSign: string | null;
    if (body.sunSign !== undefined) {
      sunSign =
        body.sunSign === null
          ? null
          : SIGN_KEY_SET.has(body.sunSign)
            ? body.sunSign
            : (user.sun_sign ?? null);
    } else if (birthAt && birthTz) {
      sunSign = sunSignFromEpoch(birthAt, birthTz);
    } else {
      sunSign = user.sun_sign ?? null;
    }
    const moonSign =
      body.moonSign === undefined
        ? (user.moon_sign ?? null)
        : body.moonSign === null
          ? null
          : SIGN_KEY_SET.has(body.moonSign)
            ? body.moonSign
            : (user.moon_sign ?? null);
    const risingSign =
      body.risingSign === undefined
        ? (user.rising_sign ?? null)
        : body.risingSign === null
          ? null
          : SIGN_KEY_SET.has(body.risingSign)
            ? body.risingSign
            : (user.rising_sign ?? null);
    const mbti =
      body.mbti === undefined
        ? (user.mbti ?? null)
        : body.mbti === null
          ? null
          : VALID_MBTI.has(body.mbti.toUpperCase())
            ? body.mbti.toUpperCase()
            : (user.mbti ?? null);
    userStmts.updateBirthAndSigns.run(
      birthAt,
      birthTz,
      sunSign,
      moonSign,
      risingSign,
      mbti,
      user.id,
    );
    changed.push('birth');
  }
  if (
    body.showBirthday !== undefined ||
    body.showBirthTime !== undefined ||
    body.showMbti !== undefined ||
    body.showSigns !== undefined ||
    body.showBirthYear !== undefined
  ) {
    userStmts.updateProfileVisibility.run(
      body.showBirthday === undefined
        ? user.show_birthday
        : body.showBirthday
          ? 1
          : 0,
      body.showBirthTime === undefined
        ? user.show_birth_time
        : body.showBirthTime
          ? 1
          : 0,
      body.showMbti === undefined ? user.show_mbti : body.showMbti ? 1 : 0,
      body.showSigns === undefined ? user.show_signs : body.showSigns ? 1 : 0,
      body.showBirthYear === undefined
        ? user.show_birth_year
        : body.showBirthYear
          ? 1
          : 0,
      user.id,
    );
    changed.push('visibility');
  }
  if (body.password) {
    if (body.password.length < 6) {
      return c.json({ error: 'password too short (min 6 chars)' }, 400);
    }
    const hash = await hashPassword(body.password);
    userStmts.setOwnPassword.run(hash, user.id);
    logAudit({
      actorUserId: user.id,
      action: 'user_password_change',
    });
  }
  if (changed.length > 0) {
    logAudit({
      actorUserId: user.id,
      action: 'user_profile_update',
      metadata: { fields: changed },
    });
  }

  const fresh = userStmts.findById.get(user.id) as UserRow;
  return c.json({ user: buildUserDTO(fresh) });
});

// Persona dice — random-rolls the seed that picks variant indices for
// each of the 5 matrix cells (sun, moon, rising, MBTI-noun, MBTI-action).
// Requires the user to have all four astro fields filled (matches the
// "填完出生資訊以及 MBTI 才能按骰子" spec). Each roll is logged as a
// tiny synthetic LLM call so the user's $cost ticker reflects the
// activity even though no real model runs.
const PERSONA_SEED_RANGE = 5 * 5 * 5 * 5 * 5; // 5^5 = 3125

authRoute.post('/persona/roll', requireAuth, async (c) => {
  const session = c.get('user');
  const user = userStmts.findById.get(session.id) as UserRow | undefined;
  if (!user) return c.json({ error: 'unauthorized' }, 401);

  // Gate on having the full astro set — no point rolling otherwise.
  const ready =
    !!user.sun_sign &&
    !!user.moon_sign &&
    !!user.rising_sign &&
    !!user.mbti;
  if (!ready) {
    return c.json(
      { error: '請先填完出生資訊與 MBTI 才能骰' },
      400,
    );
  }

  const seed = Math.floor(Math.random() * PERSONA_SEED_RANGE);
  userStmts.updatePersonaSeed.run(seed, user.id);

  // Synthetic usage_log row — model 'persona-dice' has a $0.001 per-
  // image price, tokens_out=1 = one roll, success=1.
  try {
    usageStmts.insert.run(
      user.id,
      'gemini', // mythic ownership: Gemini designed the matrix
      'gemini_api:persona-dice',
      'persona',
      0,
      0,
      0,
      1,
      1,
      1,
      null,
      'persona-dice',
    );
  } catch (err) {
    console.error('[persona] usage_log insert failed', (err as Error).message);
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
  // User view groups by requested_model — fallback rows roll up under the
  // model the user actually asked for, so the per-model row never says
  // "openrouter:..." or "claude_api:...". Cost stays based on the
  // requested model (slightly over-reported when fallbacks fired, which
  // the user has accepted as "fair given retry overhead").
  const breakdown = usageStmts.byRequestedModelForUser.all(session.id) as Array<{
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

// Public — avatars are not secret (a username is already public when it
// shows up on a forum post or comment, so the matching avatar should be
// reachable by anonymous viewers too). See forum routes which need this.
authRoute.get('/avatar/:username', (c) => {
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

// Lightweight introspection so the reset/invite landing page can decide
// what UI to show. Tells the client whether this is a fresh invite
// (where letting the user pick a username makes sense) or just a
// password reset for an existing account.
authRoute.get('/reset-info', (c) => {
  const token = c.req.query('token') ?? '';
  if (!token) return c.json({ error: 'token required' }, 400);
  const now = Math.floor(Date.now() / 1000);
  const row = resetStmts.findValid.get(token, now) as
    | { user_id: number }
    | undefined;
  if (!row) return c.json({ error: 'invalid or expired token' }, 400);
  const user = userStmts.findById.get(row.user_id) as UserRow | undefined;
  if (!user) return c.json({ error: 'user not found' }, 404);
  // "Invite" = unverified row (admin-created or self-signed-up but
  // not yet email-verified). Reset = verified existing user.
  return c.json({
    username: user.username,
    email: user.email,
    nickname: user.nickname,
    isInvite: !user.email_verified,
  });
});

authRoute.post('/reset-password', async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | { token?: string; password?: string; username?: string }
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
  const user = userStmts.findById.get(row.user_id) as UserRow | undefined;
  if (!user) return c.json({ error: 'user not found' }, 404);

  // Optional username pick — only honored for invite flow (unverified
  // users). Existing users with verified emails can't change their
  // username via the reset flow; they'd be a real account hijack risk.
  const requestedUsername = (body.username ?? '').trim().toLowerCase();
  if (requestedUsername && requestedUsername !== user.username) {
    if (user.email_verified) {
      return c.json({ error: '已驗證帳號無法在此修改使用者名稱' }, 400);
    }
    if (!/^[a-z0-9_.-]{3,40}$/.test(requestedUsername)) {
      return c.json(
        { error: '帳號名只能用英數字加 . _ -，長度 3–40' },
        400,
      );
    }
    if (userStmts.findByEmailOrUsername.get(requestedUsername, requestedUsername)) {
      return c.json({ error: '這個帳號名已被使用' }, 409);
    }
    userStmts.updateUsername.run(requestedUsername, user.id);
  }

  const hash = await hashPassword(body.password);
  userStmts.setPasswordHash.run(hash, row.user_id);
  resetStmts.markUsed.run(body.token);
  logAudit({
    actorUserId: row.user_id,
    action: 'user_password_reset_complete',
    metadata: { wasInvite: !user.email_verified },
  });
  return c.json({ ok: true });
});
