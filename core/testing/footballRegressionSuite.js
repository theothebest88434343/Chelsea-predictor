'use strict';

/**
 * core/testing/footballRegressionSuite.js
 *
 * Snapshot-based regression test suite for the football analytics platform.
 *
 * Covers three pipelines — PL (FPL fixtures), FD (football-data.org), WC (World Cup) —
 * without making any network calls. All inputs are fixed, deterministic mock data.
 *
 * Usage:
 *   node core/testing/footballRegressionSuite.js           # compare against saved snapshots
 *   node core/testing/footballRegressionSuite.js --update  # rebuild snapshot file
 *
 * What is snapshotted:
 *   PL  — 20 predict() calls: winProbHome, winProbDraw, winProbAway, expectedGoalsHome,
 *          expectedGoalsAway, eloHome, eloAway
 *   FD  — 20 form-stat + average entries built via FD_ACCESSORS
 *   WC  — 20 team ELO values from calculateEloRatings worldcup mode
 *
 * What is unit-tested (no snapshot, hard-coded assertions):
 *   poissonPMF     — exact PMF values at known inputs
 *   dixonColesTau  — τ correction at all four special cells
 *   cross-pipeline — same logical data through PL vs FD accessors → identical averages
 *
 * Snapshot file:  core/testing/footballRegressionSnapshots.json
 */

const path = require('path');
const fs   = require('fs');

// ─── Imports ──────────────────────────────────────────────────────────────────

const {
  poissonPMF,
  dixonColesTau,
  calculateEloRatings,
  buildFormStats,
  calcMatchAverages,
  PL_ACCESSORS,
  FD_ACCESSORS,
} = require('../footballEngine');

const {
  predict,
  buildEloRatings,
} = require('../../models/predictionEngine');

// ─── Config ───────────────────────────────────────────────────────────────────

const SNAPSHOT_PATH = path.join(__dirname, 'footballRegressionSnapshots.json');
const UPDATE_MODE   = process.argv.includes('--update');
const TOLERANCE     = 1e-9; // floating-point comparison threshold

// ─── Test harness ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

function assert(label, condition, detail = '') {
  if (condition) {
    passed++;
  } else {
    failed++;
    failures.push(`  ✗ ${label}${detail ? ': ' + detail : ''}`);
  }
}

function assertClose(label, actual, expected, tol = TOLERANCE) {
  const ok = Math.abs(actual - expected) <= tol;
  assert(label, ok, `expected ${expected}, got ${actual} (diff ${Math.abs(actual - expected).toExponential(3)})`);
}

function section(name) {
  console.log(`\n── ${name} ${'─'.repeat(Math.max(0, 60 - name.length))}`);
}

// ─── Mock data builders ───────────────────────────────────────────────────────

/**
 * Build a minimal set of FPL-shape fixtures for a fictional 4-team league.
 * Scores are fixed — same data every run.
 * Teams: 101 (Arsenal), 102 (Chelsea), 103 (Liverpool), 104 (Man City)
 */
function makePLFixtures() {
  // Each fixture: { id, team_h, team_a, team_h_score, team_a_score, kickoff_time, finished }
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
    { id: 11, team_h: 104, team_a: 103, team_h_score: 2, team_a_score: 0, kickoff_time: '2024-09-21T17:30:00Z', finished: true },
    { id: 12, team_h: 103, team_a: 102, team_h_score: 3, team_a_score: 1, kickoff_time: '2024-09-28T15:00:00Z', finished: true },
    // GW 7-10 — second half
    { id: 13, team_h: 101, team_a: 102, team_h_score: 2, team_a_score: 2, kickoff_time: '2024-10-05T15:00:00Z', finished: true },
    { id: 14, team_h: 103, team_a: 104, team_h_score: 0, team_a_score: 1, kickoff_time: '2024-10-05T17:30:00Z', finished: true },
    { id: 15, team_h: 104, team_a: 101, team_h_score: 2, team_a_score: 1, kickoff_time: '2024-10-19T15:00:00Z', finished: true },
    { id: 16, team_h: 102, team_a: 103, team_h_score: 1, team_a_score: 0, kickoff_time: '2024-10-19T17:30:00Z', finished: true },
    { id: 17, team_h: 101, team_a: 103, team_h_score: 1, team_a_score: 1, kickoff_time: '2024-10-26T15:00:00Z', finished: true },
    { id: 18, team_h: 104, team_a: 102, team_h_score: 3, team_a_score: 2, kickoff_time: '2024-10-26T17:30:00Z', finished: true },
    { id: 19, team_h: 102, team_a: 104, team_h_score: 0, team_a_score: 2, kickoff_time: '2024-11-02T15:00:00Z', finished: true },
    { id: 20, team_h: 103, team_a: 101, team_h_score: 2, team_a_score: 1, kickoff_time: '2024-11-02T17:30:00Z', finished: true },
  ];
}

