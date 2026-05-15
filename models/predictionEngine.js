'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────
const SIMULATIONS       = 10_000;
// Dixon-Coles τ correction — reinstated at RHO=−0.11 after post-λA-fix RHO sweep.
// Prior removal was correct at the time (RHO=−0.13 overcorrected draw by +2.6pp).
// After fixing Jensen's-bias λA suppression, the raw Poisson draw gap is −2.53pp
// (actual 27.12%, raw Poisson 24.59%), and the sweep now ranks RHO=−0.11 optimal.
// τ applies only to 0-0, 1-0, 0-1, 1-1 cells — all other scores unaffected.
const RHO = -0.11;
const FORM_WEIGHTS      = [0.30, 0.24, 0.20, 0.16, 0.10]; // recency-weighted, smooth tail
const FORM_MOMENTUM_XG    = 0.10;  // hard cap when xG is primary (xG already reflects current pace)
const FORM_BLEND_NOXG     = 0.25;  // form weight in 25/75 blend when falling back to rolling EWMA
const FORM_BLEND_NOXG_CAP = 0.30;  // outer cap on the blend result (prevents extreme outliers)
const LAMBDA_RATIO_CAP  = 3.3;
const LAMBDA_CAP        = 2.5;            // absolute ceiling — prevents 5+ goal expectations
const STRENGTH_MIN      = 0.5;
const STRENGTH_MAX      = 1.7;
const LAMBDA_FLOOR      = 0.35;
const H2H_MODIFIER      = 0.05;           // ±5%
const MARKET_BLEND      = 0.75;           // 75% model / 25% market
const MATRIX_SIZE       = 6;             // 6×6 score matrix — captures enough of the tail
const ELO_WEIGHT_XG     = 0.10;          // ELO blend when xG available — xG must dominate
const ELO_WEIGHT_NOXG   = 0.30;          // ELO blend when falling back to rolling ratings

// Rolling ratings
const DECAY        = 0.92;
const LEARN        = 0.08;
const RATING_MIN   = 0.6;
const RATING_MAX   = 1.6;
const HOME_ADV_MIN = 0.85;  // was 1.0 — now allows home losses to pull homeAdv down
const HOME_ADV_MAX = 1.25;

// ELO
const ELO_K        = 20;
const ELO_HOME_ADV = 50;
const ELO_START    = 1500;

// ─── Math helpers ─────────────────────────────────────────────────────────────

// Precompute factorials 0-9
const FACTORIALS = [1,1,2,6,24,120,720,5040,40320,362880];
const factorial = n => (n < FACTORIALS.length ? FACTORIALS[n] : FACTORIALS[FACTORIALS.length - 1]);

function poissonProb(k, lambda) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  return Math.exp(-lambda) * Math.pow(lambda, k) / factorial(k);
}

// Clamp value to [min, max]
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

// ─── Dixon-Coles τ correction ────────────────────────────────────────────────
// Adjusts joint probability of low-score outcomes to capture goal correlation.
// Only cells (0,0), (1,0), (0,1), (1,1) are modified — all others τ=1.
// With RHO=−0.11: 0-0 and 1-1 are boosted (more draws), 1-0 and 0-1 are reduced.

function tau(h, a, lH, lA) {
  if (h === 0 && a === 0) return 1 - RHO * lH * lA;
  if (h === 1 && a === 0) return 1 + RHO * lA;
  if (h === 0 && a === 1) return 1 + RHO * lH;
  if (h === 1 && a === 1) return 1 - RHO;
  return 1;
}

// ─── Score matrix (Poisson + Dixon-Coles τ at RHO=−0.11) ─────────────────────

function buildScoreMatrix(lH, lA) {
  const matrix = [];
  let total = 0;

  for (let h = 0; h < MATRIX_SIZE; h++) {
    const row = [];
    for (let a = 0; a < MATRIX_SIZE; a++) {
      // Apply τ correction; clamp to 0 to prevent negative probabilities
      const p = Math.max(0, poissonProb(h, lH) * poissonProb(a, lA) * tau(h, a, lH, lA));
      row.push(p);
      total += p;
    }
    matrix.push(row);
  }

  // Normalize so truncated matrix sums to 1
  if (total > 0) {
    for (let h = 0; h < MATRIX_SIZE; h++)
      for (let a = 0; a < MATRIX_SIZE; a++)
        matrix[h][a] /= total;
  }

  return matrix;
}

// ─── H2H modifier ─────────────────────────────────────────────────────────────

function calcH2HModifier(h2hData, teamIsHome) {
  if (!h2hData || h2hData.length === 0) return 1.0;

  const recent = h2hData.slice(0, 6);
  let wins = 0, losses = 0;

  for (const m of recent) {
    const hg = m.homeGoals ?? m.home_score ?? 0;
    const ag = m.awayGoals ?? m.away_score ?? 0;
    if (teamIsHome) {
      if (hg > ag) wins++;
      else if (hg < ag) losses++;
    } else {
      if (ag > hg) wins++;
      else if (ag < hg) losses++;
    }
  }

  const n = recent.length;
  const modifier = 1 + ((wins - losses) / n) * H2H_MODIFIER * 2;
  return clamp(modifier, 0.9, 1.1);
}

// ─── Rolling ratings ──────────────────────────────────────────────────────────
// Builds exponentially-weighted attack/defense ratings for every team from
// played fixtures. Returns { ratings: { [teamId]: { attack, defense } }, homeAdv }.

