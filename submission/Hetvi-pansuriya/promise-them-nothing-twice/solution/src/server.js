import express from 'express';
import { checkRedisHealth } from './redis/client.js';
import { rateLimiter } from './middleware/rateLimiter.js';

const app = express();
const PORT   = parseInt(process.env.PORT   ?? '3000', 10);
const NODE_ID = process.env.NODE_ID ?? 'unknown';

// ---------------------------------------------------------------------------
// Global middleware
// ---------------------------------------------------------------------------

/**
 * X-Served-By — echoes the NODE_ID environment variable on every response.
 *
 * Applied before any route handler so it covers all endpoints unconditionally,
 * including /api/v1/ping (rate-limited), /api/v1/health/redis, and any future
 * routes added in later phases.
 *
 * Falls back to "unknown" when NODE_ID is not set, keeping local (non-Docker)
 * development runs working exactly as before.
 */
app.use((_req, res, next) => {
  res.set('X-Served-By', NODE_ID);
  next();
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * GET /api/v1/ping
 * Liveness check — protected by rate limiting (Phase 3).
 * The rateLimiter middleware runs before this handler and enforces per-customer
 * sliding-window limits. The route handler itself is unchanged from Phase 2.
 */
app.get('/api/v1/ping', rateLimiter, (_req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'relayapi',
    timestamp: new Date().toISOString(),
  });
});

/**
 * GET /api/v1/health/redis
 * Verifies that the server can reach Redis.
 * Intentionally NOT rate-limited: this endpoint must always be reachable
 * regardless of rate-limit state so that Redis connectivity can be checked
 * in isolation (including during a Redis outage where the limiter would
 * itself fail open).
 */
app.get('/api/v1/health/redis', async (_req, res) => {
  const health = await checkRedisHealth();

  if (health.ok) {
    return res.status(200).json({
      status: 'ok',
      redis: 'connected',
      latencyMs: health.latencyMs,
    });
  }

  return res.status(503).json({
    status: 'error',
    redis: 'unreachable',
    detail: health.error,
  });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`RelayAPI server listening on port ${PORT}`);
});
