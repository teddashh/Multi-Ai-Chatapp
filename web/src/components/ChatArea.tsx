import React, { useEffect, useRef, useState } from 'react';
import type { ChatMessage } from '../shared/types';
import { AI_PROVIDERS } from '../shared/constants';
import ProviderAvatar from './ProviderAvatar';

interface Props {
  messages: ChatMessage[];
}

// Roughly: collapse if message has > 3 newlines or > 220 chars (~3 lines wide).
function isLong(text: string): boolean {
  if (text.split('\n').length > 3) return true;
  return text.length > 220;
}

export default function ChatArea({ messages }: Props) {
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
        <div className="text-center text-gray-500 text-sm pt-12">開始對話吧</div>
      ) : (
        messages.map((msg) => {
          if (msg.role === 'user') {
            return (
              <div
                key={msg.id}
                className="flex justify-end"
              >
                <div className="bg-blue-600/20 border border-blue-700/40 rounded-lg p-3 text-sm whitespace-pre-wrap max-w-[85%]">
                  {msg.content}
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
                {long && (
                  <button
                    onClick={() => toggle(msg.id)}
                    className="mt-1.5 text-xs text-gray-500 hover:text-white inline-flex items-center gap-1"
                  >
                    {open ? '▲ 收起' : '▼ 展開'}
                  </button>
                )}
              </div>
            </div>
          );
        })
      )}
      <div ref={endRef} />
    </div>
  );
}
