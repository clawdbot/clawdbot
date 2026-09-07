// Verifies agent cleanup steps time out with bounded diagnostic logging.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgentCleanupStep, createAgentCleanupScope } from "./run-cleanup-timeout.js";

const AGENT_CLEANUP_STEP_TIMEOUT_MS = 10_000;
const CLEANUP_TIMEOUT_DETAILS_MAX_CHARS = 512;
const CLEANUP_TIMEOUT_DETAILS_TRUNCATED_SUFFIX = "...[truncated]";

describe("agent cleanup timeout", () => {
  const log = {
    warn: vi.fn(),
  };

  const timeoutWithDetails = (getTimeoutDetails: () => string) =>
    runAgentCleanupStep({
      runId: "run-trajectory",
      sessionId: "session-trajectory",
      step: "agent-trajectory-flush",
      cleanup: () => new Promise<never>(() => {}),
      log,
      timeoutMs: 5,
      getTimeoutDetails,
    });

  beforeEach(() => {
    vi.useFakeTimers();
    log.warn.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each<{
    name: string;
    step: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    expectedTimeoutMs: number;
  }>([
    {
      name: "default budget",
      step: "bundle-mcp-retire",
      env: {},
      expectedTimeoutMs: AGENT_CLEANUP_STEP_TIMEOUT_MS,
    },
    {
      name: "trajectory environment override",
      step: "openclaw-trajectory-flush",
      env: { OPENCLAW_TRAJECTORY_FLUSH_TIMEOUT_MS: "25000" },
      expectedTimeoutMs: 25_000,
    },
    {
      name: "general environment override",
      step: "bundle-mcp-retire",
      env: { OPENCLAW_AGENT_CLEANUP_TIMEOUT_MS: "1500" },
      expectedTimeoutMs: 1_500,
    },
    {
      name: "explicit budget before environment overrides",
      step: "openclaw-trajectory-flush",
      timeoutMs: 2_000,
      env: {
        OPENCLAW_TRAJECTORY_FLUSH_TIMEOUT_MS: "25000",
        OPENCLAW_AGENT_CLEANUP_TIMEOUT_MS: "15000",
      },
      expectedTimeoutMs: 2_000,
    },
    {
      name: "explicit zero clamped to one millisecond",
      step: "openclaw-trajectory-flush",
      timeoutMs: 0,
      env: { OPENCLAW_TRAJECTORY_FLUSH_TIMEOUT_MS: "25000" },
      expectedTimeoutMs: 1,
    },
    {
      name: "invalid environment numbers ignored",
      step: "openclaw-trajectory-flush",
      env: {
        OPENCLAW_TRAJECTORY_FLUSH_TIMEOUT_MS: "0",
        OPENCLAW_AGENT_CLEANUP_TIMEOUT_MS: "not-a-number",
      },
      expectedTimeoutMs: AGENT_CLEANUP_STEP_TIMEOUT_MS,
    },
    {
      name: "invalid environment formats ignored",
      step: "openclaw-trajectory-flush",
      env: {
        OPENCLAW_TRAJECTORY_FLUSH_TIMEOUT_MS: "1e3",
        OPENCLAW_AGENT_CLEANUP_TIMEOUT_MS: "0x10",
      },
      expectedTimeoutMs: AGENT_CLEANUP_STEP_TIMEOUT_MS,
    },
  ])("bounds stalled cleanup with $name", async ({ step, env, timeoutMs, expectedTimeoutMs }) => {
    const result = runAgentCleanupStep({
      runId: "run-1",
      sessionId: "session-1",
      step,
      cleanup: () => new Promise<never>(() => {}),
      log,
      env,
      timeoutMs,
    });

    await vi.advanceTimersByTimeAsync(expectedTimeoutMs - 1);
    expect(log.warn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledExactlyOnceWith(
      `agent cleanup timed out: runId=run-1 sessionId=session-1 step=${step} timeoutMs=${expectedTimeoutMs}`,
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
    const oversizedDetails = `queuedBytes=${"9".repeat(CLEANUP_TIMEOUT_DETAILS_MAX_CHARS * 2)}`;

    const result = timeoutWithDetails(() => oversizedDetails);

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
    const prefixLength =
      CLEANUP_TIMEOUT_DETAILS_MAX_CHARS - CLEANUP_TIMEOUT_DETAILS_TRUNCATED_SUFFIX.length;
    const detailsPrefix = "a".repeat(prefixLength - 1);
    const oversizedDetails = `${detailsPrefix}😀${"b".repeat(CLEANUP_TIMEOUT_DETAILS_MAX_CHARS)}`;

    const result = timeoutWithDetails(() => oversizedDetails);

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

    const result = timeoutWithDetails(() => {
      throw new Error("details unavailable ".repeat(CLEANUP_TIMEOUT_DETAILS_MAX_CHARS));
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

  it.each([false, true])(
    "preserves nested cleanup uncertainty and the original run outcome (fails=%s)",
    async (fails) => {
      const failure = new Error("run failed");
      const outer = createAgentCleanupScope();
      const inner = createAgentCleanupScope();
      const result = outer.run(() =>
        inner.run(async () => {
          await runAgentCleanupStep({
            runId: "nested",
            sessionId: "isolated",
            step: "registered-owner",
            cleanup: async () => {
              throw new Error("cleanup failed");
            },
            log,
          });
          if (fails) {
            throw failure;
          }
          return "result";
        }),
      );
      if (fails) {
        await expect(result).rejects.toBe(failure);
      } else {
        await expect(result).resolves.toBe("result");
      }
      expect(inner.outcome).toBe("uncertain");
      expect(outer.outcome).toBe("uncertain");
    },
  );

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
  it.each([
    { label: "completed", settles: true, fails: false, outcome: "closed" },
    { label: "failed", settles: true, fails: true, outcome: "uncertain" },
    { label: "stalled", settles: false, fails: false, outcome: "uncertain" },
    { label: "late rejection", settles: false, fails: true, outcome: "uncertain" },
  ])(
    "bounds automatic cleanup and records $label ownership",
    async ({ settles, fails, outcome }) => {
      let settle!: () => void;
      const held = new Promise<void>((resolve) => {
        settle = resolve;
      });
      const scope = createAgentCleanupScope();
      const result = scope.run(() =>
        runAgentCleanupStep({
          runId: "automatic",
          sessionId: "isolated",
          step: "registered-owner",
          log,
          timeoutMs: 5,
          cleanup: async () => {
            await held;
            if (fails) {
              throw new Error("teardown failed");
            }
          },
        }),
      );
      try {
        if (settles) {
          settle();
        }
        await vi.advanceTimersByTimeAsync(5);
        expect(scope.outcome).toBe(outcome);
        await expect(result).resolves.toBeUndefined();
      } finally {
        settle();
        await result;
      }
    },
  );
});
