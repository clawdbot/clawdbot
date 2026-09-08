import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveSessionStorePathForScope } from "../../../config/sessions/session-store-path.js";
import {
  runWithOwnedSessionTranscriptWrite,
  withOwnedSessionTranscriptWrites,
} from "../../../config/sessions/transcript-write-context.js";
import type { CallGatewayOptions } from "../../../gateway/call.js";
import { getAgentEventLifecycleGeneration } from "../../../infra/agent-events.js";
// Subagent registry lifecycle tests cover completion, cleanup, announce retry,
// detached task status, and resource retirement around child-run endings.
import { bindGatewayContextResolver } from "../../../plugins/runtime/gateway-request-scope.js";
import {
  getActiveGatewayRootWorkCount,
  getActiveGatewayRootWorkHolders,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  runWithGatewayIndependentRootWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../../../process/gateway-work-admission.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { SUBAGENT_KILL_TASK_ERROR } from "../../../tasks/detached-task-runtime-contract.js";
import {
  buildAnnounceIdFromChildRun,
  buildAnnounceIdempotencyKey,
} from "../../announce-idempotency.js";
import { createStructuredOutputTool } from "../../tools/structured-output-tool.js";
import {
  runSubagentAnnounceDispatch,
  type SubagentAnnounceDeliveryResult,
} from "../announce/subagent-announce-dispatch.js";
import {
  SUBAGENT_ENDED_REASON_COMPLETE,
  SUBAGENT_ENDED_REASON_ERROR,
  SUBAGENT_ENDED_REASON_KILLED,
} from "./subagent-lifecycle-events.js";
import { shouldSuppressSubagentRecoverySessionEffects } from "./subagent-recovery-state.js";
import { loadPendingFinalDeliveryPayload } from "./subagent-registry-lifecycle-delivery.js";
import {
  SubagentLifecycleController,
  type SubagentLifecycleOptions,
} from "./subagent-registry-lifecycle.js";
import { markSubagentRunPausedAfterYield } from "./subagent-registry-run-manager.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

type LifecycleControllerParams = SubagentLifecycleOptions;
type LifecycleController = SubagentLifecycleController;
type RequesterSettleWakeParams = Parameters<
  LifecycleControllerParams["maybeWakeRequesterAfterAllChildrenSettled"]
>[0];
type SubagentCompletionParams = Parameters<LifecycleController["completeSubagentRun"]>[0];
type AnnounceFlowOutcome = Awaited<
  ReturnType<LifecycleControllerParams["runSubagentAnnounceFlow"]>
>;
type RestartRecoveryReceipt = NonNullable<SubagentRunRecord["execution"]["restartRecovery"]>;

describe("subagent recovery session-effect ownership", () => {
  it("does not treat an ordinary run generation as a recovery suppression receipt", () => {
    const entry = createRunEntry({
      execution: {
        status: "terminal",
        endedAt: 4_000,
        lifecycleGeneration: "retired-generation",
      },
    });

    expect(shouldSuppressSubagentRecoverySessionEffects(entry)).toBe(false);
  });

  it("suppresses retired recovery receipts and legacy kill intents", () => {
    const recoveryEntry = createRunEntry({
      execution: {
        status: "terminal",
        endedAt: 4_000,
        restartRecovery: makeRestartRecoveryReceipt({
          lifecycleGeneration: "retired-generation",
        }),
      },
    });
    const legacyKillEntry = createRunEntry({
      killIntent: {
        requestedAt: 4_000,
        reason: "legacy kill",
        sessionId: "session-id",
      },
    });

    expect(shouldSuppressSubagentRecoverySessionEffects(recoveryEntry)).toBe(true);
    expect(shouldSuppressSubagentRecoverySessionEffects(legacyKillEntry)).toBe(true);
  });
});

function waitForLifecycleState<T>(assertion: () => T | Promise<T>): Promise<T> {
  return vi.waitFor(assertion, { interval: 1 });
}

const taskExecutorMocks = vi.hoisted(() => ({
  completeTaskRunByRunId: vi.fn(),
  failTaskRunByRunId: vi.fn(),
  setDetachedTaskDeliveryStatusByRunId: vi.fn(),
}));

const completionDeliveryMocks = vi.hoisted(() => ({
  blockSubagentCompletionDelivery: vi.fn(),
}));

function mockBlockedCompletionDeliveryOwner(): void {
  completionDeliveryMocks.blockSubagentCompletionDelivery.mockImplementation(
    ({
      subagent,
      reason,
      suspendedReason,
      disposition,
    }: {
      subagent: SubagentRunRecord;
      reason: string;
      suspendedReason?: "expiry" | "permanent_failure";
      disposition?: NonNullable<SubagentRunRecord["delivery"]>["disposition"];
    }) => {
      subagent.delivery ??= { status: "pending" };
      subagent.delivery.lastError = reason;
      subagent.delivery.deliveredAt = undefined;
      subagent.delivery.announcedAt = undefined;
      if (suspendedReason) {
        subagent.delivery.status = "suspended";
        subagent.delivery.suspendedReason = suspendedReason;
        subagent.delivery.suspendedAt = Date.now();
        subagent.cleanupHandled = false;
        subagent.requesterSettleWake ??= { status: "pending", attemptCount: 0 };
      } else {
        subagent.delivery.status = "failed";
        subagent.delivery.disposition = disposition ?? subagent.delivery.disposition;
        subagent.suppressCompletionDelivery = true;
      }
      return true;
    },
  );
}

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

const internalSessionEffectsMocks = vi.hoisted(() => ({
  removeInternalSessionEffectsSession: vi.fn(async () => {}),
}));

const sessionReconciliationMocks = vi.hoisted(() => ({
  loadSubagentSessionEntry: vi.fn(),
}));

vi.mock("../../../tasks/detached-task-runtime.js", () => ({
  completeTaskRunByRunId: taskExecutorMocks.completeTaskRunByRunId,
  failTaskRunByRunId: taskExecutorMocks.failTaskRunByRunId,
  setDetachedTaskDeliveryStatusByRunId: taskExecutorMocks.setDetachedTaskDeliveryStatusByRunId,
}));

vi.mock("../completion/subagent-completion-admission.store.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../completion/subagent-completion-admission.store.js")
  >()),
  blockSubagentCompletionDelivery: completionDeliveryMocks.blockSubagentCompletionDelivery,
}));

vi.mock("../../../sessions/session-lifecycle-events.js", () => ({
  emitSessionLifecycleEvent: lifecycleEventMocks.emitSessionLifecycleEvent,
}));

vi.mock("../../../browser-lifecycle-cleanup.js", () => ({
  cleanupBrowserSessionsForLifecycleEnd:
    browserLifecycleCleanupMocks.cleanupBrowserSessionsForLifecycleEnd,
}));

vi.mock("../../agent-bundle-mcp-tools.js", () => ({
  retireSessionMcpRuntimeForSessionKey: bundleMcpRuntimeMocks.retireSessionMcpRuntimeForSessionKey,
}));

vi.mock("../../internal-session-effects.js", () => ({
  removeInternalSessionEffectsSession:
    internalSessionEffectsMocks.removeInternalSessionEffectsSession,
}));

vi.mock("./subagent-session-reconciliation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./subagent-session-reconciliation.js")>()),
  loadSubagentSessionEntry: sessionReconciliationMocks.loadSubagentSessionEntry,
}));

vi.mock("../../../runtime.js", () => ({
  defaultRuntime: {
    log: runtimeMocks.log,
  },
}));

vi.mock("../../../utils/delivery-context.shared.js", () => ({
  normalizeDeliveryContext: (origin: unknown) => origin ?? "agent",
}));

vi.mock("../announce/subagent-announce.js", () => ({
  captureSubagentCompletionReply: vi.fn(async () => undefined),
  runSubagentAnnounceFlow: vi.fn(async () => "retryable" as const),
}));

vi.mock("./subagent-registry-cleanup.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./subagent-registry-cleanup.js")>()),
  resolveCleanupCompletionReason: () => SUBAGENT_ENDED_REASON_COMPLETE,
  resolveDeferredCleanupDecision: () => ({ kind: "give-up", reason: "expiry" }),
}));

vi.mock("./subagent-registry-helpers.js", () => ({
  ANNOUNCE_COMPLETION_HARD_EXPIRY_MS: 30 * 60_000,
  ANNOUNCE_EXPIRY_MS: 5 * 60_000,
  MIN_ANNOUNCE_RETRY_DELAY_MS: 1_000,
  PROVISIONAL_KILL_RECONCILIATION_MS: 5 * 60_000,
  capFrozenResultText: (text: string) => text.trim(),
  logAnnounceGiveUp: helperMocks.logAnnounceGiveUp,
  persistSubagentSessionTiming: helperMocks.persistSubagentSessionTiming,
  resolveAnnounceRetryDelayMs: (retryCount: number) =>
    Math.min(1_000 * 2 ** Math.max(0, retryCount - 1), 8_000),
  safeRemoveAttachmentsDir: helperMocks.safeRemoveAttachmentsDir,
  updateSubagentArchiveAtMs: () => false,
}));

type RunEntryOverrides = Omit<Partial<SubagentRunRecord>, "execution"> & {
  execution?: SubagentRunRecord["execution"];
  startedAt?: number;
  endedAt?: number;
  outcome?: SubagentRunRecord["execution"]["outcome"];
};
type RunModeCleanupEntryOverrides = Omit<RunEntryOverrides, "execution"> & {
  execution?: Partial<SubagentRunRecord["execution"]>;
};

function createRunEntry(overrides: RunEntryOverrides = {}): SubagentRunRecord {
  const { startedAt = 2_000, endedAt, outcome, execution, ...recordOverrides } = overrides;
  return {
    runId: "run-1",
    childSessionKey: "agent:main:subagent:child",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "finish the task",
    cleanup: "keep",
    createdAt: 1_000,
    ...recordOverrides,
    execution: execution
      ? { startedAt, ...execution }
      : {
          status: endedAt !== undefined || outcome !== undefined ? "terminal" : "running",
          startedAt,
          ...(endedAt === undefined ? {} : { endedAt }),
          ...(outcome === undefined ? {} : { outcome }),
        },
  };
}

describe("pending final delivery payload", () => {
  it("uses the authoritative completion reply after a retry payload was captured", () => {
    const staleTerminalReply = { disposition: "visible", text: "child result" } as const;
    const completionTerminalReply = {
      disposition: "visible",
      text: "child result",
      modelRouteChange: "Model route changed: requested/model → actual/model.",
    } as const;
    const entry = createRunEntry({
      delivery: {
        status: "pending",
        payload: {
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          childSessionKey: "agent:main:subagent:child",
          childRunId: "run-1",
          task: "finish the task",
          terminalReply: staleTerminalReply,
        },
      },
      completion: { required: true, terminalReply: completionTerminalReply },
    });

    expect(loadPendingFinalDeliveryPayload(entry).terminalReply).toEqual(completionTerminalReply);
  });
});

function makeProvisionalKilledRunEntry(overrides: RunEntryOverrides = {}): SubagentRunRecord {
  return createRunEntry({
    endedAt: 4_000,
    endedReason: SUBAGENT_ENDED_REASON_KILLED,
    outcome: { status: "error", error: "agent run aborted" },
    suppressAnnounceReason: "killed",
    killReconciliation: { killedAt: 4_000 },
    cleanupHandled: true,
    cleanupCompletedAt: 4_000,
    ...overrides,
  });
}

function makeRestartRecoveryReceipt(
  overrides: Partial<RestartRecoveryReceipt> = {},
): RestartRecoveryReceipt {
  return {
    sessionId: "session-id",
    sessionMarker: "session-id:1",
    idempotencyKey: "recovery-run",
    phase: "accepted",
    ...overrides,
  };
}

function makeRunModeCleanupEntry(
  transcriptSessionId: string,
  overrides: RunModeCleanupEntryOverrides = {},
): SubagentRunRecord {
  const { execution, ...recordOverrides } = overrides;
  const sessionKeySuffix = transcriptSessionId.replace(/^internal-/u, "");
  return createRunEntry({
    cleanup: "delete",
    spawnMode: "run",
    ...recordOverrides,
    execution: {
      status: "terminal",
      endedAt: 4_000,
      transcriptTarget: {
        agentId: "main",
        sessionId: transcriptSessionId,
        sessionKey: `agent:main:internal:${sessionKeySuffix}`,
        storePath: "/tmp/openclaw-agent.sqlite",
      },
      ...execution,
    },
  });
}

function makeSubagentCompletion(
  entry: SubagentRunRecord,
  overrides: Omit<Partial<SubagentCompletionParams>, "runId"> = {},
): SubagentCompletionParams {
  return {
    runId: entry.runId,
    endedAt: 4_000,
    outcome: { status: "ok" },
    reason: SUBAGENT_ENDED_REASON_COMPLETE,
    triggerCleanup: false,
    ...overrides,
  };
}

function makeKilledSubagentCompletion(
  entry: SubagentRunRecord,
  overrides: Omit<Partial<SubagentCompletionParams>, "runId"> = {},
): SubagentCompletionParams {
  return makeSubagentCompletion(entry, {
    outcome: { status: "error", error: "agent run aborted" },
    reason: SUBAGENT_ENDED_REASON_KILLED,
    ...overrides,
  });
}

function makeInterruptedSubagentCompletion(
  entry: SubagentRunRecord,
  overrides: Omit<Partial<SubagentCompletionParams>, "runId"> = {},
): SubagentCompletionParams {
  return makeSubagentCompletion(entry, {
    outcome: { status: "error", error: "restart interrupted run" },
    reason: SUBAGENT_ENDED_REASON_ERROR,
    recoverInterrupted: true,
    ...overrides,
  });
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
} & Partial<SubagentLifecycleOptions>) {
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
    cleanupBrowserSessionsForLifecycleEnd:
      browserLifecycleCleanupMocks.cleanupBrowserSessionsForLifecycleEnd,
    runSubagentAnnounceFlow: vi.fn(async () => "delivered" as const),
    maybeWakeRequesterAfterAllChildrenSettled: vi.fn(
      async (wakeParams: {
        settledEntry: SubagentRunRecord;
        completeBatch(batch: readonly SubagentRunRecord[]): void;
      }) => {
        wakeParams.completeBatch([wakeParams.settledEntry]);
        return false;
      },
    ),
    warn: vi.fn(),
  };
  Object.assign(params, overrides);
  return new SubagentLifecycleController(params);
}

function completeRun(
  controller: LifecycleController,
  entry: SubagentRunRecord,
  overrides: Omit<Partial<SubagentCompletionParams>, "runId"> = {},
) {
  return controller.completeSubagentRun(makeSubagentCompletion(entry, overrides));
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
      return "retryable" as const;
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
  }).completeSubagentRun(
    makeSubagentCompletion(entry, {
      triggerCleanup: true,
      terminalReply: { disposition: "visible", text },
    }),
  );
  return entry;
}

