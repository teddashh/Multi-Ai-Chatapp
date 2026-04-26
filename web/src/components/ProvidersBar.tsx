import React from 'react';
import type { AIProvider } from '../shared/types';
import { AI_PROVIDERS } from '../shared/constants';

const PROVIDERS: AIProvider[] = ['chatgpt', 'claude', 'gemini', 'grok'];

export default function ProvidersBar() {
  return (
    <div className="grid grid-cols-2 gap-2">
      {PROVIDERS.map((p) => {
        const info = AI_PROVIDERS[p];
        return (
          <div
            key={p}
            className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-xs font-medium bg-gray-800 border border-gray-700"
          >
            <span
              className="w-2 h-2 rounded-full"
              style={{ backgroundColor: info.color }}
            />
            <span style={{ color: info.color }}>{info.name}</span>
          </div>
        );
      })}
    </div>
  );
}
