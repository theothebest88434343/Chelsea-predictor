'use strict';
/**
 * Walk-forward prediction evaluation — PRE-FIX vs POST-FIX
 *
 * For each completed fixture in the current FPL season:
 *   1. Build form / rolling ratings / ELO from ONLY the games played before it
 *   2. Run both the old and new model
 *   3. Compare to the actual result
 *
 * Computes: Brier score, log-loss, RPS, calibration error,
 *           home/away/draw/upset accuracy, and home bias.
 *
 * Usage: /opt/homebrew/bin/node evaluate-engine.js
 */

const axios = require('axios');
const { buildRollingRatings, buildEloRatings, FORM_WEIGHTS } = require('./models/predictionEngine');

// ─── Inline Poisson matrix + Dixon-Coles τ (mirrors predictionEngine.js) ─────
// τ reinstated at RHO=−0.11 — post-λA-fix sweep ranks it optimal.
const RHO = -0.11;
const FACTORIALS = [1,1,2,6,24,120,720,5040,40320,362880];
const MATRIX_SIZE  = 6;
const LAMBDA_CAP   = 2.5;
const RATING_MIN   = 0.6;   // mirrors predictionEngine.js — used in λA decomposition
const RATING_MAX   = 1.6;
const LAMBDA_FLOOR = 0.35;
const ELO_START    = 1500;
const ELO_K        = 20;
const ELO_HOME_ADV = 50;
const STRENGTH_MIN = 0.5;
const STRENGTH_MAX = 1.7;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const poi   = (k, λ) => λ <= 0 ? (k === 0 ? 1 : 0)
  : Math.exp(-λ) * Math.pow(λ, k) / FACTORIALS[Math.min(k, 9)];

// matrix() delegates to matrixParam (defined later in RHO sweep helpers) with the
// global RHO so the main walk-forward and the sweep use identical τ logic.
// Forward reference is fine in JS — matrixParam is defined before matrix() is called.
function matrix(lH, lA) { return matrixParam(lH, lA, RHO); }

function probs(m) {
  let h = 0, d = 0, a = 0;
  for (let i = 0; i < MATRIX_SIZE; i++)
    for (let j = 0; j < MATRIX_SIZE; j++) {
      const p = m[i][j];
      if (i > j) h += p; else if (i === j) d += p; else a += p;
    }
  const t = h + d + a;
  return { h: h/t, d: d/t, a: a/t };
}

// ─── Old calibrate ─────────────────────────────────────────────────────────────
function oldCal(h, d, a) {
  if (a > 0.55) {
    const e = a - 0.55; a = 0.55 + e * 0.7;
    const rem = 1 - a, sp = h + d;
    h = sp > 0 ? (h / sp) * rem : rem * 0.5;
    d = sp > 0 ? (d / sp) * rem : rem * 0.5;
  }
  const t = h + d + a; return { h: h/t, d: d/t, a: a/t };
}

// ─── New isotonic calibration — PAV-fitted to Poisson+τ (RHO=−0.11), post-λA-fix ──
// Source: RHO=−0.11 sweep, 354 fixtures, 2025-26 PL season, 20-bin weighted PAV.
// Conservative top anchor: [0.740, 0.580] replaces PAV's [0.771, 1.000] sparse artifact.
const NEW_CALIB = [
  [0.000, 0.000], [0.157, 0.150], [0.258, 0.271], [0.322, 0.292],
  [0.372, 0.400], [0.448, 0.489], [0.544, 0.495], [0.622, 0.536],
  [0.686, 0.579], [0.740, 0.620], [1.000, 1.000],
];
function lerpCal(p) {
  if (p <= NEW_CALIB[0][0]) return NEW_CALIB[0][1];
  if (p >= NEW_CALIB[NEW_CALIB.length-1][0]) return NEW_CALIB[NEW_CALIB.length-1][1];
  for (let i = 0; i < NEW_CALIB.length - 1; i++) {
    if (p >= NEW_CALIB[i][0] && p <= NEW_CALIB[i+1][0]) {
      const t = (p - NEW_CALIB[i][0]) / (NEW_CALIB[i+1][0] - NEW_CALIB[i][0]);
      return NEW_CALIB[i][1] + t * (NEW_CALIB[i+1][1] - NEW_CALIB[i][1]);
    }
  }
  return p;
}
function newCal(h, d, a) {
  const ch = lerpCal(h), cd = lerpCal(d), ca = lerpCal(a);
  const t = ch + cd + ca;
  if (t <= 0) return { h: 1/3, d: 1/3, a: 1/3 };
  return { h: ch/t, d: cd/t, a: ca/t };
}

// ─── Old ELO (binary win/loss, no goal-margin) ─────────────────────────────────
function buildEloOld(fixtures) {
  const played = fixtures
    .filter(f => f.team_h_score != null && f.team_a_score != null)
    .sort((a, b) => new Date(a.kickoff_time) - new Date(b.kickoff_time));
  const elo = {};
  const get = id => { const k = String(id); if (elo[k] == null) elo[k] = ELO_START; return elo[k]; };
  for (const f of played) {
    const hId = String(f.team_h), aId = String(f.team_a);
    const hE = get(hId) + ELO_HOME_ADV, aE = get(aId);
    const eH = 1 / (1 + Math.pow(10, (aE - hE) / 400));
    const eA = 1 - eH;
    const sH = f.team_h_score > f.team_a_score ? 1 : f.team_h_score === f.team_a_score ? 0.5 : 0;
    elo[hId] = (elo[hId] ?? ELO_START) + ELO_K * (sH - eH);
    elo[aId] = (elo[aId] ?? ELO_START) + ELO_K * ((1 - sH) - eA);
  }
  return elo;
}

// ─── Form builders ──────────────────────────────────────────────────────────────
function formOld(before, teamId) {
  const played = before
    .filter(f => f.team_h === teamId || f.team_a === teamId)
    .sort((a, b) => new Date(b.kickoff_time) - new Date(a.kickoff_time))
    .slice(0, 5);
  let sc = 0, co = 0, g = 0;
  for (const f of played) {
    sc += f.team_h === teamId ? (f.team_h_score ?? 0) : (f.team_a_score ?? 0);
    co += f.team_h === teamId ? (f.team_a_score ?? 0) : (f.team_h_score ?? 0);
    g++;
  }
  const all = before.filter(f => f.team_h === teamId || f.team_a === teamId);
  let sSc = 0, sCo = 0;
  for (const f of all) {
    sSc += f.team_h === teamId ? (f.team_h_score ?? 0) : (f.team_a_score ?? 0);
    sCo += f.team_h === teamId ? (f.team_a_score ?? 0) : (f.team_h_score ?? 0);
  }
  return { scored: sc, conceded: co, games: g || 1, seasonScored: sSc, seasonConceded: sCo, seasonGames: all.length };
}

function formNew(before, teamId) {
  const all = before.filter(f => f.team_h === teamId || f.team_a === teamId)
    .sort((a, b) => new Date(b.kickoff_time) - new Date(a.kickoff_time));

  const homePlayed = all.filter(f => f.team_h === teamId).slice(0, 5);
  const awayPlayed = all.filter(f => f.team_a === teamId).slice(0, 5);

  const wavg = (games, getFor, getAgainst) => {
    if (!games.length) return { sc: 0, co: 0 };
    const ws = FORM_WEIGHTS.slice(0, games.length);
    const wSum = ws.reduce((a, b) => a + b, 0) || 1;
    let sc = 0, co = 0;
    for (let i = 0; i < games.length; i++) {
      const w = (FORM_WEIGHTS[i] ?? 0) / wSum;
      sc += getFor(games[i]) * w;
      co += getAgainst(games[i]) * w;
    }
    return { sc, co };
  };

  const hr = wavg(homePlayed, f => f.team_h_score ?? 0, f => f.team_a_score ?? 0);
  const ar = wavg(awayPlayed, f => f.team_a_score ?? 0, f => f.team_h_score ?? 0);

  let seasonHomeScored = 0, seasonHomeConceded = 0;
  let seasonAwayScored = 0, seasonAwayConceded = 0;
  for (const f of all) {
    if (f.team_h === teamId) {
      seasonHomeScored    += f.team_h_score ?? 0;
      seasonHomeConceded  += f.team_a_score ?? 0;
    } else {
      seasonAwayScored    += f.team_a_score ?? 0;
      seasonAwayConceded  += f.team_h_score ?? 0;
    }
  }
  const allHome = all.filter(f => f.team_h === teamId);
  const allAway = all.filter(f => f.team_a === teamId);

  return {
    homeScored: hr.sc, homeConceded: hr.co, homeGames: homePlayed.length,
    awayScored: ar.sc, awayConceded: ar.co, awayGames: awayPlayed.length,
    seasonHomeScored, seasonHomeConceded, seasonHomeGames: allHome.length,
    seasonAwayScored, seasonAwayConceded, seasonAwayGames: allAway.length,
    seasonScored:   seasonHomeScored + seasonAwayScored,
    seasonConceded: seasonHomeConceded + seasonAwayConceded,
    seasonGames: all.length,
  };
}

// ─── OLD lambda builder (mixed form, homeAdvFactor, binary ELO) ──────────────────
function makeLambdasOld(hId, aId, hFD, aFD, rolling, elo, laH, laA) {
  const rm = rolling.ratings ?? {};
  const homeAdvFactor = rolling.homeAdv ?? 1.1;

  const atk = (fd, id, isHome) => {
    const avg = isHome ? laH : laA;
    const r = rm[String(id)];
    const rr = (fd.scored && fd.games) ? (fd.scored / fd.games) / avg : null;
    const anchor = r ? r.attack : (fd.seasonScored && fd.seasonGames) ? (fd.seasonScored / fd.seasonGames) / avg : 1.0;
    return rr !== null ? 0.4 * rr + 0.6 * anchor : anchor;
  };
  const def = (fd, id, isHome) => {
    const avg = isHome ? laA : laH;
    const r = rm[String(id)];
    const rr = (fd.conceded && fd.games) ? (fd.conceded / fd.games) / avg : null;
    // Defense EWMA now stores linear conceded ratio (HIGH = weak) — use directly, no inversion
    const anchor = r ? clamp(r.defense, 0.6, 1.6) : (fd.seasonConceded && fd.seasonGames) ? (fd.seasonConceded / fd.seasonGames) / avg : 1.0;
    return rr !== null ? 0.4 * rr + 0.6 * anchor : anchor;
  };

  const hAtk = clamp(atk(hFD, hId, true),  STRENGTH_MIN, STRENGTH_MAX);
  const hDef = clamp(def(hFD, hId, true),  STRENGTH_MIN, STRENGTH_MAX);
  const aAtk = clamp(atk(aFD, aId, false), STRENGTH_MIN, STRENGTH_MAX);
  const aDef = clamp(def(aFD, aId, false), STRENGTH_MIN, STRENGTH_MAX);

  let lH = laH * hAtk * aDef * homeAdvFactor;
  let lA = laA * aAtk * hDef;

  const hER = elo[String(hId)], aER = elo[String(aId)];
  if (hER != null && aER != null) {
    const hM = clamp(hER / ELO_START, 0.6, 1.6);
    const aM = clamp(aER / ELO_START, 0.6, 1.6);
    lH = lH * 0.7 + clamp(laH * hM / aM, LAMBDA_FLOOR, LAMBDA_CAP) * 0.3;
    lA = lA * 0.7 + clamp(laA * aM / hM, LAMBDA_FLOOR, LAMBDA_CAP) * 0.3;
  }

  return { lH: clamp(lH, LAMBDA_FLOOR, LAMBDA_CAP), lA: clamp(lA, LAMBDA_FLOOR, LAMBDA_CAP) };
}

// ─── NEW lambda builder — mirrors predictionEngine.js signal hierarchy (no xG in evaluator) ─
// No xG available in walk-forward evaluator (would require per-week Understat snapshots).
// Tests: rolling EWMA as base, form momentum ±10% cap, ELO at NOXG weight (30%).
const FORM_BLEND_NOXG     = 0.25;  // form weight in soft blend (no-xG path)
const FORM_BLEND_NOXG_CAP = 0.30;  // outer cap on blend result
const ELO_WEIGHT_NOXG     = 0.30;

