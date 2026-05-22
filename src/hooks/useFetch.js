import { useState, useEffect, useRef } from 'react';

// ─── Shared visibility subscriber registry ────────────────────────────────────
// One DOM listener for the entire app. Each useFetch instance registers a
// callback; the single listener fans out to all subscribers.
// Previously each hook instance added its own addEventListener, causing
// N listeners (one per mounted useFetch) and an N-request storm on tab return.
const _visibilitySubscribers = new Set();
let   _visibilityListenerAttached = false;

function _ensureVisibilityListener() {
  if (_visibilityListenerAttached) return;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      _visibilitySubscribers.forEach(fn => fn());
    }
  });
  _visibilityListenerAttached = true;
}

export function useFetch(url, deps = []) {
  const [data,       setData]       = useState(null);
  const [loading,    setLoading]    = useState(!!url);
  const [error,      setError]      = useState(null);
  // Incremented to force a re-fetch without changing the URL
  const [refreshKey, setRefreshKey] = useState(0);
  const abortRef = useRef(null);

  // Re-fetch whenever the browser tab comes back into view.
  // Uses a single shared DOM listener — not one per hook instance.
  useEffect(() => {
    _ensureVisibilityListener();
    const onVisible = () => setRefreshKey(k => k + 1);
    _visibilitySubscribers.add(onVisible);
    return () => _visibilitySubscribers.delete(onVisible);
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
        // Friendlify raw HTTP status codes so users never see "HTTP 500"
        const msg = err.message;
        const friendly = /^HTTP 5/.test(msg)
          ? 'Server temporarily unavailable'
          : /^HTTP 4/.test(msg)
            ? 'Resource not found'
            : msg;
        setError(friendly);
        setLoading(false);
      });

    return () => controller.abort();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, refreshKey, ...deps]);

  const refresh = () => setRefreshKey(k => k + 1);
  return { data, loading, error, refresh };
}
