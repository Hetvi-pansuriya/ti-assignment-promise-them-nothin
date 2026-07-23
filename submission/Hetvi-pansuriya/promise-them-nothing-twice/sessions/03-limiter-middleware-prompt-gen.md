phase 2 is complete and verified , server runs, /api/v1/ping works, redis health-check works both when redis is up and down.

now generate a complete, detailed prompt for antigravity to build phase 3: the config loader and the core rate-limiting middleware with the redis Lua script. It should instruct antigravity to:

build src/config/ , a loader that reads a customers.json file containing tier defaults (starter: 60 RPM, growth: 300 RPM) and named customer entries, including a northwind stand-in with a time-bound override (02:00–04:00 UTC, effectiveRpm 1200, with mandatory reason, window, and owner/review-date fields , reject the config at load time if any override is missing these fields). include resolution order: active named override → flat named override → tier default → unknown customer.

build src/middleware/rateLimiter.js implementing: extract X-Customer-Id (missing/empty → 401), resolve effective config (unresolvable customer → 403, log it, create zero redis keys), then call a single atomic Lua script for the sliding-window-counter check-and-record, using redis.call('TIME') as the sole time source inside the script — never a timestamp from the app node. key format: ratelimit:{customerId}:{windowStartEpochMinute}, TTL 120s. on allow: attach X-RateLimit-Limit/Remaining/Reset headers, call next(). On deny: 429 with an accurate Retry-After computed from the actual sliding-window math, same rate-limit headers, and a small JSON body naming the limit and reset time.

implement the redis-outage fail-open behavior: if Redis is unreachable, fail open at a fixed 60 RPM per-node in-memory ceiling, logged loudly as a distinct degraded-mode event.

wire this middleware into the existing express app ahead of the ping route, and add 2-3 test customer entries to customers.json so it's immediately testable.

at the end, have antigravity actually test it,  hit the ping endpoint repeatedly past a low test customer's limit and confirm a 429 appears with correct headers, then confirm a request from an unrecognized customer ID gets 403, and report the exact commands and observed output.

add the same safety note as before: only touch solution/, never sessions/ or DECISIONS.md.

Show more

Reconciled missing safety note discrepancy between phases
Reconciled missing safety note discrepancy between phases
This is the phase where the "no hidden bypass" claim actually gets tested, so I leaned hard on two things:

