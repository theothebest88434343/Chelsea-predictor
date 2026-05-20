import { useState, useEffect, useMemo } from 'react';
import { format, parseISO, isPast } from 'date-fns';
import { useParams } from 'react-router-dom';
import { useFetch } from '../hooks/useFetch';
import { useFavouriteTeam } from '../hooks/useFavouriteTeam';
import { getLeague } from '../utils/leagues.jsx';

// ─── Crest image ──────────────────────────────────────────────────────────────

function Crest({ src, alt, size = 22 }) {
  if (!src) return <div style={{ width: size, height: size, flexShrink: 0 }} />;
  return (
    <img src={src} alt={alt}
      style={{ width: size, height: size, objectFit: 'contain', flexShrink: 0 }} />
  );
}

// ─── Countdown timer ──────────────────────────────────────────────────────────

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
  const mins  = Math.floor((diff % 3600000)  / 60000);
  const secs  = Math.floor((diff % 60000)    / 1000);

  return (
    <div style={{ textAlign: 'center', marginTop: 12 }}>
      <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', marginBottom: 6, letterSpacing: 1, fontWeight: 600 }}>
        KICKOFF IN
      </div>
      <div className="countdown">
        {days > 0 && (
          <div className="countdown-unit">
            <span className="countdown-num">{String(days).padStart(2, '0')}</span>
            <span className="countdown-label">DAYS</span>
          </div>
        )}
        <div className="countdown-unit">
          <span className="countdown-num">{String(hours).padStart(2, '0')}</span>
          <span className="countdown-label">HRS</span>
        </div>
        <div className="countdown-unit">
          <span className="countdown-num">{String(mins).padStart(2, '0')}</span>
          <span className="countdown-label">MIN</span>
        </div>
        <div className="countdown-unit">
          <span className="countdown-num">{String(secs).padStart(2, '0')}</span>
          <span className="countdown-label">SEC</span>
        </div>
      </div>
    </div>
  );
}

// ─── Hero card — next fixture ──────────────────────────────────────────────────

function HeroCard({ match, favTeam, prediction }) {
  if (!match) {
    return (
      <div className="card" style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 40, marginBottom: 12 }}>
        No upcoming fixtures found
      </div>
    );
  }

  const kicks  = match.kickoffTime ? parseISO(match.kickoffTime) : null;
  const isHome = match.homeTeam.id === favTeam.id;

  return (
    <div className="hero-card" style={{ marginBottom: 12 }}>
      <div style={{
        fontSize: 11, color: 'rgba(255,255,255,0.5)',
        letterSpacing: 1, fontWeight: 600, marginBottom: 8,
      }}>
        NEXT MATCH · MD {match.matchday}
        {kicks && (
          <span style={{ marginLeft: 8 }}>
            {format(kicks, 'EEE d MMM · HH:mm')}
          </span>
        )}
      </div>

      <div className="hero-matchup">
        {/* Home team */}
        <div className="hero-team">
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 6 }}>
            <Crest src={match.homeTeam.crest} alt={match.homeTeam.shortName} size={48} />
          </div>
          <div className="hero-team-name" style={{
            fontWeight: isHome ? 700 : 400,
            color: isHome ? 'var(--gold)' : undefined,
          }}>
            {match.homeTeam.shortName ?? match.homeTeam.name}
          </div>
        </div>

        {/* Centre — predicted score if available, VS while loading */}
        <div style={{ textAlign: 'center' }}>
          {prediction ? (
            <>
              <div style={{
                fontFamily: 'Bebas Neue, sans-serif', fontSize: 28, letterSpacing: 3,
                color: 'rgba(255,255,255,0.9)', lineHeight: 1,
              }}>
                {prediction.predictedScore?.replace('-', '–') ?? 'VS'}
              </div>
              <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.45)', marginTop: 3, letterSpacing: 0.5 }}>
                TOP SCORE
              </div>
            </>
          ) : (
            <div className="hero-vs">VS</div>
          )}
        </div>

        {/* Away team */}
        <div className="hero-team">
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 6 }}>
            <Crest src={match.awayTeam.crest} alt={match.awayTeam.shortName} size={48} />
          </div>
          <div className="hero-team-name" style={{
            fontWeight: !isHome ? 700 : 400,
            color: !isHome ? 'var(--gold)' : undefined,
          }}>
            {match.awayTeam.shortName ?? match.awayTeam.name}
          </div>
        </div>
      </div>

      {/* Live countdown */}
      <Countdown kickoffTime={match.kickoffTime} />
    </div>
  );
}

// ─── Season stats bar ──────────────────────────────────────────────────────────

