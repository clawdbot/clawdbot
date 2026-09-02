// Codex tests cover attempt timeouts plugin behavior.
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isCodexAppServerStartupError,
  resolveCodexGatewayTimeoutWithGraceMs,
  resolveCodexStartupTimeoutMs,
  withCodexStartupTimeout,
} from "./attempt-timeouts.js";

const CODEX_APP_SERVER_STARTUP_TIMEOUT_FLOOR_MS = 100;

describe("Codex app-server attempt timeouts", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves startup timeout with a configurable floor", () => {
    expect(resolveCodexStartupTimeoutMs({ timeoutMs: 5 })).toBe(
      CODEX_APP_SERVER_STARTUP_TIMEOUT_FLOOR_MS,
    );
    expect(resolveCodexStartupTimeoutMs({ timeoutMs: 500 })).toBe(500);
    expect(resolveCodexStartupTimeoutMs({ timeoutMs: 5, timeoutFloorMs: 250 })).toBe(250);
    expect(resolveCodexStartupTimeoutMs({ timeoutMs: Number.NaN })).toBe(
      CODEX_APP_SERVER_STARTUP_TIMEOUT_FLOOR_MS,
    );
    expect(resolveCodexStartupTimeoutMs({ timeoutMs: 500, timeoutFloorMs: Number.NaN })).toBe(500);
    expect(resolveCodexStartupTimeoutMs({ timeoutMs: Number.MAX_SAFE_INTEGER })).toBe(
      MAX_TIMER_TIMEOUT_MS,
    );
    expect(
      resolveCodexStartupTimeoutMs({
        timeoutMs: Number.MAX_SAFE_INTEGER,
        timeoutFloorMs: Number.MAX_SAFE_INTEGER,
      }),
    ).toBe(MAX_TIMER_TIMEOUT_MS);
    expect(
      resolveCodexStartupTimeoutMs({
        timeoutMs: Number.NaN,
        timeoutFloorMs: Number.NaN,
      }),
    ).toBe(CODEX_APP_SERVER_STARTUP_TIMEOUT_FLOOR_MS);
  });

  it("caps gateway timeout grace", () => {
    expect(resolveCodexGatewayTimeoutWithGraceMs(120_000)).toBe(130_000);
    expect(resolveCodexGatewayTimeoutWithGraceMs(120_000, 500)).toBe(120_500);
    expect(resolveCodexGatewayTimeoutWithGraceMs(Number.MAX_SAFE_INTEGER)).toBe(
      MAX_TIMER_TIMEOUT_MS,
    );
    expect(resolveCodexGatewayTimeoutWithGraceMs(MAX_TIMER_TIMEOUT_MS - 100, 500)).toBe(
      MAX_TIMER_TIMEOUT_MS,
    );
  });

  it("returns the startup operation result before timeout", async () => {
    await expect(
      withCodexStartupTimeout({
        timeoutMs: 1_000,
        signal: new AbortController().signal,
        operation: async () => "ready",
      }),
    ).resolves.toBe("ready");
  });

  it("waits for startup timeout cleanup before rejecting", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const run = withCodexStartupTimeout({
      timeoutMs: 10,
      signal: new AbortController().signal,
      onTimeout: async () => {
        events.push("cleanup-start");
        await new Promise<void>((resolve) => {
          setTimeout(() => {
            events.push("cleanup-done");
            resolve();
          }, 5);
        });
      },
      operation: async () => new Promise<never>(() => {}),
    });
    const errorResult = run.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(10);
    expect(events).toEqual(["cleanup-start"]);
    await vi.advanceTimersByTimeAsync(5);
    const error = await errorResult;
    expect(isCodexAppServerStartupError(error, "timed_out")).toBe(true);
    expect((error as Error).message).toBe("codex app-server startup timed out");
    expect(events).toEqual(["cleanup-start", "cleanup-done"]);
  });

  it("rejects startup timeout when aborted before completion", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const run = withCodexStartupTimeout({
      timeoutMs: 1_000,
      signal: controller.signal,
      operation: async () => new Promise<never>(() => {}),
    });
    const errorResult = run.catch((error: unknown) => error);

    controller.abort();

    const error = await errorResult;
    expect(isCodexAppServerStartupError(error, "aborted")).toBe(true);
    expect((error as Error).message).toBe("codex app-server startup aborted");
  });
});
