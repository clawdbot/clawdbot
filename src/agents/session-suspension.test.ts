// Verifies quota suspension persists lane state and auto-resumes safely.
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CRON_MAX_CONCURRENT_RUNS } from "../config/cron-limits.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { CommandLane } from "../process/lanes.js";
import { MAX_TIMER_TIMEOUT_MS } from "../shared/number-coercion.js";

const sessionStoreMocks = vi.hoisted(() => ({
  applySessionStoreEntryPatch: vi.fn(),
}));

const commandQueueMocks = vi.hoisted(() => ({
  setCommandLaneConcurrency: vi.fn(),
}));

vi.mock("../config/sessions.js", () => sessionStoreMocks);

vi.mock("../process/command-queue.js", () => commandQueueMocks);

vi.mock("./command/session.js", () => ({
  resolveStoredSessionKeyForSessionId: () => ({
    sessionKey: "session-key",
    storePath: "/tmp/openclaw-session-suspension-test/sessions.json",
  }),
}));

async function suspendLane(ttlMs: number, cfg: OpenClawConfig, laneId: CommandLane) {
  // All cases exercise the public suspendSession path with fixed failure metadata.
  const { suspendSession } = await import("./session-suspension.js");
  await suspendSession({
    cfg,
    sessionId: "session-1",
    laneId,
    reason: "quota_exhausted",
    failedProvider: "anthropic",
    failedModel: "claude-opus-4-6",
    ttlMs,
  });
}

describe("session suspension", () => {
  afterEach(async () => {
    const { cancelLaneAutoResume } = await import("./session-suspension.js");
    cancelLaneAutoResume(CommandLane.Main);
    cancelLaneAutoResume(CommandLane.Cron);
    cancelLaneAutoResume(CommandLane.CronNested);
    vi.useRealTimers();
    sessionStoreMocks.applySessionStoreEntryPatch.mockClear();
    commandQueueMocks.setCommandLaneConcurrency.mockClear();
  });

  it("auto-resumes main lane to configured agent concurrency", async () => {
    vi.useFakeTimers();
    const cfg = {
      agents: { defaults: { maxConcurrent: 4 } },
    } as OpenClawConfig;

    await suspendLane(100, cfg, CommandLane.Main);

    expect(commandQueueMocks.setCommandLaneConcurrency).toHaveBeenCalledWith(CommandLane.Main, 0);

    await vi.advanceTimersByTimeAsync(100);

    expect(commandQueueMocks.setCommandLaneConcurrency).toHaveBeenLastCalledWith(
      CommandLane.Main,
      4,
    );
  });

  it("auto-resumes cron lanes to the cron concurrency default", async () => {
    vi.useFakeTimers();

    await suspendLane(100, {} as OpenClawConfig, CommandLane.CronNested);

    expect(commandQueueMocks.setCommandLaneConcurrency).toHaveBeenCalledWith(
      CommandLane.CronNested,
      0,
    );

    await vi.advanceTimersByTimeAsync(100);

    expect(commandQueueMocks.setCommandLaneConcurrency).toHaveBeenLastCalledWith(
      CommandLane.CronNested,
      DEFAULT_CRON_MAX_CONCURRENT_RUNS,
    );
  });

  it("auto-resumes cron lanes to configured and clamped cron concurrency", async () => {
    vi.useFakeTimers();

    await suspendLane(100, { cron: { maxConcurrentRuns: 3 } } as OpenClawConfig, CommandLane.Cron);
    await vi.advanceTimersByTimeAsync(100);

    expect(commandQueueMocks.setCommandLaneConcurrency).toHaveBeenLastCalledWith(
      CommandLane.Cron,
      3,
    );

    await suspendLane(100, { cron: { maxConcurrentRuns: 0 } } as OpenClawConfig, CommandLane.Cron);
    await vi.advanceTimersByTimeAsync(100);

    expect(commandQueueMocks.setCommandLaneConcurrency).toHaveBeenLastCalledWith(
      CommandLane.Cron,
      1,
    );
  });

  it("clamps oversized suspension TTLs for timers and persisted resume time", async () => {
    // Persisted expectedResumeBy must match the clamped timer, not MAX_SAFE_INTEGER.
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    await suspendLane(Number.MAX_SAFE_INTEGER, {} as OpenClawConfig, CommandLane.Main);

    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
    const patch = sessionStoreMocks.applySessionStoreEntryPatch.mock.calls[0]?.[0].patch as {
      quotaSuspension?: { expectedResumeBy?: number };
    };
    expect(patch.quotaSuspension?.expectedResumeBy).toBe(1_000 + MAX_TIMER_TIMEOUT_MS);
  });

  it("maps failover reasons to persisted suspension reasons", async () => {
    const { testing } = await import("./session-suspension.js");

    expect(testing.resolveSessionSuspensionReason("rate_limit")).toBe("quota_exhausted");
    expect(testing.resolveSessionSuspensionReason("billing")).toBe("manual");
    expect(testing.resolveSessionSuspensionReason("overloaded")).toBe("circuit_open");
    expect(testing.resolveSessionSuspensionReason("timeout")).toBe("circuit_open");
    expect(testing.resolveSessionSuspensionReason("auth")).toBe("circuit_open");
  });
});
