// Append-only backup of the SQLite app DB to Oracle Autonomous Database.
//
// Design:
//   MAC_USERS        — versioned user records. Whenever a SQLite user row
//                      differs from the latest non-deleted Oracle snapshot,
//                      a new row is appended. If a SQLite user disappears,
//                      a tombstone row (IS_DELETED=1) is appended.
//   MAC_SESSIONS     — same versioning strategy for chat sessions.
//   MAC_MESSAGES     — pure append. SQLite message ids are unique-per-row
//                      and immutable, so we just insert any id beyond the
//                      max already in Oracle.
//   MAC_BACKUP_LOG   — one row per run with counts + status.
//
// SQLite is the source of truth; Oracle is an audit/archive store. Rows in
// Oracle are never updated or deleted by this script.
import oracledb from 'oracledb';
import { db, type SessionRow } from '../lib/db.js';

interface Env {
  user: string;
  password: string;
  connectString: string;
  configDir: string;
  walletLocation: string;
  walletPassword: string;
}

function readEnv(): Env | null {
  const user = process.env.ORACLE_USER;
  const password = process.env.ORACLE_PASSWORD;
  if (!user || !password) return null;
  return {
    user,
    password,
    connectString: process.env.ORACLE_CONNECT_STRING || 'aibase_low',
    configDir: process.env.ORACLE_WALLET_DIR || '',
    walletLocation: process.env.ORACLE_WALLET_DIR || '',
    walletPassword: process.env.ORACLE_WALLET_PASSWORD || '',
  };
}

const DDL: string[] = [
  `CREATE TABLE MAC_USERS (
     ROW_ID         NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
     USER_ID        NUMBER NOT NULL,
     USERNAME       VARCHAR2(255) NOT NULL,
     NICKNAME       VARCHAR2(255),
     EMAIL          VARCHAR2(255),
     PASSWORD_HASH  VARCHAR2(255) NOT NULL,
     TIER           VARCHAR2(16) NOT NULL,
     SRC_CREATED_AT NUMBER NOT NULL,
     SYNCED_AT      TIMESTAMP DEFAULT SYSTIMESTAMP,
     IS_DELETED     NUMBER(1) DEFAULT 0
   )`,
  `CREATE INDEX IX_MAC_USR_USER ON MAC_USERS (USER_ID, SYNCED_AT)`,

  `CREATE TABLE MAC_SESSIONS (
     ROW_ID         NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
     SESSION_ID     VARCHAR2(64) NOT NULL,
     USER_ID        NUMBER NOT NULL,
     TITLE          VARCHAR2(500) NOT NULL,
     CHAT_MODE      VARCHAR2(32) NOT NULL,
     SRC_CREATED_AT NUMBER NOT NULL,
     SRC_UPDATED_AT NUMBER NOT NULL,
     SYNCED_AT      TIMESTAMP DEFAULT SYSTIMESTAMP,
     IS_DELETED     NUMBER(1) DEFAULT 0
   )`,
  `CREATE INDEX IX_MAC_SES_SESSION ON MAC_SESSIONS (SESSION_ID, SYNCED_AT)`,

  `CREATE TABLE MAC_MESSAGES (
     MSG_ID       NUMBER PRIMARY KEY,
     SESSION_ID   VARCHAR2(64) NOT NULL,
     MSG_ROLE     VARCHAR2(8) NOT NULL,
     PROVIDER     VARCHAR2(32),
     MODE_ROLE    VARCHAR2(64),
     CONTENT      CLOB NOT NULL,
     TS           NUMBER NOT NULL,
     SYNCED_AT    TIMESTAMP DEFAULT SYSTIMESTAMP
   )`,
  `CREATE INDEX IX_MAC_MSG_SESSION ON MAC_MESSAGES (SESSION_ID)`,

  `CREATE TABLE MAC_BACKUP_LOG (
     RUN_ID         NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
     RUN_AT         TIMESTAMP DEFAULT SYSTIMESTAMP,
     STATUS         VARCHAR2(16),
     USERS_ADDED    NUMBER DEFAULT 0,
     SESSIONS_ADDED NUMBER DEFAULT 0,
     MESSAGES_ADDED NUMBER DEFAULT 0,
     DURATION_MS    NUMBER,
     ERROR_MESSAGE  VARCHAR2(2000)
   )`,
];

