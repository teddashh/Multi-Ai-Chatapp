// User profile page (/forum/user/:username). Mirrors AIProfile shape:
// big avatar + name + member-since, cumulative forum stats, and a
// recent-activity feed (posts + comments interleaved by time).
//
// Anonymous-flagged contributions are server-filtered from the recent
// feed but still counted in stats — the user posted them anonymously,
// so listing them on a public profile would defeat the point.

import React, { useEffect, useState } from 'react';
import {
  avatarUrl,
  getUserProfile,
  type UserProfileResponse,
} from '../api';
import {
  aiLevel,
  daysUntilBirthday,
  signLabel,
} from '../shared/constants';

interface Props {
  username: string;
  navigate: (path: string) => void;
}

export default function UserProfile({ username, navigate }: Props) {
  const [data, setData] = useState<UserProfileResponse | null>(null);
  const [err, setErr] = useState<string>('');

  useEffect(() => {
    let alive = true;
    setData(null);
    setErr('');
    getUserProfile(username)
      .then((d) => {
        if (alive) setData(d);
      })
      .catch((e: Error) => {
        if (alive) setErr(e.message);
      });
    return () => {
      alive = false;
    };
  }, [username]);

  if (err) return <div className="p-4 text-red-400 text-sm">{err}</div>;
  if (!data) return <div className="p-4 text-gray-500 text-sm">載入中…</div>;

  const displayName = data.nickname || data.username;

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

      {/* Header card */}
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-5 flex gap-4 items-start">
        {data.hasAvatar ? (
          <img
            src={avatarUrl(data.username, 0)}
            alt={displayName}
            className="w-[72px] h-[72px] rounded-full object-cover border border-gray-700 flex-none"
          />
        ) : (
          <div
            className="rounded-full bg-gray-700 flex items-center justify-center text-gray-200 font-bold flex-none"
            style={{ width: 72, height: 72, fontSize: 28 }}
          >
            {displayName.slice(0, 1).toUpperCase()}
          </div>
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <h1 className="text-2xl font-bold text-gray-100">{displayName}</h1>
            <TierBadge tier={data.tier} />
            <span
              className="px-2 py-0.5 rounded text-xs font-bold text-white"
              style={{ backgroundColor: '#475569' }}
            >
              Lv{' '}
              {aiLevel(
                data.stats.totalPosts + data.stats.totalComments,
                data.stats.totalLikes,
              )}
            </span>
          </div>
          <div className="text-xs text-gray-500 mb-3">
            @{data.username} · {memberSinceLabel(data.memberSince)}
          </div>
          <p className="text-sm text-gray-300 leading-relaxed whitespace-pre-wrap">
            {data.bio?.trim()
              ? data.bio
              : '這位用戶還沒寫個人介紹。'}
          </p>
        </div>
      </div>

      {/* Astro / MBTI section — only renders the rows the user has
          chosen to expose. Birthday banner appears when within 7 days
          and the user has the date public. */}
      <AstroSection
        birthAt={data.birthAt}
        birthTz={data.birthTz}
        sunSign={data.sunSign}
        moonSign={data.moonSign}
        risingSign={data.risingSign}
        mbti={data.mbti}
      />

      {/* Stats — five metrics matching AIProfile. Posts + comments are
          collapsed into one "累計發文" since both are public posts. */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        <Stat
          label="累計發文"
          value={String(data.stats.totalPosts + data.stats.totalComments)}
        />
        <Stat label="收到讚" value={String(data.stats.totalLikes)} />
        <Stat
          label="累計 tokens"
          value={formatTokens(data.stats.totalTokens)}
        />
        <Stat
          label="呼叫次數"
          value={data.stats.totalCalls.toLocaleString()}
        />
        <Stat label="累計成本" value={`$${data.stats.totalCost.toFixed(2)}`} />
      </div>

      {/* Recent posts */}
      {data.recentPosts.length > 0 && (
        <section>
          <h2 className="text-sm uppercase tracking-wider text-gray-500 mb-2">
            最近發文
          </h2>
          <div className="space-y-2">
            {data.recentPosts.map((p) => (
              <button
                key={p.id}
                onClick={() => navigate(`/forum/post/${p.id}`)}
                className="block w-full text-left bg-gray-900 hover:bg-gray-850 border border-gray-800 rounded-lg p-3 transition-colors"
              >
                <div className="flex items-center gap-2 text-[11px] text-gray-500 mb-1">
                  <span className="px-1.5 py-0.5 rounded bg-gray-800 text-gray-300">
                    {p.category}
                  </span>
                  <span className="text-gray-400">{relTime(p.createdAt)}</span>
                  <span className="text-gray-600 ml-auto">
                    👍 {p.thumbsCount} · 💬 {p.commentCount}
                  </span>
                </div>
                <div className="text-sm font-semibold text-gray-100 mb-1">
                  {p.title}
                </div>
                <div className="text-xs text-gray-400 line-clamp-2">
                  {p.bodyPreview}
                </div>
              </button>
            ))}
          </div>
        </section>
      )}

      {/* Recent comments */}
      {data.recentComments.length > 0 && (
        <section>
          <h2 className="text-sm uppercase tracking-wider text-gray-500 mb-2">
            最近留言
          </h2>
          <div className="space-y-2">
            {data.recentComments.map((cm) => (
              <button
                key={cm.id}
                onClick={() => navigate(`/forum/post/${cm.postId}`)}
                className="block w-full text-left bg-gray-900 hover:bg-gray-850 border border-gray-800 rounded-lg p-3 transition-colors"
              >
                <div className="flex items-center gap-2 text-[11px] text-gray-500 mb-1">
                  <span className="px-1.5 py-0.5 rounded bg-gray-800 text-gray-300">
                    {cm.postCategory}
                  </span>
                  <span className="text-gray-400 truncate">{cm.postTitle}</span>
                  <span className="text-gray-600 ml-auto">
                    👍 {cm.thumbsCount}
                  </span>
                </div>
                <div className="text-sm text-gray-300 line-clamp-3 whitespace-pre-wrap">
                  {cm.body}
                </div>
              </button>
            ))}
          </div>
        </section>
      )}

      {data.recentPosts.length === 0 && data.recentComments.length === 0 && (
        <div className="text-gray-500 text-sm text-center py-8">
          {displayName} 還沒有公開的論壇活動。
        </div>
      )}
    </div>
  );
}

// Renders the astrology + MBTI block plus a birthday banner when the
// next birthday is within a week. Any of the props can be null/undefined
// — empty rows are simply omitted, and the whole section collapses if
// nothing is exposed.
export function AstroSection({
  birthAt,
  birthTz,
  sunSign,
  moonSign,
  risingSign,
  mbti,
  archetype,
  archetypeNote,
}: {
  birthAt: number | null;
  birthTz: string | null;
  sunSign: string | null;
  moonSign: string | null;
  risingSign: string | null;
  mbti: string | null;
  archetype?: string | null;
  archetypeNote?: string | null;
}) {
  const hasBirth = !!birthAt && !!birthTz;
  const hasSigns = !!(sunSign || moonSign || risingSign);
  if (!hasBirth && !hasSigns && !mbti && !archetype) return null;

  // Year and time are intentionally never displayed publicly. Birthday
  // is rendered as month + day only.
  const birthLabel = hasBirth ? formatBirth(birthAt!, birthTz!) : null;
  const days = hasBirth ? daysUntilBirthday(birthAt, birthTz) : null;
  const banner =
    days === 0
      ? '🎂 生日是今天！'
      : days !== null && days <= 7
        ? `🎂 生日快到了！（再 ${days} 天）`
        : null;

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 space-y-3">
      {banner && (
        <div className="px-3 py-2 rounded bg-amber-900/30 border border-amber-700/40 text-amber-200 text-sm font-semibold">
          {banner}
        </div>
      )}
      {archetype && (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-0.5">
            核心靈魂定位
          </div>
          <div className="text-base font-bold text-amber-200">
            {archetype}
            {archetypeNote && (
              <span className="text-xs text-gray-400 font-normal ml-2">
                （{archetypeNote}）
              </span>
            )}
          </div>
        </div>
      )}
      {/* MBTI sits in the same row as birth + signs to keep the
          section to one line on desktop (5 columns). On narrow
          screens it wraps gracefully via auto-flow. */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-xs">
        {birthLabel && <Field label="出生" value={birthLabel} />}
        {sunSign && <Field label="☀ 太陽" value={signLabel(sunSign)} />}
        {moonSign && <Field label="🌙 月亮" value={signLabel(moonSign)} />}
        {risingSign && (
          <Field label="↗ 上升" value={signLabel(risingSign)} />
        )}
        {mbti && <Field label="MBTI" value={mbti} />}
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-0.5">
        {label}
      </div>
      <div className="text-sm font-semibold text-gray-100">{value}</div>
    </div>
  );
}

// Birthday display is intentionally month + day only — year and time
// are private regardless of any flag the API may still expose.
function formatBirth(epochSec: number, tz: string): string {
  try {
    return new Intl.DateTimeFormat('zh-TW', {
      timeZone: tz,
      month: 'long',
      day: 'numeric',
    }).format(new Date(epochSec * 1000));
  } catch {
    return '';
  }
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-3 text-center">
      <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">
        {label}
      </div>
      <div className="text-xl font-bold text-gray-100">{value}</div>
    </div>
  );
}

const TIER_BADGES: Record<string, { label: string; bg: string }> = {
  free: { label: 'Free', bg: '#6b7280' },
  standard: { label: 'Standard', bg: '#4b5563' },
  pro: { label: 'Pro', bg: '#2563eb' },
  super: { label: 'Super', bg: '#f59e0b' },
  admin: { label: 'Admin', bg: '#dc2626' },
};
function TierBadge({ tier }: { tier: string }) {
  const t = TIER_BADGES[tier] ?? TIER_BADGES.free;
  return (
    <span
      className="px-2 py-0.5 rounded text-xs font-bold text-white whitespace-nowrap"
      style={{ backgroundColor: t.bg }}
    >
      {t.label}
    </span>
  );
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function memberSinceLabel(ms: number): string {
  const days = Math.floor((Date.now() - ms) / 86400000);
  if (days < 30) return `加入 ${days} 天`;
  if (days < 365) return `加入 ${Math.floor(days / 30)} 個月`;
  return `加入 ${Math.floor(days / 365)} 年`;
}

function relTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return '剛剛';
  const m = Math.floor(diff / 60_000);
  if (m < 60) return `${m} 分鐘前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小時前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  const date = new Date(ms);
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}
