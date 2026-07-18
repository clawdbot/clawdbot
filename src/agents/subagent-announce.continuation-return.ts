import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  enqueueContinuationReturnDeliveries,
  resolveContinuationReturnTargetSessionKeys,
} from "../auto-reply/continuation/targeting.js";
import type { ContinuationTrigger } from "../auto-reply/get-reply-options.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  markTrustedContinuationHeartbeatWake,
  requestHeartbeatNow,
} from "../infra/heartbeat-wake.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { defaultRuntime } from "../runtime.js";
import { parseContinuationChainHop } from "./subagent-announce.continuation.accounting.js";

const continuationLog = createSubsystemLogger("continuation/announce");

type RegistryReturnRuntime = {
  listAncestorSessionKeys: (sessionKey: string) => string[];
  shouldIgnorePostCompletionAnnounceForSession: (sessionKey: string) => boolean;
};

async function listKnownSessionKeysOnHost(cfg: OpenClawConfig): Promise<string[]> {
  const [{ resolveAllAgentSessionStoreTargetsSync }, { loadSessionStore }] = await Promise.all([
    import("../config/sessions/targets.js"),
    import("../config/sessions/store-load.js"),
  ]);
  const keys = new Set<string>();
  for (const target of resolveAllAgentSessionStoreTargetsSync(cfg)) {
    for (const key of Object.keys(loadSessionStore(target.storePath))) {
      const normalized = normalizeOptionalString(key);
      if (normalized) {
        keys.add(normalized);
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
  continuationTriggerOverride?: ContinuationTrigger;
  traceparent?: string;
}> {
  const completionTrace = resolveCompletionTraceContext({
    traceparent: params.traceparent,
    task: params.task,
    maxChainLength: params.maxChainLength,
  });
  const hasTargeting = Boolean(
    params.continuationTargetSessionKey ||
    (params.continuationTargetSessionKeys && params.continuationTargetSessionKeys.length > 0) ||
    params.continuationFanoutMode,
  );
  if (hasTargeting) {
    // Resolve the full tree first, then remove completed recipients. Filtering
    // before target resolution makes an all-cleaned tree look like a missing
    // tree and incorrectly re-enables the requester fallback.
    const treeSessionKeys =
      params.continuationFanoutMode === "tree"
        ? params.registryRuntime?.listAncestorSessionKeys(params.targetRequesterSessionKey)
        : undefined;
    const allSessionKeys =
      params.continuationFanoutMode === "all"
        ? await listKnownSessionKeysOnHost(params.cfg)
        : undefined;
    const resolvedTargetSessionKeys = resolveContinuationReturnTargetSessionKeys({
      defaultSessionKey: params.targetRequesterSessionKey,
      targetSessionKey: params.continuationTargetSessionKey,
      targetSessionKeys: params.continuationTargetSessionKeys,
      fanoutMode: params.continuationFanoutMode,
      treeSessionKeys,
      allSessionKeys,
      childSessionKey: params.childSessionKey,
    });
    const targetSessionKeys =
      params.continuationFanoutMode === "tree"
        ? resolvedTargetSessionKeys.filter(
            (sessionKey) =>
              !params.registryRuntime?.shouldIgnorePostCompletionAnnounceForSession(sessionKey),
          )
        : resolvedTargetSessionKeys;
    await enqueueContinuationReturnDeliveries({
      targetSessionKeys,
      text:
        params.triggerMessage ||
        `[continuation:enrichment-return] Delegate completed: ${params.taskLabel}`,
      idempotencyKeyBase: `continuation-return:${params.announceId}`,
      wakeRecipients: params.wakeOnReturn === true || params.silentAnnounce !== true,
      childRunId: params.childRunId,
      ...(params.continuationFanoutMode ? { fanoutMode: params.continuationFanoutMode } : {}),
      ...(completionTrace.chainStepRemaining !== undefined
        ? { chainStepRemaining: completionTrace.chainStepRemaining }
        : {}),
      ...(completionTrace.traceparent ? { traceparent: completionTrace.traceparent } : {}),
    });
    defaultRuntime.log(
      `[continuation:targeted-return] Delivered to ${targetSessionKeys.join(",")} from ${params.childSessionKey}`,
    );
    return { handled: true };
  }

  if (params.silentAnnounce) {
    if (params.wakeOnReturn) {
      continuationLog.info(
        `[continuation/silent-wake] wakeOnReturn=true target=${params.targetRequesterSessionKey} silentAnnounce=true`,
      );
    }
    enqueueSystemEvent(
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
