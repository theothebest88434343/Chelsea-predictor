import { useState } from 'react';
import { useFetch } from '../hooks/useFetch';
import ClubBadge from './ClubBadge';

export default function TeamSwitcher({ selectedId, onChange }) {
  const { data: teams, loading } = useFetch('/api/teams');
  const [query, setQuery] = useState('');

  if (loading) return <div style={{ height: 48 }} />;

  const filtered = (teams ?? []).filter(t =>
    query === '' ||
    t.name.toLowerCase().includes(query.toLowerCase()) ||
    t.short.toLowerCase().includes(query.toLowerCase())
  );

  return (
    <div>
      {/* Search box */}
      <input
        type="text"
        placeholder="Search team…"
        value={query}
        onChange={e => setQuery(e.target.value)}
        style={{
          width: '100%',
          boxSizing: 'border-box',
          padding: '8px 12px',
          borderRadius: 8,
          border: '1px solid var(--border)',
          background: 'var(--surface2)',
          color: 'var(--text)',
          fontSize: 13,
          fontFamily: 'inherit',
          marginBottom: 8,
          outline: 'none',
        }}
      />

      {/* Team grid */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(4, 1fr)',
        gap: 6,
      }}>
        {filtered.map(team => {
          const active = selectedId === team.id;
          return (
            <button
              key={team.id}
              onClick={() => onChange(team)}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 4,
                padding: '8px 4px',
                borderRadius: 8,
                border: '1px solid',
                borderColor: active ? 'var(--gold)' : 'var(--border)',
                background: active ? 'rgba(219,161,17,0.12)' : 'var(--surface2)',
                cursor: 'pointer',
                fontFamily: 'inherit',
                transition: 'all 0.15s',
              }}
            >
              <ClubBadge code={team.code} short={team.short} size={24} />
              <span style={{
                fontSize: 10,
                fontWeight: 600,
                color: active ? 'var(--gold)' : 'var(--text-muted)',
                letterSpacing: 0.3,
              }}>
                {team.short}
              </span>
            </button>
          );
        })}
      </div>

      {filtered.length === 0 && (
        <div style={{ fontSize: 13, color: 'var(--text-muted)', textAlign: 'center', padding: '12px 0' }}>
          No teams match "{query}"
        </div>
      )}
    </div>
  );
}
