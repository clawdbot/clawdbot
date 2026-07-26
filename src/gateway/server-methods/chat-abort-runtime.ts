import {
  abortChatRunById,
  type ChatAbortControllerEntry,
  type ChatAbortOps,
} from "../chat-abort.js";
import {
  abortQueuedChatTurns,
  listQueuedChatTurnsForSession,
  type QueuedChatTurnMap,
} from "../chat-queued-turns.js";
import { PENDING_CHAT_SEND_DEDUPE_PREFIX } from "../server-shared.js";
// Cancellation orchestration across active, queued, pending, and worker runs.
import { loadSessionEntry } from "../session-utils.js";
import { asWorkerInferenceControl } from "../worker-environments/inference-control.js";
import {
  canRequesterAbortQueuedChatTurn,
  resolveAuthorizedPreRegisteredRunsForSessionKeys,
  resolveAuthorizedRunsForSessionKeys,
  writePreRegisteredAgentAbort,
  writePreRegisteredChatAbort,
  type ChatAbortRequester,
} from "./chat-abort-authorization.js";
import {
  normalizeOptionalChatText as normalizeOptionalText,
  normalizeUnknownChatText as normalizeUnknownText,
} from "./chat-text-normalization.js";
import { appendAssistantTranscriptMessage } from "./chat-transcript-persistence.js";
import type { GatewayRequestContext } from "./types.js";

type AbortOrigin = "rpc" | "stop-command";

type AbortedPartialSnapshot = {
  runId: string;
  sessionId: string;
  agentId?: string;
  text: string;
  abortOrigin: AbortOrigin;
};

function collectSessionAbortPartials(params: {
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  chatRunState: GatewayRequestContext["chatRunState"];
  runIds: ReadonlySet<string>;
  abortOrigin: AbortOrigin;
}): AbortedPartialSnapshot[] {
  const out: AbortedPartialSnapshot[] = [];
  for (const [runId, active] of params.chatAbortControllers) {
    if (!params.runIds.has(runId)) {
      continue;
    }
    const text = params.chatRunState.runs.get(runId)?.buffer;
    if (!text || !text.trim()) {
      continue;
    }
    out.push({
      runId,
      sessionId: active.sessionId,
      agentId: active.agentId,
      text,
      abortOrigin: params.abortOrigin,
    });
  }
  return out;
}

export async function persistAbortedPartials(params: {
  context: Pick<GatewayRequestContext, "logGateway">;
  sessionKey: string;
  snapshots: AbortedPartialSnapshot[];
}): Promise<void> {
  if (params.snapshots.length === 0) {
    return;
  }
  for (const snapshot of params.snapshots) {
    const sessionLoadOptions =
      params.sessionKey === "global" && snapshot.agentId
        ? { agentId: snapshot.agentId }
        : undefined;
    const { cfg, storePath, entry } = loadSessionEntry(params.sessionKey, sessionLoadOptions);
    const sessionId = entry?.sessionId ?? snapshot.sessionId ?? snapshot.runId;
    const appended = await appendAssistantTranscriptMessage({
      sessionKey: params.sessionKey,
      message: snapshot.text,
      sessionId,
      storePath,
      sessionFile: entry?.sessionFile,
      ...(snapshot.agentId ? { agentId: snapshot.agentId } : {}),
      createIfMissing: true,
      idempotencyKey: `${snapshot.runId}:assistant`,
      cfg,
      abortMeta: {
        aborted: true,
        origin: snapshot.abortOrigin,
        runId: snapshot.runId,
      },
    });
    if (!appended.ok) {
      params.context.logGateway.warn(
        `chat.abort transcript append failed: ${appended.error ?? "unknown error"}`,
      );
    }
  }
}

export function createChatAbortOps(context: GatewayRequestContext): ChatAbortOps {
  return {
    chatAbortControllers: context.chatAbortControllers,
    chatRunState: context.chatRunState,
    removeChatRun: context.removeChatRun,
    agentRunSeq: context.agentRunSeq,
    getRuntimeConfig: context.getRuntimeConfig,
    broadcast: context.broadcast,
    nodeSendToSession: context.nodeSendToSession,
    onRunAborted: context.cancelRunBoundApprovals,
  };
}

export function ensureChatQueuedTurns(context: GatewayRequestContext): QueuedChatTurnMap {
  return context.chatQueuedTurns;
}

function resolveAuthorizedQueuedTurnsForSession(params: {
  context: GatewayRequestContext;
  sessionKeys: string[];
  sessionId?: string;
  agentId?: string;
  defaultAgentId: string;
  requester: ChatAbortRequester;
}) {
  const chatQueuedTurns = ensureChatQueuedTurns(params.context);
  const matches = listQueuedChatTurnsForSession({
    chatQueuedTurns,
    sessionKeys: params.sessionKeys,
    sessionIds: [params.sessionId],
    agentId: params.agentId,
    defaultAgentId: params.defaultAgentId,
  });
  if (matches.length === 0) {
    return { authorized: [], hasUnauthorizedRuns: false };
  }
  const authorized = matches.filter((m) =>
    canRequesterAbortQueuedChatTurn(m.entry, params.requester),
  );
  return {
    authorized,
    hasUnauthorizedRuns: authorized.length < matches.length,
  };
}

