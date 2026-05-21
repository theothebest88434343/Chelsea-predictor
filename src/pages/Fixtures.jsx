import { useState } from 'react';
import { format } from 'date-fns';
import { useParams } from 'react-router-dom';
import { ChevronDown, ChevronUp, BarChart2, Zap, Activity, Users, Lightbulb } from 'lucide-react';
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
import { ConfidenceBadge } from '../utils/confidence.jsx';
import ClubBadge from '../components/ClubBadge';
import { ComingSoon } from '../utils/leagues.jsx';
import FdFixtures from './FdFixtures';

// ─── Probability bar ──────────────────────────────────────────────────────────

function ProbBar({ homeWin, draw, awayWin, homeName, awayName }) {
  const h = Math.round(homeWin * 100);
  const d = Math.round(draw * 100);
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

function WhyPrediction({ pred, homeTeam, awayTeam }) {
  if (!pred?.lambdas) return null;

  const { home: lH, away: lA }                          = pred.lambdas;
  const { hAtk = 1, hDef = 1, aAtk = 1, aDef = 1 }    = pred.strengths ?? {};
  const { homeWin = 0, draw = 0, awayWin = 0 }          = pred;

  const factors = [];

  // 1. Favourite / market leader
  const maxProb = Math.max(homeWin, draw, awayWin);
  if (homeWin === maxProb) {
    const label = maxProb >= 0.55 ? 'clear favourite' : 'slight favourite';
    factors.push(
      `${homeTeam.shortName} are the ${label} at ${Math.round(homeWin * 100)}% — ` +
      `home advantage and model ratings both lean their way.`
    );
  } else if (awayWin === maxProb) {
    const label = maxProb >= 0.55 ? 'clear favourite' : 'slight favourite';
    factors.push(
      `${awayTeam.shortName} are the ${label} at ${Math.round(awayWin * 100)}% — ` +
      `they carry a stronger expected-goal profile despite playing away.`
    );
  } else {
    factors.push(
      `This is a closely-contested match — a draw is the most likely single outcome ` +
      `at ${Math.round(draw * 100)}%, with both sides evenly matched.`
    );
  }

  // 2. Expected goals edge
  const lDiff = ((lH - lA) / Math.max(lA, 0.1) * 100).toFixed(0);
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

  // 3. Attack vs defence matchup
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

  // 4. Match tempo — total goals projection
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

  const topFactors = factors.slice(0, 4);

  return (
    <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12 }}>
        <Lightbulb size={13} color="var(--gold)" />
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 1 }}>
          WHY THIS PREDICTION
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
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
            <div style={{ fontSize: 13, lineHeight: 1.55, color: 'var(--text)' }}>
              {factor}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Single fixture row (expandable) ─────────────────────────────────────────

