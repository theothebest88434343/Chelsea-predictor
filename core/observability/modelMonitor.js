'use strict';

/**
 * core/observability/modelMonitor.js
 *
 * Live model observability and monitoring layer.
 *
 * PURPOSE
 * ═══════
 * Track prediction behaviour AFTER match outcomes are known.
 * Detect calibration drift, systematic bias, and coverage gaps.
 * Surface hidden instability across PL / FD / WC pipelines.
 *
 * WHAT THIS IS NOT
 * ════════════════
 * This module does NOT change any prediction logic.
 * It does NOT compute ELO / form / lambdas.
 * It is pure computation on arrays of prediction-outcome records.
 *
 * SISTER MODULES
 * ══════════════
 * modelDiagnostics.js  — static ELO structure analysis (confederation inflation,
 *                         clustering, rank stability). Runs on the model itself.
 * modelMonitor.js      — live accuracy tracking. Runs on settled match outcomes.
 *
 * USAGE (server.js integration sketch)
 * ═════════════════════════════════════
 *   const monitor = require('./core/observability/modelMonitor');
 *
 *   // After a match settles:
 *   const entry = monitor.recordPredictionOutcome({ matchId, system, predicted, actual });
 *   log.push(entry);                   // caller persists log (Supabase / JSON file)
 *
 *   // On demand (e.g. GET /api/monitor-report):
 *   const report = monitor.generateMonitorReport(log);
 *
 *   // GET /api/monitor-drift:
 *   const recentWindow  = log.filter(e => e.timestamp >= cutoff);
 *   const baselineWindow = log.filter(e => e.timestamp < cutoff && e.timestamp >= baseStart);
 *   const drift = monitor.detectDrift(recentWindow, baselineWindow);
 */

// ─── Thresholds ────────────────────────────────────────────────────────────────

/** Minimum samples needed to trust a metric — below this, flag as insufficient data */
const MIN_SAMPLES = 20;

/**
 * Calibration health bands (Brier score, 3-class, range 0–2):
 *   GOOD  < 0.60  — well-calibrated model
 *   FAIR  < 0.68  — acceptable, watch for drift
 *   POOR  ≥ 0.68  — structural miscalibration
 */
const BRIER_GOOD = 0.60;
const BRIER_FAIR = 0.68;

/**
 * Log-loss health bands (3-class, range 0–∞):
 *   GOOD  < 1.00
 *   FAIR  < 1.10
 *   POOR  ≥ 1.10
 */
const LOGLOSS_GOOD = 1.00;
const LOGLOSS_FAIR = 1.10;

/** Bias flag: if mean predicted − mean actual > this threshold, flag as biased */
const BIAS_THRESHOLD = 0.04;          // 4 pp systematic over/under-prediction

/** Drift alert: if Brier score worsens by more than this vs baseline, raise drift */
const DRIFT_BRIER_DELTA = 0.06;

/** Drift alert: if mean predicted probability shifts by more than this, raise drift */
const DRIFT_PROB_DELTA = 0.05;        // 5 pp shift in mean predicted probability

/** Lambda drift: if mean xG shifts by more than this vs baseline, raise drift */
const DRIFT_LAMBDA_DELTA = 0.15;

/** Reliability bucket count for calibration curve */
const RELIABILITY_BINS = 10;

// ─── Statistical primitives ────────────────────────────────────────────────────

function _mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function _stdDev(arr) {
  if (arr.length < 2) return 0;
  const m = _mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
}

function _median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

function _percentile(arr, p) {
  if (!arr.length) return 0;
  const s   = [...arr].sort((a, b) => a - b);
  const idx = Math.min(Math.floor(p * s.length), s.length - 1);
  return s[idx];
}

function _r2(n) { return Math.round(n * 100) / 100; }
function _r4(n) { return Math.round(n * 10000) / 10000; }
function _r6(n) { return Math.round(n * 1000000) / 1000000; }

const _eps = 1e-9;

// ─── 1. Record normalisation & validation ─────────────────────────────────────

/**
 * Validate and normalise an incoming prediction-outcome record.
 *
 * Does NOT write to any store — the caller is responsible for persistence.
 * Throws (or returns { error }) if the record is structurally invalid so
 * bad data never silently corrupts downstream metrics.
 *
 * @param {Object} entry
 * @param {string}  entry.matchId
 * @param {'PL'|'FD'|'WC'} entry.system
 * @param {Object}  entry.predicted
 * @param {number}  entry.predicted.homeWinProb
 * @param {number}  entry.predicted.drawProb
 * @param {number}  entry.predicted.awayWinProb
 * @param {number}  [entry.predicted.expectedGoalsHome]
 * @param {number}  [entry.predicted.expectedGoalsAway]
 * @param {Object}  entry.actual
 * @param {number}  entry.actual.homeGoals
 * @param {number}  entry.actual.awayGoals
 * @param {string}  [entry.actual.result]  — 'H'|'D'|'A', derived if omitted
 * @param {Object}  [entry.context]        — homeTeam, awayTeam, kickoffTime, eloHome, eloAway
 * @param {string}  [entry.timestamp]      — ISO string, defaults to now
 * @returns {{ entry: Object }|{ error: string }}
 */
