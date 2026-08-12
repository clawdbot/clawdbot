import {
  collectAmbiguousAutomaticMediaUrls,
  collectAutomaticDeliveredMediaUrls,
  collectDeliveredMediaUrls,
  getAgentCommandDeliveryFailure,
  getGatewayAgentResult,
  hasCommittedOutboundDeliveryEvidence,
  hasCompleteAutomaticMediaDeliveryOutcomeEvidence,
  hasUnaccountedMessagingToolAggregateEvidence,
  hasVisibleAgentPayload,
  type AgentDeliveryEvidence,
} from "../agents/embedded-agent-runner/delivery-evidence.js";
import { formatGeneratedMediaDeliveryRetryForPrompt } from "../agents/internal-events.js";
import { resolveDurableCompletionDeliveryMode } from "../auto-reply/reply/completion-delivery-policy.js";
import {
  getRestartRecoveryTerminalDeliveryEvidence,
  hasRestartRecoveryTerminalRun,
} from "../config/sessions/restart-recovery-state.js";
import { appendAssistantMessageToSessionTranscript } from "../config/sessions/transcript.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { sourceDeliveryTargetsMatch } from "../infra/outbound/source-delivery-plan.js";
import {
  advanceSessionDeliveryAgentRun,
  deferSessionDelivery,
  failSessionDelivery,
  markSessionDeliveryAttemptStarted,
  markSessionDeliverySettlement,
  SessionDeliveryDeadLetteredError,
  SessionDeliveryDeferredError,
  SessionDeliveryRetryChargedError,
  SessionDeliverySafeRetryError,
  type QueuedSessionDelivery,
  type SessionDeliveryRoute,
} from "../infra/session-delivery-queue.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizeMediaReferenceForComparison } from "../media/media-reference-comparison.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel.js";
import { dispatchGatewayMethodInProcess } from "./server-plugins.js";
import { loadSessionEntry } from "./session-utils.js";

const log = createSubsystemLogger("gateway/restart-sentinel");
const AGENT_DELIVERY_OWNERSHIP_RETRY_MS = 1_000;

type QueuedAgentTurnSessionDelivery = Extract<QueuedSessionDelivery, { kind: "agentTurn" }>;

function sessionDeliveryStateDirArgs(stateDir?: string): [] | [string] {
  return stateDir === undefined ? [] : [stateDir];
}

async function deadLetterSessionDelivery(
  entry: QueuedAgentTurnSessionDelivery,
  reason: string,
  stateDir?: string,
): Promise<never> {
  await markSessionDeliverySettlement(
    entry,
    "moved-to-failed",
    ...sessionDeliveryStateDirArgs(stateDir),
  );
  log.warn("queued session delivery requires durable dead-letter settlement", {
    queueId: entry.id,
  });
  throw new SessionDeliveryDeadLetteredError(reason);
}

function hasQueuedVisiblePayload(payload: unknown): boolean {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const visible = (payload as { visible?: unknown }).visible;
    if (typeof visible === "boolean") {
      return visible;
    }
  }
  return hasVisibleAgentPayload(
    { payloads: [payload] },
    {
      includeErrorPayloads: false,
      includeReasoningPayloads: false,
    },
  );
}

function hasQueuedVisibleAgentPayload(result: Pick<AgentDeliveryEvidence, "payloads">): boolean {
  return Array.isArray(result.payloads) && result.payloads.some(hasQueuedVisiblePayload);
}

function hasUnexpectedRecoverySideEffects(result: AgentDeliveryEvidence): boolean {
  return (
    result.restartUnsafeSideEffectsDetected === true ||
    result.messagingToolAggregateEvidenceUnaccounted === true ||
    result.messagingToolSentTargetsTruncated === true ||
    result.didSendDeterministicApprovalPrompt === true ||
    hasCommittedOutboundDeliveryEvidence(result)
  );
}

