'use strict';

require('dotenv').config();

process.on('unhandledRejection', (reason, promise) => {
  console.error('\n🔴 Unhandled Promise Rejection:');
  console.error(reason);
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  console.error('\n🔴 Uncaught Exception:');
  console.error(err);
  process.exit(1);
});

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
  buildTeamHomeAdvantage,
  simulateSeason,
  logLoss,
  brierScore,
  calibrationCurve,
  bettingSimulator,
  FORM_WEIGHTS,
} = require('./models/predictionEngine');

const { runDiagnostics }            = require('./models/modelDiagnostics');
const { generateCalibrationReport } = require('./models/autoCalibrator');
const modelMonitor                  = require('./core/observability/modelMonitor');

// ─── Core infrastructure ──────────────────────────────────────────────────────
const logger          = require('./core/observability/logger');
const failures        = require('./core/observability/failureRegistry');
const cache           = require('./core/cache/cacheManager');
const {
  WC_MODEL_VERSION,
  TTL,
  ELO_CONFIG,
  FLAGS,
} = require('./core/state/modelState');
const {
  FIFA_STRENGTH,
  WC_HOST_NATIONS,
  WC_CONFEDERATION,
  CONFED_LAMBDA_FACTOR,
  MARTJ42_ALIAS,
  WC_GROUPS,
  WC_SCHEDULE,
} = require('./core/config/footballConfig');

const {
  poissonPMF:       _corePoissonPMF,
  calculateEloRatings,
  buildFormStats,
  calcMatchAverages,
  getRestDays:      _coreRestDays,
  PL_ACCESSORS,
  FD_ACCESSORS,
} = require('./core/footballEngine');

// ─── Supabase ─────────────────────────────────────────────────────────────────
// Primary persistence layer. Falls back to local JSON files when env vars are
// missing (local dev without a Supabase project).

const { createClient } = require('@supabase/supabase-js');
const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  : null;

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
    'mailto:admin@matchiq.app',
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
// All caching goes through core/cache/cacheManager (unified TTL, invalidation,
// health stats, and file-persistence helpers).

function setCache(key, value, ttlMs) { cache.set(key, value, ttlMs); }
function getCache(key)               { return cache.get(key); }

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

// TTL imported from core/state/modelState — single source of truth.

// ─── Prediction history ───────────────────────────────────────────────────────

const HISTORY_FILE = path.join(__dirname, 'prediction-history.json');

async function loadHistory() {
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from('prediction_history')
        .select('data')
        .eq('season', getCurrentSeason())
        .maybeSingle();
      if (!error && data) return data.data;
    } catch (err) { console.warn('[Supabase loadHistory]', err.message); }
  }
  // File fallback (local dev)
  try {
    if (fs.existsSync(HISTORY_FILE)) return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
  } catch {}
  return { season: getCurrentSeason(), predictions: [] };
}

function saveHistory(data) {
  if (supabase) {
    supabase
      .from('prediction_history')
      .upsert({ season: data.season, data, updated_at: new Date().toISOString() }, { onConflict: 'season' })
      .then(({ error }) => { if (error) console.warn('[Supabase saveHistory]', error.message); });
    return;
  }
  // File fallback (local dev)
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(data, null, 2));
}

function getCurrentSeason() {
  const now = new Date();
  const year = now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
  return `${year}-${String(year + 1).slice(2)}`;
}

// Initialised with a safe default; overwritten in app.listen once Supabase resolves
let history = { season: getCurrentSeason(), predictions: [] };

// ─── Market movement history ──────────────────────────────────────────────────

const MARKET_HISTORY_FILE = path.join(__dirname, 'market-history.json');

async function loadMarketHistory() {
  if (supabase) {
    try {
      const { data, error } = await supabase.from('market_history').select('fixture_id, snapshots');
      if (!error && data) {
        const mh = {};
        for (const row of data) mh[row.fixture_id] = row.snapshots;
        return mh;
      }
    } catch (err) { console.warn('[Supabase loadMarketHistory]', err.message); }
  }
  try {
    if (fs.existsSync(MARKET_HISTORY_FILE)) return JSON.parse(fs.readFileSync(MARKET_HISTORY_FILE, 'utf-8'));
  } catch {}
  return {};
}

