import { describe, expect, it, vi } from "vitest";
import { createSubagentRegistryRestorer } from "./subagent-registry-restore.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

describe("createSubagentRegistryRestorer", () => {
  it("terminalizes a restored provisional owner and defers artifact cleanup", async () => {
    const run: SubagentRunRecord = {
      runId: "provisional-attachment-owner",
      childSessionKey: "agent:main:subagent:provisional-owner",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "clean interrupted launch",
      cleanup: "delete",
      createdAt: 100,
      execution: { status: "queued" },
      completion: { required: false },
      delivery: { status: "not_required" },
      attachmentsRootDir: "/workspace",
      attachmentsDir: "/workspace/.openclaw/attachments/00000000-0000-4000-8000-000000000002",
      launchCleanupPending: true,
      launchCleanupSessionIdentity: {
        sessionId: "original-session",
        lifecycleRevision: "original-revision",
      },
    };
    const runs = new Map([[run.runId, run]]);
    const resumeRun = vi.fn();
    const settleFailedQueuedSubagentLaunch = vi.fn(() => {
      run.execution = { status: "terminal", endedAt: 200, suppressSessionEffects: true };
      return true;
    });
    const scheduleSweep = vi.fn();
    const restorer = createSubagentRegistryRestorer({
      runs,
      resumedRuns: new Set(),
      deps: () =>
        ({
          restoreSubagentRunsFromDisk: () => 1,
          getRuntimeConfig: () => ({}),
        }) as never,
      persist: vi.fn(),
      settleRequesterTurn: vi.fn(),
      ensureListener: vi.fn(),
      startSweeper: vi.fn(),
      resumeRun,
      listSwarmRunsForGroup: vi.fn(() => []),
      startQueuedSubagentRun: vi.fn(() => false),
      recordAcceptedRunTermination: vi.fn(),
      markAcceptedRunTerminationPending: vi.fn(() => true),
      terminateAcceptedRestoredCollectorRun: vi.fn(async () => false),
      settleFailedQueuedSubagentLaunch,
      scheduleSweep,
      warn: vi.fn(),
    });

    restorer.restoreOnce();

    await vi.waitFor(() => expect(settleFailedQueuedSubagentLaunch).toHaveBeenCalledOnce());
    expect(resumeRun).not.toHaveBeenCalled();
    expect(settleFailedQueuedSubagentLaunch).toHaveBeenCalledWith(
      run.runId,
      "subagent launch was interrupted before activation",
      { suppressSessionEffects: false },
    );
    expect(scheduleSweep).toHaveBeenCalledWith({ delayMs: 0 });
    expect(run.launchCleanupPending).toBe(true);
  });

  it("retains an orphan row that still owns deferred attachment cleanup", () => {
    const run: SubagentRunRecord = {
      runId: "run-deferred-attachment-cleanup",
      childSessionKey: "agent:main:subagent:deferred-cleanup",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "clean orphan attachments",
      cleanup: "delete",
      createdAt: 100,
      execution: {
        status: "terminal",
        endedAt: 200,
        outcome: { status: "ok" },
        restartRecovery: {
          sessionId: "session-deferred-cleanup",
          sessionMarker: "marker-deferred-cleanup",
          idempotencyKey: "restart-deferred-cleanup",
          phase: "accepted",
        },
      },
      completion: { required: false },
      delivery: { status: "not_required" },
      attachmentsRootDir: "/workspace",
      attachmentsDir: "/workspace/.openclaw/attachments/00000000-0000-4000-8000-000000000001",
    };
    const runs = new Map([[run.runId, run]]);
    const persist = vi.fn();
    const ensureListener = vi.fn();
    const startSweeper = vi.fn();

    const restorer = createSubagentRegistryRestorer({
      runs,
      resumedRuns: new Set(),
      deps: () =>
        ({
          restoreSubagentRunsFromDisk: () => 1,
          getRuntimeConfig: () => ({}),
        }) as never,
      persist,
      settleRequesterTurn: vi.fn(),
      ensureListener,
      startSweeper,
      resumeRun: vi.fn(),
      listSwarmRunsForGroup: vi.fn(() => []),
      startQueuedSubagentRun: vi.fn(() => false),
      recordAcceptedRunTermination: vi.fn(),
      markAcceptedRunTerminationPending: vi.fn(() => true),
      terminateAcceptedRestoredCollectorRun: vi.fn(async () => false),
      settleFailedQueuedSubagentLaunch: vi.fn(() => false),
      scheduleSweep: vi.fn(),
      warn: vi.fn(),
    });

    restorer.restoreOnce();

    expect(runs.get(run.runId)).toBe(run);
    // Current restore policy arms terminal delete-mode retention before the
    // sweeper takes over the deferred cleanup owner.
    expect(persist).toHaveBeenCalledOnce();
    expect(ensureListener).toHaveBeenCalledOnce();
    expect(startSweeper).toHaveBeenCalledOnce();
  });
});
