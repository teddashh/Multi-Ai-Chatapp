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
  ]>(
    `INSERT INTO usage_log
       (user_id, provider, model, mode, prompt_chars, completion_chars, tokens_in, tokens_out, is_estimated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
  totalsForUser: db.prepare<[number]>(
    `SELECT COUNT(*) AS calls,
            COALESCE(SUM(tokens_in), 0) AS tokens_in,
            COALESCE(SUM(tokens_out), 0) AS tokens_out,
            COALESCE(SUM(prompt_chars), 0) AS prompt_chars,
            COALESCE(SUM(completion_chars), 0) AS completion_chars
     FROM usage_log WHERE user_id = ?`,
  ),
};

export const messageStmts = {
  insert: db.prepare<[string, 'user' | 'ai', string | null, string | null, string, number]>(
    `INSERT INTO chat_messages (session_id, role, provider, mode_role, content, timestamp)
     VALUES (?, ?, ?, ?, ?, ?)`,
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
