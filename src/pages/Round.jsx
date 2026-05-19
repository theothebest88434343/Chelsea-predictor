import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { useFetch } from '../hooks/useFetch';
import { useGameweekPredictions } from '../hooks/usePredictions';
import { useFavouriteTeam } from '../hooks/useFavouriteTeam';
import { format } from 'date-fns';
import { ConfidenceBadge } from '../utils/confidence.jsx';
import ClubBadge from '../components/ClubBadge';
import { ComingSoon } from '../utils/leagues.jsx';

function formatSeason(s) {
  // "2025-26" → "25/26"
  const [start, end] = (s ?? '').split('-');
  return start && end ? `${start.slice(2)}/${end}` : s ?? '';
}

function SeasonSelector({ seasons, selected, onChange }) {
  return (
    <div style={{ position: 'relative', flexShrink: 0 }}>
      <select
        value={selected ?? ''}
        onChange={e => onChange(e.target.value)}
        style={{
          padding: '10px 32px 10px 12px',
          borderRadius: 8,
          border: '1px solid var(--border)',
          background: 'var(--surface)',
          color: 'var(--text)',
          fontSize: 13,
          fontWeight: 600,
          fontFamily: 'inherit',
          cursor: 'pointer',
          appearance: 'none',
          WebkitAppearance: 'none',
          minWidth: 88,
        }}
      >
        {seasons.map(({ season, isCurrent }) => (
          <option key={season} value={season}>
            {formatSeason(season)}{isCurrent ? ' ·  Now' : ''}
          </option>
        ))}
      </select>
      <svg width="11" height="11" viewBox="0 0 12 12"
        style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', opacity: 0.45 }}>
        <path d="M2 4l4 4 4-4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    </div>
  );
}