function recordPredictionOutcome({
  matchId,
  system,
  predicted,
  actual,
  context = {},
  timestamp,
}) {
  // ── Structural validation ───────────────────────────────────────────────────
  if (!matchId)                        return { error: 'matchId required' };
  if (!['PL', 'FD', 'WC'].includes(system))
                                       return { error: `system must be PL|FD|WC, got "${system}"` };
  if (!predicted || !actual)           return { error: 'predicted and actual required' };

  const { homeWinProb, drawProb, awayWinProb } = predicted;
  if ([homeWinProb, drawProb, awayWinProb].some(v => v == null || !isFinite(v)))
    return { error: 'predicted.homeWinProb / drawProb / awayWinProb must be finite numbers' };

  const probSum = homeWinProb + drawProb + awayWinProb;
  if (Math.abs(probSum - 1) > 0.01)
    return { error: `predicted probabilities sum to ${probSum.toFixed(4)}, expected ~1` };

  const { homeGoals, awayGoals } = actual;
  if (homeGoals == null || awayGoals == null || !Number.isInteger(homeGoals) || !Number.isInteger(awayGoals))
    return { error: 'actual.homeGoals and actual.awayGoals must be integers' };

  // ── Derive result if not supplied ───────────────────────────────────────────
  const derivedResult = homeGoals > awayGoals ? 'H' : homeGoals === awayGoals ? 'D' : 'A';
  const result        = actual.result ?? derivedResult;

  // ── Normalised record ───────────────────────────────────────────────────────
  return {
    entry: {
      matchId,
      system,
      timestamp:  timestamp ?? new Date().toISOString(),
      predicted: {
        homeWinProb:       _r6(homeWinProb),
        drawProb:          _r6(drawProb),
        awayWinProb:       _r6(awayWinProb),
        expectedGoalsHome: predicted.expectedGoalsHome != null ? _r6(predicted.expectedGoalsHome) : null,
        expectedGoalsAway: predicted.expectedGoalsAway != null ? _r6(predicted.expectedGoalsAway) : null,
      },
      actual: {
        homeGoals,
        awayGoals,
        result,
      },
      context: {
        homeTeam:    context.homeTeam    ?? null,
        awayTeam:    context.awayTeam    ?? null,
        kickoffTime: context.kickoffTime ?? null,
        eloHome:     context.eloHome     ?? null,
        eloAway:     context.eloAway     ?? null,
      },
    },
  };
}

// ─── 2. Calibration metrics ────────────────────────────────────────────────────

/**
 * Compute full calibration metrics for an array of settled records.
 *
 * Returns: Brier score, log-loss, reliability curve, resolution, sharpness,
 *          per-outcome accuracy, and overall health band.
 *
 * @param {Array}  entries  — normalised records (from recordPredictionOutcome)
 * @param {Object} [opts]
 * @param {number} [opts.bins=10]          — reliability-curve bucket count
 * @param {string} [opts.system]           — filter to one pipeline ('PL'|'FD'|'WC')
 * @returns {Object}
 */
