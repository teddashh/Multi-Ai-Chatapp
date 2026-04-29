import React, { useCallback, useEffect, useState } from 'react';
import {
  adminGetApiKeySpending,
  adminGetModelStats,
  adminGetSession,
  adminGetUsage,
  adminListAudit,
  adminListUserSessions,
  adminRunDigest,
  createUser,
  deleteUser,
  inviteUser,
  listUsers,
  updateUser,
  type AdminSessionDetail,
  type AdminSessionSummary,
  type AdminUser,
  type ApiKeyChannel,
  type AuditEntry,
  type ModelStatRow,
  type UsageRow,
  type User,
} from '../api';
import type { Tier } from '../shared/types';
import { AI_PROVIDERS } from '../shared/constants';
import { useT } from '../i18n';

interface Props {
  currentUser: User;
  onExit: () => void;
}

type View = 'users' | 'audit' | 'stats' | 'models' | 'spending' | 'user-detail' | 'session-viewer';

const TIERS: Tier[] = ['free', 'standard', 'pro', 'super', 'admin'];

function fmtTime(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleString();
}

function shortTime(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) {
    return d.toLocaleTimeString();
  }
  return d.toLocaleString();
}

export default function AdminPage({ currentUser, onExit }: Props) {
  const t = useT();
  const [view, setView] = useState<View>('users');
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [selectedUsername, setSelectedUsername] = useState<string | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const refreshUsers = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setUsers(await listUsers());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshUsers();
  }, [refreshUsers]);

  const goUserDetail = (username: string) => {
    setSelectedUsername(username);
    setView('user-detail');
  };

  const goSessionViewer = (sessionId: string) => {
    setSelectedSessionId(sessionId);
    setView('session-viewer');
  };

  return (
    <div className="min-h-screen flex flex-col bg-gray-950">
      {/* Top bar */}
      <div className="flex-none border-b border-gray-800 px-4 py-3 flex items-center justify-between bg-gray-900">
        <div className="flex items-center gap-4">
          <button
            onClick={onExit}
            className="text-gray-400 hover:text-white text-sm"
            title="Back"
          >
            ← {t.appName}
          </button>
          <h1 className="text-lg font-bold">Admin</h1>
        </div>
        <div className="text-xs text-gray-400">
          {currentUser.nickname || currentUser.username}{' '}
          <span className="px-1.5 py-0.5 rounded bg-gray-800 text-[10px] uppercase tracking-wider">
            {currentUser.tier}
          </span>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex-none border-b border-gray-800 px-4 py-2 flex gap-2 bg-gray-900">
        {([
          ['users', '使用者 / Users'],
          ['stats', '用量 / Usage'],
          ['spending', 'API Key 花費'],
          ['models', 'Model 健康度'],
          ['audit', '稽核紀錄 / Audit'],
        ] as Array<[View, string]>).map(([k, label]) => (
          <button
            key={k}
            onClick={() => setView(k)}
            className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
              view === k || (k === 'users' && (view === 'user-detail' || view === 'session-viewer'))
                ? 'bg-blue-600 text-white'
                : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {error && (
        <div className="flex-none mx-4 mt-3 text-xs text-red-400 bg-red-900/30 border border-red-800 rounded p-2">
          {error}
        </div>
      )}

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-4">
        {view === 'users' && (
          <UsersList
            users={users}
            loading={loading}
            currentUsername={currentUser.username}
            onSelect={goUserDetail}
            onRefresh={refreshUsers}
            onError={setError}
          />
        )}
        {view === 'user-detail' && selectedUsername && (
          <UserDetail
            username={selectedUsername}
            users={users}
            currentUsername={currentUser.username}
            onBack={() => setView('users')}
            onUpdated={refreshUsers}
            onOpenSession={goSessionViewer}
            onError={setError}
          />
        )}
        {view === 'session-viewer' && selectedSessionId && (
          <SessionViewer
            sessionId={selectedSessionId}
            onBack={() => setView('user-detail')}
            onError={setError}
          />
        )}
        {view === 'audit' && <AuditList onError={setError} />}
        {view === 'stats' && <StatsView onError={setError} />}
        {view === 'models' && <ModelStatsView onError={setError} />}
        {view === 'spending' && <SpendingView onError={setError} />}
      </div>
    </div>
  );
}

// =====================================================================
// Users list — table + invite form
// =====================================================================

function UsersList({
  users,
  loading,
  currentUsername,
  onSelect,
  onRefresh,
  onError,
}: {
  users: AdminUser[];
  loading: boolean;
  currentUsername: string;
  onSelect: (u: string) => void;
  onRefresh: () => void;
  onError: (msg: string) => void;
}) {
  const t = useT();
  const [showInvite, setShowInvite] = useState(false);
  const [inv, setInv] = useState({
    email: '',
    real_name: '',
    nickname: '',
    tier: 'standard' as Tier,
  });
  const [inviteResult, setInviteResult] = useState<{
    inviteUrl: string;
    username: string;
    emailSent: boolean;
  } | null>(null);
  const [copied, setCopied] = useState(false);

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    onError('');
    setInviteResult(null);
    setCopied(false);
    try {
      const r = await inviteUser({
        email: inv.email.trim(),
        tier: inv.tier,
        nickname: inv.nickname.trim() || undefined,
        real_name: inv.real_name.trim() || undefined,
      });
      setInviteResult(r);
      setInv({ email: '', real_name: '', nickname: '', tier: 'standard' });
      onRefresh();
    } catch (err) {
      onError((err as Error).message);
    }
  };

  const handleCopyInvite = () => {
    if (!inviteResult) return;
    navigator.clipboard.writeText(inviteResult.inviteUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-sm text-gray-300">
          {users.length} accounts
        </div>
        <button
          onClick={() => setShowInvite((s) => !s)}
          className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 rounded text-xs font-medium"
        >
          {showInvite ? '▲ 關閉' : '+ 邀請使用者 / Invite'}
        </button>
      </div>

      {showInvite && (
        <form
          onSubmit={handleInvite}
          className="bg-gray-900 border border-gray-700 rounded p-3 space-y-2"
        >
          <div className="grid grid-cols-2 gap-2">
            <input
              type="email"
              placeholder="email *"
              value={inv.email}
              onChange={(e) => setInv((p) => ({ ...p, email: e.target.value }))}
              required
              className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs"
            />
            <input
              type="text"
              placeholder="真實姓名（admin 可見）"
              value={inv.real_name}
              onChange={(e) => setInv((p) => ({ ...p, real_name: e.target.value }))}
              className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs"
            />
            <input
              type="text"
              placeholder="暱稱（預設值，可空）"
              value={inv.nickname}
              onChange={(e) => setInv((p) => ({ ...p, nickname: e.target.value }))}
              className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs"
            />
            <select
              value={inv.tier}
              onChange={(e) => setInv((p) => ({ ...p, tier: e.target.value as Tier }))}
              className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs"
            >
              {TIERS.map((tt) => (
                <option key={tt} value={tt}>{tt}</option>
              ))}
            </select>
            <button
              type="submit"
              disabled={!inv.email.trim()}
              className="col-span-2 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-30 rounded text-xs font-medium"
            >
              邀請使用者
            </button>
          </div>
          <p className="text-[11px] text-gray-500">
            Username 會自動從 email 產生（衝突會加數字）。系統同時寄信給對方，並回傳一個你可以另外分享的連結（7 天有效）。
          </p>
          {inviteResult && (
            <div className="bg-gray-800 border border-emerald-700/50 rounded p-2 space-y-1">
              <div className="text-[11px] text-emerald-400">
                ✓ 已建立帳號 <code className="bg-gray-900 px-1 rounded">{inviteResult.username}</code>
                {inviteResult.emailSent ? '，邀請信已寄出。' : '。寄信失敗，請改用下方連結。'}
              </div>
              <div className="flex items-center gap-2">
                <input
                  readOnly
                  value={inviteResult.inviteUrl}
                  onFocus={(e) => e.currentTarget.select()}
                  className="flex-1 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-[11px] font-mono"
                />
                <button
                  type="button"
                  onClick={handleCopyInvite}
                  className="px-2 py-1 bg-gray-700 hover:bg-gray-600 rounded text-[11px]"
                >
                  {copied ? '✓ 已複製' : '複製'}
                </button>
              </div>
            </div>
          )}
        </form>
      )}

      {loading ? (
        <div className="text-xs text-gray-500">{t.loading}</div>
      ) : (
        <div className="overflow-x-auto bg-gray-900 border border-gray-700 rounded">
          <table className="w-full text-xs">
            <thead className="bg-gray-800 text-gray-400">
              <tr>
                <th className="px-3 py-2 text-left">Username</th>
                <th className="px-3 py-2 text-left">真實姓名</th>
                <th className="px-3 py-2 text-left">暱稱</th>
                <th className="px-3 py-2 text-left">Email</th>
                <th className="px-3 py-2 text-left">Tier</th>
                <th className="px-3 py-2 text-right">呼叫</th>
                <th className="px-3 py-2 text-right">Tokens (in / out)</th>
                <th className="px-3 py-2 text-right">$</th>
                <th className="px-3 py-2 text-left">建立</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const totalTokens = u.total_tokens_in + u.total_tokens_out;
                const cost = u.total_cost_usd;
                const fmtCost =
                  cost === 0
                    ? '—'
                    : `$${cost.toFixed(cost < 1 ? 4 : 2)}`;
                return (
                  <tr
                    key={u.id}
                    className="border-t border-gray-800 hover:bg-gray-800/50 cursor-pointer"
                    onClick={() => onSelect(u.username)}
                  >
                    <td className="px-3 py-2 font-medium">
                      {u.username}
                      {u.username === currentUsername && (
                        <span className="ml-1 text-[10px] text-gray-500">(you)</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-gray-300">{u.real_name ?? '—'}</td>
                    <td className="px-3 py-2 text-gray-300">{u.nickname ?? '—'}</td>
                    <td className="px-3 py-2 text-gray-400">{u.email ?? '—'}</td>
                    <td className="px-3 py-2">
                      <span className="px-1.5 py-0.5 rounded bg-gray-800 text-[10px] uppercase">
                        {u.tier}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right font-mono">
                      {u.total_calls > 0 ? u.total_calls.toLocaleString() : '—'}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-[11px]">
                      {totalTokens > 0
                        ? `${u.total_tokens_in.toLocaleString()} / ${u.total_tokens_out.toLocaleString()}`
                        : '—'}
                    </td>
                    <td className="px-3 py-2 text-right font-mono">{fmtCost}</td>
                    <td className="px-3 py-2 text-gray-500">{shortTime(u.created_at)}</td>
                    <td className="px-3 py-2 text-right">
                      <span className="text-gray-500 text-[10px]">→</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// =====================================================================
// User detail — edit fields + session list (incl. soft-deleted)
// =====================================================================

function UserDetail({
  username,
  users,
  currentUsername,
  onBack,
  onUpdated,
  onOpenSession,
  onError,
}: {
  username: string;
  users: AdminUser[];
  currentUsername: string;
  onBack: () => void;
  onUpdated: () => void;
  onOpenSession: (id: string) => void;
  onError: (msg: string) => void;
}) {
  const u = users.find((x) => x.username === username);
  const [realName, setRealName] = useState(u?.real_name ?? '');
  const [nickname, setNickname] = useState(u?.nickname ?? '');
  const [email, setEmail] = useState(u?.email ?? '');
  const [tier, setTier] = useState<Tier>(u?.tier ?? 'standard');
  const [newPass, setNewPass] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [sessions, setSessions] = useState<AdminSessionSummary[]>([]);
  const [showActiveOnly, setShowActiveOnly] = useState(false);

  useEffect(() => {
    if (!u) return;
    setRealName(u.real_name ?? '');
    setNickname(u.nickname ?? '');
    setEmail(u.email ?? '');
    setTier(u.tier);
    setNewPass('');
    setSaved(false);
  }, [u]);

  useEffect(() => {
    onError('');
    adminListUserSessions(username)
      .then(setSessions)
      .catch((err: Error) => onError(err.message));
  }, [username, onError]);

  if (!u) {
    return (
      <div className="text-sm text-gray-400">User not found.</div>
    );
  }

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setSaved(false);
    try {
      await updateUser(username, {
        real_name: realName || undefined,
        nickname: nickname || undefined,
        email: email || undefined,
        tier,
        password: newPass || undefined,
      });
      setSaved(true);
      setNewPass('');
      onUpdated();
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm(`刪除 '${username}' ?`)) return;
    try {
      await deleteUser(username);
      onUpdated();
      onBack();
    } catch (err) {
      onError((err as Error).message);
    }
  };

  const visibleSessions = showActiveOnly
    ? sessions.filter((s) => s.deleted_at === null)
    : sessions;

  return (
    <div className="space-y-4 max-w-3xl">
      <button
        onClick={onBack}
        className="text-xs text-gray-400 hover:text-white"
      >
        ← 回使用者清單
      </button>

      <form
        onSubmit={handleSave}
        className="bg-gray-900 border border-gray-700 rounded p-4 space-y-3"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-bold">{u.username}</h2>
          <button
            type="button"
            onClick={handleDelete}
            disabled={u.username === currentUsername}
            className="text-xs text-red-400 hover:text-red-300 disabled:opacity-30 disabled:cursor-not-allowed"
          >
            刪除帳號
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3 text-xs">
          <div>
            <label className="text-gray-400 block mb-1">真實姓名（admin 可見）</label>
            <input
              type="text"
              value={realName}
              onChange={(e) => setRealName(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5"
            />
          </div>
          <div>
            <label className="text-gray-400 block mb-1">暱稱</label>
            <input
              type="text"
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5"
            />
          </div>
          <div>
            <label className="text-gray-400 block mb-1">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5"
            />
          </div>
          <div>
            <label className="text-gray-400 block mb-1">Tier</label>
            <select
              value={tier}
              onChange={(e) => setTier(e.target.value as Tier)}
              disabled={u.username === currentUsername}
              className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 disabled:opacity-50"
            >
              {TIERS.map((tt) => (
                <option key={tt} value={tt}>{tt}</option>
              ))}
            </select>
          </div>
          <div className="col-span-2">
            <label className="text-gray-400 block mb-1">重設密碼（留空不改）</label>
            <input
              type="password"
              value={newPass}
              onChange={(e) => setNewPass(e.target.value)}
              autoComplete="new-password"
              className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5"
            />
          </div>
        </div>

        {saved && <p className="text-xs text-emerald-400">✓ 已儲存</p>}

        <button
          type="submit"
          disabled={busy}
          className="px-4 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded text-xs font-medium"
        >
          儲存
        </button>
      </form>

      {/* Sessions */}
      <div className="bg-gray-900 border border-gray-700 rounded">
        <div className="p-3 border-b border-gray-800 flex items-center justify-between">
          <h3 className="text-sm font-bold">對話記錄（包含已刪除）</h3>
          <label className="text-xs text-gray-400 flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={showActiveOnly}
              onChange={(e) => setShowActiveOnly(e.target.checked)}
            />
            只看現有
          </label>
        </div>
        {visibleSessions.length === 0 ? (
          <div className="p-4 text-xs text-gray-500">沒有對話</div>
        ) : (
          <table className="w-full text-xs">
            <thead className="bg-gray-800 text-gray-400">
              <tr>
                <th className="px-3 py-2 text-left">標題</th>
                <th className="px-3 py-2 text-left">模式</th>
                <th className="px-3 py-2 text-left">訊息</th>
                <th className="px-3 py-2 text-left">最後更新</th>
                <th className="px-3 py-2 text-left">狀態</th>
              </tr>
            </thead>
            <tbody>
              {visibleSessions.map((s) => (
                <tr
                  key={s.id}
                  onClick={() => onOpenSession(s.id)}
                  className={`border-t border-gray-800 hover:bg-gray-800/50 cursor-pointer ${
                    s.deleted_at ? 'opacity-60' : ''
                  }`}
                >
                  <td className="px-3 py-2">{s.title}</td>
                  <td className="px-3 py-2 text-gray-400">{s.mode}</td>
                  <td className="px-3 py-2 text-gray-500">{s.msg_count}</td>
                  <td className="px-3 py-2 text-gray-500">{shortTime(s.updated_at)}</td>
                  <td className="px-3 py-2">
                    {s.deleted_at ? (
                      <span className="text-red-400">已刪除</span>
                    ) : (
                      <span className="text-gray-500">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// =====================================================================
// Session viewer — read-only chat replay (audited)
// =====================================================================

function SessionViewer({
  sessionId,
  onBack,
  onError,
}: {
  sessionId: string;
  onBack: () => void;
  onError: (msg: string) => void;
}) {
  const [data, setData] = useState<AdminSessionDetail | null>(null);

  useEffect(() => {
    onError('');
    adminGetSession(sessionId)
      .then(setData)
      .catch((err: Error) => onError(err.message));
  }, [sessionId, onError]);

  if (!data) {
    return <div className="text-xs text-gray-500">載入中...</div>;
  }

  return (
    <div className="space-y-3 max-w-4xl">
      <button onClick={onBack} className="text-xs text-gray-400 hover:text-white">
        ← 回使用者
      </button>
      <div className="bg-gray-900 border border-gray-700 rounded p-3">
        <div className="flex items-center gap-2 mb-2">
          <h2 className="text-sm font-bold flex-1">{data.session.title}</h2>
          {data.session.deleted_at && (
            <span className="text-xs text-red-400">已刪除 · {fmtTime(data.session.deleted_at)}</span>
          )}
        </div>
        <div className="text-[11px] text-gray-500">
          {data.session.owner && (
            <>
              使用者: {data.session.owner.real_name || data.session.owner.username}
              （{data.session.owner.username}）·{' '}
            </>
          )}
          模式: {data.session.mode} · 建立: {fmtTime(data.session.created_at)} · 更新:{' '}
          {fmtTime(data.session.updated_at)}
        </div>
      </div>

      <div className="bg-gray-900 border border-gray-700 rounded p-3 space-y-3 max-h-[70vh] overflow-y-auto">
        {data.messages.map((m) => {
          if (m.role === 'user') {
            return (
              <div
                key={m.id}
                className="bg-blue-600/15 border border-blue-700/30 rounded p-2 text-sm whitespace-pre-wrap"
              >
                <div className="text-[10px] text-gray-500 mb-1">user</div>
                {m.content}
                {m.attachments && m.attachments.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {m.attachments.map((a) => {
                      // Admin endpoint bypasses ownership check.
                      const url = `/api/admin/attachments/${a.id}`;
                      if (a.kind === 'image') {
                        return (
                          <a
                            key={a.id}
                            href={url}
                            target="_blank"
                            rel="noopener noreferrer"
                            title={a.filename}
                          >
                            <img
                              src={url}
                              alt={a.filename}
                              className="max-h-32 max-w-[180px] rounded object-cover border border-blue-800/40"
                            />
                          </a>
                        );
                      }
                      const icon =
                        a.kind === 'pdf' ? '📕' : a.kind === 'text' ? '📝' : '📎';
                      return (
                        <a
                          key={a.id}
                          href={url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-1.5 bg-blue-900/30 border border-blue-800/40 rounded px-2 py-1 text-xs hover:bg-blue-900/50"
                          title={a.filename}
                        >
                          <span>{icon}</span>
                          <span className="max-w-[160px] truncate">{a.filename}</span>
                          <span className="text-[10px] text-gray-400">
                            ({Math.round(a.size / 1024)}KB)
                          </span>
                        </a>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          }
          const info = m.provider ? AI_PROVIDERS[m.provider] : undefined;
          return (
            <div
              key={m.id}
              className="bg-gray-800 border border-gray-700 rounded p-2 text-sm"
            >
              <div
                className="text-[10px] font-semibold mb-1"
                style={{ color: info?.color ?? '#9ca3af' }}
              >
                {info?.name ?? m.provider ?? 'AI'}
                {m.modeRole && (
                  <span className="ml-1 text-gray-500 font-normal">({m.modeRole})</span>
                )}
              </div>
              <div className="whitespace-pre-wrap">{m.content}</div>
            </div>
          );
        })}
      </div>
      <p className="text-[10px] text-gray-600 text-center">
        瀏覽此對話已寫入 audit trail
      </p>
    </div>
  );
}

// =====================================================================
// Audit log
// =====================================================================

function AuditList({ onError }: { onError: (msg: string) => void }) {
  const [rows, setRows] = useState<AuditEntry[] | null>(null);
  useEffect(() => {
    onError('');
    adminListAudit(300)
      .then(setRows)
      .catch((err: Error) => onError(err.message));
  }, [onError]);

  if (!rows) return <div className="text-xs text-gray-500">載入中...</div>;
  if (rows.length === 0) {
    return <div className="text-xs text-gray-500">沒有 audit 紀錄</div>;
  }

  return (
    <div className="space-y-2">
      {rows.map((r) => (
        <AuditCard key={r.id} row={r} />
      ))}
    </div>
  );
}

// One audit row as a card. The previous table layout broke on mobile —
// the metadata column was wider than the viewport because some entries
// (model_fallback journey) carry chunky JSON. Cards stack vertically and
// give each field its own line, so phones don't get a horizontal scroll.
function AuditCard({ row }: { row: AuditEntry }) {
  const meta = row.metadata as Record<string, unknown> | null;
  const isFallback = row.action === 'model_fallback';

  // Compact summary for fallback events — show the journey as
  // arrows so admin doesn't have to read JSON.
  const fallbackSummary = isFallback && meta && Array.isArray(meta.journey)
    ? (meta.journey as Array<{ stage: string; outcome: string; error?: string }>)
        .map((s) => `${s.stage}=${s.outcome}${s.error ? `(${s.error})` : ''}`)
        .join(' → ')
    : null;

  return (
    <div className="bg-gray-900 border border-gray-700 rounded p-3 text-xs">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 mb-1">
        <span className="text-gray-500 whitespace-nowrap">{shortTime(row.timestamp)}</span>
        <span className="font-mono text-[11px] px-1.5 py-0.5 rounded bg-gray-800 text-gray-300">
          {row.action}
        </span>
        <span className="text-gray-400">
          <span className="text-gray-600">by</span> {row.admin ?? '—'}
          {row.target_user && row.target_user !== row.admin && (
            <>
              {' '}
              <span className="text-gray-600">→</span> {row.target_user}
            </>
          )}
        </span>
      </div>
      {fallbackSummary && (
        <div className="text-[11px] font-mono text-gray-300 mb-1 break-all">
          {(meta?.provider as string) ?? '?'}: {fallbackSummary}
        </div>
      )}
      {meta && (
        <details className="text-[11px] text-gray-500">
          <summary className="cursor-pointer text-gray-600 hover:text-gray-400 select-none">
            {isFallback ? 'JSON 細節' : '細節'}
          </summary>
          <pre className="mt-1 font-mono text-[10.5px] whitespace-pre-wrap break-all bg-gray-950 border border-gray-800 rounded p-2 leading-relaxed">
            {JSON.stringify(meta, null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
}

// =====================================================================
// Stats — per-user totals + per-(user, model) breakdown
// =====================================================================

function StatsView({ onError }: { onError: (msg: string) => void }) {
  const [rows, setRows] = useState<UsageRow[] | null>(null);
  useEffect(() => {
    onError('');
    adminGetUsage()
      .then(setRows)
      .catch((err: Error) => onError(err.message));
  }, [onError]);

  if (!rows) return <div className="text-xs text-gray-500">載入中...</div>;

  // Sort by estimated cost desc — that's the most actionable signal.
  const sorted = [...rows].sort((a, b) => b.totals.cost_usd - a.totals.cost_usd);
  const grandTotal = sorted.reduce((sum, u) => sum + u.totals.cost_usd, 0);

  const fmtCost = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`;

  return (
    <div className="space-y-4">
      <div className="bg-gray-900 border border-gray-700 rounded p-3 flex items-center justify-between">
        <span className="text-xs text-gray-400">總估算費用（所有使用者）</span>
        <span className="text-lg font-bold font-mono">{fmtCost(grandTotal)}</span>
      </div>
      <p className="text-[11px] text-gray-500 leading-relaxed">
        Grok 的 token 數與費用是 xAI API 實際扣的。Claude / ChatGPT / Gemini 走訂閱方案，不直接照
        token 收錢；這裡的費用是用「等價 metered API 牌價」推算給你做參考（標 ⚠ 表示 token 為估算值）。
        牌價在 server <code>shared/prices.ts</code> 改。
      </p>

      {sorted.map((u) => (
        <div key={u.id} className="bg-gray-900 border border-gray-700 rounded p-3">
          <div className="flex items-center justify-between mb-2">
            <div>
              <div className="text-sm font-bold">
                {u.real_name || u.nickname || u.username}
                <span className="ml-2 text-[10px] text-gray-500">{u.username}</span>
              </div>
              <div className="text-[10px] text-gray-500">tier: {u.tier}</div>
            </div>
            <div className="text-right text-xs">
              <div>
                <span className="text-gray-400">呼叫: </span>
                <span className="font-mono">{u.totals.calls}</span>
                <span className="text-gray-400 ml-2">tokens: </span>
                <span className="font-mono">
                  {u.totals.tokens_in.toLocaleString()} /{' '}
                  {u.totals.tokens_out.toLocaleString()}
                </span>
              </div>
              <div className="text-sm font-bold mt-0.5">{fmtCost(u.totals.cost_usd)}</div>
            </div>
          </div>

          {u.by_model.length > 0 ? (
            <table className="w-full text-xs">
              <thead className="text-gray-500">
                <tr className="border-b border-gray-800">
                  <th className="text-left py-1">Provider</th>
                  <th className="text-left py-1">Model</th>
                  <th className="text-right py-1">Calls</th>
                  <th className="text-right py-1">Tokens In</th>
                  <th className="text-right py-1">Tokens Out</th>
                  <th className="text-right py-1">Cost</th>
                </tr>
              </thead>
              <tbody>
                {u.by_model.map((m) => (
                  <tr key={`${m.provider}-${m.model}`} className="border-b border-gray-800/50">
                    <td className="py-1 text-gray-400">{m.provider}</td>
                    <td className="py-1 font-mono">{m.model}</td>
                    <td className="py-1 text-right font-mono">{m.calls}</td>
                    <td className="py-1 text-right font-mono">
                      {m.tokens_in.toLocaleString()}
                      {m.is_estimated && <span className="text-yellow-500 ml-1" title="估算值">⚠</span>}
                    </td>
                    <td className="py-1 text-right font-mono">
                      {m.tokens_out.toLocaleString()}
                      {m.is_estimated && <span className="text-yellow-500 ml-1" title="估算值">⚠</span>}
                    </td>
                    <td className="py-1 text-right font-mono">{fmtCost(m.cost_usd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-[11px] text-gray-500">尚無使用紀錄</p>
          )}
        </div>
      ))}
    </div>
  );
}

// =====================================================================
// Model health — per-(provider, model) success rate + recent error codes
// =====================================================================

function ModelStatsView({ onError }: { onError: (msg: string) => void }) {
  const [rows, setRows] = useState<ModelStatRow[] | null>(null);
  useEffect(() => {
    onError('');
    adminGetModelStats()
      .then(setRows)
      .catch((err: Error) => onError(err.message));
  }, [onError]);

  if (!rows) return <div className="text-xs text-gray-500">載入中...</div>;

  const fmtRate = (r: number | null) => (r === null ? '—' : `${(r * 100).toFixed(1)}%`);
  const rateColor = (r: number | null, attempts: number) => {
    if (r === null || attempts === 0) return 'text-gray-500';
    if (r >= 0.98) return 'text-green-400';
    if (r >= 0.9) return 'text-yellow-400';
    return 'text-red-400';
  };

  return (
    <div className="space-y-2">
      <p className="text-[11px] text-gray-500 leading-relaxed">
        每個 (provider, model) 的 success rate。失敗會在 <code>usage_log</code>{' '}
        留下一筆 <code>success=0</code>，error_code 是分類過的短碼（429 / timeout /
        5xx 等）。最近 7 天的失敗碼會顯示在最右欄。
      </p>
      <table className="w-full text-xs">
        <thead className="text-gray-500 sticky top-0 bg-gray-950">
          <tr className="border-b border-gray-800">
            <th className="text-left py-1.5 pr-2">Provider</th>
            <th className="text-left py-1.5 pr-2">Family</th>
            <th className="text-left py-1.5 pr-2">Method</th>
            <th className="text-left py-1.5 pr-2">Model</th>
            <th className="text-right py-1.5 pr-2">Attempts</th>
            <th className="text-right py-1.5 pr-2">Success</th>
            <th className="text-right py-1.5 pr-2">Fail</th>
            <th className="text-right py-1.5 pr-2">Rate</th>
            <th className="text-left py-1.5 pr-2">Last seen</th>
            <th className="text-left py-1.5">Recent errors (7d)</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.provider}-${r.family}-${r.method}-${r.model}-${i}`} className="border-b border-gray-800/50">
              <td className="py-1 pr-2 text-gray-300">{r.provider}</td>
              <td className="py-1 pr-2 text-gray-400">{r.family}</td>
              <td className="py-1 pr-2">
                <span
                  className={`px-1.5 py-0.5 rounded text-[10px] font-mono ${
                    r.method === 'CLI'
                      ? 'bg-purple-900/50 text-purple-300'
                      : 'bg-blue-900/50 text-blue-300'
                  }`}
                >
                  {r.method}
                </span>
              </td>
              <td className="py-1 pr-2 font-mono">{r.model}</td>
              <td className="py-1 pr-2 text-right font-mono">{r.attempts}</td>
              <td className="py-1 pr-2 text-right font-mono text-green-400">
                {r.successes}
              </td>
              <td className="py-1 pr-2 text-right font-mono text-red-400">
                {r.failures}
              </td>
              <td
                className={`py-1 pr-2 text-right font-mono font-bold ${rateColor(
                  r.success_rate,
                  r.attempts,
                )}`}
              >
                {fmtRate(r.success_rate)}
              </td>
              <td className="py-1 pr-2 text-gray-500 whitespace-nowrap">
                {r.last_seen ? shortTime(r.last_seen) : '—'}
              </td>
              <td className="py-1 text-[11px]">
                {r.recent_errors.length === 0 ? (
                  <span className="text-gray-600">—</span>
                ) : (
                  <span className="text-gray-400">
                    {r.recent_errors
                      .map((e) => `${e.code}×${e.n}`)
                      .join(', ')}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// =====================================================================
// Per-API-key spending — what each billing relationship cost us
// =====================================================================

const CHANNEL_LABEL: Record<string, string> = {
  anthropic_api: 'Anthropic API',
  openai_api: 'OpenAI API',
  gemini_api: 'Google Gemini API',
  xai_api: 'xAI API',
  openrouter: 'OpenRouter (混合)',
  cli_subscription: 'CLI 訂閱方案 (無 metered 費用)',
};

function SpendingView({ onError }: { onError: (msg: string) => void }) {
  const [channels, setChannels] = useState<ApiKeyChannel[] | null>(null);
  const [digestStatus, setDigestStatus] = useState<string>('');
  const [sending, setSending] = useState(false);

  useEffect(() => {
    onError('');
    adminGetApiKeySpending()
      .then(setChannels)
      .catch((err: Error) => onError(err.message));
  }, [onError]);

  const handleDigest = async () => {
    setSending(true);
    setDigestStatus('');
    try {
      const r = await adminRunDigest();
      setDigestStatus(
        r.ok
          ? '✓ 已觸發 digest（過去 1 小時若有 fallback 事件就會寄到 admin email）'
          : `失敗: ${r.error}`,
      );
    } catch (err) {
      setDigestStatus(`失敗: ${(err as Error).message}`);
    } finally {
      setSending(false);
    }
  };

  if (!channels) return <div className="text-xs text-gray-500">載入中...</div>;

  const fmtCost = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`;
  const grandTotal = channels.reduce((s, c) => s + c.total_cost_usd, 0);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between bg-gray-900 border border-gray-700 rounded p-3">
        <div>
          <div className="text-xs text-gray-400">所有 API Key 累計估算費用</div>
          <div className="text-lg font-bold font-mono mt-1">{fmtCost(grandTotal)}</div>
        </div>
        <div className="text-right">
          <button
            onClick={handleDigest}
            disabled={sending}
            className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-30 rounded text-xs"
          >
            手動寄一次 fallback digest
          </button>
          {digestStatus && (
            <div className="text-[11px] mt-1 text-gray-400 max-w-md">{digestStatus}</div>
          )}
        </div>
      </div>

      <p className="text-[11px] text-gray-500 leading-relaxed">
        每筆「成功」的 usage_log 依實際被扣的 vendor 分類。OpenRouter 不分家族、走的是 OR 那家的 bill。
        CLI 訂閱方案是定額（Claude Code / Codex / Gemini CLI 月費），這裡的 calls 是統計但 cost = $0。
      </p>

      {channels.map((ch) => (
        <div key={ch.channel} className="bg-gray-900 border border-gray-700 rounded p-3">
          <div className="flex items-center justify-between mb-2">
            <div className="text-sm font-bold">{CHANNEL_LABEL[ch.channel] ?? ch.channel}</div>
            <div className="text-right">
              <span className="text-gray-400 text-xs mr-2">{ch.total_calls} calls</span>
              <span className="text-sm font-bold font-mono">{fmtCost(ch.total_cost_usd)}</span>
            </div>
          </div>
          <table className="w-full text-xs">
            <thead className="text-gray-500">
              <tr className="border-b border-gray-800">
                <th className="text-left py-1">Provider</th>
                <th className="text-left py-1">Model (billed)</th>
                <th className="text-right py-1">Calls</th>
                <th className="text-right py-1">In</th>
                <th className="text-right py-1">Out</th>
                <th className="text-right py-1">Cost</th>
              </tr>
            </thead>
            <tbody>
              {ch.models.map((m) => (
                <tr key={`${m.provider}-${m.model}`} className="border-b border-gray-800/50">
                  <td className="py-1 text-gray-400">{m.provider}</td>
                  <td className="py-1 font-mono">{m.model}</td>
                  <td className="py-1 text-right font-mono">{m.calls}</td>
                  <td className="py-1 text-right font-mono">{m.tokens_in.toLocaleString()}</td>
                  <td className="py-1 text-right font-mono">{m.tokens_out.toLocaleString()}</td>
                  <td className="py-1 text-right font-mono">{fmtCost(m.cost_usd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}
