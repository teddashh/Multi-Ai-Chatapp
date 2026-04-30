import React from 'react';
import type { AIProvider, ChatMode } from '../shared/types';
import { modelAvailableInMode } from '../shared/types';
import { AI_PROVIDERS } from '../shared/constants';
import type { ModelChoices } from '../api';

const PROVIDERS: AIProvider[] = ['chatgpt', 'claude', 'gemini', 'grok'];

interface Props {
  models: Record<AIProvider, ModelChoices>;
  selected: Partial<Record<AIProvider, string>>;
  onSelect: (provider: AIProvider, model: string) => void;
  // Per-model compact cost label rendered after the model name in the
  // dropdown — "$5/$30 /M" for text, "$0.07/img" for image. Server-
  // built (User.priceLabels). Pass empty {} to suppress.
  priceLabels: Record<string, string>;
  // Mode-aware filter: hides codex outside coding, hides o3/o4 outside
  // reasoning. The dropdown only ever offers options that make sense
  // for the active mode.
  mode: ChatMode;
}

export default function ProvidersBar({ models, selected, onSelect, priceLabels, mode }: Props) {
  return (
    <div className="grid grid-cols-4 gap-1 sm:gap-2">
      {PROVIDERS.map((p) => {
        const info = AI_PROVIDERS[p];
        const choices = models[p];
        const filteredOptions = choices.options.filter((m) =>
          modelAvailableInMode(m, mode),
        );
        const sel = selected[p];
        const current =
          sel && filteredOptions.includes(sel)
            ? sel
            : filteredOptions.includes(choices.default)
              ? choices.default
              : (filteredOptions[0] ?? choices.default);
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
              {filteredOptions.map((m) => {
                const price = priceLabels[m];
                return (
                  <option key={m} value={m} className="bg-gray-900 text-gray-200">
                    {price ? `${m}  ${price}` : m}
                  </option>
                );
              })}
            </select>
          </div>
        );
      })}
    </div>
  );
}
