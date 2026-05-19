// ─── League registry ─────────────────────────────────────────────────────────
// Single source of truth for league metadata used across the app.

export const LEAGUES = [
  { id: 'premier-league', name: 'Premier League', short: 'PL',  emoji: '🏴󠁧󠁢󠁥󠁮󠁧󠁿', color: '#3d0f6e', available: true  },
  { id: 'la-liga',        name: 'La Liga',         short: 'LaL', emoji: '🇪🇸',         color: '#ee2d29', available: false },
  { id: 'bundesliga',     name: 'Bundesliga',      short: 'BL',  emoji: '🇩🇪',         color: '#d20515', available: false },
  { id: 'ligue-1',        name: 'Ligue 1',         short: 'L1',  emoji: '🇫🇷',         color: '#091c3e', available: false },
  { id: 'serie-a',        name: 'Serie A',         short: 'SA',  emoji: '🇮🇹',         color: '#008c45', available: false },
];

export function getLeague(leagueId) {
  return LEAGUES.find(l => l.id === leagueId) ?? { id: leagueId, name: leagueId, short: '?', emoji: '⚽', color: '#333', available: false };
}

// ─── ComingSoon ───────────────────────────────────────────────────────────────

export function ComingSoon({ leagueId }) {
  const league = getLeague(leagueId);
  return (
    <div style={{ textAlign: 'center', padding: '48px 20px' }}>
      <div style={{ fontSize: 56, marginBottom: 12 }}>{league.emoji}</div>
      <div style={{
        fontSize: 22, fontWeight: 700, fontFamily: 'Bebas Neue, sans-serif',
        letterSpacing: 2, color: 'var(--text)', marginBottom: 8,
      }}>
        {league.name}
      </div>
      <div className="card" style={{ marginTop: 16, textAlign: 'left' }}>
        <div className="card-title">Coming soon</div>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, lineHeight: 1.6, margin: 0 }}>
          Predictions and data for {league.name} are in development.
          <br /><br />
          The Premier League is fully available right now — switch back via the badge in the nav.
        </p>
      </div>
    </div>
  );
}
