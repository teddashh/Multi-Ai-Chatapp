import { Hono } from 'hono';
import { randomBytes } from 'node:crypto';
import {
  hashPassword,
  requireSuper,
  type AppVariables,
} from '../lib/auth.js';
import {
  attachmentStmts,
  auditStmts,
  messageStmts,
  resetStmts,
  sessionStmts,
  usageStmts,
  userStmts,
  type AuditRow,
  type MessageRow,
  type SessionRow,
  type UserRow,
} from '../lib/db.js';
import { sendResetEmail } from '../lib/mail.js';
import type { Tier } from '../shared/types.js';

export const adminRoute = new Hono<{ Variables: AppVariables }>();

const VALID_TIERS: Tier[] = ['standard', 'pro', 'super'];
const RESET_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days for invites

adminRoute.use('*', requireSuper);

function audit(
  adminId: number,
  action: string,
  opts: {
    targetUserId?: number | null;
    targetSessionId?: string | null;
    metadata?: Record<string, unknown>;
  } = {},
): void {
  try {
    auditStmts.insert.run(
      adminId,
      opts.targetUserId ?? null,
      opts.targetSessionId ?? null,
      action,
      opts.metadata ? JSON.stringify(opts.metadata) : null,
    );
  } catch (err) {
    console.error('audit insert failed', (err as Error).message);
  }
}

// === USERS ===

adminRoute.get('/users', (c) => {
  const rows = userStmts.list.all() as Array<{
    id: number;
    username: string;
    tier: Tier;
    created_at: number;
  }>;
  const enriched = rows.map((r) => {
    const full = userStmts.findByUsername.get(r.username) as UserRow | undefined;
    return {
      id: r.id,
      username: r.username,
      tier: r.tier,
      created_at: r.created_at,
      nickname: full?.nickname ?? null,
      email: full?.email ?? null,
      real_name: full?.real_name ?? null,
      has_avatar: !!full?.avatar_path,
    };
  });
  return c.json({ users: enriched });
});

// Create + email an invite link. The user clicks the link to set their own
// password — same mechanism as forgot-password but with a longer TTL since
// they may not check email immediately.
adminRoute.post('/users/invite', async (c) => {
  const me = c.get('user');
  const body = (await c.req.json().catch(() => null)) as
    | {
        username?: string;
        email?: string;
        tier?: Tier;
        nickname?: string;
        real_name?: string;
      }
    | null;
  if (!body?.username || !body?.email || !body?.tier) {
    return c.json({ error: 'username, email, tier required' }, 400);
  }
  if (!VALID_TIERS.includes(body.tier)) {
    return c.json({ error: 'invalid tier' }, 400);
  }
  if (userStmts.findByUsername.get(body.username)) {
    return c.json({ error: 'user already exists' }, 409);
  }

  // Stash a placeholder password — the user replaces it via the reset link.
  const placeholder = await hashPassword(randomBytes(24).toString('hex'));
  userStmts.insert.run(body.username, placeholder, body.tier);
  userStmts.updateProfile.run(
    body.nickname ?? null,
    body.email,
    body.username,
  );
  if (body.real_name) {
    userStmts.updateRealName.run(body.real_name, body.username);
  }

  const created = userStmts.findByUsername.get(body.username) as UserRow;
  const token = randomBytes(32).toString('hex');
  const expiresAt = Math.floor(Date.now() / 1000) + RESET_TOKEN_TTL_SECONDS;
  resetStmts.insert.run(token, created.id, expiresAt);

  const publicUrl = process.env.PUBLIC_URL || 'https://chat.ted-h.com';
  const inviteUrl = `${publicUrl}/?reset=${token}`;
  try {
    await sendResetEmail({
      to: body.email,
      nickname: body.nickname || body.real_name || body.username,
      resetUrl: inviteUrl,
      reason: 'self_request',
    });
  } catch (err) {
    console.error('invite email failed', (err as Error).message);
  }

  audit(me.id, 'invite_user', {
    targetUserId: created.id,
    metadata: {
      username: body.username,
      email: body.email,
      tier: body.tier,
    },
  });

  return c.json({ ok: true, inviteUrl });
});

