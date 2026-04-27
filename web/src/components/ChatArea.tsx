import React, { useEffect, useRef, useState } from 'react';
import type { ChatMessage, ChatMode } from '../shared/types';
import { AI_PROVIDERS, MODE_ICONS } from '../shared/constants';
import ProviderAvatar from './ProviderAvatar';
import { modeDesc, modeHowto, modeName, useT } from '../i18n';

interface Props {
  messages: ChatMessage[];
  mode: ChatMode;
  onRegenerate?: (messageId: string) => void;
  regeneratingId?: string | null;
}

// Roughly: collapse if message has > 3 newlines or > 220 chars (~3 lines wide).
function isLong(text: string): boolean {
  if (text.split('\n').length > 3) return true;
  return text.length > 220;
}

export default function ChatArea({
  messages,
  mode,
  onRegenerate,
  regeneratingId,
}: Props) {
  const t = useT();
  const isSequential = mode !== 'free';
  const retryLabel = isSequential ? t.retrySeqIdle : t.retryFreeIdle;
  const retryBusyLabel = isSequential ? t.retrySeqBusy : t.retryFreeBusy;
  const retryTitle = isSequential ? t.retrySeqTitle : t.retryFreeTitle;
  const endRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages]);

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="flex-1 overflow-y-auto p-3 space-y-3">
      {messages.length === 0 ? (
        <div className="max-w-md mx-auto pt-12 px-4">
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-5">
            <div className="flex items-center gap-2 mb-3">
              <span className="text-2xl">{MODE_ICONS[mode]}</span>
              <h2 className="text-base font-bold text-white">
                {modeName(t, mode)}
              </h2>
            </div>
            <p className="text-xs text-gray-400 mb-3">{modeDesc(t, mode)}</p>
            <ul className="text-xs text-gray-300 space-y-2 leading-relaxed">
              {modeHowto(t, mode).map((line, i) => (
                <li key={i} className="flex gap-2">
                  <span className="text-gray-600 flex-none">•</span>
                  <span>{line}</span>
                </li>
              ))}
            </ul>
            <p className="text-[11px] text-gray-500 mt-4 text-center">
              {t.chatStartHere}
            </p>
          </div>
        </div>
      ) : (
        messages.map((msg) => {
          if (msg.role === 'user') {
            return (
              <div key={msg.id} className="flex justify-end">
                <div className="bg-blue-600/20 border border-blue-700/40 rounded-lg p-3 text-sm whitespace-pre-wrap max-w-[85%]">
                  {msg.content && <div>{msg.content}</div>}
                  {msg.attachments && msg.attachments.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {msg.attachments.map((a) => {
                        if (a.kind === 'image') {
                          return (
                            <a
                              key={a.id}
                              href={`/api/sessions/attachments/${a.id}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              title={a.filename}
                            >
                              <img
                                src={`/api/sessions/attachments/${a.id}`}
                                alt={a.filename}
                                className="max-h-32 max-w-[160px] rounded object-cover border border-blue-800/40"
                              />
                            </a>
                          );
                        }
                        return (
                          <a
                            key={a.id}
                            href={`/api/sessions/attachments/${a.id}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-1.5 bg-blue-900/30 border border-blue-800/40 rounded px-2 py-1 text-xs hover:bg-blue-900/50"
                            title={a.filename}
                          >
                            <span>
                              {a.kind === 'pdf' ? '📕' : a.kind === 'text' ? '📝' : '📎'}
                            </span>
                            <span className="max-w-[140px] truncate">{a.filename}</span>
                          </a>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            );
          }
          const info = msg.provider ? AI_PROVIDERS[msg.provider] : undefined;
          const name = info?.name ?? msg.provider ?? 'AI';
          const color = info?.color ?? '#9ca3af';
          const open = expanded.has(msg.id);
          const long = isLong(msg.content);
          const showCollapse = long && !open;

          return (
            <div key={msg.id} className="flex gap-2 items-start">
              {msg.provider ? (
                <ProviderAvatar provider={msg.provider} size={36} />
              ) : (
                <div className="w-9 h-9 rounded-full bg-gray-700 flex items-center justify-center text-xs flex-none">
                  ⚠
                </div>
              )}
              <div className="flex-1 min-w-0 bg-gray-800 border border-gray-700 rounded-lg p-3 text-sm">
                <div
                  className="text-xs font-semibold mb-1.5"
                  style={{ color }}
                >
                  {name}
                  {msg.modeRole ? (
                    <span className="ml-1 text-gray-500 font-normal">
                      ({msg.modeRole})
                    </span>
                  ) : null}
                </div>
                <div
                  className={`whitespace-pre-wrap ${
                    showCollapse ? 'line-clamp-3' : ''
                  }`}
                >
                  {msg.content}
                </div>
                <div className="flex items-center gap-3 mt-1.5">
                  {long && (
                    <button
                      onClick={() => toggle(msg.id)}
                      className="text-xs text-gray-500 hover:text-white inline-flex items-center gap-1"
                    >
                      {open ? t.chatCollapse : t.chatExpand}
                    </button>
                  )}
                  {onRegenerate &&
                    msg.provider &&
                    !msg.id.endsWith('-streaming') &&
                    /^\d+$/.test(msg.id) && (
                      <button
                        onClick={() => onRegenerate(msg.id)}
                        disabled={regeneratingId !== null}
                        className="text-xs text-gray-500 hover:text-white inline-flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed"
                        title={retryTitle}
                      >
                        {regeneratingId === msg.id ? retryBusyLabel : retryLabel}
                      </button>
                    )}
                </div>
              </div>
            </div>
          );
        })
      )}
      <div ref={endRef} />
    </div>
  );
}
