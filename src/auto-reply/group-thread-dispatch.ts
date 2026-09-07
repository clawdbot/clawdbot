import { normalizeChatType } from "../channels/chat-type.js";
import {
  readAgentRunTerminalOutcome,
  recordAgentRunTerminalOutcome,
} from "../channels/turn/agent-run-terminal-outcome.js";
import { buildAgentSessionKey } from "../routing/resolve-route.js";
import {
  DEFAULT_ACCOUNT_ID,
  isAcpSessionKey,
  normalizeAccountId,
  resolveThreadSessionKeys,
} from "../routing/session-key.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel-constants.js";
import { withReplyDispatcher } from "./dispatch-dispatcher.js";
import { resolveGroupThreadConfig } from "./group-thread-config.js";
import {
  adoptGroupThreadRoot,
  bindGroupThreadDispatchContext,
  getGroupThreadTurn,
  recordGroupThreadReply,
} from "./group-thread-context.js";
import { runGroupThread } from "./group-thread.js";
import { resolveBoundAcpDispatchSessionKey } from "./reply/dispatch-from-config.context.js";
import type {
  DispatchFromConfigParams,
  DispatchFromConfigResult,
  DispatchReplyFromConfig,
} from "./reply/dispatch-from-config.types.js";
import { finalizeInboundContext } from "./reply/inbound-context.js";
import { REPLY_ADMISSION_TICKET } from "./reply/reply-admission-ticket.js";
import {
  createReplyDispatchSettledCounts,
  REPLY_DISPATCH_OUTCOME_COUNTS,
} from "./reply/reply-dispatch-outcome.js";
import { captureReplyDispatchDeliveryOutcome } from "./reply/reply-dispatcher.js";
import {
  mapReplyDispatchCounts,
  type ReplyDispatchKind,
  type ReplyDispatcher,
} from "./reply/reply-dispatcher.types.js";
import { REPLY_OPERATION_RUN_STATE } from "./reply/reply-operation-run-state.js";
import { buildChannelSourceTurnId, setChannelSourceTurnId } from "./reply/source-turn-id.js";
import { withReplySystemEventContext } from "./reply/system-event-session-key.js";
import type { FinalizedMsgContext } from "./templating.js";
import type { ReplyPayload } from "./types.js";

function participantDispatcher(parent: ReplyDispatcher): ReplyDispatcher {
  const queued = { tool: 0, block: 0, final: 0 };
  const counts = {
    tool: createReplyDispatchSettledCounts(),
    block: createReplyDispatchSettledCounts(),
    final: createReplyDispatchSettledCounts(),
  };
  const pending: Promise<void>[] = [];
  const send = (kind: ReplyDispatchKind, payload: ReplyPayload) => {
    const outcome = captureReplyDispatchDeliveryOutcome(payload);
    const accepted =
      kind === "tool"
        ? parent.sendToolResult(payload)
        : kind === "block"
          ? parent.sendBlockReply(payload)
          : parent.sendFinalReply(payload);
    if (accepted) {
      queued[kind]++;
    }
    if (outcome.isTracked()) {
      pending.push(
        outcome.promise.then((result) => {
          counts[kind][REPLY_DISPATCH_OUTCOME_COUNTS[result]]++;
          if (kind === "final" && result === "delivered") {
            recordGroupThreadReply(outcome.getDeliveredPayload() ?? payload);
          }
        }),
      );
    } else if (accepted) {
      counts[kind].delivered++;
      if (kind === "final") {
        recordGroupThreadReply(payload);
      }
    }
    return accepted;
  };
  return {
    prepareReplyPayload: parent.prepareReplyPayload,
    sendToolResult: (payload) => send("tool", payload),
    sendBlockReply: (payload) => send("block", payload),
    sendFinalReply: (payload) => send("final", payload),
    supportsSettledReceipt: true,
    waitForIdle: async () => {
      await Promise.all(pending);
      return {
        counts,
        anyVisibleDelivered: Object.values(counts).some((value) => value.delivered > 0),
      };
    },
    getQueuedCounts: () => ({ ...queued }),
    getCancelledCounts: () => mapReplyDispatchCounts(counts, (value) => value.cancelled),
    getFailedCounts: () =>
      mapReplyDispatchCounts(counts, (value) => value.failedBeforeSend + value.failedAfterSend),
    // The physical channel dispatcher belongs to the root, not an individual participant.
    markComplete: () => {},
  };
}

