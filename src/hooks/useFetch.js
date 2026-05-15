import { useState, useEffect, useRef } from 'react';

export function useFetch(url, deps = []) {
  const [data,       setData]       = useState(null);
  const [loading,    setLoading]    = useState(!!url);
  const [error,      setError]      = useState(null);
  // Incremented to force a re-fetch without changing the URL
  const [refreshKey, setRefreshKey] = useState(0);
  const abortRef = useRef(null);

  // Re-fetch whenever the browser tab comes back into view.
  // Handles the "came back after a while" case without polling every component.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') setRefreshKey(k => k + 1);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  useEffect(() => {
    if (!url) { setData(null); setLoading(false); setError(null); return; }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);

    // cache: 'no-store' prevents the browser from serving a stale cached
    // response — without it, repeated fetches to the same URL may hit disk
    // cache and never show newly-settled results.
    fetch(url, { signal: controller.signal, cache: 'no-store' })
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(d => { setData(d); setLoading(false); })
      .catch(err => {
        if (err.name === 'AbortError') return;
        setError(err.message);
        setLoading(false);
      });

    return () => controller.abort();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, refreshKey, ...deps]);

  return { data, loading, error };
}
