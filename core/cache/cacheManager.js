'use strict';

/**
 * core/cache/cacheManager.js
 *
 * Unified cache layer for all three pipelines.
 *
 * DESIGN
 * ══════
 * Replaces the bare `new Map()` + inline setCache/getCache pattern in server.js.
 * Behavior is IDENTICAL — same Map backing store, same TTL logic.
 * The added surface area is:
 *
 *   invalidate(prefix)  — delete all keys starting with prefix
 *   clearAll()          — wipe everything (used by tests / model-version bumps)
 *   getCacheHealth()    — live stats (hit rate, entry count, oldest/newest entry)
 *   persist / load      — optional JSON-file persistence for a named slot
 *                         (replaces direct fs.writeFileSync calls in server.js)
 *
 * USAGE:
 *   const cache = require('./core/cache/cacheManager');
 *
 *   cache.set('bootstrap', data, 5 * 60 * 1000);  // TTL in ms
 *   const data = cache.get('bootstrap');           // null if expired / missing
 *
 *   cache.invalidate('wc_');     // drop all keys beginning with 'wc_'
 *   cache.clearAll();            // full reset (model version bump, etc.)
 *
 *   // Persistent slot (replaces fs.writeFileSync for monitor-log, diagnostics etc.)
 *   await cache.persistSlot('monitor-log', entries);
 *   const entries = await cache.loadSlot('monitor-log');
 *
 * RULE: All caching in the system goes through this module.
 */

const fs   = require('fs');
const path = require('path');

const logger = require('../observability/logger');

// ─── Backing store ────────────────────────────────────────────────────────────

const _store = new Map();   // key → { value, expires }

// ─── Statistics ───────────────────────────────────────────────────────────────

let _hits   = 0;
let _misses = 0;
let _sets   = 0;

// ─── Core operations ──────────────────────────────────────────────────────────

/**
 * Retrieve a cached value.
 *
 * @param {string} key
 * @returns {*} stored value, or null if missing / expired
 */
function get(key) {
  const entry = _store.get(key);
  if (!entry) { _misses++; return null; }
  if (Date.now() > entry.expires) {
    _store.delete(key);
    _misses++;
    return null;
  }
  _hits++;
  return entry.value;
}

/**
 * Store a value with a TTL.
 *
 * @param {string} key
 * @param {*}      value
 * @param {number} ttlMs  — milliseconds until expiry
 */
function set(key, value, ttlMs) {
  if (typeof ttlMs !== 'number' || ttlMs <= 0) {
    throw new RangeError(`cacheManager.set: ttlMs must be a positive number, got ${ttlMs}`);
  }
  _store.set(key, { value, expires: Date.now() + ttlMs });
  _sets++;
}

/**
 * Delete a single key.
 *
 * @param {string} key
 * @returns {boolean} true if the key existed
 */
function del(key) {
  return _store.delete(key);
}

/**
 * Delete all keys whose name starts with the given prefix.
 *
 * @param {string} prefix
 * @returns {number} count of deleted entries
 */
function invalidate(prefix) {
  let count = 0;
  for (const key of _store.keys()) {
    if (key.startsWith(prefix)) { _store.delete(key); count++; }
  }
  if (count > 0) {
    logger.info({ system: 'CACHE', stage: 'cache',
      message: `Invalidated ${count} entries with prefix "${prefix}"`,
      metrics: { prefix, count } });
  }
  return count;
}

/**
 * Clear all cached entries and reset statistics.
 * Use this on model version bumps or test teardown.
 */
function clearAll() {
  const count = _store.size;
  _store.clear();
  _hits = _misses = _sets = 0;
  logger.info({ system: 'CACHE', stage: 'cache',
    message: `Cache cleared — ${count} entries removed` });
}

// ─── Health / inspection ──────────────────────────────────────────────────────

/**
 * Returns live statistics about the cache.
 *
 * @returns {Object}
 */
