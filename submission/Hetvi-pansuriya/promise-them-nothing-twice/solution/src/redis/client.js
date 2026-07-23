import Redis from 'ioredis';

const REDIS_HOST = process.env.REDIS_HOST ?? 'localhost';
const REDIS_PORT = parseInt(process.env.REDIS_PORT ?? '6379', 10);

/**
 * Shared ioredis client instance.
 * Connection target is controlled entirely via environment variables so
 * that the same code works against a local Docker container in development
 * and against the "redis" service hostname in Docker Compose later.
 *
 * Auto-connects on creation (no lazyConnect) so the persistent TCP connection
 * is established at server startup. enableOfflineQueue: false ensures that
 * commands fail immediately (rather than queuing) when Redis is unreachable —
 * which is what we need for the health-check to return a fast 503.
 * maxRetriesPerRequest: 0 prevents ioredis from retrying failed commands so
 * the health-check route gets an error back quickly.
 */
const redisClient = new Redis({
  host: REDIS_HOST,
  port: REDIS_PORT,
  enableOfflineQueue: false,
  maxRetriesPerRequest: 0,
});

// Suppress unhandled 'error' events from bringing down the process.
// Errors are surfaced through checkRedisHealth() instead.
redisClient.on('error', () => {
  // intentionally swallowed here; callers check via checkRedisHealth()
});

/**
 * Ping Redis and return connectivity status + round-trip latency.
 *
 * @returns {{ ok: boolean, latencyMs?: number, error?: string }}
 */
export async function checkRedisHealth() {
  const start = Date.now();
  try {
    const reply = await redisClient.ping();
    if (reply !== 'PONG') {
      return { ok: false, error: `Unexpected PING reply: ${reply}` };
    }
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    return { ok: false, error: err.message ?? String(err) };
  }
}

export default redisClient;
