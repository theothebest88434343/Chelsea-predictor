'use strict';

require('dotenv').config();

const express   = require('express');
const cors      = require('cors');
const axios     = require('axios');
const cron      = require('node-cron');
const webPush   = require('web-push');
const fs        = require('fs');
const path      = require('path');
const Groq      = require('groq-sdk');

const {
  predict,
  calculateLambdas,
  buildRollingRatings,
  buildEloRatings,
  simulateSeason,
  logLoss,
  brierScore,
  calibrationCurve,
  bettingSimulator,
  FORM_WEIGHTS,
} = require('./models/predictionEngine');

// ─── App setup ────────────────────────────────────────────────────────────────

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// ─── Health check ─────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ─── Groq ─────────────────────────────────────────────────────────────────────

const groq = process.env.GROQ_API_KEY
  ? new Groq({ apiKey: process.env.GROQ_API_KEY })
  : null;

async function groqChat(messages, maxTokens = 1200) {
  if (!groq) return 'Groq API key not configured. Add GROQ_API_KEY to your .env file.';
  const res = await groq.chat.completions.create({
    model:       'llama-3.3-70b-versatile',
    messages,
    max_tokens:  maxTokens,
    temperature: 0.4,
  });
  return res.choices[0]?.message?.content ?? '';
}

// ─── Push notifications ───────────────────────────────────────────────────────

const subscriptions = [];

if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_SECRET_KEY) {
  webPush.setVapidDetails(
    'mailto:admin@chelseapred.local',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_SECRET_KEY,
  );
}

async function sendPushToAll(payload) {
  if (!process.env.VAPID_PUBLIC_KEY) return;
  const results = subscriptions.map(sub =>
    webPush.sendNotification(sub, JSON.stringify(payload)).catch(() => null)
  );
  await Promise.allSettled(results);
}

// ─── Cache ────────────────────────────────────────────────────────────────────

const cache = new Map();

function setCache(key, value, ttlMs) {
  cache.set(key, { value, expires: Date.now() + ttlMs });
}

function getCache(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expires) { cache.delete(key); return null; }
  return entry.value;
}

// ─── Retry with exponential backoff ──────────────────────────────────────────
// Retries on network failures and 5xx. Never retries 4xx (client errors).
async function withRetry(fn, { maxAttempts = 3, baseDelayMs = 800, label = '' } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (err.response?.status >= 400 && err.response?.status < 500) throw err;
      if (attempt < maxAttempts) {
        const delay = baseDelayMs * Math.pow(2, attempt - 1);
        console.warn(`[Retry] ${label} (attempt ${attempt}/${maxAttempts}): ${err.message} — retrying in ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

const TTL = {
  FPL:      5  * 60 * 1000,
  XG:       60 * 60 * 1000,
  ODDS:     60 * 60 * 1000,
  ODDS_HOT: 15 * 60 * 1000,
  ACCURACY: 2  * 60 * 60 * 1000,
  TABLE:    5  * 60 * 1000,
  XPTS:     10 * 60 * 1000,
  WEATHER:  60 * 60 * 1000,
};

// ─── Prediction history ───────────────────────────────────────────────────────

const HISTORY_FILE = path.join(__dirname, 'prediction-history.json');

function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const raw = fs.readFileSync(HISTORY_FILE, 'utf-8');
      return JSON.parse(raw);
    }
  } catch {}
  return { season: getCurrentSeason(), predictions: [] };
}

function saveHistory(data) {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(data, null, 2));
}

function getCurrentSeason() {
  const now = new Date();
  const year = now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
  return `${year}-${String(year + 1).slice(2)}`;
}

let history = loadHistory();

// ─── Market movement history ──────────────────────────────────────────────────

const MARKET_HISTORY_FILE = path.join(__dirname, 'market-history.json');

function loadMarketHistory() {
  try {
    if (fs.existsSync(MARKET_HISTORY_FILE)) return JSON.parse(fs.readFileSync(MARKET_HISTORY_FILE, 'utf-8'));
  } catch {}
  return {};
}

function saveMarketSnapshot(fixtureId, odds) {
  const mh  = loadMarketHistory();
  const key = String(fixtureId);
  if (!mh[key]) mh[key] = [];
  mh[key].push({ timestamp: new Date().toISOString(), home: odds.home, draw: odds.draw, away: odds.away });
  if (mh[key].length > 10) mh[key] = mh[key].slice(-10); // keep last 10
  try { fs.writeFileSync(MARKET_HISTORY_FILE, JSON.stringify(mh, null, 2)); } catch {}
}

// ─── FPL helpers ──────────────────────────────────────────────────────────────

const FPL_BASE  = 'https://fantasy.premierleague.com/api';
const CHELSEA_CODE = 8; // FPL team code for Chelsea

async function fetchBootstrap() {
  const cached = getCache('bootstrap');
  if (cached) return cached;
  const res = await withRetry(
    () => axios.get(`${FPL_BASE}/bootstrap-static/`, { timeout: 10000 }),
    { maxAttempts: 3, label: 'FPL bootstrap' }
  );
  const data = res.data;
  setCache('bootstrap', data, TTL.FPL);
  return data;
}

async function fetchFixtures() {
  const cached = getCache('fixtures_all');
  if (cached) return cached;
  const res = await withRetry(
    () => axios.get(`${FPL_BASE}/fixtures/`, { timeout: 10000 }),
    { maxAttempts: 3, label: 'FPL fixtures' }
  );
  setCache('fixtures_all', res.data, TTL.FPL);
  return res.data;
}

async function getBootstrapTeams() {
  const bs = await fetchBootstrap();
  return bs.teams ?? [];
}

async function getChelseaTeamId() {
  const teams = await getBootstrapTeams();
  const chelsea = teams.find(t => t.code === CHELSEA_CODE || t.short_name === 'CHE');
  return chelsea?.id ?? null;
}

function enrichFixture(fix, teams, events) {
  const homeTeam = teams.find(t => t.id === fix.team_h) ?? {};
  const awayTeam = teams.find(t => t.id === fix.team_a) ?? {};
  const event    = events.find(e => e.id === fix.event)  ?? {};

  return {
    id:           fix.id,
    gameweek:     fix.event,
    kickoffTime:  fix.kickoff_time,
    finished:     fix.finished,
    started:      fix.started,
    homeTeam: {
      id:        homeTeam.id,
      name:      homeTeam.name,
      shortName: homeTeam.short_name,
      code:      homeTeam.code,
    },
    awayTeam: {
      id:        awayTeam.id,
      name:      awayTeam.name,
      shortName: awayTeam.short_name,
      code:      awayTeam.code,
    },
    homeScore: fix.team_h_score,
    awayScore: fix.team_a_score,
    difficulty: { home: fix.team_h_difficulty, away: fix.team_a_difficulty },
  };
}

// ─── xG (Understat) ───────────────────────────────────────────────────────────
// Understat migrated from inline HTML data to a JSON API endpoint (May 2025).
// Old: GET /league/EPL/{year}  →  HTML with teamsData = JSON.parse('...')
// New: GET /getLeagueData/EPL/{year}  →  { teams: {...}, dates: [...], players: [...] }
// The per-team history schema (h_a, xG, xGA, ...) is unchanged.

async function fetchUnderstatXG() {
  const cached = getCache('understat_xg');
  if (cached) return cached;

  try {
    const year = new Date().getMonth() >= 6 ? new Date().getFullYear() : new Date().getFullYear() - 1;
    const res  = await withRetry(
      () => axios.get(`https://understat.com/getLeagueData/EPL/${year}`, {
        timeout: 15000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'application/json, text/javascript, */*; q=0.01',
          'Referer': `https://understat.com/league/EPL/${year}`,
          'X-Requested-With': 'XMLHttpRequest',
        },
      }),
      { maxAttempts: 2, label: 'Understat xG' }
    );

      const raw = res.data?.teams;
    if (!raw || typeof raw !== 'object' || Object.keys(raw).length === 0) {
      throw new Error(`Understat API returned no teams data (keys: ${Object.keys(res.data ?? {}).join(', ')})`);
    }

    const xgMap = {};
    const XG_DECAY = 0.92; // per-match exponential decay — same α as rolling ratings

    for (const [, team] of Object.entries(raw)) {
      // Understat history is chronological (oldest first), so most recent = last index.
      // Apply exponential decay: weight of match i = DECAY^(n-1-i), so weight=1 for newest.
      const history = team.history ?? [];
      const n = history.length;

      let homeXG = 0, awayXG = 0, homeXGA = 0, awayXGA = 0;
      let homeW  = 0, awayW  = 0;
      let totalXG = 0, totalXGA = 0, totalW = 0;

      for (let i = 0; i < n; i++) {
        const g       = history[i];
        const w       = Math.pow(XG_DECAY, n - 1 - i); // 1.0 for most recent
        const scored   = parseFloat(g.xG  ?? 0);
        const conceded = parseFloat(g.xGA ?? 0);

        totalXG  += scored   * w;
        totalXGA += conceded * w;
        totalW   += w;

        if (g.h_a === 'h') {
          homeXG  += scored   * w; homeXGA += conceded * w; homeW += w;
        } else {
          awayXG  += scored   * w; awayXGA += conceded * w; awayW += w;
        }
      }

      const safe = v => (isFinite(v) && !isNaN(v) ? v : 0);
      xgMap[team.title] = {
        homeXG:   safe(homeW  ? homeXG  / homeW  : totalW ? totalXG  / totalW : 0),
        awayXG:   safe(awayW  ? awayXG  / awayW  : totalW ? totalXG  / totalW : 0),
        homeXGA:  safe(homeW  ? homeXGA / homeW   : totalW ? totalXGA / totalW : 0),
        awayXGA:  safe(awayW  ? awayXGA / awayW   : totalW ? totalXGA / totalW : 0),
        seasonXG:  safe(totalW ? totalXG  / totalW : 0),
        seasonXGA: safe(totalW ? totalXGA / totalW : 0),
        games: n,
      };
    }

    setCache('understat_xg', xgMap, TTL.XG);
    return xgMap;
  } catch (err) {
    console.warn('[Understat] Failed to fetch xG:', err.message);
    return {};
  }
}

