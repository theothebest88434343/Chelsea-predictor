import { useState, useEffect } from 'react';
import { format } from 'date-fns';
import { ChevronDown, ChevronUp } from 'lucide-react';
import ScoreMatrix from './ScoreMatrix';
import OddsPanel from './OddsPanel';
import XGPanel from './XGPanel';
import FormChart from './FormChart';
import H2HPanel from './H2HPanel';
import ClubBadge from './ClubBadge';
import { getMatchLabel, getInsightText } from '../utils/matchLabels';

// ─── useIsMobile ──────────────────────────────────────────────────────────────
function useIsMobile(breakpoint = 500) {
  const [mobile, setMobile] = useState(() => window.innerWidth < breakpoint);
  useEffect(() => {
    const handler = () => setMobile(window.innerWidth < breakpoint);
    window.addEventListener('resize', handler, { passive: true });
    return () => window.removeEventListener('resize', handler);
  }, [breakpoint]);
  return mobile;
}

// ─── Tier badge config ────────────────────────────────────────────────────────
const TIER_STYLE = {
  dominant: { bg: 'rgba(59,130,246,0.12)', color: '#7aadff',  border: 'rgba(59,130,246,0.3)' },
  strong:   { bg: 'rgba(34,197,94,0.10)',  color: '#4ade80',  border: 'rgba(34,197,94,0.3)'  },
  slight:   { bg: 'rgba(219,161,17,0.12)', color: '#DBA111',  border: 'rgba(219,161,17,0.3)' },
  tossup:   { bg: 'rgba(255,255,255,0.05)',color: '#7d93b3',  border: 'rgba(255,255,255,0.1)'},
  underdog: { bg: 'rgba(239,68,68,0.10)',  color: '#f87171',  border: 'rgba(239,68,68,0.3)'  },
};

// ─── ProbBar ──────────────────────────────────────────────────────────────────
// Slimmer, secondary bar — score is the hero, this supports it.
function ProbBar({ homeWin, draw, awayWin, homeName, awayName }) {
  const h = Math.round(homeWin * 100);
  const d = Math.round(draw * 100);
  const a = 100 - h - d;
  return (
    <div>
      {/* Thin bar — visually secondary */}
      <div style={{ display: 'flex', gap: 3, borderRadius: 4, overflow: 'hidden', height: 6 }}>
        <div style={{ flex: h, background: 'var(--blue)',              transition: 'flex 0.4s ease', minWidth: h > 0 ? 3 : 0 }} />
        <div style={{ flex: d, background: 'rgba(255,255,255,0.18)', transition: 'flex 0.4s ease', minWidth: d > 0 ? 3 : 0 }} />
        <div style={{ flex: Math.max(a, 1), background: '#6b2222',   transition: 'flex 0.4s ease', minWidth: a > 0 ? 3 : 0 }} />
      </div>
      {/* Labels row */}
      <div style={{
        display: 'flex', justifyContent: 'space-between',
        marginTop: 6, fontSize: 11, fontWeight: 600,
      }}>
        <span style={{ color: '#7aadff' }}>{homeName} {h}%</span>
        <span style={{ color: 'var(--text-muted)' }}>Draw {d}%</span>
        <span style={{ color: '#e07878' }}>{awayName} {a}%</span>
      </div>
    </div>
  );
}

// ─── TeamSlot ─────────────────────────────────────────────────────────────────
// One side of the hero row. Scales slightly when that side is favoured.
function TeamSlot({ team, isFavourite, align = 'left', isMobile }) {
  const scale = isFavourite ? 1.04 : 1;
  return (
    <div style={{
      display:        'flex',
      flexDirection:  isMobile ? 'column' : align === 'left' ? 'row' : 'row-reverse',
      alignItems:     'center',
      gap:            8,
      flex:           1,
      textAlign:      isMobile ? 'center' : align,
      transform:      `scale(${scale})`,
      transformOrigin: isMobile ? 'center' : align === 'left' ? 'left center' : 'right center',
      transition:     'transform 0.2s ease',
    }}>
      <ClubBadge code={team?.code} short={team?.shortName} size={isMobile ? 32 : 36} />
      <span style={{
        fontSize:   isMobile ? 15 : 17,
        fontWeight: isFavourite ? 700 : 600,
        color:      isFavourite ? 'var(--text)' : 'var(--text-muted)',
        lineHeight: 1.2,
      }}>
        {team?.name}
      </span>
    </div>
  );
}

