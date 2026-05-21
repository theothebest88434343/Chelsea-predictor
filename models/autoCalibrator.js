'use strict';

/**
 * autoCalibrator.js
 *
 * Model Health Advisor for the WC ELO prediction system.
 *
 * Reads diagnostics output → detects bias patterns → produces recommendations.
 *
 * STRICT RULES:
 *   ✗ Does NOT modify ELO ratings
 *   ✗ Does NOT touch Poisson / simulation logic
 *   ✗ Does NOT apply changes automatically
 *   ✓ Purely deterministic — same diagnostics input always produces same output
 *   ✓ All recommendations reference actual parameter names in server.js / predictionEngine.js
 */

// ─── Known parameter reference table ─────────────────────────────────────────
// These are the actual variables the calibrator references in its suggestions.
// Kept here so recommendations stay in sync with the codebase.

const PARAMS = {
  intraConfedMultiplier: {
    file: 'server.js → buildDynamicElo()',
    variable: 'K = baseK * (isCrossConfed ? 1.0 : 0.87)',
    currentIntra: 0.87,
    safeRange: [0.80, 0.92],
  },
  crossConfedBoost: {
    file: 'server.js → buildDynamicElo()',
    variable: 'K = baseK * (isCrossConfed ? 1.0 : …)',
    currentCross: 1.0,
    safeRange: [1.0, 1.08],
  },
  adaptiveAlphaCap: {
    file: 'server.js → buildDynamicElo() credibility block',
    variable: 'alpha = clamp(n / 25, 0.15, 0.85)',
    currentCap: 0.85,
    safeRange: [0.75, 0.90],
  },
  adaptiveAlphaDivisor: {
    file: 'server.js → buildDynamicElo() credibility block',
    variable: 'alpha = clamp(n / 25 …)',
    currentDivisor: 25,
    safeRange: [18, 35],
  },
  confedLambdaCAF: {
    file: 'server.js → CONFED_LAMBDA_FACTOR',
    variable: 'CAF: 0.97',
    currentValue: 0.97,
    safeRange: [0.93, 1.00],
  },
  confedLambdaAFC: {
    file: 'server.js → CONFED_LAMBDA_FACTOR',
    variable: 'AFC: 0.97',
    currentValue: 0.97,
    safeRange: [0.93, 1.00],
  },
  wcKFactor: {
    file: 'server.js → kFactor()',
    variable: 'K = 60 (World Cup)',
    currentValue: 60,
    safeRange: [50, 70],
  },
  decayYear3Multiplier: {
    file: 'server.js → kFactor()',
    variable: 'ageDays > 1095 → K *= 0.35',
    currentValue: 0.35,
    safeRange: [0.25, 0.50],
  },
};

// ─── Severity helpers ─────────────────────────────────────────────────────────

const SEV = { HIGH: 3, MEDIUM: 2, LOW: 1 };

function sortBySeverity(issues) {
  return [...issues].sort((a, b) => (SEV[b.severity] ?? 0) - (SEV[a.severity] ?? 0));
}

// ─── Detection 1: CAF / AFC Clustering ───────────────────────────────────────
// Clustering = CAF/AFC teams bunching tightly in global rank bands.
// Signals: LOW eloSpread relative to UEFA, or HIGH/MEDIUM cluster score.

