import { useState } from 'react';
import { format } from 'date-fns';
import { ChevronDown, ChevronUp, BarChart2, Zap, FileText } from 'lucide-react';
import { useFixtures } from '../hooks/useFixtures';
import { usePrediction } from '../hooks/usePredictions';
import { useFetch } from '../hooks/useFetch';
import ScoreMatrix from '../components/ScoreMatrix';
import OddsPanel from '../components/OddsPanel';
import XGPanel from '../components/XGPanel';
import H2HPanel from '../components/H2HPanel';
import InjuriesPanel from '../components/InjuriesPanel';
import WeatherPanel from '../components/WeatherPanel';  // used inside WeatherWrapper
import RefereePanel from '../components/RefereePanel';
import { ConfidenceBadge } from '../utils/confidence.jsx';
import ClubBadge from '../components/ClubBadge';

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

// ─── Pre-match report (lazy) ──────────────────────────────────────────────────

function PrematchReport({ fixtureId }) {
  const [open, setOpen] = useState(false);
  const { data, loading } = useFetch(open ? `/api/prematch-report?id=${fixtureId}` : null);

  return (
    <div style={{ borderTop: '1px solid var(--border)', marginTop: 12, paddingTop: 12 }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit',
          display: 'flex', alignItems: 'center', gap: 6, color: 'var(--gold)',
          fontSize: 13, fontWeight: 700, padding: 0, letterSpacing: 0.3,
        }}
      >
        <FileText size={14} />
        AI pre-match report
        {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
      </button>

      {open && (
        <div style={{ marginTop: 10 }}>
          {loading && <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Generating report…</div>}
          {data?.report && (
            <div
              style={{ fontSize: 13, lineHeight: 1.7, color: 'var(--text)' }}
              dangerouslySetInnerHTML={{
                __html: data.report
                  .replace(/\n/g, '<br/>')
                  .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}

// ─── Single fixture row (expandable) ─────────────────────────────────────────

function FixtureRow({ fixture }) {
  const isCup = !!fixture.isCup;
  const [expanded, setExpanded] = useState(false);
  const { data: prediction } = usePrediction(!isCup ? fixture.id : null);

  const opponentId = fixture.homeTeam.code === 8
    ? fixture.awayTeam.id
    : fixture.homeTeam.id;

  const { data: h2h, loading: h2hLoading } = useFetch(
    expanded && !isCup && opponentId ? `/api/h2h/${opponentId}` : null
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
            {isCup
              ? <span className="chip chip-gold" style={{ fontSize: 10 }}>{fixture.competition ?? 'Cup'}</span>
              : <span className="chip chip-muted">GW {fixture.gameweek}</span>
            }
            {kicks ? (
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                {format(kicks, 'EEE d MMM · HH:mm')}
              </span>
            ) : isCup ? (
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Date TBC</span>
            ) : null}
          </div>
          {expanded
            ? <ChevronUp size={16} color="var(--text-muted)" />
            : <ChevronDown size={16} color="var(--text-muted)" />}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <ClubBadge code={fixture.homeTeam.code} short={fixture.homeTeam.shortName} size={22} />
              <span style={{ fontWeight: fixture.homeTeam.code === 8 ? 700 : 500, color: fixture.homeTeam.code === 8 ? 'var(--gold)' : 'var(--text)', fontSize: 15 }}>
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
                <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 1 }}>predicted</div>
              </>
            ) : (
              <div style={{ color: 'var(--text-muted)', fontFamily: 'Bebas Neue, sans-serif', fontSize: 20 }}>vs</div>
            )}
          </div>
          <div style={{ flex: 1, textAlign: 'right' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 7 }}>
              <span style={{ fontWeight: fixture.awayTeam.code === 8 ? 700 : 500, color: fixture.awayTeam.code === 8 ? 'var(--gold)' : 'var(--text)', fontSize: 15 }}>
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

          <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)' }}>
            {h2hLoading
              ? <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading H2H…</div>
              : <H2HPanel h2h={h2h ?? []} />
            }
          </div>

          <div style={{ padding: '0 16px 14px' }}>
            <InjuriesPanel />
          </div>

          <div style={{ padding: '0 16px 16px' }}>
            <PrematchReport fixtureId={fixture.id} />
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function Fixtures() {
  const { data: fixtures, loading, error } = useFixtures();

  if (loading) return <div className="loading-card"><div className="spinner" /><div>Loading fixtures…</div></div>;
  if (error)   return <div className="error-card">Failed to load fixtures: {error}</div>;
  if (!fixtures?.length) {
    return (
      <div className="loading-card">
        No upcoming Chelsea fixtures found.
        <div style={{ fontSize: 12, marginTop: 6, color: 'var(--text-muted)' }}>
          The FPL API may be updating after the season ends.
        </div>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div className="section-title" style={{ margin: 0 }}>Upcoming</div>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{fixtures.length} games</span>
      </div>

      {fixtures.map(fixture => (
        <FixtureRow key={fixture.id} fixture={fixture} />
      ))}
    </div>
  );
}
