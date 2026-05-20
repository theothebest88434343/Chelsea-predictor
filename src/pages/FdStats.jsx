import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useFetch } from '../hooks/useFetch';
import { getLeague } from '../utils/leagues.jsx';

// ─── Shared helpers ────────────────────────────────────────────────────────────

function Crest({ src, alt, size = 20 }) {
  if (!src) return <div style={{ width: size, height: size, flexShrink: 0 }} />;
  return (
    <img
      src={src} alt={alt}
      style={{ width: size, height: size, objectFit: 'contain', flexShrink: 0 }}
    />
  );
}

// Stat tile — matches PL Stats.jsx surface2 tile style
function StatTile({ value, label, color = 'var(--gold)', span = 1 }) {
  return (
    <div style={{
      background: 'var(--surface2)', borderRadius: 8, padding: '10px 8px',
      textAlign: 'center', gridColumn: span > 1 ? `span ${span}` : undefined,
    }}>
      <div style={{
        fontSize: 22, fontWeight: 700,
        fontFamily: 'Bebas Neue, sans-serif',
        color, letterSpacing: 1,
      }}>
        {value}
      </div>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 600, marginTop: 2, letterSpacing: 0.5 }}>
        {label}
      </div>
    </div>
  );
}

// Form dot — same size as FdLeague.jsx
function FormDot({ result }) {
  const color =
    result === 'W' ? 'var(--green)' :
    result === 'L' ? 'var(--red)'   :
                     'var(--draw)';
  return (
    <div style={{
      width: 18, height: 18, borderRadius: '50%',
      fontSize: 9, display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontWeight: 700, background: color, color: '#fff', flexShrink: 0,
    }}>
      {result}
    </div>
  );
}

// ─── Tab 1: Top Scorers ────────────────────────────────────────────────────────

