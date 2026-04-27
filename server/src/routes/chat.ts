import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { randomUUID } from 'node:crypto';
import { requireAuth, type AppVariables } from '../lib/auth.js';
import { runMode } from '../lib/orchestrator.js';
import {
  messageStmts,
  sessionStmts,
  type SessionRow,
} from '../lib/db.js';
import type { AIProvider, ChatMode, ModeRoles, SSEEvent } from '../shared/types.js';

export const chatRoute = new Hono<{ Variables: AppVariables }>();

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
      }
    | null;

  if (!body?.text || !body?.mode) {
    return c.json({ error: 'text and mode required' }, 400);
  }

  const text = body.text;
  const mode = body.mode;
  const roles = body.roles;
  const modelOverrides = body.modelOverrides;

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
  messageStmts.insert.run(sessionId, 'user', null, null, text, now);

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
