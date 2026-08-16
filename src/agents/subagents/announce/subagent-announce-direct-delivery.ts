/**
 * Requester-agent handoff and direct delivery for subagent announcements.
 */
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { completionRequiresMessageToolDelivery } from "../../../auto-reply/reply/completion-delivery-policy.js";
import { stringifyRouteThreadId } from "../../../plugin-sdk/channel-route.js";
import { defaultRuntime } from "../../../runtime.js";
import {
  isAgentMediatedCompletionSourceTool,
  shouldPreserveUserFacingSessionStateForInputProvenance,
} from "../../../sessions/input-provenance.js";
import { isCronRunSessionKey } from "../../../sessions/session-key-utils.js";
import { sessionDeliveryChannel } from "../../../utils/delivery-context.shared.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isGatewayMessageChannel,
  normalizeMessageChannel,
} from "../../../utils/message-channel.js";
import {
  getAgentCommandDeliveryFailure,
  getGatewayAgentResult,
  hasCommittedOutboundDeliveryEvidence,
  hasPayloadOutcomeSendEvidence,
} from "../../embedded-agent-runner/delivery-evidence.js";
import {
  hasIntentionalSilentAgentPayload,
  hasVisibleAgentPayload,
} from "../../embedded-agent-runner/message-visibility.js";
import type { EmbeddedAgentQueueMessageOptions } from "../../embedded-agent-runner/run-state.js";
import { AGENT_INTERNAL_EVENT_TYPE_TASK_COMPLETION } from "../../internal-event-contract.js";
import type { AgentInternalEvent } from "../../internal-events.js";
import {
  formatActiveWakeFailure,
  isSourceOwnerChangedWake,
  resolveActiveWakeWithRetries,
  resolveRequesterSessionActivity,
} from "./subagent-announce-active-wake.js";
import {
  deliverCompletionDirect,
  hasFailedSubagentNoOutputCompletion,
  hasMessagingToolDeliveryToSource,
  isDirectMessageDeliveryTarget,
  isGatewayAgentRunPending,
} from "./subagent-announce-completion-delivery.js";
import {
  hasAnnounceSendEvidence,
  isIncompleteAnnounceAgentResultError,
  isPermanentAnnounceDeliveryError,
  resolveSubagentAnnounceTimeoutMs,
  runAnnounceDeliveryWithRetry,
  SourceOwnerChangedError,
  sourceOwnerChangedResult,
  summarizeDeliveryError,
} from "./subagent-announce-delivery-retry.js";
import {
  dispatchSubagentAnnounceAgent,
  getSubagentAnnounceRuntimeConfig,
  isSubagentRequesterSessionAbandoned,
  loadRequesterSessionEntry,
  resolveExternalBestEffortDeliveryTarget,
  resolveQueueSettings,
} from "./subagent-announce-delivery.runtime.js";
import type { SubagentAnnounceDeliveryResult } from "./subagent-announce-dispatch.js";
import type { SubagentCompletionToolHandoffRegistration } from "./subagent-announce-handoff.js";
import {
  resolveCompletionDeliveryOrigins,
  type DeliveryContext,
} from "./subagent-announce-origin.js";
import { resolveRequesterStoreKey } from "./subagent-requester-store-key.js";

async function runAnnounceAgentCall(params: {
  agentParams: Record<string, unknown>;
  delegatedToolPolicyHandoff?: SubagentCompletionToolHandoffRegistration;
  expectFinal?: boolean;
  timeoutMs?: number;
}): Promise<unknown> {
  return await dispatchSubagentAnnounceAgent(params.agentParams, {
    expectFinal: params.expectFinal,
    forceSyntheticClient: shouldPreserveUserFacingSessionStateForInputProvenance(
      params.agentParams.inputProvenance,
    ),
    delegatedToolPolicyHandoff: params.delegatedToolPolicyHandoff,
    timeoutMs: params.timeoutMs,
  });
}

