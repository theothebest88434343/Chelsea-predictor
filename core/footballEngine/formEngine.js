'use strict';

/**
 * core/footballEngine/formEngine.js
 *
 * Unified form, league-average, and rest-days logic for all three pipelines.
 *
 * Previously three duplicate pairs — identical algorithm, different field names:
 *
 *   buildFormData()       (PL)  vs  buildFdFormData()       (FD)
 *   calcLeagueAverages()  (PL)  vs  calcFdLeagueAverages()  (FD)
 *   getRestDays()         (PL)  vs  getFdRestDays()          (FD)
 *
 * All six are now three functions that accept ACCESSORS — small objects that
 * describe how to read fields from whichever match shape is in use.
 *
 * Callers supply one of the two pre-built accessor sets (PL_ACCESSORS or
 * FD_ACCESSORS) exported below. This keeps the core free of shape assumptions
 * while guaranteeing zero output change — the algorithm is untouched.
 */

// ─── Pre-built accessor sets ──────────────────────────────────────────────────
// Each accessor is a function: (match) → value.
// Supply these when calling buildFormStats / calcMatchAverages / getRestDays.

/**
 * Accessors for FPL (Premier League) fixture shape.
 * Fields: team_h, team_a, team_h_score, team_a_score, kickoff_time, finished
 */
const PL_ACCESSORS = {
  getHomeTeamId:  f => f.team_h,
  getAwayTeamId:  f => f.team_a,
  getHomeScore:   f => f.team_h_score,
  getAwayScore:   f => f.team_a_score,
  getKickoffTime: f => f.kickoff_time,
  isFinished:     f => f.finished && f.team_h_score != null,
};

/**
 * Accessors for football-data.org normalised match shape.
 * Fields: homeTeam.id, awayTeam.id, homeGoals, awayGoals, kickoffTime, finished
 */
const FD_ACCESSORS = {
  getHomeTeamId:  m => m.homeTeam.id,
  getAwayTeamId:  m => m.awayTeam.id,
  getHomeScore:   m => m.homeGoals,
  getAwayScore:   m => m.awayGoals,
  getKickoffTime: m => m.kickoffTime,
  isFinished:     m => m.finished && m.homeGoals != null,
};

// ─── 1. Form stats ────────────────────────────────────────────────────────────

/**
 * Build per-team form statistics from a list of matches.
 *
 * Replaces both buildFormData() (PL) and buildFdFormData() (FD).
 * Output shape is identical to both originals.
 *
 * @param {Array}    matches      — raw match records (any shape)
 * @param {Array}    teamIds      — list of team IDs to compute (e.g. teams.map(t=>t.id) for PL,
 *                                  or auto-derived from matches for FD)
 * @param {Object}   accessors    — field accessor set (PL_ACCESSORS or FD_ACCESSORS)
 * @param {number[]} formWeights  — recency weights for last-5 games
 * @returns {{ [teamId]: FormEntry }}
 */
