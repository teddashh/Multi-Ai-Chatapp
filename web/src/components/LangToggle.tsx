import React from 'react';
import type { Lang } from '../i18n';
import FlagIcon from './FlagIcon';

interface Props {
  lang: Lang;
  onChange: (lang: Lang) => void;
  size?: 'sm' | 'md';
}

export default function LangToggle({ lang, onChange, size = 'sm' }: Props) {
  const flagSize = size === 'md' ? 22 : 18;
  const padding = size === 'md' ? 'px-2 py-1' : 'px-1.5 py-1';
  return (
    <div className="inline-flex items-center gap-0.5 bg-gray-800 border border-gray-700 rounded">
      <button
        type="button"
        onClick={() => onChange('zh-TW')}
        title="繁體中文"
        aria-label="繁體中文"
        className={`${padding} rounded transition flex items-center ${
          lang === 'zh-TW' ? 'bg-blue-600' : 'opacity-50 hover:opacity-100'
        }`}
      >
        <FlagIcon code="tw" size={flagSize} />
      </button>
      <button
        type="button"
        onClick={() => onChange('en')}
        title="English"
        aria-label="English"
        className={`${padding} rounded transition flex items-center ${
          lang === 'en' ? 'bg-blue-600' : 'opacity-50 hover:opacity-100'
        }`}
      >
        <FlagIcon code="us" size={flagSize} />
      </button>
    </div>
  );
}
