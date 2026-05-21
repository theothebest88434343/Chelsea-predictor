import { useState, useEffect } from 'react';

const API = import.meta.env.VITE_API_URL ?? 'http://localhost:3001';

// ─── Colour helpers ───────────────────────────────────────────────────────────

const CONFED_COLOURS = {
  UEFA:     '#3b82f6',
  CONMEBOL: '#10b981',
  CAF:      '#f59e0b',
  AFC:      '#8b5cf6',
  CONCACAF: '#ec4899',
  OFC:      '#6b7280',
};

function clusterColour(score) {
  if (score === 'HIGH')   return '#ef4444';
  if (score === 'MEDIUM') return '#f59e0b';
  return '#10b981';
}

function healthColour(status) {
  if (status === 'HEALTHY')  return '#10b981';
  if (status === 'WARNING')  return '#f59e0b';
  return '#ef4444';
}

function stabilityColour(score) {
  if (score >= 75) return '#10b981';
  if (score >= 50) return '#f59e0b';
  return '#ef4444';
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function SectionHeader({ title, subtitle }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 2, color: '#6b7280', textTransform: 'uppercase' }}>
        {title}
      </div>
      {subtitle && <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 2 }}>{subtitle}</div>}
    </div>
  );
}

function Card({ children, style = {} }) {
  return (
    <div style={{
      background: '#1f2937',
      border: '1px solid #374151',
      borderRadius: 10,
      padding: '16px 18px',
      ...style,
    }}>
      {children}
    </div>
  );
}

// ── 1. Health Banner ──────────────────────────────────────────────────────────

function HealthBanner({ health, generatedAt }) {
  const col = healthColour(health.overallStatus);
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      background: '#111827', border: `1px solid ${col}`, borderRadius: 10,
      padding: '12px 18px', marginBottom: 16,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{
          width: 10, height: 10, borderRadius: '50%',
          background: col, boxShadow: `0 0 8px ${col}`,
        }} />
        <span style={{ fontWeight: 700, color: col, fontSize: 14 }}>
          MODEL {health.overallStatus}
        </span>
        {health.clusteringAlert && (
          <span style={{ fontSize: 11, background: '#7f1d1d', color: '#fca5a5', borderRadius: 4, padding: '2px 8px' }}>
            ⚠ Clustering: {health.clusteringConfeds.join(', ')}
          </span>
        )}
        {health.stabilityAlert && (
          <span style={{ fontSize: 11, background: '#78350f', color: '#fde68a', borderRadius: 4, padding: '2px 8px' }}>
            ⚠ Low Stability
          </span>
        )}
        {health.driftAlert && (
          <span style={{ fontSize: 11, background: '#1e3a5f', color: '#93c5fd', borderRadius: 4, padding: '2px 8px' }}>
            ⚠ Structural Drift
          </span>
        )}
      </div>
      <span style={{ fontSize: 11, color: '#6b7280' }}>
        {generatedAt ? new Date(generatedAt).toLocaleTimeString() : '—'}
      </span>
    </div>
  );
}

// ── 2. Confederation Spread Bars ──────────────────────────────────────────────

