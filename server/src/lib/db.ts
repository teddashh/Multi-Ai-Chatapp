import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Tier } from '../shared/types.js';

const DB_PATH = resolve(process.env.DB_PATH || './data/app.db');

mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    tier TEXT NOT NULL CHECK (tier IN ('standard','pro','super')),
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    nickname TEXT,
    email TEXT,
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS chat_sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    mode TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON chat_sessions(user_id, updated_at DESC);

  CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user','ai')),
    provider TEXT,
    mode_role TEXT,
    content TEXT NOT NULL,
    timestamp INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_session ON chat_messages(session_id, id);

  CREATE TABLE IF NOT EXISTS password_resets (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    used INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  );
  CREATE INDEX IF NOT EXISTS idx_resets_user ON password_resets(user_id, expires_at);

  CREATE TABLE IF NOT EXISTS chat_attachments (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message_id INTEGER REFERENCES chat_messages(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    path TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('image','pdf','text','other')),
    text_content TEXT,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  );
  CREATE INDEX IF NOT EXISTS idx_attachments_message ON chat_attachments(message_id);
  CREATE INDEX IF NOT EXISTS idx_attachments_orphaned ON chat_attachments(user_id, message_id);
`);

// One-shot, idempotent column additions for existing DBs.
function addColumnIfMissing(table: string, column: string, decl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }
}
addColumnIfMissing('users', 'nickname', 'TEXT');
addColumnIfMissing('users', 'email', 'TEXT');
addColumnIfMissing('users', 'failed_attempts', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('users', 'locked_until', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('users', 'lang', "TEXT NOT NULL DEFAULT 'zh-TW'");
addColumnIfMissing('users', 'avatar_path', 'TEXT');
addColumnIfMissing('users', 'theme', "TEXT NOT NULL DEFAULT 'winter'");
addColumnIfMissing('users', 'real_name', 'TEXT');
// Existing users default to verified (1). New /signup flow flips to 0.
addColumnIfMissing('users', 'email_verified', 'INTEGER NOT NULL DEFAULT 1');
addColumnIfMissing('users', 'verify_token', 'TEXT');
addColumnIfMissing('users', 'verify_expires_at', 'INTEGER');
addColumnIfMissing('chat_sessions', 'deleted_at', 'INTEGER');
// Phase 1 of fallback chain: track per-call success and the error_code that
// caused a failure (e.g. "429", "timeout", "5xx"). Existing rows are all
// successes so default success=1.
addColumnIfMissing('usage_log', 'success', 'INTEGER NOT NULL DEFAULT 1');
addColumnIfMissing('usage_log', 'error_code', 'TEXT');
// Phase 5: track the model the user actually *asked* for (their tier
// default or override). Distinct from `model`, which records what
// answered them — could be a CLI run, a direct-API run with the same
// id, or a fallback-to-OpenRouter on a different SKU. The user-facing
// usage view only ever shows `requested_model` so fallbacks are invisible.
addColumnIfMissing('usage_log', 'requested_model', 'TEXT');
// Phase 8: per-AI-message provenance. answered_stage tells admin whether
// this bubble came from CLI / vendor API / OpenRouter / NVIDIA, and
// answered_model is the actual SKU (claude-opus-4-7 vs anthropic/claude-3-haiku
// vs moonshotai/kimi-k2-instruct). Surfaced as a small subtext under the
// provider name in admin view; hidden from regular users entirely so the
// fallback story stays invisible.
addColumnIfMissing('chat_messages', 'answered_stage', 'TEXT');
addColumnIfMissing('chat_messages', 'answered_model', 'TEXT');
// What the user actually picked from the dropdown — may differ from
// answered_model when we map (gpt-5.5 → gpt-4o on direct API) or fall
// back (claude-opus-4-7 → anthropic/claude-3-haiku on OpenRouter). Admin
// badge renders "requested → answered / stage" with an arrow when they
// differ; identical values render as a single name.
addColumnIfMissing('chat_messages', 'requested_model', 'TEXT');

// Backfill: for old rows without requested_model, strip the known
// prefixes ("claude_api:", "chatgpt_api:", "gemini_api:", "openrouter:")
// so the user view can use it for grouping/cost. OR rows lose vendor
// detail (we never logged the originally-requested model for them) but
// at least the user sees a coherent SKU instead of "openrouter:anthropic/...".
db.exec(`
  UPDATE usage_log SET requested_model = model
    WHERE requested_model IS NULL
      AND model NOT LIKE '%:%';
  UPDATE usage_log SET requested_model =
    SUBSTR(model, INSTR(model, ':') + 1)
    WHERE requested_model IS NULL
      AND model LIKE '%:%';
