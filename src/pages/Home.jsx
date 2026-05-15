import { useState, useEffect } from 'react';
import { format, isPast } from 'date-fns';
import { useFixtures, useResults, useChelseaStats } from '../hooks/useFixtures';
import { usePrediction } from '../hooks/usePredictions';
import { ConfidenceBadge } from '../utils/confidence.jsx';

function Countdown({ kickoffTime }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  if (!kickoffTime) return null;
  const kickoff = new Date(kickoffTime);
  if (isPast(kickoff)) return null;

  const diff  = kickoff - now;
  const days  = Math.floor(diff / 86400000);
  const hours = Math.floor((diff % 86400000) / 3600000);
  const mins  = Math.floor((diff % 3600000) / 60000);
  const secs  = Math.floor((diff % 60000) / 1000);

  return (
    <div style={{ textAlign: 'center', marginTop: 12 }}>
      <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', marginBottom: 6, letterSpacing: 1, fontWeight: 600 }}>
        KICKOFF IN
      </div>
      <div className="countdown">
        {days > 0 && (
          <div className="countdown-unit">
            <span className="countdown-num">{String(days).padStart(2,'0')}</span>
            <span className="countdown-label">DAYS</span>
          </div>
        )}
        <div className="countdown-unit">
          <span className="countdown-num">{String(hours).padStart(2,'0')}</span>
          <span className="countdown-label">HRS</span>
        </div>
        <div className="countdown-unit">
          <span className="countdown-num">{String(mins).padStart(2,'0')}</span>
          <span className="countdown-label">MIN</span>
        </div>
        <div className="countdown-unit">
          <span className="countdown-num">{String(secs).padStart(2,'0')}</span>
          <span className="countdown-label">SEC</span>
        </div>
      </div>
    </div>
  );
}

function StatsBar({ stats }) {
  if (!stats) return null;
  const { played, won, drawn, lost, gf, ga, points } = stats;
  return (
    <div className="card">
      <div className="card-title">Season so far</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, textAlign: 'center' }}>
        {[
          { label: 'Points',  value: points },
          { label: 'W-D-L',   value: `${won}-${drawn}-${lost}` },
          { label: 'Scored',  value: gf },
          { label: 'Conceded',value: ga },
        ].map(item => (
          <div key={item.label} style={{ background: 'var(--surface2)', borderRadius: 8, padding: '10px 4px' }}>
            <div style={{ fontSize: 20, fontWeight: 700, fontFamily: 'Bebas Neue, sans-serif', color: 'var(--gold)', letterSpacing: 1 }}>
              {item.value}
            </div>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 600, marginTop: 2, letterSpacing: 0.5 }}>
              {item.label}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function RecentResults({ results }) {
  if (!results?.length) return null;
  return (
    <div className="card">
      <div className="card-title">Recent results</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {results.map(r => {
          const isChelseaHome = r.homeTeam.code === 8;
          const chelseaGoals  = isChelseaHome ? r.homeScore : r.awayScore;
          const oppGoals      = isChelseaHome ? r.awayScore : r.homeScore;
          const opp           = isChelseaHome ? r.awayTeam  : r.homeTeam;
          const result        = chelseaGoals > oppGoals ? 'W' : chelseaGoals < oppGoals ? 'L' : 'D';
          const color         = result === 'W' ? 'var(--green)' : result === 'L' ? 'var(--red)' : 'var(--draw)';

          return (
            <div key={r.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div className="form-dot" style={{ background: `${color}20`, color, border: `1.5px solid ${color}`, width: 26, height: 26, fontSize: 11 }}>
                  {result}
                </div>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>
                    {isChelseaHome ? 'vs' : '@'} {opp.name}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    {r.kickoffTime ? format(new Date(r.kickoffTime), 'd MMM') : ''} · GW {r.gameweek}
                  </div>
                </div>
              </div>
              <div style={{ fontFamily: 'Bebas Neue, sans-serif', fontSize: 22, letterSpacing: 2, color }}>
                {chelseaGoals} – {oppGoals}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function Home() {
  const { data: fixtures, loading: fLoading } = useFixtures();
  const { data: results }                      = useResults();
  const { data: stats }                        = useChelseaStats();

  const nextFixture = fixtures?.[0] ?? null;
  const { data: prediction, loading: pLoading } = usePrediction(nextFixture?.id);

  if (fLoading) {
    return <div className="loading-card"><div className="spinner" /><div>Loading Chelsea data…</div></div>;
  }

  return (
    <div>
      {nextFixture ? (
        <div className="hero-card" style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', letterSpacing: 1, fontWeight: 600, marginBottom: 8 }}>
            NEXT MATCH · GW {nextFixture.gameweek}
            {nextFixture.kickoffTime && (
              <span style={{ marginLeft: 8 }}>
                {format(new Date(nextFixture.kickoffTime), 'EEE d MMM · HH:mm')}
              </span>
            )}
          </div>

          <div className="hero-matchup">
            <div className="hero-team">
              <div className="hero-team-badge">{nextFixture.homeTeam.shortName}</div>
              <div className="hero-team-name">{nextFixture.homeTeam.name}</div>
            </div>
            <div style={{ textAlign: 'center' }}>
              {pLoading ? (
                <div className="spinner" style={{ width: 24, height: 24, margin: '0 auto' }} />
              ) : prediction ? (
                <>
                  <div className="hero-score" style={{ fontSize: 36 }}>
                    {prediction.prediction?.predictedScore?.replace('-', '–') ?? '?–?'}
                  </div>
                  <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', marginTop: 2 }}>predicted</div>
                </>
              ) : (
                <div className="hero-vs">VS</div>
              )}
            </div>
            <div className="hero-team">
              <div className="hero-team-badge">{nextFixture.awayTeam.shortName}</div>
              <div className="hero-team-name">{nextFixture.awayTeam.name}</div>
            </div>
          </div>

          {prediction?.prediction && (
            <div className="hero-meta">
              <span className="chip chip-gold">{Math.round(prediction.prediction.homeWin * 100)}% home</span>
              <span className="chip chip-muted">{Math.round(prediction.prediction.draw * 100)}% draw</span>
              <span className="chip chip-muted">{Math.round(prediction.prediction.awayWin * 100)}% away</span>
              <ConfidenceBadge
                homeWin={prediction.prediction.homeWin}
                draw={prediction.prediction.draw}
                awayWin={prediction.prediction.awayWin}
              />
            </div>
          )}

          <Countdown kickoffTime={nextFixture.kickoffTime} />
        </div>
      ) : (
        <div className="card" style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 40 }}>
          No upcoming fixtures found
        </div>
      )}

      <StatsBar stats={stats} />

      <RecentResults results={results} />
    </div>
  );
}
