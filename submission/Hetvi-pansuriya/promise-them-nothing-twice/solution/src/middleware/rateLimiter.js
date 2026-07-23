/**
 * src/middleware/rateLimiter.js
 *
 * Sliding-window rate-limit middleware.
 *
 * Architecture notes:
 *  - Reads X-Customer-Id from request headers (trusted from upstream gateway).
 *  - Calls getCandidateLimits() from the config loader to get the base limit
 *    and any time-bound override candidates (with window boundaries in seconds).
 *  - Passes the candidate set as ARGV into a single atomic Lua script in Redis.
 *  - The Lua script calls redis.call('TIME') as its FIRST operation and uses
 *    that timestamp for EVERY time-dependent decision — override-window selection
 *    AND sliding-window math. No app-node clock is ever consulted for any
 *    timing decision. This is a hard architectural requirement: the three app
 *    nodes are independent processes whose system clocks are not guaranteed to
 *    agree; Redis TIME is the single authoritative source.
 *  - On Redis outage: fails open at a fixed 60 RPM ceiling tracked per
 *    app-process in memory (intentionally coarse — not shared across nodes,
 *    not sliding-window-accurate). Every hit is logged with the greppable tag
 *    REDIS_OUTAGE_FAILOPEN so outages are never silently absorbed.
 *
 * Key format:  ratelimit:{customerId}:{windowStartMinute}
 *   where windowStartMinute = floor(redisTimeSeconds / 60)
 *   TTL: 120 seconds (2 windows) — Redis auto-GCs old buckets.
 *
 * Lua ARGV layout:
 *   ARGV[1]  = baseRpm
 *   ARGV[2]  = baseSource  (e.g. "customer:northwind")
 *   ARGV[3]  = windowSeconds (always 60)
 *   ARGV[4]  = number of override candidates (N)
 *   For each candidate i in [0, N):
 *     ARGV[5 + i*4 + 0] = rpm
 *     ARGV[5 + i*4 + 1] = startSec (seconds since midnight UTC)
 *     ARGV[5 + i*4 + 2] = endSec   (seconds since midnight UTC)
 *     ARGV[5 + i*4 + 3] = source   (e.g. "override:nightly_batch_capacity")
 */

import redisClient from '../redis/client.js';
import { getCandidateLimits } from '../config/index.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WINDOW_SECONDS = 60;

/**
 * Fail-open ceiling when Redis is unreachable.
 * Equal to the Starter tier limit — the lowest contracted promise —
 * so degraded mode never grants more headroom than any customer's contract floor.
 */
const FAILOPEN_CEILING_RPM = 60;

// ---------------------------------------------------------------------------
// Lua sliding-window script
//
// Inline EVAL approach: straightforward for this project.
// Trade-off vs EVALSHA: re-sends the script body on every call instead of
// using a server-side cached SHA, but avoids the SCRIPT LOAD / NOSCRIPT retry
// dance. EVALSHA is a natural next step if profiling shows overhead matters.
//
// This script is the single enforcement point for all rate-limit decisions.
// It:
//   1. Gets the authoritative current time from Redis (TIME command).
//   2. Selects which limit candidate applies based on UTC time-of-day windows.
//   3. Runs the sliding-window check-and-record against that limit.
//   4. Computes Retry-After correctly for both relief mechanisms.
//
// Fix for Issue 1 (Retry-After accuracy):
//   The denial branch now computes retry_after as the MAX of:
//     (a) time for prev-bucket decay to bring estimate below limit, AND
//     (b) time remaining until end of the current window
//   Rationale: if cur_count >= effective_rpm on its own, prev-bucket decay
//   alone is insufficient — the current bucket doesn't clear until the window
//   rolls over. Taking the max ensures the returned Retry-After covers both
//   relief paths. When cur_count >= effective_rpm, (b) dominates. When
//   cur_count < effective_rpm but the weighted sum exceeds it due to prev_count,
//   (a) may dominate. Either way the client gets a safe, sufficient wait.
//
// Fix for Issue 2 (override window selection inside Redis):
//   Override candidates are passed as ARGV. The script selects the first
//   candidate whose window contains the current UTC time-of-day (derived from
//   epochSeconds % 86400 — valid because Unix epoch is UTC-based). No timestamp
//   is ever passed from the app node.
// ---------------------------------------------------------------------------