async function ensureTables(conn: oracledb.Connection): Promise<void> {
  for (const stmt of DDL) {
    try {
      await conn.execute(stmt);
    } catch (err) {
      // ORA-00955: name is already used by an existing object — ignore
      // ORA-01408: such column list already indexed — ignore
      const msg = (err as Error).message;
      if (!msg.includes('ORA-00955') && !msg.includes('ORA-01408')) {
        throw err;
      }
    }
  }
  await conn.commit();
}

interface SqliteUser {
  id: number;
  username: string;
  password_hash: string;
  tier: string;
  created_at: number;
  nickname: string;
  email: string;
}

interface SqliteMessage {
  id: number;
  session_id: string;
  role: 'user' | 'ai';
  provider: string | null;
  mode_role: string | null;
  content: string;
  timestamp: number;
}

async function syncUsers(conn: oracledb.Connection): Promise<number> {
  const sqliteUsers = db
    .prepare(
      `SELECT id, username, password_hash, tier, created_at,
              COALESCE(nickname, '') AS nickname,
              COALESCE(email, '')    AS email
         FROM users`,
    )
    .all() as SqliteUser[];

  let added = 0;

  // For each SQLite user: compare with the latest non-deleted Oracle snapshot.
  for (const u of sqliteUsers) {
    const latest = await conn.execute<{
      USERNAME: string;
      NICKNAME: string | null;
      EMAIL: string | null;
      PASSWORD_HASH: string;
      TIER: string;
      IS_DELETED: number;
    }>(
      `SELECT * FROM (
         SELECT USERNAME, NICKNAME, EMAIL, PASSWORD_HASH, TIER, IS_DELETED
           FROM MAC_USERS
          WHERE USER_ID = :id
          ORDER BY SYNCED_AT DESC
       ) WHERE ROWNUM = 1`,
      { id: u.id },
      { outFormat: oracledb.OUT_FORMAT_OBJECT },
    );
    const last = latest.rows?.[0];
    const same =
      last &&
      last.IS_DELETED === 0 &&
      last.USERNAME === u.username &&
      (last.NICKNAME ?? '') === (u.nickname ?? '') &&
      (last.EMAIL ?? '') === (u.email ?? '') &&
      last.PASSWORD_HASH === u.password_hash &&
      last.TIER === u.tier;
    if (same) continue;

    await conn.execute(
      `INSERT INTO MAC_USERS
         (USER_ID, USERNAME, NICKNAME, EMAIL, PASSWORD_HASH, TIER, SRC_CREATED_AT, IS_DELETED)
       VALUES
         (:id, :username, :nickname, :email, :hash, :tier, :created, 0)`,
      {
        id: u.id,
        username: u.username,
        nickname: u.nickname || null,
        email: u.email || null,
        hash: u.password_hash,
        tier: u.tier,
        created: u.created_at,
      },
    );
    added++;
  }

  // Detect users deleted from SQLite — append tombstone rows.
  const sqliteIds = new Set(sqliteUsers.map((u) => u.id));
  const liveOracleIds = await conn.execute<{ USER_ID: number }>(
    `SELECT USER_ID FROM (
       SELECT USER_ID, IS_DELETED,
              ROW_NUMBER() OVER (PARTITION BY USER_ID ORDER BY SYNCED_AT DESC) RN
         FROM MAC_USERS
     ) WHERE RN = 1 AND IS_DELETED = 0`,
    {},
    { outFormat: oracledb.OUT_FORMAT_OBJECT },
  );
  for (const row of liveOracleIds.rows ?? []) {
    if (!sqliteIds.has(row.USER_ID)) {
      // Need to look up the latest snapshot to copy its values into the tombstone
      const last = await conn.execute<{
        USERNAME: string;
        NICKNAME: string | null;
        EMAIL: string | null;
        PASSWORD_HASH: string;
        TIER: string;
        SRC_CREATED_AT: number;
      }>(
        `SELECT * FROM (
           SELECT USERNAME, NICKNAME, EMAIL, PASSWORD_HASH, TIER, SRC_CREATED_AT
             FROM MAC_USERS WHERE USER_ID = :id
             ORDER BY SYNCED_AT DESC
         ) WHERE ROWNUM = 1`,
        { id: row.USER_ID },
        { outFormat: oracledb.OUT_FORMAT_OBJECT },
      );
      const r = last.rows?.[0];
      if (!r) continue;
      await conn.execute(
        `INSERT INTO MAC_USERS
           (USER_ID, USERNAME, NICKNAME, EMAIL, PASSWORD_HASH, TIER, SRC_CREATED_AT, IS_DELETED)
         VALUES
           (:id, :username, :nickname, :email, :hash, :tier, :created, 1)`,
        {
          id: row.USER_ID,
          username: r.USERNAME,
          nickname: r.NICKNAME,
          email: r.EMAIL,
          hash: r.PASSWORD_HASH,
          tier: r.TIER,
          created: r.SRC_CREATED_AT,
        },
      );
      added++;
    }
  }

  return added;
}

