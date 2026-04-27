import React, { useEffect, useState } from 'react';
import {
  createUser,
  deleteUser,
  listUsers,
  updateUser,
  type AdminUser,
} from '../api';
import type { Tier } from '../shared/types';
import { useT } from '../i18n';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  currentUsername: string;
}

const TIERS: Tier[] = ['standard', 'pro', 'super'];

interface RowEdit {
  password?: string;
  tier?: Tier;
  nickname?: string;
  email?: string;
}

export default function AdminPanel({ isOpen, onClose, currentUsername }: Props) {
  const t = useT();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // create form
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newNickname, setNewNickname] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newTier, setNewTier] = useState<Tier>('standard');

  const [editing, setEditing] = useState<Record<string, RowEdit>>({});

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
      setNewNickname('');
      setNewEmail('');
      setNewTier('standard');
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      await createUser({
        username: newUsername.trim(),
        password: newPassword,
        tier: newTier,
        nickname: newNickname.trim() || undefined,
        email: newEmail.trim() || undefined,
      });
      setNewUsername('');
      setNewPassword('');
      setNewNickname('');
      setNewEmail('');
      setNewTier('standard');
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleDelete = async (username: string) => {
    if (!confirm(t.adminConfirmDelete(username))) return;
    setError('');
    try {
      await deleteUser(username);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleSave = async (u: AdminUser) => {
    const patch = editing[u.username];
    if (!patch) return;
    const dirty: RowEdit = {};
    if (patch.password) dirty.password = patch.password;
    if (patch.tier && patch.tier !== u.tier) dirty.tier = patch.tier;
    if (patch.nickname !== undefined && patch.nickname !== (u.nickname || '')) {
      dirty.nickname = patch.nickname;
    }
    if (patch.email !== undefined && patch.email !== (u.email || '')) {
      dirty.email = patch.email;
    }
    if (Object.keys(dirty).length === 0) return;
    setError('');
    try {
      await updateUser(u.username, dirty);
      setEditing((prev) => ({ ...prev, [u.username]: {} }));
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
        className="bg-gray-900 border border-gray-700 rounded-lg w-full max-w-2xl max-h-[90vh] overflow-y-auto p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-bold text-white">{t.adminTitle}</h2>
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

        <div className="mb-4">
          <div className="text-xs text-gray-400 mb-2">
            {t.adminCurrentCount(users.length)}
          </div>
          {loading ? (
            <div className="text-xs text-gray-500">{t.loading}</div>
          ) : (
            <div className="space-y-2">
              {users.map((u) => {
                const e = editing[u.username] || {};
                const isSelf = u.username === currentUsername;
                const tierVal = e.tier ?? u.tier;
                const nickVal = e.nickname ?? u.nickname ?? '';
                const emailVal = e.email ?? u.email ?? '';
                const dirty =
                  !!e.password ||
                  tierVal !== u.tier ||
                  nickVal !== (u.nickname || '') ||
                  emailVal !== (u.email || '');
                return (
                  <div
                    key={u.id}
                    className="bg-gray-800 border border-gray-700 rounded p-2 text-xs"
                  >
                    <div className="flex items-center gap-2 mb-2">
                      <span className="font-semibold text-white flex-1">
                        {u.username}
                        {isSelf && <span className="ml-1 text-gray-500">{t.adminYou}</span>}
                      </span>
                      <select
                        value={tierVal}
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
                    <div className="grid grid-cols-2 gap-2 mb-2">
                      <input
                        type="text"
                        placeholder={t.adminNickname}
                        value={nickVal}
                        onChange={(ev) =>
                          setEditing((prev) => ({
                            ...prev,
                            [u.username]: { ...e, nickname: ev.target.value },
                          }))
                        }
                        className="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs focus:outline-none focus:border-blue-500"
                      />
                      <input
                        type="email"
                        placeholder={t.adminEmail}
                        value={emailVal}
                        onChange={(ev) =>
                          setEditing((prev) => ({
                            ...prev,
                            [u.username]: { ...e, email: ev.target.value },
                          }))
                        }
                        className="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs focus:outline-none focus:border-blue-500"
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <input
                        type="password"
                        placeholder={t.adminNewPasswordPlaceholder}
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
                        onClick={() => handleSave(u)}
                        disabled={!dirty}
                        className="px-2 py-1 bg-blue-600 hover:bg-blue-700 disabled:opacity-30 rounded text-xs"
                      >
                        {t.save}
                      </button>
                      <button
                        onClick={() => handleDelete(u.username)}
                        disabled={isSelf}
                        className="px-2 py-1 text-red-400 hover:text-red-300 disabled:opacity-30 disabled:cursor-not-allowed rounded text-xs"
                      >
                        {t.delete}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <form onSubmit={handleCreate} className="border-t border-gray-700 pt-3 space-y-2">
          <div className="text-xs text-gray-400">{t.adminCreateHeading}</div>
          <div className="grid grid-cols-2 gap-2">
            <input
              type="text"
              placeholder={t.adminUsername}
              value={newUsername}
              onChange={(e) => setNewUsername(e.target.value)}
              required
              autoComplete="off"
              className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs focus:outline-none focus:border-blue-500"
            />
            <input
              type="password"
              placeholder={t.adminPassword}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              required
              autoComplete="new-password"
              className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs focus:outline-none focus:border-blue-500"
            />
            <input
              type="text"
              placeholder={t.adminNickname}
              value={newNickname}
              onChange={(e) => setNewNickname(e.target.value)}
              className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs focus:outline-none focus:border-blue-500"
            />
            <input
              type="email"
              placeholder={t.adminEmail}
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs focus:outline-none focus:border-blue-500"
            />
            <select
              value={newTier}
              onChange={(e) => setNewTier(e.target.value as Tier)}
              className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs"
            >
              {TIERS.map((tier) => (
                <option key={tier} value={tier}>
                  {tier}
                </option>
              ))}
            </select>
            <button
              type="submit"
              disabled={!newUsername.trim() || !newPassword}
              className="px-3 py-1 bg-blue-600 hover:bg-blue-700 disabled:opacity-30 rounded text-xs"
            >
              {t.adminCreate}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
