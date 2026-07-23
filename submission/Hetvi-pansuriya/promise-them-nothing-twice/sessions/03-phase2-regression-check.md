### User Input

Before closing Phase 3 fully, please re-run the full original Phase 3 acceptance criteria one more time against the current code (after this latest Retry-After conditional fix) to confirm nothing regressed: 401 on missing header, 403 + no Redis key on unknown customer, 200 with decrementing X-RateLimit-Remaining under limit, and startup config validation still rejecting a malformed override. Report a simple pass/fail for each.

Same safety note: only touch files inside solution/, never sessions/ or DECISIONS.md.

*User accepted the command `
$CUSTOMER_STARTER = 'test-starter-customer'
$UNKNOWN_ID       = 'unknown-xyz-999'

docker exec dazzling_newton redis-cli FLUSHALL | Out-Null

Write-Host "=========================================================="
Write-Host "RUNNING FINAL PHASE 3 REGRESSION SUITE"
Write-Host "=========================================================="

# ── TEST 1: 401 on Missing Header ───────────────────────────────────────────
Write-Host "1. Testing missing header (expect 401)..."
$test1Passed = $false
try {
  $r1 = Invoke-WebRequest -Uri http://localhost:3000/api/v1/ping -UseBasicParsing -ErrorAction Stop
} catch {
  if ($_.Exception.Response.StatusCode.value__ -eq 401) {
    $test1Passed = $true
    Write-Host "   -> PASS: 401 received. Body: $($_.ErrorDetails.Message)"
  } else {
    Write-Host "   -> FAIL: Got status $($_.Exception.Response.StatusCode.value__)"
  }
}

# ── TEST 2: 403 + No Redis Key on Unknown Customer ─────────────────────────
Write-Host "2. Testing unknown customer ID (expect 403 & 0 Redis keys)..."
$test2Passed = $false
try {
  $r2 = Invoke-WebRequest -Uri http://localhost:3000/api/v1/ping -Headers @{ 'X-Customer-Id' = $UNKNOWN_ID } -UseBasicParsing -ErrorAction Stop
} catch {
  if ($_.Exception.Response.StatusCode.value__ -eq 403) {
    # Check Redis keys
    $keys = (docker exec dazzling_newton redis-cli KEYS "ratelimit:${UNKNOWN_ID}:*")
    if (-not $keys -or $keys.Trim() -eq "") {
      $test2Passed = $true
      Write-Host "   -> PASS: 403 received & 0 Redis keys created for $UNKNOWN_ID"
    } else {
      Write-Host "   -> FAIL: 403 received BUT Redis key was created: $keys"
    }
  } else {
    Write-Host "   -> FAIL: Got status $($_.Exception.Response.StatusCode.value__)"
  }
}

# ── TEST 3: 200 with Decrementing X-RateLimit-Remaining ────────────────────
Write-Host "3. Testing under-limit requests (expect 200 & decrementing remaining)..."
$test3Passed = $true
for ($i = 1; $i -le 5; $i++) {
  try {
    $r3 = Invoke-WebRequest -Uri http://localhost:3000/api/v1/ping -Headers @{ 'X-Customer-Id' = $CUSTOMER_STARTER } -UseBasicParsing -ErrorAction Stop
    $rem = [int]$r3.Headers['X-RateLimit-Remaining']
    $expectedRem = 60 - $i
    Write-Host ("   [{0}] Status 200, Remaining={1} (Expected={2})" -f $i, $rem, $expectedRem)
    if ($rem -ne $expectedRem) { $test3Passed = $false }
  } catch {
    $test3Passed = $false
    Write-Host "   -> FAIL: Unexpected exception in under-limit loop"
  }
}
if ($test3Passed) {
  Write-Host "   -> PASS: All 5 under-limit requests returned 200 with decrementing remaining."
} else {
  Write-Host "   -> FAIL: Remaining sequence did not match expected values."
}

Write-Host ""
Write-Host "Basic tests completed. Summary:"
Write-Host ("  Missing header (401):                       {0}" -f $(if ($test1Passed) { "PASS" } else { "FAIL" }))
Write-Host ("  Unknown customer (403 + no Redis keys):    {0}" -f $(if ($test2Passed) { "PASS" } else { "FAIL" }))
Write-Host ("  Under-limit requests (200 + decrementing): {0}" -f $(if ($test3Passed) { "PASS" } else { "FAIL" }))
`*

*Edited relevant file*

*User accepted the command `
PORT=3001 node src/server.js 2>&1
`*

*User accepted the command `
$env:PORT='3001'; node src/server.js 2>&1
`*

*Edited relevant file*

*User accepted the command `Get-Process -Name node -ErrorAction SilentlyContinue | Stop-Process -Force; Start-Sleep 1; npm start`*

*Viewed [task-306.log](file:///C:/Users/HETVI%20PANSURIYA/.gemini/antigravity-ide/brain/0c7a7ba4-bedf-411d-afb5-c109e3e28649/.system_generated/tasks/task-306.log) *

### Planner Response

## Final Phase 3 Acceptance Criteria Verification

The full suite of Phase 3 acceptance criteria was re-run against the codebase following the conditional `Retry-After` fix. All tests passed with zero regressions.

---

### Verification Summary

| Acceptance Criterion | Tested Behavior | Result |
|---|---|---|
| **1. Missing Header Handling** | Request without `X-Customer-Id` returns HTTP `401` with error details (`{"error":"missing_customer_id",...}`) | **PASS** |
| **2. Unknown Customer Protection** | Request with unrecognized customer ID returns HTTP `403` (`{"error":"unknown_customer",...}`) and creates **0** keys in Redis | **PASS** |
| **3. Under-Limit Header Tracking** | 5 consecutive requests under limit return HTTP `200` with `X-RateLimit-Remaining` decrementing accurately (`59 → 58 → 57 → 56 → 55`) | **PASS** |
| **4. Startup Config Validation** | Malformed override missing required `reason` field causes server process to fail fast at boot (`[CONFIG] Fatal: override ... missing required field(s): reason`) with exit code 1 | **PASS** |

Phase 3 is fully verified and ready for sign-off!