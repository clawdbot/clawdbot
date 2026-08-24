/** Stateless staged post-compaction spawn transaction shared by live release and recovery. */

import { formatDelegateArtifactTaskInstruction } from "../../agents/delegate-artifact-policy.js";
import {
  assertDelegateArtifactPolicyPrepared,
  MissingDelegateArtifactPolicyError,
  removeUnacceptedDelegateArtifactPolicy,
  UnavailableDelegateArtifactPolicyError,
} from "../../agents/delegate-artifacts.js";
import { spawnSubagentDirect } from "../../agents/subagents/spawn/subagent-spawn.js";
import {
  emitContinuationDisabledSpan,
  resolveContinuationTraceparent,
} from "../../infra/continuation-tracer.js";
import { generateChainId } from "../../infra/secure-random.js";
import { enqueueSystemEventRaw as enqueueSystemEvent } from "../../infra/system-events.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { InlineAttachment, InlineAttachmentMount } from "../../shared/inline-attachments.js";
import { resolveContinuationRuntimeConfig } from "./config.js";
import { partitionKnownAcceptedDelegateChildren } from "./delegate-dispatch-accepted-children.js";
import {
  createContinuationOwnerSessionLoader,
  registerContinuationDelegateDispatchClaim,
} from "./delegate-spawn-authority.js";
import { requeueReleasedPostCompactionTaskFlowDelegate } from "./delegate-store-post-compaction.js";
import { revalidatePendingDelegateForSpawn } from "./delegate-store.js";
import {
  classifyPostCompactionDelegateAge,
  formatPostCompactionStaleRejection,
  POST_COMPACTION_DELEGATE_TTL_MS,
} from "./post-compaction-staleness.js";
import { rejectPostCompactionTaskFlowDelegate } from "./post-compaction-taskflow-rejection.js";
import { checkContinuationBudget, type ChainState } from "./scheduler.js";
import { hasCrossSessionDelegateTargeting } from "./targeting-pure.js";

const postCompactionLog = createSubsystemLogger("continuation/compaction");

function formatDelegateTaskForSystemEvent(task: string): string {
  return task;
}

export interface PostCompactionSpawnContext {
  agentSessionKey: string;
  agentChannel?: string;
  agentAccountId?: string;
  agentTo?: string;
  agentThreadId?: string | number;
}

/**
 * Dispatch post-compaction delegates with silentAnnounce + wakeOnReturn.
 *
 * This mirrors dispatchToolDelegates but is specifically for post-compaction
 * staged delegates. Errors are logged and surfaced as system events rather
 * than silently swallowed.
 */
