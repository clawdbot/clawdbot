// Verifies quota suspension persists lane state and auto-resumes safely.
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CRON_MAX_CONCURRENT_RUNS } from "../config/cron-limits.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { CommandLane } from "../process/lanes.js";
import { MAX_TIMER_TIMEOUT_MS } from "../shared/number-coercion.js";

const sessionAccessorMocks = vi.hoisted(() => ({
  patchSessionEntry: vi.fn(),
}));

const commandQueueMocks = vi.hoisted(() => ({
  setCommandLaneConcurrency: vi.fn(),
}));

vi.mock("../config/sessions/session-accessor.js", () => sessionAccessorMocks);

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
    if (vi.isFakeTimers()) {
      await vi.runOnlyPendingTimersAsync();
      vi.clearAllTimers();
    }
    vi.useRealTimers();
    const { resetSessionSuspensionStateForTest } =
      await import("./session-suspension.test-support.js");
    resetSessionSuspensionStateForTest();
    sessionAccessorMocks.patchSessionEntry.mockClear();
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

  it("clamps oversized suspension TTLs for timers and persisted resume time", async () => {
    // Persisted expectedResumeBy must match the clamped timer, not MAX_SAFE_INTEGER.
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    await suspendLane(Number.MAX_SAFE_INTEGER, {} as OpenClawConfig, CommandLane.Main);

    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
    const buildPatch = sessionAccessorMocks.patchSessionEntry.mock.calls[0]?.[1] as (_entry: {
      quotaSuspension?: unknown;
    }) => {
      quotaSuspension?: { expectedResumeBy?: number };
    };
    const patch = buildPatch({});
    expect(patch.quotaSuspension?.expectedResumeBy).toBe(1_000 + MAX_TIMER_TIMEOUT_MS);
  });

  it("clears pending lane auto-resume timers without pumping queued work during cleanup", async () => {
    vi.useFakeTimers();
    const { clearSessionSuspensionTimers } = await import("./session-suspension.js");

    await suspendLane(
      100,
      { agents: { defaults: { maxConcurrent: 3 } } } as OpenClawConfig,
      CommandLane.Main,
    );

    expect(commandQueueMocks.setCommandLaneConcurrency).toHaveBeenCalledWith(CommandLane.Main, 0);
    expect(clearSessionSuspensionTimers()).toBe(1);

    commandQueueMocks.setCommandLaneConcurrency.mockClear();
    await vi.advanceTimersByTimeAsync(100);

    expect(commandQueueMocks.setCommandLaneConcurrency).not.toHaveBeenCalled();
    expect(clearSessionSuspensionTimers()).toBe(0);
  });

  it("blocks new suspension timers until gateway startup re-enables them", async () => {
    vi.useFakeTimers();
    const { clearSessionSuspensionTimers, enableSessionSuspensionTimersForGatewayStart } =
      await import("./session-suspension.js");

    await suspendLane(100, {} as OpenClawConfig, CommandLane.Nested);

    expect(commandQueueMocks.setCommandLaneConcurrency).toHaveBeenCalledWith(CommandLane.Nested, 0);
    expect(clearSessionSuspensionTimers()).toBe(1);
    commandQueueMocks.setCommandLaneConcurrency.mockClear();
    sessionAccessorMocks.patchSessionEntry.mockClear();

    await suspendLane(100, {} as OpenClawConfig, CommandLane.Nested);

    expect(commandQueueMocks.setCommandLaneConcurrency).not.toHaveBeenCalled();
    expect(sessionAccessorMocks.patchSessionEntry).not.toHaveBeenCalled();

    enableSessionSuspensionTimersForGatewayStart();
    await suspendLane(100, {} as OpenClawConfig, CommandLane.Nested);

    expect(commandQueueMocks.setCommandLaneConcurrency).toHaveBeenCalledWith(CommandLane.Nested, 0);
  });

  it("restores suspended custom lanes when gateway startup re-enables timers", async () => {
    vi.useFakeTimers();
    const { clearSessionSuspensionTimers, enableSessionSuspensionTimersForGatewayStart } =
      await import("./session-suspension.js");
    const customLaneId = "plugin:voice:room-1" as CommandLane;

    await suspendLane(100, {} as OpenClawConfig, customLaneId);

    expect(commandQueueMocks.setCommandLaneConcurrency).toHaveBeenCalledWith(customLaneId, 0);
    expect(clearSessionSuspensionTimers()).toBe(1);
    commandQueueMocks.setCommandLaneConcurrency.mockClear();

    await vi.advanceTimersByTimeAsync(100);

    expect(commandQueueMocks.setCommandLaneConcurrency).not.toHaveBeenCalled();
    expect(enableSessionSuspensionTimersForGatewayStart().size).toBe(0);
    expect(commandQueueMocks.setCommandLaneConcurrency).toHaveBeenCalledWith(customLaneId, 1);
    expect(enableSessionSuspensionTimersForGatewayStart().size).toBe(0);
  });

  it("reschedules unexpired custom lane suspensions when gateway startup re-enables timers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { clearSessionSuspensionTimers, enableSessionSuspensionTimersForGatewayStart } =
      await import("./session-suspension.js");
    const customLaneId = "plugin:voice:room-2" as CommandLane;

    await suspendLane(100, {} as OpenClawConfig, customLaneId);
    expect(clearSessionSuspensionTimers()).toBe(1);
    commandQueueMocks.setCommandLaneConcurrency.mockClear();

    await vi.advanceTimersByTimeAsync(40);
    const suspendedLaneIds = enableSessionSuspensionTimersForGatewayStart();

    expect(suspendedLaneIds).toEqual(new Set([customLaneId]));
    expect(commandQueueMocks.setCommandLaneConcurrency).toHaveBeenCalledWith(customLaneId, 0);
    commandQueueMocks.setCommandLaneConcurrency.mockClear();

    await vi.advanceTimersByTimeAsync(59);
    expect(commandQueueMocks.setCommandLaneConcurrency).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(commandQueueMocks.setCommandLaneConcurrency).toHaveBeenCalledWith(customLaneId, 1);
  });

  it("leaves built-in lane restoration to gateway startup concurrency", async () => {
    vi.useFakeTimers();
    const { clearSessionSuspensionTimers, enableSessionSuspensionTimersForGatewayStart } =
      await import("./session-suspension.js");

    await suspendLane(
      100,
      { agents: { defaults: { maxConcurrent: 3 } } } as OpenClawConfig,
      CommandLane.Main,
    );

    expect(clearSessionSuspensionTimers()).toBe(1);
    commandQueueMocks.setCommandLaneConcurrency.mockClear();

    expect(enableSessionSuspensionTimersForGatewayStart()).toEqual(new Set([CommandLane.Main]));
    expect(commandQueueMocks.setCommandLaneConcurrency).toHaveBeenCalledWith(CommandLane.Main, 0);
  });

  it("clamps rescheduled cleanup timers after wall-clock rollback", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { enableSessionSuspensionTimersForGatewayStart } =
      await import("./session-suspension.js");
    const { seedClearedLaneResumeForTest } = await import("./session-suspension.test-support.js");
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const customLaneId = "plugin:voice:room-3";
    seedClearedLaneResumeForTest(customLaneId, {
      resumeConcurrency: 1,
      resumeAtMs: 1_000 + MAX_TIMER_TIMEOUT_MS + 1_000,
    });

    expect(enableSessionSuspensionTimersForGatewayStart()).toEqual(new Set([customLaneId]));
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
  });

  it("does not throttle lanes when cleanup wins a pending suspension write race", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { clearSessionSuspensionTimers } = await import("./session-suspension.js");
    const previousQuotaSuspension = {
      schemaVersion: 1,
      suspendedAt: 500,
      reason: "circuit_open",
      failedProvider: "openai",
      failedModel: "gpt-5.5",
      laneId: CommandLane.Main,
      expectedResumeBy: 2_000,
      state: "suspended",
    };
    let resolvePatch: (() => void) | undefined;
    let writtenQuotaSuspension:
      | {
          suspendedAt: number;
          reason: string;
          failedProvider: string;
          failedModel: string;
          laneId?: string;
        }
      | undefined;
    sessionAccessorMocks.patchSessionEntry.mockImplementationOnce(async (_scope, update) => {
      await new Promise<void>((resolve) => {
        resolvePatch = resolve;
      });
      const patch = update({ quotaSuspension: previousQuotaSuspension }) as {
        quotaSuspension?: typeof writtenQuotaSuspension;
      };
      writtenQuotaSuspension = patch.quotaSuspension;
      return patch;
    });

    const suspension = suspendLane(100, {} as OpenClawConfig, CommandLane.Main);
    await vi.waitFor(() => {
      expect(resolvePatch).toBeTypeOf("function");
    });

    expect(clearSessionSuspensionTimers()).toBe(0);
    resolvePatch?.();
    await suspension;

    expect(commandQueueMocks.setCommandLaneConcurrency).not.toHaveBeenCalled();
    expect(writtenQuotaSuspension).toBeUndefined();
    expect(sessionAccessorMocks.patchSessionEntry).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(100);

    expect(commandQueueMocks.setCommandLaneConcurrency).not.toHaveBeenCalled();
  });

  it("serializes suspension writes so cleanup cannot leave an intermediate write", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { clearSessionSuspensionTimers } = await import("./session-suspension.js");
    let storeEntry: {
      quotaSuspension?: {
        suspendedAt: number;
        reason: string;
        failedProvider: string;
        failedModel: string;
        laneId?: string;
      };
    } = {};
    let initialWrites = 0;
    let releaseInitialWrites!: () => void;
    const initialWritesReleased = new Promise<void>((resolve) => {
      releaseInitialWrites = resolve;
    });
    sessionAccessorMocks.patchSessionEntry.mockImplementation(async (_scope, update) => {
      const patch = update(storeEntry) as typeof storeEntry | null;
      if (patch && "quotaSuspension" in patch) {
        storeEntry =
          patch.quotaSuspension === undefined ? {} : { quotaSuspension: patch.quotaSuspension };
      }
      if (initialWrites < 2) {
        initialWrites += 1;
        await initialWritesReleased;
      }
      return storeEntry;
    });

    const first = suspendLane(100, {} as OpenClawConfig, CommandLane.Main);
    const second = suspendLane(100, {} as OpenClawConfig, CommandLane.Main);
    await vi.waitFor(() => {
      expect(initialWrites).toBe(1);
    });

    expect(clearSessionSuspensionTimers()).toBe(0);
    releaseInitialWrites();
    await Promise.all([first, second]);

    expect(storeEntry.quotaSuspension).toBeUndefined();
    expect(commandQueueMocks.setCommandLaneConcurrency).not.toHaveBeenCalled();
  });

  it("still throttles the lane when persistence fails while gateway is active", async () => {
    vi.useFakeTimers();
    sessionAccessorMocks.patchSessionEntry.mockRejectedValueOnce(new Error("disk busy"));

    await suspendLane(100, {} as OpenClawConfig, CommandLane.Main);

    expect(commandQueueMocks.setCommandLaneConcurrency).toHaveBeenCalledWith(CommandLane.Main, 0);
    await vi.advanceTimersByTimeAsync(100);
    expect(commandQueueMocks.setCommandLaneConcurrency).toHaveBeenLastCalledWith(
      CommandLane.Main,
      4,
    );
  });

  it("defers session suspension only for the outer fallback candidate run", async () => {
    const { resolveSessionSuspensionTarget, runWithDeferredSessionSuspension } =
      await import("./session-suspension.js");
    const onDeferred = vi.fn();

    expect(resolveSessionSuspensionTarget()).toEqual({ mode: "suspend" });
    await runWithDeferredSessionSuspension(async () => {
      const target = resolveSessionSuspensionTarget();
      expect(target.mode).toBe("defer");
      if (target.mode === "defer") {
        target.defer({
          cfg: {},
          sessionId: "session-1",
          laneId: CommandLane.Main,
          reason: "quota_exhausted",
          failedProvider: "openai",
          failedModel: "gpt-5.5",
        });
      }
      expect(resolveSessionSuspensionTarget()).toEqual({ mode: "suspend" });
    }, onDeferred);
    expect(onDeferred).toHaveBeenCalledOnce();
    expect(onDeferred).toHaveBeenCalledWith(expect.objectContaining({ laneId: CommandLane.Main }));
    expect(resolveSessionSuspensionTarget()).toEqual({ mode: "suspend" });
  });

  it("maps failover reasons to persisted suspension reasons", async () => {
    const { resolveSessionSuspensionReason } = await import("./session-suspension.js");

    expect(resolveSessionSuspensionReason("rate_limit")).toBe("quota_exhausted");
    expect(resolveSessionSuspensionReason("billing")).toBe("manual");
    expect(resolveSessionSuspensionReason("overloaded")).toBe("circuit_open");
    expect(resolveSessionSuspensionReason("timeout")).toBe("circuit_open");
    expect(resolveSessionSuspensionReason("auth")).toBe("circuit_open");
  });
});
