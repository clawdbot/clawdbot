// Isolated agent timeout tests cover per-run timeout override propagation.
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, expect, it } from "vitest";
import { resolveCronRunTimeoutOverrideMs } from "./isolated-agent/run-timeout.js";

describe("resolveCronRunTimeoutOverrideMs", () => {
  // Regression: when a cron job's payload `timeoutSeconds` numerically equals
  // the configured agent default, `timeoutMs !== defaultTimeoutMs` collapses to
  // `false` in the embedded runner. The cron entry point must carry a separate
  // explicit-timeout signal so the LLM idle watchdog does not fall back to its
  // implicit 120s cap.
  it("preserves explicit payload timeoutSeconds even when it equals the agent default", () => {
    expect(resolveCronRunTimeoutOverrideMs(300)).toBe(300_000);
  });

  it("preserves explicit payload timeoutSeconds when it differs from the agent default", () => {
    expect(resolveCronRunTimeoutOverrideMs(600)).toBe(600_000);
  });

  it("caps oversized explicit payload timeoutSeconds at the timer-safe ceiling", () => {
    expect(resolveCronRunTimeoutOverrideMs(Number.MAX_SAFE_INTEGER)).toBe(MAX_TIMER_TIMEOUT_MS);
  });

  it("omits the signal when the cron payload has no positive numeric timeout", () => {
    expect(resolveCronRunTimeoutOverrideMs(undefined)).toBeUndefined();
    expect(resolveCronRunTimeoutOverrideMs(0)).toBeUndefined();
    expect(resolveCronRunTimeoutOverrideMs(-1)).toBeUndefined();
    expect(resolveCronRunTimeoutOverrideMs(Number.NaN)).toBeUndefined();
    expect(resolveCronRunTimeoutOverrideMs("300")).toBeUndefined();
  });
});
