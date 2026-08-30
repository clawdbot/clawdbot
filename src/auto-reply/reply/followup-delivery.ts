/** Prepares queued follow-up payloads for source-channel delivery. */
import { hasOutboundReplyContent } from "openclaw/plugin-sdk/reply-payload";
import {
  hasCommittedSourceReplyDeliveryEvidence,
  hasCompletedSourceReplyDeliveryEvidence,
  hasCompletedTerminalDeliveryEvidence,
  hasVisibleCommittedMessagingToolDeliveryEvidence,
} from "../../agents/embedded-agent-runner/delivery-evidence.js";
import {
  hasDeliberateSilentTerminalReply,
  hasIntentionalTerminalCompletion,
} from "../../agents/embedded-agent-runner/result-fallback-classifier.js";
import { buildAgentRuntimeDeliveryPlan } from "../../agents/runtime-plan/build.js";
import { logVerbose } from "../../globals.js";
import { isSubagentSessionKey } from "../../routing/session-key.js";
import { defaultRuntime } from "../../runtime.js";
import { sessionDeliveryChannel } from "../../utils/delivery-context.shared.js";
import { isInternalMessageChannel } from "../../utils/message-channel.js";
import {
  getReplyPayloadMetadata,
  isReplyPayloadTerminalContent,
  markReplyPayloadForSourceSuppressionDelivery,
} from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import { normalizeAssistantFinalDeliveryText } from "./agent-runner-core.js";
import type { AgentTurnExecutionResult } from "./agent-runner-execution.types.js";
import {
  buildEmptyInteractiveReplyPayload,
  markPostCompactionModelFailurePayload,
  renderPostCompactionModelFailurePayload,
} from "./agent-runner-failure-reply.js";
import type { AccountedAgentTurn } from "./agent-runner-result-accounting.js";
import { appendUsageLine, resolveResponseUsageLine } from "./agent-runner-usage-line.js";
import { resolveFollowupDeliveryPayloads } from "./followup-delivery-payloads.js";
import type { AdmittedFollowupTurn, FollowupRunnerParams } from "./followup-turn-admission.js";
import type { InternalGetReplyOptions } from "./get-reply.types.js";
import { resolveOriginMessageProvider } from "./origin-routing.js";
import { warnPrivateMessageToolFinal } from "./private-message-tool-final.js";
import { enqueueFollowupRun, resolveQueueSettings, type FollowupRun } from "./queue.js";
import type { ReplyDispatchKind } from "./reply-dispatcher.types.js";
import { isRoutableChannel, routeReply } from "./route-reply.js";
import { buildSessionsYieldAcknowledgmentPayload } from "./sessions-yield-acknowledgment.js";
import { resolveSourceReplyVisibilityPolicy } from "./source-reply-delivery-mode.js";
import {
  buildStrandedReplyDeliveryFailurePayload,
  resolveStrandedReplyRecovery,
} from "./stranded-reply-recovery.js";
import { createTypingSignaler } from "./typing-mode.js";

type FollowupDeliveryDecision =
  | {
      kind: "deliver";
      payloads: ReplyPayload[];
      resolved?: { provider: string; model: string };
    }
  | {
      kind: "suppress";
      reason: "send-policy" | "room-event" | "silent" | "message-tool-only" | "aborted";
    }
  | {
      kind: "retry-source-delivery";
      run: FollowupRun;
      finalTextLength: number;
      resolved: { provider: string; model: string };
    }
  | {
      kind: "deliver-diagnostic";
      payload: ReplyPayload;
      resolved: { provider: string; model: string };
    };