export async function dispatchStagedPostCompactionDelegates(
  delegates: Array<{
    task: string;
    attachments?: InlineAttachment[];
    attachAs?: InlineAttachmentMount;
    targetSessionKey?: string;
    targetSessionKeys?: string[];
    fanoutMode?: "tree" | "all";
    returnOptions?: {
      artifacts?: "forbidden" | "optional" | "required";
    };
    recipientContext?: {
      purpose: string;
    };
    traceparent?: string;
    model?: string;
    /**
     * Optional TaskFlow claim handle. Carried through so a caller (startup
     * recovery) can finalize ONLY the rows whose spawn was accepted, terminalize
     * deterministic rejections, and leave transient failures recoverable.
     */
    flowId?: string;
    expectedRevision?: number;
    /** RFC §4.4 stale-TTL inputs; `createdAt` is the legacy pre-`firstArmedAt` fallback. */
    firstArmedAt?: number;
    createdAt?: number;
  }>,
  sessionKey: string,
  spawnCtx: PostCompactionSpawnContext,
  options?: {
    chainState?: ChainState;
    /** Startup recovery leaves valid pending rows running while disabled. */
    holdPendingWhileDisabled?: boolean;
    finalizeAcceptedFlow?: (params: { flowId: string; chainState: ChainState }) => Promise<void>;
    rollbackAcceptedFlow?: (params: { flowId: string; childSessionKey: string }) => Promise<void>;
  },
): Promise<{
  dispatched: number;
  failed: number;
  dispatchedFlowIds: string[];
  terminalRejectedFlowIds: string[];
  transientFailedFlowIds: string[];
  chainState: ChainState;
}> {
  let dispatched = 0;
  let failed = 0;
  const dispatchedFlowIds: string[] = [];
  const terminalRejectedFlowIds: string[] = [];
  const transientFailedFlowIds: string[] = [];
  const config = resolveContinuationRuntimeConfig();
  const chainStartedAt = options?.chainState?.chainStartedAt ?? Date.now();
  const accumulatedChainTokens = options?.chainState?.accumulatedChainTokens ?? 0;
  let currentChainCount = options?.chainState?.currentChainCount ?? 0;
  let currentChainId = options?.chainState?.chainId;

  postCompactionLog.info(
    `[continuation:compaction-delegate] Consuming ${delegates.length} compaction delegate(s) for session ${sessionKey}`,
  );

  const markTerminalRejected = (
    delegate: {
      flowId?: string;
      expectedRevision?: number;
      task: string;
      returnOptions?: { artifacts?: "forbidden" | "optional" | "required" };
    },
    summary: string,
  ): void => {
    failed++;
    if (rejectPostCompactionTaskFlowDelegate(delegate, summary)) {
      terminalRejectedFlowIds.push(delegate.flowId!);
    }
  };

  const noteTransientFailure = (delegate: { flowId?: string }): void => {
    failed++;
    if (delegate.flowId) {
      transientFailedFlowIds.push(delegate.flowId);
    }
  };

  const rejectUnavailablePolicy = (
    delegate: (typeof delegates)[number],
    error: MissingDelegateArtifactPolicyError | UnavailableDelegateArtifactPolicyError,
  ): void => {
    const unavailable = error instanceof UnavailableDelegateArtifactPolicyError;
    const reason = unavailable ? "inactive or expired" : "missing";
    const summary = `Post-compaction delegate rejected: accepted artifact policy is ${reason}.`;
    postCompactionLog.warn(
      `[continuation:post-compaction-policy-${unavailable ? "unavailable" : "missing"}] session=${sessionKey} task=${delegate.task.slice(0, 80)}`,
    );
    enqueueSystemEvent(
      `[continuation] ${summary} Task: ${formatDelegateTaskForSystemEvent(delegate.task)}`,
      { sessionKey, trusted: true },
    );
    markTerminalRejected(delegate, summary);
  };

  const { acceptedDelegates, pendingDelegates, acceptedChildSessionKeysByFlowId } =
    partitionKnownAcceptedDelegateChildren({
      delegates,
      parentSessionKey: () => sessionKey,
    });

  const releaseNow = Date.now();
  const dispatchableDelegates: typeof delegates = [];
  for (const delegate of pendingDelegates) {
    // RFC §4.4: staged work older than the TTL is terminal, and it must die here —
    // before the artifact-policy gate and before any spawn — so an expired snapshot
    // can never materialize attachments at a later compaction. Diagnostics carry
    // only the age so a stale drop cannot spill task prose or attachment bytes.
    const staleness = classifyPostCompactionDelegateAge(delegate, releaseNow);
    if (staleness.stale) {
      postCompactionLog.warn(
        `[continuation:post-compaction-release-stale] flowId=${delegate.flowId ?? "none"} session=${sessionKey} ageMs=${staleness.ageMs} ttlMs=${POST_COMPACTION_DELEGATE_TTL_MS}`,
      );
      markTerminalRejected(delegate, formatPostCompactionStaleRejection(staleness.ageMs));
      continue;
    }
    const managedArtifacts =
      delegate.returnOptions?.artifacts === "optional" ||
      delegate.returnOptions?.artifacts === "required";
    if (managedArtifacts && delegate.flowId) {
      try {
        assertDelegateArtifactPolicyPrepared(delegate.flowId);
      } catch (error) {
        if (
          error instanceof MissingDelegateArtifactPolicyError ||
          error instanceof UnavailableDelegateArtifactPolicyError
        ) {
          rejectUnavailablePolicy(delegate, error);
          continue;
        }
        throw error;
      }
    }
    if (!config.enabled && options?.holdPendingWhileDisabled) {
      continue;
    }
    if (managedArtifacts && !config.enabled) {
      requeueReleasedPostCompactionTaskFlowDelegate(delegate);
      continue;
    }
    if (
      managedArtifacts &&
      config.crossSessionTargeting === "disabled" &&
      hasCrossSessionDelegateTargeting(delegate, sessionKey)
    ) {
      requeueReleasedPostCompactionTaskFlowDelegate(delegate);
      continue;
    }
    dispatchableDelegates.push(delegate);
  }
  const delegateSlotsAvailable = Math.max(0, config.maxDelegatesPerTurn - acceptedDelegates.length);
  const delegatesWithinLimit = acceptedDelegates.concat(
    dispatchableDelegates.slice(0, delegateSlotsAvailable),
  );
  const delegatesOverLimit = dispatchableDelegates.slice(delegateSlotsAvailable);

  for (const dropped of delegatesOverLimit) {
    const summary = `Post-compaction delegate rejected: maxDelegatesPerTurn exceeded (${config.maxDelegatesPerTurn}).`;
    postCompactionLog.warn(
      `[continuation:post-compaction-policy-rejected] cap.delegates_per_turn maxDelegatesPerTurn=${config.maxDelegatesPerTurn} session=${sessionKey} task=${dropped.task.slice(0, 80)}`,
    );
    enqueueSystemEvent(
      `[continuation] Post-compaction delegate rejected: maxDelegatesPerTurn exceeded (${config.maxDelegatesPerTurn}). Task: ${formatDelegateTaskForSystemEvent(dropped.task)}`,
      { sessionKey, trusted: true },
    );
    emitContinuationDisabledSpan({
      chainId: undefined,
      chainStepRemaining: Math.max(0, config.maxChainLength - currentChainCount),
      disabledReason: "cap.delegates_per_turn",
      signalKind: "tool-delegate",
      delegateDelivery: "immediate",
      delegateMode: "post-compaction",
      reason: dropped.task,
      log: (message) => postCompactionLog.warn(message),
    });
    markTerminalRejected(dropped, summary);
  }

  for (const delegate of delegatesWithinLimit) {
    const managedArtifacts =
      delegate.returnOptions?.artifacts === "optional" ||
      delegate.returnOptions?.artifacts === "required";
    const acceptedChildAlreadyKnown = Boolean(
      delegate.flowId && acceptedChildSessionKeysByFlowId.has(delegate.flowId),
    );
    const nextHop = currentChainCount + 1;
    const dispatchChainId = currentChainId ?? generateChainId();
    if (acceptedChildAlreadyKnown) {
      if (delegate.flowId && options?.finalizeAcceptedFlow) {
        const acceptedChildSessionKey = acceptedChildSessionKeysByFlowId.get(delegate.flowId)!;
        try {
          await options.finalizeAcceptedFlow({
            flowId: delegate.flowId,
            chainState: {
              currentChainCount: nextHop,
              chainStartedAt,
              accumulatedChainTokens,
              chainId: dispatchChainId,
            },
          });
        } catch (error) {
          await options.rollbackAcceptedFlow?.({
            flowId: delegate.flowId,
            childSessionKey: acceptedChildSessionKey,
          });
          throw error;
        }
      }
      currentChainCount = nextHop;
      currentChainId = dispatchChainId;
      dispatched++;
      dispatchedFlowIds.push(delegate.flowId!);
      continue;
    }
    if (
      config.crossSessionTargeting === "disabled" &&
      hasCrossSessionDelegateTargeting(delegate, sessionKey)
    ) {
      if (managedArtifacts) {
        requeueReleasedPostCompactionTaskFlowDelegate(delegate);
        continue;
      }
      postCompactionLog.warn(
        `[continuation:post-compaction-policy-rejected] policy.cross_session_targeting session=${sessionKey} task=${delegate.task.slice(0, 80)}`,
      );
      enqueueSystemEvent(
        `[continuation] Post-compaction delegate rejected: cross-session targeting is disabled by policy. Task: ${formatDelegateTaskForSystemEvent(delegate.task)}`,
        { sessionKey, trusted: true },
      );
      emitContinuationDisabledSpan({
        chainId: undefined,
        chainStepRemaining: config.maxChainLength,
        disabledReason: "policy.cross_session_targeting",
        signalKind: "tool-delegate",
        delegateDelivery: "immediate",
        delegateMode: "post-compaction",
        reason: delegate.task,
        log: (message) => postCompactionLog.warn(message),
      });
      markTerminalRejected(
        delegate,
        "Post-compaction delegate rejected: cross-session targeting is disabled by policy.",
      );
      continue;
    }

    const budgetCheck = checkContinuationBudget({
      chainState: {
        currentChainCount,
        chainStartedAt,
        accumulatedChainTokens,
      },
      config,
      sessionKey,
    });
    if (budgetCheck) {
      const disabledReason = budgetCheck === "chain-capped" ? "cap.chain" : "cap.cost";
      const summary =
        budgetCheck === "chain-capped"
          ? `chain length ${config.maxChainLength} reached`
          : `cost cap exceeded (${accumulatedChainTokens} > ${config.costCapTokens})`;
      postCompactionLog.warn(
        `[continuation:post-compaction-policy-rejected] ${disabledReason} session=${sessionKey} task=${delegate.task.slice(0, 80)}`,
      );
      enqueueSystemEvent(
        `[continuation] Post-compaction delegate rejected: ${summary}. Task: ${formatDelegateTaskForSystemEvent(delegate.task)}`,
        { sessionKey, trusted: true },
      );
      emitContinuationDisabledSpan({
        chainId: undefined,
        chainStepRemaining: Math.max(0, config.maxChainLength - currentChainCount),
        disabledReason,
        signalKind: "tool-delegate",
        delegateDelivery: "immediate",
        delegateMode: "post-compaction",
        reason: delegate.task,
        log: (message) => postCompactionLog.warn(message),
      });
      markTerminalRejected(delegate, `Post-compaction delegate rejected: ${summary}.`);
      continue;
    }

    const activeDispatch = registerContinuationDelegateDispatchClaim({
      controller: "post-compaction",
      delegate,
      loadOwnerSessionEntry: createContinuationOwnerSessionLoader(sessionKey),
      ownerSessionKey: sessionKey,
    });
    let rollbackAcceptedSpawn: (() => Promise<void>) | undefined;
    let acceptedSpawn = false;
    try {
      const spawnTraceparent = resolveContinuationTraceparent(delegate.traceparent);
      if (
        delegate.flowId &&
        (delegate.returnOptions?.artifacts === "optional" ||
          delegate.returnOptions?.artifacts === "required")
      ) {
        assertDelegateArtifactPolicyPrepared(delegate.flowId);
      }
      const spawnFence = revalidatePendingDelegateForSpawn(delegate, "post-compaction");
      if (!spawnFence.allowed) {
        failed++;
        if (delegate.flowId) {
          terminalRejectedFlowIds.push(delegate.flowId);
          if (managedArtifacts) {
            removeUnacceptedDelegateArtifactPolicy(delegate.flowId);
          }
        }
        postCompactionLog.warn(
          `[continuation:post-compaction-spawn-fenced] reason=${spawnFence.reason} flowId=${delegate.flowId ?? "unknown"} session=${sessionKey}`,
        );
        enqueueSystemEvent(
          `[continuation] ${spawnFence.summary} Task: ${formatDelegateTaskForSystemEvent(delegate.task)}`,
          { sessionKey, trusted: true },
        );
        continue;
      }
      const spawnResult = await spawnSubagentDirect(
        {
          task:
            `[continuation:post-compaction] ` +
            `[continuation:chain-hop:${nextHop}] ` +
            `Compaction just completed. Carry this working state to the post-compaction session: ${delegate.task}` +
            formatDelegateArtifactTaskInstruction(delegate),
          silentAnnounce: true,
          wakeOnReturn: true,
          drainsContinuationDelegateQueue: true,
          continuationChainState: {
            count: nextHop,
            startedAt: chainStartedAt,
            tokens: accumulatedChainTokens,
            chainId: dispatchChainId,
          },
          ...(delegate.flowId ? { continuationDelegateFlowId: delegate.flowId } : {}),
          ...(delegate.model ? { model: delegate.model } : {}),
          ...(delegate.attachments ? { attachments: delegate.attachments } : {}),
          ...(delegate.attachAs?.mountPath ? { attachMountPath: delegate.attachAs.mountPath } : {}),
          ...(delegate.targetSessionKey
            ? { continuationTargetSessionKey: delegate.targetSessionKey }
            : {}),
          ...(delegate.targetSessionKeys && delegate.targetSessionKeys.length > 0
            ? { continuationTargetSessionKeys: delegate.targetSessionKeys }
            : {}),
          ...(delegate.fanoutMode ? { continuationFanoutMode: delegate.fanoutMode } : {}),
          ...(spawnTraceparent ? { traceparent: spawnTraceparent } : {}),
        },
        {
          ...spawnCtx,
          continuationDelegateAdmission: activeDispatch.authority,
        },
      );
      if (spawnResult.status === "accepted") {
        acceptedSpawn = true;
        rollbackAcceptedSpawn = spawnResult.rollbackAccepted;
        const acceptedChainState: ChainState = {
          currentChainCount: nextHop,
          chainStartedAt,
          accumulatedChainTokens,
          chainId: dispatchChainId,
        };
        if (delegate.flowId && options?.finalizeAcceptedFlow) {
          await options.finalizeAcceptedFlow({
            flowId: delegate.flowId,
            chainState: acceptedChainState,
          });
          activeDispatch.authority.assertCurrent("final-acceptance", null);
        }
        currentChainCount = nextHop;
        currentChainId = dispatchChainId;
        dispatched++;
        if (delegate.flowId) {
          dispatchedFlowIds.push(delegate.flowId);
        }
        continue;
      }
      if (spawnResult.status === "cancelled") {
        failed++;
        if (delegate.flowId) {
          terminalRejectedFlowIds.push(delegate.flowId);
        }
        continue;
      }
      postCompactionLog.warn(
        `[continuation:post-compaction-spawn-rejected] status=${spawnResult.status} session=${sessionKey} reason=${spawnResult.error ?? "not accepted"} task=${delegate.task.slice(0, 80)}`,
      );
      enqueueSystemEvent(
        `[continuation] Post-compaction delegate spawn ${spawnResult.status}: ${spawnResult.error ?? "delegation was not accepted."}. Task: ${formatDelegateTaskForSystemEvent(delegate.task)}`,
        { sessionKey, trusted: true },
      );
      if (spawnResult.status === "forbidden") {
        markTerminalRejected(
          delegate,
          `Post-compaction delegate spawn forbidden: ${spawnResult.error ?? "delegation was not accepted."}.`,
        );
      } else {
        noteTransientFailure(delegate);
      }
    } catch (err) {
      await rollbackAcceptedSpawn?.();
      if (acceptedSpawn) {
        throw err;
      }
      if (
        err instanceof MissingDelegateArtifactPolicyError ||
        err instanceof UnavailableDelegateArtifactPolicyError
      ) {
        rejectUnavailablePolicy(delegate, err);
        continue;
      }
      postCompactionLog.warn(
        `[continuation:post-compaction-spawn-failed] error=${err instanceof Error ? err.message : String(err)} session=${sessionKey} task=${delegate.task.slice(0, 80)}`,
      );
      enqueueSystemEvent(
        `[continuation] Post-compaction delegate spawn failed: ${String(err)}. Task: ${formatDelegateTaskForSystemEvent(delegate.task)}`,
        { sessionKey, trusted: true },
      );
      noteTransientFailure(delegate);
    } finally {
      activeDispatch.release();
    }
  }

  return {
    dispatched,
    failed,
    dispatchedFlowIds,
    terminalRejectedFlowIds,
    transientFailedFlowIds,
    chainState: {
      currentChainCount,
      chainStartedAt,
      accumulatedChainTokens,
      ...(currentChainId ? { chainId: currentChainId } : {}),
    },
  };
}
