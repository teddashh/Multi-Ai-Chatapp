// Hourly digest of model_fallback events. Skipped silently when there
// are no events in the window, so admins only hear from us when
// something actually fell back. Each instance (prod/dev) runs its own
// timer and tags its emails accordingly.

import { auditStmts, userStmts } from './db.js';
import { sendFallbackDigest, type FallbackDigestRow } from './mail.js';

const ONE_HOUR_MS = 60 * 60 * 1000;

interface AdminRow {
  email: string;
  nickname: string | null;
  real_name: string | null;
  username: string;
}

interface AuditRow {
  id: number;
  target_session_id: string | null;
  metadata: string | null;
  timestamp: number;
  user_username: string | null;
  user_email: string | null;
}

function detectInstance(): 'prod' | 'dev' {
  // Two signals: PROVIDER_MODE was set explicitly per-instance during
  // the dev/prod split, and PUBLIC_URL is unique per instance. PROVIDER_MODE
  // is the more reliable since it's required for the chain to work.
  if ((process.env.PROVIDER_MODE ?? '').toLowerCase() === 'api') return 'prod';
  if ((process.env.PUBLIC_URL ?? '').includes('sisters.ted-h.com')) return 'dev';
  return process.env.PROVIDER_MODE === 'api' ? 'prod' : 'dev';
}

async function sendDigestForWindow(windowMs: number, label: number): Promise<void> {
  const since = Math.floor((Date.now() - windowMs) / 1000);
  const audits = auditStmts.fallbacksSince.all(since) as AuditRow[];
  if (audits.length === 0) {
    console.log(`[digest] no fallback events in last ${label}m; skipping send`);
    return;
  }

  const admins = userStmts.listAdminEmails.all() as AdminRow[];
  const recipients = admins
    .map((a) => a.email)
    .filter((e): e is string => !!e);
  if (recipients.length === 0) {
    console.warn('[digest] no admin emails configured; skipping send');
    return;
  }

  const rows: FallbackDigestRow[] = audits.map((a) => {
    let parsed: {
      provider?: string;
      primary_model?: string;
      from_model?: string;
      journey?: Array<{ stage: string; outcome: string; model?: string; error?: string }>;
    } = {};
    try {
      parsed = a.metadata ? JSON.parse(a.metadata) : {};
    } catch {
      // Older rows used a flat metadata shape (from_model/to_model).
      // Fall through with empty parsed; the table cell will show '-'.
    }
    return {
      timestamp: a.timestamp,
      user: a.user_username ?? '-',
      sessionId: a.target_session_id,
      provider: parsed.provider ?? '-',
      primaryModel: parsed.primary_model ?? parsed.from_model ?? null,
      journey: parsed.journey ?? [],
    };
  });

  try {
    await sendFallbackDigest({
      to: recipients,
      instance: detectInstance(),
      windowMinutes: label,
      rows,
    });
    console.log(`[digest] sent ${rows.length} event(s) to ${recipients.length} admin(s)`);
  } catch (err) {
    console.error('[digest] send failed:', (err as Error).message);
  }
}

let timer: NodeJS.Timeout | null = null;

// Start the hourly digest scheduler. Idempotent — safe to call multiple
// times. First tick fires after one hour so we don't pile a digest on
// top of every server restart.
export function startFallbackDigest(): void {
  if (timer) return;
  if (process.env.DISABLE_FALLBACK_DIGEST === '1') {
    console.log('[digest] disabled via DISABLE_FALLBACK_DIGEST=1');
    return;
  }
  timer = setInterval(() => {
    // Hourly: only events from the past 60 minutes — that's the cadence
    // we promised admins so we don't double-mail the same event.
    void sendDigestForWindow(ONE_HOUR_MS, 60);
  }, ONE_HOUR_MS);
  console.log('[digest] hourly fallback digest scheduler started');
}

// Manual trigger for ad-hoc admin runs. Uses a 24h window so clicking
// "send digest" from /admin always finds something if there was any
// fallback today, even if the hourly tick already covered it (the only
// downside is a duplicate email — admin asked for it).
export async function runFallbackDigestNow(): Promise<void> {
  const TWENTY_FOUR_HOURS = 24 * ONE_HOUR_MS;
  await sendDigestForWindow(TWENTY_FOUR_HOURS, 24 * 60);
}
