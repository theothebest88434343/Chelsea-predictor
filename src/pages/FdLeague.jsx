import { useState, memo } from 'react';
import { useParams } from 'react-router-dom';
import { useFetch } from '../hooks/useFetch';
import { getLeague } from '../utils/leagues.jsx';
import { useFavouriteTeam, writeFavouriteTeam } from '../hooks/useFavouriteTeam';
import { TopScorers, LeagueStats, FormTable } from './FdStats';
import { ErrorCard } from '../components/ui/ErrorCard';
import { Crest }     from '../components/ui/Crest';

// ─── How Predictions Work (FD edition) ───────────────────────────────────────
// Same .hiw-* CSS pattern as League.jsx — wording adapted for non-PL leagues.
const HowItWorksPanel = memo(function HowItWorksPanel() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        className="hiw-toggle"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        aria-controls="hiw-panel-fd"
      >
        <span aria-hidden>ℹ️</span>
        How predictions work
        <span style={{ fontSize: 10, transition: 'transform 0.2s', display: 'inline-block',
          transform: open ? 'rotate(180deg)' : 'none' }} aria-hidden>▾</span>
      </button>
      {open && (
        <div id="hiw-panel-fd" className="hiw-panel" role="region" aria-label="How predictions work">
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: '0.05em', textTransform: 'uppercase' }}>
            Model methodology
          </div>
          <div className="hiw-grid">
            <div className="hiw-item">
              <div className="hiw-label">⚡ Team strength</div>
              <div className="hiw-desc">ELO ratings updated after each result, weighted by opponent quality and recency.</div>
            </div>
            <div className="hiw-item">
              <div className="hiw-label">📈 Recent form</div>
              <div className="hiw-desc">Last 5–10 results nudge expected goals by up to ±5%, capturing in-season momentum.</div>
            </div>
            <div className="hiw-item">
              <div className="hiw-label">🎯 Goals model</div>
              <div className="hiw-desc">Attack &amp; defence ratings produce expected goals (λ). Poisson + Dixon-Coles gives full scoreline probabilities.</div>
            </div>
            <div className="hiw-item">
              <div className="hiw-label">🔄 Season projection</div>
              <div className="hiw-desc">Every remaining fixture simulated using the model. "Proj." = median expected final total.</div>
            </div>
          </div>
          <div style={{ marginTop: 10, fontSize: 10, color: '#374151', fontStyle: 'italic' }}>
            For entertainment only · predictions update when new data arrives · data via football-data.org
          </div>
        </div>
      )}
    </>
  );
});

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


// ─── Predicted table ──────────────────────────────────────────────────────────