/**
 * Exactly equivalent data in football-data.org normalised shape.
 * homeTeam.id / awayTeam.id mirror team_h / team_a above.
 */
function makeFDFixtures() {
  return makePLFixtures().map(f => ({
    id:           f.id,
    homeTeam:     { id: f.team_h, name: teamName(f.team_h) },
    awayTeam:     { id: f.team_a, name: teamName(f.team_a) },
    homeGoals:    f.team_h_score,
    awayGoals:    f.team_a_score,
    kickoffTime:  f.kickoff_time,
    finished:     f.finished,
  }));
}

function teamName(id) {
  return { 101: 'Arsenal', 102: 'Chelsea', 103: 'Liverpool', 104: 'Man City' }[id] ?? `Team${id}`;
}

/**
 * Fixed WC-style (martj42) match history for 6 fictional nations.
 * Each record: { home, away, homeScore, awayScore, tournament, date }
 */
function makeWCFixtures() {
  return [
    { home: 'Brazil',    away: 'Argentina',  homeScore: 2, awayScore: 1, tournament: 'FIFA World Cup',           date: '2022-12-10' },
    { home: 'France',    away: 'England',    homeScore: 2, awayScore: 0, tournament: 'FIFA World Cup',           date: '2022-12-11' },
    { home: 'Morocco',   away: 'Portugal',   homeScore: 1, awayScore: 0, tournament: 'FIFA World Cup',           date: '2022-12-10' },
    { home: 'Japan',     away: 'Spain',      homeScore: 2, awayScore: 1, tournament: 'FIFA World Cup',           date: '2022-12-01' },
    { home: 'Germany',   away: 'Costa Rica', homeScore: 4, awayScore: 2, tournament: 'FIFA World Cup',           date: '2022-12-01' },
    { home: 'Argentina', away: 'France',     homeScore: 3, awayScore: 3, tournament: 'FIFA World Cup Final',     date: '2022-12-18' },
    { home: 'Brazil',    away: 'France',     homeScore: 1, awayScore: 0, tournament: 'Friendly',                 date: '2023-03-25' },
    { home: 'England',   away: 'Germany',    homeScore: 1, awayScore: 2, tournament: 'Friendly',                 date: '2023-03-25' },
    { home: 'Morocco',   away: 'Brazil',     homeScore: 0, awayScore: 2, tournament: 'AFCON Qualifier',          date: '2023-06-15' },
    { home: 'Japan',     away: 'Morocco',    homeScore: 1, awayScore: 1, tournament: 'Friendly',                 date: '2023-09-10' },
    { home: 'France',    away: 'Germany',    homeScore: 2, awayScore: 2, tournament: 'UEFA Nations League',      date: '2023-09-12' },
    { home: 'Argentina', away: 'Brazil',     homeScore: 1, awayScore: 0, tournament: 'Copa America',            date: '2024-07-04' },
    { home: 'England',   away: 'France',     homeScore: 1, awayScore: 2, tournament: 'UEFA Euro',               date: '2024-07-06' },
    { home: 'Germany',   away: 'Spain',      homeScore: 1, awayScore: 2, tournament: 'UEFA Euro',               date: '2024-07-05' },
    { home: 'Brazil',    away: 'England',    homeScore: 1, awayScore: 1, tournament: 'Friendly',                 date: '2024-09-07' },
    { home: 'Morocco',   away: 'France',     homeScore: 0, awayScore: 2, tournament: 'Friendly',                 date: '2024-09-09' },
    { home: 'Japan',     away: 'Germany',    homeScore: 4, awayScore: 1, tournament: 'Friendly',                 date: '2024-09-10' },
    { home: 'Spain',     away: 'Argentina',  homeScore: 1, awayScore: 2, tournament: 'Friendly',                 date: '2024-11-18' },
    { home: 'France',    away: 'Japan',      homeScore: 3, awayScore: 0, tournament: 'Friendly',                 date: '2025-03-22' },
    { home: 'Brazil',    away: 'Morocco',    homeScore: 2, awayScore: 0, tournament: 'Friendly',                 date: '2025-03-25' },
    // Extra fixtures to give all teams > 5 matches so ELO has statistical weight
    { home: 'England',   away: 'Spain',      homeScore: 0, awayScore: 1, tournament: 'Friendly',                 date: '2025-06-01' },
    { home: 'Germany',   away: 'Argentina',  homeScore: 2, awayScore: 2, tournament: 'Friendly',                 date: '2025-06-03' },
    { home: 'Costa Rica',away: 'Japan',      homeScore: 0, awayScore: 3, tournament: 'CONCACAF Nations League',  date: '2025-06-05' },
    { home: 'Morocco',   away: 'Germany',    homeScore: 1, awayScore: 3, tournament: 'Friendly',                 date: '2025-06-07' },
    { home: 'Argentina', away: 'England',    homeScore: 2, awayScore: 1, tournament: 'Friendly',                 date: '2025-09-06' },
  ];
}

