import { useState, useEffect } from 'react';
import { format, parseISO } from 'date-fns';

// ─── Flag map ─────────────────────────────────────────────────────────────────

const FLAGS = {
  // Group A
  'Mexico':                  '🇲🇽', 'South Africa':          '🇿🇦',
  'South Korea':             '🇰🇷', 'Korea Republic':        '🇰🇷',
  'Czech Republic':          '🇨🇿',
  // Group B
  'Canada':                  '🇨🇦', 'Bosnia & Herzegovina':  '🇧🇦',
  'Qatar':                   '🇶🇦', 'Switzerland':           '🇨🇭',
  // Group C
  'Brazil':                  '🇧🇷', 'Morocco':               '🇲🇦',
  'Haiti':                   '🇭🇹', 'Scotland':              '🏴󠁧󠁢󠁳󠁣󠁴󠁿',
  // Group D
  'United States':           '🇺🇸', 'USA':                   '🇺🇸',
  'Paraguay':                '🇵🇾', 'Australia':             '🇦🇺',
  'Turkey':                  '🇹🇷',
  // Group E
  'Germany':                 '🇩🇪', 'Curaçao':               '🇨🇼',
  "Côte d'Ivoire":           '🇨🇮', 'Ivory Coast':           '🇨🇮',
  'Ecuador':                 '🇪🇨',
  // Group F
  'Netherlands':             '🇳🇱', 'Japan':                 '🇯🇵',
  'Sweden':                  '🇸🇪', 'Tunisia':               '🇹🇳',
  // Group G
  'Belgium':                 '🇧🇪', 'Egypt':                 '🇪🇬',
  'Iran':                    '🇮🇷', 'New Zealand':           '🇳🇿',
  // Group H
  'Spain':                   '🇪🇸', 'Cabo Verde':            '🇨🇻',
  'Saudi Arabia':            '🇸🇦', 'Uruguay':               '🇺🇾',
  // Group I
  'France':                  '🇫🇷', 'Senegal':               '🇸🇳',
  'Iraq':                    '🇮🇶', 'Norway':                '🇳🇴',
  // Group J
  'Argentina':               '🇦🇷', 'Algeria':               '🇩🇿',
  'Austria':                 '🇦🇹', 'Jordan':                '🇯🇴',
  // Group K
  'Portugal':                '🇵🇹', 'DR Congo':              '🇨🇩',
  'Uzbekistan':              '🇺🇿', 'Colombia':              '🇨🇴',
  // Group L
  'England':                 '🏴󠁧󠁢󠁥󠁮󠁧󠁿', 'Croatia':               '🇭🇷',
  'Ghana':                   '🇬🇭', 'Panama':                '🇵🇦',
};

function flag(name) {
  if (FLAGS[name]) return FLAGS[name];
  const key = Object.keys(FLAGS).find(k => name?.toLowerCase().includes(k.toLowerCase()));
  return key ? FLAGS[key] : '🏳️';
}


// Format ISO UTC kickoff string → "11 Jun · 19:00 UTC"  (always UTC, never local time)
function fmtKickoffUTC(iso) {
  if (!iso) return null;
  const [datePart, timePart] = iso.split('T');
  const [, mm, dd] = datePart.split('-');
  const MONTHS = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const hhmm = timePart.slice(0, 5);
  return `${parseInt(dd)} ${MONTHS[parseInt(mm)]} · ${hhmm} UTC`;
}

// One accent colour per group A–L
const GROUP_COLORS = {
  A: '#3b82f6', // blue
  B: '#10b981', // emerald
  C: '#f59e0b', // amber
  D: '#ef4444', // red
  E: '#8b5cf6', // violet
  F: '#06b6d4', // cyan
  G: '#f97316', // orange
  H: '#ec4899', // pink
  I: '#84cc16', // lime
  J: '#14b8a6', // teal
  K: '#a855f7', // purple
  L: '#fb923c', // light-orange
};

// ─── Data fetching ────────────────────────────────────────────────────────────

function useWCTournament() {
  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    fetch('/api/wc/tournament', { signal: controller.signal })
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(d => { setData(d); setLoading(false); })
      .catch(err => {
        if (err.name !== 'AbortError') { setError(err.message); setLoading(false); }
      });
    return () => controller.abort();
  }, []);

  return { data, loading, error };
}

function useFormData(team) {
  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!team) { setData(null); return; }
    setLoading(true); setData(null);
    const ctrl = new AbortController();
    fetch(`/api/wc/form/${encodeURIComponent(team)}`, { signal: ctrl.signal })
      .then(r => r.json())
      .then(d => { setData(d.form); setLoading(false); })
      .catch(() => setLoading(false));
    return () => ctrl.abort();
  }, [team]);
  return { data, loading };
}

function useEloRankings() {
  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    setLoading(true);
    fetch('/api/wc/elo-rankings')
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);
  return { data, loading };
}

function useH2HData(home, away, enabled) {
  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!enabled || !home || !away) { setData(null); return; }
    setLoading(true); setData(null);
    const ctrl = new AbortController();
    fetch(`/api/wc/h2h?home=${encodeURIComponent(home)}&away=${encodeURIComponent(away)}`, { signal: ctrl.signal })
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
    return () => ctrl.abort();
  }, [home, away, enabled]);
  return { data, loading };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const PHASE_LABELS = {
  PRE_TOURNAMENT: 'Pre-Tournament',
  GROUP_STAGE:    'Group Stage',
  ROUND_OF_32:    'Round of 32',
  ROUND_OF_16:    'Round of 16',
  QUARTER_FINALS: 'Quarter-Finals',
  SEMI_FINALS:    'Semi-Finals',
  FINAL:          'Final',
  COMPLETE:       'Complete',
};

function outcomeColor(status, homeGoals, awayGoals, perspective) {
  if (!['FT','AET','PEN'].includes(status)) return 'var(--text-muted)';
  const h = parseInt(homeGoals, 10);
  const a = parseInt(awayGoals, 10);
  if (isNaN(h) || isNaN(a)) return 'var(--text-muted)';
  if (perspective === 'home') {
    if (h > a) return 'var(--green)';
    if (h < a) return 'var(--red)';
    return 'var(--draw)';
  }
  if (a > h) return 'var(--green)';
  if (a < h) return 'var(--red)';
  return 'var(--draw)';
}

function fmtKickoff(ts) {
  if (!ts) return '';
  try { return format(typeof ts === 'number' ? new Date(ts * 1000) : parseISO(ts), 'd MMM HH:mm'); }
  catch { return ''; }
}

function pct(v) { return `${Math.round((v ?? 0) * 100)}%`; }

// ─── Sub-components ───────────────────────────────────────────────────────────

function PhaseBadge({ phase }) {
  return (
    <div style={{
      display:        'inline-flex',
      alignItems:     'center',
      gap:            6,
      background:     'var(--surface2)',
      border:         '1px solid var(--gold)',
      borderRadius:   20,
      padding:        '4px 14px',
      fontSize:       11,
      fontWeight:     700,
      letterSpacing:  1,
      color:          'var(--gold)',
      marginBottom:   16,
    }}>
      🌍 {PHASE_LABELS[phase] ?? phase}
    </div>
  );
}