function PredictedTable({ leagueId, favId }) {
  const { data: rows, loading, error, refresh } = useFetch(`/api/fd/predicted-table?league=${leagueId}`);

  if (loading) return <div className="loading-card"><div className="spinner" /><div>Simulating season…</div></div>;
  if (error)   return <ErrorCard message={error} onRetry={refresh} />;
  if (!rows?.length) return null;

  const totalTeams = rows.length;

  return (
    <div className="card" style={{ padding: '12px 0' }}>
      <div style={{ padding: '0 12px 10px', fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>
        Projected final standings — current points + expected points from remaining fixtures using the prediction model.
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table className="league-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Team</th>
              <th style={{ textAlign: 'center' }}>Now</th>
              <th style={{ textAlign: 'center' }}>Left</th>
              <th style={{ textAlign: 'center' }}>+xPts</th>
              <th style={{ textAlign: 'center', color: 'var(--gold)' }}>Proj</th>
              <th style={{ textAlign: 'center' }}>Chg</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(team => {
              const isFav  = team.teamId === favId;
              const change = team.currentPos - team.projectedPosition;
              return (
                <tr key={team.teamId} className={isFav ? 'chelsea-row' : ''}>
                  <td>
                    <PositionBadge pos={team.projectedPosition} total={totalTeams} />
                  </td>
                  <td style={{ fontWeight: isFav ? 700 : 400 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <Crest src={team.crest} alt={team.shortName} size={18} />
                      <span style={{
                        color: isFav ? 'var(--gold)' : 'var(--text)', fontSize: 13,
                        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 110,
                      }}>
                        {team.shortName}
                      </span>
                      {isFav && <span style={{ fontSize: 10, color: 'var(--gold)' }}>★</span>}
                    </div>
                  </td>
                  <td style={{ textAlign: 'center', color: 'var(--text-muted)' }}>{team.points}</td>
                  <td style={{ textAlign: 'center', color: 'var(--text-muted)' }}>{team.gamesLeft}</td>
                  <td style={{ textAlign: 'center', color: 'var(--blue-light)' }}>+{team.xPts.toFixed(1)}</td>
                  <td style={{ textAlign: 'center', fontWeight: 700, color: isFav ? 'var(--gold)' : 'var(--text)' }}>
                    {team.projectedPoints.toFixed(1)}
                  </td>
                  <td style={{ textAlign: 'center' }}>
                    {change > 0
                      ? <span style={{ color: 'var(--green)',      fontSize: 11, fontWeight: 700 }}>▲{change}</span>
                      : change < 0
                      ? <span style={{ color: 'var(--red)',        fontSize: 11, fontWeight: 700 }}>▼{Math.abs(change)}</span>
                      : <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>—</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div style={{ padding: '10px 12px 0', fontSize: 11, color: 'var(--text-muted)' }}>
        Proj = current pts + model expected pts · Chg = vs current position · Data: football-data.org
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function FdLeague() {
  const { leagueId } = useParams();
  const league = getLeague(leagueId);

  const [tab,    setTab]    = useState('live');
  const [sortBy, setSortBy] = useState('points');

  // Read the current favourite from the shared key so it stays in sync with
  // FdHome and FdFixtures (all three now read/write the same 'favouriteTeam' key).
  const favTeam = useFavouriteTeam();
  const favId   = favTeam?.id ?? null;

  const { data: rows, loading, error, refresh } = useFetch(`/api/fd/standings?league=${leagueId}`);

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

      <div className="tab-row">
        <button className={`tab-btn${tab === 'live'      ? ' active' : ''}`} onClick={() => setTab('live')}>Table</button>
        <button className={`tab-btn${tab === 'predicted' ? ' active' : ''}`} onClick={() => setTab('predicted')}>Predicted</button>
        <button className={`tab-btn${tab === 'scorers'   ? ' active' : ''}`} onClick={() => setTab('scorers')}>Scorers</button>
        <button className={`tab-btn${tab === 'stats'     ? ' active' : ''}`} onClick={() => setTab('stats')}>Stats</button>
        <button className={`tab-btn${tab === 'form'      ? ' active' : ''}`} onClick={() => setTab('form')}>Form</button>
      </div>

      {/* Trust layer — same pattern as PL League.jsx */}
      <div style={{ marginBottom: 8 }}>
        <HowItWorksPanel />
      </div>

      {tab === 'predicted' && <PredictedTable leagueId={leagueId} favId={favId} />}
      {tab === 'scorers'   && <TopScorers  leagueId={leagueId} />}
      {tab === 'stats'     && <LeagueStats leagueId={leagueId} />}
      {tab === 'form'      && <FormTable   leagueId={leagueId} />}

      {tab === 'live' && loading && (
        <div className="loading-card">
          <div className="spinner" />
          <div>Loading {league.name} table…</div>
        </div>
      )}
      {tab === 'live' && error && <ErrorCard message={error} onRetry={refresh} />}

      {tab === 'live' && !loading && !error && rows && (
        <div className="card" style={{ padding: '12px 0', border: '1px solid rgba(255,255,255,0.08)' }}>
          {/* Sort controls */}
          <div style={{ display: 'flex', gap: 6, marginBottom: 10, paddingLeft: 8, flexWrap: 'wrap' }}>
            {sortBtn('points', 'Points')}
            {sortBtn('gf', 'Goals scored')}
            {sortBtn('ga', 'Goals conceded')}
          </div>

          <div style={{ overflowX: 'auto' }}>
            <table className="league-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Team</th>
                  <th style={{ textAlign: 'center', color: 'var(--gold)', fontWeight: 700 }}>Pts</th>
                  <th style={{ textAlign: 'center', opacity: 0.6 }}>P</th>
                  <th style={{ textAlign: 'center', opacity: 0.6 }}>W</th>
                  <th style={{ textAlign: 'center', opacity: 0.6 }}>D</th>
                  <th style={{ textAlign: 'center', opacity: 0.6 }}>L</th>
                  <th style={{ textAlign: 'center', opacity: sortBy === 'gf' ? 1 : 0.6, color: sortBy === 'gf' ? 'var(--gold)' : undefined }}>GF</th>
                  <th style={{ textAlign: 'center', opacity: sortBy === 'ga' ? 1 : 0.6, color: sortBy === 'ga' ? 'var(--gold)' : undefined }}>GA</th>
                  <th style={{ textAlign: 'center', opacity: 0.6 }}>GD</th>
                  {hasForm && <th style={{ textAlign: 'center', opacity: 0.6 }}>Form</th>}
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
                          <Crest src={team.crest} alt={team.shortName} size={18} />
                          <span style={{
                            color: isFav ? 'var(--gold)' : 'var(--text)', fontSize: 13,
                            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 130,
                          }}>
                            {team.shortName}
                          </span>
                          {team.position === 1 && sortBy === 'points' && (
                            <span style={{ fontSize: 12 }} title="League champions">🏆</span>
                          )}
                          {isFav && <span style={{ fontSize: 10, color: 'var(--gold)' }}>★</span>}
                        </div>
                      </td>
                      <td style={{ textAlign: 'center', fontWeight: 700, color: isFav ? 'var(--gold)' : 'var(--text)' }}>
                        {team.points}
                      </td>
                      <td style={{ textAlign: 'center', color: 'var(--text-muted)' }}>{team.played}</td>
                      <td style={{ textAlign: 'center', color: 'var(--green)' }}>{team.won}</td>
                      <td style={{ textAlign: 'center', color: 'var(--draw)' }}>{team.drawn}</td>
                      <td style={{ textAlign: 'center', color: 'var(--red)' }}>{team.lost}</td>
                      <td style={{
                        textAlign: 'center', fontWeight: sortBy === 'gf' ? 700 : 400,
                        color: sortBy === 'gf' ? 'var(--text)' : 'var(--text-muted)',
                      }}>{team.goalsFor}</td>
                      <td style={{
                        textAlign: 'center', fontWeight: sortBy === 'ga' ? 700 : 400,
                        color: sortBy === 'ga' ? 'var(--text)' : 'var(--text-muted)',
                      }}>{team.goalsAgainst}</td>
                      <td style={{ textAlign: 'center' }}>
                        <span style={{ color: team.gd >= 0 ? 'var(--green)' : 'var(--red)' }}>
                          {team.gd >= 0 ? '+' : ''}{team.gd}
                        </span>
                      </td>
                      {hasForm && <td style={{ textAlign: 'center' }}><FormDots form={team.form} /></td>}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div style={{
            padding: '8px 12px 4px', fontSize: 11, color: 'var(--text-muted)',
            borderTop: '1px solid rgba(255,255,255,0.07)', marginTop: 8,
          }}>
            <span style={{ color: 'var(--blue-light)', fontWeight: 700 }}>■</span> UCL &nbsp;
            <span style={{ color: 'var(--green)', fontWeight: 700 }}>■</span> UEL &nbsp;
            <span style={{ color: 'var(--red)', fontWeight: 700 }}>■</span> Rel.
            <span style={{ marginLeft: 10, opacity: 0.7 }}>Tap row to pin ★</span>
          </div>
        </div>
      )}
    </div>
  );
}
