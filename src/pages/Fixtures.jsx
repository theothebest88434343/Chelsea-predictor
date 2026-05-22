import { useState } from 'react';
import { format } from 'date-fns';
import { useParams } from 'react-router-dom';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useFetch } from '../hooks/useFetch';
import { usePrediction } from '../hooks/usePredictions';
import { useFavouriteTeam } from '../hooks/useFavouriteTeam';
import ScoreMatrix from '../components/ScoreMatrix';
import OddsPanel from '../components/OddsPanel';
import XGPanel from '../components/XGPanel';
import H2HPanel from '../components/H2HPanel';
import InjuriesPanel from '../components/InjuriesPanel';
import WeatherPanel from '../components/WeatherPanel';
import RefereePanel from '../components/RefereePanel';
import FormChart from '../components/FormChart';
import OpponentAnalysis from '../components/OpponentAnalysis';
import Lineup from '../components/Lineup';
import TeamSwitcher from '../components/TeamSwitcher';
import ClubBadge from '../components/ClubBadge';
import { ComingSoon } from '../utils/leagues.jsx';
import FdFixtures from './FdFixtures';
import { ErrorCard } from '../components/ui/ErrorCard';
import { ProbBar }          from '../components/ui/ProbBar';
import { ConfidenceChip }   from '../components/ui/ConfidenceChip';
import { ExpandableSection } from '../components/ui/ExpandableSection';

// ─── Weather wrapper (hides border when no data) ─────────────────────────────

function WeatherWrapper({ fixtureId }) {
  const { data, loading } = useFetch(fixtureId ? `/api/weather/${fixtureId}` : null);
  if (loading || !data?.available) return null;
  return (
    <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)' }}>
      <WeatherPanel data={data} />
    </div>
  );
}

// ─── Why this prediction ──────────────────────────────────────────────────────
// Shows structured technical factors — the narrative overview is handled by
// getInsightText() and displayed in the collapsed card header instead.

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
      `suggesting a higher likelihood of a goal-rich home performance.`
    );
  } else if (aAtk > hAtk * 1.15 && hDef > aDef * 1.08) {
    factors.push(
      `${awayTeam.shortName}'s attack (${aAtk.toFixed(2)}×) is up against ` +
      `a vulnerable ${homeTeam.shortName} defence (${hDef.toFixed(2)}×) — ` +
      `raising the likelihood that the visitors test the home backline.`
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
      `${totalGoals.toFixed(1)} combined goals projected — both defences ` +
      `appear likely to limit scoring opportunities.`
    );
  }

  const topFactors = factors.slice(0, 4);

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

// ─── TeamComparisonMini ───────────────────────────────────────────────────────
// Compact head-to-head visual using EXISTING pred.lambdas + pred.strengths.
// No new API calls. Adds visual comparison that XGPanel text doesn't provide.
// Lower hDef/aDef = stronger defence (inverted multiplier), so we invert for bars.

