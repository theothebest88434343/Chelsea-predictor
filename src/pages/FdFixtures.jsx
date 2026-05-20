import { useState, useMemo } from 'react';
import { format, parseISO } from 'date-fns';
import { useParams } from 'react-router-dom';
import { ChevronDown, ChevronUp, BarChart2, Zap, Activity, GitMerge } from 'lucide-react';
import { useFetch } from '../hooks/useFetch';
import { useFavouriteTeam } from '../hooks/useFavouriteTeam';
import { getLeague } from '../utils/leagues.jsx';
import { ConfidenceBadge } from '../utils/confidence.jsx';
import ScoreMatrix from '../components/ScoreMatrix';
import XGPanel from '../components/XGPanel';
import FormChart from '../components/FormChart';
import H2HPanel from '../components/H2HPanel';

// ─── Crest image ──────────────────────────────────────────────────────────────

function Crest({ src, alt, size = 22 }) {
  if (!src) return <div style={{ width: size, height: size, flexShrink: 0 }} />;
  return (
    <img
      src={src} alt={alt}
      style={{ width: size, height: size, objectFit: 'contain', flexShrink: 0 }}
    />
  );
}

// ─── Probability bar (identical to PL) ───────────────────────────────────────

function ProbBar({ homeWin, draw, awayWin, homeName, awayName }) {
  const h = Math.round(homeWin * 100);
  const d = Math.round(draw    * 100);
  const a = 100 - h - d;
  return (
    <div>
      <div className="prob-row">
        <div className="prob-segment home" style={{ flex: h }}>{h >= 14 && `${h}%`}</div>
        <div className="prob-segment draw" style={{ flex: d }}>{d >= 10 && `${d}%`}</div>
        <div className="prob-segment away" style={{ flex: Math.max(a, 1) }}>{a >= 14 && `${a}%`}</div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>
        <span>{homeName}</span><span>Draw</span><span>{awayName}</span>
      </div>
    </div>
  );
}

// ─── Derive per-team recent form from all-matches data ────────────────────────

function deriveForm(allMatches, teamId) {
  const played = (allMatches ?? [])
    .filter(m => m.finished && m.homeGoals != null &&
      (m.homeTeam.id === teamId || m.awayTeam.id === teamId))
    .sort((a, b) => new Date(b.kickoffTime) - new Date(a.kickoffTime))
    .slice(0, 5);

  return played.map(m => ({
    homeGoals: m.homeTeam.id === teamId ? m.homeGoals : m.awayGoals,
    awayGoals: m.homeTeam.id === teamId ? m.awayGoals : m.homeGoals,
  }));
}

// ─── Team switcher (built from FD match data) ─────────────────────────────────

