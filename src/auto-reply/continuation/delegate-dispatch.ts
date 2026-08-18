/**
 * Continuation delegate dispatch — spawn logic for both immediate and delayed delegates.
 *
 * Consumes pending delegates from the store and dispatches them via spawnSubagentDirect.
 * Handles per-turn cap enforcement, chain-hop prefix, and mode flags.
 *
 * OBSERVABILITY: every spawn outcome (accepted/rejected/failed) is logged at info level,
 * regardless of whether the spawn was immediate or timer-triggered. The old branch gated
 * success logging behind `timerTriggered`, making immediate delegates invisible to operators.
 * Do not reproduce this.
 *
 * RFC: docs/design/continue-work-signal-v2.md §3.2, §3.4
 */

import { formatDelegateArtifactTaskInstruction } from "../../agents/delegate-artifact-policy.js";
import {
  assertDelegateArtifactPolicyPrepared,
  removeUnacceptedDelegateArtifactPolicy,
} from "../../agents/delegate-artifacts.js";
import { deriveContinuationDelegateChildSessionKeyFromParent } from "../../agents/subagent-continuation-ids.js";
import { spawnSubagentDirect } from "../../agents/subagents/spawn/subagent-spawn.js";
import type { SpawnSubagentContext } from "../../agents/subagents/spawn/subagent-spawn.js";
import { getRuntimeConfig } from "../../config/config.js";
import {
  emitContinuationDelegateFireSpan,
  emitContinuationDisabledSpan,
  resolveContinuationTraceparent,
  startContinuationDelegateSpan,
} from "../../infra/continuation-tracer.js";
import { generateChainId } from "../../infra/secure-random.js";
import { enqueueSystemEventRaw as enqueueSystemEvent } from "../../infra/system-events.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveContinuationRuntimeConfig } from "./config.js";
import { partitionKnownAcceptedDelegateChildren } from "./delegate-dispatch-accepted-children.js";
import {
  DelegateTerminalChainStatePersistError,
  formatDelegateDispatchError as formatErrorMessage,
  persistChainStateBeforeTerminalCommit,
} from "./delegate-dispatch-chain-state.js";
import type {
  DelegateDispatchParams,
  DelegateDispatchResult,
} from "./delegate-dispatch-contract.js";
import {
  armDelegateDispatchHedge,
  clearDelegateDispatchHedge,
  DELEGATE_DISPATCH_RETRY_MS,
} from "./delegate-dispatch-hedge.js";
import { partitionManagedDelegatesForRuntime } from "./delegate-dispatch-managed-gates.js";
import {
  annotateQueuedDelegatesInheritedPolicy,
  clearRecoverableDelegatesChainTokensFold,
  consumePendingDelegates,
  markPendingDelegateFailed,
  markPendingDelegateSpawnAccepted,
  peekEarliestQueuedDelegateDueAt,
  revalidatePendingDelegateForSpawn,
  requeuePendingDelegate,
} from "./delegate-store.js";
import { checkContinuationBudget, type ChainState } from "./scheduler.js";
import { hasCrossSessionDelegateTargeting } from "./targeting-pure.js";
import type { PendingContinuationDelegate } from "./types.js";

export { resetDelegateDispatchHedgesForTests } from "./delegate-dispatch-hedge.js";

const log = createSubsystemLogger("continuation/delegate-dispatch");

function formatDelegateTaskForSystemEvent(task: string): string {
  return task;
}
/**
 * Consume and dispatch all pending tool-dispatched delegates for a session.
 *
 * Called by agent-runner.ts after the response finalizes.
 * Each delegate goes through chain/cost enforcement and is spawned via spawnSubagentDirect.
 */
function markDelegateFailed(
  delegate: { flowId?: string; expectedRevision?: number; task: string },
  summary: string,
): boolean {
  return markPendingDelegateFailed(delegate, summary);
}

