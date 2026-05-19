import { NavLink, useLocation } from 'react-router-dom';
import { Home, Calendar, Trophy, BarChart2, LayoutGrid, Globe } from 'lucide-react';
import { LEAGUES } from '../utils/leagues.jsx';

const KNOWN_LEAGUE_IDS = new Set(LEAGUES.map(l => l.id));

export default function BottomNav() {
  const { pathname } = useLocation();

  // Extract leagueId from the current URL (/section/leagueId)
  // Falls back to localStorage so the nav stays correct on /worldcup and /
  const parts        = pathname.split('/').filter(Boolean);
  const urlLeagueId  = KNOWN_LEAGUE_IDS.has(parts[1]) ? parts[1] : null;
  const leagueId     = urlLeagueId ?? localStorage.getItem('preferredLeague') ?? 'premier-league';

  const TABS = [
    { to: `/league/${leagueId}`,   icon: Home,        label: 'Home'     },
    { to: `/fixtures/${leagueId}`, icon: Calendar,    label: 'Fixtures' },
    { to: `/table/${leagueId}`,    icon: Trophy,      label: 'League'   },
    { to: `/stats/${leagueId}`,    icon: BarChart2,   label: 'Stats'    },
    { to: `/round/${leagueId}`,    icon: LayoutGrid,  label: 'Round'    },
    { to: '/worldcup',             icon: Globe,       label: 'WC 2026'  },
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