function detectClustering(diagnostics) {
  const issues = [];
  const { clusteringIndex, confedInflation } = diagnostics;

  const uefaSpread   = clusteringIndex['UEFA']?.eloSpread ?? 100;
  const targets      = ['CAF', 'AFC'];

  for (const confed of targets) {
    const cl  = clusteringIndex[confed];
    const inf = confedInflation[confed];
    if (!cl || !inf) continue;

    const spreadRatio     = cl.eloSpread / uefaSpread;   // 1.0 = same spread as UEFA
    const isHighClustered = cl.clusterScore === 'HIGH';
    const isMedClustered  = cl.clusterScore === 'MEDIUM';
    const hasSpreadProblem = spreadRatio < 0.55;          // spread < 55% of UEFA = compressed
    const hasBandPile     = cl.bandAlert;

    if (!isHighClustered && !isMedClustered && !hasSpreadProblem && !hasBandPile) continue;

    // Determine severity
    let severity;
    if (isHighClustered || (hasSpreadProblem && spreadRatio < 0.40)) severity = 'HIGH';
    else if (isMedClustered || hasSpreadProblem)                       severity = 'MEDIUM';
    else                                                               severity = 'LOW';

    issues.push({
      id:       `clustering_${confed}`,
      category: 'CLUSTERING',
      confed,
      severity,
      signals: {
        clusterScore:  cl.clusterScore,
        eloSpread:     cl.eloSpread,
        uefaSpread,
        spreadRatio:   Math.round(spreadRatio * 100) / 100,
        bandAlert:     hasBandPile,
        rankBands:     cl.rankBands,
      },
      issue: `${confed} teams are compressed into a narrow ELO band (spread ${cl.eloSpread} vs UEFA ${uefaSpread})`,
      recommendations: [
        {
          action: 'Reduce intra-confederation K multiplier slightly',
          effect: 'Weakens within-confederation signals, forces more global signal reliance',
          param:  PARAMS.intraConfedMultiplier,
          delta:  severity === 'HIGH' ? '0.87 → 0.83 (max reduction)' : '0.87 → 0.85',
          risk:   'LOW — small change, easy to revert',
        },
        {
          action: 'Increase adaptive alpha divisor',
          effect: 'Teams need more matches to escape prior anchoring — slows convergence to ELO, preserves prior differentiation longer',
          param:  PARAMS.adaptiveAlphaDivisor,
          delta:  severity === 'HIGH' ? '25 → 30' : '25 → 27',
          risk:   'LOW — only affects blending speed, not ELO update mechanics',
        },
      ],
      preferredFix: 'intra-confederation K multiplier reduction',
    });
  }

  return issues;
}

// ─── Detection 2: Confederation Inflation ────────────────────────────────────
// Inflation = CAF/AFC mean ELO is too close to UEFA, or heavily overlaps UEFA mid-tier.
// Expected gap: CAF ~100–170 below UEFA mean, AFC ~80–150 below.

const EXPECTED_UEFA_GAP = { CAF: -130, AFC: -110, CONCACAF: -90 };
const INFLATION_TOLERANCE = 40;   // allow ±40 pts before flagging

function detectInflation(diagnostics) {
  const issues = [];
  const { confedInflation, overlapScores } = diagnostics;

  for (const [confed, expected] of Object.entries(EXPECTED_UEFA_GAP)) {
    const inf = confedInflation[confed];
    if (!inf) continue;

    const gapDeviation   = inf.uefaGap - expected;         // positive = inflated above expected
    const uefaOverlap    = overlapScores.matrix?.[confed]?.['UEFA'] ?? 0;
    const isInflated     = gapDeviation > INFLATION_TOLERANCE;
    const isHighOverlap  = uefaOverlap > 0.60;

    if (!isInflated && !isHighOverlap) continue;

    let severity;
    if (gapDeviation > INFLATION_TOLERANCE * 2.5 || uefaOverlap > 0.80) severity = 'HIGH';
    else if (gapDeviation > INFLATION_TOLERANCE || uefaOverlap > 0.60)   severity = 'MEDIUM';
    else                                                                  severity = 'LOW';

    issues.push({
      id:       `inflation_${confed}`,
      category: 'INFLATION',
      confed,
      severity,
      signals: {
        actualUefaGap:    inf.uefaGap,
        expectedUefaGap:  expected,
        gapDeviation:     Math.round(gapDeviation),
        uefaOverlap,
        confedMeanElo:    inf.meanElo,
      },
      issue: `${confed} mean ELO (${inf.meanElo}) is ${Math.round(gapDeviation)} pts above expected gap from UEFA. UEFA overlap: ${uefaOverlap.toFixed(2)}.`,
      recommendations: [
        {
          action: 'Reduce adaptive alpha cap',
          effect: 'Limits how far teams can move from priors regardless of match count — damps upward drift from regional wins',
          param:  PARAMS.adaptiveAlphaCap,
          delta:  severity === 'HIGH' ? '0.85 → 0.78' : '0.85 → 0.82',
          risk:   'MEDIUM — reduces ELO signal trust broadly, monitor top-tier separation',
        },
        {
          action: `Reduce CONFED_LAMBDA_FACTOR for ${confed}`,
          effect: 'Lowers predicted goal rate for inflated confederation at match time without touching ELO',
          param:  confed === 'CAF' ? PARAMS.confedLambdaCAF : PARAMS.confedLambdaAFC,
          delta:  severity === 'HIGH' ? `${confed === 'CAF' ? '0.97' : '0.97'} → 0.94` : '0.97 → 0.95',
          risk:   'LOW — match-time only, does not affect ELO standings',
        },
      ],
      preferredFix: 'Reduce adaptive alpha cap (0.85 → 0.82) to limit regional drift',
    });
  }

  return issues;
}

