import crypto from "node:crypto";
import { isRecoverableTerminalSessionStatus } from "../../config/sessions/terminal-status.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { logVerbose } from "../../globals.js";
import type { SessionWorkAdmissionLease } from "../../sessions/session-lifecycle-admission.js";
import type { FinalizedMsgContext } from "../templating.js";
import {
  createAbortAwareDispatcher,
  DispatchReplyOperationAbortedError,
} from "./dispatch-from-config.abort.js";
import type { InboundMessageAuditTerminalRecorder } from "./dispatch-from-config.audit.js";
import { shouldLetSlackRoutedThreadBypassBusyReplyOperation } from "./dispatch-from-config.context.js";
import type { DispatchFromConfigParams } from "./dispatch-from-config.types.js";
import { waitForReplyDispatcherIdle } from "./reply-dispatcher.js";
import type { ReplyDispatcher } from "./reply-dispatcher.types.js";
import {
  forceClearReplyRunBySessionId,
  replyRunRegistry,
  type ReplyOperation,
  waitForReplyBarrierSettlement,
} from "./reply-run-registry.js";
import {
  admitReplyTurn,
  resolveReplyTurnKind,
  runWithReplyOperationLifecycleAdmission,
} from "./reply-turn-admission.js";

type DispatchReplyOperationAcquisition =
  | { status: "ready" }
  | { status: "busy" }
  | { status: "aborted" };

