import React, { useState } from 'react';
import { forgotPassword, login, signup, type User } from '../api';
import { useI18n } from '../i18n';
import LangToggle from './LangToggle';

interface Props {
  onLogin: (user: User) => void;
}

type View = 'login' | 'signup' | 'forgot';

export default function Login({ onLogin }: Props) {
  const { lang, setLang, t } = useI18n();
  const [view, setView] = useState<View>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [forgotIdent, setForgotIdent] = useState('');
  const [forgotSent, setForgotSent] = useState(false);

  const [signupEmail, setSignupEmail] = useState('');
  const [signupPwd, setSignupPwd] = useState('');
  const [signupNick, setSignupNick] = useState('');

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
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

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const user = await signup({
        email: signupEmail.trim(),
        password: signupPwd,
        nickname: signupNick.trim() || undefined,
      });
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

  const flagCorner = (
    <div className="absolute top-4 right-4">
      <LangToggle lang={lang} onChange={setLang} size="md" />
    </div>
  );

  if (view === 'forgot') {
    return (
      <div className="min-h-screen flex items-center justify-center p-6 relative">
        {flagCorner}
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 w-full max-w-sm shadow-xl">
          <h1 className="text-xl font-bold mb-3">{t.forgotTitle}</h1>
          {forgotSent ? (
            <>
              <p className="text-sm text-gray-300 leading-relaxed mb-4">
                {t.forgotSent}
              </p>
              <button
                onClick={() => {
                  setView('login');
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
                  onClick={() => setView('login')}
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

  if (view === 'signup') {
    return (
      <div className="min-h-screen flex items-center justify-center p-6 relative">
        {flagCorner}
        <form
          onSubmit={handleSignup}
          className="bg-gray-900 border border-gray-800 rounded-lg p-6 w-full max-w-sm shadow-xl"
        >
          <h1 className="text-xl font-bold mb-4">{t.signupTitle}</h1>

          <label className="block text-xs text-gray-300 mb-1">{t.signupEmail}</label>
          <input
            type="email"
            value={signupEmail}
            onChange={(e) => setSignupEmail(e.target.value)}
            autoFocus
            autoComplete="email"
            className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-sm mb-3 focus:outline-none focus:border-blue-500"
          />

          <label className="block text-xs text-gray-300 mb-1">{t.signupPassword}</label>
          <input
            type="password"
            value={signupPwd}
            onChange={(e) => setSignupPwd(e.target.value)}
            autoComplete="new-password"
            className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-sm mb-3 focus:outline-none focus:border-blue-500"
          />

          <label className="block text-xs text-gray-300 mb-1">{t.signupNickname}</label>
          <input
            type="text"
            value={signupNick}
            onChange={(e) => setSignupNick(e.target.value)}
            className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-sm mb-3 focus:outline-none focus:border-blue-500"
          />

          <p className="text-[11px] text-gray-500 mb-3 leading-relaxed">{t.signupTierNote}</p>

          {error && <p className="text-xs text-red-400 mb-3">{error}</p>}

          <button
            type="submit"
            disabled={loading || !signupEmail.trim() || signupPwd.length < 6}
            className="w-full py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed rounded text-sm font-medium"
          >
            {loading ? t.signupSubmitting : t.signupSubmit}
          </button>
          <div className="text-center mt-3">
            <button
              type="button"
              onClick={() => {
                setView('login');
                setError('');
              }}
              className="text-xs text-gray-400 hover:text-blue-400"
            >
              {t.loginHaveAccount}
            </button>
          </div>
        </form>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6 relative">
      {flagCorner}
      <form
        onSubmit={handleLogin}
        className="bg-gray-900 border border-gray-800 rounded-lg p-6 w-full max-w-sm shadow-xl"
      >
        <h1 className="text-xl font-bold mb-4">{t.loginTitle}</h1>

        <label className="block text-xs text-gray-300 mb-1">{t.loginUsernameLabel}</label>
        <input
          type="text"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoFocus
          autoComplete="username"
          className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-sm mb-3 focus:outline-none focus:border-blue-500"
        />

        <label className="block text-xs text-gray-300 mb-1">{t.loginPasswordLabel}</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-sm mb-2 focus:outline-none focus:border-blue-500"
        />

        <div className="flex justify-between mb-4">
          <button
            type="button"
            onClick={() => {
              setError('');
              setView('signup');
            }}
            className="text-xs text-gray-400 hover:text-blue-400"
          >
            {t.loginNoAccount}
          </button>
          <button
            type="button"
            onClick={() => {
              setError('');
              setView('forgot');
              setForgotIdent(username);
            }}
            className="text-xs text-gray-400 hover:text-blue-400"
          >
            {t.loginForgot}
          </button>
        </div>

        {error && <p className="text-xs text-red-400 mb-3">{error}</p>}

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