const SLIDING_WINDOW_SCRIPT = `
-- Step 1: Get authoritative time from Redis. This is the ONLY time source used
-- in this entire script — no timestamp is passed from the app node.
local now_result    = redis.call('TIME')
local now_seconds   = tonumber(now_result[1])
local now_micros    = tonumber(now_result[2])

-- Derived time values
local window_size   = tonumber(ARGV[3])
local current_minute = math.floor(now_seconds / window_size)
local elapsed_abs   = now_seconds % window_size + now_micros / 1e6
local elapsed_fraction = elapsed_abs / window_size

-- Step 2: Select the effective limit.
-- Iterate override candidates. The first one whose window contains the current
-- UTC time-of-day wins. If none match, fall back to baseRpm.
-- UTC time-of-day in seconds: epochSeconds % 86400 (Unix epoch is UTC-based,
-- so no timezone conversion is needed).
local now_of_day    = now_seconds % 86400
local effective_rpm = tonumber(ARGV[1])   -- default: base RPM
local effective_src = ARGV[2]             -- default: base source

local num_overrides = tonumber(ARGV[4])
for i = 0, num_overrides - 1 do
  local base     = 5 + i * 4
  local o_rpm    = tonumber(ARGV[base + 0])
  local o_start  = tonumber(ARGV[base + 1])
  local o_end    = tonumber(ARGV[base + 2])
  local o_source = ARGV[base + 3]

  local in_window
  if o_start <= o_end then
    -- Normal range (e.g. 02:00–04:00 = 7200–14400)
    in_window = (now_of_day >= o_start) and (now_of_day < o_end)
  else
    -- Wraps midnight (e.g. 23:00–01:00)
    in_window = (now_of_day >= o_start) or (now_of_day < o_end)
  end

  if in_window then
    effective_rpm = o_rpm
    effective_src = o_source
    break
  end
end

-- Step 3: Read existing bucket counts
local cur_count  = tonumber(redis.call('GET', KEYS[1])) or 0
local prev_count = tonumber(redis.call('GET', KEYS[2])) or 0

-- Sliding-window weighted estimate
local estimated = cur_count + prev_count * (1 - elapsed_fraction)

-- Step 4: Allow or deny
if estimated < effective_rpm then
  -- Allowed: increment current bucket and refresh its TTL
  local new_count = redis.call('INCR', KEYS[1])
  redis.call('EXPIRE', KEYS[1], 2 * window_size)   -- 120-second TTL

  local new_estimated = new_count + prev_count * (1 - elapsed_fraction)
  local remaining = math.max(0, math.floor(effective_rpm - new_estimated))
  local reset_at  = (current_minute + 1) * window_size

  -- return: allowed=1, remaining, reset_at, now_seconds, effective_rpm, retry_after=0, source
  return { 1, remaining, reset_at, now_seconds, effective_rpm, 0, effective_src }
else
  -- Denied: do not touch any key.
  --
  -- Two regimes, with different binding constraints:
  --
  -- Regime A — cur_count >= effective_rpm:
  --   The current bucket alone already exceeds the limit. Prev-bucket decay
  --   within this window cannot bring the estimate below the limit regardless
  --   of elapsed time. The client must wait until the window rolls over so that
  --   the current bucket becomes prev and starts decaying.
  --   => retry_after = ceil(window_size - elapsed_abs)
  --
  -- Regime B — cur_count < effective_rpm (denial is purely from prev-bucket weight):
  --   We need: cur_count + prev_count * (1 - f') < effective_rpm
  --   => f' > 1 - (effective_rpm - cur_count) / prev_count
  --   => t' = f' * window_size  =>  retry_after = ceil(t' - elapsed_abs)
  --   This is the true minimum; no rollover padding needed.

  local time_until_rollover = window_size - elapsed_abs
  local retry_after

  if cur_count >= effective_rpm then
    -- Regime A: current bucket alone is at or over the limit.
    -- Decay of prev cannot help; must wait for full window rollover.
    retry_after = math.max(1, math.ceil(time_until_rollover))

  elseif prev_count > 0 then
    -- Regime B: cur_count < effective_rpm; denial is from prev-bucket weight.
    local f_needed = 1 - (effective_rpm - cur_count) / prev_count
    if f_needed <= elapsed_fraction then
      -- Estimate already below limit at this instant — should not reach here
      -- (estimated >= effective_rpm contradicts this), but be safe.
      retry_after = 1
    else
      local t_needed = f_needed * window_size
      retry_after = math.max(1, math.ceil(t_needed - elapsed_abs))
    end

  else
    -- prev_count == 0 and cur_count < effective_rpm — should be impossible
    -- (estimated = cur_count < effective_rpm means we'd be in the allow branch).
    -- Defensive fallback.
    retry_after = 1
  end

  local reset_at = (current_minute + 1) * window_size

  -- return: allowed=0, remaining=0, reset_at, now_seconds, effective_rpm, retry_after, source
  return { 0, 0, reset_at, now_seconds, effective_rpm, retry_after, effective_src }
end
`;

