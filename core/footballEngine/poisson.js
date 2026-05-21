'use strict';

/**
 * core/footballEngine/poisson.js
 *
 * Shared Poisson math used by ALL three pipelines:
 *   - predictionEngine.js (league model)
 *   - server.js           (World Cup model)
 *
 * Previously: poissonProb() in predictionEngine, poissonPMF() in server.js
 * — same function, two names, two divergence points.
 *
 * ZERO model-behaviour change: logic is a direct extraction from both originals.
 */

// ─── Factorial lookup (0–15 precomputed) ─────────────────────────────────────
// Table covers k=0..15 (well beyond any realistic score-matrix size of 6–8).
// For k > 15 we multiply up from the table tail — avoids float-accumulation
// errors that a fully recursive form would introduce for large k.

const FACTORIALS = [
  1, 1, 2, 6, 24, 120, 720, 5040, 40320, 362880,      // 0!–9!
  3628800, 39916800, 479001600, 6227020800,             // 10!–13!
  87178291200, 1307674368000,                           // 14!–15!
];

function factorial(n) {
  if (n < FACTORIALS.length) return FACTORIALS[n];
  // Extend beyond the table by multiplying up from 15!
  let result = FACTORIALS[FACTORIALS.length - 1];
  for (let i = FACTORIALS.length; i <= n; i++) result *= i;
  return result;
}

/**
 * Poisson PMF — P(X = k) for Poisson(λ).
 *
 * Was: poissonProb()  in models/predictionEngine.js
 *      poissonPMF()   in server.js
 *
 * These were byte-for-byte identical. This is now the single implementation.
 *
 * @param {number} k      — observed count (goals)
 * @param {number} lambda — expected goals
 * @returns {number}
 */
function poissonPMF(k, lambda) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  return Math.exp(-lambda) * Math.pow(lambda, k) / factorial(k);
}

/**
 * Dixon-Coles τ correction.
 *
 * Adjusts the joint probability of low-scoring outcomes to account for
 * goal correlation (e.g. 0-0 and 1-1 occur more often than independent
 * Poisson would predict). Only the 4 cells (0-0, 1-0, 0-1, 1-1) are
 * modified — all other scores return 1.
 *
 * Was: tau() in models/predictionEngine.js
 *      Inlined inside wcPoisson() in server.js
 *
 * NOTE: rho is passed in by the caller. League model uses dynamicRho();
 * WC model uses a fixed −0.10. That caller-side decision is intentionally
 * NOT unified here — it is a deliberate model difference, not duplication.
 *
 * @param {number} h   — home goals in this cell
 * @param {number} a   — away goals in this cell
 * @param {number} lH  — home lambda
 * @param {number} lA  — away lambda
 * @param {number} rho — Dixon-Coles ρ (negative = positive low-score correlation)
 * @returns {number}   — multiplicative τ correction factor
 */
function dixonColesTau(h, a, lH, lA, rho) {
  if (h === 0 && a === 0) return 1 - rho * lH * lA;
  if (h === 1 && a === 0) return 1 + rho * lA;
  if (h === 0 && a === 1) return 1 + rho * lH;
  if (h === 1 && a === 1) return 1 - rho;
  return 1;
}

module.exports = { poissonPMF, dixonColesTau };
