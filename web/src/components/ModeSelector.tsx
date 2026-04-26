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
    <div className="flex gap-1 flex-wrap">
      {MODES.map((m) => {
        const info = CHAT_MODES[m];
        const active = m === mode;
        return (
          <button
            key={m}
            onClick={() => onModeChange(m)}
            title={info.description}
            className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
              active
                ? 'bg-blue-600 text-white'
                : 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200'
            }`}
          >
            <span className="mr-1">{info.icon}</span>
            {info.name}
          </button>
        );
      })}
    </div>
  );
}
