'use strict';
/**
 * Multi-season evaluation + market-relative (CLV) validation
 *
 * Data source: football-data.co.uk Premier League CSV
 *   → match results + B365 closing odds for 3 historical seasons
 *
 * Phases covered:
 *   Phase 3 — multi-season walk-forward (per-season + aggregate metrics)
 *   Phase 5 — market-relative evaluation (model edge vs B365 closing lines)
 *
 * Usage: /opt/homebrew/bin/node multi-season-eval.js
 *
 * Seasons evaluated (independently, no carry-over between seasons):
 *   2022-23, 2023-24, 2024-25
 */

const axios  = require('axios');
const { buildRollingRatings, buildEloRatings, FORM_WEIGHTS } = require('./models/predictionEngine');

// ─── Season manifest ──────────────────────────────────────────────────────────
const SEASONS = [
  { id: '2223', label: '2022-23', url: 'https://www.football-data.co.uk/mmz4281/2223/E0.csv' },
  { id: '2324', label: '2023-24', url: 'https://www.football-data.co.uk/mmz4281/2324/E0.csv' },
  { id: '2425', label: '2024-25', url: 'https://www.football-data.co.uk/mmz4281/2425/E0.csv' },
];

// ─── Constants (mirror predictionEngine.js) ───────────────────────────────────
const FACTORIALS   = [1,1,2,6,24,120,720,5040,40320,362880];
const MATRIX_SIZE  = 6;
const LAMBDA_CAP   = 2.5;
const LAMBDA_FLOOR = 0.35;
const STRENGTH_MIN = 0.5;
const STRENGTH_MAX = 1.7;
const RATING_MIN   = 0.6;
const RATING_MAX   = 1.6;
const ELO_START    = 1500;
const ELO_WEIGHT_NOXG     = 0.30;
const FORM_BLEND_NOXG     = 0.25;
const FORM_BLEND_NOXG_CAP = 0.30;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const poi   = (k, λ) => λ <= 0 ? (k===0?1:0) : Math.exp(-λ) * Math.pow(λ,k) / FACTORIALS[Math.min(k,9)];

// ─── Pure-Poisson score matrix ────────────────────────────────────────────────
function buildMatrix(lH, lA) {
  const m = []; let tot = 0;
  for (let h = 0; h < MATRIX_SIZE; h++) {
    const r = [];
    for (let a = 0; a < MATRIX_SIZE; a++) { const p = poi(h,lH)*poi(a,lA); r.push(p); tot+=p; }
    m.push(r);
  }
  if (tot > 0) for (let h = 0; h < MATRIX_SIZE; h++) for (let a = 0; a < MATRIX_SIZE; a++) m[h][a] /= tot;
  return m;
}

function matrixProbs(m) {
  let h=0, d=0, a=0;
  for (let i=0; i<MATRIX_SIZE; i++) for (let j=0; j<MATRIX_SIZE; j++) {
    const p = m[i][j]; if(i>j) h+=p; else if(i===j) d+=p; else a+=p;
  }
  const t=h+d+a; return { h:h/t, d:d/t, a:a/t };
}

// ─── CSV parser (no external dependency) ──────────────────────────────────────
function parseCSVLine(line) {
  const result=[]; let cur='', inQ=false;
  for (const c of line) {
    if (c==='"') { inQ=!inQ; continue; }
    if (c===',' && !inQ) { result.push(cur); cur=''; continue; }
    cur+=c;
  }
  result.push(cur);
  return result.map(v => v.trim());
}

function parseCSV(text) {
  const lines = text.replace(/\r/g,'').trim().split('\n');
  const headers = parseCSVLine(lines[0]);
  return lines.slice(1)
    .filter(l => l.trim())
    .map(l => {
      const vals = parseCSVLine(l);
      const obj = {};
      headers.forEach((h,i) => { obj[h] = vals[i] ?? ''; });
      return obj;
    })
    .filter(r => r.HomeTeam && r.FTHG !== '' && r.FTAG !== '');
}