// ─── Detection 3: Rank Instability ───────────────────────────────────────────
// Instability = small ELO perturbations cause large rank changes (top 30 shuffle).

function detectInstability(diagnostics) {
  const issues = [];
  const { stabilityIndex } = diagnostics;
  const { stabilityScore, avgVariance, mostVolatile } = stabilityIndex;

  if (stabilityScore >= 60) return issues;

  const severity = stabilityScore < 35 ? 'HIGH' : stabilityScore < 50 ? 'MEDIUM' : 'LOW';

  // Identify the confederation most represented in volatile teams
  const volatileConfeds = {};
  for (const v of (mostVolatile ?? [])) {
    if (v.confederation) {
      volatileConfeds[v.confederation] = (volatileConfeds[v.confederation] ?? 0) + 1;
    }
  }
  const topVolatileConfed = Object.entries(volatileConfeds)
    .sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'unknown';

  issues.push({
    id:       'instability_global',
    category: 'INSTABILITY',
    severity,
    signals: {
      stabilityScore,
      avgVariance,
      topVolatileConfed,
      volatileTeamCount: mostVolatile?.filter(v => v.meanShift > 2).length ?? 0,
    },
    issue: `Global rank stability score is ${stabilityScore}/100 (threshold: 60). Avg rank variance under ±5 ELO perturbation: ${avgVariance}.`,
    recommendations: [
      {
        action: 'Increase adaptive alpha divisor to slow convergence',
        effect: 'Teams need more matches to reach high ELO trust, increasing prior anchoring stability',
        param:  PARAMS.adaptiveAlphaDivisor,
        delta:  severity === 'HIGH' ? '25 → 32' : '25 → 28',
        risk:   'LOW — does not affect ELO update mechanics, only prior blending',
      },
      {
        action: 'Reduce WC K-factor slightly',
        effect: 'Dampens impact of single WC results on long-term ELO, smooths variance from tournament runs',
        param:  PARAMS.wcKFactor,
        delta:  severity === 'HIGH' ? '60 → 52' : '60 → 55',
        risk:   'MEDIUM — reduces signal from most important matches; only use if instability is severe',
      },
    ],
    preferredFix: 'Increase adaptive alpha divisor — safer than touching K-factors',
  });

  return issues;
}

// ─── Detection 4: Over-Damping (Elite Separation) ────────────────────────────
// Over-damping = top-tier teams (France/Argentina/Spain) are too close to each other
// and/or too close to mid-tier teams. Caused by excessive prior pull or credibility shrink.

