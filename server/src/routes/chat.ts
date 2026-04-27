import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { randomUUID } from 'node:crypto';
import { requireAuth, type AppVariables } from '../lib/auth.js';
import { runMode } from '../lib/orchestrator.js';
import { runCLI } from '../lib/cli.js';
import { resolveModel } from '../shared/models.js';
import {
  attachmentStmts,
  messageStmts,
  sessionStmts,
  type AttachmentRow,
  type MessageRow,
  type SessionRow,
} from '../lib/db.js';
import {
  buildAttachmentPrefix,
  loadAttachments,
  relocateToSession,
  saveUpload,
  type PreparedAttachment,
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

// Re-run a single AI message. V1 supports Free mode only (each AI is
// independent there). For sequential modes the response is part of a chain so
// we'd have to also re-run downstream — out of scope for this iteration.
chatRoute.post('/regenerate', requireAuth, async (c) => {
  const user = c.get('user');
  const body = (await c.req.json().catch(() => null)) as
    | {
        messageId?: string | number;
        modelOverrides?: Partial<Record<AIProvider, string>>;
      }
    | null;
  if (!body?.messageId) {
    return c.json({ error: 'messageId required' }, 400);
  }
  const msgId = Number(body.messageId);
  if (!Number.isFinite(msgId)) {
    return c.json({ error: 'invalid messageId' }, 400);
  }

  const msg = messageStmts.findById.get(msgId) as MessageRow | undefined;
  if (!msg || msg.role !== 'ai' || !msg.provider) {
    return c.json({ error: 'AI message not found' }, 404);
  }

  const session = sessionStmts.findOwned.get(msg.session_id, user.id) as
    | SessionRow
    | undefined;
  if (!session) {
    return c.json({ error: 'session not found' }, 404);
  }

  if (session.mode !== 'free') {
    return c.json(
      {
        error:
          '只有自由模式支援單獨重新作答，序列模式的回覆是接力的，得整段重跑',
      },
      400,
    );
  }

  const userMsg = messageStmts.precedingUser.get(msg.session_id, msgId) as
    | MessageRow
    | undefined;
  if (!userMsg) {
    return c.json({ error: 'preceding user message not found' }, 404);
  }

  // Load attachments tied to that user message.
  const rawAtts = attachmentStmts.listForMessage.all(userMsg.id) as Array<
    Pick<AttachmentRow, 'id'>
  >;
  const attachments: PreparedAttachment[] = loadAttachments(
    rawAtts.map((a) => a.id),
    user.id,
  );

  const provider = msg.provider as AIProvider;
  const model = resolveModel(user.tier, provider, body.modelOverrides?.[provider]);
  const prompt =
    attachments.length > 0
      ? buildAttachmentPrefix(attachments) + userMsg.content
      : userMsg.content;

  return streamSSE(c, async (stream) => {
    const ctrl = new AbortController();
    stream.onAbort(() => ctrl.abort());
    const send = (event: SSEEvent) =>
      stream.writeSSE({ event: event.type, data: JSON.stringify(event) });

    try {
      const result = await runCLI({
        provider,
        model,
        prompt,
        attachments,
        signal: ctrl.signal,
        onChunk: (text) => {
          void send({ type: 'chunk', provider, text });
        },
      });
      messageStmts.updateContent.run(
        result.text,
        Math.floor(Date.now() / 1000),
        msgId,
      );
      sessionStmts.touch.run(msg.session_id);
      send({ type: 'done', provider, text: result.text });
      send({ type: 'finish' });
    } catch (err) {
      send({
        type: 'error',
        provider,
        message: (err as Error).message || 'regenerate failed',
      });
      send({ type: 'finish' });
    }
  });
});