// Convert football-data.co.uk rows → internal fixture format.
// Creates a fresh team-name → integer-ID mapping per season call.
function convertFixtures(rows) {
  const teamMap = {}; let nextId = 1;
  const id = name => { if (!teamMap[name]) teamMap[name] = nextId++; return teamMap[name]; };

  return {
    fixtures: rows.map(row => {
      // Date: "11/08/2023" or "11/08/23"
      const parts = (row.Date||'').split('/');
      if (parts.length < 3) return null;
      const [d, m, y] = parts;
      const year = y.length === 2 ? '20'+y : y;
      const hG = parseInt(row.FTHG), aG = parseInt(row.FTAG);
      if (isNaN(hG) || isNaN(aG)) return null;
      return {
        team_h:       id(row.HomeTeam),
        team_a:       id(row.AwayTeam),
        team_h_score: hG,
        team_a_score: aG,
        kickoff_time: `${year}-${m.padStart(2,'0')}-${d.padStart(2,'0')}T15:00:00Z`,
        // B365 closing odds (may be missing in older data)
        b365H: parseFloat(row.B365H) || null,
        b365D: parseFloat(row.B365D) || null,
        b365A: parseFloat(row.B365A) || null,
      };
    }).filter(Boolean).sort((a,b) => new Date(a.kickoff_time)-new Date(b.kickoff_time)),
    teamMap,
  };
}

// ─── Form builder (mirrors evaluate-engine.js formNew) ───────────────────────
function buildForm(before, teamId) {
  const all = before.filter(f => f.team_h===teamId || f.team_a===teamId)
    .sort((a,b) => new Date(b.kickoff_time)-new Date(a.kickoff_time));

  const homePlayed = all.filter(f => f.team_h===teamId).slice(0,5);
  const awayPlayed = all.filter(f => f.team_a===teamId).slice(0,5);

  const wavg = (games, getFor, getAgainst) => {
    if (!games.length) return { sc:0, co:0 };
    const ws = FORM_WEIGHTS.slice(0,games.length);
    const wSum = ws.reduce((a,b)=>a+b,0)||1;
    let sc=0,co=0;
    for (let i=0; i<games.length; i++) { const w=(FORM_WEIGHTS[i]??0)/wSum; sc+=getFor(games[i])*w; co+=getAgainst(games[i])*w; }
    return {sc,co};
  };

  const hr = wavg(homePlayed, f=>f.team_h_score??0, f=>f.team_a_score??0);
  const ar = wavg(awayPlayed, f=>f.team_a_score??0, f=>f.team_h_score??0);

  let sHS=0,sHC=0,sAS=0,sAC=0;
  for (const f of all) {
    if (f.team_h===teamId) { sHS+=f.team_h_score??0; sHC+=f.team_a_score??0; }
    else                   { sAS+=f.team_a_score??0; sAC+=f.team_h_score??0; }
  }
  const allH = all.filter(f=>f.team_h===teamId), allA = all.filter(f=>f.team_a===teamId);

  return {
    homeScored:hr.sc, homeConceded:hr.co, homeGames:homePlayed.length,
    awayScored:ar.sc, awayConceded:ar.co, awayGames:awayPlayed.length,
    seasonHomeScored:sHS, seasonHomeConceded:sHC, seasonHomeGames:allH.length,
    seasonAwayScored:sAS, seasonAwayConceded:sAC, seasonAwayGames:allA.length,
    seasonScored:sHS+sAS, seasonConceded:sHC+sAC, seasonGames:all.length,
  };
}

