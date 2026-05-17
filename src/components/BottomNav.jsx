import { NavLink } from 'react-router-dom';
import { Home, Calendar, Trophy, BarChart2, LayoutGrid, Globe } from 'lucide-react';

const TABS = [
  { to: '/',         icon: Home,        label: 'Home' },
  { to: '/fixtures', icon: Calendar,    label: 'Fixtures' },
  { to: '/league',   icon: Trophy,      label: 'League' },
  { to: '/stats',    icon: BarChart2,   label: 'Stats' },
  { to: '/round',    icon: LayoutGrid,  label: 'Round' },
  { to: '/worldcup', icon: Globe,       label: 'WC 2026' },
];

export default function BottomNav() {
  return (
    <nav className="bottom-nav">
      {TABS.map(({ to, icon: Icon, label }) => (
        <NavLink
          key={to}
          to={to}
          end={to === '/'}
          className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
        >
          <Icon />
          <span>{label}</span>
        </NavLink>
      ))}
    </nav>
  );
}