`);

// Audit trail — admin actions on users / sessions are recorded here. The
// admin sees them; users do not. We never delete rows.
db.exec(`
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE SET NULL,
    target_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    target_session_id TEXT,
    action TEXT NOT NULL,
    metadata TEXT,
    timestamp INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  );
  CREATE INDEX IF NOT EXISTS idx_audit_admin ON audit_log(admin_user_id, timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_log(target_user_id, timestamp DESC);

  CREATE TABLE IF NOT EXISTS usage_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    mode TEXT,
    prompt_chars INTEGER NOT NULL,
    completion_chars INTEGER NOT NULL,
    tokens_in INTEGER,
    tokens_out INTEGER,
    is_estimated INTEGER NOT NULL DEFAULT 0,
    timestamp INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  );
  CREATE INDEX IF NOT EXISTS idx_usage_user ON usage_log(user_id, timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_usage_provider ON usage_log(provider, timestamp DESC);
`);
addColumnIfMissing('chat_sessions', 'roles_json', 'TEXT');

// Tier rename migration (test/standard/super → standard/pro/super).
// Idempotent: gated on PRAGMA user_version to run exactly once.
const ver = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
if (ver < 1) {
  db.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN;
    CREATE TABLE users_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      tier TEXT NOT NULL CHECK (tier IN ('standard','pro','super')),
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      nickname TEXT,
      email TEXT,
      failed_attempts INTEGER NOT NULL DEFAULT 0,
      locked_until INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO users_new (id, username, password_hash, tier, created_at, nickname, email, failed_attempts, locked_until)
    SELECT id, username, password_hash,
      CASE tier
        WHEN 'test' THEN 'standard'
        WHEN 'standard' THEN 'pro'
        ELSE 'super'
      END,
      created_at, nickname, email, failed_attempts, locked_until
    FROM users;
    DROP TABLE users;
    ALTER TABLE users_new RENAME TO users;
    COMMIT;
    PRAGMA foreign_keys = ON;
    PRAGMA user_version = 1;
  `);
}