async function syncSessions(conn: oracledb.Connection): Promise<number> {
  const rows = db
    .prepare(`SELECT id, user_id, title, mode, created_at, updated_at FROM chat_sessions`)
    .all() as SessionRow[];

  let added = 0;

  for (const s of rows) {
    const latest = await conn.execute<{
      TITLE: string;
      CHAT_MODE: string;
      USER_ID: number;
      IS_DELETED: number;
    }>(
      `SELECT * FROM (
         SELECT TITLE, CHAT_MODE, USER_ID, IS_DELETED
           FROM MAC_SESSIONS
          WHERE SESSION_ID = :id
          ORDER BY SYNCED_AT DESC
       ) WHERE ROWNUM = 1`,
      { id: s.id },
      { outFormat: oracledb.OUT_FORMAT_OBJECT },
    );
    const last = latest.rows?.[0];
    const same =
      last &&
      last.IS_DELETED === 0 &&
      last.TITLE === s.title &&
      last.CHAT_MODE === s.mode &&
      last.USER_ID === s.user_id;
    if (same) continue;

    await conn.execute(
      `INSERT INTO MAC_SESSIONS
         (SESSION_ID, USER_ID, TITLE, CHAT_MODE, SRC_CREATED_AT, SRC_UPDATED_AT, IS_DELETED)
       VALUES (:sid, :uid, :title, :mode, :created, :updated, 0)`,
      {
        sid: s.id,
        uid: s.user_id,
        title: s.title,
        mode: s.mode,
        created: s.created_at,
        updated: s.updated_at,
      },
    );
    added++;
  }

  // Tombstones for deleted sessions
  const sqliteIds = new Set(rows.map((r) => r.id));
  const live = await conn.execute<{ SESSION_ID: string }>(
    `SELECT SESSION_ID FROM (
       SELECT SESSION_ID, IS_DELETED,
              ROW_NUMBER() OVER (PARTITION BY SESSION_ID ORDER BY SYNCED_AT DESC) RN
         FROM MAC_SESSIONS
     ) WHERE RN = 1 AND IS_DELETED = 0`,
    {},
    { outFormat: oracledb.OUT_FORMAT_OBJECT },
  );
  for (const r of live.rows ?? []) {
    if (!sqliteIds.has(r.SESSION_ID)) {
      const last = await conn.execute<{
        USER_ID: number;
        TITLE: string;
        CHAT_MODE: string;
        SRC_CREATED_AT: number;
        SRC_UPDATED_AT: number;
      }>(
        `SELECT * FROM (
           SELECT USER_ID, TITLE, CHAT_MODE, SRC_CREATED_AT, SRC_UPDATED_AT
             FROM MAC_SESSIONS WHERE SESSION_ID = :sid
             ORDER BY SYNCED_AT DESC
         ) WHERE ROWNUM = 1`,
        { sid: r.SESSION_ID },
        { outFormat: oracledb.OUT_FORMAT_OBJECT },
      );
      const x = last.rows?.[0];
      if (!x) continue;
      await conn.execute(
        `INSERT INTO MAC_SESSIONS
           (SESSION_ID, USER_ID, TITLE, CHAT_MODE, SRC_CREATED_AT, SRC_UPDATED_AT, IS_DELETED)
         VALUES (:sid, :uid, :title, :mode, :created, :updated, 1)`,
        {
          sid: r.SESSION_ID,
          uid: x.USER_ID,
          title: x.TITLE,
          mode: x.CHAT_MODE,
          created: x.SRC_CREATED_AT,
          updated: x.SRC_UPDATED_AT,
        },
      );
      added++;
    }
  }

  return added;
}