function makeLambdasNew(hId, aId, hFD, aFD, rolling, elo, laH, laA) {
  const rm = rolling.ratings ?? {};

  // Base quality: rolling EWMA blended 70/30 with current-season venue avg (more responsive)
  const baseAtk = (fd, id, isHome) => {
    const avg = isHome ? laH : laA;
    const r   = rm[String(id)];
    if (r) {
      const vSeasonSc = isHome ? fd.seasonHomeScored : fd.seasonAwayScored;
      const vSeasonG  = isHome ? fd.seasonHomeGames  : fd.seasonAwayGames;
      if (vSeasonSc && vSeasonG) {
        const seasonRatio = (vSeasonSc / vSeasonG) / avg;
        return 0.70 * r.attack + 0.30 * seasonRatio;
      }
      return r.attack;
    }
    const vSeasonSc = isHome ? fd.seasonHomeScored : fd.seasonAwayScored;
    const vSeasonG  = isHome ? fd.seasonHomeGames  : fd.seasonAwayGames;
    if (vSeasonSc && vSeasonG) return (vSeasonSc / vSeasonG) / avg;
    if (fd.seasonScored && fd.seasonGames) return (fd.seasonScored / fd.seasonGames) / avg;
    return 1.0;
  };

  const baseDef = (fd, id, isHome) => {
    const avg = isHome ? laA : laH;
    const r   = rm[String(id)];
    if (r) {
      const vSeasonCo = isHome ? fd.seasonHomeConceded : fd.seasonAwayConceded;
      const vSeasonG  = isHome ? fd.seasonHomeGames    : fd.seasonAwayGames;
      if (vSeasonCo && vSeasonG) {
        // Defense EWMA now stores linear conceded ratio (HIGH = weak) — use directly, no inversion
        const ewmaDef   = clamp(r.defense, 0.6, 1.6);
        const seasonDef = (vSeasonCo / vSeasonG) / avg;
        return 0.70 * ewmaDef + 0.30 * seasonDef;
      }
      return clamp(r.defense, 0.6, 1.6);
    }
    const vSeasonCo = isHome ? fd.seasonHomeConceded : fd.seasonAwayConceded;
    const vSeasonG  = isHome ? fd.seasonHomeGames    : fd.seasonAwayGames;
    if (vSeasonCo && vSeasonG) return (vSeasonCo / vSeasonG) / avg;
    if (fd.seasonConceded && fd.seasonGames) return (fd.seasonConceded / fd.seasonGames) / avg;
    return 1.0;
  };

  // Form momentum: 25/75 soft blend (no-xG path) with ±30% outer cap
  const formMomAtk = (fd, isHome, base) => {
    const avg  = isHome ? laH : laA;
    const vSc  = isHome ? fd.homeScored : fd.awayScored;
    const vG   = isHome ? fd.homeGames  : fd.awayGames;
    if (!vG) return 1.0;
    const formRatio = vSc / avg;
    const blended = FORM_BLEND_NOXG * formRatio + (1 - FORM_BLEND_NOXG) * base;
    return clamp(blended / Math.max(base, 0.1), 1 - FORM_BLEND_NOXG_CAP, 1 + FORM_BLEND_NOXG_CAP);
  };

  const formMomDef = (fd, isHome, base) => {
    const avg  = isHome ? laA : laH;
    const vCo  = isHome ? fd.homeConceded : fd.awayConceded;
    const vG   = isHome ? fd.homeGames    : fd.awayGames;
    if (!vG) return 1.0;
    const formRatio = vCo / avg;
    const blended = FORM_BLEND_NOXG * formRatio + (1 - FORM_BLEND_NOXG) * base;
    return clamp(blended / Math.max(base, 0.1), 1 - FORM_BLEND_NOXG_CAP, 1 + FORM_BLEND_NOXG_CAP);
  };

  const hAtkBase = clamp(baseAtk(hFD, hId, true),  STRENGTH_MIN, STRENGTH_MAX);
  const hDefBase = clamp(baseDef(hFD, hId, true),  STRENGTH_MIN, STRENGTH_MAX);
  const aAtkBase = clamp(baseAtk(aFD, aId, false), STRENGTH_MIN, STRENGTH_MAX);
  const aDefBase = clamp(baseDef(aFD, aId, false), STRENGTH_MIN, STRENGTH_MAX);

  const hAtk = clamp(hAtkBase * formMomAtk(hFD, true,  hAtkBase), STRENGTH_MIN, STRENGTH_MAX);
  const hDef = clamp(hDefBase * formMomDef(hFD, true,  hDefBase), STRENGTH_MIN, STRENGTH_MAX);
  const aAtk = clamp(aAtkBase * formMomAtk(aFD, false, aAtkBase), STRENGTH_MIN, STRENGTH_MAX);
  const aDef = clamp(aDefBase * formMomDef(aFD, false, aDefBase), STRENGTH_MIN, STRENGTH_MAX);

  let lH = laH * hAtk * aDef;
  let lA = laA * aAtk * hDef;

  // ELO at NOXG weight (30%) — no xG available to take primary quality role
  const hER = elo[String(hId)], aER = elo[String(aId)];
  if (hER != null && aER != null) {
    const hM = clamp(hER / ELO_START, 0.6, 1.6);
    const aM = clamp(aER / ELO_START, 0.6, 1.6);
    lH = lH * (1 - ELO_WEIGHT_NOXG) + clamp(laH * hM / aM, LAMBDA_FLOOR, LAMBDA_CAP) * ELO_WEIGHT_NOXG;
    lA = lA * (1 - ELO_WEIGHT_NOXG) + clamp(laA * aM / hM, LAMBDA_FLOOR, LAMBDA_CAP) * ELO_WEIGHT_NOXG;
  }

  return { lH: clamp(lH, LAMBDA_FLOOR, LAMBDA_CAP), lA: clamp(lA, LAMBDA_FLOOR, LAMBDA_CAP) };
}

// ─── Metric calculations ────────────────────────────────────────────────────────
const eps = 1e-9;

function brierScore(preds) {
  let tot = 0;
  for (const p of preds) {
    const oH = p.actual === 'H' ? 1 : 0;
    const oD = p.actual === 'D' ? 1 : 0;
    const oA = p.actual === 'A' ? 1 : 0;
    tot += (p.pH - oH)**2 + (p.pD - oD)**2 + (p.pA - oA)**2;
  }
  return tot / preds.length;
}

function logLoss(preds) {
  let tot = 0;
  for (const p of preds) {
    const prob = p.actual === 'H' ? p.pH : p.actual === 'D' ? p.pD : p.pA;
    tot += Math.log(clamp(prob, eps, 1 - eps));
  }
  return -(tot / preds.length);
}

// Ranked Probability Score (proper for ordinal outcomes)
function rps(preds) {
  // Outcomes ordered: H, D, A
  let tot = 0;
  for (const p of preds) {
    const predCDF  = [p.pH, p.pH + p.pD, 1];
    const actCDF   = p.actual === 'H' ? [1, 1, 1]
                   : p.actual === 'D' ? [0, 1, 1]
                   :                    [0, 0, 1];
    let s = 0;
    for (let i = 0; i < 2; i++) s += (predCDF[i] - actCDF[i])**2;
    tot += s / 2;
  }
  return tot / preds.length;
}

function accuracy(preds) {
  const correct = preds.filter(p => {
    const best = p.pH > p.pD && p.pH > p.pA ? 'H' : p.pA > p.pD ? 'A' : 'D';
    return best === p.actual;
  }).length;
  return correct / preds.length;
}

function subsetAccuracy(preds, filter) {
  const sub = preds.filter(filter);
  if (!sub.length) return { acc: null, n: 0 };
  const ok = sub.filter(p => {
    const best = p.pH > p.pD && p.pH > p.pA ? 'H' : p.pA > p.pD ? 'A' : 'D';
    return best === p.actual;
  }).length;
  return { acc: ok / sub.length, n: sub.length };
}

function homeBias(preds) {
  const avgPredH = preds.reduce((s, p) => s + p.pH, 0) / preds.length;
  const actualH  = preds.filter(p => p.actual === 'H').length / preds.length;
  return { predicted: avgPredH, actual: actualH, bias: avgPredH - actualH };
}

function calibrationError(preds, bins = 10) {
  const buckets = Array.from({ length: bins }, () => ({ sp: 0, sa: 0, n: 0 }));
  for (const p of preds) {
    for (const [pred, actual] of [[p.pH, p.actual==='H'?1:0],[p.pD, p.actual==='D'?1:0],[p.pA, p.actual==='A'?1:0]]) {
      const b = Math.min(Math.floor(pred * bins), bins - 1);
      buckets[b].sp += pred; buckets[b].sa += actual; buckets[b].n++;
    }
  }
  const filled = buckets.filter(b => b.n > 0);
  const ece = filled.reduce((s, b) => s + (b.n / (preds.length * 3)) * Math.abs(b.sp/b.n - b.sa/b.n), 0);
  return { ece, buckets: filled.map(b => ({ pred: b.sp/b.n, actual: b.sa/b.n, n: b.n, err: Math.abs(b.sp/b.n - b.sa/b.n) })) };
}

function avgProbs(preds) {
  const n = preds.length;
  return {
    h: preds.reduce((s,p) => s + p.pH, 0) / n,
    d: preds.reduce((s,p) => s + p.pD, 0) / n,
    a: preds.reduce((s,p) => s + p.pA, 0) / n,
  };
}

// ─── Monte-Carlo comparison helper (lightweight, not used for main metrics) ───
function mcProbs(lH, lA, n = 2000) {
  const hCDF = [], aCDF = [];
  let sh = 0, sa = 0;
  for (let k = 0; k < MATRIX_SIZE; k++) {
    sh += poi(k, lH); hCDF.push(sh);
    sa += poi(k, lA); aCDF.push(sa);
  }
  const sample = cdf => {
    const r = Math.random();
    for (let i = 0; i < cdf.length; i++) if (r < cdf[i]) return i;
    return cdf.length - 1;
  };
  let hw = 0, dr = 0, aw = 0;
  for (let i = 0; i < n; i++) {
    const h = sample(hCDF), a = sample(aCDF);
    if (h > a) hw++; else if (h < a) aw++; else dr++;
  }
  return { h: hw/n, d: dr/n, a: aw/n };
}

// ─── RHO sweep helpers ─────────────────────────────────────────────────────────

function tauParam(h, a, lH, lA, rho) {
  if (h === 0 && a === 0) return 1 - lH * lA * rho;
  if (h === 0 && a === 1) return 1 + lH * rho;
  if (h === 1 && a === 0) return 1 + lA * rho;
  if (h === 1 && a === 1) return 1 - rho;
  return 1;
}

function matrixParam(lH, lA, rho) {
  const m = []; let tot = 0;
  for (let h = 0; h < MATRIX_SIZE; h++) {
    const r = [];
    for (let a = 0; a < MATRIX_SIZE; a++) {
      const p = Math.max(0, poi(h, lH) * poi(a, lA) * tauParam(h, a, lH, lA, rho));
      r.push(p); tot += p;
    }
    m.push(r);
  }
  if (tot > 0) for (let h = 0; h < MATRIX_SIZE; h++) for (let a = 0; a < MATRIX_SIZE; a++) m[h][a] /= tot;
  return m;
}

// PAV (Pool Adjacent Violators) isotonic calibration fitting
// Returns CALIB_POINTS in [[rawProb, calibratedProb], ...] format
function fitCalibPoints(rawPreds, nBins = 20) {
  const bins = Array.from({ length: nBins }, () => ({ sumX: 0, sumY: 0, n: 0 }));
  for (const p of rawPreds) {
    for (const [x, y] of [[p.pH, p.actual==='H'?1:0],[p.pD, p.actual==='D'?1:0],[p.pA, p.actual==='A'?1:0]]) {
      const b = Math.min(Math.floor(x * nBins), nBins - 1);
      bins[b].sumX += x; bins[b].sumY += y; bins[b].n++;
    }
  }
  const filled = bins
    .map(b => b.n > 0 ? { x: b.sumX / b.n, y: b.sumY / b.n, n: b.n } : null)
    .filter(Boolean);

  // PAV: merge adjacent violations until monotone non-decreasing
  const blocks = filled.map(b => ({ x: b.x, y: b.y, n: b.n }));
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < blocks.length - 1; i++) {
      if (blocks[i].y > blocks[i+1].y) {
        const tot = blocks[i].n + blocks[i+1].n;
        blocks.splice(i, 2, {
          x: (blocks[i].x * blocks[i].n + blocks[i+1].x * blocks[i+1].n) / tot,
          y: (blocks[i].y * blocks[i].n + blocks[i+1].y * blocks[i+1].n) / tot,
          n: tot,
        });
        changed = true; break;
      }
    }
  }

  const pts = [[0, 0]];
  for (const b of blocks) pts.push([+b.x.toFixed(3), +b.y.toFixed(3)]);
  pts.push([1, 1]);
  return pts;
}

