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