// ─── ScoreBlock ───────────────────────────────────────────────────────────────
// The visual anchor of the entire card.
function ScoreBlock({ finished, homeScore, awayScore, predictedScore, isMobile }) {
  const scoreSize = isMobile ? 44 : 36;
  const isResult  = finished && homeScore !== null;

  if (isResult) {
    return (
      <div style={{ textAlign: 'center', padding: '0 12px' }}>
        <div style={{
          fontFamily:    '"Bebas Neue", sans-serif',
          fontSize:      scoreSize,
          letterSpacing: 4,
          color:         'var(--text)',
          lineHeight:    1,
        }}>
          {homeScore}–{awayScore}
        </div>
        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4, letterSpacing: 1, fontWeight: 700 }}>
          FULL TIME
        </div>
      </div>
    );
  }

  if (predictedScore) {
    const [sh, sa] = predictedScore.split('-').map(Number);
    return (
      <div style={{ textAlign: 'center', padding: '0 12px' }}>
        <div style={{
          fontFamily:    '"Bebas Neue", sans-serif',
          fontSize:      scoreSize,
          letterSpacing: 4,
          color:         '#ffffff',
          lineHeight:    1,
        }}>
          {sh}–{sa}
        </div>
        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4, letterSpacing: 1, fontWeight: 700 }}>
          PREDICTED
        </div>
      </div>
    );
  }

  return (
    <div style={{
      fontFamily:    '"Bebas Neue", sans-serif',
      fontSize:      28,
      color:         'var(--gold)',
      letterSpacing: 3,
      padding:       '0 12px',
    }}>
      VS
    </div>
  );
}

