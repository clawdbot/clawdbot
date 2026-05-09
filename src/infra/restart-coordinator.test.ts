import { describe, expect, it, vi } from "vitest";
import {
  createSafeGatewayRestartPreflight,
  requestSafeGatewayRestart,
} from "./restart-coordinator.js";

const scheduleGatewaySigusr1Restart = vi.hoisted(() => vi.fn());

vi.mock("./restart.js", () => ({
  scheduleGatewaySigusr1Restart: (opts: unknown) => scheduleGatewaySigusr1Restart(opts),
}));

describe("safe gateway restart coordinator", () => {
  it("reports safe when no restart blockers are active", () => {
    const preflight = createSafeGatewayRestartPreflight({
      getQueueSize: () => 0,
      getPendingReplies: () => 0,
      getEmbeddedRuns: () => 0,
      getActiveTasks: () => 0,
      getTaskBlockers: () => [],
    });

    expect(preflight).toEqual({
      safe: true,
      counts: {
        queueSize: 0,
        pendingReplies: 0,
        embeddedRuns: 0,
        activeTasks: 0,
        totalActive: 0,
      },
      blockers: [],
      summary: "safe to restart now",
    });
  });

  it("returns structured blockers for active work", () => {
    const preflight = createSafeGatewayRestartPreflight({
      getQueueSize: () => 2,
      getPendingReplies: () => 1,
      getEmbeddedRuns: () => 1,
      getActiveTasks: () => 1,
      getTaskBlockers: () => [
        {
          taskId: "task-1",
          runId: "run-1",
          status: "running",
          runtime: "acp",
          label: "build",
          title: "Build branch",
        },
      ],
    });

    expect(preflight.safe).toBe(false);
    expect(preflight.counts.totalActive).toBe(5);
    expect(preflight.blockers.map((blocker) => blocker.kind)).toEqual([
      "queue",
      "reply",
      "embedded-run",
      "task",
    ]);
    expect(preflight.summary).toContain("restart deferred");
    expect(preflight.summary).toContain("taskId=task-1");
  });

  it("schedules one restart request and marks active work as deferred", () => {
    scheduleGatewaySigusr1Restart.mockReturnValueOnce({
      ok: true,
      pid: 123,
      signal: "SIGUSR1",
      delayMs: 0,
      mode: "emit",
      coalesced: false,
      cooldownMsApplied: 0,
    });

    const result = requestSafeGatewayRestart({
      reason: "test.safe",
      inspect: {
        getQueueSize: () => 1,
        getPendingReplies: () => 0,
        getEmbeddedRuns: () => 0,
        getActiveTasks: () => 0,
        getTaskBlockers: () => [],
      },
    });

    expect(result.status).toBe("deferred");
    expect(scheduleGatewaySigusr1Restart).toHaveBeenCalledWith({
      delayMs: 0,
      reason: "test.safe",
    });
  });

  it("surfaces coalesced restart requests", () => {
    scheduleGatewaySigusr1Restart.mockReturnValueOnce({
      ok: true,
      pid: 123,
      signal: "SIGUSR1",
      delayMs: 500,
      mode: "emit",
      coalesced: true,
      cooldownMsApplied: 0,
    });

    const result = requestSafeGatewayRestart({
      inspect: {
        getQueueSize: () => 0,
        getPendingReplies: () => 0,
        getEmbeddedRuns: () => 0,
        getActiveTasks: () => 0,
        getTaskBlockers: () => [],
      },
    });

    expect(result.status).toBe("coalesced");
  });

  it("forwards skipDeferral to scheduleGatewaySigusr1Restart and marks status scheduled", () => {
    scheduleGatewaySigusr1Restart.mockReturnValueOnce({
      ok: true,
      pid: 123,
      signal: "SIGUSR1",
      delayMs: 0,
      mode: "emit",
      coalesced: false,
      cooldownMsApplied: 0,
    });

    const result = requestSafeGatewayRestart({
      reason: "test.skip-deferral",
      skipDeferral: true,
      inspect: {
        getQueueSize: () => 1,
        getPendingReplies: () => 0,
        getEmbeddedRuns: () => 0,
        getActiveTasks: () => 0,
        getTaskBlockers: () => [],
      },
    });

    expect(result.status).toBe("scheduled");
    expect(result.preflight.safe).toBe(false);
    expect(scheduleGatewaySigusr1Restart).toHaveBeenCalledWith({
      delayMs: 0,
      reason: "test.skip-deferral",
      skipDeferral: true,
    });
  });

  it("omits skipDeferral when not requested", () => {
    scheduleGatewaySigusr1Restart.mockReturnValueOnce({
      ok: true,
      pid: 123,
      signal: "SIGUSR1",
      delayMs: 0,
      mode: "emit",
      coalesced: false,
      cooldownMsApplied: 0,
    });

    requestSafeGatewayRestart({
      reason: "test.no-skip",
      inspect: {
        getQueueSize: () => 0,
        getPendingReplies: () => 0,
        getEmbeddedRuns: () => 0,
        getActiveTasks: () => 0,
        getTaskBlockers: () => [],
      },
    });

    expect(scheduleGatewaySigusr1Restart).toHaveBeenCalledWith({
      delayMs: 0,
      reason: "test.no-skip",
    });
  });
});
