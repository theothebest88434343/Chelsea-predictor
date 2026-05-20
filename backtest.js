'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// backtest.js — Walk-forward validation of the MatchIQ prediction model
//
// For each completed match in a season, builds form / rolling ratings / ELO
// using ONLY matches played before that fixture, then runs predict() and
// compares to the actual result. No xG (historical xG snapshots unavailable),
// no market odds — pure model signal.
//
// Run: node backtest.js
// Requires the local dev server to be running on :3001 (for FD match data).
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config();
const axios = require('axios');
const {
  predict,
  buildRollingRatings,
  buildEloRatings,
  logLoss,
  brierScore,
  FORM_WEIGHTS,
} = require('./models/predictionEngine');

const BASE = 'http://localhost:3001';
const MIN_PRIOR = 5; // minimum matches played before we start predicting

// ─── Helpers (mirrors server.js exactly) ──────────────────────────────────────

function fdMatchesToFplShape(matches) {
  return matches
    .filter(m => m.finished && m.homeGoals != null)
    .map(m => ({
      team_h:       m.homeTeam.id,
      team_a:       m.awayTeam.id,
      team_h_score: m.homeGoals,
      team_a_score: m.awayGoals,
      kickoff_time: m.kickoffTime,
      finished:     true,
    }));
}

function calcFdLeagueAverages(matches) {
  const finished = matches.filter(m => m.finished && m.homeGoals != null);
  if (!finished.length) return { home: 1.52, away: 1.18 };
  const totalHome = finished.reduce((s, m) => s + m.homeGoals, 0);
  const totalAway = finished.reduce((s, m) => s + m.awayGoals, 0);
  return { home: totalHome / finished.length, away: totalAway / finished.length };
}

function buildFdFormData(matches) {
  const teamIds = new Set();
  for (const m of matches) {
    teamIds.add(m.homeTeam.id);
    teamIds.add(m.awayTeam.id);
  }

  const wavg = (games, goalsFor, goalsAgainst) => {
    if (!games.length) return { sc: 0, co: 0 };
    const ws   = FORM_WEIGHTS.slice(0, games.length);
    const wSum = ws.reduce((a, b) => a + b, 0) || 1;
    let sc = 0, co = 0;
    for (let i = 0; i < games.length; i++) {
      const w = (FORM_WEIGHTS[i] ?? 0) / wSum;
      sc += goalsFor(games[i])     * w;
      co += goalsAgainst(games[i]) * w;
    }
    return { sc, co };
  };

  const formMap = {};
  for (const teamId of teamIds) {
    const allPlayed = matches
      .filter(m => m.finished && m.homeGoals != null &&
        (m.homeTeam.id === teamId || m.awayTeam.id === teamId))
      .sort((a, b) => new Date(b.kickoffTime) - new Date(a.kickoffTime));

    const homePlayed = allPlayed.filter(m => m.homeTeam.id === teamId).slice(0, 5);
    const awayPlayed = allPlayed.filter(m => m.awayTeam.id === teamId).slice(0, 5);

    const homeRecent = wavg(homePlayed, m => m.homeGoals ?? 0, m => m.awayGoals ?? 0);
    const awayRecent = wavg(awayPlayed, m => m.awayGoals ?? 0, m => m.homeGoals ?? 0);

    let seasonHomeScored = 0, seasonHomeConceded = 0;
    let seasonAwayScored = 0, seasonAwayConceded = 0;
    for (const m of allPlayed) {
      if (m.homeTeam.id === teamId) {
        seasonHomeScored   += m.homeGoals ?? 0;
        seasonHomeConceded += m.awayGoals ?? 0;
      } else {
        seasonAwayScored   += m.awayGoals ?? 0;
        seasonAwayConceded += m.homeGoals ?? 0;
      }
    }

    const allHome = allPlayed.filter(m => m.homeTeam.id === teamId);
    const allAway = allPlayed.filter(m => m.awayTeam.id === teamId);
    const mixed   = allPlayed.slice(0, 5);

    const mixedStats = wavg(
      mixed,
      m => (m.homeTeam.id === teamId ? m.homeGoals : m.awayGoals) ?? 0,
      m => (m.homeTeam.id === teamId ? m.awayGoals : m.homeGoals) ?? 0,
    );

    formMap[teamId] = {
      homeScored:    homeRecent.sc,
      homeConceded:  homeRecent.co,
      homeGames:     homePlayed.length,
      awayScored:    awayRecent.sc,
      awayConceded:  awayRecent.co,
      awayGames:     awayPlayed.length,
      seasonHomeScored,  seasonHomeConceded,  seasonHomeGames: allHome.length,
      seasonAwayScored,  seasonAwayConceded,  seasonAwayGames: allAway.length,
      seasonScored:   seasonHomeScored + seasonAwayScored,
      seasonConceded: seasonHomeConceded + seasonAwayConceded,
      seasonGames:    allPlayed.length,
      scored:   mixedStats.sc,
      conceded: mixedStats.co,
      games:    1,
      recentResults: mixed.map(m => ({
        homeGoals: m.homeTeam.id === teamId ? m.homeGoals : m.awayGoals,
        awayGoals: m.homeTeam.id === teamId ? m.awayGoals : m.homeGoals,
      })),
    };
  }
  return formMap;
}