// ─── Lambda builder (mirrors evaluate-engine.js makeLambdasNew) ──────────────
function buildLambdas(hId, aId, hFD, aFD, rolling, elo, laH, laA) {
  const rm = rolling.ratings ?? {};

  const baseAtk = (fd, id, isHome) => {
    const avg = isHome ? laH : laA;
    const r   = rm[String(id)];
    if (r) {
      const vSc = isHome ? fd.seasonHomeScored : fd.seasonAwayScored;
      const vG  = isHome ? fd.seasonHomeGames  : fd.seasonAwayGames;
      if (vSc && vG) return 0.70*r.attack + 0.30*((vSc/vG)/avg);
      return r.attack;
    }
    const vSc = isHome ? fd.seasonHomeScored : fd.seasonAwayScored;
    const vG  = isHome ? fd.seasonHomeGames  : fd.seasonAwayGames;
    if (vSc && vG) return (vSc/vG)/avg;
    if (fd.seasonScored && fd.seasonGames) return (fd.seasonScored/fd.seasonGames)/avg;
    return 1.0;
  };

  const baseDef = (fd, id, isHome) => {
    const avg = isHome ? laA : laH;
    const r   = rm[String(id)];
    if (r) {
      const vCo = isHome ? fd.seasonHomeConceded : fd.seasonAwayConceded;
      const vG  = isHome ? fd.seasonHomeGames    : fd.seasonAwayGames;
      // Defense EWMA now stores linear conceded ratio (HIGH = weak) — use directly, no inversion
      if (vCo && vG) { const ewmaD=clamp(r.defense,RATING_MIN,RATING_MAX); return 0.70*ewmaD+0.30*((vCo/vG)/avg); }
      return clamp(r.defense,RATING_MIN,RATING_MAX);
    }
    const vCo = isHome ? fd.seasonHomeConceded : fd.seasonAwayConceded;
    const vG  = isHome ? fd.seasonHomeGames    : fd.seasonAwayGames;
    if (vCo && vG) return (vCo/vG)/avg;
    if (fd.seasonConceded && fd.seasonGames) return (fd.seasonConceded/fd.seasonGames)/avg;
    return 1.0;
  };

  const formMomAtk = (fd, isHome, base) => {
    const avg=isHome?laH:laA; const vSc=isHome?fd.homeScored:fd.awayScored; const vG=isHome?fd.homeGames:fd.awayGames;
    if(!vG) return 1.0;
    const fr=vSc/avg, bl=FORM_BLEND_NOXG*fr+(1-FORM_BLEND_NOXG)*base;
    return clamp(bl/Math.max(base,0.1),1-FORM_BLEND_NOXG_CAP,1+FORM_BLEND_NOXG_CAP);
  };
  const formMomDef = (fd, isHome, base) => {
    const avg=isHome?laA:laH; const vCo=isHome?fd.homeConceded:fd.awayConceded; const vG=isHome?fd.homeGames:fd.awayGames;
    if(!vG) return 1.0;
    const fr=vCo/avg, bl=FORM_BLEND_NOXG*fr+(1-FORM_BLEND_NOXG)*base;
    return clamp(bl/Math.max(base,0.1),1-FORM_BLEND_NOXG_CAP,1+FORM_BLEND_NOXG_CAP);
  };

  const hAtkBase = clamp(baseAtk(hFD,hId,true),  STRENGTH_MIN,STRENGTH_MAX);
  const hDefBase = clamp(baseDef(hFD,hId,true),  STRENGTH_MIN,STRENGTH_MAX);
  const aAtkBase = clamp(baseAtk(aFD,aId,false), STRENGTH_MIN,STRENGTH_MAX);
  const aDefBase = clamp(baseDef(aFD,aId,false), STRENGTH_MIN,STRENGTH_MAX);

  const hAtk = clamp(hAtkBase*formMomAtk(hFD,true, hAtkBase),STRENGTH_MIN,STRENGTH_MAX);
  const hDef = clamp(hDefBase*formMomDef(hFD,true, hDefBase),STRENGTH_MIN,STRENGTH_MAX);
  const aAtk = clamp(aAtkBase*formMomAtk(aFD,false,aAtkBase),STRENGTH_MIN,STRENGTH_MAX);
  const aDef = clamp(aDefBase*formMomDef(aFD,false,aDefBase),STRENGTH_MIN,STRENGTH_MAX);

  let lH = laH*hAtk*aDef;
  let lA = laA*aAtk*hDef;

  const hER = elo[String(hId)], aER = elo[String(aId)];
  if (hER!=null && aER!=null) {
    const hM=clamp(hER/ELO_START,RATING_MIN,RATING_MAX), aM=clamp(aER/ELO_START,RATING_MIN,RATING_MAX);
    lH = lH*(1-ELO_WEIGHT_NOXG) + clamp(laH*hM/aM,LAMBDA_FLOOR,LAMBDA_CAP)*ELO_WEIGHT_NOXG;
    lA = lA*(1-ELO_WEIGHT_NOXG) + clamp(laA*aM/hM,LAMBDA_FLOOR,LAMBDA_CAP)*ELO_WEIGHT_NOXG;
  }
  return { lH:clamp(lH,LAMBDA_FLOOR,LAMBDA_CAP), lA:clamp(lA,LAMBDA_FLOOR,LAMBDA_CAP) };
}

