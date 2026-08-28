/** Authorized steering and follow-up messaging for controlled subagents. */
import crypto from "node:crypto";
import { resolveSubagentLabel } from "../../../auto-reply/reply/subagents-utils.js";
import { resolveSessionStorePathCore } from "../../../config/sessions/paths.js";
import { loadSessionEntry } from "../../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { callGateway } from "../../../gateway/call.js";
import { getGatewayRecoveryRuntime } from "../../../gateway/server-recovery-runtime-context.js";
import { logVerbose } from "../../../globals.js";
import {
  getAgentEventLifecycleGeneration,
  isAgentEventLifecycleGenerationCurrent,
} from "../../../infra/agent-events.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import { parseAgentSessionKey } from "../../../routing/session-key.js";
import { recordSessionParticipantBestEffort } from "../../../sessions/session-participant-recording.js";
import { createLazyImportLoader } from "../../../shared/lazy-promise.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../../utils/message-channel.js";
import { AGENT_LANE_SUBAGENT } from "../../lanes.js";
import {
  readLatestAssistantReplySnapshot,
  waitForAgentRunAndReadUpdatedAssistantReply,
} from "../../run-wait.js";
import { terminateAcceptedCollectorRun } from "../spawn/subagent-spawn-cleanup.js";
import {
  ensureSubagentControllerOwnsRun,
  isFinishedSubagentRunForSteer,
  isSameSubagentRunGeneration,
  type ResolvedSubagentController,
} from "./subagent-control-scope.js";
import { resolveSessionEntryForKey } from "./subagent-list.js";
import {
  countPendingDescendantRuns,
  getLatestLiveSubagentRunByChildSessionKey,
} from "./subagent-registry-read.js";
import {
  clearSubagentRunSteerRestart,
  markSubagentRunForSteerRestart,
  replaceSubagentRunAfterSteerCore,
} from "./subagent-registry.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const STEER_RATE_LIMIT_MS = 2_000;
const STEER_ABORT_SETTLE_TIMEOUT_MS = 5_000;
const SUBAGENT_REPLY_HISTORY_LIMIT = 50;

const steerRateLimit = new Map<string, number>();

function recordSubagentControllerParticipant(params: {
  cfg: OpenClawConfig;
  controller: ResolvedSubagentController;
  entry: SubagentRunRecord;
}): void {
  const requesterAgentId = params.controller.controllerAgentId;
  if (!requesterAgentId) {
    return;
  }
  const targetAgentId = parseAgentSessionKey(params.entry.childSessionKey)?.agentId;
  if (!targetAgentId) {
    return;
  }
  recordSessionParticipantBestEffort({
    actor: { type: "agent", id: requesterAgentId },
    agentId: targetAgentId,
    sessionKey: params.entry.childSessionKey,
    source: "agent",
    storePath: resolveSessionStorePathCore(params.cfg.session?.store, { agentId: targetAgentId }),
  });
}

type GatewayCaller = typeof callGateway;

const callSubagentControlGateway: GatewayCaller = async (request) => {
  const gatewayRuntime = getGatewayRecoveryRuntime();
  if (gatewayRuntime && request.method === "agent") {
    return await gatewayRuntime.dispatchAgent(
      request.params as Parameters<typeof gatewayRuntime.dispatchAgent>[0],
      request.timeoutMs ?? undefined,
    );
  }
  if (gatewayRuntime && request.method === "agent.wait") {
    return await gatewayRuntime.waitForAgent(
      request.params as Parameters<typeof gatewayRuntime.waitForAgent>[0],
      request.timeoutMs ?? undefined,
    );
  }
  return await callGateway(request);
};

const subagentMessagingRuntimeLoader = createLazyImportLoader(
  () => import("./subagent-control.runtime.js"),
);

/** Restarts a controlled subagent run with a new steering message. */
export async function steerControlledSubagentRun(params: {
  cfg: OpenClawConfig;
  controller: ResolvedSubagentController;
  entry: SubagentRunRecord;
  message: string;
}): Promise<
  | {
      status: "forbidden" | "done" | "rate_limited" | "error";
      runId?: string;
      sessionKey: string;
      sessionId?: string;
      error?: string;
      text?: string;
    }
  | {
      status: "accepted";
      runId: string;
      sessionKey: string;
      sessionId?: string;
      mode: "restart";
      label: string;
      text: string;
    }