// ─── Walk-forward backtest ─────────────────────────────────────────────────────

function backtestMatches(matches) {
  const completed = matches
    .filter(m => m.finished && m.homeGoals != null && m.awayGoals != null)
    .sort((a, b) => new Date(a.kickoffTime) - new Date(b.kickoffTime));

  const results = [];

  for (let i = MIN_PRIOR; i < completed.length; i++) {
    const match       = completed[i];
    const priorMatches = completed.slice(0, i);

    const avgs           = calcFdLeagueAverages(priorMatches);
    const fplShape       = fdMatchesToFplShape(priorMatches);
    const rollingRatings = buildRollingRatings(fplShape, avgs.home, avgs.away);
    const eloRatings     = buildEloRatings(fplShape);
    const formData       = buildFdFormData(priorMatches);

    let pred;
    try {
      pred = predict({
        homeTeam:      { id: match.homeTeam.id },
        awayTeam:      { id: match.awayTeam.id },
        leagueAvgHome: avgs.home,
        leagueAvgAway: avgs.away,
        xGData:        {},       // no historical xG available
        formData,
        rollingRatings,
        eloRatings,
        h2hData:       null,
        marketOdds:    null,
      });
    } catch { continue; }

    const actual    = match.homeGoals > match.awayGoals ? 'H'
                    : match.homeGoals < match.awayGoals ? 'A' : 'D';
    const probs     = [pred.homeWin, pred.draw, pred.awayWin];
    const predOut   = ['H', 'D', 'A'][probs.indexOf(Math.max(...probs))];
    const confidence = Math.max(...probs);

    results.push({
      predicted:  pred,
      actual,
      predOut,
      correct:    actual === predOut,
      confidence,
      home:       match.homeTeam.shortName,
      away:       match.awayTeam.shortName,
      homeGoals:  match.homeGoals,
      awayGoals:  match.awayGoals,
    });
  }

  return results;
}

// ─── Per-league report ─────────────────────────────────────────────────────────

