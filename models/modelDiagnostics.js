'use strict';

/**
 * modelDiagnostics.js
 *
 * Observational diagnostics layer for the WC ELO model.
 * Detects confederation inflation, clustering, rank instability,
 * cross-confederation overlap and model drift.
 *
 * IMPORTANT: Pure computation only. Does NOT touch ELO, prediction, or Poisson logic.
 */

// ─── 1. Confederation Inflation Index ────────────────────────────────────────
// Mean, median, top-5 average, std-dev per confederation, compared to UEFA.

function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

function stdDev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
}

/**
 * @param {Array<{team:string, elo:number, confederation:string}>} rankings
 * @returns {Object} keyed by confederation
 */
function computeConfederationInflation(rankings) {
  // Group ELOs by confederation
  const byConfed = {};
  for (const { elo, confederation } of rankings) {
    if (!byConfed[confederation]) byConfed[confederation] = [];
    byConfed[confederation].push(elo);
  }

  const uefaElos = byConfed['UEFA'] ?? [];
  const uefaMean = mean(uefaElos);

  const result = {};
  for (const [confed, elos] of Object.entries(byConfed)) {
    const sorted = [...elos].sort((a, b) => b - a);
    const top5   = sorted.slice(0, 5);
    const m      = mean(elos);
    result[confed] = {
      confed,
      teamCount:  elos.length,
      meanElo:    Math.round(m),
      medianElo:  Math.round(median(elos)),
      top5Mean:   Math.round(mean(top5)),
      spread:     Math.round(stdDev(elos)),
      minElo:     Math.round(Math.min(...elos)),
      maxElo:     Math.round(Math.max(...elos)),
      uefaGap:    Math.round(m - uefaMean),   // negative = below UEFA
    };
  }
  return result;
}

// ─── 2. Clustering Index ──────────────────────────────────────────────────────
// Measures how tightly CAF/AFC teams bunch in global rank bands.
// HIGH std-dev within confed = spread (good). LOW std-dev = clustered (bad).

function computeClusteringIndex(rankings) {
  // Global rank already embedded (index + 1 after sort)
  const sorted = [...rankings].sort((a, b) => b.elo - a.elo);
  sorted.forEach((t, i) => { t._rank = i + 1; });

  const byConfed = {};
  for (const t of sorted) {
    if (!byConfed[t.confederation]) byConfed[t.confederation] = [];
    byConfed[t.confederation].push(t);
  }

  const result = {};
  for (const [confed, teams] of Object.entries(byConfed)) {
    const elos  = teams.map(t => t.elo);
    const ranks = teams.map(t => t._rank);
    const sd    = stdDev(elos);

    // Count teams in global rank bands
    const inTop10  = ranks.filter(r => r <= 10).length;
    const in10_20  = ranks.filter(r => r > 10 && r <= 20).length;
    const in20_40  = ranks.filter(r => r > 20 && r <= 40).length;

    // Cluster score: LOW spread AND multiple teams in same narrow band = HIGH clustering
    // Threshold: sd < 40 = very compressed, 40–80 = moderate, >80 = healthy spread
    let clusterScore;
    if (sd < 35)       clusterScore = 'HIGH';
    else if (sd < 70)  clusterScore = 'MEDIUM';
    else               clusterScore = 'LOW';

    result[confed] = {
      confed,
      eloSpread:    Math.round(sd),
      clusterScore,
      rankBands: { top10: inTop10, band10_20: in10_20, band20_40: in20_40 },
      // Flag when ≥3 teams pile into a single 10-rank band
      bandAlert: [inTop10, in10_20, in20_40].some(n => n >= Math.max(3, teams.length * 0.5)),
    };
  }
  return result;
}

// ─── 3. Global Rank Stability Index ──────────────────────────────────────────
// Adds ±5 ELO noise N times, re-ranks top 30, measures average rank variance.
// stabilityScore 100 = perfectly stable; 0 = wildly unstable.

function computeGlobalStabilityIndex(rankings, trials = 30) {
  const top30Base = [...rankings]
    .sort((a, b) => b.elo - a.elo)
    .slice(0, 30)
    .map((t, i) => ({ team: t.team, baseRank: i + 1, elo: t.elo }));

  // Track rank across trials for each top-30 team
  const rankHistory = {};
  for (const { team } of top30Base) rankHistory[team] = [];

  for (let t = 0; t < trials; t++) {
    // Perturb all rankings (not just top 30 — a rank-31 team could displace rank-30)
    const perturbed = rankings.map(r => ({
      ...r,
      elo: r.elo + (Math.random() * 10 - 5),  // ±5 uniform
    }));
    const reSorted = [...perturbed].sort((a, b) => b.elo - a.elo);

    for (const { team } of top30Base) {
      const newRank = reSorted.findIndex(r => r.team === team) + 1;
      rankHistory[team].push(newRank > 0 ? newRank : 35); // 35 if fell out of visible range
    }
  }

  // Compute mean rank variance across all top-30 teams
  const variances = top30Base.map(({ team, baseRank }) => {
    const hist = rankHistory[team];
    const m    = mean(hist);
    const v    = hist.reduce((s, r) => s + (r - baseRank) ** 2, 0) / hist.length;
    return { team, baseRank, meanShift: Math.round(Math.abs(m - baseRank) * 10) / 10, variance: v };
  });

  const avgVariance = mean(variances.map(v => v.variance));
  // Map variance to 0–100: variance ≤ 0.5 → 100, variance ≥ 25 → 0
  const stabilityScore = Math.round(Math.max(0, Math.min(100, 100 - (avgVariance / 25) * 100)));

  // Most volatile = highest rank variance
  const mostVolatile = [...variances]
    .sort((a, b) => b.variance - a.variance)
    .slice(0, 10)
    .map(v => ({
      team:       v.team,
      baseRank:   v.baseRank,
      meanShift:  v.meanShift,
      volatility: Math.round(v.variance * 10) / 10,
    }));

  return { stabilityScore, avgVariance: Math.round(avgVariance * 100) / 100, mostVolatile };
}

