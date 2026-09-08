import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
// Tests active reply run registry add, lookup, and cleanup behavior.
import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { QuestionAnswerUnconfirmedError } from "../../agents/harness/gateway-question-dispatch.js";
import { createAgentRunRestartAbortError } from "../../agents/run-termination.js";
import { attachToolAllowlistIntersection } from "../../agents/tool-policy.js";
import {
  getDiagnosticSessionActivitySnapshot,
  markDiagnosticEmbeddedRunStarted,
  resetDiagnosticRunActivityForTest,
  RUN_STALE_TAKEOVER_MS,
} from "../../logging/diagnostic-run-activity.js";
import { markDiagnosticModelStartedForTest } from "../../logging/diagnostic-run-activity.test-support.js";
import { diagnosticLogger } from "../../logging/diagnostic-runtime.js";
import { enqueueCommandInLane, setCommandLaneConcurrency } from "../../process/command-queue.js";
import { resetCommandQueueStateForTest } from "../../process/command-queue.test-support.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { createTestUserTurnTranscriptTarget } from "../../sessions/user-turn-transcript.test-support.js";
import { createQueueTestRun } from "./queue.test-helpers.js";
import { beginReplyOperationFinalizationWork } from "./reply-run-finalization-lease.js";
import type { ReplyToolAuthorityOverlay } from "./reply-run-registry.contracts.js";
import {
  abortActiveReplyRuns,
  beginReplyMessageInjectionTarget,
  createReplyOperation,
  expireStaleReplyOperation,
  forceClearReplyOperation,
  forceClearReplyRunBySessionId,
  hasCommittedReplyOperationOutcome,
  isReplyRunEvidenceStale,
  isReplyRunActiveForSessionId,
  isReplyRunAbortableForCompaction,
  isReplyRunAbortableForSignal,
  interruptReplyRunTarget,
  clearReplyRunForResetBySessionId,
  REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS,
  REPLY_RUN_TERMINAL_SETTLE_TIMEOUT_MS,
  registerReplyOperationSuccessorBarrier,
  type ReplyBackendQueueMessageOptions,
  type ReplyOperation,
  ReplyRunAlreadyActiveError,
  ReplyRunSuccessorAdmissionBlockedError,
  replyRunRegistry,
  markReplyOperationGlobalLaneWaitProgress,
  runAfterReplyOperationClear,
  resolveActiveReplyRunSessionId,
  resolveActiveReplyOperationForSessionId,
  supersedeReplyRunByRunId,
  waitForReplyOperationOwnerSettlement,
  waitForReplyRunEndBySessionId,
  waitForReplyRunSuccessorAdmission,
} from "./reply-run-registry.js";
import { lifecycleAdmissionByOperation } from "./reply-run-registry.state.js";
import { testing } from "./reply-run-registry.test-support.js";
import {
  prepareReplyToolAuthority,
  resolveFollowupRunToolAuthorityFingerprint,
} from "./reply-tool-authority.js";
import { admitReplyTurn } from "./reply-turn-admission.js";

const REPLY_RUN_FINALIZATION_SETTLE_TIMEOUT_MS = 60_000;

function createTestReplyOperation(
  overrides: Partial<Parameters<typeof createReplyOperation>[0]> = {},
) {
  return createReplyOperation({
    sessionKey: "agent:main:main",
    sessionId: "session-1",
    resetTriggered: false,
    ...overrides,
  });
}

function toolAuthorityOverlay(
  run: ReturnType<typeof createQueueTestRun>,
): ReplyToolAuthorityOverlay {
  return {
    permissionMode: run.run.permissionMode,
    toolOverrides: run.run.toolOverrides,
    originatingChannel: run.originatingChannel,
    messageProvider: run.run.messageProvider,
    chatType: run.run.chatType,
    agentAccountId: run.run.agentAccountId,
    conversationToolPolicy: run.run.conversationToolPolicy,
    groupId: run.run.groupId,
    groupChannel: run.run.groupChannel,
    groupSpace: run.run.groupSpace,
    memberRoleIds: run.run.memberRoleIds,
    spawnedBy: run.run.spawnedBy,
    senderId: run.run.senderId,
    senderName: run.run.senderName,
    senderUsername: run.run.senderUsername,
    senderE164: run.run.senderE164,
    senderIsOwner: run.run.senderIsOwner === true,
    inputProvenance: run.run.inputProvenance,
    trustedInternalHandoff: run.run.trustedInternalHandoff,
    scheduledToolPolicy: run.run.scheduledToolPolicy,
    runtimePluginToolGrant: run.run.runtimePluginToolGrant,
    toolsAllow: run.toolsAllow,
    disableTools: run.disableTools === true,
    traceAuthorized: run.run.traceAuthorized === true,
    approvalReviewerDeviceId: run.run.approvalReviewerDeviceId,
    clientCaps: run.run.clientCaps,
    toolBindings: run.run.toolBindings,
  };
}

async function queueCurrentReplyRunMessage(
  sessionId: string,
  text: string,
  options?: Parameters<typeof beginReplyMessageInjectionTarget>[2],
) {
  const operation = resolveActiveReplyOperationForSessionId(sessionId);
  const target = operation
    ? replyRunRegistry.resolveCurrentMessageInjectionTarget(operation.key)
    : undefined;
  return target
    ? await queueReplyMessageInjectionTarget(target, text, options)
    : { status: "rejected" as const, reason: "injection_unavailable" as const };
}

async function queueReplyMessageInjectionTarget(
  ...args: Parameters<typeof beginReplyMessageInjectionTarget>
) {
  return await beginReplyMessageInjectionTarget(...args).outcome;
}

async function withFakeReplyTimers<T>(run: () => Promise<T>): Promise<T> {
  vi.useFakeTimers();
  try {
    return await run();
  } finally {
    await vi.runOnlyPendingTimersAsync();
    vi.useRealTimers();
  }
}

