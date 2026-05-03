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
import {
  runMode,
  runOne,
  buildStepList,
  DEFAULT_ROUNDTABLE_ROLES,
  type StepResult,
} from './orchestrator.js';
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

  const postId = promoteSessionToForumPost(
    sessionId,
    userId,
    initialTitle,
    input.category,
  );
  return { sessionId, postId, steps: stepCount };
}

// Shared share-to-forum step. Mirrors the /share happy path for a
// brand-new session: insert anonymous forum_post with the first user
// message as body, import every other message as a comment, then
// fire-and-forget the existing summary + infograph pipeline.
function promoteSessionToForumPost(
  sessionId: string,
  userId: number,
  title: string,
  category: ForumCategory,
): number {
  const messages = messageStmts.listForSession.all(sessionId) as MessageRow[];
  const firstUserIdx = messages.findIndex((m) => m.role === 'user');
  if (firstUserIdx < 0) {
    throw new Error('session has no user message to anchor the post');
  }
  const firstUser = messages[firstUserIdx];
  const rest = messages.slice(firstUserIdx + 1);

  let postId = 0;
  const tx = db.transaction(() => {
    const result = forumStmts.insertPost.run(
      category,
      sessionId,
      'roundtable',
      title,
      firstUser.content,
      userId,
      1, // is_anonymous — bot identity stays hidden
      null,
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
        m.role === 'user' ? 1 : 0,
        1,
        m.id,
        m.timestamp,
      );
    }
    forumStmts.setCommentCount.run(rest.length, postId);
  });
  tx();

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

  const post = forumStmts.findPostById.get(postId) as ForumPostRow | undefined;
  if (!post) throw new Error('forum post insert lost');
  return postId;
}

// Pick up an interrupted bot roundtable session — server restart
// killed runMode mid-stream, leaving N < 20 AI msgs. Re-runs only the
// remaining steps using existing msgs as history, then promotes to a
// forum post the same way a fresh runAutoDebate would.
//
// Caller passes (or we look up) the session id; we figure out the
// first missing step from the AI message count and the deterministic
// roundtable schedule (5 rounds × 4 speakers in DEFAULT_ROUNDTABLE_ROLES
// order). Tolerates non-default speaker orderings by reading the
// session's stored roles_json.
export interface ResumeResult {
  sessionId: string;
  postId: number;
  resumed: number; // how many steps we re-ran
  total: number; // how many steps the chain has total (always 20 for roundtable)
}

export async function resumeAutoDebate(
  sessionId: string,
  category: ForumCategory,
): Promise<ResumeResult> {
  const session = sessionStmts.findById.get(sessionId) as
    | { id: string; user_id: number; mode: string; title: string; roles_json: string | null }
    | undefined;
  if (!session) throw new Error(`session not found: ${sessionId}`);
  if (session.mode !== 'roundtable') {
    throw new Error(`only roundtable can be resumed, got mode=${session.mode}`);
  }

  // Already promoted to a post? Refuse — caller should pick a different
  // path (probably noop / surface the existing post id).
  const existingPost = forumStmts.findPostBySession.get(sessionId) as
    | ForumPostRow
    | undefined;
  if (existingPost) {
    return {
      sessionId,
      postId: existingPost.id,
      resumed: 0,
      total: 20,
    };
  }

  const roles = (session.roles_json
    ? (JSON.parse(session.roles_json) as typeof DEFAULT_ROUNDTABLE_ROLES)
    : DEFAULT_ROUNDTABLE_ROLES);
  const steps = buildStepList('roundtable', roles, 'zh-TW');

  const messages = messageStmts.listForSession.all(sessionId) as MessageRow[];
  const userMsg = messages.find((m) => m.role === 'user');
  if (!userMsg) throw new Error('session has no user message');
  const aiMsgs = messages.filter((m) => m.role === 'ai');
  const startFrom = aiMsgs.length; // 0-indexed step to resume at

  if (startFrom >= steps.length) {
    // Already complete — just promote.
    const postId = promoteSessionToForumPost(
      sessionId,
      session.user_id,
      session.title,
      category,
    );
    return { sessionId, postId, resumed: 0, total: steps.length };
  }

  // Build the StepResult history from existing AI msgs so the next
  // step's buildPrompt sees the same context the original chain had.
  const history: StepResult[] = aiMsgs.map((m, i) => ({
    provider: steps[i].provider,
    modeRole: steps[i].label,
    text: m.content,
  }));

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 30 * 60_000);

  try {
    for (let i = startFrom; i < steps.length; i++) {
      if (ctrl.signal.aborted) break;
      const step = steps[i];
      const prompt = step.buildPrompt(userMsg.content, history);
      let text: string;
      try {
        text = await runOne(
          {
            text: userMsg.content,
            mode: 'roundtable',
            roles,
            tier: 'admin',
            lang: 'zh-TW',
            userId: session.user_id,
            sessionId,
            emit: () => {},
            signal: ctrl.signal,
          },
          step.provider,
          prompt,
        );
      } catch (err) {
        if (ctrl.signal.aborted) break;
        console.error(
          `[auto-debate] resume step ${i} (${step.provider}/${step.label}) failed:`,
          (err as Error).message,
        );
        text = `[step ${step.label} 失敗：${(err as Error).message}]`;
      }
      const ts = Math.floor(Date.now() / 1000);
      messageStmts.insert.run(
        sessionId,
        'ai',
        step.provider,
        step.label,
        text,
        ts,
      );
      history.push({
        provider: step.provider,
        modeRole: step.label,
        text,
      });
    }
  } finally {
    clearTimeout(timeout);
  }
  sessionStmts.touch.run(sessionId);

  const postId = promoteSessionToForumPost(
    sessionId,
    session.user_id,
    session.title,
    category,
  );
  return {
    sessionId,
    postId,
    resumed: steps.length - startFrom,
    total: steps.length,
  };
}