function computeCalibration(entries, opts = {}) {
  const { bins = RELIABILITY_BINS, system } = opts;
  const filtered = system ? entries.filter(e => e.system === system) : entries;
  const n        = filtered.length;

  if (n < 1) {
    return {
      n, insufficient: true,
      brier: null, logLoss: null, accuracy: null,
      reliability: [], resolution: null, sharpness: null,
      health: 'UNKNOWN',
    };
  }

  // ── Brier score (3-class) ───────────────────────────────────────────────────
  // Range [0, 2]. Lower is better. Chance = 2/3 ≈ 0.667.
  let brierTotal = 0;
  // ── Log-loss ────────────────────────────────────────────────────────────────
  let logTotal = 0;
  // ── Accuracy: did the highest-probability outcome match? ───────────────────
  let correct = 0;
  // ── Per-outcome averages ───────────────────────────────────────────────────
  let sumPredH = 0, sumPredD = 0, sumPredA = 0;
  let sumActH  = 0, sumActD  = 0, sumActA  = 0;
  // ── Lambda tracking ────────────────────────────────────────────────────────
  let sumLH = 0, sumLA = 0, lambdaN = 0;

  // Reliability buckets (per predicted probability, pooled across all 3 outcomes)
  const buckets = Array.from({ length: bins }, () => ({ sumPred: 0, sumAct: 0, count: 0 }));

  for (const e of filtered) {
    const { homeWinProb: pH, drawProb: pD, awayWinProb: pA } = e.predicted;
    const result = e.actual.result;

    const oH = result === 'H' ? 1 : 0;
    const oD = result === 'D' ? 1 : 0;
    const oA = result === 'A' ? 1 : 0;

    brierTotal += (pH - oH) ** 2 + (pD - oD) ** 2 + (pA - oA) ** 2;

    const logP = result === 'H' ? Math.max(_eps, pH)
               : result === 'D' ? Math.max(_eps, pD)
               :                  Math.max(_eps, pA);
    logTotal += Math.log(logP);

    // Predicted outcome = argmax of the three probabilities
    const predictedOutcome = pH >= pD && pH >= pA ? 'H' : pD >= pA ? 'D' : 'A';
    if (predictedOutcome === result) correct++;

    sumPredH += pH; sumPredD += pD; sumPredA += pA;
    sumActH  += oH; sumActD  += oD; sumActA  += oA;

    // Reliability buckets (pooled H/D/A)
    for (const [pred, act] of [[pH, oH], [pD, oD], [pA, oA]]) {
      const b = Math.min(Math.floor(pred * bins), bins - 1);
      buckets[b].sumPred += pred;
      buckets[b].sumAct  += act;
      buckets[b].count++;
    }

    // Lambda
    if (e.predicted.expectedGoalsHome != null) {
      sumLH += e.predicted.expectedGoalsHome;
      sumLA += e.predicted.expectedGoalsAway;
      lambdaN++;
    }
  }

  const brier   = _r4(brierTotal / n);
  const logLoss = _r4(-(logTotal / n));

  // ── Reliability curve (ECE-style) ──────────────────────────────────────────
  const reliability = buckets
    .filter(b => b.count > 0)
    .map(b => ({
      meanPredicted: _r4(b.sumPred / b.count),
      meanActual:    _r4(b.sumAct  / b.count),
      count:         b.count,
      overconfident: (b.sumPred / b.count) > (b.sumAct / b.count),
    }));

  // Expected Calibration Error = weighted avg |pred − actual| across buckets
  const totalBucketCount = buckets.reduce((s, b) => s + b.count, 0);
  const ece = _r4(buckets.reduce((s, b) =>
    s + b.count * Math.abs(b.sumPred / (b.count || 1) - b.sumAct / (b.count || 1)), 0)
    / (totalBucketCount || 1));

  // ── Resolution: std-dev of predicted probabilities (pooled) ───────────────
  // High resolution = the model is confident and spread out. Low = all near 33%.
  const allPreds = filtered.flatMap(e => [
    e.predicted.homeWinProb, e.predicted.drawProb, e.predicted.awayWinProb,
  ]);
  const resolution = _r4(_stdDev(allPreds));

  // ── Sharpness: mean max confidence ────────────────────────────────────────
  const sharpness = _r4(_mean(
    filtered.map(e => Math.max(e.predicted.homeWinProb, e.predicted.drawProb, e.predicted.awayWinProb))
  ));

  // ── Per-outcome actual rates ───────────────────────────────────────────────
  const perOutcome = {
    home: {
      meanPredicted: _r4(sumPredH / n),
      actualRate:    _r4(sumActH  / n),
      bias:          _r4(sumPredH / n - sumActH / n),
    },
    draw: {
      meanPredicted: _r4(sumPredD / n),
      actualRate:    _r4(sumActD  / n),
      bias:          _r4(sumPredD / n - sumActD / n),
    },
    away: {
      meanPredicted: _r4(sumPredA / n),
      actualRate:    _r4(sumActA  / n),
      bias:          _r4(sumPredA / n - sumActA / n),
    },
  };

  // ── Lambda averages ────────────────────────────────────────────────────────
  const lambdaAvg = lambdaN > 0
    ? { home: _r4(sumLH / lambdaN), away: _r4(sumLA / lambdaN), n: lambdaN }
    : null;

  // ── Health band ────────────────────────────────────────────────────────────
  const health = n < MIN_SAMPLES ? 'INSUFFICIENT_DATA'
               : brier < BRIER_GOOD ? 'GOOD'
               : brier < BRIER_FAIR ? 'FAIR'
               : 'POOR';

  return {
    n,
    insufficient: n < MIN_SAMPLES,
    brier,
    logLoss,
    ece,
    accuracy:    _r4(correct / n),
    resolution,
    sharpness,
    perOutcome,
    lambdaAvg,
    reliability,
    health,
  };
}

// ─── 3. Bias detection ─────────────────────────────────────────────────────────

/**
 * Detect systematic over/under-prediction per outcome and per pipeline.
 *
 * A model is biased when its average predicted probability consistently differs
 * from the observed frequency — e.g. it always predicts P(home) = 0.50 when the
 * true home-win rate in the data is 0.43.
 *
 * @param {Array}  entries
 * @param {Object} [opts]
 * @param {number} [opts.threshold=BIAS_THRESHOLD]  — minimum pp bias to flag
 * @returns {Object}  { systems, combined, flags }
 */