// v2: drop tier CHECK constraint so we can introduce 'admin' (and any future
// tier) without another rebuild. Validation moves to the app layer.
const ver2 = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
if (ver2 < 2) {
  // Re-collect every column the table currently has — earlier addColumnIfMissing
  // calls may have grown it, and we have to copy the lot through.
  const cols = (db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>).map(
    (c) => c.name,
  );
  const colList = cols.join(', ');
  db.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN;
    CREATE TABLE users_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      tier TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      nickname TEXT,
      email TEXT,
      failed_attempts INTEGER NOT NULL DEFAULT 0,
      locked_until INTEGER NOT NULL DEFAULT 0,
      lang TEXT NOT NULL DEFAULT 'zh-TW',
      avatar_path TEXT,
      theme TEXT NOT NULL DEFAULT 'winter',
      real_name TEXT
    );
    INSERT INTO users_new (${colList})
    SELECT ${colList} FROM users;
    DROP TABLE users;
    ALTER TABLE users_new RENAME TO users;
    COMMIT;
    PRAGMA foreign_keys = ON;
    PRAGMA user_version = 2;
  `);
}

// v3: tighten requested_model on backfilled rows. The Phase 5 first-pass
// migration just stripped the "<channel>:" prefix, which leaves user-view
// rows like 'gpt-4o' (the OpenAI direct-API SKU we map gpt-5.x onto) or
// 'anthropic/claude-3-haiku' (an OpenRouter id). Neither is in TIER_MODELS,
// so the user's profile usage panel shows them as separate "mystery"
// rows instead of rolling under the model the user actually picked.
// Best-effort remap to the closest tier-visible default per family.
const ver3 = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
if (ver3 < 3) {
  db.exec(`
    BEGIN;
    -- OpenAI API mappings (reverse of OPENAI_API_MODEL_MAP in providers/openai.ts)
    UPDATE usage_log SET requested_model = 'gpt-5.5'
      WHERE requested_model = 'gpt-4o';
    UPDATE usage_log SET requested_model = 'gpt-5.4-mini'
      WHERE requested_model = 'gpt-4o-mini';
    -- OpenRouter rows: vendor prefix + arbitrary upstream id. Roll all
    -- under the family's tier default — admin can still see what actually
    -- billed via the 'model' column, this only affects user-facing view.
    UPDATE usage_log SET requested_model = 'claude-haiku-4-5'
      WHERE requested_model LIKE 'anthropic/%';
    UPDATE usage_log SET requested_model = 'gemini-3.1-flash-lite-preview'
      WHERE requested_model LIKE 'google/gemini%';
    UPDATE usage_log SET requested_model = 'gpt-5.4-mini'
      WHERE requested_model LIKE 'openai/%';
    UPDATE usage_log SET requested_model = 'grok-4-1-fast-non-reasoning'
      WHERE requested_model LIKE 'x-ai/%';
    COMMIT;
    PRAGMA user_version = 3;
  `);
}

// v4: rewrite stale absolute avatar_path values that still point at the
// pre-split layout (`/server/data/uploads/_avatars/<id>.<ext>`). The
// dev/prod split moved files via `mv data data-prod` but didn't update
// DB rows, so users 3 / 13 were silently 404'ing on every avatar fetch
// and Ted thought their pictures kept "getting wiped". Rebuild the path
// from current process.env.UPLOAD_DIR + the original `<id>.<ext>` tail.
const ver4 = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
if (ver4 < 4) {
  const uploadDir = process.env.UPLOAD_DIR || './data/uploads';
  const rows = db
    .prepare('SELECT id, avatar_path FROM users WHERE avatar_path IS NOT NULL')
    .all() as Array<{ id: number; avatar_path: string }>;
  const update = db.prepare('UPDATE users SET avatar_path = ? WHERE id = ?');
  for (const r of rows) {
    // Strip everything up to and including the `_avatars/` token, keep
    // only the `<id>.<ext>` suffix, rebuild against current UPLOAD_DIR.
    const m = r.avatar_path.match(/_avatars[\\/]+(.+)$/);
    if (!m) continue;
    const fixed = `${uploadDir}/_avatars/${m[1]}`;
    if (fixed !== r.avatar_path) {
      update.run(fixed, r.id);
    }
  }
  db.exec('PRAGMA user_version = 4');
}

// v5: collapse avatar_path from absolute to a bare `<id>.<ext>` filename
// resolved at read time. Future uploads-dir moves won't break rows again.
// Idempotent: rows already in `<id>.<ext>` form are left alone.
const ver5 = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
if (ver5 < 5) {
  const rows = db
    .prepare('SELECT id, avatar_path FROM users WHERE avatar_path IS NOT NULL')
    .all() as Array<{ id: number; avatar_path: string }>;
  const update = db.prepare('UPDATE users SET avatar_path = ? WHERE id = ?');
  for (const r of rows) {
    if (!r.avatar_path.includes('/') && !r.avatar_path.includes('\\')) continue;
    const m = r.avatar_path.match(/[\\/]([^\\/]+)$/);
    if (!m) continue;
    update.run(m[1], r.id);
  }
  db.exec('PRAGMA user_version = 5');
}

export interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  tier: Tier;
  created_at: number;
  nickname: string | null;
  email: string | null;
  failed_attempts: number;
  locked_until: number;
  lang: 'zh-TW' | 'en';
  avatar_path: string | null;
  theme: string;
  real_name: string | null;
  email_verified: number;
  verify_token: string | null;
  verify_expires_at: number | null;
}

export interface PasswordResetRow {
  token: string;
  user_id: number;
  expires_at: number;
  used: number;
  created_at: number;
}

export const userStmts = {
  insert: db.prepare<[string, string, Tier]>(
    'INSERT INTO users (username, password_hash, tier) VALUES (?, ?, ?)',
  ),
  findByUsername: db.prepare<[string]>(
    'SELECT * FROM users WHERE username = ?',
  ),
  findById: db.prepare<[number]>('SELECT * FROM users WHERE id = ?'),
  list: db.prepare('SELECT id, username, tier, created_at FROM users ORDER BY id'),
  delete: db.prepare<[string]>('DELETE FROM users WHERE username = ?'),
  updatePassword: db.prepare<[string, string]>(
    'UPDATE users SET password_hash = ? WHERE username = ?',
  ),
  updateTier: db.prepare<[Tier, string]>(
    'UPDATE users SET tier = ? WHERE username = ?',
  ),
  updateProfile: db.prepare<[string | null, string | null, string]>(
    'UPDATE users SET nickname = ?, email = ? WHERE username = ?',
  ),
  findByEmailOrUsername: db.prepare<[string, string]>(
    'SELECT * FROM users WHERE username = ? OR LOWER(email) = LOWER(?)',
  ),
  bumpFailedAttempts: db.prepare<[number]>(
    'UPDATE users SET failed_attempts = failed_attempts + 1 WHERE id = ?',
  ),
  resetFailedAttempts: db.prepare<[number]>(
    'UPDATE users SET failed_attempts = 0, locked_until = 0 WHERE id = ?',
  ),
  lockUser: db.prepare<[number, number]>(
    'UPDATE users SET locked_until = ? WHERE id = ?',
  ),
  setPasswordHash: db.prepare<[string, number]>(
    'UPDATE users SET password_hash = ?, failed_attempts = 0, locked_until = 0 WHERE id = ?',
  ),
  updateLang: db.prepare<[string, number]>(
    'UPDATE users SET lang = ? WHERE id = ?',
  ),
  updateAvatar: db.prepare<[string | null, number]>(
    'UPDATE users SET avatar_path = ? WHERE id = ?',
  ),
  updateTheme: db.prepare<[string, number]>(
    'UPDATE users SET theme = ? WHERE id = ?',
  ),
  updateNicknameEmail: db.prepare<[string | null, string | null, number]>(
    'UPDATE users SET nickname = ?, email = ? WHERE id = ?',
  ),
  setOwnPassword: db.prepare<[string, number]>(
    'UPDATE users SET password_hash = ? WHERE id = ?',
  ),
  updateRealName: db.prepare<[string | null, string]>(
    'UPDATE users SET real_name = ? WHERE username = ?',
  ),
  // First-login username pick (gated to unverified rows by the auth
  // route — the schema-level UNIQUE on username still protects us).
  updateUsername: db.prepare<[string, number]>(
    'UPDATE users SET username = ? WHERE id = ?',
  ),
  // Email verification — set token + expiry on signup / resend, and flip
  // email_verified to 0 in the same write so the gate catches them.
  setVerifyToken: db.prepare<[string, number, number]>(
    `UPDATE users SET verify_token = ?, verify_expires_at = ?, email_verified = 0 WHERE id = ?`,
  ),
  // Look up by token to resolve a click-through. Token is single-use; the
  // markVerified call below clears it.
  findByVerifyToken: db.prepare<[string]>(
    'SELECT * FROM users WHERE verify_token = ?',
  ),
  markEmailVerified: db.prepare<[number]>(
    'UPDATE users SET email_verified = 1, verify_token = NULL, verify_expires_at = NULL WHERE id = ?',
  ),
  // Hard-delete unverified accounts whose tokens have expired. Run from
  // a periodic cleanup if we ever wire one up.
  deleteExpiredUnverified: db.prepare<[number]>(
    `DELETE FROM users WHERE email_verified = 0 AND verify_expires_at IS NOT NULL AND verify_expires_at < ?`,
  ),
  // Recipients for the hourly fallback digest. Free-tier admins still
  // count; only the email_verified gate matters.
  listAdminEmails: db.prepare(
    `SELECT email, nickname, real_name, username FROM users
     WHERE tier = 'admin' AND email IS NOT NULL AND email_verified = 1`,
  ),
};

export type AttachmentKind = 'image' | 'pdf' | 'text' | 'other';

export interface AttachmentRow {
  id: string;
  user_id: number;
  message_id: number | null;
  filename: string;
  mime_type: string;
  size: number;
  path: string;
  kind: AttachmentKind;
  text_content: string | null;
  created_at: number;
}

export const attachmentStmts = {
  insert: db.prepare<[string, number, string, string, number, string, AttachmentKind, string | null]>(
    `INSERT INTO chat_attachments (id, user_id, filename, mime_type, size, path, kind, text_content)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ),
  findOwned: db.prepare<[string, number]>(
    `SELECT * FROM chat_attachments WHERE id = ? AND user_id = ?`,
  ),
  // Admin lookup — bypasses ownership.
  findById: db.prepare<[string]>(
    `SELECT * FROM chat_attachments WHERE id = ?`,
  ),
  attachToMessage: db.prepare<[number, string, number]>(
    `UPDATE chat_attachments SET message_id = ? WHERE id = ? AND user_id = ?`,
  ),
  listForMessage: db.prepare<[number]>(
    `SELECT id, filename, mime_type, size, kind FROM chat_attachments WHERE message_id = ? ORDER BY created_at`,
  ),
};

