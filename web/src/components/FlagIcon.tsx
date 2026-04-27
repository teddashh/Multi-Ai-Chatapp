import React from 'react';

interface Props {
  code: 'tw' | 'us';
  size?: number;
  className?: string;
}

// Inline SVG flags so Windows browsers (which lack the regional-indicator
// emoji font by default) still see actual flags instead of "TW" / "US".
export default function FlagIcon({ code, size = 16, className }: Props) {
  if (code === 'tw') {
    return (
      <svg
        viewBox="0 0 30 20"
        width={size}
        height={(size * 2) / 3}
        className={className}
        aria-label="Taiwan"
      >
        <rect width="30" height="20" fill="#fe0000" />
        <rect width="15" height="10" fill="#000095" />
        <g transform="translate(7.5 5)">
          <circle r="2.6" fill="#fff" />
          <circle r="2" fill="#000095" />
          <g fill="#fff">
            {Array.from({ length: 12 }).map((_, i) => {
              const angle = (i * 30 * Math.PI) / 180;
              const x = Math.cos(angle) * 2.6;
              const y = Math.sin(angle) * 2.6;
              return <circle key={i} cx={x} cy={y} r="0.55" />;
            })}
          </g>
          <circle r="0.85" fill="#000095" />
        </g>
      </svg>
    );
  }
  // US flag — simplified (stripes + canton, no individual stars)
  return (
    <svg
      viewBox="0 0 38 20"
      width={size}
      height={(size * 2) / 3.8}
      className={className}
      aria-label="United States"
    >
      <rect width="38" height="20" fill="#fff" />
      {Array.from({ length: 7 }).map((_, i) => (
        <rect key={i} y={i * (20 / 13) * 2} width="38" height={20 / 13} fill="#bf0a30" />
      ))}
      <rect width="15.2" height="10.77" fill="#002868" />
      <g fill="#fff">
        {Array.from({ length: 9 }).flatMap((_, row) =>
          Array.from({ length: row % 2 === 0 ? 6 : 5 }).map((_, col) => {
            const x = (row % 2 === 0 ? 1.4 : 2.6) + col * 2.4;
            const y = 1.1 + row * 1.1;
            return <circle key={`${row}-${col}`} cx={x} cy={y} r="0.45" />;
          }),
        )}
      </g>
    </svg>
  );
}
