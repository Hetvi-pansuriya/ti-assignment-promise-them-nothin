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
_(to be added after the load-testing harness is built and run)_

## 6. If I had 4 more hours
_(to be added at the end)_