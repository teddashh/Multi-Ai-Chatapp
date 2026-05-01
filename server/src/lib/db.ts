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

  -- Forum (Phase 1). A chat session can be "shared" — first user message
  -- becomes the post body, every later message becomes an imported comment
  -- in chronological order. Re-share is append-only: any new chat messages
  -- since the last share land as new imported comments. Schema reserves
  -- trending_score (Phase 2 hot-topics sort) and author_ai_model
  -- (5.6 AI peer rating stats) so we don't need another migration later.
  CREATE TABLE IF NOT EXISTS forum_posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL,
    source_session_id TEXT UNIQUE REFERENCES chat_sessions(id) ON DELETE SET NULL,
    source_mode TEXT,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    author_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    is_anonymous INTEGER NOT NULL DEFAULT 0,
    thumbs_count INTEGER NOT NULL DEFAULT 0,
    comment_count INTEGER NOT NULL DEFAULT 0,
    trending_score REAL NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  );
  CREATE INDEX IF NOT EXISTS idx_forum_posts_category ON forum_posts(category, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_forum_posts_session ON forum_posts(source_session_id);

  CREATE TABLE IF NOT EXISTS forum_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL REFERENCES forum_posts(id) ON DELETE CASCADE,
    author_type TEXT NOT NULL CHECK (author_type IN ('user','ai')),
    author_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    author_ai_provider TEXT,
    author_ai_model TEXT,
    body TEXT NOT NULL,
    is_anonymous INTEGER NOT NULL DEFAULT 0,
    is_imported INTEGER NOT NULL DEFAULT 0,
    source_message_id INTEGER REFERENCES chat_messages(id) ON DELETE SET NULL,
    thumbs_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_forum_comments_post ON forum_comments(post_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_forum_comments_source ON forum_comments(source_message_id);

  CREATE TABLE IF NOT EXISTS forum_likes (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_type TEXT NOT NULL CHECK (target_type IN ('post','comment')),
    target_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    PRIMARY KEY (user_id, target_type, target_id)
  );
  CREATE INDEX IF NOT EXISTS idx_forum_likes_target ON forum_likes(target_type, target_id);

  -- PTT-style replies under a forum comment. vote='up' = 推 (+1
  -- thumbs_count on the parent comment), vote='down' = 噓 (-1),
  -- vote='none' = → (just a one-liner, no ± on the parent). Each
  -- user may post multiple 'none' replies but only one 'up'-or-'down'
  -- vote per parent comment (enforced in the route handler).
  CREATE TABLE IF NOT EXISTS forum_comment_replies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    comment_id INTEGER NOT NULL REFERENCES forum_comments(id) ON DELETE CASCADE,
    author_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    vote TEXT NOT NULL CHECK (vote IN ('up','down','none')),
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  );
  CREATE INDEX IF NOT EXISTS idx_comment_replies ON forum_comment_replies(comment_id, id);

  -- Media library — image attachments associated with either a forum
  -- post (post_id set) or one of the four AI personas (ai_provider set).
  -- Exactly one of the two must be non-null. Thumbnails surface as the
  -- og:image when sharing a post; ai_provider rows render in the AI's
  -- public profile gallery. Files live under UPLOAD_DIR/_forum-media/
  -- as <uuid>.<ext>; path stores the bare filename so moving the
  -- uploads dir doesn't break rows (same pattern as users.avatar_path).
  CREATE TABLE IF NOT EXISTS forum_media (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER REFERENCES forum_posts(id) ON DELETE CASCADE,
    ai_provider TEXT,
    path TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    caption TEXT,
    is_thumbnail INTEGER NOT NULL DEFAULT 0,
    position INTEGER NOT NULL DEFAULT 0,
    uploaded_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    CHECK ((post_id IS NULL) <> (ai_provider IS NULL))
  );
  CREATE INDEX IF NOT EXISTS idx_forum_media_post ON forum_media(post_id, position);
  CREATE INDEX IF NOT EXISTS idx_forum_media_ai ON forum_media(ai_provider, position);
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
addColumnIfMissing('users', 'theme', "TEXT NOT NULL DEFAULT 'spring'");
addColumnIfMissing('users', 'real_name', 'TEXT');
// Self-edited public bio shown on the user's forum profile page. Plain
// text, capped server-side. Empty by default.
addColumnIfMissing('users', 'bio', 'TEXT');
// Birth date/time stored as UTC unix seconds; the IANA timezone the
// user originally chose stays alongside it so we can render the value
// back in their preferred local time. Nullable while users haven't
// filled them in.
addColumnIfMissing('users', 'birth_at', 'INTEGER');
addColumnIfMissing('users', 'birth_tz', 'TEXT');
// Astrology fields. sun_sign is auto-derived from birth_at when the
// date is set; moon/rising require accurate time + location so we let
// users fill them manually. Stored as English keys ("leo", "pisces"
// etc.) — display labels live on the client.
addColumnIfMissing('users', 'sun_sign', 'TEXT');
addColumnIfMissing('users', 'moon_sign', 'TEXT');
addColumnIfMissing('users', 'rising_sign', 'TEXT');
addColumnIfMissing('users', 'mbti', 'TEXT');
// Per-field profile visibility (default OFF). The fields themselves
// stay in the DB regardless; these flags only gate the public
// /api/forum/user/:username response.
addColumnIfMissing('users', 'show_birthday', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('users', 'show_birth_time', 'INTEGER NOT NULL DEFAULT 0');
// Soft-disable: when set, the user can't sign in or be authenticated by
// existing sessions, but their data is preserved. Distinct from a hard
// purge (DELETE /api/auth/me) which removes the row entirely. NULL =
// active. Set to current epoch when disabled.
addColumnIfMissing('users', 'disabled_at', 'INTEGER');
// Forum content gating: posts flagged as NSFW are hidden from anonymous
// visitors entirely (404 on detail, filtered out of list endpoints) and
// surfaced to logged-in users with a click-to-confirm 18+ overlay on
// the post detail page. Default 0 (safe).
addColumnIfMissing('forum_posts', 'nsfw', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('users', 'show_mbti', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('users', 'show_signs', 'INTEGER NOT NULL DEFAULT 0');
// Birth year is the most personal field — split off from show_birthday
// so users can show "1月15日" without revealing the year. Defaults
// off; AIs ignore this entirely (their year never displays per spec).
addColumnIfMissing('users', 'show_birth_year', 'INTEGER NOT NULL DEFAULT 0');
// Persona dice — encodes which of the 5 variants is picked for each of
// the 5 cells in the persona matrix (sun/moon/rising/mbtiNoun/mbtiAction).
// One integer in [0, 3124]; client decodes via base-5 modulo. NULL means
// the user hasn't rolled yet — UserProfile shows no archetype line.
addColumnIfMissing('users', 'persona_seed', 'INTEGER');
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
    -- Nullable on purpose: audit rows survive admin-account deletion via
    -- ON DELETE SET NULL; declaring NOT NULL would conflict and throw
    -- SQLITE_CONSTRAINT_NOTNULL when the cascading SET NULL fires.
    admin_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
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
// Persona snapshot at share time — for `profession` mode this is the
// profession the user typed in (e.g. "按摩師"). Forum UI shows this in
// place of the bare provider name so the AI's role is preserved even
// after the source session is deleted.
addColumnIfMissing('forum_posts', 'ai_persona', 'TEXT');

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

// v6: audit_log.admin_user_id was declared `NOT NULL ... ON DELETE SET NULL`,
// which is internally inconsistent — once a user with audit history is
// deleted, SQLite tries to NULL the FK, hits the NOT NULL constraint, and
// throws SQLITE_CONSTRAINT_NOTNULL. Surface symptom: clicking "delete user"
// in the admin panel returns 500. Drop the NOT NULL by recreating the
// table; SET NULL behaviour is the correct intent (preserve audit trail
// even when an admin's own account is later removed).
const ver6 = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
if (ver6 < 6) {
  db.exec(`
    CREATE TABLE audit_log_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      target_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      target_session_id TEXT,
      action TEXT NOT NULL,
      metadata TEXT,
      timestamp INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    INSERT INTO audit_log_new (id, admin_user_id, target_user_id, target_session_id, action, metadata, timestamp)
      SELECT id, admin_user_id, target_user_id, target_session_id, action, metadata, timestamp FROM audit_log;
    DROP TABLE audit_log;
    ALTER TABLE audit_log_new RENAME TO audit_log;
    CREATE INDEX IF NOT EXISTS idx_audit_admin ON audit_log(admin_user_id, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_log(target_user_id, timestamp DESC);
    PRAGMA user_version = 6;
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
  bio: string | null;
  birth_at: number | null;
  birth_tz: string | null;
  sun_sign: string | null;
  moon_sign: string | null;
  rising_sign: string | null;
  mbti: string | null;
  show_birthday: number;
  show_birth_time: number;
  show_mbti: number;
  show_signs: number;
  show_birth_year: number;
  persona_seed: number | null;
  disabled_at: number | null;
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
    // Explicitly set theme to 'spring' (warmer/lighter default) so new
    // signups don't inherit the legacy 'winter' default baked into the
    // already-deployed schema.
    "INSERT INTO users (username, password_hash, tier, theme) VALUES (?, ?, ?, 'spring')",
  ),
  findByUsername: db.prepare<[string]>(
    'SELECT * FROM users WHERE username = ?',
  ),
  findById: db.prepare<[number]>('SELECT * FROM users WHERE id = ?'),
  list: db.prepare('SELECT id, username, tier, created_at FROM users ORDER BY id'),
  delete: db.prepare<[string]>('DELETE FROM users WHERE username = ?'),
  // Override the SET NULL FK on forum_comments so deleting a user also
  // hard-deletes the comments they wrote on OTHER users' posts. Used by
  // both admin delete and self-purge paths.
  deleteForumCommentsByAuthor: db.prepare<[number]>(
    'DELETE FROM forum_comments WHERE author_user_id = ?',
  ),
  updatePassword: db.prepare<[string, string]>(
    'UPDATE users SET password_hash = ? WHERE username = ?',
  ),
  updateTier: db.prepare<[Tier, string]>(
    'UPDATE users SET tier = ? WHERE username = ?',
  ),
  // Soft disable / re-enable. Sets/clears users.disabled_at; NULL = active.
  setDisabled: db.prepare<[number | null, string]>(
    'UPDATE users SET disabled_at = ? WHERE username = ?',
  ),
  setDisabledById: db.prepare<[number | null, number]>(
    'UPDATE users SET disabled_at = ? WHERE id = ?',
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
  updateBio: db.prepare<[string | null, number]>(
    'UPDATE users SET bio = ? WHERE id = ?',
  ),
  // Birth + astrology batch update — all fields nullable. Sun sign
  // is computed in the route from birth_at when the user provides a
  // date; moon/rising/mbti are user-typed.
  updateBirthAndSigns: db.prepare<[
    number | null,
    string | null,
    string | null,
    string | null,
    string | null,
    string | null,
    number,
  ]>(
    `UPDATE users
       SET birth_at = ?, birth_tz = ?, sun_sign = ?, moon_sign = ?,
           rising_sign = ?, mbti = ?
     WHERE id = ?`,
  ),
  updateProfileVisibility: db.prepare<[
    number,
    number,
    number,
    number,
    number,
    number,
  ]>(
    `UPDATE users
       SET show_birthday = ?, show_birth_time = ?, show_mbti = ?,
           show_signs = ?, show_birth_year = ?
     WHERE id = ?`,
  ),
  updatePersonaSeed: db.prepare<[number | null, number]>(
    'UPDATE users SET persona_seed = ? WHERE id = ?',
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
    `SELECT s.id, s.title, s.mode, s.roles_json, s.created_at, s.updated_at,
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

export interface ForumPostRow {
  id: number;
  category: string;
  source_session_id: string | null;
  source_mode: string | null;
  title: string;
  body: string;
  author_user_id: number;
  is_anonymous: number;
  thumbs_count: number;
  comment_count: number;
  trending_score: number;
  created_at: number;
  updated_at: number;
  ai_persona: string | null;
  nsfw: number;
}

export interface ForumCommentRow {
  id: number;
  post_id: number;
  author_type: 'user' | 'ai';
  author_user_id: number | null;
  author_ai_provider: string | null;
  author_ai_model: string | null;
  body: string;
  is_anonymous: number;
  is_imported: number;
  source_message_id: number | null;
  thumbs_count: number;
  created_at: number;
}

export const forumStmts = {
  findPostById: db.prepare<[number]>(
    `SELECT * FROM forum_posts WHERE id = ?`,
  ),
  // Used to detect re-share — same source_session_id → append mode.
  findPostBySession: db.prepare<[string]>(
    `SELECT * FROM forum_posts WHERE source_session_id = ?`,
  ),
  insertPost: db.prepare<[
    string,
    string,
    string,
    string,
    string,
    number,
    number,
    string | null,
  ]>(
    `INSERT INTO forum_posts
       (category, source_session_id, source_mode, title, body, author_user_id, is_anonymous, ai_persona)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ),
  setCommentCount: db.prepare<[number, number]>(
    `UPDATE forum_posts SET comment_count = ?, updated_at = strftime('%s','now') WHERE id = ?`,
  ),
  setPostNsfw: db.prepare<[number, number]>(
    `UPDATE forum_posts SET nsfw = ? WHERE id = ?`,
  ),
  bumpCommentCount: db.prepare<[number, number]>(
    `UPDATE forum_posts SET comment_count = comment_count + ?, updated_at = strftime('%s','now') WHERE id = ?`,
  ),
  // List with author join — author may be anonymous; the route formatter
  // hides the username in that case.
  listByCategory: db.prepare<[string, number, number]>(
    `SELECT p.*, u.username AS author_username, u.nickname AS author_nickname
     FROM forum_posts p
     JOIN users u ON u.id = p.author_user_id
     WHERE p.category = ?
     ORDER BY p.created_at DESC
     LIMIT ? OFFSET ?`,
  ),
  listAll: db.prepare<[number, number]>(
    `SELECT p.*, u.username AS author_username, u.nickname AS author_nickname
     FROM forum_posts p
     JOIN users u ON u.id = p.author_user_id
     ORDER BY p.created_at DESC
     LIMIT ? OFFSET ?`,
  ),
  // Trending = thumbs + comments × 2, with the comment count weighted
  // higher because a 留言 represents more engagement than a one-click
  // ❤. Time decay isn't applied yet; we'll layer that in via the
  // reserved trending_score column when the cron lands.
  listByTrending: db.prepare<[number, number]>(
    `SELECT p.*, u.username AS author_username, u.nickname AS author_nickname
     FROM forum_posts p
     JOIN users u ON u.id = p.author_user_id
     ORDER BY (p.thumbs_count + p.comment_count * 2) DESC, p.created_at DESC
     LIMIT ? OFFSET ?`,
  ),
  countByCategory: db.prepare(
    `SELECT category, COUNT(*) AS n FROM forum_posts GROUP BY category`,
  ),
  // Highest source_message_id imported so far for a given post — the
  // append-on-re-share path takes anything strictly greater than this.
  maxImportedSourceMsg: db.prepare<[number]>(
    `SELECT COALESCE(MAX(source_message_id), 0) AS max
     FROM forum_comments WHERE post_id = ? AND is_imported = 1`,
  ),
  insertComment: db.prepare<[
    number,
    'user' | 'ai',
    number | null,
    string | null,
    string | null,
    string,
    number,
    number,
    number | null,
    number,
  ]>(
    `INSERT INTO forum_comments
       (post_id, author_type, author_user_id, author_ai_provider, author_ai_model,
        body, is_anonymous, is_imported, source_message_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ),
  findCommentById: db.prepare<[number]>(
    `SELECT * FROM forum_comments WHERE id = ?`,
  ),
  listComments: db.prepare<[number]>(
    `SELECT c.*, u.username AS author_username, u.nickname AS author_nickname,
            u.avatar_path AS author_avatar
     FROM forum_comments c
     LEFT JOIN users u ON u.id = c.author_user_id
     WHERE c.post_id = ?
     ORDER BY c.created_at, c.id`,
  ),
  // PTT-style replies (推/噓/→) attached to a forum comment.
  insertReply: db.prepare<[
    number,
    number,
    'up' | 'down' | 'none',
    string,
  ]>(
    `INSERT INTO forum_comment_replies (comment_id, author_user_id, vote, body)
     VALUES (?, ?, ?, ?)`,
  ),
  // Has the user already cast a 推 / 噓 vote on this comment? (Used
  // to enforce one ±-vote per user per parent.) Multiple 'none'
  // replies are always allowed.
  findUserVoteOnComment: db.prepare<[number, number]>(
    `SELECT id, vote FROM forum_comment_replies
     WHERE comment_id = ? AND author_user_id = ? AND vote IN ('up', 'down')
     LIMIT 1`,
  ),
  findReplyById: db.prepare<[number]>(
    `SELECT * FROM forum_comment_replies WHERE id = ?`,
  ),
  deleteReply: db.prepare<[number, number]>(
    `DELETE FROM forum_comment_replies WHERE id = ? AND author_user_id = ?`,
  ),
  // All replies on every comment of one post — joined with users
  // for author info. Caller groups by comment_id in JS.
  listRepliesForPost: db.prepare<[number]>(
    `SELECT r.id, r.comment_id, r.vote, r.body, r.created_at,
            u.username AS author_username, u.nickname AS author_nickname,
            u.avatar_path AS author_avatar
     FROM forum_comment_replies r
     JOIN forum_comments c ON c.id = r.comment_id
     JOIN users u ON u.id = r.author_user_id
     WHERE c.post_id = ?
     ORDER BY r.id`,
  ),

  // Likes — toggle-style. Caller checks findLike first, then either
  // insertLike+inc<*>Thumbs or deleteLike+dec<*>Thumbs.
  findLike: db.prepare<[number, string, number]>(
    `SELECT 1 FROM forum_likes WHERE user_id = ? AND target_type = ? AND target_id = ?`,
  ),
  insertLike: db.prepare<[number, string, number]>(
    `INSERT INTO forum_likes (user_id, target_type, target_id) VALUES (?, ?, ?)`,
  ),
  deleteLike: db.prepare<[number, string, number]>(
    `DELETE FROM forum_likes WHERE user_id = ? AND target_type = ? AND target_id = ?`,
  ),
  incPostThumbs: db.prepare<[number]>(
    `UPDATE forum_posts SET thumbs_count = thumbs_count + 1 WHERE id = ?`,
  ),
  decPostThumbs: db.prepare<[number]>(
    `UPDATE forum_posts SET thumbs_count = MAX(0, thumbs_count - 1) WHERE id = ?`,
  ),
  incCommentThumbs: db.prepare<[number]>(
    `UPDATE forum_comments SET thumbs_count = thumbs_count + 1 WHERE id = ?`,
  ),
  decCommentThumbs: db.prepare<[number]>(
    `UPDATE forum_comments SET thumbs_count = MAX(0, thumbs_count - 1) WHERE id = ?`,
  ),
  // AI profile aggregates — total comments and total received likes
  // for one provider (claude/chatgpt/gemini/grok) across the entire
  // forum. Used by the per-AI profile page.
  aiCommentStats: db.prepare<[string]>(
    `SELECT
       COUNT(*) AS total_comments,
       COALESCE(SUM(thumbs_count), 0) AS total_likes
     FROM forum_comments
     WHERE author_type = 'ai' AND author_ai_provider = ?`,
  ),
  // Same shape as aiCommentStats but rolled up for every provider in
  // one query. Inlined into post-detail responses so the comment hover
  // card has stats without N extra round-trips.
  allAIStats: db.prepare(
    `SELECT author_ai_provider AS provider,
            COUNT(*) AS total_comments,
            COALESCE(SUM(thumbs_count), 0) AS total_likes
     FROM forum_comments
     WHERE author_type = 'ai' AND author_ai_provider IS NOT NULL
     GROUP BY author_ai_provider`,
  ),
  // User-side counterparts — user profile page calls these. Stats are
  // computed live (no denormalised counters) since the forum is small.
  // Anonymous contributions are excluded from the public totals — if
  // we counted likes on someone's anonymous post toward their profile,
  // an observer could correlate "user N has 17 likes total but only 12
  // visible" → the missing 5 must be from an anonymous post.
  userPostStats: db.prepare<[number]>(
    `SELECT COUNT(*) AS total_posts,
            COALESCE(SUM(thumbs_count), 0) AS post_likes
     FROM forum_posts WHERE author_user_id = ? AND is_anonymous = 0`,
  ),
  userCommentStats: db.prepare<[number]>(
    `SELECT COUNT(*) AS total_comments,
            COALESCE(SUM(thumbs_count), 0) AS comment_likes
     FROM forum_comments
     WHERE author_user_id = ?
       AND author_type = 'user'
       AND is_anonymous = 0`,
  ),
  userRecentPosts: db.prepare<[number, number]>(
    `SELECT id, title, category, body, thumbs_count, comment_count,
            is_anonymous, created_at
     FROM forum_posts
     WHERE author_user_id = ?
     ORDER BY id DESC
     LIMIT ?`,
  ),
  userRecentComments: db.prepare<[number, number]>(
    `SELECT c.id, c.body, c.thumbs_count, c.created_at, c.is_anonymous,
            p.id AS post_id, p.title AS post_title, p.category AS post_category
     FROM forum_comments c
     JOIN forum_posts p ON p.id = c.post_id
     WHERE c.author_user_id = ? AND c.author_type = 'user'
     ORDER BY c.id DESC
     LIMIT ?`,
  ),
  // Inlined into post-detail responses to back the user hover-card —
  // returns one row per non-anonymous participant (post author + every
  // user commenter on this post) with their cumulative forum stats +
  // tier (for the badge) + user_id (callers compute usage_log totals
  // separately and join on this).
  participantStats: db.prepare<[number, number]>(
    `WITH participants AS (
       SELECT DISTINCT author_user_id AS uid
         FROM forum_comments
         WHERE post_id = ? AND author_type = 'user'
           AND is_anonymous = 0 AND author_user_id IS NOT NULL
       UNION
       SELECT author_user_id AS uid
         FROM forum_posts WHERE id = ? AND is_anonymous = 0
     )
     SELECT u.id AS user_id, u.username, u.nickname, u.tier,
            CASE WHEN u.avatar_path IS NOT NULL THEN 1 ELSE 0 END AS has_avatar,
            u.created_at AS member_since,
            COALESCE(p.cnt, 0) AS total_posts,
            COALESCE(c.cnt, 0) AS total_comments,
            COALESCE(p.likes, 0) + COALESCE(c.likes, 0) AS total_likes
     FROM participants part
     JOIN users u ON u.id = part.uid
     LEFT JOIN (
       SELECT author_user_id, COUNT(*) AS cnt,
              COALESCE(SUM(thumbs_count), 0) AS likes
       FROM forum_posts WHERE is_anonymous = 0
       GROUP BY author_user_id
     ) p ON p.author_user_id = u.id
     LEFT JOIN (
       SELECT author_user_id, COUNT(*) AS cnt,
              COALESCE(SUM(thumbs_count), 0) AS likes
       FROM forum_comments
       WHERE author_type = 'user' AND is_anonymous = 0
       GROUP BY author_user_id
     ) c ON c.author_user_id = u.id`,
  ),
  // Successful-call rollup per (provider, model) for one user — feeds
  // the four "lifetime usage" metrics (tokens, calls, cost, tier).
  // Cost is computed in JS via estimateCost(provider, model, tin, tout)
  // since priced lookup needs price-table knowledge.
  userUsageByModel: db.prepare<[number]>(
    `SELECT provider, model,
            COUNT(*) AS calls,
            COALESCE(SUM(tokens_in), 0) AS tokens_in,
            COALESCE(SUM(tokens_out), 0) AS tokens_out
     FROM usage_log
     WHERE user_id = ? AND success = 1
     GROUP BY provider, model`,
  ),
  // Same shape, scoped to one provider — for the AI profile aggregate.
  aiProviderUsageByModel: db.prepare<[string]>(
    `SELECT provider, model,
            COUNT(*) AS calls,
            COALESCE(SUM(tokens_in), 0) AS tokens_in,
            COALESCE(SUM(tokens_out), 0) AS tokens_out
     FROM usage_log
     WHERE provider = ? AND success = 1
     GROUP BY provider, model`,
  ),
  // Cross-provider usage rollup for the post-detail aiStats map. Caller
  // groups in JS by provider and pipes through estimateCost — one
  // round-trip beats four queries (one per provider).
  allUsageByProviderAndModel: db.prepare(
    `SELECT provider, model,
            COUNT(*) AS calls,
            COALESCE(SUM(tokens_in), 0) AS tokens_in,
            COALESCE(SUM(tokens_out), 0) AS tokens_out
     FROM usage_log
     WHERE success = 1
     GROUP BY provider, model`,
  ),
  // Recent activity for the AI profile — last N comments by this
  // provider, joined with the parent post for context.
  aiRecentComments: db.prepare<[string, number]>(
    `SELECT c.id, c.body, c.thumbs_count, c.created_at, c.is_imported,
            p.id AS post_id, p.title AS post_title, p.category AS post_category
     FROM forum_comments c
     JOIN forum_posts p ON p.id = c.post_id
     WHERE c.author_type = 'ai' AND c.author_ai_provider = ?
     ORDER BY c.id DESC
     LIMIT ?`,
  ),
  // Public list of who liked a target — backs the "點 thumbs 看誰按過"
  // popover. Anonymity at like-time is not yet supported (Phase 2 if
  // wanted); for now usernames are always visible.
  listLikers: db.prepare<[string, number]>(
    `SELECT u.username, u.nickname, u.avatar_path AS avatar_path,
            l.created_at
     FROM forum_likes l
     JOIN users u ON u.id = l.user_id
     WHERE l.target_type = ? AND l.target_id = ?
     ORDER BY l.created_at DESC`,
  ),
  // Liked-by-user lookups — hydrate the `liked` flag on detail view.
  likedPostByUser: db.prepare<[number, number]>(
    `SELECT 1 FROM forum_likes WHERE user_id = ? AND target_type = 'post' AND target_id = ?`,
  ),
  likedCommentsInPost: db.prepare<[number, number]>(
    `SELECT l.target_id
     FROM forum_likes l
     JOIN forum_comments c ON c.id = l.target_id
     WHERE l.user_id = ? AND l.target_type = 'comment' AND c.post_id = ?`,
  ),

  // ── Media library ────────────────────────────────────────────────
  insertPostMedia: db.prepare<[
    number,
    string,
    string,
    number,
    string | null,
    number,
    number,
    number | null,
  ]>(
    `INSERT INTO forum_media
       (post_id, ai_provider, path, mime_type, size, caption,
        is_thumbnail, position, uploaded_by_user_id)
     VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
  ),
  insertAIMedia: db.prepare<[
    string,
    string,
    string,
    number,
    string | null,
    number,
    number,
    number | null,
  ]>(
    `INSERT INTO forum_media
       (post_id, ai_provider, path, mime_type, size, caption,
        is_thumbnail, position, uploaded_by_user_id)
     VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ),
  listMediaForPost: db.prepare<[number]>(
    `SELECT * FROM forum_media WHERE post_id = ? ORDER BY position, id`,
  ),
  listMediaForAI: db.prepare<[string]>(
    `SELECT * FROM forum_media WHERE ai_provider = ? ORDER BY position, id`,
  ),
  // OG image lookup — prefer the row marked is_thumbnail, fall back to
  // the first by position. Used by the SSR meta-tag injector.
  thumbnailForPost: db.prepare<[number]>(
    `SELECT * FROM forum_media
     WHERE post_id = ?
     ORDER BY is_thumbnail DESC, position, id
     LIMIT 1`,
  ),
  findMediaById: db.prepare<[number]>(
    `SELECT * FROM forum_media WHERE id = ?`,
  ),
  deleteMediaById: db.prepare<[number]>(
    `DELETE FROM forum_media WHERE id = ?`,
  ),
  // Clears the thumbnail flag on every other media row for the same
  // owner so only one row per post / per AI persona is the canonical
  // share thumbnail at any time.
  clearPostThumbnailExcept: db.prepare<[number, number]>(
    `UPDATE forum_media SET is_thumbnail = 0 WHERE post_id = ? AND id <> ?`,
  ),
  clearAIThumbnailExcept: db.prepare<[string, number]>(
    `UPDATE forum_media SET is_thumbnail = 0 WHERE ai_provider = ? AND id <> ?`,
  ),
};

export interface MediaRow {
  id: number;
  post_id: number | null;
  ai_provider: string | null;
  path: string;
  mime_type: string;
  size: number;
  caption: string | null;
  is_thumbnail: number;
  position: number;
  uploaded_by_user_id: number | null;
  created_at: number;
}

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
