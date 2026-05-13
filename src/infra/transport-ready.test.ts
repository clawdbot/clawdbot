import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const transportReadyMocks = vi.hoisted(() => ({
  injectedSleepError: null as Error | null,
}));

type TransportReadyModule = typeof import("./transport-ready.js");
let waitForTransportReady: TransportReadyModule["waitForTransportReady"];

vi.mock("./backoff.js", () => ({
  sleepWithAbort: async (ms: number, signal?: AbortSignal) => {
    if (transportReadyMocks.injectedSleepError) {
      throw transportReadyMocks.injectedSleepError;
    }
    if (signal?.aborted) {
      throw new Error("aborted");
    }
    if (ms <= 0) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(new Error("aborted"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  },
}));

function createRuntime() {
  return { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
}

function runtimeErrorMessageAt(runtime: ReturnType<typeof createRuntime>, index: number): string {
  const call = runtime.error.mock.calls[index];
  if (!call || typeof call[0] !== "string") {
    throw new Error(`expected runtime error call ${index + 1}`);
  }
  return call[0];
}

function latestRuntimeErrorMessage(runtime: ReturnType<typeof createRuntime>): string {
  return runtimeErrorMessageAt(runtime, runtime.error.mock.calls.length - 1);
}

describe("waitForTransportReady", () => {
  beforeAll(async () => {
    ({ waitForTransportReady } = await import("./transport-ready.js"));
  });

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    transportReadyMocks.injectedSleepError = null;
  });

  it("returns when the check succeeds and logs after the delay", async () => {
    const runtime = createRuntime();
    let attempts = 0;
    const readyPromise = waitForTransportReady({
      label: "test transport",
      timeoutMs: 220,
      // Deterministic: first attempt at t=0 won't log; second attempt at t=50 will.
      logAfterMs: 1,
      logIntervalMs: 1_000,
      pollIntervalMs: 50,
      runtime,
      check: async () => {
        attempts += 1;
        if (attempts > 2) {
          return { ok: true };
        }
        return { ok: false, error: "not ready" };
      },
    });

    await vi.advanceTimersByTimeAsync(200);

    await readyPromise;
    expect(runtime.error).toHaveBeenCalled();
  });

  it("throws after the timeout", async () => {
    const runtime = createRuntime();
    const waitPromise = waitForTransportReady({
      label: "test transport",
      timeoutMs: 110,
      logAfterMs: 0,
      logIntervalMs: 1_000,
      pollIntervalMs: 50,
      runtime,
      check: async () => ({ ok: false, error: "still down" }),
    });
    const asserted = expect(waitPromise).rejects.toThrow("test transport not ready");
    await vi.advanceTimersByTimeAsync(200);
    await asserted;
    expect(runtime.error).toHaveBeenCalled();
  });

  it("returns early when aborted", async () => {
    const runtime = createRuntime();
    const controller = new AbortController();
    controller.abort();
    await waitForTransportReady({
      label: "test transport",
      timeoutMs: 200,
      runtime,
      abortSignal: controller.signal,
      check: async () => ({ ok: false, error: "still down" }),
    });
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("stops polling when aborted during the sleep interval", async () => {
    const runtime = createRuntime();
    const controller = new AbortController();
    let attempts = 0;

    const waitPromise = waitForTransportReady({
      label: "test transport",
      timeoutMs: 500,
      pollIntervalMs: 50,
      runtime,
      abortSignal: controller.signal,
      check: async () => {
        attempts += 1;
        setTimeout(() => controller.abort(), 10);
        return { ok: false, error: "still down" };
      },
    });

    await vi.advanceTimersByTimeAsync(100);
    await waitPromise;

    expect(attempts).toBe(1);
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("logs repeated unknown-error retries and the final timeout message", async () => {
    const runtime = createRuntime();
    const waitPromise = waitForTransportReady({
      label: "test transport",
      timeoutMs: 120,
      logAfterMs: 0,
      logIntervalMs: 50,
      pollIntervalMs: 50,
      runtime,
      check: async () => ({ ok: false, error: null }),
    });

    const asserted = expect(waitPromise).rejects.toThrow(
      "test transport not ready (unknown error)",
    );
    await vi.advanceTimersByTimeAsync(200);
    await asserted;

    expect(runtime.error).toHaveBeenCalledTimes(2);
    expect(runtimeErrorMessageAt(runtime, 0)).toContain("unknown error");
    expect(latestRuntimeErrorMessage(runtime)).toContain("not ready after 120ms");
  });

  it("rethrows non-abort sleep failures", async () => {
    const runtime = createRuntime();
    transportReadyMocks.injectedSleepError = new Error("sleep exploded");

    await expect(
      waitForTransportReady({
        label: "test transport",
        timeoutMs: 500,
        pollIntervalMs: 50,
        runtime,
        check: async () => ({ ok: false, error: "still down" }),
      }),
    ).rejects.toThrow("sleep exploded");

    expect(runtime.error).not.toHaveBeenCalled();
  });
});
