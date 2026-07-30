/** Prepares queued follow-up payloads for source-channel delivery. */
import crypto from "node:crypto";
import { hasOutboundReplyContent } from "openclaw/plugin-sdk/reply-payload";
import {
  hasCommittedSourceReplyDeliveryEvidence,
  hasCompletedSourceReplyDeliveryEvidence,
  hasCompletedTerminalDeliveryEvidence,
  hasVisibleOutboundDeliveryEvidence,
} from "../../agents/embedded-agent-runner/delivery-evidence.js";
import { hasDeliberateSilentTerminalReply } from "../../agents/embedded-agent-runner/result-fallback-classifier.js";
import { buildAgentRuntimeDeliveryPlan } from "../../agents/runtime-plan/build.js";
import { logVerbose } from "../../globals.js";
import { defaultRuntime } from "../../runtime.js";
import { sessionDeliveryChannel } from "../../utils/delivery-context.shared.js";
import { isInternalMessageChannel } from "../../utils/message-channel.js";
import {
  getReplyPayloadMetadata,
  isReplyPayloadStatusNotice,
  markOperationalReplyPayloadForSourceSuppressionDelivery,
  markReplyPayloadForSourceSuppressionDelivery,
  setReplyPayloadMetadata,
} from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import { normalizeAssistantFinalDeliveryText } from "./agent-runner-core.js";
import type { AgentTurnExecutionResult } from "./agent-runner-execution.types.js";
import { buildEmptyInteractiveReplyPayload } from "./agent-runner-failure-reply.js";
import type { AccountedAgentTurn } from "./agent-runner-result-accounting.js";
import { appendUsageLine, resolveResponseUsageLine } from "./agent-runner-usage-line.js";
import { resolveFollowupDeliveryPayloads } from "./followup-delivery-payloads.js";
import type { AdmittedFollowupTurn, FollowupRunnerParams } from "./followup-turn-admission.js";
import type { InternalGetReplyOptions } from "./get-reply.types.js";
import {
  applyOperationalReplyPolicy,
  isOperationalReplyPayload,
  markOperationalReplyPolicyDelivered,
  resolveOperationalReplyPolicy,
} from "./operational-reply-policy.js";
import { resolveOriginMessageProvider } from "./origin-routing.js";
import { warnPrivateMessageToolFinal } from "./private-message-tool-final.js";
import {
  enqueueFollowupRun,
  isFollowupRunAborted,
  resolveFollowupAbortSignal,
  resolveQueueSettings,
  type FollowupRun,
} from "./queue.js";
import type { ReplyDispatchKind } from "./reply-dispatcher.types.js";
import { isRoutableChannel, routeReply } from "./route-reply.js";
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

function resolveFollowupOperationalReplySourceEventKey(params: {
  queued: FollowupRun;
  runId?: string;
}): string {
  const sourceMessageKey =
    params.queued.messageId ?? params.queued.originatingReplyToId ?? params.runId;
  if (sourceMessageKey) {
    return sourceMessageKey;
  }
  // One queued event may cross progress/final lanes, so its redirect key must
  // stay stable across lanes but differ from later events in the same session.
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        enqueuedAt: params.queued.enqueuedAt,
        prompt: params.queued.prompt,
        sessionId: params.queued.run.sessionId,
      }),
    )
    .digest("hex");
}

