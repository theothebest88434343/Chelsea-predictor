import { useFetch } from '../hooks/useFetch';

export default function TeamSwitcher({ selectedId, onChange }) {
  const { data: teams, loading } = useFetch('/api/teams');

  if (loading) return <div style={{ height: 40 }} />;

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6, fontWeight: 600, letterSpacing: 0.5 }}>
        SELECT TEAM
      </div>
      <div style={{ overflowX: 'auto', paddingBottom: 4 }}>
        <div style={{ display: 'flex', gap: 6, width: 'max-content' }}>
          {(teams ?? []).map(team => (
            <button
              key={team.id}
              onClick={() => onChange(team)}
              style={{
                padding: '5px 10px',
                borderRadius: 20,
                border: '1px solid',
                borderColor: selectedId === team.id ? 'var(--gold)' : 'var(--border)',
                background: selectedId === team.id ? 'rgba(219,161,17,0.12)' : 'var(--surface)',
                color: selectedId === team.id ? 'var(--gold)' : 'var(--text-muted)',
                cursor: 'pointer',
                fontFamily: 'inherit',
                fontSize: 12,
                fontWeight: 600,
                whiteSpace: 'nowrap',
                transition: 'all 0.15s',
              }}
            >
              {team.short}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
