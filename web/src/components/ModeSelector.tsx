import React from 'react';
import type { ChatMode } from '../shared/types';
import { modeDesc, modeName, useT } from '../i18n';

interface Props {
  mode: ChatMode;
  onModeChange: (mode: ChatMode) => void;
}

const MODES: ChatMode[] = ['free', 'debate', 'consult', 'coding', 'roundtable'];

export default function ModeSelector({ mode, onModeChange }: Props) {
  const t = useT();
  return (
    <div className="flex gap-1 flex-wrap">
      {MODES.map((m) => {
        const active = m === mode;
        const name = modeName(t, m);
        const desc = modeDesc(t, m);
        return (
          <button
            key={m}
            onClick={() => onModeChange(m)}
            title={`${name} — ${desc}`}
            className={`px-2 sm:px-3 py-1.5 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
              active
                ? 'bg-blue-600 text-white'
                : 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200'
            }`}
          >
            {name}
          </button>
        );
      })}
    </div>
  );
}