describe("subagent registry lifecycle hardening", () => {
  beforeEach(() => {
    resetGatewayWorkAdmission();
    vi.clearAllMocks();
    taskExecutorMocks.completeTaskRunByRunId.mockReset();
    taskExecutorMocks.failTaskRunByRunId.mockReset();
    taskExecutorMocks.setDetachedTaskDeliveryStatusByRunId.mockReset();
    mockBlockedCompletionDeliveryOwner();
    gatewayMocks.callGateway.mockReset();
    gatewayMocks.callGateway.mockResolvedValue({});
    browserLifecycleCleanupMocks.cleanupBrowserSessionsForLifecycleEnd.mockClear();
    bundleMcpRuntimeMocks.retireSessionMcpRuntimeForSessionKey.mockClear();
    bundleMcpRuntimeMocks.retireSessionMcpRuntimeForSessionKey.mockResolvedValue(true);
    internalSessionEffectsMocks.removeInternalSessionEffectsSession.mockClear();
    sessionReconciliationMocks.loadSubagentSessionEntry.mockReset().mockReturnValue({
      sessionId: "child-session-id",
      lifecycleRevision: "child-lifecycle-revision",
    });
  });

  it("fails a required successful completion without producer reply evidence", async () => {
    const entry = createRunEntry({ expectsCompletionMessage: true });
    const captureSubagentCompletionReply = vi.fn(async () => "stale transcript reply");
    const controller = createLifecycleController({ entry, captureSubagentCompletionReply });

    await completeRun(controller, entry, { terminalReply: undefined });

    expect(entry.endedReason).toBe(SUBAGENT_ENDED_REASON_ERROR);
    expect(entry.execution.outcome).toMatchObject({
      status: "error",
      error: "subagent run ended before producing a final reply",
    });
    expect(entry.completion?.resultText).toBeNull();
    expect(captureSubagentCompletionReply).not.toHaveBeenCalled();
  });

  it("keeps reply-optional successful completion compatible without evidence", async () => {
    const entry = createRunEntry({ expectsCompletionMessage: false });
    const captureSubagentCompletionReply = vi.fn(async () => "legacy transcript reply");
    const controller = createLifecycleController({ entry, captureSubagentCompletionReply });

    await completeRun(controller, entry, { terminalReply: undefined });

    expect(entry.endedReason).toBe(SUBAGENT_ENDED_REASON_COMPLETE);
    expect(entry.execution.outcome).toMatchObject({ status: "ok" });
    expect(entry.completion?.resultText).toBe("legacy transcript reply");
  });

  it.each([
    {
      terminalReply: { disposition: "visible", text: "authoritative final" } as const,
      resultText: "authoritative final",
    },
    {
      terminalReply: { disposition: "silent" } as const,
      resultText: "NO_REPLY",
    },
  ])(
    "persists $terminalReply.disposition producer evidence without transcript inference",
    async ({ terminalReply, resultText }) => {
      const entry = createRunEntry({ expectsCompletionMessage: true });
      const captureSubagentCompletionReply = vi.fn(async () => "stale transcript reply");
      const runSubagentAnnounceFlow = vi.fn(async () => "delivered" as const);
      const controller = createLifecycleController({
        entry,
        captureSubagentCompletionReply,
        runSubagentAnnounceFlow,
      });

      await completeRun(controller, entry, {
        triggerCleanup: true,
        terminalReply,
      });

      expect(captureSubagentCompletionReply).not.toHaveBeenCalled();
      expect(entry.completion).toMatchObject({ terminalReply, resultText });
      expect(runSubagentAnnounceFlow).toHaveBeenCalledWith(
        expect.objectContaining({ terminalReply }),
      );
    },
  );

  it("records explicit empty success as intentional non-delivery at the lifecycle owner", async () => {
    const entry = createRunEntry({ expectsCompletionMessage: true });
    const captureSubagentCompletionReply = vi.fn(async () => "stale transcript reply");
    const runSubagentAnnounceFlow = vi.fn(async () => "delivered" as const);
    const maybeWakeRequesterAfterAllChildrenSettled = vi.fn(async () => false);
    const controller = createLifecycleController({
      entry,
      captureSubagentCompletionReply,
      runSubagentAnnounceFlow,
      maybeWakeRequesterAfterAllChildrenSettled,
    });

    await completeRun(controller, entry, {
      triggerCleanup: true,
      terminalReply: { disposition: "empty" },
    });
    await waitForLifecycleState(() => expect(entry.cleanupCompletedAt).toBeTypeOf("number"));

    expect(captureSubagentCompletionReply).not.toHaveBeenCalled();
    expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
    expect(maybeWakeRequesterAfterAllChildrenSettled).not.toHaveBeenCalled();
    expect(entry.execution.outcome).toMatchObject({ status: "ok" });
    expect(entry.completion).toMatchObject({
      terminalReply: { disposition: "empty" },
      resultText: null,
    });
    expect(entry.requesterSettleWake).toBeUndefined();
    expect(entry.delivery).toMatchObject({
      status: "not_required",
      disposition: "intentional_non_delivery",
    });
    expect(entry.suppressCompletionDelivery).toBeUndefined();
    expectFields(firstCallArg(taskExecutorMocks.completeTaskRunByRunId), {
      runId: entry.runId,
      suppressDelivery: true,
      terminalOutcome: "succeeded",
    });
  });

  it("keeps message-tool-required missing output on the requester delivery path", async () => {
    const entry = createRunEntry({ expectsCompletionMessage: true });
    const runSubagentAnnounceFlow: LifecycleControllerParams["runSubagentAnnounceFlow"] = vi.fn(
      async (announceParams) => {
        announceParams.onDeliveryResult?.({
          delivered: false,
          path: "direct",
          reason: "message_tool_delivery_missing",
          error: "completion agent did not use the message tool",
        });
        return "retryable" as const;
      },
    );
    const controller = createLifecycleController({ entry, runSubagentAnnounceFlow });

    await completeRun(controller, entry, {
      endedAt: Date.now(),
      triggerCleanup: true,
      terminalReply: { disposition: "empty", code: "message-tool-not-called" },
    });
    await waitForLifecycleState(() => expect(runSubagentAnnounceFlow).toHaveBeenCalledOnce());

    expect(runSubagentAnnounceFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        terminalReply: { disposition: "empty", code: "message-tool-not-called" },
      }),
    );
    expect(entry.suppressCompletionDelivery).toBeUndefined();
    expect(entry.delivery).toMatchObject({
      disposition: "retryable",
      lastError: expect.stringContaining("message tool"),
    });
    expect(entry.delivery?.status).not.toBe("not_required");
    expect(entry.cleanupCompletedAt).toBeUndefined();
  });

  it.each([
    { label: "bound", hasOwner: true },
    { label: "unbound", hasOwner: false },
  ])("uses only the $label run owner for announce dispatch", async ({ hasOwner }) => {
    const entry = createRunEntry({ expectsCompletionMessage: true });
    const liveContext = { marker: "live-context" };
    const resolveGatewayContext = () => liveContext;
    if (hasOwner) {
      bindGatewayContextResolver(entry, resolveGatewayContext as never);
    }
    const runSubagentAnnounceFlow = vi.fn(
      async (_announceParams: { resolveGatewayContext?: () => unknown }) =>
        "delivered" as AnnounceFlowOutcome,
    );
    const controller = createLifecycleController({
      entry,
      runSubagentAnnounceFlow,
    });

    await completeRun(controller, entry, { triggerCleanup: true });

    const announceParams = runSubagentAnnounceFlow.mock.calls[0]?.[0];
    expect(announceParams?.resolveGatewayContext).toBe(
      hasOwner ? resolveGatewayContext : undefined,
    );
  });

  it("merges late visible reply evidence into an already-terminal completion", async () => {
    const entry = createRunEntry({ expectsCompletionMessage: true });
    const captureSubagentCompletionReply = vi.fn(async () => "legacy fallback");
    const controller = createLifecycleController({ entry, captureSubagentCompletionReply });

    await completeRun(controller, entry, {
      terminalReply: { disposition: "empty" },
    });
    await completeRun(controller, entry, {
      endedAt: 4_001,
      terminalReply: { disposition: "visible", text: "late authoritative reply" },
    });

    expect(entry.completion).toMatchObject({
      resultText: "late authoritative reply",
      terminalReply: { disposition: "visible", text: "late authoritative reply" },
    });
    expect(captureSubagentCompletionReply).not.toHaveBeenCalled();
  });

  it("runs detached cleanup outside a disposed requester transcript owner", async () => {
    const sessionKey = "agent:main:disposed-cleanup-owner";
    const entry = createRunEntry({
      requesterSessionKey: sessionKey,
      endedAt: 4_000,
      expectsCompletionMessage: true,
      retainAttachmentsOnKeep: true,
    });
    let disposed = false;
    let releaseCleanup!: () => void;
    const cleanupReady = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const requesterTranscriptWrite = vi.fn();
    const withRequesterTranscriptWrite = async <T>(operation: () => Promise<T> | T): Promise<T> => {
      requesterTranscriptWrite();
      if (disposed) {
        throw new Error("attempt disposed before transcript write");
      }
      return await operation();
    };
    const freshTranscriptWrite = vi.fn(async () => {});
    const runSubagentAnnounceFlow = vi.fn(async () => {
      await cleanupReady;
      await runWithOwnedSessionTranscriptWrite({ sessionKey }, freshTranscriptWrite);
      return "delivered" as const;
    });
    const controller = createLifecycleController({ entry, runSubagentAnnounceFlow });

    await withOwnedSessionTranscriptWrites(
      { sessionKey, withTranscriptWrite: withRequesterTranscriptWrite },
      async () => {
        expect(controller.startSubagentAnnounceCleanupFlow(entry.runId, entry)).toBe(true);
      },
    );

    disposed = true;
    releaseCleanup();

    await waitForLifecycleState(() => expect(freshTranscriptWrite).toHaveBeenCalledOnce());
    await waitForLifecycleState(() => expect(entry.delivery?.status).toBe("delivered"));
    expect(requesterTranscriptWrite).not.toHaveBeenCalled();
    expect(runSubagentAnnounceFlow).toHaveBeenCalledOnce();
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

  it("publishes a recovered terminal session status exactly once", async () => {
    const entry = createRunEntry();
    const emitSubagentProgressEndedForRun = vi.fn(async () => {});
    const controller = createLifecycleController({ entry, emitSubagentProgressEndedForRun });
    const completion = makeInterruptedSubagentCompletion(entry);

    await controller.completeSubagentRun(completion);
    await controller.completeSubagentRun(completion);

    expect(lifecycleEventMocks.emitSessionLifecycleEvent).toHaveBeenCalledExactlyOnceWith({
      sessionKey: entry.childSessionKey,
      reason: "subagent-status",
      parentSessionKey: entry.requesterSessionKey,
      label: entry.label,
    });
    expect(emitSubagentProgressEndedForRun).toHaveBeenCalledExactlyOnceWith(entry);
  });

  it("does not publish recovered terminal events for an ordinary completion", async () => {
    const outcome = {
      status: "error" as const,
      error: "restart interrupted run",
      startedAt: 2_000,
      endedAt: 4_000,
      elapsedMs: 2_000,
    };
    const entry = createRunEntry({
      endedReason: SUBAGENT_ENDED_REASON_ERROR,
      terminalOwner: "interrupted-recovery",
      execution: {
        status: "terminal",
        startedAt: 2_000,
        endedAt: 4_000,
        outcome,
      },
      completion: { required: false, resultText: null, capturedAt: 4_000 },
    });
    const emitSubagentProgressEndedForRun = vi.fn(async () => {});
    const controller = createLifecycleController({ entry, emitSubagentProgressEndedForRun });

    await controller.completeSubagentRun(
      makeSubagentCompletion(entry, {
        outcome: { status: "error", error: "restart interrupted run" },
        reason: SUBAGENT_ENDED_REASON_ERROR,
      }),
    );

    expect(lifecycleEventMocks.emitSessionLifecycleEvent).not.toHaveBeenCalled();
    expect(emitSubagentProgressEndedForRun).not.toHaveBeenCalled();
  });

  it("retains a retired accepted receipt until terminal cleanup completes", async () => {
    const entry = createRunEntry({
      execution: {
        status: "running",
        startedAt: 2_000,
        restartRecovery: makeRestartRecoveryReceipt({
          lifecycleGeneration: "retired-generation",
        }),
      },
    });
    const persistOrThrow = vi.fn();
    const controller = createLifecycleController({ entry, persistOrThrow });

    await controller.completeSubagentRun(
      makeInterruptedSubagentCompletion(entry, {
        outcome: { status: "error", error: "exact recovery session was lost" },
        suppressSessionEffects: true,
      }),
    );

    expect(entry).toMatchObject({
      terminalOwner: "interrupted-recovery",
      execution: {
        status: "terminal",
        endedAt: 4_000,
        restartRecovery: expect.objectContaining({
          phase: "accepted",
          lifecycleGeneration: "retired-generation",
        }),
        suppressSessionEffects: true,
      },
    });
    expect(persistOrThrow).toHaveBeenCalled();
  });

  it("keeps retired recovery cleanup away from the newer child lifecycle", async () => {
    const entry = createRunEntry({
      cleanup: "delete",
      expectsCompletionMessage: false,
      execution: {
        status: "interrupted",
        startedAt: 2_000,
        restartRecovery: makeRestartRecoveryReceipt({
          lifecycleGeneration: "retired-generation",
        }),
      },
    });
    const runs = new Map([[entry.runId, entry]]);
    const emitSubagentEndedHookForRun = vi.fn(async () => {});
    const notifyContextEngineSubagentEnded = vi.fn(async () => {});
    const controller = createLifecycleController({
      entry,
      runs,
      emitSubagentEndedHookForRun,
      notifyContextEngineSubagentEnded,
      shouldEmitEndedHookForRun: () => true,
    });

    await controller.completeSubagentRun(
      makeInterruptedSubagentCompletion(entry, {
        outcome: { status: "error", error: "retired Gateway lifecycle" },
        triggerCleanup: true,
        suppressSessionEffects: true,
      }),
    );
    await waitForLifecycleState(() => {
      expect(entry.execution.restartRecovery).toBeUndefined();
    });

    expect(
      browserLifecycleCleanupMocks.cleanupBrowserSessionsForLifecycleEnd,
    ).not.toHaveBeenCalled();
    expect(bundleMcpRuntimeMocks.retireSessionMcpRuntimeForSessionKey).not.toHaveBeenCalled();
    expect(gatewayMocks.callGateway).not.toHaveBeenCalled();
    expect(lifecycleEventMocks.emitSessionLifecycleEvent).not.toHaveBeenCalled();
    expect(emitSubagentEndedHookForRun).not.toHaveBeenCalled();
    expect(notifyContextEngineSubagentEnded).not.toHaveBeenCalled();
    expect(entry.terminalOwner).toBeUndefined();
    expect(entry.execution.suppressSessionEffects).toBe(true);

    const recovered = structuredClone(entry);
    await completeRun(controller, entry, { endedAt: 4_001, triggerCleanup: true });
    expect(markSubagentRunPausedAfterYield({ entry, endedAt: 4_002 })).toBe(false);
    expect(entry).toEqual(recovered);
    expect(
      browserLifecycleCleanupMocks.cleanupBrowserSessionsForLifecycleEnd,
    ).not.toHaveBeenCalled();
    expect(bundleMcpRuntimeMocks.retireSessionMcpRuntimeForSessionKey).not.toHaveBeenCalled();
    expect(gatewayMocks.callGateway).not.toHaveBeenCalled();
    expect(lifecycleEventMocks.emitSessionLifecycleEvent).not.toHaveBeenCalled();
    expect(emitSubagentEndedHookForRun).not.toHaveBeenCalled();
    expect(notifyContextEngineSubagentEnded).not.toHaveBeenCalled();
  });

  it("promotes kill intent over a restored interrupted terminal owner", async () => {
    const entry = createRunEntry({
      endedAt: 4_000,
      endedReason: SUBAGENT_ENDED_REASON_ERROR,
      outcome: { status: "error", error: "restart interrupted run" },
      terminalOwner: "interrupted-recovery",
      killIntent: {
        requestedAt: 4_001,
        reason: "killed",
        sessionId: "session-id",
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
      },
      execution: {
        status: "terminal",
        startedAt: 2_000,
        endedAt: 4_000,
        outcome: { status: "error", error: "restart interrupted run" },
        restartRecovery: makeRestartRecoveryReceipt(),
      },
    });
    const controller = createLifecycleController({ entry });

    await controller.completeSubagentRun(
      makeKilledSubagentCompletion(entry, {
        endedAt: 4_001,
        outcome: { status: "error", error: "killed" },
      }),
    );

    expect(entry).toMatchObject({
      endedReason: SUBAGENT_ENDED_REASON_KILLED,
      killReconciliation: { killedAt: 4_001 },
      execution: {
        status: "terminal",
        endedAt: 4_001,
        restartRecovery: undefined,
      },
    });
    expect(entry.killIntent).toBeUndefined();
  });

  it("keeps replacement-session effects suppressed for a legacy unowned kill", async () => {
    const entry = createRunEntry({
      endedAt: 4_000,
      endedReason: SUBAGENT_ENDED_REASON_ERROR,
      outcome: { status: "error", error: "restart interrupted run" },
      terminalOwner: "interrupted-recovery",
      killIntent: {
        requestedAt: 4_001,
        reason: "legacy killed",
        sessionId: "session-id",
      },
      execution: {
        status: "terminal",
        startedAt: 2_000,
        endedAt: 4_000,
        outcome: { status: "error", error: "restart interrupted run" },
        restartRecovery: makeRestartRecoveryReceipt(),
      },
    });
    const controller = createLifecycleController({ entry });

    await controller.completeSubagentRun(
      makeKilledSubagentCompletion(entry, {
        endedAt: 4_001,
        outcome: { status: "error", error: "legacy killed" },
      }),
    );

    expect(entry).toMatchObject({
      endedReason: SUBAGENT_ENDED_REASON_KILLED,
      killReconciliation: { killedAt: 4_001 },
      execution: {
        status: "terminal",
        restartRecovery: expect.objectContaining({ phase: "accepted" }),
        suppressSessionEffects: true,
      },
    });
    expect(entry.killIntent).toBeUndefined();
  });

  it("keeps a natural completion that predates the durable kill intent", async () => {
    const entry = createRunEntry({
      killIntent: {
        requestedAt: 5_000,
        reason: "killed",
        sessionId: "session-id",
      },
      execution: {
        status: "running",
        startedAt: 2_000,
      },
    });
    const controller = createLifecycleController({ entry });

    await controller.completeSubagentRun(makeSubagentCompletion(entry));

    expect(entry).toMatchObject({
      endedReason: SUBAGENT_ENDED_REASON_COMPLETE,
      execution: {
        status: "terminal",
        endedAt: 4_000,
        outcome: { status: "ok" },
      },
    });
    expect(entry.killIntent).toBeUndefined();
    expect(entry.killReconciliation).toBeUndefined();
  });

  it("keeps task finalization, resource retirement, and announce cleanup root-admitted", async () => {
    const entry = createRunEntry({ expectsCompletionMessage: true });
    let releaseBrowserCleanup: (() => void) | undefined;
    let releaseAnnounce: ((outcome: AnnounceFlowOutcome) => void) | undefined;
    browserLifecycleCleanupMocks.cleanupBrowserSessionsForLifecycleEnd.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseBrowserCleanup = resolve;
        }),
    );
    const runSubagentAnnounceFlow = vi.fn(
      () =>
        new Promise<AnnounceFlowOutcome>((resolve) => {
          releaseAnnounce = resolve;
        }),
    );
    const controller = createLifecycleController({ entry, runSubagentAnnounceFlow });

    const completion = completeRun(controller, entry, {
      triggerCleanup: true,
      terminalReply: { disposition: "visible", text: "final completion reply" },
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

    releaseAnnounce?.("delivered");
    await waitForLifecycleState(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
    expect(entry.cleanupCompletedAt).toBeTypeOf("number");
  });

  it("settles an admitted subagent and its delivery behind a closed drain fence", async () => {
    const entry = createRunEntry({ expectsCompletionMessage: true });
    let releaseAnnounce = (_outcome: AnnounceFlowOutcome) => {};
    const runSubagentAnnounceFlow = vi.fn(
      () =>
        new Promise<AnnounceFlowOutcome>((resolve) => {
          releaseAnnounce = resolve;
        }),
    );
    const controller = createLifecycleController({ entry, runSubagentAnnounceFlow });
    let finishRun = () => {};
    const admittedRun = runWithGatewayIndependentRootWorkAdmission(async () => {
      await new Promise<void>((resolve) => {
        finishRun = resolve;
      });
      await completeRun(controller, entry, {
        triggerCleanup: true,
        terminalReply: { disposition: "visible", text: "final completion reply" },
      });
    });
    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension?.drain()).toBe(true);

    try {
      expect(tryBeginGatewayRootWorkAdmission()).toBeNull();
      finishRun();
      await waitForLifecycleState(() => expect(runSubagentAnnounceFlow).toHaveBeenCalledOnce());
      await admittedRun;
      expect(entry.execution.status).toBe("terminal");
      expect(getActiveGatewayRootWorkCount()).toBe(1);
      expect(tryBeginGatewayRootWorkAdmission()).toBeNull();

      releaseAnnounce("delivered");
      await waitForLifecycleState(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
      expect(entry.cleanupCompletedAt).toBeTypeOf("number");
    } finally {
      releaseAnnounce("delivered");
      finishRun();
      suspension?.release();
      await admittedRun;
    }
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

    await completeRun(controller, entry, { triggerCleanup: true });
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
      const runSubagentAnnounceFlow = vi.fn(async () => "delivered" as const);
      const resumeSubagentRun = vi.fn((runId: string) => {
        controller.startSubagentAnnounceCleanupFlow(runId, entry);
      });
      const controller = createLifecycleController({
        entry,
        resumeSubagentRun,
        runSubagentAnnounceFlow,
      });

      const completion = completeRun(controller, entry, { triggerCleanup: true });
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

  it("retries a detached cleanup failure and completes on the next attempt", async () => {
    vi.useFakeTimers();
    const entry = createRunEntry({
      endedAt: 4_000,
      expectsCompletionMessage: false,
      retainAttachmentsOnKeep: false,
    });
    helperMocks.safeRemoveAttachmentsDir.mockRejectedValueOnce(new Error("cleanup failed"));
    const resumeSubagentRun = vi.fn((runId: string) => {
      controller.startSubagentAnnounceCleanupFlow(runId, entry);
    });
    const controller = createLifecycleController({ entry, resumeSubagentRun });

    try {
      expect(controller.startSubagentAnnounceCleanupFlow(entry.runId, entry)).toBe(true);
      await waitForLifecycleState(() => expect(entry.cleanupHandled).toBe(false));
      expect(entry.cleanupCompletedAt).toBeUndefined();
      expect(vi.getTimerCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(1_000);

      expect(resumeSubagentRun).toHaveBeenCalledExactlyOnceWith(entry.runId);
      await waitForLifecycleState(() => expect(entry.cleanupCompletedAt).toBeTypeOf("number"));
    } finally {
      helperMocks.safeRemoveAttachmentsDir.mockReset().mockResolvedValue(undefined);
      controller.clearScheduledResumeTimers();
      vi.useRealTimers();
    }
  });

  it("drops a failed-cleanup retry after a newer cleanup generation starts", async () => {
    vi.useFakeTimers();
    const entry = createRunEntry({
      endedAt: 4_000,
      expectsCompletionMessage: false,
      retainAttachmentsOnKeep: false,
    });
    let releaseNewCleanup: (() => void) | undefined;
    helperMocks.safeRemoveAttachmentsDir
      .mockRejectedValueOnce(new Error("cleanup failed"))
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releaseNewCleanup = resolve;
          }),
      );
    const resumeSubagentRun = vi.fn();
    const controller = createLifecycleController({ entry, resumeSubagentRun });

    try {
      expect(controller.startSubagentAnnounceCleanupFlow(entry.runId, entry)).toBe(true);
      await waitForLifecycleState(() => expect(entry.cleanupHandled).toBe(false));
      expect(vi.getTimerCount()).toBe(1);

      expect(controller.startSubagentAnnounceCleanupFlow(entry.runId, entry)).toBe(true);
      await waitForLifecycleState(() => expect(releaseNewCleanup).toBeTypeOf("function"));
      await vi.advanceTimersByTimeAsync(1_000);

      expect(resumeSubagentRun).not.toHaveBeenCalled();
      releaseNewCleanup?.();
      await waitForLifecycleState(() => expect(entry.cleanupCompletedAt).toBeTypeOf("number"));
    } finally {
      releaseNewCleanup?.();
      controller.clearScheduledResumeTimers();
      vi.useRealTimers();
    }
  });

  it("stops retrying detached cleanup failures and leaves the run durably unlocked", async () => {
    vi.useFakeTimers();
    const entry = createRunEntry({
      endedAt: 4_000,
      expectsCompletionMessage: false,
      retainAttachmentsOnKeep: false,
    });
    const persist = vi.fn();
    helperMocks.safeRemoveAttachmentsDir.mockRejectedValue(new Error("cleanup failed"));
    const resumeSubagentRun = vi.fn((runId: string) => {
      controller.startSubagentAnnounceCleanupFlow(runId, entry);
    });
    const controller = createLifecycleController({ entry, persist, resumeSubagentRun });

    try {
      expect(controller.startSubagentAnnounceCleanupFlow(entry.runId, entry)).toBe(true);
      await waitForLifecycleState(() => expect(entry.cleanupHandled).toBe(false));
      expect(vi.getTimerCount()).toBe(1);

      for (let attempts = 0; attempts < 10 && vi.getTimerCount() > 0; attempts += 1) {
        await vi.runOnlyPendingTimersAsync();
      }

      expect(helperMocks.safeRemoveAttachmentsDir.mock.calls.length).toBeGreaterThan(1);
      expect(helperMocks.safeRemoveAttachmentsDir.mock.calls.length).toBeLessThan(10);
      expect(entry.cleanupHandled).toBe(false);
      expect(entry.cleanupCompletedAt).toBeUndefined();
      expect(persist).toHaveBeenLastCalledWith(entry.runId);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      helperMocks.safeRemoveAttachmentsDir.mockReset().mockResolvedValue(undefined);
      controller.clearScheduledResumeTimers();
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

    await expect(completeRun(controller, entry)).resolves.toBeUndefined();

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

  it.each([
    { identity: "ASCII", runId: "run-1234567890", expected: "run-…7890" },
    { identity: "short ASCII", runId: "short", expected: "***" },
    { identity: "astral prefix", runId: "abc😀" + "x".repeat(10), expected: "abc…xxxx" },
    { identity: "astral suffix", runId: "x".repeat(10) + "😀abc", expected: "xxxx…abc" },
    {
      identity: "astral prefix and suffix",
      runId: "abc😀" + "x".repeat(10) + "😀xyz",
      expected: "abc…xyz",
    },
  ])(
    "keeps $identity run IDs well-formed in actual completion warnings",
    async ({ runId, expected }) => {
      const warn = vi.fn();
      const entry = createRunEntry({ runId });
      taskExecutorMocks.completeTaskRunByRunId.mockImplementation(() => {
        throw new Error("task store boom");
      });

      const controller = createLifecycleController({ entry, warn });
      await expect(completeRun(controller, entry)).resolves.toBeUndefined();

      const [, warningFields] = firstCall(warn);
      const maskedRunId = (warningFields as { runId?: string }).runId;
      expect(maskedRunId).toBe(expected);
      expect(new TextDecoder().decode(new TextEncoder().encode(maskedRunId))).toBe(maskedRunId);
    },
  );

  it("restores the registry state when canonical completion persistence fails", async () => {
    const entry = createRunEntry();
    const original = structuredClone(entry);
    const persistOrThrow = vi.fn(() => {
      throw new Error("registry store boom");
    });
    const controller = createLifecycleController({ entry, persistOrThrow });

    await expect(completeRun(controller, entry)).rejects.toThrow("registry store boom");

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
    const providerCompletion = completeRun(controller, entry);
    await waitForLifecycleState(() => expect(finishCapture).toBeTypeOf("function"));
    const interruptedRecovery = controller.completeSubagentRun(
      makeInterruptedSubagentCompletion(entry, {
        endedAt: 4_001,
      }),
    );

    finishCapture?.("provider result");
    await Promise.all([providerCompletion, interruptedRecovery]);

    expect(entry.execution.outcome?.status).toBe("ok");
    expect(entry.endedReason).toBe(SUBAGENT_ENDED_REASON_COMPLETE);
    expect(entry.terminalOwner).toBeUndefined();
    expect(taskExecutorMocks.failTaskRunByRunId).not.toHaveBeenCalled();
  });

  it("persists interrupted recovery before task projection and rejects late provider or yield", async () => {
    const entry = createRunEntry();
    const persistOrThrow = vi.fn();
    const controller = createLifecycleController({ entry, persistOrThrow });
    await controller.completeSubagentRun(makeInterruptedSubagentCompletion(entry));
    const recovered = structuredClone(entry);

    await completeRun(controller, entry, { endedAt: 4_001 });

    expect(markSubagentRunPausedAfterYield({ entry, endedAt: 4_002 })).toBe(false);
    expect(entry).toEqual(recovered);
    expect(entry).toMatchObject({
      endedReason: SUBAGENT_ENDED_REASON_ERROR,
      terminalOwner: "interrupted-recovery",
      execution: {
        endedAt: 4_000,
        outcome: { status: "error", error: "restart interrupted run" },
      },
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
      controller.completeSubagentRun(makeInterruptedSubagentCompletion(entry)),
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
    await createLifecycleController({ entry, persistOrThrow }).completeSubagentRun(
      makeInterruptedSubagentCompletion(entry, {
        endedAt: 4_001,
      }),
    );

    expect(entry).toEqual(original);
    expect(persistOrThrow).not.toHaveBeenCalled();
    expect(taskExecutorMocks.failTaskRunByRunId).not.toHaveBeenCalled();
    expect(taskExecutorMocks.completeTaskRunByRunId).not.toHaveBeenCalled();
  });

  it("does not overwrite partial terminal evidence during interrupted recovery", async () => {
    const terminalEvidence: RunEntryOverrides[] = [
      { execution: { status: "terminal", endedAt: 4_000 } },
      {
        execution: {
          status: "terminal",
          outcome: { status: "error", error: "existing failure" },
        },
      },
      { endedReason: SUBAGENT_ENDED_REASON_ERROR },
      {
        execution: {
          status: "terminal",
          endedAt: 4_000,
          outcome: { status: "error", error: "existing failure" },
        },
        endedReason: SUBAGENT_ENDED_REASON_ERROR,
      },
    ];
    for (const evidence of terminalEvidence) {
      const entry = createRunEntry(evidence);
      const original = structuredClone(entry);
      const persistOrThrow = vi.fn();
      await createLifecycleController({ entry, persistOrThrow }).completeSubagentRun(
        makeInterruptedSubagentCompletion(entry, {
          endedAt: 4_001,
        }),
      );

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
      endedReason: SUBAGENT_ENDED_REASON_ERROR,
      execution: {
        status: "terminal",
        startedAt: 2_000,
        endedAt: 4_000,
        outcome: interruptedOutcome,
      },
    });
    const persistOrThrow = vi.fn();
    await createLifecycleController({ entry, persistOrThrow }).completeSubagentRun(
      makeInterruptedSubagentCompletion(entry),
    );

    expect(entry).toMatchObject({
      endedReason: SUBAGENT_ENDED_REASON_ERROR,
      terminalOwner: "interrupted-recovery",
      execution: {
        status: "terminal",
        endedAt: 4_000,
        outcome: { status: "error", error: "restart interrupted run" },
      },
    });
    expect(persistOrThrow).toHaveBeenCalled();
  });

  it("restores a provisional kill when canonical task projection fails", async () => {
    const entry = makeProvisionalKilledRunEntry();
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

    await expect(completeRun(controller, entry, { endedAt: 4_001 })).rejects.toThrow(
      "subagent task projection did not finalize",
    );

    expect(entry).toEqual(original);
    expect(persistOrThrow).not.toHaveBeenCalled();
  });

  it("commits a reconciled task before its canonical registry outcome", async () => {
    taskExecutorMocks.completeTaskRunByRunId.mockReturnValueOnce([{}]);
    const entry = makeProvisionalKilledRunEntry();
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

    await completeRun(controller, entry, { endedAt: 4_001 });

    expect(taskExecutorMocks.completeTaskRunByRunId.mock.invocationCallOrder[0]).toBeLessThan(
      persistOrThrow.mock.invocationCallOrder[0]!,
    );
    expect(entry.killReconciliation).toBeUndefined();
  });

  it("keeps the shared task writable when a steer restart aborts its old run", async () => {
    const entry = createRunEntry({ suppressAnnounceReason: "steer-restart" });
    const controller = createLifecycleController({ entry });

    await controller.completeSubagentRun(makeKilledSubagentCompletion(entry));

    expect(entry).toMatchObject({
      endedReason: SUBAGENT_ENDED_REASON_KILLED,
      execution: { endedAt: 4_000 },
    });
    expect(taskExecutorMocks.failTaskRunByRunId).not.toHaveBeenCalled();
    expect(taskExecutorMocks.completeTaskRunByRunId).not.toHaveBeenCalled();
  });

  it("marks standalone killed lifecycle tasks with the recoverable cancellation", async () => {
    const entry = createRunEntry();
    const controller = createLifecycleController({ entry });

    await controller.completeSubagentRun(makeKilledSubagentCompletion(entry));

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

    await controller.completeSubagentRun(
      makeKilledSubagentCompletion(entry, {
        startedAt: 2_000,
        endedAt: 6_000,
      }),
    );

    expect(entry).toMatchObject({
      endedReason: SUBAGENT_ENDED_REASON_COMPLETE,
      execution: {
        endedAt: 5_000,
        outcome: { status: "timeout", startedAt: 2_000, endedAt: 5_000 },
      },
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

    await controller.completeSubagentRun(
      makeKilledSubagentCompletion(entry, {
        startedAt: 2_000,
        endedAt: 6_000,
      }),
    );

    expect(entry).toMatchObject({
      endedReason: SUBAGENT_ENDED_REASON_COMPLETE,
      execution: { endedAt: 5_000, outcome: { status: "timeout" } },
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
      const runSubagentAnnounceFlow = vi.fn(async () => "delivered" as const);
      const controller = createLifecycleController({
        entry,
        shouldEmitEndedHookForRun: () => true,
        emitSubagentEndedHookForRun,
        runSubagentAnnounceFlow,
      });

      await controller.completeSubagentRun(
        makeKilledSubagentCompletion(entry, {
          triggerCleanup: true,
        }),
      );

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

  it("uses producer reply evidence when success supersedes a killed lifecycle", async () => {
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

    await controller.completeSubagentRun(makeKilledSubagentCompletion(entry));
    expect(entry.completion).toMatchObject({ resultText: null });

    await completeRun(controller, entry, {
      endedAt: 4_001,
      terminalReply: {
        disposition: "visible",
        text: "Fixed the crash and verified the regression tests pass.",
      },
    });

    expect(captureSubagentCompletionReply).not.toHaveBeenCalled();
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

    await controller.completeSubagentRun(makeKilledSubagentCompletion(entry));
    expect(entry.completion).toMatchObject({ resultText: null });

    await completeRun(controller, entry, {
      endedAt: 4_001,
      outcome: { status: "timeout" },
      triggerCleanup: false,
    });

    expect(captureSubagentCompletionReply).toHaveBeenCalledOnce();
    expect(entry.completion?.resultText).toBe("Partial result before timeout.");
  });

  it("preserves a captured reply when success supersedes a delayed killed lifecycle", async () => {
    const entry = makeProvisionalKilledRunEntry({
      archiveAtMs: 5_000,
      expectsCompletionMessage: true,
      completion: {
        required: true,
        resultText: "Already captured final reply.",
        capturedAt: 4_000,
        terminalReply: { disposition: "visible", text: "Already captured final reply." },
      },
    });
    const captureSubagentCompletionReply = vi.fn(async () => undefined);
    const controller = createLifecycleController({
      entry,
      captureSubagentCompletionReply,
    });

    await completeRun(controller, entry, { endedAt: 4_001 });

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

  it("skips frozen-result refill for a sessions_yield-paused run", async () => {
    const entry = createRunEntry({
      expectsCompletionMessage: true,
      endedAt: 4_000,
      pauseReason: "sessions_yield",
    });
    const captureSubagentCompletionReply = vi.fn(async () => "text from the next turn");
    const controller = createLifecycleController({ entry, captureSubagentCompletionReply });

    expect(await controller.refreshFrozenResultFromSession(entry.childSessionKey)).toBe(false);

    // The yield cleared this row's result on purpose. Whatever the session holds
    // now belongs to the turn that runs next, so refreezing it would announce a
    // stranger's output as the paused run's completion.
    expect(captureSubagentCompletionReply).not.toHaveBeenCalled();
    expect(entry.completion?.resultText).toBeUndefined();
  });

  it("refreshes only the newest pending completion generation for a shared session", async () => {
    const childSessionKey = "agent:main:subagent:shared-refresh";
    const older = createRunEntry({
      runId: "run-shared-refresh-old",
      childSessionKey,
      generation: 1,
      createdAt: 1_000,
      expectsCompletionMessage: true,
      endedAt: 4_000,
      outcome: { status: "ok" },
      completion: {
        required: true,
        resultText: "older generation result",
        capturedAt: 4_000,
      },
    });
    const newer = createRunEntry({
      runId: "run-shared-refresh-new",
      childSessionKey,
      generation: 2,
      createdAt: 2_000,
      expectsCompletionMessage: true,
      endedAt: 5_000,
      outcome: { status: "ok" },
      completion: {
        required: true,
        resultText: "newer generation placeholder",
        capturedAt: 5_000,
      },
    });
    const olderBefore = structuredClone(older);
    const persist = vi.fn();
    const controller = createLifecycleController({
      entry: newer,
      runs: new Map([
        [older.runId, older],
        [newer.runId, newer],
      ]),
      persist,
      captureSubagentCompletionReply: vi.fn(async () => "latest session reply"),
    });

    expect(await controller.refreshFrozenResultFromSession(childSessionKey)).toBe(true);

    expect(older).toEqual(olderBefore);
    expect(newer.completion).toMatchObject({
      resultText: "latest session reply",
      capturedAt: expect.any(Number),
    });
    expect(persist).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledWith(newer.runId);
  });

  it("rejects a frozen-result refresh when a newer generation registers during capture", async () => {
    const childSessionKey = "agent:main:subagent:refresh-race";
    const entry = createRunEntry({
      runId: "run-refresh-race-old",
      childSessionKey,
      generation: 1,
      expectsCompletionMessage: true,
      endedAt: 4_000,
      outcome: { status: "ok" },
    });
    const runs = new Map([[entry.runId, entry]]);
    let finishCapture: ((value: string) => void) | undefined;
    const captureSubagentCompletionReply = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finishCapture = resolve;
        }),
    );
    const persist = vi.fn();
    const controller = createLifecycleController({
      entry,
      runs,
      persist,
      captureSubagentCompletionReply,
    });

    const refresh = controller.refreshFrozenResultFromSession(childSessionKey);
    await waitForLifecycleState(() =>
      expect(captureSubagentCompletionReply).toHaveBeenCalledOnce(),
    );
    const successor = createRunEntry({
      runId: "run-refresh-race-new",
      childSessionKey,
      generation: 2,
      createdAt: 2_000,
    });
    runs.set(successor.runId, successor);
    finishCapture?.("reply owned by the successor");

    expect(await refresh).toBe(false);
    expect(entry.completion?.resultText).toBeUndefined();
    expect(successor.completion?.resultText).toBeUndefined();
    expect(persist).not.toHaveBeenCalled();
  });

  it("keeps success canonical while a killed callback waits behind reply capture", async () => {
    const entry = createRunEntry({ expectsCompletionMessage: false });
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

    const success = completeRun(controller, entry);
    await waitForLifecycleState(() =>
      expect(captureSubagentCompletionReply).toHaveBeenCalledOnce(),
    );
    const killed = controller.completeSubagentRun(
      makeKilledSubagentCompletion(entry, {
        endedAt: 4_001,
      }),
    );
    releaseCapture?.("Canonical final reply.");
    await Promise.all([success, killed]);

    expect(entry).toMatchObject({
      endedReason: SUBAGENT_ENDED_REASON_COMPLETE,
      execution: { endedAt: 4_000, outcome: { status: "ok" } },
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
      let finishAnnounce: ((outcome: AnnounceFlowOutcome) => void) | undefined;
      const runSubagentAnnounceFlow = vi.fn(
        () =>
          new Promise<AnnounceFlowOutcome>((resolve) => {
            finishAnnounce = resolve;
          }),
      );
      const controller = createLifecycleController({
        entry,
        runs,
        runSubagentAnnounceFlow,
        captureSubagentCompletionReply: vi.fn(async () => "premature terminal reply"),
      });

      await completeRun(controller, entry, { triggerCleanup: true });
      expect(runSubagentAnnounceFlow).toHaveBeenCalledOnce();
      expect(entry.cleanupHandled).toBe(true);

      expect(
        markSubagentRunPausedAfterYield({
          entry,
          startedAt: 2_000,
          endedAt: 4_001,
        }),
      ).toBe(true);
      finishAnnounce?.("delivered");
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

    await completeRun(controller, entry, { triggerCleanup: true });
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
        new Promise<AnnounceFlowOutcome>((resolve) => {
          expect(announceParams.onBeforeDeleteChildSession?.()).toBe(true);
          releaseAnnounce = () => resolve("delivered");
        }),
    );
    const controller = createLifecycleController({ entry, runs, runSubagentAnnounceFlow });

    await completeRun(controller, entry, {
      triggerCleanup: true,
      terminalReply: { disposition: "visible", text: "final completion reply" },
    });
    await waitForLifecycleState(() => expect(entry.deleteCleanupDispatchedAt).toBeTypeOf("number"));

    expect(markSubagentRunPausedAfterYield({ entry, endedAt: 4_001 })).toBe(false);
    expect(entry.pauseReason).toBeUndefined();
    expect(entry.endedReason).toBe(SUBAGENT_ENDED_REASON_COMPLETE);

    releaseAnnounce?.();
    await waitForLifecycleState(() => expect(runs.has(entry.runId)).toBe(false));
  });

  it.each([
    { name: "pending", beforeDelete: undefined, persisted: { status: "pending" as const } },
    {
      name: "queued",
      beforeDelete: {
        status: "in_progress" as const,
        disposition: "session_queued" as const,
        queueId: "queue-1",
      },
      persisted: {
        status: "in_progress" as const,
        disposition: "session_queued" as const,
        queueId: "queue-1",
      },
    },
  ])(
    "persists a required completion before delete cleanup for $name delivery",
    async ({ beforeDelete, persisted }) => {
      const entry = createRunEntry({ cleanup: "delete", expectsCompletionMessage: true });
      const runs = new Map([[entry.runId, entry]]);
      const persistedSnapshots: SubagentRunRecord[] = [];
      let releaseAnnounce: ((outcome: AnnounceFlowOutcome) => void) | undefined;
      const runSubagentAnnounceFlow: LifecycleControllerParams["runSubagentAnnounceFlow"] = vi.fn(
        (announceParams) =>
          new Promise<AnnounceFlowOutcome>((resolve) => {
            if (beforeDelete) {
              entry.delivery = { ...entry.delivery, ...beforeDelete };
            }
            expect(announceParams.onBeforeDeleteChildSession?.()).toBe(true);
            releaseAnnounce = resolve;
          }),
      );
      const controller = createLifecycleController({
        entry,
        runs,
        persistOrThrow: vi.fn(() => {
          persistedSnapshots.push(structuredClone(entry));
        }),
        runSubagentAnnounceFlow,
      });

      await completeRun(controller, entry, {
        triggerCleanup: true,
        terminalReply: { disposition: "visible", text: "final completion reply" },
      });
      await waitForLifecycleState(() =>
        expect(entry.deleteCleanupDispatchedAt).toBeTypeOf("number"),
      );

      const deleteSnapshot = persistedSnapshots.find(
        (snapshot) => snapshot.deleteCleanupDispatchedAt !== undefined,
      );
      expect(deleteSnapshot).toMatchObject({
        completion: {
          required: true,
          resultText: "final completion reply",
        },
        delivery: {
          ...persisted,
          payload: {
            requesterSessionKey: "agent:main:main",
            childSessionKey: "agent:main:subagent:child",
            task: "finish the task",
            outcome: { status: "ok" },
            terminalReply: { disposition: "visible", text: "final completion reply" },
          },
        },
      });
      expect(deleteSnapshot?.delivery?.attemptCount).toBeUndefined();
      expect(deleteSnapshot?.delivery?.lastAttemptAt).toBeUndefined();

      releaseAnnounce?.("delivered");
      await waitForLifecycleState(() => expect(runs.has(entry.runId)).toBe(false));
    },
  );

  it("does not hand off delete cleanup when the replay payload cannot be persisted", async () => {
    const entry = createRunEntry({ cleanup: "delete", expectsCompletionMessage: true });
    const runs = new Map([[entry.runId, entry]]);
    const persistOrThrow = vi.fn();
    let beforeDelete: (() => boolean) | undefined;
    let releaseAnnounce: ((outcome: AnnounceFlowOutcome) => void) | undefined;
    const runSubagentAnnounceFlow: LifecycleControllerParams["runSubagentAnnounceFlow"] = vi.fn(
      (announceParams) =>
        new Promise<AnnounceFlowOutcome>((resolve) => {
          beforeDelete = announceParams.onBeforeDeleteChildSession;
          releaseAnnounce = resolve;
        }),
    );
    const controller = createLifecycleController({
      entry,
      runs,
      persistOrThrow,
      runSubagentAnnounceFlow,
    });

    await completeRun(controller, entry, {
      triggerCleanup: true,
      terminalReply: { disposition: "visible", text: "final completion reply" },
    });
    await waitForLifecycleState(() => expect(beforeDelete).toBeTypeOf("function"));
    persistOrThrow.mockImplementationOnce(() => {
      throw new Error("registry store boom");
    });

    expect(() => beforeDelete?.()).toThrow("registry store boom");
    expect(entry.deleteCleanupDispatchedAt).toBeUndefined();
    expect(entry.delivery?.payload).toBeUndefined();

    releaseAnnounce?.("delivered");
    await waitForLifecycleState(() => expect(runs.has(entry.runId)).toBe(false));
  });

  it("discards completion capture when an authoritative yield arrives during the await", async () => {
    const entry = createRunEntry({ expectsCompletionMessage: false });
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

    const completion = completeRun(controller, entry, { triggerCleanup: true });
    await waitForLifecycleState(() =>
      expect(captureSubagentCompletionReply).toHaveBeenCalledOnce(),
    );
    expect(markSubagentRunPausedAfterYield({ entry, endedAt: 4_001 })).toBe(true);
    finishCapture?.("stale pre-yield reply");
    await completion;

    expect(entry).toMatchObject({
      pauseReason: "sessions_yield",
      completion: { required: false },
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
    const runSubagentAnnounceFlow = vi.fn<
      (_params: unknown) => ReturnType<LifecycleControllerParams["runSubagentAnnounceFlow"]>
    >(async () => "delivered");
    const controller = createLifecycleController({
      entry,
      runSubagentAnnounceFlow,
      captureSubagentCompletionReply: vi.fn(async () => "Canonical success."),
    });

    const killed = controller.completeSubagentRun(
      makeKilledSubagentCompletion(entry, {
        triggerCleanup: true,
      }),
    );
    await waitForLifecycleState(() =>
      expect(helperMocks.persistSubagentSessionTiming).toHaveBeenCalledOnce(),
    );
    const success = completeRun(controller, entry, {
      endedAt: 4_001,
      triggerCleanup: true,
      terminalReply: { disposition: "visible", text: "Canonical success." },
    });
    await waitForLifecycleState(() =>
      expect(helperMocks.persistSubagentSessionTiming).toHaveBeenCalledTimes(2),
    );
    releaseKilledTiming?.();
    await Promise.all([killed, success]);

    expect(entry).toMatchObject({
      endedReason: SUBAGENT_ENDED_REASON_COMPLETE,
      execution: { outcome: { status: "ok" } },
      completion: { resultText: "Canonical success." },
    });
    expect(runSubagentAnnounceFlow).toHaveBeenCalledOnce();
    expect(runSubagentAnnounceFlow.mock.calls[0]?.[0]).toMatchObject({
      outcome: { status: "ok" },
      roundOneReply: "Canonical success.",
    });
  });

  it("keeps requester stop delivery suppressed when provider completion wins", async () => {
    const entry = makeProvisionalKilledRunEntry({
      expectsCompletionMessage: true,
      killReconciliation: {
        killedAt: 4_000,
        suppressTaskDelivery: true,
      },
    });
    const runSubagentAnnounceFlow = vi.fn<
      (_params: unknown) => ReturnType<LifecycleControllerParams["runSubagentAnnounceFlow"]>
    >(async () => "delivered");
    const emitSubagentEndedHookForRun = vi.fn(async () => {});
    const controller = createLifecycleController({
      entry,
      runSubagentAnnounceFlow,
      shouldEmitEndedHookForRun: () => true,
      emitSubagentEndedHookForRun,
    });

    await completeRun(controller, entry, {
      endedAt: 4_001,
      triggerCleanup: true,
      terminalReply: { disposition: "visible", text: "final completion reply" },
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

      await controller.completeSubagentRun(
        makeSubagentCompletion(entry, {
          outcome,
          reason,
        }),
      );
      await controller.completeSubagentRun(
        makeKilledSubagentCompletion(entry, {
          endedAt: 4_001,
        }),
      );

      expect(entry.execution.outcome?.status).toBe(outcome.status);
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
      const entry = makeProvisionalKilledRunEntry({
        expectsCompletionMessage: true,
        delivery: {
          status: "delivered",
          announcedAt: 4_000,
          deliveredAt: 4_000,
        },
      });
      const controller = createLifecycleController({ entry });

      await controller.completeSubagentRun(
        makeSubagentCompletion(entry, {
          endedAt: 4_001,
          outcome,
          reason,
        }),
      );

      expect(entry).toMatchObject({
        endedReason: reason,
        execution: { endedAt: 4_001, outcome: { status: outcome.status } },
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
    const entry = makeProvisionalKilledRunEntry();
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

    await completeRun(controller, entry, { endedAt: 4_001, triggerCleanup: true });

    expect(entry).toMatchObject({
      endedReason: SUBAGENT_ENDED_REASON_KILLED,
      execution: {
        endedAt: 4_000,
        outcome: { status: "error", error: "agent run aborted" },
      },
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

    await completeRun(controller, entry, { endedAt: 4_001, triggerCleanup: true });

    expect(entry).toEqual(original);
    expect(taskExecutorMocks.completeTaskRunByRunId).not.toHaveBeenCalled();
  });

  it("keeps cancellation canonical when a custom runtime cannot resolve its task", async () => {
    const entry = makeProvisionalKilledRunEntry();
    const controller = createLifecycleController({
      entry,
      resolveSubagentTask: () => ({ lookup: "unavailable" }),
    });

    await completeRun(controller, entry, { endedAt: 4_001, triggerCleanup: true });

    expect(entry).toMatchObject({
      endedReason: SUBAGENT_ENDED_REASON_KILLED,
      execution: {
        endedAt: 4_000,
        outcome: { status: "error", error: "agent run aborted" },
      },
      suppressAnnounceReason: "killed",
    });
    expect(taskExecutorMocks.completeTaskRunByRunId).toHaveBeenCalledTimes(1);
  });

  it("accepts provider completion when an opaque custom runtime finalizes it", async () => {
    taskExecutorMocks.completeTaskRunByRunId.mockReturnValueOnce([{}]);
    const entry = makeProvisionalKilledRunEntry();
    const controller = createLifecycleController({
      entry,
      resolveSubagentTask: () => ({ lookup: "unavailable" }),
    });

    await completeRun(controller, entry, { endedAt: 4_001 });

    expect(entry).toMatchObject({
      endedReason: SUBAGENT_ENDED_REASON_COMPLETE,
      execution: { endedAt: 4_001, outcome: { status: "ok" } },
    });
    expect(entry.suppressAnnounceReason).toBeUndefined();
    expect(taskExecutorMocks.completeTaskRunByRunId).toHaveBeenCalled();
  });

  it("restores an opaque provisional kill when completion persistence fails", async () => {
    taskExecutorMocks.completeTaskRunByRunId.mockReturnValueOnce([{}]);
    const entry = makeProvisionalKilledRunEntry();
    const original = structuredClone(entry);
    const controller = createLifecycleController({
      entry,
      resolveSubagentTask: () => ({ lookup: "unavailable" }),
      persistOrThrow: vi.fn(() => {
        throw new Error("registry store boom");
      }),
    });

    await expect(completeRun(controller, entry, { endedAt: 4_001 })).rejects.toThrow(
      "registry store boom",
    );

    expect(entry).toEqual(original);
    expect(taskExecutorMocks.completeTaskRunByRunId).toHaveBeenCalledTimes(1);
  });

  it("keeps cancellation that becomes durable during completion capture", async () => {
    const entry = makeProvisionalKilledRunEntry();
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

    const completion = completeRun(controller, entry, { endedAt: 4_001, triggerCleanup: true });
    await waitForLifecycleState(() => expect(captureSubagentCompletionReply).toHaveBeenCalled());
    expect(entry).toMatchObject({
      endedReason: SUBAGENT_ENDED_REASON_KILLED,
      execution: { endedAt: 4_000 },
      killReconciliation: { killedAt: 4_000 },
    });
    expect(entry.completion).toBeUndefined();
    cancellationStable = true;
    finishCapture?.("late success");
    await completion;

    expect(entry).toMatchObject({
      endedReason: SUBAGENT_ENDED_REASON_KILLED,
      execution: {
        endedAt: 4_000,
        outcome: { status: "error", error: "agent run aborted" },
      },
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

    const killed = controller.completeSubagentRun(
      makeKilledSubagentCompletion(entry, {
        triggerCleanup: true,
      }),
    );
    await waitForLifecycleState(() =>
      expect(helperMocks.persistSubagentSessionTiming).toHaveBeenCalled(),
    );

    cancellationStable = true;
    await completeRun(controller, entry, { endedAt: 4_001, triggerCleanup: true });
    finishSessionTiming?.();
    await killed;

    expect(
      browserLifecycleCleanupMocks.cleanupBrowserSessionsForLifecycleEnd,
    ).toHaveBeenCalledTimes(1);
    expect(entry.killReconciliation).toEqual({ killedAt: 4_000 });
  });

  it("accepts a provider result that predates task cancellation", async () => {
    taskExecutorMocks.completeTaskRunByRunId.mockReturnValueOnce([{}]);
    const entry = makeProvisionalKilledRunEntry();
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

    await completeRun(controller, entry, { endedAt: 3_999 });

    expect(entry).toMatchObject({
      endedReason: SUBAGENT_ENDED_REASON_COMPLETE,
      execution: { endedAt: 3_999, outcome: { status: "ok" } },
      cleanupHandled: false,
    });
    expect(entry.suppressAnnounceReason).toBeUndefined();
    expect(taskExecutorMocks.completeTaskRunByRunId).toHaveBeenCalled();
  });

  it("lets an explicit timeout deadline predate accepted task cancellation", async () => {
    taskExecutorMocks.failTaskRunByRunId.mockReturnValueOnce([{}]);
    const entry = makeProvisionalKilledRunEntry({
      runTimeoutSeconds: 3,
      endedAt: 5_500,
      killReconciliation: { killedAt: 5_500 },
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

    await controller.completeSubagentRun(
      makeSubagentCompletion(entry, {
        startedAt: 2_000,
        endedAt: 6_000,
      }),
    );

    expect(entry).toMatchObject({
      endedReason: SUBAGENT_ENDED_REASON_COMPLETE,
      execution: {
        endedAt: 5_000,
        outcome: { status: "timeout", startedAt: 2_000, endedAt: 5_000 },
      },
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
    const entry = makeProvisionalKilledRunEntry({
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
    const runSubagentAnnounceFlow = vi.fn<
      (_params: unknown) => ReturnType<LifecycleControllerParams["runSubagentAnnounceFlow"]>
    >(async () => "delivered");
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

    await completeRun(controller, entry, { endedAt: 3_999, triggerCleanup: true });

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
    const entry = makeProvisionalKilledRunEntry({
      runId: "run-after-replacement",
      killReconciliation: marker,
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

    await completeRun(controller, entry, { endedAt: 3_999 });

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

    await completeRun(controller, entry, { triggerCleanup: true });

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

    await completeRun(controller, entry);

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

    const completion = completeRun(controller, entry, { triggerCleanup: true });
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

    const completion = completeRun(controller, entry, { triggerCleanup: true });
    await waitForLifecycleState(() =>
      expect(helperMocks.persistSubagentSessionTiming).toHaveBeenCalledOnce(),
    );
    const newer = createRunEntry({
      runId: "run-same-millisecond-newer",
      generation: 2,
      createdAt: entry.createdAt,
      startedAt: entry.execution.startedAt,
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

    await completeRun(controller, entry);

    expectFields(firstCallArg(taskExecutorMocks.completeTaskRunByRunId), {
      runId: entry.runId,
      status: undefined,
      progressSummary: "restored final result",
      terminalSummary: null,
    });
  });

  it.each([
    {
      name: "marks required progress-only completions blocked without failing the task",
      reply: "I'll inspect the repo now.",
      terminalOutcome: "blocked",
      terminalSummary:
        "Required completion ended with progress-only text, not a final deliverable.",
    },
    {
      name: "preserves real final completion reports",
      reply: "Fixed the crash and verified the regression tests pass.",
      terminalOutcome: undefined,
      terminalSummary: null,
    },
    {
      name: "keeps required completions successful when final output follows progress text",
      reply: "I'll inspect the repo now. The crash is a missing null check in src/foo.ts.",
      terminalOutcome: undefined,
      terminalSummary: null,
    },
    {
      name: "keeps required completions successful when final output follows a separator",
      reply: "I'll inspect the repo now - the crash is a missing null check in src/foo.ts.",
      terminalOutcome: undefined,
      terminalSummary: null,
    },
    {
      name: "keeps required completions blocked when progress text only adds follow-up planning",
      reply: "I'll inspect the repo now. Then I'll run tests and report back.",
      terminalOutcome: "blocked",
      terminalSummary:
        "Required completion ended with progress-only text, not a final deliverable.",
    },
  ])("$name", async ({ reply, terminalOutcome, terminalSummary }) => {
    const entry = createRunEntry({ expectsCompletionMessage: true });
    await createLifecycleController({
      entry,
      captureSubagentCompletionReply: vi.fn(async () => reply),
    }).completeSubagentRun(
      makeSubagentCompletion(entry, {
        terminalReply: { disposition: "visible", text: reply },
      }),
    );

    const finalArg = firstCallArg(taskExecutorMocks.completeTaskRunByRunId);
    expectFields(finalArg, {
      runId: entry.runId,
      runtime: "subagent",
      sessionKey: entry.childSessionKey,
      progressSummary: reply,
      terminalSummary,
    });
    expect(finalArg.terminalOutcome).toBe(terminalOutcome);
    expect(taskExecutorMocks.failTaskRunByRunId).not.toHaveBeenCalled();
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
        reason: "expiry",
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
    const runSubagentAnnounceFlow = vi.fn(async () => "delivered" as const);

    const controller = createLifecycleController({ entry, persist, runSubagentAnnounceFlow });

    await expect(
      completeRun(controller, entry, {
        triggerCleanup: true,
        terminalReply: { disposition: "visible", text: "final completion reply" },
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

  it.each([
    {
      name: "replacement row",
      installSuccessor: (
        runs: Map<string, SubagentRunRecord>,
        entry: SubagentRunRecord,
        successor: SubagentRunRecord,
      ) => runs.set(entry.runId, successor),
    },
    {
      name: "newer child generation",
      installSuccessor: (
        runs: Map<string, SubagentRunRecord>,
        _entry: SubagentRunRecord,
        successor: SubagentRunRecord,
      ) => runs.set(successor.runId, successor),
    },
  ])("does not dispatch browser cleanup after a $name takes ownership", async (scenario) => {
    const entry = createRunEntry({
      generation: 1,
      createdAt: 1_000,
      execution: { status: "running", startedAt: 2_000 },
    });
    const runs = new Map([[entry.runId, entry]]);
    let releaseBrowserLoader!: () => void;
    let markBrowserLoaderEntered!: () => void;
    const browserLoaderEntered = new Promise<void>((resolve) => {
      markBrowserLoaderEntered = resolve;
    });
    const browserLoaderRelease = new Promise<void>((resolve) => {
      releaseBrowserLoader = resolve;
    });
    const loadCleanupBrowserSessionsForLifecycleEnd = vi.fn(async () => {
      markBrowserLoaderEntered();
      await browserLoaderRelease;
      return browserLifecycleCleanupMocks.cleanupBrowserSessionsForLifecycleEnd;
    });
    const controller = createLifecycleController({
      entry,
      runs,
      cleanupBrowserSessionsForLifecycleEnd: undefined,
      loadCleanupBrowserSessionsForLifecycleEnd,
    });

    const completion = completeRun(controller, entry, { triggerCleanup: true });
    await browserLoaderEntered;
    const successor = createRunEntry({
      runId: scenario.name === "replacement row" ? entry.runId : "run-2",
      childSessionKey: entry.childSessionKey,
      generation: 2,
      createdAt: 5_000,
      execution: { status: "running", startedAt: 5_000 },
    });
    scenario.installSuccessor(runs, entry, successor);
    releaseBrowserLoader();
    await completion;

    expect(
      browserLifecycleCleanupMocks.cleanupBrowserSessionsForLifecycleEnd,
    ).not.toHaveBeenCalled();
    expect(entry.browserCleanupDispatchedAt).toBeUndefined();
    expect(successor.execution).toEqual({ status: "running", startedAt: 5_000 });
  });

  it("rolls back dynamic session-effect suppression when persistence fails", async () => {
    const entry = createRunEntry({
      generation: 1,
      execution: { status: "running", startedAt: 2_000 },
    });
    let releaseBrowserLoader!: () => void;
    let markBrowserLoaderEntered!: () => void;
    const browserLoaderEntered = new Promise<void>((resolve) => {
      markBrowserLoaderEntered = resolve;
    });
    const browserLoaderRelease = new Promise<void>((resolve) => {
      releaseBrowserLoader = resolve;
    });
    const loadCleanupBrowserSessionsForLifecycleEnd = vi.fn(async () => {
      markBrowserLoaderEntered();
      await browserLoaderRelease;
      return browserLifecycleCleanupMocks.cleanupBrowserSessionsForLifecycleEnd;
    });
    const persistOrThrow = vi.fn(() => {
      if (entry.execution.suppressSessionEffects === true) {
        throw new Error("suppression persistence failed");
      }
    });
    const controller = createLifecycleController({
      entry,
      persistOrThrow,
      cleanupBrowserSessionsForLifecycleEnd: undefined,
      loadCleanupBrowserSessionsForLifecycleEnd,
    });

    const completion = completeRun(controller, entry, { triggerCleanup: true });
    await browserLoaderEntered;
    const recoveryReceipt = {
      sessionId: "session-id",
      sessionMarker: "session-id:1",
      idempotencyKey: "recovery-run",
      phase: "accepted" as const,
      lifecycleGeneration: "retired-generation",
    };
    entry.execution = {
      ...entry.execution,
      restartRecovery: recoveryReceipt,
    };
    releaseBrowserLoader();

    await expect(completion).rejects.toThrow("suppression persistence failed");
    expect(entry.execution.restartRecovery).toBe(recoveryReceipt);
    expect(entry.execution.suppressSessionEffects).toBeUndefined();
    expect(entry.browserCleanupDispatchedAt).toBeUndefined();
    expect(
      browserLifecycleCleanupMocks.cleanupBrowserSessionsForLifecycleEnd,
    ).not.toHaveBeenCalled();
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
        return "delivered" as const;
      },
    );

    const controller = createLifecycleController({ entry, persist, runSubagentAnnounceFlow });

    await expect(
      completeRun(controller, entry, {
        triggerCleanup: true,
        terminalReply: { disposition: "visible", text: "final completion reply" },
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

  it.each([
    {
      name: "persists steer_dropped when announce mapping preserves a live-queue refusal",
      delivery: {
        delivered: false as const,
        path: "none" as const,
        reason: "steer_dropped" as const,
      },
      lastDropReason: "steer_dropped",
      lastError: "steer_dropped",
    },
    {
      name: "persists sink_unavailable when announce mapping reports no viable requester",
      delivery: {
        delivered: false as const,
        path: "none" as const,
      },
      lastDropReason: "sink_unavailable",
      lastError: "delivery path none did not complete",
    },
  ])("$name", async ({ delivery, lastDropReason, lastError }) => {
    const persist = vi.fn();
    const entry = createRunEntry({
      endedAt: 4_000,
      expectsCompletionMessage: true,
      retainAttachmentsOnKeep: true,
    });
    const runSubagentAnnounceFlow: LifecycleControllerParams["runSubagentAnnounceFlow"] = vi.fn(
      async (announceParams) => {
        announceParams.onDeliveryResult?.(delivery);
        return "retryable" as const;
      },
    );

    const controller = createLifecycleController({ entry, persist, runSubagentAnnounceFlow });

    await expect(
      completeRun(controller, entry, {
        triggerCleanup: true,
        terminalReply: { disposition: "visible", text: "final completion reply" },
      }),
    ).resolves.toBeUndefined();

    await waitForLifecycleState(() => expect(entry.delivery?.lastDropReason).toBe(lastDropReason));
    expect(entry.delivery?.lastError).toBe(lastError);
    expect(entry.delivery?.status).toBe("suspended");
    expect(persist).toHaveBeenCalledWith(entry.runId);
  });

  it.each([
    {
      name: "persists a newly failed completion",
      previousDropReason: undefined,
      reusePreviousError: false,
      persistCalls: 1,
    },
    {
      name: "persists a changed drop reason when the direct error is unchanged",
      previousDropReason: "sink_unavailable" as const,
      reusePreviousError: true,
      persistCalls: 1,
    },
    {
      name: "does not persist unchanged completion diagnostics",
      previousDropReason: "steer_dropped" as const,
      reusePreviousError: true,
      persistCalls: 0,
    },
  ])("$name before stalled announce bookkeeping settles", async (scenario) => {
    const lastError = "failed; visible_reply_missing; direct-primary: failed";
    const persist = vi.fn();
    const entry = createRunEntry({
      endedAt: 4_000,
      expectsCompletionMessage: true,
      retainAttachmentsOnKeep: true,
      delivery: {
        status: "pending",
        ...(scenario.reusePreviousError ? { lastError } : {}),
        ...(scenario.previousDropReason ? { lastDropReason: scenario.previousDropReason } : {}),
      },
    });
    let releaseAnnounce!: () => void;
    const announcePending = new Promise<void>((resolve) => {
      releaseAnnounce = resolve;
    });
    const runSubagentAnnounceFlow: LifecycleControllerParams["runSubagentAnnounceFlow"] = vi.fn(
      async (announceParams) => {
        const delivery = await runSubagentAnnounceDispatch({
          expectsCompletionMessage: true,
          steer: async () => ({ status: "dropped" }),
          direct: async () => ({
            delivered: false,
            path: "direct",
            error: "failed",
            reason: "visible_reply_missing",
          }),
        });
        persist.mockClear();
        announceParams.onDeliveryResult?.(delivery);
        await announcePending;
        return "retryable" as const;
      },
    );
    const controller = createLifecycleController({ entry, persist, runSubagentAnnounceFlow });

    try {
      await expect(
        completeRun(controller, entry, {
          triggerCleanup: true,
          terminalReply: { disposition: "visible", text: "final completion reply" },
        }),
      ).resolves.toBeUndefined();
      await waitForLifecycleState(() => expect(entry.delivery?.disposition).toBe("retryable"));
      expect(entry.delivery?.lastDropReason).toBe("steer_dropped");
      expect(entry.delivery?.lastError).toBe(lastError);
      expect(entry.cleanupCompletedAt).toBeUndefined();
      expect(persist).toHaveBeenCalledTimes(scenario.persistCalls);
      if (scenario.persistCalls > 0) {
        expect(persist).toHaveBeenCalledWith(entry.runId);
      }
    } finally {
      releaseAnnounce();
    }

    await waitForLifecycleState(() => expect(entry.delivery?.status).toBe("suspended"));
  });

  it("persists identified completion delivery while completing the active multipart send", async () => {
    const persist = vi.fn();
    const entry = createRunEntry({
      expectsCompletionMessage: true,
      delivery: {
        status: "pending",
        lastError: "earlier delivery failed",
        lastDropReason: "sink_unavailable",
        nextAttemptAt: 13_000,
      },
    });
    let releaseAnnounce!: () => void;
    const announcePending = new Promise<void>((resolve) => {
      releaseAnnounce = resolve;
    });
    const sentChunks: number[] = [];
    const runSubagentAnnounceFlow: LifecycleControllerParams["runSubagentAnnounceFlow"] = vi.fn(
      async (announceParams) => {
        for (const chunk of [1, 2, 3]) {
          if (announceParams.isCompletionDeliveryAllowed?.() === false) {
            break;
          }
          sentChunks.push(chunk);
          announceParams.onDeliveryResult?.({
            delivered: true,
            path: "direct",
            deliveredAt: 12_300,
          });
          await Promise.resolve();
        }
        await announcePending;
        return "delivered" as const;
      },
    );
    const controller = createLifecycleController({ entry, persist, runSubagentAnnounceFlow });

    await completeRun(controller, entry, {
      triggerCleanup: true,
      terminalReply: { disposition: "visible", text: "final completion reply" },
    });
    await waitForLifecycleState(() =>
      expect(taskExecutorMocks.setDetachedTaskDeliveryStatusByRunId).toHaveBeenCalledWith({
        runId: entry.runId,
        runtime: "subagent",
        sessionKey: entry.childSessionKey,
        deliveryStatus: "delivered",
        error: undefined,
      }),
    );

    expect(entry.delivery).toMatchObject({
      status: "delivered",
      announcedAt: 12_300,
      deliveredAt: 12_300,
    });
    expect(entry.delivery?.lastError).toBeUndefined();
    expect(entry.delivery?.lastDropReason).toBeUndefined();
    expect(entry.cleanupCompletedAt).toBeUndefined();
    expect(persist).toHaveBeenCalledWith(entry.runId);
    expect.soft(sentChunks).toEqual([1, 2, 3]);

    releaseAnnounce();
    await waitForLifecycleState(() => expect(entry.cleanupCompletedAt).toBeTypeOf("number"));
    expect(entry.delivery?.nextAttemptAt).toBeUndefined();
  });

  it("keeps a late superseded-delivery retirement root-admitted", async () => {
    const entry = createRunEntry({ expectsCompletionMessage: true, generation: 1 });
    const runs = new Map([[entry.runId, entry]]);
    let onDeliveryResult: ((delivery: SubagentAnnounceDeliveryResult) => void) | undefined;
    const runSubagentAnnounceFlow: LifecycleControllerParams["runSubagentAnnounceFlow"] = vi.fn(
      async (announceParams) => {
        onDeliveryResult = announceParams.onDeliveryResult;
        return "delivered" as const;
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

    await completeRun(controller, entry, { triggerCleanup: true });
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
        return "delivered" as const;
      },
    );

    const controller = createLifecycleController({ entry, persist, runSubagentAnnounceFlow });

    await expect(completeRun(controller, entry, { triggerCleanup: true })).resolves.toBeUndefined();

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
    const runSubagentAnnounceFlow = vi.fn(async () => "delivered" as const);

    const controller = createLifecycleController({
      entry,
      persist,
      runSubagentAnnounceFlow,
      captureSubagentCompletionReply: vi.fn(async () => "raw collector result"),
    });

    await expect(completeRun(controller, entry, { triggerCleanup: true })).resolves.toBeUndefined();

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
      requesterTurnRunId: "run-requester",
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

    await completeRun(controller, entry, { triggerCleanup: true });

    await waitForLifecycleState(() => expect(entry.cleanupCompletedAt).toBeTypeOf("number"));
    await waitForLifecycleState(() =>
      expect(gatewayMocks.callGateway).toHaveBeenCalledWith({
        method: "sessions.delete",
        params: {
          key: entry.childSessionKey,
          deleteTranscript: true,
          emitLifecycleHooks: false,
          expectedSessionId: "child-session-id",
          expectedLifecycleRevision: "child-lifecycle-revision",
        },
        timeoutMs: 10_000,
      }),
    );
    await waitForLifecycleState(() =>
      expect(notifyContextEngineSubagentEnded).toHaveBeenCalledWith(
        {
          childSessionKey: entry.childSessionKey,
          reason: "deleted",
          agentDir: entry.agentDir,
          workspaceDir: entry.workspaceDir,
        },
        { isCurrent: expect.any(Function) },
      ),
    );
    expect(helperMocks.safeRemoveAttachmentsDir).toHaveBeenCalledWith(entry);
    expect(runs.get(entry.runId)).toBe(entry);
    expect(entry.collectorCompletion).toEqual({ status: "done" });
    expect(entry.completion?.required).toBe(false);
    expect(entry.requesterSettleWake).toBeUndefined();
    expect(entry.retireAfterRequesterTurn).toBeUndefined();
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

    await controller.completeSubagentRun(
      makeSubagentCompletion(entry, {
        outcome: { status: "error", error: "completed" },
        reason: SUBAGENT_ENDED_REASON_ERROR,
        triggerCleanup: true,
      }),
    );

    await waitForLifecycleState(() => expect(entry.cleanupCompletedAt).toBeTypeOf("number"));
    expect(entry.collectorCompletion).toEqual({ status: "done", structured });
    expect(entry.execution.outcome).toMatchObject({ status: "ok" });
    expect(entry.execution).toMatchObject({
      status: "terminal",
      outcome: expect.objectContaining({ status: "ok" }),
    });
    expect(entry.endedReason).toBe(SUBAGENT_ENDED_REASON_COMPLETE);
  });

  it("preserves the authoritative execution failure after structured output was accepted", async () => {
    const structured = { answer: "yes" };
    const entry = createRunEntry({
      expectsCompletionMessage: false,
      collect: true,
      outputSchema: { type: "object" },
      structuredOutput: { structured, invalidAttempts: 0 },
    });
    const controller = createLifecycleController({ entry });

    await controller.completeSubagentRun(
      makeSubagentCompletion(entry, {
        outcome: { status: "error", error: "provider failed after tool output" },
        reason: SUBAGENT_ENDED_REASON_ERROR,
        triggerCleanup: true,
      }),
    );

    await waitForLifecycleState(() => expect(entry.cleanupCompletedAt).toBeTypeOf("number"));
    expect(entry.execution.outcome).toMatchObject({
      status: "error",
      error: "provider failed after tool output",
    });
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

    await completeRun(controller, entry, { triggerCleanup: true });

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
    const runSubagentAnnounceFlow = vi.fn(async () => "delivered" as const);

    const controller = createLifecycleController({
      entry,
      runs,
      persist,
      runSubagentAnnounceFlow,
    });

    await expect(completeRun(controller, entry, { triggerCleanup: true })).resolves.toBeUndefined();

    await waitForLifecycleState(() =>
      expect(gatewayMocks.callGateway).toHaveBeenCalledWith({
        method: "sessions.delete",
        params: {
          key: entry.childSessionKey,
          deleteTranscript: true,
          emitLifecycleHooks: true,
          expectedSessionId: "child-session-id",
          expectedLifecycleRevision: "child-lifecycle-revision",
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
      startedAt: entry.execution.startedAt,
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

    await expect(completeRun(controller, entry, { triggerCleanup: true })).resolves.toBeUndefined();

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

    await expect(completeRun(controller, entry, { triggerCleanup: true })).resolves.toBeUndefined();

    expect(bundleMcpRuntimeMocks.retireSessionMcpRuntimeForSessionKey).not.toHaveBeenCalled();
  });

  it("enriches registered-run outcomes with persisted timing before cleanup", async () => {
    const persist = vi.fn();
    const runSubagentAnnounceFlow = vi.fn(async () => "delivered" as const);
    const entry = createRunEntry({
      startedAt: 2_000,
      expectsCompletionMessage: true,
    });

    const controller = createLifecycleController({ entry, persist, runSubagentAnnounceFlow });

    await expect(
      completeRun(controller, entry, {
        endedAt: 4_250,
        outcome: { status: "timeout" },
        triggerCleanup: true,
      }),
    ).resolves.toBeUndefined();

    const enrichedOutcome = {
      status: "timeout" as const,
      startedAt: 2_000,
      endedAt: 4_250,
      elapsedMs: 2_250,
    };
    expect(entry.execution.outcome).toEqual(enrichedOutcome);
    expectFields(firstCallArg(taskExecutorMocks.failTaskRunByRunId), { status: "timed_out" });
    expectFields(firstCallArg(runSubagentAnnounceFlow), {
      startedAt: 2_000,
      endedAt: 4_250,
      outcome: enrichedOutcome,
    });
    expect(persist).toHaveBeenCalled();
  });

  it("does not wait for a completion reply when the run does not expect one", async () => {
    const entry = createRunEntry({
      expectsCompletionMessage: false,
      execution: {
        status: "running",
        transcriptTarget: {
          agentId: "main",
          sessionId: "child-session",
          sessionKey: "agent:main:subagent:child",
          storePath: "/tmp/openclaw/agents/main/sessions/sessions.json",
        },
      },
    });
    const captureSubagentCompletionReply = vi.fn(async () => undefined);

    const controller = createLifecycleController({
      entry,
      captureSubagentCompletionReply,
      runSubagentAnnounceFlow: vi.fn(async () => "retryable" as const),
    });

    await expect(completeRun(controller, entry)).resolves.toBeUndefined();

    expect(captureSubagentCompletionReply).toHaveBeenCalledWith(entry.childSessionKey, {
      waitForReply: false,
      sessionTarget: entry.execution?.transcriptTarget,
      outcome: {
        status: "ok",
        startedAt: 2_000,
        endedAt: 4_000,
        elapsedMs: 2_000,
      },
    });
  });

  it("scopes fallback completion capture to the incognito child store", async () => {
    const childSessionKey = "agent:main:subagent:incognito-child";
    const durableStorePath = "/tmp/durable-sessions.json";
    const entry = createRunEntry({
      childSessionKey,
      expectsCompletionMessage: false,
      execution: {
        status: "running",
        transcriptTarget: {
          agentId: "main",
          sessionId: "incognito-child-session",
          sessionKey: childSessionKey,
        },
      },
    });
    const captureSubagentCompletionReply = vi.fn(async () => undefined);
    const controller = createLifecycleController({
      entry,
      captureSubagentCompletionReply,
      getRuntimeConfig: () => ({ session: { store: durableStorePath } }),
      runSubagentAnnounceFlow: vi.fn(async () => "retryable" as const),
    });

    await controller.completeSubagentRun(makeSubagentCompletion(entry));

    expect(captureSubagentCompletionReply).toHaveBeenCalledWith(
      childSessionKey,
      expect.objectContaining({
        sessionTarget: {
          agentId: "main",
          sessionId: "incognito-child-session",
          sessionKey: childSessionKey,
          storePath: resolveSessionStorePathForScope({
            agentId: "main",
            sessionKey: childSessionKey,
            storePath: durableStorePath,
          }),
        },
      }),
    );
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
      controller.completeSubagentRun(
        makeSubagentCompletion(entry, {
          outcome: { status: "error", error: "All models failed (2): timeout" },
        }),
      ),
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
    const runSubagentAnnounceFlow = vi.fn(async () => "delivered" as const);
    const notifyContextEngineSubagentEnded = vi.fn(async () => {});

    const controller = createLifecycleController({
      entry,
      persist,
      notifyContextEngineSubagentEnded,
      runSubagentAnnounceFlow,
    });

    await expect(completeRun(controller, entry, { triggerCleanup: true })).resolves.toBeUndefined();

    expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
    expect(typeof entry.cleanupCompletedAt).toBe("number");
    expect(entry.cleanupCompletedAt).toBeGreaterThanOrEqual(4_000);
    expect(notifyContextEngineSubagentEnded).toHaveBeenCalledWith(
      {
        childSessionKey: entry.childSessionKey,
        reason: "completed",
        agentDir: entry.agentDir,
        workspaceDir: entry.workspaceDir,
      },
      { isCurrent: expect.any(Function) },
    );
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

    await expect(completeRun(controller, entry, { triggerCleanup: true })).resolves.toBeUndefined();

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

    const completion = completeRun(controller, entry, { triggerCleanup: true });
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
      reason: "expiry",
    });

    expect(entry.cleanupCompletedAt).toBeTypeOf("number");
    expect(Number.isNaN(entry.cleanupCompletedAt)).toBe(false);
  });

  it.each([
    { name: "original window", required: true, redriven: false, replaced: false },
    { name: "explicit retry window", required: true, redriven: true, replaced: false },
    { name: "retired owner", required: true, redriven: false, replaced: true },
    { name: "optional completion window", required: false, redriven: false, replaced: false },
  ])(
    "bounds a pending completion handoff by its $name",
    async ({ required, redriven, replaced }) => {
      vi.useFakeTimers();
      vi.setSystemTime(2_000_000);
      const deadlineAt = Date.now() + (redriven ? 3_000 : 1_000);
      const entry = createRunEntry({
        endedAt: Date.now() - (required ? 30 : 5) * 60_000 + 1_000,
        endedReason: SUBAGENT_ENDED_REASON_COMPLETE,
        expectsCompletionMessage: required ? true : undefined,
        completion: { required, resultText: "final answer" },
        delivery: {
          status: "pending",
          ...(redriven ? { windowStartedAt: Date.now(), deadlineAt } : {}),
        },
        outcome: { status: "ok" },
        retainAttachmentsOnKeep: true,
      });
      const pendingHandoff = createDeferredCore<AnnounceFlowOutcome>();
      let deliverySignal: AbortSignal | undefined;
      const runSubagentAnnounceFlow = vi.fn<LifecycleControllerParams["runSubagentAnnounceFlow"]>(
        (params) => {
          deliverySignal = params.signal;
          params.signal?.addEventListener(
            "abort",
            () => pendingHandoff.reject(params.signal?.reason),
            {
              once: true,
            },
          );
          return pendingHandoff.promise;
        },
      );
      const runs = new Map([[entry.runId, entry]]);
      const controller = createLifecycleController({ entry, runs, runSubagentAnnounceFlow });
      try {
        expect(controller.startSubagentAnnounceCleanupFlow(entry.runId, entry)).toBe(true);
        await waitForLifecycleState(() => expect(runSubagentAnnounceFlow).toHaveBeenCalledOnce());
        const successor = replaced ? createRunEntry({ runId: entry.runId }) : undefined;
        if (successor) {
          runs.set(entry.runId, successor);
        }

        await vi.advanceTimersByTimeAsync(deadlineAt - Date.now() - 1);
        expect(entry.delivery?.status).toBe("pending");
        expect(completionDeliveryMocks.blockSubagentCompletionDelivery).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);

        expect(deliverySignal?.aborted).toBe(true);
        await waitForLifecycleState(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
        if (successor) {
          expect(runs.get(entry.runId)).toBe(successor);
          expect(completionDeliveryMocks.blockSubagentCompletionDelivery).not.toHaveBeenCalled();
        } else if (!required) {
          expect(entry.delivery?.status).toBe("failed");
          expect(entry.cleanupCompletedAt).toBeTypeOf("number");
          expect(completionDeliveryMocks.blockSubagentCompletionDelivery).not.toHaveBeenCalled();
        } else {
          expect(entry.delivery?.status).toBe("suspended");
          expect(entry.delivery?.suspendedReason).toBe("expiry");
          expect(entry.completion?.resultText).toBe("final answer");
          expect(entry.cleanupHandled).toBe(false);
          expect(entry.cleanupCompletedAt).toBeUndefined();
        }
      } finally {
        pendingHandoff.resolve("retryable");
        await vi.advanceTimersByTimeAsync(0);
        controller.clearScheduledResumeTimers();
        vi.useRealTimers();
      }
    },
  );

  it("suspends successful keep-mode final delivery after its deadline", async () => {
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
      reason: "expiry",
    });

    expect(entry.delivery?.status).toBe("suspended");
    expect(entry.completion?.resultText).toBe("final answer");
    expect(entry.delivery?.suspendedAt).toBeTypeOf("number");
    expect(entry.delivery?.suspendedReason).toBe("expiry");
    expect(entry.cleanupHandled).toBe(false);
    expect(entry.cleanupCompletedAt).toBeUndefined();
    expect(helperMocks.safeRemoveAttachmentsDir).not.toHaveBeenCalled();
    expect(completionDeliveryMocks.blockSubagentCompletionDelivery).toHaveBeenCalledWith({
      subagent: entry,
      taskId: "",
      reason: "gateway request timeout for agent",
      suspendedReason: "expiry",
    });
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
        reason: "expiry",
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

    await expect(completeRun(controller, entry, { triggerCleanup: true })).resolves.toBeUndefined();

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
        return "retryable" as const;
      },
    );

    const controller = createLifecycleController({
      entry,
      persist,
      runSubagentAnnounceFlow,
    });

    await expect(
      completeRun(controller, entry, {
        triggerCleanup: true,
        terminalReply: { disposition: "visible", text: "final completion reply" },
      }),
    ).resolves.toBeUndefined();

    expect(completionDeliveryMocks.blockSubagentCompletionDelivery).toHaveBeenCalledWith({
      subagent: entry,
      taskId: "",
      reason:
        "UNAVAILABLE: requester wake failed; direct-primary: UNAVAILABLE: requester wake failed",
      suspendedReason: "expiry",
    });
    expect(entry.delivery?.lastError).toBe(
      "UNAVAILABLE: requester wake failed; direct-primary: UNAVAILABLE: requester wake failed",
    );
    expect(entry.delivery?.status).toBe("suspended");
    expect(entry.delivery?.suspendedAt).toBeTypeOf("number");
    expect(entry.delivery?.suspendedReason).toBe("expiry");
    expect(entry.cleanupCompletedAt).toBeUndefined();
    expect(persist).toHaveBeenCalled();
  });

  it.each([
    { waitingOn: "announce", outcome: "intentional_non_delivery" },
    { waitingOn: "announce", outcome: "retryable" },
    { waitingOn: "mirror", outcome: "intentional_non_delivery" },
    { waitingOn: "mirror", outcome: "retryable" },
    { waitingOn: "active-send", outcome: "delivered" },
    { waitingOn: "delivered-mirror", outcome: "retryable" },
  ] as const)(
    "preserves requester-settle delivery while $outcome cleanup awaits $waitingOn",
    async ({ waitingOn, outcome }) => {
      const entry = createRunEntry({
        endedAt: Date.now(),
        outcome: { status: "timeout" },
        requesterTurnRunId: "run-requester",
        expectsCompletionMessage: true,
        retainAttachmentsOnKeep: true,
        completion: { required: true, resultText: "child timed out" },
        delivery: { status: "pending", attemptCount: 1 },
      });
      entry.delivery!.payload = loadPendingFinalDeliveryPayload(entry);
      const announce = createDeferredCore();
      const mirror = createDeferredCore<{ messages: unknown[] }>();
      const runSubagentAnnounceFlow = vi.fn<LifecycleControllerParams["runSubagentAnnounceFlow"]>(
        async (params) => {
          if (waitingOn === "active-send") {
            params.onDeliveryResult?.({ delivered: true, path: "direct", deliveredAt: 12_345 });
          }
          await announce.promise;
          if (waitingOn === "active-send") {
            return outcome;
          }
          params.onDeliveryResult?.({
            delivered: false,
            path: "direct",
            error: "completion agent did not produce a visible reply",
            disposition: outcome,
          });
          return outcome;
        },
      );
      gatewayMocks.callGateway.mockImplementation(() => mirror.promise);
      const controller = createLifecycleController({
        entry,
        runSubagentAnnounceFlow,
        maybeWakeRequesterAfterAllChildrenSettled: async (params) => {
          params.completeBatch([entry], entry.requesterSettleWake?.rearmGeneration, {
            delivered: true,
            path: "direct",
            deliveredAt: 12_345,
            requesterVisibleFinalDelivered: true,
          });
          return true;
        },
      });

      try {
        expect(controller.startSubagentAnnounceCleanupFlow(entry.runId, entry)).toBe(true);
        await waitForLifecycleState(() => expect(runSubagentAnnounceFlow).toHaveBeenCalledOnce());
        if (waitingOn === "mirror" || waitingOn === "delivered-mirror") {
          announce.resolve();
          await waitForLifecycleState(() =>
            expect(gatewayMocks.callGateway).toHaveBeenCalledWith(
              expect.objectContaining({ method: "chat.history" }),
            ),
          );
        }
        const announceParams = runSubagentAnnounceFlow.mock.calls[0]![0];
        expect(announceParams.isCompletionDeliveryAllowed?.()).toBe(true);
        entry.requesterTurnYielded = true;
        expect(
          controller.settleRequesterTurnAfterSessionSpawns({
            requesterSessionKey: entry.requesterSessionKey,
            requesterTurnRunId: "run-requester",
            requesterYielded: true,
            acceptedSessionSpawns: [{ runId: entry.runId, childSessionKey: entry.childSessionKey }],
          }),
        ).toBe(true);
        await waitForLifecycleState(() => expect(entry.delivery?.status).toBe("delivered"));
        expect.soft(entry.delivery).toMatchObject({ payload: undefined, attemptCount: undefined });
        expect(entry.requesterSettleWake).toBeUndefined();
        expect(announceParams.isCompletionOwnedByRequesterYield?.()).toBe(false);
        expect.soft(announceParams.isCompletionDeliveryAllowed?.()).toBe(false);

        announce.resolve();
        mirror.resolve({
          messages:
            waitingOn === "delivered-mirror"
              ? [
                  {
                    role: "assistant",
                    provider: "openclaw",
                    model: "delivery-mirror",
                    timestamp: 12_300,
                    idempotencyKey: buildExpectedAnnounceIdempotencyKey(entry),
                    content: "child timed out",
                  },
                ]
              : [],
        });
        await waitForLifecycleState(() => expect(entry.cleanupCompletedAt).toBeTypeOf("number"));
        expect(entry.delivery).toMatchObject({
          status: "delivered",
          disposition: "delivered",
          deliveredAt: 12_345,
          announcedAt: 12_345,
          payload: undefined,
          lastError: undefined,
          attemptCount: undefined,
        });
        expect(taskExecutorMocks.setDetachedTaskDeliveryStatusByRunId).toHaveBeenLastCalledWith({
          runId: entry.runId,
          runtime: "subagent",
          sessionKey: entry.childSessionKey,
          deliveryStatus: "delivered",
          error: undefined,
        });
      } finally {
        announce.resolve();
        mirror.resolve({ messages: [] });
        await waitForLifecycleState(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
        controller.clearScheduledResumeTimers();
      }
    },
  );

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
    expect(completionDeliveryMocks.blockSubagentCompletionDelivery).toHaveBeenCalledWith({
      subagent: staleEntry,
      taskId: "",
      reason: "completion agent did not produce a visible reply",
      suspendedReason: "expiry",
    });
    expect(helperMocks.logAnnounceGiveUp).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: staleEntry.runId,
        requesterSessionKey: staleEntry.requesterSessionKey,
      }),
      "expiry",
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
    const runSubagentAnnounceFlow = vi.fn(async () => "delivered" as const);

    const controller = createLifecycleController({
      entry,
      suppressAnnounceForSteerRestart: () => true,
      runSubagentAnnounceFlow,
    });

    await expect(completeRun(controller, entry, { triggerCleanup: true })).resolves.toBeUndefined();

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
    const runSubagentAnnounceFlow = vi.fn(async () => "delivered" as const);

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

  it("does not apply a queued interrupted completion to a same-id successor", async () => {
    const entry = createRunEntry({
      generation: 1,
      expectsCompletionMessage: false,
    });
    const runs = new Map([[entry.runId, entry]]);
    const successor = createRunEntry({
      generation: 2,
      createdAt: 5_000,
      execution: { status: "running", startedAt: 5_000 },
    });
    const controller = createLifecycleController({ entry, runs });
    let releaseFirstCleanup!: () => void;
    let markFirstCleanupEntered!: () => void;
    const firstCleanupEntered = new Promise<void>((resolve) => {
      markFirstCleanupEntered = resolve;
    });
    const firstCleanupRelease = new Promise<void>((resolve) => {
      releaseFirstCleanup = resolve;
    });
    browserLifecycleCleanupMocks.cleanupBrowserSessionsForLifecycleEnd.mockImplementationOnce(
      async () => {
        markFirstCleanupEntered();
        await firstCleanupRelease;
      },
    );

    const firstCompletion = controller.completeSubagentRun(
      makeSubagentCompletion(entry, {
        triggerCleanup: true,
      }),
    );
    await firstCleanupEntered;
    const staleRecovery = controller.completeSubagentRun(
      makeInterruptedSubagentCompletion(entry, {
        expectedEntry: entry,
        endedAt: 4_001,
        outcome: { status: "error", error: "stale interrupted recovery" },
        triggerCleanup: true,
      }),
    );
    runs.set(entry.runId, successor);

    releaseFirstCleanup();
    await Promise.all([firstCompletion, staleRecovery]);

    expect(runs.get(entry.runId)).toBe(successor);
    expect(successor.execution).toEqual({ status: "running", startedAt: 5_000 });
    expect(successor.endedReason).toBeUndefined();
    expect(successor.terminalOwner).toBeUndefined();
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
    const runSubagentAnnounceFlow = vi.fn(async () => "delivered" as const);
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
      terminalReply: { disposition: "visible" as const, text: "final completion reply" },
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
    expect(entry.execution.endedAt).toBe(4_000);
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
    const runSubagentAnnounceFlow = vi.fn<
      (_params: unknown) => ReturnType<LifecycleControllerParams["runSubagentAnnounceFlow"]>
    >(async () => "delivered");
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
    mockBlockedCompletionDeliveryOwner();
    helperMocks.safeRemoveAttachmentsDir.mockClear();
    helperMocks.logAnnounceGiveUp.mockClear();
    taskExecutorMocks.setDetachedTaskDeliveryStatusByRunId.mockClear();
    bundleMcpRuntimeMocks.retireSessionMcpRuntimeForSessionKey.mockReset().mockResolvedValue(true);
    internalSessionEffectsMocks.removeInternalSessionEffectsSession
      .mockReset()
      .mockResolvedValue(undefined);
  });

  it("runs a detached settle wake outside a disposed requester transcript owner", async () => {
    const sessionKey = "agent:main:disposed-settle-wake-owner";
    const entry = createRunEntry({ requesterSessionKey: sessionKey, endedAt: 4_000 });
    let disposed = false;
    let releaseWake!: () => void;
    const wakeReady = new Promise<void>((resolve) => {
      releaseWake = resolve;
    });
    const requesterTranscriptWrite = vi.fn();
    const withRequesterTranscriptWrite = async <T>(operation: () => Promise<T> | T): Promise<T> => {
      requesterTranscriptWrite();
      if (disposed) {
        throw new Error("attempt disposed before transcript write");
      }
      return await operation();
    };
    const freshTranscriptWrite = vi.fn(async () => {});
    const settleWake = vi.fn(async () => {
      await wakeReady;
      await runWithOwnedSessionTranscriptWrite({ sessionKey }, freshTranscriptWrite);
      return false;
    });
    const controller = createLifecycleController({
      entry,
      maybeWakeRequesterAfterAllChildrenSettled: settleWake,
    });

    await withOwnedSessionTranscriptWrites(
      { sessionKey, withTranscriptWrite: withRequesterTranscriptWrite },
      async () => {
        controller.completeCleanupBookkeeping({
          runId: entry.runId,
          entry,
          cleanup: "keep",
          completedAt: 5_000,
        });
      },
    );

    disposed = true;
    releaseWake();

    await waitForLifecycleState(() => expect(freshTranscriptWrite).toHaveBeenCalledOnce());
    expect(requesterTranscriptWrite).not.toHaveBeenCalled();
    expect(settleWake).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: "replacement row",
      installSuccessor: (
        runs: Map<string, SubagentRunRecord>,
        entry: SubagentRunRecord,
        successor: SubagentRunRecord,
      ) => runs.set(entry.runId, successor),
    },
    {
      name: "newer child generation",
      installSuccessor: (
        runs: Map<string, SubagentRunRecord>,
        _entry: SubagentRunRecord,
        successor: SubagentRunRecord,
      ) => runs.set(successor.runId, successor),
    },
  ])("drops detached cleanup tails after a $name takes ownership", async (scenario) => {
    const entry = makeRunModeCleanupEntry("internal-run-1", {
      generation: 1,
      createdAt: 1_000,
      cleanup: "keep",
      execution: {
        startedAt: 2_000,
        outcome: { status: "ok" },
      },
    });
    const runs = new Map([[entry.runId, entry]]);
    const notifyContextEngineSubagentEnded = vi.fn(async () => {});
    const controller = createLifecycleController({
      entry,
      runs,
      notifyContextEngineSubagentEnded,
    });
    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension).not.toBeNull();
    expect(suspension?.commit()).toBe(true);

    controller.completeCleanupBookkeeping({
      runId: entry.runId,
      entry,
      cleanup: "keep",
      completedAt: 5_000,
      skipRequesterSettleWake: true,
    });
    const successor = createRunEntry({
      runId: scenario.name === "replacement row" ? entry.runId : "run-2",
      childSessionKey: entry.childSessionKey,
      generation: 2,
      createdAt: 6_000,
      execution: { status: "running", startedAt: 6_000 },
    });
    scenario.installSuccessor(runs, entry, successor);
    expect(suspension?.release()).toBe(true);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    await waitForLifecycleState(() => expect(getActiveGatewayRootWorkCount()).toBe(0));

    expect(internalSessionEffectsMocks.removeInternalSessionEffectsSession).not.toHaveBeenCalled();
    expect(bundleMcpRuntimeMocks.retireSessionMcpRuntimeForSessionKey).not.toHaveBeenCalled();
    expect(notifyContextEngineSubagentEnded).not.toHaveBeenCalled();
    expect(successor.execution).toEqual({ status: "running", startedAt: 6_000 });
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
      batch: readonly SubagentRunRecord[],
    ) => void;
    completeBatch([entry]);
    expect(runs.has(entry.runId)).toBe(false);
  });

  it("emits cleanup effects when settle retirement wins before detached tails start", async () => {
    const entry = makeRunModeCleanupEntry("internal-settle-retirement");
    const transcriptTarget = entry.execution.transcriptTarget;
    const runs = new Map([[entry.runId, entry]]);
    const notifyContextEngineSubagentEnded = vi.fn(async () => {});
    const settleWake = vi.fn(async () => false);
    const controller = createLifecycleController({
      entry,
      runs,
      maybeWakeRequesterAfterAllChildrenSettled: settleWake,
      notifyContextEngineSubagentEnded,
    });
    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension).not.toBeNull();
    expect(suspension?.commit()).toBe(true);

    controller.completeCleanupBookkeeping({
      runId: entry.runId,
      entry,
      cleanup: "delete",
      completedAt: 5_000,
    });

    expect(entry.requesterSettleWake?.retireAfterSettle).toBe(true);
    runs.delete(entry.runId);
    expect(suspension?.release()).toBe(true);
    await waitForLifecycleState(() => {
      expect(
        internalSessionEffectsMocks.removeInternalSessionEffectsSession,
      ).toHaveBeenCalledOnce();
      expect(bundleMcpRuntimeMocks.retireSessionMcpRuntimeForSessionKey).toHaveBeenCalledOnce();
      expect(notifyContextEngineSubagentEnded).toHaveBeenCalledOnce();
    });
    expect(internalSessionEffectsMocks.removeInternalSessionEffectsSession).toHaveBeenCalledWith(
      transcriptTarget,
    );
  });

  it("drops settle-retirement effects when a newer child generation takes ownership", async () => {
    const entry = makeRunModeCleanupEntry("internal-settle-retired-generation", {
      generation: 1,
    });
    const runs = new Map([[entry.runId, entry]]);
    const notifyContextEngineSubagentEnded = vi.fn(async () => {});
    const controller = createLifecycleController({
      entry,
      runs,
      maybeWakeRequesterAfterAllChildrenSettled: vi.fn(async () => false),
      notifyContextEngineSubagentEnded,
    });
    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension).not.toBeNull();
    expect(suspension?.commit()).toBe(true);

    controller.completeCleanupBookkeeping({
      runId: entry.runId,
      entry,
      cleanup: "delete",
      completedAt: 5_000,
    });
    runs.delete(entry.runId);
    const successor = createRunEntry({
      runId: "run-settle-successor",
      childSessionKey: entry.childSessionKey,
      generation: 2,
      createdAt: 6_000,
      execution: { status: "running", startedAt: 6_000 },
    });
    runs.set(successor.runId, successor);
    expect(suspension?.release()).toBe(true);
    await waitForLifecycleState(() => expect(getActiveGatewayRootWorkCount()).toBe(0));

    expect(internalSessionEffectsMocks.removeInternalSessionEffectsSession).not.toHaveBeenCalled();
    expect(bundleMcpRuntimeMocks.retireSessionMcpRuntimeForSessionKey).not.toHaveBeenCalled();
    expect(notifyContextEngineSubagentEnded).not.toHaveBeenCalled();
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
          params.completeBatch([first]);
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

  it("does not resume a persisted settle wake until its registry row is terminal", async () => {
    const entry = createRunEntry({
      requesterSettleWake: { status: "pending", attemptCount: 0 },
    });
    const settleWake = vi.fn(async () => false);
    const controller = createLifecycleController({
      entry,
      maybeWakeRequesterAfterAllChildrenSettled: settleWake,
    });

    controller.resumeRequesterSettleWake(entry.runId, entry);
    await Promise.resolve();
    expect(settleWake).not.toHaveBeenCalled();

    entry.execution = { ...entry.execution, status: "terminal", endedAt: 4_000 };
    controller.resumeRequesterSettleWake(entry.runId, entry);

    await waitForLifecycleState(() => expect(settleWake).toHaveBeenCalledOnce());
  });

  it("keeps a yielded completion parked until its requester turn settles", async () => {
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
        params.completeBatch([entry], entry.requesterSettleWake?.rearmGeneration);
        return true;
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

    await Promise.resolve();
    expect(settleWake).not.toHaveBeenCalled();

    controller.settleRequesterTurnAfterSessionSpawns({
      requesterSessionKey: entry.requesterSessionKey,
      requesterTurnRunId: "run-requester",
      requesterYielded: true,
      acceptedSessionSpawns: [{ runId: entry.runId, childSessionKey: entry.childSessionKey }],
    });

    await waitForLifecycleState(() => expect(settleWake).toHaveBeenCalledOnce());
    expect(entry.requesterSettleWake).toBeUndefined();
  });

  it.each([
    "unbound",
    "closed-receipt",
    "closed-in-flight",
    "throwing-in-flight",
    "closed-rearmed",
  ] as const)(
    "credits a yielded handoff only from settled delivery evidence: %s",
    async (ownership) => {
      const entry = createRunEntry({
        endedAt: 4_000,
        expectsCompletionMessage: true,
        requesterSettleWake: {
          status: "pending",
          attemptCount: 0,
          requesterYieldBatch: true,
          rearmGeneration: 1,
        },
      });
      let gatewayOpen = true;
      const gatewayContext = {};
      if (ownership !== "unbound") {
        bindGatewayContextResolver(entry, () => {
          if (!gatewayOpen && ownership === "throwing-in-flight") {
            throw new Error("Gateway owner unavailable");
          }
          return gatewayOpen ? (gatewayContext as never) : undefined;
        });
      }
      let settleParams:
        | Parameters<LifecycleControllerParams["maybeWakeRequesterAfterAllChildrenSettled"]>[0]
        | undefined;
      const maybeWakeRequesterAfterAllChildrenSettled = vi.fn(async (params) => {
        settleParams = params;
        return false;
      });
      const runSubagentAnnounceFlow: LifecycleControllerParams["runSubagentAnnounceFlow"] = vi.fn(
        async (announceParams) => {
          announceParams.onDeliveryResult?.({
            delivered: false,
            path: "none",
            reason: "completion_handoff_pending",
            terminal: true,
            disposition: "intentional_non_delivery",
          });
          return "intentional_non_delivery" as const;
        },
      );
      const controller = createLifecycleController({
        entry,
        maybeWakeRequesterAfterAllChildrenSettled,
        runSubagentAnnounceFlow,
      });

      await completeRun(controller, entry, {
        triggerCleanup: true,
        terminalReply: { disposition: "empty" },
      });
      await waitForLifecycleState(() =>
        expect(maybeWakeRequesterAfterAllChildrenSettled).toHaveBeenCalledOnce(),
      );
      expect(entry.delivery).toMatchObject({
        status: "pending",
        disposition: "intentional_non_delivery",
        lastError: "completion_handoff_pending",
      });
      expect(entry.delivery?.deliveredAt).toBeUndefined();
      expect(taskExecutorMocks.setDetachedTaskDeliveryStatusByRunId).toHaveBeenCalledWith(
        expect.objectContaining({ deliveryStatus: "pending" }),
      );

      gatewayOpen = false;
      if (ownership === "closed-rearmed") {
        entry.requesterSettleWake!.rearmGeneration = 2;
      }
      const pendingWake = structuredClone(entry.requesterSettleWake);
      settleParams?.completeBatch([entry], 1, {
        delivered: true,
        path: "direct",
        deliveredAt: 8_000,
        ...(ownership === "closed-receipt" || ownership === "closed-rearmed"
          ? { requesterVisibleFinalDelivered: true as const }
          : {}),
      });
      if (ownership.endsWith("in-flight") || ownership === "closed-rearmed") {
        expect(entry.delivery?.status).toBe("pending");
        expect(entry.requesterSettleWake).toEqual(pendingWake);
        return;
      }

      expect(entry.delivery).toMatchObject({
        status: "delivered",
        disposition: "delivered",
        deliveredAt: 8_000,
        announcedAt: 8_000,
      });
      expect(taskExecutorMocks.setDetachedTaskDeliveryStatusByRunId).toHaveBeenCalledWith(
        expect.objectContaining({ deliveryStatus: "delivered" }),
      );
    },
  );

  it("records suppressed completion delivery without retrying or waking the requester", async () => {
    const entry = createRunEntry({ endedAt: 4_000, expectsCompletionMessage: true });
    const maybeWakeRequesterAfterAllChildrenSettled = vi.fn(async () => false);
    const runSubagentAnnounceFlow: LifecycleControllerParams["runSubagentAnnounceFlow"] = vi.fn(
      async (announceParams) => {
        announceParams.onDeliveryResult?.({
          delivered: false,
          path: "direct",
          reason: "delivery_suppressed",
          error: "cancelled_by_message_sending_hook",
          terminal: true,
          disposition: "intentional_non_delivery",
        });
        return "intentional_non_delivery" as const;
      },
    );
    const controller = createLifecycleController({
      entry,
      maybeWakeRequesterAfterAllChildrenSettled,
      runSubagentAnnounceFlow,
    });

    await completeRun(controller, entry, {
      triggerCleanup: true,
      terminalReply: { disposition: "visible", text: "Generated completion" },
    });
    await waitForLifecycleState(() => expect(entry.cleanupCompletedAt).toBeDefined());

    expect(entry.delivery).toMatchObject({
      status: "failed",
      disposition: "intentional_non_delivery",
      lastError: "cancelled_by_message_sending_hook; delivery_suppressed",
    });
    expect(entry.delivery?.deliveredAt).toBeUndefined();
    expect(entry.delivery?.nextAttemptAt).toBeUndefined();
    expect(taskExecutorMocks.setDetachedTaskDeliveryStatusByRunId).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryStatus: "failed",
        error: "cancelled_by_message_sending_hook; delivery_suppressed",
      }),
    );
    expect(maybeWakeRequesterAfterAllChildrenSettled).not.toHaveBeenCalled();
  });

  it("does not transfer a partial batch after a suppressed delete-mode child retires", async () => {
    const entry = createRunEntry({
      runId: "suppressed-child",
      requesterTurnRunId: "requester-turn",
      cleanup: "delete",
      expectsCompletionMessage: true,
    });
    const sibling = createRunEntry({
      runId: "remaining-child",
      childSessionKey: "agent:main:subagent:remaining",
      requesterTurnRunId: "requester-turn",
      requesterTurnYielded: true,
      expectsCompletionMessage: true,
      endedAt: 4_000,
      delivery: { status: "delivered" },
    });
    const runs = new Map([entry, sibling].map((child) => [child.runId, child]));
    const acceptedSessionSpawns = [entry, sibling].map((child) => ({
      runId: child.runId,
      childSessionKey: child.childSessionKey,
      expectsCompletionMessage: true,
    }));
    const persistOrThrow = vi.fn();
    const settleWake = vi.fn(async () => false);
    const controller = createLifecycleController({
      entry,
      runs,
      persistOrThrow,
      maybeWakeRequesterAfterAllChildrenSettled: settleWake,
      runSubagentAnnounceFlow: async (params) => {
        params.onDeliveryResult?.({
          delivered: false,
          path: "direct",
          reason: "delivery_suppressed",
          error: "cancelled_by_message_sending_hook",
          terminal: true,
          disposition: "intentional_non_delivery",
        });
        return "intentional_non_delivery";
      },
    });
    await completeRun(controller, entry, {
      triggerCleanup: true,
      terminalReply: { disposition: "visible", text: "Suppressed child result" },
    });
    await waitForLifecycleState(() => expect(runs.has(entry.runId)).toBe(false));
    expect(entry.delivery?.status).toBe("failed");
    const before = structuredClone(runs);
    persistOrThrow.mockClear();
    expect(
      controller.settleRequesterTurnAfterSessionSpawns({
        requesterSessionKey: entry.requesterSessionKey,
        requesterTurnRunId: "requester-turn",
        requesterYielded: true,
        acceptedSessionSpawns,
      }),
    ).toBe(false);
    expect(runs).toEqual(before);
    expect(persistOrThrow).not.toHaveBeenCalled();
    expect(settleWake).not.toHaveBeenCalled();
  });

  it("marks yielded intentional non-delivery blocked after requester-settle exhaustion", async () => {
    const entry = createRunEntry({
      endedAt: 4_000,
      expectsCompletionMessage: true,
      requesterSettleWake: {
        status: "pending",
        attemptCount: 0,
        requesterYieldBatch: true,
        rearmGeneration: 1,
      },
    });
    let settleParams:
      | Parameters<LifecycleControllerParams["maybeWakeRequesterAfterAllChildrenSettled"]>[0]
      | undefined;
    const maybeWakeRequesterAfterAllChildrenSettled = vi.fn(async (params) => {
      settleParams = params;
      return false;
    });
    const runSubagentAnnounceFlow: LifecycleControllerParams["runSubagentAnnounceFlow"] = vi.fn(
      async (announceParams) => {
        announceParams.onDeliveryResult?.({
          delivered: false,
          path: "none",
          reason: "completion_handoff_pending",
          terminal: true,
          disposition: "intentional_non_delivery",
        });
        return "intentional_non_delivery" as const;
      },
    );
    let pendingDescendantRuns = 0;
    const controller = createLifecycleController({
      entry,
      maybeWakeRequesterAfterAllChildrenSettled,
      runSubagentAnnounceFlow,
      countPendingDescendantRuns: () => pendingDescendantRuns,
    });

    await completeRun(controller, entry, {
      triggerCleanup: true,
      terminalReply: { disposition: "empty" },
    });
    await waitForLifecycleState(() =>
      expect(maybeWakeRequesterAfterAllChildrenSettled).toHaveBeenCalledOnce(),
    );
    settleParams?.completeBatch([entry], 1, {
      delivered: false,
      path: "none",
      error: "requester settle wake attempts exhausted",
    });

    expect(entry.delivery).toMatchObject({
      status: "failed",
      disposition: "intentional_non_delivery",
      lastError: "requester settle wake attempts exhausted",
    });
    expect(completionDeliveryMocks.blockSubagentCompletionDelivery).toHaveBeenCalledWith({
      subagent: entry,
      taskId: "",
      reason: "requester settle wake attempts exhausted",
      disposition: undefined,
    });
    expect(entry.suppressCompletionDelivery).toBe(true);

    entry.cleanupCompletedAt = undefined;
    entry.cleanupHandled = false;
    entry.wakeOnDescendantSettle = true;
    vi.mocked(runSubagentAnnounceFlow).mockClear();
    taskExecutorMocks.setDetachedTaskDeliveryStatusByRunId.mockClear();

    pendingDescendantRuns = 1;
    expect(controller.startSubagentAnnounceCleanupFlow(entry.runId, entry)).toBe(true);
    expect(entry.cleanupCompletedAt).toBeUndefined();
    expect(entry.suppressCompletionDelivery).toBe(true);
    expect(entry.wakeOnDescendantSettle).toBe(true);
    expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();

    pendingDescendantRuns = 0;
    expect(controller.startSubagentAnnounceCleanupFlow(entry.runId, entry)).toBe(true);
    await waitForLifecycleState(() => expect(entry.cleanupCompletedAt).toEqual(expect.any(Number)));

    expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
    expect(entry.suppressCompletionDelivery).toBeUndefined();
    expect(entry.wakeOnDescendantSettle).toBeUndefined();
    expect(entry.requesterSettleWake).toBeUndefined();
    expect(hasDeliveredTaskStatusUpdate(entry.runId)).toBe(false);
  });

  it("keeps committed blocked state when requester-settle bookkeeping persistence fails", async () => {
    const entry = createRunEntry({
      endedAt: 4_000,
      expectsCompletionMessage: true,
      requesterSettleWake: { status: "pending", attemptCount: 0, rearmGeneration: 1 },
    });
    let settleParams:
      | Parameters<LifecycleControllerParams["maybeWakeRequesterAfterAllChildrenSettled"]>[0]
      | undefined;
    const persistOrThrow = vi.fn();
    const controller = createLifecycleController({
      entry,
      persistOrThrow,
      maybeWakeRequesterAfterAllChildrenSettled: vi.fn(async (params) => {
        settleParams = params;
        return false;
      }),
      runSubagentAnnounceFlow: vi.fn(async () => "intentional_non_delivery" as const),
    });
    await completeRun(controller, entry, {
      triggerCleanup: true,
      terminalReply: { disposition: "empty" },
    });
    await waitForLifecycleState(() => expect(settleParams).toBeDefined());
    persistOrThrow.mockImplementationOnce(() => {
      throw new Error("bookkeeping write failed");
    });

    expect(() =>
      settleParams?.completeBatch([entry], 1, {
        delivered: false,
        path: "none",
        error: "requester settle wake failed",
      }),
    ).toThrow("bookkeeping write failed");
    expect(entry).toMatchObject({
      delivery: { status: "failed", lastError: "requester settle wake failed" },
      suppressCompletionDelivery: true,
      requesterSettleWake: { status: "pending", attemptCount: 0, rearmGeneration: 1 },
    });
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
        params.completeBatch([entry]);
        return false;
      },
    );
    const runSubagentAnnounceFlow = vi.fn(async () => "delivered" as const);
    const controller = createLifecycleController({
      entry,
      runs,
      maybeWakeRequesterAfterAllChildrenSettled: settleWake,
      runSubagentAnnounceFlow,
    });

    await completeRun(controller, entry, { triggerCleanup: true });
    await Promise.resolve();

    // The child cannot wake its requester while that exact requester turn owns it.
    expect(entry.completion?.resultText).toBe("delete-mode findings");
    expect(runs.has(entry.runId)).toBe(true);
    expect(entry.requesterSettleWake).toMatchObject({
      status: "pending",
      retireAfterSettle: true,
    });
    expect(entry.retireAfterRequesterTurn).toBeUndefined();
    expect(settleWake).not.toHaveBeenCalled();

    controller.settleRequesterTurnAfterSessionSpawns({
      requesterSessionKey: entry.requesterSessionKey,
      requesterTurnRunId: "run-requester",
      requesterYielded: false,
      acceptedSessionSpawns: [{ runId: entry.runId, childSessionKey: entry.childSessionKey }],
    });
    await waitForLifecycleState(() => expect(settleWake).toHaveBeenCalledTimes(1));

    expect(settleWake).toHaveBeenCalledWith(
      expect.objectContaining({
        settledEntry: expect.objectContaining({
          runId: entry.runId,
          completion: expect.objectContaining({ resultText: "delete-mode findings" }),
        }),
      }),
    );
    expect(runs.has(entry.runId)).toBe(false);
  });

  it.each([false, undefined])(
    "retires delete cleanup immediately without a completion message: %s",
    async (expectsCompletionMessage) => {
      const entry = createRunEntry({
        requesterTurnRunId: "run-requester",
        cleanup: "delete",
        expectsCompletionMessage,
        completion: { required: false, resultText: "delete-mode findings" },
      });
      const runs = new Map([[entry.runId, entry]]);
      const settleWake = vi.fn(
        async (params: { completeBatch: (batch: readonly SubagentRunRecord[]) => void }) => {
          params.completeBatch([entry]);
          return false;
        },
      );
      const runSubagentAnnounceFlow = vi.fn(async () => "delivered" as const);
      const controller = createLifecycleController({
        entry,
        runs,
        maybeWakeRequesterAfterAllChildrenSettled: settleWake,
        runSubagentAnnounceFlow,
      });

      await completeRun(controller, entry, { triggerCleanup: true });
      await waitForLifecycleState(() => expect(settleWake).toHaveBeenCalledTimes(1));
      expect(runs.has(entry.runId)).toBe(false);

      expect(entry.completion?.resultText).toBe("delete-mode findings");
      expect(runs.get(entry.runId)?.requesterSettleWake).toBeUndefined();
      expect(entry.retireAfterRequesterTurn).toBeUndefined();
    },
  );

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
      batch: readonly SubagentRunRecord[],
    ) => void;
    completeBatch([entry]);
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

  it("restores a suspended delete row without cleanup effects when retirement fails", () => {
    const entry = makeRunModeCleanupEntry("internal-failed-retirement", {
      delivery: {
        status: "discarded",
        discardedAt: 5_000,
        discardReason: "expired",
      },
    });
    const deferredEntry = createRunEntry({
      runId: "run-2",
      childSessionKey: "agent:main:subagent:deferred-child",
      endedAt: 4_000,
      expectsCompletionMessage: true,
    });
    const runs = new Map([
      [entry.runId, entry],
      [deferredEntry.runId, deferredEntry],
    ]);
    const resumeSubagentRun = vi.fn();
    const notifyContextEngineSubagentEnded = vi.fn(async () => {});
    const controller = createLifecycleController({
      entry,
      runs,
      resumeSubagentRun,
      notifyContextEngineSubagentEnded,
      persistOrThrow: vi.fn(() => {
        throw new Error("registry deletion failed");
      }),
    });

    expect(() =>
      controller.completeCleanupBookkeeping({
        runId: entry.runId,
        entry,
        cleanup: "delete",
        completedAt: 5_000,
        skipRequesterSettleWake: true,
      }),
    ).toThrow("registry deletion failed");

    expect(runs.get(entry.runId)).toBe(entry);
    expect(resumeSubagentRun).not.toHaveBeenCalled();
    expect(internalSessionEffectsMocks.removeInternalSessionEffectsSession).not.toHaveBeenCalled();
    expect(bundleMcpRuntimeMocks.retireSessionMcpRuntimeForSessionKey).not.toHaveBeenCalled();
    expect(notifyContextEngineSubagentEnded).not.toHaveBeenCalled();
  });

  it("emits cleanup effects once after immediate retirement commits", async () => {
    const entry = makeRunModeCleanupEntry("internal-successful-retirement");
    const transcriptTarget = entry.execution.transcriptTarget;
    const runs = new Map([[entry.runId, entry]]);
    const notifyContextEngineSubagentEnded = vi.fn(async () => {});
    const persistOrThrow = vi.fn();
    const controller = createLifecycleController({
      entry,
      runs,
      notifyContextEngineSubagentEnded,
      persistOrThrow,
    });

    controller.completeCleanupBookkeeping({
      runId: entry.runId,
      entry,
      cleanup: "delete",
      completedAt: 5_000,
      skipRequesterSettleWake: true,
    });

    expect(persistOrThrow).toHaveBeenCalledOnce();
    expect(runs.has(entry.runId)).toBe(false);
    await waitForLifecycleState(() => {
      expect(
        internalSessionEffectsMocks.removeInternalSessionEffectsSession,
      ).toHaveBeenCalledOnce();
      expect(bundleMcpRuntimeMocks.retireSessionMcpRuntimeForSessionKey).toHaveBeenCalledOnce();
      expect(notifyContextEngineSubagentEnded).toHaveBeenCalledOnce();
    });
    expect(internalSessionEffectsMocks.removeInternalSessionEffectsSession).toHaveBeenCalledWith(
      transcriptTarget,
    );
  });

  it("drops immediate-retirement effects after a newer child generation takes ownership", async () => {
    const entry = makeRunModeCleanupEntry("internal-retired-generation", {
      generation: 1,
    });
    const runs = new Map([[entry.runId, entry]]);
    const notifyContextEngineSubagentEnded = vi.fn(async () => {});
    const controller = createLifecycleController({
      entry,
      runs,
      notifyContextEngineSubagentEnded,
    });
    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension).not.toBeNull();
    expect(suspension?.commit()).toBe(true);

    controller.completeCleanupBookkeeping({
      runId: entry.runId,
      entry,
      cleanup: "delete",
      completedAt: 5_000,
      skipRequesterSettleWake: true,
    });
    const successor = createRunEntry({
      runId: "run-successor",
      childSessionKey: entry.childSessionKey,
      generation: 2,
      createdAt: 6_000,
      execution: { status: "running", startedAt: 6_000 },
    });
    runs.set(successor.runId, successor);
    expect(suspension?.release()).toBe(true);
    await waitForLifecycleState(() => expect(getActiveGatewayRootWorkCount()).toBe(0));

    expect(internalSessionEffectsMocks.removeInternalSessionEffectsSession).not.toHaveBeenCalled();
    expect(bundleMcpRuntimeMocks.retireSessionMcpRuntimeForSessionKey).not.toHaveBeenCalled();
    expect(notifyContextEngineSubagentEnded).not.toHaveBeenCalled();
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
          params.transitionBatch([entry], {
            status: "pending",
            attemptCount: 0,
            nextAttemptAt: 30_000,
            batchRunIds: [entry.runId],
          });
        } else {
          params.completeBatch([entry]);
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
      controller.resumeRequesterSettleWake(entry.runId, entry);
      controller.resumeRequesterSettleWake(entry.runId, entry);
      expect(vi.getTimerCount()).toBe(1);

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

  it("lets a fresh yield wake preempt a stale retry timer", async () => {
    const entry = createRunEntry({
      endedAt: 4_000,
      expectsCompletionMessage: true,
      delivery: { status: "delivered" },
      requesterSettleWake: {
        status: "pending",
        attemptCount: 1,
        nextAttemptAt: 120_000,
        rearmGeneration: 1,
      },
    });
    const settleWake = vi.fn(
      async (
        params: Parameters<
          LifecycleControllerParams["maybeWakeRequesterAfterAllChildrenSettled"]
        >[0],
      ) => {
        params.completeBatch([entry], entry.requesterSettleWake?.rearmGeneration);
        return true;
      },
    );
    const controller = createLifecycleController({
      entry,
      maybeWakeRequesterAfterAllChildrenSettled: settleWake,
    });

    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      controller.resumeRequesterSettleWake(entry.runId, entry);
      expect(vi.getTimerCount()).toBe(1);

      entry.requesterTurnRunId = "run-requester";
      entry.requesterTurnYielded = true;
      expect(
        controller.settleRequesterTurnAfterSessionSpawns({
          requesterSessionKey: entry.requesterSessionKey,
          requesterTurnRunId: "run-requester",
          requesterYielded: true,
          acceptedSessionSpawns: [{ runId: entry.runId, childSessionKey: entry.childSessionKey }],
        }),
      ).toBe(true);
      await vi.advanceTimersByTimeAsync(0);

      expect(settleWake).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(settleWake).toHaveBeenCalledOnce();
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
      reason: "expiry",
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
    const completeBatch = firstCallArg(settleWake).completeBatch as NonNullable<
      Parameters<LifecycleControllerParams["maybeWakeRequesterAfterAllChildrenSettled"]>[0]
    >["completeBatch"];
    completeBatch([entry], undefined, {
      delivered: true,
      path: "direct",
    });
    expect(entry.delivery?.status).toBe("suspended");
    expect(hasDeliveredTaskStatusUpdate(entry.runId)).toBe(false);
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
      reason: "expiry",
    });

    expect(entry.delivery?.status).toBe("failed");
    expect(entry.cleanupCompletedAt).toBeTypeOf("number");
    expect(settleWake).toHaveBeenCalledTimes(1);
  });

  it("settles bookkeeping after a wake rejects before attempt admission", async () => {
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

    await waitForLifecycleState(() => {
      expect(warn).toHaveBeenCalledWith("requester settle wake failed", expect.anything());
    });
    expect(entry.requesterSettleWake).toBeUndefined();
  });

  it.each(["yielded", "replacement"])(
    "preserves a newer %s batch when an admitted wake rejects",
    async (kind) => {
      const entry = createRunEntry({
        endedAt: 4_000,
        expectsCompletionMessage: true,
        delivery: { status: "delivered" },
      });
      const admittedWake = createDeferredCore<boolean>();
      const runs = new Map([[entry.runId, entry]]);
      const warn = vi.fn();
      let wakeCount = 0;
      const settleWake = vi.fn(
        async (
          params: Parameters<
            LifecycleControllerParams["maybeWakeRequesterAfterAllChildrenSettled"]
          >[0],
        ) => {
          wakeCount += 1;
          if (wakeCount === 1) {
            return await admittedWake.promise;
          }
          params.completeBatch(
            [params.settledEntry],
            params.settledEntry.requesterSettleWake?.rearmGeneration,
            {
              delivered: true,
              path: "direct",
            },
          );
          return true;
        },
      );
      const controller = createLifecycleController({
        entry,
        runs,
        warn,
        maybeWakeRequesterAfterAllChildrenSettled: settleWake,
      });

      controller.completeCleanupBookkeeping({
        runId: entry.runId,
        entry,
        cleanup: "keep",
        completedAt: 5_000,
      });
      await waitForLifecycleState(() => expect(settleWake).toHaveBeenCalledOnce());

      let current = entry;
      if (kind === "replacement") {
        current = structuredClone(entry);
        runs.set(entry.runId, current);
      } else {
        entry.requesterTurnRunId = "run-requester";
        entry.requesterTurnYielded = true;
        expect(
          controller.settleRequesterTurnAfterSessionSpawns({
            requesterSessionKey: entry.requesterSessionKey,
            requesterTurnRunId: "run-requester",
            requesterYielded: true,
            acceptedSessionSpawns: [{ runId: entry.runId, childSessionKey: entry.childSessionKey }],
          }),
        ).toBe(true);
        expect(entry.requesterSettleWake).toMatchObject({
          requesterYieldBatch: true,
          afterRequesterYield: true,
          rearmGeneration: 1,
        });
      }

      admittedWake.reject(new Error("wake exploded"));
      await waitForLifecycleState(() =>
        expect(warn).toHaveBeenCalledWith("requester settle wake failed", expect.anything()),
      );
      if (kind === "replacement") {
        expect(current.requesterSettleWake).toEqual(entry.requesterSettleWake);
        expect(current.requesterSettleWake).toBeDefined();
        controller.resumeRequesterSettleWake(current.runId, current);
      }
      await waitForLifecycleState(() => expect(settleWake).toHaveBeenCalledTimes(2));
      await waitForLifecycleState(() => expect(current.requesterSettleWake).toBeUndefined());
    },
  );

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
      expect(getActiveGatewayRootWorkCount()).toBe(1);

      releaseWake?.();
      await waitForLifecycleState(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
    } finally {
      resetGatewayWorkAdmission();
    }
  });

  it.each([false, true])(
    "reserves Gateway roots before the limiter (queued row replaced: %s)",
    async (replaceQueued) => {
      resetGatewayWorkAdmission();
      const entries = [0, 1, 2].map((index) =>
        createRunEntry({
          runId: `run-restored-admission-${index}`,
          requesterSessionKey: `agent:main:requester-${index}`,
          endedAt: 4_000,
          requesterSettleWake: { status: "pending", attemptCount: 2 },
        }),
      );
      const runs = new Map(entries.map((entry) => [entry.runId, entry] as const));
      const releases = new Map<SubagentRunRecord, () => void>();
      const settleWake = vi.fn(
        (params: RequesterSettleWakeParams) =>
          new Promise<boolean>((resolve) => {
            releases.set(params.settledEntry, () => {
              params.completeBatch(
                [params.settledEntry],
                params.settledEntry.requesterSettleWake?.rearmGeneration,
              );
              resolve(false);
            });
          }),
      );
      const controller = createLifecycleController({
        entry: entries[0]!,
        runs,
        maybeWakeRequesterAfterAllChildrenSettled: settleWake,
      });

      try {
        await runWithGatewayIndependentRootWorkAdmission(async () => {
          for (const entry of entries) {
            controller.resumeRequesterSettleWake(entry.runId, entry, "restore");
          }
        });
        await waitForLifecycleState(() => expect(settleWake).toHaveBeenCalledTimes(2));
        // The third callback is queued behind the two wake executions, but its
        // Gateway root is already reserved and therefore visible to drain.
        expect(getActiveGatewayRootWorkCount()).toBe(3);
        expect(getActiveGatewayRootWorkHolders()).toEqual(["subagents:lifecycle-wake (3)"]);
        const queued = entries[2]!;
        const current = replaceQueued ? structuredClone(queued) : queued;
        if (replaceQueued) {
          runs.set(current.runId, current);
          controller.resumeRequesterSettleWake(current.runId, current, "restore");
        }
        markGatewayRestartDraining();
        expect(getActiveGatewayRootWorkCount()).toBe(replaceQueued ? 4 : 3);
        releases.get(entries[0]!)?.();
        await waitForLifecycleState(() => expect(settleWake).toHaveBeenCalledTimes(3));
        expect(settleWake.mock.calls[2]![0].settledEntry).toBe(current);
        await waitForLifecycleState(() => expect(getActiveGatewayRootWorkCount()).toBe(2));
        expect(current.requesterSettleWake).toEqual({ status: "pending", attemptCount: 2 });
        controller.resumeRequesterSettleWake(current.runId, current, "restore");
        expect(settleWake).toHaveBeenCalledTimes(3);

        releases.get(current)?.();
        await waitForLifecycleState(() => expect(current.requesterSettleWake).toBeUndefined());
        expect(entries[1]!.requesterSettleWake).toBeDefined();
        releases.get(entries[1]!)?.();
        await waitForLifecycleState(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
        if (replaceQueued) {
          expect(queued.requesterSettleWake).toEqual({ status: "pending", attemptCount: 2 });
        }
      } finally {
        while (releases.size > 0) {
          const pending = Array.from(releases.values());
          releases.clear();
          pending.forEach((release) => release());
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
        }
        controller.clearScheduledResumeTimers();
        resetGatewayWorkAdmission();
      }
    },
  );

  it("does not throttle live requester-settle wakes", async () => {
    resetGatewayWorkAdmission();
    const entries = [0, 1, 2].map((index) =>
      createRunEntry({
        runId: `run-live-admission-${index}`,
        requesterSessionKey: `agent:main:live-requester-${index}`,
        endedAt: 4_000,
      }),
    );
    const runs = new Map(entries.map((entry) => [entry.runId, entry] as const));
    const releases = new Map<string, () => void>();
    const settleWake = vi.fn(
      (params: RequesterSettleWakeParams) =>
        new Promise<boolean>((resolve) => {
          releases.set(params.settledEntry.runId, () => {
            params.completeBatch(
              [params.settledEntry],
              params.settledEntry.requesterSettleWake?.rearmGeneration,
            );
            resolve(false);
          });
        }),
    );
    const controller = createLifecycleController({
      entry: entries[0]!,
      runs,
      maybeWakeRequesterAfterAllChildrenSettled: settleWake,
    });

    try {
      for (const entry of entries) {
        controller.resumeRequesterSettleWake(entry.runId, entry);
      }
      await waitForLifecycleState(() => expect(settleWake).toHaveBeenCalledTimes(3));
    } finally {
      for (const release of releases.values()) {
        release();
      }
      await waitForLifecycleState(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
      controller.clearScheduledResumeTimers();
      resetGatewayWorkAdmission();
    }
  });

  it("retires restored classification after a rejected wake settles", async () => {
    resetGatewayWorkAdmission();
    const entries = [0, 1, 2].map((index) =>
      createRunEntry({
        runId: `run-restored-rejection-${index}`,
        requesterSessionKey: `agent:main:rejection-requester-${index}`,
        endedAt: 4_000,
        requesterSettleWake: { status: "pending", attemptCount: 0 },
      }),
    );
    const rejected = entries[0]!;
    const runs = new Map(entries.map((entry) => [entry.runId, entry] as const));
    const attempts = new Map<string, number>();
    const releases = new Map<string, () => void>();
    const settleWake = vi.fn((params: RequesterSettleWakeParams) => {
      const runId = params.settledEntry.runId;
      const attempt = (attempts.get(runId) ?? 0) + 1;
      attempts.set(runId, attempt);
      if (runId === rejected.runId && attempt === 1) {
        return Promise.reject(new Error("wake exploded"));
      }
      return new Promise<boolean>((resolve) => {
        releases.set(runId, () => {
          params.completeBatch(
            [params.settledEntry],
            params.settledEntry.requesterSettleWake?.rearmGeneration,
          );
          resolve(false);
        });
      });
    });
    const controller = createLifecycleController({
      entry: rejected,
      runs,
      maybeWakeRequesterAfterAllChildrenSettled: settleWake,
    });

    try {
      for (const entry of entries) {
        controller.resumeRequesterSettleWake(entry.runId, entry, "restore");
      }
      await waitForLifecycleState(() => expect(settleWake).toHaveBeenCalledTimes(3));
      await waitForLifecycleState(() => expect(rejected.requesterSettleWake).toBeUndefined());

      rejected.requesterSettleWake = { status: "pending", attemptCount: 0 };
      controller.resumeRequesterSettleWake(rejected.runId, rejected);
      await waitForLifecycleState(() => expect(settleWake).toHaveBeenCalledTimes(4));
    } finally {
      while (releases.size > 0) {
        const pending = Array.from(releases.values());
        releases.clear();
        pending.forEach((release) => release());
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
      }
      await waitForLifecycleState(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
      controller.clearScheduledResumeTimers();
      resetGatewayWorkAdmission();
    }
  });

  it("keeps restored requester-settle retries behind the recovery cap", async () => {
    resetGatewayWorkAdmission();
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const entries = [0, 1, 2].map((index) =>
      createRunEntry({
        runId: `run-restored-retry-${index}`,
        requesterSessionKey: `agent:main:retry-requester-${index}`,
        endedAt: 4_000,
        requesterSettleWake: { status: "pending", attemptCount: 0 },
      }),
    );
    const runs = new Map(entries.map((entry) => [entry.runId, entry] as const));
    const attempts = new Map<string, number>();
    const releases: Array<() => void> = [];
    let active = 0;
    let maxActive = 0;
    const settleWake = vi.fn(
      (params: RequesterSettleWakeParams) =>
        new Promise<boolean>((resolve) => {
          const runId = params.settledEntry.runId;
          const attempt = (attempts.get(runId) ?? 0) + 1;
          attempts.set(runId, attempt);
          active += 1;
          maxActive = Math.max(maxActive, active);
          releases.push(() => {
            if (attempt === 1) {
              params.transitionBatch([params.settledEntry], {
                status: "pending",
                attemptCount: 1,
                nextAttemptAt: 100,
                batchRunIds: [runId],
              });
            } else {
              params.completeBatch(
                [params.settledEntry],
                params.settledEntry.requesterSettleWake?.rearmGeneration,
              );
            }
            active -= 1;
            resolve(false);
          });
        }),
    );
    const controller = createLifecycleController({
      entry: entries[0]!,
      runs,
      maybeWakeRequesterAfterAllChildrenSettled: settleWake,
    });

    try {
      for (const entry of entries) {
        controller.resumeRequesterSettleWake(entry.runId, entry, "restore");
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(settleWake).toHaveBeenCalledTimes(2);
      expect(maxActive).toBe(2);
      releases.splice(0, 2).forEach((release) => release());
      await vi.advanceTimersByTimeAsync(0);
      expect(settleWake).toHaveBeenCalledTimes(3);
      releases.shift()?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(entries.map((entry) => entry.requesterSettleWake?.nextAttemptAt)).toEqual([
        100, 100, 100,
      ]);
      expect(vi.getTimerCount()).toBe(3);

      await vi.advanceTimersByTimeAsync(100);
      expect(settleWake).toHaveBeenCalledTimes(5);
      expect(maxActive).toBe(2);
      releases.splice(0, 2).forEach((release) => release());
      await vi.advanceTimersByTimeAsync(0);
      expect(settleWake).toHaveBeenCalledTimes(6);
      releases.shift()?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(active).toBe(0);
      expect(maxActive).toBe(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        releases.splice(0).forEach((release) => release());
        await vi.runOnlyPendingTimersAsync();
      }
      controller.clearScheduledResumeTimers();
      vi.useRealTimers();
      resetGatewayWorkAdmission();
    }
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
