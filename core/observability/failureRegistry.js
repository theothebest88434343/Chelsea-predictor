'use strict';

/**
 * core/observability/failureRegistry.js
 *
 * Tracks API failures, degraded mode status, and recovery events
 * across all three data pipelines (PL, FD, WC).
 *
 * DESIGN
 * ══════
 * Pure in-memory.  No I/O.  The caller (server.js) calls record* functions
 * after every API attempt — success or failure.  All reads are synchronous.
 *
 * Failure rate is measured over a rolling 1-hour window so stale errors
 * don't permanently mark a pipeline as degraded after it recovers.
 *
 * SYSTEMS tracked:
 *   PL       — FPL API (bootstrap, fixtures, live)
 *   FD       — football-data.org multi-league API
 *   WC_ESPN  — ESPN scoreboard/standings (live WC data)
 *   WC_ELO   — martj42 CSV (ELO training data)
 *   SUPABASE — Supabase persistence layer
 *
 * USAGE (server.js):
 *   const failures = require('./core/observability/failureRegistry');
 *
 *   // After a successful API call:
 *   failures.recordSuccess('PL', 'bootstrap');
 *
 *   // After a failed API call:
 *   failures.recordFailure('WC_ELO', 'martj42 CSV', err);
 *
 *   // In a GET /api/health endpoint:
 *   res.json(failures.getSystemStatus());
 */

const logger = require('./logger');

// ─── Config ───────────────────────────────────────────────────────────────────

/** Sliding window for failure-rate calculation (ms) */
const WINDOW_MS = 60 * 60 * 1000;           // 1 hour

/** Failure rate above which a system enters DEGRADED mode */
const DEGRADED_THRESHOLD = 0.50;            // ≥ 50% of calls in window failed

/** Consecutive failures to immediately enter DEGRADED mode (ignoring rate) */
const CONSECUTIVE_THRESHOLD = 3;

const KNOWN_SYSTEMS = new Set(['PL', 'FD', 'WC_ESPN', 'WC_ELO', 'SUPABASE']);

// ─── State ────────────────────────────────────────────────────────────────────

/**
 * Per-system state:
 * {
 *   failures:  [ { ts, source, message }, ... ]   — within sliding window
 *   successes: [ ts, ... ]                         — within sliding window
 *   consecutive: number                            — consecutive failures (resets on success)
 *   degraded:  boolean
 *   degradedSince: ISO string | null
 *   lastSuccess: ISO string | null
 *   lastFailure: ISO string | null
 * }
 */
const _state = {};

function _ensureSystem(system) {
  if (!_state[system]) {
    _state[system] = {
      failures:      [],
      successes:     [],
      consecutive:   0,
      degraded:      false,
      degradedSince: null,
      lastSuccess:   null,
      lastFailure:   null,
    };
  }
  return _state[system];
}

// ─── Sliding-window helpers ───────────────────────────────────────────────────

function _pruneWindow(sys) {
  const cutoff = Date.now() - WINDOW_MS;
  sys.failures  = sys.failures.filter(f => f.ts >= cutoff);
  sys.successes = sys.successes.filter(ts => ts >= cutoff);
}

function _failureRate(sys) {
  const total = sys.failures.length + sys.successes.length;
  return total === 0 ? 0 : sys.failures.length / total;
}

