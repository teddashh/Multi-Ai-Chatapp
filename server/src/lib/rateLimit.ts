// Tiny in-memory sliding-window rate limiter. Resets on process restart,
// which is fine for the personal-scale this app runs at. If we ever need
// persistence we move it to a `rate_limit` table.

interface Bucket {
  // Sorted ascending. Old entries get pruned on every check.
  hits: number[];
}

const buckets = new Map<string, Bucket>();

export interface Limit {
  windowMs: number;
  max: number;
}

// Check if the key is within all of the given limits. Returns the first
// limit that's exceeded, or null if all are fine. Records the hit only
// on success (so a denied request doesn't tighten its own limit further).
export function checkAndRecord(
  key: string,
  limits: Limit[],
): { ok: true } | { ok: false; retryAfterMs: number; limit: Limit } {
  const now = Date.now();
  const bucket = buckets.get(key) ?? { hits: [] };
  // Prune anything older than the longest window we'll ask about.
  const longestWindow = Math.max(...limits.map((l) => l.windowMs));
  bucket.hits = bucket.hits.filter((t) => now - t <= longestWindow);

  for (const limit of limits) {
    const inWindow = bucket.hits.filter((t) => now - t <= limit.windowMs).length;
    if (inWindow >= limit.max) {
      const oldest = bucket.hits.find((t) => now - t <= limit.windowMs) ?? now;
      const retryAfterMs = Math.max(0, limit.windowMs - (now - oldest));
      return { ok: false, retryAfterMs, limit };
    }
  }

  bucket.hits.push(now);
  buckets.set(key, bucket);
  return { ok: true };
}

// Heuristic IP extraction. Trusts the first hop in X-Forwarded-For when
// the server is behind Caddy / nginx; falls back to the connection IP.
export function clientIp(req: Request): string {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  const real = req.headers.get('x-real-ip');
  if (real) return real.trim();
  return 'unknown';
}
