import { useState, useEffect, useMemo, memo } from 'react';
import { getKnockoutPath }               from '../utils/bracketPath';

// ─── Flag map (all 48 WC 2026 teams) ─────────────────────────────────────────
const WC_FLAGS = {
  'Algeria': '🇩🇿', 'Argentina': '🇦🇷', 'Australia': '🇦🇺', 'Austria': '🇦🇹',
  'Belgium': '🇧🇪', 'Bosnia & Herzegovina': '🇧🇦', 'Brazil': '🇧🇷',
  'Cabo Verde': '🇨🇻', 'Canada': '🇨🇦', 'Colombia': '🇨🇴',
  'Croatia': '🇭🇷', 'Curaçao': '🇨🇼', "Côte d'Ivoire": '🇨🇮',
  'Czech Republic': '🇨🇿', 'DR Congo': '🇨🇩', 'Ecuador': '🇪🇨',
  'Egypt': '🇪🇬', 'England': '🏴󠁧󠁢󠁥󠁮󠁧󠁿', 'France': '🇫🇷',
  'Germany': '🇩🇪', 'Ghana': '🇬🇭', 'Haiti': '🇭🇹',
  'Iran': '🇮🇷', 'Iraq': '🇮🇶', 'Japan': '🇯🇵', 'Jordan': '🇯🇴',
  'Mexico': '🇲🇽', 'Morocco': '🇲🇦', 'Netherlands': '🇳🇱', 'New Zealand': '🇳🇿',
  'Norway': '🇳🇴', 'Panama': '🇵🇦', 'Paraguay': '🇵🇾', 'Portugal': '🇵🇹',
  'Qatar': '🇶🇦', 'Saudi Arabia': '🇸🇦', 'Scotland': '🏴󠁧󠁢󠁳󠁣󠁴󠁿', 'Senegal': '🇸🇳',
  'South Africa': '🇿🇦', 'South Korea': '🇰🇷', 'Spain': '🇪🇸', 'Sweden': '🇸🇪',
  'Switzerland': '🇨🇭', 'Tunisia': '🇹🇳', 'Turkey': '🇹🇷',
  'United States': '🇺🇸', 'USA': '🇺🇸', 'Uruguay': '🇺🇾', 'Uzbekistan': '🇺🇿',
};

function teamFlag(name) {
  if (!name) return '🏳️';
  if (WC_FLAGS[name]) return WC_FLAGS[name];
  const key = Object.keys(WC_FLAGS).find(k =>
    name.toLowerCase().includes(k.toLowerCase())
  );
  return key ? WC_FLAGS[key] : '🏳️';
}

// ─── Design helpers ───────────────────────────────────────────────────────────
function condProbColor(p) {
  if (p >= 0.62) return '#4ade80';
  if (p >= 0.46) return '#fbbf24';
  if (p >= 0.30) return '#f97316';
  return '#f87171';
}

function pct(v) { return `${Math.round((v ?? 0) * 100)}%`; }