// ─── PAV calibration fitting ──────────────────────────────────────────────────
function fitPAV(rawPreds, nBins=20) {
  const bins = Array.from({length:nBins}, ()=>({sumX:0,sumY:0,n:0}));
  for (const p of rawPreds) {
    for (const [x,y] of [[p.h,p.actual==='H'?1:0],[p.d,p.actual==='D'?1:0],[p.a,p.actual==='A'?1:0]]) {
      const b = Math.min(Math.floor(x*nBins),nBins-1);
      bins[b].sumX+=x; bins[b].sumY+=y; bins[b].n++;
    }
  }
  const filled = bins.map(b=>b.n>0?{x:b.sumX/b.n,y:b.sumY/b.n,n:b.n}:null).filter(Boolean);
  const blocks = filled.map(b=>({...b}));
  let changed=true;
  while(changed) {
    changed=false;
    for (let i=0;i<blocks.length-1;i++) {
      if(blocks[i].y>blocks[i+1].y) {
        const tot=blocks[i].n+blocks[i+1].n;
        blocks.splice(i,2,{x:(blocks[i].x*blocks[i].n+blocks[i+1].x*blocks[i+1].n)/tot,y:(blocks[i].y*blocks[i].n+blocks[i+1].y*blocks[i+1].n)/tot,n:tot});
        changed=true; break;
      }
    }
  }
  return [[0,0],...blocks.map(b=>[+b.x.toFixed(3),+b.y.toFixed(3)]),[1,1]];
}

function lerpCalWith(p, pts) {
  if(p<=pts[0][0]) return pts[0][1];
  if(p>=pts[pts.length-1][0]) return pts[pts.length-1][1];
  for(let i=0;i<pts.length-1;i++) {
    if(p>=pts[i][0]&&p<=pts[i+1][0]) { const t=(p-pts[i][0])/(pts[i+1][0]-pts[i][0]); return pts[i][1]+t*(pts[i+1][1]-pts[i][1]); }
  }
  return p;
}

function applyCalib(h,d,a,pts) {
  const ch=lerpCalWith(h,pts),cd=lerpCalWith(d,pts),ca=lerpCalWith(a,pts),t=ch+cd+ca;
  if(t<=0) return {h:1/3,d:1/3,a:1/3};
  return {h:ch/t,d:cd/t,a:ca/t};
}

// ─── Metric functions ─────────────────────────────────────────────────────────
const eps = 1e-9;

function brier(preds) {
  return preds.reduce((s,p) => {
    const oH=p.actual==='H'?1:0, oD=p.actual==='D'?1:0, oA=p.actual==='A'?1:0;
    return s + (p.h-oH)**2 + (p.d-oD)**2 + (p.a-oA)**2;
  }, 0) / preds.length;
}

function logLoss(preds) {
  return -preds.reduce((s,p) => {
    const pr = p.actual==='H'?p.h : p.actual==='D'?p.d : p.a;
    return s + Math.log(clamp(pr,eps,1-eps));
  }, 0) / preds.length;
}

function rps(preds) {
  return preds.reduce((s,p) => {
    const cdf=[p.h,p.h+p.d,1];
    const act=p.actual==='H'?[1,1,1]:p.actual==='D'?[0,1,1]:[0,0,1];
    return s + ((cdf[0]-act[0])**2+(cdf[1]-act[1])**2)/2;
  }, 0) / preds.length;
}

function ece(preds, bins=10) {
  const buckets=Array.from({length:bins},()=>({sp:0,sa:0,n:0}));
  for (const p of preds) {
    for (const [pred,act] of [[p.h,p.actual==='H'?1:0],[p.d,p.actual==='D'?1:0],[p.a,p.actual==='A'?1:0]]) {
      const b=Math.min(Math.floor(pred*bins),bins-1);
      buckets[b].sp+=pred; buckets[b].sa+=act; buckets[b].n++;
    }
  }
  const filled=buckets.filter(b=>b.n>0);
  return filled.reduce((s,b)=>s+(b.n/(preds.length*3))*Math.abs(b.sp/b.n-b.sa/b.n),0);
}

function acc(preds) {
  return preds.filter(p=>(p.h>p.d&&p.h>p.a?'H':p.a>p.d?'A':'D')===p.actual).length/preds.length;
}

