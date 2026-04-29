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
  abortChat,
  avatarUrl,
  getSession,
  listSessions,
  logout,
  me,
  resendVerifyEmail,
  streamChat,
  streamRegenerate,
  updateProfile,
  verifyEmail,
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
  // Email verification token from `?verify=...` link. Handled once the
  // user is loaded so we can update their state in place.
  const [verifyToken, setVerifyToken] = useState<string | null>(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('verify');
  });
  const [verifyState, setVerifyState] = useState<
    | { kind: 'idle' }
    | { kind: 'verifying' }
    | { kind: 'ok' }
    | { kind: 'err'; msg: string }
  >({ kind: 'idle' });
  const [resendState, setResendState] = useState<
    'idle' | 'sending' | 'sent' | 'err'
  >('idle');
  const [connectionLost, setConnectionLost] = useState(false);

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

  // Pulled out so the SSE-drop recovery can use it. Reloads the active
  // session from DB so any messages the server persisted while we were
  // disconnected show up in the UI.
  const reloadActiveSession = useCallback(async () => {
    if (!activeSessionId) return;
    try {
      const detail = await getSession(activeSessionId);
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
    } catch {
      // best-effort
    }
  }, [activeSessionId]);

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

  // Resolve `?verify=` exactly once. We want this to fire whether the user
  // is logged in or not — verifyEmail accepts the token directly and
  // returns the freshly-verified user DTO.
  useEffect(() => {
    if (!verifyToken) return;
    setVerifyState({ kind: 'verifying' });
    verifyEmail(verifyToken)
      .then((u) => {
        setUser(u);
        setVerifyState({ kind: 'ok' });
      })
      .catch((err: Error) => {
        setVerifyState({ kind: 'err', msg: err.message });
      })
      .finally(() => {
        setVerifyToken(null);
        // Strip the param so a refresh doesn't try again.
        window.history.replaceState({}, '', '/');
      });
  }, [verifyToken]);

  const handleResendVerify = useCallback(async () => {
    setResendState('sending');
    try {
      await resendVerifyEmail();
      setResendState('sent');
      setTimeout(() => setResendState('idle'), 4000);
    } catch {
      setResendState('err');
      setTimeout(() => setResendState('idle'), 4000);
    }
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
                    answeredStage: ev.answeredStage ?? m.answeredStage,
                    answeredModel: ev.answeredModel ?? m.answeredModel,
                    requestedModel: ev.requestedModel ?? m.requestedModel,
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
              answeredStage: ev.answeredStage,
              answeredModel: ev.answeredModel,
              requestedModel: ev.requestedModel,
            },
          ];
        });
        break;
      case 'fallback_notice':
        // Primary path failed (429/timeout/etc) and the orchestrator is
        // about to stream a fallback response into the same bubble. Wipe
        // any partial text so the bridge line "我換個方式…" is what the
        // user sees until the fallback's first chunk arrives. No mention
        // of OpenRouter — the swap stays invisible to the user.
        setMessages((prev) => {
          const streaming = prev.find(
            (m) =>
              m.provider === ev.provider &&
              m.role === 'ai' &&
              m.id.endsWith('-streaming'),
          );
          if (streaming) {
            return prev.map((m) =>
              m.id === streaming.id ? { ...m, content: ev.message } : m,
            );
          }
          // No partial bubble yet (e.g. primary failed before any chunk) —
          // create the streaming bubble with the bridge line so the user
          // sees a "thinking" placeholder rather than nothing.
          const modeRole = pendingRolesRef.current[ev.provider];
          return [
            ...prev,
            {
              id: `${ev.provider}-${Date.now()}-streaming`,
              role: 'ai',
              provider: ev.provider,
              modeRole,
              content: ev.message,
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
      case 'session_title':
        // NVIDIA-generated title for a brand-new session. Swap in the
        // real summary directly so the sidebar updates instantly. Also
        // schedule a refreshSessions() so any other state on the row
        // (timestamp etc) reconciles, and as belt-and-suspenders if the
        // local prev didn't have the row yet (race on first message of
        // a brand new session).
        setSessions((prev) =>
          prev.map((s) =>
            s.id === ev.sessionId ? { ...s, title: ev.title } : s,
          ),
        );
        refreshSessions();
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
          // Likely the SSE stream got dropped (tab backgrounded, network
          // blip, mobile suspension). The server keeps running, so just
          // reload the session and show a friendly banner instead of
          // injecting a noisy "[Error] xxx" bubble.
          setConnectionLost(true);
          await reloadActiveSession();
        }
      } finally {
        setIsProcessing(false);
        setWorkflowStatus('');
        abortRef.current = null;
      }
    },
    [mode, roles, isProcessing, modelOverrides, activeSessionId, handleEvent, reloadActiveSession],
  );

  const handleCancel = useCallback(() => {
    // Tell the server to stop the orchestrator — disconnecting the SSE
    // alone no longer aborts (so backgrounded tabs don't kill the chain),
    // so a real "Stop" needs an explicit endpoint hit.
    if (activeSessionId) {
      void abortChat(activeSessionId);
    }
    abortRef.current?.abort();
    setIsProcessing(false);
    setWorkflowStatus('');
  }, [activeSessionId]);

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
          // Stream dropped — same recovery as handleSend.
          setConnectionLost(true);
          await reloadActiveSession();
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
    [
      regeneratingId,
      isProcessing,
      mode,
      modelOverrides,
      handleEvent,
      reloadActiveSession,
    ],
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
  } else if (pathname === '/admin' && user.tier === 'admin') {
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
                {user.tier === 'admin' && (
                  <button
                    onClick={() => navigate('/admin')}
                    className="text-gray-400 hover:text-white"
                    title={t.manageUsers}
                  >
                    Admin
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

          {connectionLost && (
            <div className="flex-none border-b border-amber-700/40 bg-amber-900/20 px-3 py-2 text-xs text-amber-200 flex flex-wrap items-center gap-2">
              <span className="flex-1">{t.connectionLostBanner}</span>
              <button
                onClick={() => setConnectionLost(false)}
                className="px-2 py-0.5 rounded bg-amber-700/40 hover:bg-amber-700/60"
              >
                {t.connectionLostDismiss}
              </button>
            </div>
          )}
          {!user.emailVerified && (
            <div className="flex-none border-b border-yellow-700/40 bg-yellow-900/20 px-3 py-2 text-xs text-yellow-200 flex flex-wrap items-center gap-2">
              <span className="flex-1">{t.verifyBannerText}</span>
              <button
                onClick={handleResendVerify}
                disabled={resendState === 'sending' || resendState === 'sent'}
                className="px-2 py-0.5 rounded bg-yellow-700/40 hover:bg-yellow-700/60 disabled:opacity-50"
              >
                {resendState === 'sending'
                  ? t.loading
                  : resendState === 'sent'
                    ? t.verifyBannerSent
                    : t.verifyBannerResend}
              </button>
            </div>
          )}
          {verifyState.kind !== 'idle' && (
            <div
              className={`flex-none border-b px-3 py-2 text-xs ${
                verifyState.kind === 'ok'
                  ? 'border-emerald-700/40 bg-emerald-900/20 text-emerald-200'
                  : verifyState.kind === 'err'
                    ? 'border-red-700/40 bg-red-900/20 text-red-200'
                    : 'border-blue-700/40 bg-blue-900/20 text-blue-200'
              }`}
            >
              {verifyState.kind === 'verifying' && t.verifyVerifying}
              {verifyState.kind === 'ok' && t.verifySuccess}
              {verifyState.kind === 'err' && t.verifyFailed(verifyState.msg)}
            </div>
          )}

          <ChatArea
            messages={messages}
            mode={mode}
            user={user}
            avatarBust={avatarBust}
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
