import React, { useEffect, useRef, useState } from 'react';
import {
  avatarUrl,
  deleteAvatar,
  disableMyAccount,
  getMyUsage,
  purgeAccount,
  rollPersona,
  updateProfile,
  uploadAvatar,
  type MyUsage,
  type ThemeId,
  type User,
} from '../api';
import { composePersona } from '../shared/personaMatrix';
import { useI18n } from '../i18n';
import type { Dict, Lang } from '../i18n';
import {
  COMMON_TIMEZONES,
  MBTI_TYPES,
  SIGN_KEYS,
  SIGN_ZH,
  SIGN_GLYPH,
  sunSignFromMonthDay,
} from '../shared/constants';

interface Props {
  isOpen: boolean;
  user: User;
  onClose: () => void;
  onUpdate: (user: User) => void;
  // Caller's "go to public profile" handler — typically closes the
  // modal and navigates to /forum/user/<username>. Optional so the
  // button silently disappears if the caller didn't wire it up.
  onViewProfile?: () => void;
  // Called after the caller's account has been hard-deleted server-side.
  // Caller is responsible for clearing user state and navigating to a
  // public route (typically /).
  onPurged?: () => void;
}

// Bilingual strings for the Danger Zone are kept inline since they're
// only rendered here. If we add another destructive action later we can
// promote them into i18n.ts.
const DANGER_DICT = {
  'zh-TW': {
    sectionTitle: '危險區（Danger Zone）',
    sectionDesc:
      '兩個操作：「停用帳號」會把你登出並隱藏帳號，但資料保留；「永久刪除」會清除所有對話、貼文、推噓、附件等，無法復原。',
    moreInfo: '查看完整刪除說明',
    expandBtn: '展開危險操作',
    collapseBtn: '收合',
    disableTitle: '停用帳號',
    disableDesc:
      '把帳號標為已停用、登出。資料保留但下次無法登入，需聯絡 hello@ai-sister.com 重新啟用。',
    disableBtn: '停用帳號…',
    disableConfirmWarning:
      '確定要停用帳號嗎？登出後將無法自行重新啟用。',
    disablingBtn: '停用中…',
    disableConfirmBtn: '確認停用',
    deleteTitle: '永久刪除帳號',
    deleteBtn: '永久刪除帳號…',
    confirmWarning:
      '這個操作無法復原。一旦點下「確認刪除」，你的帳號與所有資料會立刻永久消失。',
    typeUsernameLabel: (u: string) => `為了確認，請輸入你的使用者名稱「${u}」`,
    typePasswordLabel: '輸入密碼',
    cancelBtn: '取消',
    confirmBtn: '確認刪除',
    deletingBtn: '刪除中…',
  },
  en: {
    sectionTitle: 'Danger Zone',
    sectionDesc:
      'Two options. "Disable" signs you out and hides the account but keeps your data. "Permanently delete" wipes every chat, post, vote, and attachment — irreversible.',
    moreInfo: 'See full deletion details',
    expandBtn: 'Show destructive actions',
    collapseBtn: 'Hide',
    disableTitle: 'Disable account',
    disableDesc:
      'Marks the account as disabled and signs you out. Data is preserved but you cannot log in again — contact hello@ai-sister.com to re-enable.',
    disableBtn: 'Disable account…',
    disableConfirmWarning:
      'Disable this account? Once signed out you cannot re-enable it yourself.',
    disablingBtn: 'Disabling…',
    disableConfirmBtn: 'Confirm disable',
    deleteTitle: 'Permanently delete account',
    deleteBtn: 'Permanently delete account…',
    confirmWarning:
      'This cannot be undone. Once you click "Confirm delete", your account and all data are gone immediately.',
    typeUsernameLabel: (u: string) => `To confirm, type your username "${u}"`,
    typePasswordLabel: 'Enter your password',
    cancelBtn: 'Cancel',
    confirmBtn: 'Confirm delete',
    deletingBtn: 'Deleting…',
  },
} as const;

// Convert UTC unix seconds + IANA tz → "YYYY-MM-DD" + "HH:mm" in that tz.
// Used to populate the date/time inputs from the stored birthAt.
function utcEpochToLocalParts(
  epochSec: number,
  tz: string,
): { date: string; time: string } {
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const parts = fmt.formatToParts(new Date(epochSec * 1000));
    const got: Record<string, string> = {};
    for (const p of parts) got[p.type] = p.value;
    const hh = got.hour === '24' ? '00' : got.hour ?? '00';
    return {
      date: `${got.year ?? '2000'}-${got.month ?? '01'}-${got.day ?? '01'}`,
      time: `${hh}:${got.minute ?? '00'}`,
    };
  } catch {
    return { date: '', time: '' };
  }
}