function drawBias(preds, actualDR) {
  return preds.reduce((s,p)=>s+p.d,0)/preds.length - actualDR;
}

// ─── Single-season walk-forward ───────────────────────────────────────────────
function runSeason(fixtures, seasonLabel) {
  const MIN_HISTORY = 5;
  const rawPreds = [];
  const mktPreds = [];  // market implied probs (B365)

  for (let i=0; i<fixtures.length; i++) {
    const fix    = fixtures[i];
    const before = fixtures.slice(0,i);
    if (before.length < MIN_HISTORY) continue;

    const totH = before.reduce((s,f)=>s+(f.team_h_score??0),0);
    const totA = before.reduce((s,f)=>s+(f.team_a_score??0),0);
    const laH  = totH/before.length, laA = totA/before.length;

    const rolling = buildRollingRatings(before,laH,laA);
    const elo     = buildEloRatings(before);

    const hId=fix.team_h, aId=fix.team_a;
    const hFD = buildForm(before,hId), aFD = buildForm(before,aId);
    const { lH, lA } = buildLambdas(hId,aId,hFD,aFD,rolling,elo,laH,laA);

    const mat  = buildMatrix(lH,lA);
    const p    = matrixProbs(mat);
    const hG   = fix.team_h_score, aG = fix.team_a_score;
    const act  = hG>aG?'H':hG<aG?'A':'D';

    rawPreds.push({ h:p.h, d:p.d, a:p.a, actual:act, lH, lA });

    // Market implied (B365) — convert odds → remove overround → normalize
    if (fix.b365H && fix.b365D && fix.b365A) {
      const mH=1/fix.b365H, mD=1/fix.b365D, mA=1/fix.b365A, mt=mH+mD+mA;
      mktPreds.push({ h:mH/mt, d:mD/mt, a:mA/mt, actual:act,
                      modelH:p.h, modelD:p.d, modelA:p.a, fix });
    }
  }

  if (!rawPreds.length) return null;

  // Fit calibration independently for this season via PAV
  const calibPts  = fitPAV(rawPreds);
  const calibPreds = rawPreds.map(p => {
    const c = applyCalib(p.h,p.d,p.a,calibPts);
    return { h:c.h, d:c.d, a:c.a, actual:p.actual };
  });

  const actualDR = rawPreds.filter(p=>p.actual==='D').length/rawPreds.length;
  const actualHR = rawPreds.filter(p=>p.actual==='H').length/rawPreds.length;
  const actualAR = rawPreds.filter(p=>p.actual==='A').length/rawPreds.length;

  return {
    season: seasonLabel,
    n: rawPreds.length,
    actualHR, actualDR, actualAR,
    raw:   { brier:brier(rawPreds),   ll:logLoss(rawPreds),   rpsV:rps(rawPreds),   eceV:ece(rawPreds),   accV:acc(rawPreds)   },
    calib: { brier:brier(calibPreds), ll:logLoss(calibPreds), rpsV:rps(calibPreds), eceV:ece(calibPreds), accV:acc(calibPreds) },
    drawBiasRaw:   drawBias(rawPreds,   actualDR),
    drawBiasCalib: drawBias(calibPreds, actualDR),
    avgLH: rawPreds.reduce((s,p)=>s+p.lH,0)/rawPreds.length,
    avgLA: rawPreds.reduce((s,p)=>s+p.lA,0)/rawPreds.length,
    calibPts,
    mktPreds,   // for Phase 5
  };
}

