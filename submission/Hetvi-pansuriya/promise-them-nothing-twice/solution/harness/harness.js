/**
 * solution/harness/harness.js
 * RelayAPI Phase 5 — Load-Testing Harness
 *
 * Runs 7 scenarios against the live Docker Compose stack.
 *
 * Usage (from solution/):
 *   node harness/harness.js
 *
 * Prerequisites:
 *   - Docker Compose stack running:  docker compose up -d
 *   - Node.js >= 18 (built-in fetch)
 *
 * Output: harness/report.json
 */

import { execSync, execFileSync }                 from 'child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname }                          from 'path';
import { fileURLToPath }                          from 'url';

const __dirname    = dirname(fileURLToPath(import.meta.url));
const SOLUTION_DIR = join(__dirname, '..');

// ── Endpoints ─────────────────────────────────────────────────────────────────
const PROXY  = 'http://localhost:8080';
const NODE_A = 'http://localhost:3001';
const NODE_B = 'http://localhost:3002';
const NODE_C = 'http://localhost:3003';

// ── Customers (from src/config/customers.json) ────────────────────────────────
const C = {
  starter:      { id: 'test-starter-customer',       rpm: 60 },
  growth:       { id: 'test-growth-customer',        rpm: 300 },
  flatOverride: { id: 'test-flat-override-customer', rpm: 500 },
  northwind:    { id: 'northwind', baseRpm: 300, overrideRpm: 1200 },
  unknown:      { id: 'no-such-customer-zzz-9999' },
};

const REDIS_CTR    = 'solution-redis-1';
const CUSTOMERS_JSON = join(SOLUTION_DIR, 'src', 'config', 'customers.json');

// ── Report ────────────────────────────────────────────────────────────────────
const REPORT = { runAt: new Date().toISOString(), scenarios: [], pass: 0, fail: 0 };

// ── Core helpers ──────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

function flushRedis() {
  execSync(`docker exec ${REDIS_CTR} redis-cli FLUSHALL`, { stdio: 'pipe' });
}

