import { useState, useEffect } from 'react';

export function usePrediction(fixtureId) {
  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(!!fixtureId);
  const [error,   setError]   = useState(null);

  useEffect(() => {
    if (!fixtureId) return;
    setLoading(true);
    setError(null);

    const controller = new AbortController();
    fetch(`/api/predict-fixture?id=${fixtureId}`, { signal: controller.signal })
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(d => { setData(d); setLoading(false); })
      .catch(err => {
        if (err.name !== 'AbortError') { setError(err.message); setLoading(false); }
      });

    return () => controller.abort();
  }, [fixtureId]);

  return { data, loading, error };
}

export function useGameweekPredictions(gw, season = null) {
  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(!!(gw));
  const [error,   setError]   = useState(null);

  useEffect(() => {
    if (!gw) return;
    setLoading(true);
    setError(null);

    const controller = new AbortController();
    const url = season
      ? `/api/predict-gameweek?gw=${gw}&season=${encodeURIComponent(season)}`
      : `/api/predict-gameweek?gw=${gw}`;

    fetch(url, { signal: controller.signal })
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(d => { setData(d); setLoading(false); })
      .catch(err => {
        if (err.name !== 'AbortError') { setError(err.message); setLoading(false); }
      });

    return () => controller.abort();
  }, [gw, season]);

  return { data, loading, error };
}

