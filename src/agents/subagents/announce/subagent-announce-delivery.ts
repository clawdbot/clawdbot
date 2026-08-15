/**
 * Subagent completion announcement delivery.
 *
 * Routes completion payloads through gateway/channel/session paths and records delivery evidence.
 */
import { normalizeUniqueTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import { completionRequiresMessageToolDelivery } from "../../../auto-reply/reply/completion-delivery-policy.js";
import { scheduleSessionDelivery } from "../../../infra/session-delivery-queue-runtime.js";
import {
  enqueueClaimedSessionDelivery,
  releaseSessionDeliveryClaim,
} from "../../../infra/session-delivery-queue-storage.js";
import { defaultRuntime } from "../../../runtime.js";
import { isAgentMediatedCompletionSourceTool } from "../../../sessions/input-provenance.js";
import { isCronSessionKey } from "../../../sessions/session-key-utils.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../../utils/message-channel.js";
import { mediaUrlsFromGeneratedAttachments } from "../../generated-attachments.js";
import { hasGeneratedMediaCompletionEvent } from "../../internal-event-contract.js";
import {
  formatAgentInternalEventsForPrompt,
  type AgentInternalEvent,
} from "../../internal-events.js";
import { admitCorrelatedSubagentSessionDelivery } from "../completion/subagent-completion-delivery.js";
import { getSubagentDepthFromSessionStore } from "../spawn/subagent-depth.js";
import { maybeSteerSubagentAnnounce } from "./subagent-announce-active-wake.js";
import {
  hasAnnounceSendEvidence,
  hasWriterClaimReboundAnnounceError,
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

function collectExpectedMediaFromInternalEvents(
  events: AgentInternalEvent[] | undefined,
): string[] {
  return normalizeUniqueTrimmedStringList(
    events?.flatMap((event) => [
      ...(Array.isArray(event.mediaUrls) ? event.mediaUrls : []),
      ...mediaUrlsFromGeneratedAttachments(event.attachments),
    ]),
  );
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
        expectedMediaUrls: collectExpectedMediaFromInternalEvents(params.internalEvents),
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
        requireVisibleReply: params.requireVisibleReply,
        onDeliveryResult: params.onDeliveryResult,
        signal: params.signal,
        bestEffortDeliver: params.bestEffortDeliver,
      });
    },
  });
}

const testing = {
  setDepsForTest(overrides?: Partial<SubagentAnnounceDeliveryDeps>) {
    setSubagentAnnounceDeliveryDepsForTest(overrides);
  },
  hasAnnounceSendEvidence,
  hasWriterClaimReboundAnnounceError,
  isWriterClaimReboundAnnounceError,
};
if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.subagentAnnounceDeliveryTestApi")
  ] = testing;
}
