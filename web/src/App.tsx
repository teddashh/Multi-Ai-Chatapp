import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AIProvider,
  ChatMessage,
  ChatMode,
  MessageAttachment,
  ModeRoles,
  SSEEvent,
} from './shared/types';
import {
  DEFAULT_CODING_ROLES,
  DEFAULT_CONSULT_ROLES,
  DEFAULT_DEBATE_ROLES,
  DEFAULT_ROUNDTABLE_ROLES,
} from './shared/constants';
import {
  avatarUrl,
  getSession,
  listSessions,
  logout,
  me,
  streamChat,
  streamRegenerate,
  updateProfile,
  type SessionSummary,
  type ThemeId,
  type User,
} from './api';
import Login from './components/Login';
import ResetPassword from './components/ResetPassword';
import ProvidersBar from './components/ProvidersBar';
import ModeSelector from './components/ModeSelector';
import RoleConfig from './components/RoleConfig';
import ChatArea from './components/ChatArea';
import InputBar from './components/InputBar';
import AdminPage from './components/AdminPage';
import Sidebar from './components/Sidebar';
import LangToggle from './components/LangToggle';
import ProfileModal from './components/ProfileModal';
import { DICTS, I18nContext, type Lang } from './i18n';

const DEFAULT_ROLES: Record<string, ModeRoles> = {
  debate: DEFAULT_DEBATE_ROLES,
  consult: DEFAULT_CONSULT_ROLES,
  coding: DEFAULT_CODING_ROLES,
  roundtable: DEFAULT_ROUNDTABLE_ROLES,
};

function loadInitialLang(): Lang {
  try {
    const v = localStorage.getItem('lang');
    if (v === 'en' || v === 'zh-TW') return v;
  } catch {
    // ignore
  }
  return 'zh-TW';
}

const VALID_THEMES: ThemeId[] = [
  'winter',
  'summer',
  'claude',
  'gemini',
  'grok',
  'chatgpt',
];

