import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useFetch } from '../hooks/useFetch';
import { getLeague } from '../utils/leagues.jsx';
import { useFavouriteTeam, writeFavouriteTeam } from '../hooks/useFavouriteTeam';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function PositionBadge({ pos, total }) {
  const color =
    pos <= 4         ? 'var(--blue-light)' :
    pos === 5        ? 'var(--green)'       :
    pos >= total - 2 ? 'var(--red)'         :
                       'var(--text-muted)';
  return (
    <div className="pos-badge" style={{ background: `${color}22`, color, border: `1px solid ${color}44` }}>
      {pos}
    </div>
  );
}

function FormDots({ form }) {
  if (!form) return null;
  const results = form.replace(/,/g, '').split('').filter(c => /[WDL]/.test(c));
  return (
    <div style={{ display: 'flex', gap: 2 }}>
      {results.slice(-5).map((r, i) => (
        <div key={i} style={{
          width: 14, height: 14, borderRadius: '50%', fontSize: 8,
          display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700,
          background: r === 'W' ? 'var(--green)' : r === 'L' ? 'var(--red)' : 'var(--draw)',
          color: '#fff',
        }}>
          {r}
        </div>
      ))}
    </div>
  );
}


// ─── Page ─────────────────────────────────────────────────────────────────────

