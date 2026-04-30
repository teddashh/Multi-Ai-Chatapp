import { Hono } from 'hono';
import { requireAuth, type AppVariables } from '../lib/auth.js';
import {
  attachmentStmts,
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
    roles_json: string | null;
    created_at: number;
    updated_at: number;
    msg_count: number;
  }>;
  // Parse roles_json into a structured `meta` field. For multi modes
  // it carries ModeRoles; for Agent modes it carries
  // {provider, profession?, imageModel?} so the client can restore
  // the right state when the user clicks back into a session.
  return c.json({
    sessions: rows.map((r) => {
      let meta: unknown = null;
      if (r.roles_json) {
        try { meta = JSON.parse(r.roles_json); } catch { meta = null; }
      }
      return {
        id: r.id,
        title: r.title,
        mode: r.mode,
        meta,
        created_at: r.created_at,
        updated_at: r.updated_at,
        msg_count: r.msg_count,
      };
    }),
  });
});

sessionsRoute.get('/:id', (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const session = sessionStmts.findOwned.get(id, user.id) as SessionRow | undefined;
  if (!session) return c.json({ error: 'not found' }, 404);
  const messages = messageStmts.listForSession.all(id) as MessageRow[];
  const isAdmin = user.tier === 'admin';
  let meta: unknown = null;
  if (session.roles_json) {
    try { meta = JSON.parse(session.roles_json); } catch { meta = null; }
  }
  return c.json({
    session: {
      id: session.id,
      title: session.title,
      mode: session.mode,
      meta,
      created_at: session.created_at,
      updated_at: session.updated_at,
    },
    messages: messages.map((m) => {
      const attachments = attachmentStmts.listForMessage.all(m.id) as Array<{
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
        // Provenance is admin-only — regular users never learn that
        // their reply came from a fallback / cheaper SKU.
        answeredStage: isAdmin ? m.answered_stage ?? undefined : undefined,
        answeredModel: isAdmin ? m.answered_model ?? undefined : undefined,
        requestedModel: isAdmin ? m.requested_model ?? undefined : undefined,
        attachments: attachments.map((a) => ({
          id: a.id,
          filename: a.filename,
          mimeType: a.mime_type,
          size: a.size,
          kind: a.kind,
        })),
      };
    }),
  });
});

// Serve a saved attachment file (only the owner can fetch). Used by the web
// UI's image previews when reloading old sessions.
sessionsRoute.get('/attachments/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const row = attachmentStmts.findOwned.get(id, user.id) as
    | { path: string; mime_type: string; filename: string }
    | undefined;
  if (!row) return c.json({ error: 'not found' }, 404);
  const fs = await import('node:fs');
  const stream = fs.createReadStream(row.path);
  return new Response(stream as unknown as ReadableStream, {
    headers: {
      'Content-Type': row.mime_type,
      'Content-Disposition': `inline; filename="${encodeURIComponent(row.filename)}"`,
    },
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

// Soft-delete only: the row stays so admin audit can still pull the
// transcript later. Files on disk are kept intact for the same reason —
// admin needs to see what was attached. Hard purge would be a separate
// admin-only operation.
sessionsRoute.delete('/:id', (c) => {
  const user = c.get('user');
  const id = c.req.param('id') ?? '';
  if (!id) return c.json({ error: 'id required' }, 400);
  const owned = sessionStmts.findOwned.get(id, user.id);
  if (!owned) return c.json({ error: 'not found' }, 404);
  sessionStmts.softDelete.run(id, user.id);
  return c.json({ ok: true });
});
