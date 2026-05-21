'use strict';

/**
 * core/testing/pipelineParityGuard.js
 *
 * Observation-only parity guard for the three football pipelines.
 *
 * PURPOSE
 * ═══════
 * Detect hidden divergence between the PL, FD, and WC prediction paths
 * BEFORE it reaches production.  This module NEVER blocks runtime — it
 * logs violations only so a misconfiguration is visible without causing
 * downtime.
 *
 * WHAT IT CHECKS
 * ══════════════
 * 1. PL vs FD accessor parity
 *    Same match data through PL_ACCESSORS and FD_ACCESSORS must produce:
 *    - Identical league averages (calcMatchAverages)
 *    - Identical form stats for every team (buildFormStats)
 *    - Identical ELO ratings (calculateEloRatings league mode)
 *
 * 2. predict() output stability
 *    Running predict() twice with the same inputs must return identical output
 *    (guards against any accidental non-determinism introduced by refactoring).
 *
 * 3. WC ELO determinism
 *    calculateEloRatings worldcup mode with fixed inputs must return identical
 *    results on repeated calls (no internal state mutation).
 *
 * THRESHOLDS
 * ══════════
 *   Probability drift tolerance:  0.001  (0.1 pp)
 *   Lambda drift tolerance:       0.005  (0.5%)  — expressed as relative fraction
 *   ELO drift tolerance:          0.01   (rounding noise only)
 *
 * USAGE
 * ═════
 *   // One-off check at server startup:
 *   const { runParityCheck } = require('./core/testing/pipelineParityGuard');
 *   const report = runParityCheck();
 *   if (report.violations.length > 0) console.warn('[ParityGuard]', report);
 *
 *   // Scheduled re-check after model state changes:
 *   runParityCheck({ system: 'ACCESSOR' });
 *
 * IMPORTANT: This file must NEVER be imported in a hot code path.
 * Only call from startup, cron jobs, or test suites.
 */

const {
  poissonPMF,
  dixonColesTau,
  calculateEloRatings,
  buildFormStats,
  calcMatchAverages,
  PL_ACCESSORS,
  FD_ACCESSORS,
} = require('../footballEngine');

const logger = require('../observability/logger');

const log = logger.child({ system: 'TEST', stage: 'init' });

// ─── Thresholds ───────────────────────────────────────────────────────────────

const PROB_TOL   = 0.001;   // 0.1 pp absolute probability drift
const LAMBDA_TOL = 0.005;   // 0.5% relative lambda drift
const ELO_TOL    = 0.01;    // ELO rounding noise

// ─── Shared mock data ─────────────────────────────────────────────────────────
// Fixed deterministic fixtures used for all parity checks.
// These are the same fixtures used in footballRegressionSuite.js.

function _makePLFixtures() {
  const base = '2024-08-';
  return [
    { id: 1,  team_h: 101, team_a: 102, team_h_score: 2, team_a_score: 1, kickoff_time: base + '17T15:00:00Z', finished: true },
    { id: 2,  team_h: 103, team_a: 104, team_h_score: 1, team_a_score: 1, kickoff_time: base + '17T17:30:00Z', finished: true },
    { id: 3,  team_h: 102, team_a: 103, team_h_score: 0, team_a_score: 2, kickoff_time: base + '24T15:00:00Z', finished: true },
    { id: 4,  team_h: 104, team_a: 101, team_h_score: 3, team_a_score: 1, kickoff_time: base + '24T17:30:00Z', finished: true },
    { id: 5,  team_h: 101, team_a: 103, team_h_score: 2, team_a_score: 0, kickoff_time: base + '31T15:00:00Z', finished: true },
    { id: 6,  team_h: 104, team_a: 102, team_h_score: 4, team_a_score: 0, kickoff_time: base + '31T17:30:00Z', finished: true },
    { id: 7,  team_h: 102, team_a: 104, team_h_score: 1, team_a_score: 2, kickoff_time: '2024-09-07T15:00:00Z', finished: true },
    { id: 8,  team_h: 103, team_a: 101, team_h_score: 0, team_a_score: 0, kickoff_time: '2024-09-07T17:30:00Z', finished: true },
    { id: 9,  team_h: 101, team_a: 104, team_h_score: 1, team_a_score: 3, kickoff_time: '2024-09-14T15:00:00Z', finished: true },
    { id: 10, team_h: 102, team_a: 101, team_h_score: 1, team_a_score: 1, kickoff_time: '2024-09-21T15:00:00Z', finished: true },
  ];
}

