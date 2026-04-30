// Share-to-forum modal — opened from the chat header. Pre-fills the
// title from the first user message; user picks 看板 + anonymous toggle.
// On re-share (same session already in forum) the server silently
// appends new chat messages and locks category/title/anonymous.

import React, { useState } from 'react';
import { FORUM_CATEGORIES, type ForumCategory } from '../shared/types';
import { shareSessionToForum } from '../api';

interface Props {
  isOpen: boolean;
  sessionId: string | null;
  defaultTitle: string; // first 60 chars of session's first user message
  onClose: () => void;
  onShared: (postId: number, isNew: boolean, appended: number) => void;
}

export default function ShareToForumModal({
  isOpen,
  sessionId,
  defaultTitle,
  onClose,
  onShared,
}: Props) {
  const [category, setCategory] = useState<ForumCategory>('雜談');
  const [title, setTitle] = useState(defaultTitle);
  const [anonymous, setAnonymous] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>('');

  React.useEffect(() => {
    if (isOpen) {
      setTitle(defaultTitle);
      setErr('');
    }
  }, [isOpen, defaultTitle]);

  if (!isOpen || !sessionId) return null;

  const submit = async () => {
    setBusy(true);
    setErr('');
    try {
      const res = await shareSessionToForum({
        sessionId,
        category,
        isAnonymous: anonymous,
        title: title.trim() || undefined,
      });
      onShared(res.postId, res.isNew, res.appended);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
      <div className="bg-surface-overlay border border-gray-800 rounded-lg w-full max-w-lg p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-gray-100">分享到論壇</h2>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-white"
            disabled={busy}
          >
            ✕
          </button>
        </div>

        <div className="text-xs text-gray-500 leading-relaxed">
          原問題會變成貼文標題與內文，AI 回答和後續對話會以留言方式保留。
          再次分享同一段對話只會把新的訊息追加到原貼文（看板/標題/匿名鎖定）。
        </div>

        <div>
          <label className="block text-xs text-gray-400 mb-1.5">看板</label>
          <div className="grid grid-cols-3 gap-1.5">
            {FORUM_CATEGORIES.map((cat) => (
              <button
                key={cat}
                onClick={() => setCategory(cat)}
                className={`px-3 py-1.5 rounded text-sm ${
                  cat === category
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
                }`}
                disabled={busy}
              >
                {cat}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="block text-xs text-gray-400 mb-1.5">
            標題（預設取第一則訊息前 60 字，可改）
          </label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={120}
            disabled={busy}
            className="w-full bg-gray-950 border border-gray-800 rounded px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-blue-500"
          />
        </div>

        <label className="flex items-center gap-2 text-sm text-gray-300">
          <input
            type="checkbox"
            checked={anonymous}
            onChange={(e) => setAnonymous(e.target.checked)}
            disabled={busy}
          />
          匿名分享（用戶顯示為「匿名」，AI 仍以實名出現）
        </label>

        {err && (
          <div className="bg-red-900/40 border border-red-700/50 rounded px-3 py-2 text-sm text-red-200">
            {err}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button
            onClick={onClose}
            disabled={busy}
            className="px-4 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm"
          >
            取消
          </button>
          <button
            onClick={submit}
            disabled={busy}
            className="px-4 py-1.5 rounded bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm"
          >
            {busy ? '分享中…' : '分享'}
          </button>
        </div>
      </div>
    </div>
  );
}