function report(leagueId, results) {
  const total   = results.length;
  const correct = results.filter(r => r.correct).length;
  const acc     = correct / total;

  // Log-loss / Brier expect { predicted: {homeWin,draw,awayWin}, actual: 'H'|'D'|'A' }
  const forMetrics = results.map(r => ({ predicted: r.predicted, actual: r.actual }));
  const ll = logLoss(forMetrics);
  const bs = brierScore(forMetrics);

  // Outcome breakdown
  const byActual = { H: [0,0], D: [0,0], A: [0,0] };
  for (const r of results) {
    byActual[r.actual][1]++;
    if (r.correct) byActual[r.actual][0]++;
  }

  // Calibration — check if 60–70% confidence calls land ~65% of the time etc.
  const buckets = [
    { label: '33–45%', min: 0.33, max: 0.45, correct: 0, total: 0 },
    { label: '45–55%', min: 0.45, max: 0.55, correct: 0, total: 0 },
    { label: '55–65%', min: 0.55, max: 0.65, correct: 0, total: 0 },
    { label: '65–75%', min: 0.65, max: 0.75, correct: 0, total: 0 },
    { label: '75%+',   min: 0.75, max: 1.00, correct: 0, total: 0 },
  ];
  for (const r of results) {
    const b = buckets.find(b => r.confidence >= b.min && r.confidence < b.max);
    if (b) { b.total++; if (r.correct) b.correct++; }
  }

  // Biggest confident misses (upset detector)
  const confidentMisses = [...results]
    .filter(r => !r.correct)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 3);

  const pad = n => String(n).padStart(3);
  const pct = (c, t) => t ? `${(c/t*100).toFixed(1)}%` : '--';

  console.log(`\n${'═'.repeat(64)}`);
  console.log(`  ${leagueId.toUpperCase().replace(/-/g,' ')}`);
  console.log(`${'═'.repeat(64)}`);
  console.log(`  Matches tested : ${total}`);
  console.log(`  Correct        : ${correct}  (${(acc*100).toFixed(1)}%)`);
  console.log(`  Log loss       : ${ll.toFixed(4)}   ← lower is better (random = 1.099)`);
  console.log(`  Brier score    : ${bs.toFixed(4)}   ← lower is better (random = 0.667)`);
  console.log(`\n  Outcome accuracy:`);
  console.log(`    Home wins : ${pad(byActual.H[0])}/${pad(byActual.H[1])}  ${pct(...byActual.H)}`);
  console.log(`    Draws     : ${pad(byActual.D[0])}/${pad(byActual.D[1])}  ${pct(...byActual.D)}`);
  console.log(`    Away wins : ${pad(byActual.A[0])}/${pad(byActual.A[1])}  ${pct(...byActual.A)}`);
  console.log(`\n  Confidence calibration:`);
  for (const b of buckets) {
    if (!b.total) continue;
    const bar = '█'.repeat(Math.round(b.total / 3));
    console.log(`    ${b.label.padEnd(7)}: ${pct(b.correct, b.total).padStart(6)}  (n=${b.total}) ${bar}`);
  }
  if (confidentMisses.length) {
    console.log(`\n  Top confident misses:`);
    for (const r of confidentMisses) {
      console.log(`    ${r.home} ${r.homeGoals}–${r.awayGoals} ${r.away}  ` +
                  `(predicted ${r.predOut} at ${(r.confidence*100).toFixed(0)}%, actual ${r.actual})`);
    }
  }

  return { leagueId, total, correct, acc, ll, bs };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n🔬 MATCHIQ BACKTEST — Walk-forward validation (2025-26 season)');
  console.log('   Signal: rolling EWMA + ELO + form momentum (no xG, no market odds)');
  console.log('   Method: predict match N using only matches 0…N-1 as training data\n');

  const leagues = [
    { id: 'la-liga',    label: 'La Liga'    },
    { id: 'bundesliga', label: 'Bundesliga' },
    { id: 'serie-a',    label: 'Serie A'    },
    { id: 'ligue-1',    label: 'Ligue 1'   },
  ];

  const summaries = [];

  // ── FD leagues ───────────────────────────────────────────────────────────────
  for (const { id, label } of leagues) {
    process.stdout.write(`  Fetching ${label}... `);
    try {
      const { data: matches } = await axios.get(`${BASE}/api/fd/matches?league=${id}`, { timeout: 15000 });
      const nCompleted = matches.filter(m => m.finished).length;
      console.log(`${nCompleted} completed matches`);
      if (nCompleted < MIN_PRIOR + 5) { console.log(`  ⚠ Too few — skipping`); continue; }
      const results = backtestMatches(matches);
      if (results.length) summaries.push(report(id, results));
    } catch (err) {
      console.log(`ERROR: ${err.message}`);
    }
  }

  // ── Premier League (FPL API) ──────────────────────────────────────────────────
  process.stdout.write('  Fetching Premier League (FPL)... ');
  try {
    const { data: fplFixtures } = await axios.get(
      'https://fantasy.premierleague.com/api/fixtures/',
      { timeout: 15000 }
    );
    // Convert FPL shape → FD-like shape for unified processing
    const plMatches = fplFixtures
      .filter(f => f.kickoff_time)
      .map(f => ({
        homeTeam: { id: f.team_h, shortName: `T${f.team_h}` },
        awayTeam: { id: f.team_a, shortName: `T${f.team_a}` },
        homeGoals:   f.team_h_score,
        awayGoals:   f.team_a_score,
        kickoffTime: f.kickoff_time,
        finished:    f.finished && f.team_h_score != null,
      }));
    const nCompleted = plMatches.filter(m => m.finished).length;
    console.log(`${nCompleted} completed matches`);
    if (nCompleted >= MIN_PRIOR + 5) {
      const results = backtestMatches(plMatches);
      if (results.length) summaries.push(report('premier-league', results));
    }
  } catch (err) {
    console.log(`ERROR: ${err.message}`);
  }

  // ── Summary table ─────────────────────────────────────────────────────────────
  if (summaries.length) {
    const totalM = summaries.reduce((s, r) => s + r.total, 0);
    const totalC = summaries.reduce((s, r) => s + r.correct, 0);
    const avgLL  = summaries.reduce((s, r) => s + r.ll, 0) / summaries.length;
    const avgBS  = summaries.reduce((s, r) => s + r.bs, 0) / summaries.length;

    console.log(`\n${'═'.repeat(64)}`);
    console.log('  SUMMARY');
    console.log(`${'═'.repeat(64)}`);
    console.log('  League             Matches  Accuracy  Log-loss  Brier');
    console.log('  ' + '─'.repeat(60));
    for (const s of summaries) {
      const name = s.leagueId.replace(/-/g,' ').padEnd(18);
      console.log(
        `  ${name} ${String(s.total).padStart(7)}  ` +
        `${(s.acc*100).toFixed(1).padStart(6)}%  ` +
        `${s.ll.toFixed(4).padStart(8)}  ` +
        `${s.bs.toFixed(4).padStart(5)}`
      );
    }
    console.log('  ' + '─'.repeat(60));
    console.log(
      `  ${'ALL LEAGUES'.padEnd(18)} ${String(totalM).padStart(7)}  ` +
      `${(totalC/totalM*100).toFixed(1).padStart(6)}%  ` +
      `${avgLL.toFixed(4).padStart(8)}  ` +
      `${avgBS.toFixed(4).padStart(5)}`
    );

    console.log(`\n  Reference baselines:`);
    console.log(`  • Random guess           ~33%   log-loss 1.099  Brier 0.667`);
    console.log(`  • Always pick home win   ~45%   log-loss ~1.05  Brier ~0.64`);
    console.log(`  • Betting markets        ~55%   log-loss ~0.93  Brier ~0.58`);
    console.log(`  • Top academic models    ~57%   log-loss ~0.90  Brier ~0.56`);
    console.log(`\n  ⚠ Production model adds xG + market odds blending on top of this.`);
    console.log(`    Those signals typically add +3–5pp accuracy.\n`);
  }
}

main().catch(err => {
  console.error('\n❌ Backtest failed:', err.message);
  process.exit(1);
});
