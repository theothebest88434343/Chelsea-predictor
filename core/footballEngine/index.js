'use strict';

/**
 * core/footballEngine/index.js
 *
 * Single import point for all shared football mathematics.
 *
 * Usage:
 *   const { poissonPMF, dixonColesTau, calculateEloRatings,
 *           buildFormStats, calcMatchAverages, getRestDays,
 *           PL_ACCESSORS, FD_ACCESSORS } = require('../../core/footballEngine');
 *
 * System map:
 *
 *   poisson.js    ─ poissonPMF(), dixonColesTau()
 *                    Previously: poissonProb (predictionEngine.js)
 *                                poissonPMF  (server.js) — same fn, 2 names
 *                    WC note: rho strategy (dynamic vs fixed) remains caller-side
 *
 *   elo.js        ─ calculateEloRatings({ matches, mode, leagueOpts, worldcupOpts })
 *                    mode="league"   → replaces buildEloRatings()  in predictionEngine.js
 *                    mode="worldcup" → replaces buildDynamicElo()  in server.js
 *
 *   formEngine.js ─ buildFormStats(matches, teamIds, accessors, formWeights)
 *                    calcMatchAverages(matches, accessors)
 *                    getRestDays(teamId, kickoffTime, matches, accessors)
 *                    PL_ACCESSORS  — for FPL fixture shape
 *                    FD_ACCESSORS  — for football-data.org match shape
 *                    Replaces: buildFormData / buildFdFormData
 *                              calcLeagueAverages / calcFdLeagueAverages
 *                              getRestDays / getFdRestDays
 */

const { poissonPMF, dixonColesTau }                              = require('./poisson');
const { calculateEloRatings }                                    = require('./elo');
const { buildFormStats, calcMatchAverages, getRestDays,
        PL_ACCESSORS, FD_ACCESSORS }                             = require('./formEngine');

module.exports = {
  // Poisson math
  poissonPMF,
  dixonColesTau,

  // ELO
  calculateEloRatings,

  // Form / averages / rest days
  buildFormStats,
  calcMatchAverages,
  getRestDays,
  PL_ACCESSORS,
  FD_ACCESSORS,
};
