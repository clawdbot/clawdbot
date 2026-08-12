import { describe, expect, it, vi } from "vitest";
import { emitSessionLifecycleEvent } from "../../../sessions/session-lifecycle-events.js";
import { reconcileFailedLaunchCleanupForSweep } from "./subagent-registry-sweeper-failed-launch.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

vi.mock("../../../sessions/session-lifecycle-events.js", () => ({
  emitSessionLifecycleEvent: vi.fn(),
}));

describe("failed-launch sweeper cleanup", () => {
  it("persists session deletion before retrying fallible resource cleanup", async () => {
    const entry = {
      runId: "failed-launch",
      childSessionKey: "agent:main:subagent:failed-launch",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "fail after launch",
      cleanup: "delete",
      createdAt: 1,
      launchCleanupPending: true,
      launchCleanupSessionIdentity: {
        sessionId: "child-session",
        lifecycleRevision: "child-revision",
      },
      execution: {
        status: "terminal",
        endedAt: 2,
        outcome: { status: "error", error: "launch failed" },
      },
    } as SubagentRunRecord;
    const runs = new Map([[entry.runId, entry]]);
    const deleteSession = vi.fn(async () => "deleted" as const);
    const cleanupResources = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const persistOrThrow = vi.fn();
    const reconcile = () =>
      reconcileFailedLaunchCleanupForSweep({
        runId: entry.runId,
        entry,
        runs,
        now: 3,
        persistOrThrow,
        deleteSession,
        settleFailedLaunch: vi.fn(() => true),
        cleanupResources,
        warn: vi.fn(),
      });

    await expect(reconcile()).resolves.toBe("pending");
    expect(entry.launchCleanupSessionOutcome).toBe("deleted");
    expect(persistOrThrow).toHaveBeenCalledWith(entry.runId);

    await expect(reconcile()).resolves.toBe("completed");
    expect(deleteSession).toHaveBeenCalledOnce();
    expect(emitSessionLifecycleEvent).toHaveBeenCalledOnce();
  });
});