export async function sendSubagentAnnounceDirectly(params: {
  requesterSessionKey: string;
  requesterAgentId?: string;
  targetRequesterSessionKey: string;
  triggerMessage: string;
  internalEvents?: AgentInternalEvent[];
  expectsCompletionMessage: boolean;
  requireVisibleReply?: boolean;
  bestEffortDeliver?: boolean;
  directIdempotencyKey: string;
  completionDirectOrigin?: DeliveryContext;
  directOrigin?: DeliveryContext;
  requesterSessionOrigin?: DeliveryContext;
  sourceSessionKey?: string;
  sourceChannel?: string;
  sourceTool?: string;
  isSourceSessionEffectsAllowed?: () => boolean;
  isCompletionOwnedByRequesterYield?: () => boolean;
  requesterIsSubagent: boolean;
  onDeliveryResult?: (delivery: SubagentAnnounceDeliveryResult) => void;
  signal?: AbortSignal;
}): Promise<SubagentAnnounceDeliveryResult> {
  if (params.signal?.aborted) {
    return {
      delivered: false,
      path: "none",
    };
  }
  const cfg = getSubagentAnnounceRuntimeConfig();
  const announceTimeoutMs = resolveSubagentAnnounceTimeoutMs(cfg);
  const canonicalRequesterSessionKey = resolveRequesterStoreKey(
    cfg,
    params.targetRequesterSessionKey,
    params.requesterAgentId,
  );
  try {
    // Merge completionDirectOrigin with directOrigin so that missing fields
    // (channel, to, accountId) fall back to the originating session's
    // lastChannel / lastTo. Without this, a completion origin that carries a
    // channel but not a `to` would prevent external delivery.
    const { directOrigin, requesterSessionOrigin, effectiveDirectOrigin } =
      resolveCompletionDeliveryOrigins(params);
    const sessionOnlyOrigin = effectiveDirectOrigin?.channel
      ? effectiveDirectOrigin
      : requesterSessionOrigin;
    const requesterEntry = loadRequesterSessionEntry(
      params.targetRequesterSessionKey,
      params.requesterAgentId,
    ).entry;
    const deliveryTarget = !params.requesterIsSubagent
      ? resolveExternalBestEffortDeliveryTarget({
          channel: effectiveDirectOrigin?.channel,
          to: effectiveDirectOrigin?.to,
          accountId: effectiveDirectOrigin?.accountId,
          threadId: effectiveDirectOrigin?.threadId,
        })
      : { deliver: false };
    const normalizedSessionOnlyOriginChannel = !params.requesterIsSubagent
      ? normalizeMessageChannel(sessionOnlyOrigin?.channel)
      : undefined;
    const sessionOnlyOriginChannel =
      normalizedSessionOnlyOriginChannel &&
      isGatewayMessageChannel(normalizedSessionOnlyOriginChannel)
        ? normalizedSessionOnlyOriginChannel
        : undefined;
    const sourceToolId =
      normalizeOptionalLowercaseString(params.sourceTool) ??
      (params.expectsCompletionMessage ? "subagent_announce" : "");
    const isSubagentCompletion = sourceToolId === "subagent_announce";
    const subagentCompletionEvents = params.internalEvents?.filter(
      (event) =>
        event.type === AGENT_INTERNAL_EVENT_TYPE_TASK_COMPLETION && event.source === "subagent",
    );
    const trustedCompletionEvent =
      subagentCompletionEvents?.length === 1 &&
      subagentCompletionEvents[0]?.childSessionKey === params.sourceSessionKey
        ? subagentCompletionEvents[0]
        : undefined;
    const hasRequiredSubagentNoOutputCompletion =
      params.expectsCompletionMessage &&
      isSubagentCompletion &&
      (trustedCompletionEvent?.result.trim() === "(no output)" ||
        hasFailedSubagentNoOutputCompletion(params.internalEvents));
    const agentMediatedCompletion =
      params.expectsCompletionMessage && isAgentMediatedCompletionSourceTool(sourceToolId);
    const completionRouteRequiresMessageToolDelivery =
      params.expectsCompletionMessage &&
      completionRequiresMessageToolDelivery({
        cfg,
        requesterSessionKey: params.requesterSessionKey,
        targetRequesterSessionKey: canonicalRequesterSessionKey,
        requesterEntry,
        directOrigin: effectiveDirectOrigin,
        requesterSessionOrigin,
      });
    const subagentDirectMessageCompletionRequiresMessageTool =
      params.expectsCompletionMessage &&
      isSubagentCompletion &&
      deliveryTarget.deliver &&
      isDirectMessageDeliveryTarget(deliveryTarget, canonicalRequesterSessionKey);
    const requiresMessageToolDelivery =
      completionRouteRequiresMessageToolDelivery ||
      subagentDirectMessageCompletionRequiresMessageTool;
    const requesterActivity = resolveRequesterSessionActivity(
      params.targetRequesterSessionKey,
      params.requesterAgentId,
    );
    if (
      params.expectsCompletionMessage &&
      isSubagentRequesterSessionAbandoned(canonicalRequesterSessionKey, requesterActivity.sessionId)
    ) {
      return {
        delivered: false,
        path: "none",
        reason: "requester_abandoned",
        error: "requester session abandoned after timeout",
      };
    }
    const isCompletionDeliveryAllowed = () =>
      params.isSourceSessionEffectsAllowed?.() !== false &&
      !(params.expectsCompletionMessage && params.isCompletionOwnedByRequesterYield?.());
    if (!isCompletionDeliveryAllowed()) {
      // sessions_yield owns the post-turn synthesis. Starting or steering a
      // requester turn here would replay the original fanout during handoff.
      return {
        delivered: false,
        path: "none",
        reason: "completion_handoff_pending",
        terminal: true,
        disposition: "intentional_non_delivery",
      };
    }
    const tryTextCompletionDirectDelivery = () =>
      deliverCompletionDirect({
        cfg,
        requesterSessionKey: canonicalRequesterSessionKey,
        requesterAgentId: params.requesterAgentId,
        directIdempotencyKey: params.directIdempotencyKey,
        deliveryTarget,
        internalEvents: params.internalEvents,
        onDeliveryResult: params.onDeliveryResult,
        isSourceSessionEffectsAllowed: isCompletionDeliveryAllowed,
      });
    const completionSourceReplyDeliveryMode = requiresMessageToolDelivery
      ? "message_tool_only"
      : undefined;
    const shouldDeliverAgentFinal = deliveryTarget.deliver && !requiresMessageToolDelivery;
    const requesterQueueSettings = resolveQueueSettings({
      cfg,
      channel:
        sessionDeliveryChannel(requesterEntry) ??
        requesterSessionOrigin?.channel ??
        directOrigin?.channel,
      sessionEntry: requesterEntry,
    });
    if (
      params.expectsCompletionMessage &&
      requesterActivity.sessionId &&
      requesterActivity.isActive
    ) {
      const wakeOptions: EmbeddedAgentQueueMessageOptions = {
        deliveryTimeoutMs: announceTimeoutMs,
        steeringMode: "all",
        ...(completionSourceReplyDeliveryMode
          ? { sourceReplyDeliveryMode: completionSourceReplyDeliveryMode }
          : {}),
        ...(requesterQueueSettings.debounceMs !== undefined
          ? { debounceMs: requesterQueueSettings.debounceMs }
          : {}),
        waitForTranscriptCommit: true,
      };
      // Ordinary subagent and harness handoffs must wait through compaction
      // and transcript retries before treating an active wake as failed.
      const wakeOutcome = await resolveActiveWakeWithRetries(
        requesterActivity.sessionId,
        params.triggerMessage,
        wakeOptions,
        params.signal,
        isCompletionDeliveryAllowed,
      );
      if (isSourceOwnerChangedWake(wakeOutcome)) {
        return sourceOwnerChangedResult();
      }
      if (wakeOutcome.queued) {
        return {
          delivered: true,
          deliveredAt: wakeOutcome.deliveredAtMs,
          enqueuedAt: wakeOutcome.enqueuedAtMs,
          path: "steered",
        };
      }
      defaultRuntime.log(
        `[warn] Active requester session could not be woken for subagent completion; falling back to requester-agent handoff: ${formatActiveWakeFailure(
          "active requester session could not be woken",
          wakeOutcome,
        )}`,
      );
    }
    if (
      params.expectsCompletionMessage &&
      isCronRunSessionKey(canonicalRequesterSessionKey) &&
      !resolveRequesterSessionActivity(params.targetRequesterSessionKey, params.requesterAgentId)
        .isActive &&
      !agentMediatedCompletion
    ) {
      return {
        delivered: false,
        path: "none",
        reason: "completion_handoff_pending",
        terminal: true,
        disposition: "intentional_non_delivery",
      };
    }
    if (params.signal?.aborted) {
      return {
        delivered: false,
        path: "none",
      };
    }
    const directAgentThreadId = shouldDeliverAgentFinal
      ? stringifyRouteThreadId(deliveryTarget.threadId)
      : sessionOnlyOriginChannel
        ? stringifyRouteThreadId(sessionOnlyOrigin?.threadId)
        : undefined;
    const directAgentParams: Record<string, unknown> = {
      sessionKey: canonicalRequesterSessionKey,
      message: params.triggerMessage,
      deliver: shouldDeliverAgentFinal,
      bestEffortDeliver: params.bestEffortDeliver,
      internalEvents: params.internalEvents,
      channel: shouldDeliverAgentFinal ? deliveryTarget.channel : sessionOnlyOriginChannel,
      accountId: shouldDeliverAgentFinal
        ? deliveryTarget.accountId
        : sessionOnlyOriginChannel
          ? sessionOnlyOrigin?.accountId
          : undefined,
      to: shouldDeliverAgentFinal
        ? deliveryTarget.to
        : sessionOnlyOriginChannel
          ? sessionOnlyOrigin?.to
          : undefined,
      threadId: directAgentThreadId,
      inputProvenance: {
        kind: "inter_session",
        sourceSessionKey: params.sourceSessionKey,
        sourceChannel: params.sourceChannel ?? INTERNAL_MESSAGE_CHANNEL,
        sourceTool: params.sourceTool ?? "subagent_announce",
      },
      ...(completionSourceReplyDeliveryMode
        ? { sourceReplyDeliveryMode: completionSourceReplyDeliveryMode }
        : {}),
      idempotencyKey: params.directIdempotencyKey,
    };
    let directAnnounceResponse: unknown;
    try {
      directAnnounceResponse = await runAnnounceDeliveryWithRetry({
        operation: params.expectsCompletionMessage
          ? "completion direct announce agent call"
          : "direct announce agent call",
        signal: params.signal,
        isAttemptAllowed: isCompletionDeliveryAllowed,
        run: async () => {
          if (!isCompletionDeliveryAllowed()) {
            throw new SourceOwnerChangedError();
          }
          return await runAnnounceAgentCall({
            agentParams: directAgentParams,
            delegatedToolPolicyHandoff:
              isSubagentCompletion &&
              trustedCompletionEvent &&
              params.sourceSessionKey &&
              requesterActivity.sessionId &&
              params.isSourceSessionEffectsAllowed?.() !== false
                ? {
                    sourceSessionKey: params.sourceSessionKey,
                    ...(trustedCompletionEvent.childSessionId
                      ? { sourceSessionId: trustedCompletionEvent.childSessionId }
                      : {}),
                    targetSessionKey: canonicalRequesterSessionKey,
                    targetSessionId: requesterActivity.sessionId,
                    idempotencyKey: params.directIdempotencyKey,
                  }
                : undefined,
            expectFinal: true,
            timeoutMs: announceTimeoutMs,
          });
        },
      });
      if (!isCompletionDeliveryAllowed()) {
        return sourceOwnerChangedResult();
      }
    } catch (err) {
      if (err instanceof SourceOwnerChangedError) {
        return sourceOwnerChangedResult();
      }
      if (isPermanentAnnounceDeliveryError(err) && hasAnnounceSendEvidence(err)) {
        throw err;
      }
      if (
        params.expectsCompletionMessage &&
        (shouldDeliverAgentFinal || subagentDirectMessageCompletionRequiresMessageTool) &&
        isSubagentCompletion &&
        isIncompleteAnnounceAgentResultError(err)
      ) {
        const textDelivery = await tryTextCompletionDirectDelivery();
        if (textDelivery) {
          return textDelivery;
        }
      }
      // The requester-agent handoff is the delivery contract for background
      // completions. A failed handoff should retry/fail visibly instead
      // of sending the child result directly to the external channel.
      throw err;
    }

    const directAnnounceStillPending = isGatewayAgentRunPending(directAnnounceResponse);
    if (directAnnounceStillPending) {
      return {
        delivered: true,
        path: "direct",
      };
    }

    const directAnnounceResult = getGatewayAgentResult(directAnnounceResponse);
    const directDeliveryFailure =
      (shouldDeliverAgentFinal || requiresMessageToolDelivery) && directAnnounceResult
        ? getAgentCommandDeliveryFailure(directAnnounceResult)
        : undefined;
    if (directDeliveryFailure) {
      return {
        delivered: false,
        path: "direct",
        error: directDeliveryFailure,
        ...(directAnnounceResult && hasPayloadOutcomeSendEvidence(directAnnounceResult)
          ? { disposition: "ambiguous" as const }
          : {}),
      };
    }
    const hasMessagingToolDelivery = Boolean(
      directAnnounceResult &&
      hasMessagingToolDeliveryToSource(directAnnounceResult, deliveryTarget),
    );
    const completionPayloadVisibility = {
      includeErrorPayloads: false,
      includeReasoningPayloads: false,
    };
    const hasVisibleGatewayPayload = Boolean(
      directAnnounceResult &&
      (hasVisibleAgentPayload(directAnnounceResult, completionPayloadVisibility) ||
        hasMessagingToolDelivery),
    );
    const hasVisibleNonSilentGatewayPayload = Boolean(
      directAnnounceResult &&
      hasVisibleAgentPayload(directAnnounceResult, {
        ...completionPayloadVisibility,
        includeSilentReplyPayloads: false,
      }),
    );
    const hasIntentionalSilentCompletionReply = Boolean(
      directAnnounceResult && hasIntentionalSilentAgentPayload(directAnnounceResult),
    );
    const hasCompletionSideEffect = Boolean(
      directAnnounceResult && hasCommittedOutboundDeliveryEvidence(directAnnounceResult),
    );
    const hasVisibleRequiredCompletionReply =
      hasMessagingToolDelivery ||
      (!requiresMessageToolDelivery && hasVisibleNonSilentGatewayPayload);
    if (
      params.expectsCompletionMessage &&
      shouldDeliverAgentFinal &&
      isSubagentCompletion &&
      !hasVisibleNonSilentGatewayPayload &&
      !hasMessagingToolDelivery
    ) {
      const textDelivery = await tryTextCompletionDirectDelivery();
      if (textDelivery) {
        return textDelivery;
      }
      if (hasRequiredSubagentNoOutputCompletion && !hasCompletionSideEffect) {
        return {
          delivered: false,
          path: "direct",
          reason: "visible_reply_missing",
          error: "completion agent did not produce a visible reply",
        };
      }
    }
    if (
      hasRequiredSubagentNoOutputCompletion &&
      !hasVisibleRequiredCompletionReply &&
      hasCompletionSideEffect
    ) {
      return {
        delivered: false,
        path: "direct",
        reason: "visible_reply_missing",
        error: "completion agent did not produce a visible reply",
        disposition: "permanent_failure",
      };
    }
    if (
      params.expectsCompletionMessage &&
      requiresMessageToolDelivery &&
      !hasMessagingToolDelivery &&
      (!hasIntentionalSilentCompletionReply ||
        subagentDirectMessageCompletionRequiresMessageTool ||
        hasRequiredSubagentNoOutputCompletion)
    ) {
      if (hasRequiredSubagentNoOutputCompletion) {
        return {
          delivered: false,
          path: "direct",
          reason: "visible_reply_missing",
          error: "completion agent did not produce a visible reply",
        };
      }
      if (subagentDirectMessageCompletionRequiresMessageTool) {
        const textDelivery = await tryTextCompletionDirectDelivery();
        if (textDelivery) {
          return textDelivery;
        }
      }
      return {
        delivered: false,
        path: "direct",
        reason: "message_tool_delivery_missing",
        error: "completion agent did not use the message tool for message-tool-only delivery",
      };
    }
    const hasVisibleCompletionReply = Boolean(
      directAnnounceResult &&
      ((params.requireVisibleReply
        ? hasMessagingToolDeliveryToSource(directAnnounceResult, deliveryTarget, {
            requireFinalReply: true,
          })
        : hasMessagingToolDelivery) ||
        (hasVisibleAgentPayload(
          params.requireVisibleReply
            ? {
                payloads: Array.isArray(directAnnounceResult.payloads)
                  ? directAnnounceResult.payloads.filter((payload) => {
                      const flags = payload as Record<string, unknown>;
                      return (
                        flags?.isCommentary !== true &&
                        flags?.isCompactionNotice !== true &&
                        flags?.isFallbackNotice !== true &&
                        flags?.isStatusNotice !== true &&
                        flags?.visible !== false
                      );
                    })
                  : [],
              }
            : directAnnounceResult,
          { ...completionPayloadVisibility, includeSilentReplyPayloads: false },
        ) &&
          (!params.requireVisibleReply ||
            directAnnounceResult.deliveryStatus?.status !== "suppressed"))),
    );
    const acceptsIntentionalSilentCompletion =
      hasIntentionalSilentCompletionReply && !isSubagentCompletion;
    if (
      !hasVisibleCompletionReply &&
      (params.requireVisibleReply ||
        (params.expectsCompletionMessage &&
          !shouldDeliverAgentFinal &&
          !requiresMessageToolDelivery &&
          !hasCompletionSideEffect &&
          !acceptsIntentionalSilentCompletion))
    ) {
      return {
        delivered: false,
        path: "direct",
        reason: "visible_reply_missing",
        error: "completion agent did not produce a visible reply",
      };
    }
    if (
      params.expectsCompletionMessage &&
      shouldDeliverAgentFinal &&
      !isSubagentCompletion &&
      !hasVisibleGatewayPayload
    ) {
      return {
        delivered: false,
        path: "direct",
        reason: "visible_reply_missing",
        error: "completion agent did not produce a visible reply",
      };
    }

    return {
      delivered: true,
      path: "direct",
    };
  } catch (err) {
    const permanent = isPermanentAnnounceDeliveryError(err);
    const disposition = permanent
      ? hasAnnounceSendEvidence(err)
        ? "ambiguous"
        : "permanent_failure"
      : "retryable";
    return {
      delivered: false,
      path: "direct",
      error: summarizeDeliveryError(err),
      disposition,
    };
  }
}