// ─── 4. Confederation Overlap Score ──────────────────────────────────────────
// Measures ELO range overlap between confederation pairs.
// overlap = length of [max(minA,minB), min(maxA,maxB)] / length of [min(minA,minB), max(maxA,maxB)]
// i.e. intersection / union of ranges. 0 = no overlap, 1 = identical ranges.

function computeConfederationOverlap(rankings) {
  const byConfed = {};
  for (const { elo, confederation } of rankings) {
    if (!byConfed[confederation]) byConfed[confederation] = [];
    byConfed[confederation].push(elo);
  }

  const ranges = {};
  for (const [confed, elos] of Object.entries(byConfed)) {
    ranges[confed] = { min: Math.min(...elos), max: Math.max(...elos) };
  }

  const confeds = Object.keys(ranges);
  const matrix  = {};

  for (const a of confeds) {
    matrix[a] = {};
    for (const b of confeds) {
      if (a === b) { matrix[a][b] = 1.0; continue; }
      const overlapMin = Math.max(ranges[a].min, ranges[b].min);
      const overlapMax = Math.min(ranges[a].max, ranges[b].max);
      const intersection = Math.max(0, overlapMax - overlapMin);
      const unionMin = Math.min(ranges[a].min, ranges[b].min);
      const unionMax = Math.max(ranges[a].max, ranges[b].max);
      const union    = unionMax - unionMin;
      matrix[a][b] = union > 0 ? Math.round((intersection / union) * 100) / 100 : 0;
    }
  }

  return { matrix, ranges };
}

// ─── 5. Model Drift Monitor ───────────────────────────────────────────────────
// Compares current rankings vs a saved snapshot.
// Returns per-team rank movement and ELO drift.

/**
 * @param {Array<{team, elo, confederation}>} current
 * @param {Array<{team, elo, rank}> | null} snapshot  — null if no snapshot yet
 */
function computeModelDrift(current, snapshot) {
  if (!snapshot || !snapshot.length) {
    return { available: false, reason: 'No previous snapshot to compare against' };
  }

  const currentSorted = [...current].sort((a, b) => b.elo - a.elo);
  currentSorted.forEach((t, i) => { t._currentRank = i + 1; });

  const snapshotByTeam = Object.fromEntries(snapshot.map(t => [t.team, t]));

  const movements = [];
  for (const { team, elo, confederation, _currentRank } of currentSorted) {
    const prev = snapshotByTeam[team];
    if (!prev) continue;
    const rankDelta = prev.rank - _currentRank;   // positive = moved up
    const eloDelta  = elo - prev.elo;
    movements.push({ team, confederation, currentRank: _currentRank, prevRank: prev.rank, rankDelta, eloDelta });
  }

  // Summary stats
  const bigMovers = [...movements]
    .filter(m => Math.abs(m.rankDelta) >= 3 || Math.abs(m.eloDelta) >= 20)
    .sort((a, b) => Math.abs(b.rankDelta) - Math.abs(a.rankDelta))
    .slice(0, 15);

  const avgEloDrift = mean(movements.map(m => Math.abs(m.eloDelta)));
  const maxRankShift = Math.max(...movements.map(m => Math.abs(m.rankDelta)), 0);

  // Structural shift flag: if avg drift > 15 ELO OR any team moved >8 ranks
  const structuralShift = avgEloDrift > 15 || maxRankShift > 8;

  return {
    available: true,
    structuralShift,
    avgEloDrift:  Math.round(avgEloDrift * 10) / 10,
    maxRankShift,
    bigMovers,
    totalTeamsTracked: movements.length,
  };
}

// ─── Master runner ────────────────────────────────────────────────────────────

/**
 * Run all diagnostics and return a single report object.
 *
 * @param {Array<{team:string, elo:number, confederation:string}>} rankings
 * @param {Array<{team:string, elo:number, rank:number}> | null} snapshot
 * @returns {Object}
 */
function runDiagnostics(rankings, snapshot = null) {
  const confedInflation  = computeConfederationInflation(rankings);
  const clusteringIndex  = computeClusteringIndex(rankings);
  const stabilityIndex   = computeGlobalStabilityIndex(rankings);
  const overlapScores    = computeConfederationOverlap(rankings);
  const driftReport      = computeModelDrift(rankings, snapshot);

  // Top-level health flags
  const highClusterConfeds = Object.values(clusteringIndex)
    .filter(c => c.clusterScore === 'HIGH')
    .map(c => c.confed);

  const health = {
    clusteringAlert:   highClusterConfeds.length > 0,
    clusteringConfeds: highClusterConfeds,
    stabilityAlert:    stabilityIndex.stabilityScore < 60,
    driftAlert:        driftReport.available && driftReport.structuralShift,
    overallStatus:
      highClusterConfeds.length === 0 && stabilityIndex.stabilityScore >= 60
        ? 'HEALTHY'
        : highClusterConfeds.length > 0 && stabilityIndex.stabilityScore < 60
        ? 'DEGRADED'
        : 'WARNING',
  };

  return {
    generatedAt:    new Date().toISOString(),
    teamCount:      rankings.length,
    health,
    confedInflation,
    clusteringIndex,
    stabilityIndex,
    overlapScores,
    driftReport,
  };
}

module.exports = { runDiagnostics };
