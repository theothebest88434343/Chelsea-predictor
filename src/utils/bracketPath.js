/**
 * bracketPath.js
 *
 * Derives the most likely knockout-stage opponent for a team at each round,
 * based on the 2026 World Cup 48-team bracket structure and the Monte Carlo
 * simulation output (tournamentReach).
 *
 * ─── 2026 WC bracket structure ────────────────────────────────────────────────
 *
 * R32 (32 → 16) — 16 matches, sequential pairs → R16
 * Slot assignments:
 *   0:  A1 vs Best3rd[0]      8:  I1 vs J2
 *   1:  B1 vs Best3rd[1]      9:  J1 vs I2
 *   2:  C1 vs Best3rd[2]     10:  K1 vs L2
 *   3:  D1 vs Best3rd[3]     11:  L1 vs K2
 *   4:  E1 vs Best3rd[4]     12:  A2 vs F2
 *   5:  F1 vs Best3rd[5]     13:  B2 vs E2
 *   6:  G1 vs Best3rd[6]     14:  C2 vs H2
 *   7:  H1 vs Best3rd[7]     15:  D2 vs G2
 *
 * R16 (16 → 8) — pairs of sequential R32 winners:
 *   r16[0] = r32[0] vs r32[1]   (A,B winners + 3rds)
 *   r16[1] = r32[2] vs r32[3]   (C,D winners + 3rds)
 *   r16[2] = r32[4] vs r32[5]   (E,F winners + 3rds)
 *   r16[3] = r32[6] vs r32[7]   (G,H winners + 3rds)
 *   r16[4] = r32[8] vs r32[9]   (I/J bracket)
 *   r16[5] = r32[10] vs r32[11] (K/L bracket)
 *   r16[6] = r32[12] vs r32[13] (A2/F2 vs B2/E2)
 *   r16[7] = r32[14] vs r32[15] (C2/H2 vs D2/G2)
 *
 * QF (8 → 4) — sequential pairs of R16 winners:
 *   qf[0] = r16[0] vs r16[1]   (A,B,C,D bracket)
 *   qf[1] = r16[2] vs r16[3]   (E,F,G,H bracket)
 *   qf[2] = r16[4] vs r16[5]   (I,J,K,L bracket)
 *   qf[3] = r16[6] vs r16[7]   (runners-up bracket)
 *
 * SF (4 → 2):  sf[0] = qf[0] vs qf[1]  |  sf[1] = qf[2] vs qf[3]
 * Final:       sf[0] vs sf[1]
 */

// Which R16 section (0-7) does each bracket position (e.g. "A1", "I2") map to?
// 0 = r16[0], 1 = r16[1], ..., 7 = r16[7]
function bracketSectionFromPos(group, pos) {
  if (pos === 1) {
    if (group === 'A' || group === 'B') return 0;
    if (group === 'C' || group === 'D') return 1;
    if (group === 'E' || group === 'F') return 2;
    if (group === 'G' || group === 'H') return 3;
    if (group === 'I' || group === 'J') return 4;
    if (group === 'K' || group === 'L') return 5;
  }
  if (pos === 2) {
    // I2/J2 stay in the I/J bracket; K2/L2 stay in the K/L bracket
    if (group === 'I' || group === 'J') return 4;
    if (group === 'K' || group === 'L') return 5;
    // A2/F2 and B2/E2 → same runners-up section
    if (group === 'A' || group === 'F' || group === 'B' || group === 'E') return 6;
    // C2/H2 and D2/G2 → same runners-up section
    if (group === 'C' || group === 'H' || group === 'D' || group === 'G') return 7;
  }
  return null; // 3rd-place path is too uncertain to map
}

// QF section that each pair of R16 sections feeds into
const QF_PAIRS = [[0, 1], [2, 3], [4, 5], [6, 7]];
// SF half that each pair of QF sections feeds into
const SF_PAIRS = [[0, 1], [2, 3]];

// ─── Internal helpers ──────────────────────────────────────────────────────────

function safeDivide(a, b) {
  if (!b || b < 0.001) return 0;
  return Math.min(a / b, 1);
}

/**
 * Get the expected finishing position for a team.
 * Primary: groupPredictedStandings (model output).
 * Fallback: hardcodedGroups array order (index 0 = assumed 1st).
 */
function teamGroupPos(team, hardcodedGroups, groupPredictedStandings) {
  for (const [letter, teams] of Object.entries(hardcodedGroups ?? {})) {
    if (!teams.includes(team)) continue;
    const standings = groupPredictedStandings?.[letter] ?? [];
    const idx       = standings.findIndex(r => r.team === team);
    if (idx >= 0) return { group: letter, pos: idx + 1 };
    // Fallback: standings missing — use hardcodedGroups array order capped at pos 1
    // (safe assumption: treat every team as a potential group winner for bracket routing)
    return { group: letter, pos: 1 };
  }
  return { group: null, pos: 1 };
}