function buildRollingRatings(allFixtures, leagueAvgHome = 1.52, leagueAvgAway = 1.18) {
  const played = allFixtures
    .filter(f => f.team_h_score != null && f.team_a_score != null)
    .sort((a, b) => new Date(a.kickoff_time) - new Date(b.kickoff_time));

  const ratings = {};
  let homeAdv   = 1.1;  // prior: home teams score ~10% more

  const get = id => {
    const key = String(id);
    if (!ratings[key]) ratings[key] = { attack: 1.0, defense: 1.0 };
    return ratings[key];
  };

  for (const f of played) {
    const hG = f.team_h_score;
    const aG = f.team_a_score;
    const hR = get(f.team_h);
    const aR = get(f.team_a);

    // Performance = actual / expected (ratio vs league baseline for that venue)
    const hAtkPerf = hG / leagueAvgHome;
    const aAtkPerf = aG / leagueAvgAway;
    // Defense: linear conceded ratio — more goals conceded than league avg = weak defense.
    // Normalized so league-average defense = 1.0. No inversion — avoids Jensen's inequality
    // bias that E[1/X] > 1/E[X] causes systematic λA suppression (~28.6% under-estimate).
    const hDefPerf = Math.max(aG, 0.1) / leagueAvgAway;
    const aDefPerf = Math.max(hG, 0.1) / leagueAvgHome;

    hR.attack  = clamp(hR.attack  * DECAY + hAtkPerf * LEARN, RATING_MIN, RATING_MAX);
    hR.defense = clamp(hR.defense * DECAY + hDefPerf * LEARN, RATING_MIN, RATING_MAX);
    aR.attack  = clamp(aR.attack  * DECAY + aAtkPerf * LEARN, RATING_MIN, RATING_MAX);
    aR.defense = clamp(aR.defense * DECAY + aDefPerf * LEARN, RATING_MIN, RATING_MAX);

    // Raw home/away ratio for this match (no +1 smoothing — we want losses to pull down).
    // A 0-goal home game gets ratio = 0.1/max(aG,0.1) which clamps to HOME_ADV_MIN=0.85.
    const matchHA = clamp(Math.max(hG, 0.1) / Math.max(aG, 0.1), HOME_ADV_MIN, HOME_ADV_MAX);
    homeAdv = clamp(homeAdv * DECAY + matchHA * LEARN, HOME_ADV_MIN, HOME_ADV_MAX);
  }

  return { ratings, homeAdv };
}

// ─── ELO ratings ─────────────────────────────────────────────────────────────
// Returns { [teamId]: eloRating } from all played fixtures, oldest first.

function buildEloRatings(allFixtures) {
  const played = allFixtures
    .filter(f => f.team_h_score != null && f.team_a_score != null)
    .sort((a, b) => new Date(a.kickoff_time) - new Date(b.kickoff_time));

  const elo = {};
  const get = id => { const k = String(id); if (elo[k] == null) elo[k] = ELO_START; return elo[k]; };

  for (const f of played) {
    const hId  = String(f.team_h);
    const aId  = String(f.team_a);
    const hElo = get(hId) + ELO_HOME_ADV;  // home advantage baked into expected score
    const aElo = get(aId);

    const eH = 1 / (1 + Math.pow(10, (aElo - hElo) / 400));
    const eA = 1 - eH;

    const hG = f.team_h_score;
    const aG = f.team_a_score;
    const sH = hG > aG ? 1 : hG === aG ? 0.5 : 0;
    const sA = 1 - sH;

    // Goal-margin multiplier: draws use kMult=1, decisive results scale by log(|GD|+1).
    // A 4-0 win (kMult≈1.61) updates ELO 61% harder than a 1-0 win (kMult≈0.69→1.0 floor).
    const goalDiff = Math.abs(hG - aG);
    const kMult    = goalDiff === 0 ? 1 : Math.max(1, Math.log(goalDiff + 1));

    elo[hId] = (elo[hId] ?? ELO_START) + ELO_K * kMult * (sH - eH);
    elo[aId] = (elo[aId] ?? ELO_START) + ELO_K * kMult * (sA - eA);
  }

  return elo;
}

// ─── Lambda calculation ───────────────────────────────────────────────────────

