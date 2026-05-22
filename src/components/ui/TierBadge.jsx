import { getMatchLabel } from '../../utils/matchLabels';

// ─── TIER_STYLE ───────────────────────────────────────────────────────────────
// Canonical tier → visual style map. Single source of truth for all leagues.
export const TIER_STYLE = {
  dominant: { bg: 'rgba(59,130,246,0.12)', color: '#7aadff',  border: 'rgba(59,130,246,0.3)' },
  strong:   { bg: 'rgba(34,197,94,0.10)',  color: '#4ade80',  border: 'rgba(34,197,94,0.3)'  },
  slight:   { bg: 'rgba(219,161,17,0.12)', color: '#DBA111',  border: 'rgba(219,161,17,0.3)' },
  tossup:   { bg: 'rgba(255,255,255,0.05)',color: '#7d93b3',  border: 'rgba(255,255,255,0.1)'},
  underdog: { bg: 'rgba(239,68,68,0.10)',  color: '#f87171',  border: 'rgba(239,68,68,0.3)'  },
};

// ─── TierBadge ────────────────────────────────────────────────────────────────
// Renders the match tier pill (e.g. "Home dominant", "Toss-up").
// Intentionally de-emphasised — secondary signal below hero sentence.
export function TierBadge({ homeWin, draw, awayWin }) {
  const matchLabel = getMatchLabel(homeWin, draw, awayWin);
  if (!matchLabel) return null;
  const ts = TIER_STYLE[matchLabel.tier] ?? TIER_STYLE.tossup;
  return (
    <span style={{
      display: 'inline-block', fontSize: 9, fontWeight: 700,
      letterSpacing: '0.07em', textTransform: 'uppercase',
      padding: '2px 8px', borderRadius: 20,
      background: ts.bg, color: ts.color,
      border: `1px solid ${ts.border}`,
    }}>
      {matchLabel.text}
    </span>
  );
}
