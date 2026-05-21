'use strict';

/**
 * core/config/footballConfig.js
 *
 * SINGLE SOURCE OF TRUTH for all football-domain constants.
 *
 * Previously scattered across server.js.  Every value here is a direct copy
 * of the original — zero model-behaviour change.
 *
 * Covers:
 *   FIFA_STRENGTH         — hardcoded prior ELOs (fallback when martj42 unavailable)
 *   WC_HOST_NATIONS       — USA / Canada / Mexico for 2026
 *   WC_CONFEDERATION      — 48-team confederation membership
 *   CONFED_LAMBDA_FACTOR  — WC performance calibration multiplier per confederation
 *   CONFED_ELO_CREDIBILITY — (HISTORICAL — replaced by adaptive alpha in core/elo.js;
 *                             retained here for documentation + future reference)
 *   MARTJ42_ALIAS         — name mapping from internal → martj42 CSV spelling
 *   WC_GROUPS             — official 2026 group draw
 *   WC_SCHEDULE           — full 72-match group-stage schedule
 *   K_FACTOR_TIERS        — K-factor weights by tournament type (data form of kFactor())
 *   K_FACTOR_DECAY        — time-decay multipliers (data form of ageDays logic in kFactor())
 *   POISSON_CONSTANTS     — WC Poisson base parameters
 *   DIXON_COLES_RHO       — RHO values per pipeline
 */

// ─── FIFA Strength priors ─────────────────────────────────────────────────────
// Hardcoded prior ELOs seeded from FIFA rankings + historical WC performance.
// Used as a fallback when martj42 data is unavailable, and as the starting
// point for the adaptive alpha blend in worldCupElo().

const FIFA_STRENGTH = {
  // Tier 1 — world elite
  Argentina: 1870, France: 1854, England: 1820, Spain: 1810,
  Brazil: 1790, Portugal: 1768, Netherlands: 1755, Germany: 1748,
  // Tier 2 — consistent WC contenders
  Belgium: 1730, Croatia: 1718, Colombia: 1700, Uruguay: 1696,
  USA: 1685, 'United States': 1685, Switzerland: 1668, Italy: 1665,
  Mexico: 1660, Norway: 1658, Canada: 1648, Austria: 1640,
  Sweden: 1635, Turkey: 1625, Ecuador: 1622, Scotland: 1618,
  // Tier 3 — solid but limited at WC
  'Czech Republic': 1610, Denmark: 1608, 'Bosnia & Herzegovina': 1598,
  Japan: 1595, Morocco: 1585, 'South Korea': 1580, 'Korea Republic': 1580,
  Senegal: 1575, Panama: 1568, Paraguay: 1565, 'Saudi Arabia': 1560,
  // Tier 4 — regional forces with WC limitations
  Iran: 1555, "Côte d'Ivoire": 1545, 'Ivory Coast': 1545,
  Egypt: 1540, Ghana: 1535, Tunisia: 1530, Australia: 1528,
  Algeria: 1522, 'DR Congo': 1510, 'South Africa': 1495,
  Uzbekistan: 1480, Iraq: 1475, Jordan: 1465, Qatar: 1455,
  'Cabo Verde': 1448, Haiti: 1420, 'Curaçao': 1400,
  'New Zealand': 1390,
};

// ─── Host nations ─────────────────────────────────────────────────────────────
// USA / Canada / Mexico host the 2026 World Cup.
// Host teams receive a lambda boost in wcLambdas().

const WC_HOST_NATIONS = new Set(['United States', 'USA', 'Canada', 'Mexico']);

// ─── Confederation membership ─────────────────────────────────────────────────
// All 48 WC 2026 qualified teams, keyed by display name used in WC_GROUPS.

