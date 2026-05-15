import { useFetch } from './useFetch';

export function useTrackerHistory() {
  return useFetch('/api/tracker/history');
}

export function useSeasonAccuracy() {
  return useFetch('/api/season-accuracy');
}

export function usePerformanceMetrics() {
  return useFetch('/api/performance-metrics');
}

export function useBettingSim(stake = 10) {
  return useFetch(`/api/betting-sim?stake=${stake}`);
}
