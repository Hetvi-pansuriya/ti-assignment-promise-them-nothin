import express from 'express';
import { checkRedisHealth } from './redis/client.js';
import { rateLimiter } from './middleware/rateLimiter.js';

const app = express();
const PORT = parseInt(process.env.PORT ?? '3000', 10);

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