export const resetStmts = {
  insert: db.prepare<[string, number, number]>(
    'INSERT INTO password_resets (token, user_id, expires_at) VALUES (?, ?, ?)',
  ),
  findValid: db.prepare<[string, number]>(
    `SELECT * FROM password_resets WHERE token = ? AND used = 0 AND expires_at > ?`,
  ),
  markUsed: db.prepare<[string]>(
    'UPDATE password_resets SET used = 1 WHERE token = ?',
  ),
  deleteForUser: db.prepare<[number]>(
    'DELETE FROM password_resets WHERE user_id = ?',
  ),
};

export interface SessionRow {
  id: string;
  user_id: number;
  title: string;
  mode: string;
  created_at: number;
  updated_at: number;
  roles_json: string | null;
  deleted_at: number | null;
}

export interface AuditRow {
  id: number;
  admin_user_id: number;
  target_user_id: number | null;
  target_session_id: string | null;
  action: string;
  metadata: string | null;
  timestamp: number;
}

export interface UsageRow {
  id: number;
  user_id: number;
  provider: string;
  model: string;
  mode: string | null;
  prompt_chars: number;
  completion_chars: number;
  tokens_in: number | null;
  tokens_out: number | null;
  is_estimated: number;
  timestamp: number;
}

export interface MessageRow {
  id: number;
  session_id: string;
  role: 'user' | 'ai';
  provider: string | null;
  mode_role: string | null;
  content: string;
  timestamp: number;
  answered_stage: string | null;
  answered_model: string | null;
  requested_model: string | null;
}

