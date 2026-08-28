/**
 * Subagent completion announcement delivery.
 *
 * Routes completion payloads through gateway/channel/session paths and records delivery evidence.
 */
import type { ContinuationTrigger } from "../../../auto-reply/get-reply-options.types.js";
import { completionRequiresMessageToolDelivery } from "../../../auto-reply/reply/completion-delivery-policy.js";
import { isContinuationHeartbeatEquivalent } from "../../../auto-reply/reply/run-provenance.js";
import { normalizeDiagnosticTraceparent } from "../../../infra/diagnostic-trace-context.js";
import { scheduleSessionDelivery } from "../../../infra/session-delivery-queue-runtime.js";
import {
  enqueueClaimedSessionDelivery,
  releaseSessionDeliveryClaim,
} from "../../../infra/session-delivery-queue-storage.js";
import { defaultRuntime } from "../../../runtime.js";
import {
  isAgentMediatedCompletionSourceTool,
  type InputProvenance,
} from "../../../sessions/input-provenance.js";
import { isCronSessionKey } from "../../../sessions/session-key-utils.js";
import { createUserTurnTranscriptRecorder } from "../../../sessions/user-turn-transcript.js";
import type { UserTurnTranscriptRecorder } from "../../../sessions/user-turn-transcript.types.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../../utils/message-channel.js";
import { hasGeneratedMediaCompletionEvent } from "../../internal-event-contract.js";
import {
  collectAgentInternalEventMedia,
  formatAgentInternalEventsForPrompt,
  type AgentInternalEvent,
} from "../../internal-events.js";
import { admitCorrelatedSubagentSessionDelivery } from "../completion/subagent-completion-delivery.js";
import { getSubagentDepthFromSessionStore } from "../spawn/subagent-depth.js";
import { maybeSteerSubagentAnnounce } from "./subagent-announce-active-wake.js";
import {
  hasAnnounceSendEvidence,
  isWriterClaimReboundAnnounceError,
  resolveSubagentAnnounceTimeoutMs,
  runAnnounceDeliveryWithRetry,
  sourceOwnerChangedResult,
  summarizeDeliveryError,
} from "./subagent-announce-delivery-retry.js";
import {
  getSubagentAnnounceRuntimeConfig,
  loadRequesterSessionEntry,
  loadSessionEntryByKey,
  setSubagentAnnounceDeliveryDepsForTest,
  type SubagentAnnounceDeliveryDeps,
} from "./subagent-announce-delivery.runtime.js";
import { sendSubagentAnnounceDirectly } from "./subagent-announce-direct-delivery.js";
import {
  runSubagentAnnounceDispatch,
  type SubagentAnnounceDeliveryResult,
} from "./subagent-announce-dispatch.js";
import {
  resolveCompletionDeliveryOrigins,
  resolveGeneratedMediaSessionDeliveryRoute,
  type DeliveryContext,
} from "./subagent-announce-origin.js";
import { resolveRequesterStoreKey } from "./subagent-requester-store-key.js";

export {
  loadRequesterSessionEntry,
  loadSessionEntryByKey,
  resolveSubagentAnnounceTimeoutMs,
  runAnnounceDeliveryWithRetry,
};

export function isInternalAnnounceRequesterSession(sessionKey: string | undefined): boolean {
  return getSubagentDepthFromSessionStore(sessionKey) >= 1 || isCronSessionKey(sessionKey);
}

function collectExpectedMediaFromInternalEvents(events: AgentInternalEvent[] | undefined): {
  expectedMediaUrls: string[];
  expectedMediaAttachments?: Record<string, NonNullable<AgentInternalEvent["attachments"]>[number]>;
} {
  const { mediaUrls: expectedMediaUrls, attachments } = collectAgentInternalEventMedia(events);
  const expectedMediaAttachments = Object.fromEntries(
    expectedMediaUrls.map((mediaUrl, index) => [mediaUrl, attachments[index] ?? {}]),
  );
  return {
    expectedMediaUrls,
    ...(expectedMediaUrls.length > 0 ? { expectedMediaAttachments } : {}),
  };
}

