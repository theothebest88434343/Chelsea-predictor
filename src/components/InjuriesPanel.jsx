import { useFetch } from '../hooks/useFetch';
import { AlertCircle } from 'lucide-react';

const STATUS_LABEL = { i: 'Injured', d: 'Doubtful', s: 'Suspended' };
const STATUS_COLOR = { i: 'var(--red)', d: 'var(--draw)', s: 'var(--text-muted)' };

export default function InjuriesPanel() {
  const { data, loading, error } = useFetch('/api/injuries');

  if (loading) return <div className="loading-card"><div className="spinner" /><div>Loading injuries…</div></div>;
  if (error)   return null;
  if (!data?.length) {
    return (
      <div className="card">
        <div className="card-title">Chelsea injuries</div>
        <span className="text-muted fs-13">No injuries reported</span>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="card-title">Chelsea injuries</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {data.map(player => (
          <div key={player.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <AlertCircle size={14} color={STATUS_COLOR[player.status] ?? 'var(--text-muted)'} style={{ flexShrink: 0 }} />
              <div>
                <div style={{ fontWeight: 600, fontSize: 14 }}>{player.webName}</div>
                {player.news && (
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>{player.news}</div>
                )}
              </div>
            </div>
            <div style={{ textAlign: 'right', flexShrink: 0 }}>
              <span className="chip chip-muted" style={{ fontSize: 10 }}>
                {player.position}
              </span>
              {player.chancePlay !== null && (
                <div style={{ fontSize: 11, color: STATUS_COLOR[player.status], marginTop: 4 }}>
                  {player.chancePlay}% chance
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