/**
 * Get the top team from a given group at a given expected position.
 * Primary:  groupPredictedStandings[group][expectedPos - 1]
 * Fallback: hardcodedGroups[group][expectedPos - 1]  (raw array order)
 */
function topTeamAtPos(group, expectedPos, groupPredictedStandings, tournamentReach, hardcodedGroups) {
  const standings = groupPredictedStandings?.[group] ?? [];
  let entry = standings[expectedPos - 1]; // 1-indexed → 0-indexed

  // Fallback: if standings data is absent, use the raw group list
  if (!entry && hardcodedGroups?.[group]) {
    const rawTeam = hardcodedGroups[group][expectedPos - 1];
    if (rawTeam) entry = { team: rawTeam };
  }
  if (!entry) return null;

  return {
    team: entry.team,
    prob: tournamentReach?.[entry.team]?.pAdvance ?? 0,
  };
}

/**
 * All teams in a given R16 section, ordered by a probability key.
 * Used to find the "most likely opponent" from a bracket region.
 */
function teamsInR16Section(
  sectionIdx,
  hardcodedGroups,
  groupPredictedStandings,
  tournamentReach,
  probKey = 'pAdvance',
) {
  const allTeams = Object.values(hardcodedGroups ?? {}).flat();
  const result   = [];

  for (const t of allTeams) {
    const { group, pos } = teamGroupPos(t, hardcodedGroups, groupPredictedStandings);
    if (bracketSectionFromPos(group, pos) === sectionIdx) {
      result.push({ team: t, prob: tournamentReach?.[t]?.[probKey] ?? 0 });
    }
  }
  return result.sort((a, b) => b.prob - a.prob);
}

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * getKnockoutPath(team, hardcodedGroups, groupPredictedStandings, tournamentReach)
 *
 * Returns:
 *   stages — array of 5 stage objects (R32 → R16 → QF → SF → Final), each with:
 *     id           — stage identifier
 *     label        — human-readable round name
 *     cumProb      — P(reach this round's winner stage) = pR16, pQF, etc.
 *     prevProb     — P(reach this round) = pAdvance, pR16, etc.
 *     condProb     — P(win this round | reached) = cumProb / prevProb
 *     opponent     — { team, prob } | null
 *     opponentNote — string label if opponent is uncertain (e.g. "Best 3rd Place")
 *     isBottleneck — true for the stage with the steepest conditional drop-off
 */
export function getKnockoutPath(team, hardcodedGroups, groupPredictedStandings, tournamentReach) {
  const reach               = tournamentReach?.[team] ?? {};
  const { group, pos }      = teamGroupPos(team, hardcodedGroups, groupPredictedStandings);
  const r16Section          = bracketSectionFromPos(group, pos);
  const qfSection           = r16Section != null
                                ? QF_PAIRS.findIndex(p => p.includes(r16Section))
                                : null;
  const sfHalf              = qfSection != null
                                ? SF_PAIRS.findIndex(p => p.includes(qfSection))
                                : null;

  // ── R32 opponent ────────────────────────────────────────────────────────────
  // Fixed matchups for I/J/K/L and runners-up from A-H; uncertain for A-H winners.
  let r32Opp  = null;
  let r32Note = null;

  const fixedR32 = {
    I1: ['J', 2], J1: ['I', 2], K1: ['L', 2], L1: ['K', 2],
    I2: ['J', 1], J2: ['I', 1], K2: ['L', 1], L2: ['K', 1],
    A2: ['F', 2], F2: ['A', 2], B2: ['E', 2], E2: ['B', 2],
    C2: ['H', 2], H2: ['C', 2], D2: ['G', 2], G2: ['D', 2],
  };

  const posCode = group && pos ? `${group}${pos}` : null;
  if (posCode && fixedR32[posCode]) {
    const [oppGroup, oppPos] = fixedR32[posCode];
    r32Opp = topTeamAtPos(oppGroup, oppPos, groupPredictedStandings, tournamentReach, hardcodedGroups);
  } else if (pos === 1 && group && 'ABCDEFGH'.includes(group)) {
    r32Note = 'Best 3rd Place qualifier';
  }

  // ── R16 opponent ────────────────────────────────────────────────────────────
  // Top team in the same R16 section (the other R32 slot within the section).
  // Fallback: show TBD note if section is genuinely empty.
  let r16Opp  = null;
  let r16Note = null;
  if (r16Section != null) {
    const sectionTeams = teamsInR16Section(r16Section, hardcodedGroups, groupPredictedStandings, tournamentReach, 'pR16');
    r16Opp = sectionTeams.find(t => t.team !== team) ?? null;
  }
  if (!r16Opp) r16Note = 'TBD';

  // ── QF opponent ─────────────────────────────────────────────────────────────
  // Top team from the adjacent R16 section within the same QF.
  let qfOpp  = null;
  let qfNote = null;
  if (qfSection != null && r16Section != null) {
    const adjSection = QF_PAIRS[qfSection].find(s => s !== r16Section);
    if (adjSection != null) {
      const adjTeams = teamsInR16Section(adjSection, hardcodedGroups, groupPredictedStandings, tournamentReach, 'pQF');
      qfOpp          = adjTeams[0] ?? null;
    }
  }
  if (!qfOpp) qfNote = 'TBD';

  // ── SF opponent ─────────────────────────────────────────────────────────────
  // Top team from the adjacent QF within the same SF half.
  let sfOpp  = null;
  let sfNote = null;
  if (sfHalf != null && qfSection != null) {
    const adjQF = SF_PAIRS[sfHalf].find(q => q !== qfSection);
    if (adjQF != null) {
      const adjSections = QF_PAIRS[adjQF];
      const candidates  = [
        ...teamsInR16Section(adjSections[0], hardcodedGroups, groupPredictedStandings, tournamentReach, 'pSF'),
        ...teamsInR16Section(adjSections[1], hardcodedGroups, groupPredictedStandings, tournamentReach, 'pSF'),
      ].sort((a, b) => b.prob - a.prob);
      sfOpp = candidates[0] ?? null;
    }
  }
  if (!sfOpp) sfNote = 'TBD';

  // ── Final opponent ──────────────────────────────────────────────────────────
  // Top team from the opposite SF half.
  let finalOpp  = null;
  let finalNote = null;
  if (sfHalf != null) {
    const otherHalf = sfHalf === 0 ? 1 : 0;
    const otherQFs  = SF_PAIRS[otherHalf];
    const candidates = [
      ...teamsInR16Section(QF_PAIRS[otherQFs[0]][0], hardcodedGroups, groupPredictedStandings, tournamentReach, 'pFinal'),
      ...teamsInR16Section(QF_PAIRS[otherQFs[0]][1], hardcodedGroups, groupPredictedStandings, tournamentReach, 'pFinal'),
      ...teamsInR16Section(QF_PAIRS[otherQFs[1]][0], hardcodedGroups, groupPredictedStandings, tournamentReach, 'pFinal'),
      ...teamsInR16Section(QF_PAIRS[otherQFs[1]][1], hardcodedGroups, groupPredictedStandings, tournamentReach, 'pFinal'),
    ].sort((a, b) => b.prob - a.prob);
    finalOpp = candidates.find(t => t.team !== team) ?? null;
  }
  if (!finalOpp) finalNote = 'TBD';

  // ── Build stage list ────────────────────────────────────────────────────────
  const stages = [
    {
      id: 'r32', label: 'Round of 32',
      cumProb:  reach.pR16     ?? 0,
      prevProb: reach.pAdvance ?? 0,
      condProb: safeDivide(reach.pR16,    reach.pAdvance),
      opponent: r32Opp, opponentNote: r32Note,
    },
    {
      id: 'r16', label: 'Round of 16',
      cumProb:  reach.pQF  ?? 0,
      prevProb: reach.pR16 ?? 0,
      condProb: safeDivide(reach.pQF, reach.pR16),
      opponent: r16Opp, opponentNote: r16Note,
    },
    {
      id: 'qf', label: 'Quarter-Final',
      cumProb:  reach.pSF  ?? 0,
      prevProb: reach.pQF  ?? 0,
      condProb: safeDivide(reach.pSF, reach.pQF),
      opponent: qfOpp, opponentNote: qfNote,
    },
    {
      id: 'sf', label: 'Semi-Final',
      cumProb:  reach.pFinal ?? 0,
      prevProb: reach.pSF    ?? 0,
      condProb: safeDivide(reach.pFinal, reach.pSF),
      opponent: sfOpp, opponentNote: sfNote,
    },
    {
      id: 'final', label: 'Final',
      cumProb:  reach.pWinner ?? 0,
      prevProb: reach.pFinal  ?? 0,
      condProb: safeDivide(reach.pWinner, reach.pFinal),
      opponent: finalOpp, opponentNote: finalNote,
    },
  ];

  // Mark the bottleneck: stage with the steepest conditional probability drop.
  // Only consider stages where the team has a meaningful chance of arriving.
  let bottleneckIdx = -1;
  let worstCond     = 1;
  stages.forEach((s, i) => {
    if (s.prevProb > 0.02 && s.condProb < worstCond) {
      worstCond     = s.condProb;
      bottleneckIdx = i;
    }
  });
  if (bottleneckIdx >= 0) stages[bottleneckIdx].isBottleneck = true;

  return { stages, posCode, r16Section, qfSection, sfHalf };
}