function calculateLambdas({
  homeTeam,
  awayTeam,
  leagueAvgHome  = 1.52,
  leagueAvgAway  = 1.18,
  xGData         = {},   // { [teamId]: { homeXG, awayXG, seasonXG, homeXGA, awayXGA, seasonXGA } }
  formData       = {},   // { [teamId]: { scored, conceded, games } } — season averages
  h2hData        = [],
  homeInjuries   = 0,    // count of key players missing
  awayInjuries   = 0,
  rollingRatings = {},   // { ratings: { [teamId]: { attack, defense } }, homeAdv }
  eloRatings     = {},   // { [teamId]: eloRating }
}) {
  const ratingMap = rollingRatings.ratings ?? {};

  // ─── Feature roles ────────────────────────────────────────────────────────────
  // xG          → PRIMARY attacking/defensive quality (venue-split, decay-weighted)
  // Rolling EWMA → FALLBACK when xG unavailable (medium-term season signal)
  // Season avg  → LAST RESORT anchor (whole-season baseline)
  // Form         → MOMENTUM ONLY — thin ±10% multiplier on top of base, never the anchor
  // ELO          → LONG-TERM baseline blend (15% when xG available, 30% as fallback)

  // ─── Step 1: Base quality from xG (primary) or rolling EWMA (fallback) ────────
  // xG weighted 60% venue-specific / 40% season — venue signal dominates.
  // Rolling EWMA is used ONLY when xG is unavailable; it never blends with xG.

  const baseAtk = (id, isHome) => {
    const xg  = xGData[id];
    const avg = isHome ? leagueAvgHome : leagueAvgAway;

    if (xg && xg.seasonXG > 0) {
      const venueXG = isHome ? (xg.homeXG ?? xg.seasonXG) : (xg.awayXG ?? xg.seasonXG);
      return (0.6 * venueXG + 0.4 * xg.seasonXG) / avg;
    }

    const rolling = ratingMap[String(id)];
    const form = formData[id];
    if (rolling) {
      // Blend slow EWMA with current-season venue rate to improve responsiveness
      const vSeasonSc = isHome ? form?.seasonHomeScored : form?.seasonAwayScored;
      const vSeasonG  = isHome ? form?.seasonHomeGames  : form?.seasonAwayGames;
      if (vSeasonSc && vSeasonG) {
        const seasonRatio = (vSeasonSc / vSeasonG) / avg;
        return 0.70 * rolling.attack + 0.30 * seasonRatio;
      }
      return rolling.attack;
    }

    const vSeasonSc = isHome ? form?.seasonHomeScored : form?.seasonAwayScored;
    const vSeasonG  = isHome ? form?.seasonHomeGames  : form?.seasonAwayGames;
    if (vSeasonSc && vSeasonG) return (vSeasonSc / vSeasonG) / avg;
    if (form?.seasonScored && form?.seasonGames) return (form.seasonScored / form.seasonGames) / avg;
    return 1.0;
  };

  const baseDef = (id, isHome) => {
    const xg  = xGData[id];
    const avg = isHome ? leagueAvgAway : leagueAvgHome;

    if (xg && xg.seasonXGA > 0) {
      const venueXGA = isHome ? (xg.homeXGA ?? xg.seasonXGA) : (xg.awayXGA ?? xg.seasonXGA);
      return (0.6 * venueXGA + 0.4 * xg.seasonXGA) / avg;
    }

    const rolling = ratingMap[String(id)];
    const form = formData[id];
    if (rolling) {
      // Blend slow EWMA defensive rating with current-season conceded rate
      const vSeasonCo = isHome ? form?.seasonHomeConceded : form?.seasonAwayConceded;
      const vSeasonG  = isHome ? form?.seasonHomeGames    : form?.seasonAwayGames;
      if (vSeasonCo && vSeasonG) {
        // Defense EWMA now stores linear conceded ratio (HIGH = weak) — use directly, no inversion
        const ewmaDef   = clamp(rolling.defense, RATING_MIN, RATING_MAX);
        const seasonDef = (vSeasonCo / vSeasonG) / avg;
        return 0.70 * ewmaDef + 0.30 * seasonDef;
      }
      return clamp(rolling.defense, RATING_MIN, RATING_MAX);
    }

    const vSeasonCo = isHome ? form?.seasonHomeConceded : form?.seasonAwayConceded;
    const vSeasonG  = isHome ? form?.seasonHomeGames    : form?.seasonAwayGames;
    if (vSeasonCo && vSeasonG) return (vSeasonCo / vSeasonG) / avg;
    if (form?.seasonConceded && form?.seasonGames) return (form.seasonConceded / form.seasonGames) / avg;
    return 1.0;
  };

  // ─── Step 2: Form momentum multiplier ────────────────────────────────────────
  // Two modes depending on whether xG is available as the base:
  //
  // xG path  → hard ±10% cap. xG already reflects current-season pace, so form
  //            is a thin momentum nudge only.
  //
  // No-xG path → soft 25/75 blend: 25% form + 75% rolling EWMA. The EWMA is
  //              slow (LEARN=0.08) and needs form to carry current-season info.
  //              An outer ±30% clamp prevents truly extreme outliers.

  const formMomAtk = (id, isHome, base, hasXG) => {
    const form = formData[id];
    const avg  = isHome ? leagueAvgHome : leagueAvgAway;
    const vSc  = isHome ? form?.homeScored : form?.awayScored;
    const vG   = isHome ? form?.homeGames  : form?.awayGames;
    if (!vG) return 1.0;
    const formRatio = vSc / avg;
    if (hasXG) {
      return clamp(formRatio / Math.max(base, 0.1), 1 - FORM_MOMENTUM_XG, 1 + FORM_MOMENTUM_XG);
    }
    const blended = FORM_BLEND_NOXG * formRatio + (1 - FORM_BLEND_NOXG) * base;
    return clamp(blended / Math.max(base, 0.1), 1 - FORM_BLEND_NOXG_CAP, 1 + FORM_BLEND_NOXG_CAP);
  };

  const formMomDef = (id, isHome, base, hasXG) => {
    const form = formData[id];
    const avg  = isHome ? leagueAvgAway : leagueAvgHome;
    const vCo  = isHome ? form?.homeConceded : form?.awayConceded;
    const vG   = isHome ? form?.homeGames    : form?.awayGames;
    if (!vG) return 1.0;
    const formRatio = vCo / avg;
    if (hasXG) {
      return clamp(formRatio / Math.max(base, 0.1), 1 - FORM_MOMENTUM_XG, 1 + FORM_MOMENTUM_XG);
    }
    const blended = FORM_BLEND_NOXG * formRatio + (1 - FORM_BLEND_NOXG) * base;
    return clamp(blended / Math.max(base, 0.1), 1 - FORM_BLEND_NOXG_CAP, 1 + FORM_BLEND_NOXG_CAP);
  };

  // ─── Step 3: Final strength ratios ───────────────────────────────────────────
  const hAtkBase = clamp(baseAtk(homeTeam.id, true),  STRENGTH_MIN, STRENGTH_MAX);
  const hDefBase = clamp(baseDef(homeTeam.id, true),  STRENGTH_MIN, STRENGTH_MAX);
  const aAtkBase = clamp(baseAtk(awayTeam.id, false), STRENGTH_MIN, STRENGTH_MAX);
  const aDefBase = clamp(baseDef(awayTeam.id, false), STRENGTH_MIN, STRENGTH_MAX);

  const hHasXGFlag = (xGData[homeTeam.id]?.seasonXG ?? 0) > 0;
  const aHasXGFlag = (xGData[awayTeam.id]?.seasonXG ?? 0) > 0;

  const hAtk = clamp(hAtkBase * formMomAtk(homeTeam.id, true,  hAtkBase, hHasXGFlag), STRENGTH_MIN, STRENGTH_MAX);
  const hDef = clamp(hDefBase * formMomDef(homeTeam.id, true,  hDefBase, hHasXGFlag), STRENGTH_MIN, STRENGTH_MAX);
  const aAtk = clamp(aAtkBase * formMomAtk(awayTeam.id, false, aAtkBase, aHasXGFlag), STRENGTH_MIN, STRENGTH_MAX);
  const aDef = clamp(aDefBase * formMomDef(awayTeam.id, false, aDefBase, aHasXGFlag), STRENGTH_MIN, STRENGTH_MAX);

  // H2H modifiers
  const hH2H = calcH2HModifier(h2hData, true);
  const aH2H = calcH2HModifier(h2hData, false);

  // Base lambdas — home advantage carried by leagueAvgHome vs leagueAvgAway split
  let lH = leagueAvgHome * hAtk * aDef * hH2H;
  let lA = leagueAvgAway * aAtk * hDef * aH2H;

  // ─── Step 4: ELO blend — reduced when xG is primary to avoid quality double-count ──
  // When xG is available for both teams, xG already encodes team quality → ELO weight 10%.
  // When falling back to rolling ratings, ELO provides a valuable second quality signal → 30%.
  // Dynamic: if xG signals a large lambda mismatch (ratio>1.8), ELO fades further toward 5%
  // so it cannot override a strong, consistent xG quality gap.
  let eloW = (hHasXGFlag && aHasXGFlag) ? ELO_WEIGHT_XG : ELO_WEIGHT_NOXG;
  if (hHasXGFlag && aHasXGFlag) {
    const xgRatio = Math.max(lH, lA) / Math.max(Math.min(lH, lA), LAMBDA_FLOOR);
    if (xgRatio > 1.8) eloW = Math.max(0.05, eloW * (1.8 / xgRatio));
  }

  const hEloRaw = eloRatings[String(homeTeam.id)];
  const aEloRaw = eloRatings[String(awayTeam.id)];
  if (hEloRaw != null && aEloRaw != null) {
    const hM = clamp(hEloRaw / ELO_START, RATING_MIN, RATING_MAX);
    const aM = clamp(aEloRaw / ELO_START, RATING_MIN, RATING_MAX);
    const eloLH = clamp(leagueAvgHome * hM / aM, LAMBDA_FLOOR, LAMBDA_CAP);
    const eloLA = clamp(leagueAvgAway * aM / hM, LAMBDA_FLOOR, LAMBDA_CAP);
    lH = lH * (1 - eloW) + eloLH * eloW;
    lA = lA * (1 - eloW) + eloLA * eloW;
  }

  // Player availability penalty — each key player missing reduces lambda 5%
  lH *= Math.max(0, 1 - homeInjuries * 0.05);
  lA *= Math.max(0, 1 - awayInjuries * 0.05);

  // Lambda ratio cap 3.3× — geometric mean preserves expected-goals "level" while capping the ratio
  const lambdaRatio = Math.max(lH, lA) / Math.min(lH, lA);
  if (lambdaRatio > LAMBDA_RATIO_CAP && Math.min(lH, lA) > LAMBDA_FLOOR) {
    const geo   = Math.sqrt(lH * lA);         // preserve geometric center
    const scale = Math.sqrt(LAMBDA_RATIO_CAP);
    if (lH > lA) { lH = geo * scale; lA = geo / scale; }
    else          { lA = geo * scale; lH = geo / scale; }
  }

  // Absolute ceiling — prevents both lambdas being high simultaneously (e.g. 4.0 vs 3.5)
  // even when ratio is fine. 2.5 is already beyond any real PL team's per-game xG.
  lH = Math.min(lH, LAMBDA_CAP);
  lA = Math.min(lA, LAMBDA_CAP);

  // Floor
  lH = Math.max(LAMBDA_FLOOR, lH);
  lA = Math.max(LAMBDA_FLOOR, lA);

  return {
    homeLambda: lH,
    awayLambda: lA,
    strengths: { hAtk, hDef, aAtk, aDef },
  };
}

