# RelayAPI — Distributed Rate Limiter

A metered HTTP API platform with per-customer rate limiting, built as a
system-design exercise resolving a conflict between hard enforcement
(CTO) and zero-downtime for a key customer's traffic pattern (Head of
Support). See [`DECISIONS.md`](../DECISIONS.md) for the full reasoning
behind every design choice below.

## How it works, briefly

- Three stateless Express nodes (`app-node-a/b/c`) sit behind an nginx
  reverse proxy doing plain round-robin, with no sticky sessions.
- All rate-limit state lives in Redis — the only thing all three nodes
  share. No node ever makes an allow/deny decision from its own memory.
- Rate limiting uses a **sliding window counter** (current + previous
  60-second bucket, weighted by elapsed time), evaluated atomically
  inside a single Redis Lua script that uses Redis's own `TIME` command
  as its sole source of "now" — never an app node's system clock.
- Customer tiers and one named, time-bound override (for a customer
  whose contracted quota doesn't match its real nightly batch traffic)
  live entirely in `src/config/customers.json` — the rate-limiting
  engine has no customer-specific code, only numbers read from config.

## Running it

**Primary path — full 3-node deployment via Docker Compose:**

```bash
docker-compose up --build
```

This starts Redis, all three app nodes, and the nginx reverse proxy.

> ⚠️ **Stop any locally-running Redis or Node processes first**, if you've
> run this project manually before. A stale container holding host port
> 6379 or 3000 (e.g. from earlier manual testing with
> `docker run -p 6379:6379 redis:7-alpine`) can cause a port conflict or
> falsely make Redis appear reachable from the host. Clean up first:
>
> ```bash
> docker ps --filter status=running --format '{{.Names}}' | grep -v solution | xargs -r docker stop
> # Windows: Get-Process -Name node -ErrorAction SilentlyContinue | Stop-Process -Force
> # macOS/Linux: pkill -f "node src/server.js" || true
> ```

**Alternative — single local process (no Docker Compose, for quick checks):**

```bash
docker run --rm -p 6379:6379 redis:7-alpine   # Redis
npm install
npm start                                      # defaults to port 3000
```

## Endpoints

| Endpoint | Rate-limited? | Description |
|---|---|---|
| `GET /api/v1/ping` | Yes | Liveness check; subject to the caller's rate limit |
| `GET /api/v1/health/redis` | No | Redis connectivity check — always available regardless of rate-limit state |

Every response carries an `X-Served-By` header naming which node
(`node-a`/`node-b`/`node-c`) handled it, so you can confirm traffic is
really being distributed.

**On an allowed request**, `/api/v1/ping` returns `200` with:
- `X-RateLimit-Limit` — the caller's effective limit
- `X-RateLimit-Remaining` — requests left in the current window
- `X-RateLimit-Reset` — unix timestamp when the next window starts

**On a denied request**, it returns `429` with the same three headers
plus:
- `Retry-After` — seconds until a retry will actually succeed (computed
  from the real sliding-window state, not a fixed constant)
- A JSON body naming the limit that was hit and the reset time

**Identity and errors:**
- Missing `X-Customer-Id` header → `401`
- `X-Customer-Id` not present in `customers.json` → `403` (and creates
  no Redis state for that identity — rejected outright, never silently
  defaulted to a tier)

## Ports (Docker Compose)

| Service | Host port | Purpose |
|---|---|---|
| Reverse proxy (nginx) | `8080` | **Normal traffic path** — round-robin across all 3 nodes |
| `app-node-a` | `3001` | Direct access to this specific node (testing only) |
| `app-node-b` | `3002` | Direct access to this specific node (testing only) |
| `app-node-c` | `3003` | Direct access to this specific node (testing only) |
| Redis | *(none — internal network only)* | Not reachable from the host by design |

The per-node ports exist so the load-testing harness's race-condition
scenario can fan requests out to specific nodes directly — they are not
the normal traffic path.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Port the Express server listens on inside its container |
| `REDIS_HOST` | `localhost` | Redis hostname (Compose sets this to `redis`) |
| `REDIS_PORT` | `6379` | Redis port |
| `NODE_ID` | `unknown` | Identifies this instance in the `X-Served-By` header |

## Customer configuration

Tiers and customers are defined in `src/config/customers.json`:

- **Starter** — 60 RPM
- **Growth** — 300 RPM
- Named customers can have a flat override (a negotiated custom limit)
  or a time-bound override (active only within a defined UTC window).
  Every override must include `reason`, `owner`, and `reviewDate` —
  the app fails to start if any of these are missing, so an
  undocumented exception can never silently load.

Config is loaded once at startup and is **not** hot-reloaded across the
three nodes — see `DECISIONS.md` for why, and what a production fix
would look like.

## Load-testing harness

```bash
node harness/harness.js
```

Runs 7 scenarios against the live Docker Compose stack — exact
quota-boundary enforcement, same-tier fairness under full concurrent
load, cross-customer isolation, multi-node distribution, a cross-node
race-condition regression test, the unknown-customer path, and the
nightly-batch override scenario. Writes a structured report to
`harness/report.json` in addition to console output. The stack must
already be running (`docker-compose up`) before you run the harness.

## Project structure

```
solution/
├── Dockerfile
├── docker-compose.yml
├── nginx/
│   └── nginx.conf
├── package.json
├── harness/
│   ├── harness.js
│   └── report.json
└── src/
    ├── server.js
    ├── config/
    │   ├── index.js
    │   └── customers.json
    ├── middleware/
    │   └── rateLimiter.js
    └── redis/
        └── client.js
```