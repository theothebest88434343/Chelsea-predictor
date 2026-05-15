import { useState } from 'react';
import { format } from 'date-fns';
import { ChevronDown, ChevronUp } from 'lucide-react';
import ScoreMatrix from './ScoreMatrix';
import OddsPanel from './OddsPanel';
import XGPanel from './XGPanel';
import FormChart from './FormChart';
import H2HPanel from './H2HPanel';
import ClubBadge from './ClubBadge';

function TeamBadge({ name, short, code }) {
  return (
    <div className="hero-team">
      <ClubBadge code={code} short={short} size={36} />
      <div className="hero-team-name">{name}</div>
    </div>
  );
}

function ProbBar({ homeWin, draw, awayWin }) {
  const h = Math.round(homeWin * 100);
  const d = Math.round(draw * 100);
  const a = 100 - h - d;
  return (
    <div className="prob-row">
      <div className="prob-segment home" style={{ flex: h }}>
        {h >= 15 && `${h}%`}
      </div>
      <div className="prob-segment draw" style={{ flex: d }}>
        {d >= 10 && `${d}%`}
      </div>
      <div className="prob-segment away" style={{ flex: Math.max(a, 1) }}>
        {a >= 15 && `${a}%`}
      </div>
    </div>
  );
}

function ConfidenceBadge({ confidence }) {
  const pct  = Math.round(confidence * 100);
  const cls  = pct >= 55 ? 'chip-green' : pct >= 45 ? 'chip-gold' : 'chip-muted';
  return <span className={`chip ${cls}`}>{pct}% confidence</span>;
}

export default function MatchCard({ fixture, prediction, compact = false }) {
  const [expanded, setExpanded] = useState(false);

  if (!fixture) return null;

  const { homeTeam, awayTeam, kickoffTime, gameweek, homeScore, awayScore, finished } = fixture;
  const pred = prediction?.prediction;

  const kickoff = kickoffTime ? new Date(kickoffTime) : null;
  const isLive  = kickoff && !finished && Date.now() > kickoff.getTime() && Date.now() < kickoff.getTime() + 110 * 60 * 1000;

  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ padding: '14px 16px 10px', background: 'linear-gradient(135deg,rgba(3,70,148,0.25) 0%,transparent 100%)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <span className="chip chip-muted">GW {gameweek}</span>
          {isLive && <span className="chip chip-red">LIVE</span>}
          {finished && homeScore !== null && (
            <span className="chip chip-muted">FT</span>
          )}
          {kickoff && !finished && (
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              {format(kickoff, 'EEE d MMM · HH:mm')}
            </span>
          )}
        </div>

        {/* Teams + score */}
        <div className="hero-matchup" style={{ marginBottom: 0 }}>
          <TeamBadge name={homeTeam?.name} short={homeTeam?.shortName} code={homeTeam?.code} />
          <div style={{ textAlign: 'center' }}>
            {finished && homeScore !== null ? (
              <div className="hero-score">{homeScore}–{awayScore}</div>
            ) : pred ? (
              <>
                <div className="hero-score" style={{ fontSize: 28 }}>
                  {pred.predictedScore?.replace('-', '–') ?? '?–?'}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                  predicted
                </div>
              </>
            ) : (
              <div className="hero-vs">VS</div>
            )}
          </div>
          <TeamBadge name={awayTeam?.name} short={awayTeam?.shortName} code={awayTeam?.code} />
        </div>
      </div>

      {/* Probability bar */}
      {pred && (
        <div style={{ padding: '8px 16px 0' }}>
          <ProbBar homeWin={pred.homeWin} draw={pred.draw} awayWin={pred.awayWin} />
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>
            <span>{homeTeam?.shortName}</span>
            <span>Draw</span>
            <span>{awayTeam?.shortName}</span>
          </div>
        </div>
      )}

      {/* Chips */}
      {pred && (
        <div style={{ padding: '0 16px 12px', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <ConfidenceBadge confidence={pred.confidence} />
          {prediction?.odds && (
            <span className="chip chip-muted">
              {prediction.odds.home} / {prediction.odds.draw} / {prediction.odds.away}
            </span>
          )}
        </div>
      )}

      {/* Expand toggle */}
      {!compact && pred && (
        <>
          <button
            onClick={() => setExpanded(e => !e)}
            style={{
              width: '100%', padding: '10px 16px', background: 'var(--surface2)',
              border: 'none', borderTop: '1px solid var(--border)',
              color: 'var(--text-muted)', cursor: 'pointer', display: 'flex',
              alignItems: 'center', justifyContent: 'center', gap: 6,
              fontSize: 13, fontWeight: 600, fontFamily: 'inherit',
            }}
          >
            {expanded ? <><ChevronUp size={15} /> Less detail</> : <><ChevronDown size={15} /> More detail</>}
          </button>

          {expanded && (
            <div style={{ padding: '16px', borderTop: '1px solid var(--border)' }}>
              <XGPanel lambdas={pred.lambdas} strengths={pred.strengths} homeTeam={homeTeam} awayTeam={awayTeam} />
              <div className="divider" />
              <ScoreMatrix matrix={pred.matrix} homeTeam={homeTeam} awayTeam={awayTeam} />
              {prediction?.odds && (
                <>
                  <div className="divider" />
                  <OddsPanel odds={prediction.odds} prediction={pred} homeTeam={homeTeam} awayTeam={awayTeam} />
                </>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
