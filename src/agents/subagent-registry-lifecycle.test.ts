import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CallGatewayOptions } from "../gateway/call.js";
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
import type { SubagentRunRecord } from "./subagent-registry.types.js";

type LifecycleControllerParams = Parameters<typeof createSubagentRegistryLifecycleController>[0];

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
    persist: vi.fn(),
    clearPendingLifecycleError: vi.fn(),
    countPendingDescendantRuns: () => 0,
    suppressAnnounceForSteerRestart: () => false,
    shouldEmitEndedHookForRun: () => false,
    emitSubagentEndedHookForRun: vi.fn(async () => {}),
    notifyContextEngineSubagentEnded: vi.fn(async () => {}),
    resumeSubagentRun: vi.fn(),
    callGateway: async <T = Record<string, unknown>>(opts: CallGatewayOptions): Promise<T> =>
      (await gatewayMocks.callGateway(opts)) as T,
    captureSubagentCompletionReply: vi.fn(async () => "final completion reply"),
    runSubagentAnnounceFlow: vi.fn(async () => true),
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

    expect(warn).toHaveBeenCalledTimes(1);
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

    await vi.waitFor(() => expect(entry.delivery?.announcedAt).toBe(12_300));
    expect(entry.delivery?.enqueuedAt).toBe(4_100);
    expect(entry.delivery?.deliveredAt).toBe(12_300);
    expect(entry.delivery?.lastDropReason).toBeUndefined();
    expectFields(firstCallArg(taskExecutorMocks.setDetachedTaskDeliveryStatusByRunId), {
      runId: entry.runId,
      deliveryStatus: "delivered",
    });
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

    const browserCleanupArg = firstCallArg(
      browserLifecycleCleanupMocks.cleanupBrowserSessionsForLifecycleEnd,
    );
    expectFields(browserCleanupArg, { sessionKeys: [entry.childSessionKey] });
    expect(browserCleanupArg.onWarn).toBeTypeOf("function");
    expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
    expect(hasDeliveredTaskStatusUpdate(entry.runId)).toBe(false);
    await vi.waitFor(() => expect(entry.cleanupCompletedAt).toBeTypeOf("number"));
    expect(entry.delivery?.announcedAt).toBeUndefined();
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
    expect(hasDeliveredTaskStatusUpdate(entry.runId)).toBe(false);
    await vi.waitFor(() => expect(runs.has(entry.runId)).toBe(false));
    expect(entry.delivery?.announcedAt).toBeUndefined();
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
    expect(entry.completion?.resultText).toBeNull();
    expectFields(firstCallArg(taskExecutorMocks.failTaskRunByRunId), {
      status: "failed",
      error: "All models failed (2): timeout",
      progressSummary: undefined,
    });
    expect(persist).toHaveBeenCalled();
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
    const persist = vi.fn();
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
      persist,
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
    expect(persist).toHaveBeenCalled();
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
      const persist = vi.fn();
      const entry = createRunEntry({
        endedAt: 4_000,
        endedReason,
        expectsCompletionMessage: true,
        delivery: { status: "pending", lastError: "gateway request timeout for agent" },
        outcome,
        retainAttachmentsOnKeep: true,
      });

      const controller = createLifecycleController({
        entry,
        persist,
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
      expect(entry.cleanupCompletedAt).toBeTypeOf("number");
      expect(persist).toHaveBeenCalled();
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

    await vi.waitFor(() => expect(entry.cleanupCompletedAt).toBeTypeOf("number"));
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

    await vi.waitFor(() => expect(longMirrorEntry.cleanupCompletedAt).toBeTypeOf("number"));
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

    await vi.waitFor(() =>
      expect(messageToolAnnounceEntry.cleanupCompletedAt).toBeTypeOf("number"),
    );
    expect(messageToolAnnounceEntry.delivery?.deliveredAt).toBe(12_345);

    vi.clearAllMocks();
    gatewayMocks.callGateway.mockResolvedValue({});
    const childRunMirrorEntry = await runNoReplyMirrorScenario({
      timestamp: 12_345,
      idempotencyKeyForEntry: (candidate) => `${candidate.runId}:message-tool:1`,
    });

    await vi.waitFor(() => expect(childRunMirrorEntry.cleanupCompletedAt).toBeTypeOf("number"));
    expect(childRunMirrorEntry.delivery?.deliveredAt).toBe(12_345);

    vi.clearAllMocks();
    taskExecutorMocks.setDetachedTaskDeliveryStatusByRunId.mockReset();
    gatewayMocks.callGateway.mockResolvedValue({});
    const staleEntry = await runNoReplyMirrorScenario({ timestamp: 1_999 });

    await vi.waitFor(() => expect(staleEntry.delivery?.suspendedAt).toBeTypeOf("number"));
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

    await vi.waitFor(() =>
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
});