// ─── WC ELO helpers (simplified, deterministic — no file I/O) ─────────────────

// Simple K-factor: World Cup matches → 40, others → 20
function wcKFactor(tournament) {
  if (/world cup/i.test(tournament)) return 40;
  if (/euro|copa america|afcon|asian cup/i.test(tournament)) return 32;
  if (/nations league|qualifier/i.test(tournament)) return 28;
  return 20;
}

// Fixed prior ELOs seeded from approximate FIFA strengths
const WC_PRIOR = {
  Argentina: 1850, Brazil: 1820, France: 1800, England: 1760,
  Germany: 1750,   Spain: 1780,  Morocco: 1650, Japan: 1620,
  Portugal: 1730,  'Costa Rica': 1540,
};
function wcPriorElo(name) {
  return WC_PRIOR[name] ?? 1500;
}

// Simple confederation lookup
const WC_CONFED = {
  Argentina: 'CONMEBOL', Brazil: 'CONMEBOL',
  France: 'UEFA', England: 'UEFA', Germany: 'UEFA', Spain: 'UEFA', Portugal: 'UEFA',
  Morocco: 'CAF',
  Japan: 'AFC', 'Costa Rica': 'CONCACAF',
};
function wcGetConfed(name) { return WC_CONFED[name] ?? null; }

// ─── Section 1: Core math unit tests ─────────────────────────────────────────

