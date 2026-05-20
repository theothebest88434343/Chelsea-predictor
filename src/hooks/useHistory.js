import { useFetch } from './useFetch';

export function useTrackerHistory(league = 'premier-league') {
  return useFetch(`/api/tracker/history?league=${league}`);
}

export function useSeasonAccuracy(league = 'premier-league') {
  return useFetch(`/api/season-accuracy?league=${league}`);
}

export function usePerformanceMetrics(league = 'premier-league') {
  return useFetch(`/api/performance-metrics?league=${league}`);
}

export function useBettingSim(stake = 10, league = 'premier-league') {
  return useFetch(`/api/betting-sim?stake=${stake}&league=${league}`);
}
