import { useState, useEffect } from 'react';

// Default only used for PL when nothing is saved yet.
// Non-PL pages check favTeam.id against match team IDs, so Chelsea (id 8)
// simply won't match any non-PL team — FdHome shows the "pick a team" nudge.
const CHELSEA_DEFAULT = { id: 8, code: 8, name: 'Chelsea', short: 'CHE' };

function readFromStorage() {
  try {
    const raw = localStorage.getItem('favouriteTeam');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed?.id) return parsed;
    }
  } catch {}
  return CHELSEA_DEFAULT;
}

// Write a full team object to the shared key and notify all hook instances.
// Pass null to clear (e.g. when unpinning in FdLeague).
export function writeFavouriteTeam(team) {
  try {
    if (team == null) {
      localStorage.removeItem('favouriteTeam');
    } else {
      localStorage.setItem('favouriteTeam', JSON.stringify(team));
    }
  } catch {}
  // Dispatch on window so every useFavouriteTeam instance re-reads.
  // (The native 'storage' event only fires in OTHER tabs, not the same tab.)
  window.dispatchEvent(new Event('favouriteTeamChange'));
}

export function useFavouriteTeam() {
  const [team, setTeam] = useState(readFromStorage);

  useEffect(() => {
    const sync = () => setTeam(readFromStorage());
    window.addEventListener('favouriteTeamChange', sync);
    return () => window.removeEventListener('favouriteTeamChange', sync);
  }, []);

  return team;
}
