import { Routes, Route } from 'react-router-dom';
import BottomNav from './components/BottomNav';
import NotificationBell from './components/NotificationBell';
import Home from './pages/Home';
import Fixtures from './pages/Fixtures';
import League from './pages/League';
import Stats from './pages/Stats';
import Round from './pages/Round';

export default function App() {
  return (
    <div className="app-shell">
      <header className="top-bar">
        <div className="top-bar-inner">
          <span className="top-bar-logo">CHELSEA PRED</span>
          <NotificationBell />
        </div>
      </header>

      <main className="page-content">
        <Routes>
          <Route path="/"         element={<Home />} />
          <Route path="/fixtures" element={<Fixtures />} />
          <Route path="/league"   element={<League />} />
          <Route path="/stats"    element={<Stats />} />
          <Route path="/round"    element={<Round />} />
        </Routes>
      </main>

      <BottomNav />
    </div>
  );
}
