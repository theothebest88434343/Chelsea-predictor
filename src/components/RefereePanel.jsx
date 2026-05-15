export default function RefereePanel({ referee }) {
  if (!referee?.name) return null;

  const { name, stats, label } = referee;
  const labelColor = label === 'STRICT' ? 'var(--red)' : label === 'LENIENT' ? 'var(--green)' : 'var(--text-muted)';
  const labelBg    = label === 'STRICT' ? 'rgba(239,68,68,0.12)' : label === 'LENIENT' ? 'rgba(34,197,94,0.12)' : 'var(--surface2)';

  return (
    <div>
      <div className="card-title" style={{ marginBottom: 8 }}>Referee</div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <div>
          <div style={{ fontWeight: 600, fontSize: 14 }}>{name}</div>
          {label && (
            <span style={{
              display: 'inline-block', marginTop: 4, padding: '2px 8px', borderRadius: 4,
              fontSize: 10, fontWeight: 700, letterSpacing: 0.8, color: labelColor, background: labelBg,
              border: `1px solid ${labelColor}44`,
            }}>
              {label}
            </span>
          )}
        </div>
        {stats && (
          <div style={{ display: 'flex', gap: 16 }}>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontFamily: 'Bebas Neue, sans-serif', fontSize: 20, color: 'var(--gold)', lineHeight: 1 }}>
                {stats.yellowsPerGame}
              </div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>YELLOW/G</div>
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontFamily: 'Bebas Neue, sans-serif', fontSize: 20, color: 'var(--red)', lineHeight: 1 }}>
                {stats.redsPerGame}
              </div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>RED/G</div>
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontFamily: 'Bebas Neue, sans-serif', fontSize: 20, color: 'var(--text)', lineHeight: 1 }}>
                {stats.pensPerGame}
              </div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>PEN/G</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
