import React, { useState } from 'react';
import { forgotPassword, login, type User } from '../api';
import { useI18n } from '../i18n';
import LangToggle from './LangToggle';

interface Props {
  onLogin: (user: User) => void;
}

export default function Login({ onLogin }: Props) {
  const { lang, setLang, t } = useI18n();
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
        <div className="absolute top-4 right-4">
          <LangToggle lang={lang} onChange={setLang} size="md" />
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 w-full max-w-sm shadow-xl">
          <h1 className="text-xl font-bold mb-3">{t.forgotTitle}</h1>
          {forgotSent ? (
            <>
              <p className="text-sm text-gray-300 leading-relaxed mb-4">
                {t.forgotSent}
              </p>
              <button
                onClick={() => {
                  setForgotOpen(false);
                  setForgotSent(false);
                  setForgotIdent('');
                }}
                className="w-full py-2 bg-blue-600 hover:bg-blue-700 rounded text-sm font-medium"
              >
                {t.forgotBack}
              </button>
            </>
          ) : (
            <form onSubmit={handleForgot}>
              <p className="text-xs text-gray-400 mb-3">{t.forgotPrompt}</p>
              <input
                type="text"
                value={forgotIdent}
                onChange={(e) => setForgotIdent(e.target.value)}
                autoFocus
                placeholder={t.forgotPlaceholder}
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-sm mb-3 focus:outline-none focus:border-blue-500"
              />
              {error && <p className="text-xs text-red-400 mb-3">{error}</p>}
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setForgotOpen(false)}
                  className="flex-1 py-2 text-gray-300 hover:text-white text-sm"
                >
                  {t.cancel}
                </button>
                <button
                  type="submit"
                  disabled={!forgotIdent.trim()}
                  className="flex-1 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded text-sm font-medium"
                >
                  {t.forgotSend}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6 relative">
      <div className="absolute top-4 right-4">
        <LangToggle lang={lang} onChange={setLang} size="md" />
      </div>
      <form
        onSubmit={handleSubmit}
        className="bg-gray-900 border border-gray-800 rounded-lg p-6 w-full max-w-sm shadow-xl"
      >
        <h1 className="text-xl font-bold mb-4">{t.loginTitle}</h1>

        <label className="block text-xs text-gray-300 mb-1">
          {t.loginUsernameLabel}
        </label>
        <input
          type="text"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoFocus
          autoComplete="username"
          className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-sm mb-3 focus:outline-none focus:border-blue-500"
        />

        <label className="block text-xs text-gray-300 mb-1">
          {t.loginPasswordLabel}
        </label>
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
            {t.loginForgot}
          </button>
        </div>

        {error && <p className="text-xs text-red-400 mb-3">{error}</p>}
        {info && <p className="text-xs text-blue-300 mb-3">{info}</p>}

        <button
          type="submit"
          disabled={loading || !username || !password}
          className="w-full py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed rounded text-sm font-medium"
        >
          {loading ? t.loginSigningIn : t.loginSignIn}
        </button>
      </form>
    </div>
  );
}
