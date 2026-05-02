import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CallGatewayOptions } from "../gateway/call.js";
import { SUBAGENT_ENDED_REASON_COMPLETE } from "./subagent-lifecycle-events.js";
import { createSubagentRegistryLifecycleController } from "./subagent-registry-lifecycle.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

type LifecycleControllerParams = Parameters<typeof createSubagentRegistryLifecycleController>[0];

const taskExecutorMocks = vi.hoisted(() => ({
  completeTaskRunByRunId: vi.fn(),
  failTaskRunByRunId: vi.fn(),
  setDetachedTaskDeliveryStatusByRunId: vi.fn(),
}));

const gatewayMocks = vi.hoisted(() => ({
  callGateway: vi.fn(async () => ({})),
}));

const helperMocks = vi.hoisted(() => ({
  persistSubagentSessionTiming: vi.fn(async () => {}),
  safeRemoveAttachmentsDir: vi.fn(async () => {}),
  logAnnounceGiveUp: vi.fn(),
}));

const runtimeMocks = vi.hoisted(() => ({
  log: vi.fn(),
}));

const lifecycleEventMocks = vi.hoisted(() => ({
  emitSessionLifecycleEvent: vi.fn(),
}));

const browserLifecycleCleanupMocks = vi.hoisted(() => ({
  cleanupBrowserSessionsForLifecycleEnd: vi.fn(async () => {}),
}));

const bundleMcpRuntimeMocks = vi.hoisted(() => ({
  retireSessionMcpRuntimeForSessionKey: vi.fn(async () => true),
}));

vi.mock("../tasks/detached-task-runtime.js", () => ({
  completeTaskRunByRunId: taskExecutorMocks.completeTaskRunByRunId,
  failTaskRunByRunId: taskExecutorMocks.failTaskRunByRunId,
  setDetachedTaskDeliveryStatusByRunId: taskExecutorMocks.setDetachedTaskDeliveryStatusByRunId,
}));

vi.mock("../sessions/session-lifecycle-events.js", () => ({
  emitSessionLifecycleEvent: lifecycleEventMocks.emitSessionLifecycleEvent,
}));

vi.mock("../browser-lifecycle-cleanup.js", () => ({
  cleanupBrowserSessionsForLifecycleEnd:
    browserLifecycleCleanupMocks.cleanupBrowserSessionsForLifecycleEnd,
}));

vi.mock("./pi-bundle-mcp-tools.js", () => ({
  retireSessionMcpRuntimeForSessionKey: bundleMcpRuntimeMocks.retireSessionMcpRuntimeForSessionKey,
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: {
    log: runtimeMocks.log,
  },
}));

vi.mock("../utils/delivery-context.js", () => ({
  normalizeDeliveryContext: (origin: unknown) => origin ?? "agent",
}));

vi.mock("./subagent-announce.js", () => ({
  captureSubagentCompletionReply: vi.fn(async () => undefined),
  runSubagentAnnounceFlow: vi.fn(async () => false),
}));

vi.mock("./subagent-registry-cleanup.js", () => ({
  resolveCleanupCompletionReason: () => SUBAGENT_ENDED_REASON_COMPLETE,
  resolveDeferredCleanupDecision: () => ({ kind: "give-up", reason: "retry-limit" }),
}));

vi.mock("./subagent-registry-helpers.js", () => ({
  ANNOUNCE_COMPLETION_HARD_EXPIRY_MS: 30 * 60_000,
  ANNOUNCE_EXPIRY_MS: 5 * 60_000,
  MAX_ANNOUNCE_RETRY_COUNT: 3,
  MIN_ANNOUNCE_RETRY_DELAY_MS: 1_000,
  capFrozenResultText: (text: string) => text.trim(),
  logAnnounceGiveUp: helperMocks.logAnnounceGiveUp,
  persistSubagentSessionTiming: helperMocks.persistSubagentSessionTiming,
  resolveAnnounceRetryDelayMs: (retryCount: number) =>
    Math.min(1_000 * 2 ** Math.max(0, retryCount - 1), 8_000),
  safeRemoveAttachmentsDir: helperMocks.safeRemoveAttachmentsDir,
}));

function createRunEntry(overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  return {
    runId: "run-1",
    childSessionKey: "agent:main:subagent:child",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "finish the task",
    cleanup: "keep",
    createdAt: 1_000,
    startedAt: 2_000,
    ...overrides,
  };
}

