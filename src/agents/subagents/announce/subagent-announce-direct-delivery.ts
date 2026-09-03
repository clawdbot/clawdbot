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
import type { UserTurnTranscriptRecorder } from "../../../sessions/user-turn-transcript.types.js";
import { sessionDeliveryChannel } from "../../../utils/delivery-context.shared.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isGatewayMessageChannel,
  normalizeMessageChannel,
} from "../../../utils/message-channel.js";
import { normalizeAgentRunTerminalDeliverySnapshot } from "../../agent-run-terminal-delivery.js";
import {
  getAgentCommandDeliveryFailure,
  getGatewayAgentResult,
  hasCommittedOutboundDeliveryEvidence,
  getAutomaticDeliveryEvidence,
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
  resolveSubagentRequesterSessionAbandonment,
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
  signal?: AbortSignal;
  timeoutMs?: number;
  isExecutionAllowed: () => boolean;
  resolveGatewayContext?: import("../../../gateway/server-methods/types.js").GatewayContextResolver;
}): Promise<unknown> {
  const deadline = new AbortController();
  const signal = params.signal
    ? AbortSignal.any([params.signal, deadline.signal])
    : deadline.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let executionStarted = false;
  const armDeadline = () => {
    clearTimeout(timer);
    if (params.timeoutMs !== undefined) {
      timer = setTimeout(
        () => deadline.abort(new Error("gateway request timeout for agent")),
        params.timeoutMs,
      );
      timer.unref?.();
    }
  };
  armDeadline();
  try {
    return await dispatchSubagentAnnounceAgent(params.agentParams, {
      cancelOnDeadline: true,
      expectFinal: params.expectFinal,
      forceSyntheticClient: shouldPreserveUserFacingSessionStateForInputProvenance(
        params.agentParams.inputProvenance,
      ),
      operatorRoleActor: { kind: "system" },
      delegatedToolPolicyHandoff: params.delegatedToolPolicyHandoff,
      signal,
      // Accepted follow-ups belong to session admission. Waiting behind a busy
      // parent must not spend the completion's execution budget or retry quota.
      onAccepted: () => {
        if (!executionStarted) {
          clearTimeout(timer);
        }
      },
      onExecutionStarted: () => {
        signal.throwIfAborted();
        if (!params.isExecutionAllowed()) {
          throw new SourceOwnerChangedError();
        }
        executionStarted = true;
        armDeadline();
      },
      resolveGatewayContext: params.resolveGatewayContext,
    });
  } finally {
    clearTimeout(timer);
  }
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
  createUserTurnTranscriptRecorder?: (sessionId: string) => UserTurnTranscriptRecorder;
  onDeliveryResult?: (delivery: SubagentAnnounceDeliveryResult) => void;
  signal?: AbortSignal;
  resolveGatewayContext?: import("../../../gateway/server-methods/types.js").GatewayContextResolver;
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
    // A partial completion origin must retain the target from the requester's
    // recorded delivery context or the generated reply becomes undeliverable.
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
    const hasFailedTrustedSubagentCompletion =
      trustedCompletionEvent !== undefined && trustedCompletionEvent.status !== "ok";
    const hasRequiredSubagentNoOutputCompletion =
      params.expectsCompletionMessage &&
      isSubagentCompletion &&
      (trustedCompletionEvent?.result.trim() === "(no output)" ||
        hasFailedSubagentNoOutputCompletion(params.internalEvents));
    const hasSuccessfulTrustedSubagentNoOutputCompletion =
      hasRequiredSubagentNoOutputCompletion && trustedCompletionEvent?.status === "ok";
    const textCompletionDirectDeliveryKind = hasFailedTrustedSubagentCompletion
      ? "failed_notice"
      : "completed_result";
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
    const requesterAbandonment = params.expectsCompletionMessage
      ? resolveSubagentRequesterSessionAbandonment(
          canonicalRequesterSessionKey,
          requesterActivity.sessionId,
        )
      : undefined;
    if (requesterAbandonment === "timeout") {
      return {
        delivered: false,
        path: "none",
        reason: "requester_abandoned",
        error: "requester session abandoned after timeout",
      };
    }
    if (requesterAbandonment === "recovering_timeout") {
      return {
        delivered: false,
        path: "none",
        reason: "completion_handoff_pending",
        error: "requester timeout recovery is still settling",
        disposition: "retryable",
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
    const tryTextCompletionDirectDelivery = (
      contentKind: "completed_result" | "failed_notice" = "completed_result",
    ) =>
      deliverCompletionDirect({
        cfg,
        requesterSessionKey: canonicalRequesterSessionKey,
        requesterAgentId: params.requesterAgentId,
        directIdempotencyKey: params.directIdempotencyKey,
        deliveryTarget,
        internalEvents: params.internalEvents,
        contentKind,
        signal: params.signal,
        onDeliveryResult: params.onDeliveryResult,
        isSourceSessionEffectsAllowed: isCompletionDeliveryAllowed,
      });
    // Synthetic requester-settle turns must not inherit a tool-only mode that suppresses the final.
    const completionSourceReplyDeliveryMode = requiresMessageToolDelivery
      ? "message_tool_only"
      : params.requireVisibleReply && deliveryTarget.deliver
        ? "automatic"
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
        ...(params.createUserTurnTranscriptRecorder
          ? {
              userTurnTranscriptRecorder: params.createUserTurnTranscriptRecorder(
                requesterActivity.sessionId,
              ),
            }
          : {}),
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
            signal: params.signal,
            timeoutMs: announceTimeoutMs,
            isExecutionAllowed: isCompletionDeliveryAllowed,
            resolveGatewayContext: params.resolveGatewayContext,
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
      if (hasAnnounceSendEvidence(err)) {
        throw err;
      }
      if (params.signal?.aborted) {
        return { delivered: false, path: "none" };
      }
      const directCompletionFallbackKind = hasFailedTrustedSubagentCompletion
        ? "failed_notice"
        : isIncompleteAnnounceAgentResultError(err)
          ? "completed_result"
          : undefined;
      if (
        params.expectsCompletionMessage &&
        (shouldDeliverAgentFinal || subagentDirectMessageCompletionRequiresMessageTool) &&
        isSubagentCompletion &&
        directCompletionFallbackKind
      ) {
        const textDelivery = await tryTextCompletionDirectDelivery(directCompletionFallbackKind);
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
    const hasFinalMessagingToolDelivery = Boolean(
      directAnnounceResult &&
      hasMessagingToolDeliveryToSource(directAnnounceResult, deliveryTarget, {
        requireFinalReply: true,
      }),
    );
    const hasMessagingToolDelivery = Boolean(
      directAnnounceResult &&
      hasMessagingToolDeliveryToSource(directAnnounceResult, deliveryTarget),
    );
    const requiresAutomaticFinalReceipt =
      shouldDeliverAgentFinal && (params.expectsCompletionMessage || params.requireVisibleReply);
    const automaticEvidence = getAutomaticDeliveryEvidence(directAnnounceResult ?? {});
    const directDeliveryFailure =
      (shouldDeliverAgentFinal || requiresMessageToolDelivery) && directAnnounceResult
        ? getAgentCommandDeliveryFailure(directAnnounceResult)
        : undefined;
    // Automatic-delivery diagnostics and a committed source message are independent facts.
    // Once the message tool delivered the owed final, the task must settle as delivered.
    if (
      directDeliveryFailure &&
      !(requiresAutomaticFinalReceipt ? hasFinalMessagingToolDelivery : hasMessagingToolDelivery)
    ) {
      return {
        delivered: false,
        path: "direct",
        error: directDeliveryFailure,
        ...(automaticEvidence.mayHaveSent ? { disposition: "ambiguous" as const } : {}),
      };
    }
    const completionPayloadVisibility = {
      includeErrorPayloads: false,
      includeReasoningPayloads: false,
      requireTerminalContent: true,
    };
    const hasVisibleNonSilentGatewayPayload = Boolean(
      directAnnounceResult &&
      hasVisibleAgentPayload(directAnnounceResult, {
        ...completionPayloadVisibility,
        includeSilentReplyPayloads: false,
      }),
    );
    const terminalDelivery = normalizeAgentRunTerminalDeliverySnapshot(
      directAnnounceResult?.deliveryStatus,
    );
    const automaticFinalDelivered =
      terminalDelivery?.status === "sent" && terminalDelivery.resultCount > 0;
    if (
      requiresAutomaticFinalReceipt &&
      !hasFinalMessagingToolDelivery &&
      terminalDelivery?.status === "suppressed" &&
      // Only genuinely empty output can fall back; another payload may have
      // been sent or intentionally cancelled by policy.
      (automaticEvidence.mayHaveSent ||
        automaticEvidence.suppressionReason !== "no_visible_payload")
    ) {
      return {
        delivered: false,
        path: "direct",
        reason: automaticEvidence.mayHaveSent ? undefined : "delivery_suppressed",
        error: automaticEvidence.mayHaveSent
          ? "automatic completion delivery could not be confirmed"
          : (automaticEvidence.suppressionReason ?? "automatic completion delivery suppressed"),
        disposition: automaticEvidence.mayHaveSent ? "ambiguous" : "intentional_non_delivery",
        terminal: automaticEvidence.mayHaveSent ? undefined : true,
      };
    }
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
      const textDelivery = await tryTextCompletionDirectDelivery(textCompletionDirectDeliveryKind);
      if (textDelivery) {
        return textDelivery;
      }
      if (hasSuccessfulTrustedSubagentNoOutputCompletion && !hasCompletionSideEffect) {
        return {
          delivered: false,
          path: "direct",
          reason: "visible_reply_missing",
          error: "completion agent did not produce a visible reply",
        };
      }
    }
    if (
      hasSuccessfulTrustedSubagentNoOutputCompletion &&
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
      if (hasSuccessfulTrustedSubagentNoOutputCompletion) {
        return {
          delivered: false,
          path: "direct",
          reason: "visible_reply_missing",
          error: "completion agent did not produce a visible reply",
        };
      }
      if (subagentDirectMessageCompletionRequiresMessageTool) {
        const textDelivery = await tryTextCompletionDirectDelivery(
          textCompletionDirectDeliveryKind,
        );
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
    const requesterVisibleFinalDelivered =
      hasFinalMessagingToolDelivery || (shouldDeliverAgentFinal && automaticFinalDelivered);
    const hasVisibleCompletionReply =
      requesterVisibleFinalDelivered ||
      (!shouldDeliverAgentFinal && !params.requireVisibleReply && hasMessagingToolDelivery) ||
      // Nested requesters and internal sessions observe the final in their transcript.
      // Unresolved external origins still require delivery evidence.
      (!requiresMessageToolDelivery &&
        hasVisibleNonSilentGatewayPayload &&
        directAnnounceResult?.deliveryStatus?.status !== "suppressed" &&
        (params.requesterIsSubagent ||
          [effectiveDirectOrigin, requesterSessionOrigin].every((origin) =>
            origin?.channel
              ? normalizeMessageChannel(origin.channel) === INTERNAL_MESSAGE_CHANNEL
              : !origin?.to,
          )));
    const acceptsIntentionalSilentCompletion =
      hasIntentionalSilentCompletionReply && !isSubagentCompletion;
    if (
      !hasVisibleCompletionReply &&
      (params.requireVisibleReply ||
        (params.expectsCompletionMessage &&
          (shouldDeliverAgentFinal ||
            (!requiresMessageToolDelivery &&
              !hasCompletionSideEffect &&
              !acceptsIntentionalSilentCompletion))))
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
      ...(params.expectsCompletionMessage &&
      !params.requesterIsSubagent &&
      requesterVisibleFinalDelivered
        ? { requesterVisibleFinalDelivered: true }
        : {}),
    };
  } catch (err) {
    const disposition = hasAnnounceSendEvidence(err)
      ? "ambiguous"
      : isPermanentAnnounceDeliveryError(err)
        ? "permanent_failure"
        : "retryable";
    return {
      delivered: false,
      path: "direct",
      error: summarizeDeliveryError(err),
      disposition,
    };
  }
}