function redisKeys(pattern) {
  try {
    // Use execFileSync (not execSync) so 'pattern' is passed as a literal process
    // argument — no shell is invoked, eliminating any shell-injection risk.
    const raw = execFileSync(
      'docker',
      ['exec', REDIS_CTR, 'redis-cli', 'KEYS', pattern],
      { stdio: 'pipe' }
    ).toString().trim();
    // redis-cli in non-interactive mode returns empty string when no keys match
    return raw === '' ? [] : raw.split('\n').map(s => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Single GET /api/v1/ping.
 * customerId=undefined  → no X-Customer-Id header (tests 401 path)
 * customerId=null       → no X-Customer-Id header
 * customerId=<string>   → sends header
 */
async function req(url, customerId) {
  const timestamp = new Date().toISOString();
  const headers = {};
  if (customerId !== undefined && customerId !== null) {
    headers['X-Customer-Id'] = customerId;
  }
  try {
    const res  = await fetch(`${url}/api/v1/ping`, { headers });
    const body = await res.json().catch(() => ({}));
    return {
      timestamp,
      status:     res.status,
      servedBy:   res.headers.get('x-served-by'),
      remaining:  res.headers.get('x-ratelimit-remaining'),
      limit:      res.headers.get('x-ratelimit-limit'),
      retryAfter: res.headers.get('retry-after'),
      reset:      res.headers.get('x-ratelimit-reset'),
      body,
    };
  } catch (err) {
    return { timestamp, status: 0, error: err.message, servedBy: null, remaining: null,
             limit: null, retryAfter: null, reset: null, body: {} };
  }
}

/** Fire n requests concurrently; individual errors are caught and returned as status=0 */
async function batch(url, customerId, n) {
  return Promise.all(Array.from({ length: n }, () => req(url, customerId)));
}

function tally(results) {
  return {
    total:   results.length,
    allowed: results.filter(r => r.status === 200).length,
    denied:  results.filter(r => r.status === 429).length,
    errors:  results.filter(r => r.status === 0).length,
  };
}

function addResult(name, ok, details) {
  const status = ok ? 'PASS' : 'FAIL';
  REPORT.scenarios.push({ name, status, ...details });
  if (ok) REPORT.pass++; else REPORT.fail++;
  const icon = ok ? '✅ PASS' : '❌ FAIL';
  console.log(`\n${icon}: ${name}`);
  if (!ok) console.error('  Details:', JSON.stringify(details, null, 2));
}

async function waitForHealthy(maxMs = 90_000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${PROXY}/api/v1/health/redis`);
      if (r.status === 200) { const b = await r.json(); if (b.redis === 'connected') return; }
    } catch {}
    await sleep(2000);
  }
  throw new Error(`Stack not healthy after ${maxMs}ms`);
}

function rebuildAndRestart() {
  console.log('  ⟳ docker compose up --build -d (this may take ~30s)...');
  const t0 = Date.now();
  try {
    execSync('docker compose up --build -d', {
      cwd:     SOLUTION_DIR,
      stdio:   ['pipe', 'pipe', 'pipe'],
      timeout: 180_000,
    });
  } catch (_) {
    // docker compose may exit non-zero on Windows due to stderr progress lines.
    // We verify actual readiness via waitForHealthy() after this call.
  }
  console.log(`  ✓ rebuild finished in ${Math.round((Date.now() - t0) / 1000)}s`);
}

// ── Scenarios ─────────────────────────────────────────────────────────────────

// Scenario 1 — Exact quota-boundary enforcement
async function scenario1() {
  const name = 'Scenario 1 — Exact quota-boundary enforcement';
  console.log(`\n${'─'.repeat(62)}\n${name}`);
  const { id, rpm } = C.starter;

  // ── Part A: plain within-window sequential test ──────────────────────────
  console.log(`  [A] Flushing Redis. Sending ${rpm + 1} sequential requests...`);
  flushRedis();

  const seqR = [];
  for (let i = 0; i < rpm + 1; i++) seqR.push(await req(PROXY, id));

  const seqAllowed = seqR.filter(r => r.status === 200).length;
  const first429   = seqR.find(r => r.status === 429);
  const aPass      = seqAllowed === rpm
    && first429 !== undefined
    && parseInt(first429.retryAfter, 10) > 0;

  console.log(`    Allowed: ${seqAllowed} (want ${rpm})`);
  console.log(`    First 429 at req #${seqAllowed + 1}, Retry-After=${first429?.retryAfter}s`);

  // ── Part B: boundary-straddling test ─────────────────────────────────────
  console.log(`  [B] Boundary-straddling test...`);
  flushRedis();

  // PRE = 40: fills the old bucket to 40, so the sliding-window denial threshold
  // immediately after rollover is rpm − prev_count = 60 − 40 = 20.
  // POST = 30: the 21st post-boundary request will be denied (well within the batch).
  const PRE  = 40;  // requests to land before the minute boundary
  const POST = 30;  // requests to land after the boundary

  // Ensure we have ≥16s before a boundary: 40 reqs × ~50ms ≈ 2s to send,
  // leaving 14s buffer before the boundary to guarantee all land in the old window.
  let toRoll = 60 - (Math.floor(Date.now() / 1000) % 60);
  if (toRoll < 16) toRoll += 60;

  const waitForSetup = Math.max(0, (toRoll - 10) * 1000);
  console.log(`    Waiting ${Math.round(waitForSetup / 1000)}s to reach 10s-before-boundary position...`);
  await sleep(waitForSetup);

  // Send PRE requests (all should land before the boundary)
  let preAllowed = 0;
  for (let i = 0; i < PRE; i++) {
    const r = await req(PROXY, id);
    if (r.status === 200) preAllowed++;
  }
  console.log(`    Pre-boundary: ${preAllowed}/${PRE} allowed`);

  // Wait for the minute to roll
  const toRoll2   = 60 - (Math.floor(Date.now() / 1000) % 60);
  const rollWait  = toRoll2 + 1; // +1s safety margin
  console.log(`    Waiting ${rollWait}s for window rollover...`);
  await sleep(rollWait * 1000);

  // Send POST requests — the sliding window carries prev_count=preAllowed
  // so denial should start before POST requests reach (rpm − preAllowed).
  let postAllowed = 0, postDenied = 0;
  const firstPostDenial = { retryAfter: null };
  for (let i = 0; i < POST; i++) {
    const r = await req(PROXY, id);
    if (r.status === 200) {
      postAllowed++;
    } else {
      postDenied++;
      if (!firstPostDenial.retryAfter) firstPostDenial.retryAfter = r.retryAfter;
    }
  }
  console.log(`    Post-boundary: ${postAllowed} allowed, ${postDenied} denied`);
  console.log(`    Sliding window: prev_count=${preAllowed} → denial started after ~${rpm - preAllowed} post-boundary reqs`);

  // Key assertions:
  // - All PRE requests were allowed (prev bucket filled correctly)
  // - Some POST requests were denied (sliding window throttles using prev_count)
  const bPass = preAllowed === PRE && postDenied > 0;

  addResult(name, aPass && bPass, {
    partA: {
      sent: rpm + 1, allowed: seqAllowed, expectedAllowed: rpm,
      first429At: seqAllowed + 1, retryAfter: first429?.retryAfter,
      ratelimitHeaders: { limit: first429?.limit, remaining: first429?.remaining },
      pass: aPass,
    },
    partB: {
      preBoundary: { sent: PRE, allowed: preAllowed },
      postBoundary: { sent: POST, allowed: postAllowed, denied: postDenied,
                      firstDenialRetryAfter: firstPostDenial.retryAfter },
      slidingWindowApplied: postDenied > 0,
      pass: bPass,
    },
  });
}

// Scenario 2 — Fairness between same-tier customers
async function scenario2() {
  const name = 'Scenario 2 — Fairness between same-tier customers';
  console.log(`\n${'─'.repeat(62)}\n${name}`);

  // Both on growth tier in config (contractedRpm: 300):
  //   custA: test-growth-customer        — effective limit 300 RPM (no overrides)
  //   custB: test-flat-override-customer  — effective limit 500 RPM (flat 00:00-23:59 override)
  //
  // Each is sent exactly its own effective limit's worth concurrently.
  // If rate-limit buckets were shared across same-tier customers (a bug), custA would see
  // denials because combined traffic (800) far exceeds any shared pool.
  // If isolated (correct), each customer gets 100% of its own quota with 0 denials.
  const custA = C.growth;       // effective limit 300 RPM
  const custB = C.flatOverride; // effective limit 500 RPM
  const NA = custA.rpm;         // 300 — custA's full quota
  const NB = custB.rpm;         // 500 — custB's full quota

  flushRedis();
  console.log(`  Firing ${NA} reqs for ${custA.id} (limit=${NA}) and ${NB} reqs for ${custB.id} (limit=${NB}) concurrently (${NA + NB} total)...`);

  const [resA, resB] = await Promise.all([
    batch(PROXY, custA.id, NA),
    batch(PROXY, custB.id, NB),
  ]);

  const tA = tally(resA);
  const tB = tally(resB);

  console.log(`  ${custA.id}: allowed=${tA.allowed}/${NA} denied=${tA.denied}`);
  console.log(`  ${custB.id}: allowed=${tB.allowed}/${NB} denied=${tB.denied}`);

  const ok = tA.allowed === NA && tA.denied === 0 && tB.allowed === NB && tB.denied === 0;
  addResult(name, ok, {
    tier: 'growth',
    customerA: { id: custA.id, effectiveLimit: NA, sent: NA, ...tA },
    customerB: { id: custB.id, effectiveLimit: NB, sent: NB, ...tB },
    totalSent: NA + NB,
    eachGotFullQuotaAccepted: ok,
    note: ok
      ? 'Both customers accepted 100% of their own quota concurrently with 0 denials'
      : 'FAIL: denials detected — rate-limit buckets may not be correctly isolated',
  });
}

// Scenario 3 — Isolation between customers
async function scenario3() {
  const name = 'Scenario 3 — Isolation between customers';
  console.log(`\n${'─'.repeat(62)}\n${name}`);

  const heavy = C.starter; // blasted 5× past its 60 RPM limit
  const light  = C.growth;  // light traffic well under its 300 RPM limit
  const heavyN = heavy.rpm * 5; // 300 requests for a 60 RPM customer
  const lightN = 20;

  flushRedis();
  console.log(`  Heavy (${heavy.id}): ${heavyN} concurrent (limit=${heavy.rpm})`);
  console.log(`  Light (${light.id}): ${lightN} concurrent (limit=${light.rpm})`);

  const [hRes, lRes] = await Promise.all([
    batch(PROXY, heavy.id, heavyN),
    batch(PROXY, light.id, lightN),
  ]);

  const hT = tally(hRes);
  const lT = tally(lRes);

  const fullLightLog = lRes.map((r, i) => ({
    req: i + 1,
    timestamp: r.timestamp,
    status: r.status,
    servedBy: r.servedBy,
    remaining: r.remaining,
  }));

  console.log(`  Heavy: allowed=${hT.allowed} denied=${hT.denied}`);
  console.log(`  Light: allowed=${lT.allowed} denied=${lT.denied}  ← must be 0`);

  const ok = lT.denied === 0 && lT.allowed === lightN && hT.denied > 0;
  addResult(name, ok, {
    heavy: { id: heavy.id, limit: heavy.rpm, sent: heavyN, ...hT },
    light: {
      id: light.id, limit: light.rpm, sent: lightN, ...lT,
      isolationHolds: lT.denied === 0,
      fullResponseLog: fullLightLog,
    },
  });
}

// Scenario 4 — Randomized traffic across all 3 nodes
async function scenario4() {
  const name = 'Scenario 4 — Randomized traffic across all 3 nodes';
  console.log(`\n${'─'.repeat(62)}\n${name}`);

  const { id, rpm } = C.growth;
  const N = 90; // 30 per node in round-robin; well under 300 RPM limit

  flushRedis();
  console.log(`  Sending ${N} concurrent requests via proxy for ${id}...`);

  const results = await batch(PROXY, id, N);
  const t = tally(results);

  const dist = {};
  for (const r of results) {
    const node = r.servedBy ?? 'unknown';
    dist[node] = (dist[node] ?? 0) + 1;
  }

  const allUsed     = ['node-a', 'node-b', 'node-c'].every(n => (dist[n] ?? 0) > 0);
  const correctTotals = t.allowed === N && t.denied === 0;

  console.log(`  Distribution: ${JSON.stringify(dist)}`);
  console.log(`  Allowed=${t.allowed} Denied=${t.denied}`);

  addResult(name, allUsed && correctTotals, {
    customer: id, limit: rpm, sent: N, ...t,
    nodeDistribution: dist,
    allThreeNodesServedRequests: allUsed,
    aggregateMatchesSingleNodeBehavior: correctTotals,
    note: `${N} requests < limit ${rpm} → all should be allowed across all 3 nodes combined`,
  });
}

// Scenario 5 — Race condition: simultaneous fan-out across nodes
async function scenario5() {
  const name = 'Scenario 5 — Race condition: simultaneous fan-out across nodes';
  console.log(`\n${'─'.repeat(62)}\n${name}`);

  const { id, rpm } = C.starter; // 60 RPM
  const perNode = 25;            // 75 total = 15 over limit

  flushRedis();
  console.log(`  Bypassing proxy. Firing ${perNode} reqs × 3 nodes = ${perNode * 3} total simultaneously...`);
  console.log(`  Customer: ${id} | Limit: ${rpm} | Over-limit by: ${perNode * 3 - rpm}`);

  // All 75 Promises are created before any resolve — genuine simultaneous fan-out
  const allReqs = [
    ...Array.from({ length: perNode }, () => req(NODE_A, id)),
    ...Array.from({ length: perNode }, () => req(NODE_B, id)),
    ...Array.from({ length: perNode }, () => req(NODE_C, id)),
  ];
  const results = await Promise.all(allReqs);

  const totalAllowed = results.filter(r => r.status === 200).length;
  const total429     = results.filter(r => r.status === 429).length;
  const exceeded     = totalAllowed > rpm;

  console.log(`  Allowed=${totalAllowed}  Denied=${total429}  Limit=${rpm}`);
  console.log(`  Overcount: ${exceeded ? 'YES ❌ (atomic Lua FAILED)' : 'NO ✓ (atomic Lua HOLDS)'}`);

  addResult(name, !exceeded, {
    customer: id, limit: rpm, perNode, totalSent: perNode * 3,
    totalAllowed, total429,
    limitExceeded: exceeded,
    atomicLuaPreventedRaceCondition: !exceeded,
  });
}

// Scenario 6 — Unknown customer path
async function scenario6() {
  const name = 'Scenario 6 — Unknown customer path';
  console.log(`\n${'─'.repeat(62)}\n${name}`);

  // Test 1: No X-Customer-Id header → 401
  const noHdr = await req(PROXY, undefined);
  const t1 = noHdr.status === 401;
  console.log(`  No header → ${noHdr.status} (want 401) ${t1 ? '✓' : '✗'}`);

  // Test 2: Unknown customer ID → 403 (not 429, not 401)
  const ukId  = C.unknown.id;
  const ukRes = await req(PROXY, ukId);
  const t2    = ukRes.status === 403;
  console.log(`  Unknown ID "${ukId}" → ${ukRes.status} (want 403) ${t2 ? '✓' : '✗'}`);

  // Test 3: No Redis key was created for the unknown customer
  // Redis isn't reachable from host directly (Phase 4 design), so we go through docker exec.
  const pattern = `ratelimit:${ukId}:*`;
  const keysCmd = `docker exec ${REDIS_CTR} redis-cli KEYS "${pattern}"`;
  const keys    = redisKeys(pattern);
  const t3      = keys.length === 0;
  console.log(`  Redis KEYS "${pattern}" → ${JSON.stringify(keys)} (want []) ${t3 ? '✓' : '✗'}`);
  console.log(`  (Checked via: ${keysCmd})`);

  addResult(name, t1 && t2 && t3, {
    noHeaderRequest:  { status: noHdr.status, expected: 401, body: noHdr.body, pass: t1 },
    unknownCustomer:  { id: ukId, status: ukRes.status, expected: 403, body: ukRes.body, pass: t2 },
    redisKeyCheck: {
      command: keysCmd,
      pattern,
      keysFound: keys,
      noKeyCreated: t3,
      note: `Checked via docker exec because Redis port is not published to host (Phase 4 design)`,
      pass: t3,
    },
  });
}

// Scenario 7 — Northwind nightly-batch scenario
async function scenario7() {
  const name = 'Scenario 7 — Northwind nightly-batch scenario';
  console.log(`\n${'─'.repeat(62)}\n${name}`);

  const original  = readFileSync(CUSTOMERS_JSON, 'utf8');
  const origParsed = JSON.parse(original);
  const origWin   = origParsed.customers.northwind.overrides[0].window;
  const { id, baseRpm, overrideRpm } = C.northwind;

  const now  = new Date();
  const utcH = now.getUTCHours().toString().padStart(2, '0');
  const utcM = now.getUTCMinutes().toString().padStart(2, '0');
  console.log(`  Current UTC: ${utcH}:${utcM}`);
  console.log(`  Original northwind window: ${origWin.startUtc}–${origWin.endUtc}`);

  // Mock ACTIVE window: 00:00–23:59 covers any UTC time.
  const mockWin = { startUtc: '00:00', endUtc: '23:59' };
  console.log(`  Mock active window:   ${mockWin.startUtc}–${mockWin.endUtc} (covers current time)`);

  // Mock INACTIVE window: placed 6 hours ahead of current UTC, no midnight crossing.
  // This guarantees the override is inactive regardless of when the harness runs —
  // avoids the failure mode where restoring the original 02:00–04:00 window is still
  // "active" if the test runs between 02:00 and 04:00 UTC.
  const curH = now.getUTCHours();
  let inactiveStartH = (curH + 6) % 24;
  if (inactiveStartH + 2 >= 24) inactiveStartH = (inactiveStartH - 4 + 24) % 24;
  const mockInactiveWin = {
    startUtc: `${String(inactiveStartH).padStart(2, '0')}:00`,
    endUtc:   `${String(inactiveStartH + 2).padStart(2, '0')}:00`,
  };
  console.log(`  Mock inactive window: ${mockInactiveWin.startUtc}–${mockInactiveWin.endUtc} (does not cover current time)`);

  let pA = false, pB = false, windowOk = false;
  let insideT = {}, outsideT = {}, restoredWin = {};

  try {
    // ── Part A: mock ACTIVE window (00:00–23:59) ───────────────────────────────
    console.log('\n  [Part A] Applying mock ACTIVE override window...');
    const mockedA = JSON.parse(original);
    mockedA.customers.northwind.overrides[0].window = mockWin;
    writeFileSync(CUSTOMERS_JSON, JSON.stringify(mockedA, null, 2));

    rebuildAndRestart();
    await waitForHealthy();
    flushRedis();

    // 400 concurrent requests: above base (300) but below override (1200)
    // If override active → all 400 allowed; if base active → ~300 allowed, ~100 denied
    const insideN = 400;
    console.log(`  Sending ${insideN} concurrent requests (${baseRpm} < ${insideN} < ${overrideRpm})...`);
    const insideRes = await batch(PROXY, id, insideN);
    insideT = tally(insideRes);
    pA = insideT.denied === 0 && insideT.allowed === insideN;
    console.log(`  Inside window: allowed=${insideT.allowed} denied=${insideT.denied} (want 0 denied)`);

    // ── Part B: mock INACTIVE window (computed, never covers current time) ──────
    console.log(`\n  [Part B] Applying mock INACTIVE window (${mockInactiveWin.startUtc}–${mockInactiveWin.endUtc})...`);
    const mockedB = JSON.parse(original);
    mockedB.customers.northwind.overrides[0].window = mockInactiveWin;
    writeFileSync(CUSTOMERS_JSON, JSON.stringify(mockedB, null, 2));

    rebuildAndRestart();
    await waitForHealthy();
    flushRedis();

    // Override now inactive → base 300 RPM applies → expect denials after ~300
    const outsideN = 400;
    console.log(`  Sending ${outsideN} concurrent requests (base=${baseRpm} limit, override inactive)...`);
    const outsideRes = await batch(PROXY, id, outsideN);
    outsideT = tally(outsideRes);
    pB = outsideT.denied > 0 && outsideT.allowed <= baseRpm;
    console.log(`  Outside window: allowed=${outsideT.allowed} denied=${outsideT.denied} (want denied>0, allowed<=${baseRpm})`);

  } finally {
    // ── Always restore original customers.json ────────────────────────────────
    console.log('\n  [Cleanup] Restoring original customers.json...');
    writeFileSync(CUSTOMERS_JSON, original);

    const verifyParsed = JSON.parse(readFileSync(CUSTOMERS_JSON, 'utf8'));
    restoredWin = verifyParsed.customers.northwind.overrides[0].window;
    windowOk = restoredWin.startUtc === '02:00' && restoredWin.endUtc === '04:00';
    console.log(`  Restored window: ${restoredWin.startUtc}–${restoredWin.endUtc} — ${windowOk ? '✓ CONFIRMED' : '✗ MISMATCH'}`);

    rebuildAndRestart();
    await waitForHealthy();
    flushRedis();
  }

  addResult(name, pA && pB && windowOk, {
    currentUtc: `${utcH}:${utcM}`,
    originalWindow: origWin,
    mockActiveWindow: mockWin,
    mockInactiveWindow: mockInactiveWin,
    partA: {
      description: `Override active (${mockWin.startUtc}–${mockWin.endUtc}): ${insideT.total} reqs above base but below override`,
      sent: insideT.total, ...insideT, expectedZeroDenied: true, pass: pA,
    },
    partB: {
      description: `Override inactive (${mockInactiveWin.startUtc}–${mockInactiveWin.endUtc}): same load against base=${baseRpm}`,
      sent: outsideT.total, ...outsideT, expectedDenialsAfterBaseLimit: true, pass: pB,
    },
    customersJsonRestored: {
      window: restoredWin,
      expectedWindow: { startUtc: '02:00', endUtc: '04:00' },
      confirmed: windowOk,
    },
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('RelayAPI Phase 5 — Load-Testing Harness');
  console.log('='.repeat(62));
  console.log(`Started:  ${new Date().toISOString()}`);
  console.log(`Proxy:    ${PROXY}`);
  console.log(`Nodes:    ${NODE_A}  ${NODE_B}  ${NODE_C}`);

  // ── Preflight ─────────────────────────────────────────────────────────────
  console.log('\n[Preflight] Verifying Docker Compose stack health...');
  try {
    await waitForHealthy(10_000);
    const r = await req(PROXY, C.starter.id);
    console.log(`✓ Stack up. Proxy ping → status=${r.status}, X-Served-By=${r.servedBy}`);
  } catch (e) {
    console.error('✗ Stack not healthy:', e.message);
    console.error('  Start with: docker compose up -d   (from solution/)');
    process.exit(1);
  }

  // ── Run all 7 scenarios ───────────────────────────────────────────────────
  await scenario1();
  await scenario2();
  await scenario3();
  await scenario4();
  await scenario5();
  await scenario6();
  await scenario7();

  // ── Write report ──────────────────────────────────────────────────────────
  REPORT.completedAt = new Date().toISOString();
  REPORT.summary = {
    totalScenarios: REPORT.pass + REPORT.fail,
    passed: REPORT.pass,
    failed: REPORT.fail,
  };

  mkdirSync(__dirname, { recursive: true });
  const reportPath = join(__dirname, 'report.json');
  writeFileSync(reportPath, JSON.stringify(REPORT, null, 2));

  console.log('\n' + '='.repeat(62));
  console.log(`DONE: ${REPORT.pass} PASSED, ${REPORT.fail} FAILED`);
  console.log(`Report: ${reportPath}`);
  console.log('='.repeat(62));

  process.exit(REPORT.fail > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('HARNESS CRASHED:', err);
  process.exit(1);
});
