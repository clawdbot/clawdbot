import { describe, expect, it, vi } from "vitest";
import { armClaudeTurnTimers, clearClaudeTurnTimers } from "./claude-live-turn-timeouts.js";

describe("armClaudeTurnTimers", () => {
  it("keeps the overall timeout authoritative when watchdog deadlines coincide", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const turn = {
      startedAtMs: Date.now(),
      rawLines: [],
      noOutputTimer: null,
      lastOutputAtMs: null,
      timeoutTimer: null,
      activeTools: new Map([["tool-1", { toolName: "Bash" }]]),
      observedStdout: true,
      useResume: false,
      hasReplayUnsafeActivity: true,
      toolEventCount: 1,
    };
    const close = vi.fn(
      (_reason: "idle" | "restart" | "abort" | "mcp-capture-rotation", _error?: unknown) =>
        clearClaudeTurnTimers(turn),
    );

    armClaudeTurnTimers(
      {
        providerId: "claude-cli",
        modelId: "sonnet",
        noOutputTimeoutMs: 1_000,
        toolActiveNoOutputTimeoutMs: 1_000,
        stdoutBuffer: { pending: "" },
        outstandingBackgroundTaskIds: new Set(),
        close,
      },
      turn,
      1_000,
    );

    await vi.advanceTimersByTimeAsync(1_000);

    expect(close).toHaveBeenCalledTimes(1);
    expect(close.mock.calls[0]?.[1]).toMatchObject({
      code: "cli_overall_timeout",
      cliTimeout: { mode: "overall", activeToolCount: 1 },
    });
    vi.useRealTimers();
  });
});
