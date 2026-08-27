// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IncompleteUsageRetry, isUsageIncomplete } from "./incomplete-usage-retry.ts";

describe("IncompleteUsageRetry", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("recognizes only an explicit incomplete marker", () => {
    expect(isUsageIncomplete({ refreshing: true })).toBe(true);
    expect(isUsageIncomplete({ refreshing: false })).toBe(false);
    expect(isUsageIncomplete(null)).toBe(false);
  });

  it("reports exhaustion once the three delayed attempts are spent", () => {
    const retry = vi.fn();
    const policy = new IncompleteUsageRetry({ retry });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(policy.observe(true)).toBe("retrying");
      vi.advanceTimersByTime(5_000);
    }
    expect(retry).toHaveBeenCalledTimes(3);
    // Nothing schedules another attempt, so the page owns the outcome from here.
    expect(policy.observe(true)).toBe("exhausted");
    vi.advanceTimersByTime(5_000);
    expect(retry).toHaveBeenCalledTimes(3);
  });

  it("resets on completion or connection replacement", () => {
    const retry = vi.fn();
    const policy = new IncompleteUsageRetry({ retry });
    const first = {};
    for (let attempt = 0; attempt < 4; attempt += 1) {
      policy.observe(true, first);
      vi.advanceTimersByTime(5_000);
    }
    expect(retry).toHaveBeenCalledTimes(3);

    policy.observe(true, {});
    vi.advanceTimersByTime(5_000);
    expect(retry).toHaveBeenCalledTimes(4);
    expect(policy.observe(false)).toBe("complete");
  });

  it("cancels timers on connection replacement and disposal", () => {
    const retry = vi.fn();
    const policy = new IncompleteUsageRetry({ retry });
    policy.observe(true, {});
    policy.useConnection({});
    vi.advanceTimersByTime(5_000);
    expect(retry).not.toHaveBeenCalled();

    policy.observe(true);
    policy.dispose();
    vi.advanceTimersByTime(5_000);
    expect(retry).not.toHaveBeenCalled();
  });

  it("lets an independent cycle retry after exhaustion without poll self-rearming", () => {
    const retry = vi.fn();
    const policy = new IncompleteUsageRetry({ retry });
    for (let attempt = 0; attempt < 4; attempt += 1) {
      policy.observe(true);
      vi.advanceTimersByTime(5_000);
    }
    expect(retry).toHaveBeenCalledTimes(3);

    policy.startCycle();
    expect(policy.observe(true)).toBe("retrying");
    vi.advanceTimersByTime(5_000);
    expect(retry).toHaveBeenCalledTimes(4);
  });
});