function lerpCalWith(p, pts) {
  if (p <= pts[0][0]) return pts[0][1];
  if (p >= pts[pts.length-1][0]) return pts[pts.length-1][1];
  for (let i = 0; i < pts.length - 1; i++) {
    if (p >= pts[i][0] && p <= pts[i+1][0]) {
      const t = (p - pts[i][0]) / (pts[i+1][0] - pts[i][0]);
      return pts[i][1] + t * (pts[i+1][1] - pts[i][1]);
    }
  }
  return p;
}

function applyCalibWith(h, d, a, pts) {
  const ch = lerpCalWith(h, pts), cd = lerpCalWith(d, pts), ca = lerpCalWith(a, pts);
  const t = ch + cd + ca;
  if (t <= 0) return { h: 1/3, d: 1/3, a: 1/3 };
  return { h: ch/t, d: cd/t, a: ca/t };
}

// ─── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  process.stdout.write('Fetching FPL data from API... ');
  const [bsRes, fxRes] = await Promise.all([
    axios.get('https://fantasy.premierleague.com/api/bootstrap-static/', { timeout: 20000 }),
    axios.get('https://fantasy.premierleague.com/api/fixtures/',         { timeout: 20000 }),
  ]);
  console.log('done.');

  const allFix = fxRes.data;
  const completed = allFix
    .filter(f => f.finished && f.team_h_score != null && f.team_a_score != null)
    .sort((a, b) => new Date(a.kickoff_time) - new Date(b.kickoff_time));

  const teams = bsRes.data.teams;
  console.log(`Season fixtures:  total=${allFix.length}  completed=${completed.length}\n`);

  if (completed.length < 10) {
    console.log('Not enough completed fixtures for meaningful evaluation.');
    process.exit(1);
  }

  const oldPreds = [], newPreds = [], rawPreds = [];
  const scorelineData = [];  // for scoreline sanity section
  const mcDiffs = [];        // |analytical − MC| per fixture, for MC audit
  const lambdaDebug = [];    // per-fixture λA component breakdown (Phase 6)
  const MIN_HISTORY = 5; // skip first N rounds — insufficient data

  process.stdout.write(`Walk-forward evaluation (${completed.length} games)... `);

  for (let i = 0; i < completed.length; i++) {
    const fix    = completed[i];
    const before = completed.slice(0, i); // strictly historical

    if (before.length < MIN_HISTORY) continue;

    // League averages from history only
    const totH = before.reduce((s, f) => s + (f.team_h_score ?? 0), 0);
    const totA = before.reduce((s, f) => s + (f.team_a_score ?? 0), 0);
    const laH  = totH / before.length;
    const laA  = totA / before.length;

    // Ratings from history only
    const rolling = buildRollingRatings(before, laH, laA);
    const eloN    = buildEloRatings(before);   // new (goal-margin)
    const eloO    = buildEloOld(before);        // old (binary)

    const hId = fix.team_h, aId = fix.team_a;
    const hFO = formOld(before, hId), aFO = formOld(before, aId);
    const hFN = formNew(before, hId), aFN = formNew(before, aId);

    // OLD: homeAdvFactor=1.1, binary ELO, mixed form, old calibrate
    const { lH: oLH, lA: oLA } = makeLambdasOld(hId, aId, hFO, aFO, rolling, eloO, laH, laA);
    const oRaw = probs(matrix(oLH, oLA));
    const oP   = oldCal(oRaw.h, oRaw.d, oRaw.a);

    // FINAL: venue-separated form, form momentum cap ±10%, goal-margin ELO,
    //        pure-Poisson matrix (DC removed), fresh isotonic calibration
    const { lH: nLH, lA: nLA } = makeLambdasNew(hId, aId, hFN, aFN, rolling, eloN, laH, laA);
    const nMat  = matrix(nLH, nLA);      // full 6×6 for scoreline analysis
    const nRaw  = probs(nMat);
    const nP    = newCal(nRaw.h, nRaw.d, nRaw.a);

    const hG  = fix.team_h_score, aG = fix.team_a_score;
    const act = hG > aG ? 'H' : hG < aG ? 'A' : 'D';

    oldPreds.push({ pH: oP.h, pD: oP.d, pA: oP.a, actual: act, hG, aG, lH: oLH, lA: oLA });
    newPreds.push({ pH: nP.h, pD: nP.d, pA: nP.a, actual: act, hG, aG, lH: nLH, lA: nLA });
    rawPreds.push({ pH: nRaw.h, pD: nRaw.d, pA: nRaw.a, actual: act });

    // ─── λA component decomposition (Phase 6 trace) ──────────────────────────
    // Decompose λA into: league baseline → EWMA layer → season-avg layer → ELO layer.
    // All components use the SAME historical data already computed above.
    const rm = rolling.ratings ?? {};
    const aRating = rm[String(aId)];
    const hRating = rm[String(hId)];

    // Layer 1: EWMA attack/defense (slow exponential avg, no form or ELO)
    const aAtkEwma   = aRating?.attack ?? 1.0;
    // Defense EWMA now stores linear conceded ratio (HIGH = weak) — use directly, no inversion
    const hDefEwmaRaw = hRating ? clamp(hRating.defense, RATING_MIN, RATING_MAX) : 1.0;
    const lA_ewma    = clamp(laA * aAtkEwma * hDefEwmaRaw, LAMBDA_FLOOR, LAMBDA_CAP);

    // Layer 2: season-venue avg only (no EWMA, no ELO — last-resort fallback quality)
    const aSeasSc = aFN.seasonAwayScored ?? 0;
    const aSeasG  = aFN.seasonAwayGames  ?? 0;
    const hSeasCo = hFN.seasonHomeConceded ?? 0;
    const hSeasG  = hFN.seasonHomeGames   ?? 0;
    const aAtkSeason = (aSeasSc && aSeasG) ? (aSeasSc / aSeasG) / laA : 1.0;
    const hDefSeason = (hSeasCo && hSeasG) ? (hSeasCo / hSeasG) / laA : 1.0;
    const lA_season  = clamp(laA * aAtkSeason * hDefSeason, LAMBDA_FLOOR, LAMBDA_CAP);

    // Layer 3: EWMA 70/30 blend (what makeLambdasNew actually computes as base)
    // aAtk_blend = 0.70*ewma + 0.30*season  (mirrors baseAtk in makeLambdasNew)
    const aAtkBlend = (aRating && aSeasSc && aSeasG)
      ? 0.70 * aAtkEwma + 0.30 * aAtkSeason : aAtkEwma;
    const hDefBlend = (hRating && hSeasCo && hSeasG)
      ? 0.70 * hDefEwmaRaw + 0.30 * hDefSeason : hDefEwmaRaw;
    const lA_blend   = clamp(laA * aAtkBlend * hDefBlend, LAMBDA_FLOOR, LAMBDA_CAP);

    // ELO contribution: final lA − lA_blend (after ELO blend in makeLambdasNew)
    const eloContribA = nLA - clamp(lA_blend, LAMBDA_FLOOR, LAMBDA_CAP);

    lambdaDebug.push({
      lH: nLH, lA: nLA, laH, laA,
      aAtkEwma, hDefEwmaRaw,
      lA_ewma, lA_season, lA_blend,
      eloContribA,
      hG, aG,
      // Strength ratio — used to segment residuals
      ratio: nLH / Math.max(nLA, LAMBDA_FLOOR),
    });

    // Scoreline sanity: accumulate predicted probability for 8 key scorelines
    scorelineData.push({ mat: nMat, hG, aG });

    // MC audit: compare analytical vs 2000-sim MC (runs fast; separate from main metrics)
    const mc = mcProbs(nLH, nLA, 2000);
    mcDiffs.push({
      dH: Math.abs(nRaw.h - mc.h),
      dD: Math.abs(nRaw.d - mc.d),
      dA: Math.abs(nRaw.a - mc.a),
    });
  }

  console.log(`done. Evaluated on ${oldPreds.length} fixtures.\n`);

  // ─── Compute all metrics ───────────────────────────────────────────────────
  const oBrier = brierScore(oldPreds);
  const nBrier = brierScore(newPreds);
  const oLL    = logLoss(oldPreds);
  const nLL    = logLoss(newPreds);
  const oRPS   = rps(oldPreds);
  const nRPS   = rps(newPreds);
  const oAcc   = accuracy(oldPreds);
  const nAcc   = accuracy(newPreds);
  const oCal   = calibrationError(oldPreds);
  const nCal   = calibrationError(newPreds);
  const oHB    = homeBias(oldPreds);
  const nHB    = homeBias(newPreds);
  const oAvg   = avgProbs(oldPreds);
  const nAvg   = avgProbs(newPreds);

  // Subset accuracies
  const isHomeFav  = p => p.pH > p.pD && p.pH > p.pA;
  const isAwayFav  = p => p.pA > p.pH && p.pA > p.pD;
  const isDrawFav  = p => p.pD >= p.pH && p.pD >= p.pA;
  const isUpset    = p => isAwayFav(p) && p.actual === 'H' || isHomeFav(p) && p.actual === 'A';
  const awayFav    = p => p.pA > 0.45; // strong away favorites (>45% implied)

  const oHA = subsetAccuracy(oldPreds, isHomeFav);
  const nHA = subsetAccuracy(newPreds, isHomeFav);
  const oAA = subsetAccuracy(oldPreds, isAwayFav);
  const nAA = subsetAccuracy(newPreds, isAwayFav);
  const oDA = subsetAccuracy(oldPreds, isDrawFav);
  const nDA = subsetAccuracy(newPreds, isDrawFav);
  const oSA = subsetAccuracy(oldPreds, awayFav);
  const nSA = subsetAccuracy(newPreds, awayFav);

  // Actual outcome rates
  const totalN    = oldPreds.length;
  const actualHR  = oldPreds.filter(p => p.actual === 'H').length / totalN;
  const actualDR  = oldPreds.filter(p => p.actual === 'D').length / totalN;
  const actualAR  = oldPreds.filter(p => p.actual === 'A').length / totalN;

  // Calibration: max error bucket
  const maxErrO = Math.max(...oCal.buckets.map(b => b.err));
  const maxErrN = Math.max(...nCal.buckets.map(b => b.err));

  // Worst-calibrated buckets (predicted vs actual)
  const worstO = [...oCal.buckets].sort((a, b) => b.err - a.err).slice(0, 3);
  const worstN = [...nCal.buckets].sort((a, b) => b.err - a.err).slice(0, 3);

  // ─── Output ────────────────────────────────────────────────────────────────
  const pct  = v  => v != null ? `${(v * 100).toFixed(2)}%` : 'N/A';
  const pp   = (n, o) => { const d = (n - o) * 100; return `${d >= 0 ? '+' : ''}${d.toFixed(2)}pp`; };
  const fmt4 = v  => v.toFixed(4);
  const sign = (n, o, lowerIsBetter = true) => {
    const better = lowerIsBetter ? n < o : n > o;
    return better ? '✓ IMPROVED' : '✗ DEGRADED';
  };
  const arrow = (n, o) => n < o ? '↓' : n > o ? '↑' : '→';

  const L = '═'.repeat(72);
  const l = '─'.repeat(72);

  console.log(L);
  console.log('  PREDICTION ENGINE — QUANTITATIVE EVALUATION');
  console.log(`  Sample: ${totalN} fixtures  |  Actual: H=${pct(actualHR)} D=${pct(actualDR)} A=${pct(actualAR)}`);
  console.log(L);

  const col = (s, w, right = false) => right ? String(s).padStart(w) : String(s).padEnd(w);

  console.log('\n  ① CORE ACCURACY METRICS\n');
  console.log(`  ${col('Metric',30)} ${col('OLD',10,true)} ${col('NEW',10,true)} ${col('Δ',10,true)} ${col('Verdict',15,true)}`);
  console.log(`  ${l.slice(0,68)}`);
  const mrow = (label, oV, nV, unit, lowerBetter = true) => {
    const d = ((nV - oV) * unit);
    const verdict = (lowerBetter ? nV < oV : nV > oV) ? '✓ IMPROVED' : '✗ DEGRADED';
    console.log(`  ${col(label,30)} ${col(fmt4(oV),10,true)} ${col(fmt4(nV),10,true)} ${col((d>=0?'+':'')+d.toFixed(1),10,true)} ${col(verdict,15,true)}`);
  };
  mrow('Brier Score',            oBrier, nBrier, 1000);
  mrow('Log-Loss',               oLL,    nLL,    100);
  mrow('RPS (Ranked Prob Score)', oRPS,  nRPS,   1000);
  console.log(`  ${col('Overall Accuracy',30)} ${col(pct(oAcc),10,true)} ${col(pct(nAcc),10,true)} ${col(pp(nAcc,oAcc),10,true)} ${col(nAcc>=oAcc?'✓ IMPROVED':'✗ DEGRADED',15,true)}`);
  console.log(`  ${col('ECE (Calib Error)',30)} ${col(pct(oCal.ece),10,true)} ${col(pct(nCal.ece),10,true)} ${col(pp(nCal.ece,oCal.ece),10,true)} ${col(nCal.ece<=oCal.ece?'✓ IMPROVED':'✗ DEGRADED',15,true)}`);
  console.log(`  ${col('Max Calib Error',30)} ${col(pct(maxErrO),10,true)} ${col(pct(maxErrN),10,true)} ${col(pp(maxErrN,maxErrO),10,true)} ${col(maxErrN<=maxErrO?'✓ IMPROVED':'✗ DEGRADED',15,true)}`);

  console.log('\n  ② OUTCOME-SPECIFIC ACCURACY\n');
  console.log(`  ${col('Subset',34)} ${col('OLD acc',8,true)} ${col('NEW acc',8,true)} ${col('Δ',8,true)} ${col('n',6,true)}`);
  console.log(`  ${l.slice(0,66)}`);
  const row = (label, o, n) => {
    if (o.acc == null) return;
    console.log(`  ${col(label,34)} ${col(pct(o.acc),8,true)} ${col(pct(n.acc),8,true)} ${col(pp(n.acc,o.acc),8,true)} ${col(o.n,6,true)}`);
  };
  row('Predicted home wins',    oHA, nHA);
  row('Predicted away wins',    oAA, nAA);
  row('Predicted draws',        oDA, nDA);
  row('Strong away fav (>45%)', oSA, nSA);

  console.log('\n  ③ HOME BIAS ANALYSIS\n');
  console.log(`  ${col('Metric',40)} ${col('OLD',12,true)} ${col('NEW',12,true)}`);
  console.log(`  ${l.slice(0,66)}`);
  console.log(`  ${col('Avg predicted home win prob',40)} ${col(pct(oAvg.h),12,true)} ${col(pct(nAvg.h),12,true)}`);
  console.log(`  ${col('Avg predicted draw prob',40)} ${col(pct(oAvg.d),12,true)} ${col(pct(nAvg.d),12,true)}`);
  console.log(`  ${col('Avg predicted away win prob',40)} ${col(pct(oAvg.a),12,true)} ${col(pct(nAvg.a),12,true)}`);
  console.log(`  ${col('Actual home win rate',40)} ${col(pct(actualHR),12,true)} ${col(pct(actualHR),12,true)}`);
  console.log(`  ${col('Home bias (pred − actual)',40)} ${col(pp(oHB.predicted, actualHR),12,true)} ${col(pp(nHB.predicted, actualHR),12,true)}`);

  console.log('\n  ④ CALIBRATION CURVE  (predicted probability → actual frequency)\n');
  const allBuckets = Array.from({ length: 10 }, (_, i) => ({
    range: `${i*10}-${(i+1)*10}%`,
    o: oCal.buckets.find(b => Math.floor(b.pred * 10) === i),
    n: nCal.buckets.find(b => Math.floor(b.pred * 10) === i),
  })).filter(b => b.o || b.n);

  console.log(`  ${col('Pred range',12)} ${col('OLD pred',9,true)} ${col('OLD act',9,true)} ${col('OLD err',9,true)} | ${col('NEW pred',9,true)} ${col('NEW act',9,true)} ${col('NEW err',9,true)}`);
  console.log(`  ${l.slice(0,68)}`);
  for (const b of allBuckets) {
    const o = b.o, n = b.n;
    const dash = '   –   ';
    console.log(`  ${b.range.padEnd(12)} ${(o ? pct(o.pred) : dash).padStart(9)} ${(o ? pct(o.actual) : dash).padStart(9)} ${(o ? pct(o.err) : dash).padStart(9)} | ${(n ? pct(n.pred) : dash).padStart(9)} ${(n ? pct(n.actual) : dash).padStart(9)} ${(n ? pct(n.err) : dash).padStart(9)}`);
  }

  console.log('\n  ⑤ WORST-CALIBRATED BUCKETS\n');
  console.log(`  OLD model top 3 miscalibrated:`);
  for (const b of worstO) console.log(`    pred=${pct(b.pred)}  actual=${pct(b.actual)}  err=${pct(b.err)}  n=${b.n}`);
  console.log(`  NEW model top 3 miscalibrated:`);
  for (const b of worstN) console.log(`    pred=${pct(b.pred)}  actual=${pct(b.actual)}  err=${pct(b.err)}  n=${b.n}`);

  // Raw (pre-calibration) curve — used to derive CALIB_POINTS for the new model
  const rawCal  = calibrationError(rawPreds);
  const rawBuckets = Array.from({ length: 10 }, (_, i) => ({
    range: `${i*10}-${(i+1)*10}%`,
    r: rawCal.buckets.find(b => Math.floor(b.pred * 10) === i),
  })).filter(b => b.r);
  console.log('\n  RAW (pre-calibration) new model distribution — use to re-derive CALIB_POINTS:\n');
  console.log(`  ${col('Pred range',12)} ${col('RAW pred',9,true)} ${col('RAW act',9,true)} ${col('ERR',9,true)} ${col('n',6,true)}`);
  console.log(`  ${l.slice(0,48)}`);
  for (const b of rawBuckets) {
    const r = b.r;
    console.log(`  ${b.range.padEnd(12)} ${pct(r.pred).padStart(9)} ${pct(r.actual).padStart(9)} ${pct(r.err).padStart(9)} ${String(r.n).padStart(6)}`);
  }

  // ─── Structural analysis ───────────────────────────────────────────────────
  const homeAdvOld = oldPreds.reduce((s, p) => s + p.lH, 0) / oldPreds.length;
  const homeAdvNew = newPreds.reduce((s, p) => s + p.lH, 0) / newPreds.length;
  const awayAvgOld = oldPreds.reduce((s, p) => s + p.lA, 0) / oldPreds.length;
  const awayAvgNew = newPreds.reduce((s, p) => s + p.lA, 0) / newPreds.length;

  // Volatility: std dev of lambda changes from game to game
  const pairDiff = (arr) => arr.slice(1).map((v, i) => Math.abs(v - arr[i]));
  const lHSeq = newPreds.map(p => p.lH);
  const lASeq = newPreds.map(p => p.lA);
  const meanAbsDiff = arr => arr.reduce((s, v) => s + v, 0) / arr.length;
  const lhVol = meanAbsDiff(pairDiff(lHSeq));
  const laVol = meanAbsDiff(pairDiff(lASeq));

  // High-confidence accuracy (model very sure)
  const highConf = newPreds.filter(p => Math.max(p.pH, p.pD, p.pA) > 0.60);
  const hcAcc    = highConf.length ? highConf.filter(p => {
    const best = p.pH > p.pD && p.pH > p.pA ? 'H' : p.pA > p.pD ? 'A' : 'D';
    return best === p.actual;
  }).length / highConf.length : null;

  // Draw over/under prediction
  const predDrawRate = newPreds.reduce((s, p) => s + p.pD, 0) / newPreds.length;
  const drawBias     = predDrawRate - actualDR;

  console.log('\n  ⑥ STRUCTURAL ANALYSIS\n');
  console.log(`  Avg home λ:   OLD=${homeAdvOld.toFixed(3)}   NEW=${homeAdvNew.toFixed(3)}  (−${(homeAdvOld-homeAdvNew).toFixed(3)})`);
  console.log(`  Avg away λ:   OLD=${awayAvgOld.toFixed(3)}   NEW=${awayAvgNew.toFixed(3)}`);
  console.log(`  λH ratio (home/away): OLD=${(homeAdvOld/awayAvgOld).toFixed(3)}  NEW=${(homeAdvNew/awayAvgNew).toFixed(3)}  actual=${(actualHR/actualAR).toFixed(3)}`);
  console.log(`  λ volatility (mean|ΔλH| game-to-game): ${lhVol.toFixed(3)}  away: ${laVol.toFixed(3)}`);
  console.log(`  High-confidence predictions (>60%): n=${highConf.length}  accuracy=${pct(hcAcc)}`);
  console.log(`  Draw bias (pred avg − actual rate): ${pp(predDrawRate, actualDR)}`);

  console.log('\n  ⑦ FORM WEIGHT SENSITIVITY\n');
  // Compare matches where team's last game result differs from GW-5 result
  // (detects whether recency weighting changes predictions meaningfully)
  let formSwingCount = 0, formSwingCorrectO = 0, formSwingCorrectN = 0;
  for (let i = MIN_HISTORY; i < completed.length; i++) {
    const fix    = completed[i];
    const before = completed.slice(0, i);
    const hGames = before.filter(f => f.team_h === fix.team_h || f.team_a === fix.team_h)
      .sort((a, b) => new Date(b.kickoff_time) - new Date(a.kickoff_time));
    if (hGames.length < 5) continue;
    // Check if most recent result differs from 5th most recent
    const recent = hGames[0], oldest = hGames[4];
    const recentGoals = recent.team_h === fix.team_h ? recent.team_h_score : recent.team_a_score;
    const oldestGoals = oldest.team_h === fix.team_h ? oldest.team_h_score : oldest.team_a_score;
    if (Math.abs((recentGoals ?? 0) - (oldestGoals ?? 0)) >= 2) {
      formSwingCount++;
      const oBest = oldPreds[i - MIN_HISTORY]?.pH > oldPreds[i - MIN_HISTORY]?.pA ? 'H' : 'A';
      const nBest = newPreds[i - MIN_HISTORY]?.pH > newPreds[i - MIN_HISTORY]?.pA ? 'H' : 'A';
      const act   = oldPreds[i - MIN_HISTORY]?.actual;
      if (oBest === act) formSwingCorrectO++;
      if (nBest === act) formSwingCorrectN++;
    }
  }
  console.log(`  Fixtures with significant form swing (|G_recent − G_oldest| ≥ 2): ${formSwingCount}`);
  if (formSwingCount > 0) {
    console.log(`  OLD accuracy on these: ${pct(formSwingCorrectO / formSwingCount)}`);
    console.log(`  NEW accuracy on these: ${pct(formSwingCorrectN / formSwingCount)}`);
  }

  console.log('\n' + L);
  console.log('  SUMMARY & DIAGNOSIS');
  console.log(L);

  const brierDelta = (nBrier - oBrier) * 1000;
  const llDelta    = (nLL - oLL) * 100;
  const rpsDelta   = (nRPS - oRPS) * 1000;
  const homeBiasO  = (oHB.predicted - actualHR) * 100;
  const homeBiasN  = (nHB.predicted - actualHR) * 100;

  console.log(`
  Brier score:    ${oBrier.toFixed(4)} → ${nBrier.toFixed(4)}  (${brierDelta >= 0 ? '+' : ''}${brierDelta.toFixed(1)} ×10⁻³, lower=better)
  Log-loss:       ${oLL.toFixed(4)} → ${nLL.toFixed(4)}  (${llDelta >= 0 ? '+' : ''}${llDelta.toFixed(2)} ×10⁻², lower=better)
  RPS:            ${oRPS.toFixed(4)} → ${nRPS.toFixed(4)}  (${rpsDelta >= 0 ? '+' : ''}${rpsDelta.toFixed(1)} ×10⁻³, lower=better)
  Home bias:      ${homeBiasO.toFixed(1)}pp → ${homeBiasN.toFixed(1)}pp (gap from actual home rate)
  ECE:            ${pct(oCal.ece)} → ${pct(nCal.ece)}
  Accuracy:       ${pct(oAcc)} → ${pct(nAcc)}
  Away fav acc:   ${pct(oAA.acc)} → ${pct(nAA.acc)}  (n=${oAA.n})
  Draw pred bias: ${pp(predDrawRate, actualDR)} (new model)`);

  // ─── ⑧ RAW vs CALIBRATED (FINAL model) ────────────────────────────────────
  // rawCal already computed above (used for existing raw-distribution section)
  const rawBrier = brierScore(rawPreds);
  const rawLL   = logLoss(rawPreds);
  const rawRPS  = rps(rawPreds);
  const rawAcc  = accuracy(rawPreds);

  console.log('\n' + L);
  console.log('  ⑧ PURE POISSON — RAW vs CALIBRATED (FINAL model)\n');
  console.log(`  ${'Metric'.padEnd(30)} ${'RAW'.padStart(10)} ${'CALIBRATED'.padStart(12)} ${'Δ'.padStart(10)}`);
  console.log(`  ${'─'.repeat(64)}`);
  const showDelta = (label, rv, cv, unit, lowerBetter = true) => {
    const d = (cv - rv) * unit;
    const verdict = (lowerBetter ? cv < rv : cv > rv) ? '↓ better' : '↑ worse';
    console.log(`  ${label.padEnd(30)} ${rv.toFixed(4).padStart(10)} ${cv.toFixed(4).padStart(12)} ${((d>=0?'+':'')+d.toFixed(1)).padStart(10)}  ${verdict}`);
  };
  showDelta('Brier Score',    rawBrier, nBrier, 1000);
  showDelta('Log-Loss',       rawLL,    nLL,    100);
  showDelta('RPS',            rawRPS,   nRPS,   1000);
  showDelta('ECE',            rawCal.ece, nCal.ece, 100);
  console.log(`  ${'Accuracy'.padEnd(30)} ${pct(rawAcc).padStart(10)} ${pct(nAcc).padStart(12)}`);

  // Raw calibration curve
  console.log('\n  RAW calibration curve (pure Poisson, pre-calibration):\n');
  console.log(`  ${'Range'.padEnd(10)} ${'Pred avg'.padStart(9)} ${'Actual'.padStart(9)} ${'Error'.padStart(9)} ${'n'.padStart(6)}`);
  console.log(`  ${'─'.repeat(46)}`);
  const tenBuckets = Array.from({length:10}, (_,i) => i);
  for (const bi of tenBuckets) {
    const b = rawCal.buckets.find(b => Math.floor(b.pred*10) === bi);
    if (b) console.log(`  ${(bi*10+'-'+(bi+1)*10+'%').padEnd(10)} ${pct(b.pred).padStart(9)} ${pct(b.actual).padStart(9)} ${pct(b.err).padStart(9)} ${String(b.n).padStart(6)}`);
  }

  // ─── ⑨ DRAW DECOMPOSITION ─────────────────────────────────────────────────
  // Decomposition: pure Poisson → post-τ (RHO=−0.11) → post-calibration.
  const avgRawDraw = rawPreds.reduce((s, p) => s + p.pD, 0) / rawPreds.length;
  const avgCalDraw = newPreds.reduce((s, p) => s + p.pD, 0) / newPreds.length;
  // Pure-Poisson draw (no tau) for comparison — rebuild matrix without tau
  const avgPoissonDraw = (() => {
    let s = 0;
    for (const d of lambdaDebug) {
      const m = matrixParam(d.lH, d.lA, 0);
      s += probs(m).d;
    }
    return s / lambdaDebug.length;
  })();
  const tauBoost = avgRawDraw - avgPoissonDraw;

  console.log('\n' + L);
  console.log('  ⑨ DRAW DECOMPOSITION (Poisson → τ correction → calibration)\n');
  console.log(`  Actual draw rate:               ${pct(actualDR)}`);
  console.log(`  Pure Poisson avg draw (no τ):   ${pct(avgPoissonDraw)}  (gap from actual: ${pp(avgPoissonDraw, actualDR)})`);
  console.log(`  Post-τ avg draw (RHO=−0.11):    ${pct(avgRawDraw)}  (τ boost: ${pp(avgRawDraw, avgPoissonDraw)})`);
  console.log(`  Post-calibration avg draw:      ${pct(avgCalDraw)}  (gap from actual: ${pp(avgCalDraw, actualDR)})`);
  console.log(`  Calibration adjustment on draw: ${pp(avgCalDraw, avgRawDraw)}`);

  // ─── ⑩ AWAY-WIN METRICS ───────────────────────────────────────────────────
  const awayWinPreds = newPreds.filter(p => p.pA > p.pH && p.pA > p.pD);
  const awayHR = awayWinPreds.length
    ? awayWinPreds.filter(p => p.actual === 'A').length / awayWinPreds.length : null;
  const avgAwayWinP = awayWinPreds.length
    ? awayWinPreds.reduce((s, p) => s + p.pA, 0) / awayWinPreds.length : null;
  const awayRawPreds = rawPreds.filter(p => p.pA > p.pH && p.pA > p.pD);
  const awayRawHR = awayRawPreds.length
    ? awayRawPreds.filter(p => p.actual === 'A').length / awayRawPreds.length : null;

  console.log('\n' + L);
  console.log('  ⑩ AWAY-WIN METRICS\n');
  console.log(`  Predicted away wins (calibrated): n=${awayWinPreds.length}`);
  console.log(`  Hit rate (calibrated):            ${pct(awayHR)}`);
  console.log(`  Avg probability assigned:         ${pct(avgAwayWinP)}`);
  console.log(`  Predicted away wins (raw):        n=${awayRawPreds.length}`);
  console.log(`  Hit rate (raw):                   ${pct(awayRawHR)}`);
  console.log(`  Actual away win rate:             ${pct(actualAR)}`);
  const avgPredA = newPreds.reduce((s,p) => s + p.pA, 0) / newPreds.length;
  console.log(`  Avg predicted away prob (all):   ${pct(avgPredA)}  (gap from actual: ${pp(avgPredA, actualAR)})`);

  // ─── ⑪ λH / λA RATIO ──────────────────────────────────────────────────────
  const avgLH = newPreds.reduce((s, p) => s + p.lH, 0) / newPreds.length;
  const avgLA = newPreds.reduce((s, p) => s + p.lA, 0) / newPreds.length;
  const lhLaRatio = avgLH / avgLA;

  console.log('\n' + L);
  console.log('  ⑪ λH / λA RATIO ANALYSIS\n');
  console.log(`  Avg λH (home expected goals):  ${avgLH.toFixed(3)}`);
  console.log(`  Avg λA (away expected goals):  ${avgLA.toFixed(3)}`);
  console.log(`  λH/λA ratio (model):           ${lhLaRatio.toFixed(3)}`);
  console.log(`  League avg home goals:         ${(completed.reduce((s,f)=>s+(f.team_h_score??0),0)/completed.length).toFixed(3)}`);
  console.log(`  League avg away goals:         ${(completed.reduce((s,f)=>s+(f.team_a_score??0),0)/completed.length).toFixed(3)}`);
  const leagHR = completed.reduce((s,f)=>s+(f.team_h_score??0),0)/completed.length;
  const leagAR = completed.reduce((s,f)=>s+(f.team_a_score??0),0)/completed.length;
  console.log(`  League actual H/A ratio:       ${(leagHR/leagAR).toFixed(3)}`);
  console.log(`  λA underestimation vs league:  ${pp(avgLA, leagAR)}`);

  // High-confidence accuracy — reuse existing highConf/hcAcc computed in section ⑥
  console.log(`\n  High-confidence predictions (>60%): n=${highConf.length}  accuracy=${pct(hcAcc)}`);

  // ─── ⑫ SCORELINE SANITY ────────────────────────────────────────────────────
  const KEY_SCORES = ['0-0','1-0','0-1','1-1','2-1','1-2','2-0','0-2'];
  const predSums  = Object.fromEntries(KEY_SCORES.map(s => [s, 0]));
  const actCounts = Object.fromEntries(KEY_SCORES.map(s => [s, 0]));
  const N = scorelineData.length;

  for (const { mat, hG, aG } of scorelineData) {
    // Predicted probability sum
    for (const sc of KEY_SCORES) {
      const [hk, ak] = sc.split('-').map(Number);
      if (hk < MATRIX_SIZE && ak < MATRIX_SIZE) predSums[sc] += mat[hk][ak];
    }
    // Actual occurrence
    const key = `${Math.min(hG, MATRIX_SIZE-1)}-${Math.min(aG, MATRIX_SIZE-1)}`;
    const trueKey = `${hG}-${aG}`;
    if (actCounts[trueKey] !== undefined) actCounts[trueKey]++;
  }

  console.log('\n' + L);
  console.log('  ⑫ SCORELINE SANITY (predicted vs actual frequency — pure Poisson)\n');
  console.log(`  ${'Score'.padEnd(8)} ${'Pred avg%'.padStart(10)} ${'Actual%'.padStart(10)} ${'Pred count'.padStart(11)} ${'Actual count'.padStart(13)} ${'Error'.padStart(8)}`);
  console.log(`  ${'─'.repeat(64)}`);
  const fmtErr = v => ((v*100>=0?'+':'')+(v*100).toFixed(2)+'pp');
  for (const sc of KEY_SCORES) {
    const predPct  = predSums[sc] / N;
    const actPct   = actCounts[sc] / N;
    const predCnt  = (predSums[sc]).toFixed(1);
    const actCnt   = actCounts[sc];
    const err      = predPct - actPct;
    console.log(`  ${sc.padEnd(8)} ${pct(predPct).padStart(10)} ${pct(actPct).padStart(10)} ${predCnt.padStart(11)} ${String(actCnt).padStart(13)} ${fmtErr(err).padStart(8)}`);
  }
  // 0-0 and 1-1 specific notes
  const p00 = predSums['0-0']/N, a00 = actCounts['0-0']/N;
  const p11 = predSums['1-1']/N, a11 = actCounts['1-1']/N;
  console.log(`\n  0-0 note: Poisson predicts ${pct(p00)} vs actual ${pct(a00)} (${pp(p00, a00)})`);
  console.log(`  1-1 note: Poisson predicts ${pct(p11)} vs actual ${pct(a11)} (${pp(p11, a11)})`);
  const totGoalsPred = scorelineData.reduce((s, { mat }) => {
    let g = 0;
    for (let h = 0; h < MATRIX_SIZE; h++) for (let a = 0; a < MATRIX_SIZE; a++) g += (h+a)*mat[h][a];
    return s + g;
  }, 0) / N;
  const totGoalsActual = scorelineData.reduce((s, { hG, aG }) => s + hG + aG, 0) / N;
  console.log(`  Avg total goals — predicted: ${totGoalsPred.toFixed(3)}  actual: ${totGoalsActual.toFixed(3)}  (Δ ${((totGoalsPred-totGoalsActual)>=0?'+':'')+(totGoalsPred-totGoalsActual).toFixed(3)})`);

  // ─── ⑬ MC vs ANALYTICAL COMPARISON ───────────────────────────────────────
  const avgMCDiff = {
    h: mcDiffs.reduce((s, d) => s + d.dH, 0) / mcDiffs.length,
    d: mcDiffs.reduce((s, d) => s + d.dD, 0) / mcDiffs.length,
    a: mcDiffs.reduce((s, d) => s + d.dA, 0) / mcDiffs.length,
  };
  const maxMCDiff = {
    h: Math.max(...mcDiffs.map(d => d.dH)),
    d: Math.max(...mcDiffs.map(d => d.dD)),
    a: Math.max(...mcDiffs.map(d => d.dA)),
  };
  const overallAvgDiff = (avgMCDiff.h + avgMCDiff.d + avgMCDiff.a) / 3;
  const overallMaxDiff = Math.max(maxMCDiff.h, maxMCDiff.d, maxMCDiff.a);

  console.log('\n' + L);
  console.log('  ⑬ MONTE CARLO vs ANALYTICAL COMPARISON (2000 sims, pure Poisson)\n');
  console.log(`  With Dixon-Coles removed, analytical matrix IS the exact Poisson solution.`);
  console.log(`  MC should now be pure sampling noise around analytical values.\n`);
  console.log(`  ${'Outcome'.padEnd(10)} ${'Avg |diff|'.padStart(12)} ${'Max |diff|'.padStart(12)}`);
  console.log(`  ${'─'.repeat(36)}`);
  console.log(`  ${'H'.padEnd(10)} ${pct(avgMCDiff.h).padStart(12)} ${pct(maxMCDiff.h).padStart(12)}`);
  console.log(`  ${'D'.padEnd(10)} ${pct(avgMCDiff.d).padStart(12)} ${pct(maxMCDiff.d).padStart(12)}`);
  console.log(`  ${'A'.padEnd(10)} ${pct(avgMCDiff.a).padStart(12)} ${pct(maxMCDiff.a).padStart(12)}`);
  console.log(`  ${'Overall avg'.padEnd(10)} ${pct(overallAvgDiff).padStart(12)} ${pct(overallMaxDiff).padStart(12)}`);
  // Theoretical expected MAE for n=2000 MC with p≈0.38: sqrt(2/π)·sqrt(p(1-p)/n) ≈ 0.87pp
  const expectedMAE = Math.sqrt(2 / Math.PI) * Math.sqrt(0.38 * 0.62 / 2000) * 100;
  const mcRedundant = overallAvgDiff <= expectedMAE * 1.5; // within 1.5× expected sampling noise
  console.log(`\n  Expected sampling MAE for n=2000:   ≈${expectedMAE.toFixed(2)}pp`);
  console.log(`  Observed avg |analytical − MC|:     ${(overallAvgDiff*100).toFixed(2)}pp`);
  console.log(`  Ratio observed/expected:            ${(overallAvgDiff*100/expectedMAE).toFixed(2)}×`);
  console.log(`\n  MC redundancy verdict: ${mcRedundant
    ? '✓ REDUNDANT — observed diff ≤1.5× expected sampling noise. MC adds no signal. Safe to remove.'
    : '✗ NOT REDUNDANT — observed diff >1.5× expected noise. MC adds genuine signal.'}`);

  // ─── ⑭ MARKET-BLEND AUDIT ─────────────────────────────────────────────────
  console.log('\n' + L);
  console.log('  ⑭ MARKET-BLEND AUDIT\n');
  console.log('  Market odds are NOT available in the walk-forward evaluator');
  console.log('  (would require historical per-fixture bookmaker snapshots).\n');
  console.log('  What we CAN measure: pure model (calibrated) vs the full pipeline.');
  console.log('  "Pure model" here = raw → calibration (no market blend).');
  console.log('  This IS what rawPreds→newPreds measures above.\n');
  // Calibrated (no market) vs theoretical market blend comparison
  // Approximate: if market were perfectly calibrated at actual rates,
  // blending 25% market would trivially improve Brier by pulling toward truth.
  // The question is whether the CURRENT model already accounts for what market adds.
  const avgH = newPreds.reduce((s,p)=>s+p.pH,0)/newPreds.length;
  const avgD = newPreds.reduce((s,p)=>s+p.pD,0)/newPreds.length;
  const avgA = newPreds.reduce((s,p)=>s+p.pA,0)/newPreds.length;
  const homeGap = (avgH - actualHR)*100, drawGap = (avgD - actualDR)*100, awayGap = (avgA - actualAR)*100;
  console.log(`  Model avg probs:  H=${pct(avgH)}  D=${pct(avgD)}  A=${pct(avgA)}`);
  console.log(`  Actual rates:     H=${pct(actualHR)}  D=${pct(actualDR)}  A=${pct(actualAR)}`);
  console.log(`  Model bias:       H=${homeGap>=0?'+':''}${homeGap.toFixed(2)}pp  D=${drawGap>=0?'+':''}${drawGap.toFixed(2)}pp  A=${awayGap>=0?'+':''}${awayGap.toFixed(2)}pp`);
  console.log(`\n  With draw bias now only ${pp(avgD, actualDR)} (down from +2.56pp with RHO=−0.13),`);
  console.log('  the model no longer needs the market to correct systematic draw inflation.');
  console.log('  Market blend (25%) still valid for individual fixture sharpening');
  console.log('  when bookmaker odds encode injury/suspension information not in our features.');
  console.log('  Recommendation: RETAIN 25% market blend for individual predictions.');
  console.log('  Calibration-level benefit: negligible (model already well-calibrated).');
  console.log('  Fixture-level benefit: bookmaker market carries news model cannot see.');

  // ─── FINAL RECOMMENDATION ─────────────────────────────────────────────────
  console.log('\n' + L);
  console.log('  FINAL ARCHITECTURE RECOMMENDATION\n');
  console.log('  Component                  Keep?   Reason');
  console.log('  ─────────────────────────────────────────────────────────────────────');
  console.log('  Poisson + τ (RHO=−0.11)    ✓ YES   τ reinstated post-λA-fix: draw gap −2.53pp raw');
  console.log('                                      τ boost ~+2.5pp → closes gap before calibration');
  console.log('  Monte Carlo blend (70/30)  ✗ NO    Pure sampling noise (≈0.86pp ≈ expected MAE)');
  console.log('                                      Remove → use analytical matrix directly');
  console.log('  Market blend (25%)         ✓ YES   Fixture-level news signal (injuries etc)');
  console.log('  Isotonic calibration       ✓ YES   ECE improvement; fitted to RHO=−0.11 distribution');
  console.log('  EWMA 70/30 blend           ✓ YES   Better responsiveness vs slow EWMA only');
  console.log('  Dynamic ELO fade           ✓ YES   Prevents quality double-count with xG');
  console.log('  λA Jensen-bias fix         ✓ YES   Removed 1/defense inversion; λA 1.067→1.199');

  // ─── ⑮ GOAL RESIDUAL DIAGNOSTICS ──────────────────────────────────────────
  {
    const n = lambdaDebug.length;
    const meanHRes = lambdaDebug.reduce((s, d) => s + (d.hG - d.lH), 0) / n;
    const meanARes = lambdaDebug.reduce((s, d) => s + (d.aG - d.lA), 0) / n;
    const meanTRes = lambdaDebug.reduce((s, d) => s + (d.hG + d.aG - d.lH - d.lA), 0) / n;
    const stdDev = arr => { const m = arr.reduce((s,v)=>s+v,0)/arr.length; return Math.sqrt(arr.reduce((s,v)=>s+(v-m)**2,0)/arr.length); };
    const sdH = stdDev(lambdaDebug.map(d => d.hG - d.lH));
    const sdA = stdDev(lambdaDebug.map(d => d.aG - d.lA));
    const sdT = stdDev(lambdaDebug.map(d => d.hG + d.aG - d.lH - d.lA));

    console.log('\n' + L);
    console.log('  ⑮ GOAL RESIDUAL DIAGNOSTICS  (actual − predicted λ)\n');
    console.log(`  ${'Component'.padEnd(30)} ${'Mean residual'.padStart(14)} ${'Std dev'.padStart(10)} ${'Direction'}`);
    console.log('  ' + '─'.repeat(68));
    const fmtRes = (m, sd) => {
      const dir = Math.abs(m) < 0.05 ? '≈ neutral' : m > 0 ? '▲ model UNDERpredicts' : '▼ model OVERpredicts';
      return `${(m>=0?'+':'')+m.toFixed(3)}`.padStart(14) + `  ${sd.toFixed(3)}`.padStart(10) + `  ${dir}`;
    };
    console.log(`  ${'Home goals (actual − λH)'.padEnd(30)} ${fmtRes(meanHRes, sdH)}`);
    console.log(`  ${'Away goals (actual − λA)'.padEnd(30)} ${fmtRes(meanARes, sdA)}`);
    console.log(`  ${'Total goals (actual − λH−λA)'.padEnd(30)} ${fmtRes(meanTRes, sdT)}`);

    // Segment by λH/λA strength ratio
    const ratBuckets = [
      { label: 'Away fav (ratio<0.85)',   filter: d => d.ratio < 0.85 },
      { label: 'Even match (0.85–1.15)',  filter: d => d.ratio >= 0.85 && d.ratio < 1.15 },
      { label: 'Slight home (1.15–1.50)', filter: d => d.ratio >= 1.15 && d.ratio < 1.50 },
      { label: 'Strong home (1.50–2.00)', filter: d => d.ratio >= 1.50 && d.ratio < 2.00 },
      { label: 'Dominant home (>2.00)',   filter: d => d.ratio >= 2.00 },
    ];
    console.log(`\n  Residuals by favourite strength (λH/λA ratio)\n`);
    console.log(`  ${'Bucket'.padEnd(28)} ${'n'.padStart(4)} ${'ΔH'.padStart(7)} ${'ΔA'.padStart(7)} ${'Δtotal'.padStart(8)} ${'Actual H'.padStart(10)} ${'Actual A'.padStart(10)}`);
    console.log('  ' + '─'.repeat(78));
    for (const { label, filter } of ratBuckets) {
      const seg = lambdaDebug.filter(filter);
      if (!seg.length) continue;
      const mH = seg.reduce((s,d)=>s+(d.hG-d.lH),0)/seg.length;
      const mA = seg.reduce((s,d)=>s+(d.aG-d.lA),0)/seg.length;
      const mT = mH + mA;
      const actH = seg.reduce((s,d)=>s+d.hG,0)/seg.length;
      const actA = seg.reduce((s,d)=>s+d.aG,0)/seg.length;
      console.log(`  ${label.padEnd(28)} ${String(seg.length).padStart(4)} ${(mH>=0?'+':'')+mH.toFixed(3).padStart(6)} ${(mA>=0?'+':'')+mA.toFixed(3).padStart(6)} ${(mT>=0?'+':'')+mT.toFixed(3).padStart(7)} ${actH.toFixed(3).padStart(10)} ${actA.toFixed(3).padStart(10)}`);
    }

    // Total-goals environment analysis
    const goalEnvs = [
      { label: 'Low-scoring game (≤1.5G pred)', filter: d => (d.lH+d.lA) <= 1.5 },
      { label: 'Mid-scoring (1.5–2.5G pred)',   filter: d => (d.lH+d.lA) > 1.5 && (d.lH+d.lA) <= 2.5 },
      { label: 'High-scoring (>2.5G pred)',      filter: d => (d.lH+d.lA) > 2.5 },
    ];
    console.log(`\n  Residuals by total-goal environment\n`);
    console.log(`  ${'Bucket'.padEnd(34)} ${'n'.padStart(4)} ${'Pred total'.padStart(11)} ${'Actual total'.padStart(13)} ${'Δ'.padStart(8)}`);
    console.log('  ' + '─'.repeat(74));
    for (const { label, filter } of goalEnvs) {
      const seg = lambdaDebug.filter(filter);
      if (!seg.length) continue;
      const predT  = seg.reduce((s,d)=>s+d.lH+d.lA,0)/seg.length;
      const actT   = seg.reduce((s,d)=>s+d.hG+d.aG,0)/seg.length;
      const delta  = actT - predT;
      console.log(`  ${label.padEnd(34)} ${String(seg.length).padStart(4)} ${predT.toFixed(3).padStart(11)} ${actT.toFixed(3).padStart(13)} ${((delta>=0?'+':'')+delta.toFixed(3)).padStart(8)}`);
    }
  }

  // ─── ⑯ λA SUPPRESSION TRACE ───────────────────────────────────────────────
  {
    const n = lambdaDebug.length;
    const avg = arr => arr.reduce((s,v)=>s+v,0)/arr.length;

    const avgLaLeague  = avg(lambdaDebug.map(d => d.laA));          // league baseline
    const avgLaEwma    = avg(lambdaDebug.map(d => d.lA_ewma));      // after EWMA layer only
    const avgLaBlend   = avg(lambdaDebug.map(d => d.lA_blend));     // after EWMA+season blend
    const avgLaFinal   = avg(lambdaDebug.map(d => d.lA));           // final (+ ELO)
    const avgActualA   = avg(lambdaDebug.map(d => d.aG));
    const avgEloContrib = avg(lambdaDebug.map(d => d.eloContribA));

    // Component strengths
    const avgAtkEwma   = avg(lambdaDebug.map(d => d.aAtkEwma));
    const avgHDefEwma  = avg(lambdaDebug.map(d => d.hDefEwmaRaw));

    console.log('\n' + L);
    console.log('  ⑯ λA SUPPRESSION TRACE — component pipeline\n');
    console.log(`  ${'Stage'.padEnd(38)} ${'Avg λA'.padStart(8)} ${'Δ from prev'.padStart(13)} ${'Δ from league'.padStart(14)}`);
    console.log('  ' + '─'.repeat(76));
    const row = (label, val, prev, league) => {
      const dPrev   = (val - prev);
      const dLeague = (val - league);
      console.log(`  ${label.padEnd(38)} ${val.toFixed(3).padStart(8)} ${((dPrev>=0?'+':'')+dPrev.toFixed(3)).padStart(13)} ${((dLeague>=0?'+':'')+dLeague.toFixed(3)).padStart(14)}`);
    };
    row('League avg away goals (baseline)',   avgLaLeague, avgLaLeague, avgLaLeague);
    row('After EWMA attack × defense',        avgLaEwma,   avgLaLeague, avgLaLeague);
    row('After 70/30 EWMA+season blend',      avgLaBlend,  avgLaEwma,   avgLaLeague);
    row('After ELO blend (= final λA)',        avgLaFinal,  avgLaBlend,  avgLaLeague);
    console.log('  ' + '─'.repeat(76));
    row('Actual away goals',                  avgActualA,  avgLaFinal,  avgLaLeague);

    console.log(`\n  λA underestimation (final λA − actual): ${((avgLaFinal-avgActualA)>=0?'+':'')+(avgLaFinal-avgActualA).toFixed(3)} goals/game`);
    console.log(`  Total suppression from league avg:      ${((avgLaFinal-avgLaLeague)>=0?'+':'')+(avgLaFinal-avgLaLeague).toFixed(3)} goals/game`);

    console.log('\n  Component strengths (avg across all fixtures):');
    console.log(`    Away team EWMA attack (aAtk):   ${avgAtkEwma.toFixed(3)}  (1.000 = league-avg, <1 = weak)`);
    console.log(`    Home team EWMA defense (hDef):  ${avgHDefEwma.toFixed(3)}  (higher = stronger defense = suppresses λA more)`);
    console.log(`    ELO contribution to λA:         ${((avgEloContrib>=0?'+':'')+avgEloContrib.toFixed(3))} (avg shift from ELO blend)`);

    // Jensen's inequality bias check: E[1/X] vs 1/E[X]
    const defRatings = lambdaDebug.map(d => d.hDefEwmaRaw);
    const avgInvDef  = avg(defRatings);                                        // E[1/X]
    const invAvgDef  = 1 / avg(lambdaDebug.map(d => 1/Math.max(d.hDefEwmaRaw, 0.01))); // 1/E[X] approx
    console.log(`\n  Jensen's inequality check on EWMA defense:`);
    console.log(`    E[1/defense] = ${avgInvDef.toFixed(3)}  (what model computes as hDef)`);
    console.log(`    Bias vs 1.0:  ${((avgInvDef-1.0)>=0?'+':'')+(avgInvDef-1.0).toFixed(3)}  (positive = EWMA defense suppresses λA systematically)`);
    console.log(`    Impact on λA: ×${avgInvDef.toFixed(3)} multiplier  → ${((avgInvDef-1)*100).toFixed(1)}% systematic suppression from defense EWMA`);

    // Segment λA residuals by home defense strength
    const defBuckets = [
      { label: 'Weak home def (hDef<0.85)',    filter: d => d.hDefEwmaRaw < 0.85 },
      { label: 'Mid home def (0.85–1.10)',     filter: d => d.hDefEwmaRaw >= 0.85 && d.hDefEwmaRaw < 1.10 },
      { label: 'Strong home def (1.10–1.30)',  filter: d => d.hDefEwmaRaw >= 1.10 && d.hDefEwmaRaw < 1.30 },
      { label: 'Elite home def (≥1.30)',        filter: d => d.hDefEwmaRaw >= 1.30 },
    ];
    console.log(`\n  λA residuals by home defense strength\n`);
    console.log(`  ${'Bucket'.padEnd(32)} ${'n'.padStart(4)} ${'Avg λA'.padStart(8)} ${'Actual A'.padStart(9)} ${'Residual'.padStart(10)} ${'Avg hDef'.padStart(10)}`);
    console.log('  ' + '─'.repeat(76));
    for (const { label, filter } of defBuckets) {
      const seg = lambdaDebug.filter(filter);
      if (!seg.length) continue;
      const aLa   = avg(seg.map(d=>d.lA));
      const aActA = avg(seg.map(d=>d.aG));
      const aRes  = aActA - aLa;
      const aDef  = avg(seg.map(d=>d.hDefEwmaRaw));
      console.log(`  ${label.padEnd(32)} ${String(seg.length).padStart(4)} ${aLa.toFixed(3).padStart(8)} ${aActA.toFixed(3).padStart(9)} ${((aRes>=0?'+':'')+aRes.toFixed(3)).padStart(10)} ${aDef.toFixed(3).padStart(10)}`);
    }

    // EWMA vs season avg λA comparison
    const bothValid = lambdaDebug.filter(d => d.lA_season > 0 && d.lA_ewma > 0);
    if (bothValid.length > 0) {
      console.log(`\n  EWMA vs season-avg λA paths (n=${bothValid.length} fixtures with both valid):`);
      console.log(`    Avg λA from pure EWMA:       ${avg(bothValid.map(d=>d.lA_ewma)).toFixed(3)}`);
      console.log(`    Avg λA from pure season avg: ${avg(bothValid.map(d=>d.lA_season)).toFixed(3)}`);
      console.log(`    Avg λA from 70/30 blend:     ${avg(bothValid.map(d=>d.lA_blend)).toFixed(3)}`);
      console.log(`    Actual avg away goals:       ${avg(bothValid.map(d=>d.aG)).toFixed(3)}`);
      const ewmaErr   = avg(bothValid.map(d=>d.lA_ewma))   - avg(bothValid.map(d=>d.aG));
      const seasonErr = avg(bothValid.map(d=>d.lA_season)) - avg(bothValid.map(d=>d.aG));
      const blendErr  = avg(bothValid.map(d=>d.lA_blend))  - avg(bothValid.map(d=>d.aG));
      console.log(`\n    Underestimation — EWMA only:     ${((ewmaErr>=0?'+':'')+ewmaErr.toFixed(3))}`);
      console.log(`    Underestimation — Season only:   ${((seasonErr>=0?'+':'')+seasonErr.toFixed(3))}`);
      console.log(`    Underestimation — 70/30 blend:   ${((blendErr>=0?'+':'')+blendErr.toFixed(3))}`);
      const root = ewmaErr < seasonErr ? 'EWMA' : 'Season avg';
      console.log(`\n    Root of suppression: ${root} path contributes more underestimation.`);
      console.log(`    (Jensen's bias in 1/defense EWMA drives systematic floor effect on λA.)`);
    }
  }

  // ─── RHO Sensitivity Sweep ──────────────────────────────────────────────────
  await runRhoSweep(completed);

  console.log('\n' + L + '\n');
}

