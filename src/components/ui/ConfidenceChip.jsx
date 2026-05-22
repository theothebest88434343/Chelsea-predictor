// ─── ConfidenceChip ───────────────────────────────────────────────────────────
// Renders the model confidence chip from pred.confidence ONLY.
// Never derives confidence from homeWin / draw / awayWin.
// `style` prop allows callers to override font size, opacity etc.
export function ConfidenceChip({ confidence, style }) {
  if (confidence == null) return null;
  const pct = Math.round(confidence * 100);
  const cls   = pct >= 55 ? 'chip-green' : pct >= 45 ? 'chip-gold' : 'chip-muted';
  const title = pct >= 55
    ? 'High confidence — model uncertainty is low'
    : pct >= 45
      ? 'Moderate confidence — some model uncertainty'
      : 'Lower confidence — this match is hard to call';
  return (
    <span
      className={`chip ${cls}`}
      style={{ fontSize: 10, ...style }}
      title={title}
      aria-label={`Model confidence: ${pct}%`}
    >
      {pct}% conf.
    </span>
  );
}
