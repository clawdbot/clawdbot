// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IncompleteUsageRetry, isUsageIncomplete } from "./incomplete-usage-retry.ts";

describe("isUsageIncomplete", () => {
  it("reports only what the Gateway marked incomplete", () => {
    expect(isUsageIncomplete({ refreshing: true })).toBe(true);
    expect(isUsageIncomplete({})).toBe(false);
    expect(isUsageIncomplete({ refreshing: false })).toBe(false);
  });

  it("does not treat a missing payload as incomplete", () => {
    // A disconnected page and a failed request both arrive as null; retrying that
    // would poll a Gateway the page never reached.
    expect(isUsageIncomplete(null)).toBe(false);
    expect(isUsageIncomplete(undefined)).toBe(false);
  });
});

describe("IncompleteUsageRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries an incomplete payload and reports it as incomplete", () => {
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
  });

  it("keeps reporting an exhausted payload as incomplete", () => {
    const retry = vi.fn();
    const policy = new IncompleteUsageRetry({ retry });

    for (let attempt = 0; attempt < 4; attempt += 1) {
      policy.observe(true);
      vi.advanceTimersByTime(5_000);
    }

    // Out of retries is not the same as loaded — the caller must keep its cache cold.
    expect(policy.observe(true)).toBe(true);
    expect(retry).toHaveBeenCalledTimes(3);
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

  it("gives a replaced connection its own retry budget", () => {
    const retry = vi.fn();
    const policy = new IncompleteUsageRetry({ retry });
    const first = { id: "client-a" };
    const second = { id: "client-b" };

    for (let attempt = 0; attempt < 4; attempt += 1) {
      policy.observe(true, first);
      vi.advanceTimersByTime(5_000);
    }
    expect(retry).toHaveBeenCalledTimes(3);

    // A new Gateway client is a new cold cache, not a continuation of the old one.
    policy.observe(true, second);
    vi.advanceTimersByTime(5_000);
    expect(retry).toHaveBeenCalledTimes(4);

    // The same connection keeps its remaining budget rather than restarting.
    policy.observe(true, second);
    vi.advanceTimersByTime(5_000);
    expect(retry).toHaveBeenCalledTimes(5);
  });

  it("drops a pending retry belonging to a replaced connection", () => {
    const retry = vi.fn();
    const policy = new IncompleteUsageRetry({ retry });
    const first = { id: "client-a" };

    policy.observe(true, first);
    // The swap is seen before the replacement's own payload lands, so the rekey alone
    // must drop the old timer — observe() would clear it for unrelated reasons.
    policy.useConnection({ id: "client-b" });
    vi.advanceTimersByTime(5_000);

    expect(retry).not.toHaveBeenCalled();
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