// ─── MatchCard ────────────────────────────────────────────────────────────────
export default function MatchCard({ fixture, prediction, compact = false }) {
  const [expanded, setExpanded] = useState(false);
  const isMobile = useIsMobile();

  if (!fixture) return null;

  const { homeTeam, awayTeam, kickoffTime, gameweek, homeScore, awayScore, finished } = fixture;
  const pred = prediction?.prediction;

  const kickoff = kickoffTime ? new Date(kickoffTime) : null;
  const isLive  = kickoff && !finished
                    && Date.now() > kickoff.getTime()
                    && Date.now() < kickoff.getTime() + 110 * 60 * 1000;

  // ── Match label + insight (only when we have probability data) ────────────
  const matchLabel = pred
    ? getMatchLabel(pred.homeWin, pred.draw, pred.awayWin)
    : null;

  const insightText = pred && pred.lambdas
    ? getInsightText(
        homeTeam?.name ?? '',
        awayTeam?.name ?? '',
        pred.homeWin,
        pred.draw,
        pred.awayWin,
        pred.lambdas.home,
        pred.lambdas.away,
      )
    : null;

  const tierStyle   = matchLabel ? (TIER_STYLE[matchLabel.tier] ?? TIER_STYLE.tossup) : null;
  const homeIsFav   = matchLabel?.favourite === 'home';
  const awayIsFav   = matchLabel?.favourite === 'away';

  // ── Confidence chip ────────────────────────────────────────────────────────
  const confPct = pred?.confidence != null ? Math.round(pred.confidence * 100) : null;
  const confCls = confPct == null ? '' : confPct >= 55 ? 'chip-green' : confPct >= 45 ? 'chip-gold' : 'chip-muted';

  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>

      {/* ① META ROW ────────────────────────────────────────────────────────── */}
      <div style={{
        display:        'flex',
        alignItems:     'center',
        justifyContent: 'space-between',
        padding:        '10px 14px 0',
        gap:            8,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span className="chip chip-muted" style={{ fontSize: 11 }}>GW {gameweek}</span>
          {isLive && <span className="chip chip-red" style={{ fontSize: 11 }}>● LIVE</span>}
          {finished && homeScore !== null && !isLive && (
            <span className="chip chip-muted" style={{ fontSize: 11 }}>FT</span>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {kickoff && !finished && (
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              {format(kickoff, 'EEE d MMM · HH:mm')}
            </span>
          )}
          {confPct != null && (
            <span className={`chip ${confCls}`} style={{ fontSize: 10 }}>
              {confPct}% conf.
            </span>
          )}
        </div>
      </div>

      {/* ② HERO ROW ─────────────────────────────────────────────────────────── */}
      {/* Mobile: score above, teams below side-by-side                         */}
      {/* Desktop: [home team] [score] [away team] all in one row                */}
      <div style={{ padding: isMobile ? '12px 14px 14px' : '14px 14px 14px' }}>
        {isMobile ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
            {/* Score first on mobile */}
            <ScoreBlock
              finished={finished}
              homeScore={homeScore}
              awayScore={awayScore}
              predictedScore={pred?.predictedScore}
              isMobile
            />
            {/* Teams row below score */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
              <TeamSlot team={homeTeam} isFavourite={homeIsFav} align="left"  isMobile />
              <TeamSlot team={awayTeam} isFavourite={awayIsFav} align="right" isMobile />
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <TeamSlot team={homeTeam} isFavourite={homeIsFav} align="left"  isMobile={false} />
            <ScoreBlock
              finished={finished}
              homeScore={homeScore}
              awayScore={awayScore}
              predictedScore={pred?.predictedScore}
              isMobile={false}
            />
            <TeamSlot team={awayTeam} isFavourite={awayIsFav} align="right" isMobile={false} />
          </div>
        )}
      </div>

      {/* ③ PROBABILITY BAR ───────────────────────────────────────────────────── */}
      {pred && (
        <div style={{
          padding:   '0 14px 12px',
          borderTop: '1px solid var(--border)',
          paddingTop: 12,
        }}>
          <ProbBar
            homeWin={pred.homeWin}
            draw={pred.draw}
            awayWin={pred.awayWin}
            homeName={homeTeam?.shortName ?? homeTeam?.name ?? 'Home'}
            awayName={awayTeam?.shortName ?? awayTeam?.name ?? 'Away'}
          />
        </div>
      )}

      {/* ④ MATCH LABEL BADGE ─────────────────────────────────────────────────── */}
      {matchLabel && tierStyle && (
        <div style={{ padding: '0 14px 10px' }}>
          <span style={{
            display:       'inline-block',
            fontSize:      10,
            fontWeight:    700,
            letterSpacing: '0.07em',
            textTransform: 'uppercase',
            padding:       '3px 10px',
            borderRadius:  20,
            background:    tierStyle.bg,
            color:         tierStyle.color,
            border:        `1px solid ${tierStyle.border}`,
          }}>
            {matchLabel.text}
          </span>
          {prediction?.odds && (
            <span className="chip chip-muted" style={{ fontSize: 10, marginLeft: 6 }}>
              {prediction.odds.home} · {prediction.odds.draw} · {prediction.odds.away}
            </span>
          )}
        </div>
      )}

      {/* ⑤ INSIGHT TEXT ──────────────────────────────────────────────────────── */}
      {insightText && (
        <div style={{
          padding:    '0 14px 14px',
          fontSize:   12,
          lineHeight: 1.65,
          color:      'var(--text-muted)',
          borderTop:  '1px solid var(--border)',
          paddingTop: 10,
        }}>
          {insightText}
        </div>
      )}

      {/* ⑥ ADVANCED TOGGLE + EXPANDED PANEL ─────────────────────────────────── */}
      {!compact && pred && (
        <>
          <button
            onClick={() => setExpanded(e => !e)}
            style={{
              width:        '100%',
              minHeight:    44,
              padding:      '10px 16px',
              background:   'var(--surface2)',
              border:       'none',
              borderTop:    '1px solid var(--border)',
              color:        expanded ? 'var(--text)' : 'var(--text-muted)',
              cursor:       'pointer',
              display:      'flex',
              alignItems:   'center',
              justifyContent: 'center',
              gap:          6,
              fontSize:     12,
              fontWeight:   600,
              fontFamily:   'inherit',
              letterSpacing: '0.03em',
              transition:   'color 0.15s',
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
