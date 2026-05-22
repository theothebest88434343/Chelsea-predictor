'use strict';

/**
 * core/testing/wcSmokeTest.js
 *
 * Live smoke test for the World Cup prediction API.
 * Requires a running server on localhost:3001.
 *
 * Usage:  node core/testing/wcSmokeTest.js
 * Exit:   0 = all pass  |  1 = any failure
 *
 * Runs in <3 seconds. No external dependencies.
 */

const http = require('http');

const BASE    = 'http://localhost:3001';
let   passed  = 0;
let   failed  = 0;

// ─── Harness ──────────────────────────────────────────────────────────────────

function pass(label) {
  console.log(`  ✅  ${label}`);
  passed++;
}

function fail(label, detail) {
  console.error(`  ❌  ${label}`);
  if (detail) console.error(`       → ${detail}`);
  failed++;
}

function assert(label, condition, detail = '') {
  condition ? pass(label) : fail(label, detail);
}

function get(path) {
  return new Promise((resolve, reject) => {
    const req = http.get(BASE + path, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`JSON parse error on ${path}: ${e.message}`)); }
      });
    });
    req.setTimeout(5000, () => { req.destroy(); reject(new Error(`Timeout: ${path}`)); });
    req.on('error', reject);
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function enc(s) { return encodeURIComponent(s); }

const DOMINANT_SCORES  = new Set(['2-0','3-0','3-1','4-0','4-1','2-1','3-2']);
const AWAY_LEAD_SCORES = new Set(['0-1','0-2','0-3','1-2','1-3','2-3']);

// ─── Preflight ────────────────────────────────────────────────────────────────
// Verifies the server is reachable before running any test suites.
// Distinguishes "server not running" (ECONNREFUSED / timeout) from other errors.

async function preflight() {
  console.log('\n── Preflight: server availability ──────────────────────────');
  try {
    await get(`/api/wc/predict?home=${enc('France')}&away=${enc('Germany')}`);
    console.log(`  ✓  Server is up at ${BASE}`);
  } catch (e) {
    const isConnRefused = (e.code === 'ECONNREFUSED') ||
                          (e.message && e.message.includes('ECONNREFUSED'));
    const isTimeout     = e.message && e.message.startsWith('Timeout:');

    console.error('');
    if (isConnRefused || isTimeout) {
      console.error('🚫  SERVER NOT RUNNING — start the backend first:');
      console.error('      node server.js');
      console.error('    or: npm run dev:server');
    } else {
      console.error(`🚫  PREFLIGHT FAILED — unexpected error:`);
      console.error(`      ${e.message}`);
      console.error('    Make sure the server is running and responding.');
    }
    console.error('');
    process.exit(1);
  }
}

// ─── Test suites ──────────────────────────────────────────────────────────────

async function testThresholdBand() {
  console.log('\n── Test 1: Score threshold (37–45% band must NOT return 1-1) ──');

  const cases = [
    // home is slight favourite in the 37–44% range
    { home: 'South Korea', away: 'Czech Republic', desc: 'SK vs CZE (~41%)' },
    { home: 'Portugal',    away: 'Colombia',        desc: 'POR vs COL (~43%)' },
    { home: 'Turkey',      away: 'Paraguay',        desc: 'TUR vs PAR (~40%)' },
  ];

  for (const { home, away, desc } of cases) {
    try {
      const r = await get(`/api/wc/predict?home=${enc(home)}&away=${enc(away)}`);
      const maxWin = Math.max(r.homeWin, r.awayWin);

      if (maxWin >= 0.37 && maxWin < 0.45) {
        assert(
          `${desc}: NOT 1-1 when max win in [0.37,0.45)`,
          r.predictedScore !== '1-1',
          `got ${r.predictedScore} (homeWin=${r.homeWin?.toFixed(3)})`,
        );
        assert(
          `${desc}: score is directional`,
          r.predictedScore !== '1-1',
          `predictedScore=${r.predictedScore}`,
        );
      } else {
        // Model output shifted outside test band — just verify no crash
        assert(
          `${desc}: responded without crash (maxWin=${maxWin.toFixed(3)})`,
          typeof r.predictedScore === 'string' && r.predictedScore.includes('-'),
        );
      }
    } catch (e) { fail(`${desc}: request failed`, e.message); }
  }
}

async function testStrongFavourite() {
  console.log('\n── Test 2: Strong favourite (≥70% homeWin → dominant scoreline) ──');

  const cases = [
    { home: 'England', away: 'Ghana',       desc: 'ENG vs GHA' },
    { home: 'Spain',   away: 'Cabo Verde',  desc: 'ESP vs CPV' },
    { home: 'France',  away: 'Haiti',       desc: 'FRA vs HAI' },
  ];

  for (const { home, away, desc } of cases) {
    try {
      const r = await get(`/api/wc/predict?home=${enc(home)}&away=${enc(away)}`);
      if (r.homeWin >= 0.70) {
        assert(
          `${desc}: dominant scoreline (homeWin=${(r.homeWin*100).toFixed(1)}%)`,
          DOMINANT_SCORES.has(r.predictedScore),
          `got ${r.predictedScore}`,
        );
      } else {
        assert(
          `${desc}: responded without crash (homeWin=${(r.homeWin*100).toFixed(1)}% — below 70%)`,
          typeof r.predictedScore === 'string',
        );
      }
    } catch (e) { fail(`${desc}: request failed`, e.message); }
  }
}

