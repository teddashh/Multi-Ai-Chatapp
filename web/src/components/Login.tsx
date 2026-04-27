import React, { useState } from 'react';
import { forgotPassword, login, type User } from '../api';

interface Props {
  onLogin: (user: User) => void;
}

export default function Login({ onLogin }: Props) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [loading, setLoading] = useState(false);
  const [forgotOpen, setForgotOpen] = useState(false);
  const [forgotIdent, setForgotIdent] = useState('');
  const [forgotSent, setForgotSent] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setInfo('');
    setLoading(true);
    try {
      const user = await login(username, password);
      onLogin(user);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const handleForgot = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!forgotIdent.trim()) return;
    try {
      await forgotPassword(forgotIdent.trim());
      setForgotSent(true);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (forgotOpen) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 w-full max-w-sm shadow-xl">
          <h1 className="text-xl font-bold mb-3">忘記密碼</h1>
          {forgotSent ? (
            <>
              <p className="text-sm text-gray-300 leading-relaxed mb-4">
                如果這個帳號存在，我們已經寄一封重設信給註冊的 email。請查收後點擊信中連結（1 小時內有效）。
              </p>
              <button
                onClick={() => {
                  setForgotOpen(false);
                  setForgotSent(false);
                  setForgotIdent('');
                }}
                className="w-full py-2 bg-blue-600 hover:bg-blue-700 rounded text-sm font-medium"
              >
                回登入
              </button>
            </>
          ) : (
            <form onSubmit={handleForgot}>
              <p className="text-xs text-gray-400 mb-3">
                輸入你的帳號或 email，我們會寄重設信過去。
              </p>
              <input
                type="text"
                value={forgotIdent}
                onChange={(e) => setForgotIdent(e.target.value)}
                autoFocus
                placeholder="username 或 email"
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-sm mb-3 focus:outline-none focus:border-blue-500"
              />
              {error && <p className="text-xs text-red-400 mb-3">{error}</p>}
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setForgotOpen(false)}
                  className="flex-1 py-2 text-gray-300 hover:text-white text-sm"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={!forgotIdent.trim()}
                  className="flex-1 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded text-sm font-medium"
                >
                  寄送
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <form
        onSubmit={handleSubmit}
        className="bg-gray-900 border border-gray-800 rounded-lg p-6 w-full max-w-sm shadow-xl"
      >
        <h1 className="text-xl font-bold mb-4">Multi-AI Chatapp</h1>

        <label className="block text-xs text-gray-300 mb-1">Username 或 Email</label>
        <input
          type="text"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoFocus
          autoComplete="username"
          className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-sm mb-3 focus:outline-none focus:border-blue-500"
        />

        <label className="block text-xs text-gray-300 mb-1">Password</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-sm mb-2 focus:outline-none focus:border-blue-500"
        />

        <div className="text-right mb-4">
          <button
            type="button"
            onClick={() => {
              setError('');
              setForgotOpen(true);
              setForgotIdent(username);
            }}
            className="text-xs text-gray-400 hover:text-blue-400"
          >
            忘記密碼？
          </button>
        </div>

        {error && <p className="text-xs text-red-400 mb-3">{error}</p>}
        {info && <p className="text-xs text-blue-300 mb-3">{info}</p>}

        <button
          type="submit"
          disabled={loading || !username || !password}
          className="w-full py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed rounded text-sm font-medium"
        >
          {loading ? 'Signing in...' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
