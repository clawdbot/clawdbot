// Verifies agent cleanup steps time out with bounded diagnostic logging.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgentCleanupStep } from "./run-cleanup-timeout.js";

const AGENT_CLEANUP_STEP_TIMEOUT_MS = 10_000;
const CLEANUP_TIMEOUT_DETAILS_MAX_CHARS = 512;
const CLEANUP_TIMEOUT_DETAILS_TRUNCATED_SUFFIX = "...[truncated]";

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
      step: "openclaw-trajectory-flush",
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
      "agent cleanup timed out: runId=run-trajectory sessionId=session-trajectory step=openclaw-trajectory-flush timeoutMs=25000",
    );
  });

  it("includes cleanup timeout details when the cleanup step exposes them", async () => {
    // Cleanup steps can expose current queue state for timeout diagnostics.
    const cleanup = vi.fn(async () => new Promise<never>(() => {}));

    const result = runAgentCleanupStep({
      runId: "run-trajectory",
      sessionId: "session-trajectory",
      step: "openclaw-trajectory-flush",
      cleanup,
      log,
      timeoutMs: 5,
      getTimeoutDetails: () => "pendingWrites=2 queuedBytes=128 activeOperation=file-append",
    });

    await vi.advanceTimersByTimeAsync(5);
    await expect(result).resolves.toBeUndefined();

    expect(log.warn).toHaveBeenCalledWith(
      "agent cleanup timed out: runId=run-trajectory sessionId=session-trajectory step=openclaw-trajectory-flush timeoutMs=5 details=pendingWrites=2 queuedBytes=128 activeOperation=file-append",
    );
  });

  it("bounds cleanup timeout details before logging", async () => {
    const cleanup = vi.fn(async () => new Promise<never>(() => {}));
    const oversizedDetails = `queuedBytes=${"9".repeat(CLEANUP_TIMEOUT_DETAILS_MAX_CHARS * 2)}`;

    const result = runAgentCleanupStep({
      runId: "run-trajectory",
      sessionId: "session-trajectory",
      step: "agent-trajectory-flush",
      cleanup,
      log,
      timeoutMs: 5,
      getTimeoutDetails: () => oversizedDetails,
    });

    await vi.advanceTimersByTimeAsync(5);
    await expect(result).resolves.toBeUndefined();

    const message = String(log.warn.mock.calls.at(-1)?.[0] ?? "");
    expect(message).toContain(" details=queuedBytes=");
    expect(message).toContain("...[truncated]");
    expect(message.length).toBeLessThan(
      "agent cleanup timed out: runId=run-trajectory sessionId=session-trajectory step=agent-trajectory-flush timeoutMs=5 details="
        .length +
        CLEANUP_TIMEOUT_DETAILS_MAX_CHARS +
        1,
    );
  });

  it("keeps truncated cleanup timeout details UTF-16 safe", async () => {
    const cleanup = vi.fn(async () => new Promise<never>(() => {}));
    const prefixLength =
      CLEANUP_TIMEOUT_DETAILS_MAX_CHARS - CLEANUP_TIMEOUT_DETAILS_TRUNCATED_SUFFIX.length;
    const detailsPrefix = "a".repeat(prefixLength - 1);
    const oversizedDetails = `${detailsPrefix}😀${"b".repeat(CLEANUP_TIMEOUT_DETAILS_MAX_CHARS)}`;

    const result = runAgentCleanupStep({
      runId: "run-trajectory",
      sessionId: "session-trajectory",
      step: "agent-trajectory-flush",
      cleanup,
      log,
      timeoutMs: 5,
      getTimeoutDetails: () => oversizedDetails,
    });

    await vi.advanceTimersByTimeAsync(5);
    await expect(result).resolves.toBeUndefined();

    const message = String(log.warn.mock.calls.at(-1)?.[0] ?? "");
    expect(message).toContain(
      ` details=${detailsPrefix}${CLEANUP_TIMEOUT_DETAILS_TRUNCATED_SUFFIX}`,
    );
    expect(message).not.toContain("�");
  });

  it("does not fail cleanup when timeout details throw", async () => {
    const cleanup = vi.fn(async () => new Promise<never>(() => {}));

    const result = runAgentCleanupStep({
      runId: "run-trajectory",
      sessionId: "session-trajectory",
      step: "openclaw-trajectory-flush",
      cleanup,
      log,
      timeoutMs: 5,
      getTimeoutDetails: () => {
        throw new Error("details unavailable");
      },
    });

    await vi.advanceTimersByTimeAsync(5);
    await expect(result).resolves.toBeUndefined();

    expect(log.warn).toHaveBeenCalledWith(
      "agent cleanup timed out: runId=run-trajectory sessionId=session-trajectory step=openclaw-trajectory-flush timeoutMs=5 detailsError=details unavailable",
    );
  });

  it("bounds cleanup timeout detail errors before logging", async () => {
    // Diagnostic failures must not produce unbounded logs or fail cleanup.
    const cleanup = vi.fn(async () => new Promise<never>(() => {}));

    const result = runAgentCleanupStep({
      runId: "run-trajectory",
      sessionId: "session-trajectory",
      step: "agent-trajectory-flush",
      cleanup,
      log,
      timeoutMs: 5,
      getTimeoutDetails: () => {
        throw new Error("details unavailable ".repeat(CLEANUP_TIMEOUT_DETAILS_MAX_CHARS));
      },
    });

    await vi.advanceTimersByTimeAsync(5);
    await expect(result).resolves.toBeUndefined();

    const message = String(log.warn.mock.calls.at(-1)?.[0] ?? "");
    expect(message).toContain(" detailsError=details unavailable");
    expect(message).toContain("...[truncated]");
    expect(message.length).toBeLessThan(
      "agent cleanup timed out: runId=run-trajectory sessionId=session-trajectory step=agent-trajectory-flush timeoutMs=5 detailsError="
        .length +
        CLEANUP_TIMEOUT_DETAILS_MAX_CHARS +
        1,
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

  it("prefers explicit cleanup timeout values over environment overrides", async () => {
    const cleanup = vi.fn(async () => new Promise<never>(() => {}));

    const result = runAgentCleanupStep({
      runId: "run-explicit",
      sessionId: "session-explicit",
      step: "openclaw-trajectory-flush",
      timeoutMs: 2_000,
      cleanup,
      log,
      env: {
        OPENCLAW_TRAJECTORY_FLUSH_TIMEOUT_MS: "25000",
        OPENCLAW_AGENT_CLEANUP_TIMEOUT_MS: "15000",
      },
    });

    await vi.advanceTimersByTimeAsync(1_999);
    expect(log.warn).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBeUndefined();

    expect(log.warn).toHaveBeenCalledWith(
      "agent cleanup timed out: runId=run-explicit sessionId=session-explicit step=openclaw-trajectory-flush timeoutMs=2000",
    );
  });

  it("keeps explicit zero cleanup timeouts as a one millisecond timeout", async () => {
    const cleanup = vi.fn(async () => new Promise<never>(() => {}));

    const result = runAgentCleanupStep({
      runId: "run-zero",
      sessionId: "session-zero",
      step: "openclaw-trajectory-flush",
      timeoutMs: 0,
      cleanup,
      log,
      env: {
        OPENCLAW_TRAJECTORY_FLUSH_TIMEOUT_MS: "25000",
      },
    });

    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBeUndefined();

    expect(log.warn).toHaveBeenCalledWith(
      "agent cleanup timed out: runId=run-zero sessionId=session-zero step=openclaw-trajectory-flush timeoutMs=1",
    );
  });

  it.each([
    {
      runId: "run-invalid-env-number",
      sessionId: "session-invalid-env-number",
      env: {
        OPENCLAW_TRAJECTORY_FLUSH_TIMEOUT_MS: "0",
        OPENCLAW_AGENT_CLEANUP_TIMEOUT_MS: "not-a-number",
      },
    },
    {
      runId: "run-invalid-env-format",
      sessionId: "session-invalid-env-format",
      env: {
        OPENCLAW_TRAJECTORY_FLUSH_TIMEOUT_MS: "1e3",
        OPENCLAW_AGENT_CLEANUP_TIMEOUT_MS: "0x10",
      },
    },
  ])("ignores invalid cleanup timeout environment values", async ({ runId, sessionId, env }) => {
    const cleanup = vi.fn(async () => new Promise<never>(() => {}));

    const result = runAgentCleanupStep({
      runId,
      sessionId,
      step: "openclaw-trajectory-flush",
      cleanup,
      log,
      env,
    });

    await vi.advanceTimersByTimeAsync(AGENT_CLEANUP_STEP_TIMEOUT_MS - 1);
    expect(log.warn).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBeUndefined();

    expect(log.warn).toHaveBeenCalledWith(
      `agent cleanup timed out: runId=${runId} sessionId=${sessionId} step=openclaw-trajectory-flush timeoutMs=10000`,
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