function createLifecycleController({
  entry,
  runs = new Map([[entry.runId, entry]]),
  ...overrides
}: {
  entry: SubagentRunRecord;
  runs?: Map<string, SubagentRunRecord>;
} & Partial<Parameters<typeof createSubagentRegistryLifecycleController>[0]>) {
  const params: LifecycleControllerParams = {
    runs,
    resumedRuns: new Set(),
    subagentAnnounceTimeoutMs: 1_000,
    persist: vi.fn(),
    clearPendingLifecycleError: vi.fn(),
    countPendingDescendantRuns: () => 0,
    suppressAnnounceForSteerRestart: () => false,
    shouldEmitEndedHookForRun: () => false,
    emitSubagentEndedHookForRun: vi.fn(async () => {}),
    notifyContextEngineSubagentEnded: vi.fn(async () => {}),
    resumeSubagentRun: vi.fn(),
    callGateway: gatewayMocks.callGateway as <T = Record<string, unknown>>(
      opts: CallGatewayOptions,
    ) => Promise<T>,
    captureSubagentCompletionReply: vi.fn(async () => "final completion reply"),
    runSubagentAnnounceFlow: vi.fn(async () => true),
    warn: vi.fn(),
  };
  Object.assign(params, overrides);
  return createSubagentRegistryLifecycleController(params);
}

