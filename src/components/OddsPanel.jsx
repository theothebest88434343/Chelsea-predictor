import { useFetch } from '../hooks/useFetch';

function MovementArrow({ pct }) {
  if (pct == null) return null;
  // Odds going DOWN = implied prob going UP = money coming in (shortening)
  const shortening = pct < 0;
  const color = shortening ? 'var(--green)' : 'var(--red)';
  return (
    <span style={{ fontSize: 10, color, marginLeft: 4, fontWeight: 700 }}>
      {shortening ? '▼' : '▲'} {Math.abs(pct).toFixed(1)}%
    </span>
  );
}

export default function OddsPanel({ odds, prediction, homeTeam, awayTeam, fixtureId }) {
  if (!odds) return null;

  const { data: movement } = useFetch(fixtureId ? `/api/market-movement/${fixtureId}` : null);

  const impliedH = odds.home ? (1 / odds.home) : null;
  const impliedD = odds.draw ? (1 / odds.draw) : null;
  const impliedA = odds.away ? (1 / odds.away) : null;

  const edgeH = prediction && impliedH != null ? prediction.homeWin - impliedH : null;
  const edgeD = prediction && impliedD != null ? prediction.draw    - impliedD : null;
  const edgeA = prediction && impliedA != null ? prediction.awayWin - impliedA : null;

  const mv = movement?.movement;

  const EdgeLabel = ({ edge }) => {
    if (edge == null) return null;
    const pct = (edge * 100).toFixed(1);
    const cls = edge > 0.02 ? 'edge-pos' : edge < -0.02 ? 'edge-neg' : '';
    return <div className={`odds-edge ${cls}`}>{edge > 0 ? '+' : ''}{pct}%</div>;
  };

  return (
    <div>
      <div className="card-title" style={{ marginBottom: 8 }}>Live odds</div>
      {odds.bookmaker && (
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>{odds.bookmaker}</div>
      )}

      {movement?.steamMove && (
        <div style={{
          background: 'rgba(219,161,17,0.12)', border: '1px solid rgba(219,161,17,0.4)',
          borderRadius: 6, padding: '6px 10px', marginBottom: 10, fontSize: 12,
          color: 'var(--gold)', fontWeight: 700,
        }}>
          🔥 Steam move — market confidence rising
        </div>
      )}

      <div className="odds-grid">
        <div className="odds-item">
          <div className="odds-label">{homeTeam?.shortName ?? 'HOME'}</div>
          <div className="odds-value">
            {mv?.home ? (
              <span>
                <span style={{ fontSize: 12, color: 'var(--text-muted)', textDecoration: 'line-through', marginRight: 4 }}>
                  {mv.home.open}
                </span>
                {mv.home.current}
              </span>
            ) : (odds.home ?? '—')}
          </div>
          {mv?.home && <MovementArrow pct={mv.home.pct} />}
          <EdgeLabel edge={edgeH} />
        </div>
        <div className="odds-item">
          <div className="odds-label">DRAW</div>
          <div className="odds-value">
            {mv?.draw ? (
              <span>
                <span style={{ fontSize: 12, color: 'var(--text-muted)', textDecoration: 'line-through', marginRight: 4 }}>
                  {mv.draw.open}
                </span>
                {mv.draw.current}
              </span>
            ) : (odds.draw ?? '—')}
          </div>
          {mv?.draw && <MovementArrow pct={mv.draw.pct} />}
          <EdgeLabel edge={edgeD} />
        </div>
        <div className="odds-item">
          <div className="odds-label">{awayTeam?.shortName ?? 'AWAY'}</div>
          <div className="odds-value">
            {mv?.away ? (
              <span>
                <span style={{ fontSize: 12, color: 'var(--text-muted)', textDecoration: 'line-through', marginRight: 4 }}>
                  {mv.away.open}
                </span>
                {mv.away.current}
              </span>
            ) : (odds.away ?? '—')}
          </div>
          {mv?.away && <MovementArrow pct={mv.away.pct} />}
          <EdgeLabel edge={edgeA} />
        </div>
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>
        Edge = model probability − implied probability. Positive = model sees value.
      </div>
    </div>
  );
}