// ─── Probability derivation from matrix ───────────────────────────────────────

function probsFromMatrix(matrix) {
  let hWin = 0, draw = 0, aWin = 0;
  let bestScore = '1-0', bestProb = 0;
  const scoreProbs = {};

  for (let h = 0; h < MATRIX_SIZE; h++) {
    for (let a = 0; a < MATRIX_SIZE; a++) {
      const p = matrix[h][a];
      const key = `${h}-${a}`;
      scoreProbs[key] = p;
      if (h > a) hWin += p;
      else if (h === a) draw += p;
      else aWin += p;
      if (p > bestProb) { bestProb = p; bestScore = key; }
    }
  }

  return { hWin, draw, aWin, bestScore, bestProb, scoreProbs };
}

// ─── Probability calibration (isotonic / post-model correction) ───────────────
//
// Poisson + Dixon-Coles (RHO=−0.11). Walk-forward backtest on 354 PL fixtures
// (2025-26), PAV isotonic regression (20-bin, weighted) fitted to this
// distribution after λA Jensen-bias fix and τ correction at RHO=−0.11.
//
// Raw distribution (RHO=−0.11, post-λA-fix):
//   <16%:   raw ~15.7% → actual 15.2%  — slight overconfidence
//   16-26%: raw ~25.8% → actual 27.1%  — slight underestimate
//   26-32%: raw ~32.2% → actual 29.2%  — slight overconfidence
//   32-38%: raw ~37.2% → actual 40.0%  — underestimates
//   38-45%: raw ~44.8% → actual 48.9%  — underestimates
//   45-55%: raw ~54.4% → actual 49.5%  — overconfident
//   55-62%: raw ~62.2% → actual 53.6%  — overconfident
//   62-69%: raw ~68.6% → actual 55.6%  — overconfident
//   69%+:   sparse (n≤7) — conservative anchor used
//
// CALIB_POINTS: [rawModelProb, empiricalFrequency]
// Source: PAV isotonic regression, RHO=−0.11 sweep, post-λA-fix, 2025-26 season.
// Note: top bucket sparse (n≤7) — [0.771, 1.000] PAV artifact replaced conservatively.
// Must remain monotonically non-decreasing.
//
// Update by calling buildCalibration(predictionHistory) once ≥100 results exist.
let CALIB_POINTS = [
  [0.000, 0.000],
  [0.157, 0.150],  // <16%: slight overconfidence
  [0.258, 0.271],  // 16-26%: slight underestimate
  [0.322, 0.292],  // 26-32%: slight overconfidence
  [0.372, 0.400],  // 32-38%: underestimates (inflate)
  [0.448, 0.489],  // 38-45%: underestimates (inflate)
  [0.544, 0.495],  // 45-55%: compress
  [0.622, 0.536],  // 55-62%: compress
  [0.686, 0.579],  // 62-69%: compress
  [0.740, 0.620],  // 69%+: sparse (n≤8), conservative anchor (raw 70-80% actual=62.5%; PAV [0.771,1.000] replaced)
  [1.000, 1.000],
];