export function createDispatchReplyOperationCoordinator(params: {
  ctx: FinalizedMsgContext;
  dispatcher: ReplyDispatcher;
  dispatchOperationSessionKey?: string;
  initialDispatchReplyOperation?: ReplyOperation;
  messageAuditTerminal?: InboundMessageAuditTerminalRecorder;
  operationSessionStoreEntry: {
    entry?: SessionEntry;
    storePath?: string;
  };
  replyOptions?: DispatchFromConfigParams["replyOptions"];
  resolveOperationExpectedSessionId: () => string | undefined;
  routeThreadId?: string | number;
}) {
  let dispatchReplyOperation: ReplyOperation | undefined;
  let dispatchAbortOperation: ReplyOperation | undefined;
  let preDispatchAbortOperation: ReplyOperation | undefined;
  let preDispatchLifecycleAdmission: SessionWorkAdmissionLease | undefined;
  let preDispatchLifecycleAbortController: AbortController | undefined;
  let dispatchLifecycleAbortController: AbortController | undefined;
  let preDispatchLifecycleInterrupted = false;
  const dispatchLifecycleWork = new Set<Promise<void>>();

  const trackDispatchLifecycleWork = (work: Promise<unknown>) => {
    if (!dispatchReplyOperation && !preDispatchLifecycleAdmission) {
      return;
    }
    const settled = work.then(
      () => {},
      () => {},
    );
    dispatchLifecycleWork.add(settled);
    void settled.then(() => {
      dispatchLifecycleWork.delete(settled);
    });
  };

  const waitForDispatchLifecycleWorkAndDelivery = async (): Promise<void> => {
    await Promise.allSettled(Array.from(dispatchLifecycleWork));
    await waitForReplyDispatcherIdle(params.dispatcher);
  };

  const releasePreDispatchLifecycleAdmission = async (
    afterWorkBarrier?: () => PromiseLike<unknown>,
  ): Promise<void> => {
    const admission = preDispatchLifecycleAdmission;
    const preDispatchAbortController = preDispatchLifecycleAbortController;
    const dispatchAbortController = dispatchLifecycleAbortController;
    preDispatchLifecycleAdmission = undefined;
    if (!admission) {
      return;
    }
    const pendingWork = Array.from(dispatchLifecycleWork);
    const clearAbortControllers = () => {
      if (preDispatchLifecycleAbortController === preDispatchAbortController) {
        preDispatchLifecycleAbortController = undefined;
      }
      if (dispatchLifecycleAbortController === dispatchAbortController) {
        dispatchLifecycleAbortController = undefined;
      }
    };
    if (!afterWorkBarrier && pendingWork.length === 0) {
      clearAbortControllers();
      admission.release();
      return;
    }
    try {
      await Promise.allSettled(pendingWork);
      if (afterWorkBarrier) {
        await waitForReplyBarrierSettlement(
          afterWorkBarrier(),
          params.dispatcher.resolveFollowupAdmissionBarrierTimeoutPolicy?.(),
        );
      }
    } finally {
      clearAbortControllers();
      admission.release();
    }
  };

  const runWithDispatchLifecycleAdmission = async <T>(run: () => Promise<T>): Promise<T> => {
    if (dispatchReplyOperation) {
      return await runWithReplyOperationLifecycleAdmission(dispatchReplyOperation, run);
    }
    return preDispatchLifecycleAdmission
      ? await preDispatchLifecycleAdmission.run(run)
      : await run();
  };

  const ensureDispatchReplyOperation = async (
    phase: "pre_dispatch" | "dispatch",
  ): Promise<DispatchReplyOperationAcquisition> => {
    if (phase === "dispatch") {
      // The next full reply operation revalidates the persisted session. Drop
      // the hook-only lease after its queued delivery settles so a waiting
      // lifecycle mutation cannot commit while that delivery is still active.
      await releasePreDispatchLifecycleAdmission(() =>
        waitForReplyDispatcherIdle(params.dispatcher),
      );
      if (preDispatchLifecycleInterrupted) {
        return { status: dispatchReplyOperation ? "aborted" : "busy" };
      }
    }
    if (dispatchReplyOperation) {
      return { status: "ready" };
    }
    if (dispatchAbortOperation && !dispatchAbortOperation.result) {
      return dispatchReplyOperation ? { status: "ready" } : { status: "busy" };
    }
    if (
      phase === "dispatch" &&
      preDispatchAbortOperation?.result &&
      preDispatchAbortOperation.result.kind !== "completed" &&
      !dispatchReplyOperation
    ) {
      dispatchAbortOperation = preDispatchAbortOperation;
      return { status: "busy" };
    }
    if (!params.dispatchOperationSessionKey) {
      return { status: "ready" };
    }
    const operationSessionId =
      dispatchAbortOperation?.sessionId ??
      params.operationSessionStoreEntry.entry?.sessionId ??
      crypto.randomUUID();
    const replyTurnKind = resolveReplyTurnKind(params.replyOptions);
    const allowActivePreDispatch = phase === "pre_dispatch" && replyTurnKind === "visible";
    const allowGatewayQueueResolution =
      phase === "dispatch" &&
      replyTurnKind === "visible" &&
      params.replyOptions?.queuedFollowupLifecycle !== undefined &&
      replyRunRegistry.get(params.dispatchOperationSessionKey) !== undefined;
    if (allowGatewayQueueResolution) {
      // Gateway turns need to reach getReplyFromConfig while the owner is active;
      // that layer applies the session's steer/followup/collect/drop policy.
      return { status: "ready" };
    }
    const allowSlackRoutedThreadBypass =
      phase === "dispatch" &&
      shouldLetSlackRoutedThreadBypassBusyReplyOperation({
        activeOperation: replyRunRegistry.get(params.dispatchOperationSessionKey),
        ctx: params.ctx,
        routeThreadId: params.routeThreadId,
      });
    const lifecycleOnlyAbortController =
      allowActivePreDispatch || allowSlackRoutedThreadBypass ? new AbortController() : undefined;
    const onLifecycleInterrupt = () => {
      preDispatchLifecycleInterrupted = true;
      lifecycleOnlyAbortController?.abort();
    };
    let admission = await admitReplyTurn({
      sessionKey: params.dispatchOperationSessionKey,
      sessionId: operationSessionId,
      expectedSessionId: params.resolveOperationExpectedSessionId(),
      expectedActiveOperation: params.initialDispatchReplyOperation,
      storePath: params.operationSessionStoreEntry.storePath,
      kind: replyTurnKind,
      resetTriggered: false,
      routeThreadId: params.routeThreadId,
      upstreamAbortSignal: params.replyOptions?.abortSignal,
      waitForActive: !allowActivePreDispatch && !allowSlackRoutedThreadBypass,
      retainLifecycleAdmissionOnActive: allowActivePreDispatch || allowSlackRoutedThreadBypass,
      onLifecycleInterrupt,
      onReplyAdmissionWaitChange: params.replyOptions?.onReplyAdmissionWaitChange,
    });
    if (
      admission.status === "skipped" &&
      admission.reason === "active-run" &&
      // Only visible reply turns may force-clear a stale terminal operation.
      // A heartbeat/control turn can also see the terminal snapshot, but it must
      // not abort an in-flight visible recovery a concurrent visible turn just
      // admitted (before that op is marked `terminalRecovery`); let it fall
      // through to normal busy/skip handling instead.
      replyTurnKind === "visible" &&
      isRecoverableTerminalSessionStatus(params.operationSessionStoreEntry.entry?.status) &&
      // Only clear the leftover op that belongs to the SAME terminal session.
      // A concurrent reset/rotation can admit a fresh op (new sessionId) under
      // this session key while we still hold the stale terminal snapshot;
      // force-clearing by the active op's id would drop that valid in-flight
      // reply and recreate the message loss this fix exists to prevent (#86827).
      admission.activeOperation?.sessionId === params.operationSessionStoreEntry.entry?.sessionId &&
      // Only clear the proven stale leftover from the failed lifecycle. A
      // freshly-admitted visible recovery op is marked `terminalRecovery` at the
      // admission choke point below; force-failing that op would drop the very
      // recovery turn this path exists to protect (concurrent visible turns can
      // read the same terminal snapshot before it clears).
      !admission.activeOperation?.terminalRecovery
    ) {
      const cleared = forceClearReplyRunBySessionId(
        admission.activeOperation?.sessionId ?? operationSessionId,
        new Error("clearing stale terminal reply operation"),
      );
      if (cleared) {
        admission.lifecycleAdmission?.release();
        logVerbose(
          `dispatch-from-config: cleared stale active reply operation for terminal session ${params.dispatchOperationSessionKey}`,
        );
        admission = await admitReplyTurn({
          sessionKey: params.dispatchOperationSessionKey,
          sessionId: operationSessionId,
          expectedSessionId: params.resolveOperationExpectedSessionId(),
          expectedActiveOperation: params.initialDispatchReplyOperation,
          storePath: params.operationSessionStoreEntry.storePath,
          kind: replyTurnKind,
          resetTriggered: false,
          routeThreadId: params.routeThreadId,
          upstreamAbortSignal: params.replyOptions?.abortSignal,
          waitForActive: !allowActivePreDispatch && !allowSlackRoutedThreadBypass,
          retainLifecycleAdmissionOnActive: allowActivePreDispatch || allowSlackRoutedThreadBypass,
          onLifecycleInterrupt,
          onReplyAdmissionWaitChange: params.replyOptions?.onReplyAdmissionWaitChange,
        });
      }
    }
    if (admission.status === "skipped") {
      if (allowActivePreDispatch && admission.reason === "active-run") {
        preDispatchAbortOperation = admission.activeOperation;
        preDispatchLifecycleAdmission = admission.lifecycleAdmission;
        preDispatchLifecycleAbortController = lifecycleOnlyAbortController;
        return { status: "ready" };
      }
      if (
        admission.reason === "active-run" &&
        shouldLetSlackRoutedThreadBypassBusyReplyOperation({
          activeOperation: admission.activeOperation,
          ctx: params.ctx,
          routeThreadId: params.routeThreadId,
        })
      ) {
        preDispatchLifecycleAdmission = admission.lifecycleAdmission;
        dispatchLifecycleAbortController = lifecycleOnlyAbortController;
        logVerbose(
          `dispatch-from-config: allowing Slack routed thread ${params.routeThreadId} while ${params.dispatchOperationSessionKey} has an active reply operation in another Slack thread`,
        );
        return { status: "ready" };
      }
      admission.lifecycleAdmission?.release();
      dispatchAbortOperation = admission.activeOperation;
      logVerbose(
        `dispatch-from-config: skipped reply operation admission for ${params.dispatchOperationSessionKey}; reason=${admission.reason}`,
      );
      return { status: "busy" };
    }
    // Mark every freshly-admitted visible recovery of a terminal session at this
    // single choke point (both the clean no-stale admission and the
    // re-admission after a sibling force-clear flow through here). The marker
    // protects this op from being force-cleared by a concurrent sibling visible
    // turn that reads the same terminal snapshot (#86827). Genuine stale
    // leftovers from the original failed run never pass through this admission,
    // so they stay unmarked and remain force-clearable.
    if (
      replyTurnKind === "visible" &&
      isRecoverableTerminalSessionStatus(params.operationSessionStoreEntry.entry?.status) &&
      operationSessionId === params.operationSessionStoreEntry.entry?.sessionId
    ) {
      admission.operation.markTerminalRecovery();
    }
    dispatchReplyOperation = admission.operation;
    dispatchReplyOperation.retainFailureUntilComplete();
    dispatchAbortOperation = admission.operation;
    return { status: "ready" };
  };

  const getPreDispatchAbortOperation = () => dispatchAbortOperation ?? preDispatchAbortOperation;
  let cachedPreDispatchAbortSignal:
    | {
        operationSignal: AbortSignal | undefined;
        lifecycleSignal: AbortSignal | undefined;
        upstreamSignal: AbortSignal | undefined;
        signal: AbortSignal | undefined;
      }
    | undefined;
  let cachedDispatchAbortSignal:
    | {
        operationSignal: AbortSignal | undefined;
        upstreamSignal: AbortSignal | undefined;
        signal: AbortSignal | undefined;
      }
    | undefined;

  const getPreDispatchAbortSignal = () => {
    const operationSignal = getPreDispatchAbortOperation()?.abortSignal;
    const lifecycleSignal = preDispatchLifecycleAbortController?.signal;
    const upstreamSignal = params.replyOptions?.abortSignal;
    if (
      cachedPreDispatchAbortSignal &&
      cachedPreDispatchAbortSignal.operationSignal === operationSignal &&
      cachedPreDispatchAbortSignal.lifecycleSignal === lifecycleSignal &&
      cachedPreDispatchAbortSignal.upstreamSignal === upstreamSignal
    ) {
      return cachedPreDispatchAbortSignal.signal;
    }
    const abortSignals = [operationSignal, lifecycleSignal, upstreamSignal].filter(
      (signal): signal is AbortSignal => Boolean(signal),
    );
    const signal = abortSignals.length > 1 ? AbortSignal.any(abortSignals) : abortSignals[0];
    cachedPreDispatchAbortSignal = { operationSignal, lifecycleSignal, upstreamSignal, signal };
    return signal;
  };

  const getDispatchAbortSignal = () => {
    const operationSignal =
      dispatchReplyOperation?.abortSignal ?? dispatchLifecycleAbortController?.signal;
    // The operation mirrors upstream aborts until the backend commits its
    // terminal outcome, then keeps delivery alive during bounded finalization.
    const upstreamSignal = operationSignal ? undefined : params.replyOptions?.abortSignal;
    if (
      cachedDispatchAbortSignal &&
      cachedDispatchAbortSignal.operationSignal === operationSignal &&
      cachedDispatchAbortSignal.upstreamSignal === upstreamSignal
    ) {
      return cachedDispatchAbortSignal.signal;
    }
    const signal = operationSignal ?? upstreamSignal;
    cachedDispatchAbortSignal = { operationSignal, upstreamSignal, signal };
    return signal;
  };

  const getQueuedFollowupAbortSignal = () =>
    dispatchReplyOperation?.abortSignal ?? params.replyOptions?.abortSignal;
  let observedReplyDelivery = false;
  const markObservedReplyDelivery = async () => {
    if (observedReplyDelivery) {
      return;
    }
    observedReplyDelivery = true;
    await params.replyOptions?.onObservedReplyDelivery?.();
  };
  const getReplyOptions = () => {
    const abortSignal = getDispatchAbortSignal();
    const onAgentRunStart = params.messageAuditTerminal
      ? (runId: string) => {
          params.messageAuditTerminal?.observeRunId(runId);
          params.replyOptions?.onAgentRunStart?.(runId);
        }
      : undefined;
    if (!abortSignal && !onAgentRunStart) {
      return params.replyOptions;
    }
    return {
      ...params.replyOptions,
      ...(abortSignal
        ? {
            abortSignal,
            queuedFollowupAbortSignal: getQueuedFollowupAbortSignal(),
          }
        : {}),
      ...(onAgentRunStart ? { onAgentRunStart } : {}),
      ...(dispatchReplyOperation ? { replyOperation: dispatchReplyOperation } : {}),
    };
  };

  const completeDispatchReplyOperation = () => {
    const completionBarrier = waitForDispatchLifecycleWorkAndDelivery();
    void releasePreDispatchLifecycleAdmission(() => waitForReplyDispatcherIdle(params.dispatcher));
    if (dispatchReplyOperation) {
      dispatchReplyOperation.completeWithAfterClearBarrier(
        completionBarrier,
        params.dispatcher.resolveFollowupAdmissionBarrierTimeoutPolicy?.(),
      );
    }
  };

  const failDispatchReplyOperation = (error: unknown) => {
    const completionBarrier = waitForDispatchLifecycleWorkAndDelivery();
    void releasePreDispatchLifecycleAdmission(() => waitForReplyDispatcherIdle(params.dispatcher));
    if (!dispatchReplyOperation) {
      return;
    }
    dispatchReplyOperation.freezeAbort();
    if (!dispatchReplyOperation.result) {
      dispatchReplyOperation.fail("run_failed", error);
    }
    dispatchReplyOperation.completeWithAfterClearBarrier(
      completionBarrier,
      params.dispatcher.resolveFollowupAdmissionBarrierTimeoutPolicy?.(),
    );
  };

  const isDispatchOperationAborted = () => getDispatchAbortSignal()?.aborted === true;
  const isPreDispatchOperationAborted = () => getPreDispatchAbortSignal()?.aborted === true;
  const throwIfDispatchOperationAborted = () => {
    if (isDispatchOperationAborted()) {
      throw new DispatchReplyOperationAbortedError();
    }
  };

  return {
    completeDispatchReplyOperation,
    dispatchHookDispatcher: createAbortAwareDispatcher({
      dispatcher: params.dispatcher,
      isAborted: isPreDispatchOperationAborted,
    }),
    ensureDispatchReplyOperation,
    failDispatchReplyOperation,
    getDispatchAbortOperation: () => dispatchAbortOperation,
    getDispatchAbortSignal,
    getDispatchReplyOperation: () => dispatchReplyOperation,
    getReplyOptions,
    getObservedReplyDelivery: () => observedReplyDelivery,
    getPreDispatchAbortSignal,
    isDispatchOperationAborted,
    isPreDispatchOperationAborted,
    markObservedReplyDelivery,
    releasePreDispatchLifecycleAdmission,
    runWithDispatchLifecycleAdmission,
    throwIfDispatchOperationAborted,
    trackDispatchLifecycleWork,
  };
}