function detectBias(entries, opts = {}) {
  const threshold = opts.threshold ?? BIAS_THRESHOLD;
  const systems   = ['PL', 'FD', 'WC'];
  const result    = {};

  for (const sys of [...systems, 'ALL']) {
    const subset = sys === 'ALL' ? entries : entries.filter(e => e.system === sys);
    if (!subset.length) { result[sys] = { n: 0, insufficient: true }; continue; }

    const n = subset.length;
    let sumPH = 0, sumPD = 0, sumPA = 0;
    let sumAH = 0, sumAD = 0, sumAA = 0;

    for (const e of subset) {
      sumPH += e.predicted.homeWinProb;
      sumPD += e.predicted.drawProb;
      sumPA += e.predicted.awayWinProb;
      sumAH += e.actual.result === 'H' ? 1 : 0;
      sumAD += e.actual.result === 'D' ? 1 : 0;
      sumAA += e.actual.result === 'A' ? 1 : 0;
    }

    const homeBias = _r4(sumPH / n - sumAH / n);
    const drawBias = _r4(sumPD / n - sumAD / n);
    const awayBias = _r4(sumPA / n - sumAA / n);

    const flags = [];
    if (Math.abs(homeBias) > threshold) flags.push({
      type:      'HOME_BIAS',
      direction: homeBias > 0 ? 'OVER_PREDICTS_HOME_WIN' : 'UNDER_PREDICTS_HOME_WIN',
      bias:      homeBias,
      severity:  Math.abs(homeBias) > threshold * 2 ? 'HIGH' : 'MEDIUM',
    });
    if (Math.abs(drawBias) > threshold) flags.push({
      type:      'DRAW_BIAS',
      direction: drawBias > 0 ? 'OVER_PREDICTS_DRAW' : 'SUPPRESSES_DRAW',
      bias:      drawBias,
      severity:  Math.abs(drawBias) > threshold * 2 ? 'HIGH' : 'MEDIUM',
    });
    if (Math.abs(awayBias) > threshold) flags.push({
      type:      'AWAY_BIAS',
      direction: awayBias > 0 ? 'OVER_PREDICTS_AWAY_WIN' : 'UNDER_PREDICTS_AWAY_WIN',
      bias:      awayBias,
      severity:  Math.abs(awayBias) > threshold * 2 ? 'HIGH' : 'MEDIUM',
    });

    result[sys] = {
      n,
      insufficient: n < MIN_SAMPLES,
      homeBias,
      drawBias,
      awayBias,
      flags,
      clean: flags.length === 0,
    };
  }

  return result;
}

// ─── 4. Drift detection ────────────────────────────────────────────────────────

/**
 * Compare a recent window of predictions against a historical baseline.
 *
 * Detects:
 *  - Calibration degradation (Brier score rising)
 *  - Mean probability shift (predictions skewing in a new direction)
 *  - Lambda inflation/deflation (expected goals trending)
 *  - Sharpness collapse (model becoming uncertain / hedge-everything)
 *  - Sample rate drop (fewer predictions being made)
 *
 * @param {Array}  recentEntries    — e.g. last 4 weeks of settled matches
 * @param {Array}  baselineEntries  — e.g. season-to-date prior to recent window
 * @param {Object} [opts]
 * @param {string} [opts.system]   — filter to one pipeline
 * @returns {Object}  { alerts: Array, deltas: Object, status: 'STABLE'|'DRIFT'|'DEGRADED' }
 */