function hasUnaccountedOrUnsafeParentOnlyDeliveryEvidence(result: AgentDeliveryEvidence): boolean {
  if (
    result.restartUnsafeSideEffectsDetected === true ||
    result.messagingToolAggregateEvidenceUnaccounted === true ||
    result.messagingToolSentTargetsTruncated === true ||
    result.didSendDeterministicApprovalPrompt === true ||
    hasUnaccountedMessagingToolAggregateEvidence(result) ||
    (Array.isArray(result.messagingToolSentTargets) && result.messagingToolSentTargets.length > 64)
  ) {
    return true;
  }
  const hasConcreteMessagingToolReceipt =
    Array.isArray(result.messagingToolSentTargets) &&
    result.messagingToolSentTargets.some(
      (target) => target !== null && typeof target === "object" && !Array.isArray(target),
    );
  const hasCommittedNonMessagingEffect = hasCommittedOutboundDeliveryEvidence({
    acceptedSessionSpawns: result.acceptedSessionSpawns,
    successfulCronAdds: result.successfulCronAdds,
  });
  return (
    hasCommittedNonMessagingEffect ||
    (hasCommittedOutboundDeliveryEvidence(result) && !hasConcreteMessagingToolReceipt)
  );
}

function collectParentOnlySourceRouteMedia(params: {
  result: AgentDeliveryEvidence;
  route: SessionDeliveryRoute;
}): { matchedRoute: boolean; mediaUrls: Set<string> } {
  if (params.route.channel === INTERNAL_MESSAGE_CHANNEL) {
    return { matchedRoute: false, mediaUrls: new Set() };
  }
  const targets = Array.isArray(params.result.messagingToolSentTargets)
    ? params.result.messagingToolSentTargets
    : [];
  let matchedRoute = false;
  const mediaUrls = new Set<string>();
  for (const target of targets) {
    if (!target || typeof target !== "object" || Array.isArray(target)) {
      continue;
    }
    if (!sourceDeliveryTargetsMatch(target, params.route)) {
      continue;
    }
    matchedRoute = true;
    const targetMediaUrls = (target as { mediaUrls?: unknown }).mediaUrls;
    if (Array.isArray(targetMediaUrls)) {
      for (const mediaUrl of targetMediaUrls) {
        if (typeof mediaUrl === "string" && mediaUrl.trim()) {
          mediaUrls.add(normalizeMediaReferenceForComparison(mediaUrl));
        }
      }
    }
  }
  return { matchedRoute, mediaUrls };
}

async function rearmParentOnlyGeneratedMediaAgentRun(params: {
  entry: QueuedAgentTurnSessionDelivery;
  stateDir?: string;
  reason?: string;
  updates?: {
    expectedMediaUrls?: string[];
    message?: string;
    suppressTextDelivery?: boolean;
  };
}): Promise<never> {
  const reason =
    params.reason ??
    "queued parent-only generated-media agent turn completed without a matching source-route message-tool receipt";
  const currentAgentRunAttempt = params.entry.agentRunAttempt ?? 0;
  if (params.entry.lastChargedAgentRunAttempt !== currentAgentRunAttempt) {
    await failSessionDelivery(
      params.entry.id,
      reason,
      ...sessionDeliveryStateDirArgs(params.stateDir),
    );
  }
  try {
    if (params.stateDir !== undefined) {
      await advanceSessionDeliveryAgentRun(params.entry.id, params.updates, params.stateDir);
    } else if (params.updates) {
      await advanceSessionDeliveryAgentRun(params.entry.id, params.updates);
    } else {
      await advanceSessionDeliveryAgentRun(params.entry.id);
    }
    await deferSessionDelivery(
      params.entry.id,
      AGENT_DELIVERY_OWNERSHIP_RETRY_MS,
      ...sessionDeliveryStateDirArgs(params.stateDir),
    );
  } catch (error) {
    log.warn("queued parent-only generated-media retry transition remains pending", {
      queueId: params.entry.id,
      error: String(error),
    });
    throw new SessionDeliveryRetryChargedError(
      `${reason}; queue state transition failed after retry charge`,
    );
  }
  throw new SessionDeliveryDeferredError(reason);
}

function resolveQueuedAgentRunId(entry: QueuedAgentTurnSessionDelivery) {
  const base = entry.idempotencyKey ?? entry.messageId;
  return entry.agentRunAttempt ? `${base}:attempt:${entry.agentRunAttempt}` : base;
}

function collectVisiblePayloadMediaUrls(result: AgentDeliveryEvidence): string[] {
  const urls = new Set<string>();
  const payloads = Array.isArray(result.payloads) ? result.payloads : [];
  for (const payload of payloads) {
    if (!hasQueuedVisiblePayload(payload)) {
      continue;
    }
    for (const url of collectDeliveredMediaUrls({ payloads: [payload] })) {
      urls.add(url);
    }
  }
  return Array.from(urls);
}