function buildFormStats(matches, teamIds, accessors, formWeights) {
  const {
    getHomeTeamId, getAwayTeamId,
    getHomeScore, getAwayScore,
    getKickoffTime, isFinished,
  } = accessors;

  // Weighted average of goals over a window of games.
  // Normalised so weights always sum to 1 even with fewer games than weights.length.
  const wavg = (games, goalsFor, goalsAgainst) => {
    if (!games.length) return { sc: 0, co: 0 };
    const ws   = formWeights.slice(0, games.length);
    const wSum = ws.reduce((a, b) => a + b, 0) || 1;
    let sc = 0, co = 0;
    for (let i = 0; i < games.length; i++) {
      const w = (formWeights[i] ?? 0) / wSum;
      sc += goalsFor(games[i])     * w;
      co += goalsAgainst(games[i]) * w;
    }
    return { sc, co };
  };

  const formMap = {};

  for (const teamId of teamIds) {
    const allPlayed = matches
      .filter(m => isFinished(m) && (getHomeTeamId(m) === teamId || getAwayTeamId(m) === teamId))
      .sort((a, b) => new Date(getKickoffTime(b)) - new Date(getKickoffTime(a)));

    // ─── Venue-specific recent form (last 5 home / last 5 away separately) ──
    const homePlayed = allPlayed.filter(m => getHomeTeamId(m) === teamId).slice(0, 5);
    const awayPlayed = allPlayed.filter(m => getAwayTeamId(m) === teamId).slice(0, 5);

    const homeRecent = wavg(homePlayed, m => getHomeScore(m) ?? 0, m => getAwayScore(m) ?? 0);
    const awayRecent = wavg(awayPlayed, m => getAwayScore(m) ?? 0, m => getHomeScore(m) ?? 0);

    // ─── Season venue splits ─────────────────────────────────────────────────
    let seasonHomeScored = 0, seasonHomeConceded = 0;
    let seasonAwayScored = 0, seasonAwayConceded = 0;
    for (const m of allPlayed) {
      if (getHomeTeamId(m) === teamId) {
        seasonHomeScored   += getHomeScore(m) ?? 0;
        seasonHomeConceded += getAwayScore(m) ?? 0;
      } else {
        seasonAwayScored   += getAwayScore(m) ?? 0;
        seasonAwayConceded += getHomeScore(m) ?? 0;
      }
    }
    const allHome = allPlayed.filter(m => getHomeTeamId(m) === teamId);
    const allAway = allPlayed.filter(m => getAwayTeamId(m) === teamId);

    // ─── Mixed recent form (kept for backward-compat fallback path only) ────
    const mixed      = allPlayed.slice(0, 5);
    const mixedStats = wavg(
      mixed,
      m => (getHomeTeamId(m) === teamId ? getHomeScore(m) : getAwayScore(m)) ?? 0,
      m => (getHomeTeamId(m) === teamId ? getAwayScore(m) : getHomeScore(m)) ?? 0,
    );

    formMap[teamId] = {
      // Venue-specific recent form (primary — used by calculateLambdas)
      homeScored:   homeRecent.sc,
      homeConceded: homeRecent.co,
      homeGames:    homePlayed.length,
      awayScored:   awayRecent.sc,
      awayConceded: awayRecent.co,
      awayGames:    awayPlayed.length,
      // Season venue splits
      seasonHomeScored,  seasonHomeConceded,  seasonHomeGames: allHome.length,
      seasonAwayScored,  seasonAwayConceded,  seasonAwayGames: allAway.length,
      // Mixed season totals
      seasonScored:   seasonHomeScored + seasonAwayScored,
      seasonConceded: seasonHomeConceded + seasonAwayConceded,
      seasonGames:    allPlayed.length,
      // Mixed recent (legacy fallback + recentResults display)
      scored:   mixedStats.sc,
      conceded: mixedStats.co,
      games:    1,
      recentResults: mixed.map(m => ({
        homeGoals: (getHomeTeamId(m) === teamId ? getHomeScore(m) : getAwayScore(m)),
        awayGoals: (getHomeTeamId(m) === teamId ? getAwayScore(m) : getHomeScore(m)),
      })),
    };
  }

  return formMap;
}

// ─── 2. League averages ───────────────────────────────────────────────────────

/**
 * Calculate home and away goals-per-game across all finished matches.
 *
 * Replaces both calcLeagueAverages() (PL) and calcFdLeagueAverages() (FD).
 *
 * @param {Array}  matches   — raw match records
 * @param {Object} accessors — PL_ACCESSORS or FD_ACCESSORS
 * @returns {{ home: number, away: number }}
 */
function calcMatchAverages(matches, accessors) {
  const { getHomeScore, getAwayScore, isFinished } = accessors;
  const finished = matches.filter(isFinished);
  if (!finished.length) return { home: 1.52, away: 1.18 };
  const totalHome = finished.reduce((s, m) => s + (getHomeScore(m) ?? 0), 0);
  const totalAway = finished.reduce((s, m) => s + (getAwayScore(m) ?? 0), 0);
  return {
    home: totalHome / finished.length,
    away: totalAway / finished.length,
  };
}

// ─── 3. Rest days ─────────────────────────────────────────────────────────────

/**
 * Calendar days between a team's most recent settled match and their next kickoff.
 *
 * Replaces both getRestDays() (PL) and getFdRestDays() (FD).
 *
 * @param {number|string} teamId      — team identifier
 * @param {string}        kickoffTime — ISO datetime of the upcoming fixture
 * @param {Array}         matches     — all matches for this competition
 * @param {Object}        accessors   — PL_ACCESSORS or FD_ACCESSORS
 * @returns {number|null}             — days of rest, or null if no prior game found
 */
function getRestDays(teamId, kickoffTime, matches, accessors) {
  if (!kickoffTime) return null;
  const { getHomeTeamId, getAwayTeamId, getHomeScore, getKickoffTime, isFinished } = accessors;

  const kickoff = new Date(kickoffTime).getTime();

  const lastGame = matches
    .filter(m => {
      const hId = getHomeTeamId(m);
      const aId = getAwayTeamId(m);
      return (hId === teamId || aId === teamId)
          && isFinished(m)
          && getHomeScore(m) != null
          && getKickoffTime(m)
          && new Date(getKickoffTime(m)).getTime() < kickoff;
    })
    .sort((a, b) => new Date(getKickoffTime(b)) - new Date(getKickoffTime(a)))[0];

  if (!lastGame) return null;
  return Math.round((kickoff - new Date(getKickoffTime(lastGame)).getTime()) / 86400000);
}

module.exports = {
  buildFormStats,
  calcMatchAverages,
  getRestDays,
  PL_ACCESSORS,
  FD_ACCESSORS,
};
