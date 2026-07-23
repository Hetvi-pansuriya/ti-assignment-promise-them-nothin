the design plan is fully approved with all corrections incorporated , clock source via redis TIME, fail-open ceiling at 60 RPM, unknown customers rejected with 403, structured src/ layout, and all five resolved decisions locked in.

i am now ready to move to implementation. i will be executing the actual build in a separate tool called antigravity, which is an agentic coding IDE that works across the editor, terminal, and browser to write code, run commands, and verify output autonomously.

i want you to generate a complete, detailed prompt that i can hand directly to antigravity to build Phase 2: initial project scaffolding and the basic API skeleton, nothing further yet. specifically, the antigravity prompt should instruct it to:

initialize a Node.js project inside solution/ with the approved src/ layout (middleware/, redis/, config/), plus package.json with express and a eedis client (ioredis) as dependencies.

create a minimal express server with a single route, GET /api/v1/ping, that returns a simple JSON status response, no rate limiting yet, this phase is just to confirm the server runs.

add a Redis connection module in src/redis/ that connects to a Redis instance (assume it'll run locally via docker on the default port for now) and exposes a simple health-check so we can confirm the app can actually talk to redis before building any rate-limit logic on top of it.

add a basic .gitignore (node_modules, etc.) and a placeholder README.md in solution/ noting this is a work-in-progress.

at the end, tell me exactly which commands to run to start redis via docker and start the server locally, and what response I should expect to see when I hit /api/v1/ping and the redis health-check, so I can verify this phase actually works before moving on.

write this as a single, clear, self-contained prompt i can paste directly into antigravity, include all the necessary context about the project (RelayAPI distributed rate limiter, stateless nodes, redis as shared store) so antigravity doesn't need anything from me beyond the prompt itself.

Show more

Architected standalone Antigravity prompt for Phase 2 scaffolding
Architected standalone Antigravity prompt for Phase 2 scaffolding
This is scoped tightly to just scaffolding — server + ping route + Redis health check + repo hygiene — with explicit "do not build yet" guardrails for rate limiting, config, Docker Compose, and the harness, so Antigravity doesn't jump ahead into later phases.

A couple of judgment calls I made that are worth a quick look before you paste this in:

ES modules vs. CommonJS — I left this as Antigravity's choice (pick one, be consistent, note it in the README) rather than dictating it, since it doesn't affect any of your approved design decisions. If you'd rather lock this in yourself now, say the word and I'll pin it.
Redis for this phase runs via plain docker run, not Compose — matches your ask ("assume it'll run locally via docker on the default port"), and keeps the actual docker-compose.yml (3 nodes + Redis) properly scoped to its own later phase rather than sneaking in early.
Health-check endpoint path — I used GET /api/v1/health/redis since it wasn't specified; flag it now if you want a different path or a top-level /health instead.
Ready for you to hand this to Antigravity whenever you like — let me know when you want the Phase 3 prompt (config loader + Redis Lua sliding-window logic) drafted.


Antigravity prompt phase2
Document · MD 


Generated prompt:

You are building **Phase 2 only** of a larger project. Do not implement rate limiting, config loading, Docker Compose, or the load-testing harness in this phase — those come later. Your job right now is strictly project scaffolding and a working API skeleton that proves the server runs and can talk to Redis. Stop once the acceptance criteria at the bottom are met.

## Project context

This is **RelayAPI**, a fictional B2B API platform being built as a system-design exercise. The end goal (not this phase) is a distributed, per-customer rate limiter with the following architecture, so the scaffolding you create now needs to fit this shape even though most of it isn't implemented yet:

- Traffic is distributed across **three stateless Express application nodes** behind a round-robin load balancer, with no sticky sessions and no shared memory between nodes.
- **Redis is the single shared source of truth** for all rate-limit state, since the app nodes share nothing with each other directly.
- Customer identity arrives via a trusted `X-Customer-Id` header from an upstream API gateway (not implemented yet — no auth logic in this phase).
- The final middleware will use a Lua script executed atomically in Redis, using Redis's own server-side clock (`redis.call('TIME')`), to do sliding-window rate limiting — none of that logic exists yet; this phase only needs a Redis client that can connect and confirm connectivity.
- The approved project structure uses a `src/` layout (not a flat `server.js`), specifically with `middleware/`, `redis/`, and `config/` subdirectories, because the middleware, the Redis integration, and the config loader are each substantial enough to warrant their own module, and a clear split makes it easy to verify later that there's exactly one rate-limit enforcement path in the code.

## What to build in this phase

Build everything inside a `solution/` directory at the project root.

### 1. Project init and structure

Initialize a Node.js project inside `solution/` with this structure:

```
solution/
├── package.json
├── .gitignore
├── README.md
└── src/
    ├── server.js
    ├── middleware/        (empty for now, just create the directory — rate-limit middleware comes in a later phase)
    ├── redis/
    │   └── client.js
    └── config/            (empty for now, just create the directory — config loader comes in a later phase)
```

Use `npm init` (or hand-write an equivalent `package.json`) with:
- `express` as a dependency (latest stable).
- `ioredis` as a dependency (latest stable) — this is the Redis client for the project; use `ioredis` specifically, not `node-redis` or another client.
- A `start` script that runs `node src/server.js`.
- Set `"type": "module"` and use ES module `import`/`export` syntax throughout, OR use CommonJS `require` throughout — pick one and be consistent across every file you create. Note which one you chose in the README.

### 2. Minimal Express server with one route

In `src/server.js`:
- Create a basic Express app.
- Add exactly one route: `GET /api/v1/ping`.
- This route does **not** use any rate-limiting logic yet (there is none in this phase). It should simply return a JSON response confirming the server is alive, e.g.:
  ```json
  { "status": "ok", "service": "relayapi", "timestamp": "<ISO 8601 timestamp>" }
  ```
- Listen on a port from `process.env.PORT`, defaulting to `3000` if not set.
- Log a clear startup message to the console when the server starts (e.g. `RelayAPI server listening on port 3000`).
- Do not add any other routes, middleware, or business logic beyond this single ping endpoint in this phase.

### 3. Redis connection module with health check

In `src/redis/client.js`:
- Create and export an `ioredis` client instance configured to connect to a Redis instance reachable via environment variables, defaulting to `localhost` and the default Redis port `6379` if not set (so it works against a Redis container run locally via Docker with standard port mapping, and can later be pointed at a `redis` hostname inside Docker Compose without code changes).
- Use environment variables `REDIS_HOST` (default `localhost`) and `REDIS_PORT` (default `6379`) to configure the connection — do not hardcode the connection target.
- Export a simple async health-check function, e.g. `checkRedisHealth()`, that pings Redis (using ioredis's built-in `PING` command) and returns whether the connection is alive, along with the latency if easy to capture.
- Wire this into a **second route** in `src/server.js`: `GET /api/v1/health/redis`, which calls `checkRedisHealth()` and returns:
  - `200` with `{ "status": "ok", "redis": "connected" }` (plus latency if you captured it) if Redis responds.
  - `503` with `{ "status": "error", "redis": "unreachable" }` if it doesn't, with the actual error message included in a `detail` field for debugging.
- This health-check route exists specifically so that Redis connectivity can be verified in isolation before any rate-limit logic is built on top of it in a later phase. Do not implement any actual rate-limiting, counting, or Lua scripting here — this route only checks connectivity.

### 4. `.gitignore` and placeholder `README.md`

- `.gitignore` inside `solution/` should at minimum ignore: `node_modules/`, `.env`, `npm-debug.log*`, and common OS/editor cruft (`.DS_Store`, `.vscode/`, `.idea/`).
- `README.md` inside `solution/` should be a short placeholder, explicitly marked as a work in progress, noting:
  - This is Phase 2 (project scaffolding + basic API skeleton) of the RelayAPI distributed rate limiter build.
  - What exists so far: Express server, `/api/v1/ping`, and a Redis health-check at `/api/v1/health/redis` — and explicitly note that **no rate limiting exists yet**.
  - Whether the project uses ES modules or CommonJS (per your choice in step 1).
  - How to install dependencies (`npm install`) and start the server (`npm start`).
  - A one-line note that Redis is expected to be running locally (e.g. via Docker) before starting the server, with a placeholder saying full Docker Compose orchestration for Redis + 3 app nodes is a later phase, not yet present.

## What NOT to do in this phase

- Do not implement any rate-limiting logic, Lua scripts, or sliding-window calculations.
- Do not implement the customer config loader or `config/customers.json` — the `config/` directory should exist but stay empty.
- Do not add any middleware to `src/middleware/` — the directory should exist but stay empty.
- Do not create a `docker-compose.yml` or any Dockerfiles — that's a later phase. Redis is assumed to be run locally by the developer via a plain `docker run` command for now (you'll provide this command in your final summary, not as a file in the repo).
- Do not add authentication, the `X-Customer-Id` header handling, or any customer-identity logic.
- Do not add a load-testing harness.
- Keep this phase minimal and focused purely on: project init, one ping route, one Redis health-check route, and basic repo hygiene files.

## Acceptance criteria — verify before finishing

Before you consider this phase done, actually run it yourself and confirm:
1. `npm install` completes cleanly inside `solution/`.
2. With a Redis instance running locally on port 6379, `npm start` boots the server without errors and logs the startup message.
3. `GET http://localhost:3000/api/v1/ping` returns `200` with the expected JSON shape.
4. `GET http://localhost:3000/api/v1/health/redis` returns `200` with `{"status":"ok","redis":"connected", ...}` when Redis is reachable.
5. Stopping Redis and re-hitting `GET http://localhost:3000/api/v1/health/redis` returns `503` with `{"status":"error","redis":"unreachable", ...}` rather than crashing the server.

## Final output required from you

At the very end, clearly state:

1. **Exact command(s) to start Redis locally via Docker** for testing this phase (a plain `docker run` command exposing port 6379 — no Compose file needed yet).
2. **Exact command(s) to install dependencies and start the server** (`npm install`, then `npm start` or equivalent).
3. **The exact expected response** (status code + JSON body, or a representative example of it) for:
   - `GET /api/v1/ping`
   - `GET /api/v1/health/redis` with Redis running
   - `GET /api/v1/health/redis` with Redis stopped
4. Confirmation that you actually ran these steps yourself and observed the expected results, not just that the code should theoretically produce them.

Do not proceed beyond this scaffolding phase. Do not start building rate-limiting logic, config loading, Docker Compose, or the test harness — those are separate phases that will be requested afterward.