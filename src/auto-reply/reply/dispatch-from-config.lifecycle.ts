import crypto from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveActiveEmbeddedRunSessionId } from "../../agents/embedded-agent-runner/active-run-projections.js";
import { normalizeChatType } from "../../channels/chat-type.js";
import { resolveGroupSessionKey } from "../../config/sessions/group.js";
import {
  isRestartRecoveryTombstone,
  isSessionWorkStartInvalidatedError,
} from "../../config/sessions/lifecycle.js";
import { patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { isRecoverableTerminalSessionStatus } from "../../config/sessions/terminal-status.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  prepareSessionWorkerPlacementMutationCheck,
  resolveWorkerPlacementArchiveRestoreError,
  type SessionWorkerPlacementContext,
} from "../../gateway/worker-environments/session-placement-lifecycle.js";
import { logVerbose } from "../../globals.js";
import {
  runExclusiveSessionLifecycleMutation,
  type SessionWorkAdmissionLease,
} from "../../sessions/session-lifecycle-admission.js";
import { classifySessionStateActor } from "../../sessions/session-state-events.js";
import {
  isNativeCommandTurn,
  resolveCommandTurnTargetSessionKey,
} from "../command-turn-context.js";
import type { FinalizedMsgContext } from "../templating.js";
import {
  createAbortAwareDispatcher,
  DispatchReplyOperationAbortedError,
} from "./dispatch-from-config.abort.js";
import type { InboundMessageAuditTerminalRecorder } from "./dispatch-from-config.audit.js";
import { shouldLetSlackRoutedThreadBypassBusyReplyOperation } from "./dispatch-from-config.context.js";
import { loadSessionStoreEntry } from "./dispatch-from-config.runtime.js";
import { createReplyTurnLedger } from "./dispatch-from-config.turn-ledger.js";
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
import { canReplaceRestartTombstoneFromParent } from "./session-parent-fork-prepare.js";
import { resolveAuthorizedSessionResetCommand } from "./session-reset-command.js";

type DispatchReplyOperationAcquisition =
  | { status: "ready" }
  | { status: "busy" }
  | { status: "aborted" };

/** Pre-dispatch session state changed before any user-visible work began. */
export class DispatchSessionRefreshRequiredError extends Error {
  constructor(cause: Error) {
    super(cause.message, { cause });
    this.name = "DispatchSessionRefreshRequiredError";
  }
}

async function restoreArchivedDispatchSession(params: {
  ctx: FinalizedMsgContext;
  entry?: SessionEntry;
  hasPluginOwnedBinding: boolean;
  placementContext?: SessionWorkerPlacementContext;
  sessionKey?: string;
  storePath?: string;
}): Promise<SessionEntry | undefined> {
  const { ctx, entry, hasPluginOwnedBinding, sessionKey, storePath } = params;
  if (
    !entry ||
    !sessionKey ||
    !storePath ||
    entry.archivedAt === undefined ||
    isRestartRecoveryTombstone(entry) ||
    hasPluginOwnedBinding ||
    ctx.InboundAccessAuthorized !== true ||
    ctx.InboundEventKind === "room_event" ||
    isNativeCommandTurn(ctx.CommandTurn) ||
    classifySessionStateActor({ inputProvenance: ctx.InputProvenance }).actorType !== "human"
  ) {
    return entry;
  }
  let placementContext = params.placementContext;
  if (!placementContext) {
    try {
      placementContext = (
        await import("../../gateway/session-worker-placement-context.js")
      ).resolveSessionWorkerPlacementContext();
    } catch {
      return entry;
    }
  }
  const snapshotSessionId = entry.sessionId;
  const snapshotArchivedAt = entry.archivedAt;
  // Admission must see the current owner: a rebound, re-archive, or unsafe placement stays untouched.
  let assertCommitAllowed: (() => void) | undefined;
  return await runExclusiveSessionLifecycleMutation({
    scope: storePath,
    identities: [sessionKey, snapshotSessionId],
    run: async () =>
      (await patchSessionEntryCore(
        { sessionKey, storePath },
        async (currentEntry) => {
          if (
            currentEntry.sessionId !== snapshotSessionId ||
            currentEntry.archivedAt !== snapshotArchivedAt ||
            isRestartRecoveryTombstone(currentEntry)
          ) {
            return null;
          }
          try {
            const placement = currentEntry.sessionId
              ? placementContext.workerSessionPlacementService
                  ?.getMany([currentEntry.sessionId])
                  .get(currentEntry.sessionId)
              : undefined;
            if (
              resolveWorkerPlacementArchiveRestoreError({
                context: placementContext,
                key: sessionKey,
                placement,
              })
            ) {
              return null;
            }
          } catch {
            return null;
          }
          if (currentEntry.worktree) {
            const { synchronizeSessionWorktreeArchive } =
              await import("../../sessions/session-worktree-lifecycle.js");
            assertCommitAllowed = prepareSessionWorkerPlacementMutationCheck({
              context: placementContext,
              sessionId: currentEntry.sessionId,
            });
            await synchronizeSessionWorktreeArchive({
              archived: false,
              entry: currentEntry,
              scope: { sessionKey, storePath },
              commitGuard: assertCommitAllowed,
            });
          }
          return { archivedAt: undefined, archivedBy: undefined, archiveReason: undefined };
        },
        { assertCommitAllowed: () => assertCommitAllowed?.() },
      )) ?? undefined,
  });
}