function runMathUnitTests() {
  section('Core math — poissonPMF');

  // P(k|λ) at known values (computed via exact formula exp(-λ)λ^k/k!)
  // P(0|1) = e^-1 ≈ 0.367879441...
  assertClose('poissonPMF(0, 1)', poissonPMF(0, 1), Math.exp(-1));
  // P(1|1) = e^-1 ≈ 0.367879441...
  assertClose('poissonPMF(1, 1)', poissonPMF(1, 1), Math.exp(-1));
  // P(2|1) = e^-1 / 2 ≈ 0.183939720...
  assertClose('poissonPMF(2, 1)', poissonPMF(2, 1), Math.exp(-1) / 2);
  // P(0|1.5) = e^-1.5 ≈ 0.223130160...
  assertClose('poissonPMF(0, 1.5)', poissonPMF(0, 1.5), Math.exp(-1.5));
  // P(2|1.5) = e^-1.5 * 1.5^2 / 2 ≈ 0.250771430...
  assertClose('poissonPMF(2, 1.5)', poissonPMF(2, 1.5), Math.exp(-1.5) * 1.5 * 1.5 / 2);
  // Boundary: λ=0 → P(0)=1, P(k>0)=0
  assertClose('poissonPMF(0, 0) = 1', poissonPMF(0, 0), 1);
  assertClose('poissonPMF(1, 0) = 0', poissonPMF(1, 0), 0);
  // Sum of first 10 values at λ=2 should approach 1
  let sumAt2 = 0;
  for (let k = 0; k < 15; k++) sumAt2 += poissonPMF(k, 2);
  assert('poissonPMF sums near 1 for λ=2', Math.abs(sumAt2 - 1) < 0.0001,
    `sum=${sumAt2}`);

  section('Core math — dixonColesTau');

  const lH = 1.4, lA = 1.1, rho = -0.10;
  // τ(0,0) = 1 − ρ·λH·λA
  assertClose('τ(0,0)', dixonColesTau(0, 0, lH, lA, rho), 1 - rho * lH * lA);
  // τ(1,0) = 1 + ρ·λA
  assertClose('τ(1,0)', dixonColesTau(1, 0, lH, lA, rho), 1 + rho * lA);
  // τ(0,1) = 1 + ρ·λH
  assertClose('τ(0,1)', dixonColesTau(0, 1, lH, lA, rho), 1 + rho * lH);
  // τ(1,1) = 1 − ρ
  assertClose('τ(1,1)', dixonColesTau(1, 1, lH, lA, rho), 1 - rho);
  // All other cells → 1
  assertClose('τ(2,0) = 1', dixonColesTau(2, 0, lH, lA, rho), 1);
  assertClose('τ(3,3) = 1', dixonColesTau(3, 3, lH, lA, rho), 1);
  // rho sign check: negative rho suppresses 0-0 (τ > 1 for (0,0))
  assert('τ(0,0) > 1 when rho < 0',
    dixonColesTau(0, 0, lH, lA, -0.10) > 1);
  // Symmetry: τ(0,0) with lH/lA swapped = same value (product is commutative)
  assertClose('τ(0,0) symmetric in λ',
    dixonColesTau(0, 0, lA, lH, rho),
    dixonColesTau(0, 0, lH, lA, rho));
}

// ─── Section 2: Cross-pipeline consistency ────────────────────────────────────

function runCrossPipelineTests() {
  section('Cross-pipeline — PL vs FD accessors on identical data');

  const plFixtures = makePLFixtures();
  const fdFixtures = makeFDFixtures();
  const teamIds    = [101, 102, 103, 104];
  const FORM_WEIGHTS = [0.30, 0.24, 0.20, 0.16, 0.10];

  // League averages should be identical regardless of accessor
  const plAvg = calcMatchAverages(plFixtures, PL_ACCESSORS);
  const fdAvg = calcMatchAverages(fdFixtures, FD_ACCESSORS);

  assertClose('league avg home — PL vs FD', plAvg.home, fdAvg.home, 1e-10);
  assertClose('league avg away — PL vs FD', plAvg.away, fdAvg.away, 1e-10);

  // Form stats for each team should be identical
  const plForm = buildFormStats(plFixtures, teamIds, PL_ACCESSORS, FORM_WEIGHTS);
  const fdForm = buildFormStats(fdFixtures, teamIds, FD_ACCESSORS, FORM_WEIGHTS);

  for (const id of teamIds) {
    const name = teamName(id);
    const fields = [
      'homeScored', 'homeConceded', 'homeGames',
      'awayScored', 'awayConceded', 'awayGames',
      'seasonScored', 'seasonConceded', 'seasonGames',
    ];
    for (const f of fields) {
      assertClose(
        `form[${name}].${f} — PL vs FD`,
        plForm[id][f],
        fdForm[id][f],
        1e-10,
      );
    }
  }

  // ELO via buildEloRatings (PL-shape) vs calculateEloRatings league mode (same data)
  const eloFromHelper = buildEloRatings(plFixtures);
  const eloFromCore   = calculateEloRatings({
    matches: plFixtures, mode: 'league',
    leagueOpts: { K: 20, homeAdv: 50, startElo: 1500 },
  });

  for (const id of teamIds) {
    assertClose(
      `ELO[${teamName(id)}] helper vs core`,
      eloFromHelper[String(id)],
      eloFromCore[String(id)],
      1e-10,
    );
  }

  return { plAvg, plForm, eloFromCore };
}

// ─── Section 3: PL predict() snapshots ───────────────────────────────────────