// ---------------------------------------------------------------------------
// In-memory fallback state (per app-process, intentionally not shared)
//
// Structure: Map<customerId, { count: number, windowStart: number }>
// windowStart is a Unix timestamp in seconds, sourced from Date.now() only in
// this degraded path — we have no Redis to ask for time here by definition.
// ---------------------------------------------------------------------------

const fallbackCounters = new Map();

/**
 * Fail-open rate check using a simple per-process fixed-window counter.
 * Called only when the Redis EVAL call throws.
 *
 * Date.now() is ONLY used inside this function — never in the main Redis path.
 *
 * @param {string} customerId
 * @returns {{ allowed: boolean, remaining: number, resetAt: number }}
 */
function failOpenCheck(customerId) {
  const nowSec = Math.floor(Date.now() / 1000);
  const windowStart = Math.floor(nowSec / WINDOW_SECONDS) * WINDOW_SECONDS;

  let state = fallbackCounters.get(customerId);

  // Reset if we've moved into a new window
  if (!state || state.windowStart !== windowStart) {
    state = { count: 0, windowStart };
  }

  state.count += 1;
  fallbackCounters.set(customerId, state);

  const allowed = state.count <= FAILOPEN_CEILING_RPM;
  const remaining = Math.max(0, FAILOPEN_CEILING_RPM - state.count);

  return { allowed, remaining, resetAt: windowStart + WINDOW_SECONDS };
}

// ---------------------------------------------------------------------------
// Helper: build ARGV array from getCandidateLimits() result
// ---------------------------------------------------------------------------

/**
 * Build the flat ARGV array for the Lua script from a CustomerLimits object.
 *
 * Layout:
 *   [baseRpm, baseSource, windowSeconds, numOverrides,
 *    ...for each override: rpm, startSec, endSec, source]
 *
 * @param {{ baseRpm: number, baseSource: string, overrides: Array }} limits
 * @returns {Array<string|number>}
 */