function detectDrift(recentEntries, baselineEntries, opts = {}) {
  const { system } = opts;
  const filter = arr => system ? arr.filter(e => e.system === system) : arr;

  const recent   = filter(recentEntries);
  const baseline = filter(baselineEntries);

  const rCal = computeCalibration(recent);
  const bCal = computeCalibration(baseline);

  const alerts = [];

  // ── Insufficient data ──────────────────────────────────────────────────────
  if (recent.length < MIN_SAMPLES) {
    return {
      recent:   { n: recent.length },
      baseline: { n: baseline.length },
      alerts:   [{ type: 'INSUFFICIENT_RECENT_DATA', n: recent.length, min: MIN_SAMPLES }],
      deltas:   {},
      status:   'UNKNOWN',
    };
  }

  // ── Calibration degradation ────────────────────────────────────────────────
  const brierDelta = bCal.brier != null ? _r4(rCal.brier - bCal.brier) : null;
  if (brierDelta != null && brierDelta > DRIFT_BRIER_DELTA) {
    alerts.push({
      type:     'CALIBRATION_DEGRADATION',
      severity: brierDelta > DRIFT_BRIER_DELTA * 2 ? 'HIGH' : 'MEDIUM',
      message:  `Brier score deteriorated by ${(brierDelta * 100).toFixed(1)}pp (baseline ${bCal.brier} → recent ${rCal.brier})`,
      baseline: bCal.brier,
      recent:   rCal.brier,
      delta:    brierDelta,
    });
  }

  // ── Probability mean shift (home / draw / away independently) ─────────────
  const outcomes = ['home', 'draw', 'away'];
  const deltas   = {};

  for (const o of outcomes) {
    const rMean = rCal.perOutcome?.[o]?.meanPredicted;
    const bMean = bCal.perOutcome?.[o]?.meanPredicted;
    if (rMean == null || bMean == null) continue;
    const delta = _r4(rMean - bMean);
    deltas[o]   = delta;
    if (Math.abs(delta) > DRIFT_PROB_DELTA) {
      alerts.push({
        type:     `PROBABILITY_SHIFT_${o.toUpperCase()}`,
        severity: Math.abs(delta) > DRIFT_PROB_DELTA * 2 ? 'HIGH' : 'MEDIUM',
        message:  `Mean P(${o}) shifted ${delta > 0 ? '+' : ''}${(delta * 100).toFixed(1)}pp (${bMean} → ${rMean})`,
        baseline: bMean,
        recent:   rMean,
        delta,
      });
    }
  }

  // ── Lambda drift ───────────────────────────────────────────────────────────
  if (rCal.lambdaAvg && bCal.lambdaAvg) {
    const deltaLH = _r4(rCal.lambdaAvg.home - bCal.lambdaAvg.home);
    const deltaLA = _r4(rCal.lambdaAvg.away - bCal.lambdaAvg.away);
    deltas.lambdaHome = deltaLH;
    deltas.lambdaAway = deltaLA;

    for (const [venue, delta] of [['HOME', deltaLH], ['AWAY', deltaLA]]) {
      if (Math.abs(delta) > DRIFT_LAMBDA_DELTA) {
        alerts.push({
          type:     `LAMBDA_DRIFT_${venue}`,
          severity: Math.abs(delta) > DRIFT_LAMBDA_DELTA * 2 ? 'HIGH' : 'MEDIUM',
          message:  `Mean xG (${venue.toLowerCase()}) drifted ${delta > 0 ? '+' : ''}${delta.toFixed(3)} goals`,
          baseline: venue === 'HOME' ? bCal.lambdaAvg.home : bCal.lambdaAvg.away,
          recent:   venue === 'HOME' ? rCal.lambdaAvg.home : rCal.lambdaAvg.away,
          delta,
        });
      }
    }
  }

  // ── Sharpness collapse ─────────────────────────────────────────────────────
  if (rCal.sharpness != null && bCal.sharpness != null) {
    const sharpDelta = _r4(rCal.sharpness - bCal.sharpness);
    deltas.sharpness = sharpDelta;
    if (sharpDelta < -0.06) {
      alerts.push({
        type:     'SHARPNESS_COLLAPSE',
        severity: sharpDelta < -0.12 ? 'HIGH' : 'MEDIUM',
        message:  `Model confidence dropped ${(sharpDelta * 100).toFixed(1)}pp — predictions converging toward 33%`,
        baseline: bCal.sharpness,
        recent:   rCal.sharpness,
        delta:    sharpDelta,
      });
    }
  }

  deltas.brier   = brierDelta;
  deltas.logLoss = bCal.logLoss != null ? _r4(rCal.logLoss - bCal.logLoss) : null;

  const highAlerts   = alerts.filter(a => a.severity === 'HIGH');
  const mediumAlerts = alerts.filter(a => a.severity === 'MEDIUM');

  const status = highAlerts.length > 0   ? 'DEGRADED'
               : mediumAlerts.length > 0 ? 'DRIFT'
               : 'STABLE';

  return {
    recent:   { n: recent.length,   calibration: rCal },
    baseline: { n: baseline.length, calibration: bCal },
    alerts,
    deltas,
    status,
  };
}

// ─── 5. Lambda distribution tracking ─────────────────────────────────────────

/**
 * Summarise the expected-goals (lambda) distribution across settled matches.
 *
 * Useful for detecting whether the model's goal expectations are:
 *  - Systematically inflating (unrealistic > 2.0 xG per side)
 *  - Systematically deflating (defensive bias)
 *  - Asymmetric (home/away gap widening or narrowing)
 *
 * @param {Array}  entries
 * @param {Object} [opts]
 * @param {string} [opts.system]        — filter to one pipeline
 * @param {string} [opts.groupBy]       — 'week'|'month'|'none' (default: 'none')
 * @returns {Object}
 */