// Convert local "YYYY-MM-DD" + "HH:mm" interpreted in tz → UTC seconds.
// Trick: format the provisional UTC instant in the target tz, then
// subtract the difference to get the actual UTC moment.
function localPartsToUtcEpoch(
  date: string,
  time: string,
  tz: string,
): number | null {
  const [y, mo, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  if (!y || !mo || !d) return null;
  const provisional = Date.UTC(y, mo - 1, d, hh || 0, mm || 0);
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const parts = fmt.formatToParts(new Date(provisional));
    const got: Record<string, number> = {};
    for (const p of parts) {
      if (
        p.type === 'year' ||
        p.type === 'month' ||
        p.type === 'day' ||
        p.type === 'hour' ||
        p.type === 'minute'
      ) {
        got[p.type] = parseInt(p.value === '24' ? '00' : p.value, 10);
      }
    }
    const tzAsUtc = Date.UTC(
      got.year,
      got.month - 1,
      got.day,
      got.hour,
      got.minute,
    );
    const offsetMs = tzAsUtc - provisional;
    return Math.floor((provisional - offsetMs) / 1000);
  } catch {
    return Math.floor(provisional / 1000);
  }
}

const MAX_AVATAR_MB = 4;
const SUPPORTED_TYPES = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif'];

// Persona-dice block — preview of the rolled archetype + a 🎲 button.
// Sits inside the astrology section after the visibility toggles.
function PersonaDice({
  user,
  onUpdate,
}: {
  user: User;
  onUpdate: (u: User) => void;
}) {
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState('');

  // Server gates rolling on the *saved* state, not the form state, so
  // the button checks user.* (not the local birthDate / birthTime / etc).
  // Reading /me returns nullable strings; an empty signs array means
  // "no roll yet" rather than "ready".
  const ready =
    !!user.sunSign && !!user.moonSign && !!user.risingSign && !!user.mbti;

  const persona =
    user.personaSeed != null
      ? composePersona({
          sun: user.sunSign,
          moon: user.moonSign,
          rising: user.risingSign,
          mbti: user.mbti,
          seed: user.personaSeed,
        })
      : null;

  const handleRoll = async () => {
    setBusy(true);
    setErr('');
    try {
      const updated = await rollPersona();
      onUpdate(updated);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-2 p-2 rounded bg-gray-800 border border-gray-700">
      <div className="flex items-center justify-between gap-2 mb-1">
        <span className="text-xs text-gray-400 font-semibold">
          核心靈魂定位
        </span>
        <button
          onClick={handleRoll}
          disabled={!ready || busy}
          title={
            !ready
              ? '填完你的完整出生資訊，以及 MBTI，將可以按骰子算出你的完整核心靈魂定位'
              : '骰一次（會記為一次 LLM 呼叫成本）'
          }
          className="text-xl leading-none disabled:opacity-25 disabled:cursor-not-allowed hover:scale-110 transition"
        >
          🎲
        </button>
      </div>
      {persona ? (
        <div>
          <div className="text-sm font-bold text-amber-200">
            {persona.archetype}
          </div>
          <div className="text-[11px] text-gray-400 leading-relaxed">
            （{persona.archetypeNote}）
          </div>
        </div>
      ) : (
        <div className="text-[11px] text-gray-500 italic leading-relaxed">
          {ready
            ? '按骰子算出你的完整核心靈魂定位'
            : '填完你的完整出生資訊，以及 MBTI，將可以按骰子算出你的完整核心靈魂定位'}
        </div>
      )}
      {err && (
        <div className="text-[11px] text-red-300 mt-1">{err}</div>
      )}
    </div>
  );
}

// Star-sign dropdown — empty value clears the field.
function SignSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full px-2 py-1 bg-gray-800 border border-gray-700 rounded text-xs"
    >
      <option value="">— 不設定 —</option>
      {SIGN_KEYS.map((k) => (
        <option key={k} value={k}>
          {SIGN_GLYPH[k]} {SIGN_ZH[k]}
        </option>
      ))}
    </select>
  );
}

function ToggleRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}

