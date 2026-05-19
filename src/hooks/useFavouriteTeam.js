// Returns the favourite team stored in localStorage.
// Defaults to Chelsea (code 8, id 8) if nothing is saved yet.
const CHELSEA_DEFAULT = { id: 8, code: 8, name: 'Chelsea', short: 'CHE' };

export function useFavouriteTeam() {
  try {
    const raw = localStorage.getItem('favouriteTeam');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed?.code && parsed?.id) return parsed;
    }
  } catch {
    // ignore JSON parse errors
  }
  return CHELSEA_DEFAULT;
}
