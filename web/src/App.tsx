import React, { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ChatMessage,
  ChatMode,
  ModeRoles,
  SSEEvent,
} from './shared/types';
import {
  AI_PROVIDERS,
  CHAT_MODES,
  DEFAULT_CODING_ROLES,
  DEFAULT_CONSULT_ROLES,
  DEFAULT_DEBATE_ROLES,
  DEFAULT_ROUNDTABLE_ROLES,
} from './shared/constants';
import { logout, me, streamChat, type User } from './api';
import Login from './components/Login';
import ProvidersBar from './components/ProvidersBar';
import ModeSelector from './components/ModeSelector';
import RoleConfig from './components/RoleConfig';
import ChatArea from './components/ChatArea';
import InputBar from './components/InputBar';
import AdminPanel from './components/AdminPanel';

const DEFAULT_ROLES: Record<string, ModeRoles> = {
  debate: DEFAULT_DEBATE_ROLES,
  consult: DEFAULT_CONSULT_ROLES,
  coding: DEFAULT_CODING_ROLES,
  roundtable: DEFAULT_ROUNDTABLE_ROLES,
};

function buildExportMarkdown(messages: ChatMessage[], mode: ChatMode): string {
  const info = CHAT_MODES[mode];
  const lines: string[] = [
    `# Multi-AI Chat — ${info.icon} ${info.name}`,
    `> Exported: ${new Date().toLocaleString()}`,
    '',
    '---',
    '',
  ];
  for (const msg of messages) {
    if (msg.role === 'user') {
      lines.push('## 👤 User');
      lines.push('');
      lines.push(...msg.content.split('\n').map((l) => `> ${l}`));
    } else {
      const name = msg.provider ? AI_PROVIDERS[msg.provider].name : 'AI';
      const role = msg.modeRole ? ` (${msg.modeRole})` : '';
      lines.push(`## 🤖 ${name}${role}`);
      lines.push('');
      lines.push(msg.content);
    }
    lines.push('');
    lines.push('---');
    lines.push('');
  }
  return lines.join('\n');
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [authChecked, setAuthChecked] = useState(false);

  const [mode, setMode] = useState<ChatMode>('free');
  const [roles, setRoles] = useState<ModeRoles>(DEFAULT_DEBATE_ROLES);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [workflowStatus, setWorkflowStatus] = useState('');
  const [showRoleConfig, setShowRoleConfig] = useState(false);
  const [showAdmin, setShowAdmin] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const pendingRolesRef = useRef<Record<string, string>>({});

  useEffect(() => {
    me().then((u) => {
      setUser(u);
      setAuthChecked(true);
    });
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

  const handleEvent = useCallback((ev: SSEEvent) => {
    switch (ev.type) {
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
                    id: m.id.replace('-streaming', ''),
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
              id: `${ev.provider}-${Date.now()}`,
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
        break;
    }
  }, []);

  const handleSend = useCallback(
    async (text: string) => {
      if (isProcessing) return;
      const userMsg: ChatMessage = {
        id: `user-${Date.now()}`,
        role: 'user',
        content: text,
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, userMsg]);
      setIsProcessing(true);

      const ctrl = new AbortController();
      abortRef.current = ctrl;

      try {
        await streamChat(
          { text, mode, roles: mode !== 'free' ? roles : undefined },
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
    [mode, roles, isProcessing, handleEvent],
  );

  const handleCancel = useCallback(() => {
    abortRef.current?.abort();
    setIsProcessing(false);
    setWorkflowStatus('');
  }, []);

  const handleExport = useCallback(() => {
    if (messages.length === 0) return;
    const md = buildExportMarkdown(messages, mode);
    const blob = new Blob([md], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const ts = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
    const a = document.createElement('a');
    a.href = url;
    a.download = `multi-ai-chat-${mode}-${ts}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }, [messages, mode]);

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
    <div className="flex flex-col h-screen max-w-3xl mx-auto">
      {/* Header */}
      <div className="flex-none border-b border-gray-800 p-3">
        <div className="flex items-center justify-between mb-2">
          <h1 className="text-lg font-bold">Multi-AI Chatapp</h1>
          <div className="flex items-center gap-3 text-xs">
            <button
              onClick={handleExport}
              disabled={messages.length === 0}
              className="text-gray-400 hover:text-white disabled:opacity-30"
              title="匯出 Markdown"
            >
              📥 匯出
            </button>
            <span className="text-gray-400">
              {user.username}{' '}
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
        <ProvidersBar />
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

      <ChatArea messages={messages} />

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
  );
}