const THEMES: Array<{ id: ThemeId; swatch: string; nameKey: keyof Dict }> = [
  // Seasonal first (chronological), then per-AI accents.
  { id: 'spring', swatch: '#ec4899', nameKey: 'themeSpring' },
  { id: 'summer', swatch: '#fb923c', nameKey: 'themeSummer' },
  { id: 'fall', swatch: '#ea580c', nameKey: 'themeFall' },
  { id: 'winter', swatch: '#1e3a8a', nameKey: 'themeWinter' },
  { id: 'claude', swatch: '#d97706', nameKey: 'themeClaude' },
  { id: 'gemini', swatch: '#4285f4', nameKey: 'themeGemini' },
  { id: 'grok', swatch: '#e11d48', nameKey: 'themeGrok' },
  { id: 'chatgpt', swatch: '#10a37f', nameKey: 'themeChatGPT' },
];

export default function ProfileModal({
  isOpen,
  user,
  onClose,
  onUpdate,
  onViewProfile,
  onPurged,
}: Props) {
  const { t, setLang, lang: currentLang } = useI18n();
  const dz = DANGER_DICT[currentLang];
  // Danger Zone is collapsed by default so the destructive buttons
  // can't be hit by accident while the user is reaching for the Save
  // button just above.
  const [dangerExpanded, setDangerExpanded] = useState(false);
  const [showPurgeConfirm, setShowPurgeConfirm] = useState(false);
  const [purgeUsername, setPurgeUsername] = useState('');
  const [purgePassword, setPurgePassword] = useState('');
  const [purging, setPurging] = useState(false);
  const [purgeErr, setPurgeErr] = useState('');
  const [showDisableConfirm, setShowDisableConfirm] = useState(false);
  const [disablePassword, setDisablePassword] = useState('');
  const [disabling, setDisabling] = useState(false);
  const [disableErr, setDisableErr] = useState('');
  const handleDisable = async () => {
    setDisableErr('');
    if (!disablePassword) {
      setDisableErr(dz.typePasswordLabel);
      return;
    }
    setDisabling(true);
    try {
      await disableMyAccount({ password: disablePassword });
      // Server cleared the cookie; mirror the same client-side cleanup
      // as logout via onPurged (closes modal, resets user state, sends
      // them to landing). disable !== purge data-wise but both result
      // in the user being signed out, so the navigation is identical.
      onPurged?.();
    } catch (e) {
      setDisableErr((e as Error).message);
    } finally {
      setDisabling(false);
    }
  };
  const handlePurge = async () => {
    setPurgeErr('');
    if (purgeUsername !== user.username) {
      setPurgeErr(dz.typeUsernameLabel(user.username));
      return;
    }
    if (!purgePassword) {
      setPurgeErr(dz.typePasswordLabel);
      return;
    }
    setPurging(true);
    try {
      await purgeAccount({
        password: purgePassword,
        confirmUsername: purgeUsername,
      });
      // Server has cleared the cookie + deleted everything; tell the
      // caller so it can clear React state and navigate away.
      onPurged?.();
    } catch (e) {
      setPurgeErr((e as Error).message);
    } finally {
      setPurging(false);
    }
  };
  const [nickname, setNickname] = useState(user.nickname || '');
  const [bio, setBio] = useState(user.bio || '');
  const [password, setPassword] = useState('');
  const [lang, setLocalLang] = useState<Lang>(user.lang);
  const [theme, setTheme] = useState<ThemeId>(user.theme);
  // Birth + astrology + MBTI. birth date/time are local strings in the
  // chosen tz; we convert to UTC epoch on save and back on load.
  const guessTz = (() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Taipei';
    } catch {
      return 'Asia/Taipei';
    }
  })();
  const [birthDate, setBirthDate] = useState('');
  const [birthTime, setBirthTime] = useState('');
  const [birthTz, setBirthTz] = useState<string>(user.birthTz || guessTz);
  const [moonSign, setMoonSign] = useState<string>(user.moonSign || '');
  const [risingSign, setRisingSign] = useState<string>(user.risingSign || '');
  const [mbti, setMbti] = useState<string>(user.mbti || '');
  const [showBirthday, setShowBirthday] = useState<boolean>(user.showBirthday);
  const [showMbti, setShowMbti] = useState<boolean>(user.showMbti);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [avatarBust, setAvatarBust] = useState(Date.now());
  const [usageOpen, setUsageOpen] = useState(true);
  const [usage, setUsage] = useState<MyUsage | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setNickname(user.nickname || '');
      setBio(user.bio || '');
      setPassword('');
      setLocalLang(user.lang);
      setTheme(user.theme);
      setError('');
      setSuccess('');
      setAvatarBust(Date.now());
      setUsageOpen(true);
      setUsage(null);
      // Hydrate birth fields from the stored UTC epoch + tz.
      const tz = user.birthTz || guessTz;
      setBirthTz(tz);
      if (user.birthAt) {
        const { date, time } = utcEpochToLocalParts(user.birthAt, tz);
        setBirthDate(date);
        setBirthTime(time);
      } else {
        setBirthDate('');
        setBirthTime('');
      }
      setMoonSign(user.moonSign || '');
      setRisingSign(user.risingSign || '');
      setMbti(user.mbti || '');
      setShowBirthday(user.showBirthday);
      setShowMbti(user.showMbti);
    }
  }, [isOpen, user, guessTz]);

  // Lazy-load usage on first expand — most opens of the modal are for
  // editing settings, no point hitting the endpoint preemptively.
  useEffect(() => {
    if (usageOpen && !usage) {
      getMyUsage()
        .then(setUsage)
        .catch(() => setUsage({ totals: { calls: 0, tokens_in: 0, tokens_out: 0, prompt_chars: 0, completion_chars: 0, cost_usd: 0 }, by_model: [] }));
    }
  }, [usageOpen, usage]);

  if (!isOpen) return null;

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSuccess('');
    if (password && password.length < 6) {
      setError(t.passwordTooShort);
      return;
    }
    setBusy(true);
    try {
      // Compute UTC epoch from local birth date/time + tz. Empty
      // date → null (clears the birth_at column).
      let birthAt: number | null = null;
      if (birthDate) {
        birthAt = localPartsToUtcEpoch(birthDate, birthTime || '00:00', birthTz);
      }
      // Auto-derive sun sign from birth date if filled, otherwise null.
      let sunSign: string | null = null;
      if (birthDate) {
        const [, mStr, dStr] = birthDate.split('-');
        sunSign = sunSignFromMonthDay(parseInt(mStr, 10), parseInt(dStr, 10));
      }
      const updated = await updateProfile({
        nickname: nickname.trim() || null,
        bio: bio.slice(0, 500),
        password: password || null,
        lang,
        theme,
        birthAt,
        birthTz: birthDate ? birthTz : null,
        sunSign,
        moonSign: moonSign || null,
        risingSign: risingSign || null,
        mbti: mbti || null,
        showBirthday,
        // Year + birth time are intentionally never public — no
        // toggle in the UI. Pin both flags to false on every save so
        // the DB stays consistent even if the row was set true in
        // an earlier build.
        showBirthTime: false,
        showBirthYear: false,
        showMbti,
      });
      onUpdate(updated);
      setLang(lang);
      setPassword('');
      setSuccess(t.profileSaved);
    } catch (err) {
      setError(t.profileSaveFailed((err as Error).message));
    } finally {
      setBusy(false);
    }
  };

  const handleAvatarPick = () => fileRef.current?.click();

  const handleAvatarFile = async (file: File) => {
    setError('');
    setSuccess('');
    if (file.size > MAX_AVATAR_MB * 1024 * 1024) {
      setError(t.profileAvatarTooLarge(MAX_AVATAR_MB));
      return;
    }
    if (!SUPPORTED_TYPES.includes(file.type)) {
      setError(t.profileAvatarUnsupported);
      return;
    }
    setBusy(true);
    try {
      const updated = await uploadAvatar(file);
      onUpdate(updated);
      setAvatarBust(Date.now());
    } catch (err) {
      setError(t.profileSaveFailed((err as Error).message));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const handleAvatarRemove = async () => {
    setError('');
    setSuccess('');
    setBusy(true);
    try {
      const updated = await deleteAvatar();
      onUpdate(updated);
      setAvatarBust(Date.now());
    } catch (err) {
      setError(t.profileSaveFailed((err as Error).message));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <form
        onSubmit={handleSave}
        onClick={(e) => e.stopPropagation()}
        className="bg-gray-900 border border-gray-700 rounded-lg w-full max-w-md max-h-[90vh] overflow-y-auto p-4 shadow-xl"
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-bold text-white">{t.profileTitle}</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-500 hover:text-white text-sm"
          >
            ✕
          </button>
        </div>

        {/* Avatar */}
        <div className="mb-4 flex items-center gap-3">
          <div className="w-16 h-16 rounded-full bg-gray-800 border border-gray-700 flex items-center justify-center overflow-hidden flex-none">
            {user.hasAvatar ? (
              <img
                src={avatarUrl(user.username, avatarBust)}
                alt={user.username}
                className="w-full h-full object-cover"
              />
            ) : (
              <span className="text-xl text-gray-500">
                {(user.nickname || user.username).slice(0, 1).toUpperCase()}
              </span>
            )}
          </div>
          <div className="flex-1 space-y-1">
            <div className="text-xs text-gray-400">{t.profileAvatar}</div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleAvatarPick}
                disabled={busy}
                className="px-2 py-1 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 rounded text-xs"
              >
                {t.profileUploadAvatar}
              </button>
              {user.hasAvatar && (
                <button
                  type="button"
                  onClick={handleAvatarRemove}
                  disabled={busy}
                  className="px-2 py-1 text-red-400 hover:text-red-300 disabled:opacity-40 rounded text-xs"
                >
                  {t.profileRemoveAvatar}
                </button>
              )}
            </div>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleAvatarFile(f);
              }}
              className="hidden"
            />
          </div>
        </div>

        {onViewProfile && (
          <button
            onClick={onViewProfile}
            className="w-full mb-3 px-3 py-2 rounded bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium"
          >
            查看我的公開檔案 →
          </button>
        )}

        {/* Username + Tier (both read-only) */}
        <div className="mb-3 space-y-1.5 text-xs">
          <div className="flex items-center gap-2">
            <span className="text-gray-400">{t.profileUsername}:</span>
            <code className="px-2 py-0.5 rounded bg-gray-800 border border-gray-700 text-gray-200 font-mono">
              {user.username}
            </code>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-gray-400">{t.profileTier}:</span>
            <span className="px-2 py-0.5 rounded bg-gray-800 border border-gray-700 uppercase tracking-wider text-gray-200">
              {user.tier}
            </span>
          </div>
        </div>

        {/* Nickname */}
        <label className="block text-xs text-gray-300 mb-1">
          {t.profileNickname}
        </label>
        <input
          type="text"
          value={nickname}
          onChange={(e) => setNickname(e.target.value)}
          className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-sm mb-3 focus:outline-none focus:border-blue-500"
        />

        {/* Bio — public, shown on /forum/user/<username>. */}
        <label className="block text-xs text-gray-300 mb-1">
          個人介紹
          <span className="text-gray-500 ml-1">（{bio.length}/500）</span>
        </label>
        <textarea
          value={bio}
          onChange={(e) => setBio(e.target.value.slice(0, 500))}
          placeholder="寫一點關於自己的事 — 會出現在你的論壇 profile 頁。"
          rows={3}
          className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-sm mb-3 focus:outline-none focus:border-blue-500 resize-y"
        />

        {/* Birth + astrology + MBTI + persona dice. Wrapped in <details>
            so the section can collapse when the user just wants to
            edit nickname/bio. Default open so the dice feature stays
            discoverable. */}
        <details
          open
          className="mb-3 p-3 rounded border border-gray-800 bg-gray-900/40"
        >
          <summary className="text-xs text-gray-400 font-semibold cursor-pointer select-none">
            出生資訊
          </summary>
          <div className="mt-2 space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-[10px] text-gray-500 mb-0.5">
                出生日期
              </label>
              <input
                type="date"
                value={birthDate}
                onChange={(e) => setBirthDate(e.target.value)}
                className="w-full px-2 py-1 bg-gray-800 border border-gray-700 rounded text-xs focus:outline-none focus:border-blue-500"
              />
            </div>
            <div>
              <label className="block text-[10px] text-gray-500 mb-0.5">
                出生時間
              </label>
              <input
                type="time"
                value={birthTime}
                onChange={(e) => setBirthTime(e.target.value)}
                className="w-full px-2 py-1 bg-gray-800 border border-gray-700 rounded text-xs focus:outline-none focus:border-blue-500"
              />
            </div>
          </div>
          <div>
            <label className="block text-[10px] text-gray-500 mb-0.5">
              出生時區
            </label>
            <select
              value={birthTz}
              onChange={(e) => setBirthTz(e.target.value)}
              className="w-full px-2 py-1 bg-gray-800 border border-gray-700 rounded text-xs"
            >
              {COMMON_TIMEZONES.map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </select>
          </div>
          {birthDate && (
            <div className="text-[10px] text-gray-500">
              太陽星座：
              <span className="text-amber-300 ml-1">
                {(() => {
                  const [, m, d] = birthDate.split('-');
                  if (!m || !d) return '';
                  const k = sunSignFromMonthDay(
                    parseInt(m, 10),
                    parseInt(d, 10),
                  );
                  return `${SIGN_GLYPH[k]} ${SIGN_ZH[k]}`;
                })()}
              </span>
              <span className="ml-1">（依生日自動推算）</span>
            </div>
          )}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-[10px] text-gray-500 mb-0.5">
                月亮星座
              </label>
              <SignSelect value={moonSign} onChange={setMoonSign} />
            </div>
            <div>
              <label className="block text-[10px] text-gray-500 mb-0.5">
                上升星座
              </label>
              <SignSelect value={risingSign} onChange={setRisingSign} />
            </div>
          </div>
          <div>
            <label className="block text-[10px] text-gray-500 mb-0.5">
              MBTI
            </label>
            <select
              value={mbti}
              onChange={(e) => setMbti(e.target.value)}
              className="w-full px-2 py-1 bg-gray-800 border border-gray-700 rounded text-xs"
            >
              <option value="">— 不設定 —</option>
              {MBTI_TYPES.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1 pt-1 border-t border-gray-800">
            <div className="text-[10px] text-gray-500 mb-1">
              公開設定（出生年份與時辰永遠私人，星座填了就公開）
            </div>
            <ToggleRow
              label="公開生日（月/日）"
              checked={showBirthday}
              onChange={setShowBirthday}
            />
            <ToggleRow
              label="公開 MBTI"
              checked={showMbti}
              onChange={setShowMbti}
            />
          </div>

          {/* Persona dice. Rolls the seed that picks a variant per
              matrix cell. Disabled until the user has SAVED a full
              astro+MBTI set (server-side gate matches). Each click
              charges a synthetic $0.1 LLM-call cost. */}
          <PersonaDice user={user} onUpdate={onUpdate} />
          </div>
        </details>

        {/* Password */}
        <label className="block text-xs text-gray-300 mb-1">
          {t.profileNewPassword}
        </label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={t.profileNewPasswordPlaceholder}
          autoComplete="new-password"
          className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-sm mb-3 focus:outline-none focus:border-blue-500"
        />

        {/* Preferences (language + theme) — collapsible. Less commonly
            edited so default closed to keep the modal compact. */}
        <details className="mb-4 p-3 rounded border border-gray-800 bg-gray-900/40">
          <summary className="text-xs text-gray-400 font-semibold cursor-pointer select-none">
            喜好設定
          </summary>
          <div className="mt-3">
            {/* Language */}
            <label className="block text-xs text-gray-300 mb-1">
              {t.profileLanguage}
            </label>
            <div className="flex gap-2 mb-3">
              <button
                type="button"
                onClick={() => setLocalLang('zh-TW')}
                className={`flex-1 py-2 rounded text-sm flex items-center justify-center gap-2 ${
                  lang === 'zh-TW'
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                }`}
              >
                <span>{t.langZh}</span>
              </button>
              <button
                type="button"
                onClick={() => setLocalLang('en')}
                className={`flex-1 py-2 rounded text-sm flex items-center justify-center gap-2 ${
                  lang === 'en'
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                }`}
              >
                <span>{t.langEn}</span>
              </button>
            </div>

            {/* Theme */}
            <label className="block text-xs text-gray-300 mb-1">
              {t.profileTheme}
            </label>
            <div className="grid grid-cols-2 gap-2">
              {THEMES.map((th) => {
                const active = th.id === theme;
                return (
                  <button
                    key={th.id}
                    type="button"
                    onClick={() => setTheme(th.id)}
                    className={`py-2 px-2 rounded text-xs flex items-center gap-2 transition-colors ${
                      active
                        ? 'bg-blue-600 text-white'
                        : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
                    }`}
                  >
                    <span
                      className="w-3 h-3 rounded-full flex-none border border-white/30"
                      style={{ backgroundColor: th.swatch }}
                    />
                    <span className="truncate">{t[th.nameKey] as string}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </details>

        {/* Usage (collapsible) */}
        <div className="mb-4 border-t border-gray-800 pt-3">
          <button
            type="button"
            onClick={() => setUsageOpen((s) => !s)}
            className="text-xs text-gray-300 hover:text-white"
          >
            {usageOpen ? t.profileUsageHide : t.profileUsageShow} · {t.profileUsage}
          </button>
          {usageOpen && (
            <div className="mt-2 space-y-2">
              {!usage ? (
                <p className="text-xs text-gray-500">{t.loading}</p>
              ) : usage.totals.calls === 0 ? (
                <p className="text-xs text-gray-500">{t.profileUsageEmpty}</p>
              ) : (
                <>
                  <div className="grid grid-cols-3 gap-2 text-xs">
                    <div className="bg-gray-800 border border-gray-700 rounded p-2">
                      <div className="text-gray-500 text-[10px]">{t.profileUsageCalls}</div>
                      <div className="font-mono">{usage.totals.calls.toLocaleString()}</div>
                    </div>
                    <div className="bg-gray-800 border border-gray-700 rounded p-2">
                      <div className="text-gray-500 text-[10px]">{t.profileUsageTokens}</div>
                      <div className="font-mono text-[11px]">
                        {usage.totals.tokens_in.toLocaleString()} /{' '}
                        {usage.totals.tokens_out.toLocaleString()}
                      </div>
                    </div>
                    <div className="bg-gray-800 border border-gray-700 rounded p-2">
                      <div className="text-gray-500 text-[10px]">{t.profileUsageCost}</div>
                      <div className="font-mono">
                        ${usage.totals.cost_usd.toFixed(usage.totals.cost_usd < 1 ? 4 : 2)}
                      </div>
                    </div>
                  </div>
                  <table className="w-full text-[11px] mt-2">
                    <thead className="text-gray-500">
                      <tr className="border-b border-gray-800">
                        <th className="text-left py-1">Model</th>
                        <th className="text-right py-1">Calls</th>
                        <th className="text-right py-1">Tokens</th>
                        <th className="text-right py-1">$</th>
                      </tr>
                    </thead>
                    <tbody>
                      {usage.by_model.map((m) => (
                        <tr key={`${m.provider}-${m.model}`} className="border-b border-gray-800/50">
                          <td className="py-1 font-mono text-gray-300">{m.model}</td>
                          <td className="py-1 text-right font-mono">{m.calls}</td>
                          <td className="py-1 text-right font-mono">
                            {(m.tokens_in + m.tokens_out).toLocaleString()}
                          </td>
                          <td className="py-1 text-right font-mono">
                            ${m.cost_usd.toFixed(m.cost_usd < 1 ? 4 : 2)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="text-[10px] text-gray-500 leading-relaxed">
                    {t.profileUsageNote}
                  </p>
                </>
              )}
            </div>
          )}
        </div>

        {error && <p className="text-xs text-red-400 mb-3">{error}</p>}
        {success && <p className="text-xs text-emerald-400 mb-3">{success}</p>}

        <button
          type="submit"
          disabled={busy}
          className="w-full py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded text-sm font-medium"
        >
          {t.save}
        </button>

        {/* Danger Zone — soft disable + permanent purge. Collapsed by
            default; the destructive buttons only appear after the user
            clicks "展開危險操作" so the Save button above can't be
            mis-clicked into a disable / purge. Each action then runs
            through its own confirm flow. */}
        <div className="mt-8 pt-5 border-t border-red-900/40">
          <div className="rounded-lg border border-red-900/60 bg-red-950/30 p-4 space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <h3 className="text-sm font-bold text-red-300 mb-1">
                  {dz.sectionTitle}
                </h3>
                <p className="text-[11px] text-red-200/70 leading-relaxed">
                  {dz.sectionDesc}{' '}
                  <a
                    href="/data-deletion"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline hover:text-red-100"
                  >
                    {dz.moreInfo}
                  </a>
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setDangerExpanded((v) => !v);
                  // When collapsing, drop any half-typed confirms so
                  // re-expanding shows clean state.
                  if (dangerExpanded) {
                    setShowDisableConfirm(false);
                    setShowPurgeConfirm(false);
                    setDisableErr('');
                    setPurgeErr('');
                  }
                }}
                className="flex-none px-2.5 py-1 rounded border border-red-900/60 text-[11px] text-red-200 hover:bg-red-900/30"
                aria-expanded={dangerExpanded}
              >
                {dangerExpanded ? `▲ ${dz.collapseBtn}` : `▼ ${dz.expandBtn}`}
              </button>
            </div>

            {dangerExpanded && (
            <>
            {/* Disable: less destructive — keeps the data, just signs
                the user out and blocks future logins. */}
            <div className="pt-3 border-t border-red-900/40">
              <h4 className="text-xs font-semibold text-yellow-200 mb-1">
                {dz.disableTitle}
              </h4>
              <p className="text-[11px] text-yellow-200/70 leading-relaxed mb-2">
                {dz.disableDesc}
              </p>
              {!showDisableConfirm ? (
                <button
                  type="button"
                  onClick={() => {
                    setShowDisableConfirm(true);
                    setDisablePassword('');
                    setDisableErr('');
                  }}
                  className="px-3 py-1.5 rounded bg-yellow-700 hover:bg-yellow-600 text-white text-xs font-medium"
                >
                  {dz.disableBtn}
                </button>
              ) : (
                <div className="space-y-2">
                  <p className="text-[11px] text-yellow-200 font-semibold">
                    ⚠ {dz.disableConfirmWarning}
                  </p>
                  <label className="block text-[11px] text-yellow-100/80">
                    {dz.typePasswordLabel}
                    <input
                      type="password"
                      value={disablePassword}
                      onChange={(e) => setDisablePassword(e.target.value)}
                      autoComplete="current-password"
                      disabled={disabling}
                      className="mt-1 w-full px-2 py-1 bg-gray-900 border border-yellow-900/50 rounded text-xs text-gray-100 focus:outline-none focus:border-yellow-500"
                    />
                  </label>
                  {disableErr && (
                    <p className="text-[11px] text-yellow-300">{disableErr}</p>
                  )}
                  <div className="flex gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => {
                        setShowDisableConfirm(false);
                        setDisableErr('');
                      }}
                      disabled={disabling}
                      className="flex-1 py-1.5 rounded border border-gray-700 hover:bg-gray-800 text-xs text-gray-300"
                    >
                      {dz.cancelBtn}
                    </button>
                    <button
                      type="button"
                      onClick={handleDisable}
                      disabled={disabling || !disablePassword}
                      className="flex-1 py-1.5 rounded bg-yellow-700 hover:bg-yellow-600 disabled:opacity-50 text-xs text-white font-medium"
                    >
                      {disabling ? dz.disablingBtn : dz.disableConfirmBtn}
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Permanent purge — fully destructive, requires both username
                AND password to confirm. */}
            <div className="pt-3 border-t border-red-900/40">
              <h4 className="text-xs font-semibold text-red-300 mb-1">
                {dz.deleteTitle}
              </h4>
            {!showPurgeConfirm ? (
              <button
                type="button"
                onClick={() => {
                  setShowPurgeConfirm(true);
                  setPurgeUsername('');
                  setPurgePassword('');
                  setPurgeErr('');
                }}
                className="px-3 py-1.5 rounded bg-red-700 hover:bg-red-600 text-white text-xs font-medium"
              >
                {dz.deleteBtn}
              </button>
            ) : (
              <div className="space-y-2">
                <p className="text-[11px] text-red-200 font-semibold">
                  ⚠ {dz.confirmWarning}
                </p>
                <label className="block text-[11px] text-red-100/80">
                  {dz.typeUsernameLabel(user.username)}
                  <input
                    type="text"
                    value={purgeUsername}
                    onChange={(e) => setPurgeUsername(e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    disabled={purging}
                    className="mt-1 w-full px-2 py-1 bg-gray-900 border border-red-900/50 rounded text-xs text-gray-100 focus:outline-none focus:border-red-500"
                  />
                </label>
                <label className="block text-[11px] text-red-100/80">
                  {dz.typePasswordLabel}
                  <input
                    type="password"
                    value={purgePassword}
                    onChange={(e) => setPurgePassword(e.target.value)}
                    autoComplete="current-password"
                    disabled={purging}
                    className="mt-1 w-full px-2 py-1 bg-gray-900 border border-red-900/50 rounded text-xs text-gray-100 focus:outline-none focus:border-red-500"
                  />
                </label>
                {purgeErr && (
                  <p className="text-[11px] text-red-300">{purgeErr}</p>
                )}
                <div className="flex gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => {
                      setShowPurgeConfirm(false);
                      setPurgeErr('');
                    }}
                    disabled={purging}
                    className="flex-1 py-1.5 rounded border border-gray-700 hover:bg-gray-800 text-xs text-gray-300"
                  >
                    {dz.cancelBtn}
                  </button>
                  <button
                    type="button"
                    onClick={handlePurge}
                    disabled={purging || !purgeUsername || !purgePassword}
                    className="flex-1 py-1.5 rounded bg-red-700 hover:bg-red-600 disabled:opacity-50 text-xs text-white font-medium"
                  >
                    {purging ? dz.deletingBtn : dz.confirmBtn}
                  </button>
                </div>
              </div>
            )}
            </div>
            </>
            )}
          </div>
        </div>
      </form>
    </div>
  );
}