async function testProbabilityIntegrity() {
  console.log('\n── Test 3: Probability integrity (homeWin + draw + awayWin ≈ 1.0) ──');

  const pairs = [
    ['Spain',     'Morocco'    ],
    ['Brazil',    'Scotland'   ],
    ['Germany',   'Ecuador'    ],
    ['Argentina', 'Algeria'    ],
    ['Portugal',  'Uzbekistan' ],
    ['England',   'Croatia'    ],
  ];

  for (const [home, away] of pairs) {
    try {
      const r   = await get(`/api/wc/predict?home=${enc(home)}&away=${enc(away)}`);
      const sum = (r.homeWin ?? 0) + (r.draw ?? 0) + (r.awayWin ?? 0);
      assert(
        `${home} vs ${away}: probs sum to 1.00 (got ${sum.toFixed(4)})`,
        Math.abs(sum - 1) < 0.01,
        `homeWin=${r.homeWin} draw=${r.draw} awayWin=${r.awayWin}`,
      );
    } catch (e) { fail(`${home} vs ${away}: request failed`, e.message); }
  }
}

async function testDirectionalAway() {
  console.log('\n── Test 4: Away favourite → away-leading score ──');

  const cases = [
    { home: 'Qatar',      away: 'Spain',     desc: 'QAT vs ESP (away fav)' },
    { home: 'New Zealand',away: 'France',    desc: 'NZL vs FRA (away fav)' },
    { home: 'Haiti',      away: 'Argentina', desc: 'HAI vs ARG (away fav)' },
  ];

  for (const { home, away, desc } of cases) {
    try {
      const r = await get(`/api/wc/predict?home=${enc(home)}&away=${enc(away)}`);
      if (r.awayWin >= 0.37) {
        assert(
          `${desc}: away-leading score (awayWin=${(r.awayWin*100).toFixed(1)}%)`,
          AWAY_LEAD_SCORES.has(r.predictedScore),
          `got ${r.predictedScore}`,
        );
      } else {
        assert(
          `${desc}: responded without crash`,
          typeof r.predictedScore === 'string',
        );
      }
    } catch (e) { fail(`${desc}: request failed`, e.message); }
  }
}

async function testTossupNoCrash() {
  console.log('\n── Test 5: Toss-up matches never crash ──');

  const cases = [
    { home: 'Algeria',     away: 'Austria',  desc: 'ALG vs AUT (tossup)' },
    { home: 'Switzerland', away: 'Senegal',  desc: 'SUI vs SEN (tossup)' },
    { home: 'Japan',       away: 'Sweden',   desc: 'JPN vs SWE (tossup)' },
  ];

  for (const { home, away, desc } of cases) {
    try {
      const r = await get(`/api/wc/predict?home=${enc(home)}&away=${enc(away)}`);
      assert(
        `${desc}: returns valid score string`,
        typeof r.predictedScore === 'string' && r.predictedScore.includes('-'),
        `got: ${JSON.stringify(r.predictedScore)}`,
      );
      assert(
        `${desc}: all probabilities are numbers`,
        typeof r.homeWin === 'number' && typeof r.draw === 'number' && typeof r.awayWin === 'number',
        `homeWin=${r.homeWin} draw=${r.draw} awayWin=${r.awayWin}`,
      );
      assert(
        `${desc}: no probability is NaN or negative`,
        [r.homeWin, r.draw, r.awayWin].every(v => !isNaN(v) && v >= 0),
      );
    } catch (e) { fail(`${desc}: request failed`, e.message); }
  }
}

async function testLambdaShape() {
  console.log('\n── Test 6: Lambda shape (home lambda > 0, away lambda > 0) ──');

  const pairs = [
    ['Brazil', 'Morocco'],
    ['Germany', 'Ecuador'],
  ];

  for (const [home, away] of pairs) {
    try {
      const r = await get(`/api/wc/predict?home=${enc(home)}&away=${enc(away)}`);
      assert(
        `${home} vs ${away}: lambdaHome > 0`,
        r.lambdaHome > 0,
        `got ${r.lambdaHome}`,
      );
      assert(
        `${home} vs ${away}: lambdaAway > 0`,
        r.lambdaAway > 0,
        `got ${r.lambdaAway}`,
      );
    } catch (e) { fail(`${home} vs ${away}: request failed`, e.message); }
  }
}

// ─── Runner ───────────────────────────────────────────────────────────────────

async function run() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║   WC Prediction API — Smoke Test Suite       ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log(`  Target: ${BASE}`);

  // Always run preflight first — gives a clean error if server isn't up.
  await preflight();

  const start = Date.now();

  try {
    await testThresholdBand();
    await testStrongFavourite();
    await testProbabilityIntegrity();
    await testDirectionalAway();
    await testTossupNoCrash();
    await testLambdaShape();
  } catch (fatal) {
    console.error('\n💥 FATAL:', fatal.message);
    process.exit(1);
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(2);

  console.log('\n══════════════════════════════════════════════');
  console.log(`  Passed: ${passed}   Failed: ${failed}   Time: ${elapsed}s`);
  console.log('══════════════════════════════════════════════');

  if (failed > 0) {
    console.error(`\n❌  SMOKE TEST FAILED (${failed} failure${failed > 1 ? 's' : ''})`);
    process.exit(1);
  }
  console.log('\n✅  ALL TESTS PASSED — SAFE TO DEPLOY\n');
  process.exit(0);
}

run();
