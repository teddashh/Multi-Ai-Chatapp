// Blog cron — every 6 hours, one AI persona picks an uncovered
// forum post and writes a blog about it. Rotates Claude → Gemini
// → Grok → Codex (chatgpt) so over a 24h cycle each AI has covered
// one post. Result: ~4 blog posts per day, evenly distributed.
//
// Self-rescheduling setTimeout pattern (matches autoDebateScheduler).
// Prod-only — dev (PROVIDER_MODE=cli) skips so manual tuning doesn'\''t
// fight the cron.

import { runOneBlogCycle } from './blogPost.js';
import { getBotUserId } from './autoDebate.js';
import type { AIProvider } from '../shared/types.js';

const SUCCESS_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h between blogs
const RETRY_INTERVAL_MS = 60 * 60 * 1000; // 1h on fail
const FIRST_TICK_DELAY_MS = 8 * 60 * 1000; // 8 min after boot (offset
//                                            from auto-debate cron'\''s
//                                            5 min so they don'\''t
//                                            collide on first run)

// Round-robin order. Persisted across server restarts via a simple
// in-DB counter (audit_log row count for blog_generate_done is good
// enough — modulo 4 gives the next provider).
const ROTATION: AIProvider[] = ['claude', 'gemini', 'grok', 'chatgpt'];

let nextTimer: NodeJS.Timeout | null = null;
let cycleIndex = 0; // local counter; resets on restart but rotation
//                     still walks evenly across the 4 providers.

async function tick(): Promise<void> {
  const provider = ROTATION[cycleIndex % ROTATION.length];
  console.log(`[blog-cron] tick — provider=${provider}`);
  try {
    const botId = getBotUserId();
    const blogId = await runOneBlogCycle(provider, botId);
    cycleIndex++;
    if (blogId === null) {
      console.log(
        `[blog-cron] ${provider} skipped (no uncovered posts) — next provider in 6h`,
      );
    }
    schedule(SUCCESS_INTERVAL_MS);
  } catch (err) {
    console.warn(
      `[blog-cron] ${provider} failed (${(err as Error).message}) — retrying in 1h with same provider`,
    );
    // Don'\''t advance cycleIndex — same provider gets retried.
    schedule(RETRY_INTERVAL_MS);
  }
}

function schedule(delayMs: number): void {
  if (nextTimer) clearTimeout(nextTimer);
  nextTimer = setTimeout(() => {
    void tick();
  }, delayMs);
  const wakeAt = new Date(Date.now() + delayMs);
  console.log(`[blog-cron] next tick at ${wakeAt.toISOString()}`);
}

export function startBlogScheduler(): void {
  const mode = (process.env.PROVIDER_MODE ?? 'cli').toLowerCase();
  if (mode !== 'api') {
    console.log(`[blog-cron] disabled (PROVIDER_MODE=${mode}, prod-only)`);
    return;
  }
  console.log(
    `[blog-cron] starting; first tick in ${FIRST_TICK_DELAY_MS / 60000} min`,
  );
  schedule(FIRST_TICK_DELAY_MS);
}

export function fireBlogCycleNow(): void {
  void tick();
}