function resolveDispatchResetAdmission(params: {
  agentId: string;
  cfg: OpenClawConfig;
  ctx: FinalizedMsgContext;
  entry?: SessionEntry;
  hasPluginOwnedBinding: boolean;
  sessionKey?: string;
  storePath?: string;
}): {
  allowRestartTombstoneParentFork: boolean;
  allowRestartTombstoneReset: boolean;
  resetTriggered: boolean;
} {
  const { ctx, entry } = params;
  const parentSessionKey = normalizeOptionalString(ctx.ParentSessionKey);
  const commandTarget = resolveCommandTurnTargetSessionKey(ctx);
  const nativeCommandTarget = isNativeCommandTurn(ctx.CommandTurn) ? commandTarget : undefined;
  const actorType = classifySessionStateActor({
    inputProvenance: ctx.InputProvenance,
  }).actorType;
  const mayReplaceRestartTombstoneFromParent = canReplaceRestartTombstoneFromParent({
    actorType,
    entry,
    // Parent existence is the only remaining fact. Avoid its synchronous store
    // lookup until the already-loaded child and inbound authority require it.
    hasParentForkSource: true,
    hasPluginOwnedBinding: params.hasPluginOwnedBinding,
    inboundAccessAuthorized: ctx.InboundAccessAuthorized,
    inboundEventKind: ctx.InboundEventKind,
    nativeCommandTarget: commandTarget,
    sessionKey: params.sessionKey,
  });
  let hasParentForkSource = false;
  if (
    mayReplaceRestartTombstoneFromParent &&
    parentSessionKey &&
    parentSessionKey !== params.sessionKey &&
    params.storePath
  ) {
    try {
      hasParentForkSource = Boolean(
        loadSessionStoreEntry({
          agentId: params.agentId,
          storePath: params.storePath,
          sessionKey: parentSessionKey,
          readConsistency: "latest",
          clone: false,
        })?.sessionId,
      );
    } catch {
      hasParentForkSource = false;
    }
  }
  const allowRestartTombstoneParentFork =
    mayReplaceRestartTombstoneFromParent && hasParentForkSource;
  if (
    params.hasPluginOwnedBinding ||
    entry?.pluginOwnerId !== undefined ||
    ctx.InboundAccessAuthorized !== true ||
    ctx.InboundEventKind === "room_event" ||
    (nativeCommandTarget !== undefined && nativeCommandTarget !== params.sessionKey) ||
    actorType !== "human"
  ) {
    return {
      allowRestartTombstoneParentFork,
      allowRestartTombstoneReset: false,
      resetTriggered: false,
    };
  }
  const normalizedChatType = normalizeChatType(ctx.ChatType);
  const isGroup =
    normalizedChatType != null && normalizedChatType !== "direct"
      ? true
      : Boolean(resolveGroupSessionKey(ctx));
  const { resetCommand } = resolveAuthorizedSessionResetCommand({
    agentId: params.agentId,
    cfg: params.cfg,
    commandAuthorized: ctx.CommandAuthorized,
    ctx,
    isGroup,
  });
  const resetTriggered = resetCommand.matchedResetTriggerLower !== undefined;
  return {
    resetTriggered,
    allowRestartTombstoneParentFork,
    allowRestartTombstoneReset: resetTriggered && isRestartRecoveryTombstone(entry),
  };
}