function getCacheHealth() {
  const now     = Date.now();
  let   expired = 0;
  let   oldest  = Infinity;
  let   newest  = 0;
  const keys    = [];

  for (const [key, entry] of _store.entries()) {
    if (entry.expires <= now) { expired++; continue; }
    const ttlLeft = entry.expires - now;
    if (ttlLeft < oldest) oldest = ttlLeft;
    if (ttlLeft > newest) newest = ttlLeft;
    keys.push(key);
  }

  const total    = _hits + _misses;
  const hitRate  = total > 0 ? +(_hits / total * 100).toFixed(1) : null;

  return {
    entries:         keys.length,
    expiredPending:  expired,
    hitRate,
    hits:            _hits,
    misses:          _misses,
    sets:            _sets,
    oldestTtlMs:     oldest === Infinity ? null : Math.round(oldest),
    newestTtlMs:     newest === 0        ? null : Math.round(newest),
    keys,
  };
}

// ─── File persistence helpers ─────────────────────────────────────────────────
// These replace the scattered fs.writeFileSync / fs.readFileSync calls in
// server.js that manage monitor-log.json, diagnostics-snapshot.json, etc.
//
// A "slot" is a named JSON file in the project root.  The slot name is mapped
// to a file path via SLOT_PATHS.  Callers never touch paths directly.

const SLOT_PATHS = {
  'monitor-log':            path.join(__dirname, '../../monitor-log.json'),
  'diagnostics-snapshot':   path.join(__dirname, '../../diagnostics-snapshot.json'),
  'prediction-history':     path.join(__dirname, '../../prediction-history.json'),
  'market-history':         path.join(__dirname, '../../market-history.json'),
  'wc-pre-predictions':     path.join(__dirname, '../../wc-pre-predictions.json'),
};

/**
 * Write data to a named persistence slot (async, non-blocking on error).
 *
 * @param {string} slot   — key in SLOT_PATHS
 * @param {*}      data   — must be JSON-serialisable
 * @returns {Promise<boolean>} true on success
 */
async function persistSlot(slot, data) {
  const slotPath = SLOT_PATHS[slot];
  if (!slotPath) {
    logger.warn({ system: 'CACHE', stage: 'cache',
      message: `persistSlot: unknown slot "${slot}"`,
      errors:  [`Known slots: ${Object.keys(SLOT_PATHS).join(', ')}`] });
    return false;
  }
  try {
    fs.writeFileSync(slotPath, JSON.stringify(data), 'utf8');
    return true;
  } catch (err) {
    logger.error({ system: 'CACHE', stage: 'cache',
      message: `persistSlot failed for slot "${slot}"`,
      errors:  [err.message] });
    return false;
  }
}

/**
 * Load data from a named persistence slot.
 *
 * @param {string} slot
 * @returns {*|null}  parsed JSON, or null if file missing / corrupt
 */
function loadSlot(slot) {
  const slotPath = SLOT_PATHS[slot];
  if (!slotPath) return null;
  try {
    if (!fs.existsSync(slotPath)) return null;
    return JSON.parse(fs.readFileSync(slotPath, 'utf8'));
  } catch (err) {
    logger.warn({ system: 'CACHE', stage: 'cache',
      message: `loadSlot failed for slot "${slot}"`,
      errors:  [err.message] });
    return null;
  }
}

/**
 * Register a new named persistence slot at runtime.
 * Useful for server.js to add slots not known at module-load time.
 *
 * @param {string} slot
 * @param {string} filePath  absolute path
 */
function registerSlot(slot, filePath) {
  SLOT_PATHS[slot] = filePath;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  // Core operations
  get,
  set,
  del,
  invalidate,
  clearAll,

  // Inspection
  getCacheHealth,

  // File persistence
  persistSlot,
  loadSlot,
  registerSlot,

  // Expose slot paths for introspection (read-only copy)
  get slotPaths() { return { ...SLOT_PATHS }; },
};