function GWSelector({ currentGW, selected, onChange }) {
  const gws = Array.from({ length: 38 }, (_, i) => i + 1);
  return (
    <div style={{ position: 'relative', flex: 1 }}>
      <select
        value={selected ?? ''}
        onChange={e => onChange(Number(e.target.value))}
        style={{
          width: '100%',
          padding: '10px 36px 10px 14px',
          borderRadius: 8,
          border: '1px solid var(--border)',
          background: 'var(--surface)',
          color: 'var(--text)',
          fontSize: 14,
          fontWeight: 600,
          fontFamily: 'inherit',
          cursor: 'pointer',
          appearance: 'none',
          WebkitAppearance: 'none',
        }}
      >
        {gws.map(gw => (
          <option key={gw} value={gw}>
            Gameweek {gw}{gw === currentGW ? '  ·  Current' : ''}
          </option>
        ))}
      </select>
      <svg width="12" height="12" viewBox="0 0 12 12"
        style={{ position: 'absolute', right: 14, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', opacity: 0.5 }}>
        <path d="M2 4l4 4 4-4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    </div>
  );
}

function FixtureRow({ pred, favTeamCode }) {
  if (!pred) return null;

  const { homeTeam, awayTeam, prediction, kickoff } = pred;
  const p = prediction;
  const isChelseaHome = homeTeam.code === favTeamCode;
  const isChelseaAway = awayTeam.code === favTeamCode;
  const isChelsea     = isChelseaHome || isChelseaAway;

  return (
    <div
      className="card"
      style={{
        padding: '12px 14px',
        borderColor: isChelsea ? 'rgba(3,70,148,0.4)' : 'var(--border)',
        background: isChelsea ? 'linear-gradient(135deg,rgba(3,70,148,0.12) 0%,var(--surface) 100%)' : 'var(--surface)',
      }}
    >
      {kickoff && (
        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 6, fontWeight: 600 }}>
          {format(new Date(kickoff), 'EEE d MMM · HH:mm')}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <ClubBadge code={homeTeam.code} short={homeTeam.shortName} size={20} />
            <span style={{ fontWeight: isChelseaHome ? 700 : 500, color: isChelseaHome ? 'var(--gold)' : 'var(--text)', fontSize: 14 }}>
              {homeTeam.name}
            </span>
          </div>
          {p && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{Math.round(p.homeWin * 100)}%</div>}
        </div>

        <div style={{ textAlign: 'center', minWidth: 64 }}>
          {p ? (
            <>
              <div style={{ fontFamily: 'Bebas Neue, sans-serif', fontSize: 22, letterSpacing: 2, color: 'var(--text)' }}>
                {p.predictedScore?.replace('-', '–') ?? '?–?'}
              </div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>predicted</div>
            </>
          ) : (
            <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>vs</div>
          )}
        </div>

        <div style={{ flex: 1, textAlign: 'right' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6 }}>
            <span style={{ fontWeight: isChelseaAway ? 700 : 500, color: isChelseaAway ? 'var(--gold)' : 'var(--text)', fontSize: 14 }}>
              {awayTeam.name}
            </span>
            <ClubBadge code={awayTeam.code} short={awayTeam.shortName} size={20} />
          </div>
          {p && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{Math.round(p.awayWin * 100)}%</div>}
        </div>
      </div>

      {p && (
        <div style={{ marginTop: 8 }}>
          <div style={{ display: 'flex', height: 6, borderRadius: 3, overflow: 'hidden', gap: 1, marginBottom: 6 }}>
            <div style={{ flex: p.homeWin, background: 'var(--blue)' }} />
            <div style={{ flex: p.draw,    background: 'rgba(255,255,255,0.2)' }} />
            <div style={{ flex: p.awayWin, background: '#6b2222' }} />
          </div>
          <ConfidenceBadge homeWin={p.homeWin} draw={p.draw} awayWin={p.awayWin} />
        </div>
      )}
    </div>
  );
}

export default function Round() {
  const { leagueId } = useParams();
  const favTeam = useFavouriteTeam();
  const { data: seasonsData } = useFetch('/api/seasons');
  const seasons = seasonsData ?? [];

  const [selectedSeason, setSelectedSeason] = useState(null);
  const [selectedGW,     setSelectedGW]     = useState(null);

  useEffect(() => {
    if (seasons.length && selectedSeason === null) {
      const cur = seasons.find(s => s.isCurrent) ?? seasons[0];
      setSelectedSeason(cur?.season ?? null);
    }
  }, [seasons]); // eslint-disable-line react-hooks/exhaustive-deps

  const { data: upcomingFixtures } = useFetch(
    selectedSeason && seasons.find(s => s.season === selectedSeason)?.isCurrent
      ? '/api/fixtures'
      : null
  );
  const currentGW = upcomingFixtures?.find(f => f.gameweek != null)?.gameweek ?? null;

  useEffect(() => {
    if (selectedSeason === null) return;
    const isCurrent = seasons.find(s => s.season === selectedSeason)?.isCurrent;
    if (isCurrent) {
      if (currentGW !== null && selectedGW === null) setSelectedGW(currentGW);
    } else {
      if (selectedGW === null) setSelectedGW(38);
    }
  }, [selectedSeason, currentGW]); // eslint-disable-line react-hooks/exhaustive-deps

  const activeGW     = selectedGW ?? currentGW;
  const isCurrent    = seasons.find(s => s.season === selectedSeason)?.isCurrent ?? true;

  const { data: predictions, loading, error } = useGameweekPredictions(
    activeGW,
    isCurrent ? null : selectedSeason
  );

  const handleSeasonChange = (s) => {
    setSelectedSeason(s);
    setSelectedGW(null); // reset GW so it re-defaults for the new season
  };

  if (!seasons.length || (isCurrent && activeGW === null)) {
    return <div className="loading-card"><div className="spinner" /><div>Loading…</div></div>;
  }

  if (leagueId !== 'premier-league') return <ComingSoon leagueId={leagueId} />;

  return (
    <div>
      <div className="section-title">
        Gameweek {activeGW ?? '…'}{' '}
        <span style={{ fontSize: 13, fontWeight: 400, color: 'var(--text-muted)' }}>
          {formatSeason(selectedSeason)}
        </span>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {seasons.length > 1 && (
          <SeasonSelector seasons={seasons} selected={selectedSeason} onChange={handleSeasonChange} />
        )}
        <GWSelector currentGW={isCurrent ? currentGW : null} selected={activeGW} onChange={setSelectedGW} />
      </div>

      {loading && <div className="loading-card"><div className="spinner" /><div>Loading predictions…</div></div>}
      {error   && <div className="error-card">Failed to load GW {activeGW}: {error}</div>}

      {!loading && predictions?.length === 0 && (
        <div className="loading-card">No predictions found for GW {activeGW}</div>
      )}

      {!loading && predictions?.map(pred => (
        <FixtureRow key={pred.fixtureId} pred={pred} favTeamCode={favTeam.code} />
      ))}

      {!loading && predictions?.length > 0 && (
        <div style={{ padding: '4px 0', fontSize: 11, color: 'var(--text-muted)', textAlign: 'center' }}>
          {predictions.length} fixtures · Poisson + Dixon-Coles
        </div>
      )}
    </div>
  );
}
