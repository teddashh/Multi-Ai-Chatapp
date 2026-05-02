import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AIProvider,
  ChatMessage,
  ChatMode,
  MessageAttachment,
  ModeRoles,
  SSEEvent,
} from './shared/types';
import { modeGroupOf, modelAvailableInMode } from './shared/types';
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
import ProfileModal from './components/ProfileModal';
import Forum from './components/Forum';
import LandingPage from './components/LandingPage';
import LegalPage from './components/LegalPage';
import ShareToForumModal from './components/ShareToForumModal';
import TopNav from './components/TopNav';
import { DICTS, I18nContext, useT, type Lang } from './i18n';

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
  'spring',
  'summer',
  'fall',
  'winter',
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
  // Default to 'spring' for fresh visitors — warmer, lighter palette
  // reads less generic-AI than the all-black look that competitors
  // default to. Logged-in users keep their saved preference.
  return 'spring';
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
  // (Theme application moved below mode/singleProvider state — see
  // useEffect referencing isAgent further down.)

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
  // Sidebar's per-session 分享 button populates this; ShareToForumModal
  // reads sessionId/defaultTitle from here. null = closed.
  const [shareTarget, setShareTarget] = useState<{
    sessionId: string;
    defaultTitle: string;
  } | null>(null);
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
  // Active AI for Agent (single-AI) modes. Persisted across reloads
  // so the user's last pick sticks. Default Claude for the first run.
  const [singleProviderRaw, setSingleProviderRaw] = useState<AIProvider>(() => {
    try {
      const raw = localStorage.getItem('singleProvider');
      if (raw === 'claude' || raw === 'chatgpt' || raw === 'gemini' || raw === 'grok') {
        return raw;
      }
    } catch {
      // ignore
    }
    return 'claude';
  });
  const singleProvider = singleProviderRaw;
  useEffect(() => {
    try {
      localStorage.setItem('singleProvider', singleProvider);
    } catch {
      // ignore (private browsing, full quota)
    }
  }, [singleProvider]);

  // Push the active theme onto <html> so the CSS attribute selectors apply
  // to the entire page. In Agent mode the theme follows the picked AI
  // (claude/chatgpt/gemini/grok) — visual cue that you're talking to one
  // persona — and reverts to the user's saved theme on Multi mode.
  useEffect(() => {
    const isAgent =
      mode === 'personal' ||
      mode === 'profession' ||
      mode === 'reasoning' ||
      mode === 'image';
    const effective = isAgent ? singleProviderRaw : theme;
    document.documentElement.setAttribute('data-theme', effective);
  }, [theme, mode, singleProviderRaw]);

  // Profession persona for `profession` mode. Persisted so users don't
  // re-type the same role every session (medical advisor, lawyer, ...).
  const [profession, setProfession] = useState<string>(() => {
    try {
      return localStorage.getItem('profession') ?? '';
    } catch {
      return '';
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('profession', profession);
    } catch {
      // ignore
    }
  }, [profession]);

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
        // Strip the param so a refresh doesn't try again. Land on /chat
        // because the verify-success banner lives inside the chat UI;
        // landing on / would just bounce through LandingPage.
        window.history.replaceState({}, '', '/chat');
        setPathname('/chat');
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
        const m = detail.session.mode as ChatMode;
        setActiveSessionId(detail.session.id);
        setMode(m);
        // Restore Agent-mode state from the session's stored metadata
        // so the AI / profession / image model picker matches what the
        // session was originally created with. Without this, clicking a
        // Grok personal-chat session left the picker on whatever AI was
        // currently selected and you'd be talking to the wrong AI.
        const isAgent = modeGroupOf(m) === 'agent';
        if (isAgent && detail.session.meta) {
          const meta = detail.session.meta as {
            provider?: AIProvider;
            profession?: string;
            imageModel?: string;
          };
          if (meta.provider) {
            setSingleProviderRaw(meta.provider);
          }
          if (m === 'profession' && meta.profession) {
            setProfession(meta.profession);
          }
          if (m === 'image' && meta.imageModel && meta.provider) {
            setModelOverrides((prev) => ({
              ...prev,
              [meta.provider as AIProvider]: meta.imageModel as string,
            }));
          }
        } else if (m !== 'free' && detail.session.meta) {
          // Multi sequential modes — restore role assignments.
          setRoles(detail.session.meta as ModeRoles);
        }
        setMessages(
          detail.messages.map((msg) => ({
            id: msg.id,
            role: msg.role,
            provider: msg.provider,
            modeRole: msg.modeRole,
            content: msg.content,
            timestamp: msg.timestamp,
            attachments: msg.attachments,
            // Admin provenance — was being dropped on session load,
            // making the model name disappear from the per-message
            // header until you sent a fresh turn. Carry it through.
            answeredStage: msg.answeredStage,
            answeredModel: msg.answeredModel,
            requestedModel: msg.requestedModel,
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

  // Picking a different AI in Agent mode means starting a new
  // conversation — the previous session was a thread with a different
  // AI persona. Clear active session so the next message creates a
  // new one. Original session stays in the sidebar for re-entry.
  const setSingleProvider = useCallback((p: AIProvider) => {
    if (p === singleProviderRaw) return;
    setSingleProviderRaw(p);
    setActiveSessionId(null);
    setMessages([]);
    setConnectionLost(false);
  }, [singleProviderRaw]);

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

  // Permanent account purge: server-side has already cleared the cookie
  // and deleted everything tied to this user. Mirror the same in-memory
  // state-clearing as logout, then bounce to the public landing page.
  const handlePurged = useCallback(() => {
    setUser(null);
    setMessages([]);
    setShowProfile(false);
    navigate('/');
  }, [navigate]);

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
        // real summary directly so the sidebar updates instantly, plus
        // a refreshSessions() as belt-and-suspenders if prev didn't yet
        // have the row (first-message race on brand-new sessions).
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
        const isAgentMode = mode === 'personal' || mode === 'profession' || mode === 'reasoning' || mode === 'image';
        if (mode === 'profession' && !profession.trim()) {
          window.alert(t.modeProfessionRequired);
          setIsProcessing(false);
          return;
        }
        await streamChat(
          {
            text,
            mode,
            roles: !isAgentMode && mode !== 'free' ? roles : undefined,
            singleProvider: isAgentMode ? singleProvider : undefined,
            profession: mode === 'profession' ? profession.trim() : undefined,
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
    [mode, roles, singleProvider, profession, isProcessing, modelOverrides, activeSessionId, handleEvent, reloadActiveSession, t],
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
      if (regeneratingId) return;
      // If a workflow is in flight (common after one AI bailed out with
      // a "我現在狀況不太好…請按重試" fallback but the orchestrator is
      // still on the next round), cancel first so the server stops
      // cleanly before the retry kicks in. Previously this branch
      // returned silently and 重試 felt unresponsive.
      if (isProcessing) {
        handleCancel();
        await new Promise((r) => setTimeout(r, 200));
      }
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
      handleCancel,
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
  } else if (pathname === '/') {
    // Public landing page — first impression for new visitors and the
    // surface that picks up traffic from social shares of forum posts.
    // Logged-in users only flash this briefly before the auto-redirect
    // useEffect bounces them to /chat.
    content = (
      <LandingPage
        navigate={navigate}
        lang={lang}
        onLangChange={handleLangToggle}
        user={user}
      />
    );
  } else if (
    pathname === '/terms' ||
    pathname === '/privacy' ||
    pathname === '/data-deletion'
  ) {
    // Static legal pages — public, no auth gate. Footer of LandingPage
    // links here; we keep them shallow so search engines can crawl them.
    const legalKind: 'terms' | 'privacy' | 'data-deletion' =
      pathname === '/terms'
        ? 'terms'
        : pathname === '/privacy'
          ? 'privacy'
          : 'data-deletion';
    content = (
      <LegalPage
        kind={legalKind}
        navigate={navigate}
        lang={lang}
        onLangChange={handleLangToggle}
      />
    );
  } else if (pathname.startsWith('/forum')) {
    // Forum is browseable by anonymous viewers — keep before the !user
    // gate so unauthed visitors land on read-only forum instead of Login.
    content = (
      <div className="flex flex-col h-screen">
        <TopNav
          user={user}
          pathname={pathname}
          navigate={navigate}
          lang={lang}
          onLangChange={handleLangToggle}
          onProfileClick={() => setShowProfile(true)}
          onLogout={handleLogout}
          avatarBust={avatarBust}
        />
        <div className="flex-1 min-h-0 overflow-y-auto bg-gray-950">
          <Forum pathname={pathname} navigate={navigate} user={user} />
        </div>
        {user && (
          <ProfileModal
            isOpen={showProfile}
            user={user}
            onClose={() => setShowProfile(false)}
            onUpdate={handleProfileUpdate}
            onViewProfile={() => {
              setShowProfile(false);
              navigate(`/forum/user/${user.username}`);
            }}
            onPurged={handlePurged}
          />
        )}
      </div>
    );
  } else if (!user) {
    content = <Login onLogin={setUser} />;
  } else if (pathname === '/admin' && user.tier === 'admin') {
    content = (
      <AdminPage
        currentUser={user}
        onExit={() => navigate('/chat')}
      />
    );
  } else {
    content = (
      <div className="flex flex-col h-screen">
        <TopNav
          user={user}
          pathname={pathname}
          navigate={navigate}
          lang={lang}
          onLangChange={handleLangToggle}
          onProfileClick={() => setShowProfile(true)}
          onLogout={handleLogout}
          onSidebarToggle={() => setSidebarOpen(true)}
          avatarBust={avatarBust}
        />
        <div className="flex flex-1 min-h-0">
          <Sidebar
            sessions={sessions}
            activeId={activeSessionId}
            onSelect={handleSelectSession}
            onNew={handleNewChat}
            onRefresh={refreshSessions}
            onShare={(sessionId, defaultTitle) =>
              setShareTarget({ sessionId, defaultTitle })
            }
            isOpen={sidebarOpen}
            onClose={() => setSidebarOpen(false)}
          />
          <div className="flex flex-col flex-1 min-w-0">
          {/* Row order (top-down) so the most-frequently-changed knobs
              are closest to the chat input:
                1. mode group + inner mode
                2. providers / single-AI picker (varies by group)
                3. role config (collapsed by default, multi sequential modes only)
            */}
          <div className="flex-none border-b border-gray-800 p-2 space-y-2">
            <ModeSelector mode={mode} onModeChange={setMode} />
            {modeGroupOf(mode) === 'multi' ? (
              <ProvidersBar
                models={user.models}
                selected={modelOverrides}
                onSelect={handleModelSelect}
                priceLabels={user.priceLabels}
                mode={mode}
              />
            ) : (
              <SingleProviderPicker
                models={user.models}
                provider={singleProvider}
                onChange={setSingleProvider}
                modelOverride={modelOverrides[singleProvider]}
                onModelChange={(model) => handleModelSelect(singleProvider, model)}
                priceLabels={user.priceLabels}
                label={t.agentTalkTo}
                lockedModelLabel={mode === 'reasoning' ? REASONING_MODEL_HINT[singleProvider] : undefined}
                mode={mode}
              />
            )}
            {mode === 'profession' && (
              <ProfessionInput
                value={profession}
                onChange={setProfession}
                placeholder={t.modeProfessionPlaceholder}
              />
            )}
            {mode !== 'free' && modeGroupOf(mode) === 'multi' && (
              <div>
                <button
                  onClick={() => setShowRoleConfig((s) => !s)}
                  className="text-xs text-gray-400 hover:text-white"
                >
                  {showRoleConfig ? t.roleConfigHide : t.roleConfigShow}
                </button>
                {showRoleConfig && (
                  <RoleConfig mode={mode} roles={roles} onRolesChange={setRoles} />
                )}
              </div>
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
            onViewProfile={() => {
              setShowProfile(false);
              navigate(`/forum/user/${user.username}`);
            }}
            onPurged={handlePurged}
          />

          <ShareToForumModal
            isOpen={shareTarget !== null}
            sessionId={shareTarget?.sessionId ?? null}
            defaultTitle={shareTarget?.defaultTitle ?? ''}
            onClose={() => setShareTarget(null)}
            onShared={(postId, isNew, appended) => {
              setShareTarget(null);
              if (!isNew && appended === 0) {
                alert('沒有新的訊息可追加到原貼文。');
                navigate(`/forum/post/${postId}`);
                return;
              }
              if (!isNew) {
                alert(`已追加 ${appended} 則訊息到原貼文。`);
              }
              navigate(`/forum/post/${postId}`);
            }}
          />
          </div>
        </div>
      </div>
    );
  }

  return (
    <I18nContext.Provider value={i18nValue}>{content}</I18nContext.Provider>
  );
}

// =====================================================================
// SingleProviderPicker — used in Agent (single-AI) modes. Replaces the
// 4-column ProvidersBar with one "對象" pill that lets the user pick
// which AI to talk to + a model dropdown for that AI. The pill borrows
// the same provider colors from ProviderAvatar so it feels consistent
// with the multi-mode bar.
// =====================================================================

const PROVIDER_COLOR: Record<AIProvider, string> = {
  claude: '#d97706',
  chatgpt: '#10a37f',
  gemini: '#4285f4',
  grok: '#e11d48',
};
const PROVIDER_NAME: Record<AIProvider, string> = {
  claude: 'Claude',
  chatgpt: 'ChatGPT',
  gemini: 'Gemini',
  grok: 'Grok',
};
const PROVIDER_ORDER: AIProvider[] = ['chatgpt', 'claude', 'gemini', 'grok'];

// Mirrors orchestrator.REASONING_MODEL — labels shown in the Agent
// picker when 深度思考 mode is active. The server still authoritatively
// resolves the actual model based on the user's tier; this is purely
// a UI hint so the user knows what flagship reasoning model is being
// used per family.
const REASONING_MODEL_HINT: Record<AIProvider, string> = {
  claude: 'claude-opus-4-7',
  chatgpt: 'o3',
  gemini: 'gemini-3.1-pro-preview',
  grok: 'grok-4.20-0309-reasoning',
};

// Mirror of server-side IMAGE_MODELS. Each AI persona gets its own
// vendor's image stack, with SDXL as the universal cheap fallback.
// Keep in sync with server/src/shared/models.ts.
const IMAGE_MODELS: Record<AIProvider, string[]> = {
  chatgpt: [
    'gpt-image-2-high',
    'gpt-image-2-medium',
    'gpt-image-2-low',
    'gpt-image-1.5-high',
    'gpt-image-1.5-medium',
    'gpt-image-1-high',
    'gpt-image-1-medium',
    'gpt-image-1-low',
    'gpt-image-1-mini',
    'sdxl',
  ],
  claude: ['flux-1.1-pro-ultra', 'flux-1.1-pro', 'sdxl'],
  gemini: [
    'imagen-4.0-ultra-generate-001',
    'imagen-4.0-generate-001',
    'imagen-4.0-fast-generate-001',
    'gemini-3-pro-image-preview',
    'gemini-3.1-flash-image-preview',
    'gemini-2.5-flash-image',
    'sdxl',
  ],
  grok: ['grok-imagine-image-pro', 'grok-imagine-image', 'sdxl'],
};
const IMAGE_DEFAULT: Record<AIProvider, string> = {
  chatgpt: 'gpt-image-1-medium',
  claude: 'flux-1.1-pro',
  gemini: 'imagen-4.0-generate-001',
  grok: 'grok-imagine-image',
};

interface SingleProviderPickerProps {
  models: Record<AIProvider, { default: string; options: string[] }>;
  provider: AIProvider;
  onChange: (p: AIProvider) => void;
  modelOverride: string | undefined;
  onModelChange: (model: string) => void;
  // Per-model price labels for the dropdown ("$5/$30 /M" / "$0.07/img").
  priceLabels: Record<string, string>;
  label: string;
  // When set, hide the model dropdown and instead display this string
  // (used by 深度思考 mode where the model is server-locked to each
  // family's reasoning variant).
  lockedModelLabel?: string;
  // Filters the model dropdown to models valid in this mode (e.g.
  // hides codex outside Coding, hides o3/o4 outside Reasoning).
  mode: ChatMode;
}

function SingleProviderPicker({
  models,
  provider,
  onChange,
  modelOverride,
  onModelChange,
  priceLabels,
  label,
  lockedModelLabel,
  mode,
}: SingleProviderPickerProps) {
  // Image mode swaps the chat-model dropdown for the per-family image
  // catalog (gpt-image-1 quality variants, Flux, Imagen, etc.). All
  // other modes stay on tier-allowed chat models with mode filtering.
  const isImageMode = mode === 'image';
  const baseOptions = isImageMode
    ? IMAGE_MODELS[provider]
    : models[provider].options.filter((m) => modelAvailableInMode(m, mode));
  const baseDefault = isImageMode ? IMAGE_DEFAULT[provider] : models[provider].default;
  const currentModel =
    modelOverride && baseOptions.includes(modelOverride)
      ? modelOverride
      : baseOptions.includes(baseDefault)
        ? baseDefault
        : (baseOptions[0] ?? baseDefault);
  const options = baseOptions;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-gray-500 mr-1">{label}:</span>
      <div className="flex gap-1">
        {PROVIDER_ORDER.map((p) => {
          const active = p === provider;
          return (
            <button
              key={p}
              onClick={() => onChange(p)}
              className={`px-2 py-1 rounded text-xs font-medium transition-colors ${
                active
                  ? 'text-white'
                  : 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200'
              }`}
              style={active ? { backgroundColor: PROVIDER_COLOR[p] } : undefined}
            >
              {PROVIDER_NAME[p]}
            </button>
          );
        })}
      </div>
      {lockedModelLabel ? (
        <span className="px-2 py-1 rounded bg-gray-900 border border-gray-800 text-[11px] text-gray-400 font-mono">
          🧠 {lockedModelLabel}
        </span>
      ) : (
        <select
          value={currentModel}
          onChange={(e) => onModelChange(e.target.value)}
          className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 max-w-full"
          style={{ minWidth: '12em' }}
        >
          {options.map((m) => {
            // Only show the per-call price label for image models —
            // chat token pricing is widely understood and clutters
            // the dropdown. Image models are the surprising/opaque
            // ones (per-image, not per-token), so the price stays.
            const price = isImageMode ? priceLabels[m] : null;
            return (
              <option key={m} value={m}>
                {price ? `${m}  ${price}` : m}
              </option>
            );
          })}
        </select>
      )}
    </div>
  );
}

// Inline profession input for the 指定職業 / Profession mode. Persists
// via the parent component's state; the mode handler injects it as a
// system instruction prefix on every turn.
interface ProfessionInputProps {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}
function ProfessionInput({ value, onChange, placeholder }: ProfessionInputProps) {
  const t = useT();
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-gray-500">{t.modeProfessionLabel}:</span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="flex-1 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500"
        maxLength={60}
      />
    </div>
  );
}
