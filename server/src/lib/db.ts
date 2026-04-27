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
    tier TEXT NOT NULL CHECK (tier IN ('test','standard','super')),
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
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
`);

export interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  tier: Tier;
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
};

export interface SessionRow {
  id: string;
  user_id: number;
  title: string;
  mode: string;
  created_at: number;
  updated_at: number;
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
  insert: db.prepare<[string, number, string, string]>(
    `INSERT INTO chat_sessions (id, user_id, title, mode) VALUES (?, ?, ?, ?)`,
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
};
