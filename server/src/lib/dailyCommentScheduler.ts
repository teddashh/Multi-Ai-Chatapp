// Daily-comment cron — every 24h fires one AI'\''s comment cycle. Over
// 4 days each AI has dropped a pair of comments. Self-rescheduling
// setTimeout (matches autoDebate / blog patterns).
//
// Spreading 4 AIs across 4 days (instead of all 4 in one day) keeps
// the forum'\''s recent-comments feed fresh-looking every day rather
// than spiking once a week.
//
// Prod-only.

import { runDailyCommentCycle } from './dailyComment.js';
import { getBotUserId } from './autoDebate.js';
import type { AIProvider } from '../shared/types.js';

const SUCCESS_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h
const RETRY_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2h on fail
const FIRST_TICK_DELAY_MS = 12 * 60 * 1000; // 12 min after boot
//                                            (offset from autoDebate
//                                            5 min and blog 8 min)

const ROTATION: AIProvider[] = ['claude', 'gemini', 'grok', 'chatgpt'];

let nextTimer: NodeJS.Timeout | null = null;
let cycleIndex = 0;

async function tick(): Promise<void> {
  const provider = ROTATION[cycleIndex % ROTATION.length];
  console.log(`[daily-comment-cron] tick — provider=${provider}`);
  try {
    const botId = getBotUserId();
    await runDailyCommentCycle(provider, botId);
    cycleIndex++;
    schedule(SUCCESS_INTERVAL_MS);
  } catch (err) {
    console.warn(
      `[daily-comment-cron] ${provider} failed (${(err as Error).message}) — retry 2h`,
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
  console.log(`[daily-comment-cron] next tick at ${wakeAt.toISOString()}`);
}

export function startDailyCommentScheduler(): void {
  const mode = (process.env.PROVIDER_MODE ?? 'cli').toLowerCase();
  if (mode !== 'api') {
    console.log(
      `[daily-comment-cron] disabled (PROVIDER_MODE=${mode}, prod-only)`,
    );
    return;
  }
  console.log(
    `[daily-comment-cron] starting; first tick in ${FIRST_TICK_DELAY_MS / 60000} min`,
  );
  schedule(FIRST_TICK_DELAY_MS);
}

export function fireDailyCommentCycleNow(): void {
  void tick();
}
