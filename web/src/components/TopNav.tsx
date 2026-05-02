// Shared sticky top navigation bar — replaces the old per-view headers
// in chat and forum. Always rendered above whatever route is active so
// the brand, tab switcher, and user state stay anchored.
//
// Layout:
//   [☰?]  AI姐妹  [聊天室] [討論區]  ......  [Lang] [Avatar Tier] [Admin?] [登出]
// Anonymous variant:
//   AI姐妹  [聊天室] [討論區]  ......  [Lang] [註冊] [登入]

import React from 'react';
import { avatarUrl, type User } from '../api';
import LangToggle from './LangToggle';
import { useT, type Lang } from '../i18n';

interface Props {
  user: User | null;
  pathname: string;
  navigate: (path: string) => void;
  lang: Lang;
  onLangChange: (lang: Lang) => void;
  onProfileClick: () => void;
  onLogout: () => void;
  // Sidebar toggle — chat view passes a handler; forum view passes
  // undefined so the ☰ button hides (forum has no sidebar).
  onSidebarToggle?: () => void;
  avatarBust: number;
}

export default function TopNav({
  user,
  pathname,
  navigate,
  lang,
  onLangChange,
  onProfileClick,
  onLogout,
  onSidebarToggle,
  avatarBust,
}: Props) {
  const t = useT();
  const isForum = pathname.startsWith('/forum');
  // Chat lives at /chat now (was /). Anything that's not forum / admin /
  // landing falls back to chat (covers nested routes if we add any).
  const isChat = !isForum && pathname !== '/admin' && pathname !== '/';

  return (
    <header className="flex-none sticky top-0 z-30 bg-gray-950/95 backdrop-blur border-b border-gray-800">
      <div className="flex items-center justify-between gap-1 sm:gap-2 px-2 sm:px-3 py-2 text-sm">
        <div className="flex items-center gap-1 sm:gap-2 min-w-0">
          {onSidebarToggle && (
            <button
              onClick={onSidebarToggle}
              className="lg:hidden text-gray-400 hover:text-white text-base flex-none"
              title="開啟左側列表"
            >
              ☰
            </button>
          )}
          <button
            onClick={() => navigate('/')}
            className="font-bold text-gray-100 hover:text-white truncate flex-none whitespace-nowrap"
            title="回首頁"
          >
            {t.appName}
          </button>
          <nav className="flex gap-0.5 ml-1 sm:ml-2">
            <button
              onClick={() => navigate('/chat')}
              className={`px-2 sm:px-2.5 py-1 rounded text-xs whitespace-nowrap transition-colors ${
                isChat
                  ? 'bg-gray-800 text-white'
                  : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'
              }`}
            >
              {t.navChat}
            </button>
            <button
              onClick={() => navigate('/forum')}
              className={`px-2 sm:px-2.5 py-1 rounded text-xs whitespace-nowrap transition-colors ${
                isForum
                  ? 'bg-gray-800 text-white'
                  : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'
              }`}
            >
              {t.navForum}
            </button>
          </nav>
        </div>

        <div className="flex items-center gap-1 sm:gap-2 text-xs flex-none">
          <LangToggle lang={lang} onChange={onLangChange} />
          {user ? (
            <AuthedRight
              user={user}
              avatarBust={avatarBust}
              onProfileClick={onProfileClick}
              onLogout={onLogout}
              navigate={navigate}
              t={t}
            />
          ) : (
            <AnonRight navigate={navigate} t={t} />
          )}
        </div>
      </div>
    </header>
  );
}

function AuthedRight({
  user,
  avatarBust,
  onProfileClick,
  onLogout,
  navigate,
  t,
}: {
  user: User;
  avatarBust: number;
  onProfileClick: () => void;
  onLogout: () => void;
  navigate: (p: string) => void;
  t: ReturnType<typeof useT>;
}) {
  const displayName = user.nickname || user.username;
  const avatarSrc = user.hasAvatar ? avatarUrl(user.username, avatarBust) : null;
  return (
    <>
      <button
        onClick={onProfileClick}
        title={t.profile}
        className="flex items-center gap-1 sm:gap-1.5 hover:bg-gray-800 rounded px-1 sm:px-1.5 py-0.5 transition-colors flex-none"
      >
        {avatarSrc ? (
          <img
            src={avatarSrc}
            alt={displayName}
            className="w-6 h-6 rounded-full object-cover border border-gray-700 flex-none"
          />
        ) : (
          <span className="w-6 h-6 rounded-full bg-gray-700 flex items-center justify-center text-[10px] font-bold flex-none">
            {displayName.slice(0, 1).toUpperCase()}
          </span>
        )}
        <span
          className="text-gray-300 hidden sm:inline whitespace-nowrap"
          title={user.username}
        >
          {displayName}
        </span>
        <span
          className="hidden sm:inline px-1.5 py-0.5 rounded bg-gray-800 text-[10px] uppercase tracking-wider whitespace-nowrap"
          title={`tier: ${user.tier}`}
        >
          {user.tier}
        </span>
      </button>
      {user.tier === 'admin' && (
        <button
          onClick={() => navigate('/admin')}
          className="hidden sm:inline text-gray-400 hover:text-white whitespace-nowrap"
          title={t.manageUsers}
        >
          Admin
        </button>
      )}
      <button
        onClick={onLogout}
        className="text-gray-500 hover:text-red-400 whitespace-nowrap flex-none"
        title={t.logout}
      >
        {t.logout}
      </button>
    </>
  );
}

function AnonRight({
  navigate,
  t,
}: {
  navigate: (p: string) => void;
  t: ReturnType<typeof useT>;
}) {
  // Both buttons land on the Login screen at "/" — Login itself flips
  // between sign-in and sign-up modes via its internal toggle. We pass
  // a query string hint so Login could pre-select sign-up if it wants.
  return (
    <>
      <button
        onClick={() => navigate('/?action=signup')}
        className="px-2 sm:px-2.5 py-1 rounded bg-gray-800 hover:bg-gray-700 text-gray-200 whitespace-nowrap"
      >
        {t.navSignUp}
      </button>
      <button
        onClick={() => navigate('/?action=login')}
        className="px-2 sm:px-2.5 py-1 rounded bg-blue-600 hover:bg-blue-700 text-white whitespace-nowrap"
      >
        {t.navSignIn}
      </button>
    </>
  );
}