function loadInitialTheme(): ThemeId {
  try {
    const v = localStorage.getItem('theme');
    if (v && (VALID_THEMES as string[]).includes(v)) return v as ThemeId;
  } catch {
    // ignore
  }
  return 'winter';
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [resetToken, setResetToken] = useState<string | null>(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('reset');
  });

  const [lang, setLangState] = useState<Lang>(loadInitialLang);
  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    try {
      localStorage.setItem('lang', l);
    } catch {
      // ignore
    }
  }, []);

  const [theme, setThemeState] = useState<ThemeId>(loadInitialTheme);
  const setTheme = useCallback((th: ThemeId) => {
    setThemeState(th);
    try {
      localStorage.setItem('theme', th);
    } catch {
      // ignore
    }
  }, []);
  // Push the active theme onto <html> so the CSS attribute selectors apply
  // to the entire page (including the body::before background painter).
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  // Browser back/forward (pushState navigation between / and /admin) needs
  // a popstate listener — pathname state is otherwise stuck at first load.
  useEffect(() => {
    const onPop = () => setPathname(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const navigate = useCallback((path: string) => {
    window.history.pushState({}, '', path);
    setPathname(path);
  }, []);
  // When switching language while logged in, persist server-side too.
  const handleLangToggle = useCallback(
    (l: Lang) => {
      setLang(l);
      if (user && user.lang !== l) {
        updateProfile({ lang: l }).then(setUser).catch(() => {});
      }
    },
    [user, setLang],
  );

  const [mode, setMode] = useState<ChatMode>('free');
  const [roles, setRoles] = useState<ModeRoles>(DEFAULT_DEBATE_ROLES);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [workflowStatus, setWorkflowStatus] = useState('');
  const [showRoleConfig, setShowRoleConfig] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [pathname, setPathname] = useState(window.location.pathname);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [regeneratingId, setRegeneratingId] = useState<string | null>(null);
  const [avatarBust, setAvatarBust] = useState(Date.now());
  const [modelOverrides, setModelOverrides] = useState<Partial<Record<AIProvider, string>>>(
    () => {
      try {
        const raw = localStorage.getItem('modelOverrides');
        return raw ? (JSON.parse(raw) as Partial<Record<AIProvider, string>>) : {};
      } catch {
        return {};
      }
    },
  );

  const abortRef = useRef<AbortController | null>(null);
  const pendingRolesRef = useRef<Record<string, string>>({});

  useEffect(() => {
    me().then((u) => {
      setUser(u);
      setAuthChecked(true);
      if (u && u.lang !== lang) setLang(u.lang);
      if (u && u.theme !== theme) setTheme(u.theme);
    });
    // Intentionally one-shot; don't refetch on lang/theme flips.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const t = DICTS[lang];
  const i18nValue = useMemo(() => ({ lang, setLang, t }), [lang, setLang, t]);

  const refreshSessions = useCallback(async () => {
    try {
      const list = await listSessions();
      setSessions(list);
    } catch {
      // ignore (likely 401 on initial load)
    }
  }, []);

  useEffect(() => {
    if (user) refreshSessions();
  }, [user, refreshSessions]);

  const handleSelectSession = useCallback(
    async (id: string) => {
      try {
        const detail = await getSession(id);
        setActiveSessionId(detail.session.id);
        setMode(detail.session.mode as ChatMode);
        setMessages(
          detail.messages.map((m) => ({
            id: m.id,
            role: m.role,
            provider: m.provider,
            modeRole: m.modeRole,
            content: m.content,
            timestamp: m.timestamp,
            attachments: m.attachments,
          })),
        );
      } catch (err) {
        alert(t.loadFailed((err as Error).message));
      }
    },
    [t],
  );

  const handleNewChat = useCallback(() => {
    setActiveSessionId(null);
    setMessages([]);
  }, []);

  useEffect(() => {
    if (mode !== 'free') {
      setRoles(DEFAULT_ROLES[mode]);
    }
  }, [mode]);

  const handleLogout = async () => {
    await logout();
    setUser(null);
    setMessages([]);
  };

  const handleProfileUpdate = useCallback(
    (updated: User) => {
      setUser(updated);
      setLang(updated.lang);
      setTheme(updated.theme);
      setAvatarBust(Date.now());
    },
    [setLang, setTheme],
  );

  const handleModelSelect = useCallback((provider: AIProvider, model: string) => {
    setModelOverrides((prev) => {
      const next = { ...prev, [provider]: model };
      try {
        localStorage.setItem('modelOverrides', JSON.stringify(next));
      } catch {
        // ignore storage failures (private mode etc.)
      }
      return next;
    });
  }, []);

  const handleEvent = useCallback((ev: SSEEvent) => {
    switch (ev.type) {
      case 'session':
        setActiveSessionId(ev.sessionId);
        if (ev.isNew) refreshSessions();
        break;
      case 'workflow':
        setWorkflowStatus(ev.status);
        if (!ev.status) setIsProcessing(false);
        break;
      case 'role':
        pendingRolesRef.current[ev.provider] = ev.label;
        break;
      case 'chunk':
        setMessages((prev) => {
          const existing = prev.find(
            (m) =>
              m.provider === ev.provider &&
              m.role === 'ai' &&
              m.id.endsWith('-streaming'),
          );
          if (existing) {
            return prev.map((m) =>
              m.id === existing.id ? { ...m, content: ev.text } : m,
            );
          }
          const modeRole = pendingRolesRef.current[ev.provider];
          if (modeRole) delete pendingRolesRef.current[ev.provider];
          return [
            ...prev,
            {
              id: `${ev.provider}-${Date.now()}-streaming`,
              role: 'ai',
              provider: ev.provider,
              modeRole,
              content: ev.text,
              timestamp: Date.now(),
            },
          ];
        });
        break;
      case 'done':
        setMessages((prev) => {
          const stableId =
            ev.messageId !== undefined ? String(ev.messageId) : null;
          const streaming = prev.find(
            (m) =>
              m.provider === ev.provider &&
              m.role === 'ai' &&
              m.id.endsWith('-streaming'),
          );
          if (streaming) {
            return prev.map((m) =>
              m.id === streaming.id
                ? {
                    ...m,
                    id: stableId ?? m.id.replace('-streaming', ''),
                    content: ev.text,
                  }
                : m,
            );
          }
          const modeRole = pendingRolesRef.current[ev.provider];
          if (modeRole) delete pendingRolesRef.current[ev.provider];
          return [
            ...prev,
            {
              id: stableId ?? `${ev.provider}-${Date.now()}`,
              role: 'ai',
              provider: ev.provider,
              modeRole,
              content: ev.text,
              timestamp: Date.now(),
            },
          ];
        });
        break;
      case 'error':
        if (ev.provider) break;
        setMessages((prev) => [
          ...prev,
          {
            id: `error-${Date.now()}`,
            role: 'ai',
            content: `[Error] ${ev.message}`,
            timestamp: Date.now(),
          },
        ]);
        break;
      case 'finish':
        setIsProcessing(false);
        setWorkflowStatus('');
        refreshSessions();
        break;
    }
  }, [refreshSessions]);

  const handleSend = useCallback(
    async (text: string, attachments: MessageAttachment[]) => {
      if (isProcessing) return;
      if (!text && attachments.length === 0) return;
      const userMsg: ChatMessage = {
        id: `user-${Date.now()}`,
        role: 'user',
        content: text,
        timestamp: Date.now(),
        attachments,
      };
      setMessages((prev) => [...prev, userMsg]);
      setIsProcessing(true);

      const ctrl = new AbortController();
      abortRef.current = ctrl;

      try {
        await streamChat(
          {
            text,
            mode,
            roles: mode !== 'free' ? roles : undefined,
            modelOverrides,
            sessionId: activeSessionId ?? undefined,
            attachmentIds: attachments.map((a) => a.id),
          },
          handleEvent,
          ctrl.signal,
        );
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          setMessages((prev) => [
            ...prev,
            {
              id: `error-${Date.now()}`,
              role: 'ai',
              content: `[Error] ${(err as Error).message}`,
              timestamp: Date.now(),
            },
          ]);
        }
      } finally {
        setIsProcessing(false);
        setWorkflowStatus('');
        abortRef.current = null;
      }
    },
    [mode, roles, isProcessing, modelOverrides, activeSessionId, handleEvent],
  );

  const handleCancel = useCallback(() => {
    abortRef.current?.abort();
    setIsProcessing(false);
    setWorkflowStatus('');
  }, []);

  const handleRegenerate = useCallback(
    async (messageId: string) => {
      if (regeneratingId || isProcessing) return;
      const isSequential = mode !== 'free';

      if (isSequential) {
        setMessages((prev) => {
          const idx = prev.findIndex((m) => m.id === messageId);
          return idx >= 0 ? prev.slice(0, idx) : prev;
        });
      }

      setRegeneratingId(messageId);
      if (isSequential) setIsProcessing(true);
      const ctrl = new AbortController();
      if (isSequential) abortRef.current = ctrl;
      try {
        await streamRegenerate(
          { messageId, modelOverrides },
          isSequential
            ? handleEvent
            : (ev) => {
                if (ev.type === 'chunk' || ev.type === 'done') {
                  setMessages((prev) =>
                    prev.map((m) =>
                      m.id === messageId ? { ...m, content: ev.text } : m,
                    ),
                  );
                } else if (ev.type === 'error') {
                  setMessages((prev) => [
                    ...prev,
                    {
                      id: `error-${Date.now()}`,
                      role: 'ai',
                      content: `[Regenerate Error] ${ev.message}`,
                      timestamp: Date.now(),
                    },
                  ]);
                }
              },
          ctrl.signal,
        );
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          alert(t.retryFailed((err as Error).message));
        }
      } finally {
        setRegeneratingId(null);
        if (isSequential) {
          setIsProcessing(false);
          setWorkflowStatus('');
          if (abortRef.current === ctrl) abortRef.current = null;
        }
      }
    },
    [regeneratingId, isProcessing, mode, modelOverrides, handleEvent, t],
  );

  // === Render ===
  let content: React.ReactNode;
  if (resetToken) {
    content = (
      <ResetPassword
        token={resetToken}
        onDone={() => {
          setResetToken(null);
          window.history.replaceState({}, '', '/');
        }}
      />
    );
  } else if (!authChecked) {
    content = (
      <div className="min-h-screen flex items-center justify-center text-gray-500 text-sm">
        {t.loading}
      </div>
    );
  } else if (!user) {
    content = <Login onLogin={setUser} />;
  } else if (pathname === '/admin' && user.tier === 'super') {
    content = (
      <AdminPage
        currentUser={user}
        onExit={() => navigate('/')}
      />
    );
  } else {
    const displayName = user.nickname || user.username;
    const avatarSrc = user.hasAvatar
      ? avatarUrl(user.username, avatarBust)
      : null;
    content = (
      <div className="flex h-screen">
        <Sidebar
          sessions={sessions}
          activeId={activeSessionId}
          onSelect={handleSelectSession}
          onNew={handleNewChat}
          onRefresh={refreshSessions}
          isOpen={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
        />
        <div className="flex flex-col flex-1 min-w-0">
          <div className="flex-none border-b border-gray-800 p-3">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setSidebarOpen(true)}
                  className="lg:hidden text-gray-400 hover:text-white"
                  title={t.sidebarOpen}
                >
                  ☰
                </button>
                <h1 className="text-lg font-bold">{t.appName}</h1>
              </div>
              <div className="flex items-center gap-2 text-xs">
                <LangToggle lang={lang} onChange={handleLangToggle} />
                <button
                  onClick={() => setShowProfile(true)}
                  title={t.profile}
                  className="flex items-center gap-1.5 hover:bg-gray-800 rounded px-1.5 py-0.5 transition-colors"
                >
                  {avatarSrc ? (
                    <img
                      src={avatarSrc}
                      alt={displayName}
                      className="w-6 h-6 rounded-full object-cover border border-gray-700"
                    />
                  ) : (
                    <span className="w-6 h-6 rounded-full bg-gray-700 flex items-center justify-center text-[10px] font-bold">
                      {displayName.slice(0, 1).toUpperCase()}
                    </span>
                  )}
                  <span className="text-gray-300 hidden sm:inline" title={user.username}>
                    {displayName}
                  </span>
                  <span className="px-1.5 py-0.5 rounded bg-gray-800 text-[10px] uppercase tracking-wider">
                    {user.tier}
                  </span>
                </button>
                {user.tier === 'super' && (
                  <button
                    onClick={() => navigate('/admin')}
                    className="text-gray-400 hover:text-white"
                    title={t.manageUsers}
                  >
                    ⚙️
                  </button>
                )}
                <button
                  onClick={handleLogout}
                  className="text-gray-500 hover:text-red-400"
                >
                  {t.logout}
                </button>
              </div>
            </div>
            <ProvidersBar
              models={user.models}
              selected={modelOverrides}
              onSelect={handleModelSelect}
            />
          </div>

          <div className="flex-none border-b border-gray-800 p-2">
            <ModeSelector mode={mode} onModeChange={setMode} />
            {mode !== 'free' && (
              <button
                onClick={() => setShowRoleConfig((s) => !s)}
                className="text-xs text-gray-400 hover:text-white mt-1 ml-1"
              >
                {showRoleConfig ? t.roleConfigHide : t.roleConfigShow}
              </button>
            )}
            {showRoleConfig && mode !== 'free' && (
              <RoleConfig mode={mode} roles={roles} onRolesChange={setRoles} />
            )}
          </div>

          <ChatArea
            messages={messages}
            mode={mode}
            onRegenerate={handleRegenerate}
            regeneratingId={regeneratingId}
          />

          {workflowStatus && (
            <div className="flex-none border-t border-gray-800 px-3 py-1.5 bg-gray-900 text-center">
              <span className="text-xs text-yellow-300 animate-pulse">
                {workflowStatus}
              </span>
            </div>
          )}

          <InputBar
            onSend={handleSend}
            onCancel={handleCancel}
            disabled={isProcessing}
            isProcessing={isProcessing}
          />

          <ProfileModal
            isOpen={showProfile}
            user={user}
            onClose={() => setShowProfile(false)}
            onUpdate={handleProfileUpdate}
          />
        </div>
      </div>
    );
  }

  return (
    <I18nContext.Provider value={i18nValue}>{content}</I18nContext.Provider>
  );
}