// ─── PathToFinalSkeleton ──────────────────────────────────────────────────────
export function PathToFinalSkeleton() {
  return (
    <div className="card" style={{ padding: '14px 12px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 14 }}>
        <div className="skeleton" style={{ height: 12, width: 130, borderRadius: 4 }} />
        <div className="skeleton" style={{ height: 20, width: 80,  borderRadius: 10 }} />
      </div>
      <div className="skel-ptf">
        {[0,1,2,3,4].map(i => (
          <div key={i} className="skel-ptf-node skeleton" />
        ))}
      </div>
    </div>
  );
}

// ─── OpponentChip ─────────────────────────────────────────────────────────────
// memo: props change at most once (when bracket data resolves). Safe to memo.
const OpponentChip = memo(function OpponentChip({ opponent, opponentNote }) {
  // Always render something — never a bare dash
  const note = opponentNote ?? (!opponent ? 'TBD' : null);

  if (note) {
    return (
      <div style={{ fontSize: 9, color: '#4b5563', fontStyle: 'italic', textAlign: 'center', lineHeight: 1.3, minHeight: 16 }}>
        {note}
      </div>
    );
  }
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 3,
      fontSize: 10, color: 'var(--text-muted)', fontWeight: 500,
      justifyContent: 'center', textAlign: 'center', lineHeight: 1.2, minHeight: 16,
    }}>
      <span style={{ fontSize: 12 }}>{teamFlag(opponent.team)}</span>
      <span style={{ maxWidth: 72, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {opponent.team}
      </span>
    </div>
  );
});

// ─── ConnectorLine ────────────────────────────────────────────────────────────
// CSS class handles orientation (vertical mobile, horizontal desktop).
// Inline style provides dynamic opacity + thickness from probability.
function ConnectorLine({ cumProb }) {
  const opacity   = Math.max(0.12, Math.min(0.9, cumProb));
  const thickness = Math.max(1.5, cumProb * 5);
  const hex       = Math.round(opacity * 255).toString(16).padStart(2, '0');
  const base      = cumProb >= 0.4 ? '#60a5fa' : cumProb >= 0.2 ? '#94a3b8' : '#475569';

  return (
    <div
      className="ptf-connector"
      style={{
        // --ptf-conn-dir is set by the stylesheet (to bottom default, to right in @media ≥560px).
        // It must NOT be set inline — inline CSS vars have higher specificity than media queries.
        background: `linear-gradient(var(--ptf-conn-dir), ${base}${hex}, ${base}22)`,
      }}
    />
  );
}

// ─── StageNode ────────────────────────────────────────────────────────────────
function StageNode({ stage, accentColor }) {
  const { label, cumProb, prevProb, condProb, opponent, opponentNote, isBottleneck } = stage;
  const condColor = condProbColor(condProb);
  const isLive    = prevProb > 0.01;

  return (
    <div className="ptf-node" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5 }}>
      {/* Stage label */}
      <div style={{
        fontSize: 9, fontWeight: 700, letterSpacing: '0.07em',
        textTransform: 'uppercase', color: 'var(--text-muted)',
        textAlign: 'center', lineHeight: 1.2, whiteSpace: 'nowrap',
      }}>
        {label}
      </div>

      {/* Main node */}
      <div style={{
        position:     'relative',
        background:   isBottleneck ? `${condColor}0d` : 'var(--surface2)',
        border:       isBottleneck ? `1.5px solid ${condColor}55` : '1px solid var(--border)',
        borderRadius: 10,
        padding:      '10px 8px',
        textAlign:    'center',
        width:        '100%',
        boxShadow:    isBottleneck ? `0 0 16px ${condColor}18` : 'none',
        transition:   'border-color 0.2s, box-shadow 0.2s',
      }}>
        {isBottleneck && (
          <div style={{
            position: 'absolute', top: -9, left: '50%', transform: 'translateX(-50%)',
            background: 'var(--surface)', border: `1px solid ${condColor}55`,
            borderRadius: 10, padding: '1px 6px',
            fontSize: 8, fontWeight: 800, letterSpacing: '0.08em',
            color: condColor, whiteSpace: 'nowrap',
          }}>
            KEY HURDLE
          </div>
        )}

        <div style={{ fontSize: 8, color: '#374151', letterSpacing: '0.04em', marginBottom: 1 }}>REACH</div>
        <div style={{
          fontFamily: '"Bebas Neue", sans-serif',
          fontSize: 24, letterSpacing: 1,
          color: isLive ? accentColor : '#374151',
          lineHeight: 1,
        }}>
          {pct(cumProb)}
        </div>

        <div style={{ height: 1, background: 'var(--border)', margin: '5px 0 4px' }} />

        <div style={{ fontSize: 8, color: '#374151', letterSpacing: '0.04em', marginBottom: 2 }}>IF REACHED</div>
        <div style={{ fontSize: 15, fontWeight: 800, color: isLive ? condColor : '#374151', lineHeight: 1 }}>
          {pct(condProb)}
        </div>
      </div>

      {/* Opponent — always shows something (TBD if unknown) */}
      <OpponentChip opponent={opponent} opponentNote={opponentNote} />
    </div>
  );
}

