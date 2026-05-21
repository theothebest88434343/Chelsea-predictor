'use strict';

/**
 * core/footballEngine/elo.js
 *
 * Unified ELO interface for all three pipelines.
 *
 * Previously two completely separate implementations:
 *   buildEloRatings()  in models/predictionEngine.js — league ELO (K=20)
 *   buildDynamicElo()  in server.js                 — WC ELO (K=60 + confederation)
 *
 * One function, two modes. Logic is a direct extraction — outputs are identical
 * to the originals when called with equivalent parameters.
 *
 * Mode: "league"
 *   - Standard season ELO. K=20, ELO_HOME_ADV=50 home bonus,
 *     goal-margin multiplier (log scale). FPL fixture shape.
 *
 * Mode: "worldcup"
 *   - Tournament ELO built from martj42 international results.
 *     Variable K via kFactorFn, time decay, FIFA_STRENGTH priors,
 *     cross-confederation weighting, adaptive alpha blending.
 *     Martj42 match shape (home, away, homeScore, awayScore, tournament, date).
 */

// ─── League mode defaults ─────────────────────────────────────────────────────
// These match the constants in predictionEngine.js exactly.

const LEAGUE_DEFAULTS = {
  K:        20,
  homeAdv:  50,    // added to home team's raw ELO before expected-score calc
  startElo: 1500,
};

// ─── Shared base update ───────────────────────────────────────────────────────

/**
 * Single ELO exchange between two sides.
 * Returns updated ELOs [newHome, newAway].
 *
 * @param {number} rH      — current home ELO (with any bonus already added)
 * @param {number} rA      — current away ELO
 * @param {number} actH    — actual home score (1 win, 0.5 draw, 0 loss)
 * @param {number} K       — effective K for this match
 * @returns {[number, number]}  [homeUpdate, awayUpdate] — deltas to add
 */
function eloDeltas(rH, rA, actH, K) {
  const expH  = 1 / (1 + Math.pow(10, (rA - rH) / 400));
  const delta = K * (actH - expH);
  return [delta, -delta];
}

// ─── League mode ──────────────────────────────────────────────────────────────

/**
 * League ELO ratings.
 * Exact equivalent of buildEloRatings() from predictionEngine.js.
 *
 * @param {Array} matches  — FPL fixture shape: { team_h, team_a, team_h_score,
 *                           team_a_score, kickoff_time }
 * @param {Object} opts
 * @param {number} [opts.K=20]          — ELO K-factor
 * @param {number} [opts.homeAdv=50]    — ELO points added to home expected score
 * @param {number} [opts.startElo=1500] — initial rating for unseen teams
 * @returns {{ [teamId: string]: number }}
 */
function leagueElo(matches, opts = {}) {
  const K        = opts.K        ?? LEAGUE_DEFAULTS.K;
  const homeAdv  = opts.homeAdv  ?? LEAGUE_DEFAULTS.homeAdv;
  const startElo = opts.startElo ?? LEAGUE_DEFAULTS.startElo;

  const played = matches
    .filter(f => f.team_h_score != null && f.team_a_score != null)
    .sort((a, b) => new Date(a.kickoff_time) - new Date(b.kickoff_time));

  const elo = {};
  const get  = id => { const k = String(id); if (elo[k] == null) elo[k] = startElo; return elo[k]; };

  for (const f of played) {
    const hId  = String(f.team_h);
    const aId  = String(f.team_a);
    const hElo = get(hId) + homeAdv;  // home advantage baked into expected score
    const aElo = get(aId);

    const hG = f.team_h_score;
    const aG = f.team_a_score;
    const sH = hG > aG ? 1 : hG === aG ? 0.5 : 0;

    // Goal-margin multiplier: draws use 1.0, decisive results scale by log(|GD|+1).
    // A 4-0 win (≈1.61×) updates harder than a 1-0 win. Floor at 1.
    const goalDiff = Math.abs(hG - aG);
    const kMult    = goalDiff === 0 ? 1 : Math.max(1, Math.log(goalDiff + 1));

    const [dH, dA] = eloDeltas(hElo, aElo, sH, K * kMult);
    elo[hId] = (elo[hId] ?? startElo) + dH;
    elo[aId] = (elo[aId] ?? startElo) + dA;
  }

  return elo;
}

// ─── World Cup mode ───────────────────────────────────────────────────────────