function filterRoomEventOperationalPayloads(params: {
  payloads: ReplyPayload[];
  turn: AdmittedFollowupTurn;
}): ReplyPayload[] {
  if (params.turn.queued.currentInboundEventKind !== "room_event") {
    return params.payloads;
  }
  const policy = resolveOperationalReplyPolicy(params.turn.config).policy;
  return params.payloads.filter((payload) => {
    const commandReply = getReplyPayloadMetadata(payload)?.commandReply === true;
    return (
      commandReply ||
      ((policy === "redirect" || policy === "silent") &&
        isOperationalReplyPayload({ payload, explicitCommandTurn: commandReply }))
    );
  });
}

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
    execution.outcome.kind === "aborted" ||
    (execution.outcome.kind === "settled" && execution.outcome.abortReason)
  ) {
    return { kind: "suppress", reason: "aborted" };
  }
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
  if (execution.outcome.kind === "rejected") {
    if (!isInteractive) {
      return { kind: "suppress", reason: "silent" };
    }
    if (
      sourcePolicy.sourceReplyDeliveryMode === "message_tool_only" &&
      getReplyPayloadMetadata(execution.outcome.payload)?.deliverDespiteSourceReplySuppression !==
        true &&
      !(
        ["redirect", "silent"].includes(resolveOperationalReplyPolicy(turn.config).policy) &&
        isOperationalReplyPayload({
          payload: execution.outcome.payload,
          explicitCommandTurn: false,
        })
      )
    ) {
      return { kind: "suppress", reason: "message-tool-only" };
    }
    const payloads = filterRoomEventOperationalPayloads({
      turn,
      payloads: resolveFollowupDeliveryPayloads({
        cfg: turn.config,
        payloads: [execution.outcome.payload],
        messageProvider: turn.queued.run.messageProvider,
        originatingAccountId: turn.queued.originatingAccountId ?? turn.queued.run.agentAccountId,
        originatingChannel: turn.queued.originatingChannel,
        originatingChatType: turn.queued.originatingChatType,
        originatingReplyToMode: turn.queued.originatingReplyToMode,
        originatingTo: turn.queued.originatingTo,
        originatingThreadId: turn.queued.originatingThreadId,
        reasoningPayloadsEnabled: opts?.reasoningPayloadsEnabled === true,
        commentaryPayloadsEnabled: opts?.commentaryPayloadsEnabled === true,
      }),
    });
    return payloads.length > 0
      ? {
          kind: "deliver",
          payloads,
          resolved: execution.outcome.resolved,
        }
      : { kind: "suppress", reason: "silent" };
  }
  if (!accounting) {
    return {
      kind: "suppress",
      reason: turn.queued.currentInboundEventKind === "room_event" ? "room-event" : "silent",
    };
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
    cfg: turn.config,
    payloads: accounting.payloadArray,
    messageProvider: turn.queued.run.messageProvider,
    originatingAccountId: turn.queued.originatingAccountId ?? turn.queued.run.agentAccountId,
    originatingChannel: turn.queued.originatingChannel,
    originatingChatType: turn.queued.originatingChatType,
    originatingReplyToMode: turn.queued.originatingReplyToMode,
    originatingTo: turn.queued.originatingTo,
    originatingThreadId: turn.queued.originatingThreadId,
    reasoningPayloadsEnabled: opts?.reasoningPayloadsEnabled === true,
    commentaryPayloadsEnabled: opts?.commentaryPayloadsEnabled === true,
    sentMediaUrls: result.messagingToolSentMediaUrls,
    sentTargets: result.messagingToolSentTargets,
    sentTexts: result.messagingToolSentTexts,
  });
  if (result.meta?.error?.kind === "hook_block") {
    payloads = payloads.map((payload) =>
      setReplyPayloadMetadata(payload, { beforeAgentRunBlocked: true }),
    );
  }
  payloads = filterRoomEventOperationalPayloads({ payloads, turn });
  const operationalPolicy = resolveOperationalReplyPolicy(turn.config).policy;
  const hasExplicitlyDeliverablePayload = payloads.some(
    (payload) =>
      getReplyPayloadMetadata(payload)?.deliverDespiteSourceReplySuppression === true ||
      ((operationalPolicy === "redirect" || operationalPolicy === "silent") &&
        isOperationalReplyPayload({ payload, explicitCommandTurn: false })),
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
          isRoomEvent: turn.queued.currentInboundEventKind === "room_event",
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
      cfg: turn.config,
      payloads: [recovery.payload],
      messageProvider: turn.queued.run.messageProvider,
      originatingAccountId: turn.queued.originatingAccountId ?? turn.queued.run.agentAccountId,
      originatingChannel: turn.queued.originatingChannel,
      originatingChatType: turn.queued.originatingChatType,
      originatingReplyToMode: turn.queued.originatingReplyToMode,
      originatingTo: turn.queued.originatingTo,
      originatingThreadId: turn.queued.originatingThreadId,
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
  const hasCommittedDelivery =
    hasVisibleOutboundDeliveryEvidence(result) ||
    hasCommittedSourceReplyDeliveryEvidence(result) ||
    result.didSendDeterministicApprovalPrompt === true;
  const fallbackPayload = accounting.terminalFailurePayload
    ? isInteractive && !hasCompletedTerminalDeliveryEvidence(result)
      ? sourcePolicy.sourceReplyDeliveryMode === "message_tool_only"
        ? markReplyPayloadForSourceSuppressionDelivery(accounting.terminalFailurePayload)
        : accounting.terminalFailurePayload
      : undefined
    : buildEmptyInteractiveReplyPayload({
        isInteractive,
        isHeartbeat: opts?.isHeartbeat,
        silentExpected: turn.queued.run.silentExpected,
        allowEmptyAssistantReplyAsSilent: turn.queued.run.allowEmptyAssistantReplyAsSilent,
        isMessageToolOnly: sourcePolicy.sourceReplyDeliveryMode === "message_tool_only",
        hasPendingContinuation:
          result.meta?.yielded === true || (result.meta?.pendingToolCalls?.length ?? 0) > 0,
        hasExplicitSilentReply: hasDeliberateSilentTerminalReply(result),
        hasCommittedDelivery,
        sessionCtx: {
          ChatType: turn.queued.originatingChatType,
          Provider: turn.queued.run.messageProvider,
          SessionKey: turn.session.kind === "session" ? turn.session.key : undefined,
          Surface: turn.queued.originatingChannel,
        },
        cfg: turn.config,
      });
  const hasTerminalPayload = payloads.some(
    (payload) =>
      payload.isReasoning !== true &&
      payload.isCommentary !== true &&
      !isReplyPayloadStatusNotice(payload) &&
      (sourcePolicy.sourceReplyDeliveryMode !== "message_tool_only" ||
        getReplyPayloadMetadata(payload)?.deliverDespiteSourceReplySuppression === true),
  );
  if (!hasTerminalPayload && fallbackPayload) {
    payloads = [
      ...payloads,
      ...resolveFollowupDeliveryPayloads({
        cfg: turn.config,
        payloads: [fallbackPayload],
        messageProvider: turn.queued.run.messageProvider,
        originatingAccountId: turn.queued.originatingAccountId ?? turn.queued.run.agentAccountId,
        originatingChannel: turn.queued.originatingChannel,
        originatingChatType: turn.queued.originatingChatType,
        originatingReplyToMode: turn.queued.originatingReplyToMode,
        originatingTo: turn.queued.originatingTo,
        originatingThreadId: turn.queued.originatingThreadId,
      }),
    ];
  }
  if (accounting.compactionNotice) {
    const compactionNotices = resolveFollowupDeliveryPayloads({
      cfg: turn.config,
      payloads: [
        markOperationalReplyPayloadForSourceSuppressionDelivery(accounting.compactionNotice),
      ],
      messageProvider: turn.queued.run.messageProvider,
      originatingAccountId: turn.queued.originatingAccountId ?? turn.queued.run.agentAccountId,
      originatingChannel: turn.queued.originatingChannel,
      originatingChatType: turn.queued.originatingChatType,
      originatingReplyToMode: turn.queued.originatingReplyToMode,
      originatingTo: turn.queued.originatingTo,
      originatingThreadId: turn.queued.originatingThreadId,
    });
    payloads = [...compactionNotices, ...payloads];
  }
  const responseUsageLine = resolveResponseUsageLine({
    config: turn.config,
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
  // Compaction and fallback payloads are assembled after the initial room-event
  // filter. Reapply it so only explicit command replies or policy-owned notices
  // can reach an ambient group turn.
  payloads = filterRoomEventOperationalPayloads({ payloads, turn });
  if (payloads.length === 0 && turn.queued.currentInboundEventKind === "room_event") {
    return { kind: "suppress", reason: "room-event" };
  }
  if (sourcePolicy.sourceReplyDeliveryMode === "message_tool_only") {
    const explicitlyDeliverable = payloads.filter(
      (payload) =>
        getReplyPayloadMetadata(payload)?.deliverDespiteSourceReplySuppression === true ||
        ((operationalPolicy === "redirect" || operationalPolicy === "silent") &&
          isOperationalReplyPayload({ payload, explicitCommandTurn: false })),
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
  const typing = createTypingSignaler({
    typing: defaults.typing,
    mode: defaults.typingMode,
    isHeartbeat: defaults.opts?.isHeartbeat === true,
  });
  const applyFollowupPayloadPolicy = async (payload: ReplyPayload) =>
    await applyOperationalReplyPolicy({
      abortSignal: resolveFollowupAbortSignal(turn.queued),
      cfg: turn.config,
      payload,
      // commandReply is host-owned metadata. Queued follow-ups no longer carry
      // the original command context, so this marker preserves its exemption.
      explicitCommandTurn: getReplyPayloadMetadata(payload)?.commandReply === true,
      sendPolicyDenied: turn.sendPolicy === "deny",
      sourceSessionKey:
        turn.queued.run.runtimePolicySessionKey ??
        turn.queued.run.sessionKey ??
        (turn.session.kind === "session" ? turn.session.key : undefined),
      sourceStorePath: turn.session.kind === "session" ? turn.session.storePath : undefined,
      sourceEventKey: resolveFollowupOperationalReplySourceEventKey({
        queued: turn.queued,
        runId: params.runId,
      }),
      sourceChannel: turn.queued.originatingChannel ?? turn.queued.run.messageProvider,
      sourceConversationKey: JSON.stringify({
        accountId: turn.queued.originatingAccountId ?? turn.queued.run.agentAccountId,
        channel: turn.queued.originatingChannel ?? turn.queued.run.messageProvider,
        threadId: turn.queued.originatingThreadId,
        to: turn.queued.originatingTo,
      }),
      provider: turn.queued.run.messageProvider,
      surface: turn.queued.originatingChannel,
      chatType: turn.queued.originatingChatType ?? turn.queued.run.chatType,
      inboundEventKind: turn.queued.currentInboundEventKind,
      messageKey: turn.queued.messageId,
      logPrefix: "followup queue",
    });
  let crossChannelFailure = false;
  let deliveredCrossChannelOrigin = false;
  for (const payload of payloads) {
    // Redirect policy writes to another session, so cancellation must win
    // before policy evaluation performs that side effect.
    if (isFollowupRunAborted(turn.queued)) {
      continue;
    }
    if (!originRoutable && !defaults.opts?.onBlockReply) {
      const policyResult = await applyFollowupPayloadPolicy(payload);
      if (policyResult.shouldDeliver) {
        await markOperationalReplyPolicyDelivered(policyResult, false);
        defaultRuntime.error?.(
          "followup queue: completed with payloads but no origin route or visible dispatcher is available",
        );
      }
      continue;
    }
    const providerRoute = deliveryPlan.resolveFollowupRoute({
      payload,
      originatingChannel,
      originatingTo,
      originRoutable,
      dispatcherAvailable: Boolean(defaults.opts?.onBlockReply),
    });
    if (providerRoute?.route === "drop") {
      continue;
    }
    const route =
      providerRoute?.route === "origin" && originRoutable
        ? "origin"
        : providerRoute?.route === "dispatcher" && defaults.opts?.onBlockReply
          ? "dispatcher"
          : originRoutable
            ? "origin"
            : "dispatcher";
    if (route !== "origin") {
      await typing.signalTextDelta(payload.text);
      // The dispatcher applies and settles operational policy for this path.
      await defaults.opts?.onBlockReply?.(payload);
    } else if (isRoutableChannel(originatingChannel) && originatingTo) {
      const policyResult = await applyFollowupPayloadPolicy(payload);
      if (!policyResult.shouldDeliver) {
        continue;
      }
      if (isFollowupRunAborted(turn.queued)) {
        await markOperationalReplyPolicyDelivered(policyResult, false);
        continue;
      }
      let policySettled = false;
      const settleOperationalPolicy = async (delivered: boolean) => {
        policySettled = true;
        await markOperationalReplyPolicyDelivered(policyResult, delivered);
      };
      const metadata = getReplyPayloadMetadata(payload);
      try {
        await typing.signalTextDelta(payload.text);
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
          const provider = resolveOriginMessageProvider({
            provider: turn.queued.run.messageProvider,
          });
          const origin = resolveOriginMessageProvider({ originatingChannel });
          if (origin && origin === provider && defaults.opts?.onBlockReply) {
            await settleOperationalPolicy(false);
            // Release any `once` reservation before the dispatcher applies policy.
            await defaults.opts.onBlockReply(payload);
          } else {
            crossChannelFailure = true;
            if (!defaults.opts?.onBlockReply) {
              defaultRuntime.error?.(`followup queue: route-reply failed: ${routeError}`);
            }
          }
        } else if (result.delivered) {
          await settleOperationalPolicy(true);
          if (!result.ok) {
            logVerbose(
              `followup queue: route-reply partially failed after delivery: ${
                result.error ?? "unknown error"
              }`,
            );
          }
          const provider = resolveOriginMessageProvider({
            provider: turn.queued.run.messageProvider,
          });
          const origin = resolveOriginMessageProvider({ originatingChannel });
          deliveredCrossChannelOrigin ||= Boolean(origin && provider && origin !== provider);
        }
      } finally {
        if (!policySettled) {
          await settleOperationalPolicy(false);
        }
      }
    }
  }
  if (crossChannelFailure && !deliveredCrossChannelOrigin) {
    const routeFailureNotice = markOperationalReplyPayloadForSourceSuppressionDelivery({
      text:
        "Follow-up completed, but OpenClaw could not deliver it to the originating channel. " +
        "The reply content was not forwarded to this channel to avoid cross-channel misdelivery.",
      isError: true,
    });
    if (defaults.opts?.onBlockReply) {
      // The dispatcher applies and settles operational policy for this fallback.
      await defaults.opts.onBlockReply(routeFailureNotice);
    } else {
      const policyResult = await applyFollowupPayloadPolicy(routeFailureNotice);
      await markOperationalReplyPolicyDelivered(policyResult, false);
    }
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
