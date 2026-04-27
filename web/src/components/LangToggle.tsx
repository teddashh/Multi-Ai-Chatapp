import React from 'react';
import type { Lang } from '../i18n';

interface Props {
  lang: Lang;
  onChange: (lang: Lang) => void;
  size?: 'sm' | 'md';
}

// Two-flag pill toggle. Used on the login screen and in the header so the
// user can switch language without going into the profile modal.
export default function LangToggle({ lang, onChange, size = 'sm' }: Props) {
  const cls =
    size === 'md'
      ? 'text-base px-2 py-1'
      : 'text-sm px-1.5 py-0.5';
  return (
    <div className={`inline-flex items-center gap-0.5 bg-gray-800 border border-gray-700 rounded`}>
      <button
        type="button"
        onClick={() => onChange('zh-TW')}
        title="繁體中文"
        aria-label="繁體中文"
        className={`${cls} rounded transition ${
          lang === 'zh-TW' ? 'bg-blue-600' : 'opacity-50 hover:opacity-100'
        }`}
      >
        🇹🇼
      </button>
      <button
        type="button"
        onClick={() => onChange('en')}
        title="English"
        aria-label="English"
        className={`${cls} rounded transition ${
          lang === 'en' ? 'bg-blue-600' : 'opacity-50 hover:opacity-100'
        }`}
      >
        🇺🇸
      </button>
    </div>
  );
}