// Legacy create — still supported in case admin wants to set a password
// without email round-trip. Marked as audit just like invite.
adminRoute.post('/users', async (c) => {
  const me = c.get('user');
  const body = (await c.req.json().catch(() => null)) as
    | {
        username?: string;
        password?: string;
        tier?: Tier;
        nickname?: string;
        email?: string;
        real_name?: string;
      }
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
  if (body.nickname || body.email) {
    userStmts.updateProfile.run(
      body.nickname ?? null,
      body.email ?? null,
      body.username,
    );
  }
  if (body.real_name) {
    userStmts.updateRealName.run(body.real_name, body.username);
  }
  const created = userStmts.findByUsername.get(body.username) as UserRow;
  audit(me.id, 'create_user', {
    targetUserId: created.id,
    metadata: { username: body.username, tier: body.tier },
  });
  return c.json({ ok: true });
});

adminRoute.patch('/users/:username', async (c) => {
  const me = c.get('user');
  const username = c.req.param('username') ?? '';
  if (!username) return c.json({ error: 'username required' }, 400);
  const body = (await c.req.json().catch(() => null)) as
    | {
        password?: string;
        tier?: Tier;
        nickname?: string;
        email?: string;
        real_name?: string;
      }
    | null;
  if (!body) return c.json({ error: 'body required' }, 400);

  const existing = userStmts.findByUsername.get(username) as UserRow | undefined;
  if (!existing) return c.json({ error: 'user not found' }, 404);

  const changedFields: string[] = [];

  if (body.password) {
    const hash = await hashPassword(body.password);
    userStmts.updatePassword.run(hash, username);
    changedFields.push('password');
  }
  if (body.tier) {
    if (!VALID_TIERS.includes(body.tier)) {
      return c.json({ error: 'invalid tier' }, 400);
    }
    if (body.tier !== existing.tier) {
      userStmts.updateTier.run(body.tier, username);
      changedFields.push('tier');
    }
  }
  if (body.nickname !== undefined || body.email !== undefined) {
    const nick =
      body.nickname !== undefined ? body.nickname || null : existing.nickname;
    const email =
      body.email !== undefined ? body.email || null : existing.email;
    userStmts.updateProfile.run(nick, email, username);
    if (nick !== existing.nickname) changedFields.push('nickname');
    if (email !== existing.email) changedFields.push('email');
  }
  if (body.real_name !== undefined) {
    const rn = body.real_name || null;
    if (rn !== existing.real_name) {
      userStmts.updateRealName.run(rn, username);
      changedFields.push('real_name');
    }
  }

  if (changedFields.length > 0) {
    audit(me.id, 'update_user', {
      targetUserId: existing.id,
      metadata: { username, fields: changedFields },
    });
  }
  return c.json({ ok: true });
});

adminRoute.delete('/users/:username', (c) => {
  const me = c.get('user');
  const username = c.req.param('username') ?? '';
  if (!username) return c.json({ error: 'username required' }, 400);
  if (me.username === username) {
    return c.json({ error: 'cannot delete yourself' }, 400);
  }
  const target = userStmts.findByUsername.get(username) as UserRow | undefined;
  if (!target) return c.json({ error: 'user not found' }, 404);
  userStmts.delete.run(username);
  audit(me.id, 'delete_user', {
    targetUserId: target.id,
    metadata: { username },
  });
  return c.json({ ok: true });
});

// === SESSIONS (admin audit view) ===

adminRoute.get('/users/:username/sessions', (c) => {
  const username = c.req.param('username') ?? '';
  if (!username) return c.json({ error: 'username required' }, 400);
  const target = userStmts.findByUsername.get(username) as UserRow | undefined;
  if (!target) return c.json({ error: 'user not found' }, 404);
  const rows = sessionStmts.listForUserIncludingDeleted.all(target.id) as Array<{
    id: string;
    title: string;
    mode: string;
    created_at: number;
    updated_at: number;
    deleted_at: number | null;
    msg_count: number;
  }>;
  return c.json({ sessions: rows });
});