function trackLambdaDrift(entries, opts = {}) {
  const { system, groupBy = 'none' } = opts;
  const filtered = (system ? entries.filter(e => e.system === system) : entries)
    .filter(e => e.predicted.expectedGoalsHome != null);

  if (!filtered.length) return { n: 0, insufficient: true };

  const lHs = filtered.map(e => e.predicted.expectedGoalsHome);
  const lAs = filtered.map(e => e.predicted.expectedGoalsAway);
  const totals = filtered.map((e, i) => lHs[i] + lAs[i]);

  const summary = {
    n:     filtered.length,
    home: {
      mean:   _r4(_mean(lHs)),
      median: _r4(_median(lHs)),
      p90:    _r4(_percentile(lHs, 0.90)),
      stdDev: _r4(_stdDev(lHs)),
    },
    away: {
      mean:   _r4(_mean(lAs)),
      median: _r4(_median(lAs)),
      p90:    _r4(_percentile(lAs, 0.90)),
      stdDev: _r4(_stdDev(lAs)),
    },
    total: {
      mean:   _r4(_mean(totals)),
      median: _r4(_median(totals)),
      p90:    _r4(_percentile(totals, 0.90)),
    },
    homeAdvantage: _r4(_mean(lHs) - _mean(lAs)),
  };

  // ── Time-series grouping ───────────────────────────────────────────────────
  if (groupBy !== 'none') {
    const groups = {};
    for (let i = 0; i < filtered.length; i++) {
      const ts  = filtered[i].timestamp ?? '';
      const key = groupBy === 'week'
        ? _isoWeek(ts)
        : groupBy === 'month' ? ts.slice(0, 7)
        : ts.slice(0, 10);
      if (!groups[key]) groups[key] = { lHs: [], lAs: [] };
      groups[key].lHs.push(lHs[i]);
      groups[key].lAs.push(lAs[i]);
    }
    summary.timeSeries = Object.entries(groups)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([period, g]) => ({
        period,
        n:          g.lHs.length,
        meanHome:   _r4(_mean(g.lHs)),
        meanAway:   _r4(_mean(g.lAs)),
        meanTotal:  _r4(_mean(g.lHs) + _mean(g.lAs)),
      }));
  }

  return summary;
}

/** ISO week string: "2025-W12" */
function _isoWeek(iso) {
  if (!iso) return 'unknown';
  const d   = new Date(iso);
  const jan = new Date(d.getFullYear(), 0, 1);
  const wk  = Math.ceil(((d - jan) / 86400000 + jan.getDay() + 1) / 7);
  return `${d.getFullYear()}-W${String(wk).padStart(2, '0')}`;
}

// ─── 6. Coverage report ────────────────────────────────────────────────────────

/**
 * Report which teams, pipelines, and time ranges have prediction coverage.
 *
 * Useful for spotting: missed matches, systems that stopped recording,
 * teams that are being systematically skipped.
 *
 * @param {Array}  entries
 * @returns {Object}  { bySystem, teamCoverage, dateRange, gaps }
 */
function computeCoverageReport(entries) {
  if (!entries.length) return { n: 0, bySystem: {}, teamCoverage: [], dateRange: null, gaps: [] };

  const bySystem = {};
  const teamMap  = {};
  const dates    = [];

  for (const e of entries) {
    // Per system
    if (!bySystem[e.system]) bySystem[e.system] = { count: 0, teams: new Set() };
    bySystem[e.system].count++;

    // Team coverage (from context)
    const home = e.context?.homeTeam;
    const away = e.context?.awayTeam;
    for (const team of [home, away]) {
      if (!team) continue;
      if (!teamMap[team]) teamMap[team] = { count: 0, systems: new Set() };
      teamMap[team].count++;
      teamMap[team].systems.add(e.system);
    }
    if (home) bySystem[e.system].teams.add(home);
    if (away) bySystem[e.system].teams.add(away);

    if (e.timestamp) dates.push(e.timestamp);
  }

  // Serialise sets
  for (const sys of Object.values(bySystem)) {
    sys.teamCount = sys.teams.size;
    delete sys.teams;
  }
  const teamCoverage = Object.entries(teamMap)
    .map(([team, v]) => ({
      team,
      count:   v.count,
      systems: [...v.systems].sort(),
    }))
    .sort((a, b) => b.count - a.count);

  dates.sort();
  const dateRange = dates.length
    ? { first: dates[0], last: dates[dates.length - 1] }
    : null;

  // Gap detection: if there's a multi-week gap in timestamps, flag it
  const gaps = [];
  for (let i = 1; i < dates.length; i++) {
    const days = (new Date(dates[i]) - new Date(dates[i - 1])) / 86400000;
    if (days > 21) {  // 3+ week gap
      gaps.push({
        from:     dates[i - 1],
        to:       dates[i],
        dayCount: Math.round(days),
      });
    }
  }

  return {
    n:            entries.length,
    bySystem,
    teamCoverage,
    dateRange,
    gaps,
    hasGaps:      gaps.length > 0,
  };
}

// ─── 7. ELO snapshot & trend ──────────────────────────────────────────────────

/**
 * Capture a point-in-time ELO distribution snapshot (for trend tracking).
 *
 * The caller stores these snapshots in an array and passes the array to
 * computeEloTrend() to see how ratings have evolved over time.
 *
 * @param {Object} eloRatings   — { [teamName]: eloValue }
 * @param {string} system       — 'PL'|'FD'|'WC'
 * @param {string} [timestamp]  — ISO string, defaults to now
 * @returns {Object}  snapshot record
 */
function snapshotEloDistribution(eloRatings, system, timestamp) {
  const elos = Object.values(eloRatings).filter(v => isFinite(v));
  if (!elos.length) return { system, timestamp: timestamp ?? new Date().toISOString(), n: 0 };

  return {
    system,
    timestamp:  timestamp ?? new Date().toISOString(),
    n:          elos.length,
    mean:       _r2(_mean(elos)),
    median:     _r2(_median(elos)),
    p10:        _r2(_percentile(elos, 0.10)),
    p90:        _r2(_percentile(elos, 0.90)),
    spread:     _r2(_stdDev(elos)),
    min:        _r2(Math.min(...elos)),
    max:        _r2(Math.max(...elos)),
    // Individual ratings (for team-level trend tracking)
    ratings:    Object.fromEntries(
      Object.entries(eloRatings)
        .filter(([, v]) => isFinite(v))
        .map(([k, v]) => [k, _r2(v)])
    ),
  };
}

