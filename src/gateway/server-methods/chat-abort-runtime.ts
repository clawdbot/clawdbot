import type { Result } from "@openclaw/normalization-core/result";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import {
  killAllControlledSubagentRuns,
  resolveSubagentController,
} from "../../agents/subagents/registry/subagent-control.js";
import { listSubagentRunsForController } from "../../agents/subagents/registry/subagent-registry-read.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  abortChatRunById,
  type ChatAbortControllerEntry,
  type ChatAbortOps,
} from "../chat-abort.js";
import { abortQueuedChatTurns, listQueuedChatTurnsForSession } from "../chat-queued-turns.js";
import { PENDING_CHAT_SEND_DEDUPE_PREFIX } from "../server-shared.js";
// Cancellation orchestration across active, queued, pending, and worker runs.
import { loadSessionEntry } from "../session-utils.js";
import { asWorkerInferenceControl } from "../worker-environments/inference-control.js";
import {
  canRequesterAbortChatRun,
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

type AbortOrigin = "rpc" | "stop-command" | "placement-abandon";

export async function abortControlledSubagents(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId?: string;
  requesterTurnRunId?: string;
  beforeKill?: Parameters<typeof killAllControlledSubagentRuns>[0]["beforeKill"];
}) {
  const controller = resolveSubagentController({
    cfg: params.cfg,
    agentSessionKey: params.sessionKey,
    agentId: params.agentId,
  });
  const runs = listSubagentRunsForController(
    controller.controllerSessionKey,
    controller.controllerAgentId,
  ).filter(
    (entry) =>
      params.requesterTurnRunId === undefined ||
      entry.requesterTurnRunId === params.requesterTurnRunId,
  );
  if (runs.length === 0) {
    await params.beforeKill?.();
    return undefined;
  }
  return killAllControlledSubagentRuns({
    cfg: params.cfg,
    controller,
    runs,
    suppressTaskDelivery: true,
    beforeKill: params.beforeKill,
  });
}

export function descendantAbortError(
  result: Awaited<ReturnType<typeof abortControlledSubagents>> | undefined,
  subject: "Parent run" | "Session",
) {
  return result && result.status !== "ok"
    ? errorShape(
        ErrorCodes.UNAVAILABLE,
        `${subject} stopped, but descendant cancellation was incomplete: ${result.error}`,
      )
    : undefined;
}

const SESSION_LIFECYCLE_ABORT_REQUESTER: ChatAbortRequester = { isAdmin: true };

type AbortSession = Result<
  Pick<
    ReturnType<typeof loadSessionEntry>,
    "cfg" | "storePath" | "entry" | "canonicalKey" | "agentId"
  >,
  unknown
>;
type AbortedPartialSnapshot = {
  runId: string;
  abortOrigin: AbortOrigin;
} & Result<Parameters<typeof appendAssistantTranscriptMessage>[0], unknown>;

export function captureAbortedPartial(params: {
  runId: string;
  sessionKey: string;
  sessionId: string;
  agentId?: string;
  text: string;
  abortOrigin: AbortOrigin;
  session?: AbortSession;
}): AbortedPartialSnapshot {
  const { runId, abortOrigin } = params;
  try {
    const session = params.session ?? {
      ok: true,
      value: loadSessionEntry(
        params.sessionKey,
        params.agentId ? { agentId: params.agentId } : undefined,
      ),
    };
    if (!session.ok) {
      throw session.error;
    }
    const { cfg, storePath, entry, canonicalKey, agentId } = session.value;
    if (entry?.sessionId !== params.sessionId) {
      throw new Error("Aborted partial transcript session changed before persistence");
    }
    // Snapshot the incarnation before signaling. Reset can keep the SID, and
    // the guarded writer rechecks both facts inside its commit transaction.
    return {
      runId,
      abortOrigin,
      ok: true,
      value: {
        sessionKey: canonicalKey,
        sessionId: params.sessionId,
        expectedSessionId: params.sessionId,
        expectedLifecycleRevision: entry.lifecycleRevision ?? null,
        agentId,
        storePath,
        cfg,
        message: params.text,
        createIfMissing: true,
        idempotencyKey: `${runId}:assistant`,
        abortMeta: { aborted: true, origin: abortOrigin, runId },
      },
    };
  } catch (error) {
    // Preparation is fallible metadata I/O, never a prerequisite for cancellation.
    return { runId, abortOrigin, ok: false, error };
  }
}