function TeamComparisonMini({ pred, homeTeam, awayTeam }) {
  if (!pred?.lambdas || !pred?.strengths) return null;

  const { home: lH, away: lA }                       = pred.lambdas;
  const { hAtk = 1, hDef = 1, aAtk = 1, aDef = 1 } = pred.strengths;

  // xG bars: direct ratio to max
  const maxL    = Math.max(lH, lA, 0.01);
  const lHPct   = Math.round((lH / maxL) * 100);
  const lAPct   = Math.round((lA / maxL) * 100);

  // Attack bars: higher multiplier = stronger attack
  const maxAtk  = Math.max(hAtk, aAtk, 0.01);
  const hAtkPct = Math.round((hAtk / maxAtk) * 100);
  const aAtkPct = Math.round((aAtk / maxAtk) * 100);

  // Defence bars: LOWER multiplier = stronger defence, so invert
  const hDefInv  = 1 / Math.max(hDef, 0.01);
  const aDefInv  = 1 / Math.max(aDef, 0.01);
  const maxDefInv = Math.max(hDefInv, aDefInv, 0.01);
  const hDefPct  = Math.round((hDefInv / maxDefInv) * 100);
  const aDefPct  = Math.round((aDefInv / maxDefInv) * 100);

  const metrics = [
    { label: 'Exp. Goals', hVal: lH.toFixed(2),     aVal: lA.toFixed(2),     hPct: lHPct,   aPct: lAPct   },
    { label: 'Attack',     hVal: hAtk.toFixed(2)+'×', aVal: aAtk.toFixed(2)+'×', hPct: hAtkPct, aPct: aAtkPct },
    { label: 'Defence',    hVal: hDefPct+'%',         aVal: aDefPct+'%',          hPct: hDefPct, aPct: aDefPct },
  ];

  return (
    <div style={{ padding: '14px 16px', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
      <div style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-muted)', opacity: 0.6, marginBottom: 10 }}>
        Model comparison
      </div>
      {/* Team name header */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 72px 1fr', gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: '#7aadff' }}>
          {homeTeam?.shortName ?? homeTeam?.name}
        </span>
        <span />
        <span style={{ fontSize: 11, fontWeight: 600, color: '#e07878', textAlign: 'right' }}>
          {awayTeam?.shortName ?? awayTeam?.name}
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
        {metrics.map(({ label, hVal, aVal, hPct, aPct }) => (
          <div key={label} style={{ display: 'grid', gridTemplateColumns: '1fr 72px 1fr', gap: 8, alignItems: 'center' }}>
            {/* Home: value + bar fills right-to-left */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end' }}>
              <span style={{ fontSize: 11, color: '#7aadff', fontWeight: 600 }}>{hVal}</span>
              <div style={{ width: 48, height: 5, background: 'var(--surface2)', borderRadius: 3, overflow: 'hidden',
                            display: 'flex', justifyContent: 'flex-end' }}>
                <div style={{ width: `${hPct}%`, height: '100%', background: '#7aadff', borderRadius: 3,
                              transition: 'width 0.35s cubic-bezier(0.4,0,0.2,1)' }} />
              </div>
            </div>
            {/* Center label */}
            <div style={{ textAlign: 'center', fontSize: 10, fontWeight: 700, color: 'var(--text-muted)',
                          letterSpacing: '0.04em', textTransform: 'uppercase' }}>
              {label}
            </div>
            {/* Away: bar fills left-to-right + value */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <div style={{ width: 48, height: 5, background: 'var(--surface2)', borderRadius: 3, overflow: 'hidden' }}>
                <div style={{ width: `${aPct}%`, height: '100%', background: '#e07878', borderRadius: 3,
                              transition: 'width 0.35s cubic-bezier(0.4,0,0.2,1)' }} />
              </div>
              <span style={{ fontSize: 11, color: '#e07878', fontWeight: 600 }}>{aVal}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Single fixture row (expandable) ─────────────────────────────────────────

function FixtureRow({ fixture, selectedTeamId, favTeam }) {
  const [expanded,     setExpanded]     = useState(false);
  // Two-tier progressive disclosure: Key Evidence open by default, Markets collapsed
  const [insightOpen,  setInsightOpen]  = useState(true);
  const [marketsOpen,  setMarketsOpen]  = useState(false);
  const { data: prediction, loading: predLoading } = usePrediction(fixture.id);

  // Which side is the "followed" team — drives highlighting and opponentId
  const homeIsSelected = fixture.homeTeam.id === selectedTeamId;
  const awayIsSelected = fixture.awayTeam.id === selectedTeamId;
  const opponentId = selectedTeamId
    ? (homeIsSelected ? fixture.awayTeam.id : fixture.homeTeam.id)
    : null;

  // Determine which team's injuries to show.
  // When a team is selected via TeamSwitcher, show that team's injuries.
  // Otherwise fall back to the favourite team if it's in the fixture.
  let injuryTeam = null;
  if (selectedTeamId) {
    if (homeIsSelected)      injuryTeam = { code: fixture.homeTeam.code, short: fixture.homeTeam.shortName };
    else if (awayIsSelected) injuryTeam = { code: fixture.awayTeam.code, short: fixture.awayTeam.shortName };
  } else {
    const favInMatch = fixture.homeTeam.code === favTeam.code || fixture.awayTeam.code === favTeam.code;
    if (favInMatch) injuryTeam = { code: favTeam.code, short: favTeam.short };
  }

  // H2H perspective: use selected/injury team's code, fall back to favTeam
  const h2hTeamCode = injuryTeam?.code ?? favTeam.code;

  const { data: h2h, loading: h2hLoading } = useFetch(
    expanded && opponentId ? `/api/h2h/${opponentId}?teamCode=${h2hTeamCode}` : null
  );

  const { data: homeForm } = useFetch(
    expanded && fixture.homeTeam.id ? `/api/team-form?teamId=${fixture.homeTeam.id}` : null
  );
  const { data: awayForm } = useFetch(
    expanded && fixture.awayTeam.id ? `/api/team-form?teamId=${fixture.awayTeam.id}` : null
  );

  // Lineup — only available for SofaScore-sourced cup fixtures
  const { data: lineupData } = useFetch(
    expanded && fixture.isCup && fixture.id ? `/api/lineup?fixtureId=${fixture.id}` : null
  );

  const pred  = prediction?.prediction;
  const kicks = fixture.kickoffTime ? new Date(fixture.kickoffTime) : null;

  // Predicted winner for upcoming matches — used to give a subtle font-weight boost
  const homeIsPredWinner = !fixture.finished && pred && pred.homeWin > pred.awayWin + 0.05;
  const awayIsPredWinner = !fixture.finished && pred && pred.awayWin > pred.homeWin + 0.05;

  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden', marginBottom: 10 }}>
      <div
        style={{ padding: '14px 16px', cursor: 'pointer' }}
        onClick={() => setExpanded(e => !e)}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, opacity: 0.85 }}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            {fixture.isCup
              ? <span className="chip chip-gold" style={{ fontSize: 10 }}>{fixture.competition ?? 'Cup'}</span>
              : <span className="chip chip-muted">GW {fixture.gameweek}</span>
            }
            {kicks && (
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                {format(kicks, 'EEE d MMM · HH:mm')}
              </span>
            )}
          </div>
          {/* Right side: confidence chip + chevron */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <ConfidenceChip confidence={pred?.confidence} />
            {expanded
              ? <ChevronUp size={16} color="var(--text-muted)" />
              : <ChevronDown size={16} color="var(--text-muted)" />}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <ClubBadge code={fixture.homeTeam.code} short={fixture.homeTeam.shortName} size={22} />
              <span style={{
                fontWeight: homeIsSelected ? 700 : homeIsPredWinner ? 600 : 500,
                color: homeIsSelected ? 'var(--gold)' : 'var(--text)',
                fontSize: 15,
              }}>
                {fixture.homeTeam.name}
              </span>
            </div>
          </div>
          <div style={{ textAlign: 'center', minWidth: 72 }}>
            {pred ? (
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
          <div style={{ flex: 1, textAlign: 'right' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 7 }}>
              <span style={{
                fontWeight: awayIsSelected ? 700 : awayIsPredWinner ? 600 : 500,
                color: awayIsSelected ? 'var(--gold)' : 'var(--text)',
                fontSize: 15,
              }}>
                {fixture.awayTeam.name}
              </span>
              <ClubBadge code={fixture.awayTeam.code} short={fixture.awayTeam.shortName} size={22} />
            </div>
          </div>
        </div>

        {/* PROB BAR — probability summary, collapsed view */}
        {pred && (
          <div style={{ marginTop: 10 }}>
            <ProbBar
              homeWin={pred.homeWin} draw={pred.draw} awayWin={pred.awayWin}
              homeName={fixture.homeTeam.shortName} awayName={fixture.awayTeam.shortName}
            />
          </div>
        )}
      </div>

      {expanded && (
        <div style={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}>

          {/* ═══════════════════════════════════════════════════════════════ */}
          {/* TIER 2 — KEY EVIDENCE (default open)                           */}
          {/* KEY FACTORS · MODEL INPUTS · SCORE MATRIX · FORM · H2H        */}
          {/* LINEUPS · INJURIES · OPPONENT ANALYSIS                         */}
          {/* ═══════════════════════════════════════════════════════════════ */}
          <ExpandableSection
            title="Key Evidence"
            open={insightOpen}
            onToggle={() => setInsightOpen(o => !o)}
          >
            <div>
              {pred?.lambdas && (
                <WhyPrediction pred={pred} homeTeam={fixture.homeTeam} awayTeam={fixture.awayTeam} />
              )}
              {pred?.lambdas && (
                <div style={{ padding: '14px 16px', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                  <div style={{ marginBottom: 8 }}>
                    <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-muted)', opacity: 0.6 }}>Model inputs</span>
                  </div>
                  <XGPanel
                    lambdas={pred.lambdas}
                    strengths={pred.strengths}
                    homeTeam={fixture.homeTeam}
                    awayTeam={fixture.awayTeam}
                  />
                </div>
              )}
              {pred?.matrix && (
                <div style={{ padding: '14px 16px', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                  <div style={{ marginBottom: 8 }}>
                    <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-muted)', opacity: 0.6 }}>Score matrix</span>
                  </div>
                  <ScoreMatrix
                    matrix={pred.matrix}
                    homeTeam={fixture.homeTeam}
                    awayTeam={fixture.awayTeam}
                  />
                </div>
              )}
              {pred?.lambdas && pred?.strengths && (
                <TeamComparisonMini pred={pred} homeTeam={fixture.homeTeam} awayTeam={fixture.awayTeam} />
              )}
              {(homeForm?.recentResults?.length > 0 || awayForm?.recentResults?.length > 0) && (
                <div style={{ padding: '14px 16px', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                  <div style={{ marginBottom: 8 }}>
                    <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-muted)', opacity: 0.6 }}>Recent form</span>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                    <FormChart results={homeForm?.recentResults ?? []} teamName={fixture.homeTeam.shortName} />
                    <FormChart results={awayForm?.recentResults ?? []} teamName={fixture.awayTeam.shortName} />
                  </div>
                </div>
              )}
              {opponentId && (
                <div style={{ padding: '14px 16px', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                  {h2hLoading
                    ? <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading H2H…</div>
                    : <H2HPanel h2h={h2h ?? []} myTeamName={favTeam.name} myTeamShort={favTeam.short} />
                  }
                </div>
              )}
              {lineupData?.available && (
                <div style={{ padding: '14px 16px', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                  <div style={{ marginBottom: 8 }}>
                    <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-muted)', opacity: 0.6 }}>Lineups</span>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                    <Lineup formation={lineupData.home?.formation} players={lineupData.home?.players ?? {}} teamName={fixture.homeTeam.shortName} />
                    <Lineup formation={lineupData.away?.formation} players={lineupData.away?.players ?? {}} teamName={fixture.awayTeam.shortName} />
                  </div>
                </div>
              )}
              {injuryTeam && (
                <div style={{ padding: '0 16px 14px', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                  <InjuriesPanel key={injuryTeam.code} teamCode={injuryTeam.code} teamShort={injuryTeam.short} />
                </div>
              )}
              {opponentId && (
                <div style={{ padding: '0 16px 16px' }}>
                  <OpponentAnalysis teamId={opponentId} myTeamCode={injuryTeam?.code ?? favTeam.code} />
                </div>
              )}
            </div>
          </ExpandableSection>

          {/* ═══════════════════════════════════════════════════════════════ */}
          {/* TIER 3 — MARKETS & CONDITIONS (default collapsed)              */}
          {/* ODDS · OVER/UNDER · ASIAN HANDICAP · TOP SCORELINES           */}
          {/* WEATHER · REFEREE                                              */}
          {/* ═══════════════════════════════════════════════════════════════ */}
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
              {!predLoading && prediction?.odds && (
                <div style={{ padding: '14px 16px', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                  <OddsPanel
                    odds={prediction.odds}
                    prediction={pred}
                    homeTeam={fixture.homeTeam}
                    awayTeam={fixture.awayTeam}
                    fixtureId={fixture.id}
                  />
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
                            <div style={{
                              height: '100%', width: `${pct}%`, background: barColor,
                              borderRadius: 3, transition: 'width 0.35s cubic-bezier(0.4,0,0.2,1)',
                            }} />
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
              <WeatherWrapper fixtureId={fixture.id} />
              {prediction?.referee && (
                <div style={{ padding: '14px 16px', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                  <RefereePanel referee={prediction.referee} />
                </div>
              )}
              {/* Fallback: only shown when no market data is available at all */}
              {!predLoading && !prediction?.odds && !pred?.overUnder && (
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

export default function Fixtures() {
  const { leagueId } = useParams();
  const favTeam = useFavouriteTeam();
  const { data: allFixtures, loading, error, refresh } = useFetch('/api/all-fixtures');
  const [selectedTeam, setSelectedTeam] = useState(null);

  if (leagueId !== 'premier-league') return <FdFixtures />;

  if (loading) return <div className="loading-card"><div className="spinner" /><div>Loading fixtures…</div></div>;
  if (error)   return <ErrorCard message={error} onRetry={refresh} />;
  if (!allFixtures?.length) {
    return (
      <div className="loading-card">
        No upcoming fixtures found.
        <div style={{ fontSize: 12, marginTop: 6, color: 'var(--text-muted)' }}>
          The FPL API may be updating after the season ends.
        </div>
      </div>
    );
  }

  const displayed = selectedTeam
    ? allFixtures.filter(f =>
        f.homeTeam.id === selectedTeam.id || f.awayTeam.id === selectedTeam.id
      )
    : allFixtures;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <div className="section-title" style={{ margin: 0 }}>
          {selectedTeam ? `${selectedTeam.name ?? selectedTeam.short}` : 'All fixtures'}
        </div>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{displayed.length} games</span>
      </div>

      <div style={{ marginBottom: 12 }}>
        <TeamSwitcher
          selectedId={selectedTeam?.id ?? null}
          onChange={(team) => setSelectedTeam(prev => prev?.id === team.id ? null : team)}
        />
      </div>

      {displayed.map(fixture => (
        <FixtureRow
          key={fixture.id}
          fixture={fixture}
          selectedTeamId={selectedTeam?.id ?? null}
          favTeam={favTeam}
        />
      ))}
    </div>
  );
}