/**
 * 20 deterministic predict() calls covering:
 *  - dominant home favourite
 *  - dominant away favourite
 *  - near-toss-up
 *  - varying xG availability
 *  - varying form weights
 */
function buildPLSnapshots(plForm, eloRatings, leagueAvg) {
  const FORM_WEIGHTS = [0.30, 0.24, 0.20, 0.16, 0.10];

  // Build minimal rollingRatings with neutral values so the test doesn't
  // depend on the EWMA calculation path (xG is supplied, dominating the signal)
  const neutral = id => ({ attack: 1.0, defense: 1.0 });
  const rollingRatings = {
    homeAdv: 1.10,
    ratings: { 101: neutral(), 102: neutral(), 103: neutral(), 104: neutral() },
  };

  // 20 fixture pairings (matchId, homeId, awayId, optional tweaks)
  const fixtures = [
    // ── Standard pairs ────────────────────────────────────────────────────
    { matchId: 'pl-001', home: 101, away: 102 },
    { matchId: 'pl-002', home: 102, away: 101 },
    { matchId: 'pl-003', home: 103, away: 104 },
    { matchId: 'pl-004', home: 104, away: 103 },
    { matchId: 'pl-005', home: 101, away: 103 },
    { matchId: 'pl-006', home: 101, away: 104 },
    { matchId: 'pl-007', home: 104, away: 101 },
    { matchId: 'pl-008', home: 102, away: 103 },
    { matchId: 'pl-009', home: 103, away: 102 },
    { matchId: 'pl-010', home: 102, away: 104 },
    // ── Same pairs with market odds supplied ──────────────────────────────
    { matchId: 'pl-011', home: 101, away: 102, marketOdds: { home: 2.10, draw: 3.40, away: 3.20 } },
    { matchId: 'pl-012', home: 104, away: 101, marketOdds: { home: 1.80, draw: 3.60, away: 4.20 } },
    { matchId: 'pl-013', home: 103, away: 104, marketOdds: { home: 4.00, draw: 3.50, away: 1.90 } },
    // ── With rest-day fatigue ─────────────────────────────────────────────
    { matchId: 'pl-014', home: 101, away: 102, homeRestDays: 3, awayRestDays: 7 },
    { matchId: 'pl-015', home: 102, away: 103, homeRestDays: 7, awayRestDays: 2 },
    // ── With injury counts ────────────────────────────────────────────────
    { matchId: 'pl-016', home: 104, away: 101, homeInjuries: 2, awayInjuries: 0 },
    { matchId: 'pl-017', home: 101, away: 104, homeInjuries: 0, awayInjuries: 3 },
    // ── With H2H data ─────────────────────────────────────────────────────
    {
      matchId: 'pl-018', home: 101, away: 104,
      h2hData: [
        { homeGoals: 1, awayGoals: 2 },
        { homeGoals: 0, awayGoals: 1 },
        { homeGoals: 2, awayGoals: 2 },
      ],
    },
    // ── With xG data supplied ─────────────────────────────────────────────
    {
      matchId: 'pl-019', home: 101, away: 102,
      xGData: {
        101: { homeXG: 1.8, awayXG: 1.4, seasonXG: 1.6, homeXGA: 0.9, awayXGA: 1.2, seasonXGA: 1.05 },
        102: { homeXG: 1.2, awayXG: 1.0, seasonXG: 1.1, homeXGA: 1.3, awayXGA: 1.5, seasonXGA: 1.40 },
      },
    },
    // ── Combined modifiers ────────────────────────────────────────────────
    {
      matchId: 'pl-020', home: 103, away: 104,
      homeRestDays: 4,
      awayRestDays: 7,
      homeInjuries: 1,
      marketOdds: { home: 3.80, draw: 3.50, away: 2.00 },
      xGData: {
        103: { homeXG: 1.5, awayXG: 1.3, seasonXG: 1.4, homeXGA: 1.4, awayXGA: 1.6, seasonXGA: 1.50 },
        104: { homeXG: 2.2, awayXG: 1.9, seasonXG: 2.05, homeXGA: 0.7, awayXGA: 0.9, seasonXGA: 0.80 },
      },
    },
  ];

  return fixtures.map(({ matchId, home, away, marketOdds, homeRestDays, awayRestDays,
                          homeInjuries, awayInjuries, h2hData, xGData }) => {
    const hName = teamName(home);
    const aName = teamName(away);

    const result = predict({
      homeTeam:         { id: home, name: hName },
      awayTeam:         { id: away, name: aName },
      leagueAvgHome:    leagueAvg.home,
      leagueAvgAway:    leagueAvg.away,
      formData:         plForm,
      xGData:           xGData ?? {},
      h2hData:          h2hData ?? [],
      homeInjuries:     homeInjuries ?? 0,
      awayInjuries:     awayInjuries ?? 0,
      rollingRatings,
      eloRatings,
      homeRestDays:     homeRestDays ?? null,
      awayRestDays:     awayRestDays ?? null,
      marketOdds:       marketOdds ?? null,
      teamHomeAdvFactor: 1.0,
    });

    return {
      matchId,
      homeTeam:          hName,
      awayTeam:          aName,
      winProbHome:       round6(result.homeWin),
      winProbDraw:       round6(result.draw),
      winProbAway:       round6(result.awayWin),
      expectedGoalsHome: round6(result.lambdas.home),
      expectedGoalsAway: round6(result.lambdas.away),
      eloHome:           round2(eloRatings[String(home)] ?? 1500),
      eloAway:           round2(eloRatings[String(away)] ?? 1500),
    };
  });
}

