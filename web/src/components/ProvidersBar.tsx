import React from 'react';
import type { AIProvider } from '../shared/types';
import { AI_PROVIDERS } from '../shared/constants';
import type { ModelChoices } from '../api';

const PROVIDERS: AIProvider[] = ['chatgpt', 'claude', 'gemini', 'grok'];

interface Props {
  models: Record<AIProvider, ModelChoices>;
  selected: Partial<Record<AIProvider, string>>;
  onSelect: (provider: AIProvider, model: string) => void;
}

export default function ProvidersBar({ models, selected, onSelect }: Props) {
  return (
    <div className="grid grid-cols-4 gap-1 sm:gap-2">
      {PROVIDERS.map((p) => {
        const info = AI_PROVIDERS[p];
        const choices = models[p];
        const current = selected[p] ?? choices.default;
        return (
          <div
            key={p}
            className="flex items-center gap-1 sm:gap-1.5 px-1.5 sm:px-2 py-1 rounded-lg bg-gray-800 border border-gray-700 min-w-0"
            title={`${info.name} · ${current}`}
          >
            <span
              className="w-2 h-2 rounded-full flex-none"
              style={{ backgroundColor: info.color }}
            />
            <span
              className="hidden sm:inline text-xs font-semibold flex-none"
              style={{ color: info.color }}
            >
              {info.name}
            </span>
            <select
              value={current}
              onChange={(e) => onSelect(p, e.target.value)}
              className="bg-transparent text-[10px] sm:text-[11px] text-gray-300 border-none focus:outline-none truncate min-w-0 flex-1 cursor-pointer hover:text-white"
            >
              {choices.options.map((m) => (
                <option key={m} value={m} className="bg-gray-900 text-gray-200">
                  {m}
                </option>
              ))}
            </select>
          </div>
        );
      })}
    </div>
  );
}