describe("reply run registry", () => {
  it.each(["agent:agent:main", "global"])(
    "distinguishes hidden allowlist intersections in steering authority for %s",
    (sessionKey) => {
      const first = createQueueTestRun({ prompt: "first" });
      const second = createQueueTestRun({ prompt: "second" });
      for (const run of [first, second]) {
        run.run.sessionKey = sessionKey;
        run.run.config = { agents: { ownership: "explicit", entries: { agent: {}, other: {} } } };
      }
      first.toolsAllow = attachToolAllowlistIntersection(["exec"], [["exec"]]);
      second.toolsAllow = attachToolAllowlistIntersection(["exec"], [["exec"], ["message"]]);

      expect(resolveFollowupRunToolAuthorityFingerprint(first)).not.toBe(
        resolveFollowupRunToolAuthorityFingerprint(second),
      );
    },
  );

  it("distinguishes session permission and tool settings in steering authority", () => {
    const full = createQueueTestRun({ prompt: "full authority" });
    const guarded = createQueueTestRun({ prompt: "guarded authority" });
    full.run.permissionMode = "full";
    guarded.run.permissionMode = "guarded";
    expect(resolveFollowupRunToolAuthorityFingerprint(full)).not.toBe(
      resolveFollowupRunToolAuthorityFingerprint(guarded),
    );

    guarded.run.permissionMode = "full";
    guarded.run.toolOverrides = { webSearch: false };
    expect(resolveFollowupRunToolAuthorityFingerprint(full)).not.toBe(
      resolveFollowupRunToolAuthorityFingerprint(guarded),
    );
  });

  it.each([
    {
      label: "provider",
      first: { provider: "openai", model: "gpt-test" },
      second: { provider: "anthropic", model: "gpt-test" },
    },
    {
      label: "model",
      first: { provider: "openai", model: "gpt-primary" },
      second: { provider: "openai", model: "gpt-fallback" },
    },
  ])("distinguishes the concrete $label route in steering authority", ({ first, second }) => {
    const run = createQueueTestRun({ prompt: "route authority" });

    expect(resolveFollowupRunToolAuthorityFingerprint(run, first)).not.toBe(
      resolveFollowupRunToolAuthorityFingerprint(run, second),
    );
  });

  it.each(["complete", "fail", "abortByUser", "abortForRestart"] as const)(
    "requires a snapshot for route preparation and rejects it after %s",
    (close) => {
      const run = createQueueTestRun({ prompt: "operation projection" });
      const operation = createTestReplyOperation({ sessionId: "session-projector" });
      const snapshot = prepareReplyToolAuthority(run);
      const overlay = toolAuthorityOverlay(run);
      const route = { provider: "openai", model: "gpt-primary" };

      expect(() => operation.bindToolAuthorityRoute(route)).toThrow(
        "Reply operation has no active tool authority snapshot",
      );
      expect(operation.toolAuthorityRoute).toBeUndefined();
      expect(operation.toolAuthorityFingerprint).toBeUndefined();
      operation.bindToolAuthoritySnapshot(snapshot);
      expect(operation.projectToolAuthorityFingerprint(overlay)).toBeUndefined();

      const fingerprint = resolveFollowupRunToolAuthorityFingerprint(run, route);
      expect(operation.bindToolAuthorityRoute(route)).toBe(fingerprint);
      expect(operation.projectToolAuthorityFingerprint(overlay)).toBe(fingerprint);

      if (close === "fail") {
        operation.fail("run_failed");
      } else {
        operation[close]();
      }
      expect(operation.projectToolAuthorityFingerprint(overlay)).toBeUndefined();
      expect(() => operation.bindToolAuthorityRoute({ ...route, model: "gpt-late" })).toThrow(
        "Reply operation has no active tool authority snapshot",
      );
      expect(operation.toolAuthorityRoute).toEqual(route);
      expect(operation.toolAuthorityFingerprint).toBe(fingerprint);
    },
  );

  it("keeps the initial policy snapshot while tracking concrete fallback authority", () => {
    const run = createQueueTestRun({ prompt: "route authority" });
    const operation = createTestReplyOperation({ sessionId: "session-route" });
    const snapshot = prepareReplyToolAuthority(run);
    const primary = { provider: "openai", model: "gpt-primary" };
    const fallback = { provider: "anthropic", model: "claude-fallback" };
    const primaryFingerprint = resolveFollowupRunToolAuthorityFingerprint(run, primary);
    const fallbackFingerprint = resolveFollowupRunToolAuthorityFingerprint(run, fallback);
    const overlay = toolAuthorityOverlay(run);
    operation.bindToolAuthoritySnapshot(snapshot);

    expect(operation.bindToolAuthorityRoute(primary)).toBe(primaryFingerprint);
    expect(operation.toolAuthorityRoute).toEqual(primary);
    expect(operation.toolAuthorityFingerprint).toBe(primaryFingerprint);

    run.run.execOverrides = { security: "deny" };
    expect(() => operation.bindToolAuthoritySnapshot(prepareReplyToolAuthority(run))).toThrow(
      "Reply operation cannot change tool authority after admission",
    );
    expect(operation.toolAuthorityFingerprint).toBe(primaryFingerprint);
    expect(operation.bindToolAuthorityRoute(fallback)).toBe(fallbackFingerprint);
    expect(operation.toolAuthorityRoute).toEqual(fallback);
    expect(operation.toolAuthorityFingerprint).toBe(fallbackFingerprint);
    expect(operation.projectToolAuthorityFingerprint(overlay)).toBe(fallbackFingerprint);

    operation.bindToolAuthoritySnapshot(snapshot);
    expect(operation.toolAuthorityRoute).toEqual(fallback);
    expect(operation.toolAuthorityFingerprint).toBe(fallbackFingerprint);
    operation.attachBackend({
      kind: "embedded",
      cancel: vi.fn(),
      toolAuthorityFingerprint: "backend-exact-authority",
    });
    operation.bindToolAuthoritySnapshot(snapshot);
    expect(operation.toolAuthorityRoute).toEqual(fallback);
    expect(operation.toolAuthorityFingerprint).toBe("backend-exact-authority");
    operation.complete();
  });

  afterEach(() => {
    testing.resetReplyRunRegistry();
    resetCommandQueueStateForTest();
    resetDiagnosticRunActivityForTest();
    vi.restoreAllMocks();
  });

  it("keeps ownership stable by sessionKey while sessionId rotates", async () => {
    await withFakeReplyTimers(async () => {
      const operation = createTestReplyOperation({
        sessionId: "session-old",
      });

      const oldWaitPromise = waitForReplyRunEndBySessionId("session-old", 1_000);

      operation.updateSessionId("session-new");

      expect(replyRunRegistry.isActive("agent:main:main")).toBe(true);
      expect(resolveActiveReplyRunSessionId("agent:main:main")).toBe("session-new");
      expect(isReplyRunActiveForSessionId("session-old")).toBe(false);
      expect(isReplyRunActiveForSessionId("session-new")).toBe(true);

      let settled = false;
      void oldWaitPromise.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(settled).toBe(false);

      operation.complete();

      await expect(oldWaitPromise).resolves.toBe(true);
    });
  });

  it("treats queued reply operations as non-abortable for compaction", () => {
    const operation = createTestReplyOperation({
      sessionId: "session-compact",
    });

    expect(isReplyRunActiveForSessionId("session-compact")).toBe(true);
    expect(isReplyRunAbortableForCompaction("session-compact")).toBe(false);

    operation.markWaitingForDeferredMaintenance();

    expect(isReplyRunAbortableForCompaction("session-compact")).toBe(false);

    operation.markDeferredMaintenanceWaitEnded();
    operation.setPhase("running");

    expect(isReplyRunAbortableForCompaction("session-compact")).toBe(true);
  });

  it("records reply-operation progress without claiming embedded-run activity", () => {
    const operation = createTestReplyOperation({
      sessionKey: "agent:main:telegram:direct:chat-1",
    });

    expect(
      getDiagnosticSessionActivitySnapshot({
        sessionId: "session-1",
        sessionKey: "agent:main:telegram:direct:chat-1",
      }),
    ).toMatchObject({
      activeWorkKind: undefined,
      lastProgressReason: "reply_operation:queued",
    });

    operation.updateSessionId("session-2");

    expect(
      getDiagnosticSessionActivitySnapshot({
        sessionId: "session-2",
        sessionKey: "agent:main:telegram:direct:chat-1",
      }),
    ).toMatchObject({
      activeWorkKind: undefined,
      lastProgressReason: "reply_operation:session_updated",
    });

    operation.complete();

    expect(
      getDiagnosticSessionActivitySnapshot({
        sessionId: "session-2",
        sessionKey: "agent:main:telegram:direct:chat-1",
      }),
    ).toMatchObject({
      activeWorkKind: undefined,
      lastProgressReason: "reply_operation:ended",
    });
  });

  it("keeps repeated request evidence across reply-operation progress", () => {
    const startedAt = Date.parse("2026-08-06T08:00:00Z");
    const now = vi.spyOn(Date, "now").mockReturnValue(startedAt);
    const ref = {
      sessionKey: "agent:main:telegram:direct:retry-bridge",
      sessionId: "session-retry-bridge",
    };
    const runId = "run-retry-bridge";

    markDiagnosticEmbeddedRunStarted({ ...ref, runId });
    markDiagnosticModelStartedForTest({
      ...ref,
      runId,
      provider: "mock",
      model: "request-model",
      observationUnit: "request",
    });
    now.mockReturnValue(startedAt + 30_000);
    markDiagnosticModelStartedForTest({
      ...ref,
      runId,
      provider: "mock",
      model: "request-model",
      observationUnit: "request",
    });

    const operation = createTestReplyOperation(ref);
    expect(getDiagnosticSessionActivitySnapshot(ref)).toMatchObject({
      lastProgressReason: "reply_operation:queued",
      repeatedRequestNoProgressAgeMs: 30_000,
    });

    operation.markWaitingForDeferredMaintenance();
    expect(getDiagnosticSessionActivitySnapshot(ref)).toMatchObject({
      lastProgressReason: "deferred_maintenance:waiting",
      repeatedRequestNoProgressAgeMs: 30_000,
    });

    operation.complete();
    expect(getDiagnosticSessionActivitySnapshot(ref)).toMatchObject({
      lastProgressReason: "reply_operation:ended",
      repeatedRequestNoProgressAgeMs: 30_000,
    });
  });

  it("tracks deferred-maintenance wait as a reply-operation phase", () => {
    const operation = createTestReplyOperation({
      sessionKey: "agent:main:telegram:direct:chat-1",
      sessionId: "session-wait",
    });

    operation.markWaitingForDeferredMaintenance();

    expect(operation.phase).toBe("waiting_for_deferred_maintenance");
    expect(
      getDiagnosticSessionActivitySnapshot({
        sessionId: "session-wait",
        sessionKey: "agent:main:telegram:direct:chat-1",
      }),
    ).toMatchObject({
      activeWorkKind: undefined,
      lastProgressReason: "deferred_maintenance:waiting",
    });

    operation.markDeferredMaintenanceWaitEnded();

    expect(operation.phase).toBe("queued");
    expect(
      getDiagnosticSessionActivitySnapshot({
        sessionId: "session-wait",
        sessionKey: "agent:main:telegram:direct:chat-1",
      }),
    ).toMatchObject({
      activeWorkKind: undefined,
      lastProgressReason: "deferred_maintenance:wait_ended",
    });
  });

  it("keeps a reply alive while the saturated global lane waits past the stale threshold", async () => {
    vi.useFakeTimers();
    const operation = createTestReplyOperation({
      sessionKey: "agent:main:telegram:direct:lane-wait",
      sessionId: "session-global-lane-wait",
    });
    try {
      const lane = "test:reply-global-wait";
      setCommandLaneConcurrency(lane, 0);
      operation.setPhase("running");
      operation.markWaitingForGlobalLane();
      let ran = false;

      const queued = enqueueCommandInLane(
        lane,
        async () => {
          operation.markGlobalLaneWaitEnded();
          ran = true;
        },
        { onWait: () => markReplyOperationGlobalLaneWaitProgress(operation) },
      );

      await vi.advanceTimersByTimeAsync(RUN_STALE_TAKEOVER_MS + 1);
      expect(operation.phase).toBe("waiting_for_global_lane");
      expect(isReplyRunEvidenceStale(operation)).toBe(false);
      expect(ran).toBe(false);

      setCommandLaneConcurrency(lane, 1);
      await queued;

      expect(ran).toBe(true);
      expect(operation.phase).toBe("running");
      expect(
        getDiagnosticSessionActivitySnapshot({
          sessionId: operation.sessionId,
          sessionKey: operation.key,
        }).lastProgressReason,
      ).toBe("global_lane:wait_ended");
    } finally {
      operation.complete();
      vi.useRealTimers();
    }
  });

  it("clears deferred-maintenance operations immediately on user abort", () => {
    const operation = createTestReplyOperation({
      sessionId: "session-waiting-abort",
    });

    operation.markWaitingForDeferredMaintenance();
    operation.abortByUser();

    expect(operation.result).toEqual({ kind: "aborted", code: "aborted_by_user" });
    expect(replyRunRegistry.isActive("agent:main:main")).toBe(false);
    expect(isReplyRunActiveForSessionId("session-waiting-abort")).toBe(false);
  });

  it("does not reset deferred-maintenance operations as backend-owned work", () => {
    const operation = createTestReplyOperation({
      sessionId: "session-waiting-reset",
    });

    operation.markWaitingForDeferredMaintenance();
    clearReplyRunForResetBySessionId("session-waiting-reset");

    expect(operation.result).toBeNull();
    expect(replyRunRegistry.isActive("agent:main:main")).toBe(true);
  });

  it("clears queued operations immediately on user abort", () => {
    const operation = createTestReplyOperation({
      sessionId: "session-queued",
    });

    expect(replyRunRegistry.isActive("agent:main:main")).toBe(true);

    operation.abortByUser();

    expect(operation.result).toEqual({ kind: "aborted", code: "aborted_by_user" });
    expect(replyRunRegistry.isActive("agent:main:main")).toBe(false);
  });

  it("runs completeThen callbacks after active state clears", () => {
    const operation = createTestReplyOperation({
      sessionId: "session-complete",
    });
    const afterClear = vi.fn(() => {
      expect(replyRunRegistry.isActive("agent:main:main")).toBe(false);
      expect(isReplyRunActiveForSessionId("session-complete")).toBe(false);
    });

    operation.completeThen(afterClear);

    expect(operation.result).toEqual({ kind: "completed" });
    expect(afterClear).toHaveBeenCalledTimes(1);
  });

  it("clears active state before a deferred after-clear barrier settles", async () => {
    const operation = createTestReplyOperation({
      sessionId: "session-deferred",
    });
    let releaseBarrier: () => void = () => {};
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    const afterClear = vi.fn();
    runAfterReplyOperationClear(operation, afterClear);

    operation.completeWithAfterClearBarrier(barrier);

    expect(operation.result).toEqual({ kind: "completed" });
    expect(replyRunRegistry.isActive("agent:main:main")).toBe(false);
    expect(afterClear).not.toHaveBeenCalled();

    releaseBarrier();
    await barrier;
    await vi.waitFor(() => {
      expect(afterClear).toHaveBeenCalledTimes(1);
    });
  });

  it("keeps owner settlement pending after stale expiry through its completion barrier", async () => {
    const operation = createTestReplyOperation({ sessionId: "session-stale-owner" });
    operation.setPhase("running");

    expect(expireStaleReplyOperation(operation, "stuck_recovery")).toBe(false);
    expect(replyRunRegistry.isActive("agent:main:main")).toBe(true);

    const settlement = waitForReplyOperationOwnerSettlement(operation, 1_000);
    let settled = false;
    void settlement.then((value) => {
      settled = value;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    let releaseCompletion: () => void = () => {};
    const completionBarrier = new Promise<void>((resolve) => {
      releaseCompletion = resolve;
    });
    operation.completeWithAfterClearBarrier(completionBarrier);
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseCompletion();
    await expect(settlement).resolves.toBe(true);
  });

  it.each(["finalization expiry", "forced clear", "terminal expiry"] as const)(
    "keeps late delivery ownership pending after %s reclaims the slot",
    async (release) => {
      await withFakeReplyTimers(async () => {
        const operation = createTestReplyOperation();
        const delivery = createDeferred();
        const settled = vi.fn();
        void operation.ownerSettlement?.then(settled);
        operation.setPhase("running");
        operation.retainFailureUntilComplete();
        operation.freezeAbort();
        try {
          if (release === "finalization expiry") {
            await vi.advanceTimersByTimeAsync(REPLY_RUN_FINALIZATION_SETTLE_TIMEOUT_MS);
          } else if (release === "forced clear") {
            expect(forceClearReplyOperation(operation)).toBe(true);
          } else {
            operation.fail("run_failed");
            await vi.advanceTimersByTimeAsync(REPLY_RUN_TERMINAL_SETTLE_TIMEOUT_MS);
          }
          expect(replyRunRegistry.isActive(operation.key)).toBe(false);
          await Promise.resolve();
          expect(settled).not.toHaveBeenCalled();
          const ownerWait = waitForReplyOperationOwnerSettlement(operation, 100);
          await vi.advanceTimersByTimeAsync(100);
          await expect(ownerWait).resolves.toBe(false);
          expect(settled).not.toHaveBeenCalled();

          const successor = createTestReplyOperation({ sessionId: "successor" });
          operation.completeWithAfterClearBarrier(delivery.promise);
          operation.complete();
          await Promise.resolve();
          expect(settled).not.toHaveBeenCalled();
          expect(replyRunRegistry.get(operation.key)).toBe(successor);
          successor.complete();
        } finally {
          delivery.resolve();
          operation.completeWithAfterClearBarrier(delivery.promise);
          await operation.ownerSettlement;
        }
        expect(settled).toHaveBeenCalledOnce();
      });
    },
  );

  it("does not settle the delivery owner when complete is called again before its barrier settles", async () => {
    const operation = createTestReplyOperation({ sessionId: "session-late-complete" });
    const delivery = createDeferred();
    const settled = vi.fn();
    expect(operation.ownerSettlement).toBeDefined();
    void operation.ownerSettlement?.then(settled);
    operation.completeWithAfterClearBarrier(delivery.promise);

    try {
      operation.complete();
      await Promise.resolve();

      expect(replyRunRegistry.isActive(operation.key)).toBe(false);
      expect(settled).not.toHaveBeenCalled();
    } finally {
      delivery.resolve();
      await operation.ownerSettlement;
    }
    expect(settled).toHaveBeenCalledOnce();
  });

  it("interrupts only the captured operation when its abort admits a same-key successor", async () => {
    const operation = createTestReplyOperation({ sessionId: "session-interrupt-captured" });
    operation.setPhase("running");
    let successor: ReplyOperation | undefined;
    let successorAbortByUser: MockInstance<ReplyOperation["abortByUser"]> | undefined;
    operation.attachBackend({
      kind: "embedded",
      cancel: () => {
        operation.complete();
        successor = createTestReplyOperation({ sessionId: "session-interrupt-successor" });
        successor.setPhase("running");
        successorAbortByUser = vi.spyOn(successor, "abortByUser");
      },
    });
    const target = replyRunRegistry.resolveCurrentInterruptTarget(operation.key);
    if (!target) {
      throw new Error("expected captured interrupt target");
    }

    await expect(interruptReplyRunTarget(target, 1_000)).resolves.toEqual({
      aborted: true,
      settled: true,
    });
    if (!successor || !successorAbortByUser) {
      throw new Error("expected same-key successor operation");
    }
    try {
      expect(successorAbortByUser).not.toHaveBeenCalled();
    } finally {
      successor.complete();
    }
  });

  it("installs stale recovery barrier before synchronous cancel completion", async () => {
    const warnSpy = vi.spyOn(diagnosticLogger, "warn").mockImplementation(() => undefined);
    const operation = createTestReplyOperation({ sessionId: "session-sync-cancel" });
    operation.setPhase("running");
    operation.attachBackend({
      kind: "embedded",
      cancel: () => operation.complete(),
      isStreaming: () => true,
    });
    let releaseRecovery: () => void = () => {};
    const recoveryBarrier = new Promise<void>((resolve) => {
      releaseRecovery = resolve;
    });
    const afterClear = vi.fn();
    runAfterReplyOperationClear(operation, afterClear);

    expect(
      expireStaleReplyOperation(operation, "stuck_recovery", {
        afterClearBarrier: recoveryBarrier,
      }),
    ).toBe(true);
    expect(afterClear).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("reply run stale takeover: forced release"),
    );

    releaseRecovery();
    await vi.waitFor(() => {
      expect(afterClear).toHaveBeenCalledWith("session-sync-cancel");
    });
  });

  it("settles a reentrant completion independently of its recovery fence", async () => {
    let releaseCompletion: () => void = () => {};
    const completionBarrier = new Promise<void>((resolve) => {
      releaseCompletion = resolve;
    });
    const operation = createTestReplyOperation({ sessionId: "session-sync-durable-completion" });
    operation.setPhase("running");
    operation.attachBackend({
      kind: "embedded",
      cancel: () => operation.completeWithAfterClearBarrier(completionBarrier),
      isStreaming: () => true,
    });
    let releaseRecovery: () => void = () => {};
    const recoveryBarrier = new Promise<void>((resolve) => {
      releaseRecovery = resolve;
    });
    const afterClear = vi.fn();
    runAfterReplyOperationClear(operation, afterClear);

    expect(
      expireStaleReplyOperation(operation, "stuck_recovery", {
        afterClearBarrier: recoveryBarrier,
      }),
    ).toBe(true);
    const ownerSettlement = waitForReplyOperationOwnerSettlement(operation, 1_000);
    releaseCompletion();
    await expect(ownerSettlement).resolves.toBe(true);
    expect(afterClear).not.toHaveBeenCalled();

    releaseRecovery();
    await vi.waitFor(() => {
      expect(afterClear).toHaveBeenCalledWith("session-sync-durable-completion");
    });
  });

  it("retains exact ownership when stale backend cancellation throws", async () => {
    const operation = createTestReplyOperation({ sessionId: "session-cancel-throws" });
    operation.setPhase("running");
    operation.attachBackend({
      kind: "embedded",
      cancel: () => {
        throw new Error("cancel failed");
      },
      isStreaming: () => true,
    });
    let releaseRecovery: () => void = () => {};
    const recoveryBarrier = new Promise<void>((resolve) => {
      releaseRecovery = resolve;
    });
    const afterClear = vi.fn();
    runAfterReplyOperationClear(operation, afterClear);

    expect(
      expireStaleReplyOperation(operation, "stuck_recovery", {
        afterClearBarrier: recoveryBarrier,
      }),
    ).toBe(false);
    expect(operation.result).toEqual({ kind: "failed", code: "run_stalled" });
    expect(operation.abortSignal.aborted).toBe(true);
    expect(replyRunRegistry.get("agent:main:main")).toBe(operation);

    releaseRecovery();
    await recoveryBarrier;
    await Promise.resolve();
    expect(afterClear).not.toHaveBeenCalled();

    expect(forceClearReplyOperation(operation, new Error("cancel failed"))).toBe(true);
    await vi.waitFor(() => {
      expect(afterClear).toHaveBeenCalledWith("session-cancel-throws");
    });
    expect(replyRunRegistry.get("agent:main:main")).toBeUndefined();
  });

  it("retains exact ownership when stale backend cancellation awaits terminal completion", async () => {
    const operation = createTestReplyOperation({ sessionId: "session-cancel-pending" });
    operation.setPhase("running");
    const cancel = vi.fn();
    operation.attachBackend({
      kind: "embedded",
      cancel,
      isStreaming: () => true,
    });
    let releaseRecovery: () => void = () => {};
    const recoveryBarrier = new Promise<void>((resolve) => {
      releaseRecovery = resolve;
    });
    const afterClear = vi.fn();
    runAfterReplyOperationClear(operation, afterClear);

    expect(
      expireStaleReplyOperation(operation, "stuck_recovery", {
        afterClearBarrier: recoveryBarrier,
      }),
    ).toBe(false);
    expect(cancel).toHaveBeenCalledWith("superseded");
    expect(operation.result).toEqual({ kind: "failed", code: "run_stalled" });
    expect(operation.abortSignal.aborted).toBe(true);
    expect(replyRunRegistry.get("agent:main:main")).toBe(operation);

    releaseRecovery();
    await recoveryBarrier;
    await Promise.resolve();
    expect(afterClear).not.toHaveBeenCalled();

    expect(forceClearReplyOperation(operation, new Error("terminal completion timed out"))).toBe(
      true,
    );
    await vi.waitFor(() => {
      expect(afterClear).toHaveBeenCalledWith("session-cancel-pending");
    });
    expect(replyRunRegistry.get("agent:main:main")).toBeUndefined();
  });

  it("retains pre-backend ownership and rejects a backend that attaches after expiry", async () => {
    const operation = createTestReplyOperation({ sessionId: "session-cancel-before-attach" });
    operation.setPhase("running");
    let releaseRecovery: () => void = () => {};
    const recoveryBarrier = new Promise<void>((resolve) => {
      releaseRecovery = resolve;
    });
    const afterClear = vi.fn();
    runAfterReplyOperationClear(operation, afterClear);

    expect(
      expireStaleReplyOperation(operation, "stuck_recovery", {
        afterClearBarrier: recoveryBarrier,
      }),
    ).toBe(false);
    expect(operation.abortSignal.aborted).toBe(true);
    expect(replyRunRegistry.get("agent:main:main")).toBe(operation);

    const lateCancel = vi.fn();
    operation.attachBackend({
      kind: "embedded",
      cancel: lateCancel,
      isStreaming: () => true,
    });
    expect(lateCancel).toHaveBeenCalledWith("superseded");
    expect(replyRunRegistry.get("agent:main:main")).toBe(operation);

    releaseRecovery();
    await recoveryBarrier;
    await Promise.resolve();
    expect(afterClear).not.toHaveBeenCalled();

    expect(forceClearReplyOperation(operation)).toBe(true);
    await vi.waitFor(() => {
      expect(afterClear).toHaveBeenCalledWith("session-cancel-before-attach");
    });
    expect(replyRunRegistry.get("agent:main:main")).toBeUndefined();
  });

  it("bounds retained ownership when stale cancellation awaits terminal completion", async () => {
    await withFakeReplyTimers(async () => {
      const operation = createTestReplyOperation({ sessionId: "session-cancel-pending-bound" });
      operation.setPhase("running");
      operation.attachBackend({
        kind: "embedded",
        cancel: () => {},
        isStreaming: () => true,
      });
      const afterClear = vi.fn();
      runAfterReplyOperationClear(operation, afterClear);

      expect(expireStaleReplyOperation(operation, "no_activity")).toBe(false);
      await vi.advanceTimersByTimeAsync(REPLY_RUN_TERMINAL_SETTLE_TIMEOUT_MS - 1);
      expect(replyRunRegistry.get("agent:main:main")).toBe(operation);
      expect(afterClear).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(replyRunRegistry.get("agent:main:main")).toBeUndefined();
      expect(afterClear).toHaveBeenCalledWith("session-cancel-pending-bound");
    });
  });

  it("bounds retained ownership when stale cancellation throws undefined", async () => {
    await withFakeReplyTimers(async () => {
      const operation = createTestReplyOperation({ sessionId: "session-undefined-cancel" });
      operation.setPhase("running");
      operation.attachBackend({
        kind: "embedded",
        cancel: () => {
          // oxlint-disable-next-line typescript/only-throw-error -- JavaScript permits undefined; this guards the explicit cancelFailed sentinel.
          throw undefined;
        },
        isStreaming: () => true,
      });
      const afterClear = vi.fn();
      runAfterReplyOperationClear(operation, afterClear);

      expect(expireStaleReplyOperation(operation, "no_activity")).toBe(false);
      expect(operation.abortSignal.aborted).toBe(true);
      await vi.advanceTimersByTimeAsync(REPLY_RUN_TERMINAL_SETTLE_TIMEOUT_MS - 1);
      expect(replyRunRegistry.get("agent:main:main")).toBe(operation);
      expect(afterClear).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(replyRunRegistry.get("agent:main:main")).toBeUndefined();
      expect(afterClear).toHaveBeenCalledWith("session-undefined-cancel");
    });
  });

  it("keeps a reentrant completion fenced when cancel then throws", async () => {
    const operation = createTestReplyOperation({ sessionId: "session-complete-then-throw" });
    operation.setPhase("running");
    operation.attachBackend({
      kind: "embedded",
      cancel: () => {
        operation.complete();
        throw new Error("cancel failed after completion");
      },
      isStreaming: () => true,
    });
    let releaseRecovery: () => void = () => {};
    const recoveryBarrier = new Promise<void>((resolve) => {
      releaseRecovery = resolve;
    });
    const afterClear = vi.fn();
    runAfterReplyOperationClear(operation, afterClear);

    expect(
      expireStaleReplyOperation(operation, "stuck_recovery", {
        afterClearBarrier: recoveryBarrier,
      }),
    ).toBe(true);
    expect(operation.result).toEqual({ kind: "failed", code: "run_stalled" });
    expect(operation.abortSignal.aborted).toBe(true);
    expect(replyRunRegistry.get("agent:main:main")).toBeUndefined();
    expect(afterClear).not.toHaveBeenCalled();

    releaseRecovery();
    await vi.waitFor(() => {
      expect(afterClear).toHaveBeenCalledWith("session-complete-then-throw");
    });
  });

  it("keeps late after-clear registration behind an active stale barrier", async () => {
    const operation = createTestReplyOperation({ sessionId: "session-late-callback" });
    operation.setPhase("running");
    let releaseRecovery: () => void = () => {};
    const recoveryBarrier = new Promise<void>((resolve) => {
      releaseRecovery = resolve;
    });

    expect(
      expireStaleReplyOperation(operation, "stuck_recovery", {
        afterClearBarrier: recoveryBarrier,
      }),
    ).toBe(false);
    const afterClear = vi.fn();
    runAfterReplyOperationClear(operation, afterClear);
    expect(afterClear).not.toHaveBeenCalled();

    releaseRecovery();
    await recoveryBarrier;
    await Promise.resolve();
    expect(afterClear).not.toHaveBeenCalled();

    expect(forceClearReplyOperation(operation)).toBe(true);
    await vi.waitFor(() => {
      expect(afterClear).toHaveBeenCalledWith("session-late-callback");
    });
  });

  it.each([
    { firstStore: "store-a", laterStore: "store-a", expected: "rotated-session" },
    { firstStore: "store-a", laterStore: "store-b", expected: "first-session" },
    { firstStore: "store-a", laterStore: undefined, expected: "first-session" },
    { firstStore: undefined, laterStore: "store-b", expected: "first-session" },
    { firstStore: undefined, laterStore: undefined, expected: "rotated-session" },
  ])(
    "keeps after-clear session rotation with its database ($firstStore -> $laterStore)",
    async ({ firstStore, laterStore, expected }) => {
      const first = createTestReplyOperation({ sessionKey: "global", sessionId: "first-session" });
      lifecycleAdmissionByOperation.set(first, { databaseIdentity: firstStore });
      const barrier = createDeferred();
      const afterClear = vi.fn();
      runAfterReplyOperationClear(first, afterClear);
      first.completeWithAfterClearBarrier(barrier.promise);

      const later = createTestReplyOperation({ sessionKey: "global", sessionId: "first-session" });
      lifecycleAdmissionByOperation.set(later, { databaseIdentity: laterStore });
      later.updateSessionId("rotated-session");
      later.complete();
      expect(afterClear).not.toHaveBeenCalled();
      barrier.resolve();
      await vi.waitFor(() => expect(afterClear).toHaveBeenCalledWith(expected));
    },
  );

  it("keeps a late callback behind its own delivery when a foreign store replaces the global barrier", async () => {
    const first = createTestReplyOperation({ sessionKey: "global", sessionId: "first-session" });
    lifecycleAdmissionByOperation.set(first, { databaseIdentity: "store-a" });
    const firstBarrier = createDeferred();
    first.completeWithAfterClearBarrier(firstBarrier.promise);
    const later = createTestReplyOperation({ sessionKey: "global", sessionId: "later-session" });
    lifecycleAdmissionByOperation.set(later, { databaseIdentity: "store-b" });
    const laterBarrier = createDeferred();
    later.completeWithAfterClearBarrier(laterBarrier.promise);

    const afterClear = vi.fn();
    runAfterReplyOperationClear(first, afterClear);
    try {
      expect(afterClear).not.toHaveBeenCalled();
      firstBarrier.resolve();
      await vi.waitFor(() => expect(afterClear).toHaveBeenCalledWith("first-session"));
    } finally {
      firstBarrier.resolve();
      laterBarrier.resolve();
    }
  });

  it("keeps later after-clear work behind earlier delivery barriers", async () => {
    const first = createTestReplyOperation({
      sessionId: "first-session",
    });
    let releaseFirst: () => void = () => {};
    const firstBarrier = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstAfterClear = vi.fn();
    runAfterReplyOperationClear(first, firstAfterClear);
    first.completeWithAfterClearBarrier(firstBarrier);

    const second = createTestReplyOperation({
      sessionId: "second-session",
    });
    let releaseSecond: () => void = () => {};
    const secondBarrier = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const secondAfterClear = vi.fn();
    runAfterReplyOperationClear(second, secondAfterClear);
    second.completeWithAfterClearBarrier(secondBarrier);

    releaseSecond();
    await secondBarrier;
    expect(secondAfterClear).not.toHaveBeenCalled();

    releaseFirst();
    await firstBarrier;
    await vi.waitFor(() => {
      expect(firstAfterClear).toHaveBeenCalledWith("first-session");
      expect(secondAfterClear).toHaveBeenCalledWith("second-session");
    });
  });

  it("keeps follow-up admission blocked until slow delivery settles", async () => {
    await withFakeReplyTimers(async () => {
      const operation = createTestReplyOperation({
        sessionId: "hung-session",
      });
      let releaseBarrier: () => void = () => {};
      const barrier = new Promise<void>((resolve) => {
        releaseBarrier = resolve;
      });
      const afterClear = vi.fn();
      runAfterReplyOperationClear(operation, afterClear);
      operation.completeWithAfterClearBarrier(barrier, 35 * 60_000);

      await vi.advanceTimersByTimeAsync(REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS);
      expect(afterClear).not.toHaveBeenCalled();
      expect(() =>
        createTestReplyOperation({
          sessionKey: "agent:main:main",
          sessionId: "blocked-session",
          resetTriggered: false,
          respectFollowupAdmissionBarrier: true,
        }),
      ).toThrow("Reply follow-up admission is blocked");

      releaseBarrier();
      await barrier;
      await vi.waitFor(() => {
        expect(afterClear).toHaveBeenCalledWith("hung-session");
      });
      const next = createTestReplyOperation({
        sessionId: "next-session",
        respectFollowupAdmissionBarrier: true,
      });
      next.complete();
    });
  });

  it("fences every durable alias until successor handoff settles", async () => {
    await withFakeReplyTimers(async () => {
      const requestKey = "agent:main:telegram:alias:request";
      const canonicalKey = "agent:main:telegram:alias:canonical";
      const adoptedKey = "agent:main:telegram:alias:adopted";
      const operation = createTestReplyOperation({
        sessionKey: requestKey,
        sessionId: "alias-session",
      });
      let releaseFirstBarrier = () => {};
      const firstBarrier = new Promise<void>((resolve) => {
        releaseFirstBarrier = resolve;
      });
      registerReplyOperationSuccessorBarrier({
        operation,
        sessionId: "alias-session",
        sessionKeys: [requestKey, canonicalKey],
        start: () => firstBarrier,
      });
      let releaseSecondBarrier = () => {};
      const secondBarrier = new Promise<void>((resolve) => {
        releaseSecondBarrier = resolve;
      });
      registerReplyOperationSuccessorBarrier({
        operation,
        sessionId: "alias-session",
        sessionKeys: [adoptedKey],
        start: () => secondBarrier,
      });

      operation.updateSessionId("rotated-alias-session");
      operation.complete();
      for (const sessionKey of [requestKey, canonicalKey, adoptedKey]) {
        expect(() => createTestReplyOperation({ sessionKey })).toThrow(
          ReplyRunSuccessorAdmissionBlockedError,
        );
      }
      const timedWait = waitForReplyRunSuccessorAdmission(canonicalKey, 100);
      await vi.advanceTimersByTimeAsync(100);
      await expect(timedWait).resolves.toEqual({ settled: false });

      const requestWait = waitForReplyRunSuccessorAdmission(requestKey, 100);
      const canonicalWait = waitForReplyRunSuccessorAdmission(canonicalKey, 100);
      releaseFirstBarrier();
      for (const wait of [requestWait, canonicalWait]) {
        await expect(wait).resolves.toEqual({
          settled: true,
          sources: [
            {
              sessionId: "rotated-alias-session",
              sessionIds: operation.captureOwnedSessionIds(),
              operation,
              databaseIdentity: undefined,
            },
          ],
        });
      }
      expect(() => createTestReplyOperation({ sessionKey: adoptedKey })).toThrow(
        ReplyRunSuccessorAdmissionBlockedError,
      );
      releaseSecondBarrier();
      await expect(waitForReplyRunSuccessorAdmission(adoptedKey, 100)).resolves.toEqual({
        settled: true,
        sources: [
          {
            sessionId: "rotated-alias-session",
            sessionIds: operation.captureOwnedSessionIds(),
            operation,
            databaseIdentity: undefined,
          },
        ],
      });
      const successor = createTestReplyOperation({ sessionKey: canonicalKey });
      successor.complete();
    });
  });

  it("stops a successor wait when its signal aborts", async () => {
    const operation = createTestReplyOperation();
    registerReplyOperationSuccessorBarrier({
      operation,
      sessionId: operation.sessionId,
      sessionKeys: [operation.key],
      start: () => new Promise<void>(() => {}),
    });
    operation.complete();
    const controller = new AbortController();
    const wait = waitForReplyRunSuccessorAdmission(operation.key, null, {
      signal: controller.signal,
    });

    controller.abort();

    await expect(wait).resolves.toEqual({ settled: false });
  });

  it("extends a hung delivery barrier only while bounded owner work remains active", async () => {
    await withFakeReplyTimers(async () => {
      const operation = createTestReplyOperation({
        sessionId: "active-owner-session",
      });
      let ownerActive = true;
      const afterClear = vi.fn();
      runAfterReplyOperationClear(operation, afterClear);
      operation.completeWithAfterClearBarrier(new Promise<void>(() => {}), {
        maxTimeoutMs: REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS * 3,
        shouldExtend: () => ownerActive,
      });

      await vi.advanceTimersByTimeAsync(REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS);
      expect(afterClear).not.toHaveBeenCalled();

      ownerActive = false;
      await vi.advanceTimersByTimeAsync(REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS);
      await vi.waitFor(() => {
        expect(afterClear).toHaveBeenCalledWith("active-owner-session");
      });
    });
  });

  it("keeps follow-up admission blocked during an unsettled inter-block delay", async () => {
    await withFakeReplyTimers(async () => {
      const operation = createTestReplyOperation({
        sessionKey: "agent:main:mattermost:direct:user-1",
        sessionId: "mattermost-delivery-session",
      });
      let settledDeliveryCount = 1;
      const queuedDeliveryCount = 2;
      const afterClear = vi.fn();
      runAfterReplyOperationClear(operation, afterClear);
      operation.completeWithAfterClearBarrier(new Promise<void>(() => {}), {
        maxTimeoutMs: REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS * 3,
        shouldExtend: () => settledDeliveryCount < queuedDeliveryCount,
      });

      await vi.advanceTimersByTimeAsync(REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS);
      expect(afterClear).not.toHaveBeenCalled();
      expect(() =>
        createTestReplyOperation({
          sessionKey: "agent:main:mattermost:direct:user-1",
          sessionId: "queued-followup",
          resetTriggered: false,
          respectFollowupAdmissionBarrier: true,
        }),
      ).toThrow();

      settledDeliveryCount = 2;
      await vi.advanceTimersByTimeAsync(REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS);
      await vi.waitFor(() => {
        expect(afterClear).toHaveBeenCalledWith("mattermost-delivery-session");
      });

      const followup = createTestReplyOperation({
        sessionKey: "agent:main:mattermost:direct:user-1",
        sessionId: "admitted-followup",
        respectFollowupAdmissionBarrier: true,
      });
      followup.complete();
    });
  });

  it("releases follow-up admission at the default timeout while retaining the raw delivery owner", async () => {
    await withFakeReplyTimers(async () => {
      const operation = createTestReplyOperation({
        sessionId: "hung-session",
      });
      const delivery = createDeferred();
      const ownerSettled = vi.fn();
      expect(operation.ownerSettlement).toBeDefined();
      void operation.ownerSettlement?.then(ownerSettled);
      const afterClear = vi.fn();
      runAfterReplyOperationClear(operation, afterClear);
      operation.completeWithAfterClearBarrier(delivery.promise);

      try {
        await vi.advanceTimersByTimeAsync(REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS - 1);
        expect(afterClear).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);
        expect(afterClear).toHaveBeenCalledWith("hung-session");
        const next = createTestReplyOperation({
          sessionId: "next-session",
          respectFollowupAdmissionBarrier: true,
        });
        next.complete();
        expect(ownerSettled).not.toHaveBeenCalled();

        const boundedWait = waitForReplyOperationOwnerSettlement(operation, 100);
        await vi.advanceTimersByTimeAsync(100);
        await expect(boundedWait).resolves.toBe(false);
        expect(ownerSettled).not.toHaveBeenCalled();
      } finally {
        delivery.resolve();
        await operation.ownerSettlement;
      }
      expect(ownerSettled).toHaveBeenCalledOnce();
    });
  });

  it("retains failed operations until final delivery completes", () => {
    const operation = createTestReplyOperation({
      sessionId: "session-failed",
    });
    const afterClear = vi.fn();
    operation.retainFailureUntilComplete();
    runAfterReplyOperationClear(operation, afterClear);

    operation.fail("run_failed", new Error("provider failed"));

    expect(operation.result).toMatchObject({ kind: "failed", code: "run_failed" });
    expect(replyRunRegistry.get("agent:main:main")).toBe(operation);
    expect(afterClear).not.toHaveBeenCalled();

    operation.complete();

    expect(replyRunRegistry.isActive("agent:main:main")).toBe(false);
    expect(afterClear).toHaveBeenCalledTimes(1);
  });

  it("keeps retained terminal failures immutable across late aborts", () => {
    const upstreamAbort = new AbortController();
    const cancel = vi.fn();
    const operation = createTestReplyOperation({
      sessionKey: "agent:main:failed-final",
      sessionId: "session-failed-final",
      upstreamAbortSignal: upstreamAbort.signal,
    });
    operation.attachBackend({
      kind: "embedded",
      cancel,
      isStreaming: () => false,
      isAbortable: () => true,
    });
    operation.setPhase("running");
    operation.retainFailureUntilComplete();

    operation.fail("run_failed", new Error("provider failed"));
    upstreamAbort.abort(new Error("late upstream abort"));

    expect(operation.abortSignal.aborted).toBe(false);
    expect(operation.abortByUser()).toBe(false);
    expect(operation.abortForRestart()).toBe(false);
    expect(operation.result).toMatchObject({ kind: "failed", code: "run_failed" });
    expect(operation.phase).toBe("failed");
    expect(cancel).not.toHaveBeenCalled();
  });

  it("records upstream cancellation as an aborted operation", () => {
    const upstreamAbort = new AbortController();
    const cancel = vi.fn();
    const operation = createTestReplyOperation({
      sessionKey: "agent:main:upstream-cancelled",
      sessionId: "session-upstream-cancelled",
      upstreamAbortSignal: upstreamAbort.signal,
    });
    operation.attachBackend({
      kind: "embedded",
      cancel,
      isStreaming: () => true,
    });
    operation.setPhase("running");

    upstreamAbort.abort(new Error("caller cancelled"));

    expect(operation.result).toEqual({ kind: "aborted", code: "aborted_by_user" });
    expect(operation.phase).toBe("aborted");
    expect(operation.abortSignal.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledWith("user_abort");
    operation.complete();
  });

  it("records upstream restart cancellation separately", () => {
    const upstreamAbort = new AbortController();
    const cancel = vi.fn();
    const operation = createTestReplyOperation({
      sessionKey: "agent:main:upstream-restart",
      sessionId: "session-upstream-restart",
      upstreamAbortSignal: upstreamAbort.signal,
    });
    operation.attachBackend({
      kind: "embedded",
      cancel,
      isStreaming: () => true,
    });
    operation.setPhase("running");

    upstreamAbort.abort(createAgentRunRestartAbortError());

    expect(operation.result).toEqual({ kind: "aborted", code: "aborted_for_restart" });
    expect(operation.phase).toBe("aborted");
    expect(operation.abortSignal.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledWith("restart");
    operation.complete();
  });

  it("clears queued ownership when the upstream signal is already aborted", () => {
    const upstreamAbort = new AbortController();
    upstreamAbort.abort(new Error("caller already cancelled"));

    const operation = createTestReplyOperation({
      sessionKey: "agent:main:already-cancelled",
      sessionId: "session-already-cancelled",
      upstreamAbortSignal: upstreamAbort.signal,
    });

    expect(operation.result).toEqual({ kind: "aborted", code: "aborted_by_user" });
    expect(operation.phase).toBe("aborted");
    expect(operation.abortSignal.aborted).toBe(true);
    expect(replyRunRegistry.isActive("agent:main:already-cancelled")).toBe(false);
  });

  it("does not cancel the backend twice when upstream abort follows a user abort", () => {
    const upstreamAbort = new AbortController();
    const cancel = vi.fn();
    const operation = createTestReplyOperation({
      sessionKey: "agent:main:duplicate-cancel",
      sessionId: "session-duplicate-cancel",
      upstreamAbortSignal: upstreamAbort.signal,
    });
    operation.attachBackend({
      kind: "embedded",
      cancel,
      isStreaming: () => true,
    });
    operation.setPhase("running");

    expect(operation.abortByUser()).toBe(true);
    upstreamAbort.abort(createAgentRunRestartAbortError());

    expect(operation.result).toEqual({ kind: "aborted", code: "aborted_by_user" });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith("user_abort");
    operation.complete();
  });

  it.each([
    {
      name: "user abort while queued",
      abort: (operation: ReturnType<typeof createTestReplyOperation>) => operation.abortByUser(),
      code: "aborted_by_user",
      reason: "user_abort",
      phase: "queued",
    },
    {
      name: "restart abort while queued",
      abort: (operation: ReturnType<typeof createTestReplyOperation>) =>
        operation.abortForRestart(),
      code: "aborted_for_restart",
      reason: "restart",
      phase: "queued",
    },
    {
      name: "user abort while running",
      abort: (operation: ReturnType<typeof createTestReplyOperation>) => operation.abortByUser(),
      code: "aborted_by_user",
      reason: "user_abort",
      phase: "running",
    },
    {
      name: "restart abort while running",
      abort: (operation: ReturnType<typeof createTestReplyOperation>) =>
        operation.abortForRestart(),
      code: "aborted_for_restart",
      reason: "restart",
      phase: "running",
    },
  ] as const)("preserves cleanup when backend cancellation throws: $name", async (testCase) => {
    await withFakeReplyTimers(async () => {
      const cancelError = new Error("cancel failed");
      const cancel = vi.fn(() => {
        throw cancelError;
      });
      const operation = createTestReplyOperation({
        sessionKey: `agent:main:${testCase.reason}-${testCase.phase}`,
        sessionId: `session-${testCase.reason}-${testCase.phase}`,
      });
      operation.attachBackend({ kind: "embedded", cancel, isStreaming: () => true });
      operation.setPhase(testCase.phase);
      const afterClear = vi.fn();
      runAfterReplyOperationClear(operation, afterClear);

      expect(() => testCase.abort(operation)).toThrow(cancelError);
      expect(operation.result).toEqual({ kind: "aborted", code: testCase.code });
      expect(operation.phase).toBe("aborted");
      expect(operation.abortSignal.aborted).toBe(true);
      expect(cancel).toHaveBeenCalledOnce();
      expect(cancel).toHaveBeenCalledWith(testCase.reason);

      const retained = testCase.phase === "running";
      expect(replyRunRegistry.isActive(operation.key)).toBe(retained);
      expect(afterClear).toHaveBeenCalledTimes(retained ? 0 : 1);
      expect(vi.getTimerCount()).toBe(retained ? 1 : 0);

      await vi.advanceTimersByTimeAsync(REPLY_RUN_TERMINAL_SETTLE_TIMEOUT_MS);
      expect(replyRunRegistry.isActive(operation.key)).toBe(false);
      expect(afterClear).toHaveBeenCalledOnce();
      operation.complete();
      expect(afterClear).toHaveBeenCalledOnce();
      expect(cancel).toHaveBeenCalledOnce();
    });
  });

  it("force-releases a running aborted operation when the owner never returns", async () => {
    await withFakeReplyTimers(async () => {
      const cancel = vi.fn();
      const operation = createTestReplyOperation({
        sessionKey: "agent:main:hung-abort",
        sessionId: "session-hung-abort",
      });
      operation.attachBackend({
        kind: "embedded",
        cancel,
        isStreaming: () => true,
      });
      operation.setPhase("running");
      const afterClear = vi.fn();
      runAfterReplyOperationClear(operation, afterClear);
      const waitPromise = replyRunRegistry.waitForIdle("agent:main:hung-abort");

      operation.abortByUser();

      await vi.advanceTimersByTimeAsync(REPLY_RUN_TERMINAL_SETTLE_TIMEOUT_MS - 1);
      expect(replyRunRegistry.get("agent:main:hung-abort")).toBe(operation);
      expect(afterClear).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);

      expect(replyRunRegistry.get("agent:main:hung-abort")).toBeUndefined();
      await expect(waitPromise).resolves.toBe(true);
      expect(afterClear).toHaveBeenCalledTimes(1);
      const next = await admitReplyTurn({
        sessionKey: "agent:main:hung-abort",
        sessionId: "session-after-hung-abort",
        kind: "visible",
        resetTriggered: false,
      });
      expect(next.status).toBe("owned");
      if (next.status === "owned") {
        next.operation.complete();
      }
    });
  });

  it("keeps late owner complete harmless after forced terminal release", async () => {
    await withFakeReplyTimers(async () => {
      const operation = createTestReplyOperation({
        sessionKey: "agent:main:late-complete",
        sessionId: "session-late-complete",
      });
      operation.setPhase("running");
      const afterClear = vi.fn();
      runAfterReplyOperationClear(operation, afterClear);

      operation.abortByUser();
      await vi.advanceTimersByTimeAsync(REPLY_RUN_TERMINAL_SETTLE_TIMEOUT_MS);
      operation.complete();

      expect(replyRunRegistry.isActive("agent:main:late-complete")).toBe(false);
      expect(afterClear).toHaveBeenCalledTimes(1);
    });
  });

  it("force-releases retained failures when the owner never completes", async () => {
    await withFakeReplyTimers(async () => {
      const operation = createTestReplyOperation({
        sessionKey: "agent:main:retained-hung-failure",
        sessionId: "session-retained-hung-failure",
      });
      operation.retainFailureUntilComplete();
      const afterClear = vi.fn();
      runAfterReplyOperationClear(operation, afterClear);

      operation.fail("run_failed", new Error("delivery payload pending"));
      await vi.advanceTimersByTimeAsync(REPLY_RUN_TERMINAL_SETTLE_TIMEOUT_MS);

      expect(replyRunRegistry.get("agent:main:retained-hung-failure")).toBeUndefined();
      expect(afterClear).toHaveBeenCalledTimes(1);
      expect(operation.result).toMatchObject({ kind: "failed", code: "run_failed" });
    });
  });

  it("keeps run_stalled attribution and ownership when cancel re-enters abortByUser", () => {
    const operation = createTestReplyOperation({
      sessionKey: "agent:main:reentrant-expire",
      sessionId: "reentrant-session",
    });
    operation.attachBackend({
      kind: "embedded",
      // Mirrors the run loop's abort handler: backend cancellation propagates
      // synchronously back into a user-shaped abort on the same operation.
      cancel: () => {
        operation.abortByUser();
      },
      isStreaming: () => true,
    });
    operation.setPhase("running");

    expect(expireStaleReplyOperation(operation, "no_activity")).toBe(false);
    expect(operation.result).toEqual({ kind: "failed", code: "run_stalled" });
    expect(replyRunRegistry.get("agent:main:reentrant-expire")).toBe(operation);
    expect(forceClearReplyOperation(operation)).toBe(true);
    expect(replyRunRegistry.get("agent:main:reentrant-expire")).toBeUndefined();
  });

  it("keeps supersession attribution when backend cancellation re-enters user abort", () => {
    const operation = createTestReplyOperation({
      sessionKey: "agent:main:heartbeat-preemption",
      sessionId: "heartbeat-preemption-session",
      turnKind: "heartbeat",
    });
    const order: string[] = [];
    const cancel = vi.fn((reason) => {
      order.push(`cancel:${reason}`);
      operation.abortByUser();
    });
    operation.attachBackend({
      kind: "embedded",
      runId: "heartbeat-preemption-run",
      cancel,
      isStreaming: () => true,
    });
    operation.setPhase("running");

    expect(supersedeReplyRunByRunId("heartbeat-preemption-run", () => order.push("record"))).toBe(
      true,
    );
    expect(cancel).toHaveBeenCalledWith("superseded");
    expect(order).toEqual(["record", "cancel:superseded"]);
    expect(operation.result).toEqual({
      kind: "aborted",
      code: "aborted_for_supersession",
    });
  });

  it("supersedes an abort-frozen heartbeat owner without cancelling its backend", () => {
    const beforeSupersede = vi.fn();
    const cancel = vi.fn();
    const operation = createTestReplyOperation({
      sessionKey: "agent:main:heartbeat-frozen",
      sessionId: "heartbeat-frozen-session",
      turnKind: "heartbeat",
    });
    operation.attachBackend({
      kind: "embedded",
      runId: "heartbeat-frozen-run",
      cancel,
      isStreaming: () => true,
    });
    operation.setPhase("running");
    operation.freezeAbort();

    expect(supersedeReplyRunByRunId("heartbeat-frozen-run", beforeSupersede)).toBe(true);
    expect(beforeSupersede).toHaveBeenCalledTimes(1);
    expect(cancel).not.toHaveBeenCalled();
    expect(operation.result).toEqual({
      kind: "aborted",
      code: "aborted_for_supersession",
    });
  });

  it("does not supersede a retained terminal reply owner", () => {
    const beforeSupersede = vi.fn();
    const cancel = vi.fn();
    const operation = createTestReplyOperation({
      sessionKey: "agent:main:terminal-reply",
      sessionId: "terminal-reply-session",
    });
    operation.attachBackend({
      kind: "cli",
      runId: "terminal-reply-run",
      cancel,
    });
    operation.setPhase("running");
    operation.retainFailureUntilComplete();
    operation.fail("run_failed", new Error("delivery pending"));

    expect(supersedeReplyRunByRunId("terminal-reply-run", beforeSupersede)).toBe(false);
    expect(beforeSupersede).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(operation.result).toMatchObject({ kind: "failed", code: "run_failed" });
  });

  it("cancels terminal settle when the owner clears state first", async () => {
    await withFakeReplyTimers(async () => {
      const warnSpy = vi.spyOn(diagnosticLogger, "warn").mockImplementation(() => undefined);
      const operation = createTestReplyOperation({
        sessionKey: "agent:main:owner-clears",
        sessionId: "session-owner-clears",
      });
      operation.setPhase("running");

      operation.abortByUser();
      operation.complete();
      await vi.advanceTimersByTimeAsync(REPLY_RUN_TERMINAL_SETTLE_TIMEOUT_MS);

      expect(replyRunRegistry.isActive("agent:main:owner-clears")).toBe(false);
      expect(warnSpy).not.toHaveBeenCalledWith(
        expect.stringContaining("reply run terminal settle: forced release"),
      );
    });
  });

  it("force-clears retained failed operations", () => {
    const operation = createTestReplyOperation({
      sessionId: "session-retained",
    });
    operation.retainFailureUntilComplete();

    expect(forceClearReplyRunBySessionId("session-retained", new Error("stuck"))).toBe(true);
    expect(operation.result).toMatchObject({ kind: "failed", code: "run_failed" });
    expect(replyRunRegistry.isActive("agent:main:main")).toBe(false);
  });

  it("does not force-clear a replacement operation through a stale owner", () => {
    const original = createTestReplyOperation({ sessionId: "session-reused" });
    original.complete();
    const replacement = createTestReplyOperation({ sessionId: "session-reused" });

    expect(forceClearReplyOperation(original, new Error("stuck"))).toBe(false);
    expect(replacement.result).toBeNull();
    expect(isReplyRunActiveForSessionId("session-reused")).toBe(true);
  });

  it("force-clears a running operation after abort without backend cleanup", async () => {
    await withFakeReplyTimers(async () => {
      const cancel = vi.fn();
      const operation = createTestReplyOperation({
        sessionId: "session-running",
      });
      operation.attachBackend({
        kind: "embedded",
        cancel,
        isStreaming: () => true,
      });
      operation.setPhase("running");

      operation.abortByUser();
      const waitPromise = waitForReplyRunEndBySessionId("session-running", 1_000);

      expect(operation.result).toEqual({ kind: "aborted", code: "aborted_by_user" });
      expect(cancel).toHaveBeenCalledWith("user_abort");
      expect(isReplyRunActiveForSessionId("session-running")).toBe(true);

      expect(forceClearReplyRunBySessionId("session-running", new Error("stuck"))).toBe(true);

      expect(isReplyRunActiveForSessionId("session-running")).toBe(false);
      await expect(waitPromise).resolves.toBe(true);
    });
  });

  it("rejects aborts while the attached backend is finalizing", () => {
    let abortable = false;
    const cancel = vi.fn();
    const operation = createTestReplyOperation({
      sessionKey: "agent:main:finalizing",
      sessionId: "session-finalizing",
    });
    operation.attachBackend({
      kind: "embedded",
      cancel,
      isStreaming: () => false,
      isAbortable: () => abortable,
    });
    operation.setPhase("running");

    expect(replyRunRegistry.abort("agent:main:finalizing")).toBe(false);
    expect(abortActiveReplyRuns({ mode: "all" })).toBe(false);
    expect(operation.result).toBeNull();
    expect(cancel).not.toHaveBeenCalled();

    abortable = true;
    expect(replyRunRegistry.abort("agent:main:finalizing")).toBe(true);
    expect(operation.result).toEqual({ kind: "aborted", code: "aborted_by_user" });
    expect(cancel).toHaveBeenCalledWith("user_abort");
  });

  it("keeps finalizing reply bookkeeping through forced in-process restart", () => {
    const cancel = vi.fn();
    const operation = createTestReplyOperation({
      sessionKey: "agent:main:restart-finalizing",
      sessionId: "session-restart-finalizing",
    });
    operation.attachBackend({
      kind: "embedded",
      cancel,
      isStreaming: () => false,
      isAbortable: () => false,
    });
    operation.setPhase("running");

    expect(abortActiveReplyRuns({ mode: "all" })).toBe(false);
    expect(replyRunRegistry.isActive("agent:main:restart-finalizing")).toBe(true);
    expect(operation.result).toBeNull();
    expect(cancel).not.toHaveBeenCalled();

    operation.complete();
    expect(replyRunRegistry.isActive("agent:main:restart-finalizing")).toBe(false);
  });

  it("keeps abort frozen after the backend detaches for reply delivery", () => {
    const cancel = vi.fn();
    const upstreamAbort = new AbortController();
    const operation = createTestReplyOperation({
      sessionKey: "agent:main:delivery-finalizing",
      sessionId: "session-delivery-finalizing",
      upstreamAbortSignal: upstreamAbort.signal,
    });
    const backend = {
      kind: "embedded" as const,
      cancel,
      isStreaming: () => false,
      isAbortable: () => false,
    };
    operation.attachBackend(backend);
    operation.setPhase("running");
    operation.freezeAbort();
    operation.detachBackend(backend);

    expect(operation.phase).toBe("running");
    expect(isReplyRunAbortableForSignal(upstreamAbort.signal)).toBe(false);
    expect(isReplyRunAbortableForSignal(new AbortController().signal)).toBe(true);
    expect(replyRunRegistry.abort("agent:main:delivery-finalizing")).toBe(false);
    expect(operation.result).toBeNull();
    expect(cancel).not.toHaveBeenCalled();

    upstreamAbort.abort();
    expect(operation.abortSignal.aborted).toBe(false);

    operation.complete();
    expect(replyRunRegistry.isActive("agent:main:delivery-finalizing")).toBe(false);
    expect(isReplyRunAbortableForSignal(upstreamAbort.signal)).toBe(false);
  });

  it("reports a committed terminal outcome only while delivery is still finalizing", () => {
    const operation = createTestReplyOperation({
      sessionKey: "agent:main:committed-outcome",
      sessionId: "session-committed-outcome",
    });
    operation.setPhase("running");
    expect(hasCommittedReplyOperationOutcome(operation)).toBe(false);

    operation.freezeAbort();
    expect(hasCommittedReplyOperationOutcome(operation)).toBe(true);

    operation.complete();
    expect(hasCommittedReplyOperationOutcome(operation)).toBe(false);
  });

  it("expires finalization when its owner stops making progress", async () => {
    await withFakeReplyTimers(async () => {
      const afterClear = vi.fn();
      const operation = createTestReplyOperation({
        sessionKey: "agent:main:hung-finalization",
        sessionId: "session-hung-finalization",
      });
      operation.setPhase("running");
      runAfterReplyOperationClear(operation, afterClear);

      operation.freezeAbort();
      await vi.advanceTimersByTimeAsync(REPLY_RUN_FINALIZATION_SETTLE_TIMEOUT_MS - 1);

      expect(replyRunRegistry.get("agent:main:hung-finalization")).toBe(operation);
      expect(operation.result).toBeNull();
      expect(operation.abortSignal.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(1);

      expect(replyRunRegistry.get("agent:main:hung-finalization")).toBeUndefined();
      expect(operation.result).toEqual({ kind: "failed", code: "run_stalled" });
      expect(operation.phase).toBe("failed");
      expect(operation.abortSignal.aborted).toBe(true);
      expect(afterClear).toHaveBeenCalledTimes(1);
    });
  });

  it("renews finalization from owner progress", async () => {
    await withFakeReplyTimers(async () => {
      const operation = createTestReplyOperation({
        sessionKey: "agent:main:progressing-finalization",
        sessionId: "session-progressing-finalization",
      });
      operation.setPhase("running");
      operation.freezeAbort();

      await vi.advanceTimersByTimeAsync(REPLY_RUN_FINALIZATION_SETTLE_TIMEOUT_MS - 15_000);
      operation.recordActivity();
      await vi.advanceTimersByTimeAsync(15_000);

      expect(replyRunRegistry.get("agent:main:progressing-finalization")).toBe(operation);
      expect(operation.result).toBeNull();

      await vi.advanceTimersByTimeAsync(REPLY_RUN_FINALIZATION_SETTLE_TIMEOUT_MS - 15_000);

      expect(replyRunRegistry.get("agent:main:progressing-finalization")).toBeUndefined();
      expect(operation.result).toEqual({ kind: "failed", code: "run_stalled" });
    });
  });

  it("preserves bounded work that starts before finalization", async () => {
    await withFakeReplyTimers(async () => {
      const operation = createTestReplyOperation({
        sessionKey: "agent:main:pre-finalization-work",
        sessionId: "session-pre-finalization-work",
      });
      operation.setPhase("running");
      beginReplyOperationFinalizationWork(operation, REPLY_RUN_FINALIZATION_SETTLE_TIMEOUT_MS * 2);

      await vi.advanceTimersByTimeAsync(30_000);
      operation.freezeAbort();
      await vi.advanceTimersByTimeAsync(REPLY_RUN_FINALIZATION_SETTLE_TIMEOUT_MS);

      expect(replyRunRegistry.get("agent:main:pre-finalization-work")).toBe(operation);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(replyRunRegistry.get("agent:main:pre-finalization-work")).toBeUndefined();
      expect(operation.result).toEqual({ kind: "failed", code: "run_stalled" });
    });
  });

  it("does not shorten bounded work when ordinary activity renews", async () => {
    await withFakeReplyTimers(async () => {
      const operation = createTestReplyOperation({
        sessionKey: "agent:main:overlapping-finalization-work",
        sessionId: "session-overlapping-finalization-work",
      });
      operation.setPhase("running");
      operation.freezeAbort();
      beginReplyOperationFinalizationWork(operation, REPLY_RUN_FINALIZATION_SETTLE_TIMEOUT_MS * 2);

      await vi.advanceTimersByTimeAsync(REPLY_RUN_FINALIZATION_SETTLE_TIMEOUT_MS - 15_000);
      operation.recordActivity();
      await vi.advanceTimersByTimeAsync(REPLY_RUN_FINALIZATION_SETTLE_TIMEOUT_MS);

      expect(replyRunRegistry.get("agent:main:overlapping-finalization-work")).toBe(operation);

      await vi.advanceTimersByTimeAsync(15_000);
      expect(replyRunRegistry.get("agent:main:overlapping-finalization-work")).toBeUndefined();
      expect(operation.result).toEqual({ kind: "failed", code: "run_stalled" });
    });
  });

  it("honors a bounded extended finalization lease", async () => {
    await withFakeReplyTimers(async () => {
      const operation = createTestReplyOperation({
        sessionKey: "agent:main:extended-finalization",
        sessionId: "session-extended-finalization",
      });
      operation.setPhase("running");
      operation.freezeAbort();
      beginReplyOperationFinalizationWork(operation, REPLY_RUN_FINALIZATION_SETTLE_TIMEOUT_MS * 2);

      await vi.advanceTimersByTimeAsync(REPLY_RUN_FINALIZATION_SETTLE_TIMEOUT_MS);
      expect(replyRunRegistry.get("agent:main:extended-finalization")).toBe(operation);

      await vi.advanceTimersByTimeAsync(REPLY_RUN_FINALIZATION_SETTLE_TIMEOUT_MS);
      expect(replyRunRegistry.get("agent:main:extended-finalization")).toBeUndefined();
      expect(operation.result).toEqual({ kind: "failed", code: "run_stalled" });
    });
  });

  it("keeps late finalization cleanup from clearing a successor", async () => {
    await withFakeReplyTimers(async () => {
      const operation = createTestReplyOperation({
        sessionKey: "agent:main:late-finalization",
        sessionId: "session-late-finalization",
      });
      operation.setPhase("running");
      operation.freezeAbort();
      await vi.advanceTimersByTimeAsync(REPLY_RUN_FINALIZATION_SETTLE_TIMEOUT_MS);

      const successor = createTestReplyOperation({
        sessionKey: "agent:main:late-finalization",
        sessionId: "session-successor",
      });
      operation.complete();

      expect(replyRunRegistry.get("agent:main:late-finalization")).toBe(successor);
      successor.complete();
    });
  });

  it("clamps oversized wait timers instead of resolving idle waits immediately", async () => {
    await withFakeReplyTimers(async () => {
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
      const operation = createTestReplyOperation({
        sessionId: "session-running",
      });

      const waitPromise = waitForReplyRunEndBySessionId(
        "session-running",
        MAX_TIMER_TIMEOUT_MS + 1,
      );

      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
      operation.complete();
      await expect(waitPromise).resolves.toBe(true);
    });
  });

  it("waits for reply-run completion without a timer when requested", async () => {
    await withFakeReplyTimers(async () => {
      const operation = createTestReplyOperation({
        sessionKey: "agent:main:unbounded",
        sessionId: "session-unbounded",
      });
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

      const waitPromise = waitForReplyRunEndBySessionId("session-unbounded", null);

      expect(setTimeoutSpy).not.toHaveBeenCalled();
      operation.complete();
      await expect(waitPromise).resolves.toBe(true);
    });
  });

  it("queues messages only through the active running backend", async () => {
    const queueMessage = vi.fn(async () => {});
    const operation = createTestReplyOperation({
      sessionId: "session-running",
    });

    operation.attachBackend({
      kind: "embedded",
      cancel: vi.fn(),
      isStreaming: () => true,
      queueMessage,
    });

    await expect(
      queueCurrentReplyRunMessage("session-running", "before running"),
    ).resolves.toMatchObject({ status: "rejected" });

    operation.setPhase("running");

    await expect(queueCurrentReplyRunMessage("session-running", "hello")).resolves.toEqual({
      status: "accepted",
    });
    expect(queueMessage).toHaveBeenCalledWith(
      "hello",
      expect.objectContaining({ onQueueAccepted: expect.any(Function) }),
    );
  });

  it("queues messages only when the task-suggestion tool surface matches", async () => {
    const queueMessage = vi.fn(async () => {});
    const operation = createTestReplyOperation({
      sessionId: "session-task-suggestions",
    });
    operation.attachBackend({
      kind: "embedded",
      taskSuggestionDeliveryMode: "gateway",
      cancel: vi.fn(),
      isStreaming: () => true,
      queueMessage,
    });
    operation.setPhase("running");

    await expect(
      queueCurrentReplyRunMessage("session-task-suggestions", "legacy client", {
        taskSuggestionDeliveryMode: undefined,
      }),
    ).resolves.toEqual({ status: "rejected", reason: "task_suggestion_delivery_mode_mismatch" });
    await expect(
      queueCurrentReplyRunMessage("session-task-suggestions", "capable client", {
        taskSuggestionDeliveryMode: "gateway",
      }),
    ).resolves.toEqual({ status: "accepted" });
    await expect(
      queueCurrentReplyRunMessage("session-task-suggestions", "internal completion"),
    ).resolves.toEqual({ status: "accepted" });
    expect(queueMessage).toHaveBeenCalledTimes(2);
    expect(queueMessage).toHaveBeenNthCalledWith(
      1,
      "capable client",
      expect.objectContaining({
        taskSuggestionDeliveryMode: "gateway",
        onQueueAccepted: expect.any(Function),
      }),
    );
    expect(queueMessage).toHaveBeenNthCalledWith(
      2,
      "internal completion",
      expect.objectContaining({ onQueueAccepted: expect.any(Function) }),
    );
  });

  it.each([
    { images: [{ type: "image" as const, data: "png", mimeType: "image/png" }] },
    { media: [{ path: "/tmp/stored.png", contentType: "image/png" }] },
    { imageOrder: ["offloaded" as const] },
  ])("queues image inputs only through backends that preserve them: %j", async (input) => {
    const queueMessage = vi.fn(async () => {});
    const operation = createTestReplyOperation({
      sessionId: "session-images",
    });
    operation.attachBackend({
      kind: "embedded",
      cancel: vi.fn(),
      isStreaming: () => true,
      queueMessage,
    });
    operation.setPhase("running");

    await expect(
      queueCurrentReplyRunMessage("session-images", "inspect", input),
    ).resolves.toMatchObject({ status: "rejected", reason: "image_input_unsupported" });
    expect(queueMessage).not.toHaveBeenCalled();

    operation.attachBackend({
      kind: "embedded",
      cancel: vi.fn(),
      isStreaming: () => true,
      queueMessage,
      supportsQueueMessageImages: true,
    });

    await expect(queueCurrentReplyRunMessage("session-images", "inspect", input)).resolves.toEqual({
      status: "accepted",
    });
    expect(queueMessage).toHaveBeenCalledWith(
      "inspect",
      expect.objectContaining({ ...input, onQueueAccepted: expect.any(Function) }),
    );
  });

  it("queues messages through queue-first legacy backends while token streaming is idle", async () => {
    const queueMessage = vi.fn(async () => {});
    const operation = createTestReplyOperation({
      sessionId: "session-running",
    });

    operation.attachBackend({
      kind: "embedded",
      cancel: vi.fn(),
      isStreaming: () => false,
      queueMessage,
    });
    operation.setPhase("running");

    await expect(queueCurrentReplyRunMessage("session-running", "hello")).resolves.toEqual({
      status: "accepted",
    });
    expect(queueMessage).toHaveBeenCalledWith(
      "hello",
      expect.objectContaining({ onQueueAccepted: expect.any(Function) }),
    );
  });

  it("rejects inbound steering when tool authority changes before backend admission", async () => {
    const queueMessage = vi.fn(async () => {});
    const operation = createTestReplyOperation({ sessionId: "session-authority" });
    operation.bindToolAuthoritySnapshot({
      fingerprint: () => "authority-a",
      project: () => "authority-a",
    });
    operation.attachBackend({
      kind: "embedded",
      cancel: vi.fn(),
      isStreaming: () => true,
      queueMessage,
    });
    operation.setPhase("running");

    await expect(
      queueCurrentReplyRunMessage("session-authority", "restricted turn", {
        isInboundUserMessage: true,
        toolAuthorityFingerprint: "authority-b",
      }),
    ).resolves.toMatchObject({ status: "rejected", reason: "tool_authority_mismatch" });
    expect(queueMessage).not.toHaveBeenCalled();

    await expect(
      queueCurrentReplyRunMessage("session-authority", "same authority", {
        isInboundUserMessage: true,
        toolAuthorityFingerprint: "authority-a",
      }),
    ).resolves.toEqual({ status: "accepted" });
  });

  it("projects inbound authority before backend admission without forwarding the overlay", async () => {
    const run = createQueueTestRun({ prompt: "projected inbound" });
    const route = { provider: "openai", model: "gpt-primary" };
    const overlay = toolAuthorityOverlay(run);
    const queueMessage = vi.fn(
      async (_text: string, _options?: ReplyBackendQueueMessageOptions) => {},
    );
    const operation = createTestReplyOperation({ sessionId: "session-projected-authority" });
    operation.bindToolAuthoritySnapshot(prepareReplyToolAuthority(run));
    operation.bindToolAuthorityRoute(route);
    operation.attachBackend({
      kind: "embedded",
      cancel: vi.fn(),
      isStreaming: () => true,
      queueMessage,
    });
    operation.setPhase("running");

    await expect(
      queueCurrentReplyRunMessage("session-projected-authority", "same authority", {
        isInboundUserMessage: true,
        toolAuthorityFingerprint: "caller-cannot-override-projection",
        toolAuthorityOverlay: overlay,
      }),
    ).resolves.toEqual({ status: "accepted" });
    const forwardedOptions = queueMessage.mock.calls[0]?.[1];
    expect(forwardedOptions).toMatchObject({
      isInboundUserMessage: true,
      toolAuthorityFingerprint: resolveFollowupRunToolAuthorityFingerprint(run, route),
    });
    expect(forwardedOptions).not.toHaveProperty("toolAuthorityOverlay");

    await expect(
      queueCurrentReplyRunMessage("session-projected-authority", "changed authority", {
        isInboundUserMessage: true,
        toolAuthorityOverlay: { ...overlay, clientCaps: ["changed-capability"] },
      }),
    ).resolves.toMatchObject({ status: "rejected", reason: "tool_authority_mismatch" });
    expect(queueMessage).toHaveBeenCalledOnce();

    await expect(
      queueCurrentReplyRunMessage("session-projected-authority", "restricted authority", {
        isInboundUserMessage: true,
        toolAuthorityOverlay: { ...overlay, permissionMode: "guarded" },
      }),
    ).resolves.toMatchObject({ status: "rejected", reason: "tool_authority_mismatch" });
    expect(queueMessage).toHaveBeenCalledOnce();
  });

  it("refuses stale injectable owners for admission and delivery until activity resumes", async () => {
    vi.useFakeTimers();
    try {
      const queueMessage = vi.fn(async () => {});
      const operation = createTestReplyOperation({
        sessionId: "session-running",
        originatingLeafEntryId: "leaf-a",
      });
      operation.attachBackend({
        kind: "embedded",
        cancel: vi.fn(),
        isStreaming: () => false,
        isStopped: () => false,
        queueMessage,
      });
      operation.setPhase("running");

      const target = replyRunRegistry.resolveCurrentMessageInjectionTarget("agent:main:main");
      expect(target).toBeDefined();

      vi.advanceTimersByTime(RUN_STALE_TAKEOVER_MS + 1);

      expect(
        replyRunRegistry.resolveCurrentMessageInjectionTarget("agent:main:main"),
      ).toBeUndefined();
      await expect(queueReplyMessageInjectionTarget(target!, "stale")).resolves.toMatchObject({
        status: "rejected",
        reason: "stale_run",
      });
      expect(queueMessage).not.toHaveBeenCalled();

      operation.recordActivity();

      expect(
        replyRunRegistry.resolveCurrentMessageInjectionTarget("agent:main:main"),
      ).toBeDefined();
      await expect(queueReplyMessageInjectionTarget(target!, "fresh")).resolves.toEqual({
        status: "accepted",
      });
      expect(queueMessage).toHaveBeenCalledWith(
        "fresh",
        expect.objectContaining({ onQueueAccepted: expect.any(Function) }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not queue messages through stopped backends", async () => {
    const queueMessage = vi.fn(async () => {});
    const operation = createTestReplyOperation({
      sessionId: "session-running",
    });

    operation.attachBackend({
      kind: "embedded",
      cancel: vi.fn(),
      isStreaming: () => true,
      isStopped: () => true,
      queueMessage,
    });
    operation.setPhase("running");

    await expect(queueCurrentReplyRunMessage("session-running", "hello")).resolves.toMatchObject({
      status: "rejected",
      reason: "injection_unavailable",
    });
    expect(queueMessage).not.toHaveBeenCalled();
  });

  it("fails closed when backend stopped state checks throw", async () => {
    const queueMessage = vi.fn(async () => {});
    const operation = createTestReplyOperation({
      sessionId: "session-running",
    });

    operation.attachBackend({
      kind: "embedded",
      cancel: vi.fn(),
      isStreaming: () => true,
      isStopped: () => {
        throw new Error("bad stopped state");
      },
      queueMessage,
    });
    operation.setPhase("running");

    await expect(queueCurrentReplyRunMessage("session-running", "hello")).resolves.toMatchObject({
      status: "rejected",
      reason: "injection_unavailable",
    });
    expect(queueMessage).not.toHaveBeenCalled();
  });

  it("requires a real injection capability", () => {
    const operation = createTestReplyOperation({ originatingLeafEntryId: "leaf-a" });
    operation.setPhase("running");
    operation.attachBackend({ kind: "cli", runId: "run-a", cancel: vi.fn() });

    expect(replyRunRegistry.resolveCurrentMessageInjectionTarget(operation.key)).toBeUndefined();
  });

  it.each(
    (["sync", "async", "mismatched-question"] as const).flatMap((source) =>
      [false, true].map((unconfirmed) => ({ source, unconfirmed })),
    ),
  )(
    "distinguishes rejection from non-replayable input: $source (unconfirmed=$unconfirmed)",
    async ({ source, unconfirmed }) => {
      const cause = new Error(`${source} rejection`);
      const error = unconfirmed ? new QuestionAnswerUnconfirmedError(cause) : cause;
      const queueMessage = vi.fn((): Promise<void> => {
        if (source === "sync") {
          throw error;
        }
        return Promise.reject(error);
      });
      const claimPendingUserInputAnswer = vi.fn(async () => {
        throw error;
      });
      const operation = createTestReplyOperation({ originatingLeafEntryId: "leaf-a" });
      operation.setPhase("running");
      operation.attachBackend({
        kind: "embedded",
        runId: "run-a",
        toolAuthorityFingerprint: "active-authority",
        cancel: vi.fn(),
        claimPendingUserInputAnswer,
        messageInjection: { isAvailable: () => true, queueMessage },
      });
      const target = replyRunRegistry.resolveCurrentMessageInjectionTarget(operation.key)!;
      const confirmSteerTargetRunIdForPersistence = vi.fn(async () => {});
      const recorder = {
        ...createUserTurnTranscriptRecorder({
          input: { text: "answer" },
          target: createTestUserTurnTranscriptTarget(),
        }),
        confirmSteerTargetRunIdForPersistence,
      };
      const onQueueAccepted = vi.fn();
      const mismatch = source === "mismatched-question";
      const attempt = beginReplyMessageInjectionTarget(target, "answer", {
        isInboundUserMessage: true,
        toolAuthorityFingerprint: mismatch ? "incoming-authority" : "active-authority",
        pendingInputAuthorityFingerprint: "active-authority",
        waitForTranscriptCommit: true,
        userTurnTranscriptRecorder: recorder,
        onQueueAccepted,
      });

      await expect(attempt.acceptance).resolves.toBe(unconfirmed);
      if (unconfirmed) {
        await expect(attempt.outcome).resolves.toEqual({
          status: "indeterminate",
          errorMessage: error.message,
        });
        expect(onQueueAccepted).toHaveBeenCalledExactlyOnceWith(true);
      } else {
        await expect(attempt.outcome).resolves.toMatchObject({
          status: "rejected",
          reason: "runtime_rejected",
          errorMessage: String(error),
        });
      }
      expect(confirmSteerTargetRunIdForPersistence).not.toHaveBeenCalled();
      expect(queueMessage).toHaveBeenCalledTimes(mismatch ? 0 : 1);
      expect(claimPendingUserInputAnswer).toHaveBeenCalledTimes(mismatch ? 1 : 0);
    },
  );

  it("reports callback acceptance before outcome and composes the caller callback", async () => {
    const delivery = createDeferred();
    const callerOnQueueAccepted = vi.fn();
    let queueOptions: ReplyBackendQueueMessageOptions | undefined;
    const operation = createTestReplyOperation({ originatingLeafEntryId: "leaf-a" });
    operation.setPhase("running");
    operation.attachBackend({
      kind: "embedded",
      runId: "run-a",
      cancel: vi.fn(),
      messageInjection: {
        isAvailable: () => true,
        queueMessage: vi.fn((_text, options) => {
          queueOptions = options;
          return delivery.promise;
        }),
      },
    });
    const target = replyRunRegistry.resolveCurrentMessageInjectionTarget(operation.key)!;
    const attempt = beginReplyMessageInjectionTarget(target, "accepted", {
      onQueueAccepted: callerOnQueueAccepted,
    });
    let outcomeSettled = false;
    void attempt.outcome.then(() => {
      outcomeSettled = true;
    });

    queueOptions?.onQueueAccepted?.(true);

    await expect(attempt.acceptance).resolves.toBe(true);
    expect(callerOnQueueAccepted).toHaveBeenCalledWith(true);
    expect(outcomeSettled).toBe(false);
    delivery.resolve();
    await expect(attempt.outcome).resolves.toEqual({ status: "accepted" });
  });

  it("falls back to queue settlement when the backend ignores acceptance callbacks", async () => {
    const operation = createTestReplyOperation({ originatingLeafEntryId: "leaf-a" });
    operation.setPhase("running");
    operation.attachBackend({
      kind: "embedded",
      runId: "run-a",
      cancel: vi.fn(),
      messageInjection: { isAvailable: () => true, queueMessage: vi.fn(async () => {}) },
    });
    const target = replyRunRegistry.resolveCurrentMessageInjectionTarget(operation.key)!;
    const accepted = beginReplyMessageInjectionTarget(target, "accepted");
    await expect(accepted.acceptance).resolves.toBe(true);

    operation.attachBackend({
      kind: "embedded",
      runId: "run-a",
      cancel: vi.fn(),
      messageInjection: {
        isAvailable: () => true,
        queueMessage: vi.fn(async () => {
          throw new Error("rejected");
        }),
      },
    });
    const rejected = beginReplyMessageInjectionTarget(target, "rejected");
    await expect(rejected.acceptance).resolves.toBe(false);
  });

  it("keeps callback acceptance authoritative over later queue rejection", async () => {
    const delivery = createDeferred();
    let queueOptions: ReplyBackendQueueMessageOptions | undefined;
    const operation = createTestReplyOperation({ originatingLeafEntryId: "leaf-a" });
    operation.setPhase("running");
    operation.attachBackend({
      kind: "embedded",
      runId: "run-a",
      cancel: vi.fn(),
      messageInjection: {
        isAvailable: () => true,
        queueMessage: vi.fn((_text, options) => {
          queueOptions = options;
          return delivery.promise;
        }),
      },
    });
    const target = replyRunRegistry.resolveCurrentMessageInjectionTarget(operation.key)!;
    const attempt = beginReplyMessageInjectionTarget(target, "uncertain");

    queueOptions?.onQueueAccepted?.(true);
    delivery.reject(new Error("transcript unconfirmed"));

    await expect(attempt.acceptance).resolves.toBe(true);
    await expect(attempt.outcome).resolves.toMatchObject({ status: "rejected" });
  });

  it("rejects an ABA successor even when key and leaf are reused", async () => {
    const first = createTestReplyOperation({ originatingLeafEntryId: "leaf-a" });
    first.setPhase("running");
    first.attachBackend({
      kind: "embedded",
      runId: "run-a",
      cancel: vi.fn(),
      messageInjection: { isAvailable: () => true, queueMessage: vi.fn(async () => {}) },
    });
    const target = replyRunRegistry.resolveCurrentMessageInjectionTarget(first.key)!;
    first.complete();
    const successorQueue = vi.fn(async () => {});
    const successor = createTestReplyOperation({ originatingLeafEntryId: "leaf-a" });
    successor.setPhase("running");
    successor.attachBackend({
      kind: "embedded",
      runId: "run-a",
      cancel: vi.fn(),
      messageInjection: { isAvailable: () => true, queueMessage: successorQueue },
    });

    await expect(queueReplyMessageInjectionTarget(target, "must not move")).resolves.toMatchObject({
      status: "rejected",
      reason: "no_active_run",
    });
    expect(successorQueue).not.toHaveBeenCalled();
  });

  it("uses a replacement backend on the same operation", async () => {
    const operation = createTestReplyOperation({ originatingLeafEntryId: "leaf-a" });
    operation.setPhase("running");
    const firstQueue = vi.fn(async () => {});
    const first = {
      kind: "embedded" as const,
      runId: "run-a",
      cancel: vi.fn(),
      messageInjection: { isAvailable: () => true, queueMessage: firstQueue },
    };
    operation.attachBackend(first);
    const target = replyRunRegistry.resolveCurrentMessageInjectionTarget(operation.key)!;
    const replacementQueue = vi.fn(async () => {});
    operation.attachBackend({
      kind: "embedded",
      runId: "run-a",
      cancel: vi.fn(),
      messageInjection: { isAvailable: () => true, queueMessage: replacementQueue },
    });

    await expect(queueReplyMessageInjectionTarget(target, "replacement")).resolves.toEqual({
      status: "accepted",
    });
    expect(firstQueue).not.toHaveBeenCalled();
    expect(replacementQueue).toHaveBeenCalledWith(
      "replacement",
      expect.objectContaining({ onQueueAccepted: expect.any(Function) }),
    );
  });

  it("keeps an invoked queue authoritative when the owner clears synchronously", async () => {
    const operation = createTestReplyOperation({ originatingLeafEntryId: "leaf-a" });
    operation.setPhase("running");
    const queueMessage = vi.fn(async () => {
      operation.complete();
    });
    operation.attachBackend({
      kind: "embedded",
      runId: "run-a",
      cancel: vi.fn(),
      messageInjection: { isAvailable: () => true, queueMessage },
    });
    const target = replyRunRegistry.resolveCurrentMessageInjectionTarget(operation.key)!;

    await expect(queueReplyMessageInjectionTarget(target, "last input")).resolves.toEqual({
      status: "accepted",
    });
    expect(replyRunRegistry.isActive(operation.key)).toBe(false);
  });

  it("aborts compacting runs through the registry compatibility helper", () => {
    const compactingOperation = createTestReplyOperation({
      sessionId: "session-compacting",
    });
    compactingOperation.setPhase("preflight_compacting");

    const runningOperation = createTestReplyOperation({
      sessionKey: "agent:main:other",
      sessionId: "session-running",
    });
    runningOperation.setPhase("running");

    expect(abortActiveReplyRuns({ mode: "compacting" })).toBe(true);
    expect(compactingOperation.result).toEqual({ kind: "aborted", code: "aborted_for_restart" });
    expect(runningOperation.result).toBeNull();
  });

  it("moves a queued reservation to the target slot and frees the source", async () => {
    const sourceSessionKey = "agent:main:telegram:slash:rekey-user";
    const targetSessionKey = "agent:main:telegram:group:rekey-target";
    const operation = createTestReplyOperation({
      sessionKey: sourceSessionKey,
      sessionId: "rekey-session",
    });
    const sourceIdle = replyRunRegistry.waitForIdle(sourceSessionKey, 1_000);

    operation.updateSessionKey(targetSessionKey);

    expect(operation.key).toBe(targetSessionKey);
    expect(replyRunRegistry.get(sourceSessionKey)).toBeUndefined();
    expect(replyRunRegistry.get(targetSessionKey)).toBe(operation);
    expect(resolveActiveReplyRunSessionId(targetSessionKey)).toBe("rekey-session");
    await expect(sourceIdle).resolves.toBe(true);

    const targetWait = waitForReplyRunEndBySessionId("rekey-session", 1_000);
    operation.complete();
    await expect(targetWait).resolves.toBe(true);
    expect(replyRunRegistry.get(targetSessionKey)).toBeUndefined();
  });

  it("refuses to rekey onto an owned target slot and keeps the source slot", () => {
    const targetSessionKey = "agent:main:telegram:group:rekey-owned";
    const sourceSessionKey = "agent:main:telegram:slash:rekey-blocked";
    const blocker = createTestReplyOperation({
      sessionKey: targetSessionKey,
      sessionId: "owned-session",
    });
    const operation = createTestReplyOperation({
      sessionKey: sourceSessionKey,
      sessionId: "blocked-session",
    });

    expect(() => operation.updateSessionKey(targetSessionKey)).toThrow(ReplyRunAlreadyActiveError);
    expect(operation.key).toBe(sourceSessionKey);
    expect(replyRunRegistry.get(sourceSessionKey)).toBe(operation);
    expect(replyRunRegistry.get(targetSessionKey)).toBe(blocker);

    blocker.complete();
    operation.complete();
  });

  it("refuses to rekey after the run leaves the queued phase", () => {
    const operation = createTestReplyOperation({
      sessionKey: "agent:main:telegram:slash:rekey-late",
      sessionId: "late-session",
    });
    operation.setPhase("running");

    expect(() => operation.updateSessionKey("agent:main:telegram:group:rekey-late")).toThrow(
      /Cannot rekey reply operation/,
    );

    operation.complete();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
