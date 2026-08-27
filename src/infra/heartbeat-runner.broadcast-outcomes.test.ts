import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { getLastHeartbeatEvent, resetHeartbeatEventsForTest } from "./heartbeat-events.js";
import { startHeartbeatRunner } from "./heartbeat-runner.js";
import * as heartbeatWake from "./heartbeat-wake.js";

describe("heartbeat broadcast outcomes", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    resetHeartbeatEventsForTest();
  });

  afterEach(async () => {
    // A failed assertion must not leave retained work for the next runner.
    const dispose = heartbeatWake.setHeartbeatWakeHandler(async () => ({
      status: "skipped",
      reason: "disabled",
    }));
    await vi.runAllTimersAsync();
    dispose();
    resetHeartbeatEventsForTest();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function startRunner() {
    const register = vi.spyOn(heartbeatWake, "setHeartbeatWakeHandler");
    const runOnce = vi
      .fn<NonNullable<Parameters<typeof startHeartbeatRunner>[0]["runOnce"]>>()
      .mockResolvedValue({ status: "ran", durationMs: 1 });
    const cfg = {
      agents: {
        defaults: { heartbeat: { every: "30m" } },
        list: [{ id: "main" }, { id: "ops" }],
      },
    } as OpenClawConfig;
    const runner = startHeartbeatRunner({ cfg, runOnce });
    onTestFinished(() => runner.stop());
    const run = register.mock.calls[0]?.[0];
    if (!run) {
      throw new Error("Expected the runner to register a wake handler");
    }
    return { run, runOnce };
  }

  it("retains an untargeted task through min-spacing and dispatches its payload at the deadline", async () => {
    const { run, runOnce } = startRunner();
    await run({ source: "manual", intent: "manual" });
    runOnce.mockClear();
    vi.setSystemTime(1);
    const wake = {
      source: "cron",
      intent: "task",
      reason: "heartbeat-task:inbox",
      tasks: [{ jobId: "inbox", name: "Inbox", prompt: "Check inbox" }],
    } as const;

    expect.soft(await run(wake)).toEqual({
      status: "skipped",
      reason: "min-spacing",
      retryAtMs: 30_000,
    });
    expect(getLastHeartbeatEvent()).toBeNull();
    heartbeatWake.requestHeartbeat({ ...wake, coalesceMs: 0 });
    await vi.advanceTimersByTimeAsync(29_998);
    expect(runOnce).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(runOnce).toHaveBeenCalledTimes(2);
    expect(
      runOnce.mock.calls.map(([opts]) => ({ agentId: opts.agentId, tasks: opts.tasks })),
    ).toEqual(["main", "ops"].map((agentId) => ({ agentId, tasks: wake.tasks })));
  });

  it.each([
    { intent: "task", reason: "min-spacing", runs: 1, retryAtMs: 30_000 },
    { intent: "scheduled", reason: "not-due", runs: 1, retryAtMs: 30 * 60_000 },
    { intent: "immediate", reason: "flood", runs: 5, retryAtMs: 60_001 },
  ] as const)("preserves the earliest $reason deadline across agents", async (testCase) => {
    const { run } = startRunner();
    for (let i = 0; i < testCase.runs; i++) {
      await run({ source: "manual", intent: "manual", agentId: "ops" });
    }
    vi.setSystemTime(5_000);
    for (let i = 0; i < testCase.runs; i++) {
      await run({ source: "manual", intent: "manual", agentId: "main" });
    }
    vi.setSystemTime(10_000);

    expect(await run({ source: "interval", intent: testCase.intent, reason: "interval" })).toEqual({
      status: "skipped",
      reason: testCase.reason,
      retryAtMs: testCase.retryAtMs,
    });
  });

  it.each([
    { status: "skipped", reason: "quiet-hours" },
    { status: "failed", reason: "agent-tool-failure" },
  ] as const)("prefers a guard deferral over a sibling $reason outcome", async (terminal) => {
    const { run, runOnce } = startRunner();
    await run({ source: "manual", intent: "manual", agentId: "ops" });
    vi.setSystemTime(1);
    runOnce.mockResolvedValue(terminal);

    expect(await run({ source: "cron", intent: "task" })).toEqual({
      status: "skipped",
      reason: "min-spacing",
      retryAtMs: 30_000,
    });
  });

  it.each([
    { status: "skipped", reason: "quiet-hours" },
    { status: "failed", reason: "agent-tool-failure" },
  ] as const)("preserves the first $reason outcome when no agent can retry", async (result) => {
    const { run, runOnce } = startRunner();
    runOnce
      .mockResolvedValueOnce(result)
      .mockResolvedValue({ status: "skipped", reason: "disabled" });

    expect(await run({ source: "cron", intent: "task" })).toEqual(result);
  });

  it("preserves the busy retry fast path even when another agent ran", async () => {
    const { run, runOnce } = startRunner();
    const busy = {
      status: "skipped",
      reason: heartbeatWake.HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT,
    } as const;
    runOnce.mockResolvedValueOnce(busy);

    expect(await run({ source: "cron", intent: "task" })).toEqual(busy);
    expect(runOnce).toHaveBeenCalledTimes(2);
  });
});