function detectOverDamping(diagnostics) {
  const issues = [];
  const { confedInflation } = diagnostics;

  const uefaInf    = confedInflation['UEFA'];
  const conmInf    = confedInflation['CONMEBOL'];
  if (!uefaInf || !conmInf) return issues;

  // Elite separation metric: how far is the absolute top from the top-5 average?
  // top5Mean ≈ average of best 5 teams. maxElo ≈ the single best team.
  // Wide gap (>60) = healthy spread at the top. Narrow (<40) = over-damped.
  const uefaEliteGap = uefaInf.maxElo - uefaInf.top5Mean;   // e.g. France 1854 vs mean of top5 = gap
  const conmEliteGap = conmInf.maxElo - conmInf.top5Mean;

  // Also check internal UEFA spread — if very low, top teams are bunching
  const uefaInternalSpread = uefaInf.spread;

  const eliteGapTooNarrow = uefaEliteGap < 40 || conmEliteGap < 35;
  const topTierCompressed = uefaInternalSpread < 45;

  if (!eliteGapTooNarrow && !topTierCompressed) return issues;

  let severity;
  if ((uefaEliteGap < 25 || conmEliteGap < 20) && topTierCompressed) severity = 'HIGH';
  else if (eliteGapTooNarrow || topTierCompressed)                    severity = 'MEDIUM';
  else                                                                severity = 'LOW';

  issues.push({
    id:       'overdamping_elite',
    category: 'OVER_DAMPING',
    severity,
    signals: {
      uefaEliteGap:      uefaEliteGap,
      conmEliteGap:      conmEliteGap,
      uefaInternalSpread: uefaInternalSpread,
      uefaMaxElo:        uefaInf.maxElo,
      uefaTop5Mean:      uefaInf.top5Mean,
    },
    issue: `Elite top-tier separation is compressed. UEFA gap (max→top5 avg): ${uefaEliteGap} pts (healthy: >60). UEFA internal spread: ${uefaInternalSpread} (healthy: >55).`,
    recommendations: [
      {
        action: 'Reduce adaptive alpha cap to allow stronger prior anchoring at extremes',
        effect: 'Paradoxically, less extreme ELO drift means priors (which are more spread) dominate more at the top — widens the gap between elite-seeded and mid-seeded teams',
        param:  PARAMS.adaptiveAlphaCap,
        delta:  '0.85 → 0.80',
        risk:   'MEDIUM — monitor that mid-tier teams do not inflate toward top',
      },
      {
        action: 'Increase WC K-factor to amplify elite match signal',
        effect: 'WC finals between Argentina/France/Spain produce larger ELO swings — top teams separate further based on WC outcomes',
        param:  PARAMS.wcKFactor,
        delta:  '60 → 65',
        risk:   'MEDIUM — also increases volatility; only combine with stable model',
      },
    ],
    preferredFix: 'Verify FIFA_STRENGTH priors first — if Argentina/France priors are too close, that is the root cause',
    note: 'Check FIFA_STRENGTH priors in server.js directly before adjusting alpha. Prior spread is the primary lever for elite separation.',
  });

  return issues;
}

// ─── Detection 5: Model Drift ─────────────────────────────────────────────────
// Structural drift = significant rank or ELO changes between model snapshots.
// Usually triggered by a parameter change or new batch of ELO-impacting results.

