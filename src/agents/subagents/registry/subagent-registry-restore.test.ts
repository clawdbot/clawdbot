import { describe, expect, it, vi } from "vitest";
import { createSubagentRegistryRestorer } from "./subagent-registry-restore.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

describe("createSubagentRegistryRestorer", () => {
  it("terminalizes and cleans a restored provisional attachment owner", async () => {
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
    };
    const runs = new Map([[run.runId, run]]);
    const resumeRun = vi.fn();
    const cleanupFailedLaunchResources = vi.fn(async () => true);
    const settleFailedQueuedSubagentLaunch = vi.fn(() => {
      run.execution = { status: "terminal", endedAt: 200, suppressSessionEffects: true };
      return true;
    });
    const completeFailedLaunchCleanup = vi.fn(() => {
      run.launchCleanupPending = undefined;
    });
    const restorer = createSubagentRegistryRestorer({
      runs,
      resumedRuns: new Set(),
      deps: () =>
        ({
          restoreSubagentRunsFromDisk: () => 1,
          getRuntimeConfig: () => ({}),
        }) as never,
      persist: vi.fn(),
      persistOrThrow: vi.fn(),
      settleRequesterTurn: vi.fn(),
      ensureListener: vi.fn(),
      startSweeper: vi.fn(),
      resumeRun,
      listSwarmRunsForGroup: vi.fn(() => []),
      startQueuedSubagentRun: vi.fn(() => false),
      terminateAcceptedRestoredCollectorRun: vi.fn(async () => undefined),
      cleanupFailedLaunchResources,
      settleFailedQueuedSubagentLaunch,
      completeFailedLaunchCleanup,
      scheduleSweep: vi.fn(),
      warn: vi.fn(),
    });

    restorer.restoreOnce();

    await vi.waitFor(() => expect(completeFailedLaunchCleanup).toHaveBeenCalledWith(run.runId));
    expect(resumeRun).not.toHaveBeenCalled();
    expect(settleFailedQueuedSubagentLaunch).toHaveBeenCalledWith(
      run.runId,
      "subagent launch was interrupted before activation",
    );
    expect(cleanupFailedLaunchResources).toHaveBeenCalledWith(run, {
      includeSessionEffects: false,
      isCurrent: expect.any(Function),
    });
    expect(run.launchCleanupPending).toBeUndefined();
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
      persistOrThrow: vi.fn(),
      settleRequesterTurn: vi.fn(),
      ensureListener,
      startSweeper,
      resumeRun: vi.fn(),
      listSwarmRunsForGroup: vi.fn(() => []),
      startQueuedSubagentRun: vi.fn(() => false),
      terminateAcceptedRestoredCollectorRun: vi.fn(async () => undefined),
      cleanupFailedLaunchResources: vi.fn(async () => true),
      settleFailedQueuedSubagentLaunch: vi.fn(() => false),
      completeFailedLaunchCleanup: vi.fn(),
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
