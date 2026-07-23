/**
 * src/config/index.js
 *
 * Loads customers.json once at process startup, validates it, and exposes
 * getCandidateLimits(customerId) for the rate-limit middleware.
 *
 * Design note — why this module no longer resolves a single "effectiveRpm":
 *   The previous design called resolveEffectiveLimit(customerId, nowSeconds)
 *   here in app-node JS, which meant the override-window comparison ran on the
 *   app node's own notion of time. Even though nowSeconds was sourced from Redis
 *   TIME *after* the Lua call, the effectiveRpm passed *into* the Lua call was
 *   evaluated with nowSeconds=0 (a placeholder), making window matching wrong.
 *   Worse, any redesign that passes a real timestamp from the app node reopens
 *   the cross-node clock-drift risk the Lua TIME call was meant to close.
 *
 *   Fix: the app node now exports the *full set of candidate limits* (base + any
 *   active override candidates) with their window boundaries converted to
 *   seconds-since-midnight-UTC. The Lua script receives this candidate set as
 *   ARGV parameters, calls redis.call('TIME') itself, computes
 *   epochSeconds % 86400 to get UTC time-of-day, and selects the matching
 *   candidate — all atomically, with Redis as the sole clock source.
 *
 * Intentional limitations (documented):
 *  - No hot-reload. A config change requires a process restart.
 *  - Tier defaults are only consulted for *named* customers (via their `tier`
 *    field), never used as a wildcard fallback for unknown IDs.
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Load and parse
// ---------------------------------------------------------------------------

let raw;
try {
  raw = readFileSync(join(__dirname, 'customers.json'), 'utf8');
} catch (err) {
  console.error('[CONFIG] Fatal: could not read customers.json:', err.message);
  process.exit(1);
}

let config;
try {
  config = JSON.parse(raw);
} catch (err) {
  console.error('[CONFIG] Fatal: customers.json is not valid JSON:', err.message);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Startup validation
// ---------------------------------------------------------------------------

/**
 * Required fields for every override object.
 * Missing any of these is a hard startup failure — we never load a malformed
 * or undocumented override silently.
 */
const REQUIRED_OVERRIDE_FIELDS = ['name', 'reason', 'window', 'owner', 'reviewDate', 'effectiveRpm', 'active'];

for (const [customerId, customer] of Object.entries(config.customers ?? {})) {
  for (const override of customer.overrides ?? []) {
    const missing = REQUIRED_OVERRIDE_FIELDS.filter((f) => !(f in override));
    if (missing.length > 0) {
      console.error(
        `[CONFIG] Fatal: override "${override.name ?? '(unnamed)'}" for customer "${customerId}" ` +
        `is missing required field(s): ${missing.join(', ')}`
      );
      process.exit(1);
    }
  }
}

console.log(
  `[CONFIG] Loaded ${Object.keys(config.customers ?? {}).length} customer(s), ` +
  `${Object.keys(config.tiers ?? {}).length} tier(s).`
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a "HH:MM" UTC string to total seconds since midnight UTC.
 * Used only to pre-compute window boundaries for the Lua ARGV payload —
 * the actual window comparison happens inside the Lua script using Redis TIME.
 *
 * @param {string} hhmm
 * @returns {number}
 */
function parseHHMMtoSeconds(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 3600 + m * 60;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} CandidateLimit
 * @property {number}  rpm        - The RPM limit for this candidate.
 * @property {number}  startSec   - Window start in seconds-since-midnight-UTC (0–86399).
 *                                  For the base limit, pass 0.
 * @property {number}  endSec     - Window end in seconds-since-midnight-UTC (0–86399).
 *                                  For the base limit, pass 86400 (full day = always active).
 * @property {boolean} isOverride - true if this is a time-bound override, false for base.
 * @property {string}  source     - Human-readable source label for logging/audit.
 */

/**
 * @typedef {Object} CustomerLimits
 * @property {boolean}          unknown    - true if customer is not in config.
 * @property {number}           baseRpm    - The base limit (contractedRpm or tier default).
 * @property {string}           baseSource - Label for the base limit.
 * @property {CandidateLimit[]} overrides  - Active override candidates (only active:true entries).
 */

/**
 * Return the full set of limit candidates for a customer.
 * The app node does NOT decide which candidate applies — that decision happens
 * inside the Lua script, driven by redis.call('TIME').
 *
 * Only override entries with `active: true` are included; inactive overrides
 * are filtered out here so they never reach the Lua script at all.
 *
 * Returns { unknown: true } when the customer is not found in config.
 *
 * @param {string} customerId
 * @returns {CustomerLimits | { unknown: true }}
 */
export function getCandidateLimits(customerId) {
  const customer = config.customers?.[customerId];

  if (!customer) {
    return { unknown: true };
  }

  const tierRpm = config.tiers?.[customer.tier]?.rpm;
  const baseRpm = customer.contractedRpm ?? tierRpm;

  if (baseRpm == null) {
    // Config inconsistency: named customer with no resolvable base limit.
    return { unknown: true };
  }

  const baseSource = `customer:${customerId}`;

  // Build the override candidate list — only active entries, boundaries in seconds.
  const overrides = (customer.overrides ?? [])
    .filter((o) => o.active)
    .map((o) => ({
      rpm:        o.effectiveRpm,
      startSec:   parseHHMMtoSeconds(o.window.startUtc),
      endSec:     parseHHMMtoSeconds(o.window.endUtc),
      isOverride: true,
      source:     `override:${o.name}`,
    }));

  return { unknown: false, baseRpm, baseSource, overrides };
}

export { config };