function prepareParticipant(
  params: DispatchFromConfigParams,
  sessionKey: string,
): DispatchFromConfigParams {
  const turn = getGroupThreadTurn();
  if (!turn) {
    return params;
  }
  const original = params.replyOptions;
  const signals = [original?.abortSignal, original?.turnAdoptionLifecycle?.abortSignal].filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  const ctx = finalizeInboundContext({
    ...params.ctx,
    AgentId: turn.agentId,
    SessionKey: sessionKey,
    RuntimePolicySessionKey: sessionKey,
    ParentSessionKey: undefined,
    ModelParentSessionKey: undefined,
    CommandTargetSessionKey: undefined,
    ...(turn.digest
      ? {
          Body: turn.digest,
          BodyForAgent: turn.digest,
          RawBody: turn.digest,
          CommandBody: turn.digest,
          BodyForCommands: "",
          agentText: turn.digest,
          rawText: turn.digest,
          commandText: "",
          CommandTurn: {
            kind: "normal" as const,
            source: "message" as const,
            authorized: false as const,
          },
          CommandInterpretationSuppressed: true,
          MessageSid: turn.messageId,
          MessageSidFull: params.ctx.MessageSidFull ?? params.ctx.MessageSid,
          // Keep transport reply references anchored to the physical inbound message.
          ReplyToId: params.ctx.ReplyToId ?? params.ctx.MessageSid,
          ReplyToIdFull: params.ctx.ReplyToIdFull ?? params.ctx.MessageSidFull,
        }
      : {}),
  });
  if (turn.digest) {
    setChannelSourceTurnId(
      ctx,
      buildChannelSourceTurnId({
        provider: ctx.OriginatingChannel ?? ctx.Provider ?? ctx.Surface,
        accountId: ctx.AccountId,
        conversationId: ctx.OriginatingTo ?? ctx.To ?? ctx.From,
        messageId: turn.messageId,
      }),
    );
  }
  const runState = bindGroupThreadDispatchContext(ctx);
  return {
    ...params,
    ctx,
    dispatcher: participantDispatcher(params.dispatcher),
    replyOptions: withReplySystemEventContext(
      {
        ...original,
        abortSignal: signals.length > 1 ? AbortSignal.any(signals) : signals[0],
        turnAdoptionLifecycle: undefined,
        replyConversation: undefined,
        expectedExistingSessionId: undefined,
        newlyCreatedSessionId: undefined,
        pinExpectedExistingSession: undefined,
        requestedSessionId: undefined,
        resumeRequestedSession: undefined,
        admittedSessionSettings: undefined,
        userTurnTranscriptRecorder: undefined,
        prepareAssistantTranscriptMessage: undefined,
        suppressNextUserMessagePersistence: undefined,
        messageInjectionDisposition: undefined,
        runId: undefined,
        onAgentRunStart: (...args) => {
          runState.runId = args[0];
          runState.executionIdentityToken = args[1];
          return original?.onAgentRunStart?.(...args);
        },
        promptCacheKey: undefined,
        onSessionPrepared: undefined,
        replyOperation: undefined,
        [REPLY_OPERATION_RUN_STATE]: undefined,
        [REPLY_ADMISSION_TICKET]: undefined,
        onQueuedFollowupReplyBatch: undefined,
        onQueuedFollowupAdmitted: undefined,
        onQueuedFollowupSettled: undefined,
        queuedDeliveryCorrelations: undefined,
      },
      { sessionKey },
    ),
  };
}

function resolvePeer(ctx: FinalizedMsgContext, channel: string): string | undefined {
  const canonical = ctx.ConversationRoutePeerId ?? ctx.NativeChannelId;
  if (canonical) {
    return canonical;
  }
  const target = ctx.OriginatingTo ?? ctx.From;
  if (!target) {
    return undefined;
  }
  const unprefixed = target.startsWith(`${channel}:`) ? target.slice(channel.length + 1) : target;
  return unprefixed.replace(/^(?:group|channel):/, "");
}