function _recomputeDegradedMode(system, sys) {
  const rate        = _failureRate(sys);
  const wasDegraded = sys.degraded;

  sys.degraded = rate >= DEGRADED_THRESHOLD || sys.consecutive >= CONSECUTIVE_THRESHOLD;

  if (sys.degraded && !wasDegraded) {
    sys.degradedSince = new Date().toISOString();
    logger.warn({
      system: KNOWN_SYSTEMS.has(system) ? system : 'SYSTEM',
      stage:  'api',
      message: `[FailureRegistry] ${system} entered DEGRADED mode`,
      metrics: { failureRate: +(rate * 100).toFixed(1), consecutive: sys.consecutive },
    });
  } else if (!sys.degraded && wasDegraded) {
    logger.info({
      system: KNOWN_SYSTEMS.has(system) ? system : 'SYSTEM',
      stage:  'api',
      message: `[FailureRegistry] ${system} recovered from DEGRADED mode`,
      metrics: { failureRate: +(rate * 100).toFixed(1) },
    });
    sys.degradedSince = null;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Record a successful API call for a system.
 *
 * @param {string} system — 'PL' | 'FD' | 'WC_ESPN' | 'WC_ELO' | 'SUPABASE'
 * @param {string} [source] — e.g. 'bootstrap', 'martj42 CSV'
 */
function recordSuccess(system, source = '') {
  const sys = _ensureSystem(system);
  _pruneWindow(sys);

  const now = Date.now();
  sys.successes.push(now);
  sys.consecutive  = 0;
  sys.lastSuccess  = new Date(now).toISOString();

  _recomputeDegradedMode(system, sys);
}

/**
 * Record a failed API call.
 *
 * @param {string} system
 * @param {string} source   — endpoint / dataset label
 * @param {Error|string} err
 */
function recordFailure(system, source = '', err = null) {
  const sys = _ensureSystem(system);
  _pruneWindow(sys);

  const now     = Date.now();
  const message = err instanceof Error ? err.message : String(err ?? 'unknown error');

  sys.failures.push({ ts: now, source, message });
  sys.consecutive++;
  sys.lastFailure = new Date(now).toISOString();

  logger.warn({
    system: KNOWN_SYSTEMS.has(system) ? system : 'SYSTEM',
    stage:  'api',
    message: `[FailureRegistry] ${system} failure: ${source} — ${message}`,
    metrics: {
      consecutive: sys.consecutive,
      failureRate: +((_failureRate(sys)) * 100).toFixed(1),
    },
    errors: [message],
  });

  _recomputeDegradedMode(system, sys);
}

/**
 * Check whether a system is in degraded mode.
 *
 * @param {string} system
 * @returns {boolean}
 */
function isDegraded(system) {
  return _state[system]?.degraded ?? false;
}

/**
 * Get a full status snapshot for a single system.
 *
 * @param {string} system
 * @returns {Object}
 */
function getSystemStatus(system) {
  const sys = _state[system];
  if (!sys) return { system, status: 'UNKNOWN', n: 0 };
  _pruneWindow(sys);

  const rate = _failureRate(sys);
  return {
    system,
    status:          sys.degraded ? 'DEGRADED' : 'OK',
    failureRate:     +(rate * 100).toFixed(1),
    consecutive:     sys.consecutive,
    recentFailures:  sys.failures.length,
    recentSuccesses: sys.successes.length,
    degradedSince:   sys.degradedSince,
    lastSuccess:     sys.lastSuccess,
    lastFailure:     sys.lastFailure,
    recentErrors:    sys.failures.slice(-5).map(f => ({ source: f.source, message: f.message })),
  };
}

/**
 * Get status for all tracked systems.
 *
 * @returns {Object}  { systems: Object[], overallStatus: 'OK'|'DEGRADED'|'PARTIAL' }
 */
function getAllSystemStatus() {
  const systems = [...KNOWN_SYSTEMS, ...Object.keys(_state).filter(k => !KNOWN_SYSTEMS.has(k))]
    .map(getSystemStatus);

  const degradedCount = systems.filter(s => s.status === 'DEGRADED').length;
  const overallStatus = degradedCount === 0          ? 'OK'
                      : degradedCount < systems.length ? 'PARTIAL'
                      : 'DEGRADED';

  return { systems, overallStatus, checkedAt: new Date().toISOString() };
}

/**
 * Reset a system's failure state (e.g. after a manual recovery action).
 *
 * @param {string} system
 */
function resetSystem(system) {
  delete _state[system];
}

/** Reset all systems (useful in tests). */
function resetAll() {
  for (const key of Object.keys(_state)) delete _state[key];
}

module.exports = {
  recordSuccess,
  recordFailure,
  isDegraded,
  getSystemStatus,
  getAllSystemStatus,
  resetSystem,
  resetAll,
  KNOWN_SYSTEMS,
  DEGRADED_THRESHOLD,
  CONSECUTIVE_THRESHOLD,
  WINDOW_MS,
};
