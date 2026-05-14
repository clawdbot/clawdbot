import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_CLEANUP_STEP_TIMEOUT_MS,
  resolveAgentCleanupStepTimeoutMs,
  runAgentCleanupStep,
} from "./run-cleanup-timeout.js";

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

  it("uses the trajectory flush timeout environment override for trajectory cleanup", async () => {
    const cleanup = vi.fn(async () => new Promise<never>(() => {}));

    const result = runAgentCleanupStep({
      runId: "run-trajectory",
      sessionId: "session-trajectory",
      step: "pi-trajectory-flush",
      cleanup,
      log,
      env: {
        OPENCLAW_TRAJECTORY_FLUSH_TIMEOUT_MS: "25000",
      },
    });

    await vi.advanceTimersByTimeAsync(24_999);
    expect(log.warn).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBeUndefined();

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      "agent cleanup timed out: runId=run-trajectory sessionId=session-trajectory step=pi-trajectory-flush timeoutMs=25000",
    );
  });

  it("uses the general cleanup timeout environment override for other cleanup steps", async () => {
    const cleanup = vi.fn(async () => new Promise<never>(() => {}));

    const result = runAgentCleanupStep({
      runId: "run-general",
      sessionId: "session-general",
      step: "bundle-mcp-retire",
      cleanup,
      log,
      env: {
        OPENCLAW_AGENT_CLEANUP_TIMEOUT_MS: "1500",
      },
    });

    await vi.advanceTimersByTimeAsync(1_500);
    await expect(result).resolves.toBeUndefined();

    expect(log.warn).toHaveBeenCalledWith(
      "agent cleanup timed out: runId=run-general sessionId=session-general step=bundle-mcp-retire timeoutMs=1500",
    );
  });

  it("prefers explicit cleanup timeout values over environment overrides", () => {
    expect(
      resolveAgentCleanupStepTimeoutMs({
        step: "pi-trajectory-flush",
        timeoutMs: 2_000,
        env: {
          OPENCLAW_TRAJECTORY_FLUSH_TIMEOUT_MS: "25000",
          OPENCLAW_AGENT_CLEANUP_TIMEOUT_MS: "15000",
        },
      }),
    ).toBe(2_000);
  });

  it("keeps explicit zero cleanup timeouts as a one millisecond timeout", () => {
    expect(
      resolveAgentCleanupStepTimeoutMs({
        step: "pi-trajectory-flush",
        timeoutMs: 0,
        env: {
          OPENCLAW_TRAJECTORY_FLUSH_TIMEOUT_MS: "25000",
        },
      }),
    ).toBe(1);
  });

  it("ignores invalid cleanup timeout environment values", () => {
    expect(
      resolveAgentCleanupStepTimeoutMs({
        step: "pi-trajectory-flush",
        env: {
          OPENCLAW_TRAJECTORY_FLUSH_TIMEOUT_MS: "0",
          OPENCLAW_AGENT_CLEANUP_TIMEOUT_MS: "not-a-number",
        },
      }),
    ).toBe(AGENT_CLEANUP_STEP_TIMEOUT_MS);
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
