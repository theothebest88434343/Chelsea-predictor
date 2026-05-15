import { useFetch } from './useFetch';

export function useFixtures() {
  return useFetch('/api/fixtures');
}

export function useResults() {
  return useFetch('/api/results');
}

export function useStandings() {
  return useFetch('/api/standings');
}

export function useChelseaStats() {
  return useFetch('/api/chelsea-stats');
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
