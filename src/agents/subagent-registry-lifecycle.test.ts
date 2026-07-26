// Subagent registry lifecycle tests cover completion, cleanup, announce retry,
// detached task status, and resource retirement around child-run endings.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CallGatewayOptions } from "../gateway/call.js";
import {
  getActiveGatewayRootWorkCount,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  runWithGatewayIndependentRootWorkAdmission,
  waitForActiveGatewayRootWork,
} from "../process/gateway-work-admission.js";
import { SUBAGENT_KILL_TASK_ERROR } from "../tasks/detached-task-runtime-contract.js";
import {
  buildAnnounceIdFromChildRun,
  buildAnnounceIdempotencyKey,
} from "./announce-idempotency.js";
import type { SubagentAnnounceDeliveryResult } from "./subagent-announce-dispatch.js";
import {
  SUBAGENT_ENDED_REASON_COMPLETE,
  SUBAGENT_ENDED_REASON_ERROR,
  SUBAGENT_ENDED_REASON_KILLED,
} from "./subagent-lifecycle-events.js";
import { createSubagentRegistryLifecycleController } from "./subagent-registry-lifecycle.js";
import { markSubagentRunPausedAfterYield } from "./subagent-registry-run-manager.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { createStructuredOutputTool } from "./tools/structured-output-tool.js";

type LifecycleControllerParams = Parameters<typeof createSubagentRegistryLifecycleController>[0];

function waitForLifecycleState<T>(assertion: () => T | Promise<T>): Promise<T> {
  return vi.waitFor(assertion, { interval: 1 });
}

const taskExecutorMocks = vi.hoisted(() => ({
  completeTaskRunByRunId: vi.fn(),
  failTaskRunByRunId: vi.fn(),
  setDetachedTaskDeliveryStatusByRunId: vi.fn(),
}));

