# RelayAPI Distributed Rate Limiter — Design Plan

Status: **Draft for review — no implementation yet**

---

## 0. Design Principles (derived from the conflict)

Before the phases, it's worth stating explicitly what governs every decision below, because it's what makes the Northwind resolution defensible in a security review:

1. **One enforcement path.** There is exactly one rate-limit code path. It always runs, for every customer, on every request. There is no `if (customerId === 'northwind') skip()` anywhere.
2. **Limits are data, not logic.** The "800–1200 RPM window" isn't a special case in code — it's a higher number sitting in the same config structure every other customer uses. The engine has no idea Northwind is special; it just reads a number.
3. **Correctness bugs must be structurally prevented, not tested away.** The prior prototype failed at quota boundaries under Northwind-scale load. That tells us the bug class is almost certainly a **race condition in the read-then-write sequence** (check count, then increment, non-atomically) — exactly what happens when 800+ RPM hits three nodes round-robin. The fix has to be atomicity in Redis (Lua/`MULTI`), not more careful application code.
4. **Lean under-limit, not over-limit, under uncertainty.** This resolves ties in Redis failure modes, clock skew, and window-edge behavior.

---

## 1. Overall Architecture

### Request flow

```
Client
  │
  ▼
Load Balancer (round-robin, no sticky sessions)
  │
  ├──────────────┬──────────────┐
  ▼              ▼              ▼
Node A         Node B         Node C     (stateless Express apps)
  │              │              │
  └──────────────┴──────────────┘
              │
              ▼
        Redis (single shared source of truth)
```

Per-request sequence on whichever node receives it:

1. **Arrival** — Express receives `GET /api/v1/ping`.
2. **Identity extraction** — rate-limit middleware reads `X-Customer-Id` from the trusted gateway header. No fallback identity source (see Phase 2 for what happens if it's missing).
3. **Config resolution** — middleware looks up that customer's effective limit: tier default, or an override if one is configured (Northwind's nightly window is just a special case of "override," not a special case of "customer").
4. **Redis evaluation** — a single atomic Lua script performs the sliding-window count-and-decide-and-record in one round trip. This is the piece that makes the system safe under three concurrent nodes.
5. **Decision** — allow (pass to route handler) or deny (`429` + `Retry-After`).
6. **Response** — every response, allowed or denied, carries the standard rate-limit headers (Phase 2) so a customer's own instrumentation can see exactly what's going on.

### Why each piece exists

| Component | Responsibility | Why it's there |
|---|---|---|
| Express app (×3) | HTTP handling, header parsing, response shaping | Stateless — can be killed/restarted/scaled without affecting correctness |
| Rate-limit middleware | Orchestrates identity → config → Redis call → decision | Single enforcement point; everything else is just plumbing around it |
| `config/customers.json` | Tier defaults + named overrides | Externalizes all "who gets what limit" decisions from code, so they're auditable and diffable in version control |
| Redis | Atomic shared counters | The *only* place that can arbitrate "how many requests has this customer made in the current window," because it's the only thing all three nodes can see |

The architectural claim that matters most for the CTO's isolation requirement: **no node ever makes an allow/deny decision using only its own memory.** It always asks Redis, and Redis is where the atomicity lives.

---

## 2. Middleware Internal Logic

Order of operations inside the middleware, per request:

### Step 1 — Extract identity
- Read `X-Customer-Id`.
- If missing or empty: reject with `401` (not 429 — this is an authentication/gateway-contract problem, not a rate-limit problem). This is a deliberate, documented boundary: the middleware trusts the gateway to have already authenticated the caller.

