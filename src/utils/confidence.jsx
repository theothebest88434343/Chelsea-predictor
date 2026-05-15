export function confidenceTier(maxProb) {
  if (maxProb >= 0.70) return { label: 'VERY HIGH', color: 'var(--green)',     bg: 'rgba(34,197,94,0.15)' };
  if (maxProb >= 0.60) return { label: 'HIGH',      color: '#6adb6a',          bg: 'rgba(106,219,106,0.12)' };
  if (maxProb >= 0.50) return { label: 'MEDIUM',    color: 'var(--gold)',      bg: 'rgba(219,161,17,0.15)' };
  if (maxProb >= 0.40) return { label: 'LOW',       color: '#e07b28',          bg: 'rgba(224,123,40,0.15)' };
  return                      { label: 'VERY LOW',  color: 'var(--red)',       bg: 'rgba(239,68,68,0.15)' };
}

export function ConfidenceBadge({ homeWin, draw, awayWin, style }) {
  const maxProb = Math.max(homeWin ?? 0, draw ?? 0, awayWin ?? 0);
  const { label, color, bg } = confidenceTier(maxProb);
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: 4,
      fontSize: 10, fontWeight: 700, letterSpacing: 0.8,
      color, background: bg, border: `1px solid ${color}44`,
      ...style,
    }}>
      {label}
    </span>
  );
}