const WC_CONFEDERATION = {
  // CONMEBOL
  Argentina: 'CONMEBOL', Brazil: 'CONMEBOL', Colombia: 'CONMEBOL',
  Ecuador: 'CONMEBOL', Paraguay: 'CONMEBOL', Uruguay: 'CONMEBOL',
  // UEFA
  England: 'UEFA', France: 'UEFA', Germany: 'UEFA', Spain: 'UEFA',
  Portugal: 'UEFA', Netherlands: 'UEFA', Belgium: 'UEFA', Croatia: 'UEFA',
  Switzerland: 'UEFA', Sweden: 'UEFA', Norway: 'UEFA', Austria: 'UEFA',
  'Czech Republic': 'UEFA', 'Bosnia & Herzegovina': 'UEFA', Scotland: 'UEFA',
  Turkey: 'UEFA',
  // CONCACAF
  'United States': 'CONCACAF', USA: 'CONCACAF', Mexico: 'CONCACAF',
  Canada: 'CONCACAF', Panama: 'CONCACAF', Haiti: 'CONCACAF', 'Curaçao': 'CONCACAF',
  // CAF
  Morocco: 'CAF', Senegal: 'CAF', Egypt: 'CAF', 'South Africa': 'CAF',
  Ghana: 'CAF', "Côte d'Ivoire": 'CAF', 'Ivory Coast': 'CAF',
  'DR Congo': 'CAF', Algeria: 'CAF', 'Cabo Verde': 'CAF', Tunisia: 'CAF',
  // AFC
  'South Korea': 'AFC', 'Korea Republic': 'AFC', Japan: 'AFC',
  'Saudi Arabia': 'AFC', Iran: 'AFC', Iraq: 'AFC', Uzbekistan: 'AFC',
  Jordan: 'AFC', Australia: 'AFC', Qatar: 'AFC',
  // OFC
  'New Zealand': 'OFC',
};

// ─── Confederation lambda factors ─────────────────────────────────────────────
// Applied to predicted goal rates in wcLambdas() AFTER ELO credibility blending.
// Range is intentionally narrow — CONFED_ELO_CREDIBILITY (below) handles most
// of the confederation signal noise; these factors capture only residual WC bias.

const CONFED_LAMBDA_FACTOR = {
  CONMEBOL: 1.02,  // slight upward — Copa América is genuinely elite
  UEFA:     1.01,  // marginal — best pool depth but ELO already reflects this
  CONCACAF: 0.98,  // host boost handled separately; minimal residual penalty
  CAF:      0.97,  // credibility (0.72) handles most CAF inflation; tiny residual
  AFC:      0.97,  // same — credibility (0.76) already accounts for weaker pool
  OFC:      0.93,  // OFC still weakest; credibility handles bulk of signal noise
};

// ─── Confederation ELO credibility ───────────────────────────────────────────
// HISTORICAL — this static credibility blend was replaced in Phase 3 by the
// match-count adaptive alpha (clamp(n/25, 0.15, 0.85)) inside worldCupElo().
// Retained here for documentation and potential future re-activation.
// It is NOT applied at runtime; core/footballEngine/elo.js uses alphaParams instead.

const CONFED_ELO_CREDIBILITY = {
  CONMEBOL: 0.96,  // Copa América is strong — trust most of the delta
  UEFA:     0.92,  // Nations League / EURO qualifiers have some weaker members
  CONCACAF: 0.83,  // Gold Cup / qualifiers are softer than European equivalents
  CAF:      0.72,  // Tightened: 0.65 was too aggressive given narrow lambda now
  AFC:      0.76,  // Tightened: 0.70 → 0.76; lambda factor no longer double-penalises
  OFC:      0.60,  // NZ vs Oceania minnows — barely meaningful signal
};

// ─── Martj42 name aliases ─────────────────────────────────────────────────────
// Maps display names used in WC_GROUPS to the spellings used in the martj42
// international-results CSV dataset.

const MARTJ42_ALIAS = {
  'USA':                    'United States',
  'Trinidad & Tobago':      'Trinidad and Tobago',
  'Bosnia & Herzegovina':   'Bosnia and Herzegovina',
  'Curaçao':                'Curacao',
  "Côte d'Ivoire":          'Ivory Coast',
  'Cabo Verde':             'Cape Verde',
  'DR Congo':               'DR Congo',  // martj42 uses this exact name
};

