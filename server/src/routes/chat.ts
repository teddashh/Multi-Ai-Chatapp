import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { randomUUID } from 'node:crypto';
import { requireAuth, type AppVariables } from '../lib/auth.js';
import {
  buildStepList,
  defaultRolesFor,
  runMode,
  type StepResult,
} from '../lib/orchestrator.js';
import { runCLI } from '../lib/cli.js';
import { FREE_DAILY_QUOTA_PER_MODE, resolveModel } from '../shared/models.js';
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

  // Free-tier daily quota: at most FREE_DAILY_QUOTA_PER_MODE user turns
  // per mode per day. Counts user messages in any session of theirs in
  // that mode since today's UTC midnight (server time).
  if (user.tier === 'free') {
    const now = new Date();
    const utcMidnight = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
    );
    const todayStart = Math.floor(utcMidnight / 1000);
    const row = messageStmts.countUserMsgsSince.get(user.id, mode, todayStart) as
      | { c: number }
      | undefined;
    const used = row?.c ?? 0;
    if (used >= FREE_DAILY_QUOTA_PER_MODE) {
      return c.json(
        {
          error: 'quota_exceeded',
          mode,
          used,
          limit: FREE_DAILY_QUOTA_PER_MODE,
          message: '此模式的每日免費額度已用完，請聯絡管理員升級會員等級。',
          messageEn:
            'You have used your free daily quota for this mode. Please contact the admin to upgrade your tier.',
        },
        429,
      );
    }
  }

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
    const rolesJson = roles && mode !== 'free' ? JSON.stringify(roles) : null;
    sessionStmts.insert.run(sessionId, user.id, deriveTitle(text), mode, rolesJson);
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
          const ins = messageStmts.insert.run(
            sessionId,
            'ai',
            event.provider,
            role ?? null,
            event.text,
            ts,
          );
          // Pass the persisted DB row id back to the client so it can use a
          // stable id on retries without needing a session reload.
          send({ ...event, messageId: Number(ins.lastInsertRowid) });
          return;
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
        lang: user.lang,
        userId: user.id,
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

// Re-run an AI message. Free mode: in-place retry of one cell. Sequential
// modes (debate/consult/coding/roundtable): wipe everything from this step
// onward and replay the chain — useful when a CLI hiccup left the chain
// stuck mid-flight.
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

  const userMsg = messageStmts.precedingUser.get(msg.session_id, msgId) as
    | MessageRow
    | undefined;
  if (!userMsg) {
    return c.json({ error: 'preceding user message not found' }, 404);
  }

  const rawAtts = attachmentStmts.listForMessage.all(userMsg.id) as Array<
    Pick<AttachmentRow, 'id'>
  >;
  const attachments = loadAttachments(
    rawAtts.map((a) => a.id),
    user.id,
  );
  const sessionId = msg.session_id;
  const modelOverrides = body.modelOverrides;
  const modeStr = session.mode as ChatMode;

  // === Free mode: just rewrite this one cell in place. ===
  if (modeStr === 'free') {
    const provider = msg.provider as AIProvider;
    const model = resolveModel(user.tier, provider, modelOverrides?.[provider]);
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
          userId: user.id,
          mode: 'free',
        });
        messageStmts.updateContent.run(
          result.text,
          Math.floor(Date.now() / 1000),
          msgId,
        );
        sessionStmts.touch.run(sessionId);
        send({ type: 'done', provider, text: result.text, messageId: msgId });
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
  }

  // === Sequential mode: replay the chain from this step onward. ===
  // Recover roles: prefer the JSON stored at session-create time, fall back
  // to mode defaults (legacy sessions created before the roles_json column).
  let roles: ModeRoles | null = null;
  if (session.roles_json) {
    try {
      roles = JSON.parse(session.roles_json) as ModeRoles;
    } catch {
      roles = null;
    }
  }
  if (!roles) roles = defaultRolesFor(modeStr);
  if (!roles) {
    return c.json({ error: `unsupported mode ${modeStr}` }, 400);
  }
  const steps = buildStepList(modeStr, roles, user.lang);
  if (steps.length === 0) {
    return c.json({ error: 'no steps for mode' }, 400);
  }

  // The chain is the AI messages produced *for this user turn*, in order.
  const allAi = messageStmts.aiAfterUser.all(sessionId, userMsg.id) as MessageRow[];
  const retryIdx = allAi.findIndex((m) => m.id === msgId);
  if (retryIdx < 0) {
    return c.json({ error: 'cannot locate retry target in chain' }, 404);
  }
  if (retryIdx >= steps.length) {
    return c.json({ error: 'retry index past end of step list' }, 400);
  }

  return streamSSE(c, async (stream) => {
    const ctrl = new AbortController();
    stream.onAbort(() => ctrl.abort());
    const send = (event: SSEEvent) =>
      stream.writeSSE({ event: event.type, data: JSON.stringify(event) });

    try {
      // History = everything BEFORE the retry point; trust what's stored.
      const history: StepResult[] = allAi
        .slice(0, retryIdx)
        .map((m, i) => ({
          provider: m.provider as AIProvider,
          modeRole: m.mode_role ?? steps[i].label,
          text: m.content,
        }));

      // Wipe the retry message and everything after it — the replay will
      // re-insert each step with fresh content.
      messageStmts.deleteAfter.run(sessionId, msgId);

      for (let i = retryIdx; i < steps.length; i++) {
        const step = steps[i];
        send({ type: 'workflow', status: step.workflowStatus });
        send({
          type: 'role',
          provider: step.provider,
          role: step.role,
          label: step.label,
        });
        const prompt = step.buildPrompt(userMsg.content, history);
        const finalPrompt =
          attachments.length > 0
            ? buildAttachmentPrefix(attachments) + prompt
            : prompt;
        const model = resolveModel(
          user.tier,
          step.provider,
          modelOverrides?.[step.provider],
        );

        let stepText = '';
        try {
          const result = await runCLI({
            provider: step.provider,
            model,
            prompt: finalPrompt,
            attachments,
            signal: ctrl.signal,
            onChunk: (text) => {
              void send({ type: 'chunk', provider: step.provider, text });
            },
            userId: user.id,
            mode: modeStr,
          });
          stepText = result.text;
        } catch (err) {
          const message = (err as Error).message;
          send({ type: 'error', provider: step.provider, message });
          stepText = `[Error: ${message}]`;
          // Persist the failure so the retry button has a target next time.
          const failIns = messageStmts.insert.run(
            sessionId,
            'ai',
            step.provider,
            step.label,
            stepText,
            Math.floor(Date.now() / 1000),
          );
          send({
            type: 'done',
            provider: step.provider,
            text: stepText,
            messageId: Number(failIns.lastInsertRowid),
          });
          throw err;
        }

        const okIns = messageStmts.insert.run(
          sessionId,
          'ai',
          step.provider,
          step.label,
          stepText,
          Math.floor(Date.now() / 1000),
        );
        send({
          type: 'done',
          provider: step.provider,
          text: stepText,
          messageId: Number(okIns.lastInsertRowid),
        });
        history.push({
          provider: step.provider,
          modeRole: step.label,
          text: stepText,
        });
      }
      sessionStmts.touch.run(sessionId);
      send({ type: 'workflow', status: '' });
      send({ type: 'finish' });
    } catch (err) {
      send({ type: 'workflow', status: '' });
      send({
        type: 'error',
        message: (err as Error).message || 'resume failed',
      });
      send({ type: 'finish' });
    }
  });
});
