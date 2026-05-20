import { useState, useEffect } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { Home, Calendar, Trophy, BarChart2, LayoutGrid } from 'lucide-react';
import { LEAGUES } from '../utils/leagues.jsx';

const KNOWN_LEAGUE_IDS = new Set(LEAGUES.map(l => l.id));

export default function BottomNav() {
  const { pathname } = useLocation();

  // Track preferredLeague in state so BottomNav re-renders immediately when it
  // changes (e.g. user picks a new league but hasn't picked a team yet).
  const [storedLeague, setStoredLeague] = useState(
    () => localStorage.getItem('preferredLeague') ?? 'premier-league'
  );
  useEffect(() => {
    const sync = () => setStoredLeague(localStorage.getItem('preferredLeague') ?? 'premier-league');
    // 'preferredLeagueChange' is dispatched by LeagueSelector on every league pick
    window.addEventListener('preferredLeagueChange', sync);
    return () => window.removeEventListener('preferredLeagueChange', sync);
  }, []);

  // Extract leagueId from the current URL (/section/leagueId)
  // Falls back to reactive storedLeague so the nav stays correct on /
  const parts        = pathname.split('/').filter(Boolean);
  const urlLeagueId  = KNOWN_LEAGUE_IDS.has(parts[1]) ? parts[1] : null;
  const leagueId     = urlLeagueId ?? storedLeague;

  if (leagueId === 'world-cup') return null;

  const TABS = [
    { to: `/league/${leagueId}`,   icon: Home,        label: 'Home'     },
    { to: `/fixtures/${leagueId}`, icon: Calendar,    label: 'Fixtures' },
    { to: `/table/${leagueId}`,    icon: Trophy,      label: 'League'   },
    { to: `/stats/${leagueId}`,    icon: BarChart2,   label: 'Stats'    },
    { to: `/round/${leagueId}`,    icon: LayoutGrid,  label: 'Round'    },
  ];

  return (
    <nav className="bottom-nav">
      {TABS.map(({ to, icon: Icon, label }) => (
        <NavLink
          key={to}
          to={to}
          end
          className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
        >
          <Icon />
          <span>{label}</span>
        </NavLink>
      ))}
    </nav>
  );
}
