// Auto-debate orchestrator. Spawns a 5-round 4-AI roundtable session
// owned by the system "bot" user, then promotes it to a forum post
// (anonymous) so the existing summary + infographic pipeline kicks in.
//
// Main entry: runAutoDebate({ topic, category }). Caller is admin
// endpoint or the every-6h cron (later).
//
// The bot user is auto-created on first call. Its sessions belong to
// it (not Ted's admin user) so admin sidebar stays clean.

import { randomUUID } from 'node:crypto';
import {
  db,
  forumStmts,
  messageStmts,
  sessionStmts,
  userStmts,
  type ForumPostRow,
  type MessageRow,
  type UserRow,
} from './db.js';
import { runMode, DEFAULT_ROUNDTABLE_ROLES } from './orchestrator.js';
import {
  generateShareSummary,
  generateInfographic,
} from '../routes/forum.js';
import type { ForumCategory, SSEEvent, AIProvider } from '../shared/types.js';

const BOT_USERNAME = 'bot';
const BOT_NICKNAME = 'AI 編輯部';

// Bcrypt-shaped string that can never match a real password — login
// attempts go through bcrypt.compare which returns false on malformed
// hashes. Belt-and-suspenders alongside `disabled_at`.
const NEVER_LOGIN_HASH = '$2b$12$' + 'X'.repeat(53);

let cachedBotUserId: number | null = null;

function getBotUserId(): number {
  if (cachedBotUserId !== null) return cachedBotUserId;

  const existing = userStmts.findByUsername.get(BOT_USERNAME) as
    | UserRow
    | undefined;
  if (existing) {
    cachedBotUserId = existing.id;
    return existing.id;
  }

  // First-run init. Tier=admin so all models work; disabled_at set so
  // login is permanently blocked even though the user row exists.
  // Username 'bot' is in the reserved list (see SCHEMA) so no human
  // can ever register over it.
  const insertWithFields = db.prepare(
    `INSERT INTO users
       (username, nickname, password_hash, tier, theme, email_verified, disabled_at)
     VALUES (?, ?, ?, 'admin', 'spring', 1, 1)`,
  );
  insertWithFields.run(
    BOT_USERNAME,
    BOT_NICKNAME,
    NEVER_LOGIN_HASH,
  );
  const created = userStmts.findByUsername.get(BOT_USERNAME) as UserRow;
  cachedBotUserId = created.id;
  console.log(`[auto-debate] created bot user id=${created.id}`);
  return created.id;
}

interface AutoDebateInput {
  topic: string;
  category: ForumCategory;
  // Optional: override the default roundtable order. Defaults to
  // claude → gemini → grok → chatgpt.
  roles?: { first: AIProvider; second: AIProvider; third: AIProvider; fourth: AIProvider };
  // Optional: post title. Defaults to the topic itself trimmed to 60.
  title?: string;
}

export interface AutoDebateResult {
  sessionId: string;
  postId: number;
  steps: number;
}

// Drives a complete auto-debate end-to-end. Synchronous as far as
// roundtable + post insert; auto-summary + infograph fire-and-forget
// after return so the caller doesn't wait the ~30-60s image gen.
export async function runAutoDebate(
  input: AutoDebateInput,
): Promise<AutoDebateResult> {
  const userId = getBotUserId();
  const roles = input.roles ?? DEFAULT_ROUNDTABLE_ROLES;

  // Create the chat session as the bot.
  const sessionId = randomUUID();
  const initialTitle =
    (input.title ?? input.topic).slice(0, 60).trim() || '(untitled)';
  sessionStmts.insert.run(
    sessionId,
    userId,
    initialTitle,
    'roundtable',
    JSON.stringify(roles),
  );

  // The topic prompt is the user message that anchors the debate.
  const now = Math.floor(Date.now() / 1000);
  messageStmts.insert.run(sessionId, 'user', null, null, input.topic, now);

  // Run roundtable. emit() persists each AI message exactly the way
  // /send's recordingSend does. No SSE clients to broadcast to —
  // we're a backend job.
  const pendingRoles: Partial<Record<AIProvider, string>> = {};
  let stepCount = 0;
  const persistOnDone = (event: SSEEvent) => {
    if (event.type === 'role') {
      pendingRoles[event.provider] = event.label;
    }
    if (event.type === 'done') {
      const role = pendingRoles[event.provider];
      if (role) delete pendingRoles[event.provider];
      if (event.messageId !== undefined) return; // already persisted upstream
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
        const msgId = Number(ins.lastInsertRowid);
        if (event.answeredStage || event.answeredModel || event.requestedModel) {
          messageStmts.setAnswered.run(
            event.answeredStage ?? null,
            event.answeredModel ?? null,
            event.requestedModel ?? null,
            msgId,
          );
        }
        stepCount++;
      } catch (err) {
        console.error('[auto-debate] persist failed', (err as Error).message);
      }
    }
  };

  const ctrl = new AbortController();
  // Generous timeout — 5 rounds × 4 AIs × ~30s each = ~10 min worst case.
  const timeout = setTimeout(() => ctrl.abort(), 30 * 60_000);
  try {
    await runMode({
      text: input.topic,
      mode: 'roundtable',
      roles,
      tier: 'admin',
      lang: 'zh-TW',
      userId,
      sessionId,
      emit: persistOnDone,
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
  sessionStmts.touch.run(sessionId);

  // Promote session to a forum post (mirrors /share happy path for
  // a brand-new session). Anonymous so the bot's name doesn't leak.
  const messages = messageStmts.listForSession.all(sessionId) as MessageRow[];
  const firstUserIdx = messages.findIndex((m) => m.role === 'user');
  if (firstUserIdx < 0) {
    throw new Error('auto-debate session ended with no user message');
  }
  const firstUser = messages[firstUserIdx];
  const rest = messages.slice(firstUserIdx + 1);

  let postId = 0;
  const tx = db.transaction(() => {
    const result = forumStmts.insertPost.run(
      input.category,
      sessionId,
      'roundtable',
      initialTitle,
      firstUser.content,
      userId,
      1, // is_anonymous
      null, // ai_persona — roundtable mode has no profession persona
    );
    postId = Number(result.lastInsertRowid);
    for (const m of rest) {
      forumStmts.insertComment.run(
        postId,
        m.role === 'user' ? 'user' : 'ai',
        m.role === 'user' ? userId : null,
        m.role === 'ai' ? m.provider : null,
        m.role === 'ai' ? m.answered_model ?? m.requested_model ?? null : null,
        m.content,
        m.role === 'user' ? 1 : 0, // anonymous flag inherited from post
        1, // is_imported
        m.id,
        m.timestamp,
      );
    }
    forumStmts.setCommentCount.run(rest.length, postId);
  });
  tx();

  // Fire-and-forget the existing post-share enrichment pipeline:
  // Gemini summary → gpt-image-2 infograph. Same as POST /share.
  void (async () => {
    try {
      await generateShareSummary(postId);
      await generateInfographic(postId, { uploadedByUserId: userId });
    } catch (err) {
      console.warn(
        '[auto-debate] post-share enrichment failed:',
        (err as Error).message,
      );
    }
  })();

  // Make sure we don't return the post id before findPostById would
  // see it (transaction is sync so this is just defensive).
  const post = forumStmts.findPostById.get(postId) as ForumPostRow | undefined;
  if (!post) throw new Error('auto-debate post insert lost');

  return { sessionId, postId, steps: stepCount };
}
