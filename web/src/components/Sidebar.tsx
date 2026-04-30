import React, { useState } from 'react';
import { AI_PROVIDERS } from '../shared/constants';
import type { AgentSessionMeta, SessionSummary } from '../api';
import { deleteSession, getSession, renameSession } from '../api';
import { modeName, useT } from '../i18n';
import type { Dict } from '../i18n';
import type { ChatMode } from '../shared/types';
import { modeGroupOf } from '../shared/types';

// Session row subtitle: "{relative time} · {mode}{·provider}{·extra}"
// so users can scan the sidebar and tell at a glance "this thread was a
// 個性化聊天 with Grok" vs "this was a 指定職業 doctor session".
function buildSubtitle(
  t: Dict,
  session: SessionSummary,
): string {
  const time = relativeTime(t, session.updated_at);
  const modeLabel = modeName(t, session.mode);
  const isAgent = modeGroupOf(session.mode) === 'agent';
  if (!isAgent) return `${time} · ${modeLabel}`;
  const meta = session.meta as AgentSessionMeta | null;
  const provider = meta?.provider;
  const providerLabel = provider ? AI_PROVIDERS[provider].name : '';
  let extra = '';
  if (session.mode === 'profession' && meta?.profession) {
    extra = ` · ${meta.profession}`;
  } else if (session.mode === 'image' && meta?.imageModel) {
    extra = ` · ${meta.imageModel}`;
  }
  return `${time} · ${modeLabel}${providerLabel ? ' / ' + providerLabel : ''}${extra}`;
}

interface Props {
  sessions: SessionSummary[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRefresh: () => void;
  isOpen: boolean;
  onClose: () => void;
}

function relativeTime(t: Dict, epochSeconds: number): string {
  const diff = Math.floor(Date.now() / 1000 - epochSeconds);
  if (diff < 60) return t.timeJustNow;
  if (diff < 3600) return t.timeMinAgo(Math.floor(diff / 60));
  if (diff < 86400) return t.timeHourAgo(Math.floor(diff / 3600));
  if (diff < 86400 * 7) return t.timeDayAgo(Math.floor(diff / 86400));
  return new Date(epochSeconds * 1000).toLocaleDateString();
}

export default function Sidebar({
  sessions,
  activeId,
  onSelect,
  onNew,
  onRefresh,
  isOpen,
  onClose,
}: Props) {
  const t = useT();
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const handleStartRename = (s: SessionSummary, e: React.MouseEvent) => {
    e.stopPropagation();
    setRenamingId(s.id);
    setRenameValue(s.title);
  };

  const handleCommitRename = async (id: string) => {
    const title = renameValue.trim();
    if (!title) {
      setRenamingId(null);
      return;
    }
    try {
      await renameSession(id, title);
      onRefresh();
    } catch (err) {
      alert(t.renameFailed((err as Error).message));
    }
    setRenamingId(null);
  };

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm(t.sidebarConfirmDelete)) return;
    try {
      await deleteSession(id);
      onRefresh();
    } catch (err) {
      alert(t.deleteFailed((err as Error).message));
    }
  };

  const handleExport = async (s: SessionSummary, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const detail = await getSession(s.id);
      const m = detail.session.mode as ChatMode;
      const lines: string[] = [
        `# AI Sister — ${detail.session.title}`,
        `> Mode: ${modeName(t, m)}`,
        `> Exported: ${new Date().toLocaleString()}`,
        '',
        '---',
        '',
      ];
      for (const msg of detail.messages) {
        if (msg.role === 'user') {
          lines.push(t.exportUserHeading);
          lines.push('');
          lines.push(...msg.content.split('\n').map((l) => `> ${l}`));
        } else {
          const name = msg.provider ? AI_PROVIDERS[msg.provider].name : 'AI';
          const role = msg.modeRole ? ` (${msg.modeRole})` : '';
          lines.push(`## ${name}${role}`);
          lines.push('');
          lines.push(msg.content);
        }
        lines.push('');
        lines.push('---');
        lines.push('');
      }
      const blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const ts = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
      const safeTitle = detail.session.title
        .replace(/[\\/:*?"<>|]/g, '_')
        .slice(0, 60);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${safeTitle}-${ts}.md`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      alert(t.exportFailed((err as Error).message));
    }
  };

  return (
    <>
      {isOpen && (
        <div
          className="lg:hidden fixed inset-0 bg-black/60 z-30"
          onClick={onClose}
        />
      )}
      <aside
        className={`fixed lg:static top-0 left-0 z-40 h-full w-64 flex-none bg-gray-950 border-r border-gray-800 flex flex-col transition-transform lg:transition-none ${
          isOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'
        }`}
      >
        <div className="p-3 border-b border-gray-800 flex items-center gap-2">
          <button
            onClick={() => {
              onNew();
              onClose();
            }}
            className="flex-1 px-3 py-2 bg-blue-600 hover:bg-blue-700 rounded text-sm font-medium"
          >
            {t.sidebarNew}
          </button>
          <button
            onClick={onClose}
            className="lg:hidden text-gray-400 hover:text-white text-sm px-2"
          >
            ✕
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {sessions.length === 0 ? (
            <div className="text-xs text-gray-500 text-center py-4">
              {t.sidebarEmpty}
            </div>
          ) : (
            sessions.map((s) => {
              const active = s.id === activeId;
              const renaming = s.id === renamingId;
              return (
                <div
                  key={s.id}
                  onClick={() => {
                    if (!renaming) {
                      onSelect(s.id);
                      onClose();
                    }
                  }}
                  className={`group rounded p-2 cursor-pointer transition-colors ${
                    active
                      ? 'bg-blue-600/20 border border-blue-700/40'
                      : 'hover:bg-gray-800 border border-transparent'
                  }`}
                >
                  <div className="mb-0.5">
                    {renaming ? (
                      <input
                        autoFocus
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onClick={(e) => e.stopPropagation()}
                        onBlur={() => handleCommitRename(s.id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleCommitRename(s.id);
                          if (e.key === 'Escape') setRenamingId(null);
                        }}
                        className="w-full bg-gray-800 border border-gray-700 rounded px-1 text-xs"
                      />
                    ) : (
                      <span className="text-xs font-medium truncate block">
                        {s.title}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] text-gray-500 truncate flex-1 mr-1">
                      {buildSubtitle(t, s)}
                    </span>
                    <div className="flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity text-[10px]">
                      <button
                        onClick={(e) => handleExport(s, e)}
                        className="text-gray-500 hover:text-white"
                      >
                        {t.sidebarExport}
                      </button>
                      <button
                        onClick={(e) => handleStartRename(s, e)}
                        className="text-gray-500 hover:text-white"
                      >
                        {t.sidebarRename}
                      </button>
                      <button
                        onClick={(e) => handleDelete(s.id, e)}
                        className="text-gray-500 hover:text-red-400"
                      >
                        {t.sidebarDelete}
                      </button>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </aside>
    </>
  );
}
