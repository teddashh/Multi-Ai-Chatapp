import { Hono } from 'hono';
import { randomBytes } from 'node:crypto';
import {
  hashPassword,
  requireAdmin,
  type AppVariables,
} from '../lib/auth.js';
import {
  attachmentStmts,
  auditStmts,
  db,
  forumStmts,
  messageStmts,
  resetStmts,
  sessionStmts,
  usageStmts,
  userStmts,
  type AuditRow,
  type AttachmentRow,
  type MediaRow,
  type MessageRow,
  type SessionRow,
  type UserRow,
} from '../lib/db.js';
import { sendInviteEmail } from '../lib/mail.js';
import {
  MAX_FORUM_MEDIA_BYTES,
  deleteForumMedia,
  isSupportedForumMediaMime,
  saveForumMedia,
} from '../lib/uploads.js';
import { runFallbackDigestNow } from '../lib/fallbackDigest.js';
import { estimateCost } from '../shared/prices.js';
import { TIER_MODELS } from '../shared/models.js';
import type { AIProvider, Tier } from '../shared/types.js';

export const adminRoute = new Hono<{ Variables: AppVariables }>();

const VALID_TIERS: Tier[] = ['free', 'standard', 'pro', 'super', 'admin'];

// Derive a sensible username from an email. `linda+test@gmail.com` → `linda`.
// Falls back to the local part as-is if the heuristics strip too much.
function deriveUsername(email: string): string {
  const local = email.split('@')[0] ?? '';
  // Drop +tags and runs of non-word chars, lowercase.
  let candidate = local.split('+')[0].replace(/[^a-zA-Z0-9_.-]/g, '').toLowerCase();
  if (!candidate) candidate = local.toLowerCase() || 'user';
  return candidate.slice(0, 40);
}

// Find a free username starting with `base`, appending 2/3/... on conflicts.
function uniqueUsername(base: string): string {
  if (!userStmts.findByUsername.get(base)) return base;
  for (let i = 2; i < 100; i++) {
    const candidate = `${base}${i}`;
    if (!userStmts.findByUsername.get(candidate)) return candidate;
  }
  return `${base}${randomBytes(2).toString('hex')}`;
}
const RESET_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days for invites

adminRoute.use('*', requireAdmin);

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
  // Pull usage totals + per-model breakdown once and index by user_id
  // so the table can show calls / tokens / estimated cost inline
  // without firing a second request from the client.
  const totals = usageStmts.totalsByUser.all() as Array<{
    id: number;
    calls: number;
    tokens_in: number;
    tokens_out: number;
  }>;
  const totalsById = new Map<number, (typeof totals)[number]>(
    totals.map((t) => [t.id, t]),
  );
  const breakdown = usageStmts.byUserAndModel.all() as Array<{
    user_id: number;
    provider: string;
    model: string;
    tokens_in: number;
    tokens_out: number;
  }>;
  const costById = new Map<number, number>();
  for (const b of breakdown) {
    const c = estimateCost(b.provider, b.model, b.tokens_in, b.tokens_out);
    costById.set(b.user_id, (costById.get(b.user_id) ?? 0) + c);
  }
  const enriched = rows.map((r) => {
    const full = userStmts.findByUsername.get(r.username) as UserRow | undefined;
    const t = totalsById.get(r.id);
    return {
      id: r.id,
      username: r.username,
      tier: r.tier,
      created_at: r.created_at,
      nickname: full?.nickname ?? null,
      email: full?.email ?? null,
      real_name: full?.real_name ?? null,
      has_avatar: !!full?.avatar_path,
      disabled_at: full?.disabled_at ?? null,
      total_calls: t?.calls ?? 0,
      total_tokens_in: t?.tokens_in ?? 0,
      total_tokens_out: t?.tokens_out ?? 0,
      total_cost_usd: costById.get(r.id) ?? 0,
    };
  });
  return c.json({ users: enriched });
});