async function syncMessages(conn: oracledb.Connection): Promise<number> {
  const maxRow = await conn.execute<{ MAX_ID: number | null }>(
    `SELECT MAX(MSG_ID) AS MAX_ID FROM MAC_MESSAGES`,
    {},
    { outFormat: oracledb.OUT_FORMAT_OBJECT },
  );
  const maxId = maxRow.rows?.[0]?.MAX_ID ?? 0;

  const rows = db
    .prepare(
      `SELECT id, session_id, role, provider, mode_role, content, timestamp
         FROM chat_messages
        WHERE id > ?
        ORDER BY id`,
    )
    .all(maxId) as SqliteMessage[];

  for (const m of rows) {
    await conn.execute(
      `INSERT INTO MAC_MESSAGES
         (MSG_ID, SESSION_ID, MSG_ROLE, PROVIDER, MODE_ROLE, CONTENT, TS)
       VALUES (:id, :sid, :role, :provider, :modeRole, :content, :ts)`,
      {
        id: m.id,
        sid: m.session_id,
        role: m.role,
        provider: m.provider,
        modeRole: m.mode_role,
        content: m.content,
        ts: m.timestamp,
      },
    );
  }

  return rows.length;
}

async function main() {
  const env = readEnv();
  if (!env) {
    console.log('Oracle backup disabled (ORACLE_USER / ORACLE_PASSWORD not set).');
    return;
  }

  const start = Date.now();
  let conn: oracledb.Connection | null = null;
  let usersAdded = 0;
  let sessionsAdded = 0;
  let messagesAdded = 0;
  let status = 'ok';
  let errMsg: string | null = null;

  try {
    conn = await oracledb.getConnection({
      user: env.user,
      password: env.password,
      connectString: env.connectString,
      configDir: env.configDir,
      walletLocation: env.walletLocation,
      walletPassword: env.walletPassword,
    });

    await ensureTables(conn);
    usersAdded = await syncUsers(conn);
    sessionsAdded = await syncSessions(conn);
    messagesAdded = await syncMessages(conn);
    await conn.commit();
  } catch (err) {
    status = 'error';
    errMsg = (err as Error).message;
    console.error('Oracle backup failed:', errMsg);
    if (conn) await conn.rollback().catch(() => {});
  }

  const durationMs = Date.now() - start;

  if (conn) {
    try {
      await conn.execute(
        `INSERT INTO MAC_BACKUP_LOG
           (STATUS, USERS_ADDED, SESSIONS_ADDED, MESSAGES_ADDED, DURATION_MS, ERROR_MESSAGE)
         VALUES (:st, :u, :s, :m, :d, :e)`,
        {
          st: status,
          u: usersAdded,
          s: sessionsAdded,
          m: messagesAdded,
          d: durationMs,
          e: errMsg ? errMsg.slice(0, 2000) : null,
        },
      );
      await conn.commit();
    } catch (err) {
      console.error('failed to write backup log:', (err as Error).message);
    }
    await conn.close().catch(() => {});
  }

  console.log(
    `[oracle-backup] status=${status} users+=${usersAdded} sessions+=${sessionsAdded} messages+=${messagesAdded} ${durationMs}ms`,
  );

  if (status !== 'ok') process.exit(1);
}

main();
