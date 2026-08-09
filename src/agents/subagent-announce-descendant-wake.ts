// Descendant-settle wake replaces an ended nested orchestrator run while
// preserving lifecycle ownership.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  getAgentEventLifecycleGeneration,
  isAgentEventLifecycleGenerationCurrent,
} from "../infra/agent-events.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel.js";
import {
  buildAnnounceIdFromChildRun,
  buildAnnounceIdempotencyKey,
} from "./announce-idempotency.js";
import {
  loadSessionEntryByKey,
  runAnnounceDeliveryWithRetry,
  resolveSubagentAnnounceTimeoutMs,
} from "./subagent-announce-delivery.js";
import type {
  callGateway,
  dispatchGatewayMethodInProcess,
  getRuntimeConfig,
} from "./subagent-announce.runtime.js";
import { terminateAcceptedCollectorRun } from "./subagent-spawn-cleanup.js";

type SubagentRegistryRuntime = typeof import("./subagent-registry-runtime.js");

export type DescendantWakeDeps = {
  callGateway: typeof callGateway;
  dispatchGatewayMethodInProcess: typeof dispatchGatewayMethodInProcess;
  getRuntimeConfig: typeof getRuntimeConfig;
  loadSubagentRegistryRuntime: () => Promise<SubagentRegistryRuntime>;
};

type UsableSessionEntryGuard = (entry: unknown) => entry is Record<string, unknown>;

const WAKE_RUN_SUFFIX = ":wake";

function stripWakeRunSuffixes(runId: string): string {
  let next = runId.trim();
  while (next.endsWith(WAKE_RUN_SUFFIX)) {
    next = next.slice(0, -WAKE_RUN_SUFFIX.length);
  }
  return next || runId.trim();
}

function isWakeContinuation(runId: string): boolean {
  const trimmed = runId.trim();
  if (!trimmed) {
    return false;
  }
  return stripWakeRunSuffixes(trimmed) !== trimmed;
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

export async function runDescendantWake(params: {
  enabled: boolean;
  runId: string;
  childSessionKey: string;
  taskLabel: string;
  findings?: string;
  isChildSessionEffectsAllowed: () => boolean;
  hasUsableSessionEntry: UsableSessionEntryGuard;
  deps: DescendantWakeDeps;
  signal?: AbortSignal;
}): Promise<boolean> {
  if (
    !params.enabled ||
    !params.isChildSessionEffectsAllowed() ||
    !params.findings?.trim() ||
    isWakeContinuation(params.runId)
  ) {
    return false;
  }
  if (params.signal?.aborted || !params.isChildSessionEffectsAllowed()) {
    return false;
  }

  const childEntry = loadSessionEntryByKey(params.childSessionKey);
  if (!params.hasUsableSessionEntry(childEntry)) {
    return false;
  }

  const cfg = params.deps.getRuntimeConfig();
  const announceTimeoutMs = resolveSubagentAnnounceTimeoutMs(cfg);
  const wakeLifecycleGeneration = getAgentEventLifecycleGeneration();
  const wakeMessage = buildDescendantWakeMessage({
    findings: params.findings,
    taskLabel: params.taskLabel,
  });
  const announceId = buildAnnounceIdFromChildRun({
    childSessionKey: params.childSessionKey,
    childRunId: stripWakeRunSuffixes(params.runId),
  });

  let wakeRunId;
  try {
    const wakeResponse = await runAnnounceDeliveryWithRetry<{ runId?: string }>({
      operation: "descendant wake agent call",
      signal: params.signal,
      run: async () => {
        if (!params.isChildSessionEffectsAllowed()) {
          return {};
        }
        return await params.deps.dispatchGatewayMethodInProcess(
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
            idempotencyKey: buildAnnounceIdempotencyKey(`${announceId}:wake`),
          },
          {
            timeoutMs: announceTimeoutMs,
          },
        );
      },
    });
    wakeRunId = normalizeOptionalString(wakeResponse?.runId) ?? "";
  } catch {
    return false;
  }

  if (!wakeRunId) {
    return false;
  }

  // An accepted wake that loses lifecycle ownership must be terminated before
  // it can mutate a replacement session owned by another run.
  const terminateUnownedWake = async () => {
    await terminateAcceptedCollectorRun({
      childSessionKey: params.childSessionKey,
      gatewayRunId: wakeRunId,
      expectedSessionId:
        typeof childEntry.sessionId === "string"
          ? childEntry.sessionId.trim() || undefined
          : undefined,
      expectedLifecycleRevision:
        typeof childEntry.lifecycleRevision === "string"
          ? childEntry.lifecycleRevision.trim() || undefined
          : undefined,
      timeoutMs: announceTimeoutMs,
      callGateway: params.deps.callGateway,
    });
  };

  const { replaceSubagentRunAfterSteer } = await params.deps.loadSubagentRegistryRuntime();
  if (
    !params.isChildSessionEffectsAllowed() ||
    !isAgentEventLifecycleGenerationCurrent(wakeLifecycleGeneration)
  ) {
    await terminateUnownedWake();
    return false;
  }
  const replaced = await replaceSubagentRunAfterSteer({
    previousRunId: params.runId,
    nextRunId: wakeRunId,
    lifecycleGeneration: wakeLifecycleGeneration,
    preserveFrozenResultFallback: true,
    // Persist the wake message as the replacement run's task so that any
    // post-restart redispatch reconstructs the correct prompt.
    task: wakeMessage,
  });
  if (!replaced) {
    await terminateUnownedWake();
  }
  return replaced;
}