function FdTeamSwitcher({ teams, selectedId, onChange }) {
  const [query, setQuery] = useState('');

  const filtered = teams.filter(t =>
    query === '' ||
    t.name.toLowerCase().includes(query.toLowerCase()) ||
    t.shortName.toLowerCase().includes(query.toLowerCase())
  );

  return (
    <div style={{ marginBottom: 12 }}>
      <input
        type="text"
        placeholder="Search team…"
        value={query}
        onChange={e => setQuery(e.target.value)}
        style={{
          width: '100%', boxSizing: 'border-box',
          padding: '8px 12px', borderRadius: 8,
          border: '1px solid var(--border)', background: 'var(--surface2)',
          color: 'var(--text)', fontSize: 13, fontFamily: 'inherit',
          marginBottom: 8, outline: 'none',
        }}
      />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 }}>
        {filtered.map(team => {
          const active = selectedId === team.id;
          return (
            <button
              key={team.id}
              onClick={() => onChange(active ? null : team.id)}
              style={{
                display: 'flex', flexDirection: 'column', alignItems: 'center',
                gap: 4, padding: '8px 4px', borderRadius: 8,
                border: '1px solid',
                borderColor: active ? 'var(--gold)' : 'var(--border)',
                background: active ? 'rgba(219,161,17,0.12)' : 'var(--surface2)',
                cursor: 'pointer', fontFamily: 'inherit', transition: 'all 0.15s',
              }}
            >
              <Crest src={team.crest} alt={team.shortName} size={24} />
              <span style={{
                fontSize: 10, fontWeight: 600, letterSpacing: 0.3,
                color: active ? 'var(--gold)' : 'var(--text-muted)',
                textAlign: 'center', lineHeight: 1.2,
              }}>
                {team.shortName}
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

// ─── FD AI opponent analysis (collapsed card, like PL OpponentAnalysis) ───────

function FdOpponentAnalysis({ leagueId, opponentId, opponentName, myTeamName }) {
  const [open, setOpen] = useState(false);

  const url = open && opponentId && opponentName
    ? `/api/fd/opponent-analysis?league=${leagueId}&opponentId=${opponentId}&opponentName=${encodeURIComponent(opponentName)}&myTeamName=${encodeURIComponent(myTeamName)}`
    : null;

  const { data, loading, error } = useFetch(url);

  return (
    <div className="card">
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%', background: 'none', border: 'none', cursor: 'pointer',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          color: 'var(--text)', fontFamily: 'inherit', padding: 0,
        }}
      >
        <span className="card-title" style={{ margin: 0 }}>AI opponent analysis</span>
        {open
          ? <ChevronUp   size={18} color="var(--text-muted)" />
          : <ChevronDown size={18} color="var(--text-muted)" />}
      </button>

      {open && (
        <div style={{ marginTop: 12 }}>
          {loading && <div className="loading-card" style={{ padding: 20 }}><div className="spinner" /></div>}
          {error   && <div className="error-card">Could not load analysis</div>}
          {data?.analysis && (
            <>
              {data.formStr && (
                <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
                  {data.formStr.split('').map((ch, i) => (
                    <div key={i} className={`form-dot ${ch}`}>{ch}</div>
                  ))}
                </div>
              )}
              <div
                style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--text)' }}
                dangerouslySetInnerHTML={{
                  __html: data.analysis
                    .replace(/\n/g, '<br/>')
                    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>'),
                }}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Single fixture row (expandable) — mirrors PL FixtureRow ─────────────────

function FdFixtureRow({ match, leagueId, selectedTeamId, favTeam }) {
  const [expanded, setExpanded] = useState(false);

  // Prediction — fetch for upcoming matches only (always, not lazily, like PL)
  const { data: predData } = useFetch(
    !match.finished ? `/api/fd/predictions?league=${leagueId}&fixtureId=${match.id}` : null
  );
  const pred = predData?.prediction;

  // All-matches — fetched lazily on expand for form + H2H derivation
  const { data: allMatches } = useFetch(
    expanded ? `/api/fd/matches?league=${leagueId}` : null
  );

  // Determine "my team" perspective for H2H and AI analysis.
  // Priority: explicitly selected team → fav team if in this match.
  let myTeam     = null;
  let opponentId = null;
  if (selectedTeamId) {
    const isHome = match.homeTeam.id === selectedTeamId;
    myTeam     = isHome ? match.homeTeam : match.awayTeam;
    opponentId = isHome ? match.awayTeam.id : match.homeTeam.id;
  } else if (favTeam?.id &&
    (match.homeTeam.id === favTeam.id || match.awayTeam.id === favTeam.id)) {
    const isHome = match.homeTeam.id === favTeam.id;
    myTeam     = isHome ? match.homeTeam : match.awayTeam;
    opponentId = isHome ? match.awayTeam.id : match.homeTeam.id;
  }

  // H2H — lazy, upcoming only, only when there's a perspective team
  const { data: h2hData, loading: h2hLoading } = useFetch(
    expanded && !match.finished && opponentId
      ? `/api/fd/h2h?league=${leagueId}&homeTeamId=${match.homeTeam.id}&awayTeamId=${match.awayTeam.id}`
      : null
  );

  const homeIsSelected = match.homeTeam.id === selectedTeamId;
  const awayIsSelected = match.awayTeam.id === selectedTeamId;
  const kicks = match.kickoffTime ? parseISO(match.kickoffTime) : null;

  const winSide = match.finished
    ? match.homeGoals > match.awayGoals ? 'home'
      : match.awayGoals > match.homeGoals ? 'away'
      : 'draw'
    : null;

  const homeForm = expanded ? deriveForm(allMatches, match.homeTeam.id) : [];
  const awayForm = expanded ? deriveForm(allMatches, match.awayTeam.id) : [];

  const opponentTeam = opponentId
    ? (match.homeTeam.id === opponentId ? match.homeTeam : match.awayTeam)
    : null;

  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden', marginBottom: 10 }}>
      {/* ── Clickable header ─────────────────────────────────────────────────── */}
      <div
        style={{ padding: '14px 16px', cursor: 'pointer' }}
        onClick={() => setExpanded(e => !e)}
      >
        {/* Row 1: MD chip + kickoff + chevron */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="chip chip-muted">MD {match.matchday}</span>
            {kicks && (
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                {format(kicks, 'EEE d MMM · HH:mm')}
              </span>
            )}
          </div>
          {expanded
            ? <ChevronUp   size={16} color="var(--text-muted)" />
            : <ChevronDown size={16} color="var(--text-muted)" />}
        </div>

        {/* Row 2: home crest + name | score/pred | name + away crest */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          {/* Home */}
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <Crest src={match.homeTeam.crest} alt={match.homeTeam.shortName} size={22} />
              <span style={{
                fontWeight: homeIsSelected || winSide === 'home' ? 700 : 500,
                color: homeIsSelected       ? 'var(--gold)'
                     : winSide === 'home'  ? 'var(--gold)'
                     : 'var(--text)',
                fontSize: 15,
              }}>
                {match.homeTeam.name}
              </span>
            </div>
          </div>

          {/* Centre */}
          <div style={{ textAlign: 'center', minWidth: 72 }}>
            {match.finished ? (
              <div style={{ fontFamily: 'Bebas Neue, sans-serif', fontSize: 26, letterSpacing: 3, color: 'var(--text)', lineHeight: 1 }}>
                {match.homeGoals} – {match.awayGoals}
              </div>
            ) : pred ? (
              <>
                <div style={{ fontFamily: 'Bebas Neue, sans-serif', fontSize: 26, letterSpacing: 3, color: 'var(--text)', lineHeight: 1 }}>
                  {pred.predictedScore?.replace('-', '–') ?? '?–?'}
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 1 }}>predicted</div>
              </>
            ) : (
              <div style={{ color: 'var(--text-muted)', fontFamily: 'Bebas Neue, sans-serif', fontSize: 20 }}>vs</div>
            )}
          </div>

          {/* Away */}
          <div style={{ flex: 1, textAlign: 'right' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 7 }}>
              <span style={{
                fontWeight: awayIsSelected || winSide === 'away' ? 700 : 500,
                color: awayIsSelected       ? 'var(--gold)'
                     : winSide === 'away'  ? 'var(--gold)'
                     : 'var(--text)',
                fontSize: 15,
              }}>
                {match.awayTeam.name}
              </span>
              <Crest src={match.awayTeam.crest} alt={match.awayTeam.shortName} size={22} />
            </div>
          </div>
        </div>

        {/* Row 3: ProbBar — upcoming only */}
        {pred && (
          <div style={{ marginTop: 10 }}>
            <ProbBar
              homeWin={pred.homeWin} draw={pred.draw} awayWin={pred.awayWin}
              homeName={match.homeTeam.shortName} awayName={match.awayTeam.shortName}
            />
          </div>
        )}

        {/* Row 4: ConfidenceBadge */}
        {pred && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4, alignItems: 'center' }}>
            <ConfidenceBadge homeWin={pred.homeWin} draw={pred.draw} awayWin={pred.awayWin} />
          </div>
        )}
      </div>

      {/* ── Expanded panel ────────────────────────────────────────────────────── */}
      {expanded && (
        <div style={{ borderTop: '1px solid var(--border)' }}>

          {/* Model inputs — upcoming only */}
          {pred?.lambdas && (
            <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
                <Zap size={13} color="var(--gold)" />
                <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 1 }}>MODEL INPUTS</span>
              </div>
              <XGPanel lambdas={pred.lambdas} strengths={pred.strengths} homeTeam={match.homeTeam} awayTeam={match.awayTeam} />
            </div>
          )}

          {/* Score matrix — upcoming only */}
          {pred?.matrix && (
            <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
                <BarChart2 size={13} color="var(--gold)" />
                <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 1 }}>SCORE MATRIX</span>
              </div>
              <ScoreMatrix matrix={pred.matrix} homeTeam={match.homeTeam} awayTeam={match.awayTeam} />
            </div>
          )}

          {/* H2H — upcoming + perspective team only */}
          {!match.finished && opponentId && (
            <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
                <GitMerge size={13} color="var(--gold)" />
                <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 1 }}>HEAD TO HEAD</span>
              </div>
              <H2HPanel
                h2h={h2hData ?? []}
                loading={h2hLoading}
                myTeamName={myTeam?.name ?? ''}
                myTeamShort={myTeam?.shortName ?? ''}
              />
            </div>
          )}

          {/* Recent form — both sections */}
          {(homeForm.length > 0 || awayForm.length > 0) && (
            <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12 }}>
                <Activity size={13} color="var(--gold)" />
                <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 1 }}>RECENT FORM</span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                <FormChart results={homeForm} teamName={match.homeTeam.shortName} />
                <FormChart results={awayForm} teamName={match.awayTeam.shortName} />
              </div>
            </div>
          )}

          {/* Loading spinner while allMatches arrives */}
          {!allMatches && homeForm.length === 0 && awayForm.length === 0 && (
            <div style={{ padding: '14px 16px', display: 'flex', justifyContent: 'center' }}>
              <div className="spinner" style={{ width: 20, height: 20 }} />
            </div>
          )}

          {/* AI opponent analysis — upcoming + perspective team only */}
          {!match.finished && opponentTeam && myTeam && (
            <div style={{ padding: '0 16px 16px' }}>
              <FdOpponentAnalysis
                leagueId={leagueId}
                opponentId={opponentTeam.id}
                opponentName={opponentTeam.name}
                myTeamName={myTeam.name}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function FdFixtures() {
  const { leagueId } = useParams();
  const league   = getLeague(leagueId);
  const favTeam  = useFavouriteTeam();

  const [selectedTeamId, setSelectedTeamId] = useState(null);

  const { data: fixtures, loading: fLoading, error: fError } = useFetch(`/api/fd/fixtures?league=${leagueId}`);

  // Derive sorted unique team list from fixtures
  const teams = useMemo(() => {
    const map = new Map();
    for (const m of (fixtures ?? [])) {
      if (!map.has(m.homeTeam.id)) map.set(m.homeTeam.id, m.homeTeam);
      if (!map.has(m.awayTeam.id)) map.set(m.awayTeam.id, m.awayTeam);
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [fixtures]);

  const filter = ms => selectedTeamId
    ? ms.filter(m => m.homeTeam.id === selectedTeamId || m.awayTeam.id === selectedTeamId)
    : ms;

  const upcomingMatches = filter(fixtures ?? []);

  const selectedTeam = teams.find(t => t.id === selectedTeamId);
  const loading = fLoading;
  const error   = fError;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <div className="section-title" style={{ margin: 0 }}>
          {selectedTeam ? selectedTeam.name : `${league.name} fixtures`}
        </div>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          {upcomingMatches.length} games
        </span>
      </div>

      {/* Team switcher — only once fixtures loaded */}
      {!fLoading && teams.length > 0 && (
        <FdTeamSwitcher
          teams={teams}
          selectedId={selectedTeamId}
          onChange={setSelectedTeamId}
        />
      )}

      {loading && (
        <div className="loading-card">
          <div className="spinner" />
          <div>Loading {league.name} fixtures…</div>
        </div>
      )}
      {error && <div className="error-card">Failed to load: {error}</div>}

      {!loading && !error && upcomingMatches.length === 0 && (
        <div className="loading-card">No upcoming fixtures found.</div>
      )}

      {/* ── Upcoming ─────────────────────────────────────────────────────────── */}
      {!fLoading && upcomingMatches.map(m => (
        <FdFixtureRow
          key={m.id}
          match={m}
          leagueId={leagueId}
          selectedTeamId={selectedTeamId}
          favTeam={favTeam}
        />
      ))}

      {!loading && (
        <div style={{ textAlign: 'center', marginTop: 12, fontSize: 11, color: 'var(--text-muted)' }}>
          Data via football-data.org
        </div>
      )}
    </div>
  );
}
