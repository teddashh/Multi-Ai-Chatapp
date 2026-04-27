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
  listForUser: db.prepare<[number]>(
    `SELECT s.id, s.title, s.mode, s.created_at, s.updated_at,
            (SELECT COUNT(*) FROM chat_messages m WHERE m.session_id = s.id) AS msg_count
     FROM chat_sessions s
     WHERE s.user_id = ?
     ORDER BY s.updated_at DESC`,
  ),
  findOwned: db.prepare<[string, number]>(
    `SELECT * FROM chat_sessions WHERE id = ? AND user_id = ?`,
  ),
  rename: db.prepare<[string, string, number]>(
    `UPDATE chat_sessions SET title = ?, updated_at = strftime('%s','now') WHERE id = ? AND user_id = ?`,
  ),
  touch: db.prepare<[string]>(
    `UPDATE chat_sessions SET updated_at = strftime('%s','now') WHERE id = ?`,
  ),
  delete: db.prepare<[string, number]>(
    `DELETE FROM chat_sessions WHERE id = ? AND user_id = ?`,
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
};
