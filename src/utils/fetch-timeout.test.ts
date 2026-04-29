import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const warn = vi.hoisted(() => vi.fn());

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: vi.fn(() => ({
    warn,
  })),
}));

import { buildTimeoutAbortSignal } from "./fetch-timeout.js";

describe("buildTimeoutAbortSignal", () => {
  beforeEach(() => {
    warn.mockClear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("logs when its own timeout aborts the signal", async () => {
    const { signal, cleanup } = buildTimeoutAbortSignal({
      timeoutMs: 25,
      operation: "unit-test",
      url: "https://user:pass@example.com/v1/responses?api-key=secret#fragment",
    });

    await vi.advanceTimersByTimeAsync(25);

    expect(signal?.aborted).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "fetch timeout reached; aborting operation",
      expect.objectContaining({
        timeoutMs: 25,
        operation: "unit-test",
        url: "https://example.com/v1/responses",
      }),
    );

    cleanup();
  });

  it("strips query strings and hashes from relative timeout URL logs", async () => {
    const { cleanup } = buildTimeoutAbortSignal({
      timeoutMs: 25,
      operation: "unit-test",
      url: "/api/responses?api-key=secret#fragment",
    });

    await vi.advanceTimersByTimeAsync(25);

    expect(warn).toHaveBeenCalledWith(
      "fetch timeout reached; aborting operation",
      expect.objectContaining({
        url: "/api/responses",
      }),
    );

    cleanup();
  });

  it("does not log when a parent signal aborts first", async () => {
    const parent = new AbortController();
    const { signal, cleanup } = buildTimeoutAbortSignal({
      timeoutMs: 25,
      signal: parent.signal,
      operation: "unit-test",
    });

    parent.abort();
    await vi.advanceTimersByTimeAsync(25);

    expect(signal?.aborted).toBe(true);
    expect(warn).not.toHaveBeenCalled();

    cleanup();
  });
});