export function createDispatchReplyOperationCoordinator(params: {
  allowActiveQueueResolution?: boolean;
  agentId: string;
  cfg: OpenClawConfig;
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
  sessionWorkerPlacementContext?: SessionWorkerPlacementContext;
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
  let dispatchResetTriggered = false;
  let allowRestartTombstoneParentFork = false;
  let allowRestartTombstoneReset = false;
  const dispatchLifecycleWork = {
    owner: new Set<Promise<void>>(),
    delivery: new Set<Promise<void>>(),
  };

  const trackDispatchLifecycleWork = (
    work: Promise<unknown>,
    phase: "owner" | "delivery" = "owner",
  ) => {
    if (!dispatchReplyOperation && !preDispatchLifecycleAdmission) {
      return;
    }
    const pending = dispatchLifecycleWork[phase];
    const settled = work.then(
      () => {},
      () => {},
    );
    pending.add(settled);
    void settled.then(() => {
      pending.delete(settled);
    });
  };

  const waitForDispatchDelivery = async (): Promise<void> => {
    await Promise.allSettled(Array.from(dispatchLifecycleWork.delivery));
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
    const pendingWork = [...dispatchLifecycleWork.owner, ...dispatchLifecycleWork.delivery];
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
    phase: "pre_dispatch" | "command_resolution" | "dispatch",
    hasPluginOwnedBinding = false,
  ): Promise<DispatchReplyOperationAcquisition> => {
    // Archive restoration belongs to pre-dispatch ownership resolution. Later calls only upgrade admission.
    if (phase === "pre_dispatch") {
      params.operationSessionStoreEntry.entry = await restoreArchivedDispatchSession({
        ctx: params.ctx,
        entry: params.operationSessionStoreEntry.entry,
        hasPluginOwnedBinding,
        placementContext: params.sessionWorkerPlacementContext,
        sessionKey: params.dispatchOperationSessionKey,
        storePath: params.operationSessionStoreEntry.storePath,
      });
      ({
        resetTriggered: dispatchResetTriggered,
        allowRestartTombstoneParentFork,
        allowRestartTombstoneReset,
      } = resolveDispatchResetAdmission({
        agentId: params.agentId,
        cfg: params.cfg,
        ctx: params.ctx,
        entry: params.operationSessionStoreEntry.entry,
        hasPluginOwnedBinding,
        sessionKey: params.dispatchOperationSessionKey,
        storePath: params.operationSessionStoreEntry.storePath,
      }));
    }
    if (phase !== "pre_dispatch") {
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
      phase !== "pre_dispatch" &&
      preDispatchAbortOperation?.result &&
      preDispatchAbortOperation.result.kind !== "completed" &&
      !dispatchReplyOperation &&
      // Low-level queue resolution can abort the old owner before final delivery acquires its
      // successor operation. The old result belongs to that owner, not to this inbound turn.
      params.allowActiveQueueResolution !== true
    ) {
      dispatchAbortOperation = preDispatchAbortOperation;
      return { status: "busy" };
    }
    const dispatchOperationSessionKey = params.dispatchOperationSessionKey;
    if (!dispatchOperationSessionKey) {
      return { status: "ready" };
    }
    const operationSessionId =
      dispatchAbortOperation?.sessionId ??
      params.operationSessionStoreEntry.entry?.sessionId ??
      crypto.randomUUID();
    const replyTurnKind = resolveReplyTurnKind(params.replyOptions);
    const activeReplyOperation = replyRunRegistry.get(dispatchOperationSessionKey);
    const activeEmbeddedSessionId = resolveActiveEmbeddedRunSessionId(dispatchOperationSessionKey);
    const allowGatewayEmbeddedQueueResolution =
      replyTurnKind === "visible" &&
      (params.replyOptions?.turnAdoptionLifecycle !== undefined ||
        params.allowActiveQueueResolution === true) &&
      activeReplyOperation === undefined &&
      activeEmbeddedSessionId === operationSessionId;
    if (allowGatewayEmbeddedQueueResolution) {
      // An embedded owner can outlive its reply-operation registration. Do not
      // create a competing operation for the same session before queue policy
      // gets a chance to steer the active backend.
      return { status: "ready" };
    }
    const allowActiveResolution =
      replyTurnKind === "visible" && (phase === "pre_dispatch" || phase === "command_resolution");
    const allowGatewayQueueResolution =
      phase !== "pre_dispatch" &&
      replyTurnKind === "visible" &&
      (params.replyOptions?.turnAdoptionLifecycle !== undefined ||
        params.allowActiveQueueResolution === true) &&
      activeReplyOperation !== undefined &&
      activeReplyOperation.turnKind !== "heartbeat";
    if (allowGatewayQueueResolution) {
      // Gateway and low-level plugin turns must reach getReplyFromConfig while the owner is active;
      // that layer applies the session's steer/followup/collect/drop policy without concurrent runs.
      return { status: "ready" };
    }
    const allowSlackRoutedThreadBypass =
      phase !== "pre_dispatch" &&
      shouldLetSlackRoutedThreadBypassBusyReplyOperation({
        activeOperation: replyRunRegistry.get(dispatchOperationSessionKey),
        ctx: params.ctx,
        routeThreadId: params.routeThreadId,
      });
    const lifecycleOnlyAbortController =
      allowActiveResolution || allowSlackRoutedThreadBypass ? new AbortController() : undefined;
    const onLifecycleInterrupt = () => {
      preDispatchLifecycleInterrupted = true;
      lifecycleOnlyAbortController?.abort();
    };
    const admitCurrentReplyTurn = async () => {
      try {
        return await admitReplyTurn({
          sessionKey: dispatchOperationSessionKey,
          sessionId: operationSessionId,
          expectedSessionId: params.resolveOperationExpectedSessionId(),
          expectedActiveOperation: params.initialDispatchReplyOperation,
          storePath: params.operationSessionStoreEntry.storePath,
          kind: replyTurnKind,
          resetTriggered: dispatchResetTriggered,
          allowRestartTombstoneParentFork,
          allowRestartTombstoneReset,
          routeThreadId: params.routeThreadId,
          originatingLeafEntryId:
            params.replyOptions?.turnAdoptionLifecycle?.originatingLeafEntryId,
          upstreamAbortSignal: params.replyOptions?.abortSignal,
          waitForActive: !allowActiveResolution && !allowSlackRoutedThreadBypass,
          retainLifecycleAdmissionOnActive: allowActiveResolution || allowSlackRoutedThreadBypass,
          onLifecycleInterrupt,
        });
      } catch (error) {
        if (
          phase === "pre_dispatch" &&
          replyTurnKind === "visible" &&
          isSessionWorkStartInvalidatedError(error)
        ) {
          throw new DispatchSessionRefreshRequiredError(error);
        }
        throw error;
      }
    };
    let admission = await admitCurrentReplyTurn();
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
          `dispatch-from-config: cleared stale active reply operation for terminal session ${dispatchOperationSessionKey}`,
        );
        admission = await admitCurrentReplyTurn();
      }
    }
    if (admission.status === "skipped") {
      if (allowActiveResolution && admission.reason === "active-run") {
        preDispatchAbortOperation = admission.activeOperation;
        preDispatchLifecycleAdmission = admission.lifecycleAdmission;
        if (phase === "pre_dispatch") {
          preDispatchLifecycleAbortController = lifecycleOnlyAbortController;
        } else {
          dispatchLifecycleAbortController = lifecycleOnlyAbortController;
        }
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
          `dispatch-from-config: allowing Slack routed thread ${params.routeThreadId} while ${dispatchOperationSessionKey} has an active reply operation in another Slack thread`,
        );
        return { status: "ready" };
      }
      admission.lifecycleAdmission?.release();
      dispatchAbortOperation = admission.activeOperation;
      logVerbose(
        `dispatch-from-config: skipped reply operation admission for ${dispatchOperationSessionKey}; reason=${admission.reason}`,
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
    params.replyOptions?.turnAdoptionLifecycle?.abortSignal ??
    dispatchReplyOperation?.abortSignal ??
    params.replyOptions?.abortSignal;
  let observedReplyDelivery = false;
  let agentRunTerminalOutcome: "completed" | "failed" | undefined;
  const markObservedReplyDelivery = async () => {
    if (observedReplyDelivery) {
      return;
    }
    observedReplyDelivery = true;
    await params.replyOptions?.onObservedReplyDelivery?.();
  };
  const getReplyOptions = (): DispatchFromConfigParams["replyOptions"] => {
    const abortSignal = getDispatchAbortSignal();
    const onAgentRunStart: NonNullable<
      NonNullable<DispatchFromConfigParams["replyOptions"]>["onAgentRunStart"]
    > = (...args) => {
      agentRunTerminalOutcome = "completed";
      params.messageAuditTerminal?.observeRunId(args[0]);
      return params.replyOptions?.onAgentRunStart?.(...args);
    };
    const onAgentRunTerminalOutcome: NonNullable<
      NonNullable<DispatchFromConfigParams["replyOptions"]>["onAgentRunTerminalOutcome"]
    > = (outcome) => {
      if (outcome === "failed" || agentRunTerminalOutcome === undefined) {
        agentRunTerminalOutcome = outcome;
      }
      params.replyOptions?.onAgentRunTerminalOutcome?.(outcome);
    };
    return {
      ...params.replyOptions,
      ...(abortSignal
        ? {
            abortSignal,
            queuedFollowupAbortSignal: getQueuedFollowupAbortSignal(),
          }
        : {}),
      onAgentRunStart,
      onAgentRunTerminalOutcome,
      ...(dispatchReplyOperation ? { replyOperation: dispatchReplyOperation } : {}),
    };
  };

  const completeDispatchReplyOperation = () => {
    void releasePreDispatchLifecycleAdmission(() => waitForReplyDispatcherIdle(params.dispatcher));
    const operation = dispatchReplyOperation;
    if (!operation) {
      return;
    }
    const timeoutPolicy = params.dispatcher.resolveFollowupAdmissionBarrierTimeoutPolicy?.();
    const complete = () =>
      operation.completeWithAfterClearBarrier(waitForDispatchDelivery(), timeoutPolicy);
    // Abort races the resolver, not its bookkeeping. Retain this exact owner
    // until that work exits; delivery must remain after-clear to avoid queue cycles.
    if (dispatchLifecycleWork.owner.size > 0) {
      void Promise.allSettled(Array.from(dispatchLifecycleWork.owner)).then(complete);
    } else {
      complete();
    }
  };

  const failDispatchReplyOperation = (error: unknown, terminalOutcome?: "failed") => {
    if (terminalOutcome === "failed") {
      agentRunTerminalOutcome = "failed";
    }
    dispatchReplyOperation?.freezeAbort();
    if (dispatchReplyOperation && !dispatchReplyOperation.result) {
      dispatchReplyOperation.fail("run_failed", error);
    }
    completeDispatchReplyOperation();
  };

  const isDispatchOperationAborted = () => getDispatchAbortSignal()?.aborted === true;
  const isPreDispatchOperationAborted = () => getPreDispatchAbortSignal()?.aborted === true;
  const throwIfDispatchOperationAborted = () => {
    if (isDispatchOperationAborted()) {
      throw new DispatchReplyOperationAbortedError();
    }
  };

  const turnLedger = createReplyTurnLedger(params.dispatcher);
  return {
    completeDispatchReplyOperation,
    // Hook-queued payloads must settle through the turn ledger too, or a
    // hook-delivered visible reply could trigger the no-visible-reply fallback.
    dispatchHookDispatcher: createAbortAwareDispatcher({
      dispatcher: {
        ...params.dispatcher,
        sendToolResult: (payload) => turnLedger.sendQueued("tool", payload).queued,
        sendBlockReply: (payload) => turnLedger.sendQueued("block", payload).queued,
        sendFinalReply: (payload) => turnLedger.sendQueued("final", payload).queued,
      },
      isAborted: isPreDispatchOperationAborted,
    }),
    turnLedger,
    ensureDispatchReplyOperation,
    failDispatchReplyOperation,
    getAgentRunTerminalOutcome: () => agentRunTerminalOutcome,
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