export default function FdLeague() {
  const { leagueId } = useParams();
  const league = getLeague(leagueId);

  const [sortBy, setSortBy] = useState('points');

  // Read the current favourite from the shared key so it stays in sync with
  // FdHome and FdFixtures (all three now read/write the same 'favouriteTeam' key).
  const favTeam = useFavouriteTeam();
  const favId   = favTeam?.id ?? null;

  const { data: rows, loading, error } = useFetch(`/api/fd/standings?league=${leagueId}`);

  function toggleFav(teamId) {
    if (favId === teamId) {
      // Unpin — clear the shared favourite
      writeFavouriteTeam(null);
    } else {
      // Pin — write the full team object so FdHome / FdFixtures can use it
      const row = (rows ?? []).find(r => r.teamId === teamId);
      if (row) {
        writeFavouriteTeam({
          id:    row.teamId,
          name:  row.name,
          short: row.shortName,
          code:  null,          // non-PL teams have no FPL code
          crest: row.crest ?? null,
        });
      }
    }
  }

  const sorted = rows ? [...rows].sort((a, b) => {
    if (sortBy === 'gf') return b.goalsFor - a.goalsFor;
    if (sortBy === 'ga') return a.goalsAgainst - b.goalsAgainst;
    return 0; // 'points' — server already returns sorted by points
  }) : [];

  // Only show Form column if the API returned form data for at least one team
  const hasForm = sorted.some(t => t.form);

  const sortBtn = (key, label) => (
    <button
      onClick={() => setSortBy(key)}
      style={{
        padding: '4px 10px', borderRadius: 4, border: '1px solid var(--border)',
        background: sortBy === key ? 'var(--blue)' : 'transparent',
        color: sortBy === key ? '#fff' : 'var(--text-muted)',
        fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
      }}
    >
      {label}
    </button>
  );

  return (
    <div>
      <div className="section-title">{league.name} table</div>

      {loading && (
        <div className="loading-card">
          <div className="spinner" />
          <div>Loading {league.name} table…</div>
        </div>
      )}
      {error && <div className="error-card">Failed to load standings: {error}</div>}

      {!loading && !error && rows && (
        <div className="card" style={{ padding: '12px 4px' }}>
          {/* Sort controls */}
          <div style={{ display: 'flex', gap: 6, marginBottom: 10, paddingLeft: 8 }}>
            {sortBtn('points', 'Points')}
            {sortBtn('gf',     'Goals scored')}
            {sortBtn('ga',     'Goals conceded')}
          </div>

          <div style={{ overflowX: 'auto' }}>
            <table className="league-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Team</th>
                  <th style={{ textAlign: 'center' }}>P</th>
                  <th style={{ textAlign: 'center' }}>W</th>
                  <th style={{ textAlign: 'center' }}>D</th>
                  <th style={{ textAlign: 'center' }}>L</th>
                  <th style={{ textAlign: 'center', color: sortBy === 'gf' ? 'var(--gold)' : undefined }}>GF</th>
                  <th style={{ textAlign: 'center', color: sortBy === 'ga' ? 'var(--gold)' : undefined }}>GA</th>
                  <th style={{ textAlign: 'center' }}>GD</th>
                  <th style={{ textAlign: 'center', color: sortBy === 'points' ? 'var(--gold)' : undefined }}>Pts</th>
                  {hasForm && <th style={{ textAlign: 'center' }}>Form</th>}
                </tr>
              </thead>
              <tbody>
                {sorted.map((team, i) => {
                  const isFav = team.teamId === favId;
                  return (
                    <tr
                      key={team.teamId}
                      className={isFav ? 'chelsea-row' : ''}
                      onClick={() => toggleFav(team.teamId)}
                      style={{ cursor: 'pointer' }}
                      title={isFav ? 'Click to unpin' : 'Click to pin as your team'}
                    >
                      <td>
                        <PositionBadge
                          pos={sortBy === 'points' ? team.position : i + 1}
                          total={sorted.length}
                        />
                      </td>
                      <td style={{ fontWeight: isFav ? 700 : 400 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          {team.crest && (
                            <img
                              src={team.crest}
                              alt={team.shortName}
                              style={{ width: 18, height: 18, objectFit: 'contain', flexShrink: 0 }}
                            />
                          )}
                          <span style={{
                            color: isFav ? 'var(--gold)' : 'var(--text)', fontSize: 13,
                            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 130,
                          }}>
                            {team.shortName}
                          </span>
                          {isFav && <span style={{ fontSize: 10, color: 'var(--gold)' }}>★</span>}
                        </div>
                      </td>
                      <td style={{ textAlign: 'center', color: 'var(--text-muted)' }}>{team.played}</td>
                      <td style={{ textAlign: 'center', color: 'var(--green)' }}>{team.won}</td>
                      <td style={{ textAlign: 'center', color: 'var(--draw)' }}>{team.drawn}</td>
                      <td style={{ textAlign: 'center', color: 'var(--red)' }}>{team.lost}</td>
                      <td style={{
                        textAlign: 'center',
                        fontWeight: sortBy === 'gf' ? 700 : 400,
                        color: sortBy === 'gf' ? 'var(--text)' : 'var(--text-muted)',
                      }}>
                        {team.goalsFor}
                      </td>
                      <td style={{
                        textAlign: 'center',
                        fontWeight: sortBy === 'ga' ? 700 : 400,
                        color: sortBy === 'ga' ? 'var(--text)' : 'var(--text-muted)',
                      }}>
                        {team.goalsAgainst}
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        <span style={{ color: team.gd >= 0 ? 'var(--green)' : 'var(--red)' }}>
                          {team.gd >= 0 ? '+' : ''}{team.gd}
                        </span>
                      </td>
                      <td style={{
                        textAlign: 'center', fontWeight: 700,
                        color: isFav ? 'var(--gold)' : 'var(--text)',
                      }}>
                        {team.points}
                      </td>
                      {hasForm && <td style={{ textAlign: 'center' }}><FormDots form={team.form} /></td>}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div style={{ padding: '10px 12px 0', fontSize: 11, color: 'var(--text-muted)' }}>
            <span style={{ color: 'var(--blue-light)', fontWeight: 700 }}>■</span> UCL &nbsp;
            <span style={{ color: 'var(--green)', fontWeight: 700 }}>■</span> UEL/Europa &nbsp;
            <span style={{ color: 'var(--red)', fontWeight: 700 }}>■</span> Relegation
            <span style={{ marginLeft: 12 }}>Tap a team to pin ★ · Data: football-data.org</span>
          </div>
        </div>
      )}
    </div>
  );
}