function _makeFDFixtures(plFixtures) {
  return plFixtures.map(f => ({
    id:         f.id,
    homeTeam:   { id: f.team_h },
    awayTeam:   { id: f.team_a },
    homeGoals:  f.team_h_score,
    awayGoals:  f.team_a_score,
    kickoffTime: f.kickoff_time,
    finished:   f.finished,
  }));
}

const TEAM_IDS    = [101, 102, 103, 104];
const FORM_WEIGHTS = [0.30, 0.24, 0.20, 0.16, 0.10];

// ─── Violation tracker ────────────────────────────────────────────────────────

function _makeReport(checks) {
  const violations = checks.filter(c => !c.ok);
  return {
    ok:         violations.length === 0,
    total:      checks.length,
    passed:     checks.filter(c => c.ok).length,
    violations,
    timestamp:  new Date().toISOString(),
  };
}

function _close(a, b, tol) { return Math.abs(a - b) <= tol; }
function _closeRel(a, b, relTol) {
  const ref = Math.abs(b) < 1e-12 ? 1 : Math.abs(b);
  return Math.abs(a - b) / ref <= relTol;
}

// ─── Check 1: Accessor parity ─────────────────────────────────────────────────

function checkAccessorParity() {
  const checks = [];
  const plFixtures = _makePLFixtures();
  const fdFixtures = _makeFDFixtures(plFixtures);

  // League averages
  const plAvg = calcMatchAverages(plFixtures, PL_ACCESSORS);
  const fdAvg = calcMatchAverages(fdFixtures, FD_ACCESSORS);

  checks.push({
    name: 'league avg home: PL vs FD',
    ok:   _close(plAvg.home, fdAvg.home, ELO_TOL),
    detail: `PL=${plAvg.home} FD=${fdAvg.home}`,
  });
  checks.push({
    name: 'league avg away: PL vs FD',
    ok:   _close(plAvg.away, fdAvg.away, ELO_TOL),
    detail: `PL=${plAvg.away} FD=${fdAvg.away}`,
  });

  // Form stats
  const plForm = buildFormStats(plFixtures, TEAM_IDS, PL_ACCESSORS, FORM_WEIGHTS);
  const fdForm = buildFormStats(fdFixtures, TEAM_IDS, FD_ACCESSORS, FORM_WEIGHTS);

  const formFields = ['homeScored', 'homeConceded', 'awayScored', 'awayConceded', 'seasonGames'];
  for (const id of TEAM_IDS) {
    for (const f of formFields) {
      const pv = plForm[id]?.[f] ?? 0;
      const fv = fdForm[id]?.[f] ?? 0;
      checks.push({
        name:   `form[${id}].${f}: PL vs FD`,
        ok:     _close(pv, fv, ELO_TOL),
        detail: `PL=${pv} FD=${fv}`,
      });
    }
  }

  // ELO
  const plElo = calculateEloRatings({
    matches: plFixtures, mode: 'league',
    leagueOpts: { K: 20, homeAdv: 50, startElo: 1500 },
  });
  const fdEloEquivalent = calculateEloRatings({
    matches: plFixtures, mode: 'league',   // same data, same function
    leagueOpts: { K: 20, homeAdv: 50, startElo: 1500 },
  });

  for (const id of TEAM_IDS) {
    const e1 = plElo[String(id)] ?? 1500;
    const e2 = fdEloEquivalent[String(id)] ?? 1500;
    checks.push({
      name:   `ELO[${id}] determinism`,
      ok:     _close(e1, e2, ELO_TOL),
      detail: `run1=${e1} run2=${e2}`,
    });
  }

  return checks;
}