export function TopScorers({ leagueId }) {
  const { data: scorers, loading, error } = useFetch(`/api/fd/scorers?league=${leagueId}`);

  if (loading) return (
    <div className="loading-card"><div className="spinner" /><div>Loading scorers…</div></div>
  );
  if (error) return <div className="error-card">Failed to load: {error}</div>;
  if (!scorers?.length) return <div className="card" style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 32 }}>No scorer data available.</div>;

  return (
    <div className="card" style={{ padding: 0 }}>
      {scorers.map((s, i) => (
        <div
          key={s.player.id}
          style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '12px 14px',
            borderBottom: i < scorers.length - 1 ? '1px solid var(--border)' : 'none',
          }}
        >
          {/* Rank */}
          <div style={{
            width: 24, textAlign: 'center', flexShrink: 0,
            fontFamily: 'Bebas Neue, sans-serif', fontSize: 18,
            color: s.rank <= 3 ? 'var(--gold)' : 'var(--text-muted)',
          }}>
            {s.rank}
          </div>

          {/* Crest */}
          <Crest src={s.team.crest} alt={s.team.shortName} size={22} />

          {/* Player + team */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 14, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {s.player.name}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1 }}>
              {s.team.shortName}
            </div>
          </div>

          {/* Goals */}
          <div style={{ textAlign: 'center', minWidth: 36 }}>
            <div style={{
              fontFamily: 'Bebas Neue, sans-serif', fontSize: 22,
              color: 'var(--gold)', letterSpacing: 1,
            }}>
              {s.goals}
            </div>
            <div style={{ fontSize: 9, color: 'var(--text-muted)', fontWeight: 600, letterSpacing: 0.5 }}>
              GOALS
            </div>
          </div>

          {/* Assists */}
          <div style={{ textAlign: 'center', minWidth: 36 }}>
            <div style={{
              fontFamily: 'Bebas Neue, sans-serif', fontSize: 22,
              color: 'var(--text-muted)', letterSpacing: 1,
            }}>
              {s.assists ?? '—'}
            </div>
            <div style={{ fontSize: 9, color: 'var(--text-muted)', fontWeight: 600, letterSpacing: 0.5 }}>
              AST
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Tab 2: League Stats ───────────────────────────────────────────────────────

export function LeagueStats({ leagueId }) {
  const { data: allMatches, loading, error } = useFetch(`/api/fd/matches?league=${leagueId}`);

  const stats = useMemo(() => {
    if (!allMatches) return null;
    const finished = allMatches.filter(m => m.finished && m.homeGoals != null);
    if (!finished.length) return null;

    const total     = finished.length;
    const homeWins  = finished.filter(m => m.homeGoals > m.awayGoals).length;
    const awayWins  = finished.filter(m => m.awayGoals > m.homeGoals).length;
    const draws     = finished.filter(m => m.homeGoals === m.awayGoals).length;
    const totalGoals = finished.reduce((s, m) => s + m.homeGoals + m.awayGoals, 0);

    // Per-team goals for/against
    const teamMap = new Map();
    const ensureTeam = (t) => {
      if (!teamMap.has(t.id)) teamMap.set(t.id, { ...t, gf: 0, ga: 0, played: 0 });
    };
    for (const m of finished) {
      ensureTeam(m.homeTeam);
      ensureTeam(m.awayTeam);
      const h = teamMap.get(m.homeTeam.id);
      const a = teamMap.get(m.awayTeam.id);
      h.gf += m.homeGoals; h.ga += m.awayGoals; h.played++;
      a.gf += m.awayGoals; a.ga += m.homeGoals; a.played++;
    }

    const teams = [...teamMap.values()].filter(t => t.played >= 5);
    const bestAttack  = teams.length ? [...teams].sort((a, b) => b.gf - a.gf)[0] : null;
    const bestDefense = teams.length ? [...teams].sort((a, b) => a.ga - b.ga)[0] : null;

    return {
      total,
      gpg:      (totalGoals / total).toFixed(2),
      homeWinPct: Math.round(homeWins / total * 100),
      awayWinPct: Math.round(awayWins / total * 100),
      drawPct:    Math.round(draws    / total * 100),
      totalGoals,
      bestAttack,
      bestDefense,
    };
  }, [allMatches]);

  if (loading) return (
    <div className="loading-card"><div className="spinner" /><div>Loading stats…</div></div>
  );
  if (error) return <div className="error-card">Failed to load: {error}</div>;
  if (!stats) return <div className="card" style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 32 }}>Not enough data yet.</div>;

  return (
    <>
      {/* Goals overview */}
      <div className="card">
        <div className="card-title">Goals</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
          <StatTile value={stats.gpg}        label="GOALS / GAME" />
          <StatTile value={stats.totalGoals} label="TOTAL GOALS"  color="var(--text)" />
          <StatTile value={stats.total}      label="GAMES PLAYED" color="var(--text-muted)" />
        </div>
      </div>

      {/* Outcome split */}
      <div className="card">
        <div className="card-title">Outcome split</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 10 }}>
          <StatTile value={`${stats.homeWinPct}%`} label="HOME WIN" color="var(--blue-light)" />
          <StatTile value={`${stats.drawPct}%`}    label="DRAW"     color="var(--draw)"       />
          <StatTile value={`${stats.awayWinPct}%`} label="AWAY WIN" color="var(--green)"      />
        </div>
        {/* Visual bar */}
        <div style={{ display: 'flex', borderRadius: 6, overflow: 'hidden', height: 8 }}>
          <div style={{ flex: stats.homeWinPct, background: 'var(--blue-light)' }} />
          <div style={{ flex: stats.drawPct,    background: 'var(--draw)'       }} />
          <div style={{ flex: stats.awayWinPct, background: 'var(--green)'      }} />
        </div>
      </div>

      {/* Best attack / defense */}
      {(stats.bestAttack || stats.bestDefense) && (
        <div className="card">
          <div className="card-title">Season leaders</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {stats.bestAttack && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 12px', background: 'var(--surface2)', borderRadius: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Crest src={stats.bestAttack.crest} alt={stats.bestAttack.shortName} size={22} />
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 14 }}>{stats.bestAttack.name}</div>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 600, letterSpacing: 0.5 }}>BEST ATTACK</div>
                  </div>
                </div>
                <div style={{ fontFamily: 'Bebas Neue, sans-serif', fontSize: 24, color: 'var(--gold)', letterSpacing: 1 }}>
                  {stats.bestAttack.gf} <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>GF</span>
                </div>
              </div>
            )}
            {stats.bestDefense && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 12px', background: 'var(--surface2)', borderRadius: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Crest src={stats.bestDefense.crest} alt={stats.bestDefense.shortName} size={22} />
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 14 }}>{stats.bestDefense.name}</div>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 600, letterSpacing: 0.5 }}>BEST DEFENCE</div>
                  </div>
                </div>
                <div style={{ fontFamily: 'Bebas Neue, sans-serif', fontSize: 24, color: 'var(--blue-light)', letterSpacing: 1 }}>
                  {stats.bestDefense.ga} <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>GA</span>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

// ─── Tab 3: Form Table ─────────────────────────────────────────────────────────

