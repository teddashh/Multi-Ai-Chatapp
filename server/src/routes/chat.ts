import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { requireAuth, type AppVariables } from '../lib/auth.js';
import { runMode } from '../lib/orchestrator.js';
import type { AIProvider, ChatMode, ModeRoles, SSEEvent } from '../shared/types.js';

export const chatRoute = new Hono<{ Variables: AppVariables }>();

chatRoute.post('/send', requireAuth, async (c) => {
  const user = c.get('user');
  const body = (await c.req.json().catch(() => null)) as
    | {
        text?: string;
        mode?: ChatMode;
        roles?: ModeRoles;
        modelOverrides?: Partial<Record<AIProvider, string>>;
      }
    | null;

  if (!body?.text || !body?.mode) {
    return c.json({ error: 'text and mode required' }, 400);
  }

  const text = body.text;
  const mode = body.mode;
  const roles = body.roles;
  const modelOverrides = body.modelOverrides;

  return streamSSE(c, async (stream) => {
    const controller = new AbortController();
    // If the client disconnects, abort the orchestrator chain
    stream.onAbort(() => controller.abort());

    const send = (event: SSEEvent) => {
      void stream.writeSSE({
        event: event.type,
        data: JSON.stringify(event),
      });
    };

    try {
      await runMode({
        text,
        mode,
        roles,
        modelOverrides,
        tier: user.tier,
        emit: send,
        signal: controller.signal,
      });
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
