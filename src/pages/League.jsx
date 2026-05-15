import { useState } from 'react';
import { useStandings, usePredictedTable } from '../hooks/useFixtures';
import { useFetch } from '../hooks/useFetch';
import ClubBadge from '../components/ClubBadge';

const CHELSEA_CODE = 8;

function PositionBadge({ pos }) {
  const color = pos <= 4 ? 'var(--blue-light)' : pos <= 6 ? 'var(--green)' : pos >= 18 ? 'var(--red)' : 'var(--text-muted)';
  return (
    <div className="pos-badge" style={{ background: `${color}22`, color, border: `1px solid ${color}44` }}>
      {pos}
    </div>
  );
}

function LiveTable({ rows, xptsMap, eloMap, isChelsea, sortBy, setSortBy }) {
  const sorted = [...rows].sort((a, b) => {
    if (sortBy === 'xpts') {
      const ax = xptsMap[a.id] ?? -1;
      const bx = xptsMap[b.id] ?? -1;
      return bx - ax || b.points - a.points;
    }
    return 0; // default order already sorted by points from API
  });

  return (
    <div style={{ overflowX: 'auto' }}>
      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        <button
          onClick={() => setSortBy('pts')}
          style={{
            padding: '4px 10px', borderRadius: 4, border: '1px solid var(--border)',
            background: sortBy === 'pts' ? 'var(--blue)' : 'transparent',
            color: sortBy === 'pts' ? '#fff' : 'var(--text-muted)',
            fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
          }}
        >Sort: Points</button>
        <button
          onClick={() => setSortBy('xpts')}
          style={{
            padding: '4px 10px', borderRadius: 4, border: '1px solid var(--border)',
            background: sortBy === 'xpts' ? 'var(--gold)' : 'transparent',
            color: sortBy === 'xpts' ? '#000' : 'var(--text-muted)',
            fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
          }}
        >Sort: xPts</button>
      </div>
      <table className="league-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Team</th>
            <th style={{ textAlign: 'center' }}>P</th>
            <th style={{ textAlign: 'center' }}>W</th>
            <th style={{ textAlign: 'center' }}>D</th>
            <th style={{ textAlign: 'center' }}>L</th>
            <th style={{ textAlign: 'center' }}>GD</th>
            <th style={{ textAlign: 'center' }}>Pts</th>
            <th style={{ textAlign: 'center', color: 'var(--gold)' }}>xPts</th>
            <th style={{ textAlign: 'center', color: 'var(--blue-light)' }}>ELO</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((team, i) => {
            const isCHE  = isChelsea(team);
            const xPts   = xptsMap[team.id];
            const elo    = eloMap[team.id];
            const xDiff  = xPts != null ? xPts - team.points : null;
            return (
              <tr key={team.id} className={isCHE ? 'chelsea-row' : ''}>
                <td><PositionBadge pos={i + 1} /></td>
                <td style={{ fontWeight: isCHE ? 700 : 400 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <ClubBadge code={team.code} short={team.short_name} size={18} />
                    <span style={{ color: isCHE ? 'var(--gold)' : 'var(--text)' }}>{team.name}</span>
                  </div>
                </td>
                <td style={{ textAlign: 'center', color: 'var(--text-muted)' }}>{team.played}</td>
                <td style={{ textAlign: 'center', color: 'var(--green)' }}>{team.won}</td>
                <td style={{ textAlign: 'center', color: 'var(--draw)' }}>{team.drawn}</td>
                <td style={{ textAlign: 'center', color: 'var(--red)' }}>{team.lost}</td>
                <td style={{ textAlign: 'center' }}>
                  <span style={{ color: team.gd >= 0 ? 'var(--green)' : 'var(--red)' }}>
                    {team.gd >= 0 ? '+' : ''}{team.gd}
                  </span>
                </td>
                <td style={{ textAlign: 'center', fontWeight: 700, color: isCHE ? 'var(--gold)' : 'var(--text)' }}>
                  {team.points}
                </td>
                <td style={{ textAlign: 'center' }}>
                  {xPts != null ? (
                    <span style={{ color: xDiff > 2 ? 'var(--green)' : xDiff < -2 ? 'var(--red)' : 'var(--text-muted)', fontWeight: 600 }}>
                      {Math.round(xPts)}
                    </span>
                  ) : '—'}
                </td>
                <td style={{ textAlign: 'center', color: 'var(--blue-light)', fontSize: 12 }}>
                  {elo != null ? elo : '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function PredTable({ rows, isChelsea }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="league-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Team</th>
            <th style={{ textAlign: 'center' }}>GD</th>
            <th style={{ textAlign: 'center' }}>Pts</th>
            <th style={{ textAlign: 'center', color: 'var(--gold)' }}>Proj.</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((team, i) => {
            const isCHE = isChelsea(team);
            return (
              <tr key={team.teamId} className={isCHE ? 'chelsea-row' : ''}>
                <td><PositionBadge pos={i + 1} /></td>
                <td style={{ fontWeight: isCHE ? 700 : 400 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <ClubBadge code={team.code} short={team.short} size={18} />
                    <span style={{ color: isCHE ? 'var(--gold)' : 'var(--text)' }}>{team.name}</span>
                  </div>
                </td>
                <td style={{ textAlign: 'center' }}>
                  <span style={{ color: (team.finalGD ?? 0) >= 0 ? 'var(--green)' : 'var(--red)' }}>
                    {team.finalGD != null ? (team.finalGD >= 0 ? '+' : '') + Math.round(team.finalGD) : '—'}
                  </span>
                </td>
                <td style={{ textAlign: 'center', color: 'var(--text-muted)' }}>{team.currentPoints ?? '—'}</td>
                <td style={{ textAlign: 'center', fontWeight: 700, color: isCHE ? 'var(--gold)' : 'var(--text)' }}>
                  {team.finalPoints != null ? Math.round(team.finalPoints) : '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function League() {
  const [view,   setView]   = useState('live');
  const [sortBy, setSortBy] = useState('pts');

  const { data: standings, loading: sLoading, error: sError } = useStandings();
  const { data: predicted, loading: pLoading, error: pError } = usePredictedTable();
  const { data: xptsData }  = useFetch('/api/xpts');
  const { data: eloData }   = useFetch('/api/elo-ratings');

  const isChelsea = t => t.code === CHELSEA_CODE || t.short === 'CHE';

  const xptsMap = {};
  for (const row of xptsData ?? []) xptsMap[row.teamId] = row.xPts;
  const eloMap = {};
  for (const row of eloData ?? []) eloMap[row.teamId] = row.elo;

  const loading = view === 'live' ? sLoading : pLoading;
  const error   = view === 'live' ? sError   : pError;

  return (
    <div>
      <div className="section-title">Premier League</div>

      <div className="tab-row">
        <button className={`tab-btn${view === 'live'      ? ' active' : ''}`} onClick={() => setView('live')}>Live table</button>
        <button className={`tab-btn${view === 'predicted' ? ' active' : ''}`} onClick={() => setView('predicted')}>Predicted</button>
      </div>

      {loading && <div className="loading-card"><div className="spinner" /><div>Loading table…</div></div>}
      {error   && <div className="error-card">{error}</div>}

      {!loading && !error && view === 'live' && standings && (
        <div className="card" style={{ padding: '12px 4px' }}>
          <LiveTable
            rows={standings}
            xptsMap={xptsMap}
            eloMap={eloMap}
            isChelsea={isChelsea}
            sortBy={sortBy}
            setSortBy={setSortBy}
          />
          <div style={{ padding: '8px 12px 0', fontSize: 11, color: 'var(--text-muted)' }}>
            <span style={{ color: 'var(--blue-light)', fontWeight: 700 }}>■</span> UCL &nbsp;
            <span style={{ color: 'var(--green)', fontWeight: 700 }}>■</span> UEL &nbsp;
            <span style={{ color: 'var(--red)', fontWeight: 700 }}>■</span> Relegation
            <span style={{ marginLeft: 12 }}>xPts: green = underperforming luck</span>
          </div>
        </div>
      )}

      {!loading && !error && view === 'predicted' && predicted && (
        <div className="card" style={{ padding: '12px 4px' }}>
          <div style={{ padding: '0 12px 8px', fontSize: 12, color: 'var(--text-muted)' }}>
            Fixture-by-fixture projection using Poisson + Dixon-Coles. "Proj." = predicted final points.
          </div>
          <PredTable rows={predicted} isChelsea={isChelsea} />
        </div>
      )}
    </div>
  );
}