// ─── Market-relative (CLV) evaluation ────────────────────────────────────────
function runMarketEval(mktPreds) {
  if (!mktPreds.length) return null;

  // For each fixture compute: edge = model_prob_of_correct_outcome - market_implied
  // then track accuracy within edge buckets.
  // "Correct outcome" = the outcome that actually happened.
  const enriched = mktPreds.map(p => {
    const mktP  = p.actual==='H'?p.h  : p.actual==='D'?p.d  : p.a;
    const modP  = p.actual==='H'?p.modelH : p.actual==='D'?p.modelD : p.modelA;
    const edge  = modP - mktP;   // positive = model more confident in what happened
    const win   = p.actual === (p.modelH>p.modelD&&p.modelH>p.modelA?'H':p.modelA>p.modelD?'A':'D');
    return { edge, win, modP, mktP, actual:p.actual };
  });

  // Edge buckets
  const edgeBuckets = [
    { label: '< −0.10 (model far below mkt)', filter: e => e.edge < -0.10 },
    { label: '−0.10 to −0.05',                filter: e => e.edge >= -0.10 && e.edge < -0.05 },
    { label: '−0.05 to  0.00',                filter: e => e.edge >= -0.05 && e.edge <  0.00 },
    { label: ' 0.00 to +0.05',                filter: e => e.edge >=  0.00 && e.edge <  0.05 },
    { label: '+0.05 to +0.10',                filter: e => e.edge >=  0.05 && e.edge <  0.10 },
    { label: '> +0.10 (model far above mkt)', filter: e => e.edge >= 0.10 },
  ];

  // Overall model vs market metrics
  const mktRaw   = mktPreds.map(p => ({ h:p.h, d:p.d, a:p.a, actual:p.actual }));
  const modRaw   = mktPreds.map(p => ({ h:p.modelH, d:p.modelD, a:p.modelA, actual:p.actual }));
  const mktBrier = brier(mktRaw);
  const modBrier = brier(modRaw);
  const mktLL    = logLoss(mktRaw);
  const modLL    = logLoss(modRaw);
  const mktAcc   = acc(mktRaw);
  const modAcc   = acc(modRaw);

  return { enriched, edgeBuckets, mktBrier, modBrier, mktLL, modLL, mktAcc, modAcc };
}