function detectDrift(diagnostics) {
  const issues = [];
  const { driftReport } = diagnostics;

  if (!driftReport.available) return issues;
  if (!driftReport.structuralShift) return issues;

  const severity = (driftReport.avgEloDrift > 30 || driftReport.maxRankShift > 12)
    ? 'HIGH'
    : (driftReport.avgEloDrift > 15 || driftReport.maxRankShift > 8)
    ? 'MEDIUM'
    : 'LOW';

  // Detect if drift is confederation-specific
  const driftByConfed = {};
  for (const m of (driftReport.bigMovers ?? [])) {
    if (m.confederation) {
      if (!driftByConfed[m.confederation]) driftByConfed[m.confederation] = [];
      driftByConfed[m.confederation].push(m);
    }
  }
  const confedConcentrated = Object.entries(driftByConfed)
    .filter(([, movers]) => movers.length >= 3)
    .map(([confed]) => confed);

  issues.push({
    id:       'drift_structural',
    category: 'MODEL_DRIFT',
    severity,
    signals: {
      avgEloDrift:       driftReport.avgEloDrift,
      maxRankShift:      driftReport.maxRankShift,
      teamsTracked:      driftReport.totalTeamsTracked,
      confedConcentrated,
      topMovers:         (driftReport.bigMovers ?? []).slice(0, 5).map(m => ({
        team: m.team, rankDelta: m.rankDelta, eloDelta: Math.round(m.eloDelta),
      })),
    },
    issue: `Structural model drift detected. Avg ELO change: ${driftReport.avgEloDrift}, max rank shift: ${driftReport.maxRankShift}.${confedConcentrated.length ? ` Drift concentrated in: ${confedConcentrated.join(', ')}.` : ''}`,
    recommendations: [
      {
        action: 'Review recent parameter changes',
        effect: 'Identify which change caused the drift before adjusting anything else',
        param:  null,
        delta:  'Audit git diff server.js → compare WC_MODEL_VERSION change log',
        risk:   'NONE — investigative step only',
      },
      {
        action: confedConcentrated.length
          ? `Check if ${confedConcentrated[0]} recent match results (AFCON / qualifiers) drove the shift`
          : 'Verify no new international result dataset was loaded with scoring anomalies',
        effect: 'Confirm drift is results-driven (expected) vs parameter-driven (investigate)',
        param:  null,
        delta:  'No parameter change yet — diagnosis first',
        risk:   'NONE',
      },
    ],
    preferredFix: 'Diagnose before acting — drift may be correct if results genuinely changed',
  });

  return issues;
}

// ─── Confidence score ─────────────────────────────────────────────────────────
// How confident is the calibrator in its own assessment?
// Based on: data completeness, issue clarity, drift availability.

function computeConfidence(allIssues, diagnostics) {
  let score = 1.0;

  // Penalise per issue (more issues = more uncertain the model is in a stable state)
  for (const issue of allIssues) {
    if (issue.severity === 'HIGH')   score -= 0.15;
    else if (issue.severity === 'MEDIUM') score -= 0.08;
    else                             score -= 0.03;
  }

  // No drift data = less visibility
  if (!diagnostics.driftReport.available) score -= 0.05;

  // Structural drift = harder to diagnose root cause
  if (diagnostics.driftReport.available && diagnostics.driftReport.structuralShift) score -= 0.10;

  // Team count below 30 = thin data for overlap/clustering conclusions
  if (diagnostics.teamCount < 30) score -= 0.08;

  return Math.round(Math.max(0.10, Math.min(1.0, score)) * 100) / 100;
}

// ─── Plain-English summary ────────────────────────────────────────────────────