// ─── K-factor tournament tiers ────────────────────────────────────────────────
// Data representation of the kFactor() function in server.js.
// Each entry: { match: string (lowercase substring), K: number }
// Used in order — first match wins.

const K_FACTOR_TIERS = [
  { match: 'world cup',          exclude: 'qualif',   K: 60 },
  { match: 'uefa euro',                               K: 52 },
  { match: 'european championship',                   K: 52 },
  { match: 'euro 20',                                 K: 52 },
  { match: 'copa am',                                 K: 52 },
  { match: 'uefa nations league',                     K: 45 },
  { match: 'africa cup',                              K: 38 },
  { match: 'african cup',                             K: 38 },
  { match: 'afcon',                                   K: 38 },
  { match: 'asian cup',                               K: 38 },
  { match: 'afc asian',                               K: 38 },
  { match: 'gold cup',                                K: 38 },
  { match: 'concacaf nations',                        K: 38 },
  { match: 'nations league',                          K: 38 },
  { match: 'qualif',                                  K: 36 },
  { match: 'qualifier',                               K: 36 },
  { match: 'friendly',                                K: 20 },
  { match: 'friendlies',                              K: 20 },
  { match: '',                                        K: 30 },  // default
];

// ─── K-factor time decay ──────────────────────────────────────────────────────
// Applied as K *= multiplier when a match is older than ageDays.
// Evaluated in order (oldest first) — first matching threshold wins.

const K_FACTOR_DECAY = [
  { ageDays: 1095, multiplier: 0.35 },  // 3+ years (e.g. 2022 WC spikes)
  { ageDays:  730, multiplier: 0.55 },  // 2–3 years
  { ageDays:  365, multiplier: 0.78 },  // 1–2 years
  // < 365 days: full K (no decay)
];

// ─── WC Poisson model constants ───────────────────────────────────────────────
// Base parameters for wcLambdas() — changing these WILL change predictions.

const WC_POISSON = {
  BASE_LAMBDA:    1.30,   // geometric mean expected-goals across all WC matches
  DIFF_SCALE:     0.88,   // ELO-diff → lambda scaling (0.88 chosen by calibration)
  LAMBDA_FLOOR:   0.30,   // minimum expected goals to avoid degenerate distributions
  HOST_BOOST_HOME_FACTOR: 1.18,   // lH *= this for home host nations
  HOST_BOOST_HOME_ADD:    0.22,   // lH = min(lH * factor, lH + this)
  HOST_BOOST_AWAY_FACTOR: 1.10,   // lA *= this for away host nations
  HOST_BOOST_AWAY_ADD:    0.12,   // lA = min(lA * factor, lA + this)
  DIXON_COLES_RHO:       -0.10,  // fixed WC τ-correction (league uses dynamicRho)
  SCORE_MATRIX_MAX:        8,     // 0..8 score range for WC matrix
  H2H_NUDGE_MAX:           0.05,  // ±5% max H2H probability nudge
  H2H_MIN_MEETINGS:        5,     // minimum H2H games to apply nudge
  H2H_NUDGE_FACTOR:        0.08,  // (hW - aW) / n * this = nudge
  H2H_AWAY_NUDGE_FACTOR:   0.6,   // awayWin nudge is this fraction of homeWin nudge
};

// ─── Dixon-Coles RHO per pipeline ────────────────────────────────────────────
// WC uses a fixed −0.10; league model uses dynamicRho() (callers handle this).
// Stored here for documentation — the actual computation remains in the caller.

const DIXON_COLES_RHO = {
  WC:     -0.10,   // fixed
  LEAGUE: null,    // dynamic — see predictionEngine.js dynamicRho()
};

// ─── WC Groups (official 2026 draw) ──────────────────────────────────────────

