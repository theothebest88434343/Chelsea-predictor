import { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useFetch } from '../hooks/useFetch';
import ClubBadge from '../components/ClubBadge';
import { LEAGUES } from '../utils/leagues.jsx';

// ─── Team picker (PL only for now) ───────────────────────────────────────────

function TeamPicker({ onPick, onBack }) {
  const { data: teams, loading } = useFetch('/api/teams');
  const [query, setQuery] = useState('');

  const filtered = (teams ?? []).filter(t =>
    query === '' ||
    t.name.toLowerCase().includes(query.toLowerCase()) ||
    t.short.toLowerCase().includes(query.toLowerCase())
  );

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
        <button
          onClick={onBack}
          style={{
            background: 'none', border: '1px solid var(--border)', borderRadius: 8,
            color: 'var(--text-muted)', padding: '6px 12px', cursor: 'pointer',
            fontFamily: 'inherit', fontSize: 13,
          }}
        >
          ← Back
        </button>
        <div style={{ fontSize: 18, fontWeight: 700, fontFamily: 'Bebas Neue, sans-serif', letterSpacing: 1 }}>
          Pick your team
        </div>
      </div>

      <input
        type="text"
        placeholder="Search team…"
        value={query}
        onChange={e => setQuery(e.target.value)}
        autoFocus
        style={{
          width: '100%', boxSizing: 'border-box',
          padding: '10px 14px', borderRadius: 8,
          border: '1px solid var(--border)', background: 'var(--surface2)',
          color: 'var(--text)', fontSize: 14, fontFamily: 'inherit',
          marginBottom: 14, outline: 'none',
        }}
      />

      {loading ? (
        <div className="loading-card"><div className="spinner" /></div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
          {filtered.map(team => (
            <button
              key={team.id}
              onClick={() => onPick(team)}
              style={{
                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
                padding: '12px 6px', borderRadius: 10,
                border: '1px solid var(--border)', background: 'var(--surface2)',
                cursor: 'pointer', fontFamily: 'inherit', transition: 'all 0.15s',
              }}
            >
              <ClubBadge code={team.code} short={team.short} size={30} />
              <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 0.3 }}>
                {team.short}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── League card ─────────────────────────────────────────────────────────────

function LeagueCard({ league, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        width: '100%', display: 'flex', alignItems: 'center', gap: 16,
        padding: '16px 18px', borderRadius: 12, marginBottom: 10,
        border: '1px solid var(--border)',
        background: league.available
          ? `linear-gradient(135deg, ${league.color}33 0%, var(--surface) 100%)`
          : 'var(--surface)',
        cursor: league.available ? 'pointer' : 'default',
        fontFamily: 'inherit', textAlign: 'left',
        opacity: league.available ? 1 : 0.6,
        transition: 'border-color 0.15s',
      }}
    >
      <span style={{ fontSize: 32, flexShrink: 0 }}>{league.emoji}</span>
      <div style={{ flex: 1 }}>
        <div style={{
          fontWeight: 700, fontSize: 15, color: 'var(--text)',
          fontFamily: 'Bebas Neue, sans-serif', letterSpacing: 1,
        }}>
          {league.name}
        </div>
        {!league.available && (
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2, fontWeight: 600, letterSpacing: 0.5 }}>
            COMING SOON
          </div>
        )}
      </div>
      {league.available && (
        <span style={{ fontSize: 18, color: 'var(--text-muted)' }}>›</span>
      )}
    </button>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function LeagueSelector() {
  const navigate  = useNavigate();
  const location  = useLocation();
  const isSwitch  = location.state?.switch === true; // came from badge → show selector, skip auto-redirect

  const [step,   setStep]   = useState('league'); // 'league' | 'team'
  const [picked, setPicked] = useState(null);     // selected LEAGUES entry

  // Auto-redirect returning users — skip if the user tapped "switch" in the nav badge
  useEffect(() => {
    if (isSwitch) return;
    const pref = localStorage.getItem('preferredLeague');
    const team = localStorage.getItem('favouriteTeam');
    if (pref && team) {
      navigate(`/league/${pref}`, { replace: true });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleLeagueClick = (league) => {
    if (!league.available) return;
    setPicked(league);
    setStep('team');
  };

  const handleTeamPick = (team) => {
    const teamData = { id: team.id, name: team.name, short: team.short, code: team.code };
    localStorage.setItem('preferredLeague', picked.id);
    localStorage.setItem('favouriteTeam', JSON.stringify(teamData));
    navigate(`/league/${picked.id}`, { replace: true });
  };

  const handleBack = () => {
    setStep('league');
    setPicked(null);
  };

  if (step === 'team' && picked) {
    return (
      <div>
        <TeamPicker onPick={handleTeamPick} onBack={handleBack} />
      </div>
    );
  }

  return (
    <div>
      <div style={{ textAlign: 'center', padding: '28px 0 24px' }}>
        <div style={{ fontSize: 13, color: 'var(--text-muted)', letterSpacing: 1, fontWeight: 600, marginBottom: 4 }}>
          FOOTBALL PREDICTIONS
        </div>
        <div style={{
          fontSize: 28, fontWeight: 700, fontFamily: 'Bebas Neue, sans-serif',
          letterSpacing: 2, color: 'var(--text)',
        }}>
          Choose your league
        </div>
      </div>

      {LEAGUES.map(league => (
        <LeagueCard
          key={league.id}
          league={league}
          onClick={() => handleLeagueClick(league)}
        />
      ))}

      {isSwitch && (
        <button
          onClick={() => navigate(-1)}
          style={{
            width: '100%', marginTop: 8, padding: '12px', borderRadius: 10,
            border: '1px solid var(--border)', background: 'none',
            color: 'var(--text-muted)', fontFamily: 'inherit', fontSize: 13,
            cursor: 'pointer',
          }}
        >
          Cancel
        </button>
      )}
    </div>
  );
}
