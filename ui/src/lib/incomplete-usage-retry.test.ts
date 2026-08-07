// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IncompleteUsageRetry } from "./incomplete-usage-retry.ts";

describe("IncompleteUsageRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries an incomplete payload and reports the pending state", () => {
    const retry = vi.fn();
    const policy = new IncompleteUsageRetry({ retry });

    expect(policy.observe(true)).toBe(true);
    vi.advanceTimersByTime(5_000);

    expect(retry).toHaveBeenCalledOnce();
  });

  it("stops after three attempts so a refresh that never lands cannot poll", () => {
    const retry = vi.fn();
    const policy = new IncompleteUsageRetry({ retry });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      policy.observe(true);
      vi.advanceTimersByTime(5_000);
    }

    expect(retry).toHaveBeenCalledTimes(3);
    expect(policy.observe(true)).toBe(false);
  });

  it("clears the pending retry once a complete payload lands", () => {
    const retry = vi.fn();
    const policy = new IncompleteUsageRetry({ retry });

    policy.observe(true);
    expect(policy.observe(false)).toBe(false);
    vi.advanceTimersByTime(5_000);

    expect(retry).not.toHaveBeenCalled();
    // A complete payload also resets the budget for the next cold cache.
    expect(policy.observe(true)).toBe(true);
  });

  it("drops the pending retry on dispose", () => {
    const retry = vi.fn();
    const policy = new IncompleteUsageRetry({ retry });

    policy.observe(true);
    policy.dispose();
    vi.advanceTimersByTime(5_000);

    expect(retry).not.toHaveBeenCalled();
  });
});
