# Design Decisions

## 1. Conflict & Resolution

RelayAPI's rate limiter had two conflicting stakeholder requirements:

- The CTO required hard enforcement (429 + Retry-After), full auditability,
  strict per-customer isolation and fairness, and explicitly ruled out any
  hidden bypass in code — an exception, if granted, must be config-driven
  and auditable.
- The Head of Support required that Northwind Logistics (60% of recurring
  revenue) never see a 429 during its nightly batch window (02:00–04:00 UTC,
  ~800–1200 RPM), without disabling rate limiting for anyone else.

Resolution: rather than satisfying both literally, Northwind gets an explicit,
named, documented, auditable configuration override that raises its effective
limit during the batch window only. The rate-limiting engine has no special-case
code for Northwind — it reads `effectiveRpm` from config exactly like it reads
any tier's limit. This satisfies the CTO's "no hidden bypass, must be auditable"
requirement and the Support lead's "no 429s for Northwind" requirement, while
every other customer remains fully and fairly rate-limited.

## 2. Technical Choices

**Algorithm — Sliding Window Counter (over Fixed Window, Sliding Window Log,
Token Bucket, Leaky Bucket):**
- Fixed window allows a 2x boundary burst (the exact bug class that sank an
  earlier internal prototype) — rejected.
- Sliding window log is fully precise but stores a timestamp per request,
  which doesn't scale memory-wise at Northwind's traffic volume — rejected.
- Token bucket and leaky bucket solve a different problem (intentional
  bursting / traffic smoothing) than what's needed here (accurate, low-memory,
  boundary-safe counting) — not a fit for this requirement set.
- Sliding window counter gives boundary correctness close to the log-based
  approach at O(1) memory per customer (two counters), and directly matches
  the CTO's stated tolerance for "eventual consistency, but lean under-limit."

**Clock source — Redis server-side `TIME`, not app-node clocks:**
Three independent containers cannot be assumed to have perfectly synced
clocks. If each node computed "now" locally, two nodes could disagree about
which window a request falls into — reopening the same boundary-bug class
from the earlier prototype. Redis is already the single source of truth for
counts, so it is also made the single source of truth for time.

**Redis failure mode — fail open at a fixed 60 RPM ceiling (Starter tier),
per node:**
Full denial on a Redis blip would take the API down for everyone; fully
open would violate the CTO's "never over-limit" preference. A ceiling
equal to the lowest tier limit in the system means a Redis outage degrades
every customer to "the smallest promise we make to anyone" — never grants
more than a customer's contract, and never fully denies service. Logged
loudly as a distinct degraded-mode event.

**Unknown customer — reject with 403, not a default tier:**
Silently granting an unrecognized identity a default quota is the same
category of hidden behavior the CTO ruled out for Northwind. An identity
with no config entry indicates a provisioning/gateway problem and should
surface loudly, not be quietly absorbed.

## 3. Known Limitations

Customer configuration (`config/customers.json`) is loaded into memory once
at each node's startup — it is not hot-reloaded and not synced live across
the three nodes. Changing a tier or override requires a restart of all three
nodes to take full effect everywhere; between restarts, nodes could briefly
disagree about a customer's limit. This is a bounded, transient inconsistency,
not a break in Redis's atomic counting.

Production fix (not built here, out of scope for this exercise): move config
into a shared store the nodes read directly — Redis itself is the natural
candidate since it's already the shared dependency — and add a lightweight
reload mechanism (an internal endpoint or Redis pub/sub signal) so changes
propagate without a restart, validated against the same schema used at
startup.

## 4. For Enterprise Security Reviews

RelayAPI counts requests using a sliding 60-second window, not a hard
"reset at the top of the minute" counter — so bursting traffic right at a
minute boundary cannot double the effective rate; usage from the tail of
the previous minute is still weighted into the current minute's count. All
counting happens in a single, centrally coordinated data store shared by
every RelayAPI server handling a customer's traffic, and each check-and-record
happens as one indivisible operation — so two simultaneous requests, even
handled by two different servers at the same instant, cannot both slip
through past the limit due to a timing gap. The limit is enforced consistently
regardless of which server handles a given request.

## 5. Verification

The load-testing harness (`solution/harness/harness.js`) runs seven scenarios
against the live 3-node Docker Compose deployment (not against a single local
process), producing a structured `report.json` alongside console output.

**1. Exact quota-boundary enforcement** — a test customer's exact limit's
worth of requests all succeed; the next one is denied with a correct
`Retry-After`. A second pass specifically straddles a real minute boundary
to exercise the sliding-window weighting, not just a simple within-bucket
count. **PASS.**

