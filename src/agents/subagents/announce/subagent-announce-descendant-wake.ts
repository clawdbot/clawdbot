import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { GatewayContextResolver } from "../../../gateway/server-methods/types.js";
import {
  getAgentEventLifecycleGeneration,
  isAgentEventLifecycleGenerationCurrent,
} from "../../../infra/agent-events.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../../utils/message-channel.js";
import { buildAnnounceIdempotencyKey } from "../../announce-idempotency.js";
import { terminateAcceptedCollectorRun } from "../spawn/subagent-spawn-cleanup.js";
import {
  loadSessionEntryByKey,
  resolveSubagentAnnounceTimeoutMs,
  runAnnounceDeliveryWithRetry,
} from "./subagent-announce-delivery.js";
import type {
  dispatchGatewayMethodInProcess,
  getRuntimeConfig,
} from "./subagent-announce.runtime.js";

type SubagentRegistryRuntime = typeof import("../registry/subagent-registry-runtime.js");

const log = createSubsystemLogger("agents/subagent-announce-descendant-wake");

/**
 * Wake dispatch outcome. `termination-unconfirmed` means an accepted wake run was
 * never proven stopped, so the caller must keep child-session ownership instead of
 * treating the failed wake as a clean no-op.
 */
type SubagentDescendantWakeOutcome = "woke" | "not-woken" | "termination-unconfirmed";

type SubagentDescendantWakeDeps = {
  callGateway: typeof import("../../../gateway/call.js").callGateway;
  dispatchGatewayMethodInProcess: typeof dispatchGatewayMethodInProcess;
  getRuntimeConfig: typeof getRuntimeConfig;
  loadSubagentRegistryRuntime: () => Promise<SubagentRegistryRuntime>;
};

type WakeAgentResponse = {
  runId?: string;
  status?: string;
};

export function hasUsableSessionEntry(entry: unknown): entry is Record<string, unknown> {
  if (!isRecord(entry)) {
    return false;
  }
  const sessionId = entry.sessionId;
  return typeof sessionId !== "string" || sessionId.trim() !== "";
}

function buildDescendantWakeMessage(params: { findings: string; taskLabel: string }): string {
  return [
    "[Subagent Context] Your prior run ended while waiting for descendant subagent completions.",
    "[Subagent Context] All pending descendants for that run have now settled.",
    "[Subagent Context] Continue your workflow using these results. Spawn more subagents if needed, otherwise send your final answer.",
    "",
    `Task: ${params.taskLabel}`,
    "",
    params.findings,
  ].join("\n");
}

const WAKE_RUN_SUFFIX = ":wake";

export function stripWakeRunSuffixes(runId: string): string {
  let next = runId.trim();
  while (next.endsWith(WAKE_RUN_SUFFIX)) {
    next = next.slice(0, -WAKE_RUN_SUFFIX.length);
  }
  return next || runId.trim();
}

export function isWakeContinuationRun(runId: string): boolean {
  const trimmed = runId.trim();
  if (!trimmed) {
    return false;
  }
  return stripWakeRunSuffixes(trimmed) !== trimmed;
}