// Read any session — bypasses ownership. Always logs an audit entry.
adminRoute.get('/sessions/:id', (c) => {
  const me = c.get('user');
  const id = c.req.param('id') ?? '';
  if (!id) return c.json({ error: 'id required' }, 400);
  const session = sessionStmts.findById.get(id) as SessionRow | undefined;
  if (!session) return c.json({ error: 'not found' }, 404);
  const messages = messageStmts.listForSession.all(id) as MessageRow[];
  const owner = userStmts.findById.get(session.user_id) as UserRow | undefined;
  const enriched = messages.map((m) => {
    const atts = attachmentStmts.listForMessage.all(m.id) as Array<{
      id: string;
      filename: string;
      mime_type: string;
      size: number;
      kind: string;
    }>;
    return {
      id: `${m.id}`,
      role: m.role,
      provider: m.provider ?? undefined,
      modeRole: m.mode_role ?? undefined,
      content: m.content,
      timestamp: m.timestamp * 1000,
      attachments: atts.map((a) => ({
        id: a.id,
        filename: a.filename,
        mimeType: a.mime_type,
        size: a.size,
        kind: a.kind,
      })),
    };
  });

  audit(me.id, 'view_session', {
    targetUserId: session.user_id,
    targetSessionId: session.id,
    metadata: {
      title: session.title,
      mode: session.mode,
      owner: owner?.username,
      message_count: messages.length,
      deleted: !!session.deleted_at,
    },
  });

  return c.json({
    session: {
      id: session.id,
      title: session.title,
      mode: session.mode,
      created_at: session.created_at,
      updated_at: session.updated_at,
      deleted_at: session.deleted_at,
      owner: owner
        ? {
            username: owner.username,
            nickname: owner.nickname,
            real_name: owner.real_name,
          }
        : null,
    },
    messages: enriched,
  });
});

// === AUDIT TRAIL ===

adminRoute.get('/audit', (c) => {
  const limit = Math.min(parseInt(c.req.query('limit') ?? '200', 10) || 200, 500);
  const rows = auditStmts.list.all(limit) as Array<
    AuditRow & { admin_username: string | null; target_username: string | null }
  >;
  return c.json({
    audit: rows.map((r) => ({
      id: r.id,
      admin: r.admin_username,
      target_user: r.target_username,
      target_session_id: r.target_session_id,
      action: r.action,
      metadata: r.metadata ? JSON.parse(r.metadata) : null,
      timestamp: r.timestamp,
    })),
  });
});

// === USAGE STATS ===

adminRoute.get('/usage', (c) => {
  const totals = usageStmts.totalsByUser.all() as Array<{
    id: number;
    username: string;
    real_name: string | null;
    nickname: string | null;
    tier: Tier;
    calls: number;
    tokens_in: number;
    tokens_out: number;
    prompt_chars: number;
    completion_chars: number;
  }>;
  const breakdown = usageStmts.byUserAndModel.all() as Array<{
    user_id: number;
    provider: string;
    model: string;
    calls: number;
    tokens_in: number;
    tokens_out: number;
    prompt_chars: number;
    completion_chars: number;
    any_estimated: number;
  }>;

  // Group breakdown rows under each user. Cheap nested loop — at most a few
  // dozen rows total in this app.
  const breakdownByUser = new Map<number, typeof breakdown>();
  for (const row of breakdown) {
    const list = breakdownByUser.get(row.user_id) ?? [];
    list.push(row);
    breakdownByUser.set(row.user_id, list);
  }

  return c.json({
    users: totals.map((u) => ({
      id: u.id,
      username: u.username,
      real_name: u.real_name,
      nickname: u.nickname,
      tier: u.tier,
      totals: {
        calls: u.calls,
        tokens_in: u.tokens_in,
        tokens_out: u.tokens_out,
        prompt_chars: u.prompt_chars,
        completion_chars: u.completion_chars,
      },
      by_model: (breakdownByUser.get(u.id) ?? []).map((b) => ({
        provider: b.provider,
        model: b.model,
        calls: b.calls,
        tokens_in: b.tokens_in,
        tokens_out: b.tokens_out,
        prompt_chars: b.prompt_chars,
        completion_chars: b.completion_chars,
        is_estimated: !!b.any_estimated,
      })),
    })),
  });
});
