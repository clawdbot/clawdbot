/**
 * Tests OAuth refresh timeout invariants.
 * Guards the relationship between caller deadlines, stale lock metadata, and
 * the contention retry budget.
 */
import { describe, expect, it } from "vitest";
import {
  OAUTH_REFRESH_CALL_TIMEOUT_MS,
  OAUTH_REFRESH_LOCK_OPTIONS,
  OAUTH_REFRESH_OWNERSHIP_TIMEOUT_MS,
} from "./constants.js";

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

describe("OAuth refresh caller deadlines (invariants)", () => {
  it("keeps the provider-call deadline below the ownership deadline", () => {
    expect(OAUTH_REFRESH_CALL_TIMEOUT_MS).toBeLessThan(OAUTH_REFRESH_OWNERSHIP_TIMEOUT_MS);
  });

  it("OAUTH_REFRESH_CALL_TIMEOUT_MS has a reasonable floor for OAuth token exchanges", () => {
    // 30s is a sane lower bound: typical OAuth refresh RTT is <5s, but a
    // cold TCP/TLS handshake + plugin bootstrap can push into double-digit
    // seconds. Anything below 30s would start false-positive timing out.
    expect(OAUTH_REFRESH_CALL_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
  });

  it("keeps the ownership deadline below the stale metadata window", () => {
    // Live-PID owners are never reclaimed from age alone. This margin keeps
    // incomplete/malformed sidecar classification outside the caller budget.
    expect(OAUTH_REFRESH_OWNERSHIP_TIMEOUT_MS).toBeLessThan(OAUTH_REFRESH_LOCK_OPTIONS.stale);
  });

  it("OAUTH_REFRESH_LOCK_OPTIONS.stale is well above the slow-refresh ceiling", () => {
    // Sanity check: the stale window must clearly exceed a plausible slow-
    // refresh ceiling (60s) so waiting agents never prematurely reclaim a
    // lock during a legitimate slow-but-successful refresh.
    expect(OAUTH_REFRESH_LOCK_OPTIONS.stale).toBeGreaterThan(60_000);
  });

  it("OAUTH_REFRESH_LOCK_OPTIONS retry budget outlasts the ownership deadline", () => {
    // The current caller should observe its deadline before a peer waiting on
    // retained ownership reports refresh contention.
    expect(computeMinimumRetryBudgetMs()).toBeGreaterThan(OAUTH_REFRESH_OWNERSHIP_TIMEOUT_MS);
  });
});
