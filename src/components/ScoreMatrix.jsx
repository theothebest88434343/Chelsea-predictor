import { useMemo } from 'react';

function heatColor(prob, maxProb) {
  const intensity = Math.min(prob / maxProb, 1);
  const r = Math.round(3  + intensity * 0);
  const g = Math.round(70 + intensity * 86);
  const b = Math.round(148 + intensity * 7);
  const a = 0.1 + intensity * 0.85;
  return `rgba(${r},${g},${b},${a})`;
}

function TopScorelines({ matrix }) {
  const scored = [];
  for (let h = 0; h < matrix.length; h++)
    for (let a = 0; a < (matrix[h]?.length ?? 0); a++)
      scored.push({ score: `${h}–${a}`, prob: matrix[h][a] });
  const top3 = scored.sort((a, b) => b.prob - a.prob).slice(0, 3);
  const medals = ['🥇', '🥈', '🥉'];

  return (
    <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
      {top3.map((s, i) => (
        <div key={s.score} style={{
          flex: 1, minWidth: 80, background: i === 0 ? 'rgba(219,161,17,0.12)' : 'var(--surface2)',
          border: `1px solid ${i === 0 ? 'rgba(219,161,17,0.4)' : 'var(--border)'}`,
          borderRadius: 8, padding: '8px 10px', textAlign: 'center',
        }}>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 2 }}>{medals[i]}</div>
          <div style={{
            fontFamily: 'Bebas Neue, sans-serif', fontSize: 22, letterSpacing: 2,
            color: i === 0 ? 'var(--gold)' : 'var(--text)', lineHeight: 1,
          }}>{s.score}</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
            {(s.prob * 100).toFixed(1)}%
          </div>
        </div>
      ))}
    </div>
  );
}

export default function ScoreMatrix({ matrix, homeTeam, awayTeam }) {
  if (!matrix || !matrix.length) return null;

  const size   = matrix.length;
  const awaySize = matrix[0]?.length ?? size;

  const maxProb = useMemo(() => {
    let max = 0;
    for (const row of matrix) for (const cell of row) if (cell > max) max = cell;
    return max;
  }, [matrix]);

  const cols = awaySize + 1;

  return (
    <div>
      <div className="card-title" style={{ marginBottom: 8 }}>Score probability matrix</div>
      <TopScorelines matrix={matrix} />
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8, display: 'flex', justifyContent: 'space-between' }}>
        <span>↓ {homeTeam?.shortName ?? 'Home'} goals</span>
        <span>{awayTeam?.shortName ?? 'Away'} goals →</span>
      </div>
      <div className="score-matrix" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
        <div className="matrix-header" />
        {Array.from({ length: awaySize }, (_, a) => (
          <div key={a} className="matrix-header">{a}</div>
        ))}

        {matrix.map((row, h) => (
          <>
            <div key={`h${h}`} className="matrix-header">{h}</div>
            {row.map((prob, a) => {
              const pct = (prob * 100).toFixed(1);
              return (
                <div
                  key={`${h}-${a}`}
                  className="matrix-cell"
                  title={`${h}-${a}: ${pct}%`}
                  style={{
                    background: heatColor(prob, maxProb),
                    color: prob > maxProb * 0.5 ? '#fff' : 'var(--text-muted)',
                    fontSize: 10,
                  }}
                >
                  {pct}
                </div>
              );
            })}
          </>
        ))}
      </div>
    </div>
  );
}