const UNDERSTAT_NAME_MAP = {
  'Arsenal':              'Arsenal',
  'Aston Villa':          'Aston Villa',
  'Brentford':            'Brentford',
  'Brighton':             'Brighton',
  'Chelsea':              'Chelsea',
  'Crystal Palace':       'Crystal Palace',
  'Everton':              'Everton',
  'Fulham':               'Fulham',
  'Ipswich':              'Ipswich',
  'Leicester':            'Leicester',
  'Liverpool':            'Liverpool',
  'Man City':             'Manchester City',
  'Man Utd':              'Manchester United',
  'Newcastle':            'Newcastle United',
  'Nott\'m Forest':       'Nottingham Forest',
  'Southampton':          'Southampton',
  'Spurs':                'Tottenham',
  'West Ham':             'West Ham',
  'Wolves':               'Wolverhampton Wanderers',
  'Bournemouth':          'Bournemouth',
};

// ─── The Odds API ─────────────────────────────────────────────────────────────

async function fetchOdds(teamName = null) {
  if (!process.env.ODDS_API_KEY) return {};

  const hoursToKickoff = teamName ? null : null;
  const cacheKey = `odds_${teamName ?? 'all'}`;
  const cached   = getCache(cacheKey);
  if (cached) return cached;

  try {
    const res = await withRetry(
      () => axios.get('https://api.the-odds-api.com/v4/sports/soccer_epl/odds/', {
        params: {
          apiKey:  process.env.ODDS_API_KEY,
          regions: 'uk',
          markets: 'h2h',
          oddsFormat: 'decimal',
          bookmakers: 'bet365,williamhill,betfair_ex_uk',
        },
        timeout: 10000,
      }),
      { maxAttempts: 2, label: 'Odds API' }
    );

    const oddsMap = {};
    for (const game of (res.data ?? [])) {
      const book = game.bookmakers?.[0];
      if (!book) continue;
      const h2h = book.markets?.find(m => m.key === 'h2h');
      if (!h2h) continue;

      const homeOut  = h2h.outcomes.find(o => o.name === game.home_team);
      const awayOut  = h2h.outcomes.find(o => o.name === game.away_team);
      const drawOut  = h2h.outcomes.find(o => o.name === 'Draw');

      const gameKey = `${game.home_team}_${game.away_team}`;
      oddsMap[gameKey] = {
        home:       homeOut?.price ?? null,
        draw:       drawOut?.price ?? null,
        away:       awayOut?.price ?? null,
        commence:   game.commence_time,
        gameId:     game.id,
        homeTeam:   game.home_team,
        awayTeam:   game.away_team,
        bookmaker:  book.title,
      };
    }

    setCache(cacheKey, oddsMap, TTL.ODDS);
    return oddsMap;
  } catch (err) {
    console.warn('[Odds API]', err.message);
    return {};
  }
}

// ─── SofaScore (unofficial) ───────────────────────────────────────────────────

const SOFASCORE_CHELSEA_ID = 38;

