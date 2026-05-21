'use strict';

// ─── matchLabels.js ───────────────────────────────────────────────────────────
//
// Unified language layer for World Cup match predictions.
//
// RULES:
//   • All language is probabilistic — never deterministic.
//   • Every insight includes a probability percentage + an English interpretation.
//   • Draw probability is always referenced using probToPhrase(draw).
//   • No "will", "should", "need to", or "are going to" phrasing.
//
// EXPORTS:
//   probToPhrase(p)                                       → English phrase
//   getMatchLabel(homeWin, draw, awayWin)                 → { text, tier, favourite }
//   getInsightText(home, away, hW, d, aW, λH, λA)        → string

// ─── probToPhrase ─────────────────────────────────────────────────────────────
// Maps a raw probability (0–1) to a consistent natural-language equivalent.
// Used to pair every number with an interpretation across the UI.

export function probToPhrase(p) {
  if (p >= 0.80) return 'very likely';
  if (p >= 0.65) return 'likely';
  if (p >= 0.52) return 'more likely than not';
  if (p >= 0.45) return 'slight edge';
  if (p >= 0.38) return 'marginal edge';
  return 'coin flip';
}

// ─── getMatchLabel ────────────────────────────────────────────────────────────
// Returns a tier label and display text for a match based on win probabilities.
//
// Tiers (favourite side only, not draw):
//   dominant  — one team has >= 65% win probability
//   strong    — one team has 52–64% win probability
//   slight    — one team has 40–51% win probability
//   tossup    — neither team exceeds 40% and draw >= 36%
//   underdog  — neither team exceeds 40% but draw < 36% (fragmented market)

export function getMatchLabel(homeWin, draw, awayWin) {
  const max       = Math.max(homeWin, awayWin);
  const favourite = homeWin >= awayWin ? 'home' : 'away';

  if (max >= 0.65) return { text: 'Dominant favourite', tier: 'dominant', favourite };
  if (max >= 0.52) return { text: 'Strong favourite',   tier: 'strong',   favourite };
  if (max >= 0.40) return { text: 'Slight favourite',   tier: 'slight',   favourite };
  if (draw >= 0.36 && max < 0.40)
                   return { text: 'Toss-up',            tier: 'tossup',   favourite: null };
  return           { text: 'Underdog alert',            tier: 'underdog', favourite };
}

// ─── getInsightText ───────────────────────────────────────────────────────────
// Generates a probabilistic match insight sentence.
//
// Sentence structure per tier — locked vocabulary, probabilistic framing:
//
//   dominant  [FAV] hold a [PHRASE] edge ([PCT]%), with [DOG] facing long odds.
//             A draw looks [DRAW_PHRASE] ([DRAW_PCT]%). Expect ~[GOALS] goals.
//
//   strong    [FAV] are clear favourites ([PCT]%), though [DOG] carry
//             enough quality to make this competitive. The draw is [DRAW_PHRASE]
//             ([DRAW_PCT]%). Expect ~[GOALS] goals.
//
//   slight    [FAV] hold a narrow edge ([PCT]%), but this is genuinely close.
//             A draw is [DRAW_PHRASE] at [DRAW_PCT]% — the single most common
//             outcome in matches this tight. Expect ~[GOALS] goals.
//
//   tossup    Neither side holds a meaningful edge — this is as open as it gets.
//             A draw is [DRAW_PHRASE] at [DRAW_PCT]%. Expect ~[GOALS] goals
//             in an unpredictable contest.
//
//   underdog  [DOG] are the underdogs ([DOG_PCT]%) but are not without a chance.
//             [FAV] hold the edge at [FAV_PCT]%, with a draw [DRAW_PHRASE]
//             at [DRAW_PCT]%. Expect ~[GOALS] goals.

export function getInsightText(home, away, homeWin, draw, awayWin, lambdaHome, lambdaAway) {
  const { tier, favourite }  = getMatchLabel(homeWin, draw, awayWin);

  const favName  = favourite === 'home' ? home  : away;
  const dogName  = favourite === 'home' ? away  : home;
  const favPct   = Math.round((favourite === 'home' ? homeWin : awayWin) * 100);
  const dogPct   = Math.round((favourite === 'home' ? awayWin : homeWin) * 100);
  const drawPct  = Math.round(draw * 100);
  const avgGoals = (lambdaHome + lambdaAway).toFixed(1);

  const favPhrase  = probToPhrase(favourite === 'home' ? homeWin : awayWin);
  const drawPhrase = probToPhrase(draw);

  switch (tier) {
    case 'dominant':
      return (
        `${favName} hold a ${favPhrase} edge at ${favPct}%, with ${dogName} facing long odds to get a result. ` +
        `A draw looks ${drawPhrase} at ${drawPct}%. ` +
        `The model expects around ${avgGoals} goals on average.`
      );

    case 'strong':
      return (
        `${favName} are clear favourites at ${favPct}%, though ${dogName} carry enough quality to keep this competitive. ` +
        `A draw is ${drawPhrase} at ${drawPct}%. ` +
        `Around ${avgGoals} goals expected on average.`
      );

    case 'slight':
      return (
        `${favName} hold a narrow edge at ${favPct}%, but this match is genuinely close. ` +
        `A draw is ${drawPhrase} at ${drawPct}% — the single most common outcome in matches this tight. ` +
        `The model puts average goals at around ${avgGoals}.`
      );

    case 'tossup':
      return (
        `Neither side holds a meaningful edge — this is as open as it gets. ` +
        `A draw is ${drawPhrase} at ${drawPct}%. ` +
        `Expect around ${avgGoals} goals in an unpredictable contest.`
      );

    case 'underdog':
      return (
        `${dogName} are the underdogs at ${dogPct}%, but are not without a chance. ` +
        `${favName} hold the edge at ${favPct}%, with a draw ${drawPhrase} at ${drawPct}%. ` +
        `Around ${avgGoals} goals expected on average.`
      );

    default:
      return `${favName} are favoured at ${favPct}%. Draw: ${drawPct}%. Expected goals: ~${avgGoals}.`;
  }
}
