import { memo } from 'react';

// ─── ProbBar ──────────────────────────────────────────────────────────────────
// Canonical 6px probability bar — single source of truth for all leagues.
// memo: pure component — same props in → identical output.
export const ProbBar = memo(function ProbBar({ homeWin, draw, awayWin, homeName, awayName }) {
  const h = Math.round(homeWin * 100);
  const d = Math.round(draw    * 100);
  const a = 100 - h - d;
  const ariaLabel = `${homeName} ${h}%, Draw ${d}%, ${awayName} ${a}%`;
  return (
    <div>
      {/* role="img" + aria-label makes the bar meaningful to screen readers */}
      <div
        role="img"
        aria-label={ariaLabel}
        style={{ display: 'flex', gap: 3, borderRadius: 4, overflow: 'hidden', height: 6 }}
      >
        <div style={{ flex: h,             background: 'var(--blue)',            transition: 'flex 0.35s cubic-bezier(0.4,0,0.2,1)', minWidth: h > 0 ? 3 : 0 }} />
        <div style={{ flex: d,             background: 'rgba(255,255,255,0.18)', transition: 'flex 0.35s cubic-bezier(0.4,0,0.2,1)', minWidth: d > 0 ? 3 : 0 }} />
        <div style={{ flex: Math.max(a,1), background: '#6b2222',               transition: 'flex 0.35s cubic-bezier(0.4,0,0.2,1)', minWidth: a > 0 ? 3 : 0 }} />
      </div>
      {/* aria-hidden: the bar already exposes the numbers above */}
      <div aria-hidden style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, fontSize: 11, fontWeight: 600 }}>
        <span style={{ color: '#7aadff' }}>{homeName} {h}%</span>
        <span style={{ color: 'var(--text-muted)' }}>Draw {d}%</span>
        <span style={{ color: '#e07878' }}>{awayName} {a}%</span>
      </div>
    </div>
  );
});
