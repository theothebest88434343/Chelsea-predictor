import { AlertTriangle } from 'lucide-react';

// results: array of { homeGoals, awayGoals } from team's perspective — team always listed first
function resultChar(homeGoals, awayGoals) {
  if (homeGoals > awayGoals) return 'W';
  if (homeGoals < awayGoals) return 'L';
  return 'D';
}

export default function FormChart({ results = [], teamName = '' }) {
  const recent = results.slice(0, 5);
  const zeroScoring = recent.length >= 3 && recent.every(r => (r.homeGoals ?? 0) === 0);

  if (recent.length === 0) {
    return (
      <div>
        <div className="card-title">Form</div>
        <span className="text-muted fs-13">No recent results</span>
      </div>
    );
  }

  return (
    <div>
      <div className="card-title" style={{ marginBottom: 8 }}>
        {teamName ? `${teamName} form` : 'Recent form'}
      </div>

      {zeroScoring && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10, color: 'var(--draw)', fontSize: 12 }}>
          <AlertTriangle size={14} />
          <span>Zero scoring run — attack lambda dampened</span>
        </div>
      )}

      <div className="form-dots">
        {recent.map((r, i) => {
          const ch = resultChar(r.homeGoals ?? 0, r.awayGoals ?? 0);
          return (
            <div key={i} className={`form-dot ${ch}`} title={`${r.homeGoals ?? 0}-${r.awayGoals ?? 0}`}>
              {ch}
            </div>
          );
        })}
        {/* Placeholder dots for missing results */}
        {Array.from({ length: Math.max(0, 5 - recent.length) }).map((_, i) => (
          <div key={`ph-${i}`} className="form-dot" style={{ background: 'var(--surface2)', border: '1.5px dashed var(--border)', color: 'var(--text-muted)' }}>
            ?
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 12, marginTop: 10, fontSize: 12, color: 'var(--text-muted)' }}>
        {(() => {
          const w = recent.filter(r => resultChar(r.homeGoals ?? 0, r.awayGoals ?? 0) === 'W').length;
          const d = recent.filter(r => resultChar(r.homeGoals ?? 0, r.awayGoals ?? 0) === 'D').length;
          const l = recent.length - w - d;
          const gf = recent.reduce((s, r) => s + (r.homeGoals ?? 0), 0);
          const ga = recent.reduce((s, r) => s + (r.awayGoals ?? 0), 0);
          return (
            <>
              <span><span className="text-green fw-700">{w}W</span> {d}D <span className="text-red">{l}L</span></span>
              <span>{gf} scored / {ga} conceded</span>
            </>
          );
        })()}
      </div>
    </div>
  );
}
