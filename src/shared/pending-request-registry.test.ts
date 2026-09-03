import { afterEach, describe, expect, it, vi } from "vitest";
import { createPendingRequestRegistry } from "./pending-request-registry.js";

describe("createPendingRequestRegistry", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("unrefs each request timeout", () => {
    const registry = createPendingRequestRegistry<string, void, undefined>();
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");

    const entry = registry.add("request", {
      value: undefined,
      timeoutMs: 60_000,
      timeoutError: () => new Error("timed out"),
    });

    const timer = timeoutSpy.mock.results[0]?.value as NodeJS.Timeout | undefined;
    expect(entry).toBeDefined();
    expect(timer?.hasRef()).toBe(false);
    registry.take("request", entry);
  });

  it("takes only the expected entry and settles a timeout once", async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const registry = createPendingRequestRegistry<string, string, string>();
    const first = registry.add("first", {
      value: "first-value",
      timeoutMs: 10,
      timeoutError: () => new Error("first timed out"),
      onTimeout,
    });
    const other = registry.add("other", {
      value: "other-value",
      timeoutMs: 20,
      timeoutError: () => new Error("other timed out"),
    });
    if (!first || !other) {
      throw new Error("expected pending requests");
    }

    expect(registry.take("first", other)).toBeUndefined();
    const rejected = expect(first.promise).rejects.toThrow("first timed out");
    await vi.advanceTimersByTimeAsync(10);

    await rejected;
    expect(onTimeout).toHaveBeenCalledOnce();
    expect(registry.take("first", first)).toBeUndefined();
    registry.take("other", other);
  });

  it("rejects every live entry and runs cleanup once", async () => {
    vi.useFakeTimers();
    const dispose = vi.fn();
    const registry = createPendingRequestRegistry<string, void, undefined>();
    const first = registry.add("first", {
      value: undefined,
      timeoutMs: 100,
      timeoutError: () => new Error("timed out"),
      dispose,
    });
    const second = registry.add("second", {
      value: undefined,
      timeoutMs: 100,
      timeoutError: () => new Error("timed out"),
      dispose,
    });
    if (!first || !second) {
      throw new Error("expected pending requests");
    }
    const stopped = new Error("stopped");
    const firstRejected = expect(first.promise).rejects.toBe(stopped);
    const secondRejected = expect(second.promise).rejects.toBe(stopped);

    registry.rejectAll(stopped);

    await firstRejected;
    await secondRejected;
    expect(dispose).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