// ─── Section 4: FD form snapshots ────────────────────────────────────────────

/**
 * 20 form-stat entries built via FD_ACCESSORS.
 * Each entry is a { teamId, teamName, ...formFields } object.
 * We generate 5 entries per team (4 teams × 5 stat fields shown as separate records).
 *
 * This deliberately covers all four teams' full form output so a future change
 * to any accessor path will immediately surface here.
 */
function buildFDSnapshots(fdForm, fdAvg) {
  const entries = [];
  const teams   = [101, 102, 103, 104];
  const STAT_KEYS = [
    'homeScored', 'homeConceded', 'homeGames',
    'awayScored', 'awayConceded', 'awayGames',
    'seasonHomeScored', 'seasonHomeConceded', 'seasonHomeGames',
    'seasonAwayScored', 'seasonAwayConceded', 'seasonAwayGames',
    'seasonScored', 'seasonConceded', 'seasonGames',
    'scored', 'conceded',
  ];

  // One snapshot record per team (all stat keys inline, 4 teams = 4 entries)
  for (const id of teams) {
    const f = fdForm[id];
    const record = { snapshotId: `fd-team-${id}`, teamId: id, teamName: teamName(id) };
    for (const k of STAT_KEYS) record[k] = round6(f[k]);
    entries.push(record);
  }

  // 16 additional entries covering calcMatchAverages at various fixture counts
  // (test the averages function with progressively larger subsets of the data)
  const fdFixtures = makeFDFixtures();
  for (let i = 4; i <= 20; i += 1) {  // subsets of size 4..20 → 17 entries, we take 16
    if (entries.length >= 20) break;
    const sub = fdFixtures.slice(0, i);
    const avg = calcMatchAverages(sub, FD_ACCESSORS);
    entries.push({
      snapshotId:      `fd-avg-n${String(i).padStart(2, '0')}`,
      fixtureCount:    i,
      leagueAvgHome:   round6(avg.home),
      leagueAvgAway:   round6(avg.away),
    });
  }

  return entries;
}

// ─── Section 5: WC ELO snapshots ─────────────────────────────────────────────

function buildWCSnapshots() {
  const results = calculateEloRatings({
    matches: makeWCFixtures(),
    mode:    'worldcup',
    worldcupOpts: {
      kFactorFn:        wcKFactor,
      priorEloFn:       wcPriorElo,
      confederationCtx: {
        getConfed:              wcGetConfed,
        crossConfedIntraWeight: 0.87,
        alphaParams:            { divisor: 25, min: 0.15, cap: 0.85 },
      },
      startDate: '2022-01-01',
    },
  });

  // 20 team-specific ELO snapshots (all 10 teams appear twice in the list with different
  // orderings, demonstrating key tier relationships hold after blending)
  const order1 = ['Argentina', 'Brazil', 'France', 'England', 'Germany',
                   'Spain', 'Portugal', 'Morocco', 'Japan', 'Costa Rica'];
  const order2 = ['France', 'Argentina', 'Germany', 'Spain', 'England',
                   'Brazil', 'Japan', 'Portugal', 'Morocco', 'Costa Rica'];

  return [...order1, ...order2].map((team, i) => ({
    snapshotId: `wc-${String(i + 1).padStart(2, '0')}`,
    team,
    elo:        round2(results[team] ?? wcPriorElo(team)),
  }));
}

