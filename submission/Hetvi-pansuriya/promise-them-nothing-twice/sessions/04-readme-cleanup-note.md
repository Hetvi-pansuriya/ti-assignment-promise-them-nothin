### User Input

Phase 4 is verified and looks correct. One small housekeeping addition before moving to Phase 5: please add a short note to solution/README.md under the setup/run instructions, warning that any locally-running Redis or Node process from earlier manual testing (e.g. a container started with docker run -p 6379:6379) should be stopped before running docker-compose up, since a leftover container can falsely appear to make Redis reachable from the host or cause port conflicts — this exact issue was encountered and resolved during Phase 4 verification (the stale dazzling_newton container). No other changes needed.

Same safety note: only touch files inside solution/, never sessions/ or DECISIONS.md.

*Edited relevant file*

*Viewed [04-docker-compose-build.md](file:///c:/Users/HETVI%20PANSURIYA/OneDrive/Desktop/ti-assignment-promise-them-nothin/submission/Hetvi-pansuriya/promise-them-nothing-twice/sessions/04-docker-compose-build.md) *

### Planner Response

First, read the current README before touching it:

*Viewed [README.md](file:///c:/Users/HETVI%20PANSURIYA/OneDrive/Desktop/ti-assignment-promise-them-nothin/submission/Hetvi-pansuriya/promise-them-nothing-twice/solution/README.md) *

### Planner Response

The README is clearly Phase 2-era. The right place to add the warning is right before or within the section that now describes the Docker Compose run flow — which doesn't exist yet as a section. I'll add it as a new section immediately after the existing "Prerequisites" section, keeping everything else intact. This is the natural place where a reader about to run `docker compose up` would be:

*Edited relevant file*

### Planner Response

Now verify the result looks right around the insertion point:

*Viewed [README.md](file:///c:/Users/HETVI%20PANSURIYA/OneDrive/Desktop/ti-assignment-promise-them-nothin/submission/Hetvi-pansuriya/promise-them-nothing-twice/solution/README.md) *

### Planner Response

The "Install & run" section heading got dropped in the insertion. Let me fix that — the blank line at 92 before the code block is missing the section heading:

*Edited relevant file*

*Viewed [README.md](file:///c:/Users/HETVI%20PANSURIYA/OneDrive/Desktop/ti-assignment-promise-them-nothin/submission/Hetvi-pansuriya/promise-them-nothing-twice/solution/README.md) *

*Edited relevant file*

### Planner Response

Now do a final read of the whole file to confirm it's clean end-to-end:

*Viewed [README.md](file:///c:/Users/HETVI%20PANSURIYA/OneDrive/Desktop/ti-assignment-promise-them-nothin/submission/Hetvi-pansuriya/promise-them-nothing-twice/solution/README.md) *

### Planner Response

The README is clean. The new section sits at lines 56–90, between **Prerequisites** and **Install & run**, exactly where a reader would encounter it before trying to run the Compose stack. Everything else is intact and unmodified.

---

**What was added** — a new [`## Before running docker compose up`](file:///c:/Users/HETVI%20PANSURIYA/OneDrive/Desktop/ti-assignment-promise-them-nothin/submission/Hetvi-pansuriya/promise-them-nothing-twice/solution/README.md#L56-L90) section covering:

- **Why** a stale container causes the problem (holds the host port even though Compose Redis has no `ports:` mapping), and the **two failure modes** it causes (port conflict at startup, or false positive on the Redis-reachable test)
- **The specific incident** — the `dazzling_newton` container from Phase 2/3 development
- **Stale Node process** risk (holds port 3000)
- **Concrete clean-up commands** for both Windows (PowerShell) and macOS/Linux
- A **verification step** (`docker ps --filter publish=6379`) to confirm port 6379 is clear before running `docker compose up`

No other files were touched.