function collectQueuedDeliveredMediaUrls(params: {
  result: AgentDeliveryEvidence;
  route: SessionDeliveryRoute;
}): string[] {
  if (params.route.channel === INTERNAL_MESSAGE_CHANNEL) {
    return collectVisiblePayloadMediaUrls(params.result);
  }
  return collectAutomaticDeliveredMediaUrls(params.result);
}

function hasAutomaticVisibleSendEvidence(result: AgentDeliveryEvidence): boolean {
  if (result.deliveryStatus?.status === "sent" || result.deliveryStatus?.status === "suppressed") {
    return hasQueuedVisibleAgentPayload(result);
  }
  const payloads = Array.isArray(result.payloads) ? result.payloads : [];
  const outcomes = Array.isArray(result.deliveryStatus?.payloadOutcomes)
    ? result.deliveryStatus.payloadOutcomes
    : [];
  return outcomes.some((outcome) => {
    if (!outcome || typeof outcome !== "object" || Array.isArray(outcome)) {
      return false;
    }
    const record = outcome as Record<string, unknown>;
    if (
      record.status !== "sent" &&
      record.status !== "suppressed" &&
      record.sentBeforeError !== true
    ) {
      return false;
    }
    const index =
      typeof record.index === "number" && Number.isInteger(record.index) ? record.index : undefined;
    return index !== undefined && hasQueuedVisiblePayload(payloads[index]);
  });
}

function hasQueuedVisibleReplyEvidence(params: {
  result: AgentDeliveryEvidence;
  route: SessionDeliveryRoute;
}): boolean {
  if (params.route.channel === INTERNAL_MESSAGE_CHANNEL) {
    return hasQueuedVisibleAgentPayload(params.result);
  }
  return hasAutomaticVisibleSendEvidence(params.result);
}