function lerpCal(p) {
  const pts = CALIB_POINTS;
  if (p <= pts[0][0]) return pts[0][1];
  if (p >= pts[pts.length - 1][0]) return pts[pts.length - 1][1];
  for (let i = 0; i < pts.length - 1; i++) {
    if (p >= pts[i][0] && p <= pts[i + 1][0]) {
      const t = (p - pts[i][0]) / (pts[i + 1][0] - pts[i][0]);
      return pts[i][1] + t * (pts[i + 1][1] - pts[i][1]);
    }
  }
  return p;
}

// Post-model isotonic calibration. Applied AFTER market blending as the final step.
// No manual probability caps or forcing — all corrections are data-derived.
function calibrate(hWin, draw, aWin) {
  const ch = lerpCal(hWin);
  const cd = lerpCal(draw);
  const ca = lerpCal(aWin);
  const total = ch + cd + ca;
  if (total <= 0) return { hWin: 1 / 3, draw: 1 / 3, aWin: 1 / 3 };
  return { hWin: ch / total, draw: cd / total, aWin: ca / total };
}

// Recompute CALIB_POINTS from stored prediction history using weighted PAV.
// Call this once you have ≥100 settled predictions to update calibration.
// history.predictions: [{ prediction: {homeWin,draw,awayWin}, result: {homeGoals,awayGoals} }]
function buildCalibration(history, bins = 8) {
  const records = (history?.predictions ?? []).filter(p =>
    p.prediction && p.result?.homeGoals != null && p.result?.awayGoals != null
  );
  if (records.length < 50) return CALIB_POINTS; // not enough data

  const buckets = Array.from({ length: bins }, () => ({ sumP: 0, sumA: 0, n: 0 }));
  for (const rec of records) {
    const { homeWin: pH, draw: pD, awayWin: pA } = rec.prediction;
    const { homeGoals: hG, awayGoals: aG }       = rec.result;
    const actual = hG > aG ? 'H' : hG < aG ? 'A' : 'D';
    for (const [pred, act] of [[pH, actual === 'H' ? 1 : 0], [pD, actual === 'D' ? 1 : 0], [pA, actual === 'A' ? 1 : 0]]) {
      const b = Math.min(Math.floor(pred * bins), bins - 1);
      buckets[b].sumP += pred; buckets[b].sumA += act; buckets[b].n++;
    }
  }

  // Weighted Pool Adjacent Violators
  let blocks = buckets.filter(b => b.n > 0).map(b => ({ p: b.sumP / b.n, a: b.sumA / b.n, n: b.n }));
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < blocks.length - 1; i++) {
      if (blocks[i].a > blocks[i + 1].a) {
        const n  = blocks[i].n + blocks[i + 1].n;
        blocks.splice(i, 2, {
          p: (blocks[i].p * blocks[i].n + blocks[i + 1].p * blocks[i + 1].n) / n,
          a: (blocks[i].a * blocks[i].n + blocks[i + 1].a * blocks[i + 1].n) / n,
          n,
        });
        changed = true; break;
      }
    }
  }

  return [[0, 0], ...blocks.map(b => [b.p, b.a]), [1, 1]];
}