/** Resolves one final queued delivery action without performing transport I/O. */
export function resolveFollowupDeliveryDecision(params: {
  turn: AdmittedFollowupTurn;
  execution: AgentTurnExecutionResult;
  accounting?: AccountedAgentTurn & { compactionNotice?: ReplyPayload };
  opts?: InternalGetReplyOptions;
}): FollowupDeliveryDecision {
  const { turn, execution, accounting, opts } = params;
  if (turn.sendPolicy === "deny") {
    return { kind: "suppress", reason: "send-policy" };
  }
  if (
    turn.queued.currentInboundEventKind === "room_event" &&
    !isInternalMessageChannel(turn.queued.originatingChannel)
  ) {
    return { kind: "suppress", reason: "room-event" };
  }
  if (
    execution.outcome.kind === "aborted" ||
    (execution.outcome.kind === "settled" && execution.outcome.abortReason)
  ) {
    return { kind: "suppress", reason: "aborted" };
  }
  const postCompactionModelFailure = execution.outcome.postCompactionModelFailure;
  const renderFailurePayloads = (payloads: ReplyPayload[]) =>
    payloads.map((payload) =>
      renderPostCompactionModelFailurePayload(
        markPostCompactionModelFailurePayload(postCompactionModelFailure, payload),
      ),
    );
  const sourcePolicy = resolveSourceReplyVisibilityPolicy({
    cfg: turn.config,
    ctx: {
      ChatType: turn.queued.originatingChatType ?? turn.queued.run.chatType,
      InboundEventKind: turn.queued.currentInboundEventKind,
      Provider: turn.queued.originatingChannel ?? turn.queued.run.messageProvider,
      Surface: turn.queued.originatingChannel ?? turn.queued.run.messageProvider,
    },
    requested: turn.queued.run.sourceReplyDeliveryMode ?? opts?.sourceReplyDeliveryMode,
    sendPolicy: turn.sendPolicy,
  });
  const hasDestination = Boolean(
    (isRoutableChannel(turn.queued.originatingChannel) && turn.queued.originatingTo) ||
    opts?.onBlockReply,
  );
  const isInteractive =
    hasDestination &&
    (turn.queued.run.inputProvenance?.kind === "external_user" ||
      (turn.queued.run.inputProvenance?.kind === undefined &&
        !isInternalMessageChannel(
          turn.queued.originatingChannel ?? turn.queued.run.messageProvider,
        )));
  const deliveryContext = {
    cfg: turn.config,
    messageProvider: turn.queued.run.messageProvider,
    originatingAccountId: turn.queued.originatingAccountId ?? turn.queued.run.agentAccountId,
    originatingChannel: turn.queued.originatingChannel,
    originatingChatType: turn.queued.originatingChatType,
    originatingReplyToMode: turn.queued.originatingReplyToMode,
    originatingTo: turn.queued.originatingTo,
    originatingThreadId: turn.queued.originatingThreadId,
  };
  if (execution.outcome.kind === "rejected") {
    if (!isInteractive) {
      return { kind: "suppress", reason: "silent" };
    }
    if (
      sourcePolicy.sourceReplyDeliveryMode === "message_tool_only" &&
      getReplyPayloadMetadata(execution.outcome.payload)?.deliverDespiteSourceReplySuppression !==
        true
    ) {
      return { kind: "suppress", reason: "message-tool-only" };
    }
    const payloads = renderFailurePayloads(
      resolveFollowupDeliveryPayloads({
        ...deliveryContext,
        payloads: [execution.outcome.payload],
        reasoningPayloadsEnabled: opts?.reasoningPayloadsEnabled === true,
        commentaryPayloadsEnabled: opts?.commentaryPayloadsEnabled === true,
      }),
    );
    return payloads.length > 0
      ? {
          kind: "deliver",
          payloads,
          resolved: execution.outcome.resolved,
        }
      : { kind: "suppress", reason: "silent" };
  }
  if (!accounting) {
    return { kind: "suppress", reason: "silent" };
  }
  const runtimeResolved = {
    provider: accounting.providerUsed,
    model: accounting.modelUsed,
  };
  const result = execution.outcome.result;
  const completedSourceDelivery = hasCompletedSourceReplyDeliveryEvidence(result);
  const assistantFinalText = normalizeAssistantFinalDeliveryText(
    typeof result.meta?.finalAssistantVisibleText === "string"
      ? result.meta.finalAssistantVisibleText
      : "",
  );
  let payloads = resolveFollowupDeliveryPayloads({
    ...deliveryContext,
    payloads: accounting.payloadArray,
    reasoningPayloadsEnabled: opts?.reasoningPayloadsEnabled === true,
    commentaryPayloadsEnabled: opts?.commentaryPayloadsEnabled === true,
    sentMediaUrls: result.messagingToolSentMediaUrls,
    sentTargets: result.messagingToolSentTargets,
    sentTexts: result.messagingToolSentTexts,
  });
  const hasExplicitlyDeliverablePayload = payloads.some(
    (payload) => getReplyPayloadMetadata(payload)?.deliverDespiteSourceReplySuppression === true,
  );
  const recovery =
    hasExplicitlyDeliverablePayload || accounting.terminalFailurePayload
      ? ({ kind: "none" } as const)
      : resolveStrandedReplyRecovery({
          base: turn.queued,
          finalText: assistantFinalText,
          sourceReplyDeliveryMode: sourcePolicy.sourceReplyDeliveryMode,
          sendPolicyDenied: sourcePolicy.sendPolicyDenied,
          successfulSourceReplyDelivery: completedSourceDelivery,
          isHeartbeat: opts?.isHeartbeat === true,
          isRoomEvent: false,
        });
  if (recovery.kind === "retry") {
    return {
      kind: "retry-source-delivery",
      run: recovery.run,
      finalTextLength: assistantFinalText.trim().length,
      resolved: runtimeResolved,
    };
  }
  if (recovery.kind === "diagnostic") {
    const [payload] = resolveFollowupDeliveryPayloads({
      ...deliveryContext,
      payloads: [recovery.payload],
    });
    if (!payload) {
      return { kind: "suppress", reason: "silent" };
    }
    return {
      kind: "deliver-diagnostic",
      payload,
      resolved: runtimeResolved,
    };
  }
  const fallbackPayload = accounting.terminalFailurePayload
    ? isInteractive && !hasCompletedTerminalDeliveryEvidence(result)
      ? sourcePolicy.sourceReplyDeliveryMode === "message_tool_only"
        ? markReplyPayloadForSourceSuppressionDelivery(accounting.terminalFailurePayload)
        : accounting.terminalFailurePayload
      : undefined
    : (buildSessionsYieldAcknowledgmentPayload({
        yielded: result.meta?.yielded === true,
        yieldAcknowledgment: result.meta?.yieldAcknowledgment,
        isInteractive,
        isHeartbeat: opts?.isHeartbeat,
        silentExpected: turn.queued.run.silentExpected,
        isSubagentSession:
          turn.session.kind === "session" && isSubagentSessionKey(turn.session.key),
        hasExplicitSilentReply: hasDeliberateSilentTerminalReply(result),
        // Child spawns are side effects, not user-visible messages. They must not
        // suppress the explicit waiting reply for the parent turn.
        hasVisibleMessageDelivery:
          hasCommittedSourceReplyDeliveryEvidence(result) ||
          hasVisibleCommittedMessagingToolDeliveryEvidence(result) ||
          result.didSendDeterministicApprovalPrompt === true,
      }) ??
      buildEmptyInteractiveReplyPayload({
        isInteractive,
        isHeartbeat: opts?.isHeartbeat,
        silentExpected: turn.queued.run.silentExpected,
        allowEmptyAssistantReplyAsSilent: turn.queued.run.allowEmptyAssistantReplyAsSilent,
        hasPendingContinuation:
          result.meta?.yielded === true || (result.meta?.pendingToolCalls?.length ?? 0) > 0,
        hasExplicitSilentReply: hasDeliberateSilentTerminalReply(result),
        hasCommittedDelivery: hasCompletedTerminalDeliveryEvidence(result),
        hasIntentionalTerminalCompletion: hasIntentionalTerminalCompletion(result),
        sessionCtx: {
          ChatType: turn.queued.originatingChatType,
          Provider: turn.queued.run.messageProvider,
          SessionKey: turn.session.kind === "session" ? turn.session.key : undefined,
          Surface: turn.queued.originatingChannel,
        },
        cfg: turn.config,
      }));
  const hasTerminalPayload = payloads.some(
    (payload) =>
      isReplyPayloadTerminalContent(payload) &&
      (sourcePolicy.sourceReplyDeliveryMode !== "message_tool_only" ||
        getReplyPayloadMetadata(payload)?.deliverDespiteSourceReplySuppression === true),
  );
  if (!hasTerminalPayload && fallbackPayload) {
    payloads = [
      ...payloads,
      ...resolveFollowupDeliveryPayloads({
        ...deliveryContext,
        payloads: [fallbackPayload],
      }),
    ];
  }
  if (accounting.compactionNotice) {
    const compactionNotices = resolveFollowupDeliveryPayloads({
      ...deliveryContext,
      payloads: [accounting.compactionNotice],
    });
    payloads = [...compactionNotices, ...payloads];
  }
  const responseUsageLine = resolveResponseUsageLine({
    config: turn.config,
    agentDir: turn.queued.run.agentDir,
    sessionRaw: turn.session.current()?.responseUsage,
    channel: resolveOriginMessageProvider({
      originatingChannel: turn.queued.originatingChannel,
      provider: turn.queued.run.messageProvider,
    }),
    usage: accounting.usage,
    provider: accounting.providerUsed,
    model: accounting.modelUsed,
    preserveUserFacingSessionState: accounting.preserveUserFacingSessionState,
    replyUsageState: accounting.replyUsageState,
  });
  if (responseUsageLine) {
    payloads = appendUsageLine(payloads, responseUsageLine);
  }
  payloads = renderFailurePayloads(payloads);
  if (sourcePolicy.sourceReplyDeliveryMode === "message_tool_only") {
    const explicitlyDeliverable = payloads.filter(
      (payload) => getReplyPayloadMetadata(payload)?.deliverDespiteSourceReplySuppression === true,
    );
    return explicitlyDeliverable.length > 0
      ? { kind: "deliver", payloads: explicitlyDeliverable, resolved: runtimeResolved }
      : { kind: "suppress", reason: "message-tool-only" };
  }
  return payloads.length > 0
    ? { kind: "deliver", payloads, resolved: runtimeResolved }
    : { kind: "suppress", reason: "silent" };
}