// Create + email an invite link. Admin only fills email + real_name + tier;
// username is derived from the email (with a numeric suffix on conflict).
// Returns the invite URL so admin can also share it manually.
adminRoute.post('/users/invite', async (c) => {
  const me = c.get('user');
  const body = (await c.req.json().catch(() => null)) as
    | {
        email?: string;
        tier?: Tier;
        real_name?: string;
        nickname?: string;
      }
    | null;
  if (!body?.email || !body?.tier) {
    return c.json({ error: 'email and tier required' }, 400);
  }
  if (!VALID_TIERS.includes(body.tier)) {
    return c.json({ error: 'invalid tier' }, 400);
  }
  const email = body.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return c.json({ error: 'invalid email' }, 400);
  }
  const existing = userStmts.findByEmailOrUsername.get(email, email) as
    | UserRow
    | undefined;
  if (existing) {
    return c.json({ error: 'account already exists for this email' }, 409);
  }

  const username = uniqueUsername(deriveUsername(email));
  // Stash a placeholder password — the user replaces it via the reset link.
  const placeholder = await hashPassword(randomBytes(24).toString('hex'));
  userStmts.insert.run(username, placeholder, body.tier);
  userStmts.updateProfile.run(body.nickname ?? null, email, username);
  if (body.real_name) {
    userStmts.updateRealName.run(body.real_name, username);
  }

  const created = userStmts.findByUsername.get(username) as UserRow;
  const token = randomBytes(32).toString('hex');
  const expiresAt = Math.floor(Date.now() / 1000) + RESET_TOKEN_TTL_SECONDS;
  resetStmts.insert.run(token, created.id, expiresAt);

  const publicUrl = process.env.PUBLIC_URL || 'https://chat.ted-h.com';
  const inviteUrl = `${publicUrl}/?reset=${token}`;
  // Look up the inviting admin's display name so the recipient sees who
  // invited them (instead of just an anonymous "you've been invited").
  const adminRow = userStmts.findById.get(me.id) as UserRow | undefined;
  const inviterName =
    adminRow?.nickname || adminRow?.real_name || adminRow?.username || null;

  let emailSent = false;
  try {
    await sendInviteEmail({
      to: email,
      greetingName: body.nickname || body.real_name || username,
      inviterName,
      setupUrl: inviteUrl,
    });
    emailSent = true;
  } catch (err) {
    console.error('invite email failed', (err as Error).message);
  }

  audit(me.id, 'invite_user', {
    targetUserId: created.id,
    metadata: { username, email, tier: body.tier, emailSent },
  });

  return c.json({ ok: true, inviteUrl, username, emailSent });
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
  // Override SET NULL on forum_comments to hard-purge the user's
  // comments on other people's posts (rest cascades via the FK).
  userStmts.deleteForumCommentsByAuthor.run(target.id);
  userStmts.delete.run(username);
  audit(me.id, 'delete_user', {
    targetUserId: target.id,
    metadata: { username },
  });
  return c.json({ ok: true });
});

// Admin-side soft disable / re-enable. POST flips the disabled_at flag.
// `disabled` true → set epoch now; false → clear. Cannot disable yourself
// (would lock you out of the admin panel).
adminRoute.post('/users/:username/disabled', async (c) => {
  const me = c.get('user');
  const username = c.req.param('username') ?? '';
  if (!username) return c.json({ error: 'username required' }, 400);
  if (me.username === username) {
    return c.json({ error: 'cannot disable yourself' }, 400);
  }
  const target = userStmts.findByUsername.get(username) as UserRow | undefined;
  if (!target) return c.json({ error: 'user not found' }, 404);
  const body = (await c.req.json().catch(() => null)) as
    | { disabled?: boolean }
    | null;
  if (typeof body?.disabled !== 'boolean') {
    return c.json({ error: 'disabled boolean required' }, 400);
  }
  const next = body.disabled ? Math.floor(Date.now() / 1000) : null;
  userStmts.setDisabled.run(next, username);
  audit(me.id, body.disabled ? 'disable_user' : 'enable_user', {
    targetUserId: target.id,
    metadata: { username },
  });
  return c.json({ ok: true, disabledAt: next });
});

