import { useState, memo } from 'react';
import { useParams } from 'react-router-dom';
import { useStandings, usePredictedTable } from '../hooks/useFixtures';
import { useFetch } from '../hooks/useFetch';
import { useFavouriteTeam } from '../hooks/useFavouriteTeam';
import ClubBadge from '../components/ClubBadge';
import { ComingSoon } from '../utils/leagues.jsx';
import FdLeague from './FdLeague';
import { TopScorers, LeagueStats, FormTable } from './FdStats';
import { ErrorCard } from '../components/ui/ErrorCard';

// ─── How Predictions Work (League edition) ───────────────────────────────────
// Reuses the shared .hiw-* CSS classes from index.css.
// Wording is league-specific (no WC bracket simulations).
const HowItWorksPanel = memo(function HowItWorksPanel() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        className="hiw-toggle"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        aria-controls="hiw-panel-league"
      >
        <span aria-hidden>ℹ️</span>
        How predictions work
        <span style={{ fontSize: 10, transition: 'transform 0.2s', display: 'inline-block', transform: open ? 'rotate(180deg)' : 'none' }} aria-hidden>▾</span>
      </button>

      {open && (
        <div id="hiw-panel-league" className="hiw-panel" role="region" aria-label="How predictions work">
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: '0.05em', textTransform: 'uppercase' }}>
            Model methodology
          </div>
          <div className="hiw-grid">
            <div className="hiw-item">
              <div className="hiw-label">⚡ Team strength</div>
              <div className="hiw-desc">Live ELO ratings updated after every Premier League match, weighted by opponent quality and result recency.</div>
            </div>
            <div className="hiw-item">
              <div className="hiw-label">📈 Recent form</div>
              <div className="hiw-desc">Last 10 PL results nudge expected goals by up to ±5%, capturing in-season momentum without overfitting.</div>
            </div>
            <div className="hiw-item">
              <div className="hiw-label">🎯 Goals model</div>
              <div className="hiw-desc">Attack &amp; defence ratings produce expected goals (λ) per team. A Poisson distribution with Dixon-Coles correction converts these to full scoreline probabilities.</div>
            </div>
            <div className="hiw-item">
              <div className="hiw-label">🔄 Season projection</div>
              <div className="hiw-desc">Every remaining fixture is simulated using the model. "Proj." points are the median expected final total across all simulations.</div>
            </div>
          </div>
          <div style={{ marginTop: 10, fontSize: 10, color: '#374151', fontStyle: 'italic' }}>
            For entertainment only · predictions update when new data arrives
          </div>
        </div>
      )}
    </>
  );
});

// ─── Key Races Panel ─────────────────────────────────────────────────────────
// Derives position race status from the predicted table (E[pts] per team).
// No Monte Carlo simulation exists in the league backend, so we show points
// gaps rather than probabilities. Labels are calibrated on gap size only.
// All data comes from /api/predicted-table (rows sorted by finalPoints desc).

function raceLabel(gap, isRelegation) {
  if (isRelegation) {
    // gap = team.finalPoints - safetyThreshold
    if (gap >= 8)  return { text: 'Safe',       cls: 'chip-green' };
    if (gap >= 4)  return { text: 'Cushion',     cls: 'chip-green' };
    if (gap >= 1)  return { text: 'Tight',       cls: 'chip-gold'  };
    if (gap === 0) return { text: 'On the line', cls: 'chip-gold'  };
    if (gap >= -4) return { text: 'At risk',     cls: 'chip-muted' };
    return               { text: 'In danger',    cls: 'chip-muted' };
  } else {
    // gap = team.finalPoints - thresholdPts (threshold = last qualifying team)
    if (gap >= 6)  return { text: 'Likely',      cls: 'chip-green' };
    if (gap >= 1)  return { text: 'In position', cls: 'chip-green' };
    if (gap === 0) return { text: 'On the line', cls: 'chip-gold'  };
    if (gap >= -5) return { text: 'Possible',    cls: 'chip-gold'  };
    return               { text: 'Fading',       cls: 'chip-muted' };
  }
}