async function fetchSofaScoreLineup(eventId) {
  const cacheKey = `sofa_lineup_${eventId}`;
  const cached   = getCache(cacheKey);
  if (cached) return cached;
  try {
    const res = await axios.get(
      `https://api.sofascore.com/api/v1/event/${eventId}/lineups`,
      { timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0' } },
    );
    setCache(cacheKey, res.data, TTL.FPL);
    return res.data;
  } catch {
    return null;
  }
}

async function fetchSofaScoreNextFixtures() {
  const cached = getCache('sofa_fixtures');
  if (cached) return cached;
  try {
    const res = await axios.get(
      `https://api.sofascore.com/api/v1/team/${SOFASCORE_CHELSEA_ID}/events/next/0`,
      { timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0' } },
    );
    const data = res.data?.events ?? [];
    setCache('sofa_fixtures', data, TTL.FPL);
    return data;
  } catch {
    return [];
  }
}

// ─── H2H (openfootball) ───────────────────────────────────────────────────────

async function fetchH2H(opponentName) {
  const cacheKey = `h2h_${opponentName}`;
  const cached   = getCache(cacheKey);
  if (cached) return cached;

  try {
    const year = new Date().getMonth() >= 6 ? new Date().getFullYear() : new Date().getFullYear() - 1;
    const seasons = [`${year}-${year + 1}`, `${year - 1}-${year}`, `${year - 2}-${year - 1}`];
    const matches = [];

    for (const season of seasons) {
      const [y1, y2] = season.split('-');
      const url = `https://raw.githubusercontent.com/openfootball/football.json/master/${y1}-${String(y2).slice(-2)}/en.1.json`;
      try {
        const res = await axios.get(url, { timeout: 8000 });
        const rounds = res.data?.rounds ?? [];
        for (const round of rounds) {
          for (const m of (round.matches ?? [])) {
            const isH2H = (
              (m.team1 === 'Chelsea FC' && m.team2 === opponentName) ||
              (m.team2 === 'Chelsea FC' && m.team1 === opponentName)
            );
            if (isH2H) {
              matches.push({
                date:      m.date,
                homeTeam:  m.team1,
                awayTeam:  m.team2,
                homeGoals: m.score?.ft?.[0] ?? null,
                awayGoals: m.score?.ft?.[1] ?? null,
                season,
              });
            }
          }
        }
      } catch {}
    }

    const result = matches.sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 10);
    setCache(cacheKey, result, TTL.XG);
    return result;
  } catch (err) {
    console.warn('[H2H]', err.message);
    return [];
  }
}

// ─── Form data from FPL ───────────────────────────────────────────────────────

async function buildFormData(fixtures, teams, chelseaId) {
  const formMap = {};

  const wavg = (games, goalsFor, goalsAgainst) => {
    if (!games.length) return { sc: 0, co: 0 };
    const ws  = FORM_WEIGHTS.slice(0, games.length);
    const wSum = ws.reduce((a, b) => a + b, 0) || 1;
    let sc = 0, co = 0;
    for (let i = 0; i < games.length; i++) {
      const w = (FORM_WEIGHTS[i] ?? 0) / wSum;
      sc += goalsFor(games[i])     * w;
      co += goalsAgainst(games[i]) * w;
    }
    return { sc, co }; // weighted per-game averages (denominator already applied)
  };

  for (const team of teams) {
    const allPlayed = fixtures
      .filter(f => f.finished && (f.team_h === team.id || f.team_a === team.id))
      .sort((a, b) => new Date(b.kickoff_time) - new Date(a.kickoff_time));

    // ─── Venue-specific recent form (last 5 home / last 5 away separately) ──
    // CRITICAL: home and away games are weighted independently so that each
    // signal is compared against the correct league average (home vs away),
    // eliminating the venue-context mixing bug that suppressed home attack ratings.
    const homePlayed = allPlayed.filter(f => f.team_h === team.id).slice(0, 5);
    const awayPlayed = allPlayed.filter(f => f.team_a === team.id).slice(0, 5);

    const homeRecent = wavg(homePlayed, f => f.team_h_score ?? 0, f => f.team_a_score ?? 0);
    const awayRecent = wavg(awayPlayed, f => f.team_a_score ?? 0, f => f.team_h_score ?? 0);

    // ─── Season venue splits ─────────────────────────────────────────────────
    let seasonHomeScored = 0, seasonHomeConceded = 0;
    let seasonAwayScored = 0, seasonAwayConceded = 0;
    for (const f of allPlayed) {
      if (f.team_h === team.id) {
        seasonHomeScored   += f.team_h_score ?? 0;
        seasonHomeConceded += f.team_a_score ?? 0;
      } else {
        seasonAwayScored   += f.team_a_score ?? 0;
        seasonAwayConceded += f.team_h_score ?? 0;
      }
    }
    const allHome = allPlayed.filter(f => f.team_h === team.id);
    const allAway = allPlayed.filter(f => f.team_a === team.id);

    // ─── Mixed recent form (kept for backward-compat fallback path only) ────
    const mixed = allPlayed.slice(0, 5);
    const mixedStats = wavg(
      mixed,
      f => (f.team_h === team.id ? f.team_h_score : f.team_a_score) ?? 0,
      f => (f.team_h === team.id ? f.team_a_score : f.team_h_score) ?? 0,
    );

    formMap[team.id] = {
      // ─── Venue-specific recent form (PRIMARY — used by getAttack/getDefense) ─
      homeScored:   homeRecent.sc,
      homeConceded: homeRecent.co,
      homeGames:    homePlayed.length,
      awayScored:   awayRecent.sc,
      awayConceded: awayRecent.co,
      awayGames:    awayPlayed.length,
      // ─── Season venue splits (anchor when insufficient recent games) ────────
      seasonHomeScored,  seasonHomeConceded, seasonHomeGames: allHome.length,
      seasonAwayScored,  seasonAwayConceded, seasonAwayGames: allAway.length,
      // ─── Mixed season totals (fallback / display) ────────────────────────────
      seasonScored:   seasonHomeScored + seasonAwayScored,
      seasonConceded: seasonHomeConceded + seasonAwayConceded,
      seasonGames:    allPlayed.length,
      // ─── Mixed recent (legacy fallback in engine, also used for recentResults) ─
      scored:  mixedStats.sc,
      conceded: mixedStats.co,
      games:   1,
      recentResults: mixed.map(f => ({
        homeGoals: f.team_h === team.id ? f.team_h_score : f.team_a_score,
        awayGoals: f.team_h === team.id ? f.team_a_score : f.team_h_score,
      })),
    };
  }

  return formMap;
}

// ─── League average goals ─────────────────────────────────────────────────────

function calcLeagueAverages(fixtures) {
  const finished = fixtures.filter(f => f.finished);
  if (!finished.length) return { home: 1.52, away: 1.18 };
  const totalHome = finished.reduce((s, f) => s + (f.team_h_score ?? 0), 0);
  const totalAway = finished.reduce((s, f) => s + (f.team_a_score ?? 0), 0);
  return {
    home: totalHome / finished.length,
    away: totalAway / finished.length,
  };
}

// ─── Rolling ratings (cached 5 min) ──────────────────────────────────────────

async function getRollingRatings() {
  const cached = getCache('rolling_ratings');
  if (cached) return cached;

  const allFixtures = await fetchFixtures();
  const leagueAvg   = calcLeagueAverages(allFixtures);
  const result      = buildRollingRatings(allFixtures, leagueAvg.home, leagueAvg.away);

  setCache('rolling_ratings', result, TTL.FPL);
  return result;
}

async function getEloRatings() {
  const cached = getCache('elo_ratings');
  if (cached) return cached;

  const allFixtures = await fetchFixtures();
  const result      = buildEloRatings(allFixtures);
  setCache('elo_ratings', result, TTL.FPL);
  return result;
}

// ─── Referee stats ────────────────────────────────────────────────────────────

function buildRefereeStats(allFixtures) {
  const stats = {}; // { [referee]: { games, yellows, reds, penAttempts } }

  for (const f of allFixtures) {
    if (!f.finished || !f.referee) continue;
    const ref = f.referee;
    if (!stats[ref]) stats[ref] = { games: 0, yellows: 0, reds: 0, penAttempts: 0 };
    stats[ref].games++;

    for (const s of f.stats ?? []) {
      const sum = arr => (arr ?? []).reduce((t, x) => t + (x.value ?? 0), 0);
      if (s.identifier === 'yellow_cards')   stats[ref].yellows     += sum(s.a) + sum(s.h);
      if (s.identifier === 'red_cards')      stats[ref].reds        += sum(s.a) + sum(s.h);
      if (s.identifier === 'penalties_missed' || s.identifier === 'penalties_saved')
        stats[ref].penAttempts += sum(s.a) + sum(s.h);
    }
  }

  return Object.fromEntries(
    Object.entries(stats).map(([ref, d]) => [ref, {
      games:        d.games,
      yellowsPerGame: d.games ? +(d.yellows     / d.games).toFixed(2) : 0,
      redsPerGame:    d.games ? +(d.reds         / d.games).toFixed(2) : 0,
      pensPerGame:    d.games ? +(d.penAttempts  / d.games).toFixed(2) : 0,
    }])
  );
}

// ─── Injuries from FPL ────────────────────────────────────────────────────────

async function getChelseaInjuries(chelseaId) {
  const bs      = await fetchBootstrap();
  const players = bs.elements ?? [];
  return players
    .filter(p => p.team === chelseaId && (p.status === 'i' || p.status === 'd' || p.status === 's'))
    .map(p => ({
      id:          p.id,
      name:        `${p.first_name} ${p.second_name}`,
      webName:     p.web_name,
      status:      p.status,
      news:        p.news,
      chancePlay:  p.chance_of_playing_next_round,
      position:    ['GKP','DEF','MID','FWD'][p.element_type - 1],
      cost:        p.now_cost / 10,
    }))
    .filter(p => p.news && p.news.length > 0);
}

// ─── Route: GET /api/fixtures ─────────────────────────────────────────────────

app.get('/api/fixtures', async (req, res) => {
  try {
    const [[bs, fixtures], sofaEvents] = await Promise.all([
      Promise.all([fetchBootstrap(), fetchFixtures()]),
      fetchSofaScoreNextFixtures(),
    ]);
    const { teams, events } = bs;
    const chelseaId = (teams.find(t => t.code === CHELSEA_CODE))?.id;

      const plUpcoming = fixtures
      .filter(f => !f.finished && (f.team_h === chelseaId || f.team_a === chelseaId))
      .sort((a, b) => new Date(a.kickoff_time) - new Date(b.kickoff_time))
      .slice(0, 10)
      .map(f => ({ ...enrichFixture(f, teams, events), competition: 'Premier League', isCup: false }));

    // SofaScore cup fixtures — excluded if tournament slug contains "premier-league"
    const cupFixtures = sofaEvents
      .filter(e => {
        const slug = (e.tournament?.slug ?? e.tournament?.uniqueTournament?.slug ?? '').toLowerCase();
        return !slug.includes('premier-league') && !slug.includes('premier_league');
      })
      .map(e => {
        const isHomeChelsea = e.homeTeam?.id === SOFASCORE_CHELSEA_ID;
        return {
          id:          `sofa_${e.id}`,
          gameweek:    null,
          kickoffTime: e.startTimestamp ? new Date(e.startTimestamp * 1000).toISOString() : null,
          finished:    false,
          started:     false,
          homeTeam: {
            id:        e.homeTeam?.id,
            name:      e.homeTeam?.name ?? 'TBC',
            shortName: e.homeTeam?.shortName ?? e.homeTeam?.name ?? 'TBC',
            code:      isHomeChelsea ? CHELSEA_CODE : null,
          },
          awayTeam: {
            id:        e.awayTeam?.id,
            name:      e.awayTeam?.name ?? 'TBC',
            shortName: e.awayTeam?.shortName ?? e.awayTeam?.name ?? 'TBC',
            code:      !isHomeChelsea ? CHELSEA_CODE : null,
          },
          homeScore:   null,
          awayScore:   null,
          competition: e.tournament?.name ?? 'Cup',
          isCup:       true,
        };
      });

    // If no FA Cup fixture found from SofaScore, add a placeholder
    const hasFaCup = cupFixtures.some(f =>
      (f.competition ?? '').toLowerCase().includes('fa cup')
    );
    if (!hasFaCup) {
      cupFixtures.push({
        id:          'sofa_facup_placeholder',
        gameweek:    null,
        kickoffTime: null,
        finished:    false,
        started:     false,
        homeTeam:    { id: null, name: 'TBC', shortName: 'TBC', code: null },
        awayTeam:    { id: SOFASCORE_CHELSEA_ID, name: 'Chelsea', shortName: 'CHE', code: CHELSEA_CODE },
        homeScore:   null,
        awayScore:   null,
        competition: 'FA Cup Final',
        isCup:       true,
        placeholder: true,
      });
    }

    const seen = new Set();
    const merged = [...plUpcoming, ...cupFixtures]
      .filter(f => { if (seen.has(f.id)) return false; seen.add(f.id); return true; })
      .sort((a, b) => {
        if (!a.kickoffTime && !b.kickoffTime) return 0;
        if (!a.kickoffTime) return 1;
        if (!b.kickoffTime) return -1;
        return new Date(a.kickoffTime) - new Date(b.kickoffTime);
      });

    res.json(merged);
  } catch (err) {
    console.error('[/api/fixtures]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Route: GET /api/results ──────────────────────────────────────────────────

app.get('/api/results', async (req, res) => {
  try {
    const [bs, fixtures] = await Promise.all([fetchBootstrap(), fetchFixtures()]);
    const { teams, events } = bs;
    const chelseaId = (teams.find(t => t.code === CHELSEA_CODE))?.id;

    const results = fixtures
      .filter(f => f.finished && (f.team_h === chelseaId || f.team_a === chelseaId))
      .sort((a, b) => new Date(b.kickoff_time) - new Date(a.kickoff_time))
      .slice(0, 10)
      .map(f => enrichFixture(f, teams, events));

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Route: GET /api/standings ────────────────────────────────────────────────

app.get('/api/standings', async (req, res) => {
  try {
    const [bs, fixtures] = await Promise.all([fetchBootstrap(), fetchFixtures()]);
    const { teams } = bs;
    const finished = fixtures.filter(f => f.finished);

    const table = teams.map(team => {
      let played = 0, won = 0, drawn = 0, lost = 0, gf = 0, ga = 0;
      for (const f of finished) {
        if (f.team_h === team.id) {
          played++;
          gf += f.team_h_score ?? 0; ga += f.team_a_score ?? 0;
          if (f.team_h_score > f.team_a_score)      won++;
          else if (f.team_h_score === f.team_a_score) drawn++;
          else                                        lost++;
        } else if (f.team_a === team.id) {
          played++;
          gf += f.team_a_score ?? 0; ga += f.team_h_score ?? 0;
          if (f.team_a_score > f.team_h_score)      won++;
          else if (f.team_a_score === f.team_h_score) drawn++;
          else                                        lost++;
        }
      }
      return {
        id:     team.id,
        name:   team.name,
        short:  team.short_name,
        code:   team.code,
        played, won, drawn, lost,
        gf, ga, gd: gf - ga,
        points: won * 3 + drawn,
      };
    }).sort((a, b) => b.points - a.points || b.gd - a.gd || b.gf - a.gf);

    setCache('standings', table, TTL.FPL);
    res.json(table);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Route: GET /api/teams ────────────────────────────────────────────────────

app.get('/api/teams', async (req, res) => {
  try {
    const bs = await fetchBootstrap();
    res.json(bs.teams.map(t => ({ id: t.id, name: t.name, short: t.short_name, code: t.code })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Route: GET /api/chelsea-stats ────────────────────────────────────────────

app.get('/api/chelsea-stats', async (req, res) => {
  try {
    const [bs, fixtures] = await Promise.all([fetchBootstrap(), fetchFixtures()]);
    const { teams, elements } = bs;
    const chelseaId   = (teams.find(t => t.code === CHELSEA_CODE))?.id;
    const finished    = fixtures.filter(f => f.finished && (f.team_h === chelseaId || f.team_a === chelseaId));

    let won = 0, drawn = 0, lost = 0, gf = 0, ga = 0;
    let homeWon = 0, homeDrawn = 0, homeLost = 0;
    let awayWon = 0, awayDrawn = 0, awayLost = 0;

    for (const f of finished) {
      const isHome = f.team_h === chelseaId;
      const cg     = isHome ? f.team_h_score : f.team_a_score;
      const og     = isHome ? f.team_a_score : f.team_h_score;
      gf += cg; ga += og;
      if (cg > og)      { won++;   isHome ? homeWon++   : awayWon++;   }
      else if (cg === og) { drawn++; isHome ? homeDrawn++ : awayDrawn++; }
      else              { lost++;  isHome ? homeLost++  : awayLost++;  }
    }

    const squad = (elements ?? [])
      .filter(p => p.team === chelseaId)
      .sort((a, b) => b.goals_scored - a.goals_scored)
      .slice(0, 5)
      .map(p => ({ name: p.web_name, goals: p.goals_scored, assists: p.assists }));

    res.json({
      played: finished.length, won, drawn, lost, gf, ga, gd: gf - ga,
      points: won * 3 + drawn,
      home: { won: homeWon, drawn: homeDrawn, lost: homeLost },
      away: { won: awayWon, drawn: awayDrawn, lost: awayLost },
      topScorers: squad,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Route: GET /api/injuries ─────────────────────────────────────────────────

app.get('/api/injuries', async (req, res) => {
  try {
    const bs        = await fetchBootstrap();
    const chelseaId = (bs.teams.find(t => t.code === CHELSEA_CODE))?.id;
    const injuries  = await getChelseaInjuries(chelseaId);
    res.json(injuries);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Route: GET /api/h2h/:opponentId ─────────────────────────────────────────

app.get('/api/h2h/:opponentId', async (req, res) => {
  try {
    const bs = await fetchBootstrap();
    const opponent = bs.teams.find(t => t.id === Number(req.params.opponentId));
    if (!opponent) return res.status(404).json({ error: 'Team not found' });

    const h2h = await fetchH2H(opponent.name);
    res.json(h2h);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Route: GET /api/live-odds/:fixtureId ────────────────────────────────────

app.get('/api/live-odds/:fixtureId', async (req, res) => {
  try {
    const bs       = await fetchBootstrap();
    const fixtures = await fetchFixtures();
    const fix      = fixtures.find(f => f.id === Number(req.params.fixtureId));
    if (!fix) return res.status(404).json({ error: 'Fixture not found' });

    const { teams } = bs;
    const homeTeam  = teams.find(t => t.id === fix.team_h);
    const awayTeam  = teams.find(t => t.id === fix.team_a);

    const oddsMap = await fetchOdds();
    const key     = `${homeTeam?.name}_${awayTeam?.name}`;
    const odds    = oddsMap[key] ?? null;

      let edge = null;
    if (odds) {
      const cacheKey = `pred_${fix.id}`;
      const pred     = getCache(cacheKey);
      if (pred) {
        const impliedH = 1 / odds.home;
        const impliedD = 1 / odds.draw;
        const impliedA = 1 / odds.away;
        edge = {
          home: pred.homeWin - impliedH,
          draw: pred.draw    - impliedD,
          away: pred.awayWin - impliedA,
        };
      }
    }

      if (odds?.home && odds?.draw && odds?.away) {
      saveMarketSnapshot(fix.id, odds);
    }

    res.json({ fixtureId: fix.id, odds, edge });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── FPL fixture settled helper ───────────────────────────────────────────────
// FPL uses a two-step finish flag:
//   finished_provisional → true immediately at full-time (scores available)
//   finished             → true hours later once bonus points are calculated
// Checking only `finished` leaves games stuck as Pending for hours after the
// whistle. Accept either flag as long as scores are present.

function isFixtureSettled(fix) {
  return (fix.finished || fix.finished_provisional) &&
    fix.team_h_score != null && fix.team_a_score != null;
}

// ─── Core prediction builder ──────────────────────────────────────────────────

async function buildPrediction(fix, bs, allFixtures) {
  const { teams } = bs;
  const homeTeam  = teams.find(t => t.id === fix.team_h);
  const awayTeam  = teams.find(t => t.id === fix.team_a);
  if (!homeTeam || !awayTeam) throw new Error('Teams not found in bootstrap');

  const homeTeamObj = { id: homeTeam.id, name: homeTeam.name, short: homeTeam.short_name, shortName: homeTeam.short_name, code: homeTeam.code };
  const awayTeamObj = { id: awayTeam.id, name: awayTeam.name, short: awayTeam.short_name, shortName: awayTeam.short_name, code: awayTeam.code };

  // Referee stats are derived synchronously from fixture data — always fresh.
  const allRefStats = buildRefereeStats(allFixtures);
  const referee     = fix.referee ?? null;
  const refStats    = referee ? (allRefStats[referee] ?? null) : null;
  const avgYellows  = Object.values(allRefStats).reduce((s, r) => s + r.yellowsPerGame, 0)
                    / (Object.keys(allRefStats).length || 1);
  const refLabel    = refStats
    ? (refStats.yellowsPerGame > avgYellows * 1.25 ? 'STRICT'
       : refStats.yellowsPerGame < avgYellows * 0.75 ? 'LENIENT' : 'AVERAGE')
    : null;

  const storedEntry = history.predictions.find(p => p.fixtureId === fix.id);
  let prediction;
  let marketOdds;

  if (storedEntry?.prediction) {
    // Reuse the stored prediction so all tabs (Fixtures, Round, History) are consistent.
    // Still fetch fresh odds so the Fixtures tab shows current market prices.
    prediction  = storedEntry.prediction;
    const oddsMap = await fetchOdds();
    marketOdds  = oddsMap[`${homeTeam.name}_${awayTeam.name}`] ?? null;
  } else {
    // No stored prediction — run the full model then save the result.
    const [xgRaw, oddsMap, formData, rollingRatings, eloRatings] = await Promise.all([
      fetchUnderstatXG(),
      fetchOdds(),
      buildFormData(allFixtures, teams, null),
      getRollingRatings(),
      getEloRatings(),
    ]);

    const xGData = {};
    for (const team of teams) {
      const usName = UNDERSTAT_NAME_MAP[team.name] ?? team.name;
      if (xgRaw[usName]) xGData[team.id] = xgRaw[usName];
    }

    const leagueAvg = calcLeagueAverages(allFixtures);
    const h2hData   = await fetchH2H(awayTeam.name);
    marketOdds      = oddsMap[`${homeTeam.name}_${awayTeam.name}`] ?? null;

    const bs2     = await fetchBootstrap();
    const homeInj = (bs2.elements ?? [])
      .filter(p => p.team === homeTeam.id && (p.status === 'i' || p.status === 'd') && p.chance_of_playing_next_round !== null && p.chance_of_playing_next_round < 50)
      .length;
    const awayInj = (bs2.elements ?? [])
      .filter(p => p.team === awayTeam.id && (p.status === 'i' || p.status === 'd') && p.chance_of_playing_next_round !== null && p.chance_of_playing_next_round < 50)
      .length;

    prediction = predict({
      homeTeam:      { id: homeTeam.id, name: homeTeam.name },
      awayTeam:      { id: awayTeam.id, name: awayTeam.name },
      leagueAvgHome: leagueAvg.home,
      leagueAvgAway: leagueAvg.away,
      xGData,
      formData,
      h2hData,
      marketOdds,
      homeInjuries:  homeInj,
      awayInjuries:  awayInj,
      rollingRatings,
      eloRatings,
    });

    const immediateResult = isFixtureSettled(fix)
      ? { homeGoals: fix.team_h_score, awayGoals: fix.team_a_score, settledAt: new Date().toISOString() }
      : null;

    history.predictions.push({
      fixtureId:  fix.id,
      gameweek:   fix.event,
      kickoff:    fix.kickoff_time,
      homeTeam:   homeTeamObj,
      awayTeam:   awayTeamObj,
      prediction,
      trackedAt:  new Date().toISOString(),
      result:     immediateResult,
    });
    saveHistory(history);
  }

  return {
    fixtureId:  fix.id,
    gameweek:   fix.event,
    kickoff:    fix.kickoff_time,
    homeTeam:   homeTeamObj,
    awayTeam:   awayTeamObj,
    prediction,
    odds:       marketOdds,
    referee:    referee ? { name: referee, stats: refStats, label: refLabel } : null,
    generatedAt: new Date().toISOString(),
  };
}

// ─── Route: GET /api/predict-fixture ─────────────────────────────────────────

app.get('/api/predict-fixture', async (req, res) => {
  try {
    const fixtureId = Number(req.query.id);
    if (!fixtureId) return res.status(400).json({ error: 'id query param required' });

    const cacheKey = `pred_${fixtureId}`;
    const cached   = getCache(cacheKey);
    if (cached) return res.json(cached);

    const [bs, allFixtures] = await Promise.all([fetchBootstrap(), fetchFixtures()]);
    const fix = allFixtures.find(f => f.id === fixtureId);
    if (!fix) return res.status(404).json({ error: 'Fixture not found' });

    const result = await buildPrediction(fix, bs, allFixtures);
    setCache(cacheKey, result, TTL.FPL);
    res.json(result);
  } catch (err) {
    console.error('[/api/predict-fixture]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Route: GET /api/predict-gameweek ────────────────────────────────────────

app.get('/api/predict-gameweek', async (req, res) => {
  try {
    const gw     = Number(req.query.gw);
    const season = req.query.season ?? null;
    if (!gw) return res.status(400).json({ error: 'gw query param required' });

    const currentSeason = getCurrentSeason();

    if (season && season !== currentSeason) {
      const archivePath = path.join(__dirname, `prediction-history-${season}.json`);
      if (!fs.existsSync(archivePath)) return res.json([]);
      const archive = JSON.parse(fs.readFileSync(archivePath, 'utf-8'));
      const gwPreds = (archive.predictions ?? []).filter(p => p.gameweek === gw);
      return res.json(gwPreds);
    }

    const [bs, allFixtures] = await Promise.all([fetchBootstrap(), fetchFixtures()]);
    const gwFixtures = allFixtures.filter(f => f.event === gw);

    const results = await Promise.allSettled(
      gwFixtures.map(f => buildPrediction(f, bs, allFixtures))
    );

    res.json(results.filter(r => r.status === 'fulfilled').map(r => r.value));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Helper: gather team stats from FPL data for cup reports ─────────────────

function cupTeamStats(teamId, allFixtures, elements) {
  const finished = allFixtures
    .filter(f => f.finished && (f.team_h === teamId || f.team_a === teamId))
    .sort((a, b) => new Date(b.kickoff_time) - new Date(a.kickoff_time));

  let won = 0, drawn = 0, lost = 0, gf = 0, ga = 0;
  for (const f of finished) {
    const isHome = f.team_h === teamId;
    const tg = isHome ? f.team_h_score : f.team_a_score;
    const og = isHome ? f.team_a_score : f.team_h_score;
    gf += tg; ga += og;
    if (tg > og) won++; else if (tg === og) drawn++; else lost++;
  }

  const last5form = finished.slice(0, 5).map(f => {
    const isHome = f.team_h === teamId;
    const tg = isHome ? f.team_h_score : f.team_a_score;
    const og = isHome ? f.team_a_score : f.team_h_score;
    return tg > og ? 'W' : tg < og ? 'L' : 'D';
  }).join(' ');

  const squad      = (elements ?? []).filter(p => p.team === teamId);
  const topScorer  = [...squad].sort((a, b) => b.goals_scored - a.goals_scored)[0];
  const keyMissing = squad
    .filter(p => (p.status === 'i' || p.status === 'd') && (p.chance_of_playing_next_round ?? 100) < 75)
    .slice(0, 3)
    .map(p => p.web_name);

  return { won, drawn, lost, gf, ga, played: finished.length, last5form, topScorer, keyMissing };
}

// ─── Route: GET /api/prematch-report ─────────────────────────────────────────

app.get('/api/prematch-report', async (req, res) => {
  try {
    const rawId      = req.query.id ?? '';
    const fixtureId  = Number(rawId);
    const isCupRoute = isNaN(fixtureId) || fixtureId === 0;

    if (!rawId) return res.status(400).json({ error: 'id required' });

    const cacheKey = `report_${rawId}`;
    const cached   = getCache(cacheKey);
    if (cached) return res.json({ report: cached });

    // ── Cup fixture path ──────────────────────────────────────────────────────
    if (isCupRoute) {
      const homeName    = req.query.home        ?? 'Chelsea';
      const awayName    = req.query.away        ?? 'Opponent TBC';
      const competition = req.query.competition ?? 'FA Cup Final';

      if (!groq) return res.status(503).json({ error: 'Groq not configured' });

      const [bs, allFixtures] = await Promise.all([fetchBootstrap(), fetchFixtures()]);
      const { teams, elements } = bs;

      // Fuzzy team lookup by name
      const findTeam = name => teams.find(t =>
        t.name === name || t.name.includes(name) || name.includes(t.name)
      );

      const homeTeamData = findTeam(homeName);
      const awayTeamData = findTeam(awayName);

      const homeStats = homeTeamData ? cupTeamStats(homeTeamData.id, allFixtures, elements) : null;
      const awayStats = awayTeamData ? cupTeamStats(awayTeamData.id, allFixtures, elements) : null;

        let h2hText = '';
      try {
        const h2h = await fetchH2H(awayName);
        if (h2h.length) {
          const recent = h2h.slice(0, 5);
          h2hText = 'Recent H2H: ' + recent.map(m =>
            `${m.homeTeam} ${m.homeGoals ?? '?'}-${m.awayGoals ?? '?'} ${m.awayTeam}`
          ).join(', ');
        }
      } catch {}

      const teamBlock = (name, stats) => {
        if (!stats) return `${name}: stats unavailable.`;
        return [
          `${name}: ${stats.played} games — ${stats.won}W ${stats.drawn}D ${stats.lost}L, ${stats.gf} scored / ${stats.ga} conceded.`,
          stats.last5form ? `Last 5 form: ${stats.last5form}` : '',
          stats.topScorer ? `Top scorer: **${stats.topScorer.web_name}** (${stats.topScorer.goals_scored} goals)` : '',
          stats.keyMissing.length ? `Injury concerns: ${stats.keyMissing.join(', ')}` : 'No confirmed major absences',
        ].filter(Boolean).join('\n');
      };

      const systemPrompt = `You are a football analyst specialising in Chelsea FC. Write engaging pre-match analysis for cup finals.
Use **bold** for key stats and player names. Keep it under 450 words.
CRITICAL: Do NOT produce score predictions, scorelines, or win/draw/loss percentages. Your job is purely narrative.`;

      const userPrompt = `Write a pre-match analysis for the **${competition} at Wembley**: ${homeName} vs ${awayName}.

${teamBlock(homeName, homeStats)}

${teamBlock(awayName, awayStats)}

${h2hText}

Cover: recent form of both sides, key tactical battles, players to watch on each team, how the cup final one-off context differs from a league game, and what each side needs to do to win. If any injury doubts are listed, factor them in.`;

      const report = await groqChat([
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt },
      ]);

      setCache(cacheKey, report, TTL.XG);
      return res.json({ report });
    }

    const [bs, allFixtures] = await Promise.all([fetchBootstrap(), fetchFixtures()]);
    const fix      = allFixtures.find(f => f.id === fixtureId);
    if (!fix) return res.status(404).json({ error: 'Fixture not found' });

    const pred     = await buildPrediction(fix, bs, allFixtures);
    const { teams } = bs;
    const homeTeam  = teams.find(t => t.id === fix.team_h);
    const awayTeam  = teams.find(t => t.id === fix.team_a);

    const p = pred.prediction;
    const systemPrompt = `You are a Premier League tactical analyst specialising in Chelsea FC.
Write concise, data-driven pre-match narrative reports. Use **bold** for key stats.
Never invent stats not provided. Keep it under 400 words.
CRITICAL: Do NOT produce your own score predictions, scorelines, or win/draw/loss percentages.
All numerical probabilities and expected scores are calculated by the Monte Carlo simulation and provided to you.
Your sole job is to write narrative analysis explaining WHY the model sees those numbers — tactics, form, injuries, H2H.`;

    const userPrompt = `Write a pre-match narrative for ${homeTeam.name} vs ${awayTeam.name}.

Monte Carlo outputs (do NOT change or re-derive):
  Home win: ${(p.homeWin * 100).toFixed(1)}% | Draw: ${(p.draw * 100).toFixed(1)}% | Away win: ${(p.awayWin * 100).toFixed(1)}%
  Most likely score: ${p.predictedScore} (${(p.scoreProbability * 100).toFixed(1)}%)
  xG — ${homeTeam.name}: ${p.lambdas.home.toFixed(2)} | ${awayTeam.name}: ${p.lambdas.away.toFixed(2)}
  ${pred.odds ? `Odds: ${pred.odds.home} / ${pred.odds.draw} / ${pred.odds.away}` : ''}

Write 3–4 paragraphs: current form, key tactical battles, players to watch, and what would need to go wrong for the favourite.
Do NOT suggest alternative scores or probabilities.`;

    const report = await groqChat([
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPrompt },
    ]);

    setCache(cacheKey, report, TTL.XG);
    res.json({ report });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Route: GET /api/opponent-analysis ───────────────────────────────────────

app.get('/api/opponent-analysis', async (req, res) => {
  try {
    const teamId = Number(req.query.teamId);
    if (!teamId) return res.status(400).json({ error: 'teamId required' });

    const cacheKey = `opp_${teamId}`;
    const cached   = getCache(cacheKey);
    if (cached) return res.json(cached);

    const [bs, allFixtures] = await Promise.all([fetchBootstrap(), fetchFixtures()]);
    const { teams, elements } = bs;
    const team    = teams.find(t => t.id === teamId);
    if (!team) return res.status(404).json({ error: 'Team not found' });

    const squad   = (elements ?? []).filter(p => p.team === teamId);
    const topScorer = squad.sort((a, b) => b.goals_scored - a.goals_scored)[0];
    const injuries  = squad.filter(p => p.status === 'i' || p.status === 'd').slice(0, 3);

    const last5 = allFixtures
      .filter(f => f.finished && (f.team_h === teamId || f.team_a === teamId))
      .sort((a, b) => new Date(b.kickoff_time) - new Date(a.kickoff_time))
      .slice(0, 5);

    const formStr = last5.map(f => {
      const isHome = f.team_h === teamId;
      const tg     = isHome ? f.team_h_score : f.team_a_score;
      const og     = isHome ? f.team_a_score : f.team_h_score;
      return tg > og ? 'W' : tg < og ? 'L' : 'D';
    }).join('');

    const systemPrompt = `You are a Premier League scout. Write a concise opponent analysis in under 300 words. Use markdown. Be specific and analytical.
IMPORTANT: Do NOT suggest match scores, scorelines, win probabilities, or percentage predictions of any kind. Focus purely on qualitative tactical and form analysis.`;
    const userPrompt   = `Analyse ${team.name} as Chelsea's next opponent.
Last 5 form: ${formStr}
Top scorer: ${topScorer?.web_name ?? 'Unknown'} (${topScorer?.goals_scored ?? 0} goals)
Injuries: ${injuries.map(p => p.web_name).join(', ') || 'None reported'}
Cover: their attacking threats, defensive weaknesses Chelsea can exploit, pressing style, set-piece danger, and the key tactical battle to watch. No scores or probabilities.`;

    const analysis = await groqChat([
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPrompt },
    ]);

    const result = { teamId, teamName: team.name, analysis, formStr, topScorer: topScorer?.web_name };
    setCache(cacheKey, result, TTL.XG);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Route: GET /api/predicted-table ─────────────────────────────────────────
// Projected final points = current actual points + E[pts from remaining fixtures].
// E[pts] per fixture = P(win)×3 + P(draw)×1, using the full predict() engine
// for each specific unplayed fixture — not a season-long Monte Carlo extrapolation.
// All model dependencies are fetched once and reused across every fixture.

app.get('/api/predicted-table', async (req, res) => {
  try {
    const cached = getCache('pred_table');
    if (cached) return res.json(cached);

    const [bs, allFixtures] = await Promise.all([fetchBootstrap(), fetchFixtures()]);
    const { teams } = bs;

    const unplayed  = allFixtures.filter(f => !f.finished && f.team_h && f.team_a);
    const leagueAvg = calcLeagueAverages(allFixtures);

    const [xgRaw, formData, rollingRatings, eloRatings, oddsMap] = await Promise.all([
      fetchUnderstatXG(),
      buildFormData(allFixtures, teams, null),
      getRollingRatings(),
      getEloRatings(),
      fetchOdds(),
    ]);

    const xGData = {};
    for (const team of teams) {
      const usName = UNDERSTAT_NAME_MAP[team.name] ?? team.name;
      if (xgRaw[usName]) xGData[team.id] = xgRaw[usName];
    }

    // For each remaining fixture, accumulate E[pts] = P(win)×3 + P(draw)×1.
    // h2hData is omitted (modifier defaults to 1.0) to avoid N×API calls.
    const extraPts = {};
    const extraGD  = {};

    for (const fix of unplayed) {
      const homeTeam = teams.find(t => t.id === fix.team_h);
      const awayTeam = teams.find(t => t.id === fix.team_a);
      if (!homeTeam || !awayTeam) continue;

      let pred;
      try {
        pred = predict({
          homeTeam:      { id: homeTeam.id, name: homeTeam.name },
          awayTeam:      { id: awayTeam.id, name: awayTeam.name },
          leagueAvgHome: leagueAvg.home,
          leagueAvgAway: leagueAvg.away,
          xGData,
          formData,
          h2hData:       [],
          marketOdds:    oddsMap[`${homeTeam.name}_${awayTeam.name}`] ?? null,
          homeInjuries:  0,
          awayInjuries:  0,
          rollingRatings,
          eloRatings,
        });
      } catch { continue; }

      const { homeWin, draw, awayWin, lambdas } = pred;

      extraPts[fix.team_h] = (extraPts[fix.team_h] ?? 0) + homeWin * 3 + draw;
      extraPts[fix.team_a] = (extraPts[fix.team_a] ?? 0) + awayWin * 3 + draw;

      extraGD[fix.team_h] = (extraGD[fix.team_h] ?? 0) + (lambdas.home - lambdas.away);
      extraGD[fix.team_a] = (extraGD[fix.team_a] ?? 0) + (lambdas.away - lambdas.home);
    }

    const currentTable = [];
    for (const team of teams) {
      const finished = allFixtures.filter(
        f => f.finished && (f.team_h === team.id || f.team_a === team.id)
      );
      let pts = 0, gd = 0;
      for (const f of finished) {
        const isHome = f.team_h === team.id;
        const tg = isHome ? f.team_h_score : f.team_a_score;
        const og = isHome ? f.team_a_score : f.team_h_score;
        if (tg > og) pts += 3;
        else if (tg === og) pts += 1;
        gd += tg - og;
      }

      const projExtra = +(extraPts[team.id] ?? 0).toFixed(1);
      const projGD    = +(extraGD[team.id]  ?? 0).toFixed(1);
      const remaining = unplayed.filter(
        f => f.team_h === team.id || f.team_a === team.id
      ).length;

      currentTable.push({
        teamId:         team.id,
        name:           team.name,
        short:          team.short_name,
        code:           team.code,
        currentPoints:  pts,
        currentGD:      gd,
        projectedExtra: projExtra,
        projectedGD:    projGD,
        finalPoints:    +(pts + projExtra).toFixed(1),
        finalGD:        +(gd  + projGD).toFixed(1),
        remaining,
      });
    }

    const result = currentTable
      .filter(t => t.currentPoints > 0 || t.remaining > 0)
      .sort((a, b) => b.finalPoints - a.finalPoints || b.finalGD - a.finalGD);

    setCache('pred_table', result, TTL.TABLE);
    res.json(result);
  } catch (err) {
    console.error('[/api/predicted-table]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Route: GET /api/season-accuracy ─────────────────────────────────────────

app.get('/api/season-accuracy', async (req, res) => {
  try {
    const cached = getCache('season_accuracy');
    if (cached) return res.json(cached);

    const completed = history.predictions.filter(p => p.result && p.prediction);
    const total     = completed.length;
    if (total === 0) return res.json({ total: 0, correct: 0, accuracy: 0, byGW: [] });

    let correct = 0;
    const byGW  = {};

    for (const p of completed) {
      const actual  = p.result.homeGoals > p.result.awayGoals ? 'H'
                    : p.result.homeGoals < p.result.awayGoals ? 'A' : 'D';
      const bestOut = ['H','D','A'][
        [p.prediction.homeWin, p.prediction.draw, p.prediction.awayWin].indexOf(
          Math.max(p.prediction.homeWin, p.prediction.draw, p.prediction.awayWin))
      ];
      const isCorrect = actual === bestOut;
      if (isCorrect) correct++;

      const gw = p.gameweek ?? 0;
      if (!byGW[gw]) byGW[gw] = { correct: 0, total: 0 };
      byGW[gw].total++;
      if (isCorrect) byGW[gw].correct++;
    }

    const predictions = completed.map(p => ({
      predicted: p.prediction,
      actual: p.result.homeGoals > p.result.awayGoals ? 'H'
            : p.result.homeGoals < p.result.awayGoals ? 'A' : 'D',
    }));

    const result = {
      total,
      correct,
      accuracy: total ? correct / total : 0,
      logLoss:  logLoss(predictions),
      brier:    brierScore(predictions),
      calibration: calibrationCurve(predictions),
      byGW: Object.entries(byGW)
        .map(([gw, d]) => ({ gw: Number(gw), ...d, accuracy: d.correct / d.total }))
        .sort((a, b) => a.gw - b.gw),
    };

    setCache('season_accuracy', result, TTL.ACCURACY);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Route: GET /api/performance-metrics ─────────────────────────────────────

app.get('/api/performance-metrics', async (req, res) => {
  try {
    const completed = history.predictions.filter(p => p.result && p.prediction);
    if (completed.length === 0) return res.json({ message: 'No completed predictions yet' });

    const predictions = completed.map(p => ({
      predicted: p.prediction,
      actual: p.result.homeGoals > p.result.awayGoals ? 'H'
            : p.result.homeGoals < p.result.awayGoals ? 'A' : 'D',
    }));

    res.json({
      count:       completed.length,
      logLoss:     logLoss(predictions),
      brierScore:  brierScore(predictions),
      calibration: calibrationCurve(predictions, 10),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Route: GET /api/betting-sim ─────────────────────────────────────────────

app.get('/api/betting-sim', async (req, res) => {
  try {
    const stake  = Number(req.query.stake) || 10;
    const result = bettingSimulator(history.predictions, stake);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});



// ─── Route: POST /api/tracker/result ─────────────────────────────────────────

app.post('/api/tracker/result', async (req, res) => {
  try {
    const { fixtureId, homeGoals, awayGoals } = req.body;
    const entry = history.predictions.find(p => p.fixtureId === fixtureId);
    if (!entry) return res.status(404).json({ error: 'Prediction not tracked' });

    entry.result = { homeGoals, awayGoals, settledAt: new Date().toISOString() };
    saveHistory(history);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Route: GET /api/tracker/history ─────────────────────────────────────────

app.get('/api/tracker/history', async (req, res) => {
  try {
    const bootstrap = await fetchBootstrap();
    const currentGW = bootstrap?.events?.find(e => e.is_current)?.id
      ?? bootstrap?.events?.find(e => e.is_next)?.id
      ?? null;
    res.json({ predictions: history.predictions.slice().reverse(), currentGW });
  } catch {
    res.json({ predictions: history.predictions.slice().reverse(), currentGW: null });
  }
});

// ─── Route: POST /api/refresh-cache ──────────────────────────────────────────

app.post('/api/refresh-cache', (req, res) => {
  cache.clear();
  res.json({ ok: true, message: 'All caches cleared' });
});

// ─── Route: GET /api/seasons ──────────────────────────────────────────────────
// Returns all seasons with prediction data: current season always included,
// plus any archived prediction-history-{season}.json files found on disk.
app.get('/api/seasons', (req, res) => {
  try {
    const current = getCurrentSeason();
    const archiveRe = /^prediction-history-(.+)\.json$/;
    const archived = fs.readdirSync(__dirname)
      .map(f => f.match(archiveRe)?.[1])
      .filter(Boolean);
    const all = [...new Set([current, ...archived])].sort().reverse();
    res.json(all.map(s => ({ season: s, isCurrent: s === current })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Route: GET /api/xpts ─────────────────────────────────────────────────────
// Calculates xPts using a fast analytical Poisson model directly from FPL data.
// No prediction history required.

app.get('/api/xpts', async (req, res) => {
  try {
    const cached = getCache('xpts');
    if (cached) return res.json(cached);

    const [bs, allFixtures] = await Promise.all([fetchBootstrap(), fetchFixtures()]);
    const { teams } = bs;
    const finished  = allFixtures.filter(f => f.finished && f.team_h_score != null && f.team_a_score != null);
    const leagueAvg = calcLeagueAverages(allFixtures);

    const strMap = {};
    for (const team of teams) {
      let scored = 0, conceded = 0, games = 0;
      for (const f of finished) {
        if (f.team_h === team.id) { scored += f.team_h_score; conceded += f.team_a_score; games++; }
        else if (f.team_a === team.id) { scored += f.team_a_score; conceded += f.team_h_score; games++; }
      }
      if (games === 0) { strMap[team.id] = { atk: 1.0, def: 1.0 }; continue; }
      const avgGoal = (leagueAvg.home + leagueAvg.away) / 2;
      const atk = Math.max(0.5, Math.min(1.7, (scored  / games) / avgGoal));
      const def = Math.max(0.5, Math.min(1.7, (conceded / games) / avgGoal));
      strMap[team.id] = { atk, def };
    }

    const FACS = [1,1,2,6,24,120,720,5040,40320,362880];
    const poi  = (k, lam) => Math.exp(-lam) * Math.pow(lam, k) / (FACS[k] ?? FACS[FACS.length - 1]);

    const xptsMap = {};
    for (const f of finished) {
      const hStr = strMap[f.team_h] ?? { atk: 1, def: 1 };
      const aStr = strMap[f.team_a] ?? { atk: 1, def: 1 };
      const lH   = Math.min(2.5, Math.max(0.35, leagueAvg.home * hStr.atk * aStr.def));
      const lA   = Math.min(2.5, Math.max(0.35, leagueAvg.away * aStr.atk * hStr.def));

      let hWin = 0, draw = 0, aWin = 0;
      for (let h = 0; h < 8; h++) {
        for (let a = 0; a < 8; a++) {
          const p = poi(h, lH) * poi(a, lA);
          if      (h > a) hWin += p;
          else if (h === a) draw += p;
          else              aWin += p;
        }
      }

      xptsMap[f.team_h] = (xptsMap[f.team_h] ?? 0) + hWin * 3 + draw;
      xptsMap[f.team_a] = (xptsMap[f.team_a] ?? 0) + aWin * 3 + draw;
    }

    const result = teams.map(team => {
      let pts = 0;
      for (const f of finished) {
        if (f.team_h === team.id) {
          if      (f.team_h_score > f.team_a_score)    pts += 3;
          else if (f.team_h_score === f.team_a_score)  pts += 1;
        } else if (f.team_a === team.id) {
          if      (f.team_a_score > f.team_h_score)    pts += 3;
          else if (f.team_a_score === f.team_h_score)  pts += 1;
        }
      }
      const raw  = xptsMap[team.id];
      const xPts = raw != null ? +raw.toFixed(1) : null;
      return { teamId: team.id, name: team.name, short: team.short_name, code: team.code, actualPts: pts, xPts };
    }).filter(t => t.actualPts > 0 || t.xPts != null)
      .sort((a, b) => b.actualPts - a.actualPts);

    setCache('xpts', result, 30 * 60 * 1000); // 30 min cache
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Route: GET /api/elo-ratings ─────────────────────────────────────────────

app.get('/api/elo-ratings', async (req, res) => {
  try {
    const cached = getCache('elo_ratings_api');
    if (cached) return res.json(cached);

    const [bs, elo] = await Promise.all([fetchBootstrap(), getEloRatings()]);
    const { teams } = bs;

    const result = teams
      .map(t => ({ teamId: t.id, name: t.name, short: t.short_name, code: t.code, elo: Math.round(elo[String(t.id)] ?? 1500) }))
      .sort((a, b) => b.elo - a.elo);

    setCache('elo_ratings_api', result, TTL.FPL);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Route: GET /api/weather/:fixtureId ──────────────────────────────────────

const STADIUM_COORDS = {
  'Chelsea':           { lat: 51.4816, lng: -0.1910 },
  'Arsenal':           { lat: 51.5549, lng: -0.1084 },
  'Liverpool':         { lat: 53.4308, lng: -2.9608 },
  'Manchester City':   { lat: 53.4831, lng: -2.2004 },
  'Manchester United': { lat: 53.4631, lng: -2.2913 },
  'Tottenham Hotspur': { lat: 51.6044, lng: -0.0665 },
  'Newcastle United':  { lat: 54.9756, lng: -1.6216 },
  'Aston Villa':       { lat: 52.5090, lng: -1.8847 },
  'Brighton':          { lat: 50.8619, lng: -0.0837 },
  'West Ham United':   { lat: 51.5386, lng: -0.0164 },
  'Brentford':         { lat: 51.4882, lng: -0.2886 },
  'Fulham':            { lat: 51.4749, lng: -0.2217 },
  'Bournemouth':       { lat: 50.7352, lng: -1.8382 },
  'Crystal Palace':    { lat: 51.3983, lng: -0.0855 },
  'Everton':           { lat: 53.4388, lng: -2.9662 },
  'Wolverhampton Wanderers': { lat: 52.5902, lng: -2.1302 },
  'Leeds United':      { lat: 53.7772, lng: -1.5724 },
  'Leicester City':    { lat: 52.6204, lng: -1.1422 },
  'Nottingham Forest': { lat: 52.9399, lng: -1.1326 },
  'Sunderland':        { lat: 54.9147, lng: -1.3883 },
  'Ipswich Town':      { lat: 52.0551, lng:  1.1447 },
  'Southampton':       { lat: 50.9058, lng: -1.3914 },
};

function wmoToCondition(code) {
  if (code === 0)           return { label: 'Clear', icon: '☀️' };
  if (code <= 3)            return { label: 'Partly cloudy', icon: '⛅' };
  if (code <= 48)           return { label: 'Foggy', icon: '🌫️' };
  if (code <= 55)           return { label: 'Drizzle', icon: '🌦️' };
  if (code <= 67)           return { label: 'Rain', icon: '🌧️' };
  if (code <= 77)           return { label: 'Snow', icon: '❄️' };
  if (code <= 82)           return { label: 'Showers', icon: '🌦️' };
  if (code <= 99)           return { label: 'Thunderstorm', icon: '⛈️' };
  return { label: 'Unknown', icon: '🌡️' };
}

app.get('/api/weather/:fixtureId', async (req, res) => {
  try {
    const fixtureId = Number(req.params.fixtureId);
    const cacheKey  = `weather_${fixtureId}`;
    const cached    = getCache(cacheKey);
    if (cached) return res.json(cached);

    const [bs, allFixtures] = await Promise.all([fetchBootstrap(), fetchFixtures()]);
    const fix = allFixtures.find(f => f.id === fixtureId);
    if (!fix) return res.status(404).json({ error: 'Fixture not found' });

    const homeTeam = bs.teams.find(t => t.id === fix.team_h);
    if (!homeTeam) return res.status(404).json({ error: 'Home team not found' });

    const coords = STADIUM_COORDS[homeTeam.name];
    if (!coords) return res.json({ available: false, reason: 'No stadium coordinates' });

    if (!fix.kickoff_time) return res.json({ available: false, reason: 'No kickoff time' });

    const kickoff  = new Date(fix.kickoff_time);
    const forecastDays = Math.max(1, Math.min(7, Math.ceil((kickoff - Date.now()) / 86400000) + 1));

    const url = `https://api.open-meteo.com/v1/forecast?latitude=${coords.lat}&longitude=${coords.lng}` +
      `&hourly=temperature_2m,precipitation_probability,precipitation,windspeed_10m,weathercode` +
      `&timezone=Europe%2FLondon&forecast_days=${forecastDays}`;

    const weatherRes = await axios.get(url, { timeout: 8000 });
    const { hourly } = weatherRes.data;

    const kickoffISO = kickoff.toISOString().slice(0, 13); // "YYYY-MM-DDTHH"
    const hourIdx = (hourly.time ?? []).findIndex(t => t.startsWith(kickoffISO));

    if (hourIdx === -1) {
      return res.json({ available: false, reason: 'Kickoff time outside forecast window' });
    }

    const condition = wmoToCondition(hourly.weathercode[hourIdx]);
    const result = {
      available:        true,
      kickoff:          fix.kickoff_time,
      stadium:          homeTeam.name,
      temperature:      Math.round(hourly.temperature_2m[hourIdx]),
      precipChance:     hourly.precipitation_probability[hourIdx] ?? 0,
      precipMm:         +(hourly.precipitation[hourIdx] ?? 0).toFixed(1),
      windKph:          Math.round((hourly.windspeed_10m[hourIdx] ?? 0)),
      condition:        condition.label,
      icon:             condition.icon,
      notes:            [],
    };

    if (result.precipMm > 5)   result.notes.push('Heavy rain expected — conditions may favour defensive play');
    if (result.windKph > 40)   result.notes.push('High winds — aerial balls and long shots less effective');

    setCache(cacheKey, result, TTL.WEATHER);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Route: GET /api/market-movement/:fixtureId ──────────────────────────────

app.get('/api/market-movement/:fixtureId', (req, res) => {
  try {
    const fixtureId = Number(req.params.fixtureId);
    const mh = loadMarketHistory();
    const snapshots = mh[String(fixtureId)] ?? [];

    if (snapshots.length < 2) return res.json({ fixtureId, snapshots, movement: null });

    const opening = snapshots[0];
    const current = snapshots[snapshots.length - 1];

    const pctChange = (open, curr) => open ? +((curr - open) / open * 100).toFixed(1) : null;

    const movement = {
      home: { open: opening.home, current: current.home, pct: pctChange(opening.home, current.home) },
      draw: { open: opening.draw, current: current.draw, pct: pctChange(opening.draw, current.draw) },
      away: { open: opening.away, current: current.away, pct: pctChange(opening.away, current.away) },
    };

    const steamMove = movement.home.pct != null && movement.home.pct < -10;

    res.json({ fixtureId, snapshots, movement, steamMove });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Route: GET /api/referee-stats/:fixtureId ────────────────────────────────

app.get('/api/referee-stats/:fixtureId', async (req, res) => {
  try {
    const fixtureId = Number(req.params.fixtureId);
    const allFixtures = await fetchFixtures();
    const fix = allFixtures.find(f => f.id === fixtureId);
    if (!fix) return res.status(404).json({ error: 'Fixture not found' });

    const refName  = fix.referee ?? null;
    if (!refName) return res.json({ fixtureId, available: false });

    const allStats = buildRefereeStats(allFixtures);
    const stats    = allStats[refName] ?? null;
    const avgY     = Object.values(allStats).reduce((s, r) => s + r.yellowsPerGame, 0)
                   / (Object.keys(allStats).length || 1);
    const label    = stats
      ? (stats.yellowsPerGame > avgY * 1.25 ? 'STRICT'
         : stats.yellowsPerGame < avgY * 0.75 ? 'LENIENT' : 'AVERAGE')
      : null;

    res.json({ fixtureId, available: true, referee: refName, stats, label, leagueAvgYellows: +avgY.toFixed(2) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Route: POST /api/push/subscribe ─────────────────────────────────────────

app.post('/api/push/subscribe', (req, res) => {
  const sub = req.body;
  if (!subscriptions.find(s => s.endpoint === sub.endpoint)) {
    subscriptions.push(sub);
  }
  res.json({ ok: true });
});

// ─── Background: auto-fill results ───────────────────────────────────────────

async function autoFillResults() {
  try {
    const allFixtures = await fetchFixtures();
    const unresolved  = history.predictions.filter(p => !p.result);

    for (const entry of unresolved) {
      const fix = allFixtures.find(f => f.id === entry.fixtureId);
      if (isFixtureSettled(fix)) {
        entry.result = {
          homeGoals:  fix.team_h_score,
          awayGoals:  fix.team_a_score,
          settledAt:  new Date().toISOString(),
        };
        // Refresh kickoff from live data — fixes entries where kickoff_time was
        // null or stale when the prediction was first saved
        if (fix.kickoff_time) entry.kickoff = fix.kickoff_time;
      }
    }

    saveHistory(history);
  } catch (err) {
    console.warn('[Auto-fill results]', err.message);
  }
}

// ─── Background: push notifications ──────────────────────────────────────────

async function checkKickoffNotifications() {
  if (!process.env.VAPID_PUBLIC_KEY) return;
  try {
    const allFixtures = await fetchFixtures();
    const now         = Date.now();
    const twoHours    = 2 * 60 * 60 * 1000;

    const upcoming = allFixtures.filter(f => {
      if (!f.kickoff_time || f.finished) return false;
      const diff = new Date(f.kickoff_time) - now;
      return diff > 0 && diff <= twoHours;
    });

    for (const fix of upcoming) {
      const notifKey = `notif_pre_${fix.id}`;
      if (getCache(notifKey)) continue;

      await sendPushToAll({
        type:    'KICKOFF_SOON',
        message: `Kickoff in ~2h`,
        fixtureId: fix.id,
      });

      setCache(notifKey, true, twoHours + 5 * 60 * 1000);
    }

    // Post-match notifications
    const justFinished = allFixtures.filter(f => {
      if (!f.finished || !f.kickoff_time) return false;
      const diff = now - new Date(f.kickoff_time);
      return diff > 0 && diff <= 2 * 60 * 60 * 1000;
    });

    for (const fix of justFinished) {
      const notifKey = `notif_post_${fix.id}`;
      if (getCache(notifKey)) continue;

      await sendPushToAll({
        type:    'RESULT',
        message: `FT: ${fix.team_h_score} - ${fix.team_a_score}`,
        fixtureId: fix.id,
      });

      setCache(notifKey, true, 3 * 60 * 60 * 1000);
    }
  } catch (err) {
    console.warn('[Push notifications]', err.message);
  }
}

// ─── Background: season rollover ──────────────────────────────────────────────

// ─── Startup: health checks ───────────────────────────────────────────────────
async function runHealthChecks() {
  console.log('🔍 Health checks:');
  try {
    await axios.get(`${FPL_BASE}/bootstrap-static/`, { timeout: 6000 });
    console.log('   ✅ FPL API');
  } catch (err) {
    console.error(`   ❌ FPL API: ${err.message} — predictions will fail until resolved`);
  }
  try {
    await axios.get('https://understat.com', {
      timeout: 6000,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    console.log('   ✅ Understat xG');
  } catch (err) {
    console.warn(`   ⚠️  Understat xG: ${err.message} — model falling back to EWMA ratings`);
  }
  if (process.env.ODDS_API_KEY) {
    try {
      await axios.get('https://api.the-odds-api.com/v4/sports/', {
        params: { apiKey: process.env.ODDS_API_KEY },
        timeout: 6000,
      });
      console.log('   ✅ Odds API');
    } catch (err) {
      const detail = err.response?.status === 401 ? 'invalid API key' : err.message;
      console.warn(`   ⚠️  Odds API: ${detail} — market blending disabled`);
    }
  } else {
    console.warn('   ⚠️  Odds API: no ODDS_API_KEY — market blending disabled');
  }
  console.log('');
}

function checkSeasonRollover() {
  const currentSeason = getCurrentSeason();
  if (!history.season) {
    history.season = currentSeason;
    saveHistory(history);
    return;
  }
  if (history.season !== currentSeason) {
    const oldSeason = history.season;
    const archivePath = path.join(__dirname, `prediction-history-${oldSeason}.json`);
    fs.writeFileSync(archivePath, JSON.stringify(history, null, 2));
    ['rolling_ratings', 'elo_ratings', 'fixtures_all', 'bootstrap'].forEach(k => cache.delete(k));
    history = { season: currentSeason, predictions: [] };
    saveHistory(history);
    console.log(`[Season rollover] ✅ ${oldSeason} → ${currentSeason}. Ratings cache cleared.`);
  }
}

// ─── Startup: backfill pending results ───────────────────────────────────────
// Runs once at boot. Bypasses the in-memory fixture cache so we always get a
// fresh copy of FPL data — important because the cache may not have been
// populated yet, or may hold pre-result data from a previous run.
// Catches any entries whose result wasn't filled inline (e.g. race condition on first load).

async function backfillPendingResults() {
  try {
    const pending = history.predictions.filter(p => !p.result);
    if (pending.length === 0) {
      console.log('[Backfill] No pending predictions to fill.');
      return;
    }

    const res = await axios.get(`${FPL_BASE}/fixtures/`, { timeout: 15000 });
    const allFixtures = res.data;

    let filled = 0;
    for (const entry of pending) {
      const fix = allFixtures.find(f => f.id === entry.fixtureId);
      if (isFixtureSettled(fix)) {
        entry.result = {
          homeGoals:  fix.team_h_score,
          awayGoals:  fix.team_a_score,
          settledAt:  new Date().toISOString(),
        };
        // Refresh kickoff from live data — fixes entries where kickoff_time was
        // null or stale when the prediction was first saved
        if (fix.kickoff_time) entry.kickoff = fix.kickoff_time;
        filled++;
      }
    }

    if (filled > 0) {
      saveHistory(history);
      console.log(`[Backfill] Filled results for ${filled}/${pending.length} pending predictions.`);
    } else {
      console.log(`[Backfill] ${pending.length} predictions still genuinely pending (not finished yet).`);
    }
  } catch (err) {
    console.warn('[Backfill] Failed:', err.message);
  }
}

// ─── Cron jobs ────────────────────────────────────────────────────────────────

cron.schedule('0 * * * *',    autoFillResults);            // every hour
cron.schedule('*/15 * * * *', checkKickoffNotifications);  // every 15 min
cron.schedule('0 8 * * *',    checkSeasonRollover);        // daily at 8am

// ─── Production static + SPA fallback ────────────────────────────────────────

if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, 'dist')));
  app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
      res.sendFile(path.join(__dirname, 'dist', 'index.html'));
    }
  });
} else {
  app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
      res.status(200).send('Chelsea Pred API running. Start the frontend with: npm run client');
    }
  });
}

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n⚽ Chelsea Pred backend running on http://localhost:${PORT}`);
  console.log(`   Groq: ${groq ? '✅ connected' : '❌ no GROQ_API_KEY'}`);
  console.log(`   Push: ${process.env.VAPID_PUBLIC_KEY ? '✅ configured' : '⚠️  no VAPID keys'}\n`);
  checkSeasonRollover();
  runHealthChecks();
  backfillPendingResults();
  autoFillResults();
});

module.exports = app;
