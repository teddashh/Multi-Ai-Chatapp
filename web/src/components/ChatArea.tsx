import React, { useEffect, useRef } from 'react';
import type { ChatMessage } from '../shared/types';
import { AI_PROVIDERS } from '../shared/constants';

interface Props {
  messages: ChatMessage[];
}

export default function ChatArea({ messages }: Props) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages]);

  return (
    <div className="flex-1 overflow-y-auto p-3 space-y-3">
      {messages.length === 0 ? (
        <div className="text-center text-gray-500 text-sm pt-12">
          開始對話吧
        </div>
      ) : (
        messages.map((msg) => {
          if (msg.role === 'user') {
            return (
              <div
                key={msg.id}
                className="bg-blue-600/20 border border-blue-700/40 rounded-lg p-3 text-sm whitespace-pre-wrap"
              >
                <div className="text-xs font-semibold text-blue-300 mb-1">👤 你</div>
                {msg.content}
              </div>
            );
          }
          const info = msg.provider ? AI_PROVIDERS[msg.provider] : undefined;
          const name = info?.name ?? msg.provider ?? 'AI';
          const color = info?.color ?? '#9ca3af';
          return (
            <div
              key={msg.id}
              className="bg-gray-800 border border-gray-700 rounded-lg p-3 text-sm whitespace-pre-wrap"
            >
              <div className="text-xs font-semibold mb-1" style={{ color }}>
                🤖 {name}
                {msg.modeRole ? ` (${msg.modeRole})` : ''}
              </div>
              {msg.content}
            </div>
          );
        })
      )}
      <div ref={endRef} />
    </div>
  );
}