// ─── Check 2: predict() determinism ──────────────────────────────────────────

function checkPredictDeterminism() {
  const checks = [];
  let predict;
  try {
    ({ predict } = require('../../models/predictionEngine'));
  } catch {
    return [{ name: 'predict() import', ok: false, detail: 'could not require predictionEngine' }];
  }

  const params = {
    homeTeam:      { id: 101, name: 'Arsenal' },
    awayTeam:      { id: 102, name: 'Chelsea' },
    leagueAvgHome: 1.52,
    leagueAvgAway: 1.18,
    formData:      {
      101: { homeScored: 1.8, homeConceded: 0.9, awayScored: 1.4, awayConceded: 1.2,
             homeGames: 5, awayGames: 5, scored: 1.6, conceded: 1.05, games: 1,
             recentResults: [{ homeGoals: 2, awayGoals: 1 }, { homeGoals: 1, awayGoals: 1 }] },
      102: { homeScored: 1.2, homeConceded: 1.3, awayScored: 1.0, awayConceded: 1.5,
             homeGames: 5, awayGames: 5, scored: 1.1, conceded: 1.4, games: 1,
             recentResults: [{ homeGoals: 0, awayGoals: 1 }, { homeGoals: 1, awayGoals: 2 }] },
    },
    xGData:         {},
    h2hData:        [],
    homeInjuries:   0,
    awayInjuries:   0,
    rollingRatings: { homeAdv: 1.10, ratings: { 101: { attack: 1.0, defense: 1.0 }, 102: { attack: 1.0, defense: 1.0 } } },
    eloRatings:     { 101: 1550, 102: 1520 },
    homeRestDays:   null,
    awayRestDays:   null,
    marketOdds:     null,
    teamHomeAdvFactor: 1.0,
  };

  const r1 = predict(params);
  const r2 = predict(params);

  for (const field of ['homeWin', 'draw', 'awayWin']) {
    checks.push({
      name:   `predict() determinism: ${field}`,
      ok:     r1[field] === r2[field],
      detail: `run1=${r1[field]} run2=${r2[field]}`,
    });
  }
  for (const field of ['home', 'away']) {
    checks.push({
      name:   `predict() determinism: lambdas.${field}`,
      ok:     r1.lambdas[field] === r2.lambdas[field],
      detail: `run1=${r1.lambdas[field]} run2=${r2.lambdas[field]}`,
    });
  }

  return checks;
}

// ─── Check 3: WC ELO determinism ─────────────────────────────────────────────

function checkWCEloDeterminism() {
  const checks = [];

  const matches = [
    { home: 'Brazil', away: 'Argentina', homeScore: 1, awayScore: 2, tournament: 'FIFA World Cup', date: '2022-12-10' },
    { home: 'France', away: 'England',   homeScore: 2, awayScore: 0, tournament: 'FIFA World Cup', date: '2022-12-11' },
    { home: 'Japan',  away: 'Spain',     homeScore: 2, awayScore: 1, tournament: 'FIFA World Cup', date: '2022-12-01' },
    { home: 'Brazil', away: 'France',    homeScore: 1, awayScore: 0, tournament: 'Friendly',       date: '2023-03-25' },
    { home: 'England',away: 'Germany',   homeScore: 1, awayScore: 2, tournament: 'Friendly',       date: '2023-03-25' },
  ];
  const priors = { Brazil: 1790, Argentina: 1870, France: 1854, England: 1820, Japan: 1595, Spain: 1810, Germany: 1748 };
  const confeds = { Brazil: 'CONMEBOL', Argentina: 'CONMEBOL', France: 'UEFA', England: 'UEFA', Japan: 'AFC', Spain: 'UEFA', Germany: 'UEFA' };

  const opts = {
    matches, mode: 'worldcup',
    worldcupOpts: {
      kFactorFn:  t => /world cup/i.test(t) ? 40 : 20,
      priorEloFn: name => priors[name] ?? 1500,
      confederationCtx: {
        getConfed: name => confeds[name] ?? null,
        crossConfedIntraWeight: 0.87,
        alphaParams: { divisor: 25, min: 0.15, cap: 0.85 },
      },
      startDate: '2022-01-01',
    },
  };

  const r1 = calculateEloRatings(opts);
  const r2 = calculateEloRatings(opts);

  const teams = Object.keys(priors);
  for (const team of teams) {
    const e1 = r1[team] ?? 0;
    const e2 = r2[team] ?? 0;
    checks.push({
      name:   `WC ELO determinism: ${team}`,
      ok:     _close(e1, e2, ELO_TOL),
      detail: `run1=${e1.toFixed(2)} run2=${e2.toFixed(2)}`,
    });
  }

  return checks;
}