// ─── TrophyNode ───────────────────────────────────────────────────────────────
function TrophyNode({ winProb, accentColor, isTopContender }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, minWidth: 52, justifyContent: 'center', paddingBottom: 24 }}>
      <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color: '#4b5563' }}>
        Champion
      </div>
      <div style={{
        fontSize: 30, lineHeight: 1,
        filter: isTopContender ? `drop-shadow(0 0 8px ${accentColor}99)` : 'grayscale(0.75) opacity(0.5)',
        transition: 'filter 0.3s',
      }}>
        🏆
      </div>
      <div style={{
        fontFamily: '"Bebas Neue", sans-serif',
        fontSize: 20, letterSpacing: 1,
        color: isTopContender ? accentColor : 'var(--text-muted)',
        lineHeight: 1,
      }}>
        {pct(winProb)}
      </div>
    </div>
  );
}

// ─── PathToFinal ──────────────────────────────────────────────────────────────
/**
 * Props:
 *   team                    — string team name
 *   reach                   — { pAdvance, pR16, pQF, pSF, pFinal, pWinner }
 *   tournamentReach         — full object (all teams) from /api/wc/tournament
 *   groupPredictedStandings — { A: [{team, xPts, xGD}...], ... }
 *   hardcodedGroups         — { A: [teamNames...], ... }
 *   color                   — accent colour for this team / group
 */
export default function PathToFinal({
  team,
  reach,
  tournamentReach,
  groupPredictedStandings,
  hardcodedGroups,
  color = 'var(--gold)',
}) {
  const [mounted, setMounted] = useState(false);

  // Fade in after first paint — CSS transition avoids layout shift
  useEffect(() => {
    const t = setTimeout(() => setMounted(true), 60);
    return () => clearTimeout(t);
  }, []);

  // Memoize bracket path — try/catch guards against malformed bracket data.
  // If getKnockoutPath throws (e.g. corrupted hardcodedGroups), we fall back to
  // the skeleton instead of crashing the whole page.
  const { stages } = useMemo(() => {
    try {
      return getKnockoutPath(team, hardcodedGroups, groupPredictedStandings, tournamentReach);
    } catch {
      return { stages: [] };
    }
  }, [team, hardcodedGroups, groupPredictedStandings, tournamentReach]);

  if (!team || !reach || !tournamentReach || stages.length === 0) return <PathToFinalSkeleton />;

  const winProb        = reach.pWinner ?? 0;
  const finalProb      = reach.pFinal  ?? 0;
  const isTopContender = winProb >= 0.08;

  return (
    <div style={{ position: 'relative' }}>
      {/* Ambient glow for title contenders */}
      {isTopContender && (
        <div aria-hidden style={{
          position: 'absolute', inset: -2, borderRadius: 14,
          pointerEvents: 'none',
          boxShadow: `0 0 28px ${color}44, 0 0 56px ${color}18`,
          zIndex: 0,
        }} />
      )}

      <div style={{
        position: 'relative', zIndex: 1,
        background: 'var(--surface)',
        border: `1px solid ${isTopContender ? `${color}55` : 'var(--border)'}`,
        borderRadius: 12, padding: '14px 12px 10px', overflow: 'hidden',
      }}>

        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14, gap: 8 }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color, display: 'flex', alignItems: 'center', gap: 5 }}>
            {isTopContender && <span style={{ fontSize: 13 }}>⭐</span>}
            Path to the Final
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            {finalProb > 0.01 && (
              <span style={{ fontSize: 10, fontWeight: 700, padding: '3px 9px', borderRadius: 20, background: 'rgba(251,191,36,0.1)', color: '#fbbf24', border: '1px solid rgba(251,191,36,0.3)', letterSpacing: '0.03em', whiteSpace: 'nowrap' }}>
                Final {pct(finalProb)}
              </span>
            )}
            {winProb > 0.005 && (
              <span style={{ fontSize: 10, fontWeight: 700, padding: '3px 9px', borderRadius: 20, background: isTopContender ? 'rgba(250,204,21,0.15)' : 'rgba(255,255,255,0.05)', color: isTopContender ? '#facc15' : 'var(--text-muted)', border: `1px solid ${isTopContender ? 'rgba(250,204,21,0.4)' : 'var(--border)'}`, letterSpacing: '0.03em', whiteSpace: 'nowrap' }}>
                🏆 {pct(winProb)}
              </span>
            )}
          </div>
        </div>

        {/* Flow diagram — ptf-flow CSS class handles mobile (column) vs desktop (row) */}
        <div
          className="ptf-flow"
          style={{
            opacity:   mounted ? 1 : 0,
            transform: mounted ? 'none' : 'translateY(6px)',
            transition: 'opacity 0.35s ease, transform 0.35s ease',
          }}
        >
          {stages.map((stage, i) => (
            <>
              <StageNode
                key={stage.id}
                stage={stage}
                accentColor={color}
              />
              {i < stages.length - 1 && (
                <ConnectorLine key={`conn-${i}`} cumProb={stage.cumProb} />
              )}
            </>
          ))}

          {/* Final connector → trophy */}
          <ConnectorLine cumProb={stages[stages.length - 1].cumProb} />
          <TrophyNode winProb={winProb} accentColor={color} isTopContender={isTopContender} />
        </div>

        {/* Footer */}
        <div style={{ marginTop: 10, fontSize: 9, color: '#374151', textAlign: 'center', letterSpacing: '0.02em', lineHeight: 1.4 }}>
          Reach % = cumulative · If Reached % = win probability for that round · 10,000 Monte Carlo simulations
        </div>
      </div>
    </div>
  );
}

