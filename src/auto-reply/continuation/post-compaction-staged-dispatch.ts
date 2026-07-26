/** Stateless staged post-compaction spawn transaction shared by live release and recovery. */

import { formatDelegateArtifactTaskInstruction } from "../../agents/delegate-artifact-policy.js";
import {
  assertDelegateArtifactPolicyPrepared,
  MissingDelegateArtifactPolicyError,
} from "../../agents/delegate-artifacts.js";
import { deriveContinuationDelegateChildSessionKeyFromParent } from "../../agents/subagent-continuation-ids.js";
import {
  getSubagentRunByChildSessionKey,
  hasLiveContinuationDelegateChildRun,
  isSubagentRunLive,
} from "../../agents/subagent-registry-read.js";
import { spawnSubagentDirect } from "../../agents/subagent-spawn.js";
import {
  emitContinuationDisabledSpan,
  resolveContinuationTraceparent,
} from "../../infra/continuation-tracer.js";
import { generateChainId } from "../../infra/secure-random.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { sanitizeInboundSystemTags } from "../../security/system-tags.js";
import type { InlineAttachment, InlineAttachmentMount } from "../../shared/inline-attachments.js";
import { resolveContinuationRuntimeConfig } from "./config.js";
import { requeueReleasedPostCompactionTaskFlowDelegate } from "./delegate-store.js";
import { rejectPostCompactionTaskFlowDelegate } from "./post-compaction-taskflow-rejection.js";
import { checkContinuationBudget, type ChainState } from "./scheduler.js";
import { hasCrossSessionDelegateTargeting } from "./targeting-pure.js";

const postCompactionLog = createSubsystemLogger("continuation/compaction");

function formatDelegateTaskForSystemEvent(task: string): string {
  return sanitizeInboundSystemTags(task);
}

function hasActiveSubagentRegistryRun(childSessionKey: string): boolean {
  return isSubagentRunLive(getSubagentRunByChildSessionKey(childSessionKey));
}

function hasAcceptedContinuationChildRun(childSessionKey: string, flowId: string): boolean {
  return hasLiveContinuationDelegateChildRun({ childSessionKey, flowId });
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
  }>,
  sessionKey: string,
  spawnCtx: PostCompactionSpawnContext,
  options?: {
    chainState?: ChainState;
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
  const dispatchableDelegates = delegates.filter((delegate) => {
    const managedArtifacts =
      delegate.returnOptions?.artifacts === "optional" ||
      delegate.returnOptions?.artifacts === "required";
    if (managedArtifacts && !config.enabled) {
      requeueReleasedPostCompactionTaskFlowDelegate(delegate);
      return false;
    }
    if (
      managedArtifacts &&
      config.crossSessionTargeting === "disabled" &&
      hasCrossSessionDelegateTargeting(delegate, sessionKey)
    ) {
      requeueReleasedPostCompactionTaskFlowDelegate(delegate);
      return false;
    }
    return true;
  });
  const delegatesWithinLimit = dispatchableDelegates.slice(0, config.maxDelegatesPerTurn);
  const delegatesOverLimit = dispatchableDelegates.slice(config.maxDelegatesPerTurn);

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
    if (managedArtifacts && !config.enabled) {
      requeueReleasedPostCompactionTaskFlowDelegate(delegate);
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

    try {
      const spawnTraceparent = resolveContinuationTraceparent(delegate.traceparent);
      const nextHop = currentChainCount + 1;
      const dispatchChainId = currentChainId ?? generateChainId();
      const childSessionKey = delegate.flowId
        ? deriveContinuationDelegateChildSessionKeyFromParent(sessionKey, delegate.flowId)
        : undefined;
      if (
        childSessionKey &&
        (hasActiveSubagentRegistryRun(childSessionKey) ||
          (delegate.flowId && hasAcceptedContinuationChildRun(childSessionKey, delegate.flowId)))
      ) {
        currentChainCount = nextHop;
        currentChainId = dispatchChainId;
        dispatched++;
        dispatchedFlowIds.push(delegate.flowId!);
        continue;
      }
      if (
        delegate.flowId &&
        (delegate.returnOptions?.artifacts === "optional" ||
          delegate.returnOptions?.artifacts === "required")
      ) {
        assertDelegateArtifactPolicyPrepared(delegate.flowId);
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
        spawnCtx,
      );
      if (spawnResult.status === "accepted") {
        currentChainCount = nextHop;
        currentChainId = dispatchChainId;
        dispatched++;
        if (delegate.flowId) {
          dispatchedFlowIds.push(delegate.flowId);
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
      if (err instanceof MissingDelegateArtifactPolicyError) {
        const summary = "Post-compaction delegate rejected: accepted artifact policy is missing.";
        postCompactionLog.warn(
          `[continuation:post-compaction-policy-missing] session=${sessionKey} task=${delegate.task.slice(0, 80)}`,
        );
        enqueueSystemEvent(
          `[continuation] ${summary} Task: ${formatDelegateTaskForSystemEvent(delegate.task)}`,
          { sessionKey, trusted: true },
        );
        markTerminalRejected(delegate, summary);
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