// === FORUM COMMENT MODERATION ===
// Single-comment delete — admin only. Cleans up the per-comment
// likes (forum_likes has no FK so it won't cascade) and decrements
// the parent post's comment_count. Replies under the comment cascade
// via the schema FK.
adminRoute.delete('/forum/comments/:id', (c) => {
  const me = c.get('user');
  const commentId = parseInt(c.req.param('id') ?? '', 10);
  if (!Number.isFinite(commentId) || commentId <= 0) {
    return c.json({ error: 'invalid id' }, 400);
  }
  const row = forumStmts.findCommentById.get(commentId) as
    | { id: number; post_id: number; author_user_id: number | null; author_type: string }
    | undefined;
  if (!row) return c.json({ error: 'not found' }, 404);
  db.transaction(() => {
    forumStmts.deleteCommentLikes.run(commentId);
    forumStmts.deleteCommentById.run(commentId);
    forumStmts.bumpCommentCount.run(-1, row.post_id);
  })();
  audit(me.id, 'delete_forum_comment', {
    targetUserId: row.author_user_id,
    metadata: {
      commentId,
      postId: row.post_id,
      authorType: row.author_type,
    },
  });
  return c.json({ ok: true });
});

// === FORUM POST MODERATION ===
// Admin can flag any post as NSFW. NSFW posts are hidden from anonymous
// visitors and gated behind a click-to-confirm overlay for logged-in
// users (see server/src/routes/forum.ts list/detail handlers + the
// client-side overlay in Forum.tsx).
adminRoute.post('/forum/posts/:id/nsfw', async (c) => {
  const me = c.get('user');
  const postId = parseInt(c.req.param('id') ?? '', 10);
  if (!Number.isFinite(postId) || postId <= 0) {
    return c.json({ error: 'invalid id' }, 400);
  }
  const body = (await c.req.json().catch(() => null)) as
    | { nsfw?: boolean }
    | null;
  if (typeof body?.nsfw !== 'boolean') {
    return c.json({ error: 'nsfw boolean required' }, 400);
  }
  forumStmts.setPostNsfw.run(body.nsfw ? 1 : 0, postId);
  audit(me.id, body.nsfw ? 'post_flag_nsfw' : 'post_unflag_nsfw', {
    metadata: { postId },
  });
  return c.json({ ok: true, nsfw: body.nsfw });
});

// === AI PERSONA MEDIA LIBRARY ===
// Each of the 4 AI personas (claude / chatgpt / gemini / grok) gets a
// public-facing media gallery on their forum profile. Admin-only upload
// since AIs aren't real users; we don't want random users posting
// images there.

const VALID_AI_PROVIDERS = new Set(['claude', 'chatgpt', 'gemini', 'grok']);

adminRoute.post('/ai-personas/:provider/media', async (c) => {
  const me = c.get('user');
  const provider = c.req.param('provider') ?? '';
  if (!VALID_AI_PROVIDERS.has(provider)) {
    return c.json({ error: 'invalid provider' }, 400);
  }
  const form = await c.req.parseBody();
  const file = form['file'];
  if (!(file instanceof File)) return c.json({ error: 'file required' }, 400);
  if (!isSupportedForumMediaMime(file.type)) {
    return c.json({ error: 'unsupported mime' }, 400);
  }
  const buf = Buffer.from(await file.arrayBuffer());
  if (buf.length > MAX_FORUM_MEDIA_BYTES) {
    return c.json({ error: 'file too large (max 8 MB)' }, 400);
  }
  const caption = typeof form['caption'] === 'string' ? form['caption'] : null;
  const isThumbnail =
    form['isThumbnail'] === '1' || form['isThumbnail'] === 'true';

  const path = saveForumMedia(file.type, buf);
  const existing = forumStmts.listMediaForAI.all(provider) as MediaRow[];
  const result = forumStmts.insertAIMedia.run(
    provider,
    path,
    file.type,
    buf.length,
    caption,
    isThumbnail ? 1 : 0,
    existing.length,
    me.id,
  );
  const newId = Number(result.lastInsertRowid);
  if (isThumbnail) {
    forumStmts.clearAIThumbnailExcept.run(provider, newId);
  }
  audit(me.id, 'ai_media_upload', {
    metadata: { provider, mediaId: newId, size: buf.length },
  });
  return c.json({ ok: true, mediaId: newId });
});