export function FormTable({ leagueId }) {
  const { data: allMatches, loading, error } = useFetch(`/api/fd/matches?league=${leagueId}`);

  const formRows = useMemo(() => {
    if (!allMatches) return [];
    const finished = allMatches.filter(m => m.finished && m.homeGoals != null);

    // Collect teams
    const teamMap = new Map();
    const ensureTeam = (t) => {
      if (!teamMap.has(t.id)) teamMap.set(t.id, { ...t, matches: [] });
    };
    for (const m of finished) {
      ensureTeam(m.homeTeam);
      ensureTeam(m.awayTeam);
      teamMap.get(m.homeTeam.id).matches.push({ date: m.kickoffTime, gf: m.homeGoals, ga: m.awayGoals });
      teamMap.get(m.awayTeam.id).matches.push({ date: m.kickoffTime, gf: m.awayGoals, ga: m.homeGoals });
    }

    return [...teamMap.values()]
      .map(t => {
        const recent = [...t.matches]
          .sort((a, b) => new Date(b.date) - new Date(a.date))
          .slice(0, 5);
        const results = recent.map(m =>
          m.gf > m.ga ? 'W' : m.gf < m.ga ? 'L' : 'D'
        );
        const pts = results.reduce((s, r) => s + (r === 'W' ? 3 : r === 'D' ? 1 : 0), 0);
        return { ...t, results, formPts: pts };
      })
      .sort((a, b) => b.formPts - a.formPts || b.results.filter(r => r === 'W').length - a.results.filter(r => r === 'W').length);
  }, [allMatches]);

  if (loading) return (
    <div className="loading-card"><div className="spinner" /><div>Loading form…</div></div>
  );
  if (error) return <div className="error-card">Failed to load: {error}</div>;
  if (!formRows.length) return <div className="card" style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 32 }}>No form data yet.</div>;

  return (
    <div className="card" style={{ padding: 0 }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center',
        padding: '10px 14px', borderBottom: '1px solid var(--border)',
        fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 0.8,
      }}>
        <div style={{ width: 24, flexShrink: 0 }}>#</div>
        <div style={{ flex: 1 }}>TEAM</div>
        <div style={{ display: 'flex', gap: 4, marginRight: 12 }}>
          {['', '', '', '', ''].map((_, i) => (
            <div key={i} style={{ width: 18, textAlign: 'center' }}>{5 - i}</div>
          ))}
        </div>
        <div style={{ width: 28, textAlign: 'right' }}>PTS</div>
      </div>

      {formRows.map((team, i) => (
        <div
          key={team.id}
          style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '10px 14px',
            borderBottom: i < formRows.length - 1 ? '1px solid var(--border)' : 'none',
          }}
        >
          {/* Rank */}
          <div style={{
            width: 24, flexShrink: 0, textAlign: 'center',
            fontSize: 12, fontWeight: 700,
            color: i < 3 ? 'var(--gold)' : 'var(--text-muted)',
          }}>
            {i + 1}
          </div>

          {/* Crest + name */}
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
            <Crest src={team.crest} alt={team.shortName} size={20} />
            <span style={{
              fontSize: 13, fontWeight: 600,
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}>
              {team.name}
            </span>
          </div>

          {/* Form dots — most recent rightmost */}
          <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
            {/* Pad to always show 5 slots */}
            {Array.from({ length: 5 }).map((_, idx) => {
              const r = team.results[4 - idx]; // oldest left, newest right
              return r
                ? <FormDot key={idx} result={r} />
                : <div key={idx} style={{ width: 18, height: 18, borderRadius: '50%', background: 'var(--surface2)' }} />;
            }).reverse()}
          </div>

          {/* Form points */}
          <div style={{
            width: 28, textAlign: 'right', flexShrink: 0,
            fontFamily: 'Bebas Neue, sans-serif', fontSize: 18,
            color: team.formPts >= 10 ? 'var(--gold)' : team.formPts >= 6 ? 'var(--text)' : 'var(--text-muted)',
          }}>
            {team.formPts}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function FdStats() {
  const { leagueId } = useParams();
  const league = getLeague(leagueId);
  const [tab, setTab] = useState('scorers');

  return (
    <div>
      <div className="section-title">{league.name} stats</div>

      <div className="tab-row">
        <button
          className={`tab-btn${tab === 'scorers' ? ' active' : ''}`}
          onClick={() => setTab('scorers')}
        >
          Top Scorers
        </button>
        <button
          className={`tab-btn${tab === 'league' ? ' active' : ''}`}
          onClick={() => setTab('league')}
        >
          League Stats
        </button>
        <button
          className={`tab-btn${tab === 'form' ? ' active' : ''}`}
          onClick={() => setTab('form')}
        >
          Form Table
        </button>
      </div>

      {tab === 'scorers' && <TopScorers leagueId={leagueId} />}
      {tab === 'league'  && <LeagueStats leagueId={leagueId} />}
      {tab === 'form'    && <FormTable leagueId={leagueId} />}

      <div style={{ textAlign: 'center', marginTop: 12, fontSize: 11, color: 'var(--text-muted)' }}>
        Data via football-data.org
      </div>
    </div>
  );
}
