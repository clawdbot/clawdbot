import {
  enqueueContinuationReturnDeliveries,
  resolveContinuationReturnTargetSessionKeys,
} from "../auto-reply/continuation/targeting.js";
import type { ContinuationTrigger } from "../auto-reply/get-reply-options.types.js";
import { listSessionEntriesCore } from "../config/sessions/session-accessor.js";
import { resolveAllAgentSessionStoreTargetsSync } from "../config/sessions/targets.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  markTrustedContinuationHeartbeatWake,
  requestHeartbeatNow,
} from "../infra/heartbeat-wake.js";
import type { DelegateArtifactDeliveryReceipt } from "../infra/session-delivery-queue-storage.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { defaultRuntime } from "../runtime.js";
import { markDelegateArtifactDeliveryUnavailable } from "./delegate-artifacts.js";
import type { DelegateArtifactRecipientProjectionV1 } from "./delegate-artifacts.js";
import { parseContinuationChainHop } from "./subagent-announce.continuation.accounting.js";

const continuationLog = createSubsystemLogger("continuation/announce");

type RegistryReturnRuntime = {
  listAncestorSessionKeys: (sessionKey: string) => string[];
  shouldIgnorePostCompletionAnnounceForSession: (sessionKey: string) => boolean;
};

async function listKnownSessionKeysOnHost(cfg: OpenClawConfig): Promise<string[]> {
  const keys = new Set<string>();
  for (const target of resolveAllAgentSessionStoreTargetsSync(cfg)) {
    for (const { sessionKey } of listSessionEntriesCore({
      agentId: target.agentId,
      storePath: target.storePath,
    })) {
      if (sessionKey) {
        keys.add(sessionKey);
      }
    }
  }
  return [...keys].toSorted();
}

function resolveCompletionTraceContext(params: {
  traceparent?: string;
  task: string;
  maxChainLength: number;
}): { traceparent?: string; chainStepRemaining?: number } {
  if (!params.traceparent) {
    return {};
  }
  const childChainHop = parseContinuationChainHop(params.task);
  if (childChainHop === undefined) {
    return { traceparent: params.traceparent };
  }
  const chainStepRemaining = Math.max(0, params.maxChainLength - childChainHop);
  return {
    chainStepRemaining,
    ...(chainStepRemaining > 0 ? { traceparent: params.traceparent } : {}),
  };
}