/**
 * Compute trend from an array of ELO snapshots (oldest first).
 *
 * Returns per-team and distribution-level changes between first and last snapshot,
 * plus any teams whose rating has shifted more than the alert threshold.
 *
 * @param {Array}  snapshots      — array of snapshotEloDistribution() results
 * @param {Object} [opts]
 * @param {number} [opts.alertThreshold=50]  — ELO points shift to flag
 * @returns {Object}
 */
function computeEloTrend(snapshots, opts = {}) {
  const alertThreshold = opts.alertThreshold ?? 50;

  if (snapshots.length < 2) {
    return { insufficient: true, snapshots: snapshots.length };
  }

  const first = snapshots[0];
  const last  = snapshots[snapshots.length - 1];

  // Distribution trend
  const distributionTrend = {
    meanShift:   _r2(last.mean   - first.mean),
    spreadShift: _r2(last.spread - first.spread),
    p90Shift:    _r2((last.p90 ?? 0) - (first.p90 ?? 0)),
    p10Shift:    _r2((last.p10 ?? 0) - (first.p10 ?? 0)),
  };

  // Per-team shift
  const allTeams = new Set([
    ...Object.keys(first.ratings ?? {}),
    ...Object.keys(last.ratings ?? {}),
  ]);

  const teamShifts = [];
  for (const team of allTeams) {
    const eloFirst = first.ratings?.[team];
    const eloLast  = last.ratings?.[team];
    if (eloFirst == null || eloLast == null) continue;
    const shift = _r2(eloLast - eloFirst);
    teamShifts.push({ team, from: eloFirst, to: eloLast, shift });
  }
  teamShifts.sort((a, b) => Math.abs(b.shift) - Math.abs(a.shift));

  const alerts = teamShifts
    .filter(t => Math.abs(t.shift) > alertThreshold)
    .map(t => ({
      type:      t.shift > 0 ? 'RAPID_RATING_RISE' : 'RAPID_RATING_DROP',
      team:      t.team,
      shift:     t.shift,
      severity:  Math.abs(t.shift) > alertThreshold * 2 ? 'HIGH' : 'MEDIUM',
    }));

  return {
    system:          last.system,
    from:            first.timestamp,
    to:              last.timestamp,
    snapshotCount:   snapshots.length,
    distributionTrend,
    teamShifts:      teamShifts.slice(0, 20),  // top 20 movers
    alerts,
    stable:          alerts.length === 0,
  };
}

// ─── 8. Per-confidence band accuracy ─────────────────────────────────────────

/**
 * Break down accuracy by confidence band.
 *
 * Groups predictions by how confident the model was (max predicted probability),
 * then shows whether high-confidence predictions actually land more often.
 * A well-calibrated model should show higher accuracy in higher confidence bands.
 *
 * @param {Array}  entries
 * @param {Object} [opts]
 * @param {string} [opts.system]
 * @returns {Array<Object>}  sorted from lowest to highest confidence band
 */
function computeConfidenceBandAccuracy(entries, opts = {}) {
  const { system } = opts;
  const filtered = system ? entries.filter(e => e.system === system) : entries;

  // Bands: < 0.40, 0.40–0.50, 0.50–0.60, 0.60–0.70, 0.70–0.80, ≥ 0.80
  const BANDS = [
    { label: '<40%',   min: 0,    max: 0.40 },
    { label: '40-50%', min: 0.40, max: 0.50 },
    { label: '50-60%', min: 0.50, max: 0.60 },
    { label: '60-70%', min: 0.60, max: 0.70 },
    { label: '70-80%', min: 0.70, max: 0.80 },
    { label: '≥80%',   min: 0.80, max: 1.01 },
  ];

  return BANDS.map(band => {
    const inBand = filtered.filter(e => {
      const maxP = Math.max(e.predicted.homeWinProb, e.predicted.drawProb, e.predicted.awayWinProb);
      return maxP >= band.min && maxP < band.max;
    });

    if (!inBand.length) return { ...band, n: 0, accuracy: null };

    const correct = inBand.filter(e => {
      const { homeWinProb: pH, drawProb: pD, awayWinProb: pA } = e.predicted;
      const pred = pH >= pD && pH >= pA ? 'H' : pD >= pA ? 'D' : 'A';
      return pred === e.actual.result;
    }).length;

    const meanConf = _r4(_mean(
      inBand.map(e => Math.max(e.predicted.homeWinProb, e.predicted.drawProb, e.predicted.awayWinProb))
    ));

    return {
      label:          band.label,
      n:              inBand.length,
      accuracy:       _r4(correct / inBand.length),
      meanConfidence: meanConf,
      // Overconfidence: accuracy should roughly match confidence
      overconfident:  meanConf - (correct / inBand.length) > 0.08,
    };
  }).filter(b => b.n > 0);
}

