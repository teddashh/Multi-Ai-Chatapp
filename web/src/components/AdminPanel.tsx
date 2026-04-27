import React, { useEffect, useState } from 'react';
import {
  createUser,
  deleteUser,
  listUsers,
  updateUser,
  type AdminUser,
} from '../api';
import type { Tier } from '../shared/types';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  currentUsername: string;
}

const TIERS: Tier[] = ['test', 'standard', 'super'];

export default function AdminPanel({ isOpen, onClose, currentUsername }: Props) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // create form
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newTier, setNewTier] = useState<Tier>('test');

  // per-row inline edits (password reset / tier change)
  const [editing, setEditing] = useState<Record<string, { password?: string; tier?: Tier }>>({});

  const refresh = async () => {
    setLoading(true);
    setError('');
    try {
      const data = await listUsers();
      setUsers(data);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      refresh();
      setEditing({});
      setNewUsername('');
      setNewPassword('');
      setNewTier('test');
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      await createUser(newUsername.trim(), newPassword, newTier);
      setNewUsername('');
      setNewPassword('');
      setNewTier('test');
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleDelete = async (username: string) => {
    if (!confirm(`Delete user '${username}'?`)) return;
    setError('');
    try {
      await deleteUser(username);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleSave = async (username: string) => {
    const patch = editing[username];
    if (!patch || (!patch.password && !patch.tier)) return;
    setError('');
    try {
      await updateUser(username, patch);
      setEditing((prev) => ({ ...prev, [username]: {} }));
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-gray-900 border border-gray-700 rounded-lg w-full max-w-2xl max-h-[85vh] overflow-y-auto p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-bold text-white">使用者管理</h2>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-white text-sm"
          >
            ✕
          </button>
        </div>

        {error && (
          <p className="text-xs text-red-400 mb-3 bg-red-900/30 border border-red-800 rounded p-2">
            {error}
          </p>
        )}

        {/* User list */}
        <div className="mb-4">
          <div className="text-xs text-gray-400 mb-2">
            目前帳號 ({users.length})
          </div>
          {loading ? (
            <div className="text-xs text-gray-500">載入中...</div>
          ) : (
            <div className="space-y-1">
              {users.map((u) => {
                const e = editing[u.username] || {};
                const isSelf = u.username === currentUsername;
                return (
                  <div
                    key={u.id}
                    className="bg-gray-800 border border-gray-700 rounded p-2 text-xs"
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-semibold text-white flex-1">
                        {u.username}
                        {isSelf && <span className="ml-1 text-gray-500">(you)</span>}
                      </span>
                      <select
                        value={e.tier ?? u.tier}
                        onChange={(ev) =>
                          setEditing((prev) => ({
                            ...prev,
                            [u.username]: { ...e, tier: ev.target.value as Tier },
                          }))
                        }
                        disabled={isSelf}
                        className="bg-gray-900 border border-gray-700 rounded px-1.5 py-0.5 text-xs disabled:opacity-50"
                      >
                        {TIERS.map((t) => (
                          <option key={t} value={t}>
                            {t}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="flex items-center gap-2">
                      <input
                        type="password"
                        placeholder="新密碼（留空不改）"
                        value={e.password ?? ''}
                        onChange={(ev) =>
                          setEditing((prev) => ({
                            ...prev,
                            [u.username]: { ...e, password: ev.target.value },
                          }))
                        }
                        className="flex-1 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs focus:outline-none focus:border-blue-500"
                      />
                      <button
                        onClick={() => handleSave(u.username)}
                        disabled={!e.password && (!e.tier || e.tier === u.tier)}
                        className="px-2 py-1 bg-blue-600 hover:bg-blue-700 disabled:opacity-30 rounded text-xs"
                      >
                        儲存
                      </button>
                      <button
                        onClick={() => handleDelete(u.username)}
                        disabled={isSelf}
                        className="px-2 py-1 text-red-400 hover:text-red-300 disabled:opacity-30 disabled:cursor-not-allowed rounded text-xs"
                      >
                        刪除
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Create new */}
        <form onSubmit={handleCreate} className="border-t border-gray-700 pt-3">
          <div className="text-xs text-gray-400 mb-2">新增帳號</div>
          <div className="grid grid-cols-[1fr_1fr_auto_auto] gap-2 items-center">
            <input
              type="text"
              placeholder="username"
              value={newUsername}
              onChange={(e) => setNewUsername(e.target.value)}
              required
              autoComplete="off"
              className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs focus:outline-none focus:border-blue-500"
            />
            <input
              type="password"
              placeholder="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              required
              autoComplete="new-password"
              className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs focus:outline-none focus:border-blue-500"
            />
            <select
              value={newTier}
              onChange={(e) => setNewTier(e.target.value as Tier)}
              className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs"
            >
              {TIERS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <button
              type="submit"
              disabled={!newUsername.trim() || !newPassword}
              className="px-3 py-1 bg-blue-600 hover:bg-blue-700 disabled:opacity-30 rounded text-xs"
            >
              新增
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