Startup validation as a real acceptance test, not just a code path — I had it instruct Antigravity to deliberately break a required override field, confirm the app refuses to boot, then restore the file. That's the only way to actually prove the "reject at load time" rule works rather than just exists in code.
Explicit ban on any customerId === 'northwind' branching, called out as a hard architectural rule in its own section — since this is the phase where that temptation is highest (it'd be the "easy" way to make the override work).
A couple of judgment calls worth flagging:

Resolution order wording — your spec listed "tier default" as step 3 in the order, but since every customer in this design must be individually named in customers.json (no wildcard "any customer on tier X"), I clarified that tier default only ever applies to a named customer via their tier field — it's not a separate fallback tier for unnamed IDs. Worth double-checking that matches your intent; if you actually want unnamed IDs to fall through to a tier by some other signal, let me know and I'll rewrite that section.
In-memory fail-open counter is per-process, not shared — I called this out explicitly as a known coarseness (three nodes each independently allowing up to 60 RPM during an outage, not one coordinated 60 RPM), since it's a real gap between "the promise" and "the degraded-mode implementation." Worth deciding whether that nuance belongs in DECISIONS.md too — happy to draft that note if you want it there.
Let me know when you're ready for the Phase 4 prompt (Docker Compose: 3 nodes + Redis).


Antigravity prompt phase3
Document · MD 


Generated prompt:
You are building **Phase 3 only** of a larger project. Phase 2 (project scaffolding, Express server, `/api/v1/ping`, and a Redis health-check at `/api/v1/health/redis`) is already complete and verified — do not redo it, but you will be extending `src/server.js` in this phase. Do not build Docker Compose, the load-testing harness, or anything beyond what's listed below. Stop once the acceptance criteria at the bottom are met.

## Safety note — scope of file access

**Only touch files inside `solution/`.** Do not create, modify, or delete anything in `sessions/` or `DECISIONS.md` at the project root — those are outside your scope for every phase, including this one.

## Project context

This is **RelayAPI**, a fictional B2B API platform being built as a system-design exercise: a distributed, per-customer rate limiter for a metered HTTP API. Recap of the approved architecture relevant to this phase:

- Three stateless Express nodes sit behind a round-robin load balancer with no sticky sessions and no shared memory between nodes (the Docker Compose setup that actually stands up 3 nodes is a later phase — for now you're working against the single Express app from Phase 2).
- **Redis is the single shared source of truth** for rate-limit state, since app nodes share nothing with each other directly.
- Customer identity arrives via a trusted `X-Customer-Id` header from an upstream API gateway. RelayAPI trusts this header as-is; there is no additional auth logic to implement.
- Rate limiting uses a **sliding window counter (hybrid)** approach: two fixed 60-second buckets (current + previous), weighted by how far into the current bucket "now" is, to avoid the hard-edge burst problem of plain fixed windows.
- **Time must come from Redis itself**, not from any app node's system clock. The three app nodes are independent processes and their clocks are not guaranteed to agree; if window-boundary math depended on a node's own clock, two nodes could disagree about which bucket "now" falls into. This was the root cause class of a real bug in an earlier (decommissioned) prototype of this system, so it's a hard requirement here, not a style preference.
- **Redis outage → fail open at a fixed, low, safe ceiling — never fail closed, never fail fully open.** The approved ceiling is 60 RPM, chosen specifically because it equals the Starter tier limit, the lowest promise made to any customer, so a degraded Redis doesn't grant anyone more headroom than their contract and doesn't take the API down outright.
- One customer, "northwind" (a stand-in for a real customer, Northwind Logistics), runs a nightly batch job generating 800–1200 RPM between 02:00–04:00 UTC, against a contracted 300 RPM. This is handled via a **named, documented, time-bound config override** — never a hardcoded bypass in application code. The rate-limit engine has no special-case logic for "northwind" as a string; it only ever reads numbers out of config. This is a hard architectural requirement: there must be exactly one enforcement code path for every customer, with all variation expressed as data in `customers.json`, not as branches in code.
- Unknown customer IDs (not present in config) are rejected outright with `403` — never silently defaulted to a tier, and never allowed to create any Redis state.

## What to build in this phase

### 1. `src/config/` — customer config loader

Create `src/config/customers.json` and `src/config/index.js` (or similar — your call on the exact filename, just keep it inside `src/config/`).

**`customers.json` structure:**

```json
{
  "tiers": {
    "starter": { "rpm": 60 },
    "growth": { "rpm": 300 }
  },
  "customers": {
    "northwind": {
      "tier": "growth",
      "contractedRpm": 300,
      "overrides": [
        {
          "name": "nightly_batch_capacity",
          "reason": "Contracted nightly batch ETL job consistently generates 800-1200 RPM between 02:00-04:00 UTC. Approved exception.",
          "effectiveRpm": 1200,
          "window": { "startUtc": "02:00", "endUtc": "04:00" },
          "owner": "<placeholder-owner-name>",
          "reviewDate": "<placeholder-YYYY-MM-DD>",
          "active": true
        }
      ]
    }
  }
}
```

**Loader behavior (`src/config/index.js` or equivalent):**

- Load and parse `customers.json` **once at startup** (no hot-reload in this phase — that's a known, documented limitation already captured in the project's `DECISIONS.md`, which you are not to edit).
- **Validate every override entry at load time.** Any override object missing `reason`, `window`, `owner`, or `reviewDate` must cause the app to fail fast at startup with a clear error message naming the customer and the missing field(s) — do not let a malformed or undocumented override silently load. This is a hard validation rule, not a warning.
- Expose a resolution function, e.g. `resolveEffectiveLimit(customerId, now)`, implementing this exact resolution order:
  1. **Active named override** — an override on this customer whose `active` is `true` and whose `window` (interpreted as a UTC clock-time range, using `now`, which should itself ultimately be sourced from Redis `TIME` inside the actual rate-limit check — see middleware section below for exactly where "now" comes from) currently contains the current UTC time. If matched, return `{ rpm: override.effectiveRpm, source: "override:<name>" }`.
  2. **Flat named override** — a customer entry that exists in config but has no active time-bound override right now; return `{ rpm: customer.contractedRpm ?? tierDefault, source: "customer:<id>" }`.
  3. **Tier default** — if the customer isn't individually named in config at all but... *(note: given the resolution order in this project, every customer that should be allowed through must be explicitly named in `customers.json`; there is no "any customer on tier X" wildcard matching — treat tier defaults as looked up only for named customers via their `tier` field, not as a fallback for arbitrary unnamed IDs)*. Return `{ rpm: tiers[customer.tier].rpm, source: "tier:<tierName>" }`.
  4. **Unknown customer** — the ID has no entry in `customers.json` at all. Return a distinct `{ unknown: true }` result (not a numeric RPM) so the middleware can reject with `403`. Do not default unknown customers to any tier.
- Add **2–3 test customer entries** to `customers.json` alongside `northwind`, specifically to make this phase immediately testable, for example:
  - A `starter`-tier test customer with a low limit (e.g. `test-starter-customer`, tier `starter`, 60 RPM) — deliberately kept low so it's easy to manually exceed in a quick test.
  - A `growth`-tier test customer (e.g. `test-growth-customer`, tier `growth`, 300 RPM).
  - Optionally, a customer with its own flat override (no time window) to prove that resolution path also works, e.g. a negotiated enterprise-style flat limit.

### 2. `src/middleware/rateLimiter.js` — the rate-limit middleware

Build the single Express middleware function that will sit in front of protected routes. Logic, in order:

**a. Extract identity**
- Read `X-Customer-Id` from the request headers.
- If missing or empty string: respond `401` immediately (JSON body explaining the missing header), do not proceed further, do not touch Redis or config resolution.

**b. Resolve effective config**
- Call the config resolver from step 1 with the customer ID.
- If the result indicates an unknown customer: respond `403` immediately, with a JSON body making clear this identity isn't recognized. **Log this event clearly** (distinct log line noting the rejected unknown customer ID). **Do not create any Redis key for this request** — an unresolvable customer must leave zero trace in Redis state.
- Otherwise, you now have an `effectiveRpm` and a `source` string to use for this request.

**c. Atomic Redis evaluation (Lua script)**
- Write a single Lua script (inline string or a `.lua` file loaded and passed via `EVALSHA`/`EVAL` — your call, but document the choice) that performs the entire sliding-window check-and-record as **one atomic Redis operation**.
- **Critical requirement: the script must call `redis.call('TIME')` itself as its first operation and use that as the sole source of "now" for every calculation inside the script.** No timestamp may be passed into the script as an argument from the app node. This is non-negotiable per the project's approved design — clock drift between independent Node processes must never be able to affect window-boundary correctness.
- Key format: `ratelimit:{customerId}:{windowStartEpochMinute}` — the script computes `windowStartEpochMinute` itself from the Redis-sourced time (`floor(nowSeconds / 60)`), and needs to read/consider both the current minute bucket and the previous minute bucket to perform the weighted sliding-window calculation (weight = fraction of the current 60s window that has elapsed).
- On every key it creates/increments, set/refresh a **TTL of 120 seconds** so Redis garbage-collects old buckets automatically — never accumulate unbounded keys.
- The script's decision logic:
  - Compute `estimatedCount = currentBucketCount + previousBucketCount * (1 - elapsedFractionOfCurrentWindow)`.
  - If `estimatedCount < effectiveRpm`: increment the current bucket, return an "allowed" result including enough info for the app node to compute `remaining` and `resetAt`.
  - If `estimatedCount >= effectiveRpm`: **do not increment anything**, return a "denied" result including enough info for the app node to compute an accurate `Retry-After`.
- Call this script from the middleware, passing in `customerId`, `effectiveRpm`, and the 60-second window size — but, again, never a timestamp.

**d. Decide response**
- **Allowed:** attach response headers `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` (unix timestamp of the next window start), then call `next()`.
- **Denied:** respond `429` with:
  - `Retry-After` header, in seconds, computed from the actual sliding-window math for this specific request (i.e., how long until `estimatedCount` would drop back under `effectiveRpm`) — not a hardcoded constant.
  - The same `X-RateLimit-*` headers reflecting current (denied) state.
  - A small JSON body naming the limit that was hit and the reset time, e.g. `{ "error": "rate_limit_exceeded", "limit": 60, "resetAt": "<ISO 8601>" }`.

**e. Redis-outage fail-open behavior**
- If the Redis call fails (connection error, timeout, etc.) rather than returning a normal allow/deny result: **fail open at a fixed 60 RPM ceiling, tracked per app-process in-memory** (a simple in-memory counter local to this Node process, since the shared source of truth is unavailable by definition in this branch).
- This in-memory fallback is intentionally coarse (not sliding-window-accurate, not shared across nodes) — it's a degraded-mode safety net, not a steady-state design, and should be clearly commented as such in the code.
- **Log this as a distinct, loud, clearly-labeled event** (e.g. a log line explicitly saying something like `REDIS_OUTAGE_FAILOPEN` or similar, easily greppable) every time this path is hit, so an outage is operationally visible and not silently absorbed.
- Apply the same 60 RPM ceiling and the same response shape (headers, 429 body) as the normal path when this fallback denies a request — the customer-facing contract shouldn't visibly change just because the system is in degraded mode.

### 3. Wire the middleware into the existing app

- In `src/server.js`, import and apply `rateLimiter` middleware **ahead of** the existing `GET /api/v1/ping` route from Phase 2, so ping is now protected by rate limiting.
- Do not add rate limiting to the `/api/v1/health/redis` route from Phase 2 — that endpoint should remain unprotected so it can always be used to check Redis connectivity regardless of rate-limit state.
- Do not modify the response shape of `/api/v1/ping` itself beyond what's already there — the rate-limit headers are added by the middleware, not by the route handler.

## What NOT to do in this phase

- Do not build `docker-compose.yml`, Dockerfiles, or any multi-node orchestration — still a later phase.
- Do not build the load-testing harness — still a later phase.
- Do not add hot-reloading of config, a `/admin/reload-config` endpoint, or any pub/sub config sync — explicitly out of scope and already documented as a known limitation elsewhere in the project.
- Do not add any special-case code branching on customer ID or name (e.g. `if (customerId === 'northwind')`) anywhere in the middleware or Redis logic. Northwind's behavior must emerge entirely from the config resolution described in step 1 — this is a hard architectural rule for this project, not a style preference.
- Do not touch `sessions/` or `DECISIONS.md`.

## Acceptance criteria — verify before finishing

Actually run these yourself and confirm real output, not just that the code should theoretically work:

1. App starts cleanly with the updated `customers.json`, including the northwind entry with its override — startup validation passes (all required override fields present).
2. As a build-time sanity check, temporarily prove the startup validation actually works: remove a required field (e.g. `reason`) from a test override, confirm the app fails to start with a clear error naming the customer and missing field, then restore the file to its correct state before final testing.
3. Repeated `GET /api/v1/ping` requests using the low-limit test starter customer's `X-Customer-Id` header, sent past that customer's limit, produce a `429` once the limit is exceeded, with correct `X-RateLimit-*` headers and a `Retry-After` header present and reasonable.
4. A `GET /api/v1/ping` request with an `X-Customer-Id` for a customer not present in `customers.json` returns `403`, and this rejection is visible in the logs.
5. A request with no `X-Customer-Id` header at all returns `401`.
6. Requests under a customer's limit return `200` with `X-RateLimit-Remaining` decrementing as expected.

## Final output required from you

At the end, report:

1. The exact `X-Customer-Id` values you used for testing (matching what you added to `customers.json`).
2. The exact commands you ran (e.g. `curl` invocations, including headers) to exceed the test starter customer's limit, and the exact `429` response you observed (status, headers, body).
3. The exact command and response for the unknown-customer `403` case, plus the corresponding log line you observed.
4. The exact command and response for the missing-header `401` case.
5. Confirmation that you actually ran the startup-validation failure test (step 2 above) and restored the config afterward, with the exact error message the app produced when a required override field was missing.

Do not proceed beyond this middleware-and-config phase. Do not start building Docker Compose, the multi-node setup, or the load-testing harness — those are separate phases that will be requested afterward.