import { useState } from 'react';

/**
 * Renders the FPL club badge for a given team code.
 * Falls back to a 3-letter abbreviation if the image fails to load.
 *
 * Props:
 *   code  — FPL team code (integer), e.g. 8 for Chelsea
 *   short — short name fallback, e.g. "CHE"
 *   size  — pixel size (default 20)
 */
export default function ClubBadge({ code, short, size = 20 }) {
  const [errored, setErrored] = useState(false);

  if (!code || errored) {
    return (
      <span style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: size, height: size,
        fontSize: Math.round(size * 0.4), fontWeight: 700,
        color: 'var(--text-muted)', flexShrink: 0,
      }}>
        {short?.slice(0, 3) ?? '?'}
      </span>
    );
  }

  return (
    <img
      src={`https://resources.premierleague.com/premierleague/badges/t${code}.png`}
      alt={short ?? ''}
      width={size}
      height={size}
      onError={() => setErrored(true)}
      style={{ objectFit: 'contain', flexShrink: 0 }}
    />
  );
}
