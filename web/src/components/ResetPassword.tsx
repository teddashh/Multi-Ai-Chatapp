import React, { useState } from 'react';
import { resetPassword } from '../api';

interface Props {
  token: string;
  onDone: () => void;
}

export default function ResetPassword({ token, onDone }: Props) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (password !== confirm) {
      setError('兩次輸入的密碼不一致');
      return;
    }
    if (password.length < 6) {
      setError('密碼至少 6 個字元');
      return;
    }
    setLoading(true);
    try {
      await resetPassword(token, password);
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
        <h1 className="text-xl font-bold mb-4">重設密碼</h1>
        {success ? (
          <>
            <p className="text-sm text-gray-300 mb-4">密碼已重設，請用新密碼登入。</p>
            <button
              onClick={onDone}
              className="w-full py-2 bg-blue-600 hover:bg-blue-700 rounded text-sm font-medium"
            >
              回登入頁
            </button>
          </>
        ) : (
          <form onSubmit={handleSubmit}>
            <label className="block text-xs text-gray-300 mb-1">新密碼</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
              autoComplete="new-password"
              className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-sm mb-3 focus:outline-none focus:border-blue-500"
            />
            <label className="block text-xs text-gray-300 mb-1">確認新密碼</label>
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
              {loading ? '重設中...' : '確定'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
