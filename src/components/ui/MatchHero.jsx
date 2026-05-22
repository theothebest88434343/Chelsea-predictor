import { memo } from 'react';

// ─── getHeroSentence ──────────────────────────────────────────────────────────
// Returns the single clearest statement about a match result likelihood.
// Pure function — single source of truth for all leagues.
export function getHeroSentence(homeName, awayName, homeWin, draw, awayWin) {
  const h = Math.round(homeWin * 100);
  const d = Math.round(draw    * 100);
  const a = 100 - h - d;
  if (h >= a + 14 && h > d) return { label: `${homeName} win`,   pct: h,    color: '#7aadff' };
  if (a >= h + 14 && a > d) return { label: `${awayName} win`,   pct: a,    color: '#e07878' };
  if (d > h && d > a)       return { label: 'Draw most likely',  pct: d,    color: 'rgba(255,255,255,0.6)' };
  if (h > a)                return { label: `${homeName} edge`,  pct: h,    color: '#7aadff' };
  if (a > h)                return { label: `${awayName} edge`,  pct: a,    color: '#e07878' };
  return                           { label: 'Too close to call', pct: null, color: 'rgba(255,255,255,0.5)' };
}

// ─── MatchHero ────────────────────────────────────────────────────────────────
// Renders the hero sentence as a styled element.
// `style` prop allows callers to override margins per-context.
export const MatchHero = memo(function MatchHero({ homeName, awayName, homeWin, draw, awayWin, style }) {
  const hero = getHeroSentence(homeName, awayName, homeWin, draw, awayWin);
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, ...style }}>
      <span style={{ fontSize: 14, fontWeight: 700, color: hero.color, lineHeight: 1 }}>
        {hero.label}
      </span>
      {hero.pct != null && (
        <span style={{ fontSize: 12, fontWeight: 600, color: hero.color, opacity: 0.7 }}>
          {hero.pct}%
        </span>
      )}
    </div>
  );
});