function ConfedSpreadBars({ confedInflation, clusteringIndex }) {
  const confeds = ['UEFA', 'CONMEBOL', 'CONCACAF', 'CAF', 'AFC', 'OFC'].filter(c => confedInflation[c]);
  const maxElo  = Math.max(...confeds.map(c => confedInflation[c]?.maxElo ?? 0));
  const minElo  = Math.min(...confeds.map(c => confedInflation[c]?.minElo ?? 9999));
  const range   = maxElo - minElo || 1;

  return (
    <Card>
      <SectionHeader title="Confederation ELO Distribution" subtitle="Bar shows min–max range; dot = mean; cluster score on right" />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {confeds.map(c => {
          const inf = confedInflation[c];
          const cl  = clusteringIndex[c];
          if (!inf) return null;
          const barLeft  = ((inf.minElo - minElo) / range) * 100;
          const barWidth = ((inf.maxElo - inf.minElo) / range) * 100;
          const dotPos   = ((inf.meanElo - minElo) / range) * 100;
          const colour   = CONFED_COLOURS[c] ?? '#9ca3af';

          return (
            <div key={c} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              {/* Label */}
              <div style={{ width: 72, fontSize: 12, fontWeight: 600, color: colour, flexShrink: 0 }}>
                {c}
              </div>
              {/* Bar track */}
              <div style={{ flex: 1, position: 'relative', height: 12, background: '#374151', borderRadius: 6 }}>
                {/* Range bar */}
                <div style={{
                  position: 'absolute', top: 0, bottom: 0,
                  left: `${barLeft}%`, width: `${Math.max(barWidth, 1)}%`,
                  background: colour + '55', borderRadius: 6,
                }} />
                {/* Mean dot */}
                <div style={{
                  position: 'absolute', top: '50%', left: `${dotPos}%`,
                  transform: 'translate(-50%, -50%)',
                  width: 10, height: 10, borderRadius: '50%',
                  background: colour, border: '2px solid #1f2937',
                }} />
              </div>
              {/* Stats */}
              <div style={{ width: 160, display: 'flex', gap: 6, fontSize: 11, color: '#9ca3af', flexShrink: 0 }}>
                <span title="Mean ELO" style={{ color: '#d1d5db' }}>{inf.meanElo}</span>
                <span>±{inf.spread}</span>
                <span title="UEFA gap" style={{ color: inf.uefaGap < -80 ? '#f87171' : '#9ca3af' }}>
                  {inf.uefaGap >= 0 ? '+' : ''}{inf.uefaGap}v UEFA
                </span>
              </div>
              {/* Cluster score */}
              {cl && (
                <div style={{
                  width: 64, fontSize: 10, fontWeight: 700, textAlign: 'center',
                  color: clusterColour(cl.clusterScore),
                  background: clusterColour(cl.clusterScore) + '22',
                  borderRadius: 4, padding: '2px 0',
                }}>
                  {cl.clusterScore}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {/* ELO axis labels */}
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, fontSize: 10, color: '#4b5563', paddingLeft: 82 }}>
        <span>{minElo}</span>
        <span>{Math.round(minElo + range / 2)}</span>
        <span>{maxElo}</span>
      </div>
    </Card>
  );
}

// ── 3. Clustering Detail ──────────────────────────────────────────────────────

function ClusteringDetail({ clusteringIndex }) {
  const rows = ['CAF', 'AFC', 'CONCACAF', 'CONMEBOL', 'UEFA', 'OFC']
    .filter(c => clusteringIndex[c]);

  return (
    <Card>
      <SectionHeader title="Clustering Index" subtitle="ELO spread per confederation. LOW spread = clustering problem." />
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr style={{ color: '#6b7280', borderBottom: '1px solid #374151' }}>
            {['Confed', 'ELO Spread', 'Score', 'Top 10', '10–20', '20–40', 'Band Alert'].map(h => (
              <th key={h} style={{ padding: '4px 8px', textAlign: h === 'Confed' ? 'left' : 'center', fontWeight: 600, fontSize: 11 }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(c => {
            const cl = clusteringIndex[c];
            return (
              <tr key={c} style={{ borderBottom: '1px solid #1f2937' }}>
                <td style={{ padding: '6px 8px', color: CONFED_COLOURS[c] ?? '#9ca3af', fontWeight: 600 }}>{c}</td>
                <td style={{ padding: '6px 8px', textAlign: 'center', color: '#d1d5db' }}>{cl.eloSpread}</td>
                <td style={{ padding: '6px 8px', textAlign: 'center' }}>
                  <span style={{
                    color: clusterColour(cl.clusterScore),
                    background: clusterColour(cl.clusterScore) + '22',
                    borderRadius: 4, padding: '1px 6px', fontSize: 11, fontWeight: 700,
                  }}>
                    {cl.clusterScore}
                  </span>
                </td>
                <td style={{ padding: '6px 8px', textAlign: 'center', color: '#9ca3af' }}>{cl.rankBands.top10}</td>
                <td style={{ padding: '6px 8px', textAlign: 'center', color: '#9ca3af' }}>{cl.rankBands.band10_20}</td>
                <td style={{ padding: '6px 8px', textAlign: 'center', color: '#9ca3af' }}>{cl.rankBands.band20_40}</td>
                <td style={{ padding: '6px 8px', textAlign: 'center' }}>
                  {cl.bandAlert
                    ? <span style={{ color: '#fbbf24', fontSize: 14 }}>⚠</span>
                    : <span style={{ color: '#4b5563' }}>—</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}

// ── 4. Stability + Volatile Teams ─────────────────────────────────────────────

function StabilityPanel({ stabilityIndex }) {
  const { stabilityScore, avgVariance, mostVolatile } = stabilityIndex;
  const col = stabilityColour(stabilityScore);
  const arc = (stabilityScore / 100) * 251;  // circumference of r=40 circle ≈ 251

  return (
    <Card>
      <SectionHeader title="Rank Stability" subtitle="±5 ELO perturbation test across top 30 teams (30 trials)" />
      <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start' }}>
        {/* Gauge */}
        <div style={{ flexShrink: 0, textAlign: 'center' }}>
          <svg width={100} height={100} viewBox="0 0 100 100">
            <circle cx={50} cy={50} r={40} fill="none" stroke="#374151" strokeWidth={10} />
            <circle
              cx={50} cy={50} r={40} fill="none" stroke={col} strokeWidth={10}
              strokeDasharray={`${arc} 251`} strokeLinecap="round"
              transform="rotate(-90 50 50)"
            />
            <text x={50} y={55} textAnchor="middle" fontSize={22} fontWeight={700} fill={col}>{stabilityScore}</text>
          </svg>
          <div style={{ fontSize: 10, color: '#6b7280', marginTop: -4 }}>/ 100</div>
          <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>Avg variance: {avgVariance}</div>
        </div>

        {/* Volatile teams */}
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 6, fontWeight: 600 }}>MOST VOLATILE TEAMS</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {mostVolatile.slice(0, 8).map(v => (
              <div key={v.team} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ width: 24, fontSize: 11, color: '#6b7280', textAlign: 'right' }}>#{v.baseRank}</span>
                <span style={{ flex: 1, fontSize: 12, color: '#d1d5db' }}>{v.team}</span>
                <span style={{ fontSize: 11, color: v.meanShift > 1.5 ? '#f87171' : '#9ca3af' }}>
                  ±{v.meanShift} ranks
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Card>
  );
}

// ── 5. Overlap Matrix ─────────────────────────────────────────────────────────

function OverlapMatrix({ overlapScores }) {
  const { matrix } = overlapScores;
  const confeds = ['UEFA', 'CONMEBOL', 'CONCACAF', 'CAF', 'AFC', 'OFC'].filter(c => matrix[c]);

  function overlapColour(v) {
    if (v >= 0.8) return '#ef4444';
    if (v >= 0.5) return '#f59e0b';
    if (v >= 0.2) return '#3b82f6';
    return '#374151';
  }

  return (
    <Card>
      <SectionHeader title="Confederation ELO Overlap" subtitle="How much ELO ranges overlap. High = confederations occupy same bands." />
      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', fontSize: 11 }}>
          <thead>
            <tr>
              <th style={{ padding: '4px 10px', color: '#6b7280' }}></th>
              {confeds.map(c => (
                <th key={c} style={{ padding: '4px 10px', color: CONFED_COLOURS[c] ?? '#9ca3af', fontWeight: 600 }}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {confeds.map(a => (
              <tr key={a}>
                <td style={{ padding: '4px 10px', color: CONFED_COLOURS[a] ?? '#9ca3af', fontWeight: 600 }}>{a}</td>
                {confeds.map(b => {
                  const v = matrix[a]?.[b] ?? 0;
                  const bg = overlapColour(v);
                  return (
                    <td key={b} style={{ padding: '4px 10px', textAlign: 'center' }}>
                      <div style={{
                        display: 'inline-block', minWidth: 38, padding: '3px 6px',
                        background: a === b ? '#1f2937' : bg + '33',
                        color: a === b ? '#4b5563' : bg,
                        borderRadius: 4, fontWeight: 600,
                      }}>
                        {a === b ? '—' : v.toFixed(2)}
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ marginTop: 10, display: 'flex', gap: 12, fontSize: 10, color: '#6b7280' }}>
        <span><span style={{ color: '#ef4444' }}>■</span> ≥0.80 Heavy overlap</span>
        <span><span style={{ color: '#f59e0b' }}>■</span> ≥0.50 Moderate</span>
        <span><span style={{ color: '#3b82f6' }}>■</span> ≥0.20 Light</span>
        <span><span style={{ color: '#374151' }}>■</span> Minimal</span>
      </div>
    </Card>
  );
}

// ── 6. Drift Report ───────────────────────────────────────────────────────────

function DriftPanel({ driftReport }) {
  if (!driftReport.available) {
    return (
      <Card>
        <SectionHeader title="Model Drift" />
        <p style={{ fontSize: 12, color: '#6b7280', margin: 0 }}>
          No snapshot available yet. Drift will be tracked from the next server restart.
        </p>
      </Card>
    );
  }

  const { structuralShift, avgEloDrift, maxRankShift, bigMovers, totalTeamsTracked } = driftReport;

  return (
    <Card>
      <SectionHeader title="Model Drift" subtitle={`vs previous snapshot — ${totalTeamsTracked} teams tracked`} />
      <div style={{ display: 'flex', gap: 20, marginBottom: 12 }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 22, fontWeight: 700, color: avgEloDrift > 15 ? '#ef4444' : '#10b981' }}>
            {avgEloDrift}
          </div>
          <div style={{ fontSize: 10, color: '#6b7280' }}>Avg ELO drift</div>
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 22, fontWeight: 700, color: maxRankShift > 8 ? '#ef4444' : '#10b981' }}>
            {maxRankShift}
          </div>
          <div style={{ fontSize: 10, color: '#6b7280' }}>Max rank shift</div>
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: structuralShift ? '#ef4444' : '#10b981', marginTop: 4 }}>
            {structuralShift ? '⚠ STRUCTURAL SHIFT' : '✓ Stable'}
          </div>
          <div style={{ fontSize: 10, color: '#6b7280' }}>Overall assessment</div>
        </div>
      </div>

      {bigMovers.length > 0 && (
        <>
          <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 6, fontWeight: 600 }}>BIG MOVERS</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {bigMovers.slice(0, 8).map(m => (
              <div key={m.team} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ width: 24, fontSize: 11, color: '#6b7280', textAlign: 'right' }}>#{m.currentRank}</span>
                <span style={{ flex: 1, fontSize: 12, color: '#d1d5db' }}>{m.team}</span>
                <span style={{
                  fontSize: 11, minWidth: 40, textAlign: 'right',
                  color: m.rankDelta > 0 ? '#10b981' : m.rankDelta < 0 ? '#ef4444' : '#6b7280',
                }}>
                  {m.rankDelta > 0 ? '▲' : m.rankDelta < 0 ? '▼' : '—'}{Math.abs(m.rankDelta)} rnk
                </span>
                <span style={{
                  fontSize: 11, minWidth: 52, textAlign: 'right',
                  color: m.eloDelta > 0 ? '#10b981' : m.eloDelta < 0 ? '#f87171' : '#6b7280',
                }}>
                  {m.eloDelta >= 0 ? '+' : ''}{Math.round(m.eloDelta)} ELO
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </Card>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function ModelDiagnosticsPanel() {
  const [data, setData]     = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]   = useState(null);
  const [expanded, setExpanded] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetch(`${API}/api/model-diagnostics`)
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false); })
      .catch(e => { setError(e.message); setLoading(false); });
  }, []);

  if (!expanded) {
    return (
      <div
        onClick={() => setExpanded(true)}
        style={{
          cursor: 'pointer', background: '#111827', border: '1px solid #374151',
          borderRadius: 10, padding: '10px 18px', marginBottom: 16,
          display: 'flex', alignItems: 'center', gap: 10,
        }}
      >
        <div style={{
          width: 8, height: 8, borderRadius: '50%',
          background: data ? healthColour(data.health?.overallStatus) : '#6b7280',
        }} />
        <span style={{ fontSize: 12, color: '#6b7280', fontWeight: 600, letterSpacing: 1 }}>
          MODEL DIAGNOSTICS
        </span>
        <span style={{ fontSize: 11, color: '#4b5563', marginLeft: 'auto' }}>click to expand</span>
      </div>
    );
  }

  return (
    <div style={{ fontFamily: "'Inter', sans-serif", color: '#f9fafb', marginBottom: 24 }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: 12,
      }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#f9fafb', letterSpacing: 1 }}>
            Model Diagnostics
          </h2>
          <p style={{ margin: '2px 0 0', fontSize: 11, color: '#6b7280' }}>
            Bias monitoring — confederation inflation · clustering · stability · drift
          </p>
        </div>
        <button
          onClick={() => setExpanded(false)}
          style={{
            background: 'none', border: '1px solid #374151', borderRadius: 6,
            color: '#6b7280', cursor: 'pointer', fontSize: 11, padding: '4px 10px',
          }}
        >
          collapse
        </button>
      </div>

      {loading && (
        <div style={{ color: '#6b7280', fontSize: 13, padding: '20px 0', textAlign: 'center' }}>
          Loading diagnostics…
        </div>
      )}

      {error && (
        <div style={{ color: '#f87171', fontSize: 13, padding: '10px 0' }}>
          Error: {error}
        </div>
      )}

      {data && (
        <>
          <HealthBanner health={data.health} generatedAt={data.generatedAt} />

          {/* Row 1: Spread bars + Clustering */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
            <ConfedSpreadBars
              confedInflation={data.confedInflation}
              clusteringIndex={data.clusteringIndex}
            />
            <ClusteringDetail clusteringIndex={data.clusteringIndex} />
          </div>

          {/* Row 2: Stability + Overlap */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
            <StabilityPanel stabilityIndex={data.stabilityIndex} />
            <OverlapMatrix overlapScores={data.overlapScores} />
          </div>

          {/* Row 3: Drift */}
          <DriftPanel driftReport={data.driftReport} />
        </>
      )}
    </div>
  );
}