function RaceSection({ title, teams, thresholdPts, isRelegation }) {
  if (!teams?.length) return null;
  const pts    = teams.map(t => t.finalPoints);
  const maxPts = Math.max(...pts, thresholdPts + 1);
  const minPts = Math.min(...pts, thresholdPts - 1);
  const span   = maxPts - minPts || 1;

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: '0.08em',
                    textTransform: 'uppercase', marginBottom: 8 }}>
        {title}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {teams.map(team => {
          const gap    = team.finalPoints - thresholdPts;
          const barPct = Math.round(((team.finalPoints - minPts) / span) * 100);
          const { text: labelText, cls: labelCls } = raceLabel(Math.round(gap), isRelegation);
          const barColor = labelCls === 'chip-green' ? 'var(--green)'
                         : labelCls === 'chip-gold'  ? 'var(--gold)'
                         : 'rgba(255,255,255,0.18)';
          return (
            <div key={team.teamId} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <ClubBadge code={team.code} short={team.short} size={18} />
              <span style={{ fontSize: 12, color: 'var(--text)', width: 88, flexShrink: 0,
                             overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {team.name}
              </span>
              <div style={{ flex: 1, height: 5, background: 'var(--surface2)', borderRadius: 3, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${barPct}%`, background: barColor, borderRadius: 3,
                              transition: 'width 0.35s cubic-bezier(0.4,0,0.2,1)' }} />
              </div>
              <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text)', width: 24, textAlign: 'right', flexShrink: 0 }}>
                {Math.round(team.finalPoints)}
              </span>
              <span className={`chip ${labelCls}`} style={{ fontSize: 9, flexShrink: 0 }}>
                {labelText}
              </span>
            </div>
          );
        })}
      </div>
      <div style={{ fontSize: 9, color: 'var(--text-muted)', opacity: 0.55, marginTop: 5, paddingLeft: 24 }}>
        Threshold: ~{Math.round(thresholdPts)} pts projected
      </div>
    </div>
  );
}

const KeyRacesPanel = memo(function KeyRacesPanel({ rows }) {
  if (!rows?.length || rows.length < 10) return null;

  const n       = rows.length;
  const cl4Pts  = rows[Math.min(3, n - 1)]?.finalPoints ?? 0;
  const eur6Pts = rows[Math.min(5, n - 1)]?.finalPoints ?? 0;
  const safePts = rows[Math.max(n - 4, 0)]?.finalPoints ?? 0; // 17th place (last safe)

  // Teams within range of each threshold — capped at 6 for readability
  const clTeams  = rows.slice(0, Math.min(7, n)).filter(t => t.finalPoints >= cl4Pts - 9);
  const eurTeams = rows.slice(2, Math.min(10, n)).filter(t => t.finalPoints >= eur6Pts - 9);
  const relTeams = rows.slice(Math.max(n - 7, 0)).filter(t => t.finalPoints <= safePts + 9);

  return (
    <div style={{ padding: '14px 16px 4px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 14 }}>
        <span aria-hidden>🏁</span>
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 1, textTransform: 'uppercase' }}>
          Key Races
        </span>
        <span style={{ fontSize: 10, color: 'var(--text-muted)', opacity: 0.6 }}>· based on projected points</span>
      </div>
      <RaceSection title="🔵 Champions League (Top 4)" teams={clTeams}  thresholdPts={cl4Pts}  isRelegation={false} />
      <RaceSection title="🟡 European Football (Top 6)"  teams={eurTeams} thresholdPts={eur6Pts} isRelegation={false} />
      <RaceSection title="🔴 Relegation Battle"           teams={relTeams} thresholdPts={safePts} isRelegation={true}  />
    </div>
  );
});

function PositionBadge({ pos }) {
  const color = pos <= 4 ? 'var(--blue-light)' : pos <= 6 ? 'var(--green)' : pos >= 18 ? 'var(--red)' : 'var(--text-muted)';
  return (
    <div className="pos-badge" style={{ background: `${color}22`, color, border: `1px solid ${color}44` }}>
      {pos}
    </div>
  );
}

// LiveTable — default view shows only the columns needed for a 3-second scan.
// Advanced columns (W/D/L, GD, ELO) revealed by showStats toggle.
function LiveTable({ rows, xptsMap, eloMap, isChelsea, sortBy, setSortBy }) {
  const sorted = [...rows].sort((a, b) => {
    if (sortBy === 'xpts') {
      const ax = xptsMap[a.id] ?? -1;
      const bx = xptsMap[b.id] ?? -1;
      return bx - ax || b.points - a.points;
    }
    return 0; // default order already sorted by points from API
  });

  // ELO bar scaling — O(n) for 20 teams, only used when showStats is true
  const eloVals  = sorted.map(t => eloMap[t.id]).filter(v => v != null);
  const minElo   = eloVals.length ? Math.min(...eloVals) : 0;
  const maxElo   = eloVals.length ? Math.max(...eloVals) : 1;
  const eloSpan  = maxElo - minElo || 1;

  return (
    <div style={{ overflowX: 'auto' }}>
      <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap', alignItems: 'center' }}>
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
            background: sortBy === 'xpts' ? 'rgba(219,161,17,0.15)' : 'transparent',
            color: sortBy === 'xpts' ? 'var(--gold)' : 'var(--text-muted)',
            fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
            opacity: sortBy === 'xpts' ? 1 : 0.7,
          }}
        >Sort: xPts</button>
      </div>
      <table className="league-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Team</th>
            <th style={{ textAlign: 'center', fontWeight: 700 }}>Pts</th>
            <th style={{ textAlign: 'center', color: 'var(--gold)', opacity: 0.75 }}>xPts</th>
            <th style={{ textAlign: 'center', opacity: 0.6 }}>P</th>
            <th style={{ textAlign: 'center', opacity: 0.6 }}>W</th>
            <th style={{ textAlign: 'center', opacity: 0.6 }}>D</th>
            <th style={{ textAlign: 'center', opacity: 0.6 }}>L</th>
            <th style={{ textAlign: 'center', opacity: 0.6 }}>GD</th>
            <th style={{ textAlign: 'center', color: 'var(--text-muted)', opacity: 0.45 }}>ELO</th>
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
                <td style={{ textAlign: 'center', fontWeight: 700, color: isCHE ? 'var(--gold)' : 'var(--text)' }}>
                  {team.points}
                </td>
                <td style={{ textAlign: 'center' }}>
                  {xPts != null ? (
                    <span
                      style={{ color: xDiff > 2 ? 'var(--green)' : xDiff < -2 ? 'var(--red)' : 'var(--text-muted)', fontWeight: 600 }}
                      title={
                        xDiff > 2  ? `Expected ${Math.round(xPts)} pts — ${team.name} are underperforming their xG (unlucky)` :
                        xDiff < -2 ? `Expected ${Math.round(xPts)} pts — ${team.name} are overperforming their xG (fortunate)` :
                                     `Expected ${Math.round(xPts)} pts — roughly in line with xG`
                      }
                    >
                      {Math.round(xPts)}
                    </span>
                  ) : '—'}
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
                <td style={{ textAlign: 'center' }}>
                  {elo != null ? (
                    <div title={`ELO: ${elo}`}
                         style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <div style={{ width: 36, height: 4, background: 'var(--surface2)', borderRadius: 2, overflow: 'hidden' }}>
                        <div style={{
                          height: '100%',
                          width: `${Math.round(((elo - minElo) / eloSpan) * 100)}%`,
                          background: 'rgba(255,255,255,0.3)', borderRadius: 2,
                        }} />
                      </div>
                    </div>
                  ) : '—'}
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
                <td style={{ textAlign: 'center' }}>
                  {team.finalPoints != null ? (() => {
                    const main = Math.round(team.finalPoints);
                    // Uncertainty only in projected extra — current pts are fixed
                    const extra = team.projectedExtra ?? 0;
                    const low   = Math.round(team.currentPoints + extra * 0.95);
                    const high  = Math.round(team.currentPoints + extra * 1.05);
                    return (
                      <div>
                        <div style={{ fontWeight: 700, color: isCHE ? 'var(--gold)' : 'var(--text)' }}>
                          {main}
                        </div>
                        {low !== high && (
                          <div style={{ fontSize: 9, color: 'var(--text-muted)', opacity: 0.45, marginTop: 1, fontWeight: 400 }}
                               title="Low–high range: ±5% on projected additional points">
                            {low}–{high}
                          </div>
                        )}
                      </div>
                    );
                  })() : '—'}
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
  const { leagueId } = useParams();
  const favTeam = useFavouriteTeam();
  const [view,       setView]       = useState('live');
  const [sortBy,     setSortBy]     = useState('pts');
  const [showRaces,  setShowRaces]  = useState(false);


  const { data: standings, loading: sLoading, error: sError, refresh: sRefresh } = useStandings();
  const { data: predicted, loading: pLoading, error: pError, refresh: pRefresh } = usePredictedTable();
  const { data: xptsData }  = useFetch('/api/xpts');
  const { data: eloData }   = useFetch('/api/elo-ratings');

  if (leagueId !== 'premier-league') return <FdLeague />;

  const isChelsea = t => t.code === favTeam.code || t.short === favTeam.short;

  const xptsMap = {};
  for (const row of xptsData ?? []) xptsMap[row.teamId] = row.xPts;
  const eloMap = {};
  for (const row of eloData ?? []) eloMap[row.teamId] = row.elo;

  const loading = view === 'live' ? sLoading : pLoading;
  const error   = view === 'live' ? sError   : pError;
  const refresh = view === 'live' ? sRefresh  : pRefresh;

  return (
    <div>
      <div className="section-title">Premier League</div>

      <div className="tab-row">
        <button className={`tab-btn${view === 'live'      ? ' active' : ''}`} onClick={() => setView('live')}>Table</button>
        <button className={`tab-btn${view === 'predicted' ? ' active' : ''}`} onClick={() => setView('predicted')}>Predicted</button>
        <button className={`tab-btn${view === 'scorers'   ? ' active' : ''}`} onClick={() => setView('scorers')}>Scorers</button>
        <button className={`tab-btn${view === 'stats'     ? ' active' : ''}`} onClick={() => setView('stats')}>Stats</button>
        <button className={`tab-btn${view === 'form'      ? ' active' : ''}`} onClick={() => setView('form')}>Form</button>
      </div>

      {/* Trust layer — same pattern as WC system, league-specific wording */}
      <div style={{ marginBottom: 8 }}>
        <HowItWorksPanel />
      </div>

      {loading && <div className="loading-card"><div className="spinner" /><div>Loading table…</div></div>}
      {error   && <ErrorCard message={error} onRetry={refresh} />}

      {!loading && !error && view === 'live' && standings && (
        <div className="card" style={{ padding: '12px 4px', border: '1px solid rgba(255,255,255,0.08)' }}>
          <LiveTable
            rows={standings}
            xptsMap={xptsMap}
            eloMap={eloMap}
            isChelsea={isChelsea}
            sortBy={sortBy}
            setSortBy={setSortBy}
          />
          {/* Legend + stats toggle — combined into one footer row */}
          <div style={{
            padding: '8px 12px 4px', fontSize: 11, color: 'var(--text-muted)',
            borderTop: '1px solid rgba(255,255,255,0.07)', marginTop: 8,
          }}>
            <span style={{ color: 'var(--blue-light)', fontWeight: 700 }}>■</span> UCL &nbsp;
            <span style={{ color: 'var(--green)', fontWeight: 700 }}>■</span> UEL &nbsp;
            <span style={{ color: 'var(--red)', fontWeight: 700 }}>■</span> Rel. &nbsp;
            <span style={{ opacity: 0.6 }}>xPts: <span style={{ color: 'var(--green)' }}>green = unlucky</span> · <span style={{ color: 'var(--red)' }}>red = fortunate</span></span>
          </div>
        </div>
      )}

      {!loading && !error && view === 'predicted' && predicted && (
        <>
          <div className="card" style={{ padding: '12px 4px', border: '1px solid rgba(255,255,255,0.08)' }}>
            <div style={{ padding: '0 12px 8px', fontSize: 11, color: 'var(--text-muted)', opacity: 0.7 }}>
              Fixture-by-fixture projection using Poisson + Dixon-Coles. "Proj." = predicted final points · range = ±5% on remaining games.
            </div>
            <PredTable rows={predicted} isChelsea={isChelsea} />
          </div>
          {/* Position race tracker — collapsible, default collapsed */}
          <div className="card" style={{ padding: 0, marginTop: 10, overflow: 'hidden' }}>
            <button
              onClick={() => setShowRaces(r => !r)}
              aria-expanded={showRaces}
              style={{
                width: '100%', display: 'flex', alignItems: 'center',
                justifyContent: 'space-between', padding: '11px 14px',
                background: 'transparent', border: 'none',
                color: showRaces ? 'var(--text)' : 'var(--text-muted)',
                cursor: 'pointer', fontFamily: 'inherit',
                fontSize: 12, fontWeight: 600, transition: 'color 0.15s',
              }}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span aria-hidden>🏁</span>
                {showRaces ? 'Hide season outlook' : 'Show season outlook'}
              </span>
              <span style={{ fontSize: 10, opacity: 0.5, transition: 'transform 0.2s', display: 'inline-block',
                             transform: showRaces ? 'rotate(180deg)' : 'none' }} aria-hidden>▾</span>
            </button>
            {showRaces && (
              <div style={{ borderTop: '1px solid rgba(255,255,255,0.07)' }}>
                <KeyRacesPanel rows={predicted} />
              </div>
            )}
          </div>
        </>
      )}

      {view === 'scorers' && <TopScorers  leagueId="premier-league" />}
      {view === 'stats'   && <LeagueStats leagueId="premier-league" />}
      {view === 'form'    && <FormTable   leagueId="premier-league" />}
    </div>
  );
}
