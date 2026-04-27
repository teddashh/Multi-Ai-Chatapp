import React, { useState } from 'react';
import { AI_PROVIDERS, CHAT_MODES } from '../shared/constants';
import type { SessionSummary } from '../api';
import { deleteSession, getSession, renameSession } from '../api';

interface Props {
  sessions: SessionSummary[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRefresh: () => void;
  isOpen: boolean;
  onClose: () => void;
}

function relativeTime(epochSeconds: number): string {
  const diff = Math.floor(Date.now() / 1000 - epochSeconds);
  if (diff < 60) return '剛剛';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分鐘前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小時前`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} 天前`;
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
      alert(`改名失敗：${(err as Error).message}`);
    }
    setRenamingId(null);
  };

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm('刪除這個對話？')) return;
    try {
      await deleteSession(id);
      onRefresh();
    } catch (err) {
      alert(`刪除失敗：${(err as Error).message}`);
    }
  };

  const handleExport = async (s: SessionSummary, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const detail = await getSession(s.id);
      const modeInfo = CHAT_MODES[detail.session.mode];
      const lines: string[] = [
        `# Multi-AI Chat — ${modeInfo?.icon ?? ''} ${detail.session.title}`,
        `> Mode: ${modeInfo?.name ?? detail.session.mode}`,
        `> Exported: ${new Date().toLocaleString()}`,
        '',
        '---',
        '',
      ];
      for (const m of detail.messages) {
        if (m.role === 'user') {
          lines.push('## 👤 User');
          lines.push('');
          lines.push(...m.content.split('\n').map((l) => `> ${l}`));
        } else {
          const name = m.provider ? AI_PROVIDERS[m.provider].name : 'AI';
          const role = m.modeRole ? ` (${m.modeRole})` : '';
          lines.push(`## 🤖 ${name}${role}`);
          lines.push('');
          lines.push(m.content);
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
      alert(`匯出失敗：${(err as Error).message}`);
    }
  };

  return (
    <>
      {/* Mobile backdrop */}
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
            + 新對話
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
              還沒有對話
            </div>
          ) : (
            sessions.map((s) => {
              const modeInfo = CHAT_MODES[s.mode];
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
                  <div className="flex items-center gap-1.5 mb-0.5">
                    <span className="text-xs flex-none">{modeInfo?.icon ?? '💬'}</span>
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
                        className="flex-1 bg-gray-800 border border-gray-700 rounded px-1 text-xs"
                      />
                    ) : (
                      <span className="text-xs font-medium truncate flex-1">
                        {s.title}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] text-gray-500">
                      {relativeTime(s.updated_at)}
                    </span>
                    <div className="flex gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={(e) => handleExport(s, e)}
                        className="text-[10px] text-gray-500 hover:text-white"
                        title="匯出 Markdown"
                      >
                        📥
                      </button>
                      <button
                        onClick={(e) => handleStartRename(s, e)}
                        className="text-[10px] text-gray-500 hover:text-white"
                        title="改名"
                      >
                        ✎
                      </button>
                      <button
                        onClick={(e) => handleDelete(s.id, e)}
                        className="text-[10px] text-gray-500 hover:text-red-400"
                        title="刪除"
                      >
                        🗑
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
