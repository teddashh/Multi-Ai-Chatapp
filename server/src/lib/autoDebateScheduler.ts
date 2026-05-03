// Auto-debate scheduler — every 6 hours fires one debate in a random
// category, populating the forum without manual intervention. Self-
// rescheduling setTimeout (not setInterval) so failed runs retry
// after 1 h while successes wait the full 6 h.
//
// Prod-only. Dev (PROVIDER_MODE=cli) skips because the operator runs
// debates manually there for tuning.
//
// Saturation guard: bot user has 24h post quota — if it'\''s already
// produced ≥ MAX_POSTS_PER_DAY posts in the last day, skip this
// iteration and reschedule normally.

import { db } from './db.js';
import { discoverTopic, runAutoDebate } from './autoDebate.js';
import { FORUM_CATEGORIES, type ForumCategory } from '../shared/types.js';

const SUCCESS_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h
const RETRY_INTERVAL_MS = 60 * 60 * 1000; // 1h
const FIRST_TICK_DELAY_MS = 5 * 60 * 1000; // 5 min after boot
const MAX_POSTS_PER_DAY = 4;

const BOT_USERNAME = 'bot';

let nextTimer: NodeJS.Timeout | null = null;

function botPostsLast24h(): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM forum_posts
       WHERE author_user_id = (SELECT id FROM users WHERE username = ?)
         AND created_at > strftime('%s','now') - 86400`,
    )
    .get(BOT_USERNAME) as { n: number } | undefined;
  return row?.n ?? 0;
}

function pickCategory(): ForumCategory {
  const idx = Math.floor(Math.random() * FORUM_CATEGORIES.length);
  return FORUM_CATEGORIES[idx];
}

async function tick(): Promise<void> {
  const recent = botPostsLast24h();
  if (recent >= MAX_POSTS_PER_DAY) {
    console.log(
      `[auto-debate-cron] skip — bot already has ${recent}/${MAX_POSTS_PER_DAY} posts in last 24h`,
    );
    schedule(SUCCESS_INTERVAL_MS);
    return;
  }
  const category = pickCategory();
  console.log(`[auto-debate-cron] tick — category=${category}`);
  try {
    const discovered = await discoverTopic(category);
    console.log(
      `[auto-debate-cron] discovered title="${discovered.title}", running debate…`,
    );
    const result = await runAutoDebate({
      topic: discovered.topic,
      category,
      title: discovered.title,
    });
    console.log(
      `[auto-debate-cron] success — postId=${result.postId} steps=${result.steps}`,
    );
    schedule(SUCCESS_INTERVAL_MS);
  } catch (err) {
    console.warn(
      `[auto-debate-cron] failed (${(err as Error).message}) — retrying in 1h`,
    );
    schedule(RETRY_INTERVAL_MS);
  }
}

function schedule(delayMs: number): void {
  if (nextTimer) clearTimeout(nextTimer);
  nextTimer = setTimeout(() => {
    void tick();
  }, delayMs);
  const wakeAt = new Date(Date.now() + delayMs);
  console.log(`[auto-debate-cron] next tick at ${wakeAt.toISOString()}`);
}

// Boot the scheduler. Called from server entry only when PROVIDER_MODE
// resolves to 'api' (i.e., prod). Dev manual-trigger is enough for
// tuning the prompt without burning quota every 6h.
export function startAutoDebateScheduler(): void {
  const mode = (process.env.PROVIDER_MODE ?? 'cli').toLowerCase();
  if (mode !== 'api') {
    console.log(
      `[auto-debate-cron] disabled (PROVIDER_MODE=${mode}, prod-only)`,
    );
    return;
  }
  console.log(
    `[auto-debate-cron] starting; first tick in ${FIRST_TICK_DELAY_MS / 60000} min`,
  );
  schedule(FIRST_TICK_DELAY_MS);
}

// Manual one-shot fire for admin testing. Returns immediately; the
// debate runs in the background. Caller logs the result via existing
// console output / audit.
export function fireAutoDebateNow(): void {
  void tick();
}