async function sendFollowupPayloads(params: {
  payloads: ReplyPayload[];
  turn: AdmittedFollowupTurn;
  defaults: FollowupRunnerParams;
  runId: string;
  kind: ReplyDispatchKind;
  mirror?: boolean;
  resolved?: { provider: string; model: string };
}): Promise<void> {
  const { turn, defaults } = params;
  const { originatingChannel, originatingTo } = turn.queued;
  const originRoutable = Boolean(isRoutableChannel(originatingChannel) && originatingTo);
  const deliveryPlan = buildAgentRuntimeDeliveryPlan({
    provider: params.resolved?.provider ?? turn.queued.run.provider,
    modelId: params.resolved?.model ?? turn.queued.run.model,
    config: turn.config,
    workspaceDir: turn.queued.run.workspaceDir,
    agentDir: turn.queued.run.agentDir,
  });
  const payloads = params.payloads.filter(
    (payload) =>
      hasOutboundReplyContent(payload) &&
      (!deliveryPlan.isSilentPayload(payload) ||
        getReplyPayloadMetadata(payload)?.deliverDespiteSourceReplySuppression === true),
  );
  if (payloads.length === 0) {
    return;
  }
  const sourceDisposition = turn.queued.queuedFollowupReplyDisposition;
  if (sourceDisposition?.kind === "drop") {
    logVerbose(`followup queue: source delivery dropped (${sourceDisposition.reason})`);
    return;
  }
  const deliverQueuedBatch = sourceDisposition?.deliver;
  const fallbackDispatcher = sourceDisposition ? undefined : defaults.opts?.onBlockReply;
  const dispatcherAvailable = Boolean(deliverQueuedBatch || fallbackDispatcher);
  if (!originRoutable && !dispatcherAvailable) {
    defaultRuntime.error?.(
      "followup queue: completed with payloads but no origin route or visible dispatcher is available",
    );
    return;
  }
  const typing = createTypingSignaler({
    typing: defaults.typing,
    mode: defaults.typingMode,
    isHeartbeat: defaults.opts?.isHeartbeat === true,
  });
  const crossChannelFailures: ReplyPayload[] = [];
  const queuedPayloads: ReplyPayload[] = [];
  const dispatchPayload = async (payload: ReplyPayload) => {
    if (deliverQueuedBatch) {
      queuedPayloads.push(payload);
    } else {
      await fallbackDispatcher?.(payload);
    }
  };
  let deliveredCrossChannelOrigin = false;
  const provider = resolveOriginMessageProvider({
    provider: turn.queued.run.messageProvider,
  });
  const origin = resolveOriginMessageProvider({ originatingChannel });
  const sameChannelOrigin = Boolean(origin && origin === provider);
  const crossChannelOrigin = Boolean(origin && provider && origin !== provider);
  for (const payload of payloads) {
    const providerRoute = deliveryPlan.resolveFollowupRoute({
      payload,
      originatingChannel,
      originatingTo,
      originRoutable,
      dispatcherAvailable,
    });
    if (providerRoute?.route === "drop") {
      continue;
    }
    const route =
      providerRoute?.route === "origin" && originRoutable
        ? "origin"
        : providerRoute?.route === "dispatcher" && dispatcherAvailable
          ? "dispatcher"
          : originRoutable
            ? "origin"
            : "dispatcher";
    await typing.signalTextDelta(payload.text);
    if (route !== "origin") {
      await dispatchPayload(payload);
    } else if (isRoutableChannel(originatingChannel) && originatingTo) {
      const metadata = getReplyPayloadMetadata(payload);
      const result = await routeReply({
        payload,
        channel: originatingChannel,
        to: originatingTo,
        sessionKey: turn.queued.run.sessionKey,
        accountId: turn.queued.originatingAccountId,
        requesterSenderId: turn.queued.run.senderId,
        requesterSenderName: turn.queued.run.senderName,
        requesterSenderUsername: turn.queued.run.senderUsername,
        requesterSenderE164: turn.queued.run.senderE164,
        threadId: turn.queued.originatingThreadId,
        cfg: turn.config,
        mirror:
          metadata?.assistantMessageIndex !== undefined ||
          metadata?.assistantTranscriptOwned === true
            ? false
            : params.mirror,
        replyKind: params.kind,
        runId: params.runId,
      });
      if (!result.delivered && !result.suppressed) {
        const routeError = result.error ?? "no visible delivery";
        logVerbose(`followup queue: route-reply failed: ${routeError}`);
        if (sameChannelOrigin && dispatcherAvailable) {
          await dispatchPayload(payload);
        } else if (dispatcherAvailable) {
          crossChannelFailures.push(payload);
        } else {
          defaultRuntime.error?.(`followup queue: route-reply failed: ${routeError}`);
        }
      } else if (result.delivered) {
        if (!result.ok) {
          logVerbose(
            `followup queue: route-reply partially failed after delivery: ${
              result.error ?? "unknown error"
            }`,
          );
        }
        deliveredCrossChannelOrigin ||= crossChannelOrigin;
      }
    }
  }
  // A delivered supplement cannot settle missing terminal content, while a
  // delivered terminal reply does settle failures of later supplements.
  const terminalFailure = crossChannelFailures.some(isReplyPayloadTerminalContent);
  if (
    (terminalFailure || (crossChannelFailures.length > 0 && !deliveredCrossChannelOrigin)) &&
    dispatcherAvailable
  ) {
    await dispatchPayload({
      text:
        "Follow-up completed, but OpenClaw could not deliver it to the originating channel. " +
        "The reply content was not forwarded to this channel to avoid cross-channel misdelivery.",
      isError: true,
    });
  }
  if (queuedPayloads.length > 0) {
    await deliverQueuedBatch?.({
      kind: "queued-followup",
      runId: params.runId,
      originatingChannel,
      payloads: queuedPayloads,
    });
  }
}