function buildExplanation(status, issues, diagnostics) {
  const { stabilityIndex, confedInflation } = diagnostics;

  if (issues.length === 0) {
    return `Model is operating within healthy parameters. ELO spreads, confederation gaps, and rank stability all pass thresholds. No calibration action needed.`;
  }

  const highIssues   = issues.filter(i => i.severity === 'HIGH');
  const medIssues    = issues.filter(i => i.severity === 'MEDIUM');
  const categories   = [...new Set(issues.map(i => i.category))];

  const parts = [];

  if (highIssues.length) {
    parts.push(`${highIssues.length} high-severity issue${highIssues.length > 1 ? 's' : ''} detected: ${highIssues.map(i => i.issue.split('.')[0]).join('; ')}.`);
  }
  if (medIssues.length) {
    parts.push(`${medIssues.length} medium-severity issue${medIssues.length > 1 ? 's' : ''} also present.`);
  }
  if (categories.includes('CLUSTERING')) {
    const clIssues = issues.filter(i => i.category === 'CLUSTERING');
    parts.push(`CAF/AFC rating spread is ${clIssues.map(i => `${i.signals.eloSpread} (${i.confed})`).join(', ')} vs UEFA ${clIssues[0]?.signals.uefaSpread} — tighter than expected. Teams are not separating based on quality differences.`);
  }
  if (categories.includes('INFLATION')) {
    parts.push(`One or more confederations are rating higher than historical WC performance justifies, causing overlap with UEFA mid-tier.`);
  }
  if (categories.includes('INSTABILITY')) {
    parts.push(`Rank stability score is ${stabilityIndex.stabilityScore}/100. Small ELO perturbations are causing meaningful rank shuffles in the top 30.`);
  }
  if (categories.includes('OVER_DAMPING')) {
    parts.push(`Elite tier (France/Argentina/Spain class) is not spreading enough from upper-mid-tier teams. Top-tier prior differentiation may need review.`);
  }
  if (categories.includes('MODEL_DRIFT')) {
    parts.push(`Structural drift vs previous snapshot — diagnose before applying any new calibration.`);
  }

  const preferred = issues
    .filter(i => i.preferredFix)
    .slice(0, 2)
    .map(i => i.preferredFix);
  if (preferred.length) {
    parts.push(`Recommended starting point: ${preferred.join(' | ')}.`);
  }

  return parts.join(' ');
}

// ─── Master entry point ───────────────────────────────────────────────────────

/**
 * Generate a calibration recommendation report from diagnostics output.
 *
 * @param {Object} diagnostics — output of runDiagnostics() from modelDiagnostics.js
 * @returns {Object} calibration report
 */
function generateCalibrationReport(diagnostics) {
  // Run all detectors
  const rawIssues = [
    ...detectClustering(diagnostics),
    ...detectInflation(diagnostics),
    ...detectInstability(diagnostics),
    ...detectOverDamping(diagnostics),
    ...detectDrift(diagnostics),
  ];

  const issues     = sortBySeverity(rawIssues);
  const status     = issues.some(i => i.severity === 'HIGH')
    ? 'DEGRADED'
    : issues.some(i => i.severity === 'MEDIUM')
    ? 'WARNING'
    : issues.length > 0
    ? 'ATTENTION'
    : 'HEALTHY';

  const confidence   = computeConfidence(issues, diagnostics);
  const explanation  = buildExplanation(status, issues, diagnostics);

  // Flatten top recommended changes, deduplicated by action string
  const seen = new Set();
  const recommendedChanges = [];
  for (const issue of issues) {
    const pref = issue.recommendations?.find(r => r.action === issue.preferredFix)
              ?? issue.recommendations?.[0];
    if (!pref) continue;
    if (seen.has(pref.action)) continue;
    seen.add(pref.action);
    recommendedChanges.push({
      priority:  recommendedChanges.length + 1,
      action:    pref.action,
      param:     pref.param ? {
        file:     pref.param.file,
        variable: pref.param.variable,
        delta:    pref.delta,
      } : { delta: pref.delta },
      risk:      pref.risk ?? 'UNKNOWN',
      triggeredBy: issue.id,
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    status,
    confidence,
    explanation,
    issueCount: {
      total:  issues.length,
      HIGH:   issues.filter(i => i.severity === 'HIGH').length,
      MEDIUM: issues.filter(i => i.severity === 'MEDIUM').length,
      LOW:    issues.filter(i => i.severity === 'LOW').length,
    },
    topIssues: issues.map(i => ({
      id:        i.id,
      category:  i.category,
      confed:    i.confed ?? null,
      severity:  i.severity,
      issue:     i.issue,
      preferred: i.preferredFix ?? null,
    })),
    recommendedChanges,
    fullIssues: issues,   // full detail including all alternatives + signals
    paramReference: PARAMS,
  };
}

module.exports = { generateCalibrationReport };
