// Codex tests cover attempt timeouts plugin behavior.
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CODEX_APP_SERVER_STARTUP_TIMEOUT_FLOOR_MS,
  CODEX_POST_TOOL_RAW_ASSISTANT_COMPLETION_IDLE_TIMEOUT_MS,
  CODEX_TURN_ASSISTANT_COMPLETION_IDLE_TIMEOUT_MS,
  CODEX_TURN_COMPLETION_IDLE_TIMEOUT_MS,
  CODEX_TURN_TERMINAL_IDLE_TIMEOUT_MS,
  resolveCodexPostToolRawAssistantCompletionIdleTimeoutMs,
  resolveCodexGatewayTimeoutWithGraceMs,
  resolveCodexStartupTimeoutMs,
  resolveCodexTurnAssistantCompletionIdleTimeoutMs,
  resolveCodexTurnCompletionIdleTimeoutMs,
  resolveCodexTurnTerminalIdleTimeoutMs,
  withCodexStartupTimeout,
} from "./attempt-timeouts.js";

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

  it("normalizes turn idle timeout overrides", () => {
    expect(CODEX_POST_TOOL_RAW_ASSISTANT_COMPLETION_IDLE_TIMEOUT_MS).toBe(5 * 60_000);
    expect(CODEX_POST_TOOL_RAW_ASSISTANT_COMPLETION_IDLE_TIMEOUT_MS).toBeGreaterThan(
      CODEX_TURN_COMPLETION_IDLE_TIMEOUT_MS,
    );

    expect(resolveCodexTurnCompletionIdleTimeoutMs(undefined)).toBe(
      CODEX_TURN_COMPLETION_IDLE_TIMEOUT_MS,
    );
    expect(resolveCodexTurnCompletionIdleTimeoutMs(Number.POSITIVE_INFINITY)).toBe(
      CODEX_TURN_COMPLETION_IDLE_TIMEOUT_MS,
    );
    expect(resolveCodexTurnCompletionIdleTimeoutMs(2.9)).toBe(2);
    expect(resolveCodexTurnCompletionIdleTimeoutMs(0)).toBe(1);
    expect(resolveCodexTurnCompletionIdleTimeoutMs(Number.MAX_SAFE_INTEGER)).toBe(
      MAX_TIMER_TIMEOUT_MS,
    );

    expect(resolveCodexTurnAssistantCompletionIdleTimeoutMs(undefined)).toBe(
      CODEX_TURN_ASSISTANT_COMPLETION_IDLE_TIMEOUT_MS,
    );
    expect(resolveCodexTurnAssistantCompletionIdleTimeoutMs(Number.NaN)).toBe(
      CODEX_TURN_ASSISTANT_COMPLETION_IDLE_TIMEOUT_MS,
    );
    expect(resolveCodexTurnAssistantCompletionIdleTimeoutMs(9.8)).toBe(9);
    expect(resolveCodexTurnAssistantCompletionIdleTimeoutMs(-10)).toBe(1);

    expect(resolveCodexPostToolRawAssistantCompletionIdleTimeoutMs(undefined, 123)).toBe(
      CODEX_POST_TOOL_RAW_ASSISTANT_COMPLETION_IDLE_TIMEOUT_MS,
    );
    expect(resolveCodexPostToolRawAssistantCompletionIdleTimeoutMs(Number.NaN, 123)).toBe(
      CODEX_POST_TOOL_RAW_ASSISTANT_COMPLETION_IDLE_TIMEOUT_MS,
    );
    expect(resolveCodexPostToolRawAssistantCompletionIdleTimeoutMs(undefined, 120_000)).toBe(
      CODEX_POST_TOOL_RAW_ASSISTANT_COMPLETION_IDLE_TIMEOUT_MS,
    );
    expect(resolveCodexPostToolRawAssistantCompletionIdleTimeoutMs(undefined, 6 * 60_000)).toBe(
      6 * 60_000,
    );
    expect(resolveCodexPostToolRawAssistantCompletionIdleTimeoutMs(undefined, Number.NaN)).toBe(
      CODEX_POST_TOOL_RAW_ASSISTANT_COMPLETION_IDLE_TIMEOUT_MS,
    );
    expect(resolveCodexPostToolRawAssistantCompletionIdleTimeoutMs(7.9, 123)).toBe(7);
    expect(resolveCodexPostToolRawAssistantCompletionIdleTimeoutMs(0, 123)).toBe(1);
    expect(
      resolveCodexPostToolRawAssistantCompletionIdleTimeoutMs(
        Number.MAX_SAFE_INTEGER,
        Number.MAX_SAFE_INTEGER,
      ),
    ).toBe(MAX_TIMER_TIMEOUT_MS);

    expect(resolveCodexTurnTerminalIdleTimeoutMs(undefined)).toBe(
      CODEX_TURN_TERMINAL_IDLE_TIMEOUT_MS,
    );
    expect(resolveCodexTurnTerminalIdleTimeoutMs(Number.NEGATIVE_INFINITY)).toBe(
      CODEX_TURN_TERMINAL_IDLE_TIMEOUT_MS,
    );
    expect(resolveCodexTurnTerminalIdleTimeoutMs(3.7)).toBe(3);
    expect(resolveCodexTurnTerminalIdleTimeoutMs(-1)).toBe(1);
    expect(resolveCodexTurnTerminalIdleTimeoutMs(Number.MAX_SAFE_INTEGER)).toBe(
      MAX_TIMER_TIMEOUT_MS,
    );
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
    const rejected = expect(run).rejects.toThrow("codex app-server startup timed out");

    await vi.advanceTimersByTimeAsync(10);
    expect(events).toEqual(["cleanup-start"]);
    await vi.advanceTimersByTimeAsync(5);
    await rejected;
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
    const rejected = expect(run).rejects.toThrow("codex app-server startup aborted");

    controller.abort();

    await rejected;
  });
});