> {
  if (params.controller.controlScope !== "children") {
    return {
      status: "forbidden",
      runId: params.entry.runId,
      sessionKey: params.entry.childSessionKey,
      error: "Leaf subagents cannot control other sessions.",
    };
  }
  if (params.controller.callerSessionKey === params.entry.childSessionKey) {
    return {
      status: "forbidden",
      runId: params.entry.runId,
      sessionKey: params.entry.childSessionKey,
      error: "Subagents cannot steer themselves.",
    };
  }
  const currentEntry = getLatestLiveSubagentRunByChildSessionKey(params.entry.childSessionKey);
  const currentHasPendingDescendants = currentEntry
    ? countPendingDescendantRuns(currentEntry.childSessionKey) > 0
    : false;
  if (
    !currentEntry ||
    !isSameSubagentRunGeneration(currentEntry, params.entry) ||
    isFinishedSubagentRunForSteer(currentEntry, currentHasPendingDescendants)
  ) {
    return {
      status: "done",
      runId: params.entry.runId,
      sessionKey: params.entry.childSessionKey,
      text: `${resolveSubagentLabel(params.entry)} is already finished.`,
    };
  }
  const ownershipError = ensureSubagentControllerOwnsRun({
    cfg: params.cfg,
    controller: params.controller,
    entry: currentEntry,
  });
  if (ownershipError) {
    return {
      status: "forbidden",
      runId: currentEntry.runId,
      sessionKey: currentEntry.childSessionKey,
      error: ownershipError,
    };
  }
  if (currentEntry.collect) {
    return {
      status: "forbidden",
      runId: currentEntry.runId,
      sessionKey: currentEntry.childSessionKey,
      error: "Collector subagents cannot be steered; use agents_wait or cancel the task.",
    };
  }

  const rateKey = `${params.controller.callerSessionKey}:${params.entry.childSessionKey}`;
  if (process.env.VITEST !== "true") {
    const now = Date.now();
    const lastSentAt = steerRateLimit.get(rateKey) ?? 0;
    if (now - lastSentAt < STEER_RATE_LIMIT_MS) {
      return {
        status: "rate_limited",
        runId: params.entry.runId,
        sessionKey: params.entry.childSessionKey,
        error: "Steer rate limit exceeded. Wait a moment before sending another steer.",
      };
    }
    steerRateLimit.set(rateKey, now);
  }

  let ownsSteerRestart: boolean;
  try {
    ownsSteerRestart = markSubagentRunForSteerRestart(params.entry.runId, currentEntry);
  } catch (error) {
    return {
      status: "error",
      runId: params.entry.runId,
      sessionKey: params.entry.childSessionKey,
      error: `Failed to persist steer restart ownership: ${formatErrorMessage(error)}`,
    };
  }
  if (!ownsSteerRestart) {
    return {
      status: "error",
      runId: params.entry.runId,
      sessionKey: params.entry.childSessionKey,
      error: "Another subagent restart already owns this session; retry after it settles.",
    };
  }

  const targetSession = resolveSessionEntryForKey({
    cfg: params.cfg,
    key: params.entry.childSessionKey,
    cache: new Map<string, Record<string, SessionEntry>>(),
  });
  const sessionId =
    typeof targetSession.entry?.sessionId === "string" && targetSession.entry.sessionId.trim()
      ? targetSession.entry.sessionId.trim()
      : undefined;
  const restartSessionId = sessionId ? crypto.randomUUID() : undefined;
  const runtime = await subagentMessagingRuntimeLoader.load();

  if (sessionId) {
    const active = runtime.isEmbeddedAgentRunActive(sessionId);
    const aborted = runtime.abortEmbeddedAgentRun(sessionId);
    if (active && !aborted) {
      clearSubagentRunSteerRestart(params.entry.runId, currentEntry);
      return {
        status: "error",
        runId: params.entry.runId,
        sessionKey: params.entry.childSessionKey,
        sessionId,
        error: "Subagent reply is already finalizing and can no longer be restarted.",
      };
    }
  }
  const cleared = runtime.clearSessionQueues([params.entry.childSessionKey, sessionId]);
  if (cleared.followupCleared > 0 || cleared.laneCleared > 0) {
    logVerbose(
      `subagents control steer: cleared followups=${cleared.followupCleared} lane=${cleared.laneCleared} keys=${cleared.keys.join(",")}`,
    );
  }

  try {
    await callSubagentControlGateway({
      method: "agent.wait",
      params: {
        runId: params.entry.runId,
        timeoutMs: STEER_ABORT_SETTLE_TIMEOUT_MS,
      },
      timeoutMs: STEER_ABORT_SETTLE_TIMEOUT_MS + 2_000,
    });
  } catch {
    // Continue even if wait fails; steer should still be attempted.
  }

  const idempotencyKey = crypto.randomUUID();
  let runId: string = idempotencyKey;
  const latestAfterWait = getLatestLiveSubagentRunByChildSessionKey(currentEntry.childSessionKey);
  const hasPendingDescendantsAfterWait =
    countPendingDescendantRuns(currentEntry.childSessionKey) > 0;
  if (
    latestAfterWait !== currentEntry ||
    currentEntry.suppressAnnounceReason !== "steer-restart" ||
    currentEntry.execution.restartRecovery ||
    currentEntry.killIntent ||
    currentEntry.killReconciliation ||
    isFinishedSubagentRunForSteer(currentEntry, hasPendingDescendantsAfterWait)
  ) {
    clearSubagentRunSteerRestart(params.entry.runId, currentEntry);
    return {
      status: "done",
      runId: params.entry.runId,
      sessionKey: params.entry.childSessionKey,
      text: `${resolveSubagentLabel(params.entry)} is already finished.`,
    };
  }
  try {
    const steerLifecycleGeneration = getAgentEventLifecycleGeneration();
    const response = await callSubagentControlGateway<{ runId: string }>({
      method: "agent",
      params: {
        message: params.message,
        sessionKey: params.entry.childSessionKey,
        sessionId: restartSessionId,
        idempotencyKey,
        deliver: false,
        channel: INTERNAL_MESSAGE_CHANNEL,
        lane: AGENT_LANE_SUBAGENT,
        timeout: 0,
      },
      timeoutMs: 10_000,
    });
    if (typeof response?.runId === "string" && response.runId) {
      runId = response.runId;
    }
    recordSubagentControllerParticipant(params);
    let acceptedSessionEntry: SessionEntry | undefined;
    try {
      acceptedSessionEntry = loadSessionEntry({
        storePath: targetSession.storePath,
        sessionKey: params.entry.childSessionKey,
        clone: false,
        readConsistency: "latest",
      });
    } catch {
      // chat.abort remains the primary cleanup; exact session deletion is only
      // the fallback when the accepted session row can be resolved.
    }
    const terminateUnownedSteer = () =>
      terminateAcceptedCollectorRun({
        childSessionKey: params.entry.childSessionKey,
        gatewayRunId: runId,
        expectedSessionId: acceptedSessionEntry?.sessionId,
        expectedLifecycleRevision: acceptedSessionEntry?.lifecycleRevision,
        callGateway: callSubagentControlGateway,
        timeoutMs: 10_000,
      });
    if (!isAgentEventLifecycleGenerationCurrent(steerLifecycleGeneration)) {
      await terminateUnownedSteer();
      clearSubagentRunSteerRestart(params.entry.runId, currentEntry);
      return {
        status: "error",
        runId,
        sessionKey: params.entry.childSessionKey,
        sessionId: restartSessionId,
        error: "Gateway lifecycle changed before the steered run could be registered.",
      };
    }

    const replaced = replaceSubagentRunAfterSteerCore({
      previousRunId: params.entry.runId,
      nextRunId: runId,
      fallback: currentEntry,
      expected: currentEntry,
      allowEndedSource: true,
      runTimeoutSeconds: currentEntry.runTimeoutSeconds ?? 0,
      lifecycleGeneration: steerLifecycleGeneration,
      // Persist the steer so restart recovery cannot reissue the stale task.
      task: params.message,
    });
    if (!replaced) {
      await terminateUnownedSteer();
      clearSubagentRunSteerRestart(params.entry.runId, currentEntry);
      return {
        status: "error",
        runId,
        sessionKey: params.entry.childSessionKey,
        sessionId: restartSessionId,
        error: "failed to replace steered subagent run",
      };
    }
  } catch (err) {
    clearSubagentRunSteerRestart(params.entry.runId, currentEntry);
    const error = formatErrorMessage(err);
    return {
      status: "error",
      runId,
      sessionKey: params.entry.childSessionKey,
      sessionId: restartSessionId,
      error,
    };
  }

  return {
    status: "accepted",
    runId,
    sessionKey: params.entry.childSessionKey,
    sessionId: restartSessionId,
    mode: "restart",
    label: resolveSubagentLabel(params.entry),
    text: `steered ${resolveSubagentLabel(params.entry)}.`,
  };
}