export async function dispatchToolDelegates(
  params: DelegateDispatchParams,
): Promise<DelegateDispatchResult> {
  const { sessionKey, chainState, ctx } = params;
  const config = params.config ?? resolveContinuationRuntimeConfig();
  // A hedge may consume only rows this dispatch could have annotated with its
  // inherited policy. Rows queued later belong to their own turn's dispatch.
  const hedgeQueuedCreatedAtOrBefore = params.queuedCreatedAtOrBefore ?? Date.now();
  const armManagedSpawnRetry = () => {
    armDelegateDispatchHedge(
      sessionKey,
      Date.now() + DELEGATE_DISPATCH_RETRY_MS,
      {
        chainState: params.chainState,
        ctx: params.ctx,
        maxChainLength: params.maxChainLength,
        ...(params.config ? { config: params.config } : {}),
        loadFreshChainState: params.loadFreshChainState,
        ...(params.applyDelegateChainTokensFold ? { applyDelegateChainTokensFold: true } : {}),
        persistChainState: params.persistChainState,
        ...(params.persistBeforeTerminalCommit ? { persistBeforeTerminalCommit: true } : {}),
        recoverRunningDelegates: true,
        queuedCreatedAtOrBefore: hedgeQueuedCreatedAtOrBefore,
        includeRunningUpdatedAtOrBefore: Date.now(),
      },
      dispatchToolDelegates,
    );
  };
  const deferManagedDelegate = (
    delegate: PendingContinuationDelegate,
    currentStep?: string,
  ): boolean => {
    const requeued = requeuePendingDelegate(delegate, currentStep, {
      inheritedSilent: params.inheritedSilent,
      inheritedWake: params.inheritedWake,
    });
    if (requeued) {
      armManagedSpawnRetry();
    }
    return requeued;
  };
  // Fail closed: applying a delegate chain-cost fold requires a persist path so
  // a hedge armed for a still-unmatured delegate can durably advance the folded
  // chain state when it fires. Without `persistChainState` the hedge would fold
  // the cost only in memory and lose it (later hops rebuild from the stale entry
  // and bypass the cost cap), so force immediate dispatch here instead of arming
  // a lossy hedge.
  const foldWithoutPersist =
    params.applyDelegateChainTokensFold === true && !params.persistChainState;
  const ignoreDelay = params.dispatchQueuedRegardlessOfDelay === true || foldWithoutPersist;
  const toolDelegates = consumePendingDelegates(sessionKey, {
    includeRunning: params.recoverRunningDelegates === true,
    queuedCreatedAtOrBefore: params.queuedCreatedAtOrBefore,
    includeRunningUpdatedAtOrBefore: params.includeRunningUpdatedAtOrBefore,
    ignoreDelay,
  });

  // Arm (or re-arm) a hedge timer for any remaining queued delegates so a
  // deadline crossed during consumption still fires in a fully-quiet channel.
  const earliestQueuedDueAt = peekEarliestQueuedDelegateDueAt(sessionKey, {
    queuedCreatedAtOrBefore: hedgeQueuedCreatedAtOrBefore,
  });
  if (earliestQueuedDueAt !== undefined) {
    // Inherited silent/wake policy is recorded on each still-queued delegate
    // here, so the hedge never has to carry one chain's mode at the session
    // level and leak it onto an unrelated delegate queued by a later turn.
    annotateQueuedDelegatesInheritedPolicy(
      sessionKey,
      {
        ...(params.inheritedSilent ? { inheritedSilent: true } : {}),
        ...(params.inheritedWake ? { inheritedWake: true } : {}),
      },
      hedgeQueuedCreatedAtOrBefore,
    );
    armDelegateDispatchHedge(
      sessionKey,
      earliestQueuedDueAt,
      {
        chainState: params.chainState,
        ctx: params.ctx,
        maxChainLength: params.maxChainLength,
        ...(params.config ? { config: params.config } : {}),
        loadFreshChainState: params.loadFreshChainState,
        ...(params.applyDelegateChainTokensFold ? { applyDelegateChainTokensFold: true } : {}),
        persistChainState: params.persistChainState,
        ...(params.persistBeforeTerminalCommit ? { persistBeforeTerminalCommit: true } : {}),
        ...(params.recoverRunningDelegates ? { recoverRunningDelegates: true } : {}),
        queuedCreatedAtOrBefore: hedgeQueuedCreatedAtOrBefore,
        ...(params.includeRunningUpdatedAtOrBefore !== undefined
          ? { includeRunningUpdatedAtOrBefore: params.includeRunningUpdatedAtOrBefore }
          : {}),
      },
      dispatchToolDelegates,
    );
  } else if (params.queuedCreatedAtOrBefore === undefined) {
    clearDelegateDispatchHedge(sessionKey);
  }

  if (toolDelegates.length === 0) {
    return { dispatched: 0, rejected: 0, chainState };
  }

  log.info(
    `[continue_delegate] Consuming ${toolDelegates.length} tool delegate(s) for session ${sessionKey}`,
  );

  const { maxDelegatesPerTurn, maxChainLength, crossSessionTargeting } = config;
  const hasManagedArtifacts = (delegate: PendingContinuationDelegate): boolean =>
    delegate.returnOptions?.artifacts === "optional" ||
    delegate.returnOptions?.artifacts === "required";
  const removeRejectedArtifactPolicy = (delegate: PendingContinuationDelegate): void => {
    if (hasManagedArtifacts(delegate) && delegate.flowId) {
      removeUnacceptedDelegateArtifactPolicy(delegate.flowId);
    }
  };
  const terminalizeRejectedDelegate = (
    delegate: PendingContinuationDelegate,
    summary: string,
  ): boolean => {
    const committed = markDelegateFailed(delegate, summary);
    if (committed) {
      removeRejectedArtifactPolicy(delegate);
    }
    return committed;
  };
  const artifactRuntimeSnapshot = resolveContinuationRuntimeConfig(getRuntimeConfig());
  const { acceptedDelegates, pendingDelegates, acceptedChildSessionKeysByFlowId } =
    partitionKnownAcceptedDelegateChildren({
      delegates: toolDelegates,
      parentSessionKey: (delegate) => delegate.spawnRequesterSessionKey ?? sessionKey,
    });
  const { dispatchableDelegates, unavailablePolicyDelegates } = partitionManagedDelegatesForRuntime(
    {
      delegates: pendingDelegates,
      sessionKey,
      runtime: artifactRuntimeSnapshot,
      defer: deferManagedDelegate,
    },
  );
  const delegateSlotsAvailable = Math.max(
    0,
    maxDelegatesPerTurn - (params.reservedDelegateSlots ?? 0) - acceptedDelegates.length,
  );
  const delegatesWithinLimit = acceptedDelegates.concat(
    dispatchableDelegates.slice(0, delegateSlotsAvailable),
  );
  const delegatesOverLimit = dispatchableDelegates.slice(delegateSlotsAvailable);
  let dispatched = 0;
  let rejected = delegatesOverLimit.length + unavailablePolicyDelegates.length;
  let currentChainCount = chainState.currentChainCount;
  const foldBearingDelegates = acceptedDelegates.concat(
    dispatchableDelegates,
    unavailablePolicyDelegates.map(({ delegate }) => delegate),
  );
  const appliedChainTokensFold = params.applyDelegateChainTokensFold
    ? Math.max(0, ...foldBearingDelegates.map((delegate) => delegate.chainTokensFold ?? 0))
    : 0;
  let currentAccumulatedTokens = chainState.accumulatedChainTokens + appliedChainTokensFold;
  let currentChainId = chainState.chainId;
  let chainStatePersistedBeforeTerminalCommit = false;
  const terminalChainStateForDelegate = (delegate: PendingContinuationDelegate): ChainState =>
    delegate.persistedChainState ?? {
      currentChainCount,
      chainStartedAt: chainState.chainStartedAt,
      accumulatedChainTokens: currentAccumulatedTokens,
      ...(currentChainId ? { chainId: currentChainId } : {}),
    };
  const persistTerminalChainState = async (
    delegate: PendingContinuationDelegate,
    nextState: ChainState,
    options: { markPlannedChainState?: boolean; markerKind?: "advanced" | "terminal" } = {},
  ): Promise<PendingContinuationDelegate> => {
    try {
      const updatedDelegate = await persistChainStateBeforeTerminalCommit(
        params,
        delegate,
        nextState,
        options,
      );
      if (params.persistBeforeTerminalCommit && params.persistChainState) {
        chainStatePersistedBeforeTerminalCommit = true;
      }
      return updatedDelegate;
    } catch (error) {
      const persistedFoldNeedsCleanup =
        error instanceof DelegateTerminalChainStatePersistError &&
        chainStatePersistedBeforeTerminalCommit &&
        appliedChainTokensFold > 0;
      if (persistedFoldNeedsCleanup) {
        clearRecoverableDelegatesChainTokensFold(sessionKey);
      }
      throw error;
    }
  };

  for (const { delegate, reason, error } of unavailablePolicyDelegates) {
    const summary = `DELEGATE spawn failed: accepted artifact policy is ${reason}`;
    const failedDelegate = await persistTerminalChainState(
      delegate,
      terminalChainStateForDelegate(delegate),
      {
        markPlannedChainState: appliedChainTokensFold > 0,
        markerKind: "terminal",
      },
    );
    if (!terminalizeRejectedDelegate(failedDelegate, summary)) {
      throw error;
    }
    enqueueSystemEvent(
      `[continuation] ${summary}. Task: ${formatDelegateTaskForSystemEvent(delegate.task)}`,
      { sessionKey, trusted: true },
    );
  }

  for (const dropped of delegatesOverLimit) {
    const summary = `Tool delegate rejected: maxDelegatesPerTurn exceeded (${maxDelegatesPerTurn}).`;
    log.info(
      `[continuation:delegate-rejected] maxDelegatesPerTurn=${maxDelegatesPerTurn} task=${dropped.task.slice(0, 80)} session=${sessionKey}`,
    );
    const failedDelegate = await persistTerminalChainState(
      dropped,
      terminalChainStateForDelegate(dropped),
      {
        markPlannedChainState: appliedChainTokensFold > 0,
        markerKind: "terminal",
      },
    );
    terminalizeRejectedDelegate(failedDelegate, summary);
    enqueueSystemEvent(
      `[continuation] ${summary} Task: ${formatDelegateTaskForSystemEvent(dropped.task)}`,
      {
        sessionKey,
        trusted: true,
      },
    );
  }

  for (const delegate of delegatesWithinLimit) {
    const spawnSessionKey = delegate.spawnRequesterSessionKey ?? sessionKey;
    const childSessionKey = delegate.flowId
      ? (acceptedChildSessionKeysByFlowId.get(delegate.flowId) ??
        deriveContinuationDelegateChildSessionKeyFromParent(spawnSessionKey, delegate.flowId))
      : undefined;
    const acceptedChildAlreadyKnown = Boolean(
      delegate.flowId && acceptedChildSessionKeysByFlowId.has(delegate.flowId),
    );
    const managedArtifacts = hasManagedArtifacts(delegate);
    const currentArtifactRuntime = managedArtifacts
      ? resolveContinuationRuntimeConfig(getRuntimeConfig())
      : undefined;
    if (!acceptedChildAlreadyKnown && managedArtifacts && !currentArtifactRuntime?.enabled) {
      deferManagedDelegate(delegate);
      continue;
    }
    const effectiveCrossSessionTargeting =
      currentArtifactRuntime?.crossSessionTargeting ?? crossSessionTargeting;
    if (
      !acceptedChildAlreadyKnown &&
      effectiveCrossSessionTargeting === "disabled" &&
      hasCrossSessionDelegateTargeting(delegate, sessionKey)
    ) {
      if (managedArtifacts) {
        deferManagedDelegate(
          delegate,
          "Deferred until cross-session continuation targeting is re-enabled",
        );
        continue;
      }
      const delegateMode = delegate.mode ?? "normal";
      const delegateDelivery: "immediate" | "timer" =
        delegate.delayMs && delegate.delayMs > 0 ? "timer" : "immediate";
      const summary = "Tool delegate rejected: cross-session targeting is disabled by policy.";
      log.info(
        `[continuation:delegate-rejected] policy.cross_session_targeting task=${delegate.task.slice(0, 80)} session=${sessionKey}`,
      );
      const failedDelegate = await persistTerminalChainState(
        delegate,
        terminalChainStateForDelegate(delegate),
        {
          markPlannedChainState: appliedChainTokensFold > 0,
          markerKind: "terminal",
        },
      );
      markDelegateFailed(failedDelegate, summary);
      enqueueSystemEvent(
        `[continuation] ${summary} Task: ${formatDelegateTaskForSystemEvent(delegate.task)}`,
        {
          sessionKey,
          trusted: true,
        },
      );
      emitContinuationDisabledSpan({
        chainId: undefined,
        chainStepRemaining: Math.max(0, maxChainLength - currentChainCount),
        disabledReason: "policy.cross_session_targeting",
        signalKind: "tool-delegate",
        delegateDelivery,
        delegateMode,
        reason: delegate.task,
        log: (message) => log.info(message),
      });
      rejected++;
      continue;
    }

    const persistedChainStateKind = delegate.persistedChainStateKind ?? "advanced";
    const budgetChainState: ChainState = delegate.persistedChainState
      ? {
          currentChainCount:
            persistedChainStateKind === "advanced"
              ? Math.max(0, delegate.persistedChainState.currentChainCount - 1)
              : delegate.persistedChainState.currentChainCount,
          chainStartedAt: delegate.persistedChainState.chainStartedAt,
          accumulatedChainTokens: delegate.persistedChainState.accumulatedChainTokens,
          ...(delegate.persistedChainState.chainId
            ? { chainId: delegate.persistedChainState.chainId }
            : {}),
        }
      : {
          currentChainCount,
          chainStartedAt: chainState.chainStartedAt,
          accumulatedChainTokens: currentAccumulatedTokens,
          ...(currentChainId ? { chainId: currentChainId } : {}),
        };
    const budgetCheck = acceptedChildAlreadyKnown
      ? undefined
      : checkContinuationBudget({
          chainState: budgetChainState,
          config,
          sessionKey,
        });

    if (budgetCheck) {
      const summary = `Tool delegate rejected: ${budgetCheck}.`;
      log.info(
        `[continuation:delegate-rejected] ${budgetCheck} task=${delegate.task.slice(0, 80)} session=${sessionKey}`,
      );
      const failedDelegate = await persistTerminalChainState(
        delegate,
        terminalChainStateForDelegate(delegate),
        {
          markPlannedChainState: appliedChainTokensFold > 0,
          markerKind: "terminal",
        },
      );
      terminalizeRejectedDelegate(failedDelegate, summary);
      enqueueSystemEvent(
        `[continuation] ${summary} Task: ${formatDelegateTaskForSystemEvent(delegate.task)}`,
        {
          sessionKey,
          trusted: true,
        },
      );
      rejected++;
      continue;
    }

    const nextHop =
      delegate.persistedChainState && persistedChainStateKind === "advanced"
        ? delegate.persistedChainState.currentChainCount
        : currentChainCount + 1;
    const delegateAccumulatedTokens =
      delegate.persistedChainState?.accumulatedChainTokens ?? currentAccumulatedTokens;
    const dispatchChainId =
      delegate.persistedChainState?.chainId ?? currentChainId ?? generateChainId();
    const plannedTerminalChainState: ChainState = {
      currentChainCount: nextHop,
      chainStartedAt: delegate.persistedChainState?.chainStartedAt ?? chainState.chainStartedAt,
      accumulatedChainTokens: delegateAccumulatedTokens,
      ...(dispatchChainId ? { chainId: dispatchChainId } : {}),
    };
    const commitPlannedChainState = (chainId: string | undefined): void => {
      dispatched++;
      currentChainCount = nextHop;
      currentAccumulatedTokens = delegateAccumulatedTokens;
      currentChainId = chainId ?? currentChainId;
    };

    // Own mode wins; otherwise inherit the parent chain's silent/wake policy so a
    // default-mode delegate spawned under a silent/wake chain stays internal
    // instead of announcing (mirrors the subagent-announce chain-hop guards).
    const ownSilent = delegate.mode === "silent" || delegate.mode === "silent-wake";
    const ownWake = delegate.mode === "silent-wake";
    const canInheritMode = delegate.mode === undefined;
    const inheritedSilent = delegate.inheritedSilent === true || params.inheritedSilent === true;
    const inheritedWake = delegate.inheritedWake === true || params.inheritedWake === true;
    const silent = ownSilent || (canInheritMode && inheritedSilent);
    const silentWake = ownWake || (canInheritMode && inheritedSilent && inheritedWake);
    const outboundTraceparent = resolveContinuationTraceparent(delegate.traceparent);
    const delegateMode = silentWake ? "silent-wake" : silent ? "silent" : "normal";
    const delegateDelayMs = delegate.delayMs ?? 0;
    const delegateDelivery: "immediate" | "timer" = delegateDelayMs > 0 ? "timer" : "immediate";

    const spawnCtx: SpawnSubagentContext = {
      agentSessionKey: spawnSessionKey,
      agentChannel: delegate.spawnRequesterChannel ?? ctx.agentChannel,
      agentAccountId: delegate.spawnRequesterAccountId ?? ctx.agentAccountId,
      agentTo: delegate.spawnRequesterTo ?? ctx.agentTo,
      agentThreadId: delegate.spawnRequesterThreadId ?? ctx.agentThreadId,
    };

    let dispatchSpan: ReturnType<typeof startContinuationDelegateSpan> | undefined;
    let spawnAttempted = false;
    try {
      if (delegateDelivery === "timer") {
        emitContinuationDelegateFireSpan({
          chainId: dispatchChainId,
          chainStepRemainingAtDispatch: maxChainLength - nextHop,
          delegateMode,
          delayMs: delegateDelayMs,
          fireDeferredMs: Date.now() - (delegate.firstArmedAt ?? Date.now()),
          reason: delegate.task,
          traceparent: outboundTraceparent,
          log: (message) => log.info(message),
        });
      }
      dispatchSpan = startContinuationDelegateSpan({
        chainId: dispatchChainId,
        chainStepRemaining: maxChainLength - nextHop,
        delayMs: delegateDelayMs,
        delivery: delegateDelivery,
        delegateMode,
        reason: delegate.task,
        traceparent: outboundTraceparent,
        log: (message) => log.info(message),
      });
      const spawnTraceparent = dispatchSpan.traceparent?.() ?? outboundTraceparent;
      if (childSessionKey && acceptedChildAlreadyKnown) {
        const acceptedDelegate = await persistTerminalChainState(
          delegate,
          plannedTerminalChainState,
          { markPlannedChainState: true, markerKind: "advanced" },
        );
        try {
          markPendingDelegateSpawnAccepted(
            acceptedDelegate,
            childSessionKey,
            params.persistChainState ? { requireWriteSuccess: true } : {},
          );
        } catch (err) {
          const errorMessage = formatErrorMessage(err);
          log.warn(
            `[continuation:delegate-accept-finalize-failed] flowId=${delegate.flowId ?? "unknown"} session=${sessionKey} leaving row recoverable: ${errorMessage}`,
          );
          dispatchSpan.setStatus("ERROR", errorMessage);
          rejected++;
          continue;
        }
        dispatchSpan.setStatus("OK");
        commitPlannedChainState(dispatchChainId);
        continue;
      }
      if (
        delegate.flowId &&
        (delegate.returnOptions?.artifacts === "optional" ||
          delegate.returnOptions?.artifacts === "required")
      ) {
        assertDelegateArtifactPolicyPrepared(delegate.flowId);
      }
      const spawnFence = revalidatePendingDelegateForSpawn(delegate, "pending");
      if (!spawnFence.allowed) {
        log.info(
          `[continuation:delegate-spawn-fenced] reason=${spawnFence.reason} flowId=${delegate.flowId ?? "unknown"} session=${sessionKey}`,
        );
        removeRejectedArtifactPolicy(delegate);
        dispatchSpan.setStatus("ERROR", spawnFence.summary);
        enqueueSystemEvent(
          `[continuation] ${spawnFence.summary} Task: ${formatDelegateTaskForSystemEvent(delegate.task)}`,
          { sessionKey, trusted: true },
        );
        rejected++;
        continue;
      }
      spawnAttempted = true;
      const result = await spawnSubagentDirect(
        {
          task:
            `[continuation:chain-hop:${nextHop}] Delegated task (turn ${nextHop}/${maxChainLength}): ${delegate.task}` +
            formatDelegateArtifactTaskInstruction(delegate),
          drainsContinuationDelegateQueue: true,
          continuationChainState: {
            count: nextHop,
            startedAt: plannedTerminalChainState.chainStartedAt,
            tokens: delegateAccumulatedTokens,
            chainId: dispatchChainId,
          },
          ...(delegate.model ? { model: delegate.model } : {}),
          ...(delegate.attachments ? { attachments: delegate.attachments } : {}),
          ...(delegate.attachAs?.mountPath ? { attachMountPath: delegate.attachAs.mountPath } : {}),
          ...(delegate.flowId ? { continuationDelegateFlowId: delegate.flowId } : {}),
          ...(silent ? { silentAnnounce: true } : {}),
          ...(silentWake ? { silentAnnounce: true, wakeOnReturn: true } : {}),
          ...(delegate.targetSessionKey
            ? { continuationTargetSessionKey: delegate.targetSessionKey }
            : {}),
          ...(delegate.targetSessionKeys && delegate.targetSessionKeys.length > 0
            ? { continuationTargetSessionKeys: delegate.targetSessionKeys }
            : {}),
          ...(delegate.fanoutMode ? { continuationFanoutMode: delegate.fanoutMode } : {}),
          ...(spawnTraceparent ? { traceparent: spawnTraceparent } : {}),
        },
        spawnCtx,
      );

      if (result.status === "accepted") {
        // INFO-level on EVERY successful spawn — observability parity.
        log.info(
          `[continuation:delegate-spawned] hop=${nextHop}/${maxChainLength} mode=${delegate.mode ?? "normal"} session=${sessionKey} task=${delegate.task.slice(0, 80)}`,
        );
        enqueueSystemEvent(
          `[continuation:delegate-spawned] Spawned turn ${nextHop}/${maxChainLength}: ${formatDelegateTaskForSystemEvent(delegate.task)}`,
          { sessionKey, trusted: true },
        );
        const acceptedChildSessionKey = result.childSessionKey ?? childSessionKey;
        const acceptedDelegate = await persistTerminalChainState(
          delegate,
          plannedTerminalChainState,
          { markPlannedChainState: true, markerKind: "advanced" },
        );
        if (acceptedChildSessionKey) {
          try {
            markPendingDelegateSpawnAccepted(
              acceptedDelegate,
              acceptedChildSessionKey,
              params.persistChainState ? { requireWriteSuccess: true } : {},
            );
          } catch (err) {
            const errorMessage = formatErrorMessage(err);
            log.warn(
              `[continuation:delegate-accept-finalize-failed] flowId=${delegate.flowId ?? "unknown"} session=${sessionKey} leaving row recoverable: ${errorMessage}`,
            );
            dispatchSpan.setStatus("ERROR", errorMessage);
            rejected++;
            continue;
          }
        }
        dispatchSpan.setStatus("OK");
        commitPlannedChainState(dispatchChainId);
      } else {
        const reasonText = result.error ?? "delegation was not accepted.";
        const summary = `DELEGATE spawn ${result.status}: ${reasonText}`;
        log.info(
          `[continuation:delegate-spawn-rejected] status=${result.status} session=${sessionKey} reason=${reasonText} task=${delegate.task.slice(0, 80)}`,
        );
        if (managedArtifacts && result.status === "error") {
          if (
            !requeuePendingDelegate(delegate, "Deferred after transient delegate spawn failure", {
              inheritedSilent,
              inheritedWake,
            })
          ) {
            throw new Error("transient managed delegate spawn failure could not be requeued");
          }
          armManagedSpawnRetry();
          dispatchSpan.setStatus("ERROR", reasonText);
          enqueueSystemEvent(
            `[continuation] ${summary}; managed work was deferred for retry. Task: ${formatDelegateTaskForSystemEvent(delegate.task)}`,
            {
              sessionKey,
              trusted: true,
            },
          );
          continue;
        }
        const failedDelegate = await persistTerminalChainState(
          delegate,
          terminalChainStateForDelegate(delegate),
          { markPlannedChainState: appliedChainTokensFold > 0, markerKind: "terminal" },
        );
        terminalizeRejectedDelegate(failedDelegate, summary);
        dispatchSpan.setStatus("ERROR", reasonText);
        enqueueSystemEvent(
          `[continuation] ${summary} Task: ${formatDelegateTaskForSystemEvent(delegate.task)}`,
          {
            sessionKey,
            trusted: true,
          },
        );
        rejected++;
      }
    } catch (err) {
      if (err instanceof DelegateTerminalChainStatePersistError) {
        const message = formatErrorMessage(err.originalError);
        dispatchSpan?.recordException(err.originalError);
        dispatchSpan?.setStatus("ERROR", message);
        log.warn(
          `[continuation:delegate-terminal-chain-persist-failed] error=${message} session=${sessionKey} task=${delegate.task.slice(0, 80)}`,
        );
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      const summary = `DELEGATE spawn failed: ${message}`;
      dispatchSpan?.recordException(err);
      dispatchSpan?.setStatus("ERROR", message);
      log.info(`[continuation:delegate-spawn-failed] error=${message} session=${sessionKey}`);
      if (managedArtifacts && spawnAttempted) {
        if (
          !requeuePendingDelegate(delegate, "Deferred after transient delegate spawn failure", {
            inheritedSilent,
            inheritedWake,
          })
        ) {
          throw err;
        }
        armManagedSpawnRetry();
        enqueueSystemEvent(
          `[continuation] ${summary}; managed work was deferred for retry. Task: ${formatDelegateTaskForSystemEvent(delegate.task)}`,
          {
            sessionKey,
            trusted: true,
          },
        );
        continue;
      }
      const failedDelegate = await persistTerminalChainState(
        delegate,
        terminalChainStateForDelegate(delegate),
        {
          markPlannedChainState: appliedChainTokensFold > 0,
          markerKind: "terminal",
        },
      );
      terminalizeRejectedDelegate(failedDelegate, summary);
      enqueueSystemEvent(
        `[continuation] ${summary}. Task: ${formatDelegateTaskForSystemEvent(delegate.task)}`,
        {
          sessionKey,
          trusted: true,
        },
      );
      rejected++;
    } finally {
      dispatchSpan?.end();
    }
  }

  return {
    dispatched,
    rejected,
    // Return the advanced chain state so callers can persist `currentChainCount`,
    // `chainStartedAt`, and `accumulatedChainTokens` after dispatch. Without
    // this the persisted counter never advances across hops and the
    // maxChainLength budget enforcement breaks.
    chainState: {
      currentChainCount,
      chainStartedAt: chainState.chainStartedAt,
      accumulatedChainTokens: currentAccumulatedTokens,
      ...(currentChainId ? { chainId: currentChainId } : {}),
    },
    ...(appliedChainTokensFold > 0 ? { appliedChainTokensFold } : {}),
    ...(chainStatePersistedBeforeTerminalCommit ? { chainStatePersistedBeforeTerminalCommit } : {}),
  };
}