async function evaluateQueuedGeneratedMediaAgentResult(params: {
  entry: QueuedAgentTurnSessionDelivery;
  result: AgentDeliveryEvidence;
  route: SessionDeliveryRoute;
  stateDir?: string;
  persistInternalMedia?: (mediaUrls: string[]) => Promise<void>;
}) {
  if (params.entry.completionTarget === "parent") {
    if (hasUnaccountedOrUnsafeParentOnlyDeliveryEvidence(params.result)) {
      log.warn("parent-only generated-media recovery has unaccounted or unsafe evidence", {
        queueId: params.entry.id,
      });
      await deadLetterSessionDelivery(
        params.entry,
        "queued parent-only generated-media delivery dead-lettered after unaccounted or unsafe delivery evidence",
        params.stateDir,
      );
    }
    const sourceReceipt = collectParentOnlySourceRouteMedia(params);
    const expectedMediaUrls = params.entry.expectedMediaUrls ?? [];
    const missingMediaUrls = expectedMediaUrls.filter(
      (mediaUrl) => !sourceReceipt.mediaUrls.has(normalizeMediaReferenceForComparison(mediaUrl)),
    );
    if (sourceReceipt.matchedRoute && missingMediaUrls.length === 0) {
      return;
    }
    if (sourceReceipt.matchedRoute) {
      const retryMessage = formatGeneratedMediaDeliveryRetryForPrompt(missingMediaUrls);
      await rearmParentOnlyGeneratedMediaAgentRun({
        entry: params.entry,
        ...(params.stateDir !== undefined ? { stateDir: params.stateDir } : {}),
        reason:
          "queued parent-only generated-media agent turn completed without all expected media on the matching source route",
        updates: {
          expectedMediaUrls: missingMediaUrls,
          ...(retryMessage ? { message: retryMessage } : {}),
          suppressTextDelivery: true,
        },
      });
    }
    await rearmParentOnlyGeneratedMediaAgentRun(params);
  }
  if (hasUnexpectedRecoverySideEffects(params.result)) {
    log.warn("queued generated-media recovery reported an unexpected committed side effect", {
      queueId: params.entry.id,
    });
    await deadLetterSessionDelivery(
      params.entry,
      "queued generated-media delivery dead-lettered after an unexpected committed side effect",
      params.stateDir,
    );
  }
  const expectedMediaUrls = params.entry.expectedMediaUrls ?? [];
  const deliveredMediaUrls = new Set(
    collectQueuedDeliveredMediaUrls(params).map(normalizeMediaReferenceForComparison),
  );
  const isDelivered = (url: string) =>
    deliveredMediaUrls.has(normalizeMediaReferenceForComparison(url));
  const missingMediaUrls = expectedMediaUrls.filter((url) => !isDelivered(url));
  const provenExpectedMediaUrls = expectedMediaUrls.filter(isDelivered);
  const ambiguousMediaUrls = new Set(
    collectAmbiguousAutomaticMediaUrls(params.result).map(normalizeMediaReferenceForComparison),
  );
  const deliveryFailure = getAgentCommandDeliveryFailure(params.result);
  const replySatisfied =
    expectedMediaUrls.length > 0
      ? missingMediaUrls.length === 0
      : hasQueuedVisibleReplyEvidence(params);
  const evidenceTruncated = params.result.payloadsTruncated === true;
  if (evidenceTruncated && !replySatisfied) {
    log.warn("queued generated-media delivery has truncated delivery evidence", {
      queueId: params.entry.id,
    });
    await deadLetterSessionDelivery(
      params.entry,
      "queued generated-media delivery dead-lettered after truncated evidence",
      params.stateDir,
    );
  }
  if (expectedMediaUrls.length > 0 && missingMediaUrls.length === 0) {
    await params.persistInternalMedia?.(provenExpectedMediaUrls);
    return;
  }
  const rearmAgentRun = async (
    reason: string,
    updates?: {
      expectedMediaUrls?: string[];
      message?: string;
      suppressTextDelivery?: boolean;
    },
  ): Promise<never> => {
    const currentAgentRunAttempt = params.entry.agentRunAttempt ?? 0;
    const currentAttemptAlreadyCharged =
      params.entry.lastChargedAgentRunAttempt === currentAgentRunAttempt;
    // Charge the terminal attempt before advancing its identity. Recovery may
    // revisit the same durable evidence, but must never charge that attempt twice.
    if (!currentAttemptAlreadyCharged) {
      await failSessionDelivery(
        params.entry.id,
        reason,
        ...sessionDeliveryStateDirArgs(params.stateDir),
      );
    }
    try {
      if (updates) {
        await advanceSessionDeliveryAgentRun(
          params.entry.id,
          updates,
          ...sessionDeliveryStateDirArgs(params.stateDir),
        );
      } else if (params.stateDir !== undefined) {
        await advanceSessionDeliveryAgentRun(params.entry.id, undefined, params.stateDir);
      } else {
        await advanceSessionDeliveryAgentRun(params.entry.id);
      }
      await deferSessionDelivery(
        params.entry.id,
        AGENT_DELIVERY_OWNERSHIP_RETRY_MS,
        ...sessionDeliveryStateDirArgs(params.stateDir),
      );
    } catch (error) {
      log.warn("queued generated-media terminal attempt state transition remains pending", {
        queueId: params.entry.id,
        error: String(error),
      });
      throw new SessionDeliveryRetryChargedError(
        `${reason}; queue state transition failed after retry charge`,
      );
    }
    throw new SessionDeliveryDeferredError(reason);
  };
  if (deliveryFailure && expectedMediaUrls.length > 0) {
    const incompletePartialFailureEvidence =
      params.result.deliveryStatus?.status === "partial_failed" &&
      !hasCompleteAutomaticMediaDeliveryOutcomeEvidence(params.result, missingMediaUrls);
    if (
      incompletePartialFailureEvidence ||
      missingMediaUrls.some((url) =>
        ambiguousMediaUrls.has(normalizeMediaReferenceForComparison(url)),
      )
    ) {
      log.warn("queued generated-media delivery has ambiguous attachment side effects", {
        queueId: params.entry.id,
        error: deliveryFailure,
      });
      await deadLetterSessionDelivery(
        params.entry,
        "queued generated-media delivery dead-lettered after ambiguous side effects",
        params.stateDir,
      );
    }
  } else if (deliveryFailure) {
    if (hasQueuedVisibleReplyEvidence(params)) {
      log.warn("queued generated-media notice may already be visible; refusing duplicate replay", {
        queueId: params.entry.id,
        error: deliveryFailure,
      });
      await deadLetterSessionDelivery(
        params.entry,
        "queued generated-media notice dead-lettered after a visible partial delivery",
        params.stateDir,
      );
    }
    await rearmAgentRun(deliveryFailure);
  }
  if (provenExpectedMediaUrls.length > 0) {
    await params.persistInternalMedia?.(provenExpectedMediaUrls);
  }
  if (missingMediaUrls.length > 0) {
    const retryMessage = formatGeneratedMediaDeliveryRetryForPrompt(missingMediaUrls);
    const qualifier =
      missingMediaUrls.length < expectedMediaUrls.length ? "partially missed" : "missed";
    const reason = `queued generated-media agent turn ${qualifier} expected media: ${missingMediaUrls.join(", ")}`;
    await rearmAgentRun(reason, {
      expectedMediaUrls: missingMediaUrls,
      ...(missingMediaUrls.length < expectedMediaUrls.length ||
      hasQueuedVisibleReplyEvidence(params) ||
      params.result.deliveryStatus?.status === "partial_failed"
        ? { suppressTextDelivery: true }
        : {}),
      ...(retryMessage ? { message: retryMessage } : {}),
    });
  }
  if (expectedMediaUrls.length === 0 && !hasQueuedVisibleReplyEvidence(params)) {
    await rearmAgentRun("queued generated-media agent turn completed without a visible reply");
  }
}

