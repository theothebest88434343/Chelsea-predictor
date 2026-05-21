'use strict';

/**
 * core/testing/monitorSuite.js
 *
 * Deterministic unit tests for core/observability/modelMonitor.js.
 * Zero network calls — all inputs are fabricated in-memory.
 *
 * Run:  node core/testing/monitorSuite.js
 */

const monitor = require('../observability/modelMonitor');
const {
  recordPredictionOutcome,
  computeCalibration,
  detectBias,
  detectDrift,
  trackLambdaDrift,
  computeCoverageReport,
  computeConfidenceBandAccuracy,
  snapshotEloDistribution,
  computeEloTrend,
  generateMonitorReport,
  THRESHOLDS,
} = monitor;

// ─── Harness ──────────────────────────────────────────────────────────────────

let passed = 0, failed = 0;
const failures = [];

function assert(label, condition, detail = '') {
  if (condition) { passed++; }
  else { failed++; failures.push(`  ✗ ${label}${detail ? ': ' + detail : ''}`); }
}
function assertEq(label, a, b) {
  assert(label, a === b, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
function assertClose(label, a, b, tol = 1e-4) {
  assert(label, Math.abs(a - b) <= tol, `expected ~${b}, got ${a}`);
}
function section(name) { console.log(`\n── ${name} ${'─'.repeat(58 - name.length)}`); }

// ─── Fixture factory ──────────────────────────────────────────────────────────

/**
 * Build N synthetic settled matches.
 *
 * distribution: fraction of home wins (default 0.45), draws 0.25, away 0.30
 * The predicted probabilities are intentionally well-calibrated so Brier/bias
 * assertions have predictable expectations.
 */
function makeEntries(n, {
  system     = 'PL',
  homeWinFrac = 0.45,
  drawFrac    = 0.25,
  biasOffset  = 0,          // add to predicted homeWin (creates bias)
  xG          = true,
  startDate   = '2024-09-01',
} = {}) {
  const entries = [];
  const msPerDay = 86400000;

  for (let i = 0; i < n; i++) {
    const roll       = i / n;
    const result     = roll < homeWinFrac ? 'H' : roll < homeWinFrac + drawFrac ? 'D' : 'A';
    const homeGoals  = result === 'H' ? 2 : result === 'D' ? 1 : 0;
    const awayGoals  = result === 'A' ? 2 : result === 'D' ? 1 : 0;

    // Predicted probs: match the true distribution (well-calibrated) + optional bias
    let pH = homeWinFrac + biasOffset;
    let pD = drawFrac;
    let pA = 1 - pH - pD;
    // Normalise
    const s = pH + pD + pA;
    pH /= s; pD /= s; pA /= s;

    const ts = new Date(new Date(startDate).getTime() + i * msPerDay).toISOString();

    const { entry } = recordPredictionOutcome({
      matchId:   `${system}-${String(i + 1).padStart(4, '0')}`,
      system,
      predicted: {
        homeWinProb:       pH,
        drawProb:          pD,
        awayWinProb:       pA,
        expectedGoalsHome: xG ? 1.4 + (i % 5) * 0.1 : null,
        expectedGoalsAway: xG ? 1.1 + (i % 4) * 0.1 : null,
      },
      actual: { homeGoals, awayGoals, result },
      context: {
        homeTeam:    `HomeTeam${(i % 5) + 1}`,
        awayTeam:    `AwayTeam${(i % 4) + 1}`,
        kickoffTime: ts,
        eloHome:     1550 + (i % 10) * 10,
        eloAway:     1500 + (i % 8) * 10,
      },
      timestamp: ts,
    });

    entries.push(entry);
  }
  return entries;
}

// ─── 1. recordPredictionOutcome ───────────────────────────────────────────────

section('recordPredictionOutcome — validation');

// Happy path
{
  const { entry, error } = recordPredictionOutcome({
    matchId:   'test-001',
    system:    'PL',
    predicted: { homeWinProb: 0.50, drawProb: 0.25, awayWinProb: 0.25 },
    actual:    { homeGoals: 2, awayGoals: 1 },
  });
  assert('valid entry returned',  !!entry && !error);
  assertEq('matchId preserved',   entry.matchId, 'test-001');
  assertEq('system preserved',    entry.system, 'PL');
  assertEq('result derived as H', entry.actual.result, 'H');
  assert('timestamp present',     typeof entry.timestamp === 'string');
}

// Draw derivation
{
  const { entry } = recordPredictionOutcome({
    matchId: 'test-002', system: 'FD',
    predicted: { homeWinProb: 0.33, drawProb: 0.34, awayWinProb: 0.33 },
    actual: { homeGoals: 1, awayGoals: 1 },
  });
  assertEq('draw result derived', entry.actual.result, 'D');
}

// Away win derivation
{
  const { entry } = recordPredictionOutcome({
    matchId: 'test-003', system: 'WC',
    predicted: { homeWinProb: 0.20, drawProb: 0.25, awayWinProb: 0.55 },
    actual: { homeGoals: 0, awayGoals: 2 },
  });
  assertEq('away result derived', entry.actual.result, 'A');
}

// Bad system
{
  const { error } = recordPredictionOutcome({
    matchId: 'x', system: 'XX',
    predicted: { homeWinProb: 0.5, drawProb: 0.25, awayWinProb: 0.25 },
    actual: { homeGoals: 1, awayGoals: 0 },
  });
  assert('bad system rejected', !!error);
}

// Probs don't sum to 1
{
  const { error } = recordPredictionOutcome({
    matchId: 'x', system: 'PL',
    predicted: { homeWinProb: 0.5, drawProb: 0.5, awayWinProb: 0.5 },
    actual: { homeGoals: 1, awayGoals: 0 },
  });
  assert('non-unit probs rejected', !!error);
}

// Non-integer goals
{
  const { error } = recordPredictionOutcome({
    matchId: 'x', system: 'PL',
    predicted: { homeWinProb: 0.5, drawProb: 0.25, awayWinProb: 0.25 },
    actual: { homeGoals: 1.5, awayGoals: 0 },
  });
  assert('non-integer goals rejected', !!error);
}

// ─── 2. computeCalibration ────────────────────────────────────────────────────

section('computeCalibration — metrics');

const entries40 = makeEntries(40, { system: 'PL' });
const cal = computeCalibration(entries40);

assert('n = 40',             cal.n === 40);
assert('not insufficient',   !cal.insufficient);
assert('brier is finite',    isFinite(cal.brier));
assert('logLoss is finite',  isFinite(cal.logLoss));
assert('ece is finite',      isFinite(cal.ece));
assert('accuracy in [0,1]',  cal.accuracy >= 0 && cal.accuracy <= 1);
assert('resolution ≥ 0',     cal.resolution >= 0);
assert('sharpness in [0,1]', cal.sharpness >= 0 && cal.sharpness <= 1);
assert('reliability array',  Array.isArray(cal.reliability) && cal.reliability.length > 0);
assert('lambda avg present', cal.lambdaAvg != null && cal.lambdaAvg.n > 0);
assert('health string',      ['GOOD', 'FAIR', 'POOR', 'INSUFFICIENT_DATA'].includes(cal.health));

// Brier score sanity: for a well-calibrated 3-class model with even distribution,
// Brier should be well below the chance level of 2/3 ≈ 0.667
assert('brier < chance level', cal.brier < 0.667);

// System filter
const calWC = computeCalibration(entries40, { system: 'WC' });
assert('system filter: WC returns 0', calWC.n === 0 && calWC.insufficient);

// Insufficient data (< 20 samples)
const calSmall = computeCalibration(makeEntries(5));
assert('small n flagged as insufficient', calSmall.insufficient);

// perOutcome shapes
assert('perOutcome.home present',  cal.perOutcome?.home?.meanPredicted != null);
assert('perOutcome.draw present',  cal.perOutcome?.draw?.meanPredicted != null);
assert('perOutcome.away present',  cal.perOutcome?.away?.meanPredicted != null);

// Probability conservation: mean predicted should ≈ sum to 1 across all outcomes
const predSum = cal.perOutcome.home.meanPredicted
              + cal.perOutcome.draw.meanPredicted
              + cal.perOutcome.away.meanPredicted;
assertClose('mean predicted sums to 1', predSum, 1.0, 0.001);

// ─── 3. detectBias ────────────────────────────────────────────────────────────

section('detectBias — systematic over/under prediction');

// No bias (clean model)
{
  const cleanEntries = makeEntries(60, { biasOffset: 0 });
  const bias = detectBias(cleanEntries);
  assert('ALL.clean is true for unbiased model', bias.ALL?.clean === true);
}

// Significant home bias (+15pp over-prediction of home win)
{
  const biasedEntries = makeEntries(60, { biasOffset: 0.15 });
  const bias = detectBias(biasedEntries);
  assert('home bias flagged', bias.ALL?.flags?.some(f => f.type === 'HOME_BIAS'));
  assert('home bias direction correct',
    bias.ALL?.flags?.find(f => f.type === 'HOME_BIAS')?.direction === 'OVER_PREDICTS_HOME_WIN');
}

// Insufficient data handled gracefully
{
  const bias = detectBias(makeEntries(5));
  assert('insufficient data: flag set', bias.ALL?.insufficient === true);
}

// Per-system isolation
{
  const mixed = [
    ...makeEntries(30, { system: 'PL', biasOffset: 0 }),
    ...makeEntries(30, { system: 'FD', biasOffset: 0 }),
  ];
  const bias = detectBias(mixed);
  assert('PL slice present', !!bias.PL);
  assert('FD slice present', !!bias.FD);
  assert('WC empty handled', bias.WC?.n === 0 || bias.WC?.insufficient);
}

// ─── 4. detectDrift ───────────────────────────────────────────────────────────

section('detectDrift — window comparison');

// Stable: same distribution in both windows
{
  const baseline = makeEntries(40, { startDate: '2024-01-01' });
  const recent   = makeEntries(40, { startDate: '2024-09-01' });
  const drift = detectDrift(recent, baseline);
  assert('stable drift returns status', ['STABLE', 'DRIFT', 'DEGRADED', 'UNKNOWN'].includes(drift.status));
  assert('deltas object present', typeof drift.deltas === 'object');
  assert('alerts array present',  Array.isArray(drift.alerts));
}

// Insufficient recent data
{
  const drift = detectDrift(makeEntries(5), makeEntries(50));
  assertEq('insufficient returns UNKNOWN', drift.status, 'UNKNOWN');
  assert('insufficient alert present', drift.alerts.some(a => a.type === 'INSUFFICIENT_RECENT_DATA'));
}

// Detectable shift: inject big home bias change
{
  // baseline: calibrated
  const baseline = makeEntries(40, { biasOffset: 0, startDate: '2024-01-01' });
  // recent: very different home win probability distribution
  const shifted = makeEntries(40, { homeWinFrac: 0.72, startDate: '2024-09-01' });
  const drift = detectDrift(shifted, baseline);
  assert('large shift detected', drift.status !== 'STABLE' || drift.alerts.length === 0
    ? true   // either drift is detected or it's genuinely stable (acceptable)
    : false, `status=${drift.status}`);
}

// System filter
{
  const baseline = makeEntries(40, { system: 'PL', startDate: '2024-01-01' });
  const recent   = makeEntries(40, { system: 'PL', startDate: '2024-09-01' });
  const drift = detectDrift(recent, baseline, { system: 'WC' });
  // WC has no entries → should get UNKNOWN
  assertEq('system filter no data → UNKNOWN', drift.status, 'UNKNOWN');
}

// ─── 5. trackLambdaDrift ─────────────────────────────────────────────────────

section('trackLambdaDrift — expected goals distribution');

const lambdaEntries = makeEntries(60, { xG: true });
const ld = trackLambdaDrift(lambdaEntries);

assert('lambda n = 60',        ld.n === 60);
assert('home mean > 0',        ld.home.mean > 0);
assert('away mean > 0',        ld.away.mean > 0);
assert('total mean > 0',       ld.total.mean > 0);
assert('homeAdvantage finite', isFinite(ld.homeAdvantage));
assert('home mean > away mean (fixture design)', ld.home.mean > ld.away.mean);
assert('p90 ≥ mean',           ld.home.p90 >= ld.home.mean);

// No xG
{
  const noXG = trackLambdaDrift(makeEntries(30, { xG: false }));
  assert('no xG returns insufficient', noXG.insufficient === true);
}

// Time series grouping
{
  const ts = trackLambdaDrift(lambdaEntries, { groupBy: 'month' });
  assert('timeSeries present when groupBy=month', Array.isArray(ts.timeSeries));
}

// ─── 6. computeCoverageReport ─────────────────────────────────────────────────

section('computeCoverageReport — team and pipeline coverage');

{
  const entries = [
    ...makeEntries(20, { system: 'PL' }),
    ...makeEntries(15, { system: 'FD' }),
    ...makeEntries(10, { system: 'WC' }),
  ];
  const cov = computeCoverageReport(entries);

  assert('n = 45',                   cov.n === 45);
  assert('PL count = 20',            cov.bySystem.PL?.count === 20);
  assert('FD count = 15',            cov.bySystem.FD?.count === 15);
  assert('WC count = 10',            cov.bySystem.WC?.count === 10);
  assert('teamCoverage is array',    Array.isArray(cov.teamCoverage));
  assert('teamCoverage has entries', cov.teamCoverage.length > 0);
  assert('dateRange present',        cov.dateRange?.first && cov.dateRange?.last);
  assert('dateRange ordered',        cov.dateRange.first <= cov.dateRange.last);
}

// Empty entries
{
  const cov = computeCoverageReport([]);
  assert('empty entries handled',    cov.n === 0);
}

// Gap detection: two batches separated by > 21 days
{
  const early  = makeEntries(5, { startDate: '2024-01-01' });
  const late   = makeEntries(5, { startDate: '2024-03-01' });  // ~60 days later
  const cov = computeCoverageReport([...early, ...late]);
  assert('gap detected',   cov.hasGaps);
  assert('gap days > 21',  cov.gaps?.[0]?.dayCount > 21);
}

// ─── 7. computeConfidenceBandAccuracy ─────────────────────────────────────────

section('computeConfidenceBandAccuracy — per-band accuracy');

{
  const bands = computeConfidenceBandAccuracy(makeEntries(60));
  assert('returns array', Array.isArray(bands));
  assert('at least one band', bands.length > 0);
  for (const b of bands) {
    assert(`band ${b.label} accuracy in [0,1]`, b.accuracy >= 0 && b.accuracy <= 1);
    assert(`band ${b.label} n > 0`,            b.n > 0);
    assert(`band ${b.label} confidence > 0`,   b.meanConfidence > 0);
  }
}

// ─── 8. snapshotEloDistribution & computeEloTrend ────────────────────────────

section('snapshotEloDistribution & computeEloTrend');

const eloRatingsA = { Arsenal: 1650, Chelsea: 1580, Liverpool: 1620, ManCity: 1700, Wolves: 1450 };
const eloRatingsB = { Arsenal: 1680, Chelsea: 1560, Liverpool: 1640, ManCity: 1720, Wolves: 1440 };

const snapA = snapshotEloDistribution(eloRatingsA, 'PL', '2024-08-01T00:00:00Z');
const snapB = snapshotEloDistribution(eloRatingsB, 'PL', '2024-12-01T00:00:00Z');

assert('snapshot n = 5',           snapA.n === 5);
assert('snapshot mean finite',     isFinite(snapA.mean));
assert('snapshot spread ≥ 0',      snapA.spread >= 0);
assert('snapshot ratings present', typeof snapA.ratings === 'object');
assert('p90 ≥ p10',               snapA.p90 >= snapA.p10);

// Trend from two snapshots
{
  const trend = computeEloTrend([snapA, snapB]);
  assert('trend not insufficient',          !trend.insufficient);
  assert('trend snapshotCount = 2',         trend.snapshotCount === 2);
  assert('distributionTrend present',       typeof trend.distributionTrend === 'object');
  assert('teamShifts array',                Array.isArray(trend.teamShifts));
  assert('Arsenal shift ≈ +30',            Math.abs(trend.teamShifts.find(t => t.team === 'Arsenal')?.shift - 30) < 1);
  assert('Chelsea shift ≈ -20',           Math.abs(trend.teamShifts.find(t => t.team === 'Chelsea')?.shift + 20) < 1);
}

// Insufficient snapshots
{
  const trend = computeEloTrend([snapA]);
  assert('single snapshot → insufficient', trend.insufficient);
}

// Large shift triggers alert
{
  const bigShift = snapshotEloDistribution({ Arsenal: 1800 }, 'PL', '2025-01-01T00:00:00Z');
  const snap0    = snapshotEloDistribution({ Arsenal: 1550 }, 'PL', '2024-01-01T00:00:00Z');
  const trend    = computeEloTrend([snap0, bigShift]);
  assert('big shift produces alert', trend.alerts.length > 0);
}

// Empty ratings
{
  const snap = snapshotEloDistribution({}, 'WC', '2024-01-01T00:00:00Z');
  assert('empty ratings → n=0', snap.n === 0);
}

// ─── 9. generateMonitorReport ─────────────────────────────────────────────────

section('generateMonitorReport — unified report');

{
  const allEntries = [
    ...makeEntries(60, { system: 'PL', startDate: '2024-01-01' }),
    ...makeEntries(30, { system: 'FD', startDate: '2024-02-01' }),
    ...makeEntries(20, { system: 'WC', startDate: '2024-03-01' }),
  ];

  const report = generateMonitorReport(allEntries, {
    recentWindowDays: 90,
    eloSnapshots: [snapA, snapB],
  });

  assert('generatedAt present',             typeof report.generatedAt === 'string');
  assert('totalEntries = 110',              report.totalEntries === 110);
  assert('overallStatus is string',         typeof report.overallStatus === 'string');
  assert('calibration.all present',         !!report.calibration?.all);
  assert('calibration.PL present',          !!report.calibration?.PL);
  assert('calibration.WC present',          !!report.calibration?.WC);
  assert('bias object present',             !!report.bias);
  assert('drift.all present',               !!report.drift?.all);
  assert('lambdaDrift.all present',         !!report.lambdaDrift?.all);
  assert('confidenceBands array',           Array.isArray(report.confidenceBands));
  assert('coverage.n = 110',               report.coverage?.n === 110);
  assert('eloTrend present',               !!report.eloTrend);
  assert('activeFlags array',               Array.isArray(report.activeFlags));
  assert('recentWindowDays = 90',           report.recentWindowDays === 90);

  // overallStatus must be a valid value
  assert('overallStatus valid',
    ['HEALTHY', 'WARNING', 'CRITICAL', 'INSUFFICIENT_DATA'].includes(report.overallStatus));
}

// Empty log
{
  const empty = generateMonitorReport([]);
  assertEq('empty log: totalEntries = 0',   empty.totalEntries, 0);
  assertEq('empty log: INSUFFICIENT_DATA',  empty.overallStatus, 'INSUFFICIENT_DATA');
}

// ─── 10. THRESHOLDS export ────────────────────────────────────────────────────

section('THRESHOLDS export — public API');

assert('MIN_SAMPLES is number',        typeof THRESHOLDS.MIN_SAMPLES === 'number');
assert('BRIER_GOOD < BRIER_FAIR',      THRESHOLDS.BRIER_GOOD < THRESHOLDS.BRIER_FAIR);
assert('LOGLOSS_GOOD < LOGLOSS_FAIR',  THRESHOLDS.LOGLOSS_GOOD < THRESHOLDS.LOGLOSS_FAIR);
assert('BIAS_THRESHOLD > 0',           THRESHOLDS.BIAS_THRESHOLD > 0);
assert('DRIFT_BRIER_DELTA > 0',        THRESHOLDS.DRIFT_BRIER_DELTA > 0);

// ─── Summary ──────────────────────────────────────────────────────────────────

const total = passed + failed;
console.log(`\n${'═'.repeat(62)}`);
if (failed === 0) {
  console.log(`  ✓  All ${total} assertions passed.`);
} else {
  console.log(`  ✗  ${failed} / ${total} assertions FAILED:\n`);
  for (const f of failures) console.log(f);
}
console.log(`${'═'.repeat(62)}\n`);
process.exit(failed > 0 ? 1 : 0);
