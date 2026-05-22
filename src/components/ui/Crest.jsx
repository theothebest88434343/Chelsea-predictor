import { useState } from 'react';

/**
 * Unified crest/logo component for FD-league teams.
 * - Renders a crest image from a URL (football-data.org or similar).
 * - Falls back to text initials in a fixed-size container when:
 *     • no src is provided
 *     • the image fails to load (onError)
 * - Always occupies exactly {size}×{size} px so layout never shifts.
 *
 * Props:
 *   src   — crest URL (can be null/undefined)
 *   alt   — team name used to derive initials (e.g. "Bayern Munich" → "BM")
 *   size  — pixel size, default 20
 */
export function Crest({ src, alt, size = 20 }) {
  const [errored, setErrored] = useState(false);

  // Derive initials: single word → first 3 chars; multi-word → first letter of each word (max 3)
  const words    = (alt ?? '?').trim().split(/\s+/);
  const initials = words.length === 1
    ? words[0].slice(0, 3).toUpperCase()
    : words.map(w => w[0]).join('').slice(0, 3).toUpperCase();

  if (!src || errored) {
    return (
      <span style={{
        display:        'inline-flex',
        alignItems:     'center',
        justifyContent: 'center',
        width:          size,
        height:         size,
        flexShrink:     0,
        fontSize:       Math.round(size * 0.38),
        fontWeight:     700,
        color:          'var(--text-muted)',
        userSelect:     'none',
      }}>
        {initials}
      </span>
    );
  }

  return (
    <img
      src={src}
      alt={alt ?? ''}
      width={size}
      height={size}
      onError={() => setErrored(true)}
      style={{ objectFit: 'contain', flexShrink: 0, display: 'block' }}
    />
  );
}