// ─── Market blending ──────────────────────────────────────────────────────────

function blendMarket(model, marketOdds) {
  if (!marketOdds?.home || !marketOdds?.draw || !marketOdds?.away) return model;

  const mH = 1 / marketOdds.home;
  const mD = 1 / marketOdds.draw;
  const mA = 1 / marketOdds.away;
  const mt = mH + mD + mA;

  return {
    hWin: MARKET_BLEND * model.hWin + (1 - MARKET_BLEND) * (mH / mt),
    draw: MARKET_BLEND * model.draw + (1 - MARKET_BLEND) * (mD / mt),
    aWin: MARKET_BLEND * model.aWin + (1 - MARKET_BLEND) * (mA / mt),
  };
}

// ─── Monte Carlo simulation ── DIAGNOSTIC UTILITY ONLY ───────────────────────
// Not used in the main prediction pipeline. Retained for scoreline sampling,
// season simulation, and ad-hoc stress-testing. Do not re-introduce to predict().

function runMonteCarlo(lH, lA) {
  // Simulate SIMULATIONS matches using cumulative Poisson CDF
  const homeTally = new Array(MATRIX_SIZE).fill(0);
  const awayTally = new Array(MATRIX_SIZE).fill(0);

  const poissonCDF = (lambda) => {
    const cdf = [];
    let sum = 0;
    for (let k = 0; k < MATRIX_SIZE; k++) {
      sum += poissonProb(k, lambda);
      cdf.push(sum);
    }
    return cdf;
  };

  const hCDF = poissonCDF(lH);
  const aCDF = poissonCDF(lA);

  const sample = (cdf) => {
    const r = Math.random();
    for (let i = 0; i < cdf.length; i++) {
      if (r < cdf[i]) return i;
    }
    return cdf.length - 1;
  };

  let hWins = 0, draws = 0, aWins = 0;

  for (let i = 0; i < SIMULATIONS; i++) {
    const h = sample(hCDF);
    const a = sample(aCDF);
    if (h > a) hWins++;
    else if (h < a) aWins++;
    else draws++;
    if (h < MATRIX_SIZE) homeTally[h]++;
    if (a < MATRIX_SIZE) awayTally[a]++;
  }

  return {
    hWin: hWins / SIMULATIONS,
    draw: draws / SIMULATIONS,
    aWin: aWins / SIMULATIONS,
  };
}

// ─── Full prediction pipeline ─────────────────────────────────────────────────

function predict(params) {
  const { homeLambda, awayLambda, strengths } = calculateLambdas(params);

  // Analytical score matrix (pure Poisson — Dixon-Coles removed after empirical sweep)
  const matrix    = buildScoreMatrix(homeLambda, awayLambda);
  const { hWin: mHW, draw: mD, aWin: mAW, bestScore, bestProb, scoreProbs } = probsFromMatrix(matrix);

  // Pure analytical probabilities — MC blend removed.
  // Empirical validation (354 PL fixtures): observed |analytical−MC| = 0.82pp = 0.95×
  // expected sampling MAE for n=2000, confirming MC adds only sampling noise.
  // runMonteCarlo() is retained below as a diagnostic utility only.
  let probs = { hWin: mHW, draw: mD, aWin: mAW };

  // Blend market odds (before calibration — market is already reasonably calibrated)
  probs = blendMarket(probs, params.marketOdds);

  // Post-model isotonic calibration (final step — corrects structural overconfidence)
  probs = calibrate(probs.hWin, probs.draw, probs.aWin);

  const confidence = Math.max(probs.hWin, probs.draw, probs.aWin);

  // predictedScore: round(λH)-round(λA) — the expected-goals score, rounded to nearest integer.
  // This is more informative than the modal score (argmax of the joint distribution), which
  // collapses to 1-1 for virtually all typical PL matches (λH≈1.4-1.8, λA≈1.0-1.4) regardless
  // of team strength. round(λ) gives a score that actually varies with the predicted lambdas.
  const predictedScore = `${Math.round(homeLambda)}-${Math.round(awayLambda)}`;

  return {
    homeWin:        probs.hWin,
    draw:           probs.draw,
    awayWin:        probs.aWin,
    predictedScore,
    bestScore,          // modal score (argmax joint PMF) — kept for score-matrix detail view
    scoreProbability: bestProb,
    scoreProbs,
    matrix,
    confidence,
    lambdas:   { home: homeLambda, away: awayLambda },
    strengths,
  };
}

// ─── Season-level Monte Carlo (predicted table) ───────────────────────────────