/**
 * World Cup / international ELO ratings.
 * Exact equivalent of buildDynamicElo() from server.js.
 *
 * @param {Array} matches  — martj42 shape: { home, away, homeScore, awayScore,
 *                           tournament, date }
 * @param {Object} opts
 * @param {Function} opts.kFactorFn          — kFactor(tournament, date) → number
 * @param {Function} opts.priorEloFn         — priorEloFn(teamName) → number
 * @param {Object}   opts.confederationCtx   — confederation-specific adjustments:
 *   {
 *     getConfed(teamName): string|null,       — confederation lookup
 *     crossConfedIntraWeight: number,         — K multiplier for intra-confed matches (0.87)
 *     alphaParams: {
 *       divisor: number,                      — n / divisor for alpha (25)
 *       min:     number,                      — alpha floor (0.15)
 *       cap:     number,                      — alpha ceiling (0.85)
 *     },
 *   }
 * @param {string} [opts.startDate='2018-01-01'] — filter matches before this date
 * @returns {{ [teamName: string]: number }}
 */
function worldCupElo(matches, opts) {
  const {
    kFactorFn,
    priorEloFn,
    confederationCtx,
    startDate = '2018-01-01',
  } = opts;

  const {
    getConfed,
    crossConfedIntraWeight = 0.87,
    alphaParams = { divisor: 25, min: 0.15, cap: 0.85 },
  } = confederationCtx;

  const recent = matches
    .filter(r => r.date >= startDate)
    .sort((a, b) => a.date.localeCompare(b.date));

  const ratings    = {};
  const matchCount = {};

  for (const { home, away, homeScore, awayScore, tournament, date } of recent) {
    if (ratings[home] == null) ratings[home] = priorEloFn(home);
    if (ratings[away] == null) ratings[away] = priorEloFn(away);
    matchCount[home] = (matchCount[home] ?? 0) + 1;
    matchCount[away] = (matchCount[away] ?? 0) + 1;

    const rH = ratings[home];
    const rA = ratings[away];

    const baseK = kFactorFn(tournament, date);

    // Cross-confederation weight: inter-confed matches carry stronger global signal.
    // Intra-confederation matches (qualifiers, AFCON, Asian Cup) are damped.
    const confedH      = getConfed(home);
    const confedA      = getConfed(away);
    const isCrossConfed = confedH && confedA && confedH !== confedA;
    const K             = baseK * (isCrossConfed ? 1.0 : crossConfedIntraWeight);

    let actH;
    if (homeScore > awayScore) actH = 1;
    else if (homeScore < awayScore) actH = 0;
    else actH = 0.5;

    // No home-advantage term in international ELO — host nation boost is
    // handled separately in wcLambdas() at prediction time.
    const expH = 1 / (1 + Math.pow(10, (rA - rH) / 400));
    ratings[home] = rH + K * (actH - expH);
    ratings[away] = rA + K * ((1 - actH) - (1 - expH));
  }

  // ─── Regression to prior for sparse teams (<10 matches) ───────────────────
  for (const team of Object.keys(ratings)) {
    const n = matchCount[team] ?? 0;
    if (n < 10) {
      const w = n / 10;
      ratings[team] = w * ratings[team] + (1 - w) * priorEloFn(team);
    }
  }

  // ─── Adaptive alpha blending (match-count aware prior weighting) ───────────
  // Replaces the old static confederation credibility blend.
  // Teams with many matches → rely on ELO. Teams with few → stay near prior.
  // alpha = clamp(n / divisor, min, cap)
  for (const [team, elo] of Object.entries(ratings)) {
    const confed = getConfed(team);
    if (!confed) continue;
    const n     = matchCount[team] ?? 0;
    const alpha = Math.min(Math.max(n / alphaParams.divisor, alphaParams.min), alphaParams.cap);
    const prior = priorEloFn(team);
    ratings[team] = alpha * elo + (1 - alpha) * prior;
  }

  return ratings;
}

// ─── Unified interface ────────────────────────────────────────────────────────

/**
 * calculateEloRatings — single entry point for all ELO computations.
 *
 * @param {Object} params
 * @param {Array}  params.matches           — match records (shape depends on mode)
 * @param {'league'|'worldcup'} params.mode — which pipeline to use
 * @param {Object} [params.leagueOpts]      — options for league mode (K, homeAdv, startElo)
 * @param {Object} [params.worldcupOpts]    — options for worldcup mode (kFactorFn, priorEloFn, confederationCtx)
 * @returns {{ [id: string]: number }}       — team → ELO rating map
 */
function calculateEloRatings({ matches, mode, leagueOpts = {}, worldcupOpts = {} }) {
  if (mode === 'league') {
    return leagueElo(matches, leagueOpts);
  }
  if (mode === 'worldcup') {
    if (!worldcupOpts.kFactorFn || !worldcupOpts.priorEloFn || !worldcupOpts.confederationCtx) {
      throw new Error('calculateEloRatings worldcup mode requires kFactorFn, priorEloFn, confederationCtx');
    }
    return worldCupElo(matches, worldcupOpts);
  }
  throw new Error(`calculateEloRatings: unknown mode "${mode}". Use "league" or "worldcup".`);
}

module.exports = { calculateEloRatings };
