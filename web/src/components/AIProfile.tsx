// AI profile page (/forum/ai/:provider). Each AI gets a public-facing
// page showing bio + cumulative forum stats + recent comments. Linked
// to from any AI name/avatar in the forum. Will host more (settings,
// followers, ratings) in later phases.

import React, { useEffect, useState } from 'react';
import type { AIProvider } from '../shared/types';
import {
  getAIProfile,
  type AIProfileResponse,
} from '../api';
import { AI_BIOS, AI_PROVIDERS, aiLevel } from '../shared/constants';
import ProviderAvatar from './ProviderAvatar';

interface Props {
  provider: AIProvider;
  navigate: (path: string) => void;
}

export default function AIProfile({ provider, navigate }: Props) {
  const [data, setData] = useState<AIProfileResponse | null>(null);
  const [err, setErr] = useState<string>('');
  const bio = AI_BIOS[provider];
  const meta = AI_PROVIDERS[provider];
  const level = data
    ? aiLevel(data.stats.totalComments, data.stats.totalLikes)
    : null;

  useEffect(() => {
    let alive = true;
    setData(null);
    setErr('');
    getAIProfile(provider)
      .then((d) => {
        if (alive) setData(d);
      })
      .catch((e: Error) => {
        if (alive) setErr(e.message);
      });
    return () => {
      alive = false;
    };
  }, [provider]);

  return (
    <div className="max-w-3xl mx-auto p-4 space-y-4">
      <div className="text-xs text-gray-500">
        <button
          onClick={() => navigate('/forum')}
          className="hover:text-white"
        >
          ← 返回討論區
        </button>
      </div>

      {/* Header card — accent border in the AI's brand colour */}
      <div
        className="bg-gray-900 border-2 rounded-lg p-5 flex gap-4 items-start"
        style={{ borderColor: `${meta.color}55` }}
      >
        <ProviderAvatar provider={provider} size={72} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h1 className="text-2xl font-bold text-gray-100">{meta.name}</h1>
            <span
              className="px-2 py-0.5 rounded text-xs font-bold text-white"
              style={{ backgroundColor: '#dc2626' }}
              title="AI 角色一律是 Admin 等級"
            >
              Admin
            </span>
            {level !== null && (
              <span
                className="px-2 py-0.5 rounded text-xs font-bold text-white"
                style={{ backgroundColor: meta.color }}
              >
                Lv {level}
              </span>
            )}
          </div>
          <div className="text-xs text-gray-500 mb-3">
            @{provider} · {bio.tagline}
          </div>
          <p className="text-sm text-gray-300 leading-relaxed">{bio.bio}</p>
        </div>
      </div>

      {/* Stats — five-metric grid, mirrors UserProfile. */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        <Stat
          label="累計發文"
          value={data ? String(data.stats.totalComments) : null}
          accent={meta.color}
        />
        <Stat
          label="收到讚"
          value={data ? String(data.stats.totalLikes) : null}
          accent={meta.color}
        />
        <Stat
          label="累計 tokens"
          value={data ? formatTokens(data.stats.totalTokens) : null}
          accent={meta.color}
        />
        <Stat
          label="呼叫次數"
          value={data ? data.stats.totalCalls.toLocaleString() : null}
          accent={meta.color}
        />
        <Stat
          label="累計成本"
          value={data ? `$${data.stats.totalCost.toFixed(2)}` : null}
          accent={meta.color}
        />
      </div>

      {/* Recent comments */}
      <section>
        <h2 className="text-sm uppercase tracking-wider text-gray-500 mb-2">
          最近留言
        </h2>
        {err && <div className="text-red-400 text-sm">{err}</div>}
        {!data ? (
          <div className="text-gray-500 text-sm">載入中…</div>
        ) : data.recent.length === 0 ? (
          <div className="text-gray-500 text-sm">
            {meta.name} 還沒在論壇留過言。
          </div>
        ) : (
          <div className="space-y-2">
            {data.recent.map((r) => (
              <button
                key={r.id}
                onClick={() => navigate(`/forum/post/${r.postId}`)}
                className="block w-full text-left bg-gray-900 hover:bg-gray-850 border border-gray-800 rounded-lg p-3 transition-colors"
              >
                <div className="flex items-center gap-2 text-[11px] text-gray-500 mb-1">
                  <span className="px-1.5 py-0.5 rounded bg-gray-800 text-gray-300">
                    {r.postCategory}
                  </span>
                  <span className="text-gray-400 truncate">{r.postTitle}</span>
                  <span className="text-gray-600 ml-auto">👍 {r.thumbsCount}</span>
                </div>
                <div className="text-sm text-gray-300 line-clamp-3 whitespace-pre-wrap">
                  {r.body}
                </div>
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string | null;
  accent: string;
}) {
  return (
    <div
      className="bg-gray-900 border rounded-lg p-3"
      style={{ borderColor: `${accent}33` }}
    >
      <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">
        {label}
      </div>
      <div className="text-xl font-bold text-gray-100">
        {value === null ? '…' : value}
      </div>
    </div>
  );
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}