describe("subagent registry lifecycle hardening", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    taskExecutorMocks.completeTaskRunByRunId.mockReset();
    taskExecutorMocks.failTaskRunByRunId.mockReset();
    taskExecutorMocks.setDetachedTaskDeliveryStatusByRunId.mockReset();
    gatewayMocks.callGateway.mockReset();
    gatewayMocks.callGateway.mockResolvedValue({});
    browserLifecycleCleanupMocks.cleanupBrowserSessionsForLifecycleEnd.mockClear();
    bundleMcpRuntimeMocks.retireSessionMcpRuntimeForSessionKey.mockClear();
    bundleMcpRuntimeMocks.retireSessionMcpRuntimeForSessionKey.mockResolvedValue(true);
  });

  it("does not reject completion when task finalization throws", async () => {
    const persist = vi.fn();
    const warn = vi.fn();
    const entry = createRunEntry();
    const runs = new Map([[entry.runId, entry]]);
    taskExecutorMocks.completeTaskRunByRunId.mockImplementation(() => {
      throw new Error("task store boom");
    });

    const controller = createLifecycleController({ entry, runs, persist, warn });

    await expect(
      controller.completeSubagentRun({
        runId: entry.runId,
        endedAt: 4_000,
        outcome: { status: "ok" },
        reason: SUBAGENT_ENDED_REASON_COMPLETE,
        triggerCleanup: false,
      }),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      "failed to finalize subagent background task state",
      expect.objectContaining({
        error: { name: "Error", message: "task store boom" },
        runId: "***",
        childSessionKey: "agent:main:…",
        outcomeStatus: "ok",
      }),
    );
    expect(helperMocks.persistSubagentSessionTiming).toHaveBeenCalledTimes(1);
    expect(lifecycleEventMocks.emitSessionLifecycleEvent).toHaveBeenCalledWith({
      sessionKey: "agent:main:subagent:child",
      reason: "subagent-status",
      parentSessionKey: "agent:main:main",
      label: undefined,
    });
  });

  it("does not reject cleanup give-up when task delivery status update throws", async () => {
    const persist = vi.fn();
    const warn = vi.fn();
    const entry = createRunEntry({
      endedAt: 4_000,
      expectsCompletionMessage: false,
      retainAttachmentsOnKeep: true,
    });
    taskExecutorMocks.setDetachedTaskDeliveryStatusByRunId.mockImplementation(() => {
      throw new Error("delivery state boom");
    });

    const controller = createLifecycleController({
      entry,
      persist,
      captureSubagentCompletionReply: vi.fn(async () => undefined),
      warn,
    });

    await expect(
      controller.finalizeResumedAnnounceGiveUp({
        runId: entry.runId,
        entry,
        reason: "retry-limit",
      }),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      "failed to update subagent background task delivery state",
      expect.objectContaining({
        error: { name: "Error", message: "delivery state boom" },
        runId: "***",
        childSessionKey: "agent:main:…",
        deliveryStatus: "failed",
      }),
    );
    expect(entry.cleanupCompletedAt).toBeTypeOf("number");
    expect(persist).toHaveBeenCalled();
  });

  it("cleans up tracked browser sessions before subagent cleanup flow", async () => {
    const persist = vi.fn();
    const entry = createRunEntry({
      expectsCompletionMessage: true,
    });
    const runSubagentAnnounceFlow = vi.fn(async () => true);

    const controller = createLifecycleController({ entry, persist, runSubagentAnnounceFlow });

    await expect(
      controller.completeSubagentRun({
        runId: entry.runId,
        endedAt: 4_000,
        outcome: { status: "ok" },
        reason: SUBAGENT_ENDED_REASON_COMPLETE,
        triggerCleanup: true,
      }),
    ).resolves.toBeUndefined();

    expect(browserLifecycleCleanupMocks.cleanupBrowserSessionsForLifecycleEnd).toHaveBeenCalledWith(
      {
        sessionKeys: [entry.childSessionKey],
        onWarn: expect.any(Function),
      },
    );
    expect(runSubagentAnnounceFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        childSessionKey: entry.childSessionKey,
      }),
    );
  });

  it("skips announce delivery when completion messages are disabled", async () => {
    const persist = vi.fn();
    const entry = createRunEntry({
      expectsCompletionMessage: false,
      retainAttachmentsOnKeep: true,
    });
    const runSubagentAnnounceFlow = vi.fn(async () => true);

    const controller = createLifecycleController({ entry, persist, runSubagentAnnounceFlow });

    await expect(
      controller.completeSubagentRun({
        runId: entry.runId,
        endedAt: 4_000,
        outcome: { status: "ok" },
        reason: SUBAGENT_ENDED_REASON_COMPLETE,
        triggerCleanup: true,
      }),
    ).resolves.toBeUndefined();

    expect(browserLifecycleCleanupMocks.cleanupBrowserSessionsForLifecycleEnd).toHaveBeenCalledWith(
      {
        sessionKeys: [entry.childSessionKey],
        onWarn: expect.any(Function),
      },
    );
    expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
    expect(taskExecutorMocks.setDetachedTaskDeliveryStatusByRunId).not.toHaveBeenCalledWith(
      expect.objectContaining({
        runId: entry.runId,
        deliveryStatus: "delivered",
      }),
    );
    await vi.waitFor(() => expect(entry.cleanupCompletedAt).toBeTypeOf("number"));
    expect(entry.completionAnnouncedAt).toBeUndefined();
  });

  it("archives delete-mode sessions when completion messages are disabled", async () => {
    const persist = vi.fn();
    const entry = createRunEntry({
      cleanup: "delete",
      expectsCompletionMessage: false,
      spawnMode: "session",
    });
    const runs = new Map([[entry.runId, entry]]);
    const runSubagentAnnounceFlow = vi.fn(async () => true);

    const controller = createLifecycleController({
      entry,
      runs,
      persist,
      runSubagentAnnounceFlow,
    });

    await expect(
      controller.completeSubagentRun({
        runId: entry.runId,
        endedAt: 4_000,
        outcome: { status: "ok" },
        reason: SUBAGENT_ENDED_REASON_COMPLETE,
        triggerCleanup: true,
      }),
    ).resolves.toBeUndefined();

    await vi.waitFor(() =>
      expect(gatewayMocks.callGateway).toHaveBeenCalledWith({
        method: "sessions.delete",
        params: {
          key: entry.childSessionKey,
          deleteTranscript: true,
          emitLifecycleHooks: true,
        },
        timeoutMs: 10_000,
      }),
    );
    expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
    expect(taskExecutorMocks.setDetachedTaskDeliveryStatusByRunId).not.toHaveBeenCalledWith(
      expect.objectContaining({
        runId: entry.runId,
        deliveryStatus: "delivered",
      }),
    );
    await vi.waitFor(() => expect(runs.has(entry.runId)).toBe(false));
    expect(entry.completionAnnouncedAt).toBeUndefined();
  });

  it("retires bundle MCP runtimes when run-mode cleanup completes", async () => {
    const entry = createRunEntry({
      endedAt: 4_000,
      expectsCompletionMessage: false,
      spawnMode: "run",
    });

    const controller = createLifecycleController({ entry });

    await expect(
      controller.completeSubagentRun({
        runId: entry.runId,
        endedAt: 4_000,
        outcome: { status: "ok" },
        reason: SUBAGENT_ENDED_REASON_COMPLETE,
        triggerCleanup: true,
      }),
    ).resolves.toBeUndefined();

    expect(bundleMcpRuntimeMocks.retireSessionMcpRuntimeForSessionKey).toHaveBeenCalledWith({
      sessionKey: entry.childSessionKey,
      reason: "subagent-run-cleanup",
      onError: expect.any(Function),
    });
  });

  it("keeps bundle MCP runtimes warm for persistent session-mode cleanup", async () => {
    const entry = createRunEntry({
      endedAt: 4_000,
      expectsCompletionMessage: false,
      spawnMode: "session",
    });

    const controller = createLifecycleController({ entry });

    await expect(
      controller.completeSubagentRun({
        runId: entry.runId,
        endedAt: 4_000,
        outcome: { status: "ok" },
        reason: SUBAGENT_ENDED_REASON_COMPLETE,
        triggerCleanup: true,
      }),
    ).resolves.toBeUndefined();

    expect(bundleMcpRuntimeMocks.retireSessionMcpRuntimeForSessionKey).not.toHaveBeenCalled();
  });

  it("enriches registered-run outcomes with persisted timing before cleanup", async () => {
    const persist = vi.fn();
    const runSubagentAnnounceFlow = vi.fn(async () => true);
    const entry = createRunEntry({
      startedAt: 2_000,
      expectsCompletionMessage: true,
    });

    const controller = createLifecycleController({ entry, persist, runSubagentAnnounceFlow });

    await expect(
      controller.completeSubagentRun({
        runId: entry.runId,
        endedAt: 4_250,
        outcome: { status: "timeout" },
        reason: SUBAGENT_ENDED_REASON_COMPLETE,
        triggerCleanup: true,
      }),
    ).resolves.toBeUndefined();

    const enrichedOutcome = {
      status: "timeout" as const,
      startedAt: 2_000,
      endedAt: 4_250,
      elapsedMs: 2_250,
    };
    expect(entry.outcome).toEqual(enrichedOutcome);
    expect(taskExecutorMocks.failTaskRunByRunId).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "timed_out",
      }),
    );
    expect(runSubagentAnnounceFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        startedAt: 2_000,
        endedAt: 4_250,
        outcome: enrichedOutcome,
      }),
    );
    expect(persist).toHaveBeenCalled();
  });

  it("persists timing when a preexisting outcome matches without timing", async () => {
    const persist = vi.fn();
    const entry = createRunEntry({
      startedAt: 2_000,
      outcome: { status: "ok" },
      expectsCompletionMessage: false,
    });

    const controller = createLifecycleController({ entry, persist });

    await expect(
      controller.completeSubagentRun({
        runId: entry.runId,
        endedAt: 4_250,
        outcome: { status: "ok" },
        reason: SUBAGENT_ENDED_REASON_COMPLETE,
        triggerCleanup: false,
      }),
    ).resolves.toBeUndefined();

    expect(entry.outcome).toEqual({
      status: "ok",
      startedAt: 2_000,
      endedAt: 4_250,
      elapsedMs: 2_250,
    });
    expect(persist).toHaveBeenCalled();
  });

  it("does not wait for a completion reply when the run does not expect one", async () => {
    const entry = createRunEntry({
      expectsCompletionMessage: false,
    });
    const captureSubagentCompletionReply = vi.fn(async () => undefined);

    const controller = createLifecycleController({
      entry,
      captureSubagentCompletionReply,
      runSubagentAnnounceFlow: vi.fn(async () => false),
    });

    await expect(
      controller.completeSubagentRun({
        runId: entry.runId,
        endedAt: 4_000,
        outcome: { status: "ok" },
        reason: SUBAGENT_ENDED_REASON_COMPLETE,
        triggerCleanup: false,
      }),
    ).resolves.toBeUndefined();

    expect(captureSubagentCompletionReply).toHaveBeenCalledWith(entry.childSessionKey, {
      waitForReply: false,
      outcome: {
        status: "ok",
        startedAt: 2_000,
        endedAt: 4_000,
        elapsedMs: 2_000,
      },
    });
  });

  it("does not freeze stale reply text for terminal error outcomes", async () => {
    const persist = vi.fn();
    const captureSubagentCompletionReply = vi.fn(async () => "stale assistant text");
    const entry = createRunEntry({
      expectsCompletionMessage: true,
    });

    const controller = createLifecycleController({
      entry,
      persist,
      captureSubagentCompletionReply,
    });

    await expect(
      controller.completeSubagentRun({
        runId: entry.runId,
        endedAt: 4_000,
        outcome: { status: "error", error: "All models failed (2): timeout" },
        reason: SUBAGENT_ENDED_REASON_COMPLETE,
        triggerCleanup: false,
      }),
    ).resolves.toBeUndefined();

    expect(captureSubagentCompletionReply).not.toHaveBeenCalled();
    expect(entry.frozenResultText).toBeNull();
    expect(taskExecutorMocks.failTaskRunByRunId).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        error: "All models failed (2): timeout",
        progressSummary: undefined,
      }),
    );
    expect(persist).toHaveBeenCalled();
  });

  it("does not re-run announce flow after completion was already delivered", async () => {
    const entry = createRunEntry({
      completionAnnouncedAt: 3_500,
      endedAt: 4_000,
    });
    const persist = vi.fn();
    const runSubagentAnnounceFlow = vi.fn(async () => true);
    const notifyContextEngineSubagentEnded = vi.fn(async () => {});

    const controller = createLifecycleController({
      entry,
      persist,
      notifyContextEngineSubagentEnded,
      runSubagentAnnounceFlow,
    });

    await expect(
      controller.completeSubagentRun({
        runId: entry.runId,
        endedAt: 4_000,
        outcome: { status: "ok" },
        reason: SUBAGENT_ENDED_REASON_COMPLETE,
        triggerCleanup: true,
      }),
    ).resolves.toBeUndefined();

    expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
    expect(typeof entry.cleanupCompletedAt).toBe("number");
    expect(entry.cleanupCompletedAt).toBeGreaterThan(0);
    expect(notifyContextEngineSubagentEnded).toHaveBeenCalledWith({
      childSessionKey: entry.childSessionKey,
      reason: "completed",
      workspaceDir: entry.workspaceDir,
    });
    expect(persist).toHaveBeenCalled();
  });

  it("emits ended hook while retrying cleanup after completion was already delivered", async () => {
    const entry = createRunEntry({
      completionAnnouncedAt: 3_500,
      endedAt: 4_000,
      expectsCompletionMessage: true,
    });
    const emitSubagentEndedHookForRun = vi.fn(async () => {});

    const controller = createLifecycleController({
      entry,
      shouldEmitEndedHookForRun: () => true,
      emitSubagentEndedHookForRun,
    });

    await expect(
      controller.completeSubagentRun({
        runId: entry.runId,
        endedAt: 4_000,
        outcome: { status: "ok" },
        reason: SUBAGENT_ENDED_REASON_COMPLETE,
        triggerCleanup: true,
      }),
    ).resolves.toBeUndefined();

    expect(emitSubagentEndedHookForRun).toHaveBeenCalledTimes(1);
    expect(emitSubagentEndedHookForRun).toHaveBeenCalledWith({
      entry,
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      sendFarewell: true,
    });
  });

  it("produces valid cleanupCompletedAt on give-up path when completionAnnouncedAt is undefined", async () => {
    const persist = vi.fn();
    const entry = createRunEntry({
      endedAt: 4_000,
      expectsCompletionMessage: false,
      retainAttachmentsOnKeep: true,
    });

    const controller = createLifecycleController({
      entry,
      persist,
      captureSubagentCompletionReply: vi.fn(async () => undefined),
    });

    expect(entry.completionAnnouncedAt).toBeUndefined();

    await controller.finalizeResumedAnnounceGiveUp({
      runId: entry.runId,
      entry,
      reason: "retry-limit",
    });

    expect(entry.cleanupCompletedAt).toBeTypeOf("number");
    expect(Number.isNaN(entry.cleanupCompletedAt)).toBe(false);
  });

  it("continues cleanup when delivery-status persistence throws after announce delivery", async () => {
    const persist = vi.fn();
    const warn = vi.fn();
    const emitSubagentEndedHookForRun = vi.fn(async () => {});
    const entry = createRunEntry({
      endedAt: 4_000,
      expectsCompletionMessage: true,
      retainAttachmentsOnKeep: false,
    });
    taskExecutorMocks.setDetachedTaskDeliveryStatusByRunId.mockImplementation(() => {
      throw new Error("delivery status boom");
    });

    const controller = createLifecycleController({
      entry,
      persist,
      shouldEmitEndedHookForRun: () => true,
      emitSubagentEndedHookForRun,
      warn,
    });

    await expect(
      controller.completeSubagentRun({
        runId: entry.runId,
        endedAt: 4_000,
        outcome: { status: "ok" },
        reason: SUBAGENT_ENDED_REASON_COMPLETE,
        triggerCleanup: true,
      }),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      "failed to update subagent background task delivery state",
      expect.objectContaining({
        error: { name: "Error", message: "delivery status boom" },
        deliveryStatus: "delivered",
      }),
    );
    expect(emitSubagentEndedHookForRun).toHaveBeenCalledTimes(1);
    expect(helperMocks.safeRemoveAttachmentsDir).toHaveBeenCalledTimes(1);
    expect(entry.cleanupCompletedAt).toBeTypeOf("number");
    expect(persist).toHaveBeenCalled();
  });

  it("persists the concrete announce delivery error when cleanup gives up", async () => {
    const persist = vi.fn();
    const entry = createRunEntry({
      endedAt: 4_000,
      expectsCompletionMessage: true,
      retainAttachmentsOnKeep: true,
    });
    const runSubagentAnnounceFlow = vi.fn(
      async (announceParams: {
        onDeliveryResult?: (delivery: {
          delivered: false;
          path: "direct";
          error: string;
          phases: Array<{
            phase: "direct-primary" | "queue-fallback";
            delivered: boolean;
            path: "direct" | "none";
            error?: string;
          }>;
        }) => void;
      }) => {
        announceParams.onDeliveryResult?.({
          delivered: false,
          path: "direct",
          error: "UNAVAILABLE: requester wake failed",
          phases: [
            {
              phase: "direct-primary",
              delivered: false,
              path: "direct",
              error: "UNAVAILABLE: requester wake failed",
            },
            {
              phase: "queue-fallback",
              delivered: false,
              path: "none",
            },
          ],
        });
        return false;
      },
    );

    const controller = createLifecycleController({
      entry,
      persist,
      runSubagentAnnounceFlow,
    });

    await expect(
      controller.completeSubagentRun({
        runId: entry.runId,
        endedAt: 4_000,
        outcome: { status: "ok" },
        reason: SUBAGENT_ENDED_REASON_COMPLETE,
        triggerCleanup: true,
      }),
    ).resolves.toBeUndefined();

    expect(taskExecutorMocks.setDetachedTaskDeliveryStatusByRunId).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: entry.runId,
        runtime: "subagent",
        sessionKey: entry.childSessionKey,
        deliveryStatus: "failed",
        error:
          "UNAVAILABLE: requester wake failed; direct-primary: UNAVAILABLE: requester wake failed",
      }),
    );
    expect(entry.lastAnnounceDeliveryError).toBe(
      "UNAVAILABLE: requester wake failed; direct-primary: UNAVAILABLE: requester wake failed",
    );
    expect(entry.cleanupCompletedAt).toBeTypeOf("number");
    expect(persist).toHaveBeenCalled();
  });

  it("skips browser cleanup when steer restart suppresses cleanup flow", async () => {
    const entry = createRunEntry({
      expectsCompletionMessage: false,
    });
    const runSubagentAnnounceFlow = vi.fn(async () => true);

    const controller = createLifecycleController({
      entry,
      suppressAnnounceForSteerRestart: () => true,
      runSubagentAnnounceFlow,
    });

    await expect(
      controller.completeSubagentRun({
        runId: entry.runId,
        endedAt: 4_000,
        outcome: { status: "ok" },
        reason: SUBAGENT_ENDED_REASON_COMPLETE,
        triggerCleanup: true,
      }),
    ).resolves.toBeUndefined();

    expect(
      browserLifecycleCleanupMocks.cleanupBrowserSessionsForLifecycleEnd,
    ).not.toHaveBeenCalled();
    expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
  });
});