// ─── 9. Unified health report ─────────────────────────────────────────────────

/**
 * Generate a unified observability report across all pipelines.
 *
 * Designed for the GET /api/monitor-report endpoint.
 * The full report JSON can be fed directly into a React dashboard component.
 *
 * @param {Array}  entries          — all settled prediction-outcome records
 * @param {Object} [opts]
 * @param {number} [opts.recentWindowDays=28]  — "recent" window for drift detection
 * @param {Array}  [opts.eloSnapshots]          — optional array of ELO snapshots
 * @returns {Object}
 */
function generateMonitorReport(entries, opts = {}) {
  const { recentWindowDays = 28, eloSnapshots = [] } = opts;

  const cutoff     = new Date(Date.now() - recentWindowDays * 86400000).toISOString();
  const recent     = entries.filter(e => e.timestamp >= cutoff);
  const historical = entries.filter(e => e.timestamp < cutoff);

  // ── Per-system calibration ─────────────────────────────────────────────────
  const calibration = {
    all: computeCalibration(entries),
    PL:  computeCalibration(entries, { system: 'PL' }),
    FD:  computeCalibration(entries, { system: 'FD' }),
    WC:  computeCalibration(entries, { system: 'WC' }),
  };

  // ── Bias ───────────────────────────────────────────────────────────────────
  const bias = detectBias(entries);

  // ── Drift (recent vs historical) ───────────────────────────────────────────
  const drift = {
    all: detectDrift(recent, historical),
    PL:  detectDrift(recent, historical, { system: 'PL' }),
    FD:  detectDrift(recent, historical, { system: 'FD' }),
    WC:  detectDrift(recent, historical, { system: 'WC' }),
  };

  // ── Lambda distribution ────────────────────────────────────────────────────
  const lambdaDrift = {
    all: trackLambdaDrift(entries, { groupBy: 'month' }),
    PL:  trackLambdaDrift(entries, { system: 'PL', groupBy: 'month' }),
    FD:  trackLambdaDrift(entries, { system: 'FD', groupBy: 'month' }),
    WC:  trackLambdaDrift(entries, { system: 'WC', groupBy: 'month' }),
  };

  // ── Confidence-band accuracy ───────────────────────────────────────────────
  const confidenceBands = computeConfidenceBandAccuracy(entries);

  // ── Coverage ───────────────────────────────────────────────────────────────
  const coverage = computeCoverageReport(entries);

  // ── ELO trend (if snapshots supplied) ─────────────────────────────────────
  const eloTrend = eloSnapshots.length >= 2 ? computeEloTrend(eloSnapshots) : null;

  // ── Overall health signal ─────────────────────────────────────────────────
  const allFlags = [
    ...Object.values(bias).flatMap(b => b.flags ?? []),
    ...[drift.all, drift.PL, drift.FD, drift.WC].flatMap(d => d.alerts ?? []),
    ...(eloTrend?.alerts ?? []),
  ];

  const highCount   = allFlags.filter(f => f.severity === 'HIGH').length;
  const mediumCount = allFlags.filter(f => f.severity === 'MEDIUM').length;

  const overallStatus = calibration.all.n < MIN_SAMPLES ? 'INSUFFICIENT_DATA'
                      : highCount   > 0                 ? 'CRITICAL'
                      : mediumCount > 1                 ? 'WARNING'
                      : calibration.all.health === 'POOR' ? 'WARNING'
                      : 'HEALTHY';

  return {
    generatedAt:    new Date().toISOString(),
    recentWindowDays,
    totalEntries:   entries.length,
    recentEntries:  recent.length,
    overallStatus,
    calibration,
    bias,
    drift,
    lambdaDrift,
    confidenceBands,
    coverage,
    eloTrend,
    // Flat list of all active flags for easy banner display
    activeFlags: allFlags.sort((a, b) =>
      (a.severity === 'HIGH' ? 0 : 1) - (b.severity === 'HIGH' ? 0 : 1)
    ),
  };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  // Record ingestion
  recordPredictionOutcome,

  // Individual metric computers
  computeCalibration,
  detectBias,
  detectDrift,
  trackLambdaDrift,
  computeCoverageReport,
  computeConfidenceBandAccuracy,

  // ELO monitoring
  snapshotEloDistribution,
  computeEloTrend,

  // Unified report (endpoint-ready)
  generateMonitorReport,

  // Exposed thresholds (useful for UI to know what the bands are)
  THRESHOLDS: {
    MIN_SAMPLES,
    BRIER_GOOD,
    BRIER_FAIR,
    LOGLOSS_GOOD,
    LOGLOSS_FAIR,
    BIAS_THRESHOLD,
    DRIFT_BRIER_DELTA,
    DRIFT_PROB_DELTA,
    DRIFT_LAMBDA_DELTA,
  },
};
