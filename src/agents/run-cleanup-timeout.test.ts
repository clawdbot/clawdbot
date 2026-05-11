import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_CLEANUP_STEP_TIMEOUT_MS, runAgentCleanupStep } from "./run-cleanup-timeout.js";

describe("agent cleanup timeout", () => {
  const log = {
    warn: vi.fn(),
  };

  beforeEach(() => {
    vi.useFakeTimers();
    log.warn.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns after the cleanup timeout when a cleanup step stalls", async () => {
    const cleanup = vi.fn(async () => new Promise<never>(() => {}));

    const result = runAgentCleanupStep({
      runId: "run-1",
      sessionId: "session-1",
      step: "bundle-mcp-retire",
      cleanup,
      log,
    });

    await vi.advanceTimersByTimeAsync(AGENT_CLEANUP_STEP_TIMEOUT_MS);
    await expect(result).resolves.toBeUndefined();

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      "agent cleanup timed out: runId=run-1 sessionId=session-1 step=bundle-mcp-retire timeoutMs=10000",
    );
  });

  it("logs cleanup rejection without throwing", async () => {
    await expect(
      runAgentCleanupStep({
        runId: "run-2",
        sessionId: "session-2",
        step: "context-engine-dispose",
        cleanup: async () => {
          throw new Error("dispose failed");
        },
        log,
      }),
    ).resolves.toBeUndefined();

    expect(log.warn).toHaveBeenCalledWith(
      "agent cleanup failed: runId=run-2 sessionId=session-2 step=context-engine-dispose error=dispose failed",
    );
  });
});