export const sessionStmts = {
  insert: db.prepare<[string, number, string, string, string | null]>(
    `INSERT INTO chat_sessions (id, user_id, title, mode, roles_json) VALUES (?, ?, ?, ?, ?)`,
  ),
  // Active sessions only — soft-deleted ones still live in the DB but
  // disappear from the user's sidebar.
  listForUser: db.prepare<[number]>(
    `SELECT s.id, s.title, s.mode, s.created_at, s.updated_at,
            (SELECT COUNT(*) FROM chat_messages m WHERE m.session_id = s.id) AS msg_count
     FROM chat_sessions s
     WHERE s.user_id = ? AND s.deleted_at IS NULL
     ORDER BY s.updated_at DESC`,
  ),
  // Admin view — includes soft-deleted sessions.
  listForUserIncludingDeleted: db.prepare<[number]>(
    `SELECT s.id, s.title, s.mode, s.created_at, s.updated_at, s.deleted_at,
            (SELECT COUNT(*) FROM chat_messages m WHERE m.session_id = s.id) AS msg_count
     FROM chat_sessions s
     WHERE s.user_id = ?
     ORDER BY s.updated_at DESC`,
  ),
  // Owned + active. Used by every endpoint that mutates a session for
  // the owning user; soft-deleted sessions read as "not found" to them.
  findOwned: db.prepare<[string, number]>(
    `SELECT * FROM chat_sessions WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
  ),
  // Admin lookup — bypasses ownership and the deleted_at filter.
  findById: db.prepare<[string]>(
    `SELECT * FROM chat_sessions WHERE id = ?`,
  ),
  rename: db.prepare<[string, string, number]>(
    `UPDATE chat_sessions SET title = ?, updated_at = strftime('%s','now') WHERE id = ? AND user_id = ?`,
  ),
  touch: db.prepare<[string]>(
    `UPDATE chat_sessions SET updated_at = strftime('%s','now') WHERE id = ?`,
  ),
  // Soft-delete only — the row stays so admin audit can still read it.
  softDelete: db.prepare<[string, number]>(
    `UPDATE chat_sessions SET deleted_at = strftime('%s','now') WHERE id = ? AND user_id = ?`,
  ),
};

export const auditStmts = {
  insert: db.prepare<[number, number | null, string | null, string, string | null]>(
    `INSERT INTO audit_log (admin_user_id, target_user_id, target_session_id, action, metadata)
     VALUES (?, ?, ?, ?, ?)`,
  ),
  list: db.prepare<[number]>(
    `SELECT a.*, u.username AS admin_username, t.username AS target_username
     FROM audit_log a
     LEFT JOIN users u ON u.id = a.admin_user_id
     LEFT JOIN users t ON t.id = a.target_user_id
     ORDER BY a.timestamp DESC
     LIMIT ?`,
  ),
  // Pull every model_fallback event since a given timestamp. Used by the
  // hourly digest to summarize what fell back. We join users for context
  // since the metadata JSON references admin_user_id (== the regular user
  // who owned the session).
  fallbacksSince: db.prepare<[number]>(
    `SELECT a.id, a.target_session_id, a.metadata, a.timestamp,
            u.username AS user_username, u.email AS user_email
     FROM audit_log a
     LEFT JOIN users u ON u.id = a.admin_user_id
     WHERE a.action = 'model_fallback' AND a.timestamp >= ?
     ORDER BY a.timestamp ASC`,
  ),
};

export const usageStmts = {
  insert: db.prepare<[
    number,
    string,
    string,
    string | null,
    number,
    number,
    number | null,
    number | null,
    number,
    number,
    string | null,
    string | null,
  ]>(
    `INSERT INTO usage_log
       (user_id, provider, model, mode, prompt_chars, completion_chars, tokens_in, tokens_out, is_estimated, success, error_code, requested_model)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ),
  // Per-(provider, model) success/failure rollup for the admin dashboard.
  // Rows where success=0 carry the error_code that caused the failure.
  byModel: db.prepare(
    `SELECT provider, model,
            COUNT(*) AS attempts,
            SUM(CASE WHEN success=1 THEN 1 ELSE 0 END) AS successes,
            SUM(CASE WHEN success=0 THEN 1 ELSE 0 END) AS failures,
            MAX(timestamp) AS last_seen
     FROM usage_log
     GROUP BY provider, model
     ORDER BY provider, model`,
  ),
  // Recent error codes per (provider, model) so admin can see what's
  // actually failing — top 5 codes by frequency in the last 7 days.
  recentFailureCodes: db.prepare<[number]>(
    `SELECT provider, model, error_code, COUNT(*) AS n
     FROM usage_log
     WHERE success = 0
       AND error_code IS NOT NULL
       AND timestamp >= ?
     GROUP BY provider, model, error_code
     ORDER BY provider, model, n DESC`,
  ),
  // Per-user totals across all providers/models.
  totalsByUser: db.prepare(
    `SELECT u.id, u.username, u.real_name, u.nickname, u.tier,
            COUNT(l.id) AS calls,
            COALESCE(SUM(l.tokens_in), 0) AS tokens_in,
            COALESCE(SUM(l.tokens_out), 0) AS tokens_out,
            COALESCE(SUM(l.prompt_chars), 0) AS prompt_chars,
            COALESCE(SUM(l.completion_chars), 0) AS completion_chars
     FROM users u
     LEFT JOIN usage_log l ON l.user_id = u.id
     GROUP BY u.id
     ORDER BY u.id`,
  ),
  // Per-(user, provider, model) breakdown — one row per model the user has
  // ever called. Used to compute cost (different prices per model).
  byUserAndModel: db.prepare(
    `SELECT user_id, provider, model,
            COUNT(*) AS calls,
            COALESCE(SUM(tokens_in), 0) AS tokens_in,
            COALESCE(SUM(tokens_out), 0) AS tokens_out,
            COALESCE(SUM(prompt_chars), 0) AS prompt_chars,
            COALESCE(SUM(completion_chars), 0) AS completion_chars,
            MAX(is_estimated) AS any_estimated
     FROM usage_log
     GROUP BY user_id, provider, model
     ORDER BY user_id, provider, model`,
  ),
  // Self-view variant of byUserAndModel — bound to a single user.
  byModelForUser: db.prepare<[number]>(
    `SELECT provider, model,
            COUNT(*) AS calls,
            COALESCE(SUM(tokens_in), 0) AS tokens_in,
            COALESCE(SUM(tokens_out), 0) AS tokens_out,
            COALESCE(SUM(prompt_chars), 0) AS prompt_chars,
            COALESCE(SUM(completion_chars), 0) AS completion_chars,
            MAX(is_estimated) AS any_estimated
     FROM usage_log
     WHERE user_id = ?
     GROUP BY provider, model
     ORDER BY provider, model`,
  ),
  // Same shape as byModelForUser but groups by the *requested* model so
  // the user-facing /usage view never leaks fallback detail. Cost is
  // recomputed in the route handler against requested_model.
  byRequestedModelForUser: db.prepare<[number]>(
    `SELECT provider,
            COALESCE(requested_model, model) AS model,
            COUNT(*) AS calls,
            COALESCE(SUM(tokens_in), 0) AS tokens_in,
            COALESCE(SUM(tokens_out), 0) AS tokens_out,
            COALESCE(SUM(prompt_chars), 0) AS prompt_chars,
            COALESCE(SUM(completion_chars), 0) AS completion_chars,
            MAX(is_estimated) AS any_estimated
     FROM usage_log
     WHERE user_id = ? AND success = 1
     GROUP BY provider, COALESCE(requested_model, model)
     ORDER BY provider, model`,
  ),
  // Admin "API key spending" rollup — groups by which billing relationship
  // the row hit: 'cli' (subscription, no metered cost), '<provider>_api'
  // (Anthropic/OpenAI/Gemini direct), 'openrouter' (OR aggregator), or
  // 'xai' (grok primary, also direct API). The route handler labels these.
  byBillingChannel: db.prepare(
    `SELECT
       CASE
         WHEN model LIKE 'nvidia:%' THEN 'nvidia'
         WHEN model LIKE 'openrouter:%' THEN 'openrouter'
         WHEN model LIKE 'claude_api:%' THEN 'anthropic_api'
         WHEN model LIKE 'chatgpt_api:%' THEN 'openai_api'
         WHEN model LIKE 'gemini_api:%' THEN 'gemini_api'
         WHEN provider = 'grok' THEN 'xai_api'
         ELSE 'cli_subscription'
       END AS channel,
       provider,
       CASE
         WHEN INSTR(model, ':') > 0 THEN SUBSTR(model, INSTR(model, ':') + 1)
         ELSE model
       END AS billed_model,
       COUNT(*) AS calls,
       COALESCE(SUM(tokens_in), 0) AS tokens_in,
       COALESCE(SUM(tokens_out), 0) AS tokens_out
     FROM usage_log
     WHERE success = 1
     GROUP BY channel, provider, billed_model
     ORDER BY channel, provider, billed_model`,
  ),
  totalsForUser: db.prepare<[number]>(
    `SELECT COUNT(*) AS calls,
            COALESCE(SUM(tokens_in), 0) AS tokens_in,
            COALESCE(SUM(tokens_out), 0) AS tokens_out,
            COALESCE(SUM(prompt_chars), 0) AS prompt_chars,
            COALESCE(SUM(completion_chars), 0) AS completion_chars
     FROM usage_log WHERE user_id = ? AND success = 1`,
  ),
};