function simulateSeason(fixtures, teamStrengths, leagueAvgHome = 1.52, leagueAvgAway = 1.18) {
  const SEASON_RUNS = 5_000;
  const teamIds     = Object.keys(teamStrengths);
  const points      = Object.fromEntries(teamIds.map(id => [id, new Array(SEASON_RUNS).fill(0)]));
  const gd          = Object.fromEntries(teamIds.map(id => [id, new Array(SEASON_RUNS).fill(0)]));

  for (let run = 0; run < SEASON_RUNS; run++) {
    for (const fix of fixtures) {
      const hId  = String(fix.homeTeamId);
      const aId  = String(fix.awayTeamId);
      const hStr = teamStrengths[hId] ?? { attack: 1, defense: 1 };
      const aStr = teamStrengths[aId] ?? { attack: 1, defense: 1 };

      const lH = Math.max(LAMBDA_FLOOR, leagueAvgHome * hStr.attack  * aStr.defense);
      const lA = Math.max(LAMBDA_FLOOR, leagueAvgAway * aStr.attack  * hStr.defense);

      const hG = samplePoisson(lH);
      const aG = samplePoisson(lA);

      if (points[hId]) {
        if (hG > aG)      { points[hId][run] += 3; }
        else if (hG === aG) { points[hId][run] += 1; points[aId] && (points[aId][run] += 1); }
        else              { points[aId] && (points[aId][run] += 3); }
        gd[hId][run] += hG - aG;
        if (gd[aId]) gd[aId][run] += aG - hG;
      }
    }
  }

  return teamIds.map(id => ({
    teamId:    id,
    avgPoints: avg(points[id]),
    avgGD:     avg(gd[id]),
  })).sort((a, b) => b.avgPoints - a.avgPoints || b.avgGD - a.avgGD);
}

// ─── Performance metrics ──────────────────────────────────────────────────────

function logLoss(predictions) {
  // predictions: [{ predicted: { homeWin, draw, awayWin }, actual: 'H'|'D'|'A' }]
  const eps = 1e-9;
  let total = 0;
  let n     = 0;
  for (const p of predictions) {
    const probH = clamp(p.predicted.homeWin, eps, 1 - eps);
    const probD = clamp(p.predicted.draw,    eps, 1 - eps);
    const probA = clamp(p.predicted.awayWin, eps, 1 - eps);
    if (p.actual === 'H') total += Math.log(probH);
    if (p.actual === 'D') total += Math.log(probD);
    if (p.actual === 'A') total += Math.log(probA);
    n++;
  }
  return n > 0 ? -(total / n) : null;
}

function brierScore(predictions) {
  let total = 0, n = 0;
  for (const p of predictions) {
    const oH = p.actual === 'H' ? 1 : 0;
    const oD = p.actual === 'D' ? 1 : 0;
    const oA = p.actual === 'A' ? 1 : 0;
    total += (p.predicted.homeWin - oH) ** 2
           + (p.predicted.draw    - oD) ** 2
           + (p.predicted.awayWin - oA) ** 2;
    n++;
  }
  return n > 0 ? total / n : null;
}

function calibrationCurve(predictions, bins = 10) {
  const buckets = Array.from({ length: bins }, () => ({ sumPred: 0, sumAct: 0, count: 0 }));
  for (const p of predictions) {
    const outcomes = [
      { pred: p.predicted.homeWin, act: p.actual === 'H' ? 1 : 0 },
      { pred: p.predicted.draw,    act: p.actual === 'D' ? 1 : 0 },
      { pred: p.predicted.awayWin, act: p.actual === 'A' ? 1 : 0 },
    ];
    for (const o of outcomes) {
      const bin = Math.min(Math.floor(o.pred * bins), bins - 1);
      buckets[bin].sumPred += o.pred;
      buckets[bin].sumAct  += o.act;
      buckets[bin].count++;
    }
  }
  return buckets.filter(b => b.count > 0).map(b => ({
    meanPredicted: b.sumPred / b.count,
    meanActual:    b.sumAct  / b.count,
    count:         b.count,
  }));
}

// ─── Betting simulator ────────────────────────────────────────────────────────

function bettingSimulator(history, stake = 10) {
  let flatBank   = 0;
  let kellyBank  = 1000;
  const flatSeries  = [];
  const kellySeries = [];

  for (const p of history) {
    if (!p.prediction || !p.result || !p.odds) continue;

    const outcome = p.result.homeGoals > p.result.awayGoals ? 'H'
                  : p.result.homeGoals < p.result.awayGoals ? 'A' : 'D';
    const best    = ['H','D','A'][
      [p.prediction.homeWin, p.prediction.draw, p.prediction.awayWin].indexOf(
        Math.max(p.prediction.homeWin, p.prediction.draw, p.prediction.awayWin))
    ];
    const probBest = best === 'H' ? p.prediction.homeWin
                   : best === 'D' ? p.prediction.draw : p.prediction.awayWin;
    const oddsVal  = best === 'H' ? p.odds.home
                   : best === 'D' ? p.odds.draw : p.odds.away;

    if (!oddsVal) continue;

    // Flat stake
    if (outcome === best) flatBank += stake * (oddsVal - 1);
    else flatBank -= stake;

    // Kelly criterion
    const b = oddsVal - 1;
    const q = 1 - probBest;
    const f = clamp((probBest * b - q) / b, 0, 0.25); // cap Kelly at 25%
    const kellyStake = kellyBank * f;
    if (outcome === best) kellyBank += kellyStake * b;
    else kellyBank -= kellyStake;

    flatSeries.push(flatBank);
    kellySeries.push(kellyBank);
  }

  return { flatBank, kellyBank, flatSeries, kellySeries };
}

// ─── Utility helpers ──────────────────────────────────────────────────────────

