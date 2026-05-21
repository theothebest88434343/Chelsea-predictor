'use strict';

/**
 * core/observability/logger.js
 *
 * Structured log emitter for all three pipelines.
 *
 * FORMAT (matches task specification):
 * {
 *   system:    "WC | PL | FD | SYSTEM",
 *   stage:     "elo | poisson | simulation | prediction | cache | startup | api",
 *   matchId?:  string,
 *   timestamp: ISO string,
 *   level:     "debug | info | warn | error",
 *   message:   string,
 *   metrics:   { ... },
 *   warnings:  string[],
 *   errors:    string[],
 * }
 *
 * In NODE_ENV=production the full JSON record is written to process.stderr
 * (structured logs belong on stderr; stdout is API output).
 * In development a compact human-readable line goes to console.
 *
 * The module is PURE — no network or file I/O.  Callers decide what to do
 * with the emitted records (write to file, send to Supabase, etc.) by
 * attaching a transport via logger.addTransport(fn).
 *
 * USAGE:
 *   const log = require('./core/observability/logger');
 *   log.info({ system:'WC', stage:'elo', message:'Built dynamic ELO',
 *               metrics:{ teams: 48, topRated: 'Argentina' } });
 *   log.warn({ system:'FD', stage:'api', message:'Rate limited — retrying',
 *               errors: ['HTTP 429'] });
 */

// ─── Config ───────────────────────────────────────────────────────────────────

const IS_PROD   = process.env.NODE_ENV === 'production';
const IS_TEST   = process.env.NODE_ENV === 'test';
const LOG_LEVEL = (process.env.LOG_LEVEL ?? 'info').toLowerCase();

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const MIN_LEVEL = LEVELS[LOG_LEVEL] ?? LEVELS.info;

const VALID_SYSTEMS = new Set(['PL', 'FD', 'WC', 'SYSTEM', 'MONITOR', 'CACHE', 'TEST']);
const VALID_STAGES  = new Set([
  'elo', 'poisson', 'simulation', 'prediction',
  'cache', 'startup', 'api', 'monitor', 'config', 'init',
]);

// ─── Transport registry ───────────────────────────────────────────────────────
// Callers may attach custom transports (e.g. write to Supabase, push to monitor)
// Transport: (record) => void — must not throw.

const _transports = [];

function addTransport(fn) {
  if (typeof fn !== 'function') throw new TypeError('transport must be a function');
  _transports.push(fn);
}

function removeTransports() { _transports.length = 0; }  // useful in tests

// ─── Record builder ───────────────────────────────────────────────────────────

function buildRecord(level, {
  system   = 'SYSTEM',
  stage    = 'init',
  matchId  = undefined,
  message  = '',
  metrics  = {},
  warnings = [],
  errors   = [],
} = {}) {
  const record = {
    timestamp: new Date().toISOString(),
    level,
    system:  VALID_SYSTEMS.has(system)  ? system  : 'SYSTEM',
    stage:   VALID_STAGES.has(stage)    ? stage   : 'init',
    message: String(message),
    metrics:  metrics  ?? {},
    warnings: Array.isArray(warnings) ? warnings : [String(warnings)],
    errors:   Array.isArray(errors)   ? errors   : [String(errors)],
  };
  if (matchId != null) record.matchId = String(matchId);
  return record;
}

// ─── Emit ─────────────────────────────────────────────────────────────────────

function emit(level, payload) {
  if ((LEVELS[level] ?? 0) < MIN_LEVEL) return;   // below configured threshold
  if (IS_TEST) return;                             // silence during unit tests

  const record = buildRecord(level, payload);

  // ── Console output ─────────────────────────────────────────────────────────
  if (IS_PROD) {
    // Production: machine-readable JSON on stderr
    try { process.stderr.write(JSON.stringify(record) + '\n'); } catch { /* swallow */ }
  } else {
    // Development: human-readable one-liner
    const prefix = `[${record.system}:${record.stage}]`;
    const ts     = record.timestamp.slice(11, 23);  // HH:MM:SS.mmm
    const fn     = level === 'error' ? console.error
                 : level === 'warn'  ? console.warn
                 : console.log;
    fn(`${ts} ${prefix} ${record.message}`,
       Object.keys(record.metrics).length  ? record.metrics  : '',
       record.warnings.length              ? record.warnings  : '',
       record.errors.length                ? record.errors    : '',
    );
  }

  // ── Custom transports ──────────────────────────────────────────────────────
  for (const t of _transports) {
    try { t(record); } catch { /* transports must not crash the caller */ }
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

const logger = {
  debug: payload => emit('debug', payload),
  info:  payload => emit('info',  payload),
  warn:  payload => emit('warn',  payload),
  error: payload => emit('error', payload),

  addTransport,
  removeTransports,

  /** Build a child logger pre-bound to a system + stage */
  child({ system, stage }) {
    return {
      debug: p => logger.debug({ system, stage, ...p }),
      info:  p => logger.info( { system, stage, ...p }),
      warn:  p => logger.warn( { system, stage, ...p }),
      error: p => logger.error({ system, stage, ...p }),
    };
  },
};

module.exports = logger;
