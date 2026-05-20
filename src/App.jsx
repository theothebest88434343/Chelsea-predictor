import { Routes, Route, Navigate, useLocation, useNavigate, useParams } from 'react-router-dom';
import BottomNav from './components/BottomNav';
import NotificationBell from './components/NotificationBell';
import Home from './pages/Home';
import Fixtures from './pages/Fixtures';
import League from './pages/League';
import Stats from './pages/Stats';
import Round from './pages/Round';
import WorldCup from './pages/WorldCup';

import LeagueSelector from './pages/LeagueSelector';
import { getLeague } from './utils/leagues.jsx';

// Forces a full remount of any league-scoped page when the leagueId changes,
// so useState initialises fresh and no stale tab/team selections carry over.
function K({ C }) { const { leagueId } = useParams(); return <C key={leagueId} />; }

// ─── League badge in top bar ──────────────────────────────────────────────────
// Reads the current leagueId from the URL and renders a compact tappable badge.
// Tapping navigates to / with { state: { switch: true } } so the selector
// shows without auto-redirecting the user back.

function LeagueBadge() {
  const { pathname } = useLocation();
  const navigate     = useNavigate();

  // Extract leagueId from URL: /section/leagueId
  const parts     = pathname.split('/').filter(Boolean);
  const leagueId  = parts.length >= 2 ? parts[1] : localStorage.getItem('preferredLeague') ?? 'premier-league';
  const league    = getLeague(leagueId);

  // Don't show on the selector page itself
  if (pathname === '/') return null;

  return (
    <button
      onClick={() => navigate('/', { state: { switch: true } })}
      title="Switch league"
      style={{
        display: 'flex', alignItems: 'center', gap: 5,
        padding: '4px 10px', borderRadius: 20,
        border: '1px solid var(--border)', background: 'var(--surface2)',
        cursor: 'pointer', fontFamily: 'inherit',
        color: 'var(--text-muted)', fontSize: 12, fontWeight: 700,
        letterSpacing: 0.5, flexShrink: 0,
      }}
    >
      <span style={{ fontSize: 15 }}>{league.emoji}</span>
      <span>{league.short}</span>
    </button>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  return (
    <div className="app-shell">
      <header className="top-bar">
        <div className="top-bar-inner">
          <LeagueBadge />
          <span className="top-bar-logo">MATCHIQ</span>
          <NotificationBell />
        </div>
      </header>

      <main className="page-content">
        <Routes>
          {/* League selector / onboarding */}
          <Route path="/"                   element={<LeagueSelector />} />

          {/* World Cup — all 5 tabs render the same standalone tournament page */}
          <Route path="/league/world-cup"    element={<WorldCup />} />
          <Route path="/fixtures/world-cup"  element={<WorldCup />} />
          <Route path="/table/world-cup"     element={<WorldCup />} />
          <Route path="/stats/world-cup"     element={<WorldCup />} />
          <Route path="/round/world-cup"     element={<WorldCup />} />

          {/* Scoped league routes — K wrapper remounts on league change */}
          <Route path="/league/:leagueId"   element={<K C={Home}     />} />
          <Route path="/fixtures/:leagueId" element={<K C={Fixtures} />} />
          <Route path="/table/:leagueId"    element={<K C={League}   />} />
          <Route path="/stats/:leagueId"    element={<K C={Stats}    />} />
          <Route path="/round/:leagueId"    element={<K C={Round}    />} />

          {/* Legacy unscoped routes → redirect to PL equivalent */}
          <Route path="/fixtures"  element={<Navigate to="/fixtures/premier-league"  replace />} />
          <Route path="/league"    element={<Navigate to="/table/premier-league"     replace />} />
          <Route path="/stats"     element={<Navigate to="/stats/premier-league"     replace />} />
          <Route path="/round"     element={<Navigate to="/round/premier-league"     replace />} />
          {/* Old standalone World Cup URL → new league-scoped route */}
          <Route path="/worldcup"  element={<Navigate to="/league/world-cup"         replace />} />

          {/* Catch-all */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>

      <BottomNav />
    </div>
  );
}
