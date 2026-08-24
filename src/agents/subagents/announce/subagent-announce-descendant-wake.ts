import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
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

  const cfg = deps.getRuntimeConfig();
  const announceTimeoutMs = resolveSubagentAnnounceTimeoutMs(cfg);
  const wakeLifecycleGeneration = getAgentEventLifecycleGeneration();
  const wakeMessage = buildDescendantWakeMessage({
    findings: params.findings,
    taskLabel: params.taskLabel,
  });
  const wakeDispatchId = buildAnnounceIdempotencyKey(`${params.announceId}:wake`);
  const registryRuntime = await deps.loadSubagentRegistryRuntime();
  const sourceEntry = await registryRuntime.getSubagentRunByRunId(params.runId);
  if (!sourceEntry) {
    return "not-woken";
  }
  const reservedDispatch = await registryRuntime.recordAcceptedSubagentSteerDispatch({
    runId: params.runId,
    expected: sourceEntry,
    gatewayRunId: wakeDispatchId,
    phase: "dispatching",
    lifecycleGeneration: wakeLifecycleGeneration,
    expectedSessionId:
      typeof childEntry.sessionId === "string"
        ? childEntry.sessionId.trim() || undefined
        : undefined,
    expectedLifecycleRevision:
      typeof childEntry.lifecycleRevision === "string"
        ? childEntry.lifecycleRevision.trim() || undefined
        : undefined,
  });
  if (reservedDispatch.status !== "persisted") {
    if (reservedDispatch.status === "rejected") {
      return "not-woken";
    }
    const cleared = await registryRuntime.clearSubagentRunSteerRestart(
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
  const terminateUnownedWake = async (
    gatewayRunId: string,
  ): Promise<SubagentDescendantWakeOutcome> => {
    const acceptedDispatch = await registryRuntime.recordAcceptedSubagentSteerDispatch({
      runId: wakeDispatchOwnership.ownerRunId,
      expected: wakeDispatchOwnership.owner,
      gatewayRunId,
      phase: "accepted",
      lifecycleGeneration: wakeLifecycleGeneration,
      expectedSessionId:
        typeof childEntry.sessionId === "string"
          ? childEntry.sessionId.trim() || undefined
          : undefined,
      expectedLifecycleRevision:
        typeof childEntry.lifecycleRevision === "string"
          ? childEntry.lifecycleRevision.trim() || undefined
          : undefined,
    });
    if (acceptedDispatch.status !== "rejected") {
      wakeDispatchOwnership = {
        ownerRunId: acceptedDispatch.ownerRunId,
        owner: acceptedDispatch.owner,
        dispatch: acceptedDispatch.dispatch,
      };
    }
    const terminated = await terminateAcceptedCollectorRun({
      childSessionKey: params.childSessionKey,
      gatewayRunId,
      expectedSessionId:
        typeof childEntry.sessionId === "string"
          ? childEntry.sessionId.trim() || undefined
          : undefined,
      expectedLifecycleRevision:
        typeof childEntry.lifecycleRevision === "string"
          ? childEntry.lifecycleRevision.trim() || undefined
          : undefined,
      timeoutMs: announceTimeoutMs,
      callGateway: deps.callGateway,
    });
    if (terminated) {
      await registryRuntime.clearSubagentRunSteerRestart(
        wakeDispatchOwnership.ownerRunId,
        wakeDispatchOwnership.owner,
        wakeDispatchOwnership.dispatch,
      );
      return "not-woken";
    }
    // The accepted wake run was never proven stopped. Report the unconfirmed fact
    // so the caller keeps the child session for cleanup retry rather than deleting
    // a session a live Gateway run may still own.
    log.warn("descendant wake termination unconfirmed; retained child session ownership", {
      runId: params.runId,
      gatewayRunId,
      childSessionKey: params.childSessionKey,
    });
    return "termination-unconfirmed";
  };

  let wakeRunId: string;
  try {
    const wakeResponse = await runAnnounceDeliveryWithRetry<{ runId?: string }>({
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
          },
        );
      },
    });
    wakeRunId = normalizeOptionalString(wakeResponse?.runId) ?? "";
  } catch {
    return await terminateUnownedWake(wakeDispatchId);
  }

  if (wakeRunId !== wakeDispatchId) {
    return await terminateUnownedWake(wakeDispatchId);
  }

  if (
    !params.isChildSessionEffectsAllowed() ||
    !isAgentEventLifecycleGenerationCurrent(wakeLifecycleGeneration)
  ) {
    return await terminateUnownedWake(wakeDispatchId);
  }
  const replaced = await registryRuntime.replaceSubagentRunAfterSteer({
    previousRunId: wakeDispatchOwnership.ownerRunId,
    nextRunId: wakeDispatchId,
    fallback: wakeDispatchOwnership.owner,
    expected: wakeDispatchOwnership.owner,
    allowEndedSource: true,
    lifecycleGeneration: wakeLifecycleGeneration,
    preserveFrozenResultFallback: true,
    // Persist the wake message as the replacement run's task so that any
    // post-restart redispatch reconstructs the correct prompt.
    task: wakeMessage,
  });
  return replaced ? "woke" : await terminateUnownedWake(wakeDispatchId);
}