async function saveMarketSnapshot(fixtureId, odds) {
  const key = String(fixtureId);
  const snapshot = { timestamp: new Date().toISOString(), home: odds.home, draw: odds.draw, away: odds.away };

  if (supabase) {
    try {
      // Load just this fixture's snapshots
      const { data } = await supabase.from('market_history').select('snapshots').eq('fixture_id', key).maybeSingle();
      let snapshots = data?.snapshots ?? [];
      snapshots.push(snapshot);
      if (snapshots.length > 10) snapshots = snapshots.slice(-10);
      supabase
        .from('market_history')
        .upsert({ fixture_id: key, snapshots, updated_at: new Date().toISOString() }, { onConflict: 'fixture_id' })
        .then(({ error }) => { if (error) console.warn('[Supabase saveMarketSnapshot]', error.message); });
    } catch (err) { console.warn('[Supabase saveMarketSnapshot]', err.message); }
    return;
  }
  // File fallback (local dev)
  try {
    const mh = fs.existsSync(MARKET_HISTORY_FILE) ? JSON.parse(fs.readFileSync(MARKET_HISTORY_FILE, 'utf-8')) : {};
    if (!mh[key]) mh[key] = [];
    mh[key].push(snapshot);
    if (mh[key].length > 10) mh[key] = mh[key].slice(-10);
    fs.writeFileSync(MARKET_HISTORY_FILE, JSON.stringify(mh, null, 2));
  } catch {}
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

// ─── Understat xG — non-PL leagues ───────────────────────────────────────────
// Maps leagueId → Understat league slug (used in the API URL)
const UNDERSTAT_LEAGUE_SLUG = {
  'la-liga':    'La_liga',
  'bundesliga': 'Bundesliga',
  'ligue-1':    'Ligue_1',
  'serie-a':    'Serie_A',
};

// Maps FD full team name → Understat team title for each league.
// Only entries that differ are listed; identical names fall through to direct lookup.
const FD_TO_UNDERSTAT_NAME = {
  'la-liga': {
    'Real Madrid CF':              'Real Madrid',
    'FC Barcelona':                'Barcelona',
    'Club Atlético de Madrid':     'Atletico Madrid',
    'Sevilla FC':                  'Sevilla',
    'Valencia CF':                 'Valencia',
    'Real Betis Balompié':         'Real Betis',
    'Villarreal CF':               'Villarreal',
    'RC Celta de Vigo':            'Celta Vigo',
    'Getafe CF':                   'Getafe',
    'CA Osasuna':                  'Osasuna',
    'Rayo Vallecano de Madrid':    'Rayo Vallecano',
    'RCD Mallorca':                'Mallorca',
    'Girona FC':                   'Girona',
    'UD Las Palmas':               'Las Palmas',
    'Deportivo Alavés':            'Alaves',
    'Real Valladolid CF':          'Valladolid',
    'RCD Espanyol de Barcelona':   'Espanyol',
    'CD Leganés':                  'Leganes',
  },
  'bundesliga': {
    'FC Bayern München':           'Bayern Munich',
    'Bayer 04 Leverkusen':         'Bayer Leverkusen',
    '1. FC Union Berlin':          'Union Berlin',
    'Sport-Club Freiburg':         'Freiburg',
    'VfL Wolfsburg':               'Wolfsburg',
    'Borussia Mönchengladbach':    "Borussia M'gladbach",
    '1. FSV Mainz 05':             'Mainz 05',
    'FC Augsburg':                 'Augsburg',
    'VfL Bochum 1848':             'Bochum',
    'SV Werder Bremen':            'Werder Bremen',
    'VfB Stuttgart':               'Stuttgart',
    '1. FC Köln':                  'Koln',
    'TSG 1899 Hoffenheim':         'Hoffenheim',
    '1. FC Heidenheim 1846':       'Heidenheim',
    'SV Darmstadt 98':             'Darmstadt',
    'FC St. Pauli 1910':           'St. Pauli',
  },
  'ligue-1': {
    'Paris Saint-Germain FC':      'Paris Saint-Germain',
    'AS Monaco FC':                'Monaco',
    'LOSC Lille':                  'Lille',
    'Olympique Lyonnais':          'Lyon',
    'Stade Rennais FC 1901':       'Rennes',
    'RC Lens':                     'Lens',
    'RC Strasbourg Alsace':        'Strasbourg',
    'Olympique de Marseille':      'Marseille',
    'OGC Nice':                    'Nice',
    'Montpellier HSC':             'Montpellier',
    'FC Nantes':                   'Nantes',
    'Stade de Reims':              'Reims',
    'Toulouse FC':                 'Toulouse',
    'Clermont Foot 63':            'Clermont Foot',
    'FC Lorient':                  'Lorient',
    'FC Metz':                     'Metz',
    'Le Havre AC':                 'Le Havre',
    'Stade Brestois 29':           'Brest',
    'AJ Auxerre':                  'Auxerre',
    'Angers SCO':                  'Angers',
    'AS Saint-Étienne':            'Saint-Etienne',
  },
  'serie-a': {
    'Juventus FC':                 'Juventus',
    'FC Internazionale Milano':    'Inter',
    'AS Roma':                     'Roma',
    'SSC Napoli':                  'Napoli',
    'SS Lazio':                    'Lazio',
    'Atalanta BC':                 'Atalanta',
    'ACF Fiorentina':              'Fiorentina',
    'Torino FC':                   'Torino',
    'Bologna FC 1909':             'Bologna',
    'Udinese Calcio':              'Udinese',
    'UC Sampdoria':                'Sampdoria',
    'Empoli FC':                   'Empoli',
    'US Sassuolo Calcio':          'Sassuolo',
    'AC Monza':                    'Monza',
    'US Lecce':                    'Lecce',
    'Hellas Verona FC':            'Verona',
    'Cagliari Calcio':             'Cagliari',
    'Genoa CFC':                   'Genoa',
    'Como 1907':                   'Como',
    'Venezia FC':                  'Venezia',
    'Parma Calcio 1913':           'Parma',
    'US Cremonese':                'Cremonese',
    'Spezia Calcio':               'Spezia',
    'US Salernitana 1919':         'Salernitana',
    'Frosinone Calcio':            'Frosinone',
  },
};

// Identical scraping + decay logic as fetchUnderstatXG(), parameterised by league.
// Returns xgMap keyed by Understat team title (e.g. "Inter", "Real Madrid").
// Falls back to {} on error so predictions degrade gracefully to rolling ratings.
async function fetchUnderstatXGForLeague(leagueId) {
  const slug = UNDERSTAT_LEAGUE_SLUG[leagueId];
  if (!slug) return {};

  const cacheKey = `understat_xg_${leagueId}`;
  const cached   = getCache(cacheKey);
  if (cached) return cached;

  try {
    const year = new Date().getMonth() >= 6 ? new Date().getFullYear() : new Date().getFullYear() - 1;
    const res  = await withRetry(
      () => axios.get(`https://understat.com/getLeagueData/${slug}/${year}`, {
        timeout: 15000,
        headers: {
          'User-Agent':        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept':            'application/json, text/javascript, */*; q=0.01',
          'Referer':           `https://understat.com/league/${slug}/${year}`,
          'X-Requested-With':  'XMLHttpRequest',
        },
      }),
      { maxAttempts: 2, label: `Understat xG ${leagueId}` }
    );

    const raw = res.data?.teams;
    if (!raw || typeof raw !== 'object' || Object.keys(raw).length === 0) {
      throw new Error(`Understat returned no teams data for ${slug}`);
    }

    const xgMap   = {};
    const XG_DECAY = 0.92;

    for (const [, team] of Object.entries(raw)) {
      const history = team.history ?? [];
      const n = history.length;

      let homeXG = 0, awayXG = 0, homeXGA = 0, awayXGA = 0;
      let homeW  = 0, awayW  = 0;
      let totalXG = 0, totalXGA = 0, totalW = 0;

      for (let i = 0; i < n; i++) {
        const g       = history[i];
        const w       = Math.pow(XG_DECAY, n - 1 - i);
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
        homeXG:    safe(homeW  ? homeXG  / homeW  : totalW ? totalXG  / totalW : 0),
        awayXG:    safe(awayW  ? awayXG  / awayW  : totalW ? totalXG  / totalW : 0),
        homeXGA:   safe(homeW  ? homeXGA / homeW  : totalW ? totalXGA / totalW : 0),
        awayXGA:   safe(awayW  ? awayXGA / awayW  : totalW ? totalXGA / totalW : 0),
        seasonXG:  safe(totalW ? totalXG  / totalW : 0),
        seasonXGA: safe(totalW ? totalXGA / totalW : 0),
        games:     n,
      };
    }

    setCache(cacheKey, xgMap, TTL.XG);
    console.log(`[Understat ${leagueId}] Loaded xG for ${Object.keys(xgMap).length} teams`);
    return xgMap;
  } catch (err) {
    console.warn(`[Understat ${leagueId}] Failed — predictions will use rolling ratings:`, err.message);
    return {};
  }
}

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

    // Odds API → FPL team name mapping (Odds API uses full official names)
    const ODDS_TO_FPL = {
      'Tottenham Hotspur': 'Spurs',
      'Manchester City':   'Man City',
      'Manchester United': 'Man Utd',
      'Newcastle United':  'Newcastle',
      'West Ham United':   'West Ham',
      'Wolverhampton Wanderers': 'Wolves',
      'Nottingham Forest': "Nott'm Forest",
      'Brighton and Hove Albion': 'Brighton',
      'Leicester City':    'Leicester',
      'Leeds United':      'Leeds',
      'Aston Villa':       'Aston Villa',
      'AFC Bournemouth':   'Bournemouth',
      'Ipswich Town':      'Ipswich',
    };
    const normTeam = name => ODDS_TO_FPL[name] ?? name;

    const oddsMap = {};
    for (const game of (res.data ?? [])) {
      const book = game.bookmakers?.[0];
      if (!book) continue;
      const h2h = book.markets?.find(m => m.key === 'h2h');
      if (!h2h) continue;

      const homeOut  = h2h.outcomes.find(o => o.name === game.home_team);
      const awayOut  = h2h.outcomes.find(o => o.name === game.away_team);
      const drawOut  = h2h.outcomes.find(o => o.name === 'Draw');

      // Key uses FPL names so it matches the lookup in buildPrediction
      const gameKey = `${normTeam(game.home_team)}_${normTeam(game.away_team)}`;
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

async function fetchH2H(opponentName, myTeamName = 'Chelsea FC') {
  const cacheKey = `h2h_${myTeamName}_${opponentName}`;
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
              (m.team1 === myTeamName && m.team2 === opponentName) ||
              (m.team2 === myTeamName && m.team1 === opponentName)
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

// buildFormData — now delegates to core buildFormStats with PL accessors.
// Output shape is unchanged.
async function buildFormData(fixtures, teams, _chelseaId) {
  const teamIds = teams.map(t => t.id);
  return buildFormStats(fixtures, teamIds, PL_ACCESSORS, FORM_WEIGHTS);
}

// ─── League average goals ─────────────────────────────────────────────────────

// calcLeagueAverages — now delegates to core with PL accessors.
function calcLeagueAverages(fixtures) {
  return calcMatchAverages(fixtures, PL_ACCESSORS);
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

// ─── Rest days helper ─────────────────────────────────────────────────────────
// Returns the number of calendar days between a team's most recent finished
// fixture and the kickoff of the next one. Returns null if no prior game found.

// getRestDays / getFdRestDays — both now delegate to core with their respective accessors.
function getRestDays(teamId, kickoffTime, allFixtures) {
  return _coreRestDays(teamId, kickoffTime, allFixtures, PL_ACCESSORS);
}

function getFdRestDays(teamId, kickoffTime, allMatches) {
  return _coreRestDays(teamId, kickoffTime, allMatches, FD_ACCESSORS);
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
    // teamCode defaults to Chelsea (8) for backward compat; clients pass ?teamCode=X for other teams
    const teamCode = Number(req.query.teamCode) || CHELSEA_CODE;
    const isChelsea = teamCode === CHELSEA_CODE;

    const [[bs, fixtures], sofaEvents] = await Promise.all([
      Promise.all([fetchBootstrap(), fetchFixtures()]),
      isChelsea ? fetchSofaScoreNextFixtures() : Promise.resolve([]),
    ]);
    const { teams, events } = bs;
    const teamId = (teams.find(t => t.code === teamCode))?.id;

    const plUpcoming = fixtures
      .filter(f => !f.finished && (f.team_h === teamId || f.team_a === teamId))
      .sort((a, b) => new Date(a.kickoff_time) - new Date(b.kickoff_time))
      .slice(0, 10)
      .map(f => ({ ...enrichFixture(f, teams, events), competition: 'Premier League', isCup: false }));

    // SofaScore cup fixtures — only available for Chelsea right now
    const cupFixtures = isChelsea ? sofaEvents
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
      }) : [];

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

// ─── Route: GET /api/all-fixtures ────────────────────────────────────────────
// All upcoming PL fixtures (not Chelsea-specific). Used by the team-agnostic
// Fixtures page — returns every game sorted by kickoff time.

app.get('/api/all-fixtures', async (req, res) => {
  try {
    const [bs, fixtures] = await Promise.all([fetchBootstrap(), fetchFixtures()]);
    const { teams, events } = bs;
    const upcoming = fixtures
      .filter(f => !f.finished)
      .sort((a, b) => new Date(a.kickoff_time) - new Date(b.kickoff_time))
      .map(f => ({ ...enrichFixture(f, teams, events), isCup: false }));
    res.json(upcoming);
  } catch (err) {
    console.error('[/api/all-fixtures]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Route: GET /api/results ──────────────────────────────────────────────────

app.get('/api/results', async (req, res) => {
  try {
    const teamCode = Number(req.query.teamCode) || CHELSEA_CODE;
    const [bs, fixtures] = await Promise.all([fetchBootstrap(), fetchFixtures()]);
    const { teams, events } = bs;
    const teamId = (teams.find(t => t.code === teamCode))?.id;

    const results = fixtures
      .filter(f => f.finished && (f.team_h === teamId || f.team_a === teamId))
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

// ─── Route: GET /api/team-form?teamId=<id> ───────────────────────────────────
// Returns last-5 results (recentResults) for any team — used by FormChart.

app.get('/api/team-form', async (req, res) => {
  try {
    const teamId = Number(req.query.teamId);
    if (!teamId) return res.status(400).json({ error: 'teamId query param required' });
    const [bs, fixtures] = await Promise.all([fetchBootstrap(), fetchFixtures()]);
    const formData = await buildFormData(fixtures, bs.teams, null);
    const form = formData[teamId];
    if (!form) return res.status(404).json({ error: 'Team not found' });
    res.json({
      recentResults: form.recentResults ?? [],
      // Include W/D/L summary
      record: (() => {
        const r = form.recentResults ?? [];
        return r.map(({ homeGoals, awayGoals }) =>
          homeGoals > awayGoals ? 'W' : homeGoals === awayGoals ? 'D' : 'L'
        ).join('');
      })(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Route: GET /api/lineup?fixtureId=<id> ───────────────────────────────────
// Returns predicted lineup for SofaScore-sourced cup fixtures.
// FPL numeric fixtures have no lineup data — returns { available: false }.

app.get('/api/lineup', async (req, res) => {
  try {
    const { fixtureId } = req.query;
    if (!fixtureId) return res.status(400).json({ error: 'fixtureId required' });

    // Only SofaScore fixtures carry lineup data
    if (!String(fixtureId).startsWith('sofa_')) {
      return res.json({ available: false });
    }

    const eventId  = String(fixtureId).replace('sofa_', '');
    const lineupData = await fetchSofaScoreLineup(eventId);
    if (!lineupData?.home || !lineupData?.away) return res.json({ available: false });

    const parseLineup = (side) => {
      const formation = side.formation ?? '4-3-3';
      const players   = {};
      (side.players ?? []).forEach(p => {
        const pos = p.position ?? p.player?.position ?? '';
        if (pos) players[pos.toUpperCase()] = p.player?.shortName ?? p.player?.name ?? '';
      });
      return { formation, players };
    };

    res.json({
      available: true,
      home: parseLineup(lineupData.home),
      away: parseLineup(lineupData.away),
    });
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

// Legacy alias — kept for backward compat; prefer /api/team-stats?teamCode=8
app.get('/api/chelsea-stats', async (req, res) => {
  req.query.teamCode = req.query.teamCode || String(CHELSEA_CODE);
  return teamStatsHandler(req, res);
});

// ─── Route: GET /api/team-stats?teamCode=<code> ───────────────────────────────

async function teamStatsHandler(req, res) {
  try {
    const teamCode = Number(req.query.teamCode) || CHELSEA_CODE;
    const [bs, fixtures] = await Promise.all([fetchBootstrap(), fetchFixtures()]);
    const { teams, elements } = bs;
    const teamId   = (teams.find(t => t.code === teamCode))?.id;
    const finished = fixtures.filter(f => f.finished && (f.team_h === teamId || f.team_a === teamId));

    let won = 0, drawn = 0, lost = 0, gf = 0, ga = 0;
    let homeWon = 0, homeDrawn = 0, homeLost = 0;
    let awayWon = 0, awayDrawn = 0, awayLost = 0;

    for (const f of finished) {
      const isHome = f.team_h === teamId;
      const cg     = isHome ? f.team_h_score : f.team_a_score;
      const og     = isHome ? f.team_a_score : f.team_h_score;
      gf += cg; ga += og;
      if (cg > og)        { won++;   isHome ? homeWon++   : awayWon++;   }
      else if (cg === og) { drawn++; isHome ? homeDrawn++ : awayDrawn++; }
      else                { lost++;  isHome ? homeLost++  : awayLost++;  }
    }

    const squad = (elements ?? [])
      .filter(p => p.team === teamId)
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
}

app.get('/api/team-stats', teamStatsHandler);

// ─── Route: GET /api/injuries ─────────────────────────────────────────────────

app.get('/api/injuries', async (req, res) => {
  try {
    const teamCode  = Number(req.query.teamCode) || CHELSEA_CODE;
    const bs        = await fetchBootstrap();
    const teamId    = (bs.teams.find(t => t.code === teamCode))?.id;
    const injuries  = await getChelseaInjuries(teamId);
    res.json(injuries);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Route: GET /api/h2h/:opponentId ─────────────────────────────────────────

app.get('/api/h2h/:opponentId', async (req, res) => {
  try {
    const teamCode = Number(req.query.teamCode) || CHELSEA_CODE;
    const bs = await fetchBootstrap();
    const opponent = bs.teams.find(t => t.id === Number(req.params.opponentId));
    if (!opponent) return res.status(404).json({ error: 'Team not found' });
    const myTeam = bs.teams.find(t => t.code === teamCode);
    const myTeamName = myTeam?.name ?? 'Chelsea FC';

    const h2h = await fetchH2H(opponent.name, myTeamName);
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
      saveMarketSnapshot(fix.id, odds); // fire-and-forget async
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

    const homeRestDays = getRestDays(homeTeam.id, fix.kickoff_time, allFixtures);
    const awayRestDays = getRestDays(awayTeam.id, fix.kickoff_time, allFixtures);
    const teamHomeAdvFactors = buildTeamHomeAdvantage(allFixtures);
    const teamHomeAdvFactor  = teamHomeAdvFactors[String(homeTeam.id)] ?? 1.0;

    prediction = predict({
      homeTeam:      { id: homeTeam.id, name: homeTeam.name },
      awayTeam:      { id: awayTeam.id, name: awayTeam.name },
      leagueAvgHome: leagueAvg.home,
      leagueAvgAway: leagueAvg.away,
      xGData,
      formData,
      h2hData,
      marketOdds,
      homeInjuries:     homeInj,
      awayInjuries:     awayInj,
      rollingRatings,
      eloRatings,
      homeRestDays,
      awayRestDays,
      teamHomeAdvFactor,
      refereeData: refStats
        ? { yellowsPerGame: refStats.yellowsPerGame, leagueAvgYellows: avgYellows }
        : null,
    });

    const immediateResult = isFixtureSettled(fix)
      ? { homeGoals: fix.team_h_score, awayGoals: fix.team_a_score, settledAt: new Date().toISOString() }
      : null;

    history.predictions.push({
      fixtureId:  fix.id,
      league:     'premier-league',
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

      // Build roster lists for cup fixture too
      function cupSquadRoster(teamData, elements) {
        if (!teamData) return 'Squad data unavailable';
        const players = (elements ?? [])
          .filter(pl => pl.team === teamData.id && pl.element_type !== 1)
          .sort((a, b) => b.minutes - a.minutes)
          .slice(0, 11);
        return players.map(pl => {
          let s = `${pl.first_name} ${pl.second_name}`;
          if (pl.goals_scored > 0) s += ` (${pl.goals_scored}G)`;
          if (pl.status === 'i') s += ' ⚠️ INJURED';
          if (pl.status === 'd') s += ' ⚠️ DOUBTFUL';
          return s;
        }).join(', ');
      }

      const homeRoster = cupSquadRoster(homeTeamData, elements);
      const awayRoster = cupSquadRoster(awayTeamData, elements);

      const systemPrompt = `You are an elite football analyst. Write sharp, engaging pre-match analysis for cup finals — the quality of The Athletic.
Use **bold** for player names and key stats. 3 paragraphs: form & stakes → key tactical battle → ones to watch & what each side needs. Under 420 words.
ABSOLUTE RULES: (1) ONLY name players from the roster lists provided — never guess at squad members. (2) No score predictions or percentages. (3) No filler phrases. Be specific.`;

      const userPrompt = `Pre-match report: **${competition}** — ${homeName} vs ${awayName}.

${teamBlock(homeName, homeStats)}
${homeName} current players (ONLY name from this list): ${homeRoster}

${teamBlock(awayName, awayStats)}
${awayName} current players (ONLY name from this list): ${awayRoster}

${h2hText}

Write the report now. No headline needed.`;

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

    // Build current squad lists from live FPL data so the LLM can't hallucinate
    // transferred-away players (e.g. Mason Mount).
    const { elements: allPlayers } = bs;

    function squadSummary(teamId, teamName) {
      const players = allPlayers.filter(pl => pl.team === teamId);

      // Key contributors: sort by minutes played this season, take top 11
      const outfield = players
        .filter(pl => pl.element_type !== 1) // exclude keepers from name-drop pool
        .sort((a, b) => b.minutes - a.minutes)
        .slice(0, 11);

      // Compose a readable line per player
      const lines = outfield.map(pl => {
        const parts = [`${pl.first_name} ${pl.second_name} (${pl.minutes} mins`];
        if (pl.goals_scored > 0)  parts[0] += `, ${pl.goals_scored}G`;
        if (pl.assists > 0)       parts[0] += `, ${pl.assists}A`;
        parts[0] += ')';
        if (pl.status === 'i')    parts[0] += ' ⚠️ INJURED';
        if (pl.status === 'd')    parts[0] += ' ⚠️ DOUBTFUL';
        return parts[0];
      });

      // Also surface top scorer separately in case they have low minutes
      const topScorer = [...players].sort((a, b) => b.goals_scored - a.goals_scored)[0];

      return {
        roster: lines.join('\n  '),
        topScorerName: topScorer ? `${topScorer.first_name} ${topScorer.second_name}` : null,
        topScorerGoals: topScorer?.goals_scored ?? 0,
        injuries: players
          .filter(pl => (pl.status === 'i' || pl.status === 'd') && (pl.chance_of_playing_next_round ?? 100) < 75)
          .map(pl => `${pl.first_name} ${pl.second_name}`)
          .slice(0, 4),
      };
    }

    const homeSquad = squadSummary(fix.team_h, homeTeam.name);
    const awaySquad = squadSummary(fix.team_a, awayTeam.name);

    const systemPrompt = `You are an elite Premier League tactical analyst specialising in ${homeTeam.name} vs ${awayTeam.name}.
Write sharp, insightful, punchy pre-match reports — the kind you'd find on The Athletic.
Use **bold** for player names and key stats. Structure: 3 focused paragraphs (form & context → key tactical battle → ones to watch & verdict). Under 380 words.

ABSOLUTE RULES — failure on any of these makes the report useless:
1. NEVER name a player who is not on the roster list provided. If you don't see their name, they are NOT at the club. Do not guess.
2. Do NOT produce your own score predictions, scorelines, or win/draw/loss percentages — those are already calculated by the model.
3. Do NOT use filler phrases like "in conclusion", "it promises to be", "a fascinating encounter", or "all to play for".
4. Be specific. Reference actual stats from the data provided — minutes, goals, assists, form letters.`;

    const userPrompt = `Pre-match report: **${homeTeam.name} vs ${awayTeam.name}**

── MODEL OUTPUTS (reference these, do not re-derive) ──
Home win ${(p.homeWin * 100).toFixed(1)}% · Draw ${(p.draw * 100).toFixed(1)}% · Away win ${(p.awayWin * 100).toFixed(1)}%
Most likely score: ${p.predictedScore} (${(p.scoreProbability * 100).toFixed(1)}% probability)
xG model: ${homeTeam.name} ${p.lambdas.home.toFixed(2)} | ${awayTeam.name} ${p.lambdas.away.toFixed(2)}
${pred.odds ? `Market odds: ${pred.odds.home} / ${pred.odds.draw} / ${pred.odds.away}` : ''}

── ${homeTeam.name.toUpperCase()} CURRENT SQUAD (ONLY name players from this list) ──
  ${homeSquad.roster}
${homeSquad.injuries.length ? `Injury concerns: ${homeSquad.injuries.join(', ')}` : 'No major injury concerns'}

── ${awayTeam.name.toUpperCase()} CURRENT SQUAD (ONLY name players from this list) ──
  ${awaySquad.roster}
${awaySquad.injuries.length ? `Injury concerns: ${awaySquad.injuries.join(', ')}` : 'No major injury concerns'}

Write the report now. Paragraph 1: form and context. Paragraph 2: the key tactical battle. Paragraph 3: two players to watch (one from each side) and a concise verdict referencing the model's numbers. Do not add a headline.`;

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
    const teamId    = Number(req.query.teamId);
    const myTeamCode = Number(req.query.myTeamCode) || CHELSEA_CODE;
    if (!teamId) return res.status(400).json({ error: 'teamId required' });

    const cacheKey = `opp_${myTeamCode}_${teamId}`;
    const cached   = getCache(cacheKey);
    if (cached) return res.json(cached);

    const [bs, allFixtures] = await Promise.all([fetchBootstrap(), fetchFixtures()]);
    const { teams, elements } = bs;
    const team    = teams.find(t => t.id === teamId);
    const myTeam  = teams.find(t => t.code === myTeamCode);
    const myTeamName = myTeam?.name ?? 'Chelsea';
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

    // Build full roster so the LLM cannot hallucinate stale/transferred players
    const oppRoster = (elements ?? [])
      .filter(pl => pl.team === teamId && pl.element_type !== 1)
      .sort((a, b) => b.minutes - a.minutes)
      .slice(0, 11)
      .map(pl => {
        let s = `${pl.first_name} ${pl.second_name}`;
        if (pl.goals_scored > 0) s += ` (${pl.goals_scored}G)`;
        if (pl.assists > 0) s += ` (${pl.assists}A)`;
        if (pl.status === 'i') s += ' ⚠️ INJURED';
        if (pl.status === 'd') s += ' ⚠️ DOUBTFUL';
        return s;
      }).join(', ');

    const systemPrompt = `You are an elite Premier League scout writing for ${myTeamName}'s coaching staff. Be sharp, specific, and analytical — no fluff.
Use **bold** for key names and stats. Under 280 words.
ABSOLUTE RULE: ONLY name players from the roster list provided. Never invent or recall players who may have left the club. No scores, probabilities, or scorelines.`;
    const userPrompt   = `Scout report: ${team.name} as ${myTeamName}'s upcoming opponent.
Last 5 form: ${formStr}
Top scorer: ${topScorer ? `${topScorer.first_name} ${topScorer.second_name}` : 'Unknown'} (${topScorer?.goals_scored ?? 0} goals, ${topScorer?.assists ?? 0} assists)
Confirmed injuries/doubts: ${injuries.map(p => `${p.first_name} ${p.second_name}`).join(', ') || 'None reported'}

Current squad (ONLY name players from this list):
${oppRoster}

Cover in 3 tight paragraphs: (1) their attacking threat and key danger man, (2) defensive weaknesses ${myTeamName} can exploit, (3) set-piece danger, pressing triggers, and the one tactical battle that will decide the game.`;

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
    const league   = req.query.league || 'premier-league';
    const isPL     = league === 'premier-league';
    const cacheKey = `season_accuracy_${league}`;
    const cached   = getCache(cacheKey);
    if (cached) return res.json(cached);

    const completed = history.predictions.filter(p => {
      if (!p.result || !p.prediction || !p.gameweek) return false;
      if (isPL) return (p.gameweek > 1) && (!p.league || p.league === 'premier-league');
      return p.league === league;
    });
    const total = completed.length;
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

    setCache(cacheKey, result, TTL.ACCURACY);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Route: GET /api/performance-metrics ─────────────────────────────────────

app.get('/api/performance-metrics', async (req, res) => {
  try {
    const league = req.query.league || 'premier-league';
    const isPL   = league === 'premier-league';
    const completed = history.predictions.filter(p => {
      if (!p.result || !p.prediction || !p.gameweek) return false;
      if (isPL) return (p.gameweek > 1) && (!p.league || p.league === 'premier-league');
      return p.league === league;
    });
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
    const league = req.query.league || 'premier-league';
    const isPL   = league === 'premier-league';
    const valid  = history.predictions.filter(p => {
      if (!p.gameweek) return false;
      if (isPL) return (p.gameweek > 1) && (!p.league || p.league === 'premier-league');
      return p.league === league;
    });
    const result = bettingSimulator(valid, stake);
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
    const league = req.query.league || 'premier-league';
    const isPL   = league === 'premier-league';

    const filtered = history.predictions.filter(p =>
      isPL
        ? (!p.league || p.league === 'premier-league')
        : p.league === league
    );

    // For FD leagues, compute current matchday by finding the matchday whose
    // median kickoff date is closest to today. This handles postponed fixtures
    // (e.g. a rescheduled week 4 game appearing in the future) correctly —
    // the bulk of week 17 games will be closer to today than any stray outliers.
    if (!isPL) {
      let currentGW = null;
      const code = FD_CODE[league];
      if (code) {
        try {
          const allMatches = await getFdMatches(code);
          const now = Date.now();

          // Group matches by matchday, collect median kickoff timestamp per MD
          const mdMap = new Map();
          for (const m of allMatches) {
            if (!m.matchday || !m.kickoffTime) continue;
            if (!mdMap.has(m.matchday)) mdMap.set(m.matchday, []);
            mdMap.get(m.matchday).push(new Date(m.kickoffTime).getTime());
          }

          // For each matchday compute the median kickoff date
          let closest = Infinity;
          for (const [md, times] of mdMap) {
            times.sort((a, b) => a - b);
            const median = times[Math.floor(times.length / 2)];
            const dist   = Math.abs(median - now);
            if (dist < closest) { closest = dist; currentGW = md; }
          }
        } catch { /* leave null */ }
      }
      return res.json({ predictions: filtered.slice().reverse(), currentGW });
    }

    const bootstrap = await fetchBootstrap();
    const currentGW = bootstrap?.events?.find(e => e.is_current)?.id
      ?? bootstrap?.events?.find(e => e.is_next)?.id
      ?? null;
    res.json({ predictions: filtered.slice().reverse(), currentGW });
  } catch {
    const league   = req.query.league || 'premier-league';
    const filtered = history.predictions.filter(p =>
      league === 'premier-league'
        ? (!p.league || p.league === 'premier-league')
        : p.league === league
    );
    res.json({ predictions: filtered.slice().reverse(), currentGW: null });
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
app.get('/api/seasons', async (req, res) => {
  try {
    const current = getCurrentSeason();
    let seasons = [current];

    if (supabase) {
      // Query all seasons stored in Supabase
      const { data, error } = await supabase.from('prediction_history').select('season');
      if (!error && data) {
        seasons = [...new Set([current, ...data.map(r => r.season)])];
      }
    } else {
      // File fallback: scan local archived JSON files
      const archiveRe = /^prediction-history-(.+)\.json$/;
      const archived = fs.readdirSync(__dirname)
        .map(f => f.match(archiveRe)?.[1])
        .filter(Boolean);
      seasons = [...new Set([current, ...archived])];
    }

    const all = seasons.sort().reverse();
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

app.get('/api/market-movement/:fixtureId', async (req, res) => {
  try {
    const fixtureId = Number(req.params.fixtureId);
    const mh = await loadMarketHistory();
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
    // ── Premier League: fill from FPL API ──────────────────────────────────────
    const allFixtures  = await fetchFixtures();
    const plUnresolved = history.predictions.filter(
      p => !p.result && (!p.league || p.league === 'premier-league')
    );

    for (const entry of plUnresolved) {
      const fix = allFixtures.find(f => f.id === entry.fixtureId);
      if (isFixtureSettled(fix)) {
        entry.result = {
          homeGoals:  fix.team_h_score,
          awayGoals:  fix.team_a_score,
          settledAt:  new Date().toISOString(),
        };
        if (fix.kickoff_time) entry.kickoff = fix.kickoff_time;
      }
    }

    // ── FD leagues: fill from in-memory match cache (no extra API calls) ───────
    const fdUnresolved = history.predictions.filter(
      p => !p.result && p.league && p.league !== 'premier-league'
    );

    // Group by competition code so we only look up each cache once
    const byCode = {};
    for (const entry of fdUnresolved) {
      const code = FD_CODE[entry.league];
      if (!code) continue;
      (byCode[code] = byCode[code] ?? []).push(entry);
    }

    for (const [code, entries] of Object.entries(byCode)) {
      const cached = getCache(`fd_matches_${code}`);
      if (!cached) continue;   // skip if cache cold — next cron cycle will catch it
      for (const entry of entries) {
        const match = cached.find(m => m.id === entry.fixtureId);
        if (match?.finished && match.homeGoals != null) {
          entry.result = {
            homeGoals: match.homeGoals,
            awayGoals: match.awayGoals,
            settledAt: new Date().toISOString(),
          };
        }
      }
    }

    saveHistory(history);
  } catch (err) {
    console.warn('[Auto-fill results]', err.message);
  }
}

// ─── Background: proactive FD results backfill ───────────────────────────────
// Runs every hour (staggered 30 min from the PL cron).
// Unlike the FD section inside autoFillResults (which only reads cache), this
// function actively fetches fresh match data from football-data.org so that
// pending predictions get results filled even when the cache is cold.

async function autoFillFdResults() {
  try {
    const fdUnresolved = history.predictions.filter(
      p => !p.result && p.league && p.league !== 'premier-league'
    );
    if (!fdUnresolved.length) return;

    // Determine which codes we actually need
    const codes = [...new Set(
      fdUnresolved.map(p => FD_CODE[p.league]).filter(Boolean)
    )];

    // Fetch all in parallel — getFdMatches uses cache + in-flight dedup
    const results = await Promise.all(codes.map(code => getFdMatches(code).catch(() => null)));
    const matchesByCode = Object.fromEntries(
      codes.map((code, i) => [code, results[i] ?? []])
    );

    let filled = 0;
    for (const entry of fdUnresolved) {
      const code = FD_CODE[entry.league];
      if (!code) continue;
      const match = matchesByCode[code].find(m => m.id === entry.fixtureId);
      if (match?.finished && match.homeGoals != null) {
        entry.result = {
          homeGoals:  match.homeGoals,
          awayGoals:  match.awayGoals,
          settledAt:  new Date().toISOString(),
        };
        filled++;
      }
    }

    if (filled) {
      saveHistory(history);
      console.log(`[autoFillFdResults] filled ${filled} pending prediction(s)`);
    }
  } catch (err) {
    console.warn('[autoFillFdResults]', err.message);
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
    // Archive old season — to disk only in local dev (Supabase already has it by season key)
    if (!supabase) {
      const archivePath = path.join(__dirname, `prediction-history-${oldSeason}.json`);
      try { fs.writeFileSync(archivePath, JSON.stringify(history, null, 2)); } catch {}
    }
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

// ─── World Cup 2026 ───────────────────────────────────────────────────────────

// FIFA_STRENGTH imported from core/config/footballConfig.

function wcStrength(name) {
  // Prefer live ELO built from martj42 results; fall back to hardcoded FIFA ratings
  if (_dynamicElo) {
    // Direct match (martj42 spelling)
    const alias = toMartj42(name);
    if (_dynamicElo[alias] != null) return _dynamicElo[alias];
    if (_dynamicElo[name]  != null) return _dynamicElo[name];
    // Fuzzy match
    const key = Object.keys(_dynamicElo).find(k =>
      k.toLowerCase() === name.toLowerCase() ||
      name.toLowerCase().includes(k.toLowerCase()) ||
      k.toLowerCase().includes(name.toLowerCase())
    );
    if (key) return _dynamicElo[key];
  }
  // Hardcoded fallback
  if (FIFA_STRENGTH[name]) return FIFA_STRENGTH[name];
  const key = Object.keys(FIFA_STRENGTH).find(k =>
    k.toLowerCase() === name.toLowerCase() ||
    name.toLowerCase().includes(k.toLowerCase()) ||
    k.toLowerCase().includes(name.toLowerCase())
  );
  return key ? FIFA_STRENGTH[key] : 1500;
}

// ─── WC model helpers ─────────────────────────────────────────────────────────

// Host nations — play in front of home crowds, get a lambda boost
// WC_HOST_NATIONS imported from core/config/footballConfig.

// WC_CONFEDERATION imported from core/config/footballConfig.

// CONFED_LAMBDA_FACTOR imported from core/config/footballConfig.

function confedFactor(team) {
  const c = WC_CONFEDERATION[team] ?? WC_CONFEDERATION[toMartj42(team)] ?? 'UEFA';
  return CONFED_LAMBDA_FACTOR[c] ?? 1.0;
}

function isHostNation(team) {
  return WC_HOST_NATIONS.has(team) || WC_HOST_NATIONS.has(toMartj42(team));
}

// poissonPMF now sourced from core — single implementation across all pipelines.
const poissonPMF = _corePoissonPMF;

// Compute adjusted attack lambdas for a matchup — shared by wcPoisson and Monte Carlo
function wcLambdas(homeTeam, awayTeam) {
  const BASE = 1.30;
  const hStr = wcStrength(homeTeam);
  const aStr = wcStrength(awayTeam);
  const diff = (hStr - aStr) / 400;

  // Scale of 0.88 — balances realistic score variety with tournament win spread.
  // 1.1 gave Spain 34% to win the tournament (too high).
  // 0.75 compressed lambdas so all matches predicted 1-1 (too low).
  // 0.88 gives Spain ~22% and realistic score differentiation between groups.
  let lH = Math.max(0.3, BASE * Math.exp( diff * 0.88));
  let lA = Math.max(0.3, BASE * Math.exp(-diff * 0.88));

  // Host nation boost (~0.2–0.3 extra goals historically)
  if (isHostNation(homeTeam)) lH = Math.min(lH * 1.18, lH + 0.22);
  if (isHostNation(awayTeam)) lA = Math.min(lA * 1.10, lA + 0.12);

  // Confederation calibration
  lH *= confedFactor(homeTeam);
  lA *= confedFactor(awayTeam);

  return { lH: Math.max(0.3, lH), lA: Math.max(0.3, lA) };
}

// H2H nudge — uses in-memory results synchronously (cache populated at startup)
// Returns a small ±value to add to homeWin probability
function h2hNudge(homeTeam, awayTeam) {
  if (!_intlResultsCache) return 0;
  const hAlias = toMartj42(homeTeam);
  const aAlias = toMartj42(awayTeam);
  const meetings = _intlResultsCache.filter(r =>
    (r.home === hAlias && r.away === aAlias) ||
    (r.home === aAlias && r.away === hAlias)
  );
  if (meetings.length < 5) return 0;
  let hW = 0, aW = 0;
  for (const m of meetings) {
    const hS = m.home === hAlias ? m.homeScore : m.awayScore;
    const aS = m.home === hAlias ? m.awayScore : m.homeScore;
    if (hS > aS) hW++; else if (aS > hS) aW++;
  }
  // Max nudge ±0.05 based on historical dominance
  return ((hW - aW) / meetings.length) * 0.08;
}

// Poisson prediction — matrix approach with Dixon-Coles correction (replaces Monte Carlo)
function wcPoisson(homeTeam, awayTeam) {
  const { lH, lA } = wcLambdas(homeTeam, awayTeam);

  // Dixon-Coles τ correlation (negative = slight positive correlation in low-scoring games)
  const RHO = -0.10;
  const MAX = 8;

  let hWin = 0, draw = 0, aWin = 0;
  const scores = {};

  for (let h = 0; h <= MAX; h++) {
    for (let a = 0; a <= MAX; a++) {
      let p = poissonPMF(h, lH) * poissonPMF(a, lA);
      // Dixon-Coles τ correction for low-scoring cells
      if      (h === 0 && a === 0) p *= 1 - lH * lA * RHO;
      else if (h === 1 && a === 0) p *= 1 + lA * RHO;
      else if (h === 0 && a === 1) p *= 1 + lH * RHO;
      else if (h === 1 && a === 1) p *= 1 - RHO;

      scores[`${h}-${a}`] = (scores[`${h}-${a}`] ?? 0) + p;
      if (h > a) hWin += p;
      else if (h < a) aWin += p;
      else draw += p;
    }
  }

  // Normalise (Dixon-Coles slightly perturbs total)
  const total = hWin + draw + aWin;
  hWin /= total; draw /= total; aWin /= total;

  // H2H nudge — small adjustment toward historically dominant side
  const nudge = h2hNudge(homeTeam, awayTeam);
  if (Math.abs(nudge) > 0.001) {
    hWin = Math.max(0.05, Math.min(0.90, hWin + nudge));
    aWin = Math.max(0.05, Math.min(0.90, aWin - nudge * 0.6));
    draw = Math.max(0.05, 1 - hWin - aWin);
  }

  // Hybrid predicted score:
  // - If one team has ≥37% win probability → conditional argmax (most likely score
  //   given that outcome), so moderate favourites (38-44%) show 1-0 / 2-1 rather
  //   than defaulting to 1-1. Threshold was 0.45 — too high, caused Germany vs
  //   Ecuador (44%) and Turkey vs USA (40%) to show 1-1 despite a clear favourite.
  // - Otherwise (genuine toss-up, both ≤37%) → unconditional matrix argmax, which
  //   naturally gives 1-1 for truly equal matchups. Preserves draw predictions.
  const sortedScores = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  let predictedScore;
  if (hWin >= 0.37 || aWin >= 0.37) {
    const outcome = hWin >= aWin ? 'home' : 'away';
    const filtered = sortedScores.filter(([s]) => {
      const [h, a] = s.split('-').map(Number);
      return outcome === 'home' ? h > a : a > h;
    });
    predictedScore = filtered.length > 0 ? filtered[0][0] : sortedScores[0][0];
  } else {
    predictedScore = sortedScores[0][0];
  }

  return {
    homeWin:        +hWin.toFixed(4),
    draw:           +draw.toFixed(4),
    awayWin:        +aWin.toFixed(4),
    lambdaHome:     +lH.toFixed(2),
    lambdaAway:     +lA.toFixed(2),
    predictedScore,
  };
}

// WC_GROUPS imported from core/config/footballConfig — single source of truth.

// WC_SCHEDULE imported from core/config/footballConfig — single source of truth.

// ESPN undocumented JSON endpoints — no key required
const ESPN_SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard';
const ESPN_STANDINGS  = 'https://site.api.espn.com/apis/v2/sports/soccer/fifa.world/standings';

async function fetchESPN(url, cacheKey) {
  const cached = getCache(cacheKey);
  if (cached) return cached;
  const res = await withRetry(
    () => axios.get(url, {
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    }),
    { label: `ESPN ${cacheKey}` }
  );
  setCache(cacheKey, res.data, 5 * 60 * 1000);
  return res.data;
}

// Parse ESPN scoreboard events into a normalised fixture list
function parseESPNFixtures(data) {
  const events = data?.events ?? [];
  return events.map(ev => {
    const comp       = ev.competitions?.[0] ?? {};
    const status     = comp.status ?? {};
    const stateStr   = status.type?.state ?? 'pre';        // 'pre' | 'in' | 'post'
    const detail     = status.type?.shortDetail ?? 'NS';   // 'FT', 'HT', '45+2', etc.
    const home       = comp.competitors?.find(c => c.homeAway === 'home');
    const away       = comp.competitors?.find(c => c.homeAway === 'away');
    const round      = comp.groups?.name ?? ev.season?.slug ?? '';

    return {
      id:       ev.id,
      date:     comp.date ?? ev.date,
      round,
      status:   stateStr,
      detail,
      teams: {
        home: { name: home?.team?.displayName ?? home?.team?.name ?? '?', id: home?.team?.id },
        away: { name: away?.team?.displayName ?? away?.team?.name ?? '?', id: away?.team?.id },
      },
      goals: {
        home: stateStr === 'post' ? Number(home?.score ?? 0) : null,
        away: stateStr === 'post' ? Number(away?.score ?? 0) : null,
      },
      _statusShort: stateStr === 'post' ? 'FT' : stateStr === 'in' ? 'LIVE' : 'NS',
    };
  });
}

// Parse ESPN standings into group rows
function parseESPNStandings(data) {
  const groups = {};
  const entries = data?.standings?.entries ?? data?.children?.flatMap(g =>
    (g.standings?.entries ?? []).map(e => ({ ...e, _groupName: g.name ?? g.abbreviation }))
  ) ?? [];

  for (const entry of entries) {
    const grpName = entry._groupName ?? entry.group?.name ?? 'Unknown';
    // Extract letter: "Group A" → "A"
    const letter = grpName.replace(/^group\s*/i, '').trim();
    if (!letter) continue;

    const stat = name => entry.stats?.find(s => s.name === name)?.value ?? 0;

    groups[letter] = groups[letter] ?? [];
    groups[letter].push({
      team:   entry.team?.displayName ?? entry.team?.name ?? '?',
      teamId: entry.team?.id,
      played: stat('gamesPlayed'),
      won:    stat('wins'),
      drawn:  stat('ties'),
      lost:   stat('losses'),
      gf:     stat('pointsFor'),
      ga:     stat('pointsAgainst'),
      gd:     stat('pointsFor') - stat('pointsAgainst'),
      points: stat('points'),
    });
  }
  return groups;
}

// Derive tournament phase from normalised fixture list
function wcTournamentPhase(fixtures) {
  if (!fixtures?.length) return 'PRE_TOURNAMENT';

  const byRound = {};
  for (const f of fixtures) {
    const r = (f.round ?? '').toLowerCase();
    byRound[r] = byRound[r] ?? [];
    byRound[r].push(f);
  }

  const allDone  = (key) => {
    const matches = Object.entries(byRound).filter(([k]) => k.includes(key));
    return matches.length > 0 && matches.every(([, fs]) => fs.every(f => f._statusShort === 'FT'));
  };
  const hasRound = (key) => Object.keys(byRound).some(k => k.includes(key));

  if (allDone('final') && !hasRound('semi'))  return 'COMPLETE';
  if (allDone('semi')  || hasRound('final'))  return 'FINAL';
  if (allDone('quarter') || hasRound('semi')) return 'SEMI_FINALS';
  if (allDone('round of 16') || hasRound('quarter')) return 'QUARTER_FINALS';
  if (allDone('round of 32') || hasRound('round of 16')) return 'ROUND_OF_16';
  if (allDone('group') || hasRound('round of 32')) return 'ROUND_OF_32';

  const anyStarted = Object.entries(byRound)
    .filter(([k]) => k.includes('group'))
    .some(([, fs]) => fs.some(f => f._statusShort !== 'NS'));

  return anyStarted ? 'GROUP_STAGE' : 'PRE_TOURNAMENT';
}

// Inject Poisson predictions onto upcoming fixtures
function enrichWithPredictions(fixtures) {
  return fixtures.map(f => {
    if (f._statusShort !== 'NS') return f;
    const home = f.teams?.home?.name;
    const away = f.teams?.away?.name;
    if (!home || !away) return f;
    return { ...f, _prediction: wcPoisson(home, away) };
  });
}

// ─── Monte Carlo full tournament simulation ───────────────────────────────────
// Returns per-team reach probabilities cached for 1hr.
// Keys: pAdvance, pR16, pQF, pSF, pFinal, pWinner
let _tournamentReachCache = null;
let _tournamentReachExpires = 0;
let _liveReachCache = null;       // separate cache for live-data runs
let _liveReachExpires = 0;

// liveGroups — optional: { 'A': [{ team, points, gd, gf, played }], ... }
// When provided, completed groups (all played=3) use actual standings
// deterministically instead of being re-simulated. Incomplete groups
// are still simulated from scratch. Odds update every 15 min during the
// tournament vs the 1hr pre-tournament cache.
function simulateTournamentReach(n = 10000, liveGroups = null) {
  if (liveGroups) {
    if (_liveReachCache && Date.now() < _liveReachExpires) return _liveReachCache;
  } else {
    if (_tournamentReachCache && Date.now() < _tournamentReachExpires) return _tournamentReachCache;
  }

  // Pre-compute which groups are fully completed so we can lock them in
  // rather than re-simulating. A group is complete when all 4 teams have played 3 games.
  const lockedGroups = {}; // letter → { sorted: [t1,t2,t3,t4], pts, gd, gf }
  if (liveGroups) {
    for (const [letter, rows] of Object.entries(liveGroups)) {
      if (rows.length === 4 && rows.every(r => (r.played ?? 0) >= 3)) {
        const sorted = [...rows].sort((a, b) =>
          b.points - a.points || b.gd - a.gd || (b.gf ?? 0) - (a.gf ?? 0)
        );
        lockedGroups[letter] = {
          sorted: sorted.map(r => r.team),
          pts: Object.fromEntries(rows.map(r => [r.team, r.points])),
          gd:  Object.fromEntries(rows.map(r => [r.team, r.gd ?? 0])),
          gf:  Object.fromEntries(rows.map(r => [r.team, r.gf ?? 0])),
        };
      }
    }
  }

  // Counters per team
  const counts = {};
  for (const teams of Object.values(WC_GROUPS)) {
    for (const t of teams) {
      counts[t] = { advance: 0, r16: 0, qf: 0, sf: 0, final: 0, winner: 0 };
    }
  }

  // Fast inline Poisson draw
  function poissonDraw(lambda) {
    const L = Math.exp(-lambda);
    let k = 0, p = 1;
    do { k++; p *= Math.random(); } while (p > L);
    return k - 1;
  }

  // Simulate a single knockout match — uses full wcLambdas (host boost + confed + ELO)
  function knockoutMatch(teamA, teamB) {
    const { lH: lA, lA: lB } = wcLambdas(teamA, teamB);
    const gA = poissonDraw(lA);
    const gB = poissonDraw(lB);
    if (gA > gB) return teamA;
    if (gB > gA) return teamB;
    // Penalties — strength-weighted coin flip
    const sA = wcStrength(teamA), sB = wcStrength(teamB);
    return Math.random() < sA / (sA + sB) ? teamA : teamB;
  }

  // Simulate a group stage: returns sorted [1st, 2nd, 3rd, 4th] plus pts/gd/gf maps
  function simulateGroup(teams) {
    const pts = {};
    const gd  = {};
    const gf  = {};
    for (const t of teams) { pts[t] = 0; gd[t] = 0; gf[t] = 0; }

    for (let i = 0; i < teams.length; i++) {
      for (let j = i + 1; j < teams.length; j++) {
        const tA = teams[i], tB = teams[j];
        const { lH: lA, lA: lB } = wcLambdas(tA, tB);
        const gA = poissonDraw(lA), gB = poissonDraw(lB);
        if (gA > gB) { pts[tA] += 3; }
        else if (gA < gB) { pts[tB] += 3; }
        else { pts[tA]++; pts[tB]++; }
        gd[tA] += gA - gB; gd[tB] += gB - gA;
        gf[tA] += gA;      gf[tB] += gB;
      }
    }

    const sorted = [...teams].sort((a, b) => pts[b] - pts[a] || gd[b] - gd[a] || gf[b] - gf[a]);
    return { sorted, pts, gd, gf };
  }

  for (let sim = 0; sim < n; sim++) {
    const groupResults = {}; // letter → { sorted, pts, gd, gf }
    for (const [letter, teams] of Object.entries(WC_GROUPS)) {
      // Use actual standings for completed groups — no randomness needed
      groupResults[letter] = lockedGroups[letter] ?? simulateGroup(teams);
    }

    // Mark group advance for top-2 per group
    for (const [letter, { sorted }] of Object.entries(groupResults)) {
      counts[sorted[0]].advance++;
      counts[sorted[1]].advance++;
    }

    // Collect all 12 third-place teams; rank by pts → GD → GF; best 8 advance
    const thirdPlaceTeams = Object.entries(groupResults).map(([letter, { sorted, pts, gd, gf }]) => ({
      team: sorted[2],
      pts:  pts[sorted[2]],
      gd:   gd[sorted[2]],
      gf:   gf[sorted[2]],
      letter,
    }));
    thirdPlaceTeams.sort((a, b) => b.pts - a.pts || b.gd - a.gd || b.gf - a.gf);
    const b8 = thirdPlaceTeams.slice(0, 8).map(x => x.team);

    // Credit the 8 best third-place teams with an advance
    for (const t of b8) counts[t].advance++;

    // R32 bracket — 16 matches
    // Matches 1-8: Group winners A-H vs b8[0]-b8[7]
    const groupLetters = Object.keys(WC_GROUPS);
    const r32Winners = [];

    // Matches 1–8
    for (let i = 0; i < 8; i++) {
      const winner = groupResults[groupLetters[i]].sorted[0];
      const third  = b8[i];
      r32Winners.push(knockoutMatch(winner, third));
    }

    // Matches 9-12: I1 vs J2, J1 vs I2, K1 vs L2, L1 vs K2
    const [I1, I2] = groupResults['I'].sorted;
    const [J1, J2] = groupResults['J'].sorted;
    const [K1, K2] = groupResults['K'].sorted;
    const [L1, L2] = groupResults['L'].sorted;
    r32Winners.push(knockoutMatch(I1, J2));
    r32Winners.push(knockoutMatch(J1, I2));
    r32Winners.push(knockoutMatch(K1, L2));
    r32Winners.push(knockoutMatch(L1, K2));

    // Matches 13-16: A2 vs F2, B2 vs E2, C2 vs H2, D2 vs G2
    const A2 = groupResults['A'].sorted[1];
    const B2 = groupResults['B'].sorted[1];
    const C2 = groupResults['C'].sorted[1];
    const D2 = groupResults['D'].sorted[1];
    const E2 = groupResults['E'].sorted[1];
    const F2 = groupResults['F'].sorted[1];
    const G2 = groupResults['G'].sorted[1];
    const H2 = groupResults['H'].sorted[1];
    r32Winners.push(knockoutMatch(A2, F2));
    r32Winners.push(knockoutMatch(B2, E2));
    r32Winners.push(knockoutMatch(C2, H2));
    r32Winners.push(knockoutMatch(D2, G2));

    // r32Winners now has 16 teams — mark r16 credit
    for (const t of r32Winners) counts[t].r16++;

    // R16 — 8 matches (pair winners sequentially: 0v1, 2v3, ...)
    const r16Winners = [];
    for (let i = 0; i < r32Winners.length; i += 2) {
      r16Winners.push(knockoutMatch(r32Winners[i], r32Winners[i + 1]));
    }
    for (const t of r16Winners) counts[t].qf++;

    // QF — 4 matches
    const qfWinners = [];
    for (let i = 0; i < r16Winners.length; i += 2) {
      qfWinners.push(knockoutMatch(r16Winners[i], r16Winners[i + 1]));
    }
    for (const t of qfWinners) counts[t].sf++;

    // SF — 2 matches
    const sfWinners = [];
    for (let i = 0; i < qfWinners.length; i += 2) {
      sfWinners.push(knockoutMatch(qfWinners[i], qfWinners[i + 1]));
    }
    for (const t of sfWinners) counts[t].final++;

    // Final
    const champion = knockoutMatch(sfWinners[0], sfWinners[1]);
    counts[champion].winner++;
  }

  // Normalise to probabilities
  const result = {};
  for (const [team, c] of Object.entries(counts)) {
    result[team] = {
      pAdvance: c.advance / n,
      pR16:     c.r16     / n,
      pQF:      c.qf      / n,
      pSF:      c.sf      / n,
      pFinal:   c.final   / n,
      pWinner:  c.winner  / n,
    };
  }

  if (liveGroups) {
    _liveReachCache   = result;
    _liveReachExpires = Date.now() + 15 * 60 * 1000; // 15min — refreshes as groups complete
  } else {
    _tournamentReachCache   = result;
    _tournamentReachExpires = Date.now() + 60 * 60 * 1000; // 1hr pre-tournament
  }
  return result;
}

// ─── International Results (martj42 dataset) ─────────────────────────────────

const INTL_RESULTS_URL = 'https://raw.githubusercontent.com/martj42/international_results/master/results.csv';
let _intlResultsCache   = null;
let _intlResultsExpires = 0;

// MARTJ42_ALIAS imported from core/config/footballConfig — single source of truth.
function toMartj42(name) { return MARTJ42_ALIAS[name] ?? name; }

async function getIntlResults() {
  if (_intlResultsCache && Date.now() < _intlResultsExpires) return _intlResultsCache;
  try {
    const res  = await axios.get(INTL_RESULTS_URL, {
      timeout: 20000, responseType: 'text', headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    const rows = res.data.trim().split('\n').slice(1);
    const parsed = rows.map(line => {
      const i1 = line.indexOf(',');
      const i2 = line.indexOf(',', i1 + 1);
      const i3 = line.indexOf(',', i2 + 1);
      const i4 = line.indexOf(',', i3 + 1);
      const i5 = line.indexOf(',', i4 + 1);
      const i6 = line.indexOf(',', i5 + 1);
      if (i4 === -1) return null;
      const homeScore = parseInt(line.slice(i3 + 1, i4), 10);
      const awayScore = parseInt(line.slice(i4 + 1, i5 === -1 ? undefined : i5), 10);
      if (isNaN(homeScore) || isNaN(awayScore)) return null;
      // tournament column sits between i5 and i6
      const tournament = i5 !== -1 ? line.slice(i5 + 1, i6 === -1 ? undefined : i6).replace(/^"|"$/g, '').trim() : '';
      return {
        date: line.slice(0, i1),
        home: line.slice(i1 + 1, i2),
        away: line.slice(i2 + 1, i3),
        homeScore, awayScore, tournament,
      };
    }).filter(Boolean);
    _intlResultsCache   = parsed;
    _intlResultsExpires = Date.now() + 24 * 60 * 60 * 1000;
    failures.recordSuccess('WC_ELO', 'martj42 CSV fetch');
    console.log(`[IntlResults] Loaded ${parsed.length} matches from martj42 dataset`);
    return parsed;
  } catch (err) {
    failures.recordFailure('WC_ELO', 'martj42 CSV fetch', err);
    console.warn('[IntlResults] Fetch failed:', err.message);
    return _intlResultsCache ?? [];
  }
}

// ─── Dynamic ELO from martj42 results ────────────────────────────────────────
// Replaces hardcoded FIFA_STRENGTH with ratings computed from actual results.
// K-factor weighted by tournament importance. Cached for 24h.

let _dynamicElo = null; // populated at startup

// K-factor weighted by tournament importance + time decay (recent matches matter more)
// Tiers:
//   60 — World Cup (the gold standard)
//   52 — UEFA Euro / Copa América (genuinely elite cross-continental competition)
//   45 — UEFA Nations League (competitive European round-robin)
//   38 — Africa Cup of Nations / Asian Cup / CONCACAF Gold Cup (regional, weaker avg quality)
//   36 — World Cup qualification (mixed; broad range of team quality)
//   20 — Friendlies
//   30 — anything else (tournaments, invitational cups etc.)
function kFactor(tournament = '', date = '') {
  const t = tournament.toLowerCase();
  let K;
  if (t.includes('world cup') && !t.includes('qualif')) {
    K = 60;
  } else if (t.includes('uefa euro') || t.includes('european championship') ||
             t.includes('euro 20') || t.includes('copa am')) {
    // UEFA Euro & Copa América — highest-quality continental tournaments
    K = 52;
  } else if (t.includes('uefa nations league')) {
    // Competitive UEFA round-robin — respectable but below a championship
    K = 45;
  } else if (t.includes('africa cup') || t.includes('african cup') || t.includes('afcon') ||
             t.includes('asian cup') || t.includes('afc asian') ||
             t.includes('gold cup') || t.includes('concacaf nations') ||
             t.includes('nations league')) {
    // Regional continental cups — lower average team quality than EURO / Copa
    K = 38;
  } else if (t.includes('qualif') || t.includes('qualifier')) {
    // WC qualifiers — value varies hugely by zone; conservative mid-weight
    K = 36;
  } else if (t.includes('friendly') || t.includes('friendlies')) {
    K = 20;
  } else {
    K = 30;
  }

  // Time decay — older matches have less impact on current ratings
  if (date) {
    const ageDays = (Date.now() - new Date(date).getTime()) / 86400000;
    if (ageDays > 1095) K *= 0.35;      // 3+ years old (e.g. 2022 WC spikes)
    else if (ageDays > 730) K *= 0.55;  // 2–3 years old
    else if (ageDays > 365) K *= 0.78;  // 1–2 years old
    // < 1 year: full K
  }
  return K;
}

// CONFED_ELO_CREDIBILITY — historical static credibility blend.
// Replaced by adaptive alpha (clamp(n/25, 0.15, 0.85)) in core/footballEngine/elo.js.
// Not applied at runtime. Retained in core/config/footballConfig.js for documentation.

// ─── WC prior ELO lookup (used by buildDynamicElo and wcStrength fallback) ────
function _wcPriorElo(teamName) {
  if (FIFA_STRENGTH[teamName] != null) return FIFA_STRENGTH[teamName];
  const key = Object.keys(FIFA_STRENGTH).find(k =>
    k.toLowerCase() === teamName.toLowerCase() ||
    teamName.toLowerCase().includes(k.toLowerCase()) ||
    k.toLowerCase().includes(teamName.toLowerCase())
  );
  return key ? FIFA_STRENGTH[key] : 1500;
}

// ─── WC confederation lookup (martj42 name → confederation) ──────────────────
function _wcTeamConfed(martj42Name) {
  const ourName = Object.entries(MARTJ42_ALIAS).find(([, v]) => v === martj42Name)?.[0] ?? martj42Name;
  return WC_CONFEDERATION[ourName] ?? WC_CONFEDERATION[martj42Name] ?? null;
}

// buildDynamicElo now delegates to core calculateEloRatings (worldcup mode).
// All WC-specific parameters are injected — core has no hard dependencies on
// server.js constants.
function buildDynamicElo(results) {
  return calculateEloRatings({
    matches: results,
    mode: 'worldcup',
    worldcupOpts: {
      kFactorFn:  kFactor,
      priorEloFn: _wcPriorElo,
      confederationCtx: {
        getConfed:             _wcTeamConfed,
        crossConfedIntraWeight: 0.87,
        alphaParams: { divisor: 25, min: 0.15, cap: 0.85 },
      },
      startDate: '2018-01-01',
    },
  });
}

async function initDynamicElo() {
  try {
    const results = await getIntlResults();
    if (!results || results.length === 0) {
      // Hard failure: no data at all — log and flag, do NOT silently continue
      failures.recordFailure('WC_ELO', 'martj42 CSV', new Error('empty dataset returned'));
      logger.error({
        system: 'WC', stage: 'elo',
        message: '[DynamicElo] martj42 dataset returned 0 results — ELO init aborted',
        warnings: ['wcStrength() will fall back to FIFA_STRENGTH priors for all teams'],
        errors:   ['empty dataset — check INTL_RESULTS_URL and network connectivity'],
      });
      return;   // _dynamicElo stays null → wcStrength() falls back to FIFA_STRENGTH
    }
    _dynamicElo = buildDynamicElo(results);
    // Clear frozen pre-tournament predictions so they regenerate with updated model
    _wcPrePredCache = null;
    failures.recordSuccess('WC_ELO', 'martj42 CSV');
    const top5 = Object.entries(_dynamicElo)
      .sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([t, r]) => `${t} ${Math.round(r)}`).join(', ');
    logger.info({
      system: 'WC', stage: 'elo',
      message: `[DynamicElo] Built from ${results.length} intl results. Top 5: ${top5}`,
      metrics: { matchCount: results.length, top5 },
    });
  } catch (err) {
    // Explicit failure — record in registry and log structured warning.
    // _dynamicElo remains null → wcStrength() falls back to FIFA_STRENGTH priors.
    // This is an EXPECTED degradation path, not a silent bug.
    failures.recordFailure('WC_ELO', 'martj42 CSV', err);
    logger.warn({
      system:   'WC', stage: 'elo',
      message:  '[DynamicElo] Init failed — falling back to FIFA_STRENGTH priors',
      warnings: ['All WC predictions will use hardcoded prior ELOs until next successful init'],
      errors:   [err.message],
    });
  }
}

function getTeamFormData(results, teamAlias, since = '2023-01-01') {
  const matches = results
    .filter(r => r.date >= since && (r.home === teamAlias || r.away === teamAlias))
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-12);
  if (!matches.length) return null;

  const items = matches.map(r => {
    const isHome   = r.home === teamAlias;
    const scored   = isHome ? r.homeScore : r.awayScore;
    const conceded = isHome ? r.awayScore : r.homeScore;
    const outcome  = scored > conceded ? 'W' : scored < conceded ? 'L' : 'D';
    return { date: r.date, opponent: isHome ? r.away : r.home, scored, conceded, outcome,
             pts: outcome === 'W' ? 3 : outcome === 'D' ? 1 : 0 };
  });

  const last5    = items.slice(-5);
  const prev5    = items.slice(-10, -5);
  const avgLast  = last5.reduce((s, x) => s + x.pts, 0) / (last5.length || 1);
  const avgPrev  = prev5.length ? prev5.reduce((s, x) => s + x.pts, 0) / prev5.length : avgLast;
  const diff     = avgLast - avgPrev;
  const avg      = items.reduce((s, x) => s + x.pts, 0) / items.length;
  const variance = items.reduce((s, x) => s + (x.pts - avg) ** 2, 0) / items.length;
  const trend    = variance > 2.0  ? 'Inconsistent'
                 : diff >= 0.7     ? 'Peaking'
                 : diff <= -0.7    ? 'Declining'
                 :                   'Steady';
  return {
    items, trend,
    W: items.filter(x => x.outcome === 'W').length,
    D: items.filter(x => x.outcome === 'D').length,
    L: items.filter(x => x.outcome === 'L').length,
    avgPts: +avg.toFixed(2),
  };
}

function getH2HData(results, homeAlias, awayAlias) {
  const meetings = results
    .filter(r => (r.home === homeAlias && r.away === awayAlias) ||
                 (r.home === awayAlias && r.away === homeAlias))
    .sort((a, b) => a.date.localeCompare(b.date));
  const total = meetings.length;
  let homeWins = 0, awayWins = 0, draws = 0, totalGoals = 0;
  for (const m of meetings) {
    const hS = m.home === homeAlias ? m.homeScore : m.awayScore;
    const aS = m.home === homeAlias ? m.awayScore : m.homeScore;
    totalGoals += m.homeScore + m.awayScore;
    if (hS > aS) homeWins++; else if (hS < aS) awayWins++; else draws++;
  }
  const last5 = meetings.slice(-5).reverse().map(m => ({
    date: m.date,
    homeScore: m.home === homeAlias ? m.homeScore : m.awayScore,
    awayScore: m.home === homeAlias ? m.awayScore : m.homeScore,
  }));
  return { total, homeWins, awayWins, draws,
           avgGoals: total ? +(totalGoals / total).toFixed(2) : 0,
           last5, edge: homeWins > awayWins ? 'home' : awayWins > homeWins ? 'away' : null };
}

// ─── Golden Boot Predictor ───────────────────────────────────────────────────

// All teams verified against confirmed WC_GROUPS 2026 draw.
// No player from an unqualified nation is included.
// Squads based on current international form — updated once official 2026 squads announced.
const WC_STRIKERS = [
  // Group A — Mexico, South Africa, South Korea, Czech Republic
  { name: 'Santiago Giménez',   team: 'Mexico',                share: 0.30 },
  { name: 'Son Heung-min',      team: 'South Korea',           share: 0.28 },
  { name: 'Patrik Schick',      team: 'Czech Republic',        share: 0.32 },
  // Group B — Canada, Bosnia & Herzegovina, Qatar, Switzerland
  { name: 'Jonathan David',     team: 'Canada',                share: 0.30 },
  { name: 'Edin Džeko',         team: 'Bosnia & Herzegovina',  share: 0.28 },
  { name: 'Breel Embolo',       team: 'Switzerland',           share: 0.30 },
  // Group C — Brazil, Morocco, Haiti, Scotland
  { name: 'Vinicius Jr.',       team: 'Brazil',                share: 0.27 },
  { name: 'Rodrygo',            team: 'Brazil',                share: 0.18 },
  { name: 'Youssef En-Nesyri',  team: 'Morocco',               share: 0.30 },
  // Group D — United States, Paraguay, Australia, Turkey
  { name: 'Christian Pulisic',  team: 'United States',         share: 0.24 },
  { name: 'Mathew Leckie',      team: 'Australia',             share: 0.24 },
  { name: 'Arda Güler',         team: 'Turkey',                share: 0.26 },
  { name: 'Enes Ünal',          team: 'Turkey',                share: 0.20 },
  // Group E — Germany, Curaçao, Côte d'Ivoire, Ecuador
  { name: 'Kai Havertz',        team: 'Germany',               share: 0.26 },
  { name: 'Florian Wirtz',      team: 'Germany',               share: 0.18 },
  { name: 'Enner Valencia',     team: 'Ecuador',               share: 0.32 },
  // Group F — Netherlands, Japan, Sweden, Tunisia
  { name: 'Cody Gakpo',         team: 'Netherlands',           share: 0.26 },
  { name: 'Memphis Depay',      team: 'Netherlands',           share: 0.22 },
  { name: 'Ayase Ueda',         team: 'Japan',                 share: 0.32 },
  { name: 'Alexander Isak',     team: 'Sweden',                share: 0.35 },
  // Group G — Belgium, Egypt, Iran, New Zealand
  { name: 'Romelu Lukaku',      team: 'Belgium',               share: 0.32 },
  { name: 'Mohamed Salah',      team: 'Egypt',                 share: 0.38 },
  { name: 'Mehdi Taremi',       team: 'Iran',                  share: 0.32 },
  { name: 'Chris Wood',         team: 'New Zealand',           share: 0.40 },
  // Group H — Spain, Cabo Verde, Saudi Arabia, Uruguay
  { name: 'Álvaro Morata',      team: 'Spain',                 share: 0.24 },
  { name: 'Mikel Oyarzabal',    team: 'Spain',                 share: 0.18 },
  { name: 'Darwin Núñez',       team: 'Uruguay',               share: 0.30 },
  { name: 'Salem Al-Dawsari',   team: 'Saudi Arabia',          share: 0.28 },
  // Group I — France, Senegal, Iraq, Norway
  { name: 'Kylian Mbappé',      team: 'France',                share: 0.40 },
  { name: 'Antoine Griezmann',  team: 'France',                share: 0.18 },
  { name: 'Sadio Mané',         team: 'Senegal',               share: 0.28 },
  { name: 'Ismaila Sarr',       team: 'Senegal',               share: 0.20 },
  { name: 'Erling Haaland',     team: 'Norway',                share: 0.42 },
  // Group J — Argentina, Algeria, Austria, Jordan
  { name: 'Lautaro Martínez',   team: 'Argentina',             share: 0.28 },
  { name: 'Julián Álvarez',     team: 'Argentina',             share: 0.20 },
  { name: 'Riyad Mahrez',       team: 'Algeria',               share: 0.30 },
  // Group K — Portugal, DR Congo, Uzbekistan, Colombia
  { name: 'Cristiano Ronaldo',  team: 'Portugal',              share: 0.30 },
  { name: 'Gonçalo Ramos',      team: 'Portugal',              share: 0.22 },
  { name: 'Eldor Shomurodov',   team: 'Uzbekistan',            share: 0.30 },
  { name: 'Luis Díaz',          team: 'Colombia',              share: 0.24 },
  // Group L — England, Croatia, Ghana, Panama
  { name: 'Harry Kane',         team: 'England',               share: 0.33 },
  { name: 'Bukayo Saka',        team: 'England',               share: 0.18 },
  { name: 'Andrej Kramarić',    team: 'Croatia',               share: 0.26 },
  { name: 'Mohammed Kudus',     team: 'Ghana',                 share: 0.30 },
  { name: 'Ismael Díaz',        team: 'Panama',                share: 0.34 },
];

function computeGoldenBoot(reach) {
  return WC_STRIKERS.map(s => {
    // Use wcLambdas vs average team (1500 ELO) to get team's typical attack lambda
    const { lH: lambda } = wcLambdas(s.team, '__avg__');
    const r        = reach[s.team] ?? {};
    const expGames = 3 + (r.pAdvance ?? 0) + (r.pR16 ?? 0) + (r.pQF ?? 0) + (r.pSF ?? 0) + (r.pFinal ?? 0);
    const xGoals   = +(lambda * expGames * s.share).toFixed(2);
    return { name: s.name, team: s.team, xGoals, expGames: +expGames.toFixed(1) };
  }).sort((a, b) => b.xGoals - a.xGoals).slice(0, 15);
}

const WC_START = new Date('2026-06-11T00:00:00Z');

// ── Pre-tournament predictions — computed once, frozen permanently ─────────────
// Cached in memory for the lifetime of the process so stochastic results don't
// drift between page refreshes. Also persisted to disk so a server restart (e.g.
// a Railway redeploy) loads the same numbers users saw before.
const WC_PRE_PRED_FILE = path.join(__dirname, 'wc-pre-predictions.json');
let   _wcPrePredCache  = null;

function _loadPrePredFromDisk() {
  try {
    if (fs.existsSync(WC_PRE_PRED_FILE)) {
      const raw = JSON.parse(fs.readFileSync(WC_PRE_PRED_FILE, 'utf8'));
      // Guard: discard disk cache if model version doesn't match.
      // (Same check Supabase loader applies — was previously missing here.)
      if (raw.modelVersion !== WC_MODEL_VERSION) {
        console.log(`[WC] Disk cache is model ${raw.modelVersion ?? 'unknown'}, current is ${WC_MODEL_VERSION} — discarding`);
        return null;
      }
      console.log(`[WC] Loaded frozen pre-tournament predictions from disk (saved ${raw.savedAt})`);
      return raw;
    }
  } catch (err) { console.warn('[WC] Could not load pre-pred file:', err.message); }
  return null;
}

// WC_MODEL_VERSION imported from core/state/modelState — single source of truth.

async function initWcPrePredictions() {
  if (!supabase) return; // will fall through to disk/build in getPrePredictions
  try {
    const { data, error } = await supabase
      .from('wc_predictions')
      .select('data, saved_at')
      .eq('id', 1)
      .maybeSingle();
    if (!error && data) {
      // Discard stale cache if model version doesn't match
      if (data.data?.modelVersion !== WC_MODEL_VERSION) {
        console.log(`[WC] Supabase cache is model ${data.data?.modelVersion ?? 'unknown'}, current is ${WC_MODEL_VERSION} — discarding`);
        return;
      }
      _wcPrePredCache = { savedAt: data.saved_at, ...data.data };
      console.log(`[WC] Loaded frozen pre-tournament predictions from Supabase (saved ${data.saved_at})`);
    }
  } catch (err) { console.warn('[Supabase initWcPrePredictions]', err.message); }
}

function _buildPrePredictions() {
  const groupMatchPredictions   = {};
  const groupPredictedStandings = {};

  for (const [letter, teams] of Object.entries(WC_GROUPS)) {
    const matches = [];
    for (let i = 0; i < teams.length; i++) {
      for (let j = i + 1; j < teams.length; j++) {
        matches.push({ home: teams[i], away: teams[j], ...wcPoisson(teams[i], teams[j]) });
      }
    }
    groupMatchPredictions[letter] = matches;

    // Monte Carlo: simulate the group N times with real 3/1/0 points.
    //
    // Strategy: medoid selection.
    // 1. Run MC_N simulations, storing every full 4-team points vector.
    // 2. Compute each team's median points across all runs independently.
    // 3. Find the actual simulation run whose vector is closest (min L1) to
    //    that per-team median vector — the "medoid".
    //
    // This gives a realistic, internally consistent outcome:
    //   • Values come from one real run → wins always equal losses, sum ∈ [12,18]
    //   • Reflects the typical (median) distribution, not just the clean dominant
    //     outcome, so balanced groups show spreads like 6/5/4/3 rather than 9/6/3/0
    const MC_N = 10000;
    function poissonDrawLocal(lambda) {
      const L = Math.exp(-lambda);
      let k = 0, p = 1;
      do { k++; p *= Math.random(); } while (p > L);
      return k - 1;
    }

    const allSims  = new Array(MC_N); // allSims[s] = [pts_t0, pts_t1, pts_t2, pts_t3]
    const ptsLists = teams.map(() => new Array(MC_N)); // per-team list for median
    const gdSum    = {};
    for (const t of teams) gdSum[t] = 0;

    for (let sim = 0; sim < MC_N; sim++) {
      const simPts = {};
      const simGD  = {};
      for (const t of teams) { simPts[t] = 0; simGD[t] = 0; }

      for (let i = 0; i < teams.length; i++) {
        for (let j = i + 1; j < teams.length; j++) {
          const tA = teams[i], tB = teams[j];
          const { lH: lA, lA: lB } = wcLambdas(tA, tB);
          const gA   = poissonDrawLocal(lA);
          const gB   = poissonDrawLocal(lB);
          if      (gA > gB) { simPts[tA] += 3; }
          else if (gA < gB) { simPts[tB] += 3; }
          else              { simPts[tA]++;  simPts[tB]++; }
          simGD[tA] += gA - gB;
          simGD[tB] += gB - gA;
        }
      }

      allSims[sim] = teams.map(t => simPts[t]);
      for (let i = 0; i < teams.length; i++) {
        ptsLists[i][sim] = simPts[teams[i]];
        gdSum[teams[i]] += simGD[teams[i]];
      }
    }

    // Per-team median (sort each list, pick middle value)
    const medians = ptsLists.map(list => {
      const s = list.slice().sort((a, b) => a - b);
      const m = (MC_N - 1) / 2;
      return (s[Math.floor(m)] + s[Math.ceil(m)]) / 2;
    });

    // Medoid: find the actual simulation run closest to the median vector
    let bestIdx = 0, bestDist = Infinity;
    for (let s = 0; s < MC_N; s++) {
      let dist = 0;
      for (let i = 0; i < teams.length; i++) dist += Math.abs(allSims[s][i] - medians[i]);
      if (dist < bestDist) { bestDist = dist; bestIdx = s; }
    }
    const repPts = allSims[bestIdx]; // representative points vector

    groupPredictedStandings[letter] = teams
      .map((t, i) => ({ team: t, xPts: repPts[i], xGD: +(gdSum[t] / MC_N).toFixed(2) }))
      .sort((a, b) => b.xPts - a.xPts || b.xGD - a.xGD);
  }

  return { groupMatchPredictions, groupPredictedStandings };
}

function getPrePredictions() {
  if (_wcPrePredCache) return _wcPrePredCache;
  // Try disk first (local dev fallback — Supabase is loaded at startup via initWcPrePredictions)
  _wcPrePredCache = _loadPrePredFromDisk();
  if (_wcPrePredCache) return _wcPrePredCache;
  // First ever call — compute, cache, and persist
  const built = _buildPrePredictions();
  _wcPrePredCache = { savedAt: new Date().toISOString(), modelVersion: WC_MODEL_VERSION, ...built };
  const { savedAt, ...dataToStore } = _wcPrePredCache;
  if (supabase) {
    supabase
      .from('wc_predictions')
      .upsert({ id: 1, saved_at: savedAt, data: dataToStore }, { onConflict: 'id' })
      .then(({ error }) => {
        if (error) console.warn('[Supabase getPrePredictions save]', error.message);
        else console.log('[WC] Pre-tournament predictions frozen and saved to Supabase');
      });
  } else {
    try {
      fs.writeFileSync(WC_PRE_PRED_FILE, JSON.stringify(_wcPrePredCache, null, 2));
      console.log('[WC] Pre-tournament predictions frozen and saved to disk');
    } catch (err) { console.warn('[WC] Could not persist pre-preds:', err.message); }
  }
  return _wcPrePredCache;
}

// Build a flat prediction lookup keyed by normalised team-name pair.
// Handles ESPN name variants (e.g. "United States" vs "USA") via substring matching.
function _buildPrePredLookup(groupMatchPredictions) {
  const flat = Object.values(groupMatchPredictions).flat();
  const norm = s => (s ?? '').toLowerCase().replace(/[^a-z]/g, '');
  const lookup = [];
  for (const m of flat) {
    lookup.push({ hn: norm(m.home), an: norm(m.away), pred: m, swapped: false });
    lookup.push({ hn: norm(m.away), an: norm(m.home), pred: m, swapped: true  });
    // Also index martj42 aliases in case ESPN uses those
    lookup.push({ hn: norm(toMartj42(m.home)), an: norm(toMartj42(m.away)), pred: m, swapped: false });
    lookup.push({ hn: norm(toMartj42(m.away)), an: norm(toMartj42(m.home)), pred: m, swapped: true  });
  }
  return function findPred(homeDisplay, awayDisplay) {
    const hn = norm(homeDisplay);
    const an = norm(awayDisplay);
    const exact = lookup.find(e => e.hn === hn && e.an === an);
    if (exact) return exact;
    // Fuzzy: substring containment for name variants
    return lookup.find(e =>
      (hn.includes(e.hn) || e.hn.includes(hn)) &&
      (an.includes(e.an) || e.an.includes(an))
    ) ?? null;
  };
}

// GET /api/wc/tournament
app.get('/api/wc/tournament', async (req, res) => {
  // Don't hit ESPN until the tournament is actually underway — before then the
  // fifa.world endpoint returns unrelated FIFA fixtures and pollutes the UI.
  if (Date.now() < WC_START.getTime()) {
    const { groupMatchPredictions, groupPredictedStandings } = getPrePredictions();

    // ── Insights (re-derived each call from frozen predictions) ─────────────
    // ── Group of Death rankings ──────────────────────────────────────────────
    const groupInsights = Object.entries(WC_GROUPS).map(([letter, teams]) => {
      const strengths = teams.map(t => wcStrength(t));
      const avg       = Math.round(strengths.reduce((s, v) => s + v, 0) / strengths.length);
      const gap       = Math.max(...strengths) - Math.min(...strengths);
      const score     = Math.round(avg - gap * 0.4);
      const label     = score >= 1600 ? 'Group of Death'
                      : score >= 1540 ? 'Tight Group'
                      : score >= 1490 ? 'Balanced'
                      : score >= 1450 ? 'Wide Open'
                      : 'Mismatch';
      const teamStrengths = teams
        .map(t => ({ team: t, strength: wcStrength(t) }))
        .sort((a, b) => b.strength - a.strength);
      return { letter, avg, gap, score, label, teamStrengths };
    }).sort((a, b) => b.score - a.score);

    // ── Upset Tracker ────────────────────────────────────────────────────────
    const upsetMatches = [];
    for (const [letter, matches] of Object.entries(groupMatchPredictions)) {
      for (const m of matches) {
        const hStr = wcStrength(m.home);
        const aStr = wcStrength(m.away);
        // Require a meaningful ELO gap before labelling a team as underdog.
        // <60 points ≈ coin-flip — not a genuine upset opportunity.
        // (Previously only skipped hStr === aStr, causing Canada/Switzerland 36%/36%
        // to appear as an upset alert despite tied win probabilities.)
        const eloGap = Math.abs(hStr - aStr);
        if (eloGap < 60) continue;
        const isHomeUnderdog = hStr < aStr;
        const underdogWin    = isHomeUnderdog ? m.homeWin : m.awayWin;
        if (underdogWin >= 0.33) {
          upsetMatches.push({
            group:        letter,
            home:         m.home,
            away:         m.away,
            underdog:     isHomeUnderdog ? m.home : m.away,
            favourite:    isHomeUnderdog ? m.away : m.home,
            underdogWin,
            draw:         m.draw,
            predictedScore: m.predictedScore,
            label:        underdogWin >= 0.40 ? 'Watch This' : 'Upset Alert',
          });
        }
      }
    }
    upsetMatches.sort((a, b) => b.underdogWin - a.underdogWin);

    return res.json({
      phase:                  'PRE_TOURNAMENT',
      groups:                 {},
      groupFixtures:          [],
      knockoutFixtures:       [],
      hardcodedGroups:        WC_GROUPS,
      wcSchedule:             WC_SCHEDULE,
      groupMatchPredictions,
      groupPredictedStandings,
      tournamentReach:        simulateTournamentReach(),
      goldenBoot:             computeGoldenBoot(simulateTournamentReach()),
      groupInsights,
      upsetMatches,
      hasLiveData:            false,
    });
  }

  try {
    const [scoreboardData, standingsData] = await Promise.allSettled([
      fetchESPN(ESPN_SCOREBOARD, 'wc_scoreboard'),
      fetchESPN(ESPN_STANDINGS,  'wc_standings'),
    ]);

    const fixtures = scoreboardData.status === 'fulfilled'
      ? parseESPNFixtures(scoreboardData.value)
      : [];

    const groups = standingsData.status === 'fulfilled'
      ? parseESPNStandings(standingsData.value)
      : {};

    const phase            = wcTournamentPhase(fixtures);
    const groupFixtures    = fixtures.filter(f => (f.round ?? '').toLowerCase().includes('group'));
    const knockoutFixtures = fixtures.filter(f => !(f.round ?? '').toLowerCase().includes('group'));
    const hasLiveData      = fixtures.length > 0 || Object.keys(groups).length > 0;

    // Load frozen pre-tournament predictions so we can show "predicted vs actual"
    const prePreds = getPrePredictions();
    const findPrePred = prePreds ? _buildPrePredLookup(prePreds.groupMatchPredictions) : () => null;

    function attachPrePreds(fixtureList) {
      return enrichWithPredictions(fixtureList).map(f => {
        const home  = f.teams?.home?.name ?? '';
        const away  = f.teams?.away?.name ?? '';
        const entry = findPrePred(home, away);
        if (!entry) return f;
        // If names were stored swapped, flip so home/away match the live fixture
        const pred = entry.swapped
          ? { ...entry.pred, home: entry.pred.away, away: entry.pred.home,
              homeWin: entry.pred.awayWin, awayWin: entry.pred.homeWin,
              predictedScore: entry.pred.predictedScore.split('-').reverse().join('-') }
          : entry.pred;
        return { ...f, _prePrediction: pred };
      });
    }

    // Compute live tournament reach — completed groups use actual standings,
    // incomplete groups are simulated. This keeps Odds tab and Team Detail
    // Modal accurate throughout the tournament.
    const liveTournamentReach = simulateTournamentReach(10000, groups);

    res.json({
      phase,
      groups,
      groupFixtures:          attachPrePreds(groupFixtures),
      knockoutFixtures:       enrichWithPredictions(knockoutFixtures),
      hardcodedGroups:        WC_GROUPS,
      wcSchedule:             WC_SCHEDULE,
      preTournamentSavedAt:   prePreds?.savedAt ?? null,
      tournamentReach:        liveTournamentReach,
      goldenBoot:             computeGoldenBoot(liveTournamentReach),
      hasLiveData,
    });
  } catch (err) {
    console.error('[WC] Tournament fetch failed:', err.message);
    res.json({ phase: 'PRE_TOURNAMENT', groups: {}, groupFixtures: [], knockoutFixtures: [], hardcodedGroups: WC_GROUPS, wcSchedule: WC_SCHEDULE, hasLiveData: false });
  }
});

// GET /api/wc/elo-rankings — all 48 WC teams ranked by dynamic ELO
app.get('/api/wc/elo-rankings', (req, res) => {
  const allTeams = Object.values(WC_GROUPS).flat();
  const ranked = allTeams
    .map(team => ({
      team,
      elo:         Math.round(wcStrength(team)),
      confederation: WC_CONFEDERATION[team] ?? 'Unknown',
      hostNation:  WC_HOST_NATIONS.has(team) || WC_HOST_NATIONS.has(toMartj42(team)),
    }))
    .sort((a, b) => b.elo - a.elo)
    .map((t, i) => ({ ...t, rank: i + 1 }));
  res.json({ rankings: ranked, usingDynamicElo: !!_dynamicElo });
});

// ─── Model Diagnostics ───────────────────────────────────────────────────────

// Lightweight in-memory cache for diagnostics (recompute at most every 5 min)
let _diagnosticsCache   = null;
let _diagnosticsCacheAt = 0;
const DIAGNOSTICS_TTL   = TTL.DIAGNOSTICS;  // from modelState

// Diagnostics snapshot — now routed through cacheManager for unified persistence.
function loadDiagnosticsSnapshot() {
  return cache.loadSlot('diagnostics-snapshot');
}
function saveDiagnosticsSnapshot(rankings) {
  const snap = rankings.map(r => ({ team: r.team, elo: r.elo, rank: r.rank }));
  cache.persistSlot('diagnostics-snapshot', snap);
}

// GET /api/model-diagnostics
app.get('/api/model-diagnostics', (req, res) => {
  const now = Date.now();
  if (_diagnosticsCache && (now - _diagnosticsCacheAt) < DIAGNOSTICS_TTL) {
    return res.json(_diagnosticsCache);
  }

  const allTeams = Object.values(WC_GROUPS).flat();
  const rankings = allTeams
    .map(team => ({
      team,
      elo:           Math.round(wcStrength(team)),
      confederation: WC_CONFEDERATION[team] ?? 'Unknown',
      hostNation:    WC_HOST_NATIONS.has(team) || WC_HOST_NATIONS.has(toMartj42(team)),
    }))
    .sort((a, b) => b.elo - a.elo)
    .map((t, i) => ({ ...t, rank: i + 1 }));

  const snapshot     = loadDiagnosticsSnapshot();
  const report       = runDiagnostics(rankings, snapshot);
  const calibration  = generateCalibrationReport(report);

  // Save current rankings as the new snapshot reference
  saveDiagnosticsSnapshot(rankings);

  const fullResponse  = { ...report, calibration };
  _diagnosticsCache   = fullResponse;
  _diagnosticsCacheAt = now;

  res.json(fullResponse);
});

// ─── Model Monitor — live prediction-outcome tracking ─────────────────────────
// In-memory log of settled prediction outcomes. On startup the log is seeded
// from a local JSON file (monitor-log.json) so history survives restarts.
// The log is capped at MAX_MONITOR_LOG entries to prevent unbounded growth.
//
// Integration:
//   • POST /api/monitor/record-outcome — called after a match settles
//   • GET  /api/monitor/report         — full health report for the dashboard
//   • GET  /api/monitor/report/:system — health report filtered to PL|FD|WC

const MAX_MONITOR_LOG      = 5_000;               // keep last 5k settled matches
const MONITOR_REPORT_TTL   = TTL.MONITOR_REPORT;   // from modelState

let _monitorLog        = [];
let _monitorReportCache = null;
let _monitorReportAt    = 0;

// ── Load persisted log on startup (via cacheManager) ────────────────────────
(function loadMonitorLog() {
  try {
    const raw = cache.loadSlot('monitor-log');
    if (Array.isArray(raw)) {
      _monitorLog = raw.slice(-MAX_MONITOR_LOG);
      console.log(`[monitor] loaded ${_monitorLog.length} settled outcomes from disk`);
    }
  } catch (err) {
    console.warn('[monitor] could not load monitor-log.json:', err.message);
  }
})();

function persistMonitorLog() {
  cache.persistSlot('monitor-log', _monitorLog.slice(-MAX_MONITOR_LOG));
}

function invalidateMonitorCache() {
  _monitorReportCache = null;
  _monitorReportAt    = 0;
}

/**
 * POST /api/monitor/record-outcome
 *
 * Body (JSON):
 * {
 *   matchId:   "pl-2024-W29-arsenal-chelsea",
 *   system:    "PL" | "FD" | "WC",
 *   predicted: { homeWinProb, drawProb, awayWinProb, expectedGoalsHome?, expectedGoalsAway? },
 *   actual:    { homeGoals, awayGoals, result? },
 *   context?:  { homeTeam, awayTeam, kickoffTime, eloHome?, eloAway? },
 *   timestamp?: "2025-03-15T15:00:00Z"
 * }
 *
 * Returns: { ok: true, n: <total settled count> }
 */
app.post('/api/monitor/record-outcome', (req, res) => {
  const { entry, error } = modelMonitor.recordPredictionOutcome(req.body ?? {});
  if (error) return res.status(400).json({ error });

  // Prevent duplicate matchId entries
  const existing = _monitorLog.findIndex(e => e.matchId === entry.matchId && e.system === entry.system);
  if (existing >= 0) {
    _monitorLog[existing] = entry;   // update in place (late result correction)
  } else {
    _monitorLog.push(entry);
    if (_monitorLog.length > MAX_MONITOR_LOG) _monitorLog.shift();
  }

  invalidateMonitorCache();
  persistMonitorLog();   // write-through; negligible cost for sporadic updates

  res.json({ ok: true, n: _monitorLog.length });
});

/**
 * POST /api/monitor/record-outcomes   (batch variant)
 *
 * Body: { outcomes: Array<outcome> }
 * Returns: { ok: true, accepted: N, rejected: [{index, error}] }
 */
app.post('/api/monitor/record-outcomes', (req, res) => {
  const { outcomes } = req.body ?? {};
  if (!Array.isArray(outcomes)) return res.status(400).json({ error: 'outcomes[] required' });

  let accepted = 0;
  const rejected = [];

  for (let i = 0; i < outcomes.length; i++) {
    const { entry, error } = modelMonitor.recordPredictionOutcome(outcomes[i]);
    if (error) { rejected.push({ index: i, error }); continue; }

    const existing = _monitorLog.findIndex(
      e => e.matchId === entry.matchId && e.system === entry.system
    );
    if (existing >= 0) _monitorLog[existing] = entry;
    else _monitorLog.push(entry);
    accepted++;
  }

  // Trim to cap
  if (_monitorLog.length > MAX_MONITOR_LOG) {
    _monitorLog = _monitorLog.slice(-MAX_MONITOR_LOG);
  }
  if (accepted > 0) {
    invalidateMonitorCache();
    persistMonitorLog();
  }

  res.json({ ok: true, accepted, rejected });
});

/**
 * GET /api/monitor/report[/:system]
 *
 * Returns a full health report for all pipelines or a single one.
 * Cached for MONITOR_REPORT_TTL to avoid recomputing on every poll.
 *
 * Optional query param: ?days=28  — recent window size (default 28)
 */
app.get('/api/monitor/report/:system?', (req, res) => {
  const { system } = req.params;
  const days       = Math.max(1, parseInt(req.query.days, 10) || 28);

  if (system && !['PL', 'FD', 'WC'].includes(system)) {
    return res.status(400).json({ error: 'system must be PL, FD, or WC' });
  }

  const now = Date.now();
  if (_monitorReportCache && (now - _monitorReportAt) < MONITOR_REPORT_TTL && !system) {
    return res.json(_monitorReportCache);
  }

  const entries = system ? _monitorLog.filter(e => e.system === system) : _monitorLog;

  // Build ELO snapshots from in-memory WC ELO for the trend tracker.
  // Only populated once WC data has been initialised.
  const eloSnapshots = [];
  try {
    if (typeof wcStrength === 'function') {
      const allTeams = Object.values(WC_GROUPS ?? {}).flat();
      const ratingMap = {};
      for (const t of allTeams) ratingMap[t] = wcStrength(t);
      const snap = modelMonitor.snapshotEloDistribution(ratingMap, 'WC');
      if (snap.n > 0) eloSnapshots.push(snap);
    }
  } catch { /* WC data not yet loaded */ }

  const report = modelMonitor.generateMonitorReport(entries, {
    recentWindowDays: days,
    eloSnapshots,
  });

  if (!system) {
    _monitorReportCache = report;
    _monitorReportAt    = now;
  }

  res.json(report);
});

/**
 * GET /api/monitor/log
 *
 * Returns the raw settled-outcome log (last N entries).
 * Useful for ad-hoc inspection. Default limit: 100.
 */
app.get('/api/monitor/log', (req, res) => {
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
  res.json({
    n:       _monitorLog.length,
    entries: _monitorLog.slice(-limit),
  });
});

/**
 * GET /api/system-status
 *
 * Returns the failure-registry status for all external data systems.
 * Useful for ops dashboards, alerting, and health checks.
 */
app.get('/api/system-status', (_req, res) => {
  res.json({
    ...failures.getAllSystemStatus(),
    cache: cache.getCacheHealth(),
    modelVersion: WC_MODEL_VERSION,
    dynamicEloLoaded: !!_dynamicElo,
  });
});

// GET /api/wc/predict?home=Argentina&away=France
app.get('/api/wc/predict', (req, res) => {
  const { home, away } = req.query;
  if (!home || !away) return res.status(400).json({ error: 'home and away params required' });
  res.json(wcPoisson(home, away));
});

// GET /api/wc/form/:team — recent international form from martj42 dataset
app.get('/api/wc/form/:team', async (req, res) => {
  const { team } = req.params;
  try {
    const results = await getIntlResults();
    const alias   = toMartj42(team);
    const form    = getTeamFormData(results, alias);
    res.json({ team, form });
  } catch (err) {
    console.error('[WC Form]', err.message);
    res.json({ team, form: null });
  }
});

// GET /api/wc/h2h?home=X&away=Y — head to head history from martj42 dataset
app.get('/api/wc/h2h', async (req, res) => {
  const { home, away } = req.query;
  if (!home || !away) return res.status(400).json({ error: 'home and away required' });
  try {
    const results   = await getIntlResults();
    const homeAlias = toMartj42(home);
    const awayAlias = toMartj42(away);
    const h2h       = getH2HData(results, homeAlias, awayAlias);
    res.json({ home, away, ...h2h });
  } catch (err) {
    console.error('[WC H2H]', err.message);
    res.json({ home, away, total: 0, homeWins: 0, awayWins: 0, draws: 0, avgGoals: 0, last5: [], edge: null });
  }
});

// ─── football-data.org pipeline (non-PL leagues) ─────────────────────────────
// Free tier: 10 req/min, no commercial use.
// League codes: PD=La Liga, BL1=Bundesliga, FL1=Ligue 1, SA=Serie A

const FD_BASE = 'https://api.football-data.org/v4';
const FD_KEY  = process.env.FOOTBALL_DATA_API_KEY;

// Internal leagueId → football-data.org competition code
const FD_CODE = {
  'premier-league': 'PL',
  'la-liga':        'PD',
  'bundesliga':     'BL1',
  'ligue-1':        'FL1',
  'serie-a':        'SA',
  'brasileirao':    'BSA',
  'eredivisie':     'DED',
  'primeira-liga':  'PPL',
};

async function fdFetch(path) {
  if (!FD_KEY) throw new Error('FOOTBALL_DATA_API_KEY not set');
  const res = await fetch(`${FD_BASE}${path}`, {
    headers: { 'X-Auth-Token': FD_KEY },
  });
  if (!res.ok) throw new Error(`football-data.org ${res.status}: ${path}`);
  return res.json();
}

// Normalise a fd match object into a simple shape the UI can consume
function normaliseFdMatch(m, competitionCode) {
  const homeGoals = m.score?.fullTime?.home ?? null;
  const awayGoals = m.score?.fullTime?.away ?? null;
  return {
    id:           m.id,
    competition:  competitionCode,
    matchday:     m.matchday,
    kickoffTime:  m.utcDate,
    status:       m.status,                 // SCHEDULED | FINISHED | IN_PLAY | etc.
    finished:     m.status === 'FINISHED',
    homeTeam: {
      id:        m.homeTeam.id,
      name:      m.homeTeam.name,
      shortName: m.homeTeam.shortName ?? m.homeTeam.tla ?? m.homeTeam.name,
      crest:     m.homeTeam.crest,
    },
    awayTeam: {
      id:        m.awayTeam.id,
      name:      m.awayTeam.name,
      shortName: m.awayTeam.shortName ?? m.awayTeam.tla ?? m.awayTeam.name,
      crest:     m.awayTeam.crest,
    },
    homeGoals,
    awayGoals,
  };
}

// In-flight deduplication map — prevents thundering-herd rate-limit exhaustion
// when multiple fixture cards fetch predictions simultaneously with a cold cache.
const FD_MATCHES_INFLIGHT = new Map(); // competition code → Promise<allMatches>

async function getFdMatches(code) {
  const cacheKey = `fd_matches_${code}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;

  // If a fetch is already in-flight for this code, share that promise
  if (FD_MATCHES_INFLIGHT.has(code)) return FD_MATCHES_INFLIGHT.get(code);

  const promise = fdFetch(`/competitions/${code}/matches`)
    .then(data => {
      const matches = (data.matches ?? [])
        .sort((a, b) => a.matchday - b.matchday || new Date(a.utcDate) - new Date(b.utcDate))
        .map(m => normaliseFdMatch(m, code));
      setCache(cacheKey, matches, TTL.XPTS);
      return matches;
    })
    .finally(() => FD_MATCHES_INFLIGHT.delete(code));

  FD_MATCHES_INFLIGHT.set(code, promise);
  return promise;
}

// GET /api/fd/standings?league=la-liga
app.get('/api/fd/standings', async (req, res) => {
  const leagueId = req.query.league;
  const code     = FD_CODE[leagueId];
  if (!code) return res.status(400).json({ error: `Unknown league: ${leagueId}` });

  const cacheKey = `fd_standings_${code}`;
  const cached   = getCache(cacheKey);
  if (cached) return res.json(cached);

  try {
    const data  = await fdFetch(`/competitions/${code}/standings`);
    const table = data.standings?.find(s => s.type === 'TOTAL')?.table ?? [];
    const rows  = table.map(r => ({
      position: r.position,
      teamId:   r.team.id,
      name:     r.team.name,
      shortName: r.team.shortName ?? r.team.tla ?? r.team.name,
      crest:    r.team.crest,
      played:   r.playedGames,
      won:      r.won,
      drawn:    r.draw,
      lost:     r.lost,
      goalsFor: r.goalsFor,
      goalsAgainst: r.goalsAgainst,
      gd:       r.goalDifference,
      points:   r.points,
      form:     r.form,          // e.g. "W,D,L,W,W"
    }));
    setCache(cacheKey, rows, TTL.TABLE);
    res.json(rows);
  } catch (err) {
    console.error('[FD standings]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/fd/predicted-table?league=la-liga
// Simulates the remaining season using expected points from the model and
// adds them to the current standings to produce a projected final table.
app.get('/api/fd/predicted-table', async (req, res) => {
  const leagueId = req.query.league;
  const code     = FD_CODE[leagueId];
  if (!code) return res.status(400).json({ error: `Unknown league: ${leagueId}` });

  const cacheKey = `fd_pred_table_${code}`;
  const cached   = getCache(cacheKey);
  if (cached) return res.json(cached);

  try {
    const [allMatches, standingsRaw, xgRaw] = await Promise.all([
      getFdMatches(code),
      fdFetch(`/competitions/${code}/standings`),
      fetchUnderstatXGForLeague(leagueId),
    ]);

    const table = standingsRaw.standings?.find(s => s.type === 'TOTAL')?.table ?? [];

    // Build team map from current standings
    const teamMap = new Map();
    for (const r of table) {
      teamMap.set(r.team.id, {
        teamId:       r.team.id,
        name:         r.team.name,
        shortName:    r.team.shortName ?? r.team.tla ?? r.team.name,
        crest:        r.team.crest,
        currentPos:   r.position,
        played:       r.playedGames,
        won:          r.won,
        drawn:        r.draw,
        lost:         r.lost,
        goalsFor:     r.goalsFor,
        goalsAgainst: r.goalsAgainst,
        gd:           r.goalDifference,
        points:       r.points,
        xPts:         0,   // expected points from remaining fixtures
        gamesLeft:    0,
      });
    }

    // Build prediction engine inputs (same as /api/fd/predictions)
    const leagueAvg      = calcFdLeagueAverages(allMatches);
    const fplShape       = fdMatchesToFplShape(allMatches);
    const formData       = buildFdFormData(allMatches);
    const rollingRatings = buildRollingRatings(fplShape, leagueAvg.home, leagueAvg.away);
    const eloRatings     = buildEloRatings(fplShape);

    const nameMap = FD_TO_UNDERSTAT_NAME[leagueId] ?? {};
    const xGData  = {};
    for (const m of allMatches) {
      for (const side of ['homeTeam', 'awayTeam']) {
        const team = m[side];
        if (xGData[team.id]) continue;
        const usTitle = nameMap[team.name] ?? team.name;
        if (xgRaw[usTitle]) xGData[team.id] = xgRaw[usTitle];
      }
    }

    // For each unfinished fixture, add expected points to both teams
    const remaining = allMatches.filter(m => !m.finished);
    for (const match of remaining) {
      const pred = predict({
        homeTeam:      { id: match.homeTeam.id, name: match.homeTeam.name },
        awayTeam:      { id: match.awayTeam.id, name: match.awayTeam.name },
        leagueAvgHome: leagueAvg.home,
        leagueAvgAway: leagueAvg.away,
        xGData,
        formData,
        h2hData:       [],
        marketOdds:    null,
        homeInjuries:  0,
        awayInjuries:  0,
        rollingRatings,
        eloRatings,
      });

      const homeXP = pred.homeWin * 3 + pred.draw;
      const awayXP = pred.awayWin * 3 + pred.draw;

      if (teamMap.has(match.homeTeam.id)) {
        const t = teamMap.get(match.homeTeam.id);
        t.xPts      += homeXP;
        t.gamesLeft += 1;
      }
      if (teamMap.has(match.awayTeam.id)) {
        const t = teamMap.get(match.awayTeam.id);
        t.xPts      += awayXP;
        t.gamesLeft += 1;
      }
    }

    // Build projected table sorted by projectedPoints then GD
    const projected = [...teamMap.values()]
      .map(t => ({ ...t, projectedPoints: t.points + t.xPts }))
      .sort((a, b) => b.projectedPoints - a.projectedPoints || b.gd - a.gd)
      .map((t, i) => ({ ...t, projectedPosition: i + 1 }));

    setCache(cacheKey, projected, 1800); // 30 min cache
    res.json(projected);
  } catch (err) {
    console.error('[FD predicted table]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/fd/fixtures?league=la-liga  — upcoming (SCHEDULED/TIMED) matches
app.get('/api/fd/fixtures', async (req, res) => {
  const leagueId = req.query.league;
  const code     = FD_CODE[leagueId];
  if (!code) return res.status(400).json({ error: `Unknown league: ${leagueId}` });

  const cacheKey = `fd_fixtures_${code}`;
  const cached   = getCache(cacheKey);
  if (cached) return res.json(cached);

  try {
    const data    = await fdFetch(`/competitions/${code}/matches?status=SCHEDULED,TIMED`);
    const matches = (data.matches ?? [])
      .sort((a, b) => new Date(a.utcDate) - new Date(b.utcDate))
      .slice(0, 40)
      .map(m => normaliseFdMatch(m, code));
    setCache(cacheKey, matches, TTL.XPTS);
    res.json(matches);
  } catch (err) {
    console.error('[FD fixtures]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/fd/matches?league=la-liga  — ALL matches (scheduled + finished), for matchday browser
app.get('/api/fd/matches', async (req, res) => {
  const leagueId = req.query.league;
  const code     = FD_CODE[leagueId];
  if (!code) return res.status(400).json({ error: `Unknown league: ${leagueId}` });

  try {
    const matches = await getFdMatches(code);
    res.json(matches);
  } catch (err) {
    console.error('[FD matches]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/fd/results?league=la-liga  — recent finished matches
app.get('/api/fd/results', async (req, res) => {
  const leagueId = req.query.league;
  const code     = FD_CODE[leagueId];
  if (!code) return res.status(400).json({ error: `Unknown league: ${leagueId}` });

  const cacheKey = `fd_results_${code}`;
  const cached   = getCache(cacheKey);
  if (cached) return res.json(cached);

  try {
    const data    = await fdFetch(`/competitions/${code}/matches?status=FINISHED`);
    const matches = (data.matches ?? [])
      .sort((a, b) => new Date(b.utcDate) - new Date(a.utcDate))
      .slice(0, 20)
      .map(m => normaliseFdMatch(m, code));
    setCache(cacheKey, matches, TTL.XPTS);
    res.json(matches);
  } catch (err) {
    console.error('[FD results]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── FD prediction helpers ────────────────────────────────────────────────────

// Build form data from normalised FD matches (same shape as PL buildFormData)
// buildFdFormData — now delegates to core buildFormStats with FD accessors.
function buildFdFormData(allMatches) {
  const teamIds = [...new Set(allMatches.flatMap(m => [m.homeTeam.id, m.awayTeam.id]))];
  return buildFormStats(allMatches, teamIds, FD_ACCESSORS, FORM_WEIGHTS);
}

// calcFdLeagueAverages — now delegates to core with FD accessors.
function calcFdLeagueAverages(allMatches) {
  return calcMatchAverages(allMatches, FD_ACCESSORS);
}

// Convert normalised FD match shape → FPL-like shape for buildRollingRatings / buildEloRatings
function fdMatchesToFplShape(allMatches) {
  return allMatches
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

// GET /api/fd/predictions?league=la-liga&fixtureId=<id>
app.get('/api/fd/predictions', async (req, res) => {
  const leagueId  = req.query.league;
  const fixtureId = Number(req.query.fixtureId);
  const code      = FD_CODE[leagueId];

  if (!code)      return res.status(400).json({ error: `Unknown league: ${leagueId}` });
  if (!fixtureId) return res.status(400).json({ error: 'fixtureId required' });

  const cacheKey = `fd_pred_${code}_${fixtureId}`;
  const cached   = getCache(cacheKey);
  if (cached) return res.json(cached);

  try {
    // Fetch match data and Understat xG in parallel
    const [allMatches, xgRaw] = await Promise.all([
      getFdMatches(code),
      fetchUnderstatXGForLeague(leagueId),
    ]);

    const match = allMatches.find(m => m.id === fixtureId);
    if (!match) return res.status(404).json({ error: 'Fixture not found' });

    // Build xGData keyed by FD team ID, translating FD full names → Understat titles.
    // Teams whose names match directly (same string) are picked up by the fallback.
    const nameMap = FD_TO_UNDERSTAT_NAME[leagueId] ?? {};
    const xGData  = {};
    for (const m of allMatches) {
      for (const side of ['homeTeam', 'awayTeam']) {
        const team = m[side];
        if (xGData[team.id]) continue;                         // already mapped
        const usTitle = nameMap[team.name] ?? team.name;       // translate or try direct
        if (xgRaw[usTitle]) xGData[team.id] = xgRaw[usTitle];
      }
    }

    const leagueAvg      = calcFdLeagueAverages(allMatches);
    const fplShape       = fdMatchesToFplShape(allMatches);
    const formData       = buildFdFormData(allMatches);
    const rollingRatings = buildRollingRatings(fplShape, leagueAvg.home, leagueAvg.away);
    const eloRatings     = buildEloRatings(fplShape);

    const fdHomeRestDays = getFdRestDays(match.homeTeam.id, match.kickoffTime, allMatches);
    const fdAwayRestDays = getFdRestDays(match.awayTeam.id, match.kickoffTime, allMatches);
    const fdTeamAdvFactors = buildTeamHomeAdvantage(fplShape);
    const fdTeamHomeAdvFactor = fdTeamAdvFactors[String(match.homeTeam.id)] ?? 1.0;

    const prediction = predict({
      homeTeam:      { id: match.homeTeam.id, name: match.homeTeam.name },
      awayTeam:      { id: match.awayTeam.id, name: match.awayTeam.name },
      leagueAvgHome: leagueAvg.home,
      leagueAvgAway: leagueAvg.away,
      xGData,
      formData,
      h2hData:       [],
      marketOdds:    null,
      homeInjuries:  0,
      awayInjuries:  0,
      rollingRatings,
      eloRatings,
      homeRestDays:     fdHomeRestDays,
      awayRestDays:     fdAwayRestDays,
      teamHomeAdvFactor: fdTeamHomeAdvFactor,
    });

    const result = {
      fixtureId,
      matchday:    match.matchday,
      kickoffTime: match.kickoffTime,
      homeTeam:    match.homeTeam,
      awayTeam:    match.awayTeam,
      prediction,
      generatedAt: new Date().toISOString(),
    };

    setCache(cacheKey, result, TTL.XPTS);

    // Save to prediction tracker if not already stored
    const alreadyTracked = history.predictions.find(
      p => p.fixtureId === fixtureId && p.league === leagueId
    );
    if (!alreadyTracked) {
      const immediateResult = match.finished && match.homeGoals != null
        ? { homeGoals: match.homeGoals, awayGoals: match.awayGoals, settledAt: new Date().toISOString() }
        : null;
      history.predictions.push({
        fixtureId,
        league:    leagueId,
        gameweek:  match.matchday,   // matchday used as gameweek equivalent
        kickoff:   match.kickoffTime,
        homeTeam:  match.homeTeam,
        awayTeam:  match.awayTeam,
        prediction,
        trackedAt: new Date().toISOString(),
        result:    immediateResult,
      });
      saveHistory(history);
    }

    res.json(result);
  } catch (err) {
    console.error('[FD predictions]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/fd/h2h?league=la-liga&homeTeamId=X&awayTeamId=Y
// Filters head-to-head from the cached all-matches data — zero extra FD API calls.
// Returns matches shaped for H2HPanel: { date, homeTeam, awayTeam, homeGoals, awayGoals }
app.get('/api/fd/h2h', async (req, res) => {
  const { league, homeTeamId, awayTeamId } = req.query;
  const code = FD_CODE[league];
  if (!code || !homeTeamId || !awayTeamId) {
    return res.status(400).json({ error: 'league, homeTeamId and awayTeamId required' });
  }

  const cacheKey = `fd_h2h_${code}_${homeTeamId}_${awayTeamId}`;
  const cached   = getCache(cacheKey);
  if (cached) return res.json(cached);

  try {
    const allMatches = await getFdMatches(code);

    const hId = Number(homeTeamId);
    const aId = Number(awayTeamId);

    const h2h = allMatches
      .filter(m => m.finished && m.homeGoals != null && (
        (m.homeTeam.id === hId && m.awayTeam.id === aId) ||
        (m.homeTeam.id === aId && m.awayTeam.id === hId)
      ))
      .sort((a, b) => new Date(b.kickoffTime) - new Date(a.kickoffTime))
      .slice(0, 10)
      .map(m => ({
        date:      m.kickoffTime,
        homeTeam:  m.homeTeam.name,
        awayTeam:  m.awayTeam.name,
        homeGoals: m.homeGoals,
        awayGoals: m.awayGoals,
      }));

    setCache(cacheKey, h2h, TTL.XPTS);
    res.json(h2h);
  } catch (err) {
    console.error('[FD H2H]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/fd/opponent-analysis?league=la-liga&opponentId=X&opponentName=Y&myTeamName=Z
// AI scout report derived from cached FD match data (no FPL dependency).
app.get('/api/fd/opponent-analysis', async (req, res) => {
  const { league, opponentId, opponentName, myTeamName = 'your team' } = req.query;
  const code = FD_CODE[league];
  if (!code || !opponentId || !opponentName) {
    return res.status(400).json({ error: 'league, opponentId and opponentName required' });
  }
  if (!groq) return res.status(503).json({ error: 'AI analysis not configured' });

  const cacheKey = `fd_opp_${code}_${opponentId}_${encodeURIComponent(myTeamName)}`;
  const cached   = getCache(cacheKey);
  if (cached) return res.json(cached);

  try {
    const allMatches = await getFdMatches(code);

    const oppId = Number(opponentId);
    const last5 = allMatches
      .filter(m => m.finished && m.homeGoals != null &&
        (m.homeTeam.id === oppId || m.awayTeam.id === oppId))
      .sort((a, b) => new Date(b.kickoffTime) - new Date(a.kickoffTime))
      .slice(0, 5);

    const formStr = last5.map(m => {
      const isHome = m.homeTeam.id === oppId;
      const tg = isHome ? m.homeGoals : m.awayGoals;
      const og = isHome ? m.awayGoals : m.homeGoals;
      return tg > og ? 'W' : tg < og ? 'L' : 'D';
    }).join('');

    const n  = last5.length || 1;
    const gf = last5.reduce((s, m) => s + (m.homeTeam.id === oppId ? m.homeGoals : m.awayGoals), 0);
    const ga = last5.reduce((s, m) => s + (m.homeTeam.id === oppId ? m.awayGoals : m.homeGoals), 0);

    const resultsSummary = last5.map(m => {
      const isHome  = m.homeTeam.id === oppId;
      const opp     = isHome ? m.awayTeam.name : m.homeTeam.name;
      const score   = `${m.homeGoals}–${m.awayGoals}`;
      const venue   = isHome ? 'H' : 'A';
      const r       = (isHome ? m.homeGoals > m.awayGoals : m.awayGoals > m.homeGoals) ? 'W'
                    : m.homeGoals === m.awayGoals ? 'D' : 'L';
      return `${r} ${venue} vs ${opp} (${score})`;
    }).join(', ');

    const systemPrompt = `You are an elite football scout writing for ${myTeamName}'s coaching staff. Be sharp, specific, and analytical — no fluff. Use **bold** for key stats and tactical observations. Under 260 words. Do NOT name individual players unless their name appears in the data provided — describe team-level patterns only.`;
    const userPrompt   = `Scout report: **${opponentName}** as ${myTeamName}'s upcoming opponent.

Last 5 form: ${formStr || 'unknown'}
Avg goals scored per game: ${(gf / n).toFixed(2)}
Avg goals conceded per game: ${(ga / n).toFixed(2)}
Recent results (${n} games): ${resultsSummary || 'No data'}

Cover in 3 tight paragraphs: (1) attacking threat and danger patterns, (2) defensive vulnerabilities ${myTeamName} can exploit, (3) the key tactical battle that will decide the game.`;

    const analysis = await groqChat([
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPrompt },
    ]);

    const result = { opponentId: oppId, opponentName, analysis, formStr };
    setCache(cacheKey, result, TTL.XG);
    res.json(result);
  } catch (err) {
    console.error('[FD opponent-analysis]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/fd/scorers?league=la-liga  — top scorers from FD API
app.get('/api/fd/scorers', async (req, res) => {
  const leagueId = req.query.league;
  const code     = FD_CODE[leagueId];
  if (!code) return res.status(400).json({ error: `Unknown league: ${leagueId}` });

  const cacheKey = `fd_scorers_${code}`;
  const cached   = getCache(cacheKey);
  if (cached) return res.json(cached);

  try {
    const data    = await fdFetch(`/competitions/${code}/scorers?limit=20`);
    const scorers = (data.scorers ?? []).map((s, i) => ({
      rank:    i + 1,
      player:  { id: s.player.id, name: s.player.name, nationality: s.player.nationality ?? null },
      team: {
        id:        s.team.id,
        name:      s.team.name,
        shortName: s.team.shortName ?? s.team.tla ?? s.team.name,
        crest:     s.team.crest ?? null,
      },
      goals:        s.goals      ?? 0,
      assists:      s.assists    ?? 0,
      penalties:    s.penalties  ?? 0,
      playedMatches: s.playedMatches ?? 0,
    }));
    setCache(cacheKey, scorers, TTL.XG);   // 1-hour cache — changes infrequently
    res.json(scorers);
  } catch (err) {
    console.error('[FD scorers]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Background: bulk prediction pre-generation ──────────────────────────────
// Runs every hour at :45 to pre-generate predictions for all upcoming fixtures
// across every league so stats/accuracy tracking starts from kickoff, not first
// user visit. Uses the same model path as the on-demand endpoints.
// All data sources (FD matches, xG, odds, rolling ratings) are cached so this
// function adds virtually no extra API cost when the caches are warm.

async function preFillPredictions() {
  let generated = 0;

  // ── Premier League ──────────────────────────────────────────────────────────
  try {
    const [bs, allFixtures, xgRaw, oddsMap, rollingRatings, eloRatings] =
      await Promise.all([
        fetchBootstrap(),
        fetchFixtures(),
        fetchUnderstatXG(),
        fetchOdds().catch(() => ({})),
        getRollingRatings(),
        getEloRatings(),
      ]);

    const { teams }  = bs;
    const formDataPL = await buildFormData(allFixtures, teams, null);
    const leagueAvg  = calcLeagueAverages(allFixtures);
    const allRefStats = buildRefereeStats(allFixtures);

    const xGData = {};
    for (const team of teams) {
      const usName = UNDERSTAT_NAME_MAP[team.name] ?? team.name;
      if (xgRaw[usName]) xGData[team.id] = xgRaw[usName];
    }

    const plTeamAdvFactors = buildTeamHomeAdvantage(allFixtures);
    const upcoming = allFixtures.filter(f => !isFixtureSettled(f) && f.kickoff_time);
    for (const fix of upcoming) {
      const alreadyTracked = history.predictions.find(
        p => p.fixtureId === fix.id && (!p.league || p.league === 'premier-league')
      );
      if (alreadyTracked) continue;

      const homeTeam = teams.find(t => t.id === fix.team_h);
      const awayTeam = teams.find(t => t.id === fix.team_a);
      if (!homeTeam || !awayTeam) continue;

      const marketOdds = oddsMap[`${homeTeam.name}_${awayTeam.name}`] ?? null;
      const plHomeRest = getRestDays(homeTeam.id, fix.kickoff_time, allFixtures);
      const plAwayRest = getRestDays(awayTeam.id, fix.kickoff_time, allFixtures);
      const plHomeAdv  = plTeamAdvFactors[String(homeTeam.id)] ?? 1.0;

      const prediction = predict({
        homeTeam:      { id: homeTeam.id, name: homeTeam.name },
        awayTeam:      { id: awayTeam.id, name: awayTeam.name },
        leagueAvgHome: leagueAvg.home,
        leagueAvgAway: leagueAvg.away,
        xGData,
        formData:      formDataPL,
        h2hData:       [],
        marketOdds,
        homeInjuries:  0,
        awayInjuries:  0,
        rollingRatings,
        eloRatings,
        homeRestDays:     plHomeRest,
        awayRestDays:     plAwayRest,
        teamHomeAdvFactor: plHomeAdv,
      });

      history.predictions.push({
        fixtureId:  fix.id,
        league:     'premier-league',
        gameweek:   fix.event,
        kickoff:    fix.kickoff_time,
        homeTeam:   { id: homeTeam.id, name: homeTeam.name, short: homeTeam.short_name, shortName: homeTeam.short_name, code: homeTeam.code },
        awayTeam:   { id: awayTeam.id, name: awayTeam.name, short: awayTeam.short_name, shortName: awayTeam.short_name, code: awayTeam.code },
        prediction,
        trackedAt:  new Date().toISOString(),
        result:     null,
      });
      generated++;
    }
  } catch (err) {
    console.warn('[PreFill PL]', err.message);
  }

  // ── FD leagues (La Liga, Bundesliga, Ligue 1, Serie A) ─────────────────────
  for (const leagueId of Object.keys(FD_CODE)) {
    try {
      const code = FD_CODE[leagueId];

      const [allMatches, xgRaw] = await Promise.all([
        getFdMatches(code),
        fetchUnderstatXGForLeague(leagueId),
      ]);

      // Build xGData keyed by FD team ID
      const nameMap = FD_TO_UNDERSTAT_NAME[leagueId] ?? {};
      const xGData  = {};
      for (const m of allMatches) {
        for (const side of ['homeTeam', 'awayTeam']) {
          const team = m[side];
          if (xGData[team.id]) continue;
          const usTitle = nameMap[team.name] ?? team.name;
          if (xgRaw[usTitle]) xGData[team.id] = xgRaw[usTitle];
        }
      }

      const leagueAvg      = calcFdLeagueAverages(allMatches);
      const fplShape       = fdMatchesToFplShape(allMatches);
      const formData       = buildFdFormData(allMatches);
      const rollingRatings = buildRollingRatings(fplShape, leagueAvg.home, leagueAvg.away);
      const eloRatings     = buildEloRatings(fplShape);
      const fdBulkAdvFactors = buildTeamHomeAdvantage(fplShape);

      const upcoming = allMatches.filter(m => !m.finished && m.kickoffTime);
      for (const match of upcoming) {
        const alreadyTracked = history.predictions.find(
          p => p.fixtureId === match.id && p.league === leagueId
        );
        if (alreadyTracked) continue;

        const bulkHomeRest = getFdRestDays(match.homeTeam.id, match.kickoffTime, allMatches);
        const bulkAwayRest = getFdRestDays(match.awayTeam.id, match.kickoffTime, allMatches);
        const bulkHomeAdv  = fdBulkAdvFactors[String(match.homeTeam.id)] ?? 1.0;

        const prediction = predict({
          homeTeam:      { id: match.homeTeam.id, name: match.homeTeam.name },
          awayTeam:      { id: match.awayTeam.id, name: match.awayTeam.name },
          leagueAvgHome: leagueAvg.home,
          leagueAvgAway: leagueAvg.away,
          xGData,
          formData,
          h2hData:       [],
          marketOdds:    null,
          homeInjuries:  0,
          awayInjuries:  0,
          rollingRatings,
          eloRatings,
          homeRestDays:     bulkHomeRest,
          awayRestDays:     bulkAwayRest,
          teamHomeAdvFactor: bulkHomeAdv,
        });

        history.predictions.push({
          fixtureId:  match.id,
          league:     leagueId,
          gameweek:   match.matchday,
          kickoff:    match.kickoffTime,
          homeTeam:   match.homeTeam,
          awayTeam:   match.awayTeam,
          prediction,
          trackedAt:  new Date().toISOString(),
          result:     null,
        });
        generated++;
      }
    } catch (err) {
      console.warn(`[PreFill ${leagueId}]`, err.message);
    }
  }

  if (generated > 0) {
    saveHistory(history);
    console.log(`[PreFill] Generated ${generated} new prediction(s)`);
  }
}

// ─── Cron jobs ────────────────────────────────────────────────────────────────

cron.schedule('0 * * * *',    autoFillResults);            // every hour — PL
cron.schedule('30 * * * *',   autoFillFdResults);          // every hour, staggered — FD leagues
cron.schedule('45 * * * *',   preFillPredictions);         // every hour — pre-generate all leagues
cron.schedule('*/15 * * * *', checkKickoffNotifications);  // every 15 min
cron.schedule('0 8 * * *',    checkSeasonRollover);        // daily at 8am
cron.schedule('0 6 * * *',    initDynamicElo);              // daily at 6am — refresh WC ELO from martj42

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
      res.status(200).send('MatchIQ API running. Start the frontend with: npm run client');
    }
  });
}

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, async () => {
  console.log(`\n⚽ MatchIQ backend running on http://localhost:${PORT}`);
  console.log(`   Groq:     ${groq ? '✅ connected' : '❌ no GROQ_API_KEY'}`);
  console.log(`   Push:     ${process.env.VAPID_PUBLIC_KEY ? '✅ configured' : '⚠️  no VAPID keys'}`);
  console.log(`   Supabase: ${supabase ? '✅ connected' : '⚠️  no SUPABASE_URL/KEY — using local files'}\n`);

  // Load persistent data from Supabase (or fall back to local files)
  history = await loadHistory();

  // Build dynamic ELO from international results before freezing WC predictions
  await initDynamicElo();
  await initWcPrePredictions();

  checkSeasonRollover();
  runHealthChecks();
  backfillPendingResults();
  autoFillResults();
  autoFillFdResults();
  preFillPredictions();
});