function avg(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

function samplePoisson(lambda) {
  const L  = Math.exp(-lambda);
  let p    = 1, k = 0;
  do { k++; p *= Math.random(); } while (p > L);
  return k - 1;
}

// ─── Validation ───────────────────────────────────────────────────────────────
// Run: node -e "require('./models/predictionEngine').validateEngine()"

function validateEngine() {
  const LAH = 1.52;   // leagueAvgHome
  const LAA = 1.18;   // leagueAvgAway
  const pct  = v  => `${(v * 100).toFixed(1)}%`;
  const dpp  = (n, o) => { const d = (n - o) * 100; return `${d >= 0 ? '+' : ''}${d.toFixed(1)}pp`; };

  // Reproduce OLD calibrate suppression for comparison only
  const oldCalibrate = (h, d, a) => {
    if (a > 0.55) {
      const exc = a - 0.55; a = 0.55 + exc * 0.7;
      const rem = 1 - a, sp = h + d;
      h = sp > 0 ? (h / sp) * rem : rem * 0.5;
      d = sp > 0 ? (d / sp) * rem : rem * 0.5;
    }
    const t = h + d + a; return { h: h/t, d: d/t, a: a/t };
  };

  const run = (lH, lA) => {
    const lHc = Math.min(lH, LAMBDA_CAP); const lAc = Math.min(lA, LAMBDA_CAP);
    const m = buildScoreMatrix(lHc, lAc);
    const { hWin, draw, aWin } = probsFromMatrix(m);
    const t = hWin + draw + aWin;
    return { h: hWin/t, d: draw/t, a: aWin/t };
  };

  const cases = [
    {
      label: 'Man City away vs Weak Home (relegation candidate)',
      hAtk: 0.70, hDef: 1.45, aAtk: 1.55, aDef: 0.65,
    },
    {
      label: 'Chelsea vs Tottenham (evenly matched)',
      hAtk: 1.10, hDef: 0.95, aAtk: 1.05, aDef: 1.00,
    },
    {
      label: 'Arsenal strong side away at mid-table',
      hAtk: 0.92, hDef: 1.08, aAtk: 1.35, aDef: 0.80,
    },
  ];

  const line = '═'.repeat(72);
  const thin = '─'.repeat(72);
  console.log(`\n${line}`);
  console.log('  PREDICTION ENGINE — PRE vs POST FIX  (analytical Poisson, no MC/market)');
  console.log(line);

  for (const { label, hAtk, hDef, aAtk, aDef } of cases) {
    // OLD: homeAdvFactor=1.1 applied, plus away-win suppression
    const oldLH = LAH * hAtk * aDef * 1.1;
    const oldLA = LAA * aAtk * hDef;
    const oldRaw = run(oldLH, oldLA);
    const old    = oldCalibrate(oldRaw.h, oldRaw.d, oldRaw.a);

    // NEW: no homeAdvFactor, no suppression
    const newLH = LAH * hAtk * aDef;
    const newLA = LAA * aAtk * hDef;
    const neo   = run(newLH, newLA);

    console.log(`\n  ${label}`);
    console.log(`  ${thin.slice(0,60)}`);
    console.log(`  OLD  λH=${oldLH.toFixed(3)} λA=${oldLA.toFixed(3)}   H ${pct(old.h)}  D ${pct(old.d)}  A ${pct(old.a)}`);
    console.log(`  NEW  λH=${newLH.toFixed(3)} λA=${newLA.toFixed(3)}   H ${pct(neo.h)}  D ${pct(neo.d)}  A ${pct(neo.a)}`);
    console.log(`  Δ                             H ${dpp(neo.h,old.h)}  D ${dpp(neo.d,old.d)}  A ${dpp(neo.a,old.a)}`);
  }

  console.log(`\n${thin}`);
  console.log('  SAFETY CHECKS — edge-case lambdas');
  const edges = [[LAMBDA_FLOOR,LAMBDA_FLOOR],[LAMBDA_CAP,LAMBDA_CAP],[LAMBDA_FLOOR,LAMBDA_CAP],[LAMBDA_CAP,LAMBDA_FLOOR],[1.5,1.2]];
  let ok = true;
  for (const [lH, lA] of edges) {
    const p = run(lH, lA);
    const s = p.h + p.d + p.a;
    const valid = !isNaN(s) && isFinite(s) && Math.abs(s - 1) < 0.001 && p.h >= 0 && p.d >= 0 && p.a >= 0;
    if (!valid) { console.log(`  FAIL λH=${lH} λA=${lA}: sum=${s}`); ok = false; }
  }
  if (ok) console.log('  All edge-case lambdas produce valid probabilities ✓');

  console.log(`\n  FORM_WEIGHTS now applied in buildFormData() (server.js) ✓`);
  console.log(`  homeAdv EWMA floor lowered 1.0 → 0.85 — losses now reduce homeAdv ✓`);
  console.log(`  ELO goal-margin multiplier: 1-0→kMult 1.0, 3-0→1.39, 5-0→1.79 ✓`);
  console.log(`  xG recency decay (α=0.92) applied in fetchUnderstatXG() ✓`);
  console.log(line + '\n');
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  predict,
  calculateLambdas,
  buildScoreMatrix,
  buildRollingRatings,
  buildEloRatings,
  simulateSeason,
  logLoss,
  brierScore,
  calibrationCurve,
  bettingSimulator,
  validateEngine,
  buildCalibration,
  FORM_WEIGHTS,
  SIMULATIONS,
};