const gatewayMocks = vi.hoisted(() => ({
  callGateway: vi.fn(async (_opts: CallGatewayOptions) => ({})),
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

vi.mock("./agent-bundle-mcp-tools.js", () => ({
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
  PROVISIONAL_KILL_RECONCILIATION_MS: 5 * 60_000,
  backfillCollectorArchiveAtMs: () => false,
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

function expectFields(value: unknown, expected: Record<string, unknown>): void {
  if (!value || typeof value !== "object") {
    throw new Error("expected fields object");
  }
  const record = value as Record<string, unknown>;
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(record[key], key).toEqual(expectedValue);
  }
}

function firstCall(mock: ReturnType<typeof vi.fn>): ReadonlyArray<unknown> {
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error("expected first mock call");
  }
  return call;
}

function firstCallArg(mock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const [arg] = firstCall(mock);
  if (!arg || typeof arg !== "object") {
    throw new Error("expected first call argument object");
  }
  return arg as Record<string, unknown>;
}

function findCallArg(
  mock: ReturnType<typeof vi.fn>,
  predicate: (arg: Record<string, unknown>) => boolean,
): Record<string, unknown> {
  for (const [arg] of mock.mock.calls) {
    if (arg && typeof arg === "object" && predicate(arg as Record<string, unknown>)) {
      return arg as Record<string, unknown>;
    }
  }
  throw new Error("expected matching mock call");
}

function hasDeliveredTaskStatusUpdate(runId: string): boolean {
  return taskExecutorMocks.setDetachedTaskDeliveryStatusByRunId.mock.calls.some(([arg]) => {
    const record = arg as { runId?: unknown; deliveryStatus?: unknown } | undefined;
    return record?.runId === runId && record.deliveryStatus === "delivered";
  });
}

function buildExpectedAnnounceIdempotencyKey(entry: SubagentRunRecord): string {
  return buildAnnounceIdempotencyKey(
    buildAnnounceIdFromChildRun({
      childSessionKey: entry.childSessionKey,
      childRunId: entry.runId,
    }),
  );
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
    getRuntimeConfig: () => ({}),
    persist: vi.fn(),
    persistOrThrow: vi.fn(),
    clearPendingLifecycleError: vi.fn(),
    countPendingDescendantRuns: () => 0,
    suppressAnnounceForSteerRestart: () => false,
    resolveSubagentTask: () => ({ lookup: "available" }),
    shouldEmitEndedHookForRun: () => false,
    emitSubagentEndedHookForRun: vi.fn(async () => {}),
    emitSubagentProgressEndedForRun: vi.fn(async () => {}),
    notifyContextEngineSubagentEnded: vi.fn(async () => {}),
    retireSupersededRun: vi.fn(async () => {}),
    resumeSubagentRun: vi.fn(),
    callGateway: async <T = Record<string, unknown>>(opts: CallGatewayOptions): Promise<T> =>
      (await gatewayMocks.callGateway(opts)) as T,
    captureSubagentCompletionReply: vi.fn(async () => "final completion reply"),
    runSubagentAnnounceFlow: vi.fn(async () => true),
    maybeWakeRequesterAfterAllChildrenSettled: vi.fn(
      async (wakeParams: {
        settledEntry: { runId: string };
        completeBatch(runIds: readonly string[]): void;
      }) => {
        wakeParams.completeBatch([wakeParams.settledEntry.runId]);
        return false;
      },
    ),
    warn: vi.fn(),
  };
  Object.assign(params, overrides);
  return createSubagentRegistryLifecycleController(params);
}

async function runNoReplyMirrorScenario(params: {
  timestamp: number;
  text?: string;
  idempotencyKey?: string;
  idempotencyKeyForEntry?: (entry: SubagentRunRecord) => string;
}): Promise<SubagentRunRecord> {
  // A failed direct announce can still be mirrored from the requester history;
  // the idempotency key prevents stale or unrelated assistant text from winning.
  const entry = createRunEntry({
    endedAt: 4_000,
    expectsCompletionMessage: true,
    retainAttachmentsOnKeep: true,
  });
  const text = params.text ?? "final completion reply";
  const idempotencyKey =
    params.idempotencyKeyForEntry?.(entry) ??
    params.idempotencyKey ??
    `${buildExpectedAnnounceIdempotencyKey(entry)}:internal-source-reply:0`;
  const runSubagentAnnounceFlow = vi.fn(
    async (announceParams: {
      onDeliveryResult?: (delivery: SubagentAnnounceDeliveryResult) => void;
    }) => {
      announceParams.onDeliveryResult?.({
        delivered: false,
        path: "direct",
        error: "completion agent did not produce a visible reply",
      });
      return false;
    },
  );
  gatewayMocks.callGateway.mockResolvedValueOnce({
    messages: [
      {
        role: "assistant",
        provider: "openclaw",
        model: "delivery-mirror",
        content: text,
        timestamp: params.timestamp,
        idempotencyKey,
      },
    ],
  });

  await createLifecycleController({
    entry,
    captureSubagentCompletionReply: vi.fn(async () => text),
    persist: vi.fn(),
    runSubagentAnnounceFlow,
  }).completeSubagentRun({
    runId: entry.runId,
    endedAt: 4_000,
    outcome: { status: "ok" },
    reason: SUBAGENT_ENDED_REASON_COMPLETE,
    triggerCleanup: true,
  });
  return entry;
}

describe("subagent registry lifecycle hardening", () => {
  beforeEach(() => {
    resetGatewayWorkAdmission();
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

  it("emits one progress end event at the canonical terminal transition", async () => {
    const entry = createRunEntry({ expectsCompletionMessage: false });
    const emitSubagentProgressEndedForRun = vi.fn(async () => {});
    const controller = createLifecycleController({ entry, emitSubagentProgressEndedForRun });
    const completion = {
      runId: entry.runId,
      endedAt: 4_000,
      outcome: { status: "ok" as const },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      triggerCleanup: false,
    };

    await controller.completeSubagentRun(completion);
    await controller.completeSubagentRun(completion);

    expect(emitSubagentProgressEndedForRun).toHaveBeenCalledTimes(1);
    expect(emitSubagentProgressEndedForRun).toHaveBeenCalledWith(entry);
  });

  it("keeps task finalization, resource retirement, and announce cleanup root-admitted", async () => {
    const entry = createRunEntry({ expectsCompletionMessage: true });
    let releaseBrowserCleanup: (() => void) | undefined;
    let releaseAnnounce: ((didAnnounce: boolean) => void) | undefined;
    browserLifecycleCleanupMocks.cleanupBrowserSessionsForLifecycleEnd.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseBrowserCleanup = resolve;
        }),
    );
    const runSubagentAnnounceFlow = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          releaseAnnounce = resolve;
        }),
    );
    const controller = createLifecycleController({ entry, runSubagentAnnounceFlow });

    const completion = controller.completeSubagentRun({
      runId: entry.runId,
      endedAt: 4_000,
      outcome: { status: "ok" },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      triggerCleanup: true,
    });

    await waitForLifecycleState(() =>
      expect(
        browserLifecycleCleanupMocks.cleanupBrowserSessionsForLifecycleEnd,
      ).toHaveBeenCalledOnce(),
    );
    expect(taskExecutorMocks.completeTaskRunByRunId).toHaveBeenCalledOnce();
    expect(getActiveGatewayRootWorkCount()).toBe(1);

    releaseBrowserCleanup?.();
    await waitForLifecycleState(() => expect(runSubagentAnnounceFlow).toHaveBeenCalledOnce());
    await completion;
    expect(getActiveGatewayRootWorkCount()).toBe(1);

    releaseAnnounce?.(true);
    await waitForLifecycleState(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
    expect(entry.cleanupCompletedAt).toBeTypeOf("number");
  });

  it("keeps direct delete cleanup root-admitted until the gateway call settles", async () => {
    const entry = createRunEntry({ cleanup: "delete", expectsCompletionMessage: false });
    const runs = new Map([[entry.runId, entry]]);
    let releaseDelete: (() => void) | undefined;
    gatewayMocks.callGateway.mockImplementation((opts) => {
      if (opts.method !== "sessions.delete") {
        return Promise.resolve({});
      }
      return new Promise<Record<string, unknown>>((resolve) => {
        releaseDelete = () => resolve({});
      });
    });
    const controller = createLifecycleController({ entry, runs });

    await controller.completeSubagentRun({
      runId: entry.runId,
      endedAt: 4_000,
      outcome: { status: "ok" },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      triggerCleanup: true,
    });
    await waitForLifecycleState(() => expect(releaseDelete).toBeTypeOf("function"));
    expect(getActiveGatewayRootWorkCount()).toBe(1);

    releaseDelete?.();
    await waitForLifecycleState(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
    expect(runs.has(entry.runId)).toBe(false);
  });

  it("retries a cleanup handoff rejected by restart drain", async () => {
    vi.useFakeTimers();
    try {
      const entry = createRunEntry({ expectsCompletionMessage: true });
      let releaseBrowserCleanup: (() => void) | undefined;
      browserLifecycleCleanupMocks.cleanupBrowserSessionsForLifecycleEnd.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releaseBrowserCleanup = resolve;
          }),
      );
      const runSubagentAnnounceFlow = vi.fn(async () => true);
      const resumeSubagentRun = vi.fn((runId: string) => {
        controller.startSubagentAnnounceCleanupFlow(runId, entry);
      });
      const controller = createLifecycleController({
        entry,
        resumeSubagentRun,
        runSubagentAnnounceFlow,
      });

      const completion = controller.completeSubagentRun({
        runId: entry.runId,
        endedAt: 4_000,
        outcome: { status: "ok" },
        reason: SUBAGENT_ENDED_REASON_COMPLETE,
        triggerCleanup: true,
      });
      await waitForLifecycleState(() => expect(releaseBrowserCleanup).toBeTypeOf("function"));
      markGatewayRestartDraining();
      releaseBrowserCleanup?.();
      await completion;
      await waitForLifecycleState(() =>
        expect(runtimeMocks.log).toHaveBeenCalledWith(
          expect.stringContaining("subagent cleanup admission failed"),
        ),
      );
      expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
      expect(entry.cleanupHandled).toBe(true);

      resetGatewayWorkAdmission();
      await vi.advanceTimersByTimeAsync(1_000);
      await waitForLifecycleState(() => expect(runSubagentAnnounceFlow).toHaveBeenCalledOnce());
      await waitForLifecycleState(() => expect(entry.cleanupCompletedAt).toBeTypeOf("number"));
      expect(resumeSubagentRun).toHaveBeenCalledWith(entry.runId);
      expect(getActiveGatewayRootWorkCount()).toBe(0);
    } finally {
      resetGatewayWorkAdmission();
      vi.useRealTimers();
    }
  });

  it("does not reject completion when task finalization throws", async () => {
    const persist = vi.fn();
    const persistOrThrow = vi.fn();
    const warn = vi.fn();
    const entry = createRunEntry();
    const runs = new Map([[entry.runId, entry]]);
    taskExecutorMocks.completeTaskRunByRunId.mockImplementation(() => {
      throw new Error("task store boom");
    });

    const controller = createLifecycleController({ entry, runs, persist, persistOrThrow, warn });

    await expect(
      controller.completeSubagentRun({
        runId: entry.runId,
        endedAt: 4_000,
        outcome: { status: "ok" },
        reason: SUBAGENT_ENDED_REASON_COMPLETE,
        triggerCleanup: false,
      }),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(persistOrThrow).toHaveBeenCalledTimes(1);
    expect(persistOrThrow.mock.invocationCallOrder[0]).toBeLessThan(
      taskExecutorMocks.completeTaskRunByRunId.mock.invocationCallOrder[0]!,
    );
    const [warning, warningFields] = firstCall(warn);
    expect(warning).toBe("failed to finalize subagent background task state");
    expectFields(warningFields, {
      error: { name: "Error", message: "task store boom" },
      runId: "***",
      childSessionKey: "agent:main:…",
      outcomeStatus: "ok",
    });
    expect(helperMocks.persistSubagentSessionTiming).toHaveBeenCalledTimes(1);
    expect(lifecycleEventMocks.emitSessionLifecycleEvent).toHaveBeenCalledWith({
      sessionKey: "agent:main:subagent:child",
      reason: "subagent-status",
      parentSessionKey: "agent:main:main",
      label: undefined,
    });
  });

  it("restores the registry state when canonical completion persistence fails", async () => {
    const entry = createRunEntry();
    const original = structuredClone(entry);
    const persistOrThrow = vi.fn(() => {
      throw new Error("registry store boom");
    });
    const controller = createLifecycleController({ entry, persistOrThrow });

    await expect(
      controller.completeSubagentRun({
        runId: entry.runId,
        endedAt: 4_000,
        outcome: { status: "ok" },
        reason: SUBAGENT_ENDED_REASON_COMPLETE,
        triggerCleanup: false,
      }),
    ).rejects.toThrow("registry store boom");

    expect(entry).toEqual(original);
    expect(taskExecutorMocks.completeTaskRunByRunId).not.toHaveBeenCalled();
  });

  it("keeps a provider terminal when it acquires the completion lock first", async () => {
    let finishCapture: ((value: string) => void) | undefined;
    const entry = createRunEntry();
    const controller = createLifecycleController({
      entry,
      captureSubagentCompletionReply: vi.fn(
        () =>
          new Promise<string>((resolve) => {
            finishCapture = resolve;
          }),
      ),
    });
    const providerCompletion = controller.completeSubagentRun({
      runId: entry.runId,
      endedAt: 4_000,
      outcome: { status: "ok" },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      triggerCleanup: false,
    });
    await waitForLifecycleState(() => expect(finishCapture).toBeTypeOf("function"));
    const interruptedRecovery = controller.completeSubagentRun({
      runId: entry.runId,
      endedAt: 4_001,
      outcome: { status: "error", error: "restart interrupted run" },
      reason: SUBAGENT_ENDED_REASON_ERROR,
      triggerCleanup: false,
      recoverInterrupted: true,
    });

    finishCapture?.("provider result");
    await Promise.all([providerCompletion, interruptedRecovery]);

    expect(entry.outcome?.status).toBe("ok");
    expect(entry.endedReason).toBe(SUBAGENT_ENDED_REASON_COMPLETE);
    expect(entry.terminalOwner).toBeUndefined();
    expect(taskExecutorMocks.failTaskRunByRunId).not.toHaveBeenCalled();
  });

  it("persists interrupted recovery before task projection and rejects late provider or yield", async () => {
    const entry = createRunEntry();
    const persistOrThrow = vi.fn();
    const controller = createLifecycleController({ entry, persistOrThrow });
    await controller.completeSubagentRun({
      runId: entry.runId,
      endedAt: 4_000,
      outcome: { status: "error", error: "restart interrupted run" },
      reason: SUBAGENT_ENDED_REASON_ERROR,
      triggerCleanup: false,
      recoverInterrupted: true,
    });
    const recovered = structuredClone(entry);

    await controller.completeSubagentRun({
      runId: entry.runId,
      endedAt: 4_001,
      outcome: { status: "ok" },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      triggerCleanup: false,
    });

    expect(markSubagentRunPausedAfterYield({ entry, endedAt: 4_002 })).toBe(false);
    expect(entry).toEqual(recovered);
    expect(entry).toMatchObject({
      endedAt: 4_000,
      endedReason: SUBAGENT_ENDED_REASON_ERROR,
      terminalOwner: "interrupted-recovery",
      outcome: { status: "error", error: "restart interrupted run" },
      completion: { resultText: null, capturedAt: 4_000 },
    });
    expect(persistOrThrow).toHaveBeenCalledOnce();
    expect(persistOrThrow.mock.invocationCallOrder[0]).toBeLessThan(
      taskExecutorMocks.failTaskRunByRunId.mock.invocationCallOrder[0]!,
    );
  });

  it("rolls interrupted recovery back when registry persistence fails", async () => {
    const entry = createRunEntry();
    const original = structuredClone(entry);
    const controller = createLifecycleController({
      entry,
      persistOrThrow: vi.fn(() => {
        throw new Error("registry store boom");
      }),
    });

    await expect(
      controller.completeSubagentRun({
        runId: entry.runId,
        endedAt: 4_000,
        outcome: { status: "error", error: "restart interrupted run" },
        reason: SUBAGENT_ENDED_REASON_ERROR,
        triggerCleanup: false,
        recoverInterrupted: true,
      }),
    ).rejects.toThrow("registry store boom");

    expect(entry).toEqual(original);
    expect(taskExecutorMocks.failTaskRunByRunId).not.toHaveBeenCalled();
  });

  it.each([
    ["provisional", { killReconciliation: { killedAt: 4_000 } }],
    ["stable", {}],
  ])("keeps %s killed state unchanged during interrupted recovery", async (_name, extra) => {
    const entry = createRunEntry({
      endedAt: 4_000,
      endedReason: SUBAGENT_ENDED_REASON_KILLED,
      outcome: { status: "error", error: "agent run aborted" },
      suppressAnnounceReason: "killed",
      ...extra,
    });
    const original = structuredClone(entry);
    const persistOrThrow = vi.fn();
    await createLifecycleController({ entry, persistOrThrow }).completeSubagentRun({
      runId: entry.runId,
      endedAt: 4_001,
      outcome: { status: "error", error: "restart interrupted run" },
      reason: SUBAGENT_ENDED_REASON_ERROR,
      triggerCleanup: false,
      recoverInterrupted: true,
    });

    expect(entry).toEqual(original);
    expect(persistOrThrow).not.toHaveBeenCalled();
    expect(taskExecutorMocks.failTaskRunByRunId).not.toHaveBeenCalled();
    expect(taskExecutorMocks.completeTaskRunByRunId).not.toHaveBeenCalled();
  });

  it("does not overwrite partial terminal evidence during interrupted recovery", async () => {
    const terminalEvidence: Array<Partial<SubagentRunRecord>> = [
      { endedAt: 4_000 },
      { outcome: { status: "error", error: "existing failure" } },
      { endedReason: SUBAGENT_ENDED_REASON_ERROR },
      { execution: { status: "terminal", endedAt: 4_000 } },
      {
        endedAt: 4_000,
        outcome: { status: "error", error: "existing failure" },
        endedReason: SUBAGENT_ENDED_REASON_ERROR,
      },
    ];
    for (const evidence of terminalEvidence) {
      const entry = createRunEntry(evidence);
      const original = structuredClone(entry);
      const persistOrThrow = vi.fn();
      await createLifecycleController({ entry, persistOrThrow }).completeSubagentRun({
        runId: entry.runId,
        endedAt: 4_001,
        outcome: { status: "error", error: "restart interrupted run" },
        reason: SUBAGENT_ENDED_REASON_ERROR,
        triggerCleanup: false,
        recoverInterrupted: true,
      });

      expect(entry).toEqual(original);
      expect(persistOrThrow).not.toHaveBeenCalled();
    }
    expect(taskExecutorMocks.failTaskRunByRunId).not.toHaveBeenCalled();
    expect(taskExecutorMocks.completeTaskRunByRunId).not.toHaveBeenCalled();
  });

  it("drains exact interrupted terminal evidence after restart admission reopens", async () => {
    const interruptedOutcome = {
      status: "error" as const,
      error: "restart interrupted run",
      startedAt: 2_000,
      endedAt: 4_000,
      elapsedMs: 2_000,
    };
    const entry = createRunEntry({
      endedAt: 4_000,
      outcome: interruptedOutcome,
      endedReason: SUBAGENT_ENDED_REASON_ERROR,
      execution: {
        status: "terminal",
        startedAt: 2_000,
        endedAt: 4_000,
        outcome: interruptedOutcome,
      },
    });
    const persistOrThrow = vi.fn();
    await createLifecycleController({ entry, persistOrThrow }).completeSubagentRun({
      runId: entry.runId,
      endedAt: 4_000,
      outcome: { status: "error", error: "restart interrupted run" },
      reason: SUBAGENT_ENDED_REASON_ERROR,
      triggerCleanup: false,
      recoverInterrupted: true,
    });

    expect(entry).toMatchObject({
      endedAt: 4_000,
      endedReason: SUBAGENT_ENDED_REASON_ERROR,
      terminalOwner: "interrupted-recovery",
      outcome: { status: "error", error: "restart interrupted run" },
      execution: { status: "terminal", endedAt: 4_000 },
    });
    expect(persistOrThrow).toHaveBeenCalled();
  });

  it("preserves conflicting nested terminal evidence during interrupted recovery", async () => {
    const interruptedOutcome = {
      status: "error" as const,
      error: "restart interrupted run",
      startedAt: 2_000,
      endedAt: 4_000,
      elapsedMs: 2_000,
    };
    const entry = createRunEntry({
      endedAt: 4_000,
      outcome: interruptedOutcome,
      endedReason: SUBAGENT_ENDED_REASON_ERROR,
      execution: {
        status: "terminal",
        startedAt: 2_000,
        endedAt: 3_999,
        outcome: { status: "error", error: "provider failure" },
      },
    });
    const original = structuredClone(entry);
    const persistOrThrow = vi.fn();
    await createLifecycleController({ entry, persistOrThrow }).completeSubagentRun({
      runId: entry.runId,
      endedAt: 4_000,
      outcome: { status: "error", error: "restart interrupted run" },
      reason: SUBAGENT_ENDED_REASON_ERROR,
      triggerCleanup: false,
      recoverInterrupted: true,
    });

    expect(entry).toEqual(original);
    expect(persistOrThrow).not.toHaveBeenCalled();
    expect(taskExecutorMocks.failTaskRunByRunId).not.toHaveBeenCalled();
    expect(taskExecutorMocks.completeTaskRunByRunId).not.toHaveBeenCalled();
  });

  it("restores a provisional kill when canonical task projection fails", async () => {
    const entry = createRunEntry({
      endedAt: 4_000,
      endedReason: SUBAGENT_ENDED_REASON_KILLED,
      outcome: { status: "error", error: "agent run aborted" },
      suppressAnnounceReason: "killed",
      killReconciliation: { killedAt: 4_000 },
      cleanupHandled: true,
      cleanupCompletedAt: 4_000,
    });
    const original = structuredClone(entry);
    const persistOrThrow = vi.fn();
    taskExecutorMocks.completeTaskRunByRunId.mockImplementation(() => {
      throw new Error("task store boom");
    });
    const controller = createLifecycleController({
      entry,
      persistOrThrow,
      resolveSubagentTask: () => ({
        lookup: "available",
        task: {
          taskId: "task-provisional",
          runtime: "subagent",
          status: "cancelled",
          error: SUBAGENT_KILL_TASK_ERROR,
        } as never,
      }),
    });

    await expect(
      controller.completeSubagentRun({
        runId: entry.runId,
        endedAt: 4_001,
        outcome: { status: "ok" },
        reason: SUBAGENT_ENDED_REASON_COMPLETE,
        triggerCleanup: false,
      }),
    ).rejects.toThrow("subagent task projection did not finalize");

    expect(entry).toEqual(original);
    expect(persistOrThrow).not.toHaveBeenCalled();
  });

  it("commits a reconciled task before its canonical registry outcome", async () => {
    taskExecutorMocks.completeTaskRunByRunId.mockReturnValueOnce([{}]);
    const entry = createRunEntry({
      endedAt: 4_000,
      endedReason: SUBAGENT_ENDED_REASON_KILLED,
      outcome: { status: "error", error: "agent run aborted" },
      suppressAnnounceReason: "killed",
      killReconciliation: { killedAt: 4_000 },
      cleanupHandled: true,
      cleanupCompletedAt: 4_000,
    });
    const persistOrThrow = vi.fn();
    const controller = createLifecycleController({
      entry,
      persistOrThrow,
      resolveSubagentTask: () => ({
        lookup: "available",
        task: {
          taskId: "task-provisional",
          runtime: "subagent",
          status: "cancelled",
          error: SUBAGENT_KILL_TASK_ERROR,
        } as never,
      }),
    });

    await controller.completeSubagentRun({
      runId: entry.runId,
      endedAt: 4_001,
      outcome: { status: "ok" },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      triggerCleanup: false,
    });

    expect(taskExecutorMocks.completeTaskRunByRunId.mock.invocationCallOrder[0]).toBeLessThan(
      persistOrThrow.mock.invocationCallOrder[0]!,
    );
    expect(entry.killReconciliation).toBeUndefined();
  });

  it("keeps the shared task writable when a steer restart aborts its old run", async () => {
    const entry = createRunEntry({ suppressAnnounceReason: "steer-restart" });
    const controller = createLifecycleController({ entry });

    await controller.completeSubagentRun({
      runId: entry.runId,
      endedAt: 4_000,
      outcome: { status: "error", error: "agent run aborted" },
      reason: SUBAGENT_ENDED_REASON_KILLED,
      triggerCleanup: false,
    });

    expect(entry).toMatchObject({
      endedAt: 4_000,
      endedReason: SUBAGENT_ENDED_REASON_KILLED,
    });
    expect(taskExecutorMocks.failTaskRunByRunId).not.toHaveBeenCalled();
    expect(taskExecutorMocks.completeTaskRunByRunId).not.toHaveBeenCalled();
  });

  it("marks standalone killed lifecycle tasks with the recoverable cancellation", async () => {
    const entry = createRunEntry();
    const controller = createLifecycleController({ entry });

    await controller.completeSubagentRun({
      runId: entry.runId,
      endedAt: 4_000,
      outcome: { status: "error", error: "agent run aborted" },
      reason: SUBAGENT_ENDED_REASON_KILLED,
      triggerCleanup: false,
    });

    expectFields(firstCallArg(taskExecutorMocks.failTaskRunByRunId), {
      runId: entry.runId,
      runtime: "subagent",
      sessionKey: entry.childSessionKey,
      status: "cancelled",
      error: SUBAGENT_KILL_TASK_ERROR,
    });
  });

  it("normalizes an abort observed after its explicit deadline without a kill tombstone", async () => {
    const entry = createRunEntry({ runTimeoutSeconds: 3 });
    const controller = createLifecycleController({ entry });

    await controller.completeSubagentRun({
      runId: entry.runId,
      startedAt: 2_000,
      endedAt: 6_000,
      outcome: { status: "error", error: "agent run aborted" },
      reason: SUBAGENT_ENDED_REASON_KILLED,
      triggerCleanup: false,
    });

    expect(entry).toMatchObject({
      endedAt: 5_000,
      endedReason: SUBAGENT_ENDED_REASON_COMPLETE,
      outcome: { status: "timeout", startedAt: 2_000, endedAt: 5_000 },
    });
    expect(entry.killReconciliation).toBeUndefined();
    expect(entry.suppressAnnounceReason).toBeUndefined();
    expect(taskExecutorMocks.failTaskRunByRunId).toHaveBeenCalledWith(
      expect.objectContaining({ status: "timed_out", endedAt: 5_000 }),
    );
  });

  it("keeps a deadline-normalized steer abort from terminalizing the shared task", async () => {
    const entry = createRunEntry({
      runTimeoutSeconds: 3,
      suppressAnnounceReason: "steer-restart",
    });
    const controller = createLifecycleController({ entry });

    await controller.completeSubagentRun({
      runId: entry.runId,
      startedAt: 2_000,
      endedAt: 6_000,
      outcome: { status: "error", error: "agent run aborted" },
      reason: SUBAGENT_ENDED_REASON_KILLED,
      triggerCleanup: false,
    });

    expect(entry).toMatchObject({
      endedAt: 5_000,
      endedReason: SUBAGENT_ENDED_REASON_COMPLETE,
      outcome: { status: "timeout" },
      suppressAnnounceReason: "steer-restart",
    });
    expect(taskExecutorMocks.failTaskRunByRunId).not.toHaveBeenCalled();
    expect(taskExecutorMocks.completeTaskRunByRunId).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "defers provisional killed publication when completion delivery is %s",
    async (expectsCompletionMessage) => {
      const entry = createRunEntry({ expectsCompletionMessage });
      const emitSubagentEndedHookForRun = vi.fn(async () => {});
      const runSubagentAnnounceFlow = vi.fn(async () => true);
      const controller = createLifecycleController({
        entry,
        shouldEmitEndedHookForRun: () => true,
        emitSubagentEndedHookForRun,
        runSubagentAnnounceFlow,
      });

      await controller.completeSubagentRun({
        runId: entry.runId,
        endedAt: 4_000,
        outcome: { status: "error", error: "agent run aborted" },
        reason: SUBAGENT_ENDED_REASON_KILLED,
        triggerCleanup: true,
      });

      expect(entry).toMatchObject({
        endedReason: SUBAGENT_ENDED_REASON_KILLED,
        suppressAnnounceReason: "killed",
      });
      expect(emitSubagentEndedHookForRun).not.toHaveBeenCalled();
      expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
      expectFields(firstCallArg(taskExecutorMocks.failTaskRunByRunId), {
        error: SUBAGENT_KILL_TASK_ERROR,
      });
    },
  );

  it("recaptures the final reply when success supersedes a killed lifecycle", async () => {
    const entry = createRunEntry({
      expectsCompletionMessage: true,
      suppressAnnounceReason: "killed",
    });
    const captureSubagentCompletionReply = vi.fn(
      async () => "Fixed the crash and verified the regression tests pass.",
    );
    const controller = createLifecycleController({
      entry,
      captureSubagentCompletionReply,
    });

    await controller.completeSubagentRun({
      runId: entry.runId,
      endedAt: 4_000,
      outcome: { status: "error", error: "agent run aborted" },
      reason: SUBAGENT_ENDED_REASON_KILLED,
      triggerCleanup: false,
    });
    expect(entry.completion).toMatchObject({ resultText: null });

    await controller.completeSubagentRun({
      runId: entry.runId,
      endedAt: 4_001,
      outcome: { status: "ok" },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      triggerCleanup: false,
    });

    expect(captureSubagentCompletionReply).toHaveBeenCalledOnce();
    expect(entry.completion?.resultText).toBe(
      "Fixed the crash and verified the regression tests pass.",
    );
    const finalArg = taskExecutorMocks.completeTaskRunByRunId.mock.calls.at(-1)?.[0];
    expectFields(finalArg, {
      runId: entry.runId,
      status: undefined,
      progressSummary: "Fixed the crash and verified the regression tests pass.",
      terminalSummary: null,
    });
  });

  it("recaptures the partial reply when timeout supersedes a killed lifecycle", async () => {
    const entry = createRunEntry({
      expectsCompletionMessage: true,
      suppressAnnounceReason: "killed",
    });
    const captureSubagentCompletionReply = vi.fn(async () => "Partial result before timeout.");
    const controller = createLifecycleController({
      entry,
      captureSubagentCompletionReply,
    });

    await controller.completeSubagentRun({
      runId: entry.runId,
      endedAt: 4_000,
      outcome: { status: "error", error: "agent run aborted" },
      reason: SUBAGENT_ENDED_REASON_KILLED,
      triggerCleanup: false,
    });
    expect(entry.completion).toMatchObject({ resultText: null });

    await controller.completeSubagentRun({
      runId: entry.runId,
      endedAt: 4_001,
      outcome: { status: "timeout" },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      triggerCleanup: false,
    });

    expect(captureSubagentCompletionReply).toHaveBeenCalledOnce();
    expect(entry.completion?.resultText).toBe("Partial result before timeout.");
  });

  it("preserves a captured reply when success supersedes a delayed killed lifecycle", async () => {
    const entry = createRunEntry({
      endedAt: 4_000,
      archiveAtMs: 5_000,
      endedReason: SUBAGENT_ENDED_REASON_KILLED,
      outcome: { status: "error", error: "agent run aborted" },
      expectsCompletionMessage: true,
      suppressAnnounceReason: "killed",
      killReconciliation: { killedAt: 4_000 },
      cleanupHandled: true,
      completion: {
        required: true,
        resultText: "Already captured final reply.",
        capturedAt: 4_000,
      },
    });
    const captureSubagentCompletionReply = vi.fn(async () => undefined);
    const controller = createLifecycleController({
      entry,
      captureSubagentCompletionReply,
    });

    await controller.completeSubagentRun({
      runId: entry.runId,
      endedAt: 4_001,
      outcome: { status: "ok" },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      triggerCleanup: false,
    });

    expect(captureSubagentCompletionReply).not.toHaveBeenCalled();
    expect(entry.completion).toMatchObject({
      resultText: "Already captured final reply.",
      capturedAt: 4_000,
    });
    expect(entry.archiveAtMs).toBe(5_000);
    expectFields(taskExecutorMocks.completeTaskRunByRunId.mock.calls.at(-1)?.[0], {
      progressSummary: "Already captured final reply.",
    });
  });

  it("keeps success canonical while a killed callback waits behind reply capture", async () => {
    const entry = createRunEntry({ expectsCompletionMessage: true });
    let releaseCapture: ((value: string) => void) | undefined;
    const captureSubagentCompletionReply = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          releaseCapture = resolve;
        }),
    );
    const controller = createLifecycleController({
      entry,
      captureSubagentCompletionReply,
    });

    const success = controller.completeSubagentRun({
      runId: entry.runId,
      endedAt: 4_000,
      outcome: { status: "ok" },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      triggerCleanup: false,
    });
    await waitForLifecycleState(() =>
      expect(captureSubagentCompletionReply).toHaveBeenCalledOnce(),
    );
    const killed = controller.completeSubagentRun({
      runId: entry.runId,
      endedAt: 4_001,
      outcome: { status: "error", error: "agent run aborted" },
      reason: SUBAGENT_ENDED_REASON_KILLED,
      triggerCleanup: false,
    });
    releaseCapture?.("Canonical final reply.");
    await Promise.all([success, killed]);

    expect(entry).toMatchObject({
      endedAt: 4_000,
      endedReason: SUBAGENT_ENDED_REASON_COMPLETE,
      outcome: { status: "ok" },
      completion: { resultText: "Canonical final reply." },
    });
    expect(taskExecutorMocks.failTaskRunByRunId).not.toHaveBeenCalled();
    expectFields(taskExecutorMocks.completeTaskRunByRunId.mock.calls.at(-1)?.[0], {
      progressSummary: "Canonical final reply.",
    });
  });

  it.each(["keep", "delete"] as const)(
    "invalidates in-flight %s cleanup when an authoritative yield revives the run",
    async (cleanup) => {
      const entry = createRunEntry({
        cleanup,
        expectsCompletionMessage: true,
      });
      const runs = new Map([[entry.runId, entry]]);
      let finishAnnounce: ((didAnnounce: boolean) => void) | undefined;
      const runSubagentAnnounceFlow = vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            finishAnnounce = resolve;
          }),
      );
      const controller = createLifecycleController({
        entry,
        runs,
        runSubagentAnnounceFlow,
        captureSubagentCompletionReply: vi.fn(async () => "premature terminal reply"),
      });

      await controller.completeSubagentRun({
        runId: entry.runId,
        endedAt: 4_000,
        outcome: { status: "ok" },
        reason: SUBAGENT_ENDED_REASON_COMPLETE,
        triggerCleanup: true,
      });
      expect(runSubagentAnnounceFlow).toHaveBeenCalledOnce();
      expect(entry.cleanupHandled).toBe(true);

      expect(
        markSubagentRunPausedAfterYield({
          entry,
          startedAt: 2_000,
          endedAt: 4_001,
        }),
      ).toBe(true);
      finishAnnounce?.(true);
      await waitForLifecycleState(() => expect(entry.pauseReason).toBe("sessions_yield"));

      expect(runs.get(entry.runId)).toBe(entry);
      expect(entry.cleanupHandled).toBe(false);
      expect(entry.cleanupCompletedAt).toBeUndefined();
      expect(helperMocks.safeRemoveAttachmentsDir).not.toHaveBeenCalled();
      expect(gatewayMocks.callGateway).not.toHaveBeenCalledWith(
        expect.objectContaining({ method: "sessions.delete" }),
      );
    },
  );

  it("rejects a yield after direct delete cleanup has been dispatched", async () => {
    const entry = createRunEntry({ cleanup: "delete", expectsCompletionMessage: false });
    const runs = new Map([[entry.runId, entry]]);
    let releaseDelete: (() => void) | undefined;
    gatewayMocks.callGateway.mockImplementation((opts) => {
      if (opts.method !== "sessions.delete") {
        return Promise.resolve({});
      }
      return new Promise<Record<string, unknown>>((resolve) => {
        releaseDelete = () => resolve({});
      });
    });
    const controller = createLifecycleController({ entry, runs });

    await controller.completeSubagentRun({
      runId: entry.runId,
      endedAt: 4_000,
      outcome: { status: "ok" },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      triggerCleanup: true,
    });
    await waitForLifecycleState(() => expect(entry.deleteCleanupDispatchedAt).toBeTypeOf("number"));

    expect(markSubagentRunPausedAfterYield({ entry, endedAt: 4_001 })).toBe(false);
    expect(entry.pauseReason).toBeUndefined();
    expect(entry.endedReason).toBe(SUBAGENT_ENDED_REASON_COMPLETE);

    releaseDelete?.();
    await waitForLifecycleState(() => expect(runs.has(entry.runId)).toBe(false));
  });

  it("rejects a yield after announce cleanup hands off delete dispatch", async () => {
    const entry = createRunEntry({ cleanup: "delete", expectsCompletionMessage: true });
    const runs = new Map([[entry.runId, entry]]);
    let releaseAnnounce: (() => void) | undefined;
    const runSubagentAnnounceFlow: LifecycleControllerParams["runSubagentAnnounceFlow"] = vi.fn(
      (announceParams) =>
        new Promise<boolean>((resolve) => {
          expect(announceParams.onBeforeDeleteChildSession?.()).toBe(true);
          releaseAnnounce = () => resolve(true);
        }),
    );
    const controller = createLifecycleController({ entry, runs, runSubagentAnnounceFlow });

    await controller.completeSubagentRun({
      runId: entry.runId,
      endedAt: 4_000,
      outcome: { status: "ok" },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      triggerCleanup: true,
    });
    await waitForLifecycleState(() => expect(entry.deleteCleanupDispatchedAt).toBeTypeOf("number"));

    expect(markSubagentRunPausedAfterYield({ entry, endedAt: 4_001 })).toBe(false);
    expect(entry.pauseReason).toBeUndefined();
    expect(entry.endedReason).toBe(SUBAGENT_ENDED_REASON_COMPLETE);

    releaseAnnounce?.();
    await waitForLifecycleState(() => expect(runs.has(entry.runId)).toBe(false));
  });

  it("discards completion capture when an authoritative yield arrives during the await", async () => {
    const entry = createRunEntry({ expectsCompletionMessage: true });
    let finishCapture: ((result: string) => void) | undefined;
    const captureSubagentCompletionReply = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finishCapture = resolve;
        }),
    );
    const controller = createLifecycleController({
      entry,
      captureSubagentCompletionReply,
    });

    const completion = controller.completeSubagentRun({
      runId: entry.runId,
      endedAt: 4_000,
      outcome: { status: "ok" },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      triggerCleanup: true,
    });
    await waitForLifecycleState(() =>
      expect(captureSubagentCompletionReply).toHaveBeenCalledOnce(),
    );
    expect(markSubagentRunPausedAfterYield({ entry, endedAt: 4_001 })).toBe(true);
    finishCapture?.("stale pre-yield reply");
    await completion;

    expect(entry).toMatchObject({
      pauseReason: "sessions_yield",
      completion: { required: true },
    });
    expect(entry.completion?.resultText).toBeUndefined();
    expect(entry.completion?.capturedAt).toBeUndefined();
    expect(taskExecutorMocks.completeTaskRunByRunId).not.toHaveBeenCalled();
  });

  it("abandons a killed callback tail after success becomes canonical", async () => {
    const entry = createRunEntry({ expectsCompletionMessage: true });
    let releaseKilledTiming: (() => void) | undefined;
    helperMocks.persistSubagentSessionTiming
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releaseKilledTiming = resolve;
          }),
      )
      .mockResolvedValueOnce(undefined);
    const runSubagentAnnounceFlow = vi.fn<(_params: unknown) => Promise<boolean>>(async () => true);
    const controller = createLifecycleController({
      entry,
      runSubagentAnnounceFlow,
      captureSubagentCompletionReply: vi.fn(async () => "Canonical success."),
    });

    const killed = controller.completeSubagentRun({
      runId: entry.runId,
      endedAt: 4_000,
      outcome: { status: "error", error: "agent run aborted" },
      reason: SUBAGENT_ENDED_REASON_KILLED,
      triggerCleanup: true,
    });
    await waitForLifecycleState(() =>
      expect(helperMocks.persistSubagentSessionTiming).toHaveBeenCalledOnce(),
    );
    const success = controller.completeSubagentRun({
      runId: entry.runId,
      endedAt: 4_001,
      outcome: { status: "ok" },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      triggerCleanup: true,
    });
    await waitForLifecycleState(() =>
      expect(helperMocks.persistSubagentSessionTiming).toHaveBeenCalledTimes(2),
    );
    releaseKilledTiming?.();
    await Promise.all([killed, success]);

    expect(entry).toMatchObject({
      endedReason: SUBAGENT_ENDED_REASON_COMPLETE,
      outcome: { status: "ok" },
      completion: { resultText: "Canonical success." },
    });
    expect(runSubagentAnnounceFlow).toHaveBeenCalledOnce();
    expect(runSubagentAnnounceFlow.mock.calls[0]?.[0]).toMatchObject({
      outcome: { status: "ok" },
      roundOneReply: "Canonical success.",
    });
  });

  it("keeps requester stop delivery suppressed when provider completion wins", async () => {
    const entry = createRunEntry({
      endedAt: 4_000,
      endedReason: SUBAGENT_ENDED_REASON_KILLED,
      outcome: { status: "error", error: "agent run aborted" },
      expectsCompletionMessage: true,
      suppressAnnounceReason: "killed",
      killReconciliation: {
        killedAt: 4_000,
        suppressTaskDelivery: true,
      },
      cleanupHandled: true,
      cleanupCompletedAt: 4_000,
    });
    const runSubagentAnnounceFlow = vi.fn<(_params: unknown) => Promise<boolean>>(async () => true);
    const emitSubagentEndedHookForRun = vi.fn(async () => {});
    const controller = createLifecycleController({
      entry,
      runSubagentAnnounceFlow,
      shouldEmitEndedHookForRun: () => true,
      emitSubagentEndedHookForRun,
    });

    await controller.completeSubagentRun({
      runId: entry.runId,
      endedAt: 4_001,
      outcome: { status: "ok" },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      triggerCleanup: true,
    });

    await waitForLifecycleState(() => expect(entry.cleanupCompletedAt).toBeTypeOf("number"));
    expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
    expect(entry.delivery?.status).toBe("not_required");
    expect(entry.suppressCompletionDelivery).toBeUndefined();
    expect(emitSubagentEndedHookForRun).toHaveBeenCalledWith(
      expect.objectContaining({
        entry,
        reason: SUBAGENT_ENDED_REASON_COMPLETE,
      }),
    );
    expectFields(firstCallArg(taskExecutorMocks.completeTaskRunByRunId), {
      runId: entry.runId,
      suppressDelivery: true,
    });
  });

  it.each([
    {
      name: "failure",
      reason: SUBAGENT_ENDED_REASON_ERROR,
      outcome: { status: "error" as const, error: "provider failed" },
    },
    {
      name: "timeout",
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      outcome: { status: "timeout" as const },
    },
  ])(
    "keeps canonical $name when a delayed killed callback arrives",
    async ({ reason, outcome }) => {
      const entry = createRunEntry();
      const controller = createLifecycleController({ entry });

      await controller.completeSubagentRun({
        runId: entry.runId,
        endedAt: 4_000,
        outcome,
        reason,
        triggerCleanup: false,
      });
      await controller.completeSubagentRun({
        runId: entry.runId,
        endedAt: 4_001,
        outcome: { status: "error", error: "agent run aborted" },
        reason: SUBAGENT_ENDED_REASON_KILLED,
        triggerCleanup: false,
      });

      expect(entry.outcome?.status).toBe(outcome.status);
      expect(entry.endedReason).toBe(reason);
      expect(taskExecutorMocks.failTaskRunByRunId).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    {
      name: "failure",
      reason: SUBAGENT_ENDED_REASON_ERROR,
      outcome: { status: "error" as const, error: "provider failed" },
    },
    {
      name: "timeout",
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      outcome: { status: "timeout" as const },
    },
  ])(
    "restarts cleanup when canonical $name supersedes a killed run",
    async ({ reason, outcome }) => {
      const entry = createRunEntry({
        endedAt: 4_000,
        endedReason: SUBAGENT_ENDED_REASON_KILLED,
        outcome: { status: "error", error: "agent run aborted" },
        expectsCompletionMessage: true,
        suppressAnnounceReason: "killed",
        killReconciliation: { killedAt: 4_000 },
        cleanupHandled: true,
        cleanupCompletedAt: 4_000,
        delivery: {
          status: "delivered",
          announcedAt: 4_000,
          deliveredAt: 4_000,
        },
      });
      const controller = createLifecycleController({ entry });

      await controller.completeSubagentRun({
        runId: entry.runId,
        endedAt: 4_001,
        outcome,
        reason,
        triggerCleanup: false,
      });

      expect(entry).toMatchObject({
        endedAt: 4_001,
        endedReason: reason,
        outcome: { status: outcome.status },
        cleanupHandled: false,
        delivery: { status: "pending" },
      });
      expect(entry.cleanupCompletedAt).toBeUndefined();
      expect(entry.suppressAnnounceReason).toBeUndefined();
      expect(entry.delivery?.announcedAt).toBeUndefined();
      expect(entry.delivery?.deliveredAt).toBeUndefined();
    },
  );

  it("keeps accepted task cancellation canonical over a late provider result", async () => {
    const entry = createRunEntry({
      endedAt: 4_000,
      endedReason: SUBAGENT_ENDED_REASON_KILLED,
      outcome: { status: "error", error: "agent run aborted" },
      suppressAnnounceReason: "killed",
      killReconciliation: { killedAt: 4_000 },
      cleanupHandled: true,
      cleanupCompletedAt: 4_000,
    });
    const controller = createLifecycleController({
      entry,
      resolveSubagentTask: () => ({
        lookup: "available",
        task: {
          taskId: "task-1",
          runtime: "subagent",
          status: "cancelled",
          error: "Cancelled by operator.",
        } as never,
      }),
    });

    await controller.completeSubagentRun({
      runId: entry.runId,
      endedAt: 4_001,
      outcome: { status: "ok" },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      triggerCleanup: true,
    });

    expect(entry).toMatchObject({
      endedAt: 4_000,
      endedReason: SUBAGENT_ENDED_REASON_KILLED,
      outcome: { status: "error", error: "agent run aborted" },
      suppressAnnounceReason: "killed",
    });
    expect(taskExecutorMocks.completeTaskRunByRunId).not.toHaveBeenCalled();
  });

  it("does not reinterpret a legacy killed row as a provisional cancellation", async () => {
    const entry = createRunEntry({
      endedAt: 4_000,
      endedReason: SUBAGENT_ENDED_REASON_KILLED,
      outcome: { status: "error", error: "legacy cancellation" },
      suppressAnnounceReason: "killed",
      cleanupHandled: true,
      cleanupCompletedAt: 4_000,
    });
    const original = structuredClone(entry);
    const controller = createLifecycleController({ entry });

    await controller.completeSubagentRun({
      runId: entry.runId,
      endedAt: 4_001,
      outcome: { status: "ok" },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      triggerCleanup: true,
    });

    expect(entry).toEqual(original);
    expect(taskExecutorMocks.completeTaskRunByRunId).not.toHaveBeenCalled();
  });

  it("keeps cancellation canonical when a custom runtime cannot resolve its task", async () => {
    const entry = createRunEntry({
      endedAt: 4_000,
      endedReason: SUBAGENT_ENDED_REASON_KILLED,
      outcome: { status: "error", error: "agent run aborted" },
      suppressAnnounceReason: "killed",
      killReconciliation: { killedAt: 4_000 },
      cleanupHandled: true,
      cleanupCompletedAt: 4_000,
    });
    const controller = createLifecycleController({
      entry,
      resolveSubagentTask: () => ({ lookup: "unavailable" }),
    });

    await controller.completeSubagentRun({
      runId: entry.runId,
      endedAt: 4_001,
      outcome: { status: "ok" },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      triggerCleanup: true,
    });

    expect(entry).toMatchObject({
      endedAt: 4_000,
      endedReason: SUBAGENT_ENDED_REASON_KILLED,
      outcome: { status: "error", error: "agent run aborted" },
      suppressAnnounceReason: "killed",
    });
    expect(taskExecutorMocks.completeTaskRunByRunId).toHaveBeenCalledTimes(1);
  });

  it("accepts provider completion when an opaque custom runtime finalizes it", async () => {
    taskExecutorMocks.completeTaskRunByRunId.mockReturnValueOnce([{}]);
    const entry = createRunEntry({
      endedAt: 4_000,
      endedReason: SUBAGENT_ENDED_REASON_KILLED,
      outcome: { status: "error", error: "agent run aborted" },
      suppressAnnounceReason: "killed",
      killReconciliation: { killedAt: 4_000 },
      cleanupHandled: true,
      cleanupCompletedAt: 4_000,
    });
    const controller = createLifecycleController({
      entry,
      resolveSubagentTask: () => ({ lookup: "unavailable" }),
    });

    await controller.completeSubagentRun({
      runId: entry.runId,
      endedAt: 4_001,
      outcome: { status: "ok" },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      triggerCleanup: false,
    });

    expect(entry).toMatchObject({
      endedAt: 4_001,
      endedReason: SUBAGENT_ENDED_REASON_COMPLETE,
      outcome: { status: "ok" },
    });
    expect(entry.suppressAnnounceReason).toBeUndefined();
    expect(taskExecutorMocks.completeTaskRunByRunId).toHaveBeenCalled();
  });

  it("restores an opaque provisional kill when completion persistence fails", async () => {
    taskExecutorMocks.completeTaskRunByRunId.mockReturnValueOnce([{}]);
    const entry = createRunEntry({
      endedAt: 4_000,
      endedReason: SUBAGENT_ENDED_REASON_KILLED,
      outcome: { status: "error", error: "agent run aborted" },
      suppressAnnounceReason: "killed",
      killReconciliation: { killedAt: 4_000 },
      cleanupHandled: true,
      cleanupCompletedAt: 4_000,
    });
    const original = structuredClone(entry);
    const controller = createLifecycleController({
      entry,
      resolveSubagentTask: () => ({ lookup: "unavailable" }),
      persistOrThrow: vi.fn(() => {
        throw new Error("registry store boom");
      }),
    });

    await expect(
      controller.completeSubagentRun({
        runId: entry.runId,
        endedAt: 4_001,
        outcome: { status: "ok" },
        reason: SUBAGENT_ENDED_REASON_COMPLETE,
        triggerCleanup: false,
      }),
    ).rejects.toThrow("registry store boom");

    expect(entry).toEqual(original);
    expect(taskExecutorMocks.completeTaskRunByRunId).toHaveBeenCalledTimes(1);
  });

  it("keeps cancellation that becomes durable during completion capture", async () => {
    const entry = createRunEntry({
      endedAt: 4_000,
      endedReason: SUBAGENT_ENDED_REASON_KILLED,
      outcome: { status: "error", error: "agent run aborted" },
      suppressAnnounceReason: "killed",
      killReconciliation: { killedAt: 4_000 },
      cleanupHandled: true,
      cleanupCompletedAt: 4_000,
    });
    let cancellationStable = false;
    let finishCapture: ((value: string) => void) | undefined;
    const captureSubagentCompletionReply = vi.fn(
      async () =>
        await new Promise<string>((resolve) => {
          finishCapture = resolve;
        }),
    );
    const controller = createLifecycleController({
      entry,
      captureSubagentCompletionReply,
      resolveSubagentTask: () => ({
        lookup: "available",
        task: {
          taskId: "task-1",
          runtime: "subagent",
          status: "cancelled",
          error: cancellationStable ? "Cancelled by operator." : SUBAGENT_KILL_TASK_ERROR,
        } as never,
      }),
    });

    const completion = controller.completeSubagentRun({
      runId: entry.runId,
      endedAt: 4_001,
      outcome: { status: "ok" },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      triggerCleanup: true,
    });
    await waitForLifecycleState(() => expect(captureSubagentCompletionReply).toHaveBeenCalled());
    expect(entry).toMatchObject({
      endedAt: 4_000,
      endedReason: SUBAGENT_ENDED_REASON_KILLED,
      killReconciliation: { killedAt: 4_000 },
    });
    expect(entry.completion).toBeUndefined();
    cancellationStable = true;
    finishCapture?.("late success");
    await completion;

    expect(entry).toMatchObject({
      endedAt: 4_000,
      endedReason: SUBAGENT_ENDED_REASON_KILLED,
      outcome: { status: "error", error: "agent run aborted" },
      suppressAnnounceReason: "killed",
      killReconciliation: { killedAt: 4_000 },
      cleanupHandled: true,
      cleanupCompletedAt: 4_000,
    });
    expect(entry.completion).toBeUndefined();
    expect(taskExecutorMocks.completeTaskRunByRunId).not.toHaveBeenCalled();
    expect(helperMocks.persistSubagentSessionTiming).not.toHaveBeenCalled();
  });

  it("keeps accepted kill cleanup live when a later completion is rejected", async () => {
    let finishSessionTiming: (() => void) | undefined;
    helperMocks.persistSubagentSessionTiming.mockImplementationOnce(
      async () =>
        await new Promise<void>((resolve) => {
          finishSessionTiming = resolve;
        }),
    );
    taskExecutorMocks.failTaskRunByRunId.mockReturnValueOnce([{}]);
    const entry = createRunEntry();
    let cancellationStable = false;
    const controller = createLifecycleController({
      entry,
      resolveSubagentTask: () => ({
        lookup: "available",
        task: {
          taskId: "task-1",
          runtime: "subagent",
          status: "cancelled",
          error: cancellationStable ? "Cancelled by operator." : SUBAGENT_KILL_TASK_ERROR,
        } as never,
      }),
    });

    const killed = controller.completeSubagentRun({
      runId: entry.runId,
      endedAt: 4_000,
      outcome: { status: "error", error: "agent run aborted" },
      reason: SUBAGENT_ENDED_REASON_KILLED,
      triggerCleanup: true,
    });
    await waitForLifecycleState(() =>
      expect(helperMocks.persistSubagentSessionTiming).toHaveBeenCalled(),
    );

    cancellationStable = true;
    await controller.completeSubagentRun({
      runId: entry.runId,
      endedAt: 4_001,
      outcome: { status: "ok" },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      triggerCleanup: true,
    });
    finishSessionTiming?.();
    await killed;

    expect(
      browserLifecycleCleanupMocks.cleanupBrowserSessionsForLifecycleEnd,
    ).toHaveBeenCalledTimes(1);
    expect(entry.killReconciliation).toEqual({ killedAt: 4_000 });
  });

  it("accepts a provider result that predates task cancellation", async () => {
    taskExecutorMocks.completeTaskRunByRunId.mockReturnValueOnce([{}]);
    const entry = createRunEntry({
      endedAt: 4_000,
      endedReason: SUBAGENT_ENDED_REASON_KILLED,
      outcome: { status: "error", error: "agent run aborted" },
      suppressAnnounceReason: "killed",
      killReconciliation: { killedAt: 4_000 },
      cleanupHandled: true,
      cleanupCompletedAt: 4_000,
    });
    const controller = createLifecycleController({
      entry,
      resolveSubagentTask: () => ({
        lookup: "available",
        task: {
          taskId: "task-1",
          runtime: "subagent",
          status: "cancelled",
          error: "Cancelled by operator.",
        } as never,
      }),
    });

    await controller.completeSubagentRun({
      runId: entry.runId,
      endedAt: 3_999,
      outcome: { status: "ok" },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      triggerCleanup: false,
    });

    expect(entry).toMatchObject({
      endedAt: 3_999,
      endedReason: SUBAGENT_ENDED_REASON_COMPLETE,
      outcome: { status: "ok" },
      cleanupHandled: false,
    });
    expect(entry.suppressAnnounceReason).toBeUndefined();
    expect(taskExecutorMocks.completeTaskRunByRunId).toHaveBeenCalled();
  });

  it("lets an explicit timeout deadline predate accepted task cancellation", async () => {
    taskExecutorMocks.failTaskRunByRunId.mockReturnValueOnce([{}]);
    const entry = createRunEntry({
      runTimeoutSeconds: 3,
      endedAt: 5_500,
      endedReason: SUBAGENT_ENDED_REASON_KILLED,
      outcome: { status: "error", error: "agent run aborted" },
      suppressAnnounceReason: "killed",
      killReconciliation: { killedAt: 5_500 },
      cleanupHandled: true,
      cleanupCompletedAt: 5_500,
    });
    const controller = createLifecycleController({
      entry,
      resolveSubagentTask: () => ({
        lookup: "available",
        task: {
          taskId: "task-1",
          runtime: "subagent",
          status: "cancelled",
          error: "Cancelled by operator.",
        } as never,
      }),
    });

    await controller.completeSubagentRun({
      runId: entry.runId,
      startedAt: 2_000,
      endedAt: 6_000,
      outcome: { status: "ok" },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      triggerCleanup: false,
    });

    expect(entry).toMatchObject({
      endedAt: 5_000,
      endedReason: SUBAGENT_ENDED_REASON_COMPLETE,
      outcome: { status: "timeout", startedAt: 2_000, endedAt: 5_000 },
    });
    expect(taskExecutorMocks.failTaskRunByRunId).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: entry.runId,
        status: "timed_out",
        endedAt: 5_000,
      }),
    );
  });

  it("retires an old live completion without touching a newer session generation", async () => {
    taskExecutorMocks.completeTaskRunByRunId.mockReturnValueOnce([{}]);
    const entry = createRunEntry({
      endedAt: 4_000,
      endedReason: SUBAGENT_ENDED_REASON_KILLED,
      outcome: { status: "error", error: "agent run aborted" },
      suppressAnnounceReason: "killed",
      killReconciliation: { killedAt: 4_000 },
      cleanupHandled: true,
      cleanupCompletedAt: 4_000,
      cleanup: "delete",
    });
    const newer = createRunEntry({
      runId: "run-2",
      createdAt: 5_000,
      startedAt: 5_000,
    });
    const runs = new Map([
      [entry.runId, entry],
      [newer.runId, newer],
    ]);
    const retireSupersededRun = vi.fn(async (runId: string) => {
      runs.delete(runId);
    });
    const emitSubagentEndedHookForRun = vi.fn(async () => {});
    const runSubagentAnnounceFlow = vi.fn<(_params: unknown) => Promise<boolean>>(async () => true);
    const controller = createLifecycleController({
      entry,
      runs,
      resolveSubagentTask: () => ({
        lookup: "available",
        task: {
          taskId: "task-before-replacement",
          runId: "run-before-replacement",
          runtime: "subagent",
          status: "cancelled",
          error: SUBAGENT_KILL_TASK_ERROR,
        } as never,
      }),
      retireSupersededRun,
      shouldEmitEndedHookForRun: () => true,
      emitSubagentEndedHookForRun,
      runSubagentAnnounceFlow,
    });

    await controller.completeSubagentRun({
      runId: entry.runId,
      endedAt: 3_999,
      outcome: { status: "ok" },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      triggerCleanup: true,
    });

    expect(retireSupersededRun).toHaveBeenCalledWith(entry.runId, entry);
    expect(runs.has(entry.runId)).toBe(false);
    expect(runs.get(newer.runId)).toBe(newer);
    expect(taskExecutorMocks.completeTaskRunByRunId).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-before-replacement" }),
    );
    expect(helperMocks.persistSubagentSessionTiming).not.toHaveBeenCalled();
    expect(lifecycleEventMocks.emitSessionLifecycleEvent).not.toHaveBeenCalled();
    expect(emitSubagentEndedHookForRun).not.toHaveBeenCalled();
    expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
    expect(
      browserLifecycleCleanupMocks.cleanupBrowserSessionsForLifecycleEnd,
    ).not.toHaveBeenCalled();
    expect(gatewayMocks.callGateway).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: "sessions.delete" }),
    );
  });

  it("keeps the superseded generation boundary through task finalization", async () => {
    taskExecutorMocks.completeTaskRunByRunId.mockReturnValueOnce([{}]);
    const marker = { killedAt: 4_000, supersededAt: 5_000 };
    const entry = createRunEntry({
      runId: "run-after-replacement",
      endedAt: 4_000,
      endedReason: SUBAGENT_ENDED_REASON_KILLED,
      outcome: { status: "error", error: "agent run aborted" },
      suppressAnnounceReason: "killed",
      killReconciliation: marker,
      cleanupHandled: true,
      cleanupCompletedAt: 4_000,
    });
    const observedSupersededAt: Array<number | undefined> = [];
    const resolveSubagentTask = vi.fn((candidate: SubagentRunRecord) => {
      observedSupersededAt.push(candidate.killReconciliation?.supersededAt);
      return {
        lookup: "available" as const,
        task: {
          taskId: "task-old",
          runId: candidate.killReconciliation?.supersededAt
            ? "run-before-replacement"
            : "run-newer-generation",
          runtime: "subagent" as const,
          childSessionKey: candidate.childSessionKey,
          status: "cancelled" as const,
          error: SUBAGENT_KILL_TASK_ERROR,
        } as never,
      };
    });
    const retireSupersededRun = vi.fn(async () => {});
    const controller = createLifecycleController({
      entry,
      resolveSubagentTask,
      retireSupersededRun,
    });

    await controller.completeSubagentRun({
      runId: entry.runId,
      endedAt: 3_999,
      outcome: { status: "ok" },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      triggerCleanup: false,
    });

    expect(resolveSubagentTask).toHaveBeenCalledTimes(2);
    expect(observedSupersededAt).toEqual([5_000, 5_000]);
    expect(taskExecutorMocks.completeTaskRunByRunId).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-before-replacement" }),
    );
    expect(taskExecutorMocks.completeTaskRunByRunId).not.toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-newer-generation" }),
    );
    expect(retireSupersededRun).toHaveBeenCalledWith(entry.runId, entry);
    expect(helperMocks.persistSubagentSessionTiming).not.toHaveBeenCalled();
    expect(lifecycleEventMocks.emitSessionLifecycleEvent).not.toHaveBeenCalled();
  });

  it("updates replacement task delivery through the durable task run id", async () => {
    const entry = createRunEntry({ runId: "run-after-replacement" });
    const controller = createLifecycleController({
      entry,
      resolveSubagentTask: () => ({
        lookup: "available",
        task: {
          taskId: "task-before-replacement",
          runId: "run-before-replacement",
          runtime: "subagent",
          childSessionKey: entry.childSessionKey,
          status: "running",
        } as never,
      }),
    });

    await controller.completeSubagentRun({
      runId: entry.runId,
      endedAt: 4_000,
      outcome: { status: "ok" },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      triggerCleanup: true,
    });

    await waitForLifecycleState(() => {
      expect(taskExecutorMocks.setDetachedTaskDeliveryStatusByRunId).toHaveBeenCalledWith({
        runId: "run-before-replacement",
        runtime: "subagent",
        sessionKey: entry.childSessionKey,
        deliveryStatus: "delivered",
        error: undefined,
      });
    });
  });

  it("finalizes the durable task owner when custom lookup is unavailable", async () => {
    taskExecutorMocks.completeTaskRunByRunId.mockReturnValueOnce([{}]);
    const entry = createRunEntry({
      runId: "run-after-opaque-replacement",
      taskRunId: "run-before-opaque-replacement",
    });
    const controller = createLifecycleController({
      entry,
      resolveSubagentTask: () => ({ lookup: "unavailable" }),
    });

    await controller.completeSubagentRun({
      runId: entry.runId,
      endedAt: 4_000,
      outcome: { status: "ok" },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      triggerCleanup: false,
    });

    expect(taskExecutorMocks.completeTaskRunByRunId).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-before-opaque-replacement",
        sessionKey: entry.childSessionKey,
      }),
    );
  });

  it("discards completion capture when a newer session generation takes ownership", async () => {
    const entry = createRunEntry();
    const runs = new Map([[entry.runId, entry]]);
    let finishCapture: ((value: string) => void) | undefined;
    const captureSubagentCompletionReply = vi.fn(
      async () =>
        await new Promise<string>((resolve) => {
          finishCapture = resolve;
        }),
    );
    const retireSupersededRun = vi.fn(async (runId: string) => {
      runs.delete(runId);
    });
    const controller = createLifecycleController({
      entry,
      runs,
      captureSubagentCompletionReply,
      retireSupersededRun,
    });

    const completion = controller.completeSubagentRun({
      runId: entry.runId,
      endedAt: 4_000,
      outcome: { status: "ok" },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      triggerCleanup: true,
    });
    await waitForLifecycleState(() => expect(captureSubagentCompletionReply).toHaveBeenCalled());
    const newer = createRunEntry({ runId: "run-2", createdAt: 5_000, startedAt: 5_000 });
    runs.set(newer.runId, newer);
    finishCapture?.("new generation result");
    await completion;

    expect(entry.completion).toMatchObject({ resultText: null });
    expect(retireSupersededRun).toHaveBeenCalledWith(entry.runId, entry);
    expect(helperMocks.persistSubagentSessionTiming).not.toHaveBeenCalled();
    expect(lifecycleEventMocks.emitSessionLifecycleEvent).not.toHaveBeenCalled();
  });

  it("rechecks session ownership inside a delayed timing write", async () => {
    const entry = createRunEntry({ generation: 1, createdAt: 1_000, startedAt: 1_000 });
    const runs = new Map([[entry.runId, entry]]);
    let releaseTiming: (() => void) | undefined;
    let timingWriteStillOwned: boolean | undefined;
    helperMocks.persistSubagentSessionTiming.mockImplementationOnce(async (...args: unknown[]) => {
      await new Promise<void>((resolve) => {
        releaseTiming = resolve;
      });
      const options = args[1] as { isCurrentGeneration?: () => boolean } | undefined;
      timingWriteStillOwned = options?.isCurrentGeneration?.();
    });
    const retireSupersededRun = vi.fn(async (runId: string) => {
      runs.delete(runId);
    });
    const controller = createLifecycleController({ entry, runs, retireSupersededRun });

    const completion = controller.completeSubagentRun({
      runId: entry.runId,
      endedAt: 4_000,
      outcome: { status: "ok" },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      triggerCleanup: true,
    });
    await waitForLifecycleState(() =>
      expect(helperMocks.persistSubagentSessionTiming).toHaveBeenCalledOnce(),
    );
    const newer = createRunEntry({
      runId: "run-same-millisecond-newer",
      generation: 2,
      createdAt: entry.createdAt,
      startedAt: entry.startedAt,
    });
    runs.set(newer.runId, newer);
    releaseTiming?.();
    await completion;

    expect(timingWriteStillOwned).toBe(false);
    expect(retireSupersededRun).toHaveBeenCalledWith(entry.runId, entry);
    expect(runs.get(newer.runId)).toBe(newer);
    expect(lifecycleEventMocks.emitSessionLifecycleEvent).not.toHaveBeenCalled();
  });

  it("finalizes restored completion text that predates capturedAt", async () => {
    const entry = createRunEntry({
      completion: { required: false, resultText: "restored final result" },
    });
    const controller = createLifecycleController({ entry });

    await controller.completeSubagentRun({
      runId: entry.runId,
      endedAt: 4_000,
      outcome: { status: "ok" },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      triggerCleanup: false,
    });

    expectFields(firstCallArg(taskExecutorMocks.completeTaskRunByRunId), {
      runId: entry.runId,
      status: undefined,
      progressSummary: "restored final result",
      terminalSummary: null,
    });
  });

  it("marks required progress-only completions blocked without failing the task", async () => {
    const entry = createRunEntry({
      expectsCompletionMessage: true,
    });

    const controller = createLifecycleController({
      entry,
      captureSubagentCompletionReply: vi.fn(async () => "I'll inspect the repo now."),
    });

    await controller.completeSubagentRun({
      runId: entry.runId,
      endedAt: 4_000,
      outcome: { status: "ok" },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      triggerCleanup: false,
    });

    expectFields(firstCallArg(taskExecutorMocks.completeTaskRunByRunId), {
      runId: entry.runId,
      runtime: "subagent",
      sessionKey: entry.childSessionKey,
      progressSummary: "I'll inspect the repo now.",
      terminalOutcome: "blocked",
      terminalSummary:
        "Required completion ended with progress-only text, not a final deliverable.",
    });
    expect(taskExecutorMocks.failTaskRunByRunId).not.toHaveBeenCalled();
  });

  it("marks missing required completions blocked while preserving real final reports", async () => {
    const missingEntry = createRunEntry({
      expectsCompletionMessage: true,
    });
    await createLifecycleController({
      entry: missingEntry,
      captureSubagentCompletionReply: vi.fn(async () => undefined),
    }).completeSubagentRun({
      runId: missingEntry.runId,
      endedAt: 4_000,
      outcome: { status: "ok" },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      triggerCleanup: false,
    });

    expectFields(firstCallArg(taskExecutorMocks.completeTaskRunByRunId), {
      runId: missingEntry.runId,
      terminalOutcome: "blocked",
      terminalSummary: "Required completion did not produce a final deliverable.",
    });

    taskExecutorMocks.completeTaskRunByRunId.mockClear();
    const finalEntry = createRunEntry({
      runId: "run-final",
      expectsCompletionMessage: true,
    });
    await createLifecycleController({
      entry: finalEntry,
      captureSubagentCompletionReply: vi.fn(
        async () => "Fixed the crash and verified the regression tests pass.",
      ),
    }).completeSubagentRun({
      runId: finalEntry.runId,
      endedAt: 5_000,
      outcome: { status: "ok" },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      triggerCleanup: false,
    });

    const finalArg = firstCallArg(taskExecutorMocks.completeTaskRunByRunId);
    expectFields(finalArg, {
      runId: finalEntry.runId,
      runtime: "subagent",
      sessionKey: finalEntry.childSessionKey,
      progressSummary: "Fixed the crash and verified the regression tests pass.",
      terminalSummary: null,
    });
    expect(finalArg.terminalOutcome).toBeUndefined();
  });

  it("keeps required completions successful when final output follows progress text", async () => {
    const entry = createRunEntry({
      expectsCompletionMessage: true,
    });

    await createLifecycleController({
      entry,
      captureSubagentCompletionReply: vi.fn(
        async () => "I'll inspect the repo now. The crash is a missing null check in src/foo.ts.",
      ),
    }).completeSubagentRun({
      runId: entry.runId,
      endedAt: 4_000,
      outcome: { status: "ok" },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      triggerCleanup: false,
    });

    const finalArg = firstCallArg(taskExecutorMocks.completeTaskRunByRunId);
    expectFields(finalArg, {
      runId: entry.runId,
      runtime: "subagent",
      sessionKey: entry.childSessionKey,
      progressSummary:
        "I'll inspect the repo now. The crash is a missing null check in src/foo.ts.",
      terminalSummary: null,
    });
    expect(finalArg.terminalOutcome).toBeUndefined();
  });

  it("keeps required completions successful when final output follows a separator", async () => {
    const entry = createRunEntry({
      expectsCompletionMessage: true,
    });

    await createLifecycleController({
      entry,
      captureSubagentCompletionReply: vi.fn(
        async () => "I'll inspect the repo now - the crash is a missing null check in src/foo.ts.",
      ),
    }).completeSubagentRun({
      runId: entry.runId,
      endedAt: 4_000,
      outcome: { status: "ok" },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      triggerCleanup: false,
    });

    const finalArg = firstCallArg(taskExecutorMocks.completeTaskRunByRunId);
    expectFields(finalArg, {
      runId: entry.runId,
      runtime: "subagent",
      sessionKey: entry.childSessionKey,
      progressSummary:
        "I'll inspect the repo now - the crash is a missing null check in src/foo.ts.",
      terminalSummary: null,
    });
    expect(finalArg.terminalOutcome).toBeUndefined();
  });

  it("keeps required completions blocked when progress text only adds follow-up planning", async () => {
    const entry = createRunEntry({
      expectsCompletionMessage: true,
    });

    await createLifecycleController({
      entry,
      captureSubagentCompletionReply: vi.fn(
        async () => "I'll inspect the repo now. Then I'll run tests and report back.",
      ),
    }).completeSubagentRun({
      runId: entry.runId,
      endedAt: 4_000,
      outcome: { status: "ok" },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      triggerCleanup: false,
    });

    expectFields(firstCallArg(taskExecutorMocks.completeTaskRunByRunId), {
      runId: entry.runId,
      runtime: "subagent",
      sessionKey: entry.childSessionKey,
      progressSummary: "I'll inspect the repo now. Then I'll run tests and report back.",
      terminalOutcome: "blocked",
      terminalSummary:
        "Required completion ended with progress-only text, not a final deliverable.",
    });
  });

  it("does not reject cleanup give-up when task delivery status update throws", async () => {
    const persistOrThrow = vi.fn();
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
      persistOrThrow,
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

    expect(warn).toHaveBeenCalledTimes(1);
    const [warning, warningFields] = firstCall(warn);
    expect(warning).toBe("failed to update subagent background task delivery state");
    expectFields(warningFields, {
      error: { name: "Error", message: "delivery state boom" },
      runId: "***",
      childSessionKey: "agent:main:…",
      deliveryStatus: "failed",
    });
    expect(entry.cleanupCompletedAt).toBeTypeOf("number");
    expect(persistOrThrow).toHaveBeenCalled();
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

    const browserCleanupArg = firstCallArg(
      browserLifecycleCleanupMocks.cleanupBrowserSessionsForLifecycleEnd,
    );
    expectFields(browserCleanupArg, { sessionKeys: [entry.childSessionKey] });
    expect(browserCleanupArg.onWarn).toBeTypeOf("function");
    expectFields(firstCallArg(runSubagentAnnounceFlow), {
      childSessionKey: entry.childSessionKey,
    });
  });

  it("records completion announcement timestamps from transcript delivery", async () => {
    const persist = vi.fn();
    const entry = createRunEntry({
      expectsCompletionMessage: true,
    });
    const delivery: SubagentAnnounceDeliveryResult = {
      delivered: true,
      path: "steered",
      enqueuedAt: 4_100,
      deliveredAt: 12_300,
    };
    const runSubagentAnnounceFlow: LifecycleControllerParams["runSubagentAnnounceFlow"] = vi.fn(
      async (announceParams) => {
        announceParams.onDeliveryResult?.(delivery);
        return true;
      },
    );

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

    await waitForLifecycleState(() => expect(entry.delivery?.announcedAt).toBe(12_300));
    expect(entry.delivery?.enqueuedAt).toBe(4_100);
    expect(entry.delivery?.deliveredAt).toBe(12_300);
    expect(entry.delivery?.lastDropReason).toBeUndefined();
    expectFields(firstCallArg(taskExecutorMocks.setDetachedTaskDeliveryStatusByRunId), {
      runId: entry.runId,
      deliveryStatus: "delivered",
    });
  });

  it("keeps a late superseded-delivery retirement root-admitted", async () => {
    const entry = createRunEntry({ expectsCompletionMessage: true, generation: 1 });
    const runs = new Map([[entry.runId, entry]]);
    let onDeliveryResult: ((delivery: SubagentAnnounceDeliveryResult) => void) | undefined;
    const runSubagentAnnounceFlow: LifecycleControllerParams["runSubagentAnnounceFlow"] = vi.fn(
      async (announceParams) => {
        onDeliveryResult = announceParams.onDeliveryResult;
        return true;
      },
    );
    let releaseRetirement = () => {};
    const retirementPending = new Promise<void>((resolve) => {
      releaseRetirement = resolve;
    });
    const retireSupersededRun = vi.fn(async () => {
      await retirementPending;
    });
    const controller = createLifecycleController({
      entry,
      runs,
      retireSupersededRun,
      runSubagentAnnounceFlow,
    });

    await controller.completeSubagentRun({
      runId: entry.runId,
      endedAt: 4_000,
      outcome: { status: "ok" },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      triggerCleanup: true,
    });
    await waitForLifecycleState(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
    const newer = createRunEntry({
      runId: "run-2",
      childSessionKey: entry.childSessionKey,
      generation: 2,
    });
    runs.set(newer.runId, newer);

    onDeliveryResult?.({ delivered: false, path: "none" });

    await waitForLifecycleState(() =>
      expect(retireSupersededRun).toHaveBeenCalledWith(entry.runId, entry),
    );
    expect(getActiveGatewayRootWorkCount()).toBe(1);
    releaseRetirement();
    await waitForLifecycleState(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
  });

  it("finalizes terminal visible-send failures without scheduling completion retry", async () => {
    const persist = vi.fn();
    const entry = createRunEntry({
      endedAt: 4_000,
      expectsCompletionMessage: true,
      retainAttachmentsOnKeep: true,
    });
    const runSubagentAnnounceFlow: LifecycleControllerParams["runSubagentAnnounceFlow"] = vi.fn(
      async (announceParams) => {
        announceParams.onDeliveryResult?.({
          delivered: false,
          path: "direct",
          error: "prompt lock failed after visible send",
          terminal: true,
        });
        return true;
      },
    );

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

    await waitForLifecycleState(() => expect(entry.cleanupCompletedAt).toBeTypeOf("number"));
    expect(entry.delivery?.status).toBe("delivered");
    expect(entry.delivery?.lastError).toBeUndefined();
    expect(entry.delivery?.payload).toBeUndefined();
    expect(entry.delivery?.suspendedAt).toBeUndefined();
    expect(entry.delivery?.suspendedReason).toBeUndefined();
    expect(runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
    expectFields(firstCallArg(taskExecutorMocks.setDetachedTaskDeliveryStatusByRunId), {
      runId: entry.runId,
      deliveryStatus: "delivered",
    });
  });

  it("persists collector completion and skips announce delivery", async () => {
    const persist = vi.fn();
    const entry = createRunEntry({
      expectsCompletionMessage: false,
      retainAttachmentsOnKeep: true,
      collect: true,
      groupId: "swarm:test",
    });
    const runSubagentAnnounceFlow = vi.fn(async () => true);

    const controller = createLifecycleController({
      entry,
      persist,
      runSubagentAnnounceFlow,
      captureSubagentCompletionReply: vi.fn(async () => "raw collector result"),
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

    const browserCleanupArg = firstCallArg(
      browserLifecycleCleanupMocks.cleanupBrowserSessionsForLifecycleEnd,
    );
    expectFields(browserCleanupArg, { sessionKeys: [entry.childSessionKey] });
    expect(browserCleanupArg.onWarn).toBeTypeOf("function");
    expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
    expect(hasDeliveredTaskStatusUpdate(entry.runId)).toBe(false);
    await waitForLifecycleState(() => expect(entry.cleanupCompletedAt).toBeTypeOf("number"));
    expect(entry.completion?.resultText).toBe("raw collector result");
    expect(entry.collectorCompletion).toEqual({ status: "done" });
    expect(entry.delivery?.status).toBe("not_required");
    expect(entry.delivery?.announcedAt).toBeUndefined();
  });

  it("deletes collector session resources while retaining the waitable record", async () => {
    const entry = createRunEntry({
      cleanup: "delete",
      expectsCompletionMessage: false,
      collect: true,
      groupId: "swarm:test",
    });
    const runs = new Map([[entry.runId, entry]]);
    const notifyContextEngineSubagentEnded = vi.fn(async () => {});
    const controller = createLifecycleController({
      entry,
      runs,
      notifyContextEngineSubagentEnded,
      captureSubagentCompletionReply: vi.fn(async () => "raw collector result"),
    });

    await controller.completeSubagentRun({
      runId: entry.runId,
      endedAt: 4_000,
      outcome: { status: "ok" },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      triggerCleanup: true,
    });

    await waitForLifecycleState(() => expect(entry.cleanupCompletedAt).toBeTypeOf("number"));
    await waitForLifecycleState(() =>
      expect(gatewayMocks.callGateway).toHaveBeenCalledWith({
        method: "sessions.delete",
        params: {
          key: entry.childSessionKey,
          deleteTranscript: true,
          emitLifecycleHooks: false,
        },
        timeoutMs: 10_000,
      }),
    );
    await waitForLifecycleState(() =>
      expect(notifyContextEngineSubagentEnded).toHaveBeenCalledWith({
        childSessionKey: entry.childSessionKey,
        reason: "deleted",
        agentDir: entry.agentDir,
        workspaceDir: entry.workspaceDir,
      }),
    );
    expect(helperMocks.safeRemoveAttachmentsDir).toHaveBeenCalledWith(entry);
    expect(runs.get(entry.runId)).toBe(entry);
    expect(entry.collectorCompletion).toEqual({ status: "done" });
  });

  it("treats accepted structured output as success for a tool-only collector turn", async () => {
    const structured = { answer: "yes" };
    const entry = createRunEntry({
      expectsCompletionMessage: false,
      collect: true,
      outputSchema: { type: "object" },
    });
    const structuredOutput = createStructuredOutputTool({
      runId: entry.runId,
      schema: { type: "object" },
    });
    await structuredOutput.execute("tool-call", { result: structured });
    const controller = createLifecycleController({
      entry,
      captureSubagentCompletionReply: vi.fn(async () => ""),
    });

    await controller.completeSubagentRun({
      runId: entry.runId,
      endedAt: 4_000,
      outcome: { status: "error", error: "completed" },
      reason: SUBAGENT_ENDED_REASON_ERROR,
      triggerCleanup: true,
    });

    await waitForLifecycleState(() => expect(entry.cleanupCompletedAt).toBeTypeOf("number"));
    expect(entry.collectorCompletion).toEqual({ status: "done", structured });
    expect(entry.outcome).toMatchObject({ status: "ok" });
    expect(entry.execution).toMatchObject({
      status: "terminal",
      outcome: expect.objectContaining({ status: "ok" }),
    });
    expect(entry.endedReason).toBe(SUBAGENT_ENDED_REASON_COMPLETE);
  });

  it("preserves a real failure after structured output was accepted", async () => {
    const structured = { answer: "yes" };
    const entry = createRunEntry({
      expectsCompletionMessage: false,
      collect: true,
      outputSchema: { type: "object" },
      structuredOutput: { structured, invalidAttempts: 0 },
    });
    const controller = createLifecycleController({ entry });

    await controller.completeSubagentRun({
      runId: entry.runId,
      endedAt: 4_000,
      outcome: { status: "error", error: "provider failed after tool output" },
      reason: SUBAGENT_ENDED_REASON_ERROR,
      triggerCleanup: true,
    });

    await waitForLifecycleState(() => expect(entry.cleanupCompletedAt).toBeTypeOf("number"));
    expect(entry.collectorCompletion).toEqual({ status: "failed", structured });
  });

  it("marks a successful collector with invalid structured output failed", async () => {
    const entry = createRunEntry({
      expectsCompletionMessage: false,
      collect: true,
      outputSchema: { type: "object" },
    });
    const controller = createLifecycleController({
      entry,
      captureSubagentCompletionReply: vi.fn(async () => "raw collector result"),
    });

    await controller.completeSubagentRun({
      runId: entry.runId,
      endedAt: 4_000,
      outcome: { status: "ok" },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      triggerCleanup: true,
    });

    await waitForLifecycleState(() => expect(entry.cleanupCompletedAt).toBeTypeOf("number"));
    expect(entry.collectorCompletion).toEqual({
      status: "failed",
      schemaError: "structured_output was not called",
    });
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

    await waitForLifecycleState(() =>
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
    expect(hasDeliveredTaskStatusUpdate(entry.runId)).toBe(false);
    await waitForLifecycleState(() => expect(runs.has(entry.runId)).toBe(false));
    expect(entry.delivery?.announcedAt).toBeUndefined();
  });

  it("retires a stale cleanup before deleting a newer session generation", async () => {
    const entry = createRunEntry({
      cleanup: "delete",
      expectsCompletionMessage: false,
      spawnMode: "session",
      generation: 1,
    });
    const runs = new Map([[entry.runId, entry]]);
    const retireSupersededRun = vi.fn(async (runId: string) => {
      runs.delete(runId);
    });
    const controller = createLifecycleController({ entry, runs, retireSupersededRun });

    expect(controller.startSubagentAnnounceCleanupFlow(entry.runId, entry)).toBe(true);
    const newer = createRunEntry({
      runId: "run-2",
      generation: 2,
      createdAt: entry.createdAt,
      startedAt: entry.startedAt,
    });
    runs.set(newer.runId, newer);

    await waitForLifecycleState(() =>
      expect(retireSupersededRun).toHaveBeenCalledWith(entry.runId, entry),
    );
    expect(runs.get(newer.runId)).toBe(newer);
    expect(gatewayMocks.callGateway).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: "sessions.delete" }),
    );
  });

  it("keeps provisional killed sessions across resumed cleanup", async () => {
    const entry = createRunEntry({
      cleanup: "delete",
      endedAt: 4_000,
      endedReason: SUBAGENT_ENDED_REASON_KILLED,
      outcome: { status: "error", error: "agent run aborted" },
      suppressAnnounceReason: "killed",
      killReconciliation: { killedAt: 4_000 },
      archiveAtMs: 304_000,
      expectsCompletionMessage: false,
    });
    const runs = new Map([[entry.runId, entry]]);
    const controller = createLifecycleController({ entry, runs });

    expect(controller.startSubagentAnnounceCleanupFlow(entry.runId, entry)).toBe(false);

    expect(entry.cleanupCompletedAt).toBeUndefined();
    expect(runs.get(entry.runId)).toBe(entry);
    expect(controller.startSubagentAnnounceCleanupFlow(entry.runId, entry)).toBe(false);
    expect(gatewayMocks.callGateway).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: "sessions.delete" }),
    );
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

    const retireArg = findCallArg(
      bundleMcpRuntimeMocks.retireSessionMcpRuntimeForSessionKey,
      (arg) => arg.reason === "subagent-run-cleanup",
    );
    expectFields(retireArg, {
      sessionKey: entry.childSessionKey,
      reason: "subagent-run-cleanup",
      preserveActiveLeases: true,
    });
    expect(retireArg.onError).toBeTypeOf("function");
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
    expectFields(firstCallArg(taskExecutorMocks.failTaskRunByRunId), { status: "timed_out" });
    expectFields(firstCallArg(runSubagentAnnounceFlow), {
      startedAt: 2_000,
      endedAt: 4_250,
      outcome: enrichedOutcome,
    });
    expect(persist).toHaveBeenCalled();
  });

  it("persists timing when a preexisting outcome matches without timing", async () => {
    const persistOrThrow = vi.fn();
    const entry = createRunEntry({
      startedAt: 2_000,
      outcome: { status: "ok" },
      expectsCompletionMessage: false,
    });

    const controller = createLifecycleController({ entry, persistOrThrow });

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
    expect(persistOrThrow).toHaveBeenCalled();
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
    const persistOrThrow = vi.fn();
    const captureSubagentCompletionReply = vi.fn(async () => "stale assistant text");
    const entry = createRunEntry({
      expectsCompletionMessage: true,
    });

    const controller = createLifecycleController({
      entry,
      persistOrThrow,
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
    expect(entry.completion?.resultText).toBeNull();
    expectFields(firstCallArg(taskExecutorMocks.failTaskRunByRunId), {
      status: "failed",
      error: "All models failed (2): timeout",
      progressSummary: undefined,
    });
    expect(persistOrThrow).toHaveBeenCalled();
  });

  it("does not re-run announce flow after completion was already delivered", async () => {
    const entry = createRunEntry({
      delivery: { status: "delivered", announcedAt: 3_500, deliveredAt: 3_500 },
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
    expect(entry.cleanupCompletedAt).toBeGreaterThanOrEqual(4_000);
    expect(notifyContextEngineSubagentEnded).toHaveBeenCalledWith({
      childSessionKey: entry.childSessionKey,
      reason: "completed",
      workspaceDir: entry.workspaceDir,
    });
    expect(persist).toHaveBeenCalled();
  });

  it("emits ended hook while retrying cleanup after completion was already delivered", async () => {
    const entry = createRunEntry({
      delivery: { status: "delivered", announcedAt: 3_500, deliveredAt: 3_500 },
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
      isCurrent: expect.any(Function),
    });
  });

  it("suppresses a deferred ended hook after a newer session generation registers", async () => {
    const entry = createRunEntry({
      delivery: { status: "delivered", announcedAt: 3_500, deliveredAt: 3_500 },
      endedAt: 4_000,
      expectsCompletionMessage: true,
      generation: 1,
    });
    const runs = new Map([[entry.runId, entry]]);
    let finishPluginLoad: (() => void) | undefined;
    const emitted = vi.fn();
    const emitSubagentEndedHookForRun = vi.fn(async (params: { isCurrent?: () => boolean }) => {
      await new Promise<void>((resolve) => {
        finishPluginLoad = resolve;
      });
      if (params.isCurrent?.() !== false) {
        emitted();
      }
    });
    const controller = createLifecycleController({
      entry,
      runs,
      shouldEmitEndedHookForRun: () => true,
      emitSubagentEndedHookForRun,
    });

    const completion = controller.completeSubagentRun({
      runId: entry.runId,
      endedAt: 4_000,
      outcome: { status: "ok" },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      triggerCleanup: true,
    });
    await waitForLifecycleState(() => expect(emitSubagentEndedHookForRun).toHaveBeenCalled());
    runs.set(
      "run-2",
      createRunEntry({
        runId: "run-2",
        createdAt: 5_000,
        startedAt: 5_000,
        generation: 2,
      }),
    );
    finishPluginLoad?.();
    await completion;

    expect(emitted).not.toHaveBeenCalled();
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

    expect(entry.delivery?.announcedAt).toBeUndefined();

    await controller.finalizeResumedAnnounceGiveUp({
      runId: entry.runId,
      entry,
      reason: "retry-limit",
    });

    expect(entry.cleanupCompletedAt).toBeTypeOf("number");
    expect(Number.isNaN(entry.cleanupCompletedAt)).toBe(false);
  });

  it("suspends successful keep-mode final delivery instead of completing cleanup on retry exhaustion", async () => {
    const persistOrThrow = vi.fn();
    const entry = createRunEntry({
      endedAt: 4_000,
      endedReason: SUBAGENT_ENDED_REASON_COMPLETE,
      expectsCompletionMessage: true,
      completion: { required: true, resultText: "final answer" },
      delivery: { status: "pending", lastError: "gateway request timeout for agent" },
      outcome: { status: "ok" },
      retainAttachmentsOnKeep: true,
    });

    const controller = createLifecycleController({
      entry,
      persistOrThrow,
      captureSubagentCompletionReply: vi.fn(async () => undefined),
    });

    await controller.finalizeResumedAnnounceGiveUp({
      runId: entry.runId,
      entry,
      reason: "retry-limit",
    });

    expect(entry.delivery?.status).toBe("suspended");
    expect(entry.delivery?.payload).toMatchObject({
      requesterSessionKey: entry.requesterSessionKey,
      childSessionKey: entry.childSessionKey,
      childRunId: entry.runId,
      frozenResultText: "final answer",
    });
    expect(entry.delivery?.suspendedAt).toBeTypeOf("number");
    expect(entry.delivery?.suspendedReason).toBe("retry-limit");
    expect(entry.cleanupHandled).toBe(false);
    expect(entry.cleanupCompletedAt).toBeUndefined();
    expect(helperMocks.safeRemoveAttachmentsDir).not.toHaveBeenCalled();
    expectFields(firstCallArg(taskExecutorMocks.setDetachedTaskDeliveryStatusByRunId), {
      runId: entry.runId,
      runtime: "subagent",
      sessionKey: entry.childSessionKey,
      deliveryStatus: "failed",
      error: "gateway request timeout for agent",
    });
    expectFields(firstCallArg(taskExecutorMocks.completeTaskRunByRunId), {
      runId: entry.runId,
      runtime: "subagent",
      sessionKey: entry.childSessionKey,
      progressSummary: "final answer",
      terminalOutcome: "blocked",
      terminalSummary:
        "Required completion delivery failed before reaching the requester: gateway request timeout for agent.",
    });
    expect(persistOrThrow).toHaveBeenCalled();
  });

  it.each([
    {
      name: "timeout",
      endedReason: SUBAGENT_ENDED_REASON_COMPLETE,
      outcome: { status: "timeout" as const },
    },
    {
      name: "error",
      endedReason: SUBAGENT_ENDED_REASON_ERROR,
      outcome: { status: "error" as const, error: "child failed" },
    },
    {
      name: "killed",
      endedReason: SUBAGENT_ENDED_REASON_KILLED,
      outcome: undefined,
    },
  ])(
    "keeps $name completion cleanup terminal on retry exhaustion",
    async ({ endedReason, outcome }) => {
      const persistOrThrow = vi.fn();
      const entry = createRunEntry({
        endedAt: 4_000,
        endedReason,
        expectsCompletionMessage: true,
        delivery: { status: "pending", lastError: "gateway request timeout for agent" },
        outcome,
        retainAttachmentsOnKeep: true,
      });
      const runs = new Map([[entry.runId, entry]]);

      const controller = createLifecycleController({
        entry,
        runs,
        persistOrThrow,
        captureSubagentCompletionReply: vi.fn(async () => undefined),
      });

      await controller.finalizeResumedAnnounceGiveUp({
        runId: entry.runId,
        entry,
        reason: "retry-limit",
      });

      expect(entry.delivery?.payload).toBeUndefined();
      expect(entry.delivery?.suspendedAt).toBeUndefined();
      expect(entry.delivery?.suspendedReason).toBeUndefined();
      if (endedReason === SUBAGENT_ENDED_REASON_KILLED) {
        expect(runs.has(entry.runId)).toBe(false);
      } else {
        expect(entry.cleanupCompletedAt).toBeTypeOf("number");
      }
      expect(persistOrThrow).toHaveBeenCalled();
    },
  );

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

    expect(warn).toHaveBeenCalledTimes(1);
    const [warning, warningFields] = firstCall(warn);
    expect(warning).toBe("failed to update subagent background task delivery state");
    expectFields(warningFields, {
      error: { name: "Error", message: "delivery status boom" },
      deliveryStatus: "delivered",
    });
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
            phase: "direct-primary" | "steer-fallback";
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
              phase: "steer-fallback",
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

    expectFields(firstCallArg(taskExecutorMocks.setDetachedTaskDeliveryStatusByRunId), {
      runId: entry.runId,
      runtime: "subagent",
      sessionKey: entry.childSessionKey,
      deliveryStatus: "failed",
      error:
        "UNAVAILABLE: requester wake failed; direct-primary: UNAVAILABLE: requester wake failed",
    });
    expect(entry.delivery?.lastError).toBe(
      "UNAVAILABLE: requester wake failed; direct-primary: UNAVAILABLE: requester wake failed",
    );
    expect(entry.delivery?.status).toBe("suspended");
    expect(entry.delivery?.payload).toMatchObject({
      requesterSessionKey: entry.requesterSessionKey,
      childSessionKey: entry.childSessionKey,
      childRunId: entry.runId,
    });
    expect(entry.delivery?.suspendedAt).toBeTypeOf("number");
    expect(entry.delivery?.suspendedReason).toBe("retry-limit");
    expect(entry.cleanupCompletedAt).toBeUndefined();
    expectFields(
      findCallArg(
        taskExecutorMocks.completeTaskRunByRunId,
        (arg) => arg.terminalOutcome === "blocked",
      ),
      {
        runId: entry.runId,
        runtime: "subagent",
        sessionKey: entry.childSessionKey,
        terminalOutcome: "blocked",
        terminalSummary:
          "Required completion delivery failed before reaching the requester: UNAVAILABLE: requester wake failed; direct-primary: UNAVAILABLE: requester wake failed.",
      },
    );
    expect(persist).toHaveBeenCalled();
  });

  it("credits only current-run requester delivery mirrors before retrying NO_REPLY", async () => {
    const entry = await runNoReplyMirrorScenario({ timestamp: 12_345 });

    await waitForLifecycleState(() => expect(entry.cleanupCompletedAt).toBeTypeOf("number"));
    expect(gatewayMocks.callGateway).toHaveBeenCalledWith({
      method: "chat.history",
      params: { sessionKey: entry.requesterSessionKey, limit: 25, maxChars: 128 * 1024 },
      timeoutMs: 5_000,
    });
    expect(entry.delivery?.deliveredAt).toBe(12_345);
    expect(entry.delivery?.announcedAt).toBe(12_345);
    expect(entry.delivery?.lastError).toBeUndefined();
    expect(entry.delivery?.payload).toBeUndefined();
    expect(entry.delivery?.attemptCount).toBeUndefined();
    expect(hasDeliveredTaskStatusUpdate(entry.runId)).toBe(true);
    expect(helperMocks.logAnnounceGiveUp).not.toHaveBeenCalled();

    vi.clearAllMocks();
    gatewayMocks.callGateway.mockResolvedValue({});
    const longMirrorEntry = await runNoReplyMirrorScenario({
      timestamp: 12_345,
      text: "long completion reply ".repeat(500),
    });

    await waitForLifecycleState(() =>
      expect(longMirrorEntry.cleanupCompletedAt).toBeTypeOf("number"),
    );
    expect(longMirrorEntry.delivery?.deliveredAt).toBe(12_345);
    expect(gatewayMocks.callGateway).toHaveBeenCalledWith({
      method: "chat.history",
      params: { sessionKey: longMirrorEntry.requesterSessionKey, limit: 25, maxChars: 128 * 1024 },
      timeoutMs: 5_000,
    });

    vi.clearAllMocks();
    gatewayMocks.callGateway.mockResolvedValue({});
    const messageToolAnnounceEntry = await runNoReplyMirrorScenario({
      timestamp: 12_345,
      idempotencyKeyForEntry: (candidate) =>
        `${buildExpectedAnnounceIdempotencyKey(candidate)}:message-tool:internal-source-reply:0`,
    });

    await waitForLifecycleState(() =>
      expect(messageToolAnnounceEntry.cleanupCompletedAt).toBeTypeOf("number"),
    );
    expect(messageToolAnnounceEntry.delivery?.deliveredAt).toBe(12_345);

    vi.clearAllMocks();
    gatewayMocks.callGateway.mockResolvedValue({});
    const childRunMirrorEntry = await runNoReplyMirrorScenario({
      timestamp: 12_345,
      idempotencyKeyForEntry: (candidate) => `${candidate.runId}:message-tool:1`,
    });

    await waitForLifecycleState(() =>
      expect(childRunMirrorEntry.cleanupCompletedAt).toBeTypeOf("number"),
    );
    expect(childRunMirrorEntry.delivery?.deliveredAt).toBe(12_345);

    vi.clearAllMocks();
    taskExecutorMocks.setDetachedTaskDeliveryStatusByRunId.mockReset();
    gatewayMocks.callGateway.mockResolvedValue({});
    const staleEntry = await runNoReplyMirrorScenario({ timestamp: 1_999 });

    await waitForLifecycleState(() =>
      expect(staleEntry.delivery?.suspendedAt).toBeTypeOf("number"),
    );
    expect(staleEntry.delivery?.deliveredAt).toBeUndefined();
    expect(staleEntry.delivery?.announcedAt).toBeUndefined();
    expect(staleEntry.delivery?.lastError).toBe("completion agent did not produce a visible reply");
    expect(hasDeliveredTaskStatusUpdate(staleEntry.runId)).toBe(false);
    expectFields(firstCallArg(taskExecutorMocks.setDetachedTaskDeliveryStatusByRunId), {
      runId: staleEntry.runId,
      runtime: "subagent",
      sessionKey: staleEntry.childSessionKey,
      deliveryStatus: "failed",
      error: "completion agent did not produce a visible reply",
    });
    expect(helperMocks.logAnnounceGiveUp).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: staleEntry.runId,
        requesterSessionKey: staleEntry.requesterSessionKey,
      }),
      "retry-limit",
    );

    vi.clearAllMocks();
    taskExecutorMocks.setDetachedTaskDeliveryStatusByRunId.mockReset();
    gatewayMocks.callGateway.mockResolvedValue({});
    const sameWindowSiblingEntry = await runNoReplyMirrorScenario({
      timestamp: 12_345,
      idempotencyKey: `${buildAnnounceIdempotencyKey(
        buildAnnounceIdFromChildRun({
          childSessionKey: "agent:main:subagent:sibling",
          childRunId: "run-sibling",
        }),
      )}:internal-source-reply:0`,
    });

    await waitForLifecycleState(() =>
      expect(sameWindowSiblingEntry.delivery?.suspendedAt).toBeTypeOf("number"),
    );
    expect(sameWindowSiblingEntry.delivery?.deliveredAt).toBeUndefined();
    expect(sameWindowSiblingEntry.delivery?.announcedAt).toBeUndefined();
    expect(sameWindowSiblingEntry.delivery?.lastError).toBe(
      "completion agent did not produce a visible reply",
    );
    expect(hasDeliveredTaskStatusUpdate(sameWindowSiblingEntry.runId)).toBe(false);
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

  it("dedupes browser cleanup when two callers complete the same run in parallel", async () => {
    // registerSubagentRun fires both an in-process listener (phase='end') and a
    // gateway waitForSubagentCompletion RPC; in embedded mode both resolve to
    // the same runId and call completeSubagentRun. Without a per-entry dispatch
    // guard, cleanupBrowserSessionsForLifecycleEnd fires once per caller,
    // duplicating browser driver tab-close IPC.
    const entry = createRunEntry({
      expectsCompletionMessage: false,
    });
    const runSubagentAnnounceFlow = vi.fn(async () => true);

    const controller = createLifecycleController({
      entry,
      runSubagentAnnounceFlow,
    });

    const completeParams = {
      runId: entry.runId,
      endedAt: 4_000,
      outcome: { status: "ok" as const },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      triggerCleanup: true,
    };

    await Promise.all([
      controller.completeSubagentRun(completeParams),
      controller.completeSubagentRun(completeParams),
    ]);

    expect(
      browserLifecycleCleanupMocks.cleanupBrowserSessionsForLifecycleEnd,
    ).toHaveBeenCalledTimes(1);
    expect(entry.browserCleanupDispatchedAt).toBeTypeOf("number");
  });

  it("drains the retire + announce tail for a duplicate completion held behind a slow first browser cleanup", async () => {
    // The dispatch flag dedupes only the browser tab-close IPC. A duplicate
    // completion caller must still reach retireRunModeBundleMcpRuntime and
    // startSubagentAnnounceCleanupFlow while the first caller's cleanup
    // promise is still pending, so a slow browser driver cannot strand
    // completion delivery behind it.
    const entry = createRunEntry({
      expectsCompletionMessage: true,
    });
    const runSubagentAnnounceFlow = vi.fn(async () => true);
    const controller = createLifecycleController({ entry, runSubagentAnnounceFlow });

    let releaseFirstCleanup: (() => void) | undefined;
    let firstCleanupEntered: (() => void) | undefined;
    const firstCleanupEnteredPromise = new Promise<void>((resolve) => {
      firstCleanupEntered = resolve;
    });
    browserLifecycleCleanupMocks.cleanupBrowserSessionsForLifecycleEnd.mockImplementationOnce(
      () => {
        firstCleanupEntered?.();
        return new Promise<void>((resolve) => {
          releaseFirstCleanup = resolve;
        });
      },
    );

    const completeParams = {
      runId: entry.runId,
      endedAt: 4_000,
      outcome: { status: "ok" as const },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      triggerCleanup: true,
    };

    // First caller takes the dispatch flag and parks inside the cleanup wrapper.
    const firstCompletion = controller.completeSubagentRun(completeParams);
    await firstCleanupEnteredPromise;

    // Second caller observes the flag set, skips the cleanup wrapper, and must
    // still drain the retire + announce tail without waiting on the first
    // caller's still-pending cleanup.
    await controller.completeSubagentRun({ ...completeParams, endedAt: 3_999 });

    expect(
      browserLifecycleCleanupMocks.cleanupBrowserSessionsForLifecycleEnd,
    ).toHaveBeenCalledTimes(1);
    expect(entry.endedAt).toBe(4_000);
    expect(bundleMcpRuntimeMocks.retireSessionMcpRuntimeForSessionKey).toHaveBeenCalled();
    expect(runSubagentAnnounceFlow).toHaveBeenCalled();

    // Release the held first cleanup so the first caller can settle too.
    releaseFirstCleanup?.();
    await expect(firstCompletion).resolves.toBeUndefined();
  });

  it("does not invalidate an active timeout tail when a published timeout is observed again", async () => {
    const entry = createRunEntry({
      expectsCompletionMessage: true,
      runTimeoutSeconds: 2,
    });
    let releaseTiming: (() => void) | undefined;
    helperMocks.persistSubagentSessionTiming.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseTiming = resolve;
        }),
    );
    const runSubagentAnnounceFlow = vi.fn<(_params: unknown) => Promise<boolean>>(async () => true);
    const controller = createLifecycleController({ entry, runSubagentAnnounceFlow });
    const completeParams = {
      runId: entry.runId,
      endedAt: 4_000,
      outcome: { status: "timeout" as const },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      triggerCleanup: true,
    };

    const firstCompletion = controller.completeSubagentRun(completeParams);
    await waitForLifecycleState(() =>
      expect(helperMocks.persistSubagentSessionTiming).toHaveBeenCalledOnce(),
    );
    entry.endedHookEmittedAt = 4_000;

    await controller.completeSubagentRun(completeParams);
    releaseTiming?.();
    await firstCompletion;

    expect(runSubagentAnnounceFlow).toHaveBeenCalledOnce();
    expect(runSubagentAnnounceFlow.mock.calls[0]?.[0]).toMatchObject({
      outcome: { status: "timeout" },
    });
  });
});

