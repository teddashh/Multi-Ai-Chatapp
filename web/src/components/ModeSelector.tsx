import React from 'react';
import {
  type ChatMode,
  AGENT_MODES,
  COMING_SOON_MODES,
  MULTI_MODES,
  modeGroupOf,
} from '../shared/types';
import { modeDesc, modeName, useT } from '../i18n';

interface Props {
  mode: ChatMode;
  onModeChange: (mode: ChatMode) => void;
}

export default function ModeSelector({ mode, onModeChange }: Props) {
  const t = useT();
  const group = modeGroupOf(mode);

  const handleClick = (m: ChatMode) => {
    if (COMING_SOON_MODES.includes(m)) {
      // Disabled for now; surface a tiny visual nudge instead of changing mode.
      // (alert is intentional — non-blocking, no UI dependency, fine for now.)
      window.alert(`${modeName(t, m)}: ${t.comingSoon}`);
      return;
    }
    onModeChange(m);
  };

  // Pick the right list based on whichever group is currently active.
  const modes = group === 'agent' ? AGENT_MODES : MULTI_MODES;

  // When user switches GROUPS, jump to the first available mode in
  // the new group so we don't leave the user on a stale selection.
  const switchGroup = (newGroup: 'agent' | 'multi') => {
    if (newGroup === group) return;
    const firstAvailable =
      newGroup === 'agent'
        ? AGENT_MODES.find((m) => !COMING_SOON_MODES.includes(m))
        : MULTI_MODES[0];
    if (firstAvailable) onModeChange(firstAvailable);
  };

  return (
    <div className="space-y-1">
      {/* Outer tab row: Multi vs Agent group */}
      <div className="flex gap-1 flex-wrap">
        {(
          [
            ['multi', t.modeGroupMulti],
            ['agent', t.modeGroupAgent],
          ] as Array<['multi' | 'agent', string]>
        ).map(([g, label]) => (
          <button
            key={g}
            onClick={() => switchGroup(g)}
            className={`px-2 sm:px-3 py-1.5 rounded-md text-xs font-semibold transition-colors whitespace-nowrap ${
              group === g
                ? 'bg-purple-600 text-white'
                : 'bg-gray-900 text-gray-500 hover:bg-gray-800 hover:text-gray-300'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Inner row: per-group mode buttons */}
      <div className="flex gap-1 flex-wrap">
        {modes.map((m) => {
          const active = m === mode;
          const name = modeName(t, m);
          const desc = modeDesc(t, m);
          const disabled = COMING_SOON_MODES.includes(m);
          return (
            <button
              key={m}
              onClick={() => handleClick(m)}
              title={`${name} — ${disabled ? t.comingSoon : desc}`}
              className={`px-2 sm:px-3 py-1.5 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
                active
                  ? 'bg-blue-600 text-white'
                  : disabled
                    ? 'bg-gray-900 text-gray-600 italic hover:bg-gray-800'
                    : 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200'
              }`}
            >
              {name}
              {disabled && <span className="ml-1 text-[9px] opacity-70">({t.comingSoon})</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
