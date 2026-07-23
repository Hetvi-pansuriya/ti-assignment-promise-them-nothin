i'm building a take-home assignment for a job application and before writing any code, i want to design the system properly.

project context:
 the scenario is based on fictional company called RelayAPI, a B2B API platform that sells metered HTTP APIs to customers. every customer has a contracted requests-per-minute (RPM) quota. traffic is distributed across three stateless application nodes behind a round-robin load balancer. there are no sticky sessions and no shared memory between the application nodes. customer identity is provided by the API gateway through a trusted X-Customer-Id request header.

 the customer tiers are: 
 starter: 60 RPM (large number of smaller customers)
 growth:300 RPM (default plan for new customers)
 enterprise: custom negotiated limits

one customer, northwind logistics, is is especially important because it represents about 60% of recurring revenue. although their contract says 300 RPM, they run a nightly batch process between 02:00 and 04:00 UTC that consistently generates around 800–1200 RPM for roughly 90–120 minutes. if they begin receiving rate limits, their retry behavior increases traffic even further.    

additional history:
a previous rate limiter was decommissioned because it didn't correctly enforce limits across the load-balanced nodes. a later prototype had correctness bugs specifically at quota boundaries under northwind-scale traffic and was rolled back before it ever reached production. enterprise customers also expect a short, clear explanation of the counting method for their own security reviews.

conflicting requiremnts:
there are 2 stackholders with conflicting expectations.

the cto wants the system to provide hard rate limit enforcement using HTTP 429 with a proper retry after header, complete isolation between custoners so one customers's traffic can never consume another customer quota, strict fairness between customers on the same tier, fill auditability of how requests are counted, ans no hidden exceptions or hardcoded bypasses in code, any exception must be configuration deiven, documented and auditable. she is comfortable with eventual consistency across the distributed nodes as long as any edge cases lean toward under-limiting rather than over-limiting. her sucess criteria is, two customers on a 100RPM tier should each always receive theor own full 100RPM, while third customer exceeding 100RPM should be correctly rate-limited, even requests are randomly distributed across all the application nodes.
the head support requires that northwind must never receive 429 response during its nightly batch window, regardless of what their contact currrenty says because losing this customer would have a major busniess impact. he also makes clear that rate-limiting should not be disable globally, only this specific customer's batch worlload should be guaranteed to succeed, and the exception should ve invisible to the customer
what decision i make:
 i'm intentionally not going to satisfy both stackholders requests literally, insted i will introduce a configuration-driven customer override for northwind . rather than hiding a bypass in appliacation node, northwide cleary named, documented and sufitable configuration entry that increases its effective limit during the nightly batch window to match actual traffic pattern of roughly 800-1200 RPM. 

this satisfies the cto's requirements of no hidden code bypass, everything is explicit configuration with an audit taril), and the supprots lead's requiements that northwide's batch process completes without 429, while rate limiting stays fully active and fair for every other customer

tech stack: 
node.js, express.js, redis as the centralized shared store for distributed rate-limit counters, and docker compose to simulates the full deployment (3 application nodes+redis). redis is choosen beczuse the application nodes are stateless ans share no memory, meking it the right place to coordinate rate-limit state acorss the cluster.

rate limiting algorithm:
a sliding window counter (hybrid approach) implemented in reids, better boundary behavior than other algorithms(fixed size window, etc), while staying a well understood,prduction friendly approach rather than something custom.

scope:
a thin vertical slice: a single endpoint ( GET/api/v1/ping ), real express middleware implemeting distributed rate limiting configuration for starter/growth/enterprice tiers plus northwind stand -in with its overrode, a docker compose environment with reids + three independent app nodes and a testing harness that simulates traffic accorss the distibuted deployment.

project structure:

solution/
├── README.md              (setup + how to run, target: runnable in under 15 minutes)
├── package.json
├── server.js               (or src/, your call — explain why)
├── config/customers.json   (tier + Northwind override config)
├── docker-compose.yml      (3 app nodes + Redis)
└── harness/load-test.js    (load generator + report output)
sessions/                   (my AI working session exports, one file per phase)
DECISIONS.md                (conflict resolution, technical choices, what I'd do with 4 more hours)

what i want from you right now is:
don't write any implementation code yet, i want a complete desgin plan first, broken into the following phases, so i can review it and approve the plan befoew we build anything.

overall architecture : how a request flows from arrival to rate-limit decision, and how the pieces (express app, middleware, redis, config) fit together.

the middleware's internal logic in detail :  how it reads customer identity, loads config, performs the distributed rate-limit calculation in redis, records the request, and decides allow vs. 429 with the correct retry-After.

the redis data model : exact key naming per customer, what's stored in each key, how expiration works, and how this design guarantees correctness and fairness across all three nodes.

the docker compose setup : how the three node containers and redis will be networked, and how this setup realistically simulates a load-balanced multi-node production deployment.

the load-testing harness design :  how it will prove: exact quota-boundary enforcement, fairness between multiple same-tier customers, isolation between customers, correct behavior under randomized traffic across all three nodes, and correct handling of race conditions where two requests for the same customer land on different nodes almost simultaneously.

The Northwind override :  how the config entry will be structured and documented so it's clearly auditable and not a hidden bypass.

Lay out this full plan clearly, phase by phase, before we write any code.

Show more

Architected comprehensive design document for iterative review before implementation
Architected comprehensive design document for iterative review before implementation
This is a solid set of constraints, and your resolution on the Northwind conflict is the right call — I'll build the full design around it. Here's the complete plan before any code gets written.


Created a file, read a file
Created a file, read a file
The plan's built around one core idea: Redis atomicity via Lua fixes the boundary-race bug class that killed the earlier prototype, and the Northwind override is just data flowing through that same single enforcement path — never a second path.

A few things I flagged as open decisions rather than silently picking one, since they change the character of the system:

Redis-outage behavior — I defaulted to "fail open with a low hard-coded safe ceiling" rather than fully open or fully closed. Worth confirming that matches your intent, since "fail closed" is the more literal reading of the CTO's under-limit preference, but it also means a Redis blip takes down the whole API.
Fixed UTC window vs. adaptive detection for the Northwind override — I went with fixed window (02:00–04:00 UTC) for simplicity and auditability.
Unknown customer → growth default vs. hard rejection.
src/ split vs. flat server.js.
Take a look and let me know what you'd change — once you approve, I'll move to implementation in the same phase order.


Design plan
Document · MD 
this design looks solid. before we move to implementation, please incorporate these corrections:

clarify and fix the time source for the sliding window calculation: the Lua script must use redis's own server-side clock (redis.call('TIME')), not a timestamp passed in from the app node, so clock drift between the three docker containers can never affect window-boundary correctness.

add a documented limitation to DECISIONS.md: customer config is loaded once at app startup, not hot-reloaded across nodes; note what a production fix would look like (shared config store or reload endpoint).

add a harness test case for the "unknown customer" path.

add a short paragraph plan for DECISIONS.md explaining the request-counting semantics in plain language, for enterprise customer security reviews.

my decisions on your open questions: fail-open with a safe ceiling equal to the Starter tier limit (60 RPM) on Redis outage, fixed UTC window for the Northwind override, reject unknown customers outright with a 403 rather than defaulting them to the growth tier and use a structured src/ layout (middleware/, redis/, config/) rather than a flat server.js.
Please update the design plan with these changes before we start implementation.

Show more

Orchestrated multi-phase design corrections across timing, configuration, and testing requirements
Orchestrated multi-phase design corrections across timing, configuration, and testing requirements
Now let me add the DECISIONS.md content plan (config hot-reload limitation, plain-language counting semantics) and update the sign-off/open-questions section since those decisions are now resolved.


Add DECISIONS.md content plan section covering the config hot-reload limitation and plain-language counting semantics
Add DECISIONS.md content plan section covering the config hot-reload limitation and plain-language counting semantics
All five corrections are incorporated. Quick summary of what changed:

Time source — the Lua script now calls redis.call('TIME') itself as its first operation; no timestamp is ever passed in from a node. I spelled out why explicitly: if window-boundary math depended on each container's own clock, disagreement between nodes could quietly reopen the same bug class that killed the earlier prototype.
Config hot-reload limitation — new DECISIONS.md section (7.1) stating config loads once at startup per node, describing the transient cross-node inconsistency window that creates, and sketching the production fix (shared config store in Redis, or a reload endpoint/pub-sub signal).
Unknown-customer test — added as 5.6: asserts 403, not 429, no Redis keys created, no effect on real customers.
Plain-language counting semantics — added as 7.2, a short paragraph aimed at an enterprise reviewer covering sliding window, single shared store, atomicity, and server-agnostic enforcement.
Your four open-question decisions — all folded into the relevant phases (fail-open ceiling in 2/Step 5, fixed UTC window already in Phase 6, 403-on-unknown as new Step 2b, src/ layout confirmed) and logged as resolved at the bottom rather than left as questions.
The file at /mnt/user-data/outputs/DESIGN_PLAN.md is updated in place. Ready to move to implementation whenever you give the go-ahead — I'd suggest starting with the src/config loader and the Lua script first, since everything else in the middleware depends on both being correct.