// ─── Snapshot I/O ─────────────────────────────────────────────────────────────

function loadSnapshots() {
  if (!fs.existsSync(SNAPSHOT_PATH)) return null;
  return JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
}

function saveSnapshots(data) {
  fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(data, null, 2), 'utf8');
  console.log(`\nSnapshots written → ${SNAPSHOT_PATH}`);
}

// ─── Snapshot comparison ──────────────────────────────────────────────────────

function compareSnapshots(label, current, saved, numericKeys) {
  section(`Snapshot comparison — ${label}`);

  if (!saved) {
    console.log('  No saved snapshots found — run with --update to create them.');
    return;
  }

  if (current.length !== saved.length) {
    assert(`${label} count`, false,
      `expected ${saved.length} entries, got ${current.length}`);
    return;
  }

  for (let i = 0; i < current.length; i++) {
    const c = current[i];
    const s = saved[i];
    const id = c.snapshotId ?? c.matchId ?? `[${i}]`;

    // Structural keys (matchId, team names) must match exactly
    const strKeys = Object.keys(s).filter(k => !numericKeys.includes(k));
    for (const k of strKeys) {
      assert(`${id}.${k} matches`, c[k] === s[k],
        `expected "${s[k]}", got "${c[k]}"`);
    }

    // Numeric keys must match within tolerance
    for (const k of numericKeys) {
      if (!(k in s)) continue;
      assert(`${id}.${k} stable`, Math.abs(c[k] - s[k]) <= 1e-6,
        `expected ${s[k]}, got ${c[k]} (drift ${Math.abs(c[k] - s[k]).toExponential(3)})`);
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const round6 = v => Math.round(v * 1e6) / 1e6;
const round2 = v => Math.round(v * 100) / 100;

// ─── Monotonicity / sanity checks ─────────────────────────────────────────────

function runSanityChecks(plSnapshots, wcSnapshots) {
  section('Sanity checks — PL predict() outputs');

  for (const s of plSnapshots) {
    const sum = s.winProbHome + s.winProbDraw + s.winProbAway;
    assert(`${s.matchId} probs sum to ~1`, Math.abs(sum - 1) < 0.001,
      `sum=${sum}`);
    assert(`${s.matchId} all probs ≥ 0`,
      s.winProbHome >= 0 && s.winProbDraw >= 0 && s.winProbAway >= 0);
    assert(`${s.matchId} all probs ≤ 1`,
      s.winProbHome <= 1 && s.winProbDraw <= 1 && s.winProbAway <= 1);
    assert(`${s.matchId} xG home > 0`, s.expectedGoalsHome > 0);
    assert(`${s.matchId} xG away > 0`, s.expectedGoalsAway > 0);
    assert(`${s.matchId} xG capped`, s.expectedGoalsHome <= 2.6 && s.expectedGoalsAway <= 2.6,
      `home=${s.expectedGoalsHome} away=${s.expectedGoalsAway}`);
  }

  // Home-field advantage: when inputs are identical except venue (pl-001 vs pl-002),
  // the home side should win more often than the away side.
  const pl001 = plSnapshots.find(s => s.matchId === 'pl-001');
  const pl002 = plSnapshots.find(s => s.matchId === 'pl-002');
  if (pl001 && pl002) {
    // pl-001: Arsenal (home) vs Chelsea (away) → arsenal should have higher win prob
    // pl-002: Chelsea (home) vs Arsenal (away) → Chelsea should now have higher win prob
    assert('home advantage reversal: pl-001 homeWin > awayWin',
      pl001.winProbHome > pl001.winProbAway);
    assert('home advantage reversal: pl-002 homeWin > awayWin',
      pl002.winProbHome > pl002.winProbAway);
  }

  section('Sanity checks — WC ELO outputs');

  // ELO bounds
  for (const s of wcSnapshots) {
    assert(`${s.team} ELO > 1300`, s.elo > 1300, `elo=${s.elo}`);
    assert(`${s.team} ELO < 2100`, s.elo < 2100, `elo=${s.elo}`);
  }

  // Tier ordering: top teams should beat lower-tier teams
  const getElo = team => wcSnapshots.find(s => s.team === team && s.snapshotId.startsWith('wc-0'))?.elo;
  const argElo     = getElo('Argentina');
  const morElo     = getElo('Morocco');
  const crElo      = getElo('Costa Rica');
  if (argElo && crElo) {
    assert('Argentina ELO > Costa Rica ELO', argElo > crElo,
      `Argentina=${argElo} Costa Rica=${crElo}`);
  }
  if (morElo && crElo) {
    assert('Morocco ELO > Costa Rica ELO', morElo > crElo,
      `Morocco=${morElo} Costa Rica=${crElo}`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main() {
  console.log('┌─────────────────────────────────────────────────────────────┐');
  console.log('│        Football Analytics — Regression Test Suite           │');
  console.log(`│  mode: ${UPDATE_MODE ? 'UPDATE (rebuild snapshots)               ' : 'COMPARE (assert against saved)         '}│`);
  console.log('└─────────────────────────────────────────────────────────────┘');

  // 1. Unit tests — no snapshots
  runMathUnitTests();

  // 2. Cross-pipeline consistency — no snapshots
  const { plAvg, plForm, eloFromCore } = runCrossPipelineTests();

  // 3. Build current outputs for all three pipelines
  const fdFixtures  = makeFDFixtures();
  const fdForm      = buildFormStats(fdFixtures, [101, 102, 103, 104], FD_ACCESSORS, [0.30, 0.24, 0.20, 0.16, 0.10]);
  const fdAvg       = calcMatchAverages(fdFixtures, FD_ACCESSORS);

  section('Building pipeline outputs');
  console.log('  PL predict()   — 20 fixtures');
  const plSnapshots = buildPLSnapshots(plForm, eloFromCore, plAvg);
  console.log('  FD form/avg    — 20 entries');
  const fdSnapshots = buildFDSnapshots(fdForm, fdAvg);
  console.log('  WC ELO         — 20 team snapshots');
  const wcSnapshots = buildWCSnapshots();

  // 4. Sanity / monotonicity checks (always run)
  runSanityChecks(plSnapshots, wcSnapshots);

  // 5. Snapshot compare or update
  const current = { pl: plSnapshots, fd: fdSnapshots, wc: wcSnapshots };

  if (UPDATE_MODE) {
    saveSnapshots(current);
    console.log('\nSnapshot update complete — re-run without --update to verify.');
  } else {
    const saved = loadSnapshots();

    const plNumKeys = ['winProbHome', 'winProbDraw', 'winProbAway',
                       'expectedGoalsHome', 'expectedGoalsAway', 'eloHome', 'eloAway'];
    const fdNumKeys = [
      'homeScored', 'homeConceded', 'homeGames',
      'awayScored', 'awayConceded', 'awayGames',
      'seasonHomeScored', 'seasonHomeConceded', 'seasonHomeGames',
      'seasonAwayScored', 'seasonAwayConceded', 'seasonAwayGames',
      'seasonScored', 'seasonConceded', 'seasonGames',
      'scored', 'conceded', 'leagueAvgHome', 'leagueAvgAway',
    ];
    const wcNumKeys = ['elo'];

    compareSnapshots('PL predict()', plSnapshots, saved?.pl, plNumKeys);
    compareSnapshots('FD form/avg',  fdSnapshots, saved?.fd, fdNumKeys);
    compareSnapshots('WC ELO',       wcSnapshots, saved?.wc, wcNumKeys);
  }

  // ─── Summary ──────────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(64));
  const total = passed + failed;
  if (failed === 0) {
    console.log(`  ✓  All ${total} assertions passed.`);
  } else {
    console.log(`  ✗  ${failed} / ${total} assertions FAILED:\n`);
    for (const f of failures) console.log(f);
  }
  console.log('═'.repeat(64) + '\n');

  process.exit(failed > 0 ? 1 : 0);
}

main();