function StatsBar({ row }) {
  if (!row) return null;
  const items = [
    { label: 'Points',  value: row.points },
    { label: 'W-D-L',   value: `${row.won}-${row.drawn}-${row.lost}` },
    { label: 'GD',      value: (row.gd >= 0 ? '+' : '') + row.gd },
    { label: 'Played',  value: row.played },
  ];
  return (
    <div className="card">
      <div className="card-title">Season so far</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, textAlign: 'center' }}>
        {items.map(item => (
          <div key={item.label} style={{ background: 'var(--surface2)', borderRadius: 8, padding: '10px 4px' }}>
            <div style={{
              fontSize: 20, fontWeight: 700, fontFamily: 'Bebas Neue, sans-serif',
              color: 'var(--gold)', letterSpacing: 1,
            }}>
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

// ─── Recent results ────────────────────────────────────────────────────────────

function RecentResults({ results, favTeam }) {
  if (!results?.length) return null;
  return (
    <div className="card">
      <div className="card-title">Recent results</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {results.map(m => {
          const isFavHome = m.homeTeam.id === favTeam.id;
          const favGoals  = isFavHome ? m.homeGoals : m.awayGoals;
          const oppGoals  = isFavHome ? m.awayGoals : m.homeGoals;
          const opp       = isFavHome ? m.awayTeam  : m.homeTeam;
          const result    = favGoals > oppGoals ? 'W' : favGoals < oppGoals ? 'L' : 'D';
          const color     = result === 'W' ? 'var(--green)' : result === 'L' ? 'var(--red)' : 'var(--draw)';
          const kicks     = m.kickoffTime ? parseISO(m.kickoffTime) : null;

          return (
            <div key={m.id} style={{
              display: 'flex', alignItems: 'center',
              justifyContent: 'space-between',
              padding: '8px 0', borderBottom: '1px solid var(--border)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div className="form-dot" style={{
                  background: `${color}20`, color, border: `1.5px solid ${color}`,
                  width: 26, height: 26, fontSize: 11,
                }}>
                  {result}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                  <Crest src={opp.crest} alt={opp.shortName} size={20} />
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>
                      {isFavHome ? 'vs' : '@'} {opp.shortName ?? opp.name}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                      {kicks ? format(kicks, 'd MMM') : ''} · MD {m.matchday}
                    </div>
                  </div>
                </div>
              </div>
              <div style={{ fontFamily: 'Bebas Neue, sans-serif', fontSize: 22, letterSpacing: 2, color }}>
                {favGoals} – {oppGoals}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Off-season card ───────────────────────────────────────────────────────────

function OffSeasonCard({ standings, standingsRow, recentResults, favTeam, league, scorers }) {
  const champion  = standings?.[0] ?? null;
  const topScorer = scorers?.[0]   ?? null;

  // Derived final stats for user's team
  const isFavChampion = standingsRow && champion && standingsRow.teamId === champion.teamId;

  return (
    <div>
      {/* ── Hero banner ────────────────────────────────────────────────────── */}
      <div className="hero-card" style={{ textAlign: 'center', marginBottom: 12 }}>
        <div style={{ fontSize: 44, marginBottom: 8 }}>🏆</div>
        <div style={{
          fontFamily: 'Bebas Neue, sans-serif', fontSize: 22,
          letterSpacing: 2, color: 'rgba(255,255,255,0.9)',
        }}>
          Season Complete
        </div>
        <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', marginTop: 3, letterSpacing: 1 }}>
          {league.name} · Final standings
        </div>

        {/* Champion */}
        {champion && (
          <div style={{ marginTop: 20 }}>
            {champion.crest && (
              <img
                src={champion.crest}
                alt={champion.shortName}
                style={{ width: 60, height: 60, objectFit: 'contain', marginBottom: 8 }}
              />
            )}
            <div style={{
              fontFamily: 'Bebas Neue, sans-serif', fontSize: 22,
              color: 'var(--gold)', letterSpacing: 1,
            }}>
              {champion.shortName}
            </div>
            <div style={{
              display: 'inline-block', marginTop: 4,
              padding: '2px 10px', borderRadius: 4,
              background: 'rgba(219,161,17,0.2)', border: '1px solid rgba(219,161,17,0.4)',
              fontSize: 10, fontWeight: 700, letterSpacing: 1.5, color: 'var(--gold)',
            }}>
              CHAMPIONS · {champion.points} PTS
            </div>
          </div>
        )}
      </div>

      {/* ── Your team's final position (if not champion) ────────────────────── */}
      {standingsRow && !isFavChampion && (
        <div className="card">
          <div className="card-title">Your team · Final position</div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              {standingsRow.crest && (
                <img src={standingsRow.crest} alt={standingsRow.shortName}
                  style={{ width: 32, height: 32, objectFit: 'contain' }} />
              )}
              <div>
                <div style={{ fontWeight: 700 }}>{standingsRow.shortName}</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  {standingsRow.won}W {standingsRow.drawn}D {standingsRow.lost}L
                  &nbsp;·&nbsp; GD {standingsRow.gd >= 0 ? '+' : ''}{standingsRow.gd}
                </div>
              </div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{
                fontFamily: 'Bebas Neue, sans-serif', fontSize: 36,
                color: 'var(--gold)', lineHeight: 1,
              }}>
                {standingsRow.position}
              </div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', letterSpacing: 0.5 }}>
                FINAL POS
              </div>
              <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', marginTop: 2 }}>
                {standingsRow.points} pts
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Top scorer ─────────────────────────────────────────────────────── */}
      {topScorer && (
        <div className="card">
          <div className="card-title">Top scorer</div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              {topScorer.team.crest && (
                <img src={topScorer.team.crest} alt={topScorer.team.shortName}
                  style={{ width: 28, height: 28, objectFit: 'contain' }} />
              )}
              <div>
                <div style={{ fontWeight: 700 }}>{topScorer.player.name}</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  {topScorer.team.shortName}
                  {topScorer.assists > 0 && ` · ${topScorer.assists} assists`}
                </div>
              </div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{
                fontFamily: 'Bebas Neue, sans-serif', fontSize: 36,
                color: 'var(--gold)', lineHeight: 1,
              }}>
                {topScorer.goals}
              </div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', letterSpacing: 0.5 }}>
                GOALS
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Final season stats for user's team ─────────────────────────────── */}
      {standingsRow && (
        <div className="card">
          <div className="card-title">
            {isFavChampion ? '🏆 Champions · Season stats' : 'Season stats'}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, textAlign: 'center' }}>
            {[
              { label: 'Points',  value: standingsRow.points },
              { label: 'W-D-L',   value: `${standingsRow.won}-${standingsRow.drawn}-${standingsRow.lost}` },
              { label: 'GD',      value: (standingsRow.gd >= 0 ? '+' : '') + standingsRow.gd },
              { label: 'Played',  value: standingsRow.played },
            ].map(item => (
              <div key={item.label} style={{ background: 'var(--surface2)', borderRadius: 8, padding: '10px 4px' }}>
                <div style={{
                  fontSize: 20, fontWeight: 700, fontFamily: 'Bebas Neue, sans-serif',
                  color: 'var(--gold)', letterSpacing: 1,
                }}>
                  {item.value}
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 600, marginTop: 2, letterSpacing: 0.5 }}>
                  {item.label}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Last 5 results as season recap ─────────────────────────────────── */}
      <RecentResults results={recentResults} favTeam={favTeam} />
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function FdHome() {
  const { leagueId } = useParams();
  const league  = getLeague(leagueId);
  const favTeam = useFavouriteTeam();

  // All matches (cached) — gives us enough data to find next fixture + last 5 results
  const { data: allMatches, loading: mLoading, error: mError } = useFetch(
    `/api/fd/matches?league=${leagueId}`
  );
  const { data: standings, loading: sLoading } = useFetch(
    `/api/fd/standings?league=${leagueId}`
  );

  const loading = mLoading || sLoading;

  // Filter matches for the favourite team
  const teamMatches = useMemo(() => {
    if (!allMatches || !favTeam?.id) return [];
    return allMatches.filter(
      m => m.homeTeam.id === favTeam.id || m.awayTeam.id === favTeam.id
    );
  }, [allMatches, favTeam?.id]);

  // Next upcoming fixture
  const nextFixture = useMemo(
    () => teamMatches.find(m => !m.finished) ?? null,
    [teamMatches]
  );

  // Last 5 finished results (matches are sorted oldest→newest; reverse for recency)
  const recentResults = useMemo(
    () => [...teamMatches].filter(m => m.finished).reverse().slice(0, 5),
    [teamMatches]
  );

  // Find this team's standings row
  const standingsRow = useMemo(() => {
    if (!standings || !favTeam?.id) return null;
    return standings.find(r => r.teamId === favTeam.id) ?? null;
  }, [standings, favTeam?.id]);

  // Off-season: all team matches loaded and finished, none upcoming
  const isOffSeason = !loading && teamMatches.length > 0 && !nextFixture;

  // Prediction for the hero card — fetched lazily once nextFixture is known
  const { data: heroPredData } = useFetch(
    nextFixture ? `/api/fd/predictions?league=${leagueId}&fixtureId=${nextFixture.id}` : null
  );
  const heroPred = heroPredData?.prediction ?? null;

  // Top scorers — fetched only during off-season
  const { data: scorers } = useFetch(
    isOffSeason ? `/api/fd/scorers?league=${leagueId}` : null
  );

  if (loading) {
    return (
      <div className="loading-card">
        <div className="spinner" />
        <div>Loading {favTeam?.name ?? league.name} data…</div>
      </div>
    );
  }

  if (mError) {
    return <div className="error-card">Failed to load data: {mError}</div>;
  }

  // Team from a different league stored in localStorage
  if (!loading && teamMatches.length === 0) {
    return (
      <div className="card" style={{ textAlign: 'center', padding: 32 }}>
        <div style={{ fontSize: 32, marginBottom: 12 }}>{league.emoji}</div>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>{league.name}</div>
        <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
          Your saved team isn't in this league.<br />
          Switch league or pick a new team.
        </div>
      </div>
    );
  }

  // Off-season view
  if (isOffSeason) {
    return (
      <OffSeasonCard
        standings={standings}
        standingsRow={standingsRow}
        recentResults={recentResults}
        favTeam={favTeam}
        league={league}
        scorers={scorers}
      />
    );
  }

  return (
    <div>
      <HeroCard match={nextFixture} favTeam={favTeam} prediction={heroPred} />
      <StatsBar row={standingsRow} />
      <RecentResults results={recentResults} favTeam={favTeam} />
    </div>
  );
}
