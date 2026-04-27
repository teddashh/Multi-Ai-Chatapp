import React from 'react';
import type { AIProvider, ChatMode, ModeRoles } from '../shared/types';
import { AI_PROVIDERS } from '../shared/constants';
import { useT } from '../i18n';
import type { Dict } from '../i18n';

interface Props {
  mode: ChatMode;
  roles: ModeRoles;
  onRolesChange: (roles: ModeRoles) => void;
}

const PROVIDERS: AIProvider[] = ['chatgpt', 'claude', 'gemini', 'grok'];

function labelsFor(t: Dict, mode: ChatMode): Record<string, string> | null {
  switch (mode) {
    case 'debate':
      return {
        pro: t.roleDebatePro,
        con: t.roleDebateCon,
        judge: t.roleDebateJudge,
        summary: t.roleDebateSummary,
      };
    case 'consult':
      return {
        first: t.roleConsultFirst,
        second: t.roleConsultSecond,
        reviewer: t.roleConsultReviewer,
        summary: t.roleConsultSummary,
      };
    case 'coding':
      return {
        planner: t.roleCodingPlanner,
        reviewer: t.roleCodingReviewer,
        coder: t.roleCodingCoder,
        tester: t.roleCodingTester,
      };
    case 'roundtable':
      return {
        first: t.roleRoundtable1,
        second: t.roleRoundtable2,
        third: t.roleRoundtable3,
        fourth: t.roleRoundtable4,
      };
    default:
      return null;
  }
}

export default function RoleConfig({ mode, roles, onRolesChange }: Props) {
  const t = useT();
  const labels = labelsFor(t, mode);
  if (!labels) return null;

  const handleChange = (roleKey: string, provider: AIProvider) => {
    onRolesChange({ ...roles, [roleKey]: provider } as ModeRoles);
  };

  return (
    <div className="mt-2 p-2 bg-gray-800 rounded-lg space-y-2">
      {Object.entries(labels).map(([roleKey, label]) => (
        <div key={roleKey} className="flex items-start gap-2">
          <span className="text-xs text-gray-300 w-16 pt-1 flex-none">{label}</span>
          <div className="grid grid-cols-2 gap-1 flex-1">
            {PROVIDERS.map((p) => {
              const isSelected =
                (roles as unknown as Record<string, AIProvider>)[roleKey] === p;
              const info = AI_PROVIDERS[p];
              return (
                <button
                  key={p}
                  onClick={() => handleChange(roleKey, p)}
                  className={`px-2 py-0.5 rounded text-xs transition-colors text-center ${
                    isSelected ? 'font-bold' : 'text-gray-500 hover:text-gray-300'
                  }`}
                  style={
                    isSelected
                      ? { backgroundColor: info.color + '33', color: info.color }
                      : undefined
                  }
                >
                  {info.name}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