### Step 2 — Resolve effective config
- Look up `customerId` in the loaded config.
- Resolution order:
  1. Named override active right now (Northwind-style) — checked first, and only "active" if the current UTC time falls inside the override's defined window, if the override is time-bound.
  2. Named customer with a flat override (an enterprise customer's negotiated custom RPM, no time window).
  3. Tier default (`starter` / `growth`) based on the customer's assigned tier in config.
  4. Fallback: unknown customer → `growth` default (documented explicitly, not silent).
- Output of this step is one number: `effectiveLimitRPM`, plus metadata (`source: "tier:starter" | "override:northwind_nightly_batch" | ...`) that gets attached to response headers and logs for auditability.

### Step 3 — Atomic Redis evaluation
- One Lua script, one round trip, given `(key, limit, windowSizeMs)` — **no timestamp is passed in from the app node.**
- The script calls `redis.call('TIME')` itself as the very first operation and uses that as the sole source of "now" for every calculation in that invocation (window bucket selection, overlap fraction, `resetAt`, `Retry-After`).
- This is a deliberate correctness requirement, not an implementation detail: the three app containers are independent processes and their system clocks are not guaranteed to agree (Docker containers can drift, especially under load or on constrained CI/dev hosts). If the window boundary were computed from each node's own clock, two nodes could disagree about which 60-second bucket "now" falls into, silently reintroducing the exact class of boundary bug that sank the earlier prototype. Redis is the single source of truth for *state* in this system, so it also has to be the single source of truth for *time* — anything less reopens the correctness gap by the back door.
- The script does, atomically:
  1. Compute the sliding-window weighted count (Phase 3 explains the math).
  2. Compare against `effectiveLimitRPM`.
  3. If under limit: record the request (increment current bucket) and return `{allowed: true, remaining, resetAt}`.
  4. If at/over limit: **do not record it**, return `{allowed: false, retryAfterSeconds}`.
- Atomicity is what fixes the class of bug that killed the earlier prototype — there's no "check" and "write" as two separate Redis round trips that another node's request can interleave with.

### Step 4 — Decide response
- **Allow:** call `next()`, attach headers:
  - `X-RateLimit-Limit`
  - `X-RateLimit-Remaining`
  - `X-RateLimit-Reset` (unix timestamp, start of next window)
- **Deny:** respond `429`, with:
  - `Retry-After` (seconds, computed from the actual sliding-window math — not a hardcoded constant, so it's accurate whether the customer is 1 request or 500 requests over)
  - Same `X-RateLimit-*` headers reflecting the current (denied) state
  - A small JSON body naming the limit and reset time, since enterprise customers want this to be self-explanatory for their own audits

### Step 5 — Fail-safe behavior on Redis failure
- If Redis is unreachable/times out: **fail open with a hard-coded safe ceiling, set equal to the Starter tier limit (60 RPM), applied per node.**
  - Confirmed decision: under-limiting is preferred to full denial of service, but the safe ceiling is deliberately the *lowest* tier limit in the system rather than some arbitrary conservative number — so a Redis outage degrades every customer to "the smallest promise we make to anyone," never grants anyone more headroom than their contract, and never takes the API down outright.
  - This is a per-node, in-memory fallback counter (since Redis, the shared source of truth, is unavailable by definition in this branch) — it's intentionally coarse and short-lived, and is documented in `DECISIONS.md` as a degraded mode, not a steady-state design, since three independent 60 RPM ceilings are not the same guarantee as one coordinated 60 RPM ceiling.
  - Logged loudly (distinct log level/event) so an outage is operationally visible, not silently absorbed.

### Step 2b — Unknown customer handling
- Confirmed decision: an `X-Customer-Id` that doesn't resolve to any entry in `config/customers.json` is **rejected outright with `403`**, not silently defaulted to `growth`.
- Rationale: silently granting an unrecognized identity a default quota is itself a form of hidden, undocumented behavior — the same category of thing the CTO explicitly ruled out for Northwind. If the gateway is sending an identity RelayAPI doesn't have a contract for, that's a configuration/provisioning gap that should surface loudly (`403` + log) rather than be quietly absorbed as "just give them the default tier."

---

## 3. Redis Data Model

### Algorithm: sliding window counter (hybrid)

This is the standard "two fixed windows, weighted" approach:

- Divide time into fixed windows of 60 seconds, aligned to the minute boundary (`floor(nowMs / 60000)`).
- Track a counter for the **current** window and the **previous** window.
- Estimated count = `currentWindowCount + previousWindowCount * (overlapFraction)`, where `overlapFraction = 1 - (elapsedMsInCurrentWindow / 60000)`.
- This smooths the hard-edge problem of fixed windows (e.g., 2× burst right across a minute boundary) without the memory cost of a fully logged sliding-log approach.

### Key naming

```
ratelimit:{customerId}:{windowStartEpochMinute}
```

Example: `ratelimit:northwind:29223481` (minute-granularity epoch bucket)

- One key per customer per minute-bucket. The middleware reads/writes **two** keys per evaluation: the current bucket and the previous bucket (for the weighted overlap calculation).
- Using the customer ID directly in the key (rather than a hash) keeps this human-inspectable in Redis for debugging/audit — you can `redis-cli GET ratelimit:northwind:29223481` during an incident and read it directly.

### What's stored

- Each key is a simple Redis integer counter (`INCR`), not a hash or list — keeps the Lua script and the memory footprint minimal.
- **TTL:** each bucket key is set to expire after `2 × windowSizeSeconds` (120s) on creation. This means Redis garbage-collects old buckets automatically; we never accumulate unbounded keys, and we never need a cleanup job.

### Why this guarantees correctness across 3 nodes

- All three nodes point at the **same** Redis instance with the **same** key scheme. There is no per-node state involved in the decision at all — a node is just a stateless executor of the Lua script.
- The Lua script runs as a single atomic operation on the Redis server itself (Redis is single-threaded for command execution), so two requests for the same customer landing on Node A and Node B at literally the same millisecond still get serialized by Redis and evaluated against a consistent count. This is the direct fix for the boundary-race bug in the decommissioned prototype.
- **Fairness** falls out of this for free: two customers on the same tier get independent keys (`ratelimit:custA:*` vs `ratelimit:custB:*}`), so there's no shared counter, no contention, and no way for one customer's traffic to eat into another's budget — satisfying the CTO's isolation requirement structurally, not by convention.

---

## 4. Docker Compose Setup

```
services:
  redis:        single instance, exposed only on the internal compose network
  app-node-a:   Express app, connects to redis:6379
  app-node-b:   Express app, connects to redis:6379
  app-node-c:   Express app, connects to redis:6379
  nginx (or similar): round-robin reverse proxy in front of node-a/b/c, exposed to host
```

- All three app containers run the **identical image**, differing only in a `NODE_ID` env var used purely for logging/response headers (e.g. `X-Served-By: node-b`) so the load-test harness can prove requests really are landing on different nodes.
- Nginx (or a minimal `http-proxy`-based Node service, whichever is faster to wire up and explain) sits in front, doing plain round-robin with no session affinity — mirroring "load-balanced, no sticky sessions" from the spec exactly.
- Redis is on the internal Docker network only, not published to the host — nothing outside the compose network can reach it, which is realistic for how this would be deployed and also means the harness must go through the load balancer like a real client, not cheat by hitting nodes directly (except when a test deliberately targets a specific node to test race conditions — see Phase 5).
- This setup is enough to realistically prove the "no shared memory, no sticky sessions" architecture rather than asserting it — three genuinely separate processes, actually distributed traffic, actually shared external state.

---

## 5. Load-Testing Harness Design

The harness is where the CTO's success criteria get proven, not asserted. Five scenarios:

### 5.1 Exact quota-boundary enforcement
- Single customer at a known tier (e.g., 100 RPM).
- Send exactly 100 requests within one window → all should succeed.
- Send the 101st → should be denied with `429` and a correct `Retry-After`.
- Repeat straddling a window boundary (e.g., 50 requests just before the minute rolls, 60 just after) to specifically exercise the sliding-window weighting logic, since this is where the previous prototype broke.

### 5.2 Fairness between same-tier customers
- Two customers, both on the 100 RPM tier, firing concurrently.
- Assert each independently receives up to their own full 100 RPM — neither's success rate is affected by the other's simultaneous load. Report shows both customers' accepted-request counts side by side.

### 5.3 Isolation between customers
- One customer deliberately blown way past its limit (e.g., 5× its RPM) at the same time a second customer sends a light, well-under-limit load.
- Assert the second customer's requests are 100% unaffected — zero 429s attributable to the first customer's traffic.

### 5.4 Randomized traffic across all three nodes
- Harness fires requests through the load balancer (not directly at nodes) with no client-side coordination, letting round-robin distribute naturally.
- Harness tags each response with the `X-Served-By` node header and confirms: (a) traffic did in fact spread across all 3 nodes, and (b) the aggregate accept/deny counts across nodes match what a single-node system would have produced for the same customer — i.e., the distributed system behaves identically to a non-distributed one from the customer's point of view.

### 5.5 Race conditions — simultaneous requests, different nodes
- The precise scenario that broke the earlier prototype: fire a burst of concurrent requests for the *same customer*, deliberately fanned out across all three nodes at effectively the same instant (using `Promise.all` with pre-resolved per-node target URLs, bypassing the load balancer for this one test so the fan-out is guaranteed rather than probabilistic).
- Assert the total accepted count never exceeds the configured limit, even though three separate processes were evaluating in parallel. This is the direct regression test for the historical bug class.

### 5.6 Unknown customer path
- Send requests with an `X-Customer-Id` that has no entry in `config/customers.json` (and, separately, a request with the header missing entirely).
- Assert every such request is rejected with `403` (never `429` — this path is a provisioning/identity problem, not a rate-limit problem), that zero Redis keys are created for the unrecognized identity, and that this rejection has no effect on any real customer's counters. Included specifically because "unknown identity" is an easy path to get quietly wrong (e.g., accidentally falling through to a default tier), and it's a case an auditor would ask about directly.

### Report output
- The harness produces a structured summary (accepted/denied counts per customer, per scenario, observed vs. expected, pass/fail) written to a file, so the results are reviewable evidence rather than console noise.

### Northwind-specific test
- A dedicated scenario replays the described nightly pattern: sustained 800–1200 RPM for a simulated window, using a fast-forwarded/mocked override window rather than actually waiting 90 minutes, asserting zero 429s during the window and normal 300 RPM enforcement immediately outside it.

---

## 6. The Northwind Override

### Config shape (illustrative, not final field names)

```json
{
  "tiers": {
    "starter": { "rpm": 60 },
    "growth": { "rpm": 300 }
  },
  "customers": {
    "northwind-logistics": {
      "tier": "growth",
      "contractedRpm": 300,
      "overrides": [
        {
          "name": "nightly_batch_capacity",
          "reason": "Contracted batch ETL job consistently generates 800-1200 RPM between 02:00-04:00 UTC. Approved exception — see ticket/doc link. Reviewed by: <owner>. Review date: <date>.",
          "effectiveRpm": 1200,
          "window": { "startUtc": "02:00", "endUtc": "04:00" },
          "active": true
        }
      ]
    }
  }
}
```

### Why this satisfies both stakeholders, structurally

- **It's not a code bypass.** The rate-limit engine has zero awareness of the string `"northwind"`. It reads `effectiveRpm` off config the same way it reads `60` for a starter customer. Delete this config block and Northwind reverts to a plain 300 RPM `growth` customer with no code changes.
- **It's fully auditable.** The `reason`, `window`, and an owner/review-date field are mandatory parts of the schema (config validation rejects an override block missing them), so this can't silently become an undocumented forever-exception. It's version-controlled, diff-visible, and — if you want to go further — could be extended to require a `reviewedBy` + expiry date so it doesn't outlive its justification.
- **It's invisible to the customer, as required**, while remaining fully visible internally: Northwind sees normal `X-RateLimit-*` headers reflecting *their effective* 1200 RPM, not a note saying "you're getting an exception." From their side it just looks like their contract supports this traffic. Internally, `DECISIONS.md` and the config comments make the real story explicit for anyone doing a security or ops review.
- **Rate limiting is never disabled** — Northwind is still metered and still deniable outside the window or above 1200 RPM within it; only the ceiling changes, and only for the named customer, and only in the defined time box.
- **It doesn't erode fairness for anyone else** — because of the per-customer key isolation in Phase 3, raising Northwind's ceiling has zero effect on any other customer's counters or limits.

### Open question for your review
Should the override window use fixed UTC clock times (as above — simpler, matches "nightly batch between 02:00–04:00 UTC" from the brief) or a rolling "N minutes after first sustained high-traffic detection" trigger (more resilient to the batch job's start time drifting, but adds real complexity and a new failure mode: auto-detecting "is this really the batch job or a traffic spike/abuse pattern?"). My default recommendation is the fixed-window version for this exercise — it's simpler, fully explainable in one sentence to an auditor, and matches what's actually described in the brief. Happy to discuss the tradeoff if you want it noted in `DECISIONS.md` either way.

---

## 7. `DECISIONS.md` Content Plan

Beyond the conflict-resolution narrative already described in Phase 6, `DECISIONS.md` will include two additional sections:

### 7.1 Known limitation — config is loaded once at startup
- `config/customers.json` is read into memory when each app node boots and is **not** hot-reloaded, and is **not** shared/synced live across the three nodes. Changing a customer's tier, adding an override, or adjusting the Northwind window requires a redeploy/restart of all three nodes to take effect everywhere.
- This is called out as a known limitation rather than an oversight, with the practical consequence stated plainly: between the moment config changes and the moment all three nodes have restarted, nodes could briefly disagree about a customer's limit (e.g., two nodes on the old config, one already restarted on the new config) — a real but bounded, transient inconsistency, not a correctness break in the Redis counting itself.
- **What a production fix looks like**, noted as future work rather than built here (keeping scope to the thin vertical slice):
  - Move config into a shared store the nodes read from directly instead of a bundled file — Redis itself is the natural candidate given it's already the shared dependency, avoiding introducing a fourth moving part.
  - Add a lightweight internal `/admin/reload-config` endpoint per node (or a pub/sub "config changed" signal via Redis) so changes can be pushed without a restart, with the reload itself validated against the same schema checks used at startup so a bad config can't be pushed live.

### 7.2 Plain-language request-counting explanation (for enterprise security reviews)
A short, non-implementation-jargon paragraph aimed at an enterprise customer's security reviewer, roughly:

> RelayAPI counts your requests using a sliding 60-second window, not a hard "reset at the top of the minute" counter. This means bursting all your traffic right at a minute boundary can't double your effective rate — your usage from the tail of the previous minute is still weighted into the current minute's count. All counting happens in a single, centrally coordinated data store shared by every RelayAPI server handling your traffic, and each count check-and-record happens as one indivisible operation, so it's not possible for two simultaneous requests — even ones handled by two different RelayAPI servers at the same instant — to both be allowed through past your limit due to a timing gap. Your limit is enforced consistently regardless of which server handles a given request.

This gets refined/shortened as needed once it's sitting next to the real README, but the substance — sliding window, single shared store, atomic check-and-record, server-agnostic — is the core claim it needs to make.

---

## Resolved decisions (incorporated above)
1. ✅ Redis-outage fail-open ceiling = Starter tier limit (60 RPM), per-node — Phase 2, Step 5.
2. ✅ Fixed UTC window for the Northwind override — Phase 6.
3. ✅ Unknown customers rejected outright with `403` — Phase 2, Step 2b.
4. ✅ Structured `src/` layout (`middleware/`, `redis/`, `config/`) rather than flat `server.js`.
5. ✅ Redis server-side clock (`TIME`) as the sole time source for window math — Phase 2, Step 3.

No remaining open questions — ready to move to implementation on your go-ahead.