describe("requester settle wake trigger", () => {
  beforeEach(() => {
    helperMocks.safeRemoveAttachmentsDir.mockClear();
    helperMocks.logAnnounceGiveUp.mockClear();
    taskExecutorMocks.setDetachedTaskDeliveryStatusByRunId.mockClear();
  });

  it("fires the settle wake from keep-cleanup bookkeeping", () => {
    const entry = createRunEntry({ endedAt: 4_000 });
    const settleWake = vi.fn(async () => false);
    const controller = createLifecycleController({
      entry,
      maybeWakeRequesterAfterAllChildrenSettled: settleWake,
    });

    controller.completeCleanupBookkeeping({
      runId: entry.runId,
      entry,
      cleanup: "keep",
      completedAt: 5_000,
    });

    expect(settleWake).toHaveBeenCalledTimes(1);
    expect(settleWake).toHaveBeenCalledWith({
      requesterSessionKey: "agent:main:main",
      requesterOrigin: undefined,
      settledEntry: entry,
      transitionBatch: expect.any(Function),
      completeBatch: expect.any(Function),
    });
    expect(entry.requesterSettleWake).toEqual({ status: "pending", attemptCount: 0 });
  });

  it("retains delete-cleanup rows until the settle wake resolves", () => {
    const entry = createRunEntry({ endedAt: 4_000, cleanup: "delete" });
    const runs = new Map([[entry.runId, entry]]);
    const settleWake = vi.fn(async () => false);
    const controller = createLifecycleController({
      entry,
      runs,
      maybeWakeRequesterAfterAllChildrenSettled: settleWake,
    });

    controller.completeCleanupBookkeeping({
      runId: entry.runId,
      entry,
      cleanup: "delete",
      completedAt: 5_000,
    });

    expect(runs.has(entry.runId)).toBe(true);
    expect(entry.requesterSettleWake).toEqual({
      status: "pending",
      attemptCount: 0,
      retireAfterSettle: true,
    });
    expect(settleWake).toHaveBeenCalledTimes(1);
    expect(settleWake).toHaveBeenCalledWith(
      expect.objectContaining({
        requesterSessionKey: "agent:main:main",
        settledEntry: entry,
      }),
    );
    const completeBatch = firstCallArg(settleWake).completeBatch as (
      runIds: readonly string[],
    ) => void;
    completeBatch([entry.runId]);
    expect(runs.has(entry.runId)).toBe(false);
  });

  it("schedules every remaining requester wave after one batch resolves", async () => {
    const first = createRunEntry({ runId: "run-first", endedAt: 4_000 });
    const later = createRunEntry({ runId: "run-later", endedAt: 8_000 });
    later.requesterSettleWake = { status: "pending", attemptCount: 0 };
    const runs = new Map([
      [first.runId, first],
      [later.runId, later],
    ]);
    const settleWake = vi.fn(
      async (
        params: Parameters<
          LifecycleControllerParams["maybeWakeRequesterAfterAllChildrenSettled"]
        >[0],
      ) => {
        if (params.settledEntry.runId === first.runId) {
          params.completeBatch([first.runId]);
        }
        return false;
      },
    );
    const controller = createLifecycleController({
      entry: first,
      runs,
      maybeWakeRequesterAfterAllChildrenSettled: settleWake,
    });

    controller.completeCleanupBookkeeping({
      runId: first.runId,
      entry: first,
      cleanup: "keep",
      completedAt: 5_000,
    });

    await waitForLifecycleState(() => expect(settleWake).toHaveBeenCalledTimes(2));
    expect(settleWake.mock.calls.map(([params]) => params.settledEntry.runId)).toEqual([
      "run-first",
      "run-later",
    ]);
    expect(later.requesterSettleWake).toEqual({ status: "pending", attemptCount: 0 });
  });

  it("preserves a yielded batch re-armed during an earlier successful wake", async () => {
    const entry = createRunEntry({
      requesterTurnRunId: "run-requester",
      requesterTurnYielded: true,
      endedAt: 4_000,
      expectsCompletionMessage: true,
      delivery: { status: "delivered" },
    });
    const settleWake = vi.fn(
      async (
        params: Parameters<
          LifecycleControllerParams["maybeWakeRequesterAfterAllChildrenSettled"]
        >[0],
      ) => {
        const firstInvocation = settleWake.mock.calls.length === 1;
        if (firstInvocation) {
          controller.settleRequesterTurnAfterSessionSpawns({
            requesterSessionKey: entry.requesterSessionKey,
            requesterTurnRunId: "run-requester",
            requesterYielded: true,
            acceptedSessionSpawns: [{ runId: entry.runId, childSessionKey: entry.childSessionKey }],
          });
          params.transitionBatch([entry.runId], {
            status: "dispatching",
            attemptCount: 1,
            batchRunIds: [entry.runId],
          });
        }
        params.completeBatch(
          [entry.runId],
          firstInvocation ? undefined : entry.requesterSettleWake?.rearmGeneration,
        );
        return firstInvocation;
      },
    );
    const controller = createLifecycleController({
      entry,
      maybeWakeRequesterAfterAllChildrenSettled: settleWake,
    });

    controller.completeCleanupBookkeeping({
      runId: entry.runId,
      entry,
      cleanup: "keep",
      completedAt: 5_000,
    });

    await waitForLifecycleState(() => expect(settleWake).toHaveBeenCalledTimes(2));
    expect(entry.requesterSettleWake).toBeUndefined();
  });

  it("retains a delete-mode child after no-wake until its requester turn settles", async () => {
    const entry = createRunEntry({
      requesterTurnRunId: "run-requester",
      cleanup: "delete",
      expectsCompletionMessage: true,
      completion: { required: true, resultText: "delete-mode findings" },
    });
    const runs = new Map([[entry.runId, entry]]);
    const settleWake = vi.fn(
      async (
        params: Parameters<
          LifecycleControllerParams["maybeWakeRequesterAfterAllChildrenSettled"]
        >[0],
      ) => {
        params.completeBatch([entry.runId]);
        return false;
      },
    );
    const runSubagentAnnounceFlow = vi.fn(async () => true);
    const controller = createLifecycleController({
      entry,
      runs,
      maybeWakeRequesterAfterAllChildrenSettled: settleWake,
      runSubagentAnnounceFlow,
    });

    await controller.completeSubagentRun({
      runId: entry.runId,
      endedAt: 4_000,
      outcome: { status: "ok" },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      triggerCleanup: true,
    });
    await waitForLifecycleState(() => expect(settleWake).toHaveBeenCalledTimes(1));

    // The no-wake decision completed, but the spawning turn can still yield.
    expect(entry.completion?.resultText).toBe("delete-mode findings");
    expect(runs.has(entry.runId)).toBe(true);
    expect(entry.requesterSettleWake).toBeUndefined();
    expect(entry.retireAfterRequesterTurn).toBe(true);
    expect(settleWake).toHaveBeenCalledWith(
      expect.objectContaining({
        settledEntry: expect.objectContaining({
          runId: entry.runId,
          completion: expect.objectContaining({ resultText: "delete-mode findings" }),
        }),
      }),
    );
  });

  it("retains a reconciled killed row until the settle wake resolves", () => {
    const entry = createRunEntry({
      endedAt: 4_000,
      endedReason: "subagent-killed",
    });
    const runs = new Map([[entry.runId, entry]]);
    const settleWake = vi.fn(async () => false);
    const controller = createLifecycleController({
      entry,
      runs,
      maybeWakeRequesterAfterAllChildrenSettled: settleWake,
    });

    controller.completeCleanupBookkeeping({
      runId: entry.runId,
      entry,
      cleanup: "keep",
      completedAt: 5_000,
    });

    expect(runs.has(entry.runId)).toBe(true);
    expect(entry.requesterSettleWake?.retireAfterSettle).toBe(true);
    expect(settleWake).toHaveBeenCalledTimes(1);
    const completeBatch = firstCallArg(settleWake).completeBatch as (
      runIds: readonly string[],
    ) => void;
    completeBatch([entry.runId]);
    expect(runs.has(entry.runId)).toBe(false);
  });

  it("skips the settle wake when the caller opts out (suspended-delivery discard)", () => {
    const entry = createRunEntry({ endedAt: 4_000 });
    const settleWake = vi.fn(async () => false);
    const controller = createLifecycleController({
      entry,
      maybeWakeRequesterAfterAllChildrenSettled: settleWake,
    });

    controller.completeCleanupBookkeeping({
      runId: entry.runId,
      entry,
      cleanup: "keep",
      completedAt: 5_000,
      skipRequesterSettleWake: true,
    });

    expect(settleWake).not.toHaveBeenCalled();
  });

  it("does not settle or schedule a provisional kill", () => {
    const entry = createRunEntry({
      endedAt: 4_000,
      endedReason: SUBAGENT_ENDED_REASON_KILLED,
      killReconciliation: { killedAt: 4_000 },
    });
    const settleWake = vi.fn(async () => false);
    const controller = createLifecycleController({
      entry,
      maybeWakeRequesterAfterAllChildrenSettled: settleWake,
    });

    controller.completeCleanupBookkeeping({
      runId: entry.runId,
      entry,
      cleanup: "keep",
      completedAt: 5_000,
      provisionalKill: true,
    });

    expect(entry.cleanupCompletedAt).toBeUndefined();
    expect(entry.requesterSettleWake).toBeUndefined();
    expect(settleWake).not.toHaveBeenCalled();
  });

  it("re-arms a deferred frozen batch at its persisted retry deadline", async () => {
    const entry = createRunEntry({ endedAt: 4_000 });
    let invocation = 0;
    const settleWake = vi.fn(
      async (
        params: Parameters<
          LifecycleControllerParams["maybeWakeRequesterAfterAllChildrenSettled"]
        >[0],
      ) => {
        invocation += 1;
        if (invocation === 1) {
          params.transitionBatch([entry.runId], {
            status: "pending",
            attemptCount: 0,
            nextAttemptAt: 30_000,
            batchRunIds: [entry.runId],
          });
        } else {
          params.completeBatch([entry.runId]);
        }
        return false;
      },
    );
    const controller = createLifecycleController({
      entry,
      maybeWakeRequesterAfterAllChildrenSettled: settleWake,
    });

    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      controller.completeCleanupBookkeeping({
        runId: entry.runId,
        entry,
        cleanup: "keep",
        completedAt: 5_000,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(settleWake).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(29_999);
      expect(settleWake).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(settleWake).toHaveBeenCalledTimes(2);
      expect(entry.requesterSettleWake).toBeUndefined();
    } finally {
      controller.clearScheduledResumeTimers();
      vi.useRealTimers();
    }
  });

  it("does not re-arm coalesced batch rows whose retry deadline already passed", async () => {
    const state = {
      status: "pending" as const,
      attemptCount: 1,
      nextAttemptAt: 5_000,
      batchRunIds: ["run-a", "run-b"],
    };
    const first = createRunEntry({
      runId: "run-a",
      endedAt: 4_000,
      requesterSettleWake: { ...state },
    });
    const second = createRunEntry({
      runId: "run-b",
      endedAt: 4_000,
      requesterSettleWake: { ...state },
    });
    const runs = new Map([
      [first.runId, first],
      [second.runId, second],
    ]);
    const settleWake = vi.fn(async () => false);
    const controller = createLifecycleController({
      entry: first,
      runs,
      maybeWakeRequesterAfterAllChildrenSettled: settleWake,
    });

    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    try {
      controller.resumeRequesterSettleWake(first.runId, first);
      controller.resumeRequesterSettleWake(second.runId, second);
      await vi.advanceTimersByTimeAsync(0);

      expect(settleWake).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      controller.clearScheduledResumeTimers();
      vi.useRealTimers();
    }
  });

  it("fires the settle wake when an announce give-up suspends the delivery", async () => {
    // Suspension leaves cleanup incomplete and nothing retries it, so it is
    // the child's terminal settle for requester-drain purposes.
    const entry = createRunEntry({
      endedAt: 4_000,
      expectsCompletionMessage: true,
      cleanup: "keep",
      endedReason: SUBAGENT_ENDED_REASON_COMPLETE,
      outcome: { status: "ok" },
    });
    const settleWake = vi.fn(async () => false);
    const controller = createLifecycleController({
      entry,
      maybeWakeRequesterAfterAllChildrenSettled: settleWake,
    });

    await controller.finalizeResumedAnnounceGiveUp({
      runId: entry.runId,
      entry,
      reason: "retry-limit",
    });

    expect(entry.delivery?.status).toBe("suspended");
    expect(entry.cleanupCompletedAt).toBeUndefined();
    expect(entry.requesterSettleWake).toEqual({ status: "pending", attemptCount: 0 });
    expect(settleWake).toHaveBeenCalledTimes(1);
    expect(settleWake).toHaveBeenCalledWith(
      expect.objectContaining({
        requesterSessionKey: "agent:main:main",
        settledEntry: entry,
      }),
    );
  });

  it("fires the settle wake exactly once for a non-suspending announce give-up", async () => {
    const entry = createRunEntry({
      endedAt: 4_000,
      expectsCompletionMessage: true,
      cleanup: "keep",
      endedReason: SUBAGENT_ENDED_REASON_COMPLETE,
      outcome: { status: "timeout" },
    });
    const settleWake = vi.fn(async () => false);
    const controller = createLifecycleController({
      entry,
      maybeWakeRequesterAfterAllChildrenSettled: settleWake,
    });

    await controller.finalizeResumedAnnounceGiveUp({
      runId: entry.runId,
      entry,
      reason: "retry-limit",
    });

    expect(entry.delivery?.status).toBe("failed");
    expect(entry.cleanupCompletedAt).toBeTypeOf("number");
    expect(settleWake).toHaveBeenCalledTimes(1);
  });

  it("keeps settle bookkeeping resilient to a rejecting wake", () => {
    const entry = createRunEntry({ endedAt: 4_000 });
    const warn = vi.fn();
    const settleWake = vi.fn(async () => {
      throw new Error("wake exploded");
    });
    const controller = createLifecycleController({
      entry,
      warn,
      maybeWakeRequesterAfterAllChildrenSettled: settleWake,
    });

    expect(() =>
      controller.completeCleanupBookkeeping({
        runId: entry.runId,
        entry,
        cleanup: "keep",
        completedAt: 5_000,
      }),
    ).not.toThrow();

    return waitForLifecycleState(() => {
      expect(warn).toHaveBeenCalledWith("requester settle wake failed", expect.anything());
    });
  });

  it("holds the settle wake as tracked root work so restart drain waits for its turn", async () => {
    resetGatewayWorkAdmission();
    try {
      const entry = createRunEntry({ endedAt: 4_000 });
      let releaseWake: (() => void) | undefined;
      const settleWake = vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            releaseWake = () => resolve(false);
          }),
      );
      const controller = createLifecycleController({
        entry,
        maybeWakeRequesterAfterAllChildrenSettled: settleWake,
      });

      // Schedule from inside an admitted cleanup parent that finishes before
      // the wake settles — the quiescence window: the wake must reserve its
      // own root before the parent releases.
      await runWithGatewayIndependentRootWorkAdmission(async () => {
        controller.completeCleanupBookkeeping({
          runId: entry.runId,
          entry,
          cleanup: "keep",
          completedAt: 5_000,
        });
      });
      expect(settleWake).toHaveBeenCalledTimes(1);
      await waitForLifecycleState(() => expect(getActiveGatewayRootWorkCount()).toBe(1));

      // A restart drain arriving between scheduling and the wake's gateway
      // turn must wait for the wake instead of reporting quiescence.
      markGatewayRestartDraining();
      expect((await waitForActiveGatewayRootWork(25)).drained).toBe(false);

      releaseWake?.();
      await waitForLifecycleState(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
      expect((await waitForActiveGatewayRootWork(1_000)).drained).toBe(true);
    } finally {
      resetGatewayWorkAdmission();
    }
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