**2. Fairness between same-tier customers** — two customers sharing the
`growth` tier are each sent their own full effective limit's worth of
concurrent requests (300 and 500 respectively, 800 combined), through the
reverse proxy. Both received 100% of their own quota with zero denials,
despite the combined load exceeding either individual limit — proving
per-customer Redis key isolation, not just "no crosstalk under light load."
**PASS.**

**3. Isolation between customers** — one customer driven far past its limit
while a second, lighter customer runs concurrently; the second customer's
full per-request log (timestamp + status per request) is included in
`report.json` so the "zero attributable 429s" claim is independently
verifiable from the report itself. **PASS.**

**4. Randomized traffic across all 3 nodes** — requests fired through the
proxy with no client-side node targeting; `X-Served-By` confirms traffic
actually spread across `node-a`/`node-b`/`node-c`, and the aggregate
accept/deny count matched what a single coordinated limiter would produce
for the same customer and load. **PASS.**

**5. Race condition — concurrent requests fanned out to all 3 nodes
simultaneously** — the direct regression test for the bug class that sank
an earlier internal prototype. 75 concurrent requests fired directly at
the three nodes' individual ports (bypassing the proxy) against a 60 RPM
customer: exactly 60 accepted, 15 denied — the atomic Redis Lua script
held the line even under genuinely parallel evaluation across three
processes. **PASS.**

**6. Unknown customer path** — missing header returns `401`; unrecognized
customer ID returns `403`; confirmed via `docker-compose exec redis
redis-cli KEYS` that zero Redis keys were created for the unrecognized
identity. **PASS.**

**7. Northwind nightly-batch scenario** — replayed sustained 800–1200 RPM
against a temporarily mocked override window. Inside the mocked-active
window: 400/400 allowed, zero denials. Outside it (mocked-inactive,
deliberately computed to never overlap real current time, since the
harness can run at any hour including the real 02:00–04:00 window):
300 allowed, 100 denied against the base 300 RPM. The real `02:00–04:00`
override window was restored in every case via a `try/finally` block and
verified on disk after the run.

**Two real defects were caught and fixed during this process, not just
theoretical risks:**
- The `Retry-After` calculation initially only accounted for previous-bucket
  decay, giving an incorrect (too-short) wait time when the *current*
  bucket alone was already at or over the limit. Fixed by taking the
  binding constraint conditionally: time-until-window-rollover when
  `cur_count >= effectiveRpm`, decay-based wait otherwise. Verified with a
  real wait-and-retry test in both regimes.
- Northwind's override-window activation was initially being resolved
  using a placeholder/app-node value rather than Redis's own clock,
  reopening the exact cross-node clock-drift risk the design was meant to
  eliminate. Fixed by moving the window-matching decision itself inside
  the Lua script, using `redis.call('TIME')` as the only time source.

## 6. If I had 4 more hours

- **Config hot-reload** — replace the startup-only config load with a
  shared store (Redis itself, since it's already the common dependency)
  or a validated `/admin/reload-config` endpoint, so a tier change or a
  new override doesn't require restarting all three nodes.
- **`EVALSHA` over inline `EVAL`** — the Lua script is currently sent in
  full on every call; switching to `SCRIPT LOAD` + `EVALSHA` (with a
  `NOSCRIPT` fallback to reload) would cut payload size per request at
  meaningful scale.
- **Distributed fail-open ceiling** — the current Redis-outage fallback is
  a per-node in-memory counter, so three nodes each independently allow
  up to 60 RPM (effectively ~180 RPM system-wide during an outage, not a
  true 60 RPM ceiling). A short-lived local Redis replica or a
  coordinated fallback (e.g. each node claiming a fixed fraction of the
  ceiling) would tighten this guarantee.
- **Adaptive/expiring overrides** — the Northwind override is a static
  config block with an `owner`/`reviewDate` for auditability, but nothing
  enforces the review actually happens. A scheduled check (or a startup
  warning) that flags overrides past their `reviewDate` would close that
  gap.
- **Broader customer catalog in the harness** — the current harness reuses
  four config-defined test customers across all seven scenarios; a
  dedicated set of harness-only customers (created and torn down per run)
  would remove any coupling between test data and the "real" customer
  config.
- **Metrics/observability** — the `REDIS_OUTAGE_FAILOPEN` event and
  per-customer resolution `source` are currently logged but not exported
  anywhere queryable; a Prometheus counter per (customer, decision-source,
  outcome) would make the auditability claim operationally checkable, not
  just log-greppable.