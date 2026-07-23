import express from 'express';
import { checkRedisHealth } from './redis/client.js';

const app = express();
const PORT = parseInt(process.env.PORT ?? '3000', 10);

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * GET /api/v1/ping
 * Simple liveness check — no external dependencies, always fast.
 */
app.get('/api/v1/ping', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'relayapi',
    timestamp: new Date().toISOString(),
  });
});

/**
 * GET /api/v1/health/redis
 * Verifies that the server can reach Redis.
 * Returns 200 when Redis responds to PING, 503 otherwise.
 * This route exists to confirm Redis connectivity in isolation before any
 * rate-limit logic is layered on top in a later phase.
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