function createCompletionUserTurnTranscriptRecorderFactory(params: {
  directIdempotencyKey: string;
  requesterAgentId?: string;
  sourceSessionKey?: string;
  sourceChannel?: string;
  sourceTool?: string;
  targetRequesterSessionKey: string;
  triggerMessage: string;
}): (sessionId: string) => UserTurnTranscriptRecorder {
  const provenance: InputProvenance = {
    kind: "inter_session",
    ...(params.sourceSessionKey ? { sourceSessionKey: params.sourceSessionKey } : {}),
    sourceChannel: params.sourceChannel ?? INTERNAL_MESSAGE_CHANNEL,
    sourceTool: params.sourceTool ?? "subagent_announce",
  };
  const recorders = new Map<string, UserTurnTranscriptRecorder>();
  return (sessionId) => {
    const existing = recorders.get(sessionId);
    if (existing) {
      return existing;
    }
    // Retries targeting one session share a recorder. A successor session gets
    // its own target guard while the logical idempotency key remains stable.
    const recorder = createUserTurnTranscriptRecorder({
      input: {
        text: params.triggerMessage,
        idempotencyKey: `${params.directIdempotencyKey}:active-wake`,
        provenance,
      },
      target: () => {
        const loaded = loadRequesterSessionEntry(
          params.targetRequesterSessionKey,
          params.requesterAgentId,
        );
        if (!loaded.entry || loaded.entry.sessionId?.trim() !== sessionId || !loaded.agentId) {
          return undefined;
        }
        return {
          sessionId,
          expectedSessionId: sessionId,
          sessionKey: loaded.canonicalKey,
          sessionEntry: loaded.entry,
          ...(loaded.storePath ? { storePath: loaded.storePath } : {}),
          agentId: loaded.agentId,
          config: loaded.cfg,
        };
      },
      errorContext: "active requester completion transcript",
    });
    recorders.set(sessionId, recorder);
    return recorder;
  };
}

