'use strict';

/**
 * core/state/modelState.js
 *
 * Explicit model state, feature toggles, and cache TTLs.
 *
 * RULE: No file in the system should define these independently.
 * All files must import from here.
 *
 * CHANGING WC_MODEL_VERSION forces Supabase + disk cache discard on next
 * server restart — any structural model change must bump this string.
 *
 * FEATURE FLAGS
 * ─────────────
 * All flags default to the production-safe value (i.e. the value that
 * matches current live behaviour).  They can be overridden via environment
 * variables for A/B testing or emergency rollback without a code deploy.
 *
 * TTLs
 * ────
 * Centralised here so a single edit propagates to all cache call sites.
 * Values are in milliseconds.
 */

// ─── Model version ────────────────────────────────────────────────────────────
// Bump this whenever the WC model structure changes (new calibration phase,
// new ELO weighting, etc.).  Any cached WC pre-predictions carrying a
// different version string will be discarded and rebuilt fresh.

const WC_MODEL_VERSION = 'v9'; // score threshold 0.45→0.37; upset guard eloGap<60; upset floor 0.30→0.33

// ─── Cache TTLs (milliseconds) ────────────────────────────────────────────────

const TTL = {
  FPL:              5  * 60 * 1000,    // 5 min — FPL bootstrap / fixtures
  XG:               60 * 60 * 1000,    // 1 h   — xG data
  ODDS:             60 * 60 * 1000,    // 1 h   — bookmaker odds
  ODDS_HOT:         15 * 60 * 1000,    // 15 min — odds near kickoff
  ACCURACY:          2  * 60 * 60 * 1000,  // 2 h — prediction accuracy metrics
  TABLE:             5  * 60 * 1000,   // 5 min — league table
  XPTS:             10 * 60 * 1000,    // 10 min — expected points
  WEATHER:          60 * 60 * 1000,    // 1 h   — weather data
  DIAGNOSTICS:       5  * 60 * 1000,   // 5 min — model diagnostics report
  MONITOR_REPORT:    2  * 60 * 1000,   // 2 min — monitor health report
  WC_ELO:           24 * 60 * 60 * 1000,  // 24 h — martj42 / dynamic ELO
  WC_ESPN:           5  * 60 * 1000,   // 5 min — ESPN live fixtures / standings
  WC_PRE_PRED:      60 * 60 * 1000,    // 1 h   — pre-computed WC predictions
};

// ─── ELO build config ─────────────────────────────────────────────────────────
// Parameters for the adaptive alpha blending in worldCupElo().
// Must stay in sync with the values passed in buildDynamicElo() → server.js.

const ELO_CONFIG = {
  WC: {
    crossConfedIntraWeight: 0.87,   // K multiplier for intra-confederation matches
    startDate: '2018-01-01',        // only matches after this date are used
    alphaParams: {
      divisor: 25,    // n / divisor for alpha
      min:     0.15,  // alpha floor (very sparse teams stay near prior)
      cap:     0.85,  // alpha ceiling (teams with many games trust ELO fully)
    },
  },
  LEAGUE: {
    K:        20,
    homeAdv:  50,
    startElo: 1500,
  },
};

// ─── Feature flags ────────────────────────────────────────────────────────────
// All flags default to production-safe values.
// Override via environment variables for gradual rollout / emergency rollback.

const FLAGS = {
  // Enable the Model Monitor POST endpoint (POST /api/monitor/record-outcome).
  // When false, the endpoint returns 501.
  MONITOR_ENABLED:          env('FLAG_MONITOR_ENABLED', true),

  // Use dynamic ELO (martj42 build) for WC predictions.
  // When false, falls back to FIFA_STRENGTH priors.
  DYNAMIC_ELO_ENABLED:      env('FLAG_DYNAMIC_ELO_ENABLED', true),

  // Enable pre-computed WC predictions (disk + Supabase cache).
  // When false, all WC predictions are computed on-demand.
  WC_PRE_PRED_ENABLED:      env('FLAG_WC_PRE_PRED_ENABLED', true),

  // Enable Dixon-Coles τ correction in WC Poisson model.
  // Must stay true to preserve current calibration.
  WC_DIXON_COLES_ENABLED:   env('FLAG_WC_DIXON_COLES_ENABLED', true),

  // Enable H2H nudge in wcPoisson().
  WC_H2H_NUDGE_ENABLED:     env('FLAG_WC_H2H_NUDGE_ENABLED', true),

  // Emit structured logs via core/observability/logger.
  STRUCTURED_LOGGING:       env('FLAG_STRUCTURED_LOGGING', true),

  // Enable pipeline parity guard (logs violations, does not block).
  PARITY_GUARD_ENABLED:     env('FLAG_PARITY_GUARD_ENABLED', false),  // off by default (expensive)
};

// ─── Model health thresholds (used by monitor and diagnostics) ────────────────

const HEALTH_THRESHOLDS = {
  // ELO spread below which a confederation is flagged as clustered
  ELO_CLUSTER_SD_HIGH:   35,   // HIGH clustering risk
  ELO_CLUSTER_SD_MEDIUM: 70,   // MEDIUM clustering risk

  // ELO stability: noise trials that must stay within this rank-swap fraction
  ELO_STABILITY_SCORE_MIN: 60,  // 0-100 scale; below this → unstable

  // Monitor calibration bands (Brier score, 3-class)
  BRIER_GOOD: 0.60,
  BRIER_FAIR: 0.68,

  // Drift thresholds
  DRIFT_BRIER_DELTA:   0.06,
  DRIFT_PROB_DELTA:    0.05,
  DRIFT_LAMBDA_DELTA:  0.15,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Read a boolean env var with a default. */
function env(key, defaultValue) {
  const v = process.env[key];
  if (v == null) return defaultValue;
  return v !== '0' && v.toLowerCase() !== 'false';
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  WC_MODEL_VERSION,
  TTL,
  ELO_CONFIG,
  FLAGS,
  HEALTH_THRESHOLDS,
};