export async function routeSubagentContinuationReturn(params: {
  cfg: OpenClawConfig;
  continuationEnabled: boolean;
  isContinuationChainDelegate: boolean;
  maxChainLength: number;
  task: string;
  taskLabel: string;
  triggerMessage: string;
  triggerMessagesBySessionKey?: ReadonlyMap<string, string>;
  managedArtifactProjections?: ReadonlyMap<string, DelegateArtifactRecipientProjectionV1>;
  managedArtifactReturn?: boolean;
  announceId: string;
  childSessionKey: string;
  childRunId: string;
  targetRequesterSessionKey: string;
  silentAnnounce?: boolean;
  wakeOnReturn?: boolean;
  continuationTargetSessionKey?: string;
  continuationTargetSessionKeys?: string[];
  continuationFanoutMode?: "tree" | "all";
  traceparent?: string;
  registryRuntime?: RegistryReturnRuntime;
}): Promise<{
  handled: boolean;
  deferred?: boolean;
  continuationTriggerOverride?: ContinuationTrigger;
  traceparent?: string;
}> {
  const completionTrace = resolveCompletionTraceContext({
    traceparent: params.traceparent,
    task: params.task,
    maxChainLength: params.maxChainLength,
  });
  if (params.managedArtifactReturn && !params.continuationEnabled) {
    return { handled: true, deferred: true };
  }
  const hasTargeting = Boolean(
    params.managedArtifactReturn ||
    params.continuationTargetSessionKey ||
    (params.continuationTargetSessionKeys && params.continuationTargetSessionKeys.length > 0) ||
    params.continuationFanoutMode,
  );
  if (hasTargeting) {
    // Resolve the complete targeting set before applying the late-announcement
    // guard.  Filtering tree ancestors before resolution makes an all-cleaned
    // tree look empty and causes targeting.ts to fall back to the cleaned
    // requester.  The same guard must apply to explicit and `all` targets.
    const treeSessionKeys =
      !params.managedArtifactReturn && params.continuationFanoutMode === "tree"
        ? params.registryRuntime?.listAncestorSessionKeys(params.targetRequesterSessionKey)
        : undefined;
    const allSessionKeys =
      !params.managedArtifactReturn && params.continuationFanoutMode === "all"
        ? await listKnownSessionKeysOnHost(params.cfg)
        : undefined;
    const resolvedTargetSessionKeys = params.managedArtifactReturn
      ? [...(params.triggerMessagesBySessionKey?.keys() ?? [])]
      : resolveContinuationReturnTargetSessionKeys({
          defaultSessionKey: params.targetRequesterSessionKey,
          targetSessionKey: params.continuationTargetSessionKey,
          targetSessionKeys: params.continuationTargetSessionKeys,
          fanoutMode: params.continuationFanoutMode,
          treeSessionKeys,
          allSessionKeys,
          childSessionKey: params.childSessionKey,
        });
    const targetSessionKeys = resolvedTargetSessionKeys.filter(
      (sessionKey) =>
        !params.registryRuntime?.shouldIgnorePostCompletionAnnounceForSession(sessionKey),
    );
    if (params.managedArtifactReturn) {
      const deliverable = new Set(targetSessionKeys);
      for (const sessionKey of resolvedTargetSessionKeys) {
        if (deliverable.has(sessionKey)) {
          continue;
        }
        const projection = params.managedArtifactProjections?.get(sessionKey);
        if (projection) {
          markDelegateArtifactDeliveryUnavailable({
            dispatchId: projection.arrivalContext.dispatchId,
            recipientSessionKey: sessionKey,
            recipientSessionId: projection.arrivalContext.binding.recipientSessionId,
            reason: "recipient-no-longer-active",
          });
        }
      }
    }
    const expectedSessionIds = new Map<string, string>();
    const delegateArtifactReceipts = new Map<string, DelegateArtifactDeliveryReceipt>();
    const delegateArtifactProjections = new Map<string, DelegateArtifactRecipientProjectionV1>();
    for (const targetSessionKey of targetSessionKeys) {
      const projection = params.managedArtifactProjections?.get(targetSessionKey);
      if (!projection) {
        continue;
      }
      const recipientSessionId = projection.arrivalContext.binding.recipientSessionId;
      expectedSessionIds.set(targetSessionKey, recipientSessionId);
      delegateArtifactReceipts.set(targetSessionKey, {
        kind: "delegate-artifact",
        dispatchId: projection.arrivalContext.dispatchId,
        recipientSessionKey: targetSessionKey,
        recipientSessionId,
      });
      delegateArtifactProjections.set(targetSessionKey, projection);
    }
    if (targetSessionKeys.length > 0) {
      await enqueueContinuationReturnDeliveries({
        targetSessionKeys,
        text:
          params.triggerMessage ||
          `[continuation:enrichment-return] Delegate completed: ${params.taskLabel}`,
        ...(params.triggerMessagesBySessionKey
          ? { textBySessionKey: params.triggerMessagesBySessionKey }
          : {}),
        idempotencyKeyBase: `continuation-return:${params.announceId}`,
        wakeRecipients: params.wakeOnReturn === true || params.silentAnnounce !== true,
        childRunId: params.childRunId,
        ...(expectedSessionIds.size > 0 ? { expectedSessionIds } : {}),
        ...(delegateArtifactReceipts.size > 0 ? { delegateArtifactReceipts } : {}),
        ...(delegateArtifactProjections.size > 0 ? { delegateArtifactProjections } : {}),
        ...(params.continuationFanoutMode ? { fanoutMode: params.continuationFanoutMode } : {}),
        ...(completionTrace.chainStepRemaining !== undefined
          ? { chainStepRemaining: completionTrace.chainStepRemaining }
          : {}),
        ...(completionTrace.traceparent ? { traceparent: completionTrace.traceparent } : {}),
      });
    }
    defaultRuntime.log(
      `[continuation:targeted-return] Delivered to ${targetSessionKeys.join(",")} from ${params.childSessionKey}`,
    );
    return { handled: true };
  }

  if (
    params.managedArtifactReturn &&
    !params.triggerMessagesBySessionKey?.has(params.targetRequesterSessionKey)
  ) {
    return { handled: true };
  }

  if (params.silentAnnounce) {
    // The untargeted silent-announcement path is a one-recipient return to the
    // requester. It must honor the same post-completion guard as tree, all,
    // and explicit returns; otherwise a cleaned run-mode requester can be
    // reopened merely because the delegate did not specify fanout metadata.
    if (
      params.registryRuntime?.shouldIgnorePostCompletionAnnounceForSession(
        params.targetRequesterSessionKey,
      )
    ) {
      continuationLog.info(
        `[continuation/silent-wake] suppressed cleaned requester=${params.targetRequesterSessionKey}`,
      );
      return { handled: true };
    }
    if (params.wakeOnReturn) {
      continuationLog.info(
        `[continuation/silent-wake] wakeOnReturn=true target=${params.targetRequesterSessionKey} silentAnnounce=true`,
      );
    }
    enqueueSystemEvent(
      params.triggerMessagesBySessionKey?.get(params.targetRequesterSessionKey) ||
        params.triggerMessage ||
        `[continuation:enrichment-return] Delegate completed: ${params.taskLabel}`,
      {
        sessionKey: params.targetRequesterSessionKey,
        trusted: true,
        ...(completionTrace.traceparent ? { traceparent: completionTrace.traceparent } : {}),
      },
    );
    continuationLog.info(
      `[continuation:enrichment-return] Delivered to ${params.targetRequesterSessionKey} from ${params.childSessionKey}`,
    );
    if (params.wakeOnReturn) {
      requestHeartbeatNow(
        markTrustedContinuationHeartbeatWake({
          sessionKey: params.targetRequesterSessionKey,
          reason: "silent-wake-enrichment",
          parentRunId: params.childRunId,
        }),
      );
    }
    return { handled: true };
  }

  return {
    handled: false,
    continuationTriggerOverride: params.continuationEnabled
      ? params.isContinuationChainDelegate
        ? "delegate-return"
        : "subagent-return"
      : undefined,
    traceparent: completionTrace.traceparent,
  };
}