adminRoute.delete('/ai-personas/:provider/media/:id', (c) => {
  const me = c.get('user');
  const provider = c.req.param('provider') ?? '';
  if (!VALID_AI_PROVIDERS.has(provider)) {
    return c.json({ error: 'invalid provider' }, 400);
  }
  const id = parseInt(c.req.param('id') ?? '', 10);
  if (!Number.isFinite(id) || id <= 0) return c.json({ error: 'invalid id' }, 400);
  const row = forumStmts.findMediaById.get(id) as MediaRow | undefined;
  if (!row || row.ai_provider !== provider) {
    return c.json({ error: 'not found' }, 404);
  }
  forumStmts.deleteMediaById.run(id);
  deleteForumMedia(row.path);
  audit(me.id, 'ai_media_delete', { metadata: { provider, mediaId: id } });
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

// Stream any attachment (image/pdf/text) without the ownership check the
// user-facing route enforces. Admin needs to see what people uploaded.
adminRoute.get('/attachments/:id', async (c) => {
  const id = c.req.param('id') ?? '';
  if (!id) return c.json({ error: 'id required' }, 400);
  const row = attachmentStmts.findById.get(id) as AttachmentRow | undefined;
  if (!row) return c.json({ error: 'not found' }, 404);
  const fs = await import('node:fs');
  let stream;
  try {
    stream = fs.createReadStream(row.path);
  } catch {
    return c.json({ error: 'file missing on disk' }, 404);
  }
  return new Response(stream as unknown as ReadableStream, {
    headers: {
      'Content-Type': row.mime_type,
      'Content-Disposition': `inline; filename="${encodeURIComponent(row.filename)}"`,
    },
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

// Per-billing-channel spending (Anthropic / OpenAI / Gemini / xAI / OpenRouter
// / CLI subscription). Sums actual answered-by model so admin sees what each
// API key got billed for. Cost estimate uses estimateCost on the billed model
// — for OpenRouter rows the `billed_model` is OR's full id (e.g.
// `anthropic/claude-3-haiku`) which prices.ts may or may not have a row for;
// when it doesn't the column reads 0.
adminRoute.get('/api-key-spending', (c) => {
  const rows = usageStmts.byBillingChannel.all() as Array<{
    channel: string;
    provider: string;
    billed_model: string;
    calls: number;
    tokens_in: number;
    tokens_out: number;
  }>;

  // Group rows under each channel for the response.
  const channels = new Map<
    string,
    {
      channel: string;
      total_calls: number;
      total_cost_usd: number;
      models: Array<{
        provider: string;
        model: string;
        calls: number;
        tokens_in: number;
        tokens_out: number;
        cost_usd: number;
      }>;
    }
  >();
  for (const r of rows) {
    const cost = estimateCost(r.provider, r.billed_model, r.tokens_in, r.tokens_out);
    const ch = channels.get(r.channel) ?? {
      channel: r.channel,
      total_calls: 0,
      total_cost_usd: 0,
      models: [],
    };
    ch.total_calls += r.calls;
    ch.total_cost_usd += cost;
    ch.models.push({
      provider: r.provider,
      model: r.billed_model,
      calls: r.calls,
      tokens_in: r.tokens_in,
      tokens_out: r.tokens_out,
      cost_usd: cost,
    });
    channels.set(r.channel, ch);
  }

  // Stable order: paid API keys first, OR last, CLI subscription last (no
  // metered cost so it goes at the bottom).
  const order = ['anthropic_api', 'openai_api', 'gemini_api', 'xai_api', 'openrouter', 'nvidia', 'cli_subscription'];
  const sorted = Array.from(channels.values()).sort((a, b) => {
    const ai = order.indexOf(a.channel);
    const bi = order.indexOf(b.channel);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });
  return c.json({ channels: sorted });
});

// Manual trigger for the hourly fallback-event email digest. Useful when
// admin wants to verify formatting / smoke-test SMTP without waiting for
// the next tick. Returns ok regardless of whether anything was sent —
// the function itself logs + skips silently when there's nothing to mail.
adminRoute.post('/digest/run', async (c) => {
  const me = c.get('user');
  try {
    await runFallbackDigestNow();
    audit(me.id, 'manual_digest_run', { metadata: {} });
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ ok: false, error: (err as Error).message }, 500);
  }
});

// Per-(provider, model) success rate. Includes all models known to TIER_MODELS
// even if they have zero attempts — that way admin can see "claude-opus has
// never been called" rather than just an empty row. Recent failure codes (last
// 7 days) are attached so admin can spot patterns like persistent 429s.
// Decompose the (family, raw_model) tuple stored in usage_log into the
// 4-column shape the dashboard wants:
//   - provider: who got the bill (Anthropic / OpenAI / Google / xAI / OpenRouter)
//   - family: which character the user picked (Claude / GPT / Gemini / Grok)
//   - method: CLI subprocess vs direct API call
//   - model: the actual SKU, no channel prefix
const FAMILY_TO_VENDOR: Record<AIProvider, string> = {
  claude: 'Anthropic',
  chatgpt: 'OpenAI',
  gemini: 'Google',
  grok: 'xAI',
};
const FAMILY_LABEL: Record<AIProvider, string> = {
  claude: 'Claude',
  chatgpt: 'GPT',
  gemini: 'Gemini',
  grok: 'Grok',
};
function decomposeModel(family: AIProvider, rawModel: string): {
  provider: string;
  family: string;
  method: 'CLI' | 'API';
  model: string;
} {
  const familyLabel = FAMILY_LABEL[family];
  if (rawModel.startsWith('openrouter:')) {
    return {
      provider: 'OpenRouter',
      family: familyLabel,
      method: 'API',
      model: rawModel.slice('openrouter:'.length),
    };
  }
  if (rawModel.startsWith('nvidia:')) {
    return {
      provider: 'NVIDIA',
      family: familyLabel,
      method: 'API',
      model: rawModel.slice('nvidia:'.length),
    };
  }
  // claude_api: / chatgpt_api: / gemini_api: — direct vendor API call
  const apiMatch = rawModel.match(/^(claude|chatgpt|gemini)_api:(.+)$/);
  if (apiMatch) {
    return {
      provider: FAMILY_TO_VENDOR[family],
      family: familyLabel,
      method: 'API',
      model: apiMatch[2],
    };
  }
  // No prefix: grok always hits the xAI API direct (no CLI binary), other
  // families ran through their official CLI. Vendor is the family vendor.
  return {
    provider: FAMILY_TO_VENDOR[family],
    family: familyLabel,
    method: family === 'grok' ? 'API' : 'CLI',
    model: rawModel,
  };
}

adminRoute.get('/model-stats', (c) => {
  const rollup = usageStmts.byModel.all() as Array<{
    provider: string;
    model: string;
    attempts: number;
    successes: number;
    failures: number;
    last_seen: number | null;
  }>;
  const sevenDaysAgo = Math.floor(Date.now() / 1000) - 7 * 24 * 3600;
  const recentCodes = usageStmts.recentFailureCodes.all(sevenDaysAgo) as Array<{
    provider: string;
    model: string;
    error_code: string;
    n: number;
  }>;
  const codesByModel = new Map<string, Array<{ code: string; n: number }>>();
  for (const r of recentCodes) {
    const key = `${r.provider}:${r.model}`;
    const list = codesByModel.get(key) ?? [];
    list.push({ code: r.error_code, n: r.n });
    codesByModel.set(key, list);
  }

  // Build a stable union of every (provider, model) we know about — both
  // the ones that have logs and the ones declared in TIER_MODELS.
  const seen = new Set(rollup.map((r) => `${r.provider}:${r.model}`));
  const modelsByKey = new Map<string, { provider: AIProvider; model: string }>();
  for (const r of rollup) {
    modelsByKey.set(`${r.provider}:${r.model}`, {
      provider: r.provider as AIProvider,
      model: r.model,
    });
  }
  for (const tier of Object.values(TIER_MODELS)) {
    for (const provider of Object.keys(tier) as AIProvider[]) {
      for (const model of tier[provider].options) {
        const key = `${provider}:${model}`;
        if (!seen.has(key)) {
          modelsByKey.set(key, { provider, model });
          seen.add(key);
        }
      }
    }
  }

  const rollupByKey = new Map<string, (typeof rollup)[number]>(
    rollup.map((r) => [`${r.provider}:${r.model}`, r]),
  );

  const stats = Array.from(modelsByKey.values()).map(({ provider: family, model: rawModel }) => {
    const key = `${family}:${rawModel}`;
    const r = rollupByKey.get(key);
    const attempts = r?.attempts ?? 0;
    const successes = r?.successes ?? 0;
    const failures = r?.failures ?? 0;
    const rate = attempts > 0 ? successes / attempts : null;
    const decomposed = decomposeModel(family, rawModel);
    return {
      provider: decomposed.provider,
      family: decomposed.family,
      method: decomposed.method,
      model: decomposed.model,
      attempts,
      successes,
      failures,
      success_rate: rate,
      last_seen: r?.last_seen ?? null,
      recent_errors: codesByModel.get(key) ?? [],
    };
  });

  // Sort: family first (Claude → GPT → Gemini → Grok matches the UI order),
  // then method (CLI before API), then provider, then failures desc, then
  // attempts desc.
  const FAMILY_ORDER: Record<string, number> = { Claude: 0, GPT: 1, Gemini: 2, Grok: 3 };
  const METHOD_ORDER: Record<string, number> = { CLI: 0, API: 1 };
  stats.sort((a, b) => {
    const fa = FAMILY_ORDER[a.family] ?? 99;
    const fb = FAMILY_ORDER[b.family] ?? 99;
    if (fa !== fb) return fa - fb;
    const ma = METHOD_ORDER[a.method] ?? 99;
    const mb = METHOD_ORDER[b.method] ?? 99;
    if (ma !== mb) return ma - mb;
    if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
    if (a.failures !== b.failures) return b.failures - a.failures;
    return b.attempts - a.attempts;
  });

  return c.json({ stats });
});

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
    users: totals.map((u) => {
      const rows = (breakdownByUser.get(u.id) ?? []).map((b) => {
        const cost = estimateCost(b.provider, b.model, b.tokens_in, b.tokens_out);
        return {
          provider: b.provider,
          model: b.model,
          calls: b.calls,
          tokens_in: b.tokens_in,
          tokens_out: b.tokens_out,
          prompt_chars: b.prompt_chars,
          completion_chars: b.completion_chars,
          is_estimated: !!b.any_estimated,
          cost_usd: cost,
        };
      });
      const totalCost = rows.reduce((sum, r) => sum + r.cost_usd, 0);
      return {
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
          cost_usd: totalCost,
        },
        by_model: rows,
      };
    }),
  });
});
