import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { randomUUID } from 'node:crypto';
import { requireAuth, type AppVariables } from '../lib/auth.js';
import { runMode } from '../lib/orchestrator.js';
import {
  attachmentStmts,
  messageStmts,
  sessionStmts,
  type SessionRow,
} from '../lib/db.js';
import {
  loadAttachments,
  relocateToSession,
  saveUpload,
  MAX_FILE_BYTES,
  MAX_FILES_PER_MESSAGE,
} from '../lib/uploads.js';
import type { AIProvider, ChatMode, ModeRoles, SSEEvent } from '../shared/types.js';

export const chatRoute = new Hono<{ Variables: AppVariables }>();

chatRoute.post('/upload', requireAuth, async (c) => {
  const user = c.get('user');
  const body = await c.req.parseBody().catch(() => null);
  if (!body) return c.json({ error: 'multipart body required' }, 400);
  const file = body['file'];
  if (!(file instanceof File)) {
    return c.json({ error: 'file required' }, 400);
  }
  if (file.size > MAX_FILE_BYTES) {
    return c.json(
      { error: `檔案過大（最大 ${Math.round(MAX_FILE_BYTES / 1024 / 1024)}MB）` },
      413,
    );
  }
  const buffer = Buffer.from(await file.arrayBuffer());
  try {
    const saved = await saveUpload(user.id, file.name, file.type || 'application/octet-stream', buffer);
    return c.json({ attachment: saved });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

function deriveTitle(text: string): string {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  return trimmed.length > 60 ? trimmed.slice(0, 60) + '…' : trimmed || '新對話';
}

chatRoute.post('/send', requireAuth, async (c) => {
  const user = c.get('user');
  const body = (await c.req.json().catch(() => null)) as
    | {
        text?: string;
        mode?: ChatMode;
        roles?: ModeRoles;
        modelOverrides?: Partial<Record<AIProvider, string>>;
        sessionId?: string;
        attachmentIds?: string[];
      }
    | null;

  if (!body?.text || !body?.mode) {
    return c.json({ error: 'text and mode required' }, 400);
  }

  const text = body.text;
  const mode = body.mode;
  const roles = body.roles;
  const modelOverrides = body.modelOverrides;
  const attachmentIds = (body.attachmentIds || []).slice(0, MAX_FILES_PER_MESSAGE);
  const attachments = loadAttachments(attachmentIds, user.id);

  // Resolve session: reuse if user owns it, else create a fresh one.
  let sessionId = body.sessionId ?? '';
  let isNew = false;
  if (sessionId) {
    const found = sessionStmts.findOwned.get(sessionId, user.id) as
      | SessionRow
      | undefined;
    if (!found) {
      sessionId = '';
    }
  }
  if (!sessionId) {
    sessionId = randomUUID();
    sessionStmts.insert.run(sessionId, user.id, deriveTitle(text), mode);
    isNew = true;
  } else {
    sessionStmts.touch.run(sessionId);
  }

  // Persist the user message immediately
  const now = Math.floor(Date.now() / 1000);
  const userMsgRes = messageStmts.insert.run(sessionId, 'user', null, null, text, now);
  const userMsgId = Number(userMsgRes.lastInsertRowid);
  for (const att of attachments) {
    attachmentStmts.attachToMessage.run(userMsgId, att.id, user.id);
    // Move file from _pending/<id>/ to <username>/<session_id>/<id>/ for
    // human-browsable / rsync-friendly layout.
    try {
      relocateToSession(att.id, user.id, user.username, sessionId);
      // Refresh the path on the in-memory attachment so any downstream
      // provider invocation reads the new location.
      att.path = att.path.replace(/_pending/, ''); // best-effort; orchestrator re-loads anyway
    } catch (err) {
      console.error('attachment relocation failed', (err as Error).message);
    }
  }
  // Re-load attachments so paths reflect the post-move state.
  const reloadedAttachments = loadAttachments(
    attachments.map((a) => a.id),
    user.id,
  );

  return streamSSE(c, async (stream) => {
    const controller = new AbortController();
    stream.onAbort(() => controller.abort());

    // Track per-provider in-flight role labels so we can persist them with the
    // matching 'done' message (orchestrator emits role before chunk/done).
    const pendingRoles: Partial<Record<AIProvider, string>> = {};

    const send = (event: SSEEvent) => {
      void stream.writeSSE({
        event: event.type,
        data: JSON.stringify(event),
      });
    };

    // Surface session metadata first so client can update its sidebar
    void stream.writeSSE({
      event: 'session',
      data: JSON.stringify({
        type: 'session',
        sessionId,
        isNew,
      }),
    });

    const recordingSend = (event: SSEEvent) => {
      if (event.type === 'role') {
        pendingRoles[event.provider] = event.label;
      }
      if (event.type === 'done') {
        const role = pendingRoles[event.provider];
        if (role) delete pendingRoles[event.provider];
        const ts = Math.floor(Date.now() / 1000);
        try {
          messageStmts.insert.run(
            sessionId,
            'ai',
            event.provider,
            role ?? null,
            event.text,
            ts,
          );
        } catch (err) {
          console.error('failed to persist ai message', err);
        }
      }
      send(event);
    };

    try {
      await runMode({
        text,
        mode,
        roles,
        modelOverrides,
        attachments: reloadedAttachments,
        tier: user.tier,
        emit: recordingSend,
        signal: controller.signal,
      });
      sessionStmts.touch.run(sessionId);
      send({ type: 'finish' });
    } catch (err) {
      send({
        type: 'error',
        message: (err as Error).message || 'orchestrator failed',
      });
      send({ type: 'finish' });
    }
  });
});