/** Sends a follow-up message to a controlled subagent and waits for a reply. */
export async function sendControlledSubagentMessage(params: {
  cfg: OpenClawConfig;
  controller: ResolvedSubagentController;
  entry: SubagentRunRecord;
  message: string;
}) {
  const ownershipError = ensureSubagentControllerOwnsRun({
    cfg: params.cfg,
    controller: params.controller,
    entry: params.entry,
  });
  if (ownershipError) {
    return { status: "forbidden" as const, error: ownershipError };
  }
  if (params.entry.collect) {
    return {
      status: "forbidden" as const,
      error: "Collector subagents cannot receive follow-up messages; use agents_wait.",
    };
  }
  if (params.controller.controlScope !== "children") {
    return {
      status: "forbidden" as const,
      error: "Leaf subagents cannot control other sessions.",
    };
  }
  const currentEntry = getLatestLiveSubagentRunByChildSessionKey(params.entry.childSessionKey);
  if (!currentEntry || currentEntry.runId !== params.entry.runId) {
    return {
      status: "done" as const,
      runId: params.entry.runId,
      text: `${resolveSubagentLabel(params.entry)} is already finished.`,
    };
  }

  const targetSessionKey = params.entry.childSessionKey;
  const parsed = parseAgentSessionKey(targetSessionKey);
  const storePath = resolveSessionStorePathCore(params.cfg.session?.store, {
    agentId: parsed?.agentId,
  });
  const targetSessionEntry = loadSessionEntry({
    storePath,
    sessionKey: targetSessionKey,
    clone: false,
  });
  const targetSessionId =
    typeof targetSessionEntry?.sessionId === "string" && targetSessionEntry.sessionId.trim()
      ? targetSessionEntry.sessionId.trim()
      : undefined;

  const idempotencyKey = crypto.randomUUID();
  let runId: string = idempotencyKey;
  try {
    const baselineReply = await readLatestAssistantReplySnapshot({
      sessionKey: targetSessionKey,
      limit: SUBAGENT_REPLY_HISTORY_LIMIT,
      callGateway: callSubagentControlGateway,
    });

    const response = await callSubagentControlGateway<{ runId: string }>({
      method: "agent",
      params: {
        message: params.message,
        sessionKey: targetSessionKey,
        sessionId: targetSessionId,
        idempotencyKey,
        deliver: false,
        channel: INTERNAL_MESSAGE_CHANNEL,
        lane: AGENT_LANE_SUBAGENT,
        timeout: 0,
      },
      timeoutMs: 10_000,
    });
    const responseRunId = typeof response?.runId === "string" ? response.runId : undefined;
    if (responseRunId) {
      runId = responseRunId;
    }
    recordSubagentControllerParticipant(params);

    const result = await waitForAgentRunAndReadUpdatedAssistantReply({
      runId,
      sessionKey: targetSessionKey,
      timeoutMs: 30_000,
      limit: SUBAGENT_REPLY_HISTORY_LIMIT,
      baseline: baselineReply,
      callGateway: callSubagentControlGateway,
    });
    if (result.status === "timeout") {
      return { status: "timeout" as const, runId };
    }
    if (result.status === "error") {
      return {
        status: "error" as const,
        runId,
        error: result.error ?? "unknown error",
      };
    }
    return { status: "ok" as const, runId, replyText: result.replyText };
  } catch (err) {
    const error = formatErrorMessage(err);
    return { status: "error" as const, runId, error };
  }
}
