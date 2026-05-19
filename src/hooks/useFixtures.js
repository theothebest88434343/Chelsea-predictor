import { useFetch } from './useFetch';

export function useFixtures(teamCode) {
  const qs = teamCode ? `?teamCode=${teamCode}` : '';
  return useFetch(`/api/fixtures${qs}`);
}

export function useResults(teamCode) {
  const qs = teamCode ? `?teamCode=${teamCode}` : '';
  return useFetch(`/api/results${qs}`);
}

export function useStandings() {
  return useFetch('/api/standings');
}

// Legacy alias kept; prefer useTeamStats(teamCode)
export function useChelseaStats(teamCode) {
  return useTeamStats(teamCode);
}

export function useTeamStats(teamCode) {
  const qs = teamCode ? `?teamCode=${teamCode}` : '';
  return useFetch(`/api/team-stats${qs}`);
}

export function usePredictedTable() {
  return useFetch('/api/predicted-table');
}

export function useTeams() {
  return useFetch('/api/teams');
}

export function useXpts() {
  return useFetch('/api/xpts');
}

export function useEloRatings() {
  return useFetch('/api/elo-ratings');
}
