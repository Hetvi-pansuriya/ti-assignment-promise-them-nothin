# RelayAPI — Phase 2: Project Scaffolding + API Skeleton

> ⚠️ **Work in Progress** — This is Phase 2 of an incremental build. Rate limiting, customer config, Docker Compose orchestration, and the load-testing harness are **not yet implemented**.

---

## What exists in this phase

| Endpoint | Description |
|---|---|
| `GET /api/v1/ping` | Liveness check — confirms the server is alive |
| `GET /api/v1/health/redis` | Connectivity check — confirms Redis is reachable |

**No rate limiting exists yet.** The `src/middleware/` and `src/config/` directories are intentionally empty stubs for later phases.

---

## Module system

This project uses **ES Modules** (`"type": "module"` in `package.json`). All files use `import`/`export` syntax — no `require()`.

---

## Project structure

```
solution/
├── package.json
├── .gitignore
├── README.md          ← you are here
└── src/
    ├── server.js          # Express app + route definitions
    ├── middleware/         # Empty — rate-limit middleware (later phase)
    ├── redis/
    │   └── client.js      # ioredis client + checkRedisHealth()
    └── config/            # Empty — customer config loader (later phase)
```

---

## Prerequisites

- **Node.js ≥ 18**
- **Redis running locally on port 6379** before starting the server.

Redis is not yet orchestrated via Docker Compose (that's a later phase). For now, start it manually with Docker:

```bash
docker run --rm -p 6379:6379 redis:7-alpine
```

> Full Docker Compose setup (Redis + 3 app nodes + load balancer) is a later phase and not yet present in this repo.

---

## Before running `docker compose up`

> ⚠️ **Stop any locally-running Redis or Node processes first.**

If you have been running the app manually (e.g. from earlier phases), you may have background containers or processes that will conflict with the Compose stack:

- **Stale Redis container** — if Redis was started manually with `docker run -p 6379:6379 redis:7-alpine`, that container continues holding host port 6379 even after you stop your local Node process. Compose's own Redis service intentionally has *no* host port published, but the stale container will:
  - Cause a port-conflict error when Compose tries to start.
  - OR (if the conflict doesn't error) make port 6379 appear reachable from the host — falsely suggesting Redis is exposed, when in fact the Compose Redis is correctly isolated.

  This exact scenario was observed during Phase 4 verification: a container named `dazzling_newton` (started in Phase 2/3 development) was still running and holding port 6379 alongside the Compose stack.

- **Stale Node process** — if a local `npm start` server is still running, it will hold port 3000 and block the Compose app nodes from starting.

**Clean-up commands before `docker compose up`:**

```bash
# Stop any manually-started Redis container (adjust name if different)
docker stop dazzling_newton 2>/dev/null || true

# Or stop ALL running containers not managed by this Compose project
docker ps --filter status=running --format '{{.Names}}' | grep -v solution | xargs -r docker stop

# Kill any local Node process holding port 3000
# Windows (PowerShell):
Get-Process -Name node -ErrorAction SilentlyContinue | Stop-Process -Force
# macOS/Linux:
pkill -f "node src/server.js" || true
```

After cleanup, verify port 6379 is free before starting:
```bash
# Should print nothing (no listener) if the port is clear
docker ps --filter publish=6379
```

## Install & run

```bash
# Install dependencies
npm install

# Start the server (defaults to port 3000)
npm start

# Use a custom port
PORT=4000 npm start
```

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Port the Express server listens on |
| `REDIS_HOST` | `localhost` | Redis hostname |
| `REDIS_PORT` | `6379` | Redis port |

---

## Testing the endpoints

```bash
# Liveness ping
curl http://localhost:3000/api/v1/ping

# Redis health (Redis must be running)
curl http://localhost:3000/api/v1/health/redis
```

---

## What comes next (later phases)

- Sliding-window rate limiter via atomic Lua script in Redis
- Per-customer config loader (`src/config/`)
- Rate-limit middleware (`src/middleware/`)
- Docker Compose with 3 app nodes + nginx round-robin LB
- Load-testing harness