const WC_GROUPS = {
  A: ['Mexico',         'South Africa',          'South Korea',    'Czech Republic'],
  B: ['Canada',         'Bosnia & Herzegovina',  'Qatar',          'Switzerland'],
  C: ['Brazil',         'Morocco',               'Haiti',          'Scotland'],
  D: ['United States',  'Paraguay',              'Australia',      'Turkey'],
  E: ['Germany',        'Curaçao',               "Côte d'Ivoire",  'Ecuador'],
  F: ['Netherlands',    'Japan',                 'Sweden',         'Tunisia'],
  G: ['Belgium',        'Egypt',                 'Iran',           'New Zealand'],
  H: ['Spain',          'Cabo Verde',            'Saudi Arabia',   'Uruguay'],
  I: ['France',         'Senegal',               'Iraq',           'Norway'],
  J: ['Argentina',      'Algeria',               'Austria',        'Jordan'],
  K: ['Portugal',       'DR Congo',              'Uzbekistan',     'Colombia'],
  L: ['England',        'Croatia',               'Ghana',          'Panama'],
};

// ─── Full group-stage schedule (all 72 matches, UTC kickoffs) ─────────────────

const WC_SCHEDULE = [
  // ── Group A ─────────────────────────────────────────────────────────────────
  { group:'A', md:1, home:'Mexico',         away:'South Africa',         kickoff:'2026-06-11T19:00:00Z', venue:'Estadio Azteca',          city:'Mexico City' },
  { group:'A', md:1, home:'South Korea',    away:'Czech Republic',       kickoff:'2026-06-12T02:00:00Z', venue:'Estadio Akron',           city:'Zapopan' },
  { group:'A', md:2, home:'Czech Republic', away:'South Africa',         kickoff:'2026-06-18T16:00:00Z', venue:'Mercedes-Benz Stadium',   city:'Atlanta' },
  { group:'A', md:2, home:'Mexico',         away:'South Korea',          kickoff:'2026-06-19T01:00:00Z', venue:'Estadio Akron',           city:'Zapopan' },
  { group:'A', md:3, home:'South Africa',   away:'South Korea',          kickoff:'2026-06-25T01:00:00Z', venue:'Estadio BBVA',            city:'Guadalupe' },
  { group:'A', md:3, home:'Czech Republic', away:'Mexico',               kickoff:'2026-06-25T01:00:00Z', venue:'Estadio Azteca',          city:'Mexico City' },

  // ── Group B ─────────────────────────────────────────────────────────────────
  { group:'B', md:1, home:'Canada',              away:'Bosnia & Herzegovina', kickoff:'2026-06-12T19:00:00Z', venue:'BMO Field',            city:'Toronto' },
  { group:'B', md:1, home:'Qatar',               away:'Switzerland',          kickoff:'2026-06-13T19:00:00Z', venue:"Levi's Stadium",       city:'Santa Clara' },
  { group:'B', md:2, home:'Switzerland',         away:'Bosnia & Herzegovina', kickoff:'2026-06-18T19:00:00Z', venue:'SoFi Stadium',         city:'Inglewood' },
  { group:'B', md:2, home:'Canada',              away:'Qatar',                kickoff:'2026-06-18T22:00:00Z', venue:'BC Place',             city:'Vancouver' },
  { group:'B', md:3, home:'Bosnia & Herzegovina',away:'Qatar',               kickoff:'2026-06-24T19:00:00Z', venue:'Lumen Field',           city:'Seattle' },
  { group:'B', md:3, home:'Switzerland',         away:'Canada',               kickoff:'2026-06-24T19:00:00Z', venue:'BC Place',             city:'Vancouver' },

  // ── Group C ─────────────────────────────────────────────────────────────────
  { group:'C', md:1, home:'Brazil',   away:'Morocco',  kickoff:'2026-06-13T22:00:00Z', venue:'MetLife Stadium',         city:'East Rutherford' },
  { group:'C', md:1, home:'Haiti',    away:'Scotland', kickoff:'2026-06-14T01:00:00Z', venue:'Gillette Stadium',        city:'Foxborough' },
  { group:'C', md:2, home:'Scotland', away:'Morocco',  kickoff:'2026-06-19T22:00:00Z', venue:'Gillette Stadium',        city:'Foxborough' },
  { group:'C', md:2, home:'Brazil',   away:'Haiti',    kickoff:'2026-06-20T01:00:00Z', venue:'Lincoln Financial Field', city:'Philadelphia' },
  { group:'C', md:3, home:'Scotland', away:'Brazil',   kickoff:'2026-06-24T22:00:00Z', venue:'Hard Rock Stadium',       city:'Miami Gardens' },
  { group:'C', md:3, home:'Morocco',  away:'Haiti',    kickoff:'2026-06-24T22:00:00Z', venue:'Mercedes-Benz Stadium',   city:'Atlanta' },

  // ── Group D ─────────────────────────────────────────────────────────────────
  { group:'D', md:1, home:'United States', away:'Paraguay',       kickoff:'2026-06-13T01:00:00Z', venue:'SoFi Stadium',    city:'Inglewood' },
  { group:'D', md:1, home:'Australia',     away:'Turkey',         kickoff:'2026-06-14T01:00:00Z', venue:'BC Place',        city:'Vancouver' },
  { group:'D', md:2, home:'Turkey',        away:'Paraguay',       kickoff:'2026-06-19T04:00:00Z', venue:"Levi's Stadium",  city:'Santa Clara' },
  { group:'D', md:2, home:'United States', away:'Australia',      kickoff:'2026-06-19T19:00:00Z', venue:'Lumen Field',     city:'Seattle' },
  { group:'D', md:3, home:'Turkey',        away:'United States',  kickoff:'2026-06-26T02:00:00Z', venue:'SoFi Stadium',    city:'Inglewood' },
  { group:'D', md:3, home:'Paraguay',      away:'Australia',      kickoff:'2026-06-26T02:00:00Z', venue:"Levi's Stadium",  city:'Santa Clara' },

  // ── Group E ─────────────────────────────────────────────────────────────────
  { group:'E', md:1, home:'Germany',        away:'Curaçao',       kickoff:'2026-06-14T17:00:00Z', venue:'NRG Stadium',             city:'Houston' },
  { group:'E', md:1, home:"Côte d'Ivoire",  away:'Ecuador',       kickoff:'2026-06-14T23:00:00Z', venue:'Lincoln Financial Field', city:'Philadelphia' },
  { group:'E', md:2, home:'Germany',        away:"Côte d'Ivoire", kickoff:'2026-06-20T20:00:00Z', venue:'BMO Field',               city:'Toronto' },
  { group:'E', md:2, home:'Ecuador',        away:'Curaçao',       kickoff:'2026-06-21T00:00:00Z', venue:'Arrowhead Stadium',       city:'Kansas City' },
  { group:'E', md:3, home:'Ecuador',        away:'Germany',       kickoff:'2026-06-25T20:00:00Z', venue:'MetLife Stadium',         city:'East Rutherford' },
  { group:'E', md:3, home:'Curaçao',        away:"Côte d'Ivoire", kickoff:'2026-06-25T20:00:00Z', venue:'Lincoln Financial Field', city:'Philadelphia' },

  // ── Group F ─────────────────────────────────────────────────────────────────
  { group:'F', md:1, home:'Netherlands', away:'Japan',    kickoff:'2026-06-14T20:00:00Z', venue:'AT&T Stadium',      city:'Arlington' },
  { group:'F', md:1, home:'Sweden',      away:'Tunisia',  kickoff:'2026-06-15T02:00:00Z', venue:'Estadio BBVA',      city:'Guadalupe' },
  { group:'F', md:2, home:'Tunisia',     away:'Japan',    kickoff:'2026-06-20T04:00:00Z', venue:'Estadio BBVA',      city:'Guadalupe' },
  { group:'F', md:2, home:'Netherlands', away:'Sweden',   kickoff:'2026-06-20T17:00:00Z', venue:'NRG Stadium',       city:'Houston' },
  { group:'F', md:3, home:'Japan',       away:'Sweden',   kickoff:'2026-06-25T23:00:00Z', venue:'AT&T Stadium',      city:'Arlington' },
  { group:'F', md:3, home:'Tunisia',     away:'Netherlands', kickoff:'2026-06-25T23:00:00Z', venue:'Arrowhead Stadium', city:'Kansas City' },

  // ── Group G ─────────────────────────────────────────────────────────────────
  { group:'G', md:1, home:'Belgium',     away:'Egypt',        kickoff:'2026-06-15T19:00:00Z', venue:'BC Place',     city:'Vancouver' },
  { group:'G', md:1, home:'Iran',        away:'New Zealand',  kickoff:'2026-06-16T01:00:00Z', venue:'SoFi Stadium', city:'Inglewood' },
  { group:'G', md:2, home:'Belgium',     away:'Iran',         kickoff:'2026-06-21T19:00:00Z', venue:'SoFi Stadium', city:'Inglewood' },
  { group:'G', md:2, home:'New Zealand', away:'Egypt',        kickoff:'2026-06-22T01:00:00Z', venue:'BC Place',     city:'Vancouver' },
  { group:'G', md:3, home:'Egypt',       away:'Iran',         kickoff:'2026-06-27T03:00:00Z', venue:'Lumen Field',  city:'Seattle' },
  { group:'G', md:3, home:'New Zealand', away:'Belgium',      kickoff:'2026-06-27T03:00:00Z', venue:'BC Place',     city:'Vancouver' },

  // ── Group H ─────────────────────────────────────────────────────────────────
  { group:'H', md:1, home:'Spain',        away:'Cabo Verde',   kickoff:'2026-06-15T16:00:00Z', venue:'Mercedes-Benz Stadium', city:'Atlanta' },
  { group:'H', md:1, home:'Saudi Arabia', away:'Uruguay',      kickoff:'2026-06-15T22:00:00Z', venue:'Hard Rock Stadium',     city:'Miami Gardens' },
  { group:'H', md:2, home:'Spain',        away:'Saudi Arabia', kickoff:'2026-06-21T16:00:00Z', venue:'Mercedes-Benz Stadium', city:'Atlanta' },
  { group:'H', md:2, home:'Uruguay',      away:'Cabo Verde',   kickoff:'2026-06-21T22:00:00Z', venue:'Hard Rock Stadium',     city:'Miami Gardens' },
  { group:'H', md:3, home:'Cabo Verde',   away:'Saudi Arabia', kickoff:'2026-06-27T00:00:00Z', venue:'NRG Stadium',           city:'Houston' },
  { group:'H', md:3, home:'Uruguay',      away:'Spain',        kickoff:'2026-06-27T00:00:00Z', venue:'Estadio Akron',         city:'Zapopan' },

  // ── Group I ─────────────────────────────────────────────────────────────────
  { group:'I', md:1, home:'France',   away:'Senegal', kickoff:'2026-06-16T19:00:00Z', venue:'MetLife Stadium',         city:'East Rutherford' },
  { group:'I', md:1, home:'Iraq',     away:'Norway',  kickoff:'2026-06-16T22:00:00Z', venue:'Gillette Stadium',        city:'Foxborough' },
  { group:'I', md:2, home:'France',   away:'Iraq',    kickoff:'2026-06-22T21:00:00Z', venue:'Lincoln Financial Field', city:'Philadelphia' },
  { group:'I', md:2, home:'Norway',   away:'Senegal', kickoff:'2026-06-23T00:00:00Z', venue:'MetLife Stadium',         city:'East Rutherford' },
  { group:'I', md:3, home:'Norway',   away:'France',  kickoff:'2026-06-26T19:00:00Z', venue:'Gillette Stadium',        city:'Foxborough' },
  { group:'I', md:3, home:'Senegal',  away:'Iraq',    kickoff:'2026-06-26T19:00:00Z', venue:'BMO Field',               city:'Toronto' },

  // ── Group J ─────────────────────────────────────────────────────────────────
  { group:'J', md:1, home:'Austria',   away:'Jordan',    kickoff:'2026-06-16T04:00:00Z', venue:"Levi's Stadium",    city:'Santa Clara' },
  { group:'J', md:1, home:'Argentina', away:'Algeria',   kickoff:'2026-06-17T01:00:00Z', venue:'Arrowhead Stadium', city:'Kansas City' },
  { group:'J', md:2, home:'Argentina', away:'Austria',   kickoff:'2026-06-22T17:00:00Z', venue:'AT&T Stadium',      city:'Arlington' },
  { group:'J', md:2, home:'Jordan',    away:'Algeria',   kickoff:'2026-06-23T03:00:00Z', venue:"Levi's Stadium",    city:'Santa Clara' },
  { group:'J', md:3, home:'Algeria',   away:'Austria',   kickoff:'2026-06-28T02:00:00Z', venue:'Arrowhead Stadium', city:'Kansas City' },
  { group:'J', md:3, home:'Jordan',    away:'Argentina', kickoff:'2026-06-28T02:00:00Z', venue:'AT&T Stadium',      city:'Arlington' },

  // ── Group K ─────────────────────────────────────────────────────────────────
  { group:'K', md:1, home:'Portugal',   away:'DR Congo',   kickoff:'2026-06-17T17:00:00Z', venue:'NRG Stadium',           city:'Houston' },
  { group:'K', md:1, home:'Uzbekistan', away:'Colombia',   kickoff:'2026-06-18T02:00:00Z', venue:'Estadio Azteca',        city:'Mexico City' },
  { group:'K', md:2, home:'Portugal',   away:'Uzbekistan', kickoff:'2026-06-23T17:00:00Z', venue:'NRG Stadium',           city:'Houston' },
  { group:'K', md:2, home:'Colombia',   away:'DR Congo',   kickoff:'2026-06-24T02:00:00Z', venue:'Estadio Akron',         city:'Zapopan' },
  { group:'K', md:3, home:'Colombia',   away:'Portugal',   kickoff:'2026-06-27T23:30:00Z', venue:'Hard Rock Stadium',     city:'Miami Gardens' },
  { group:'K', md:3, home:'DR Congo',   away:'Uzbekistan', kickoff:'2026-06-27T23:30:00Z', venue:'Mercedes-Benz Stadium', city:'Atlanta' },

  // ── Group L ─────────────────────────────────────────────────────────────────
  { group:'L', md:1, home:'England', away:'Croatia', kickoff:'2026-06-17T20:00:00Z', venue:'AT&T Stadium',            city:'Arlington' },
  { group:'L', md:1, home:'Ghana',   away:'Panama',  kickoff:'2026-06-17T23:00:00Z', venue:'BMO Field',               city:'Toronto' },
  { group:'L', md:2, home:'England', away:'Ghana',   kickoff:'2026-06-23T20:00:00Z', venue:'Gillette Stadium',        city:'Foxborough' },
  { group:'L', md:2, home:'Panama',  away:'Croatia', kickoff:'2026-06-23T23:00:00Z', venue:'BMO Field',               city:'Toronto' },
  { group:'L', md:3, home:'Panama',  away:'England', kickoff:'2026-06-27T21:00:00Z', venue:'MetLife Stadium',         city:'East Rutherford' },
  { group:'L', md:3, home:'Croatia', away:'Ghana',   kickoff:'2026-06-27T21:00:00Z', venue:'Lincoln Financial Field', city:'Philadelphia' },
];

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  FIFA_STRENGTH,
  WC_HOST_NATIONS,
  WC_CONFEDERATION,
  CONFED_LAMBDA_FACTOR,
  CONFED_ELO_CREDIBILITY,   // historical — not active at runtime
  MARTJ42_ALIAS,
  K_FACTOR_TIERS,
  K_FACTOR_DECAY,
  WC_POISSON,
  DIXON_COLES_RHO,
  WC_GROUPS,
  WC_SCHEDULE,
};