/** Runs durable generated-media handoffs through the normal owning-session agent loop. */
export async function deliverQueuedGeneratedMediaAgentTurn(params: {
  canonicalKey: string;
  entry: QueuedSessionDelivery;
  sessionEntry?: SessionEntry;
  stateDir?: string;
}): Promise<boolean> {
  if (params.entry.kind !== "agentTurn") {
    return false;
  }
  const entry = params.entry;
  const route = entry.route;
  if (!route || entry.inputProvenance?.kind !== "inter_session" || !entry.sourceReplyDeliveryMode) {
    return false;
  }

  const queuedRunId = resolveQueuedAgentRunId(entry);
  const parentOnlyCompletion = entry.completionTarget === "parent";
  const deliveryMode = resolveDurableCompletionDeliveryMode(entry.sourceReplyDeliveryMode);
  if (
    !parentOnlyCompletion &&
    deliveryMode === "host_owned" &&
    route.channel === INTERNAL_MESSAGE_CHANNEL
  ) {
    return await deadLetterSessionDelivery(
      entry,
      "queued host-owned generated-media delivery requires an external route",
      params.stateDir,
    );
  }
  const persistInternalMedia =
    route.channel === INTERNAL_MESSAGE_CHANNEL && (entry.expectedMediaUrls?.length ?? 0) > 0
      ? async (mediaUrls: string[]) => {
          const sessionId = params.sessionEntry?.sessionId?.trim();
          if (!sessionId) {
            throw new Error("queued internal generated-media delivery has no owning session");
          }
          const appended = await appendAssistantMessageToSessionTranscript({
            sessionKey: params.canonicalKey,
            expectedSessionId: sessionId,
            ...(params.sessionEntry?.cronRunContinuation?.lifecycleRevision
              ? {
                  expectedLifecycleRevision:
                    params.sessionEntry.cronRunContinuation.lifecycleRevision,
                }
              : {}),
            mediaUrls,
            idempotencyKey: `${queuedRunId}:generated-media-transcript`,
            updateMode: "inline",
          });
          if (!appended.ok) {
            if (appended.code === "session-rebound") {
              await deadLetterSessionDelivery(
                entry,
                "queued internal generated-media delivery lost its owning session",
                params.stateDir,
              );
            }
            throw new Error(
              `queued internal generated-media transcript persistence failed: ${appended.reason}`,
            );
          }
        }
      : undefined;
  const evaluateResult = async (result: AgentDeliveryEvidence): Promise<true> => {
    await evaluateQueuedGeneratedMediaAgentResult({
      entry,
      result,
      route,
      ...(params.stateDir !== undefined ? { stateDir: params.stateDir } : {}),
      ...(persistInternalMedia ? { persistInternalMedia } : {}),
    });
    return true;
  };
  const terminalEvidence = getRestartRecoveryTerminalDeliveryEvidence(
    params.sessionEntry,
    queuedRunId,
  );
  if (terminalEvidence) {
    return await evaluateResult(terminalEvidence);
  }
  if (hasRestartRecoveryTerminalRun(params.sessionEntry, queuedRunId)) {
    await deadLetterSessionDelivery(
      entry,
      "queued generated-media agent turn dead-lettered without durable terminal evidence",
      params.stateDir,
    );
  }
  const activeRecoveryClaim =
    params.sessionEntry?.restartRecoveryDeliverySourceRunId === queuedRunId &&
    Boolean(params.sessionEntry.restartRecoveryDeliveryRunId);
  if (activeRecoveryClaim) {
    await deferSessionDelivery(
      entry.id,
      AGENT_DELIVERY_OWNERSHIP_RETRY_MS,
      ...sessionDeliveryStateDirArgs(params.stateDir),
    );
    throw new SessionDeliveryDeferredError(
      "queued generated-media agent turn is still owned by agent recovery",
    );
  }
  if (entry.deliveryStartedAt !== undefined) {
    await deadLetterSessionDelivery(
      entry,
      "queued generated-media agent turn dead-lettered after an interrupted unproven attempt",
      params.stateDir,
    );
  }
  // Ordinary host-owned media uses fixed automatic transport. Parent-only
  // completions preserve message-tool ownership through the durable consumer.
  const sourceReplyDeliveryMode = parentOnlyCompletion ? "message_tool_only" : "automatic";
  const cronLifecycleRevision = params.sessionEntry?.cronRunContinuation?.lifecycleRevision?.trim();
  const cronSessionId = cronLifecycleRevision ? params.sessionEntry?.sessionId?.trim() : undefined;
  // Fence before gateway admission. Recovery clears it only for an explicit
  // pre-acceptance safe retry; accepted or deduped runs may already have effects.
  await markSessionDeliveryAttemptStarted(entry, ...sessionDeliveryStateDirArgs(params.stateDir));
  let accepted = false;
  let response: unknown;
  try {
    response = await dispatchGatewayMethodInProcess(
      "agent",
      {
        sessionKey: params.canonicalKey,
        message: entry.message,
        deliver: !parentOnlyCompletion && route.channel !== INTERNAL_MESSAGE_CHANNEL,
        bestEffortDeliver: false,
        channel: route.channel,
        accountId: route.accountId,
        to: route.to,
        threadId: route.threadId,
        ...(cronSessionId ? { sessionId: cronSessionId } : {}),
        inputProvenance: entry.inputProvenance,
        sourceReplyDeliveryMode,
        disableMessageTool: !parentOnlyCompletion,
        forceRestartSafeTools: true,
        idempotencyKey: queuedRunId,
      },
      {
        ...(cronSessionId ? { allowSyntheticCronRunContinuation: true } : {}),
        expectFinal: true,
        forceSyntheticClient: true,
        internalDeliveryMediaUrls: entry.expectedMediaUrls ?? [],
        ...(entry.suppressTextDelivery === true ? { internalDeliverySuppressText: true } : {}),
        onAccepted: () => {
          accepted = true;
        },
      },
    );
  } catch (error) {
    if (!accepted) {
      throw new SessionDeliverySafeRetryError(
        "queued generated-media agent turn failed before gateway acceptance",
        { cause: error },
      );
    }
    throw error;
  }
  const result = getGatewayAgentResult(response);
  if (!result) {
    const responseStatus =
      response && typeof response === "object"
        ? (response as { status?: unknown }).status
        : undefined;
    const latestEntry = loadSessionEntry(entry.sessionKey).entry;
    if (responseStatus === "accepted") {
      accepted = true;
    }
    if (
      responseStatus === "accepted" ||
      responseStatus === "in_flight" ||
      (latestEntry?.restartRecoveryDeliverySourceRunId === queuedRunId &&
        latestEntry.restartRecoveryDeliveryRunId)
    ) {
      await deferSessionDelivery(
        entry.id,
        AGENT_DELIVERY_OWNERSHIP_RETRY_MS,
        ...sessionDeliveryStateDirArgs(params.stateDir),
      );
      throw new SessionDeliveryDeferredError(
        "queued generated-media agent turn is still owned by agent recovery",
      );
    }
    if (hasRestartRecoveryTerminalRun(latestEntry, queuedRunId)) {
      const latestTerminalEvidence = getRestartRecoveryTerminalDeliveryEvidence(
        latestEntry,
        queuedRunId,
      );
      if (latestTerminalEvidence) {
        return await evaluateResult(latestTerminalEvidence);
      }
      log.warn(
        "queued generated-media agent turn ended without durable delivery evidence; failing closed",
        { queueId: entry.id, runId: queuedRunId },
      );
      await deadLetterSessionDelivery(
        entry,
        "queued generated-media agent turn dead-lettered without durable terminal evidence",
        params.stateDir,
      );
    }
    if (!accepted) {
      throw new SessionDeliverySafeRetryError(
        "queued generated-media agent turn returned no result before gateway acceptance",
      );
    }
    throw new Error("queued generated-media agent turn returned no delivery result");
  }
  return await evaluateResult(result);
}