export const messageStmts = {
  insert: db.prepare<[string, 'user' | 'ai', string | null, string | null, string, number]>(
    `INSERT INTO chat_messages (session_id, role, provider, mode_role, content, timestamp)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ),
  // Stamp the answered-stage / answered-model / requested-model on an AI
  // row after it's been inserted (orchestrator only knows these once
  // runOne returns). Used by admin view only.
  setAnswered: db.prepare<[string | null, string | null, string | null, number]>(
    `UPDATE chat_messages SET answered_stage = ?, answered_model = ?, requested_model = ? WHERE id = ?`,
  ),
  listForSession: db.prepare<[string]>(
    `SELECT * FROM chat_messages WHERE session_id = ? ORDER BY id`,
  ),
  findById: db.prepare<[number]>(
    `SELECT * FROM chat_messages WHERE id = ?`,
  ),
  // Find the most recent user message before this AI message in the same session.
  precedingUser: db.prepare<[string, number]>(
    `SELECT * FROM chat_messages
     WHERE session_id = ? AND id < ? AND role = 'user'
     ORDER BY id DESC LIMIT 1`,
  ),
  // All AI messages in a session that came AFTER a given user message id,
  // ordered chronologically. Used to map the chain of replies for a turn.
  aiAfterUser: db.prepare<[string, number]>(
    `SELECT * FROM chat_messages
     WHERE session_id = ? AND id > ? AND role = 'ai'
     ORDER BY id`,
  ),
  // Drop everything after a given message id in a session — used by resume to
  // wipe stale steps before re-running the tail.
  deleteAfter: db.prepare<[string, number]>(
    `DELETE FROM chat_messages WHERE session_id = ? AND id >= ?`,
  ),
  updateContent: db.prepare<[string, number, number]>(
    `UPDATE chat_messages SET content = ?, timestamp = ? WHERE id = ?`,
  ),
  // Count user messages a given user has sent in a given mode since some
  // epoch second. Used for the free-tier daily quota.
  countUserMsgsSince: db.prepare<[number, string, number]>(
    `SELECT COUNT(*) AS c FROM chat_messages m
     JOIN chat_sessions s ON s.id = m.session_id
     WHERE s.user_id = ? AND s.mode = ? AND m.role = 'user' AND m.timestamp >= ?`,
  ),
};
