import React, { useCallback, useEffect, useRef, useState } from 'react';
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
  getSession,
  listSessions,
  logout,
  me,
  streamChat,
  streamRegenerate,
  type SessionSummary,
  type User,
} from './api';
import Login from './components/Login';
import ResetPassword from './components/ResetPassword';
import ProvidersBar from './components/ProvidersBar';
import ModeSelector from './components/ModeSelector';
import RoleConfig from './components/RoleConfig';
import ChatArea from './components/ChatArea';
import InputBar from './components/InputBar';
import AdminPanel from './components/AdminPanel';
import Sidebar from './components/Sidebar';

const DEFAULT_ROLES: Record<string, ModeRoles> = {
  debate: DEFAULT_DEBATE_ROLES,
  consult: DEFAULT_CONSULT_ROLES,
  coding: DEFAULT_CODING_ROLES,
  roundtable: DEFAULT_ROUNDTABLE_ROLES,
};

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [resetToken, setResetToken] = useState<string | null>(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('reset');
  });

  const [mode, setMode] = useState<ChatMode>('free');
  const [roles, setRoles] = useState<ModeRoles>(DEFAULT_DEBATE_ROLES);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [workflowStatus, setWorkflowStatus] = useState('');
  const [showRoleConfig, setShowRoleConfig] = useState(false);
  const [showAdmin, setShowAdmin] = useState(false);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [regeneratingId, setRegeneratingId] = useState<string | null>(null);
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
    });
  }, []);

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

  const handleSelectSession = useCallback(async (id: string) => {
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
      alert(`載入失敗：${(err as Error).message}`);
    }
  }, []);

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
          // Prefer the persisted DB id when the server sends one — that lets
          // retry buttons work without needing a session reload first.
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
        if (ev.provider) {
          // Provider-specific error already surfaced via 'done' with [Error: ...]
          break;
        }
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
        // Refresh session list so the sidebar updated_at order reflects this turn
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

      // Sequential modes replay the whole tail. Drop the retry target plus
      // anything after it from local state — the streaming handler will
      // re-add them as new messages just like a fresh chat turn.
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
            ? handleEvent // reuse streamChat handler — renders the whole tail
            : (ev) => {
                // Free mode: in-place rewrite of one cell.
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
          alert(`重新作答失敗：${(err as Error).message}`);
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
    [regeneratingId, isProcessing, mode, modelOverrides, handleEvent],
  );

  if (resetToken) {
    return (
      <ResetPassword
        token={resetToken}
        onDone={() => {
          setResetToken(null);
          window.history.replaceState({}, '', '/');
        }}
      />
    );
  }

  if (!authChecked) {
    return (
      <div className="min-h-screen flex items-center justify-center text-gray-500 text-sm">
        Loading...
      </div>
    );
  }

  if (!user) {
    return <Login onLogin={setUser} />;
  }

  return (
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
      {/* Header */}
      <div className="flex-none border-b border-gray-800 p-3">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setSidebarOpen(true)}
              className="lg:hidden text-gray-400 hover:text-white"
              title="開啟側邊欄"
            >
              ☰
            </button>
            <h1 className="text-lg font-bold">Multi-AI Chatapp</h1>
          </div>
          <div className="flex items-center gap-3 text-xs">
            <span className="text-gray-400" title={user.username}>
              {user.nickname || user.username}{' '}
              <span className="px-1.5 py-0.5 rounded bg-gray-800 text-[10px] uppercase tracking-wider">
                {user.tier}
              </span>
            </span>
            {user.tier === 'super' && (
              <button
                onClick={() => setShowAdmin(true)}
                className="text-gray-400 hover:text-white"
                title="使用者管理"
              >
                ⚙️
              </button>
            )}
            <button
              onClick={handleLogout}
              className="text-gray-500 hover:text-red-400"
            >
              登出
            </button>
          </div>
        </div>
        <ProvidersBar
          models={user.models}
          selected={modelOverrides}
          onSelect={handleModelSelect}
        />
      </div>

      {/* Mode + Roles */}
      <div className="flex-none border-b border-gray-800 p-2">
        <ModeSelector mode={mode} onModeChange={setMode} />
        {mode !== 'free' && (
          <button
            onClick={() => setShowRoleConfig((s) => !s)}
            className="text-xs text-gray-400 hover:text-white mt-1 ml-1"
          >
            {showRoleConfig ? '▲ 收起角色設定' : '▼ 角色設定'}
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

      <AdminPanel
        isOpen={showAdmin}
        onClose={() => setShowAdmin(false)}
        currentUsername={user.username}
      />
      </div>
    </div>
  );
}
