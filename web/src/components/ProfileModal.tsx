import React, { useEffect, useRef, useState } from 'react';
import {
  avatarUrl,
  deleteAvatar,
  updateProfile,
  uploadAvatar,
  type User,
} from '../api';
import { useI18n } from '../i18n';
import type { Lang } from '../i18n';

interface Props {
  isOpen: boolean;
  user: User;
  onClose: () => void;
  onUpdate: (user: User) => void;
}

const MAX_AVATAR_MB = 4;
const SUPPORTED_TYPES = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif'];

export default function ProfileModal({ isOpen, user, onClose, onUpdate }: Props) {
  const { t, setLang } = useI18n();
  const [nickname, setNickname] = useState(user.nickname || '');
  const [email, setEmail] = useState(user.email || '');
  const [password, setPassword] = useState('');
  const [lang, setLocalLang] = useState<Lang>(user.lang);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  // Bumps when avatar is replaced — appended as a query string so the browser
  // refetches instead of serving the cached image.
  const [avatarBust, setAvatarBust] = useState(Date.now());
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setNickname(user.nickname || '');
      setEmail(user.email || '');
      setPassword('');
      setLocalLang(user.lang);
      setError('');
      setSuccess('');
      setAvatarBust(Date.now());
    }
  }, [isOpen, user]);

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
      const updated = await updateProfile({
        nickname: nickname.trim() || null,
        email: email.trim() || null,
        password: password || null,
        lang,
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

        {/* Email */}
        <label className="block text-xs text-gray-300 mb-1">
          {t.profileEmail}
        </label>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-sm mb-3 focus:outline-none focus:border-blue-500"
        />

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

        {/* Language */}
        <label className="block text-xs text-gray-300 mb-1">
          {t.profileLanguage}
        </label>
        <div className="flex gap-2 mb-4">
          <button
            type="button"
            onClick={() => setLocalLang('zh-TW')}
            className={`flex-1 py-2 rounded text-sm flex items-center justify-center gap-2 ${
              lang === 'zh-TW'
                ? 'bg-blue-600 text-white'
                : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
            }`}
          >
            <span>🇹🇼</span>
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
            <span>🇺🇸</span>
            <span>{t.langEn}</span>
          </button>
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
      </form>
    </div>
  );
}