function StandingsTable({ rows }) {
  if (!rows?.length) return null;
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
      <thead>
        <tr style={{ color: 'var(--text-muted)', fontSize: 10 }}>
          <th style={{ textAlign: 'left',   padding: '3px 0',  fontWeight: 600 }}>#</th>
          <th style={{ textAlign: 'left',   padding: '3px 4px', fontWeight: 600 }}>Team</th>
          <th style={{ textAlign: 'center', padding: '3px 4px', fontWeight: 600 }}>P</th>
          <th style={{ textAlign: 'center', padding: '3px 4px', fontWeight: 600 }}>W</th>
          <th style={{ textAlign: 'center', padding: '3px 4px', fontWeight: 600 }}>D</th>
          <th style={{ textAlign: 'center', padding: '3px 4px', fontWeight: 600 }}>L</th>
          <th style={{ textAlign: 'center', padding: '3px 4px', fontWeight: 600 }}>GF</th>
          <th style={{ textAlign: 'center', padding: '3px 4px', fontWeight: 600 }}>GA</th>
          <th style={{ textAlign: 'center', padding: '3px 4px', fontWeight: 600 }}>GD</th>
          <th style={{ textAlign: 'center', padding: '3px 4px', fontWeight: 600 }}>Pts</th>
        </tr>
      </thead>
      <tbody>
        {rows.slice().sort((a, b) => b.points - a.points || b.gd - a.gd || b.gf - a.gf)
          .map((row, i) => (
          <tr key={row.team} style={{
            background: i < 2 ? 'rgba(255,215,0,0.06)' : i === 2 ? 'rgba(245,158,11,0.04)' : 'transparent',
            borderTop:  '1px solid var(--border)',
          }}>
            <td style={{ padding: '5px 0', color: i < 2 ? 'var(--gold)' : i === 2 ? '#f59e0b' : 'var(--text-muted)', fontWeight: 700 }}>
              {i + 1}
            </td>
            <td style={{ padding: '5px 4px', fontWeight: 600 }}>
              <span style={{ marginRight: 4 }}>{flag(row.team)}</span>{row.team}
              {i === 2 && (
                <span style={{ marginLeft: 5, fontSize: 8, fontWeight: 700, color: '#f59e0b', background: '#f59e0b22', border: '1px solid #f59e0b55', borderRadius: 3, padding: '1px 4px', verticalAlign: 'middle' }}>
                  3rd?
                </span>
              )}
            </td>
            <td style={{ padding: '5px 4px', textAlign: 'center', color: 'var(--text-muted)' }}>{row.played}</td>
            <td style={{ padding: '5px 4px', textAlign: 'center' }}>{row.won}</td>
            <td style={{ padding: '5px 4px', textAlign: 'center', color: 'var(--text-muted)' }}>{row.drawn}</td>
            <td style={{ padding: '5px 4px', textAlign: 'center', color: 'var(--text-muted)' }}>{row.lost}</td>
            <td style={{ padding: '5px 4px', textAlign: 'center' }}>{row.gf ?? 0}</td>
            <td style={{ padding: '5px 4px', textAlign: 'center', color: 'var(--text-muted)' }}>{row.ga ?? 0}</td>
            <td style={{ padding: '5px 4px', textAlign: 'center', color: row.gd > 0 ? 'var(--green)' : row.gd < 0 ? 'var(--red)' : 'var(--text-muted)' }}>
              {row.gd > 0 ? `+${row.gd}` : row.gd}
            </td>
            <td style={{ padding: '5px 4px', textAlign: 'center', fontWeight: 700, color: 'var(--gold)' }}>{row.points}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function MatchRow({ fixture }) {
  // Support both ESPN shape (_statusShort / date) and Football-API shape (fixture.fixture.status.short)
  const status   = fixture._statusShort ?? fixture.fixture?.status?.short ?? 'NS';
  const played   = ['FT','AET','PEN'].includes(status);
  const live     = ['LIVE','1H','HT','2H','ET','BT','P','INT'].includes(status);
  const home     = fixture.teams?.home?.name ?? '?';
  const away     = fixture.teams?.away?.name ?? '?';
  const hGoals   = fixture.goals?.home;
  const aGoals   = fixture.goals?.away;
  const pred     = fixture._prediction;
  const prePred  = fixture._prePrediction;   // frozen pre-tournament prediction
  const kickoff  = fixture.date ?? fixture.fixture?.date ?? fixture.fixture?.timestamp;

  // Determine if the pre-prediction was correct
  const predAccuracy = (() => {
    if (!prePred || !played || hGoals == null || aGoals == null) return null;
    const [ph, pa] = (prePred.predictedScore ?? '').split('-').map(Number);
    if (ph === hGoals && pa === aGoals) return 'score';   // exact scoreline
    const predWinner = ph > pa ? 'H' : ph < pa ? 'A' : 'D';
    const realWinner = hGoals > aGoals ? 'H' : hGoals < aGoals ? 'A' : 'D';
    if (predWinner === realWinner) return 'result';        // correct outcome
    return 'wrong';
  })();

  return (
    <div style={{
      padding:       '10px 0',
      borderBottom:  '1px solid var(--border)',
      display:       'flex',
      alignItems:    'center',
      gap:           8,
    }}>
      {/* Status pill */}
      <div style={{
        minWidth:   38,
        fontSize:   10,
        fontWeight: 700,
        textAlign:  'center',
        padding:    '2px 6px',
        borderRadius: 4,
        background: live ? 'rgba(255,60,60,0.15)' : played ? 'rgba(255,255,255,0.07)' : 'var(--surface2)',
        color:      live ? 'var(--red)' : played ? 'var(--text-muted)' : 'var(--text-muted)',
      }}>
        {live ? '🔴 LIVE' : played ? status : fmtKickoff(kickoff) || 'TBC'}
      </div>

      {/* Teams + score */}
      <div style={{ flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontWeight: 600, fontSize: 13, color: played ? outcomeColor(status, hGoals, aGoals, 'home') : 'inherit', display: 'flex', alignItems: 'center', gap: 4 }}>
            <span>{flag(home)}</span>{home}
          </span>

          {played ? (
            <span style={{ fontFamily: 'Bebas Neue, sans-serif', fontSize: 20, letterSpacing: 2, margin: '0 8px' }}>
              {hGoals} – {aGoals}
            </span>
          ) : pred ? (
            <span style={{ fontFamily: 'Bebas Neue, sans-serif', fontSize: 16, letterSpacing: 2, margin: '0 8px', color: 'var(--gold)' }}>
              {pred.predictedScore.replace('-', '–')}
            </span>
          ) : (
            <span style={{ margin: '0 8px', color: 'var(--text-muted)', fontSize: 14 }}>vs</span>
          )}

          <span style={{ fontWeight: 600, fontSize: 13, color: played ? outcomeColor(status, hGoals, aGoals, 'away') : 'inherit', display: 'flex', alignItems: 'center', gap: 4 }}>
            {away}<span>{flag(away)}</span>
          </span>
        </div>

        {/* Prediction probabilities for upcoming matches */}
        {pred && !played && !live && (
          <div style={{ marginTop: 4, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <span className="chip chip-gold"  style={{ fontSize: 10, padding: '1px 8px' }}>{pct(pred.homeWin)} {home.split(' ')[0]}</span>
            <span className="chip chip-muted" style={{ fontSize: 10, padding: '1px 8px' }}>{pct(pred.draw)} Draw</span>
            <span className="chip chip-muted" style={{ fontSize: 10, padding: '1px 8px' }}>{pct(pred.awayWin)} {away.split(' ')[0]}</span>
          </div>
        )}

        {/* Pre-tournament prediction vs real result (shown after match is played) */}
        {prePred && played && (() => {
          const accuracyMeta = {
            score:  { label: '🎯 Exact score',     color: '#10b981' },
            result: { label: '✓ Result correct',   color: '#3b82f6' },
            wrong:  { label: '✗ Wrong result',     color: '#ef4444' },
          };
          const meta = accuracyMeta[predAccuracy] ?? { label: '', color: 'var(--text-muted)' };
          return (
            <div style={{
              marginTop:    6,
              padding:      '6px 8px',
              borderRadius: 6,
              background:   'rgba(255,255,255,0.04)',
              border:       '1px solid var(--border)',
              display:      'flex',
              alignItems:   'center',
              gap:          8,
              flexWrap:     'wrap',
            }}>
              <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 0.5 }}>MODEL PREDICTED</span>
              <span style={{
                fontFamily:  'Bebas Neue, sans-serif',
                fontSize:    15,
                letterSpacing: 1.5,
                color:       'var(--gold)',
              }}>
                {prePred.predictedScore.replace('-', '–')}
              </span>
              <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>
                {pct(prePred.homeWin)} / {pct(prePred.draw)} / {pct(prePred.awayWin)}
              </span>
              {predAccuracy && (
                <span style={{
                  fontSize: 9, fontWeight: 700,
                  color:      meta.color,
                  marginLeft: 'auto',
                }}>
                  {meta.label}
                </span>
              )}
            </div>
          );
        })()}
      </div>
    </div>
  );
}

// Group stage view — shows all 12 groups
function GroupStageView({ data }) {
  const { groups, groupFixtures, hardcodedGroups } = data;
  const [expandedGroup, setExpandedGroup] = useState(null);

  const groupLetters = Object.keys(hardcodedGroups);

  // Map API standings by group letter — extract letter from group name like "Group A"
  const apiGroupsByLetter = {};
  for (const [name, rows] of Object.entries(groups ?? {})) {
    const letter = name.replace(/^group\s*/i, '').trim();
    apiGroupsByLetter[letter] = rows;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {groupLetters.map(letter => {
        const apiRows   = apiGroupsByLetter[letter];
        const teams     = hardcodedGroups[letter];
        const isOpen    = expandedGroup === letter;

        // Build fallback standing rows from hardcoded teams
        const standingRows = apiRows ?? teams.map((t, i) => ({
          rank: i + 1, team: t, played: 0, won: 0, drawn: 0, lost: 0,
          gf: 0, ga: 0, gd: 0, points: 0,
        }));

        // Filter group fixtures for this group's teams
        const teamSet = new Set(teams.map(t => t.toLowerCase()));
        const groupMatches = (groupFixtures ?? []).filter(f => {
          const h = (f.teams?.home?.name ?? '').toLowerCase();
          const a = (f.teams?.away?.name ?? '').toLowerCase();
          return teamSet.has(h) || teamSet.has(a);
        });

        const played   = groupMatches.filter(f => ['FT','AET','PEN'].includes(f._statusShort ?? f.fixture?.status?.short)).length;
        const total    = groupMatches.length || 6;
        const progress = total ? Math.round((played / total) * 100) : 0;
        const done     = progress === 100;

        return (
          <div key={letter} className="card" style={{ padding: 0, overflow: 'hidden' }}>
            {/* Group header */}
            <button
              onClick={() => setExpandedGroup(isOpen ? null : letter)}
              style={{
                width:       '100%',
                background:  'transparent',
                border:      'none',
                padding:     '12px 14px',
                display:     'flex',
                alignItems:  'center',
                cursor:      'pointer',
                gap:         10,
              }}
            >
              <div style={{
                width:      32, height: 32,
                borderRadius: 8,
                background:  'var(--surface2)',
                display:     'flex', alignItems: 'center', justifyContent: 'center',
                fontFamily:  'Bebas Neue, sans-serif',
                fontSize:    18,
                color:       'var(--gold)',
                flexShrink:  0,
              }}>
                {letter}
              </div>
              <div style={{ flex: 1, textAlign: 'left' }}>
                <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--text-primary)' }}>
                  Group {letter}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                  {teams.join(' · ')}
                </div>
              </div>
              <div style={{ textAlign: 'right', flexShrink: 0 }}>
                <div style={{ fontSize: 11, color: done ? 'var(--green)' : 'var(--text-muted)', fontWeight: 600 }}>
                  {done ? '✓ Complete' : `${played}/${total}`}
                </div>
              </div>
              <div style={{
                fontSize: 14, color: 'var(--text-muted)',
                transform: isOpen ? 'rotate(180deg)' : 'none',
                transition: '200ms',
              }}>▾</div>
            </button>

            {isOpen && (
              <div style={{ padding: '0 14px 14px' }}>
                <StandingsTable rows={standingRows} />
                {groupMatches.length > 0 && (
                  <div style={{ marginTop: 12 }}>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, letterSpacing: 0.5, marginBottom: 4 }}>
                      MATCHES
                    </div>
                    {groupMatches.map((f, i) => <MatchRow key={f.id ?? f.fixture?.id ?? i} fixture={f} />)}
                  </div>
                )}
                {groupMatches.length === 0 && (
                  <div style={{ marginTop: 12, color: 'var(--text-muted)', fontSize: 12 }}>
                    Matches begin June 11, 2026.
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// Knockout bracket view
function KnockoutView({ data }) {
  const { knockoutFixtures } = data;

  if (!knockoutFixtures?.length) {
    return (
      <div className="card" style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 40 }}>
        <div style={{ fontSize: 32, marginBottom: 8 }}>🏆</div>
        <div style={{ fontWeight: 600 }}>Knockout rounds not yet unlocked</div>
        <div style={{ fontSize: 12, marginTop: 4 }}>Check back once the group stage is complete</div>
      </div>
    );
  }

  const rounds = {};
  for (const f of knockoutFixtures) {
    const round = f.round ?? f.league?.round ?? 'Unknown';
    rounds[round] = rounds[round] ?? [];
    rounds[round].push(f);
  }

  const roundOrder = [
    'Round of 32', 'Round of 16', 'Quarter-finals',
    'Semi-finals', '3rd Place Final', 'Final',
  ];

  const sortedRounds = Object.keys(rounds).sort((a, b) => {
    const ai = roundOrder.findIndex(r => a.toLowerCase().includes(r.toLowerCase()));
    const bi = roundOrder.findIndex(r => b.toLowerCase().includes(r.toLowerCase()));
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {sortedRounds.map(round => (
        <div key={round} className="card">
          <div className="card-title">{round}</div>
          {rounds[round].map((f, i) => <MatchRow key={f.id ?? f.fixture?.id ?? i} fixture={f} />)}
        </div>
      ))}
    </div>
  );
}

// Predicted standings tab — all 12 groups in one scrollable view
function PredictedTableView({ data, onTeamClick }) {
  const { hardcodedGroups, groupPredictedStandings } = data;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {Object.entries(hardcodedGroups).map(([letter, teams]) => {
        const rows  = groupPredictedStandings?.[letter] ?? [];
        const color = GROUP_COLORS[letter] ?? 'var(--gold)';

        return (
          <div key={letter} className="card" style={{ borderLeft: `3px solid ${color}`, padding: '12px 14px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <div style={{
                width: 28, height: 28, borderRadius: 6,
                background: `${color}22`, border: `1.5px solid ${color}55`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontFamily: 'Bebas Neue, sans-serif', fontSize: 16, color,
              }}>
                {letter}
              </div>
              <span style={{ fontWeight: 700, fontSize: 13, color }}>Group {letter}</span>
            </div>

            {rows.map((row, i) => {
              const advances  = i < 2;
              const maybeAdv  = i === 2; // 3rd place — may advance as one of best 8 third-place teams
              const maxPts    = rows[0]?.xPts ?? 1;
              const barPct    = maxPts > 0 ? (row.xPts / maxPts) * 100 : 0;
              const rowColor  = advances ? color : maybeAdv ? '#f59e0b' : 'var(--text-muted)';
              return (
                <div key={row.team} style={{
                  display:      'flex',
                  alignItems:   'center',
                  gap:          8,
                  padding:      '7px 0',
                  borderBottom: i < rows.length - 1 ? '1px solid var(--border)' : 'none',
                }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: rowColor, minWidth: 16, textAlign: 'center' }}>
                    {i + 1}
                  </span>
                  <span style={{ fontSize: 15, cursor: 'pointer' }} onClick={() => onTeamClick?.(row.team)}>{flag(row.team)}</span>
                  <span style={{ fontSize: 13, fontWeight: 600, flex: 1, cursor: 'pointer' }} onClick={() => onTeamClick?.(row.team)}>{row.team}</span>
                  <div style={{ width: 70, height: 5, borderRadius: 3, background: 'rgba(255,255,255,0.07)', overflow: 'hidden' }}>
                    <div style={{ width: `${barPct}%`, height: '100%', borderRadius: 3, background: advances ? color : maybeAdv ? '#f59e0b55' : 'rgba(255,255,255,0.18)' }} />
                  </div>
                  <span style={{ fontSize: 12, fontWeight: 700, color: rowColor, minWidth: 42, textAlign: 'right' }}>
                    {row.xPts} pts
                  </span>
                  {advances ? (
                    <span style={{ fontSize: 9, fontWeight: 700, color, background: `${color}22`, border: `1px solid ${color}55`, borderRadius: 4, padding: '1px 5px', whiteSpace: 'nowrap' }}>
                      ADV
                    </span>
                  ) : maybeAdv ? (
                    <span style={{ fontSize: 9, fontWeight: 700, color: '#f59e0b', background: '#f59e0b22', border: '1px solid #f59e0b55', borderRadius: 4, padding: '1px 5px', whiteSpace: 'nowrap' }}>
                      3rd?
                    </span>
                  ) : null}
                </div>
              );
            })}

            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 8, fontStyle: 'italic' }}>
              Predicted result per match (3W / 1D / 0L) · top 2 advance · best 8 third-place teams also advance
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Form Sparkline ──────────────────────────────────────────────────────────
function FormSparkline({ items, color }) {
  if (!items?.length) return null;
  const W = 280, H = 52, PAD = 6;
  const n     = items.length;
  const maxG  = Math.max(...items.map(x => x.scored), 3);
  const xOf   = i => PAD + (n > 1 ? (i / (n - 1)) * (W - PAD * 2) : (W - PAD * 2) / 2);
  const yOf   = g => H - PAD - (g / maxG) * (H - PAD * 2 - 6);
  const pts   = items.map((x, i) => `${xOf(i).toFixed(1)},${yOf(x.scored).toFixed(1)}`).join(' ');
  const OC    = { W: '#10b981', D: '#f59e0b', L: '#ef4444' };
  const cellW = (W - PAD * 2) / n;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 52 }}>
      {items.map((x, i) => (
        <rect key={i} x={PAD + i * cellW} y={0} width={cellW} height={H}
              fill={OC[x.outcome] ?? '#888'} opacity={0.09} rx={2} />
      ))}
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.8} strokeLinejoin="round" />
      {items.map((x, i) => (
        <circle key={i} cx={xOf(i)} cy={yOf(x.scored)} r={3} fill={color} stroke="var(--surface)" strokeWidth={1} />
      ))}
    </svg>
  );
}

// ─── Form Section (used inside TeamDetailModal) ───────────────────────────────
function FormSection({ team, color }) {
  const { data: form, loading } = useFormData(team);
  const TREND = {
    Peaking:      { emoji: '📈', color: '#10b981' },
    Declining:    { emoji: '📉', color: '#ef4444' },
    Inconsistent: { emoji: '〰️', color: '#f97316' },
    Steady:       { emoji: '→',  color: '#3b82f6' },
  };
  return (
    <div className="card">
      <div className="card-title">Recent Form</div>
      {loading && (
        <div style={{ color: 'var(--text-muted)', fontSize: 12, padding: '8px 0' }}>Loading…</div>
      )}
      {!loading && !form && (
        <div style={{ color: 'var(--text-muted)', fontSize: 12, padding: '8px 0' }}>No recent data available</div>
      )}
      {!loading && form && (() => {
        const meta = TREND[form.trend] ?? { emoji: '→', color: 'var(--gold)' };
        return (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
              <div style={{ fontSize: 11, fontWeight: 700, background: `${meta.color}22`, border: `1px solid ${meta.color}55`, color: meta.color, borderRadius: 6, padding: '3px 10px' }}>
                {meta.emoji} {form.trend}
              </div>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                Last {form.items.length} games:
                <span style={{ color: '#10b981', fontWeight: 700 }}> {form.W}W</span>
                <span style={{ color: '#f59e0b', fontWeight: 700 }}> {form.D}D</span>
                <span style={{ color: '#ef4444', fontWeight: 700 }}> {form.L}L</span>
              </span>
            </div>
            <FormSparkline items={form.items} color={color} />
            <div style={{ display: 'flex', gap: 4, marginTop: 8 }}>
              {form.items.slice(-5).map((x, i) => {
                const oc = x.outcome === 'W' ? '#10b981' : x.outcome === 'D' ? '#f59e0b' : '#ef4444';
                return (
                  <div key={i} style={{ flex: 1, textAlign: 'center' }}>
                    <div style={{ borderRadius: 6, background: `${oc}22`, border: `1px solid ${oc}55`, padding: '5px 2px' }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: oc }}>{x.outcome}</div>
                      <div style={{ fontSize: 9, color: 'var(--text-muted)' }}>{x.scored}–{x.conceded}</div>
                    </div>
                    <div style={{ fontSize: 8, color: 'var(--text-muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {x.opponent.split(' ')[0]}
                    </div>
                  </div>
                );
              })}
            </div>
            <div style={{ fontSize: 9, color: 'var(--text-muted)', marginTop: 6, fontStyle: 'italic' }}>
              International results since Jan 2023 · martj42 dataset
            </div>
          </>
        );
      })()}
    </div>
  );
}

// ─── H2H Panel (lazy-loaded inside match cards) ───────────────────────────────
function H2HPanel({ home, away, color }) {
  const { data, loading } = useH2HData(home, away, true);
  if (loading) return (
    <div style={{ padding: '10px 0', color: 'var(--text-muted)', fontSize: 12, textAlign: 'center' }}>Loading H2H…</div>
  );
  if (!data || data.total === 0) return (
    <div style={{ padding: '10px 0', color: 'var(--text-muted)', fontSize: 12, textAlign: 'center' }}>
      No H2H history found
    </div>
  );

  const edgeLabel = data.edge === 'home' ? home : data.edge === 'away' ? away : null;

  return (
    <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 0.6, marginBottom: 8 }}>
        HEAD TO HEAD · {data.total} MEETINGS
      </div>

      {/* Win/Draw/Loss bar */}
      <div style={{ display: 'flex', height: 20, borderRadius: 4, overflow: 'hidden', marginBottom: 6 }}>
        {data.homeWins > 0 && (
          <div style={{ flex: data.homeWins, background: '#3b82f688', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ fontSize: 10, fontWeight: 700, color: '#fff' }}>{data.homeWins}</span>
          </div>
        )}
        {data.draws > 0 && (
          <div style={{ flex: data.draws, background: 'rgba(255,215,0,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ fontSize: 10, fontWeight: 700, color: '#fff' }}>{data.draws}</span>
          </div>
        )}
        {data.awayWins > 0 && (
          <div style={{ flex: data.awayWins, background: '#f9731688', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ fontSize: 10, fontWeight: 700, color: '#fff' }}>{data.awayWins}</span>
          </div>
        )}
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-muted)', marginBottom: 10 }}>
        <span style={{ color: '#3b82f6', fontWeight: 600 }}>{home} wins</span>
        <span style={{ color: 'var(--gold)' }}>{data.draws} draws · {data.avgGoals} avg goals/game</span>
        <span style={{ color: '#f97316', fontWeight: 600 }}>{away} wins</span>
      </div>

      {/* Last 5 */}
      {data.last5?.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 0.5, marginBottom: 2 }}>LAST {data.last5.length} MEETINGS</div>
          {data.last5.map((m, i) => {
            const hWon = m.homeScore > m.awayScore;
            const aWon = m.awayScore > m.homeScore;
            return (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
                <span style={{ color: 'var(--text-muted)', minWidth: 70, fontSize: 9 }}>{m.date}</span>
                <span style={{ fontWeight: 700, color: hWon ? '#10b981' : aWon ? '#ef4444' : 'var(--text-muted)', flex: 1, textAlign: 'right' }}>{home}</span>
                <span style={{ fontFamily: 'Bebas Neue, sans-serif', fontSize: 15, letterSpacing: 1, color: 'var(--gold)', margin: '0 4px' }}>{m.homeScore}–{m.awayScore}</span>
                <span style={{ fontWeight: 700, color: aWon ? '#10b981' : hWon ? '#ef4444' : 'var(--text-muted)', flex: 1 }}>{away}</span>
              </div>
            );
          })}
        </div>
      )}

      {edgeLabel && (
        <div style={{ marginTop: 8, fontSize: 10, fontWeight: 700, color: color, textAlign: 'center' }}>
          ⚖️ {edgeLabel} has the historical edge
        </div>
      )}
    </div>
  );
}

// ─── Team Detail Modal (bottom sheet) ────────────────────────────────────────
function TeamDetailModal({ team, data, onClose }) {
  if (!team) return null;

  // Find which group this team belongs to
  const hardcodedGroups = data?.hardcodedGroups ?? {};
  const groupLetter = Object.keys(hardcodedGroups).find(l => hardcodedGroups[l].includes(team)) ?? '';
  const color = GROUP_COLORS[groupLetter] ?? 'var(--gold)';

  const allMatches = data?.groupMatchPredictions?.[groupLetter] ?? [];
  const teamMatches = allMatches.filter(m => m.home === team || m.away === team);

  const standings = data?.groupPredictedStandings?.[groupLetter] ?? [];
  const rankEntry = standings.find(r => r.team === team);
  const rank = standings.findIndex(r => r.team === team) + 1;

  const reach = data?.tournamentReach?.[team];

  const pathStages = [
    { label: 'Advance',       key: 'pAdvance' },
    { label: 'Round of 16',   key: 'pR16'     },
    { label: 'Quarter-Final', key: 'pQF'      },
    { label: 'Semi-Final',    key: 'pSF'      },
    { label: 'Final',         key: 'pFinal'   },
    { label: 'Champion',      key: 'pWinner'  },
  ];

  return (
    <div
      onClick={onClose}
      style={{
        position:        'fixed',
        inset:           0,
        zIndex:          1000,
        background:      'rgba(0,0,0,0.65)',
        display:         'flex',
        alignItems:      'flex-end',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width:           '100%',
          maxHeight:       '85vh',
          background:      'var(--surface)',
          borderRadius:    '18px 18px 0 0',
          overflowY:       'auto',
          display:         'flex',
          flexDirection:   'column',
        }}
      >
        {/* Sticky header */}
        <div style={{
          position:        'sticky',
          top:             0,
          zIndex:          1,
          background:      'var(--surface)',
          borderBottom:    `3px solid ${color}`,
          padding:         '16px 16px 12px',
          display:         'flex',
          alignItems:      'center',
          gap:             12,
        }}>
          <span style={{ fontSize: 36 }}>{flag(team)}</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: 'Bebas Neue, sans-serif', fontSize: 26, letterSpacing: 2, color, lineHeight: 1 }}>
              {team}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2, letterSpacing: 0.5 }}>
              Group {groupLetter}
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background:   'var(--surface2)',
              border:       '1px solid var(--border)',
              borderRadius: 8,
              width:        32, height: 32,
              fontSize:     16,
              cursor:       'pointer',
              color:        'var(--text-muted)',
              display:      'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            ✕
          </button>
        </div>

        <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>

          {/* Group matches */}
          {teamMatches.length > 0 && (
            <div className="card">
              <div className="card-title">Group Matches</div>
              {teamMatches.map((m, i) => {
                const isHome   = m.home === team;
                const opponent = isHome ? m.away : m.home;
                const teamWin  = isHome ? m.homeWin : m.awayWin;
                const oppWin   = isHome ? m.awayWin : m.homeWin;
                const score    = m.predictedScore ?? '';
                const [sh, sa] = score.split('-');
                const dispScore = isHome ? `${sh}–${sa}` : `${sa}–${sh}`;
                return (
                  <div key={i} style={{
                    padding:      '10px 0',
                    borderBottom: i < teamMatches.length - 1 ? '1px solid var(--border)' : 'none',
                    display:      'flex',
                    alignItems:   'center',
                    gap:          10,
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1 }}>
                      <span style={{ fontSize: 18 }}>{flag(opponent)}</span>
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 600 }}>{opponent}</div>
                        <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{isHome ? 'Home' : 'Away'}</div>
                      </div>
                    </div>
                    <div style={{ textAlign: 'center' }}>
                      <div style={{ fontFamily: 'Bebas Neue, sans-serif', fontSize: 22, letterSpacing: 2, color: 'var(--gold)', lineHeight: 1 }}>
                        {dispScore}
                      </div>
                      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
                        {pct(teamWin)} W · {pct(m.draw)} D
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Predicted standing */}
          {rankEntry && (
            <div className="card">
              <div className="card-title">Predicted Standing</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '6px 0' }}>
                <div style={{
                  fontFamily:  'Bebas Neue, sans-serif',
                  fontSize:    52,
                  color,
                  lineHeight:  1,
                  minWidth:    40,
                  textAlign:   'center',
                }}>
                  {rank}
                </div>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: rank <= 2 ? color : rank === 3 ? '#f59e0b' : 'var(--text-muted)' }}>
                    {rank <= 2 ? 'Predicted to advance' : rank === 3 ? 'Possible best-3rd advance' : 'Predicted to exit'}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                    {rankEntry.xPts} xPts · {rankEntry.xGD > 0 ? '+' : ''}{rankEntry.xGD} xGD
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Path to the Final */}
          {reach && (
            <div className="card">
              <div className="card-title">Path to the Final</div>
              {pathStages.map(({ label, key }) => {
                const prob = reach[key] ?? 0;
                return (
                  <div key={key} style={{
                    display:      'flex',
                    alignItems:   'center',
                    gap:          10,
                    padding:      '7px 0',
                    borderBottom: key !== 'pWinner' ? '1px solid var(--border)' : 'none',
                  }}>
                    <span style={{ fontSize: 12, color: 'var(--text-muted)', minWidth: 100 }}>{label}</span>
                    <div style={{ flex: 1, height: 6, borderRadius: 3, background: 'rgba(255,255,255,0.07)', overflow: 'hidden' }}>
                      <div style={{ width: `${prob * 100}%`, height: '100%', borderRadius: 3, background: color, transition: 'width 400ms' }} />
                    </div>
                    <span style={{ fontSize: 12, fontWeight: 700, color, minWidth: 38, textAlign: 'right' }}>
                      {pct(prob)}
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          {/* Recent Form */}
          <FormSection team={team} color={color} />

        </div>
      </div>
    </div>
  );
}

// ─── Insights View ────────────────────────────────────────────────────────────
function InsightsView({ data, onTeamClick }) {
  const { groupInsights = [], upsetMatches = [] } = data;
  // Which accordion sections are open (multiple can be open at once)
  const [open, setOpen] = useState(new Set(['death']));

  function toggle(id) {
    setOpen(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  const LABEL_META = {
    'Group of Death': { emoji: '💀', color: '#ef4444' },
    'Tight Group':    { emoji: '🔥', color: '#f97316' },
    'Balanced':       { emoji: '⚖️',  color: '#f59e0b' },
    'Wide Open':      { emoji: '🌊', color: '#3b82f6' },
    'Mismatch':       { emoji: '🎯', color: '#10b981' },
  };

  const UPSET_META = {
    'Watch This':  { emoji: '👀', color: '#ef4444' },
    'Upset Alert': { emoji: '⚡', color: '#f59e0b' },
  };

  // Reusable accordion header
  function SectionHeader({ id, emoji, title, count, countColor }) {
    const isOpen = open.has(id);
    return (
      <button
        onClick={() => toggle(id)}
        style={{
          width:        '100%',
          display:      'flex',
          alignItems:   'center',
          gap:          10,
          padding:      '12px 14px',
          background:   isOpen ? 'rgba(255,255,255,0.04)' : 'var(--surface2)',
          border:       '1px solid var(--border)',
          borderRadius: isOpen ? '10px 10px 0 0' : 10,
          cursor:       'pointer',
          textAlign:    'left',
          color:        'var(--text-primary)',
          transition:   'border-radius 150ms',
        }}
      >
        <span style={{ fontSize: 18, lineHeight: 1 }}>{emoji}</span>
        <span style={{ flex: 1, fontWeight: 700, fontSize: 13, color: 'var(--text-primary)' }}>{title}</span>
        {count != null && (
          <span style={{
            fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 20,
            background: `${countColor ?? 'var(--gold)'}22`,
            border:     `1px solid ${countColor ?? 'var(--gold)'}55`,
            color:      countColor ?? 'var(--gold)',
          }}>
            {count}
          </span>
        )}
        <span style={{
          fontSize: 13, color: 'var(--text-muted)',
          transform: isOpen ? 'rotate(180deg)' : 'none',
          transition: '200ms',
          marginLeft: 2,
        }}>▾</span>
      </button>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

      {/* ── Group of Death Rankings ─────────────────────────────────────────── */}
      <div style={{ borderRadius: 10, overflow: 'hidden', border: '1px solid var(--border)' }}>
        <SectionHeader id="death" emoji="💀" title="Group of Death Rankings" count={`${groupInsights.length} groups`} countColor="#ef4444" />
        {open.has('death') && (
        <div style={{ background: 'var(--surface)', padding: '10px 10px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {groupInsights.map((g, rank) => {
            const groupColor = GROUP_COLORS[g.letter] ?? 'var(--gold)';
            const meta       = LABEL_META[g.label] ?? { emoji: '📊', color: 'var(--gold)' };
            const maxStrength = groupInsights.reduce((m, x) => Math.max(m, x.avg), 0);
            const barPct      = maxStrength > 0 ? (g.avg / maxStrength) * 100 : 0;

            return (
              <div key={g.letter} className="card" style={{
                borderLeft: `3px solid ${groupColor}`,
                padding:    '12px 14px',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                  {/* Rank */}
                  <div style={{
                    fontFamily:  'Bebas Neue, sans-serif',
                    fontSize:    22,
                    color:       rank === 0 ? meta.color : 'var(--text-muted)',
                    minWidth:    24,
                    textAlign:   'center',
                  }}>
                    {rank + 1}
                  </div>
                  {/* Group badge */}
                  <div style={{
                    width: 28, height: 28, borderRadius: 6,
                    background: `${groupColor}22`, border: `1.5px solid ${groupColor}55`,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontFamily: 'Bebas Neue, sans-serif', fontSize: 16, color: groupColor,
                    flexShrink: 0,
                  }}>
                    {g.letter}
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 700, fontSize: 13, color: groupColor }}>Group {g.letter}</div>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 1 }}>
                      {g.teamStrengths.map(t => `${flag(t.team)} ${t.team}`).join('  ·  ')}
                    </div>
                  </div>
                  {/* Label badge */}
                  <div style={{
                    fontSize:    10, fontWeight: 700,
                    background:  `${meta.color}22`,
                    border:      `1px solid ${meta.color}55`,
                    color:       meta.color,
                    borderRadius: 6,
                    padding:     '3px 8px',
                    whiteSpace:  'nowrap',
                  }}>
                    {meta.emoji} {g.label}
                  </div>
                </div>

                {/* Stats row — normalised so no raw ELO numbers show */}
                {(() => {
                  const minElo = 1380, maxElo = 1960;
                  const avgPct = Math.round(((g.avg - minElo) / (maxElo - minElo)) * 100);
                  const gapLabel = g.gap >= 350 ? 'Wide' : g.gap >= 200 ? 'Moderate' : 'Tight';
                  const gapColor = g.gap >= 350 ? '#ef4444' : g.gap >= 200 ? '#f59e0b' : '#10b981';
                  const teams    = g.teamStrengths.length;
                  return (
                    <div style={{ display: 'flex', gap: 12, marginBottom: 8 }}>
                      <div style={{ flex: 1, textAlign: 'center' }}>
                        <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 0.6, marginBottom: 2 }}>AVG STRENGTH</div>
                        <div style={{ fontSize: 15, fontWeight: 700, color: groupColor }}>{avgPct}<span style={{ fontSize: 10, fontWeight: 400 }}>/100</span></div>
                      </div>
                      <div style={{ flex: 1, textAlign: 'center' }}>
                        <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 0.6, marginBottom: 2 }}>SPREAD</div>
                        <div style={{ fontSize: 15, fontWeight: 700, color: gapColor }}>{gapLabel}</div>
                      </div>
                      <div style={{ flex: 1, textAlign: 'center' }}>
                        <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 0.6, marginBottom: 2 }}>TEAMS</div>
                        <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-muted)' }}>{teams}</div>
                      </div>
                    </div>
                  );
                })()}

                {/* Strength bar per team */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {g.teamStrengths.map((t, ti) => {
                    const tBarPct = g.teamStrengths[0].strength > 0 ? (t.strength / g.teamStrengths[0].strength) * 100 : 0;
                    return (
                      <div key={t.team} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ fontSize: 12, cursor: 'pointer' }} onClick={() => onTeamClick?.(t.team)}>{flag(t.team)}</span>
                        <span style={{ fontSize: 11, fontWeight: 600, minWidth: 80, cursor: 'pointer' }} onClick={() => onTeamClick?.(t.team)}>
                          {t.team}
                        </span>
                        <div style={{ flex: 1, height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.07)', overflow: 'hidden' }}>
                          <div style={{ width: `${tBarPct}%`, height: '100%', borderRadius: 2, background: ti === 0 ? groupColor : `${groupColor}88` }} />
                        </div>
                        <span style={{ fontSize: 11, color: 'var(--text-muted)', minWidth: 32, textAlign: 'right' }}>
                          {Math.round(((t.strength - 1380) / (1960 - 1380)) * 100)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
        )}
      </div>

      {/* ── Upset Tracker ──────────────────────────────────────────────────── */}
      <div style={{ borderRadius: 10, overflow: 'hidden', border: '1px solid var(--border)' }}>
        <SectionHeader id="upset" emoji="⚡" title="Upset Tracker" count={upsetMatches.length > 0 ? `${upsetMatches.length} flagged` : 'none'} countColor="#f59e0b" />
        {open.has('upset') && (
        <div style={{ background: 'var(--surface)', padding: '10px 10px 12px' }}>
        {upsetMatches.length === 0 ? (
          <div className="card" style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 32 }}>
            <div style={{ fontSize: 28, marginBottom: 8 }}>✅</div>
            <div style={{ fontWeight: 600 }}>No major upsets predicted</div>
            <div style={{ fontSize: 12, marginTop: 4 }}>All underdogs below 30% win probability</div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {upsetMatches.map((m, i) => {
              const meta       = UPSET_META[m.label] ?? { emoji: '⚡', color: '#f59e0b' };
              const groupColor = GROUP_COLORS[m.group] ?? 'var(--gold)';
              const underdogPct = Math.round(m.underdogWin * 100);
              const favPct      = Math.round((1 - m.underdogWin - m.draw) * 100);
              const isHomeUnderdog = m.underdog === m.home;

              return (
                <div key={i} className="card" style={{
                  borderLeft: `3px solid ${meta.color}`,
                  padding:    '12px 14px',
                }}>
                  {/* Header row */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                    <div style={{
                      width: 22, height: 22, borderRadius: 5,
                      background: `${groupColor}22`, border: `1px solid ${groupColor}55`,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontFamily: 'Bebas Neue, sans-serif', fontSize: 13, color: groupColor, flexShrink: 0,
                    }}>
                      {m.group}
                    </div>
                    <span style={{ flex: 1, fontSize: 11, color: 'var(--text-muted)' }}>Group {m.group}</span>
                    <div style={{
                      fontSize: 10, fontWeight: 700,
                      background: `${meta.color}22`, border: `1px solid ${meta.color}55`,
                      color: meta.color, borderRadius: 6, padding: '2px 8px',
                    }}>
                      {meta.emoji} {m.label}
                    </div>
                  </div>

                  {/* Match card */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                    {/* Home */}
                    <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 5 }}>
                      <span style={{ fontSize: 18, cursor: 'pointer' }} onClick={() => onTeamClick?.(m.home)}>{flag(m.home)}</span>
                      <div>
                        <div style={{ fontSize: 12, fontWeight: 700, cursor: 'pointer' }} onClick={() => onTeamClick?.(m.home)}>{m.home}</div>
                        {!isHomeUnderdog && (
                          <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--gold)', letterSpacing: 0.4 }}>FAVOURITE</div>
                        )}
                        {isHomeUnderdog && (
                          <div style={{ fontSize: 9, fontWeight: 700, color: meta.color, letterSpacing: 0.4 }}>UNDERDOG</div>
                        )}
                      </div>
                    </div>

                    {/* Predicted score */}
                    <div style={{ textAlign: 'center' }}>
                      <div style={{ fontFamily: 'Bebas Neue, sans-serif', fontSize: 22, letterSpacing: 2, color: 'var(--gold)', lineHeight: 1 }}>
                        {m.predictedScore.replace('-', '–')}
                      </div>
                      <div style={{ fontSize: 9, color: 'var(--text-muted)', marginTop: 2 }}>PREDICTED</div>
                    </div>

                    {/* Away */}
                    <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 5, justifyContent: 'flex-end' }}>
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontSize: 12, fontWeight: 700, cursor: 'pointer' }} onClick={() => onTeamClick?.(m.away)}>{m.away}</div>
                        {isHomeUnderdog && (
                          <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--gold)', letterSpacing: 0.4 }}>FAVOURITE</div>
                        )}
                        {!isHomeUnderdog && (
                          <div style={{ fontSize: 9, fontWeight: 700, color: meta.color, letterSpacing: 0.4 }}>UNDERDOG</div>
                        )}
                      </div>
                      <span style={{ fontSize: 18, cursor: 'pointer' }} onClick={() => onTeamClick?.(m.away)}>{flag(m.away)}</span>
                    </div>
                  </div>

                  {/* Probability bar */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 4 }}>
                    <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', minWidth: 30, textAlign: 'left' }}>{favPct}%</span>
                    <div style={{ flex: 1, height: 6, borderRadius: 3, background: 'rgba(255,255,255,0.07)', overflow: 'hidden', display: 'flex' }}>
                      <div style={{ width: `${favPct}%`, height: '100%', background: 'rgba(255,255,255,0.3)', borderRadius: '3px 0 0 3px' }} />
                      <div style={{ width: `${Math.round(m.draw * 100)}%`, height: '100%', background: 'rgba(255,215,0,0.4)' }} />
                      <div style={{ width: `${underdogPct}%`, height: '100%', background: meta.color, borderRadius: '0 3px 3px 0' }} />
                    </div>
                    <span style={{ fontSize: 10, fontWeight: 700, color: meta.color, minWidth: 30, textAlign: 'right' }}>{underdogPct}%</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'center' }}>
                    <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>
                      {isHomeUnderdog ? m.home : m.away} underdog win probability: <strong style={{ color: meta.color }}>{underdogPct}%</strong>
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <div style={{ fontSize: 10, color: 'var(--text-muted)', textAlign: 'center', marginTop: 8, fontStyle: 'italic' }}>
          Flags matches where underdog win% ≥ 30% · Poisson model · read-only
        </div>
        </div>
        )}
      </div>

      {/* ── Golden Boot Predictor ──────────────────────────────────────────── */}
      <div style={{ borderRadius: 10, overflow: 'hidden', border: '1px solid var(--border)' }}>
        <SectionHeader id="boot" emoji="🥇" title="Golden Boot Predictor" count={data.goldenBoot?.length ? `Top ${data.goldenBoot.length}` : null} countColor="#fbbf24" />
        {open.has('boot') && (
        <div style={{ background: 'var(--surface)', padding: '10px 10px 12px' }}>
        {(!data.goldenBoot || data.goldenBoot.length === 0) ? (
          <div className="card" style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 32 }}>
            <div style={{ fontSize: 28, marginBottom: 8 }}>⚽</div>
            <div style={{ fontWeight: 600 }}>No data available</div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {data.goldenBoot.map((p, i) => {
              const groupColor = (() => {
                for (const [letter, teams] of Object.entries(data.hardcodedGroups ?? {})) {
                  if (teams.includes(p.team)) return GROUP_COLORS[letter] ?? 'var(--gold)';
                }
                return 'var(--gold)';
              })();
              const maxGoals = data.goldenBoot[0]?.xGoals ?? 1;
              const barPct   = maxGoals > 0 ? (p.xGoals / maxGoals) * 100 : 0;
              const isTop3   = i < 3;
              return (
                <div key={i} className="card" style={{
                  padding:    '10px 14px',
                  borderLeft: isTop3 ? `3px solid ${i === 0 ? '#fbbf24' : i === 1 ? '#94a3b8' : '#b45309'}` : '3px solid var(--border)',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                    <div style={{
                      fontFamily: 'Bebas Neue, sans-serif', fontSize: 20,
                      color: i === 0 ? '#fbbf24' : i === 1 ? '#94a3b8' : i === 2 ? '#b45309' : 'var(--text-muted)',
                      minWidth: 24, textAlign: 'center',
                    }}>
                      {i + 1}
                    </div>
                    <span style={{ fontSize: 18 }}>{flag(p.team)}</span>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 13, fontWeight: 700 }}>{p.name}</div>
                      <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{p.team}</div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontFamily: 'Bebas Neue, sans-serif', fontSize: 22, letterSpacing: 1, color: i === 0 ? '#fbbf24' : groupColor, lineHeight: 1 }}>
                        {p.xGoals}
                      </div>
                      <div style={{ fontSize: 9, color: 'var(--text-muted)' }}>xG · {p.expGames} games</div>
                    </div>
                  </div>
                  <div style={{ height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.07)', overflow: 'hidden' }}>
                    <div style={{ width: `${barPct}%`, height: '100%', borderRadius: 2, background: i === 0 ? '#fbbf24' : groupColor }} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <div style={{ fontSize: 10, color: 'var(--text-muted)', textAlign: 'center', marginTop: 8, fontStyle: 'italic' }}>
          Projected goals = team λ × expected games × player goal share · read-only
        </div>
        <div style={{
          marginTop: 10,
          padding:   '10px 12px',
          borderRadius: 8,
          background:  'rgba(255,215,0,0.06)',
          border:      '1px solid rgba(255,215,0,0.18)',
          fontSize:    10,
          color:       'var(--text-muted)',
          lineHeight:  1.5,
        }}>
          ℹ️ Player projections are based on current squad assumptions and will be updated once official World Cup squads are announced in May/June 2026. All players verified against the confirmed 48-team group draw.
        </div>
        </div>
        )}
      </div>
    </div>
  );
}

// ─── AccuracyView ────────────────────────────────────────────────────────────
// Compares every pre-tournament prediction against the actual result once played.
// Shows aggregate stats + per-group advancement accuracy.
function AccuracyView({ data }) {
  const { groupFixtures = [], knockoutFixtures = [], groupPredictedStandings = {}, hardcodedGroups = {}, groups = {} } = data;

  // ── Collect all played fixtures that had a pre-tournament prediction ──────
  const allFixtures = [...groupFixtures, ...knockoutFixtures];
  const evaluated   = [];

  for (const f of allFixtures) {
    const status = f._statusShort ?? f.fixture?.status?.short ?? 'NS';
    if (!['FT','AET','PEN'].includes(status)) continue;
    const prePred = f._prePrediction;
    if (!prePred) continue;
    const hGoals = f.goals?.home;
    const aGoals = f.goals?.away;
    if (hGoals == null || aGoals == null) continue;

    const [ph, pa] = (prePred.predictedScore ?? '').split('-').map(Number);
    let outcome;
    if (ph === hGoals && pa === aGoals) {
      outcome = 'score';
    } else {
      const predWinner = ph > pa ? 'H' : ph < pa ? 'A' : 'D';
      const realWinner = hGoals > aGoals ? 'H' : hGoals < aGoals ? 'A' : 'D';
      outcome = predWinner === realWinner ? 'result' : 'wrong';
    }
    evaluated.push({ fixture: f, outcome, prePred, hGoals, aGoals });
  }

  const exact   = evaluated.filter(e => e.outcome === 'score').length;
  const correct = evaluated.filter(e => e.outcome === 'result').length;
  const wrong   = evaluated.filter(e => e.outcome === 'wrong').length;
  const total   = evaluated.length;
  const pctRight = total > 0 ? Math.round(((exact + correct) / total) * 100) : null;

  // ── Group advancement accuracy ────────────────────────────────────────────
  const apiGroupsByLetter = {};
  for (const [name, rows] of Object.entries(groups)) {
    const letter = name.replace(/^group\s*/i, '').trim();
    apiGroupsByLetter[letter] = rows;
  }

  const advancementRows = Object.keys(hardcodedGroups).map(letter => {
    const predicted = (groupPredictedStandings[letter] ?? []).slice(0, 2).map(r => r.team);
    const apiRows   = apiGroupsByLetter[letter];
    if (!apiRows?.length) return { letter, predicted, actual: null, complete: false };

    const sorted = [...apiRows].sort((a, b) => b.points - a.points || b.gd - a.gd || b.gf - a.gf);
    const allPlayed = sorted.every(r => r.played >= 3);
    const actual    = sorted.slice(0, 2).map(r => r.team);
    return { letter, predicted, actual, complete: allPlayed };
  });

  const completedGroups  = advancementRows.filter(r => r.complete);
  const correctAdvancers = completedGroups.reduce((n, r) => {
    return n + r.predicted.filter(t => r.actual.includes(t)).length;
  }, 0);
  const totalAdvancers = completedGroups.length * 2;

  // ── Accuracy badge colours ─────────────────────────────────────────────────
  const meta = {
    score:  { label: '🎯 Exact score',      color: '#10b981' },
    result: { label: '✓ Result correct',    color: '#3b82f6' },
    wrong:  { label: '✗ Wrong result',      color: '#ef4444' },
  };

  // ── Empty state ───────────────────────────────────────────────────────────
  if (total === 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="card" style={{ padding: '24px 16px', textAlign: 'center' }}>
          <div style={{ fontSize: 36, marginBottom: 8 }}>📊</div>
          <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--text-primary)', marginBottom: 6 }}>
            No results yet
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }}>
            Prediction accuracy will appear here once matches kick off on{' '}
            <span style={{ color: 'var(--gold)', fontWeight: 600 }}>June 11, 2026</span>.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

      {/* ── Overall stats ─────────────────────────────────────────────────── */}
      <div className="card" style={{ padding: '14px 16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--text-primary)' }}>
            📊 Model Accuracy
          </span>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            {total} match{total !== 1 ? 'es' : ''} evaluated
          </span>
        </div>

        {/* Big score */}
        {pctRight !== null && (
          <div style={{ textAlign: 'center', marginBottom: 14 }}>
            <div style={{
              fontFamily: 'Bebas Neue, sans-serif',
              fontSize:   52,
              color:      pctRight >= 60 ? '#10b981' : pctRight >= 40 ? '#f59e0b' : '#ef4444',
              lineHeight: 1,
            }}>
              {pctRight}%
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
              results predicted correctly ({exact + correct}/{total})
            </div>
          </div>
        )}

        {/* Breakdown bars */}
        {[
          { key: 'score',  count: exact,   label: '🎯 Exact score',    color: '#10b981' },
          { key: 'result', count: correct, label: '✓ Result correct',  color: '#3b82f6' },
          { key: 'wrong',  count: wrong,   label: '✗ Wrong result',    color: '#ef4444' },
        ].map(({ key, count, label, color }) => (
          <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
            <span style={{ fontSize: 11, color, fontWeight: 700, minWidth: 110 }}>{label}</span>
            <div style={{ flex: 1, height: 6, borderRadius: 3, background: 'rgba(255,255,255,0.07)', overflow: 'hidden' }}>
              <div style={{
                width:       total > 0 ? `${(count / total) * 100}%` : '0%',
                height:      '100%',
                borderRadius: 3,
                background:  color,
                transition:  'width 0.4s ease',
              }} />
            </div>
            <span style={{ fontSize: 11, fontWeight: 700, color, minWidth: 28, textAlign: 'right' }}>
              {count}
            </span>
          </div>
        ))}
      </div>

      {/* ── Group advancement accuracy ───────────────────────────────────── */}
      {completedGroups.length > 0 && (
        <div className="card" style={{ padding: '14px 16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--text-primary)' }}>
              🏁 Advancement Predictions
            </span>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              {correctAdvancers}/{totalAdvancers} correct
            </span>
          </div>

          {completedGroups.map(({ letter, predicted, actual }) => {
            const color = GROUP_COLORS[letter] ?? 'var(--gold)';
            return (
              <div key={letter} style={{
                display:      'flex',
                alignItems:   'center',
                gap:          8,
                padding:      '7px 0',
                borderBottom: '1px solid var(--border)',
              }}>
                {/* Group badge */}
                <div style={{
                  width: 22, height: 22, borderRadius: 5,
                  background: `${color}22`, border: `1.5px solid ${color}55`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontFamily: 'Bebas Neue, sans-serif', fontSize: 13, color,
                  flexShrink: 0,
                }}>
                  {letter}
                </div>

                {/* Predicted vs actual */}
                <div style={{ flex: 1, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {predicted.map(team => {
                    const hit = actual.includes(team);
                    return (
                      <span key={team} style={{
                        fontSize:   10,
                        fontWeight: 700,
                        color:      hit ? '#10b981' : '#ef4444',
                        background: hit ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)',
                        border:     `1px solid ${hit ? 'rgba(16,185,129,0.3)' : 'rgba(239,68,68,0.3)'}`,
                        borderRadius: 4,
                        padding:    '1px 6px',
                        display:    'flex',
                        alignItems: 'center',
                        gap:        3,
                      }}>
                        {hit ? '✓' : '✗'} {flag(team)}{team.split(' ')[0]}
                      </span>
                    );
                  })}
                </div>

                {/* Actual qualifiers (if different) */}
                {predicted.some(t => !actual.includes(t)) && (
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', flexShrink: 0 }}>
                    actual: {actual.map(t => flag(t) + t.split(' ')[0]).join(' ')}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ── Match-by-match breakdown ─────────────────────────────────────── */}
      <div className="card" style={{ padding: '14px 16px' }}>
        <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--text-primary)', marginBottom: 12 }}>
          Match Breakdown
        </div>
        {evaluated.map(({ fixture: f, outcome, prePred, hGoals, aGoals }, i) => {
          const home = f.teams?.home?.name ?? '?';
          const away = f.teams?.away?.name ?? '?';
          const { color, label } = meta[outcome];
          return (
            <div key={i} style={{
              display:      'flex',
              alignItems:   'center',
              gap:          8,
              padding:      '7px 0',
              borderBottom: i < evaluated.length - 1 ? '1px solid var(--border)' : 'none',
            }}>
              {/* Teams + score */}
              <div style={{ flex: 1, fontSize: 12 }}>
                <span style={{ fontWeight: 600 }}>{flag(home)}{home.split(' ')[0]}</span>
                <span style={{ fontFamily: 'Bebas Neue, sans-serif', fontSize: 15, margin: '0 6px', color: 'var(--text-primary)' }}>
                  {hGoals}–{aGoals}
                </span>
                <span style={{ fontWeight: 600 }}>{away.split(' ')[0]}{flag(away)}</span>
              </div>
              {/* Predicted score */}
              <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'Bebas Neue, sans-serif', letterSpacing: 1 }}>
                {prePred.predictedScore.replace('-','–')}
              </span>
              {/* Outcome badge */}
              <span style={{ fontSize: 9, fontWeight: 700, color, background: `${color}18`, border: `1px solid ${color}44`, borderRadius: 4, padding: '2px 6px', whiteSpace: 'nowrap' }}>
                {label}
              </span>
            </div>
          );
        })}
      </div>

      <div style={{ fontSize: 10, color: 'var(--text-muted)', textAlign: 'center', fontStyle: 'italic' }}>
        Poisson model predictions vs actual results · for entertainment only
      </div>
    </div>
  );
}

// ELO Rankings — all 48 WC teams ranked by live dynamic ELO
function EloRankingsView() {
  const { data, loading } = useEloRankings();

  const CONFED_COLOR = {
    CONMEBOL: '#3b82f6',
    UEFA:     '#10b981',
    CONCACAF: '#f59e0b',
    CAF:      '#ef4444',
    AFC:      '#8b5cf6',
    OFC:      '#06b6d4',
  };

  if (loading) return <div className="loading-card"><div className="spinner" /><div>Loading rankings…</div></div>;
  if (!data?.rankings?.length) return null;

  const rankings = data.rankings;
  const maxElo = rankings[0].elo;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className="card" style={{ padding: '10px 14px', marginBottom: 2 }}>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>
          Live ELO ratings built from <strong style={{ color: 'var(--text-primary)' }}>international results since 2018</strong> — weighted by tournament importance and time decay. Updates daily.
          {data.usingDynamicElo && <span style={{ color: 'var(--green)', marginLeft: 6, fontWeight: 700 }}>● Live</span>}
        </div>
        {/* Confederation legend */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 10px', marginTop: 8 }}>
          {Object.entries(CONFED_COLOR).map(([c, col]) => (
            <span key={c} style={{ fontSize: 9, fontWeight: 700, color: col }}>■ {c}</span>
          ))}
        </div>
      </div>

      {rankings.map((t, i) => {
        const confedColor = CONFED_COLOR[t.confederation] ?? 'var(--text-muted)';
        const barPct = maxElo > 0 ? (t.elo / maxElo) * 100 : 0;
        const isTop3 = i < 3;
        const MEDAL = ['🥇', '🥈', '🥉'];
        return (
          <div key={t.team} className="card" style={{
            padding: '10px 14px',
            borderLeft: `3px solid ${isTop3 ? confedColor : 'var(--border)'}`,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <div style={{
                fontFamily: 'Bebas Neue, sans-serif', fontSize: 18,
                color: isTop3 ? confedColor : 'var(--text-muted)',
                minWidth: 28, textAlign: 'center',
              }}>
                {isTop3 ? MEDAL[i] : t.rank}
              </div>
              <span style={{ fontSize: 20, lineHeight: 1 }}>{flag(t.team)}</span>
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 13, fontWeight: 700 }}>{t.team}</span>
                  {t.hostNation && <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--gold)', background: 'rgba(219,161,17,0.15)', borderRadius: 4, padding: '1px 5px' }}>HOST</span>}
                </div>
                <div style={{ fontSize: 10, color: confedColor, fontWeight: 600, marginTop: 1 }}>{t.confederation}</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontFamily: 'Bebas Neue, sans-serif', fontSize: 20, color: isTop3 ? confedColor : 'var(--text-primary)', letterSpacing: 1 }}>
                  {t.elo}
                </div>
                <div style={{ fontSize: 9, color: 'var(--text-muted)' }}>ELO</div>
              </div>
            </div>
            {/* ELO bar */}
            <div style={{ height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
              <div style={{ width: `${barPct}%`, height: '100%', background: confedColor, borderRadius: 2 }} />
            </div>
          </div>
        );
      })}

      <div style={{ fontSize: 10, color: 'var(--text-muted)', textAlign: 'center', marginTop: 4, fontStyle: 'italic' }}>
        K-factors: World Cup=60 · Major tournaments=50 · Qualifiers=40 · Friendlies=20 · Time-decayed
      </div>
    </div>
  );
}

// Winner Odds — all 48 teams ranked by championship probability
function WinnerOddsView({ data, onTeamClick }) {
  const reach  = data?.tournamentReach ?? {};
  const groups = data?.hardcodedGroups ?? {};

  // Build ranked list: every team that has a reach entry, sorted by pWinner desc
  const ranked = Object.entries(reach)
    .map(([team, r]) => ({ team, pWinner: r.pWinner ?? 0, pFinal: r.pFinal ?? 0, pSF: r.pSF ?? 0 }))
    .sort((a, b) => b.pWinner - a.pWinner);

  if (!ranked.length) {
    return (
      <div className="card" style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 32 }}>
        <div style={{ fontSize: 28, marginBottom: 8 }}>🏆</div>
        <div style={{ fontWeight: 600 }}>Loading odds…</div>
      </div>
    );
  }

  const maxP = ranked[0]?.pWinner ?? 1;

  // Find which group a team belongs to (for accent colour)
  function teamColor(team) {
    for (const [letter, teams] of Object.entries(groups)) {
      if (teams.includes(team)) return GROUP_COLORS[letter] ?? 'var(--gold)';
    }
    return 'var(--gold)';
  }

  const MEDAL = ['🥇', '🥈', '🥉'];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {/* Header card */}
      <div className="card" style={{ padding: '10px 14px', marginBottom: 2 }}>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>
          Championship probabilities from <strong style={{ color: 'var(--text-primary)' }}>10,000 Monte Carlo simulations</strong> of the full tournament — group stage through the Final.
        </div>
      </div>

      {ranked.map((entry, i) => {
        const color  = teamColor(entry.team);
        const barPct = maxP > 0 ? (entry.pWinner / maxP) * 100 : 0;
        const isTop3 = i < 3;
        const isTiny = entry.pWinner < 0.005; // < 0.5% — collapse row

        return (
          <div
            key={entry.team}
            onClick={() => onTeamClick?.(entry.team)}
            style={{
              display:      'flex',
              alignItems:   'center',
              gap:          10,
              padding:      isTiny ? '5px 14px' : '10px 14px',
              borderRadius: 10,
              background:   isTop3 ? 'var(--surface2)' : 'transparent',
              border:       isTop3 ? `1px solid ${color}33` : '1px solid var(--border)',
              cursor:       'pointer',
              transition:   'background 150ms',
            }}
          >
            {/* Rank */}
            <div style={{
              fontFamily:  'Bebas Neue, sans-serif',
              fontSize:    isTop3 ? 20 : 14,
              color:       isTop3 ? color : 'var(--text-muted)',
              minWidth:    28,
              textAlign:   'center',
            }}>
              {isTop3 ? MEDAL[i] : i + 1}
            </div>

            {/* Flag */}
            <span style={{ fontSize: isTop3 ? 22 : 16 }}>{flag(entry.team)}</span>

            {/* Name */}
            <span style={{ fontSize: isTop3 ? 14 : 12, fontWeight: isTop3 ? 700 : 600, flex: 1 }}>
              {entry.team}
            </span>

            {/* Bar + pct */}
            {!isTiny && (
              <div style={{ width: 90, height: 5, borderRadius: 3, background: 'rgba(255,255,255,0.07)', overflow: 'hidden' }}>
                <div style={{ width: `${barPct}%`, height: '100%', borderRadius: 3, background: color }} />
              </div>
            )}
            <span style={{
              fontSize:   isTop3 ? 13 : 11,
              fontWeight: 700,
              color:      isTop3 ? color : 'var(--text-muted)',
              minWidth:   42,
              textAlign:  'right',
            }}>
              {entry.pWinner >= 0.001
                ? `${(entry.pWinner * 100).toFixed(1)}%`
                : '<0.1%'}
            </span>
          </div>
        );
      })}

      <div style={{ fontSize: 10, color: 'var(--text-muted)', textAlign: 'center', marginTop: 6, fontStyle: 'italic', padding: '0 4px' }}>
        Tap any team for full Path to the Final breakdown · Poisson model · for entertainment only
      </div>
    </div>
  );
}

// Pre-tournament view — group draw with all match predictions pre-loaded
// ─── R32 Bracket view ─────────────────────────────────────────────────────────
function BracketView({ data }) {
  const { groupPredictedStandings, tournamentReach } = data;

  // Return the predicted (or actual live) team at a given group + rank (1-based)
  function getTeam(letter, rank) {
    // Live standings take priority
    const liveGroup = data.groups?.[letter];
    if (liveGroup?.length >= rank) {
      const sorted = [...liveGroup].sort((a, b) =>
        b.points - a.points || b.gd - a.gd || (b.gf ?? 0) - (a.gf ?? 0)
      );
      const t = sorted[rank - 1]?.team;
      if (t) return t;
    }
    // Fall back to pre-tournament predicted standings (already sorted)
    return groupPredictedStandings?.[letter]?.[rank - 1]?.team ?? null;
  }

  function pct(v) { return v != null ? `${Math.round(v * 100)}%` : '?'; }

  // Team card: shows flag, name, and R16 probability
  function TeamSlot({ team, label, color }) {
    const reach = team ? tournamentReach?.[team] : null;
    const prob  = reach?.pR16; // probability of advancing past R32 into R16
    return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
        {team ? (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <span style={{ fontSize: 18, lineHeight: 1 }}>{flag(team)}</span>
              <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-primary)', lineHeight: 1.2 }}>{team}</span>
            </div>
            {prob != null && (
              <div style={{ fontSize: 9, color: color ?? 'var(--text-muted)' }}>
                {pct(prob)} advance
              </div>
            )}
          </>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ fontSize: 16 }}>🏳️</span>
            <span style={{ fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic' }}>{label ?? 'TBD'}</span>
          </div>
        )}
      </div>
    );
  }

  // The 16 R32 matchups (structure mirrors simulateTournamentReach)
  const r32 = [
    // Matches 1-8: group winners A-H vs best 8 third-place finishers
    { id:1,  desc:'A1 vs Best 3rd', home: getTeam('A',1), away: null,            awayLabel:'Best 3rd' },
    { id:2,  desc:'B1 vs Best 3rd', home: getTeam('B',1), away: null,            awayLabel:'Best 3rd' },
    { id:3,  desc:'C1 vs Best 3rd', home: getTeam('C',1), away: null,            awayLabel:'Best 3rd' },
    { id:4,  desc:'D1 vs Best 3rd', home: getTeam('D',1), away: null,            awayLabel:'Best 3rd' },
    { id:5,  desc:'E1 vs Best 3rd', home: getTeam('E',1), away: null,            awayLabel:'Best 3rd' },
    { id:6,  desc:'F1 vs Best 3rd', home: getTeam('F',1), away: null,            awayLabel:'Best 3rd' },
    { id:7,  desc:'G1 vs Best 3rd', home: getTeam('G',1), away: null,            awayLabel:'Best 3rd' },
    { id:8,  desc:'H1 vs Best 3rd', home: getTeam('H',1), away: null,            awayLabel:'Best 3rd' },
    // Matches 9-12: groups I-L cross-matchups
    { id:9,  desc:'I1 vs J2',       home: getTeam('I',1), away: getTeam('J',2) },
    { id:10, desc:'J1 vs I2',       home: getTeam('J',1), away: getTeam('I',2) },
    { id:11, desc:'K1 vs L2',       home: getTeam('K',1), away: getTeam('L',2) },
    { id:12, desc:'L1 vs K2',       home: getTeam('L',1), away: getTeam('K',2) },
    // Matches 13-16: runner-up cross-matchups
    { id:13, desc:'A2 vs F2',       home: getTeam('A',2), away: getTeam('F',2) },
    { id:14, desc:'B2 vs E2',       home: getTeam('B',2), away: getTeam('E',2) },
    { id:15, desc:'C2 vs H2',       home: getTeam('C',2), away: getTeam('H',2) },
    { id:16, desc:'D2 vs G2',       home: getTeam('D',2), away: getTeam('G',2) },
  ];

  const sections = [
    { title: 'Group Winners vs Best 3rd-Place', matches: r32.slice(0, 8) },
    { title: 'Groups I–L Cross Matchups',       matches: r32.slice(8, 12) },
    { title: 'Runner-Up Cross Matchups',         matches: r32.slice(12, 16) },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {/* header note */}
      <div style={{
        background: 'rgba(255,215,0,0.07)', border: '1px solid rgba(255,215,0,0.2)',
        borderRadius: 10, padding: '10px 14px',
      }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--gold)', marginBottom: 3 }}>🗺️ Round of 32 — Predicted Bracket</div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>
          16 matchups based on predicted group standings. Best-3rd slots are determined after all groups finish — the 8 highest-ranked 3rd-place teams advance.
        </div>
      </div>

      {sections.map(({ title, matches }) => (
        <div key={title}>
          <div style={{ fontSize: 10, fontWeight: 800, color: 'var(--text-muted)', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 8 }}>
            {title}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {matches.map(m => {
              // Determine predicted winner from higher pR16
              const hProb = m.home ? (tournamentReach?.[m.home]?.pR16 ?? 0) : 0;
              const aProb = m.away ? (tournamentReach?.[m.away]?.pR16 ?? 0) : 0;
              const favHome = m.home && m.away && hProb >= aProb;
              const accent  = favHome ? 'var(--blue)' : m.away ? 'var(--gold)' : 'rgba(255,255,255,0.15)';

              return (
                <div key={m.id} style={{
                  background:   'var(--surface2)',
                  borderRadius: 10,
                  border:       '1px solid var(--border)',
                  borderLeft:   `3px solid ${accent}`,
                  padding:      '10px 12px',
                }}>
                  {/* Match label */}
                  <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 0.8, marginBottom: 8, textTransform: 'uppercase' }}>
                    R32 Match {m.id} · {m.desc}
                  </div>
                  {/* Teams */}
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                    <TeamSlot team={m.home} color='var(--blue)' />
                    <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', paddingTop: 3, flexShrink: 0 }}>vs</div>
                    <TeamSlot team={m.away} label={m.awayLabel} color='var(--gold)' />
                  </div>
                  {/* Probability bar (only when both teams known) */}
                  {m.home && m.away && (hProb + aProb > 0) && (
                    <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontSize: 9, color: 'var(--blue)', width: 28, textAlign: 'right' }}>{pct(hProb)}</span>
                      <div style={{ flex: 1, height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.08)', overflow: 'hidden', position: 'relative' }}>
                        <div style={{
                          position: 'absolute', left: 0, top: 0, bottom: 0,
                          width: `${(hProb / (hProb + aProb)) * 100}%`,
                          background: 'var(--blue)', borderRadius: 2,
                        }} />
                      </div>
                      <span style={{ fontSize: 9, color: 'var(--gold)', width: 28 }}>{pct(aProb)}</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

// PreTournamentView — just the group cards (tabs live in the outer bar)
function PreTournamentView({ data, onTeamClick }) {
  const { hardcodedGroups, groupMatchPredictions, wcSchedule } = data;

  function findSchedule(group, home, away) {
    return wcSchedule?.find(s =>
      s.group === group &&
      ((s.home === home && s.away === away) || (s.home === away && s.away === home))
    ) ?? null;
  }

  const [expandedGroup, setExpandedGroup] = useState(null);
  const [expandedH2H, setExpandedH2H]    = useState(null);

  return (
    <div>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {Object.entries(hardcodedGroups).map(([letter, teams]) => {
        const matches  = groupMatchPredictions?.[letter] ?? [];
        const isOpen   = expandedGroup === letter;
        const color    = GROUP_COLORS[letter] ?? 'var(--gold)';

        return (
          <div key={letter} className="card" style={{ padding: 0, overflow: 'hidden', borderLeft: `3px solid ${color}` }}>
            <button
              onClick={() => setExpandedGroup(isOpen ? null : letter)}
              style={{
                width:       '100%',
                background:  'transparent',
                border:      'none',
                padding:     '12px 14px',
                display:     'flex',
                alignItems:  'center',
                cursor:      'pointer',
                gap:         10,
              }}
            >
              <div style={{
                width: 32, height: 32, borderRadius: 8,
                background:  `${color}22`,
                border:      `1.5px solid ${color}55`,
                display:     'flex', alignItems: 'center', justifyContent: 'center',
                fontFamily:  'Bebas Neue, sans-serif', fontSize: 18, color,
                flexShrink:  0,
              }}>
                {letter}
              </div>
              <div style={{ flex: 1, textAlign: 'left' }}>
                <div style={{ fontWeight: 700, fontSize: 13, color }}>Group {letter}</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                  {teams.map(t => `${flag(t)} ${t}`).join('  ·  ')}
                </div>
              </div>
              <div style={{ fontSize: 14, color: 'var(--text-muted)', transform: isOpen ? 'rotate(180deg)' : 'none', transition: '200ms' }}>▾</div>
            </button>

            {isOpen && (
              <div style={{ padding: '0 14px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>

                {matches.map((m, i) => {
                  const favours = m.homeWin > m.awayWin && m.homeWin > m.draw ? 'home'
                                : m.awayWin > m.homeWin && m.awayWin > m.draw ? 'away'
                                : 'draw';
                  const accent  = favours === 'home' ? 'var(--blue)'
                                : favours === 'away' ? 'var(--gold)'
                                : 'rgba(255,255,255,0.2)';
                  const sched   = findSchedule(letter, m.home, m.away);
                  return (
                    <div key={i} style={{
                      background:   'var(--surface2)',
                      borderRadius: 10,
                      border:       '1px solid var(--border)',
                      borderLeft:   `3px solid ${accent}`,
                      padding:      '10px 12px',
                    }}>
                      {/* Schedule header */}
                      {sched && (
                        <div style={{ marginBottom: 8, display: 'flex', flexDirection: 'column', gap: 1 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                            <span style={{ fontSize: 9, color: color, fontWeight: 700, letterSpacing: 0.5 }}>MD{sched.md}</span>
                            <span style={{ fontSize: 9, color: 'var(--text-muted)', letterSpacing: 0.3 }}>·</span>
                            <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>📅 {fmtKickoffUTC(sched.kickoff)}</span>
                          </div>
                          <div style={{ fontSize: 9, color: 'var(--text-muted)' }}>
                            📍 {sched.venue}, {sched.city}
                          </div>
                        </div>
                      )}

                      {/* Teams row */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                        <span style={{ fontSize: 16, cursor: 'pointer' }} onClick={() => onTeamClick?.(m.home)}>{flag(m.home)}</span>
                        <span style={{ fontSize: 12, fontWeight: 600, flex: 1, cursor: 'pointer' }} onClick={() => onTeamClick?.(m.home)}>{m.home}</span>
                        <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>vs</span>
                        <span style={{ fontSize: 12, fontWeight: 600, flex: 1, textAlign: 'right', cursor: 'pointer' }} onClick={() => onTeamClick?.(m.away)}>{m.away}</span>
                        <span style={{ fontSize: 16, cursor: 'pointer' }} onClick={() => onTeamClick?.(m.away)}>{flag(m.away)}</span>
                      </div>

                      {/* Score + probabilities */}
                      <div style={{
                        borderTop:    '1px solid var(--border)',
                        borderBottom: '1px solid var(--border)',
                        padding:      '7px 0',
                        display:      'flex',
                        alignItems:   'center',
                        justifyContent: 'space-between',
                        gap:          6,
                      }}>
                        <div style={{ flex: 1, textAlign: 'center' }}>
                          <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 0.6, marginBottom: 2 }}>HOME WIN</div>
                          <div style={{ fontSize: 13, fontWeight: 700, color: favours === 'home' ? 'var(--blue)' : 'var(--text-muted)' }}>{pct(m.homeWin)}</div>
                        </div>
                        <div style={{ textAlign: 'center' }}>
                          <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 0.6, marginBottom: 2 }}>PREDICTED</div>
                          <div style={{ fontFamily: 'Bebas Neue, sans-serif', fontSize: 22, letterSpacing: 2, color: 'var(--gold)', lineHeight: 1 }}>
                            {m.predictedScore.replace('-', '–')}
                          </div>
                        </div>
                        <div style={{ flex: 1, textAlign: 'center' }}>
                          <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 0.6, marginBottom: 2 }}>AWAY WIN</div>
                          <div style={{ fontSize: 13, fontWeight: 700, color: favours === 'away' ? 'var(--gold)' : 'var(--text-muted)' }}>{pct(m.awayWin)}</div>
                        </div>
                      </div>

                      {/* Draw bar */}
                      <div style={{ marginTop: 7, display: 'flex', alignItems: 'center', gap: 6 }}>
                        <div style={{ flex: 1, height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
                          <div style={{ width: `${m.homeWin * 100}%`, height: '100%', background: 'var(--blue)', borderRadius: 2 }} />
                        </div>
                        <span style={{ fontSize: 9, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{pct(m.draw)} draw</span>
                        <div style={{ flex: 1, height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
                          <div style={{ width: `${m.awayWin * 100}%`, height: '100%', background: 'var(--gold)', borderRadius: 2, marginLeft: 'auto' }} />
                        </div>
                      </div>

                      {/* H2H toggle */}
                      {(() => {
                        const key = `${letter}-${i}`;
                        const open = expandedH2H === key;
                        return (
                          <>
                            <button
                              onClick={() => setExpandedH2H(open ? null : key)}
                              style={{
                                marginTop: 8, width: '100%', background: 'transparent',
                                border: `1px solid ${color}44`, borderRadius: 6,
                                padding: '4px 0', fontSize: 10, fontWeight: 700,
                                color: open ? color : 'var(--text-muted)', cursor: 'pointer',
                              }}
                            >
                              {open ? '▲ Hide H2H' : '▼ Head to Head'}
                            </button>
                            {open && <H2HPanel home={m.home} away={m.away} color={color} />}
                          </>
                        );
                      })()}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
    </div>
  );
}

// ─── Disclaimer Modal (shown once on first visit) ─────────────────────────────
function DisclaimerModal({ onDismiss }) {
  return (
    <div
      style={{
        position:   'fixed',
        inset:       0,
        zIndex:      2000,
        background:  'rgba(0,0,0,0.72)',
        display:     'flex',
        alignItems:  'center',
        justifyContent: 'center',
        padding:     '0 20px',
      }}
    >
      <div style={{
        width:        '100%',
        maxWidth:     360,
        background:   'var(--surface)',
        borderRadius: 18,
        border:       '1px solid var(--border)',
        overflow:     'hidden',
        boxShadow:    '0 24px 64px rgba(0,0,0,0.6)',
      }}>
        {/* Gold accent bar */}
        <div style={{ height: 4, background: 'linear-gradient(90deg, var(--gold), #fb923c)' }} />

        <div style={{ padding: '24px 20px 20px' }}>
          {/* Icon + title */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
            <span style={{ fontSize: 36, lineHeight: 1 }}>⚽</span>
            <div>
              <div style={{ fontFamily: 'Bebas Neue, sans-serif', fontSize: 20, letterSpacing: 1.5, color: 'var(--gold)', lineHeight: 1 }}>
                JUST FOR FUN
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>World Cup 2026 Predictor</div>
            </div>
          </div>

          {/* Body text */}
          <p style={{ fontSize: 13, color: 'var(--text-primary)', lineHeight: 1.65, margin: '0 0 10px' }}>
            This is a <strong>fun prediction tool for entertainment purposes only.</strong> All forecasts are generated by a statistical model (Poisson + Monte Carlo) and are not intended as betting advice.
          </p>
          <p style={{ fontSize: 13, color: 'var(--text-primary)', lineHeight: 1.65, margin: '0 0 20px' }}>
            Enjoy the tournament! 🏆🌍
          </p>

          {/* Dismiss button */}
          <button
            onClick={onDismiss}
            style={{
              width:        '100%',
              padding:      '11px 0',
              borderRadius: 10,
              background:   'var(--gold)',
              border:       'none',
              color:        '#000',
              fontWeight:   800,
              fontSize:     14,
              letterSpacing: 0.5,
              cursor:       'pointer',
            }}
          >
            Got it, let's go!
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function WorldCup() {
  const { data, loading, error } = useWCTournament();
  const [view, setView]          = useState('groups'); // 'groups' | 'knockout' | 'accuracy'
  const [selectedTeam, setSelectedTeam] = useState(null);
  const [showDisclaimer, setShowDisclaimer] = useState(() => {
    try { return !localStorage.getItem('wc_disclaimer_seen'); } catch { return false; }
  });

  function dismissDisclaimer() {
    try { localStorage.setItem('wc_disclaimer_seen', '1'); } catch {}
    setShowDisclaimer(false);
  }

  if (loading) {
    return <div className="loading-card"><div className="spinner" /><div>Loading World Cup data…</div></div>;
  }

  if (error && !data) {
    return (
      <div className="card" style={{ textAlign: 'center', color: 'var(--red)', padding: 40 }}>
        <div style={{ fontWeight: 600 }}>Failed to load</div>
        <div style={{ fontSize: 12, marginTop: 4, color: 'var(--text-muted)' }}>{error}</div>
      </div>
    );
  }

  const phase          = data?.phase ?? 'PRE_TOURNAMENT';
  const hasApiData     = data?.hasLiveData && (data.groupFixtures?.length > 0 || data.knockoutFixtures?.length > 0);
  const knockoutPhases = ['ROUND_OF_32','ROUND_OF_16','QUARTER_FINALS','SEMI_FINALS','FINAL','COMPLETE'];
  const isKnockout     = knockoutPhases.includes(phase);

  return (
    <div>
      {/* Header */}
      <div className="hero-card" style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
          <span style={{ fontSize: 28 }}>🌍</span>
          <div>
            <div style={{ fontFamily: 'Bebas Neue, sans-serif', fontSize: 26, letterSpacing: 2, lineHeight: 1 }}>
              FIFA WORLD CUP 2026
            </div>
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', letterSpacing: 1 }}>
              USA · CANADA · MEXICO
            </div>
          </div>
        </div>
        <PhaseBadge phase={phase} />
      </div>

      {/* Single tab bar — adapts between pre-tournament and live */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 12, overflowX: 'auto', WebkitOverflowScrolling: 'touch', paddingBottom: 2 }}>
        {(hasApiData ? [
          { id: 'groups',   label: 'Groups' },
          { id: 'bracket',  label: 'Bracket' },
          { id: 'knockout', label: 'Knockout', disabled: !isKnockout && !data?.knockoutFixtures?.length },
          { id: 'accuracy', label: '📊 Accuracy' },
          { id: 'rankings', label: '📈 Rankings' },
        ] : [
          { id: 'groups',   label: 'Groups' },
          { id: 'table',    label: 'Table' },
          { id: 'bracket',  label: 'Bracket' },
          { id: 'insights', label: 'Insights' },
          { id: 'odds',     label: '🏆 Odds' },
          { id: 'rankings', label: '📈 Rankings' },
        ]).map(({ id, label, disabled }) => (
          <button
            key={id}
            disabled={disabled}
            onClick={() => !disabled && setView(id)}
            style={{
              flex:         '0 0 auto',
              minWidth:     64,
              padding:      '8px 12px',
              borderRadius: 8,
              border:       view === id ? '1.5px solid var(--gold)' : '1px solid var(--border)',
              background:   view === id ? 'rgba(255,215,0,0.1)' : 'var(--surface2)',
              color:        view === id ? 'var(--gold)' : disabled ? 'var(--text-muted)' : 'var(--text-primary)',
              fontWeight:   700,
              fontSize:     11,
              whiteSpace:   'nowrap',
              cursor:       disabled ? 'not-allowed' : 'pointer',
              opacity:      disabled ? 0.45 : 1,
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Content */}
      {view === 'rankings' ? (
        <EloRankingsView />
      ) : view === 'bracket' ? (
        <BracketView data={{ hardcodedGroups: {}, ...data }} />
      ) : !hasApiData && view === 'table' ? (
        <PredictedTableView data={{ hardcodedGroups: {}, ...data }} onTeamClick={setSelectedTeam} />
      ) : !hasApiData && view === 'insights' ? (
        <InsightsView data={{ hardcodedGroups: {}, ...data }} onTeamClick={setSelectedTeam} />
      ) : !hasApiData && view === 'odds' ? (
        <WinnerOddsView data={{ hardcodedGroups: {}, ...data }} onTeamClick={setSelectedTeam} />
      ) : !hasApiData ? (
        <PreTournamentView data={{ hardcodedGroups: {}, phase: 'PRE_TOURNAMENT', ...data }} onTeamClick={setSelectedTeam} />
      ) : view === 'groups' ? (
        <GroupStageView data={data} />
      ) : view === 'accuracy' ? (
        <AccuracyView data={data} />
      ) : (
        <KnockoutView data={data} />
      )}

      {/* Team detail modal */}
      {selectedTeam && (
        <TeamDetailModal
          team={selectedTeam}
          data={data}
          onClose={() => setSelectedTeam(null)}
        />
      )}

      {/* One-time disclaimer */}
      {showDisclaimer && <DisclaimerModal onDismiss={dismissDisclaimer} />}
    </div>
  );
}
