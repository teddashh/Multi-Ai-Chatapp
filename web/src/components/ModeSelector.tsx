import React from 'react';
import type { ChatMode } from '../shared/types';
import { CHAT_MODES } from '../shared/constants';

interface Props {
  mode: ChatMode;
  onModeChange: (mode: ChatMode) => void;
}

const MODES: ChatMode[] = ['free', 'debate', 'consult', 'coding', 'roundtable'];

export default function ModeSelector({ mode, onModeChange }: Props) {
  return (
    <div className="flex gap-1">
      {MODES.map((m) => {
        const info = CHAT_MODES[m];
        const active = m === mode;
        return (
          <button
            key={m}
            onClick={() => onModeChange(m)}
            title={`${info.name} — ${info.description}`}
            className={`flex-1 sm:flex-none px-2 sm:px-3 py-1.5 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
              active
                ? 'bg-blue-600 text-white'
                : 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200'
            }`}
          >
            <span className="sm:mr-1">{info.icon}</span>
            <span className="hidden sm:inline">{info.name}</span>
          </button>
        );
      })}
    </div>
  );
}