function FixtureRow({ fixture, selectedTeamId, favTeam }) {
  const [expanded, setExpanded] = useState(false);
  const { data: prediction } = usePrediction(fixture.id);

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

  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden', marginBottom: 10 }}>
      <div
        style={{ padding: '14px 16px', cursor: 'pointer' }}
        onClick={() => setExpanded(e => !e)}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
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
          {expanded
            ? <ChevronUp size={16} color="var(--text-muted)" />
            : <ChevronDown size={16} color="var(--text-muted)" />}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <ClubBadge code={fixture.homeTeam.code} short={fixture.homeTeam.shortName} size={22} />
              <span style={{
                fontWeight: homeIsSelected ? 700 : 500,
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
                <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 1 }}>top score</div>
              </>
            ) : (
              <div style={{ color: 'var(--text-muted)', fontFamily: 'Bebas Neue, sans-serif', fontSize: 20 }}>vs</div>
            )}
          </div>
          <div style={{ flex: 1, textAlign: 'right' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 7 }}>
              <span style={{
                fontWeight: awayIsSelected ? 700 : 500,
                color: awayIsSelected ? 'var(--gold)' : 'var(--text)',
                fontSize: 15,
              }}>
                {fixture.awayTeam.name}
              </span>
              <ClubBadge code={fixture.awayTeam.code} short={fixture.awayTeam.shortName} size={22} />
            </div>
          </div>
        </div>

        {pred && (
          <div style={{ marginTop: 10 }}>
            <ProbBar
              homeWin={pred.homeWin} draw={pred.draw} awayWin={pred.awayWin}
              homeName={fixture.homeTeam.shortName} awayName={fixture.awayTeam.shortName}
            />
          </div>
        )}

        {pred && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4, alignItems: 'center' }}>
            <ConfidenceBadge homeWin={pred.homeWin} draw={pred.draw} awayWin={pred.awayWin} />
            {prediction?.odds && (
              <span className="chip chip-muted" style={{ fontSize: 11 }}>
                {prediction.odds.home} / {prediction.odds.draw} / {prediction.odds.away}
              </span>
            )}
          </div>
        )}
      </div>

      {expanded && (
        <div style={{ borderTop: '1px solid var(--border)' }}>

          {pred?.lambdas && (
            <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
                <Zap size={13} color="var(--gold)" />
                <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 1 }}>
                  MODEL INPUTS
                </span>
              </div>
              <XGPanel
                lambdas={pred.lambdas}
                strengths={pred.strengths}
                homeTeam={fixture.homeTeam}
                awayTeam={fixture.awayTeam}
              />
            </div>
          )}

          {pred?.lambdas && (
            <WhyPrediction pred={pred} homeTeam={fixture.homeTeam} awayTeam={fixture.awayTeam} />
          )}

          {pred?.matrix && (
            <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
                <BarChart2 size={13} color="var(--gold)" />
                <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 1 }}>
                  SCORE MATRIX
                </span>
              </div>
              <ScoreMatrix
                matrix={pred.matrix}
                homeTeam={fixture.homeTeam}
                awayTeam={fixture.awayTeam}
              />
            </div>
          )}

          {pred?.topScores?.length > 0 && (
            <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
                <BarChart2 size={13} color="var(--gold)" />
                <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 1 }}>TOP SCORELINES</span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>
                {pred.topScores.slice(0, 6).map(({ score, prob }) => (
                  <div key={score} style={{
                    background: 'var(--surface)',
                    border: '1px solid var(--border)',
                    borderRadius: 8,
                    padding: '8px 10px',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                  }}>
                    <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--text)' }}>{score}</span>
                    <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{(prob * 100).toFixed(1)}%</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {pred?.overUnder && (
            <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
                <Zap size={13} color="var(--gold)" />
                <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 1 }}>OVER / UNDER</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {[
                  { label: 'Over 1.5', val: pred.overUnder.over15 },
                  { label: 'Over 2.5', val: pred.overUnder.over25 },
                  { label: 'Over 3.5', val: pred.overUnder.over35 },
                ].map(({ label, val }) => (
                  <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ fontSize: 12, color: 'var(--text-muted)', width: 56 }}>{label}</span>
                    <div style={{ flex: 1, height: 6, background: 'var(--surface)', borderRadius: 3, overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${val * 100}%`, background: 'var(--gold)', borderRadius: 3 }} />
                    </div>
                    <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', width: 36, textAlign: 'right' }}>
                      {(val * 100).toFixed(0)}%
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {pred?.asianHandicap && (
            <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
                <Activity size={13} color="var(--gold)" />
                <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 1 }}>ASIAN HANDICAP</span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
                {[
                  { label: 'AH 0', home: pred.asianHandicap.level?.home, away: pred.asianHandicap.level?.away },
                  { label: 'AH -0.5 / +0.5', home: pred.asianHandicap.homeMinus05, away: pred.asianHandicap.awayMinus05 },
                  { label: 'AH -1.5 / +1.5', home: pred.asianHandicap.homeMinus15, away: pred.asianHandicap.awayPlus15 },
                ].map(({ label, home, away }) => (
                  <div key={label} style={{
                    background: 'var(--surface)',
                    border: '1px solid var(--border)',
                    borderRadius: 8,
                    padding: '8px 10px',
                    textAlign: 'center',
                  }}>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 6 }}>{label}</div>
                    <div style={{ display: 'flex', justifyContent: 'space-around' }}>
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--blue, #60a5fa)' }}>{home != null ? `${(home * 100).toFixed(0)}%` : '–'}</div>
                        <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>Home</div>
                      </div>
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-muted)' }}>{away != null ? `${(away * 100).toFixed(0)}%` : '–'}</div>
                        <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>Away</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {prediction?.referee && (
            <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)' }}>
              <RefereePanel referee={prediction.referee} />
            </div>
          )}

          <WeatherWrapper fixtureId={fixture.id} />

          {prediction?.odds && (
            <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)' }}>
              <OddsPanel
                odds={prediction.odds}
                prediction={pred}
                homeTeam={fixture.homeTeam}
                awayTeam={fixture.awayTeam}
                fixtureId={fixture.id}
              />
            </div>
          )}

          {opponentId && (
            <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)' }}>
              {h2hLoading
                ? <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading H2H…</div>
                : <H2HPanel
                    h2h={h2h ?? []}
                    myTeamName={favTeam.name}
                    myTeamShort={favTeam.short}
                  />
              }
            </div>
          )}

          {(homeForm?.recentResults?.length > 0 || awayForm?.recentResults?.length > 0) && (
            <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12 }}>
                <Activity size={13} color="var(--gold)" />
                <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 1 }}>
                  RECENT FORM
                </span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                <FormChart
                  results={homeForm?.recentResults ?? []}
                  teamName={fixture.homeTeam.shortName}
                />
                <FormChart
                  results={awayForm?.recentResults ?? []}
                  teamName={fixture.awayTeam.shortName}
                />
              </div>
            </div>
          )}

          {lineupData?.available && (
            <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12 }}>
                <Users size={13} color="var(--gold)" />
                <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 1 }}>
                  LINEUPS
                </span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                <Lineup
                  formation={lineupData.home?.formation}
                  players={lineupData.home?.players ?? {}}
                  teamName={fixture.homeTeam.shortName}
                />
                <Lineup
                  formation={lineupData.away?.formation}
                  players={lineupData.away?.players ?? {}}
                  teamName={fixture.awayTeam.shortName}
                />
              </div>
            </div>
          )}

          {injuryTeam && (
            <div style={{ padding: '0 16px 14px' }}>
              <InjuriesPanel key={injuryTeam.code} teamCode={injuryTeam.code} teamShort={injuryTeam.short} />
            </div>
          )}

          {opponentId && (
            <div style={{ padding: '0 16px 16px' }}>
              <OpponentAnalysis teamId={opponentId} myTeamCode={injuryTeam?.code ?? favTeam.code} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function Fixtures() {
  const { leagueId } = useParams();
  const favTeam = useFavouriteTeam();
  const { data: allFixtures, loading, error } = useFetch('/api/all-fixtures');
  const [selectedTeam, setSelectedTeam] = useState(null);

  if (leagueId !== 'premier-league') return <FdFixtures />;

  if (loading) return <div className="loading-card"><div className="spinner" /><div>Loading fixtures…</div></div>;
  if (error)   return <div className="error-card">Failed to load fixtures: {error}</div>;
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
