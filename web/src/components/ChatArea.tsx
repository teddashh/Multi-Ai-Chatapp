import React, { useEffect, useRef, useState } from 'react';
import type { ChatMessage, ChatMode } from '../shared/types';
import { AI_PROVIDERS, CHAT_MODES } from '../shared/constants';
import ProviderAvatar from './ProviderAvatar';

interface Props {
  messages: ChatMessage[];
  mode: ChatMode;
}

const MODE_HOWTO: Record<ChatMode, string[]> = {
  free: [
    '一個問題，4 家 AI 同時回答，並排比對。',
    '適合快速比較不同模型對同一問題的角度與口吻。',
  ],
  debate: [
    '4 步驟接力：正方 → 反方 → 判官 → 總結。',
    '適合決策題：「我該選 A 還 B」「該不該做這件事」。',
  ],
  consult: [
    '兩位 AI 並行先答 → 第三位審查比對 → 第四位綜合總結。',
    '適合深度諮詢：醫療、法律、技術選型 — 降低單一模型偏差。',
  ],
  coding: [
    '8 步雙迴圈：Planner 寫規格 → Reviewer 審 → Coder v1 → Code Review → Tester 出測試 → Coder v2 → 驗收 → 最終版。',
    '適合需要實際可跑代碼的任務，會比一次寫完慢但品質高。',
  ],
  roundtable: [
    '5 輪 × 4 人辯證螺旋：開場 → 質疑 → 攻防 → 收斂 → 真理浮現。',
    '適合開放性議題，給 AI 充分時間互相挑戰、修正、收斂。',
    '⚠️ 這個模式會跑很久（10-30 分鐘）。',
  ],
};

// Roughly: collapse if message has > 3 newlines or > 220 chars (~3 lines wide).
function isLong(text: string): boolean {
  if (text.split('\n').length > 3) return true;
  return text.length > 220;
}

export default function ChatArea({ messages, mode }: Props) {
  const endRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const modeInfo = CHAT_MODES[mode];
  const howto = MODE_HOWTO[mode];

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
              <span className="text-2xl">{modeInfo.icon}</span>
              <h2 className="text-base font-bold text-white">{modeInfo.name}</h2>
            </div>
            <p className="text-xs text-gray-400 mb-3">{modeInfo.description}</p>
            <ul className="text-xs text-gray-300 space-y-2 leading-relaxed">
              {howto.map((line, i) => (
                <li key={i} className="flex gap-2">
                  <span className="text-gray-600 flex-none">•</span>
                  <span>{line}</span>
                </li>
              ))}
            </ul>
            <p className="text-[11px] text-gray-500 mt-4 text-center">
              在下方輸入框開始對話
            </p>
          </div>
        </div>
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
