// Discord tests cover timeouts plugin behavior.
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isAbortError as runtimeApiIsAbortError,
  mergeAbortSignals as runtimeApiMergeAbortSignals,
  normalizeDiscordInboundWorkerTimeoutMs as runtimeApiNormalizeDiscordInboundWorkerTimeoutMs,
  normalizeDiscordListenerTimeoutMs as runtimeApiNormalizeDiscordListenerTimeoutMs,
  runDiscordTaskWithTimeout as runtimeApiRunDiscordTaskWithTimeout,
} from "../../runtime-api.js";
import {
  DISCORD_DEFAULT_INBOUND_WORKER_TIMEOUT_MS,
  DISCORD_DEFAULT_LISTENER_TIMEOUT_MS,
  isAbortError,
  mergeAbortSignals,
  normalizeDiscordInboundWorkerTimeoutMs,
  normalizeDiscordListenerTimeoutMs,
  raceWithTimeout,
  runDiscordTaskWithTimeout,
  withAbortTimeout,
} from "./timeouts.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("discord monitor timeouts", () => {
  it("keeps deprecated timeout helpers on the runtime api compatibility surface", () => {
    expect(runtimeApiIsAbortError).toBe(isAbortError);
    expect(runtimeApiMergeAbortSignals).toBe(mergeAbortSignals);
    expect(runtimeApiNormalizeDiscordInboundWorkerTimeoutMs).toBe(
      normalizeDiscordInboundWorkerTimeoutMs,
    );
    expect(runtimeApiNormalizeDiscordListenerTimeoutMs).toBe(normalizeDiscordListenerTimeoutMs);
    expect(runtimeApiRunDiscordTaskWithTimeout).toBe(runDiscordTaskWithTimeout);
  });

  it("keeps first-reason semantics on the abort-signal compatibility helper", () => {
    const first = new AbortController();
    const second = new AbortController();
    const reason = new Error("first stopped");
    const signal = mergeAbortSignals([first.signal, second.signal]);

    first.abort(reason);
    second.abort(new Error("second stopped"));

    expect(signal?.reason).toBe(reason);
  });

  it("preserves legacy timeout normalization semantics", () => {
    expect(normalizeDiscordListenerTimeoutMs(undefined)).toBe(DISCORD_DEFAULT_LISTENER_TIMEOUT_MS);
    expect(normalizeDiscordListenerTimeoutMs(0)).toBe(DISCORD_DEFAULT_LISTENER_TIMEOUT_MS);
    expect(normalizeDiscordListenerTimeoutMs(250)).toBe(1_000);
    expect(normalizeDiscordListenerTimeoutMs(Number.MAX_SAFE_INTEGER)).toBe(MAX_TIMER_TIMEOUT_MS);

    expect(normalizeDiscordInboundWorkerTimeoutMs(undefined)).toBe(
      DISCORD_DEFAULT_INBOUND_WORKER_TIMEOUT_MS,
    );
    expect(normalizeDiscordInboundWorkerTimeoutMs(0)).toBeUndefined();
    expect(normalizeDiscordInboundWorkerTimeoutMs(-1)).toBe(
      DISCORD_DEFAULT_INBOUND_WORKER_TIMEOUT_MS,
    );
    expect(normalizeDiscordInboundWorkerTimeoutMs(Number.MAX_SAFE_INTEGER)).toBe(
      MAX_TIMER_TIMEOUT_MS,
    );
  });

  it("identifies abort errors for deprecated timeout compatibility callers", () => {
    expect(isAbortError(Object.assign(new Error("aborted"), { name: "AbortError" }))).toBe(true);
    expect(isAbortError(new Error("other"))).toBe(false);
  });

  it("caps runDiscordTaskWithTimeout timers before arming the watchdog", async () => {
    vi.useFakeTimers();
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const onTimeout = vi.fn();
    let receivedSignal: AbortSignal | undefined;

    const task = runDiscordTaskWithTimeout({
      timeoutMs: Number.MAX_SAFE_INTEGER,
      onTimeout,
      run: async (signal) => {
        receivedSignal = signal;
        await new Promise<void>((resolve) => {
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    });

    await vi.advanceTimersByTimeAsync(MAX_TIMER_TIMEOUT_MS);

    await expect(task).resolves.toBe(true);
    expect(receivedSignal?.aborted).toBe(true);
    expect(onTimeout).toHaveBeenCalledWith(MAX_TIMER_TIMEOUT_MS);
    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
  });

  it("caps raceWithTimeout timers before arming the watchdog", async () => {
    const timeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockReturnValue(1 as unknown as ReturnType<typeof setTimeout>);
    vi.spyOn(globalThis, "clearTimeout").mockImplementation(() => undefined);

    await expect(
      raceWithTimeout({
        promise: Promise.resolve("ok"),
        timeoutMs: Number.MAX_SAFE_INTEGER,
        onTimeout: () => "timeout",
      }),
    ).resolves.toBe("ok");

    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
  });

  it("caps withAbortTimeout timers before arming the watchdog", async () => {
    const timeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockReturnValue(1 as unknown as ReturnType<typeof setTimeout>);
    vi.spyOn(globalThis, "clearTimeout").mockImplementation(() => undefined);

    await expect(
      withAbortTimeout({
        timeoutMs: Number.MAX_SAFE_INTEGER,
        createTimeoutError: () => new Error("timed out"),
        run: async () => "ok",
      }),
    ).resolves.toBe("ok");

    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
  });
});
