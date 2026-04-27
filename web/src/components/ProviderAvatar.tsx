import React, { useState } from 'react';
import type { AIProvider } from '../shared/types';
import { AI_PROVIDERS } from '../shared/constants';

interface Props {
  provider: AIProvider;
  size?: number;
}

export default function ProviderAvatar({ provider, size = 40 }: Props) {
  const [errored, setErrored] = useState(false);
  const info = AI_PROVIDERS[provider];

  if (errored) {
    return (
      <div
        className="rounded-full flex items-center justify-center font-bold flex-none border border-black/30"
        style={{
          width: size,
          height: size,
          backgroundColor: info.color,
          color: '#fff',
          fontSize: size * 0.4,
        }}
      >
        {info.name[0]}
      </div>
    );
  }

  return (
    <img
      src={`/avatars/${provider}.png`}
      alt={info.name}
      onError={() => setErrored(true)}
      className="rounded-full flex-none object-cover border border-gray-700"
      style={{ width: size, height: size }}
    />
  );
}