/** Performs the already-resolved follow-up delivery action. */
export async function deliverFollowupDecision(params: {
  decision: FollowupDeliveryDecision;
  turn: AdmittedFollowupTurn;
  defaults: FollowupRunnerParams;
  runId: string;
  runFollowup: (run: FollowupRun) => Promise<void>;
  kind?: ReplyDispatchKind;
}): Promise<void> {
  const { decision, turn, defaults } = params;
  if (decision.kind === "suppress") {
    logVerbose(`followup queue: delivery suppressed (${decision.reason})`);
    return;
  }
  if (decision.kind === "retry-source-delivery") {
    warnPrivateMessageToolFinal({
      sessionKey: turn.session.kind === "session" ? turn.session.key : undefined,
      channel:
        turn.queued.originatingChannel ??
        turn.queued.run.messageProvider ??
        sessionDeliveryChannel(turn.session.current()),
      finalTextLength: decision.finalTextLength,
    });
    const key = turn.session.kind === "session" ? turn.session.key : turn.queued.run.sessionKey;
    const enqueued =
      key &&
      enqueueFollowupRun(
        key,
        decision.run,
        resolveQueueSettings({
          cfg: turn.config,
          channel: turn.queued.originatingChannel ?? turn.queued.run.messageProvider,
          sessionEntry: turn.session.current(),
        }),
        "none",
        params.runFollowup,
        false,
        { position: "front" },
      );
    if (enqueued) {
      return;
    }
    const diagnosticPayloads = resolveFollowupDeliveryPayloads({
      cfg: turn.config,
      payloads: [buildStrandedReplyDeliveryFailurePayload()],
      messageProvider: turn.queued.run.messageProvider,
      originatingAccountId: turn.queued.originatingAccountId ?? turn.queued.run.agentAccountId,
      originatingChannel: turn.queued.originatingChannel,
      originatingChatType: turn.queued.originatingChatType,
      originatingReplyToMode: turn.queued.originatingReplyToMode,
      originatingTo: turn.queued.originatingTo,
      originatingThreadId: turn.queued.originatingThreadId,
    });
    await sendFollowupPayloads({
      payloads: diagnosticPayloads,
      turn,
      defaults,
      runId: params.runId,
      kind: params.kind ?? "final",
      resolved: decision.resolved,
    });
    return;
  }
  await sendFollowupPayloads({
    payloads: decision.kind === "deliver" ? decision.payloads : [decision.payload],
    turn,
    defaults,
    runId: params.runId,
    kind: params.kind ?? "final",
    mirror: params.kind && params.kind !== "final" ? false : undefined,
    resolved: decision.resolved,
  });
}
