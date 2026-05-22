import { useState, useMemo } from 'react';
import { format }            from 'date-fns';
import { ChevronDown, ChevronUp } from 'lucide-react';
import ScoreMatrix  from './ScoreMatrix';
import OddsPanel    from './OddsPanel';
import XGPanel      from './XGPanel';
import FormChart    from './FormChart';
import H2HPanel     from './H2HPanel';
import ClubBadge    from './ClubBadge';
import { getMatchLabel } from '../utils/matchLabels';
import { ProbBar }          from './ui/ProbBar';
import { ConfidenceChip }   from './ui/ConfidenceChip';

// ─── MatchCardSkeleton ────────────────────────────────────────────────────────
// Rendered while prediction data is absent. Matches final card dimensions.
export function MatchCardSkeleton() {
  return (
    <div className="skel-matchcard">
      <div className="skel-meta skeleton" />
      <div className="skel-hero">
        <div className="skel-team skeleton" />
        <div className="skel-score skeleton" />
        <div className="skel-team skeleton" />
      </div>
      <div className="skel-bar skeleton" />
      <div className="skel-text skeleton" />
      <div className="skel-text-s skeleton" />
    </div>
  );
}

// ─── TeamSlot ─────────────────────────────────────────────────────────────────
// CSS handles mobile (column) vs desktop (row) — no JS breakpoint needed.
function TeamSlot({ team, isFavourite, side = 'left' }) {
  const cls = side === 'right' ? 'mc-team-slot-r' : 'mc-team-slot';
  return (
    <div
      className={cls}
      style={{
        transform:       isFavourite ? 'scale(1.04)' : 'scale(1)',
        transformOrigin: side === 'left' ? 'left center' : 'right center',
        transition:      'transform 0.2s ease',
      }}
    >
      <ClubBadge code={team?.code} short={team?.shortName} size={34} />
      <span
        className="mc-team-name"
        style={{
          fontWeight: isFavourite ? 700 : 600,
          color:      isFavourite ? 'var(--text)' : 'var(--text-muted)',
        }}
      >
        {team?.name}
      </span>
    </div>
  );
}

// ─── ScoreBlock ───────────────────────────────────────────────────────────────
function ScoreBlock({ finished, homeScore, awayScore, predictedScore }) {
  const isResult = finished && homeScore !== null;

  if (isResult) {
    return (
      <div className="mc-score-wrap" style={{ textAlign: 'center', padding: '0 12px' }}>
        <div className="mc-score-ft">{homeScore}–{awayScore}</div>
        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4, letterSpacing: 1, fontWeight: 700 }}>
          FULL TIME
        </div>
      </div>
    );
  }

  if (predictedScore) {
    const [sh, sa] = predictedScore.split('-').map(Number);
    return (
      <div className="mc-score-wrap" style={{ textAlign: 'center', padding: '0 12px' }}>
        <div className="mc-score-val">{sh}–{sa}</div>
        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4, letterSpacing: 1, fontWeight: 700 }}>
          PREDICTED
        </div>
      </div>
    );
  }

  return (
    <div
      className="mc-score-wrap"
      style={{ fontFamily: '"Bebas Neue", sans-serif', fontSize: 28, color: 'var(--gold)', letterSpacing: 3, padding: '0 12px', textAlign: 'center' }}
    >
      VS
    </div>
  );
}

// ─── MatchCard ────────────────────────────────────────────────────────────────
export default function MatchCard({ fixture, prediction, compact = false }) {
  const [expanded, setExpanded] = useState(false);

  if (!fixture) return null;

  const { homeTeam, awayTeam, kickoffTime, gameweek, homeScore, awayScore, finished } = fixture;
  const pred = prediction?.prediction;

  const kickoff = kickoffTime ? new Date(kickoffTime) : null;
  // No real-time match data is available — clock-based LIVE removed to avoid
  // showing a "LIVE" chip alongside a static predicted score.

  // Memoize label + insight — both are pure functions of probabilities
  const matchLabel = useMemo(
    () => pred ? getMatchLabel(pred.homeWin, pred.draw, pred.awayWin) : null,
    [pred?.homeWin, pred?.draw, pred?.awayWin],
  );

  const homeIsFav = matchLabel?.favourite === 'home';
  const awayIsFav = matchLabel?.favourite === 'away';

  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>

      {/* ① META ROW */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px 0', gap: 8, opacity: 0.85 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span className="chip chip-muted" style={{ fontSize: 11 }}>GW {gameweek}</span>
          {finished && homeScore !== null && (
            <span className="chip chip-muted" style={{ fontSize: 11 }}>FT</span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {kickoff && !finished && (
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              {format(kickoff, 'EEE d MMM · HH:mm')}
            </span>
          )}
          <ConfidenceChip confidence={pred?.confidence} />
        </div>
      </div>

      {/* ② HERO ROW — CSS Grid handles mobile (score top, teams side-by-side) */}
      {/*            and desktop (home | score | away in one row).            */}
      {/* No display:contents — all three are real grid items.               */}
      <div className="mc-hero">
        <div className="mc-hero-row">
          <TeamSlot team={homeTeam} isFavourite={homeIsFav} side="left" />
          <ScoreBlock
            finished={finished}
            homeScore={homeScore}
            awayScore={awayScore}
            predictedScore={pred?.predictedScore}
          />
          <TeamSlot team={awayTeam} isFavourite={awayIsFav} side="right" />
        </div>
      </div>

      {/* ③ PROBABILITY BAR */}
      {pred && (
        <div style={{ padding: '12px 14px', borderTop: '1px solid var(--border)' }}>
          <ProbBar
            homeWin={pred.homeWin}
            draw={pred.draw}
            awayWin={pred.awayWin}
            homeName={homeTeam?.shortName ?? homeTeam?.name ?? 'Home'}
            awayName={awayTeam?.shortName ?? awayTeam?.name ?? 'Away'}
          />
        </div>
      )}

      {/* ⑥ ADVANCED TOGGLE */}
      {!compact && pred && (
        <>
          <button
            onClick={() => setExpanded(e => !e)}
            aria-expanded={expanded}
            aria-label={expanded ? 'Hide model detail' : 'Show model detail'}
            style={{
              width: '100%', minHeight: 44, padding: '10px 16px',
              background: 'var(--surface2)', border: 'none',
              borderTop: '1px solid var(--border)',
              color: expanded ? 'var(--text)' : 'var(--text-muted)',
              cursor: 'pointer', display: 'flex', alignItems: 'center',
              justifyContent: 'center', gap: 6, fontSize: 12, fontWeight: 600,
              fontFamily: 'inherit', letterSpacing: '0.03em', transition: 'color 0.15s',
            }}
          >
            {expanded
              ? <><ChevronUp size={14} /> Hide model detail</>
              : <><ChevronDown size={14} /> Model detail</>
            }
          </button>

          {expanded && (
            <div style={{ padding: 16, borderTop: '1px solid var(--border)' }}>
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