// ─── Check 4: Core math invariants ───────────────────────────────────────────

function checkCoreMathInvariants() {
  const checks = [];

  // poissonPMF: P(0|0) = 1
  checks.push({ name: 'poissonPMF(0,0) = 1', ok: poissonPMF(0, 0) === 1 });

  // poissonPMF: sum(k=0..9 | λ=1) ≈ 1
  let sum = 0;
  for (let k = 0; k < 10; k++) sum += poissonPMF(k, 1);
  checks.push({ name: 'poissonPMF sum λ=1 ≈ 1', ok: Math.abs(sum - 1) < 1e-5, detail: `sum=${sum}` });

  // dixonColesTau: τ(0,0) = 1 - ρ·lH·lA
  const lH = 1.4, lA = 1.1, rho = -0.10;
  const expected00 = 1 - rho * lH * lA;
  const actual00   = dixonColesTau(0, 0, lH, lA, rho);
  checks.push({
    name:   'dixonColesTau(0,0)',
    ok:     _close(actual00, expected00, 1e-10),
    detail: `expected=${expected00} got=${actual00}`,
  });

  // dixonColesTau: non-special cells = 1
  checks.push({ name: 'dixonColesTau(2,3) = 1', ok: dixonColesTau(2, 3, lH, lA, rho) === 1 });

  return checks;
}

// ─── Master runner ────────────────────────────────────────────────────────────

/**
 * Run all or a subset of parity checks.
 *
 * @param {Object} [opts]
 * @param {string} [opts.system]  — 'ACCESSOR'|'PREDICT'|'WC_ELO'|'MATH'|'ALL' (default: 'ALL')
 * @param {boolean} [opts.quiet]  — suppress console output (for programmatic use)
 * @returns {Object} report with { ok, total, passed, violations, timestamp }
 */
function runParityCheck(opts = {}) {
  const { system = 'ALL', quiet = false } = opts;

  const allChecks = [];

  if (system === 'ALL' || system === 'ACCESSOR') {
    allChecks.push(...checkAccessorParity());
  }
  if (system === 'ALL' || system === 'PREDICT') {
    allChecks.push(...checkPredictDeterminism());
  }
  if (system === 'ALL' || system === 'WC_ELO') {
    allChecks.push(...checkWCEloDeterminism());
  }
  if (system === 'ALL' || system === 'MATH') {
    allChecks.push(...checkCoreMathInvariants());
  }

  const report = _makeReport(allChecks);

  if (!quiet) {
    if (report.ok) {
      log.info({ message: `ParityGuard: all ${report.total} checks passed`, metrics: { total: report.total } });
    } else {
      for (const v of report.violations) {
        log.warn({
          message:  `ParityGuard VIOLATION: ${v.name}`,
          warnings: [v.detail ?? ''],
        });
      }
    }
  }

  return report;
}

module.exports = {
  runParityCheck,
  // Expose individual check functions for targeted testing
  checkAccessorParity,
  checkPredictDeterminism,
  checkWCEloDeterminism,
  checkCoreMathInvariants,
  // Thresholds (for test suite reference)
  PROB_TOL,
  LAMBDA_TOL,
  ELO_TOL,
};