export async function deliverSubagentAnnouncement(params: {
  requesterSessionKey: string;
  requesterAgentId?: string;
  announceId?: string;
  triggerMessage: string;
  steerMessage: string;
  internalEvents?: AgentInternalEvent[];
  summaryLine?: string;
  requesterSessionOrigin?: DeliveryContext;
  requesterOrigin?: DeliveryContext;
  completionDirectOrigin?: DeliveryContext;
  directOrigin?: DeliveryContext;
  sourceSessionKey?: string;
  sourceRunId?: string;
  sourceChannel?: string;
  sourceTool?: string;
  isSourceSessionEffectsAllowed?: () => boolean;
  isCompletionOwnedByRequesterYield?: () => boolean;
  targetRequesterSessionKey: string;
  requesterIsSubagent: boolean;
  expectsCompletionMessage: boolean;
  requireDirectDelivery?: boolean;
  requireVisibleReply?: boolean;
  bestEffortDeliver?: boolean;
  directIdempotencyKey: string;
  onDeliveryResult?: (delivery: SubagentAnnounceDeliveryResult) => void;
  signal?: AbortSignal;
  continuationTriggerOverride?: ContinuationTrigger;
  traceparent?: string;
  resolveGatewayContext?: import("../../../gateway/server-methods/types.js").GatewayContextResolver;
}): Promise<SubagentAnnounceDeliveryResult> {
  const sourceOwnerChanged = () => params.isSourceSessionEffectsAllowed?.() === false;
  if (sourceOwnerChanged()) {
    return sourceOwnerChangedResult();
  }
  const durableGeneratedMediaHandoff =
    params.expectsCompletionMessage &&
    isAgentMediatedCompletionSourceTool(params.sourceTool) &&
    hasGeneratedMediaCompletionEvent(params.internalEvents);
  let durableQueueId: string | undefined;
  let durableQueueClaimed = false;
  if (durableGeneratedMediaHandoff) {
    try {
      const continuationTrigger = isContinuationHeartbeatEquivalent(
        params.continuationTriggerOverride,
      )
        ? params.continuationTriggerOverride
        : undefined;
      const traceparent = normalizeDiagnosticTraceparent(params.traceparent);
      const cfg = getSubagentAnnounceRuntimeConfig();
      const canonicalSessionKey = resolveRequesterStoreKey(
        cfg,
        params.targetRequesterSessionKey,
        params.requesterAgentId,
      );
      const queuedRoute = resolveGeneratedMediaSessionDeliveryRoute({
        sessionKey: canonicalSessionKey,
        completionDirectOrigin: params.completionDirectOrigin,
        directOrigin: params.directOrigin,
        requesterSessionOrigin: params.requesterSessionOrigin,
      });
      const { requesterSessionOrigin, effectiveDirectOrigin } = resolveCompletionDeliveryOrigins({
        expectsCompletionMessage: params.expectsCompletionMessage,
        completionDirectOrigin: params.completionDirectOrigin,
        directOrigin: params.directOrigin,
        requesterSessionOrigin: params.requesterSessionOrigin,
      });
      const requesterEntry = loadRequesterSessionEntry(
        params.targetRequesterSessionKey,
        params.requesterAgentId,
      ).entry;
      // No external route exists for an internal-only handoff. Let the normal
      // agent final enter the owning transcript instead of requiring a message tool target.
      const sourceReplyDeliveryMode =
        queuedRoute.route.channel === INTERNAL_MESSAGE_CHANNEL
          ? "automatic"
          : completionRequiresMessageToolDelivery({
                cfg,
                requesterSessionKey: params.requesterSessionKey,
                targetRequesterSessionKey: canonicalSessionKey,
                requesterEntry,
                directOrigin: effectiveDirectOrigin,
                requesterSessionOrigin,
              })
            ? "message_tool_only"
            : "automatic";
      const expectedMedia = collectExpectedMediaFromInternalEvents(params.internalEvents);
      const queuePayload = {
        kind: "agentTurn",
        sessionKey: canonicalSessionKey,
        message: formatAgentInternalEventsForPrompt(params.internalEvents) || params.triggerMessage,
        messageId: `${params.directIdempotencyKey}:agent-loop`,
        route: queuedRoute.route,
        ...(queuedRoute.deliveryContext ? { deliveryContext: queuedRoute.deliveryContext } : {}),
        inputProvenance: {
          kind: "inter_session",
          ...(params.sourceSessionKey ? { sourceSessionKey: params.sourceSessionKey } : {}),
          sourceChannel: params.sourceChannel ?? INTERNAL_MESSAGE_CHANNEL,
          sourceTool: params.sourceTool ?? "subagent_announce",
        },
        sourceReplyDeliveryMode,
        ...expectedMedia,
        ...(continuationTrigger ? { continuationTrigger } : {}),
        ...(traceparent ? { traceparent, traceparentProvenance: "internal" as const } : {}),
        idempotencyKey: `${params.directIdempotencyKey}:agent-loop`,
      } as const;
      const queued = params.sourceRunId
        ? admitCorrelatedSubagentSessionDelivery({
            runId: params.sourceRunId,
            payload: queuePayload,
          })
        : await enqueueClaimedSessionDelivery(queuePayload, resolveSubagentAnnounceTimeoutMs(cfg));
      if (queued.status === "failed") {
        return {
          delivered: false,
          path: "queued",
          reason: "completion_handoff_unavailable",
          error: "generated media session handoff was already dead-lettered",
          disposition: "permanent_failure",
        };
      }
      if (queued.status === "completed") {
        return { delivered: true, path: "queued", disposition: "delivered" };
      }
      durableQueueId = queued.id;
      durableQueueClaimed = queued.claimed;
    } catch (error) {
      defaultRuntime.log(
        `[warn] Generated media session handoff could not be persisted; refusing ambiguous fallback: ${summarizeDeliveryError(error)}`,
      );
      return {
        delivered: false,
        path: "queued",
        reason: "completion_handoff_unavailable",
        error: "generated media session handoff could not be persisted",
        disposition: "retryable",
      };
    }
  }

  if (durableQueueId) {
    if (durableQueueClaimed) {
      await releaseSessionDeliveryClaim(durableQueueId).catch((error: unknown) => {
        defaultRuntime.log(
          `[warn] Generated media session handoff lease release failed; durable recovery remains pending: ${summarizeDeliveryError(error)}`,
        );
      });
    }
    await scheduleSessionDelivery(durableQueueId).catch((error: unknown) => {
      defaultRuntime.log(
        `[warn] Generated media session handoff retry scheduling failed; durable recovery remains pending: ${summarizeDeliveryError(error)}`,
      );
    });
    return { delivered: false, path: "queued", disposition: "session_queued" };
  }

  const createCompletionUserTurnTranscriptRecorder = params.expectsCompletionMessage
    ? createCompletionUserTurnTranscriptRecorderFactory(params)
    : undefined;

  return await runSubagentAnnounceDispatch({
    expectsCompletionMessage: params.expectsCompletionMessage,
    requireDirectDelivery: params.requireDirectDelivery,
    signal: params.signal,
    steer: async () => {
      if (sourceOwnerChanged()) {
        return { status: "source_owner_changed" };
      }
      return await maybeSteerSubagentAnnounce({
        deliveryTimeoutMs: resolveSubagentAnnounceTimeoutMs(getSubagentAnnounceRuntimeConfig()),
        requesterSessionKey: params.requesterSessionKey,
        requesterAgentId: params.requesterAgentId,
        steerMessage: params.steerMessage,
        createUserTurnTranscriptRecorder: createCompletionUserTurnTranscriptRecorder,
        signal: params.signal,
        isSourceSessionEffectsAllowed: params.isSourceSessionEffectsAllowed,
      });
    },
    direct: async () => {
      if (sourceOwnerChanged()) {
        return sourceOwnerChangedResult();
      }
      return await sendSubagentAnnounceDirectly({
        requesterSessionKey: params.requesterSessionKey,
        requesterAgentId: params.requesterAgentId,
        targetRequesterSessionKey: params.targetRequesterSessionKey,
        triggerMessage: params.triggerMessage,
        internalEvents: params.internalEvents,
        directIdempotencyKey: params.directIdempotencyKey,
        completionDirectOrigin: params.completionDirectOrigin,
        directOrigin: params.directOrigin,
        requesterSessionOrigin: params.requesterSessionOrigin,
        sourceSessionKey: params.sourceSessionKey,
        sourceChannel: params.sourceChannel,
        sourceTool: params.sourceTool,
        isSourceSessionEffectsAllowed: params.isSourceSessionEffectsAllowed,
        isCompletionOwnedByRequesterYield: params.isCompletionOwnedByRequesterYield,
        requesterIsSubagent: params.requesterIsSubagent,
        expectsCompletionMessage: params.expectsCompletionMessage,
        continuationTriggerOverride: params.continuationTriggerOverride,
        ...(params.traceparent ? { traceparent: params.traceparent } : {}),
        createUserTurnTranscriptRecorder: createCompletionUserTurnTranscriptRecorder,
        requireVisibleReply: params.requireVisibleReply,
        onDeliveryResult: params.onDeliveryResult,
        signal: params.signal,
        bestEffortDeliver: params.bestEffortDeliver,
        resolveGatewayContext: params.resolveGatewayContext,
      });
    },
  });
}

const testing = {
  setDepsForTest(overrides?: Partial<SubagentAnnounceDeliveryDeps>) {
    setSubagentAnnounceDeliveryDepsForTest(overrides);
  },
  hasAnnounceSendEvidence,
  isWriterClaimReboundAnnounceError,
};
if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.subagentAnnounceDeliveryTestApi")
  ] = testing;
}