export function cancelWorkerInferenceForSession(params: {
  context: GatewayRequestContext;
  sessionId?: string;
  runId?: string;
}): string[] {
  const sessionId = normalizeOptionalText(params.sessionId);
  if (!sessionId) {
    return [];
  }
  return (
    asWorkerInferenceControl(params.context.workerEnvironmentService)?.cancelInferenceForSession({
      sessionId,
      ...(params.runId ? { runId: params.runId } : {}),
    }) ?? []
  );
}

export async function abortChatRunsForSessionKeyWithPartials(params: {
  context: GatewayRequestContext;
  ops: ChatAbortOps;
  sessionKey: string;
  sessionKeyAliases?: string[];
  agentId?: string;
  sessionId?: string;
  persistSessionKey?: string;
  defaultAgentId: string;
  abortOrigin: AbortOrigin;
  stopReason?: string;
  requester: ChatAbortRequester;
  preserveSideRuns?: boolean;
  /** Internal session-wide cleanup after exact resolution and all matching owner checks. */
  onAuthorizedAfterQueuedAbort?: () => boolean;
}): Promise<{ aborted: boolean; runIds: string[]; unauthorized: boolean }> {
  const sessionKeys = [params.sessionKey, ...(params.sessionKeyAliases ?? [])];
  const queuedPlan = resolveAuthorizedQueuedTurnsForSession({
    context: params.context,
    sessionKeys,
    sessionId: params.sessionId,
    agentId: params.agentId,
    defaultAgentId: params.defaultAgentId,
    requester: params.requester,
  });
  const {
    authorizedRuns,
    matchedRunIds: matchedActiveRunIds,
    hasUnauthorizedRuns: hasUnauthorizedActiveRuns,
    hasUnauthorizedProtectedRuns: hasUnauthorizedProtectedActiveRuns,
    hasProtectedRuns: hasProtectedActiveRuns,
  } = resolveAuthorizedRunsForSessionKeys({
    chatAbortControllers: params.context.chatAbortControllers,
    sessionKeys,
    sessionIds: [params.sessionId],
    agentId: params.agentId,
    defaultAgentId: params.defaultAgentId,
    requester: params.requester,
    preserveSideRuns: params.preserveSideRuns,
  });
  const {
    authorizedRuns: authorizedPendingAgentRuns,
    hasUnauthorizedRuns: hasUnauthorizedPendingAgentRuns,
    hasUnauthorizedProtectedRuns: hasUnauthorizedProtectedPendingAgentRuns,
    hasProtectedRuns: hasProtectedPendingAgentRuns,
  } = resolveAuthorizedPreRegisteredRunsForSessionKeys({
    context: params.context,
    sessionKeys,
    agentId: params.agentId,
    defaultAgentId: params.defaultAgentId,
    requester: params.requester,
    keyPrefix: "agent:",
    preserveSideRuns: params.preserveSideRuns,
  });
  const {
    authorizedRuns: authorizedPendingChatRuns,
    hasUnauthorizedRuns: hasUnauthorizedPendingChatRuns,
    hasUnauthorizedProtectedRuns: hasUnauthorizedProtectedPendingChatRuns,
    hasProtectedRuns: hasProtectedPendingChatRuns,
  } = resolveAuthorizedPreRegisteredRunsForSessionKeys({
    context: params.context,
    sessionKeys,
    agentId: params.agentId,
    defaultAgentId: params.defaultAgentId,
    requester: params.requester,
    keyPrefix: PENDING_CHAT_SEND_DEDUPE_PREFIX,
    preserveSideRuns: params.preserveSideRuns,
  });
  const hasAuthorizedGatewayRuns =
    authorizedRuns.length > 0 ||
    authorizedPendingAgentRuns.length > 0 ||
    authorizedPendingChatRuns.length > 0 ||
    queuedPlan.authorized.length > 0;
  const workerService = asWorkerInferenceControl(params.context.workerEnvironmentService);
  const workerSessionId = params.sessionId;
  const hasWorkerRun = Boolean(
    workerSessionId &&
    (!hasAuthorizedGatewayRuns || params.onAuthorizedAfterQueuedAbort) &&
    workerService?.hasInferenceForSession(workerSessionId),
  );
  // The worker manager admits at most one active inference per session, and a
  // worker-backed turn shares its controller's runId. One exact match therefore
  // represents the only worker owner instead of inventing a second owner.
  const hasControllerRepresentedWorkerRun = Boolean(
    hasWorkerRun &&
    workerSessionId &&
    workerService &&
    matchedActiveRunIds.some((runId) =>
      workerService.hasInferenceForSession(workerSessionId, runId),
    ),
  );
  const hasUnauthorizedOwner =
    hasUnauthorizedActiveRuns ||
    hasUnauthorizedPendingAgentRuns ||
    hasUnauthorizedPendingChatRuns ||
    queuedPlan.hasUnauthorizedRuns ||
    (hasWorkerRun && !hasControllerRepresentedWorkerRun && !params.requester.isAdmin);
  const hasProtectedLifecycleRuns =
    hasProtectedActiveRuns || hasProtectedPendingAgentRuns || hasProtectedPendingChatRuns;
  const hasUnauthorizedProtectedOwner =
    hasUnauthorizedProtectedActiveRuns ||
    hasUnauthorizedProtectedPendingAgentRuns ||
    hasUnauthorizedProtectedPendingChatRuns;
  const hasUnauthorizedLifecycleOwner =
    Boolean(params.onAuthorizedAfterQueuedAbort) && hasUnauthorizedProtectedOwner;
  const canRunLifecycleCleanup = !hasUnauthorizedOwner && !hasProtectedLifecycleRuns;
  // Keep ordinary chat.abort's admin worker behavior; only the injected broad
  // lifecycle path must preserve hidden or explicitly preserved Gateway runs.
  const canCancelWorkerSession = !params.onAuthorizedAfterQueuedAbort || !hasProtectedLifecycleRuns;
  if (!hasAuthorizedGatewayRuns) {
    // The injected lifecycle callback must not turn a persisted session id into
    // a bypass around a matching connection or protected run owner.
    if (hasUnauthorizedOwner || hasUnauthorizedLifecycleOwner) {
      return { aborted: false, runIds: [], unauthorized: true };
    }
    // With no owned Gateway run, the exact persisted session is the boundary,
    // matching sessions.steer's operator.write behavior for ownerless work.
    const additionalAborted = canRunLifecycleCleanup
      ? (params.onAuthorizedAfterQueuedAbort?.() ?? false)
      : false;
    if (!hasWorkerRun || !workerSessionId || !params.requester.isAdmin || !canCancelWorkerSession) {
      return { aborted: additionalAborted, runIds: [], unauthorized: false };
    }
    const workerRunIds = cancelWorkerInferenceForSession({
      context: params.context,
      sessionId: workerSessionId,
    });
    return {
      aborted: additionalAborted || workerRunIds.length > 0,
      runIds: workerRunIds,
      unauthorized: false,
    };
  }
  const authorizedRunIdSet = new Set(authorizedRuns.map((run) => run.runId));
  const snapshots = collectSessionAbortPartials({
    chatAbortControllers: params.context.chatAbortControllers,
    chatRunState: params.context.chatRunState,
    runIds: authorizedRunIdSet,
    abortOrigin: params.abortOrigin,
  });
  // Abort queued owners before any active-work signal can promote a successor.
  // Keep them first in the response to preserve the established runIds ordering.
  const runIds: string[] = abortQueuedChatTurns(
    ensureChatQueuedTurns(params.context),
    queuedPlan.authorized,
    params.stopReason,
  );
  // Hidden and preserved side runs must also block broad cleanup: authorization
  // alone must not let the callback abort work intentionally excluded above.
  const additionalAborted = canRunLifecycleCleanup
    ? (params.onAuthorizedAfterQueuedAbort?.() ?? false)
    : false;
  for (const { runId, sessionKey } of authorizedRuns) {
    const res = abortChatRunById(params.ops, {
      runId,
      sessionKey,
      stopReason: params.stopReason,
    });
    if (res.aborted) {
      runIds.push(runId);
    }
  }
  const endedAt = Date.now();
  const stopReason = params.stopReason ?? "rpc";
  for (const { runId, sessionKey, payload } of authorizedPendingAgentRuns) {
    writePreRegisteredAgentAbort({
      context: params.context,
      runId,
      sessionKey,
      payload,
      stopReason,
      endedAt,
    });
    runIds.push(runId);
  }
  for (const { runId, payload } of authorizedPendingChatRuns) {
    writePreRegisteredChatAbort({
      context: params.context,
      runId,
      stopReason,
      endedAt,
      attemptId: normalizeUnknownText(payload.attemptId),
    });
    runIds.push(runId);
  }
  if (params.requester.isAdmin && canCancelWorkerSession) {
    for (const runId of cancelWorkerInferenceForSession({
      context: params.context,
      sessionId: params.sessionId,
    })) {
      if (!runIds.includes(runId)) {
        runIds.push(runId);
      }
    }
  }
  const res = { aborted: additionalAborted || runIds.length > 0, runIds, unauthorized: false };
  if (res.aborted && snapshots.length > 0) {
    const abortedRunIds = new Set(runIds);
    await persistAbortedPartials({
      context: params.context,
      sessionKey: params.persistSessionKey ?? params.sessionKey,
      snapshots: snapshots.filter((snapshot) => abortedRunIds.has(snapshot.runId)),
    });
  }
  return res;
}