// ─── Output helpers ───────────────────────────────────────────────────────────
const pct = v => v!=null ? `${(v*100).toFixed(2)}%` : ' N/A  ';
const pp  = (v) => `${v>=0?'+':''}${(v*100).toFixed(2)}pp`;
const f4  = v => v.toFixed(4);
const L   = '═'.repeat(100);
const l   = '─'.repeat(100);
const c   = (s,w,r=false) => r ? String(s).padStart(w) : String(s).padEnd(w);

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(L);
  console.log('  MULTI-SEASON EVALUATION + MARKET-RELATIVE (CLV) VALIDATION');
  console.log('  Data: football-data.co.uk  |  Seasons: 2022-23, 2023-24, 2024-25');
  console.log(L + '\n');

  const seasonResults = [];

  for (const { label, url } of SEASONS) {
    process.stdout.write(`  Fetching ${label}... `);
    let csvText;
    try {
      const res = await axios.get(url, { timeout: 15000, responseType: 'text' });
      csvText = res.data;
    } catch (err) {
      console.log(`FAILED (${err.message}) — skipping.`);
      continue;
    }

    const rows     = parseCSV(csvText);
    const { fixtures } = convertFixtures(rows);
    console.log(`${rows.length} rows → ${fixtures.length} fixtures`);

    process.stdout.write(`  Running walk-forward (${fixtures.length} games)... `);
    const result = runSeason(fixtures, label);
    if (!result) { console.log('insufficient data.'); continue; }
    console.log(`done. n=${result.n}`);

    seasonResults.push(result);
  }

  if (!seasonResults.length) {
    console.log('\n  No season data could be fetched. Check network access.');
    return;
  }

  // ─── Phase 3: Per-season metric table ───────────────────────────────────────
  console.log('\n' + L);
  console.log('  PHASE 3 — PER-SEASON METRICS\n');

  // Header
  const cols = [' Season ', 'n', 'Brier(R)', 'Brier(C)', 'LL(R)', 'LL(C)', 'RPS(R)', 'RPS(C)',
                'ECE(R)', 'ECE(C)', 'Acc(C)%', 'DrawBiasR', 'DrawBiasC', 'AvgλH', 'AvgλA'];
  const ws   = [9,5,9,9,7,7,8,8,8,8,9,11,11,7,7];
  console.log('  ' + cols.map((h,i)=>c(h,ws[i],true)).join(' '));
  console.log('  ' + l.slice(0,ws.reduce((s,w)=>s+w+1,0)));

  for (const r of seasonResults) {
    const row = [
      r.season, String(r.n),
      f4(r.raw.brier),  f4(r.calib.brier),
      f4(r.raw.ll),     f4(r.calib.ll),
      f4(r.raw.rpsV),   f4(r.calib.rpsV),
      pct(r.raw.eceV),  pct(r.calib.eceV),
      pct(r.calib.accV),
      pp(r.drawBiasRaw), pp(r.drawBiasCalib),
      r.avgLH.toFixed(3), r.avgLA.toFixed(3),
    ];
    console.log('  ' + row.map((v,i)=>c(v,ws[i],true)).join(' '));
  }

  // Aggregate row
  const aggN      = seasonResults.reduce((s,r)=>s+r.n,0);
  const agg = metric => seasonResults.reduce((s,r)=>s+metric(r)*r.n,0)/aggN;
  console.log('  ' + l.slice(0,ws.reduce((s,w)=>s+w+1,0)));
  const aggRow = [
    'COMBINED', String(aggN),
    f4(agg(r=>r.raw.brier)),   f4(agg(r=>r.calib.brier)),
    f4(agg(r=>r.raw.ll)),      f4(agg(r=>r.calib.ll)),
    f4(agg(r=>r.raw.rpsV)),    f4(agg(r=>r.calib.rpsV)),
    pct(agg(r=>r.raw.eceV)),   pct(agg(r=>r.calib.eceV)),
    pct(agg(r=>r.calib.accV)),
    pp(agg(r=>r.drawBiasRaw)), pp(agg(r=>r.drawBiasCalib)),
    agg(r=>r.avgLH).toFixed(3), agg(r=>r.avgLA).toFixed(3),
  ];
  console.log('  ' + aggRow.map((v,i)=>c(v,ws[i],true)).join(' '));

  // Cross-season stability check
  console.log('\n  Cross-season stability (should be consistent, not erratic):\n');
  const metrics = ['brier(R)', 'brier(C)', 'ECE(C)', 'DrawBias(C)'];
  for (const metricLabel of metrics) {
    const vals = seasonResults.map(r => {
      if (metricLabel==='brier(R)')     return r.raw.brier;
      if (metricLabel==='brier(C)')     return r.calib.brier;
      if (metricLabel==='ECE(C)')       return r.calib.eceV;
      if (metricLabel==='DrawBias(C)')  return Math.abs(r.drawBiasCalib);
      return 0;
    });
    const mean = vals.reduce((s,v)=>s+v,0)/vals.length;
    const std  = Math.sqrt(vals.reduce((s,v)=>s+(v-mean)**2,0)/vals.length);
    const cv   = std/mean; // coefficient of variation
    const stable = cv < 0.12; // <12% CV = stable generalisation
    console.log(`    ${metricLabel.padEnd(14)}: ${vals.map(v=>v.toFixed(4)).join('  ')}  │  CV=${(cv*100).toFixed(1)}%  ${stable?'✓ stable':'⚠ variable'}`);
  }

  // CALIB_POINTS per season (for inspection)
  console.log('\n  Fitted CALIB_POINTS per season (PAV isotonic):\n');
  for (const r of seasonResults) {
    const pts = r.calibPts.map(([x,y])=>`[${x.toFixed(3)}, ${y.toFixed(3)}]`).join(', ');
    console.log(`  ${r.season}:  [${pts}]`);
  }

  // ─── Phase 5: Market-relative evaluation ────────────────────────────────────
  console.log('\n' + L);
  console.log('  PHASE 5 — MARKET-RELATIVE (CLV) EVALUATION\n');

  // Pool market predictions across all seasons
  const allMktPreds = seasonResults.flatMap(r => r.mktPreds);

  if (!allMktPreds.length) {
    console.log('  No B365 odds data available in fetched CSVs. Market evaluation skipped.');
  } else {
    console.log(`  Fixtures with B365 odds: ${allMktPreds.length}\n`);

    const mEval = runMarketEval(allMktPreds);

    // Model vs market head-to-head (on the fixtures with odds data)
    console.log('  Head-to-head (on fixtures with B365 odds):\n');
    console.log(`  ${'Metric'.padEnd(20)} ${'Market (B365)'.padStart(14)} ${'Model (raw)'.padStart(14)} ${'Model edge'.padStart(12)}`);
    console.log('  ' + l.slice(0,62));
    console.log(`  ${'Brier'.padEnd(20)} ${f4(mEval.mktBrier).padStart(14)} ${f4(mEval.modBrier).padStart(14)} ${(mEval.modBrier<mEval.mktBrier?'✓ ':' ')+(((mEval.mktBrier-mEval.modBrier)*1000).toFixed(1)+'×10⁻³').padStart(12)}`);
    console.log(`  ${'Log-Loss'.padEnd(20)} ${f4(mEval.mktLL).padStart(14)} ${f4(mEval.modLL).padStart(14)} ${(mEval.modLL<mEval.mktLL?'✓ ':' ')+(((mEval.mktLL-mEval.modLL)*100).toFixed(2)+'×10⁻²').padStart(12)}`);
    console.log(`  ${'Accuracy'.padEnd(20)} ${pct(mEval.mktAcc).padStart(14)} ${pct(mEval.modAcc).padStart(14)}`);

    // Edge bucket analysis
    console.log('\n  Accuracy by model-vs-market edge bucket (CLV analysis):\n');
    console.log(`  ${'Edge bucket'.padEnd(34)} ${'n'.padStart(5)} ${'Hit rate'.padStart(10)} ${'Avg edge'.padStart(10)} ${'Interpretation'}`);
    console.log('  ' + l.slice(0,80));
    for (const { label, filter } of mEval.edgeBuckets) {
      const seg = mEval.enriched.filter(filter);
      if (!seg.length) continue;
      const hits   = seg.filter(e=>e.win).length;
      const hitPct = hits/seg.length;
      const avgEdge= seg.reduce((s,e)=>s+e.edge,0)/seg.length;
      const interp = avgEdge > 0.05 ? '▲ model strongly above market'
                   : avgEdge < -0.05 ? '▼ model strongly below market'
                   : '≈ model near market';
      console.log(`  ${label.padEnd(34)} ${String(seg.length).padStart(5)} ${pct(hitPct).padStart(10)} ${pp(avgEdge).padStart(10)}  ${interp}`);
    }

    // Outcome-specific market comparison
    console.log('\n  Market vs model by outcome:\n');
    for (const outcome of ['H','D','A']) {
      const sub = allMktPreds.filter(p => p.actual===outcome);
      if (!sub.length) continue;
      const avgMkt = sub.reduce((s,p)=>s+(outcome==='H'?p.h:outcome==='D'?p.d:p.a),0)/sub.length;
      const avgMod = sub.reduce((s,p)=>s+(outcome==='H'?p.modelH:outcome==='D'?p.modelD:p.modelA),0)/sub.length;
      const freq   = sub.length / allMktPreds.length;
      console.log(`  ${outcome} wins (${sub.length} fixtures, ${pct(freq)} of total):`);
      console.log(`    Market avg implied: ${pct(avgMkt)}   Model avg:  ${pct(avgMod)}   Δ: ${pp(avgMod-avgMkt)}`);
    }

    // Overall CLV summary
    const posEdge = mEval.enriched.filter(e=>e.edge>0.03);
    const negEdge = mEval.enriched.filter(e=>e.edge<-0.03);
    const posHit  = posEdge.filter(e=>e.win).length/(posEdge.length||1);
    const negHit  = negEdge.filter(e=>e.win).length/(negEdge.length||1);
    const overallHit = mEval.enriched.filter(e=>e.win).length/mEval.enriched.length;
    console.log('\n  CLV summary:\n');
    console.log(`    When model >3pp above market (n=${posEdge.length}): hit rate ${pct(posHit)}`);
    console.log(`    When model >3pp below market (n=${negEdge.length}): hit rate ${pct(negHit)}`);
    console.log(`    Overall on market fixtures: hit rate ${pct(overallHit)}`);
    const hasEdge = mEval.modBrier < mEval.mktBrier && posHit > overallHit;
    console.log(`\n    Verdict: ${hasEdge
      ? '✓ Model shows genuine edge vs B365 (lower Brier AND higher hit rate at positive edge).'
      : '○ Model has no systematic edge vs B365 closing lines on these fixtures.'}`);
    console.log('    Note: Edge analysis requires large samples to be statistically meaningful.');
    console.log('    This evaluation uses CLOSING B365 odds — the sharpest market line.');
  }

  console.log('\n' + L + '\n');
}

main().catch(err => { console.error('Fatal:', err.message, err.stack); process.exit(1); });