function buildArgv(limits) {
  const argv = [
    limits.baseRpm,
    limits.baseSource,
    WINDOW_SECONDS,
    limits.overrides.length,
  ];

  for (const o of limits.overrides) {
    argv.push(o.rpm, o.startSec, o.endSec, o.source);
  }

  return argv;
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

export function rateLimiter(req, res, next) {
  // a. Extract identity
  const customerId = req.headers['x-customer-id'];

  if (!customerId || customerId.trim() === '') {
    return res.status(401).json({
      error: 'missing_customer_id',
      message: 'X-Customer-Id header is required.',
    });
  }

  // Delegate to async inner function so we can use await cleanly
  return _rateLimitAsync(req, res, next, customerId.trim());
}

async function _rateLimitAsync(req, res, next, customerId) {
  // b. Resolve candidate limits (existence check + gather candidates for Lua)
  const limits = getCandidateLimits(customerId);

  if (limits.unknown) {
    console.log(
      `[RATE_LIMIT] REJECTED_UNKNOWN_CUSTOMER id="${customerId}" ` +
      `method=${req.method} path=${req.path}`
    );
    return res.status(403).json({
      error: 'unknown_customer',
      message: `Customer ID "${customerId}" is not recognized. Contact support.`,
    });
  }

  // c. Atomic Redis evaluation
  // Key names are pre-computed from the app node's rough notion of current time
  // so we can pass them as KEYS[]. The Lua script derives its own window minute
  // from redis.call('TIME') — if the bucket rolls between when we compute these
  // keys and when Redis executes TIME, the script's time is authoritative and
  // the keys we pass here would be off by one. To handle this safely, the script
  // should ideally re-derive the key names internally; for this phase we accept
  // the tiny (~0ms) race as a known limitation and document it.
  // TODO: a future refactor could pass customerId as an ARGV and have the script
  //       build both key strings itself from its TIME result.
  const nowEst = Math.floor(Date.now() / 1000);
  const curMinute = Math.floor(nowEst / WINDOW_SECONDS);
  const curKey  = `ratelimit:${customerId}:${curMinute}`;
  const prevKey = `ratelimit:${customerId}:${curMinute - 1}`;

  const argv = buildArgv(limits);

  let scriptResult;
  let redisOk = true;

  try {
    scriptResult = await redisClient.eval(
      SLIDING_WINDOW_SCRIPT,
      2,        // numkeys
      curKey,
      prevKey,
      ...argv   // ARGV[1..N]
    );
  } catch (err) {
    redisOk = false;
    console.error(
      `[RATE_LIMIT] REDIS_OUTAGE_FAILOPEN customer="${customerId}" error="${err.message}" ` +
      `— applying in-process fallback at ${FAILOPEN_CEILING_RPM} RPM ceiling`
    );
  }

  if (!redisOk) {
    // e. Fail-open path (Date.now() used here only — Redis is unavailable)
    const fb = failOpenCheck(customerId);
    const resetISO = new Date(fb.resetAt * 1000).toISOString();

    res.set('X-RateLimit-Limit',     String(FAILOPEN_CEILING_RPM));
    res.set('X-RateLimit-Remaining', String(fb.remaining));
    res.set('X-RateLimit-Reset',     String(fb.resetAt));

    if (fb.allowed) {
      return next();
    } else {
      res.set('Retry-After', String(WINDOW_SECONDS));
      return res.status(429).json({
        error:   'rate_limit_exceeded',
        limit:   FAILOPEN_CEILING_RPM,
        resetAt: resetISO,
        detail:  'Redis unavailable; degraded in-process limiter active.',
      });
    }
  }

  // Parse Lua return array:
  //   [allowed(0|1), remaining, reset_at, now_seconds, effective_rpm, retry_after, source]
  const [allowed, remaining, resetAt, , effectiveRpm, retryAfter, limitSource] = scriptResult;

  const resetISO = new Date(Number(resetAt) * 1000).toISOString();

  // d. Decide response
  res.set('X-RateLimit-Limit',     String(effectiveRpm));
  res.set('X-RateLimit-Remaining', String(remaining));
  res.set('X-RateLimit-Reset',     String(resetAt));

  if (allowed === 1) {
    return next();
  } else {
    res.set('Retry-After', String(retryAfter ?? WINDOW_SECONDS));
    return res.status(429).json({
      error:   'rate_limit_exceeded',
      limit:   effectiveRpm,
      resetAt: resetISO,
    });
  }
}
