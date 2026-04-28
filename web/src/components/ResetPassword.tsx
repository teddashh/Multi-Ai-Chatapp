import React, { useEffect, useState } from 'react';
import { getResetInfo, resetPassword, type ResetInfo } from '../api';
import { useT } from '../i18n';

interface Props {
  token: string;
  onDone: () => void;
}

export default function ResetPassword({ token, onDone }: Props) {
  const t = useT();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [username, setUsername] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  // Reset-info tells us whether this is a fresh invite (let the user
  // pick a username) or just a regular password reset for an existing
  // account (don't bother them with a username field).
  const [info, setInfo] = useState<ResetInfo | null>(null);

  useEffect(() => {
    getResetInfo(token)
      .then((i) => {
        setInfo(i);
        setUsername(i.username);
      })
      .catch((err) => {
        setError((err as Error).message);
      });
  }, [token]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (password !== confirm) {
      setError(t.passwordsDontMatch);
      return;
    }
    if (password.length < 6) {
      setError(t.passwordTooShort);
      return;
    }
    setLoading(true);
    try {
      // Only send username for invite flow; for regular resets the
      // server would reject changes anyway, but be explicit.
      const newUsername = info?.isInvite && username.trim() ? username.trim() : undefined;
      await resetPassword(token, password, newUsername);
      setSuccess(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 w-full max-w-sm shadow-xl">
        <h1 className="text-xl font-bold mb-4">{t.resetTitle}</h1>
        {success ? (
          <>
            <p className="text-sm text-gray-300 mb-4">{t.resetSuccess}</p>
            <button
              onClick={onDone}
              className="w-full py-2 bg-blue-600 hover:bg-blue-700 rounded text-sm font-medium"
            >
              {t.resetBackLogin}
            </button>
          </>
        ) : (
          <form onSubmit={handleSubmit}>
            {info?.isInvite && (
              <p className="text-xs text-blue-200 bg-blue-900/30 border border-blue-800/40 rounded p-2 mb-3 leading-relaxed">
                {t.resetWelcomeInvite}
              </p>
            )}
            {info?.isInvite && (
              <>
                <label className="block text-xs text-gray-300 mb-1">
                  {t.resetUsernameLabel}
                </label>
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="username"
                  className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-sm mb-1 focus:outline-none focus:border-blue-500"
                />
                <p className="text-[11px] text-gray-500 mb-3 leading-relaxed">
                  {t.resetUsernameHint}
                </p>
              </>
            )}
            <label className="block text-xs text-gray-300 mb-1">
              {t.resetNewLabel}
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
              autoComplete="new-password"
              className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-sm mb-3 focus:outline-none focus:border-blue-500"
            />
            <label className="block text-xs text-gray-300 mb-1">
              {t.resetConfirmLabel}
            </label>
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-sm mb-3 focus:outline-none focus:border-blue-500"
            />
            {error && <p className="text-xs text-red-400 mb-3">{error}</p>}
            <button
              type="submit"
              disabled={loading || !password || !confirm}
              className="w-full py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded text-sm font-medium"
            >
              {loading ? t.resetting : t.resetSubmit}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