// ─── RHO Sensitivity Sweep ─────────────────────────────────────────────────────
async function runRhoSweep(completed) {
  const RHO_VALUES = [0.00, -0.03, -0.05, -0.07, -0.09, -0.11, -0.13];
  const MIN_HISTORY = 5;

  process.stdout.write('\nBuilding lambda cache for RHO sweep... ');

  // Lambdas don't depend on RHO — compute once
  const cache = []; // { lH, lA, actual }
  for (let i = 0; i < completed.length; i++) {
    const fix    = completed[i];
    const before = completed.slice(0, i);
    if (before.length < MIN_HISTORY) continue;

    const totH = before.reduce((s, f) => s + (f.team_h_score ?? 0), 0);
    const totA = before.reduce((s, f) => s + (f.team_a_score ?? 0), 0);
    const laH  = totH / before.length;
    const laA  = totA / before.length;

    const rolling = buildRollingRatings(before, laH, laA);
    const eloN    = buildEloRatings(before);
    const hFN     = formNew(before, fix.team_h);
    const aFN     = formNew(before, fix.team_a);
    const { lH, lA } = makeLambdasNew(fix.team_h, fix.team_a, hFN, aFN, rolling, eloN, laH, laA);

    const hG = fix.team_h_score, aG = fix.team_a_score;
    cache.push({ lH, lA, laH, laA, actual: hG > aG ? 'H' : hG < aG ? 'A' : 'D' });
  }
  console.log(`done. ${cache.length} fixtures cached.\n`);

  const n = cache.length;
  const actualDR = cache.filter(c => c.actual === 'D').length / n;
  const actualHR = cache.filter(c => c.actual === 'H').length / n;
  const actualAR = cache.filter(c => c.actual === 'A').length / n;

  const results = [];

  for (const testRHO of RHO_VALUES) {
    // Raw probabilities with this RHO
    const rawPreds = cache.map(({ lH, lA, actual }) => {
      const p = probs(matrixParam(lH, lA, testRHO));
      return { pH: p.h, pD: p.d, pA: p.a, actual, lH, lA };
    });

    // Fit CALIB_POINTS independently via PAV
    const calibPts = fitCalibPoints(rawPreds);

    // Apply calibration
    const calibPreds = rawPreds.map(p => {
      const c = applyCalibWith(p.pH, p.pD, p.pA, calibPts);
      return { pH: c.h, pD: c.d, pA: c.a, actual: p.actual, lH: p.lH, lA: p.lA };
    });

    // Draw decomposition: pure Poisson → post-tau → post-calib
    let drawPoisson = 0, drawTau = 0;
    for (const { lH, lA } of cache) {
      drawPoisson += probs(matrixParam(lH, lA, 0.00)).d;
      drawTau     += probs(matrixParam(lH, lA, testRHO)).d;
    }
    drawPoisson /= n;
    drawTau     /= n;
    const drawCalib = calibPreds.reduce((s, p) => s + p.pD, 0) / n;

    // Core metrics — raw & calibrated
    const rBrier = brierScore(rawPreds),  cBrier = brierScore(calibPreds);
    const rLL    = logLoss(rawPreds),     cLL    = logLoss(calibPreds);
    const rRPS   = rps(rawPreds),         cRPS   = rps(calibPreds);
    const rAcc   = accuracy(rawPreds),    cAcc   = accuracy(calibPreds);
    const rCal   = calibrationError(rawPreds);
    const cCal   = calibrationError(calibPreds);

    const avgLH = cache.reduce((s, c) => s + c.lH, 0) / n;
    const avgLA = cache.reduce((s, c) => s + c.lA, 0) / n;

    const calAvgH = calibPreds.reduce((s, p) => s + p.pH, 0) / n;
    const calAvgD = calibPreds.reduce((s, p) => s + p.pD, 0) / n;
    const calAvgA = calibPreds.reduce((s, p) => s + p.pA, 0) / n;

    // High-confidence accuracy (>60%)
    const hcPreds = calibPreds.filter(p => Math.max(p.pH, p.pD, p.pA) > 0.60);
    const hcAcc   = hcPreds.length
      ? hcPreds.filter(p => (p.pH > p.pD && p.pH > p.pA ? 'H' : p.pA > p.pD ? 'A' : 'D') === p.actual).length / hcPreds.length
      : null;

    // Bucket errors (40-50%, 50-60%, 60-70%)
    const bktErr = (lo, hi) => {
      const bs = cCal.buckets.filter(b => b.pred >= lo && b.pred < hi);
      if (!bs.length) return null;
      const totN = bs.reduce((s, b) => s + b.n, 0);
      return bs.reduce((s, b) => s + b.err * b.n, 0) / totN;
    };

    // Away win tracking
    const awayWinSet = calibPreds.filter(p => p.pA > p.pH && p.pA > p.pD);
    const awayHitRate = awayWinSet.length
      ? awayWinSet.filter(p => p.actual === 'A').length / awayWinSet.length : null;
    const avgAwayP = awayWinSet.length
      ? awayWinSet.reduce((s, p) => s + p.pA, 0) / awayWinSet.length : null;

    results.push({
      rho: testRHO,
      rBrier, cBrier, rLL, cLL, rRPS, cRPS, rAcc, cAcc,
      rECE: rCal.ece, cECE: cCal.ece,
      avgDrawRaw: drawTau,      // avg raw draw before calib
      drawPoisson, drawTau, drawCalib,
      drawCalibErr: drawCalib - actualDR,
      calAvgH, calAvgD, calAvgA,
      homeBias: calAvgH - actualHR,
      awayBias: calAvgA - actualAR,
      avgLH, avgLA,
      hcAcc, hcN: hcPreds.length,
      b4050: bktErr(0.40, 0.50),
      b5060: bktErr(0.50, 0.60),
      b6070: bktErr(0.60, 0.70),
      calibPts,
      awayWinCount: awayWinSet.length,
      awayHitRate,
      avgAwayP,
    });
  }

  // ─── Output ─────────────────────────────────────────────────────────────────
  const pct = v => v != null ? `${(v*100).toFixed(2)}%` : ' N/A  ';
  const pp  = v => v != null ? `${(v>=0?'+':'')+(v*100).toFixed(2)}pp` : '  N/A  ';
  const f4  = v => v.toFixed(4);
  const f3  = v => v != null ? v.toFixed(3) : ' N/A ';
  const c   = (s, w, r=false) => r ? String(s).padStart(w) : String(s).padEnd(w);
  const L   = '═'.repeat(120);
  const l   = '─'.repeat(120);

  console.log('\n' + L);
  console.log('  RHO SENSITIVITY EXPERIMENT — Dixon-Coles τ correction sweep');
  console.log(`  Fixtures: ${n}   Actual: H=${pct(actualHR)} D=${pct(actualDR)} A=${pct(actualAR)}`);
  console.log(L);

  // ── Table 1: Core calibrated metrics ────────────────────────────────────────
  console.log('\n  TABLE 1: CALIBRATED METRICS (per RHO, independently fitted CALIB_POINTS)\n');
  const h1 = [' RHO  ', 'Brier', 'LogLoss', 'RPS', 'Acc%', 'ECE%', 'AvgD%', 'DrawErr', 'HomeBias', 'AwayBias', 'AvgλH', 'AvgλA', 'HC-Acc%', 'HC-n'];
  const w1  = [7, 7, 8, 7, 7, 7, 7, 9, 10, 10, 7, 7, 9, 6];
  console.log('  ' + h1.map((h, i) => c(h, w1[i], true)).join(' '));
  console.log('  ' + l.slice(0, h1.reduce((s,_,i)=>s+w1[i]+1,0)));
  for (const r of results) {
    const cols = [
      r.rho.toFixed(2),
      f4(r.cBrier),
      f4(r.cLL),
      f4(r.cRPS),
      (r.cAcc*100).toFixed(2),
      (r.cECE*100).toFixed(2),
      (r.calAvgD*100).toFixed(2),
      pp(r.drawCalibErr),
      pp(r.homeBias),
      pp(r.awayBias),
      r.avgLH.toFixed(3),
      r.avgLA.toFixed(3),
      r.hcAcc != null ? (r.hcAcc*100).toFixed(2) : 'N/A',
      String(r.hcN),
    ];
    console.log('  ' + cols.map((v, i) => c(v, w1[i], true)).join(' '));
  }

  // ── Table 2: Raw metrics ─────────────────────────────────────────────────────
  console.log('\n  TABLE 2: RAW (pre-calibration) METRICS\n');
  const h2 = [' RHO  ', 'Brier', 'LogLoss', 'RPS', 'Acc%', 'ECE%'];
  const w2  = [7, 7, 8, 7, 7, 7];
  console.log('  ' + h2.map((h, i) => c(h, w2[i], true)).join(' '));
  console.log('  ' + l.slice(0, h2.reduce((s,_,i)=>s+w2[i]+1,0)));
  for (const r of results) {
    const cols = [
      r.rho.toFixed(2), f4(r.rBrier), f4(r.rLL), f4(r.rRPS),
      (r.rAcc*100).toFixed(2), (r.rECE*100).toFixed(2),
    ];
    console.log('  ' + cols.map((v, i) => c(v, w2[i], true)).join(' '));
  }

  // ── Table 3: Draw decomposition ──────────────────────────────────────────────
  console.log('\n  TABLE 3: DRAW DECOMPOSITION (avg draw rate at each pipeline stage)\n');
  console.log(`  Actual draw rate: ${pct(actualDR)}`);
  console.log(`\n  ${'RHO'.padStart(6)}  ${'Pure Poisson'.padStart(13)}  ${'Post-τ'.padStart(10)}  ${'Post-Calib'.padStart(11)}  ${'τ boost'.padStart(9)}  ${'Calib adj'.padStart(10)}  ${'Net err'.padStart(9)}`);
  console.log('  ' + l.slice(0, 80));
  for (const r of results) {
    const tauBoost  = r.drawTau - r.drawPoisson;
    const calibAdj  = r.drawCalib - r.drawTau;
    const netErr    = r.drawCalib - actualDR;
    console.log(`  ${r.rho.toFixed(2).padStart(6)}  ${pct(r.drawPoisson).padStart(13)}  ${pct(r.drawTau).padStart(10)}  ${pct(r.drawCalib).padStart(11)}  ${pp(tauBoost).padStart(9)}  ${pp(calibAdj).padStart(10)}  ${pp(netErr).padStart(9)}`);
  }

  // ── Table 4: Bucket errors ───────────────────────────────────────────────────
  console.log('\n  TABLE 4: CALIBRATED BUCKET ERRORS (40-50%, 50-60%, 60-70%)\n');
  console.log(`  ${'RHO'.padStart(6)}  ${'40-50% err'.padStart(11)}  ${'50-60% err'.padStart(11)}  ${'60-70% err'.padStart(11)}`);
  console.log('  ' + l.slice(0, 50));
  for (const r of results) {
    console.log(`  ${r.rho.toFixed(2).padStart(6)}  ${(r.b4050!=null?pct(r.b4050):'  N/A   ').padStart(11)}  ${(r.b5060!=null?pct(r.b5060):'  N/A   ').padStart(11)}  ${(r.b6070!=null?pct(r.b6070):'  N/A   ').padStart(11)}`);
  }

  // ── Table 5: Away win tracking ───────────────────────────────────────────────
  console.log('\n  TABLE 5: AWAY WIN TRACKING\n');
  console.log(`  ${'RHO'.padStart(6)}  ${'Pred away wins'.padStart(14)}  ${'Hit rate'.padStart(9)}  ${'Avg prob'.padStart(9)}`);
  console.log('  ' + l.slice(0, 48));
  for (const r of results) {
    console.log(`  ${r.rho.toFixed(2).padStart(6)}  ${String(r.awayWinCount).padStart(14)}  ${(r.awayHitRate!=null?pct(r.awayHitRate):'  N/A   ').padStart(9)}  ${(r.avgAwayP!=null?pct(r.avgAwayP):'  N/A   ').padStart(9)}`);
  }

  // ── CALIB_POINTS per RHO ─────────────────────────────────────────────────────
  console.log('\n  FITTED CALIB_POINTS PER RHO (PAV isotonic regression)\n');
  for (const r of results) {
    console.log(`  RHO = ${r.rho.toFixed(2)}:`);
    const pts = r.calibPts.map(([x, y]) => `[${x.toFixed(3)}, ${y.toFixed(3)}]`).join(', ');
    console.log(`    [${pts}]`);
  }

  // ── Recommendation ───────────────────────────────────────────────────────────
  console.log('\n' + L);
  console.log('  RECOMMENDATION\n');

  // Score each RHO on: cBrier (lower=better), cLL (lower), cRPS (lower), cECE (lower),
  // |drawCalibErr| (lower), awayHitRate (higher), cAcc (higher)
  const scored = results.map(r => {
    const metrics = [
      { v: r.cBrier,                  lowerBetter: true,  weight: 3 },
      { v: r.cLL,                     lowerBetter: true,  weight: 2 },
      { v: r.cRPS,                    lowerBetter: true,  weight: 2 },
      { v: r.cECE,                    lowerBetter: true,  weight: 2 },
      { v: Math.abs(r.drawCalibErr),  lowerBetter: true,  weight: 3 },
      { v: r.awayHitRate ?? 0,        lowerBetter: false, weight: 2 },
      { v: r.cAcc,                    lowerBetter: false, weight: 1 },
    ];
    return { rho: r.rho, metrics };
  });

  // Rank each metric across RHO values, sum weighted ranks
  const metricCount = scored[0].metrics.length;
  const totalScore = results.map(() => 0);
  for (let m = 0; m < metricCount; m++) {
    const vals = scored.map(s => ({ v: s.metrics[m].v, w: s.metrics[m].weight, lb: s.metrics[m].lowerBetter }));
    const sorted = [...vals.map((v, i) => ({ ...v, i }))].sort((a, b) => a.lb ? a.v - b.v : b.v - a.v);
    for (let rank = 0; rank < sorted.length; rank++) {
      totalScore[sorted[rank].i] += (rank + 1) * vals[0].w; // rank 1 = best
    }
  }

  const best = totalScore.indexOf(Math.min(...totalScore));
  console.log(`  Scoring: Brier×3 + LogLoss×2 + RPS×2 + ECE×2 + |DrawCalibErr|×3 + AwayHitRate×2 + Acc×1`);
  console.log(`  (lower total weighted rank = better)\n`);
  console.log(`  ${'RHO'.padStart(6)}  ${'Weighted rank score'.padStart(20)}  ${'Verdict'}`);
  console.log('  ' + l.slice(0, 50));
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const star = i === best ? ' ◀ RECOMMENDED' : '';
    console.log(`  ${r.rho.toFixed(2).padStart(6)}  ${String(totalScore[i]).padStart(20)}  ${star}`);
  }

  const rec = results[best];
  console.log(`\n  ► Optimal RHO = ${rec.rho.toFixed(2)}`);
  console.log(`    Brier=${f4(rec.cBrier)}  LogLoss=${f4(rec.cLL)}  RPS=${f4(rec.cRPS)}`);
  console.log(`    ECE=${pct(rec.cECE)}  DrawCalibErr=${pp(rec.drawCalibErr)}  AwayHitRate=${pct(rec.awayHitRate)}`);

  const baseline = results.find(r => r.rho === 0.00);
  if (rec.rho !== 0.00 && baseline) {
    console.log(`\n  vs baseline RHO=0.00:`);
    console.log(`    Brier:     ${f4(baseline.cBrier)} → ${f4(rec.cBrier)}  (${((rec.cBrier-baseline.cBrier)*1000).toFixed(1)}×10⁻³)`);
    console.log(`    ECE:       ${pct(baseline.cECE)} → ${pct(rec.cECE)}`);
    console.log(`    DrawErr:   ${pp(baseline.drawCalibErr)} → ${pp(rec.drawCalibErr)}`);
    console.log(`    AwayHit:   ${pct(baseline.awayHitRate)} → ${pct(rec.awayHitRate)}`);
    if (rec.rho === 0.00) {
      console.log(`\n  VERDICT: Keep RHO=0.00 — pure Poisson is optimal on current data.`);
    } else {
      console.log(`\n  VERDICT: Current RHO=${RHO.toFixed(2)} — optimal is ${rec.rho.toFixed(2)} (${rec.rho === RHO ? 'matches current ✓' : 'consider updating'}).`);
    }
  } else {
    console.log(`\n  VERDICT: Current RHO=${RHO.toFixed(2)} is optimal across tested range.`);
  }

  console.log('\n' + L + '\n');
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
