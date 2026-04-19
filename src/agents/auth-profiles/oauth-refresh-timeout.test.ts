import { describe, expect, it } from "vitest";
import { OAUTH_REFRESH_CALL_TIMEOUT_MS, OAUTH_REFRESH_LOCK_OPTIONS } from "./constants.js";

function computeMinimumRetryBudgetMs(): number {
  let total = 0;
  for (let attempt = 0; attempt < OAUTH_REFRESH_LOCK_OPTIONS.retries.retries; attempt += 1) {
    total += Math.min(
      OAUTH_REFRESH_LOCK_OPTIONS.retries.maxTimeout,
      Math.max(
        OAUTH_REFRESH_LOCK_OPTIONS.retries.minTimeout,
        OAUTH_REFRESH_LOCK_OPTIONS.retries.minTimeout *
          OAUTH_REFRESH_LOCK_OPTIONS.retries.factor ** attempt,
      ),
    );
  }
  return total;
}

// Invariant tests for the two constants that together bound the OAuth
// refresh critical section. Behavioural tests for the inner `setTimeout`
// mechanics are deliberately omitted: the implementation is a thin
// `Promise.race` around `setTimeout`, and exercising it end-to-end requires
// stepping through nested file-lock I/O that mixes awkwardly with Vitest
// fake timers. A regression in the timeout wiring would be caught by the
// #26322 regression test (oauth.concurrent-20-agents.test.ts) because a
// stuck refresh would time out the whole suite.

describe("OAuth refresh call timeout (invariants)", () => {
  it("OAUTH_REFRESH_CALL_TIMEOUT_MS is strictly below OAUTH_REFRESH_LOCK_OPTIONS.stale", () => {
    // The whole point of the two constants: the refresh call must always
    // finish (or time out) before peers would consider the lock reclaimable.
    // If this invariant ever regresses, the #26322 race can come back.
    expect(OAUTH_REFRESH_CALL_TIMEOUT_MS).toBeLessThan(OAUTH_REFRESH_LOCK_OPTIONS.stale);
  });

  it("OAUTH_REFRESH_CALL_TIMEOUT_MS has a reasonable floor for OAuth token exchanges", () => {
    // 30s is a sane lower bound: typical OAuth refresh RTT is <5s, but a
    // cold TCP/TLS handshake + plugin bootstrap can push into double-digit
    // seconds. Anything below 30s would start false-positive aborting.
    expect(OAUTH_REFRESH_CALL_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
  });

  it("OAUTH_REFRESH_LOCK_OPTIONS.stale leaves a generous safety margin beyond the call timeout", () => {
    // Require at least 30s of headroom between the refresh deadline and
    // the stale threshold: enough to cover normal scheduling jitter and
    // the file-lock release round-trip without letting peers reclaim a
    // still-active lock.
    expect(OAUTH_REFRESH_LOCK_OPTIONS.stale - OAUTH_REFRESH_CALL_TIMEOUT_MS).toBeGreaterThanOrEqual(
      30_000,
    );
  });

  it("OAUTH_REFRESH_LOCK_OPTIONS.stale is well above the slow-refresh ceiling", () => {
    // Sanity check: the stale window must clearly exceed a plausible slow-
    // refresh ceiling (60s) so waiting agents never prematurely reclaim a
    // lock during a legitimate slow-but-successful refresh.
    expect(OAUTH_REFRESH_LOCK_OPTIONS.stale).toBeGreaterThan(60_000);
  });

  it("OAUTH_REFRESH_LOCK_OPTIONS retry budget outlasts the refresh call timeout", () => {
    // Waiters should not exhaust their retry budget while a legitimate slow
    // refresh is still within its allowed runtime budget.
    expect(computeMinimumRetryBudgetMs()).toBeGreaterThan(OAUTH_REFRESH_CALL_TIMEOUT_MS);
  });
});