export async function wakeSubagentRunAfterDescendants(
  params: {
    runId: string;
    childSessionKey: string;
    taskLabel: string;
    findings: string;
    announceId: string;
    isChildSessionEffectsAllowed: () => boolean;
    resolveGatewayContext?: GatewayContextResolver;
    signal?: AbortSignal;
  },
  deps: SubagentDescendantWakeDeps,
): Promise<SubagentDescendantWakeOutcome> {
  if (params.signal?.aborted || !params.isChildSessionEffectsAllowed()) {
    return "not-woken";
  }

  const childEntry = loadSessionEntryByKey(params.childSessionKey);
  if (!hasUsableSessionEntry(childEntry)) {
    return "not-woken";
  }
  const expectedSessionId = normalizeOptionalString(childEntry.sessionId);
  const expectedLifecycleRevision = normalizeOptionalString(childEntry.lifecycleRevision);

  const cfg = deps.getRuntimeConfig();
  const announceTimeoutMs = resolveSubagentAnnounceTimeoutMs(cfg);
  const wakeLifecycleGeneration = getAgentEventLifecycleGeneration();
  const wakeMessage = buildDescendantWakeMessage({
    findings: params.findings,
    taskLabel: params.taskLabel,
  });
  const wakeDispatchId = buildAnnounceIdempotencyKey(`${params.announceId}:wake`);
  const registryRuntime = await deps.loadSubagentRegistryRuntime();
  const sourceEntry = await registryRuntime.getLazySubagentRunByRunId(params.runId);
  if (!sourceEntry) {
    return "not-woken";
  }
  const reservedDispatch = await registryRuntime.recordLazySubagentSteerDispatch({
    runId: params.runId,
    expected: sourceEntry,
    gatewayRunId: wakeDispatchId,
    phase: "dispatching",
    lifecycleGeneration: wakeLifecycleGeneration,
    expectedSessionId,
    expectedLifecycleRevision,
  });
  if (reservedDispatch.status !== "persisted") {
    if (reservedDispatch.status === "rejected") {
      return "not-woken";
    }
    const cleared = await registryRuntime.clearLazySubagentSteerRestart(
      reservedDispatch.ownerRunId,
      reservedDispatch.owner,
      reservedDispatch.dispatch,
      true,
    );
    return cleared ? "not-woken" : "termination-unconfirmed";
  }
  let wakeDispatchOwnership = {
    ownerRunId: reservedDispatch.ownerRunId,
    owner: reservedDispatch.owner,
    dispatch: reservedDispatch.dispatch,
  };
  const recordAcceptedWake = async (
    gatewayRunId: string,
  ): Promise<"persisted" | "pending-persistence" | "rejected"> => {
    const acceptedDispatch = await registryRuntime.recordLazySubagentSteerDispatch({
      runId: wakeDispatchOwnership.ownerRunId,
      expected: wakeDispatchOwnership.owner,
      gatewayRunId,
      expectedDispatch: wakeDispatchOwnership.dispatch,
      phase: "accepted",
      lifecycleGeneration: wakeLifecycleGeneration,
      expectedSessionId,
      expectedLifecycleRevision,
    });
    if (acceptedDispatch.status === "rejected") {
      return "rejected";
    }
    wakeDispatchOwnership = {
      ownerRunId: acceptedDispatch.ownerRunId,
      owner: acceptedDispatch.owner,
      dispatch: acceptedDispatch.dispatch,
    };
    return acceptedDispatch.status;
  };
  const stopWake = async (gatewayRunId: string, accepted: boolean) =>
    await terminateAcceptedCollectorRun({
      childSessionKey: params.childSessionKey,
      gatewayRunId,
      ...(accepted ? { expectedSessionId, expectedLifecycleRevision } : { retry: false }),
      timeoutMs: announceTimeoutMs,
      callGateway: deps.callGateway,
    });
  const retainWakeOwnership = (gatewayRunId: string): SubagentDescendantWakeOutcome => {
    // A live or concurrently replaced run may still own the child session.
    // Retain cleanup ownership rather than letting announce delete through it.
    log.warn("descendant wake cleanup unconfirmed; retained child session ownership", {
      runId: params.runId,
      gatewayRunId,
      childSessionKey: params.childSessionKey,
    });
    return "termination-unconfirmed";
  };
  const settleWake = async (
    gatewayRunId: string,
    acceptedState?: "persisted" | "pending-persistence" | "rejected",
    releaseOwnership = true,
  ): Promise<SubagentDescendantWakeOutcome> => {
    const binding = acceptedState ?? (await recordAcceptedWake(gatewayRunId));
    if (binding === "pending-persistence") {
      return retainWakeOwnership(gatewayRunId);
    }
    const stopped = await stopWake(gatewayRunId, binding === "persisted");
    const cleared =
      stopped &&
      releaseOwnership &&
      (await registryRuntime.clearLazySubagentSteerRestart(
        wakeDispatchOwnership.ownerRunId,
        wakeDispatchOwnership.owner,
        wakeDispatchOwnership.dispatch,
      ));
    return cleared ? "not-woken" : retainWakeOwnership(gatewayRunId);
  };
  const settleUnboundWake = async (
    returnedRunId: string,
  ): Promise<SubagentDescendantWakeOutcome> => {
    const returnedRunStopped = await stopWake(returnedRunId, false);
    return await settleWake(wakeDispatchId, undefined, returnedRunStopped);
  };

  let wakeResponse: WakeAgentResponse | undefined;
  try {
    wakeResponse = await runAnnounceDeliveryWithRetry<WakeAgentResponse>({
      operation: "descendant wake agent call",
      signal: params.signal,
      isAttemptAllowed: params.isChildSessionEffectsAllowed,
      run: async () => {
        if (!params.isChildSessionEffectsAllowed()) {
          return {};
        }
        return await deps.dispatchGatewayMethodInProcess(
          "agent",
          {
            sessionKey: params.childSessionKey,
            message: wakeMessage,
            deliver: false,
            inputProvenance: {
              kind: "inter_session",
              sourceSessionKey: params.childSessionKey,
              sourceChannel: INTERNAL_MESSAGE_CHANNEL,
              sourceTool: "subagent_announce",
            },
            idempotencyKey: wakeDispatchId,
          },
          {
            operatorRoleActor: { kind: "system" },
            timeoutMs: announceTimeoutMs,
            resolveGatewayContext: params.resolveGatewayContext,
          },
        );
      },
    });
  } catch {
    return await settleWake(wakeDispatchId);
  }

  const wakeRunId = normalizeOptionalString(wakeResponse?.runId);
  if (!wakeRunId) {
    return await settleWake(wakeDispatchId);
  }
  // The deterministic ID binds itself to this request. A distinct runtime ID
  // needs the Gateway's accepted discriminant before it can claim the reservation.
  if (wakeRunId !== wakeDispatchId && wakeResponse?.status !== "accepted") {
    return await settleUnboundWake(wakeRunId);
  }
  const acceptedState = await recordAcceptedWake(wakeRunId);
  if (acceptedState === "pending-persistence") {
    return retainWakeOwnership(wakeRunId);
  }
  if (acceptedState === "rejected") {
    return await settleUnboundWake(wakeRunId);
  }

  if (
    !params.isChildSessionEffectsAllowed() ||
    !isAgentEventLifecycleGenerationCurrent(wakeLifecycleGeneration)
  ) {
    return await settleWake(wakeRunId, acceptedState);
  }
  const replaced = await registryRuntime.replaceSubagentRunAfterSteer({
    previousRunId: wakeDispatchOwnership.ownerRunId,
    nextRunId: wakeRunId,
    fallback: wakeDispatchOwnership.owner,
    expected: wakeDispatchOwnership.owner,
    allowEndedSource: true,
    lifecycleGeneration: wakeLifecycleGeneration,
    preserveFrozenResultFallback: true,
    // Persist the wake message as the replacement run's task so that any
    // post-restart redispatch reconstructs the correct prompt.
    task: wakeMessage,
  });
  return replaced ? "woke" : await settleWake(wakeRunId, acceptedState);
}
