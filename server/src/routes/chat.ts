import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { randomUUID } from 'node:crypto';
import { requireAuth, type AppVariables } from '../lib/auth.js';
import {
  buildPerProviderHistory,
  buildStepList,
  defaultRolesFor,
  failureText,
  runMode,
  type StepResult,
} from '../lib/orchestrator.js';
import { runCLI } from '../lib/cli.js';
import { FREE_DAILY_QUOTA_PER_MODE, resolveModel } from '../shared/models.js';
import {
  attachmentStmts,
  messageStmts,
  sessionStmts,
  userStmts,
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

// Per-session AbortController so an explicit "stop" or admin kill can
// cancel an in-flight orchestrator run. NOT tied to SSE lifecycle —
// disconnecting the stream (e.g., backgrounding the tab on iOS) no
// longer aborts the chain. The chain runs to completion server-side and
// persists each step; the next time the client reconnects it can pull
// the fresh state via GET /api/sessions/:id.
const sessionAborters = new Map<string, AbortController>();
// Hard ceiling so a runaway chain can't burn forever if the client
// genuinely walked away.
const RUN_TIMEOUT_MS = 30 * 60 * 1000;

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
  // Block unverified accounts before they can rack up usage.
  const fullUser = userStmts.findById.get(user.id) as { email_verified: number } | undefined;
  if (fullUser && !fullUser.email_verified) {
    return c.json(
      {
        error: 'email_not_verified',
        message: '請先到信箱點驗證連結，才能使用對話功能。',
        messageEn:
          'Please verify your email before using chat. Check your inbox for the verification link.',
      },
      403,
    );
  }
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
    // Reuse any controller already running for this session, or start a
    // fresh one. Subsequent sends to the same session would be unusual
    // (one chain per session at a time), but if it happens we let the
    // newer one win.
    const previousAborter = sessionAborters.get(sessionId);
    if (previousAborter) previousAborter.abort();
    const controller = new AbortController();
    sessionAborters.set(sessionId, controller);
    const runTimeout = setTimeout(() => controller.abort(), RUN_TIMEOUT_MS);

    // NOTE: deliberately NOT calling stream.onAbort(controller.abort).
    // SSE drops (tab backgrounded, network blip) shouldn't kill the
    // chain — let the orchestrator keep running and persisting; the
    // client recovers by reloading the session.

    // Track per-provider in-flight role labels so we can persist them with the
    // matching 'done' message (orchestrator emits role before chunk/done).
    const pendingRoles: Partial<Record<AIProvider, string>> = {};

    const send = (event: SSEEvent) => {
      // Writes after disconnect just no-op — they fail silently and we
      // keep going. Wrap to swallow any rejection.
      void stream.writeSSE({
        event: event.type,
        data: JSON.stringify(event),
      }).catch(() => {});
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

    // Load earlier turns for memory continuity. We use per-provider
    // history for *both* Free and Sequential modes — each AI sees its
    // own past replies plus every user question. Cross-AI awareness
    // across turns is sacrificed on purpose: leaking other agents'
    // round labels ("第二輪") into the next turn's prompt was tripping
    // the new round into mimicking the old structure. Each AI keeps
    // its own thread; multi-agent dialogue still happens *within* a
    // turn via the step pipeline.
    const priorMsgs = (messageStmts.listForSession.all(sessionId) as MessageRow[])
      .filter((m) => m.id < userMsgId);
    const perProviderHistory = buildPerProviderHistory(priorMsgs);

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
        sessionId,
        history: perProviderHistory,
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
    } finally {
      clearTimeout(runTimeout);
      if (sessionAborters.get(sessionId) === controller) {
        sessionAborters.delete(sessionId);
      }
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
    // Prior turns of THIS provider's thread (everything before the user
    // message we're retrying against).
    const priorMsgs = (messageStmts.listForSession.all(sessionId) as MessageRow[])
      .filter((m) => m.id < userMsg.id);
    const perProviderHistory = buildPerProviderHistory(priorMsgs);

    return streamSSE(c, async (stream) => {
      const previous = sessionAborters.get(sessionId);
      if (previous) previous.abort();
      const ctrl = new AbortController();
      sessionAborters.set(sessionId, ctrl);
      const runTimeout = setTimeout(() => ctrl.abort(), RUN_TIMEOUT_MS);
      const send = (event: SSEEvent) =>
        stream
          .writeSSE({ event: event.type, data: JSON.stringify(event) })
          .catch(() => {});

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
          history: perProviderHistory[provider],
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
      } finally {
        clearTimeout(runTimeout);
        if (sessionAborters.get(sessionId) === ctrl) {
          sessionAborters.delete(sessionId);
        }
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

  // Cross-turn memory: each provider sees its own past thread. Same
  // shape as the /send path so retries inherit the same context.
  const priorMsgs = (messageStmts.listForSession.all(sessionId) as MessageRow[])
    .filter((m) => m.id < userMsg.id);
  const perProviderHistory = buildPerProviderHistory(priorMsgs);
  const userText = userMsg.content;

  return streamSSE(c, async (stream) => {
    const previous = sessionAborters.get(sessionId);
    if (previous) previous.abort();
    const ctrl = new AbortController();
    sessionAborters.set(sessionId, ctrl);
    const runTimeout = setTimeout(() => ctrl.abort(), RUN_TIMEOUT_MS);
    const send = (event: SSEEvent) =>
      stream
        .writeSSE({ event: event.type, data: JSON.stringify(event) })
        .catch(() => {});

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
        const prompt = step.buildPrompt(userText, history);
        const finalPrompt =
          attachments.length > 0
            ? buildAttachmentPrefix(attachments) + prompt
            : prompt;
        const model = resolveModel(
          user.tier,
          step.provider,
          modelOverrides?.[step.provider],
        );

        // Resilient resume: one step failing shouldn't break the rest of
        // the chain. Failed steps still get persisted (so the user can
        // retry just that one), but we substitute a placeholder into the
        // running history so downstream prompts don't read "[Error:…]"
        // as if it were a real argument.
        if (ctrl.signal.aborted) break;
        let stepText = '';
        let stepFailed = false;
        let persistedId = 0;
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
            history: perProviderHistory[step.provider],
          });
          stepText = result.text;
        } catch (err) {
          if (ctrl.signal.aborted) break;
          const message = (err as Error).message;
          send({ type: 'error', provider: step.provider, message });
          stepText = failureText(user.lang);
          stepFailed = true;
        }

        const ins = messageStmts.insert.run(
          sessionId,
          'ai',
          step.provider,
          step.label,
          stepText,
          Math.floor(Date.now() / 1000),
        );
        persistedId = Number(ins.lastInsertRowid);
        send({
          type: 'done',
          provider: step.provider,
          text: stepText,
          messageId: persistedId,
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
    } finally {
      clearTimeout(runTimeout);
      if (sessionAborters.get(sessionId) === ctrl) {
        sessionAborters.delete(sessionId);
      }
    }
  });
});

// Explicit abort — used by the client's "Stop" button. Disconnecting the
// SSE stream alone no longer aborts (so backgrounded tabs don't kill the
// chain), so we need a real way for users to say "stop now please".
chatRoute.post('/abort/:sessionId', requireAuth, (c) => {
  const user = c.get('user');
  const sessionId = c.req.param('sessionId') ?? '';
  if (!sessionId) return c.json({ error: 'sessionId required' }, 400);
  // Confirm the session belongs to the caller — don't let one user abort
  // another's chain.
  const owned = sessionStmts.findOwned.get(sessionId, user.id);
  if (!owned) return c.json({ error: 'not found' }, 404);
  const ctrl = sessionAborters.get(sessionId);
  if (ctrl) ctrl.abort();
  return c.json({ ok: true, aborted: !!ctrl });
});