export async function persistAbortedPartials(params: {
  context: { logGateway: Pick<GatewayRequestContext["logGateway"], "warn"> };
  snapshots: AbortedPartialSnapshot[];
}): Promise<void> {
  for (const snapshot of params.snapshots) {
    if (!snapshot.ok) {
      throw snapshot.error;
    }
    const appended = await appendAssistantTranscriptMessage(snapshot.value);
    if (appended.skipped) {
      continue;
    }
    if (!appended.ok) {
      const error = `chat.abort transcript append failed: ${appended.error ?? "unknown error"}`;
      params.context.logGateway.warn(error);
      if (snapshot.abortOrigin === "placement-abandon") {
        throw new Error(error);
      }
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

function resolveAuthorizedQueuedTurnsForSession(params: {
  context: GatewayRequestContext;
  sessionKeys: string[];
  sessionId?: string;
  agentId?: string;
  defaultAgentId?: string;
  requester: ChatAbortRequester;
}) {
  const matches = listQueuedChatTurnsForSession({
    chatQueuedTurns: params.context.chatQueuedTurns,
    sessionKeys: params.sessionKeys,
    sessionIds: [params.sessionId],
    agentId: params.agentId,
    defaultAgentId: params.defaultAgentId,
  });
  const authorized = matches.filter((match) =>
    canRequesterAbortChatRun(match.entry, params.requester),
  );
  return {
    authorized,
    hasUnauthorizedRuns: authorized.length < matches.length,
  };
}

type SessionAbortOwnerParams = {
  context: GatewayRequestContext;
  sessionKeys: string[];
  sessionId?: string;
  agentId?: string;
  defaultAgentId?: string;
};

/** Authoritative active, pending, or queued Gateway owner for an exact session. */
export function hasGatewaySessionAbortOwner(params: SessionAbortOwnerParams): boolean {
  const ownerScope = {
    sessionKeys: params.sessionKeys,
    agentId: params.agentId,
    defaultAgentId: params.defaultAgentId,
    requester: SESSION_LIFECYCLE_ABORT_REQUESTER,
  };
  return (
    resolveAuthorizedRunsForSessionKeys({
      chatAbortControllers: params.context.chatAbortControllers,
      sessionIds: [params.sessionId],
      ...ownerScope,
      includeProtectedRuns: true,
    }).authorizedRuns.length > 0 ||
    resolveAuthorizedQueuedTurnsForSession({
      context: params.context,
      sessionId: params.sessionId,
      ...ownerScope,
    }).authorized.length > 0 ||
    ["agent:", PENDING_CHAT_SEND_DEDUPE_PREFIX].some(
      (keyPrefix) =>
        resolveAuthorizedPreRegisteredRunsForSessionKeys({
          context: params.context,
          ...ownerScope,
          keyPrefix,
          includeProtectedRuns: true,
        }).authorizedRuns.length > 0,
    )
  );
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
  session?: AbortSession;
  defaultAgentId?: string;
  abortOrigin: AbortOrigin;
  stopReason?: string;
  requester: ChatAbortRequester;
  preserveSideRuns?: boolean;
  cascadeDescendants?: true;
  /** Exact lifecycle owners may include hidden and side runs for this one session. */
  includeProtectedRuns?: boolean;
  excludeRunIds?: ReadonlySet<string>;
  /** Captures exact registrations before cancellation can remove them. */
  onControllerTargets?: (
    targets: Array<{ runId: string; entry: ChatAbortControllerEntry }>,
  ) => void;
  /** Internal session-wide cleanup after exact resolution and all matching owner checks. */
  onAuthorizedAfterQueuedAbort?: () => boolean;
}): Promise<{
  aborted: boolean;
  runIds: string[];
  unauthorized: boolean;
  descendants?: Awaited<ReturnType<typeof abortControlledSubagents>>;
}> {
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
    includeProtectedRuns: params.includeProtectedRuns,
    excludeRunIds: params.excludeRunIds,
  });
  const resolvePendingRuns = (keyPrefix: string) =>
    resolveAuthorizedPreRegisteredRunsForSessionKeys({
      context: params.context,
      sessionKeys,
      agentId: params.agentId,
      defaultAgentId: params.defaultAgentId,
      requester: params.requester,
      keyPrefix,
      preserveSideRuns: params.preserveSideRuns,
      includeProtectedRuns: params.includeProtectedRuns,
      excludeRunIds: params.excludeRunIds,
    });
  const pendingAgent = resolvePendingRuns("agent:");
  const pendingChat = resolvePendingRuns(PENDING_CHAT_SEND_DEDUPE_PREFIX);
  const pendingPlans = [pendingAgent, pendingChat];
  const hasAuthorizedGatewayRuns =
    authorizedRuns.length > 0 ||
    queuedPlan.authorized.length > 0 ||
    pendingPlans.some((plan) => plan.authorizedRuns.length > 0);
  const workerService = asWorkerInferenceControl(params.context.workerEnvironmentService);
  const workerSessionId = params.sessionId;
  const isLifecycleAbort = Boolean(
    params.cascadeDescendants || params.onAuthorizedAfterQueuedAbort,
  );
  const hasWorkerRun = Boolean(
    workerSessionId &&
    (!hasAuthorizedGatewayRuns || isLifecycleAbort) &&
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
    queuedPlan.hasUnauthorizedRuns ||
    pendingPlans.some((plan) => plan.hasUnauthorizedRuns) ||
    (hasWorkerRun && !hasControllerRepresentedWorkerRun && !params.requester.isAdmin);
  const hasProtectedLifecycleRuns =
    hasProtectedActiveRuns || pendingPlans.some((plan) => plan.hasProtectedRuns);
  const hasUnauthorizedProtectedOwner =
    hasUnauthorizedProtectedActiveRuns ||
    pendingPlans.some((plan) => plan.hasUnauthorizedProtectedRuns);
  const hasUnauthorizedLifecycleOwner = isLifecycleAbort && hasUnauthorizedProtectedOwner;
  const canRunLifecycleCleanup = !hasUnauthorizedOwner && !hasProtectedLifecycleRuns;
  // Keep ordinary chat.abort's admin worker behavior; only the injected broad
  // lifecycle path must preserve hidden or explicitly preserved Gateway runs.
  const canCancelWorkerSession = !isLifecycleAbort || !hasProtectedLifecycleRuns;
  let snapshots: AbortedPartialSnapshot[] = [];
  const abortAuthorizedRuns = () => {
    params.onControllerTargets?.(authorizedRuns);
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
      if (
        !hasWorkerRun ||
        !workerSessionId ||
        !params.requester.isAdmin ||
        !canCancelWorkerSession
      ) {
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
    snapshots = authorizedRuns.flatMap(({ runId, entry }) => {
      const text = params.context.chatRunState.resolveBuffer(runId, { final: true }).text;
      return text?.trim()
        ? [
            captureAbortedPartial({
              runId,
              sessionKey: params.sessionKey,
              sessionId: entry.sessionId,
              agentId: entry.agentId ?? params.agentId,
              text,
              abortOrigin: params.abortOrigin,
              session: params.session,
            }),
          ]
        : [];
    });
    // Abort queued owners before any active-work signal can promote a successor.
    // Keep them first in the response to preserve the established runIds ordering.
    const runIds: string[] = abortQueuedChatTurns(
      params.context.chatQueuedTurns,
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
    for (const { runId, sessionKey, payload } of pendingAgent.authorizedRuns) {
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
    for (const { runId, payload } of pendingChat.authorizedRuns) {
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
    return { aborted: additionalAborted || runIds.length > 0, runIds, unauthorized: false };
  };
  let result: ReturnType<typeof abortAuthorizedRuns> = {
    aborted: false,
    runIds: [],
    unauthorized: false,
  };
  let descendants: Awaited<ReturnType<typeof abortControlledSubagents>>;
  if (params.cascadeDescendants && canRunLifecycleCleanup && !hasUnauthorizedLifecycleOwner) {
    descendants = await abortControlledSubagents({
      cfg: params.context.getRuntimeConfig(),
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      beforeKill: () => {
        result = abortAuthorizedRuns();
        return true;
      },
    });
  } else {
    result = abortAuthorizedRuns();
  }
  // Cancellation owns the critical phase; transcript errors remain visible afterward.
  if (result.aborted && snapshots.length > 0) {
    const abortedRunIds = new Set(result.runIds);
    await persistAbortedPartials({
      context: params.context,
      snapshots: snapshots.filter((snapshot) => abortedRunIds.has(snapshot.runId)),
    });
  }
  if (params.session && !params.session.ok) {
    throw params.session.error;
  }
  return { ...result, aborted: result.aborted || Boolean(descendants?.killed), descendants };
}
