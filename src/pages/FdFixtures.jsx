import { useState, useMemo, useEffect, useRef } from 'react';
import { format, parseISO } from 'date-fns';
import { useParams } from 'react-router-dom';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useFetch } from '../hooks/useFetch';
import { useFavouriteTeam } from '../hooks/useFavouriteTeam';
import { getLeague } from '../utils/leagues.jsx';
import ScoreMatrix from '../components/ScoreMatrix';
import XGPanel from '../components/XGPanel';
import FormChart from '../components/FormChart';
import H2HPanel from '../components/H2HPanel';
import { ProbBar }          from '../components/ui/ProbBar';
import { ExpandableSection } from '../components/ui/ExpandableSection';
import { ErrorCard }        from '../components/ui/ErrorCard';
import { Crest }            from '../components/ui/Crest';

// ─── Module-level prediction cache ───────────────────────────────────────────
// Keyed by full request URL (league + fixtureId). Survives re-renders and tab
// returns — once a prediction is fetched it is never re-requested in this session.
// Prevents N parallel prediction requests on mount and repeated requests on
// every visibilitychange event when many fixture rows are rendered.
const _predCache = new Map();

function useCachedPrediction(url) {
  const [data,    setData]    = useState(() => (url ? _predCache.get(url) ?? null : null));
  const [loading, setLoading] = useState(!data && !!url);
  const abortRef = useRef(null);

  useEffect(() => {
    if (!url) { setData(null); setLoading(false); return; }

    // Cache hit — no network request needed
    if (_predCache.has(url)) {
      setData(_predCache.get(url));
      setLoading(false);
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);

    fetch(url, { signal: controller.signal, cache: 'no-store' })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(d  => { _predCache.set(url, d); setData(d); setLoading(false); })
      .catch(err => { if (err.name !== 'AbortError') setLoading(false); });

    return () => controller.abort();
  }, [url]); // no refreshKey — predictions are immutable once generated

  return { data, loading };
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

// ─── Why this prediction ──────────────────────────────────────────────────────
// Header: "KEY FACTORS" (PL canonical). Factor 1 (favourite) removed — the
// hero sentence + tier badge already cover that signal. Factors: xG, atk/def, tempo.

function WhyPrediction({ pred, homeTeam, awayTeam }) {
  if (!pred?.lambdas) return null;

  const { home: lH, away: lA }                       = pred.lambdas;
  const { hAtk = 1, hDef = 1, aAtk = 1, aDef = 1 } = pred.strengths ?? {};

  const factors = [];
  const lDiff   = ((lH - lA) / Math.max(lA, 0.1) * 100).toFixed(0);

  // 1. Expected goals edge
  if (lH > lA * 1.12) {
    factors.push(
      `${homeTeam.shortName} are expected to create ${Math.abs(lDiff)}% more ` +
      `chances (λ ${lH.toFixed(2)} vs ${lA.toFixed(2)}), reflecting their ` +
      `home-field edge and recent xG form.`
    );
  } else if (lA > lH * 1.12) {
    factors.push(
      `${awayTeam.shortName} have a ${Math.abs(lDiff)}% expected-goal advantage ` +
      `(λ ${lA.toFixed(2)} vs ${lH.toFixed(2)}) — they are outperforming their hosts ` +
      `on recent xG metrics.`
    );
  } else {
    factors.push(
      `Both teams are closely matched on expected goals ` +
      `(${homeTeam.shortName} λ ${lH.toFixed(2)} · ${awayTeam.shortName} λ ${lA.toFixed(2)}), ` +
      `making the outcome hard to call.`
    );
  }

  // 2. Attack vs defence matchup
  if (hAtk > aAtk * 1.15 && aDef > hDef * 1.08) {
    factors.push(
      `${homeTeam.shortName}'s attack (${hAtk.toFixed(2)}×) faces a ` +
      `leaky ${awayTeam.shortName} defence (${aDef.toFixed(2)}×) — ` +
      `conditions for a goal-rich home performance.`
    );
  } else if (aAtk > hAtk * 1.15 && hDef > aDef * 1.08) {
    factors.push(
      `${awayTeam.shortName}'s attack (${aAtk.toFixed(2)}×) is up against ` +
      `a vulnerable ${homeTeam.shortName} defence (${hDef.toFixed(2)}×) — ` +
      `expect the visitors to test the home backline.`
    );
  } else if (hDef < aDef * 0.88) {
    factors.push(
      `${homeTeam.shortName} have the stronger defensive record ` +
      `(${hDef.toFixed(2)}× conceded rate vs ${awayTeam.shortName}'s ${aDef.toFixed(2)}×), ` +
      `which limits the away team's scoring chances.`
    );
  } else if (aDef < hDef * 0.88) {
    factors.push(
      `${awayTeam.shortName}'s defence is the standout factor ` +
      `(${aDef.toFixed(2)}× conceded rate vs ${homeTeam.shortName}'s ${hDef.toFixed(2)}×), ` +
      `capping how many the home side can score.`
    );
  }

  // 3. Match tempo — total goals projection
  const totalGoals = lH + lA;
  if (totalGoals >= 3.0) {
    factors.push(
      `An open, free-scoring match is projected — the model expects ` +
      `${totalGoals.toFixed(1)} total goals between the two sides.`
    );
  } else if (totalGoals <= 1.9) {
    factors.push(
      `A tight, low-scoring affair is expected — only ` +
      `${totalGoals.toFixed(1)} combined goals projected, suggesting strong ` +
      `defensive displays from both teams.`
    );
  }

  const topFactors = factors.slice(0, 3);

  return (
    <div style={{ padding: '14px 16px', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
      <div style={{ marginBottom: 10 }}>
        <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-muted)', opacity: 0.6 }}>
          Key factors
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {topFactors.map((factor, i) => (
          <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <div style={{
              width: 20, height: 20, borderRadius: '50%',
              background: 'rgba(219,161,17,0.15)', border: '1px solid rgba(219,161,17,0.35)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 10, fontWeight: 700, color: 'var(--gold)', flexShrink: 0, marginTop: 1,
            }}>
              {i + 1}
            </div>
            <div style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--text)' }}>
              {factor}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Single fixture row (expandable) — mirrors PL FixtureRow ─────────────────

function FdFixtureRow({ match, leagueId, selectedTeamId, favTeam }) {
  const [expanded,    setExpanded]    = useState(false);
  // Two-tier progressive disclosure: Key Evidence open by default, Markets collapsed
  const [insightOpen, setInsightOpen] = useState(true);
  const [marketsOpen, setMarketsOpen] = useState(false);

  // Prediction — fetch for upcoming matches only, cached per fixtureId.
  const { data: predData, loading: predLoading } = useCachedPrediction(
    !match.finished ? `/api/fd/predictions?league=${leagueId}&fixtureId=${match.id}` : null
  );
  const pred = predData?.prediction;

  // Predicted winner for upcoming matches — subtle font-weight boost for scannability
  const homeIsPredWinner = !match.finished && pred && pred.homeWin > pred.awayWin + 0.05;
  const awayIsPredWinner = !match.finished && pred && pred.awayWin > pred.homeWin + 0.05;

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
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, opacity: 0.85 }}>
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
                fontWeight: homeIsSelected || winSide === 'home' ? 700 : homeIsPredWinner ? 600 : 500,
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
                <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 1, letterSpacing: 1, fontWeight: 500 }}>PREDICTED</div>
              </>
            ) : (
              <div style={{ color: 'var(--text-muted)', fontFamily: 'Bebas Neue, sans-serif', fontSize: 20 }}>vs</div>
            )}
          </div>

          {/* Away */}
          <div style={{ flex: 1, textAlign: 'right' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 7 }}>
              <span style={{
                fontWeight: awayIsSelected || winSide === 'away' ? 700 : awayIsPredWinner ? 600 : 500,
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

        {/* PROB BAR — probability summary, collapsed view */}
        {pred && (
          <div style={{ marginTop: 10 }}>
            <ProbBar
              homeWin={pred.homeWin} draw={pred.draw} awayWin={pred.awayWin}
              homeName={match.homeTeam.shortName} awayName={match.awayTeam.shortName}
            />
          </div>
        )}
      </div>

      {/* ── Expanded panel — 2-tier progressive disclosure ─────────────────── */}
      {expanded && (
        <div style={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}>

          {/* ═══════════════════════════════════════════════════════════════════ */}
          {/* TIER 2 — KEY EVIDENCE (default open)                               */}
          {/* KEY FACTORS · MODEL INPUTS · SCORE MATRIX · FORM · H2H            */}
          {/* AI OPPONENT ANALYSIS                                               */}
          {/* ═══════════════════════════════════════════════════════════════════ */}
          <ExpandableSection
            title="Key Evidence"
            open={insightOpen}
            onToggle={() => setInsightOpen(o => !o)}
          >
            <div>
              {pred?.lambdas && (
                <WhyPrediction pred={pred} homeTeam={match.homeTeam} awayTeam={match.awayTeam} />
              )}
              {pred?.lambdas && (
                <div style={{ padding: '14px 16px', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                  <div style={{ marginBottom: 8 }}>
                    <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-muted)', opacity: 0.6 }}>Model inputs</span>
                  </div>
                  <XGPanel lambdas={pred.lambdas} strengths={pred.strengths} homeTeam={match.homeTeam} awayTeam={match.awayTeam} />
                </div>
              )}
              {pred?.matrix && (
                <div style={{ padding: '14px 16px', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                  <div style={{ marginBottom: 8 }}>
                    <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-muted)', opacity: 0.6 }}>Score matrix</span>
                  </div>
                  <ScoreMatrix matrix={pred.matrix} homeTeam={match.homeTeam} awayTeam={match.awayTeam} />
                </div>
              )}
              {(homeForm.length > 0 || awayForm.length > 0) && (
                <div style={{ padding: '14px 16px', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                  <div style={{ marginBottom: 8 }}>
                    <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-muted)', opacity: 0.6 }}>Recent form</span>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                    <FormChart results={homeForm} teamName={match.homeTeam.shortName} />
                    <FormChart results={awayForm} teamName={match.awayTeam.shortName} />
                  </div>
                </div>
              )}
              {!allMatches && homeForm.length === 0 && awayForm.length === 0 && (
                <div style={{ padding: '14px 16px', display: 'flex', justifyContent: 'center' }}>
                  <div className="spinner" style={{ width: 20, height: 20 }} />
                </div>
              )}
              {!match.finished && opponentId && (
                <div style={{ padding: '14px 16px', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                  <div style={{ marginBottom: 8 }}>
                    <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-muted)', opacity: 0.6 }}>Head to head</span>
                  </div>
                  <H2HPanel
                    h2h={h2hData ?? []}
                    loading={h2hLoading}
                    myTeamName={myTeam?.name ?? ''}
                    myTeamShort={myTeam?.shortName ?? ''}
                  />
                </div>
              )}
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
          </ExpandableSection>

          {/* ═══════════════════════════════════════════════════════════════════ */}
          {/* TIER 3 — MARKETS & CONDITIONS (default collapsed)                  */}
          {/* OVER/UNDER · ASIAN HANDICAP · TOP SCORELINES                      */}
          {/* ═══════════════════════════════════════════════════════════════════ */}
          <ExpandableSection
            title="Markets & Conditions"
            open={marketsOpen}
            onToggle={() => setMarketsOpen(o => !o)}
            borderTop
            isLast
          >
            {/* Tier 3 sits at slightly lower visual emphasis than Key Evidence */}
            <div style={{ opacity: 0.92 }}>
              {predLoading && (
                <div style={{ padding: '20px 16px', display: 'flex', justifyContent: 'center' }}>
                  <div className="spinner" style={{ width: 20, height: 20 }} />
                </div>
              )}
              {!predLoading && pred?.overUnder && (
                <div style={{ padding: '14px 16px', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                  <div style={{ marginBottom: 8 }}>
                    <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-muted)', opacity: 0.6 }}>Over / under</span>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {[
                      { label: 'Over 1.5', val: pred.overUnder.over15 },
                      { label: 'Over 2.5', val: pred.overUnder.over25 },
                      { label: 'Over 3.5', val: pred.overUnder.over35 },
                    ].map(({ label, val }) => {
                      const pct      = val * 100;
                      const barColor = pct >= 65 ? 'var(--green)' : pct >= 45 ? 'var(--gold)' : 'rgba(255,255,255,0.18)';
                      const txtColor = pct >= 65 ? 'var(--green)' : pct >= 45 ? 'var(--gold)' : 'var(--text-muted)';
                      return (
                        <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <span style={{ fontSize: 12, color: 'var(--text-muted)', width: 56, flexShrink: 0 }}>{label}</span>
                          <div style={{ flex: 1, height: 6, background: 'var(--surface2)', borderRadius: 3, overflow: 'hidden' }}>
                            <div style={{ height: '100%', width: `${pct}%`, background: barColor,
                                          borderRadius: 3, transition: 'width 0.35s cubic-bezier(0.4,0,0.2,1)' }} />
                          </div>
                          <span style={{ fontSize: 12, fontWeight: 700, color: txtColor, width: 36, textAlign: 'right' }}>
                            {pct.toFixed(0)}%
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
              {!predLoading && pred?.asianHandicap && (
                <div style={{ padding: '14px 16px', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                  <div style={{ marginBottom: 8 }}>
                    <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-muted)', opacity: 0.6 }}>Asian handicap</span>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
                    {[
                      { label: 'AH 0',           home: pred.asianHandicap.level?.home,  away: pred.asianHandicap.level?.away  },
                      { label: 'AH -0.5 / +0.5', home: pred.asianHandicap.homeMinus05,  away: pred.asianHandicap.awayMinus05  },
                      { label: 'AH -1.5 / +1.5', home: pred.asianHandicap.homeMinus15,  away: pred.asianHandicap.awayPlus15   },
                    ].map(({ label, home, away }) => (
                      <div key={label} style={{
                        background: 'var(--surface)', border: '1px solid rgba(255,255,255,0.05)',
                        borderRadius: 8, padding: '8px 10px', textAlign: 'center',
                      }}>
                        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 6 }}>{label}</div>
                        <div style={{ display: 'flex', justifyContent: 'space-around' }}>
                          <div>
                            <div style={{ fontSize: 13, fontWeight: 700, color: '#7aadff' }}>
                              {home != null ? `${(home * 100).toFixed(0)}%` : '–'}
                            </div>
                            <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>Home</div>
                          </div>
                          <div>
                            <div style={{ fontSize: 13, fontWeight: 700, color: '#e07878' }}>
                              {away != null ? `${(away * 100).toFixed(0)}%` : '–'}
                            </div>
                            <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>Away</div>
                          </div>
                        </div>
                        {home != null && away != null && (
                          <div style={{ display: 'flex', gap: 2, borderRadius: 3, overflow: 'hidden', height: 4, marginTop: 8 }}>
                            <div style={{ flex: Math.round(home * 100), background: '#7aadff',
                                          transition: 'flex 0.35s cubic-bezier(0.4,0,0.2,1)', minWidth: 2 }} />
                            <div style={{ flex: Math.round(away * 100), background: '#e07878',
                                          transition: 'flex 0.35s cubic-bezier(0.4,0,0.2,1)', minWidth: 2 }} />
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {!predLoading && pred?.topScores?.length > 0 && (
                <div style={{ padding: '14px 16px', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                  <div style={{ marginBottom: 8 }}>
                    <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-muted)', opacity: 0.6 }}>Top scorelines</span>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>
                    {pred.topScores.slice(0, 6).map(({ score, prob }) => (
                      <div key={score} style={{
                        background: 'var(--surface)', border: '1px solid rgba(255,255,255,0.05)',
                        borderRadius: 8, padding: '8px 10px',
                        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      }}>
                        <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--text)' }}>{score}</span>
                        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{(prob * 100).toFixed(1)}%</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {/* Fallback: only shown when no market data is available at all */}
              {!predLoading && !pred?.overUnder && (
                <div style={{ padding: '20px 16px', textAlign: 'center', fontSize: 13, color: 'var(--text-muted)' }}>
                  Market data unavailable
                </div>
              )}
            </div>
          </ExpandableSection>
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

  const { data: fixtures, loading: fLoading, error: fError, refresh: refreshFixtures } = useFetch(`/api/fd/fixtures?league=${leagueId}`);

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
      {error && <ErrorCard message={error} onRetry={refreshFixtures} />}

      {!loading && !error && upcomingMatches.length === 0 && (
        <div className="card" style={{ textAlign: 'center', padding: 32 }}>
          <div style={{ fontSize: 36, marginBottom: 10 }}>
            {selectedTeamId ? league.emoji : '🏆'}
          </div>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>
            {selectedTeamId ? 'No upcoming fixtures' : 'Season Complete'}
          </div>
          <div style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.5 }}>
            {selectedTeamId
              ? 'No scheduled matches found for this team.'
              : `All ${league.name} matches for this season have been played.\nCheck back when the new season kicks off.`}
          </div>
        </div>
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