// ─── PathToFinalCompactHeader ─────────────────────────────────────────────────
// One-line column header for the compact bars.
// Mirrors the EXACT flex/gap/width structure of PathToFinalCompact so the stage
// labels sit pixel-perfectly above the probability bars in the table.
export function PathToFinalCompactHeader() {
  const STAGES = ['R32', 'R16', 'QF', 'SF', 'Final'];
  return (
    <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
      {STAGES.map((label, i) => (
        <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {/* 28px matches the bar width; text-align:center keeps it centred */}
          <div style={{
            width:       28,
            textAlign:   'center',
            fontSize:    8,
            fontWeight:  700,
            letterSpacing: '0.05em',
            textTransform: 'uppercase',
            color:       'var(--text-muted)',
          }}>
            {label}
          </div>
          {/* 6px spacer matches the connector between bars */}
          {i < STAGES.length - 1 && <div style={{ width: 6 }} />}
        </div>
      ))}
      {/* Trophy column — marginLeft:4 matches the compact bar */}
      <span style={{ fontSize: 9, marginLeft: 4, opacity: 0.5 }}>🏆</span>
    </div>
  );
}

// ─── PathToFinalCompact ───────────────────────────────────────────────────────
// Lightweight horizontal progress chain for group tables and leaderboards.
// memo: rendered once per team row (up to 48 rows). Props are stable after fetch.
// Without memo, every tab switch or modal open re-renders all 48 instances.
export const PathToFinalCompact = memo(function PathToFinalCompact({ team, reach, color = 'var(--gold)' }) {
  if (!team || !reach) return null;

  const stages = [
    { label: 'R32',   prob: reach.pR16    ?? 0 },
    { label: 'R16',   prob: reach.pQF     ?? 0 },
    { label: 'QF',    prob: reach.pSF     ?? 0 },
    { label: 'SF',    prob: reach.pFinal  ?? 0 },
    { label: 'Final', prob: reach.pWinner ?? 0 },
  ];

  return (
    <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
      {stages.map((s, i) => {
        const pctVal = Math.round(s.prob * 100);
        const active = pctVal >= 5;
        return (
          <div key={s.label} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <div title={`${s.label}: ${pctVal}%`} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, opacity: active ? 1 : 0.3 }}>
              <div style={{ width: 28, height: 4, borderRadius: 2, background: active ? color : 'var(--border)', transition: 'background 0.2s' }} />
              <div style={{ fontSize: 8, color: active ? color : '#374151', fontWeight: 700 }}>{pctVal}%</div>
            </div>
            {i < stages.length - 1 && (
              <div style={{ width: 6, height: 1, background: active ? `${color}66` : 'var(--border)' }} />
            )}
          </div>
        );
      })}
      <span style={{ fontSize: 9, marginLeft: 4 }}>🏆</span>
    </div>
  );
});