/** Returns undefined for ordinary single-agent turns, including exclusively bound ACP rooms. */
export async function dispatchGroupThread(
  params: DispatchFromConfigParams,
  dispatch: DispatchReplyFromConfig,
): Promise<DispatchFromConfigResult | undefined> {
  const activeTurn = getGroupThreadTurn();
  if (activeTurn) {
    await adoptGroupThreadRoot(params.replyOptions?.turnAdoptionLifecycle);
    const child = prepareParticipant(params, params.ctx.SessionKey ?? "");
    return withReplyDispatcher({ dispatcher: child.dispatcher, run: () => dispatch(child) });
  }
  const { ctx, cfg } = params;
  if (
    ctx.InternalTurnSource ||
    ctx.Surface === INTERNAL_MESSAGE_CHANNEL ||
    ctx.Provider === INTERNAL_MESSAGE_CHANNEL
  ) {
    return undefined;
  }
  const channel = ctx.OriginatingChannel ?? ctx.Surface ?? ctx.Provider;
  if (!channel || isAcpSessionKey(ctx.SessionKey) || isAcpSessionKey(ctx.CommandTargetSessionKey)) {
    return undefined;
  }
  const peerId = ctx.GroupThread?.peerId ?? resolvePeer(ctx, channel);
  const group =
    ctx.GroupThread?.group ??
    (peerId ? resolveGroupThreadConfig({ cfg, channel, peerId }) : undefined);
  if (!peerId || !group || resolveBoundAcpDispatchSessionKey({ ctx, cfg })) {
    return undefined;
  }
  const accountId = normalizeAccountId(ctx.AccountId);
  const kind = normalizeChatType(ctx.ChatType) ?? "group";
  const signals = [
    params.replyOptions?.abortSignal,
    params.replyOptions?.turnAdoptionLifecycle?.abortSignal,
  ].filter((signal): signal is AbortSignal => signal !== undefined);
  const run = await runGroupThread<DispatchFromConfigResult>({
    cfg,
    group,
    channel,
    accountId,
    peerId,
    threadId: ctx.MessageThreadId,
    messageId: ctx.MessageSid,
    text: ctx.rawText ?? ctx.RawBody ?? ctx.Body ?? "",
    mentionedAgentIds: ctx.GroupThread?.mentionedAgentIds,
    abortSignal: signals.length > 1 ? AbortSignal.any(signals) : signals[0],
    formatReply: params.replyOptions?.groupThreadReplyFormatter,
    runTurn: async (turn) => {
      await adoptGroupThreadRoot(params.replyOptions?.turnAdoptionLifecycle);
      let sessionKey = buildAgentSessionKey({
        agentId: turn.agentId,
        channel,
        accountId,
        peer: { kind, id: peerId },
        dmScope: ctx.DmScope ?? cfg.session?.dmScope,
        identityLinks: cfg.session?.identityLinks,
      });
      if (kind !== "direct" && accountId !== DEFAULT_ACCOUNT_ID) {
        sessionKey = resolveThreadSessionKeys({
          baseSessionKey: sessionKey,
          threadId: `${channel}-account-${accountId}`,
        }).sessionKey;
      }
      sessionKey = resolveThreadSessionKeys({
        baseSessionKey: sessionKey,
        threadId: ctx.MessageThreadId?.toString(),
      }).sessionKey;
      const child = prepareParticipant(params, sessionKey);
      return withReplyDispatcher({ dispatcher: child.dispatcher, run: () => dispatch(child) });
    },
  });
  const all = (test: (result: DispatchFromConfigResult) => boolean) =>
    run.results.length > 0 && run.results.every(test);
  const metadata = run.results.flatMap((result) => result.sessionMetadataChanges ?? []);
  const result: DispatchFromConfigResult = {
    queuedFinal: run.results.some((value) => value.queuedFinal),
    counts: run.results.reduce(
      (counts, value) => ({
        tool: counts.tool + value.counts.tool,
        block: counts.block + value.counts.block,
        final: counts.final + value.counts.final,
      }),
      { tool: 0, block: 0, final: 0 },
    ),
    ...(run.results.some((value) => value.observedReplyDelivery)
      ? { observedReplyDelivery: true }
      : {}),
    ...(all((value) => value.sourceReplyDeliveryMode === "message_tool_only")
      ? { sourceReplyDeliveryMode: "message_tool_only" }
      : {}),
    ...(all((value) => value.deliberateSilentTerminalReply === true)
      ? { deliberateSilentTerminalReply: true }
      : {}),
    ...(all((value) => value.sendPolicyDenied === true) ? { sendPolicyDenied: true } : {}),
    ...(all((value) => value.beforeAgentRunBlocked === true)
      ? { beforeAgentRunBlocked: true }
      : {}),
    ...(metadata.length > 0 ? { sessionMetadataChanges: metadata } : {}),
  };
  if (
    run.failedTurns > 0 ||
    run.results.some((value) => readAgentRunTerminalOutcome(value) === "failed")
  ) {
    recordAgentRunTerminalOutcome(result, "failed");
  } else if (run.results.some((value) => readAgentRunTerminalOutcome(value) === "completed")) {
    recordAgentRunTerminalOutcome(result, "completed");
  }
  return result;
}
