// Slack plugin module implements dispatch behavior.
import { resolveHumanDelayConfig } from "openclaw/plugin-sdk/agent-runtime";
import {
  createStatusReactionController,
  DEFAULT_TIMING,
  logAckFailure,
  logTypingFailure,
  removeAckReactionAfterReply,
  type StatusReactionAdapter,
} from "openclaw/plugin-sdk/channel-feedback";
import {
  dispatchChannelInboundTurn,
  type InboundReplyRecordOptions,
} from "openclaw/plugin-sdk/channel-inbound";
import {
  type ChannelBotLoopProtectionFacts,
  hasVisibleInboundReplyDispatch,
} from "openclaw/plugin-sdk/channel-inbound";
import {
  createChannelMessageReplyPipeline,
  defineFinalizableLivePreviewAdapter,
  deliverWithFinalizableLivePreviewAdapter,
  resolveChannelMessageSourceReplyDeliveryMode,
} from "openclaw/plugin-sdk/channel-outbound";
import { resolveAgentOutboundIdentity } from "openclaw/plugin-sdk/channel-outbound";
import {
  type AgentPlanStep,
  buildChannelProgressDraftLine,
  buildChannelProgressDraftLineForEntry,
  type ChannelProgressDraftCompositorLine,
  type ChannelProgressDraftCompositorSnapshot,
  createChannelProgressDraftCompositor,
  createChannelProgressReceiptTracker,
  formatChannelProgressDraftText,
  isChannelProgressDraftWorkToolName,
  mergeChannelProgressDraftLine,
  resolveChannelProgressDraftConfig,
  resolveChannelProgressDraftMaxLines,
  resolveChannelProgressDraftMaxLineChars,
  resolveChannelProgressDraftRender,
  resolveChannelStreamingBlockEnabled,
  resolveChannelStreamingNativeTransport,
  resolveChannelStreamingPreviewToolProgress,
  resolveChannelStreamingSuppressDefaultToolProgressMessages,
  type ChannelProgressDraftLine,
} from "openclaw/plugin-sdk/channel-outbound";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { mergePairLoopGuardConfig } from "openclaw/plugin-sdk/pair-loop-guard-runtime";
import {
  buildTtsSupplementMediaPayload,
  getReplyPayloadTtsSupplement,
  resolveSendableOutboundReplyParts,
} from "openclaw/plugin-sdk/reply-payload";
import type { ReplyDispatchKind, ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { resolveInboundLastRouteSessionKey } from "openclaw/plugin-sdk/routing";
import { danger, logVerbose, shouldLogVerbose, sleep } from "openclaw/plugin-sdk/runtime-env";
import { resolvePinnedMainDmOwnerFromAllowlist } from "openclaw/plugin-sdk/security-runtime";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { reactSlackMessage, removeSlackReaction } from "../../actions.js";
import { createSlackDraftStream } from "../../draft-stream.js";
import { formatSlackError } from "../../errors.js";
import { normalizeSlackOutboundText } from "../../format.js";
import {
  compileSlackInteractiveReplies,
  isSlackInteractiveRepliesEnabled,
} from "../../interactive-replies.js";
import { SLACK_TEXT_LIMIT } from "../../limits.js";
import { emitSlackMessageSentHooks } from "../../message-sent-hook.js";
import {
  buildSlackProgressDraftBlocks,
  buildSlackProgressStreamCompletionChunks,
  buildSlackProgressStreamStartChunks,
  buildSlackProgressStreamUpdateChunks,
  reconcileSlackNativeTaskChunks,
  type SlackNativeTaskSnapshot,
} from "../../progress-blocks.js";
import { resolveSlackReplyRenderPlan } from "../../reply-blocks.js";
import { recordSlackThreadParticipation } from "../../sent-thread-cache.js";
import { applyAppendOnlyStreamUpdate, resolveSlackStreamingConfig } from "../../stream-mode.js";
import type { SlackStreamSession } from "../../streaming.js";
import {
  appendSlackStream,
  markSlackStreamFallbackDelivered,
  SlackStreamNotDeliveredError,
  startSlackStream,
  stopSlackStream,
} from "../../streaming.js";
import { resolveSlackThreadTargets } from "../../threading.js";
import type { SlackMessageEvent } from "../../types.js";
import { normalizeSlackAllowOwnerEntry } from "../allow-list.js";
import { resolveStorePath, updateLastRoute } from "../config.runtime.js";
import { escapeSlackMrkdwn } from "../mrkdwn.js";
import {
  createSlackReplyDeliveryPlan,
  deliverReplies,
  readSlackReplyBlocks,
  resolveDeliveredSlackReplyThreadTs,
  resolveSlackThreadTs,
} from "../replies.js";
import { finalizeSlackPreviewEdit } from "./preview-finalize.js";
import { resolveSlackTimestampMs } from "./timestamp.js";
import type { PreparedSlackMessage } from "./types.js";

function resolveSlackMessageTimestampMs(message: SlackMessageEvent): number | undefined {
  const ts = message.event_ts ?? message.ts;
  return resolveSlackTimestampMs(ts);
}

function resolveSlackBotLoopProtection(
  prepared: PreparedSlackMessage,
): ChannelBotLoopProtectionFacts | undefined {
  const senderBotId = prepared.message.bot_id;
  if (!senderBotId) {
    return undefined;
  }
  const receiverBotId = prepared.ctx.botId || prepared.ctx.botUserId;
  if (
    !receiverBotId ||
    senderBotId === prepared.ctx.botId ||
    prepared.message.user === prepared.ctx.botUserId
  ) {
    return undefined;
  }
  return {
    scopeId: prepared.route.accountId,
    conversationId: prepared.message.channel,
    senderId: senderBotId,
    receiverId: receiverBotId,
    config: mergePairLoopGuardConfig(
      prepared.account.config.botLoopProtection,
      prepared.channelConfig?.botLoopProtection,
    ),
    defaultsConfig: prepared.ctx.cfg.channels?.defaults?.botLoopProtection,
    defaultEnabled: true,
    nowMs: resolveSlackMessageTimestampMs(prepared.message),
  };
}

function isSlackStreamingEnabled(params: {
  mode: "off" | "partial" | "block" | "progress";
  nativeStreaming: boolean;
  nativeProgressTaskCards?: boolean;
}): boolean {
  if (params.mode === "partial") {
    return params.nativeStreaming;
  }
  if (params.mode === "progress") {
    return params.nativeStreaming && params.nativeProgressTaskCards === true;
  }
  return false;
}

function shouldEnableSlackPreviewStreaming(params: {
  mode: "off" | "partial" | "block" | "progress";
}): boolean {
  return params.mode !== "off";
}

function shouldInitializeSlackDraftStream(params: {
  previewStreamingEnabled: boolean;
  useStreaming: boolean;
}): boolean {
  return params.previewStreamingEnabled && !params.useStreaming;
}

function resolveSlackDisableBlockStreaming(params: {
  useStreaming: boolean;
  shouldUseDraftStream: boolean;
  blockStreamingEnabled: boolean | undefined;
}): boolean | undefined {
  if (params.useStreaming || params.shouldUseDraftStream) {
    return true;
  }
  return typeof params.blockStreamingEnabled === "boolean"
    ? !params.blockStreamingEnabled
    : undefined;
}

function resolveExplicitSlackProgressTitle(
  entry: Parameters<typeof resolveChannelProgressDraftConfig>[0],
): string | undefined {
  const label = resolveChannelProgressDraftConfig(entry).label;
  if (typeof label !== "string") {
    return undefined;
  }
  const trimmed = label.trim();
  return trimmed && trimmed.toLowerCase() !== "auto" ? trimmed : undefined;
}

function resolveSlackNativeProgressTaskCards(
  entry: Parameters<typeof resolveChannelProgressDraftConfig>[0],
): boolean {
  const streaming = entry?.streaming;
  if (!streaming || typeof streaming !== "object" || Array.isArray(streaming)) {
    return false;
  }
  const progressConfig = (streaming as Record<string, unknown>).progress;
  return (
    Boolean(progressConfig) &&
    typeof progressConfig === "object" &&
    !Array.isArray(progressConfig) &&
    (progressConfig as { nativeTaskCards?: unknown }).nativeTaskCards === true
  );
}

function resolveSlackStreamingThreadHint(params: {
  replyToMode: "off" | "first" | "all" | "batched";
  incomingThreadTs: string | undefined;
  messageTs: string | undefined;
  isThreadReply?: boolean;
}): string | undefined {
  return resolveSlackThreadTs({
    replyToMode: params.replyToMode,
    incomingThreadTs: params.incomingThreadTs,
    messageTs: params.messageTs,
    hasReplied: false,
    isThreadReply: params.isThreadReply,
  });
}

type SlackEventDeliveryAttempt = {
  kind: ReplyDispatchKind;
  payload: ReplyPayload;
  threadTs?: string;
  textOverride?: string;
};

const SLACK_STREAM_RECIPIENT_TEAM_CACHE_MAX = 2000;
const slackStreamRecipientTeamCaches = new WeakMap<object, Map<string, string>>();

function getSlackStreamRecipientTeamCache(client: object): Map<string, string> {
  const existing = slackStreamRecipientTeamCaches.get(client);
  if (existing) {
    return existing;
  }
  const cache = new Map<string, string>();
  slackStreamRecipientTeamCaches.set(client, cache);
  return cache;
}

function buildSlackEventDeliveryKey(params: SlackEventDeliveryAttempt): string | null {
  const reply = resolveSendableOutboundReplyParts(params.payload, {
    text: params.textOverride,
  });
  const renderPlan = resolveSlackReplyRenderPlan(
    params.payload,
    params.textOverride ?? params.payload.text,
  );
  const plannedBlocks =
    renderPlan.mode === "single" ? renderPlan.blocks : renderPlan.blockPart?.blocks;
  const slackBlocks = readSlackReplyBlocks(params.payload) ?? plannedBlocks;
  const renderedText = renderPlan.mode === "single" ? renderPlan.text : renderPlan.fallbackText;
  if (!reply.hasContent && !slackBlocks?.length && !renderedText.trim()) {
    return null;
  }
  return JSON.stringify({
    kind: params.kind,
    threadTs: params.threadTs ?? "",
    replyToId: params.payload.replyToId ?? null,
    text: renderedText || reply.trimmedText,
    mediaUrls: reply.mediaUrls,
    blocks: slackBlocks ?? null,
  });
}

function readSlackStreamRecipientTeamCache(params: {
  client: object;
  fallbackTeamId?: string;
  userId?: string;
}): string | undefined {
  if (!params.fallbackTeamId || !params.userId) {
    return undefined;
  }
  const cacheKey = `${params.fallbackTeamId}:${params.userId}`;
  const cache = getSlackStreamRecipientTeamCache(params.client);
  const cached = cache.get(cacheKey);
  if (!cached) {
    return undefined;
  }
  cache.delete(cacheKey);
  cache.set(cacheKey, cached);
  return cached;
}

function rememberSlackStreamRecipientTeam(params: {
  client: object;
  fallbackTeamId?: string;
  userId?: string;
  teamId: string;
}): void {
  if (!params.fallbackTeamId || !params.userId) {
    return;
  }
  const cacheKey = `${params.fallbackTeamId}:${params.userId}`;
  const cache = getSlackStreamRecipientTeamCache(params.client);
  if (cache.has(cacheKey)) {
    cache.delete(cacheKey);
  }
  cache.set(cacheKey, params.teamId);
  if (cache.size > SLACK_STREAM_RECIPIENT_TEAM_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest) {
      cache.delete(oldest);
    }
  }
}

function createSlackEventDeliveryTracker() {
  const deliveredKeys = new Set<string>();
  return {
    hasDelivered(params: SlackEventDeliveryAttempt) {
      const key = buildSlackEventDeliveryKey(params);
      return key ? deliveredKeys.has(key) : false;
    },
    markDelivered(params: SlackEventDeliveryAttempt) {
      const key = buildSlackEventDeliveryKey(params);
      if (key) {
        deliveredKeys.add(key);
      }
    },
  };
}

function shouldUseStreaming(params: {
  streamingEnabled: boolean;
  threadTs: string | undefined;
}): boolean {
  if (!params.streamingEnabled) {
    return false;
  }
  if (!params.threadTs) {
    logVerbose("slack-stream: streaming disabled — no reply thread target available");
    return false;
  }
  return true;
}

async function resolveSlackStreamRecipientTeamId(params: {
  client: Pick<PreparedSlackMessage["ctx"]["app"]["client"], "users">;
  token: string;
  userId?: PreparedSlackMessage["message"]["user"];
  fallbackTeamId?: string;
}): Promise<string | undefined> {
  const cachedTeamId = readSlackStreamRecipientTeamCache(params);
  if (cachedTeamId) {
    return cachedTeamId;
  }
  if (params.userId) {
    try {
      const info = await params.client.users.info({
        token: params.token,
        user: params.userId,
      });
      const teamId = info.user?.team_id ?? info.user?.profile?.team;
      if (teamId) {
        rememberSlackStreamRecipientTeam({ ...params, teamId });
        return teamId;
      }
    } catch (err) {
      logVerbose(`slack-stream: users.info team lookup failed (${formatErrorMessage(err)})`);
    }
  }
  return params.fallbackTeamId;
}

export async function dispatchPreparedSlackMessage(prepared: PreparedSlackMessage) {
  const { ctx, account, message, route } = prepared;
  const slackClient = prepared.eventScope?.client ?? ctx.app.client;
  const slackStreamFallbackTeamId = prepared.eventScope?.teamId ?? ctx.teamId;
  const cfg = ctx.cfg;
  const runtime = ctx.runtime;

  // Resolve agent identity for Slack chat:write.customize overrides.
  const outboundIdentity = resolveAgentOutboundIdentity(cfg, route.agentId);
  const slackIdentity = outboundIdentity
    ? {
        username: outboundIdentity.name,
        iconUrl: outboundIdentity.avatarUrl,
        iconEmoji: outboundIdentity.emoji,
      }
    : prepared.relayIdentity;

  if (prepared.isDirectMessage) {
    const sessionCfg = cfg.session;
    const storePath = resolveStorePath(sessionCfg?.store, {
      agentId: route.agentId,
    });
    const pinnedMainDmOwner = resolvePinnedMainDmOwnerFromAllowlist({
      dmScope: cfg.session?.dmScope,
      allowFrom: ctx.allowFrom,
      normalizeEntry: normalizeSlackAllowOwnerEntry,
    });
    const senderRecipient = normalizeOptionalLowercaseString(message.user);
    const inboundLastRouteSessionKey = resolveInboundLastRouteSessionKey({
      route,
      sessionKey: prepared.ctxPayload.SessionKey ?? route.sessionKey,
    });
    const skipMainUpdate =
      inboundLastRouteSessionKey === route.mainSessionKey &&
      pinnedMainDmOwner &&
      senderRecipient &&
      normalizeOptionalLowercaseString(pinnedMainDmOwner) !== senderRecipient;
    if (skipMainUpdate) {
      logVerbose(
        `slack: skip main-session last route for ${senderRecipient} (pinned owner ${pinnedMainDmOwner})`,
      );
    } else {
      await updateLastRoute({
        storePath,
        sessionKey: inboundLastRouteSessionKey,
        deliveryContext: {
          channel: "slack",
          to: `user:${message.user}`,
          accountId: route.accountId,
          threadId: prepared.ctxPayload.MessageThreadId ?? prepared.ctxPayload.TransportThreadId,
        },
        ctx: prepared.ctxPayload,
      });
    }
  }

  const threadTargets = resolveSlackThreadTargets({
    message,
    replyToMode: prepared.replyToMode,
  });
  const forcedReplyThreadTs = prepared.forcedReplyThreadTs;
  const slackMessageMetadata = prepared.slackMessageMetadata;
  const statusThreadTs = forcedReplyThreadTs ?? threadTargets.statusThreadTs;
  const isThreadReply = threadTargets.isThreadReply;
  const replyDeliveryMode = forcedReplyThreadTs ? "off" : prepared.replyToMode;
  const sourceReplyDeliveryMode = resolveChannelMessageSourceReplyDeliveryMode({
    cfg,
    ctx: prepared.ctxPayload,
  });
  const sourceRepliesAreToolOnly = sourceReplyDeliveryMode === "message_tool_only";
  const suppressRoomEventTyping = prepared.ctxPayload.InboundEventKind === "room_event";

  // Shared context for the `message_sent` plugin hook emitted on each delivered
  // reply (both the `deliverReplies` paths and the native-streaming finalizer).
  const messageSentHookTarget =
    prepared.ctxPayload.OriginatingTo ?? prepared.ctxPayload.To ?? prepared.replyTarget;
  const messageSentHookContext = {
    sessionKeyForInternalHooks: prepared.ctxPayload.SessionKey ?? route.sessionKey,
    isGroup: prepared.isRoomish,
    groupId: prepared.isRoomish ? message.channel : undefined,
  };
  const messageSentDeliveryHookContext = {
    ...messageSentHookContext,
    messageSentHookTarget,
  };

  const reactionMessageTs = prepared.ackReactionMessageTs;
  const messageTs = message.ts ?? message.event_ts;
  const incomingThreadTs = message.thread_ts;
  let didSetStatus = false;
  const statusReactionsEnabled =
    prepared.ctxPayload.InboundEventKind !== "room_event" &&
    Boolean(prepared.ackReactionPromise) &&
    Boolean(reactionMessageTs) &&
    cfg.messages?.statusReactions?.enabled === true;
  const slackStatusAdapter: StatusReactionAdapter = {
    setReaction: async (emoji) => {
      await reactSlackMessage(message.channel, reactionMessageTs ?? "", emoji, {
        token: ctx.botToken,
        client: slackClient,
      }).catch((err: unknown) => {
        if (formatErrorMessage(err).includes("already_reacted")) {
          return;
        }
        throw err;
      });
    },
    removeReaction: async (emoji) => {
      await removeSlackReaction(message.channel, reactionMessageTs ?? "", emoji, {
        token: ctx.botToken,
        client: slackClient,
      }).catch((err: unknown) => {
        if (formatErrorMessage(err).includes("no_reaction")) {
          return;
        }
        throw err;
      });
    },
  };
  const statusReactionTiming = {
    ...DEFAULT_TIMING,
    ...cfg.messages?.statusReactions?.timing,
  };
  const statusReactions = createStatusReactionController({
    enabled: statusReactionsEnabled,
    adapter: slackStatusAdapter,
    initialEmoji: prepared.ackReactionValue || "eyes",
    emojis: cfg.messages?.statusReactions?.emojis,
    timing: cfg.messages?.statusReactions?.timing,
    onError: (err) => {
      logAckFailure({
        log: logVerbose,
        channel: "slack",
        target: `${message.channel}/${message.ts}`,
        error: err,
      });
    },
  });

  if (statusReactionsEnabled) {
    void statusReactions.setQueued();
  }

  // Shared mutable ref for "replyToMode=first". Both tool + auto-reply flows
  // mark this to ensure only the first reply is threaded.
  const hasRepliedRef = { value: false };
  const replyPlan = createSlackReplyDeliveryPlan({
    replyToMode: replyDeliveryMode,
    incomingThreadTs: forcedReplyThreadTs ?? incomingThreadTs,
    messageTs,
    hasRepliedRef,
    isThreadReply: Boolean(forcedReplyThreadTs) || isThreadReply,
  });

  const typingTarget = statusThreadTs ? `${message.channel}/${statusThreadTs}` : message.channel;
  const typingReaction = ctx.typingReaction;
  const { onModelSelected, ...replyPipeline } = createChannelMessageReplyPipeline({
    cfg,
    agentId: route.agentId,
    channel: "slack",
    accountId: route.accountId,
    transformReplyPayload: (payload) => {
      if (payload.isReasoning === true) {
        return null;
      }
      return isSlackInteractiveRepliesEnabled({ cfg, accountId: route.accountId })
        ? compileSlackInteractiveReplies(payload)
        : payload;
    },
    typing: {
      start: async () => {
        didSetStatus = true;
        await ctx.setSlackThreadStatus({
          channelId: message.channel,
          threadTs: statusThreadTs,
          status: "is typing...",
          eventScope: prepared.eventScope,
        });
        if (typingReaction && message.ts) {
          await reactSlackMessage(message.channel, message.ts, typingReaction, {
            token: ctx.botToken,
            client: slackClient,
          }).catch((err: unknown) => {
            logVerbose(`slack send: typing reaction failed: ${formatSlackError(err)}`);
          });
        }
      },
      stop: async () => {
        if (!didSetStatus) {
          return;
        }
        didSetStatus = false;
        await ctx.setSlackThreadStatus({
          channelId: message.channel,
          threadTs: statusThreadTs,
          status: "",
          eventScope: prepared.eventScope,
        });
        if (typingReaction && message.ts) {
          await removeSlackReaction(message.channel, message.ts, typingReaction, {
            token: ctx.botToken,
            client: slackClient,
          }).catch((err: unknown) => {
            logVerbose(`slack send: typing reaction removal failed: ${formatSlackError(err)}`);
          });
        }
      },
      onStartError: (err) => {
        logTypingFailure({
          log: (messageValue) => runtime.error?.(danger(messageValue)),
          channel: "slack",
          action: "start",
          target: typingTarget,
          error: err,
        });
      },
      onStopError: (err) => {
        logTypingFailure({
          log: (messageLocal) => runtime.error?.(danger(messageLocal)),
          channel: "slack",
          action: "stop",
          target: typingTarget,
          error: err,
        });
      },
    },
  });

  const slackStreaming = resolveSlackStreamingConfig({
    streaming: account.config.streaming,
    nativeStreaming: resolveChannelStreamingNativeTransport(account.config),
  });
  const streamThreadHint =
    forcedReplyThreadTs ??
    resolveSlackStreamingThreadHint({
      replyToMode: replyDeliveryMode,
      incomingThreadTs,
      messageTs,
      isThreadReply,
    });
  const previewStreamingEnabled =
    !sourceRepliesAreToolOnly &&
    shouldEnableSlackPreviewStreaming({
      mode: slackStreaming.mode,
    });
  const hasSlackCustomIdentity = Boolean(
    slackIdentity?.username || slackIdentity?.iconUrl || slackIdentity?.iconEmoji,
  );
  const streamingEnabled =
    !sourceRepliesAreToolOnly &&
    isSlackStreamingEnabled({
      mode: slackStreaming.mode,
      nativeStreaming: slackStreaming.nativeStreaming,
      nativeProgressTaskCards: resolveSlackNativeProgressTaskCards(account.config),
    });
  const useStreaming = shouldUseStreaming({
    streamingEnabled,
    threadTs: streamThreadHint,
  });
  // chat.update cannot preserve custom authorship. Use native streaming when
  // possible; otherwise keep identity intact with one final postMessage.
  const shouldUseDraftStream =
    !hasSlackCustomIdentity &&
    shouldInitializeSlackDraftStream({
      previewStreamingEnabled,
      useStreaming,
    });
  const blockStreamingEnabled = resolveChannelStreamingBlockEnabled(account.config);
  const disableBlockStreaming = sourceRepliesAreToolOnly
    ? true
    : resolveSlackDisableBlockStreaming({
        useStreaming,
        shouldUseDraftStream,
        blockStreamingEnabled,
      });
  let streamSession: SlackStreamSession | null = null;
  let nativeProgressStreamStartPromise: Promise<SlackStreamSession | null> | null = null;
  let nativeProgressStreamThreadTs: string | undefined;
  let streamFailed = false;
  let usedReplyThreadTs: string | undefined;
  let usedBlockReplyThreadTs: string | undefined;
  let observedReplyDelivery = false;
  let observedFinalReplyDelivery = false;
  // Reply payloads routed through the native text stream. Track Slack
  // acknowledgement separately because a later buffered suffix can fall back
  // after earlier payloads are already visible.
  const streamedDeliveries: Array<{
    kind: ReplyDispatchKind;
    content: string;
    acknowledged: boolean;
    outcome?: "success" | "failure";
  }> = [];
  const streamedFailuresOwnedByDispatcher: Record<ReplyDispatchKind, number> = {
    tool: 0,
    block: 0,
    final: 0,
  };
  const refreshStreamedAcknowledgements = (session: SlackStreamSession) => {
    if (session.pendingText.length === 0) {
      for (const delivery of streamedDeliveries) {
        delivery.acknowledged = true;
      }
    }
  };
  const recordStreamedDelivery = (kind: ReplyDispatchKind, content: string) => {
    const delivery: (typeof streamedDeliveries)[number] = {
      kind,
      content,
      acknowledged: false,
    };
    streamedDeliveries.push(delivery);
    return delivery;
  };
  const rememberStreamedDelivery = (
    kind: ReplyDispatchKind,
    content: string,
    session: SlackStreamSession,
  ) => {
    recordStreamedDelivery(kind, content);
    refreshStreamedAcknowledgements(session);
  };
  const emitAcknowledgedStreamedDeliveries = (messageId?: string) => {
    for (const delivery of streamedDeliveries) {
      if (!delivery.acknowledged || delivery.outcome) {
        continue;
      }
      emitSlackMessageSentHooks({
        ...messageSentHookContext,
        to: messageSentHookTarget,
        accountId: account.accountId,
        content: delivery.content,
        success: true,
        ...(messageId ? { messageId } : {}),
      });
      delivery.outcome = "success";
    }
  };
  const acknowledgeStoppedStreamedDeliveries = (
    session: SlackStreamSession,
    messageId?: string,
  ) => {
    refreshStreamedAcknowledgements(session);
    for (const delivery of streamedDeliveries) {
      delivery.acknowledged = true;
    }
    emitAcknowledgedStreamedDeliveries(messageId);
  };
  const emitFailedPendingStreamedDeliveries = (error: string) => {
    for (const delivery of streamedDeliveries) {
      if (delivery.acknowledged || delivery.outcome) {
        continue;
      }
      emitSlackMessageSentHooks({
        ...messageSentHookContext,
        to: messageSentHookTarget,
        accountId: account.accountId,
        content: delivery.content,
        success: false,
        error,
      });
      delivery.outcome = "failure";
    }
  };
  const emitSuccessfulPendingStreamedDeliveries = (messageId?: string) => {
    for (const delivery of streamedDeliveries) {
      if (delivery.acknowledged || delivery.outcome) {
        continue;
      }
      emitSlackMessageSentHooks({
        ...messageSentHookContext,
        to: messageSentHookTarget,
        accountId: account.accountId,
        content: delivery.content,
        success: true,
        ...(messageId ? { messageId } : {}),
      });
      delivery.outcome = "success";
    }
  };
  let deliveryTracker = createSlackEventDeliveryTracker();
  const markPreviewPayloadDelivered = (params: {
    kind: ReplyDispatchKind;
    payload: ReplyPayload;
    threadTs: string | undefined;
  }) => {
    deliveryTracker.markDelivered(params);
    // Single-use reply modes move later same-turn payloads off the preview
    // thread, so protect both delivery keys from duplicates.
    const nextThreadTs = replyPlan.peekThreadTs();
    if (nextThreadTs !== params.threadTs) {
      deliveryTracker.markDelivered({ ...params, threadTs: nextThreadTs });
    }
  };
  const resolveDeliveryThreadTs = (params: {
    kind: ReplyDispatchKind;
    forcedThreadTs?: string;
  }): string | undefined => {
    const plannedThreadTs = params.forcedThreadTs ? undefined : replyPlan.nextThreadTs();
    return (
      params.forcedThreadTs ??
      plannedThreadTs ??
      (params.kind === "block" ? usedBlockReplyThreadTs : undefined)
    );
  };
  const rememberDeliveredThreadTs = (
    kind: ReplyDispatchKind,
    deliveredThreadTs: string | undefined,
  ) => {
    if (!deliveredThreadTs) {
      return;
    }
    usedReplyThreadTs ??= deliveredThreadTs;
    if (kind === "block") {
      usedBlockReplyThreadTs = deliveredThreadTs;
    }
  };
  const deliverPendingStreamFallback = async (
    session: SlackStreamSession,
    err: SlackStreamNotDeliveredError,
  ): Promise<boolean> => {
    let fallbackError = err;
    if (!session.stopped) {
      try {
        const stopResult = await stopSlackStream({
          session,
          ...(slackMessageMetadata ? { metadata: slackMessageMetadata } : {}),
        });
        acknowledgeStoppedStreamedDeliveries(session, stopResult.messageId);
        observedReplyDelivery = true;
        usedReplyThreadTs ??= session.threadTs;
        return true;
      } catch (stopErr) {
        if (stopErr instanceof SlackStreamNotDeliveredError) {
          fallbackError = stopErr;
        } else {
          runtime.error?.(
            danger(
              `slack-stream: failed to finalize buffered text before fallback: ${formatSlackError(stopErr)}`,
            ),
          );
        }
      }
    }
    emitAcknowledgedStreamedDeliveries();
    // The Slack SDK still owns this text in-memory; no streaming API call has
    // acknowledged it. Route through deliverReplies so pendingText that
    // exceeds Slack's per-message text limit still lands (a single
    // chat.postMessage would have failed with msg_too_long), and so the
    // fallback respects the configured replyToMode/identity the same way
    // normal replies do.
    const fallbackText = fallbackError.pendingText.trim();
    if (!fallbackText) {
      return false;
    }
    try {
      await deliverReplies({
        cfg: ctx.cfg,
        replies: [{ text: fallbackText } as ReplyPayload],
        target: prepared.replyTarget,
        token: ctx.botToken,
        accountId: account.accountId,
        runtime,
        textLimit: ctx.textLimit,
        mediaMaxBytes: ctx.mediaMaxBytes,
        replyThreadTs: session.threadTs,
        replyToMode: replyDeliveryMode,
        ...(slackIdentity ? { identity: slackIdentity } : {}),
        ...(slackMessageMetadata ? { metadata: slackMessageMetadata } : {}),
        ...messageSentDeliveryHookContext,
        deferMessageSentHooks: true,
        ...(prepared.eventScope ? { eventScope: prepared.eventScope } : {}),
      });
      markSlackStreamFallbackDelivered(session);
      if (!session.stopped) {
        try {
          await stopSlackStream({
            session,
            ...(slackMessageMetadata ? { metadata: slackMessageMetadata } : {}),
          });
        } catch (finalizeErr) {
          runtime.error?.(
            danger(
              `slack-stream: failed to finalize native stream after fallback delivery: ${formatSlackError(finalizeErr)}`,
            ),
          );
        }
      }
      // The combined fallback can span multiple logical payloads and Slack
      // chunks, so no single message `ts` correctly identifies every event.
      emitSuccessfulPendingStreamedDeliveries();
      observedReplyDelivery = true;
      usedReplyThreadTs ??= session.threadTs;
      logVerbose(
        `slack-stream: streamed delivery failed (${fallbackError.slackCode}); delivered ${fallbackText.length} chars via deliverReplies fallback`,
      );
      return true;
    } catch (postErr) {
      emitFailedPendingStreamedDeliveries(formatErrorMessage(postErr));
      runtime.error?.(
        danger(
          `slack-stream: fallback deliverReplies failed after ${fallbackError.slackCode}: ${formatErrorMessage(postErr)}`,
        ),
      );
      return false;
    }
  };

  const deliverNormally = async (params: {
    payload: ReplyPayload;
    kind: ReplyDispatchKind;
    forcedThreadTs?: string;
  }): Promise<string | undefined> => {
    if (params.payload.isReasoning === true) {
      return undefined;
    }
    const replyThreadTs = resolveDeliveryThreadTs(params);
    const deliveryReplyThreadTs =
      replyDeliveryMode === "off" && !forcedReplyThreadTs && !isThreadReply
        ? undefined
        : replyThreadTs;
    if (
      deliveryTracker.hasDelivered({
        kind: params.kind,
        payload: params.payload,
        threadTs: deliveryReplyThreadTs,
      })
    ) {
      logVerbose("slack: suppressed duplicate normal delivery within the same turn");
      return deliveryReplyThreadTs;
    }
    await deliverReplies({
      cfg: ctx.cfg,
      replies: [params.payload],
      target: prepared.replyTarget,
      token: ctx.botToken,
      accountId: account.accountId,
      runtime,
      textLimit: ctx.textLimit,
      mediaMaxBytes: ctx.mediaMaxBytes,
      replyThreadTs: deliveryReplyThreadTs,
      replyToMode: replyDeliveryMode,
      ...(slackIdentity ? { identity: slackIdentity } : {}),
      ...(slackMessageMetadata ? { metadata: slackMessageMetadata } : {}),
      ...messageSentDeliveryHookContext,
      ...(prepared.eventScope ? { eventScope: prepared.eventScope } : {}),
    });
    observedReplyDelivery = true;
    if (params.kind === "final") {
      observedFinalReplyDelivery = true;
    }
    const deliveredThreadTs = resolveDeliveredSlackReplyThreadTs({
      replyToMode: replyDeliveryMode,
      payloadReplyToId: params.payload.replyToId,
      replyThreadTs: deliveryReplyThreadTs,
    });
    // Record the thread ts only after confirmed delivery success.
    rememberDeliveredThreadTs(params.kind, deliveredThreadTs);
    replyPlan.markSent();
    deliveryTracker.markDelivered({
      kind: params.kind,
      payload: params.payload,
      threadTs: deliveryReplyThreadTs,
    });
    return deliveryReplyThreadTs;
  };

  const deliverBufferedStreamFallback = async (params: {
    session: SlackStreamSession;
    err: SlackStreamNotDeliveredError;
    payload: ReplyPayload;
    kind: ReplyDispatchKind;
    textOverride: string;
  }): Promise<boolean> => {
    const delivered = await deliverPendingStreamFallback(params.session, params.err);
    if (!delivered) {
      // The reply dispatcher will charge the currently executing payload as
      // failed; earlier buffered payloads need separate reconciliation below.
      streamedFailuresOwnedByDispatcher[params.kind] += 1;
      return false;
    }
    replyPlan.markSent();
    if (params.kind === "final") {
      observedFinalReplyDelivery = true;
    }
    deliveryTracker.markDelivered({
      kind: params.kind,
      payload: params.payload,
      threadTs: params.session.threadTs,
      textOverride: params.textOverride,
    });
    rememberDeliveredThreadTs(params.kind, params.session.threadTs);
    return true;
  };

  const appendNativeProgressCompletion = async (isError: boolean) => {
    const session = streamSession;
    if (isError) {
      nativeProgressTerminalStatus = "error";
    }
    if (!session || nativeProgressCompletionSent) {
      return;
    }
    const chunks = buildNativeProgressCompletionChunks(isError ? "error" : "complete");
    if (!chunks?.length) {
      return;
    }
    try {
      await appendSlackStream({ session, chunks });
      nativeProgressCompletionSent = true;
      observedReplyDelivery ||= session.delivered;
    } catch (err) {
      streamFailed = true;
      runtime.error?.(
        danger(`slack-stream: native progress completion failed: ${formatSlackError(err)}`),
      );
    }
  };

  const deliverWithStreaming = async (params: {
    payload: ReplyPayload;
    kind: ReplyDispatchKind;
  }): Promise<void> => {
    if (params.payload.isReasoning === true) {
      return;
    }
    const reply = resolveSendableOutboundReplyParts(params.payload);
    const renderPlan = resolveSlackReplyRenderPlan(params.payload);
    const plannedBlocks =
      renderPlan.mode === "single" ? renderPlan.blocks : renderPlan.blockPart?.blocks;
    if (
      streamFailed ||
      reply.hasMedia ||
      renderPlan.mode === "split" ||
      Boolean(plannedBlocks?.length) ||
      readSlackReplyBlocks(params.payload)?.length ||
      !reply.hasText
    ) {
      await deliverNormally({
        payload: params.payload,
        kind: params.kind,
        forcedThreadTs: streamSession?.threadTs ?? nativeProgressStreamThreadTs,
      });
      return;
    }

    const text = reply.trimmedText;
    let plannedThreadTs: string | undefined;
    try {
      if (!streamSession && nativeProgressStreamStartPromise) {
        await nativeProgressStreamStartPromise;
      }
      if (streamFailed) {
        await deliverNormally({
          payload: params.payload,
          kind: params.kind,
          forcedThreadTs: streamSession?.threadTs ?? nativeProgressStreamThreadTs,
        });
        return;
      }
      if (!streamSession) {
        const streamThreadTs = replyPlan.nextThreadTs();
        plannedThreadTs = streamThreadTs;
        if (!streamThreadTs) {
          logVerbose(
            "slack-stream: no reply thread target for stream start, falling back to normal delivery",
          );
          streamFailed = true;
          await deliverNormally({
            payload: params.payload,
            kind: params.kind,
          });
          return;
        }
        if (
          deliveryTracker.hasDelivered({
            kind: params.kind,
            payload: params.payload,
            threadTs: streamThreadTs,
            textOverride: text,
          })
        ) {
          logVerbose("slack-stream: suppressed duplicate stream start payload");
          return;
        }

        streamSession = await startSlackStream({
          client: slackClient,
          channel: message.channel,
          threadTs: streamThreadTs,
          text,
          ...(slackIdentity ? { identity: slackIdentity } : {}),
          teamId: await resolveSlackStreamRecipientTeamId({
            client: slackClient,
            token: ctx.botToken,
            userId: message.user,
            fallbackTeamId: slackStreamFallbackTeamId,
          }),
          userId: message.user,
        });
        refreshStreamedAcknowledgements(streamSession);
        // startSlackStream may only buffer locally. Count delivery only after
        // the SDK reports a real Slack response.
        if (streamSession.delivered) {
          observedReplyDelivery = true;
          if (params.kind === "final") {
            observedFinalReplyDelivery = true;
          }
        }
        // Remember the reply text delivered through the text stream so the
        // `message_sent` hook can fire after stopSlackStream flushes it.
        // Only the text-stream path captures this; every deliverNormally branch
        // already emits via deliverReplies, so capturing there would
        // double-emit for the same payload.
        if (text) {
          rememberStreamedDelivery(params.kind, text, streamSession);
        }
        rememberDeliveredThreadTs(params.kind, streamThreadTs);
        replyPlan.markSent();
        deliveryTracker.markDelivered({
          kind: params.kind,
          payload: params.payload,
          threadTs: streamThreadTs,
          textOverride: text,
        });
        return;
      }
      if (
        deliveryTracker.hasDelivered({
          kind: params.kind,
          payload: params.payload,
          threadTs: streamSession.threadTs,
          textOverride: text,
        })
      ) {
        logVerbose("slack-stream: suppressed duplicate append payload");
        return;
      }

      if (text) {
        // appendSlackStream buffers text before attempting the Slack flush.
        // Record first so a later successful stop can acknowledge a thrown append.
        recordStreamedDelivery(params.kind, text);
      }
      await appendSlackStream({
        session: streamSession,
        text: "\n" + text,
      });
      refreshStreamedAcknowledgements(streamSession);
      // appendSlackStream also buffers locally below the SDK threshold; avoid
      // optimistic "done" status until Slack acknowledges a flush.
      if (streamSession.delivered) {
        observedReplyDelivery = true;
        if (params.kind === "final") {
          observedFinalReplyDelivery = true;
        }
      }
      deliveryTracker.markDelivered({
        kind: params.kind,
        payload: params.payload,
        threadTs: streamSession.threadTs,
        textOverride: text,
      });
    } catch (err) {
      if (err instanceof SlackStreamNotDeliveredError) {
        streamFailed = true;
        if (streamSession) {
          const delivered = await deliverBufferedStreamFallback({
            session: streamSession,
            err,
            payload: params.payload,
            kind: params.kind,
            textOverride: text,
          });
          if (delivered) {
            return;
          }
          throw err;
        }
        await deliverNormally({
          payload: params.payload,
          kind: params.kind,
          forcedThreadTs: plannedThreadTs,
        });
        return;
      }
      runtime.error?.(
        danger(`slack-stream: streaming API call failed: ${formatSlackError(err)}, falling back`),
      );
      streamFailed = true;
      // Non-benign streaming errors leave `pendingText` populated with every
      // buffered chunk since the last flush (appendSlackStream accumulates
      // into pendingText BEFORE the SDK call, so the failing chunk is
      // included too). Route the full buffer through the chunked fallback so
      // earlier chunks aren't lost, then skip deliverNormally - pendingText
      // already contains this payload's text.
      if (streamSession && streamSession.pendingText) {
        const bufferedFallbackErr = new SlackStreamNotDeliveredError(
          streamSession.pendingText,
          "unknown",
        );
        const delivered = await deliverBufferedStreamFallback({
          session: streamSession,
          err: bufferedFallbackErr,
          payload: params.payload,
          kind: params.kind,
          textOverride: text,
        });
        if (delivered) {
          return;
        }
        throw err;
      }
      await deliverNormally({
        payload: params.payload,
        kind: params.kind,
        forcedThreadTs: streamSession?.threadTs ?? nativeProgressStreamThreadTs ?? plannedThreadTs,
      });
    }
  };

  let draftPreviewCommitted = false;
  const deliverSlackPayload = async (
    payload: ReplyPayload,
    info: { kind: ReplyDispatchKind },
  ): Promise<{ visibleReplySent: false } | void> => {
    if (payload.isReasoning === true) {
      return { visibleReplySent: false };
    }
    if (
      info.kind === "final" &&
      slackStreaming.mode === "progress" &&
      streamMode === "status_final"
    ) {
      const hadProgressDraft = progressDraft.hasStarted;
      progressDraft.markFinalReplyStarted();
      if (useNativeProgressStreaming) {
        await waitForNativeProgressStreamStart();
        const finalThreadTs = streamSession?.threadTs ?? nativeProgressStreamThreadTs;
        await deliverNormally({
          payload,
          kind: info.kind,
          forcedThreadTs: finalThreadTs,
        });
        // Complete the cards only after the fresh final landed; a failed send
        // leaves completion to the outer cleanup, which can mark error state.
        await appendNativeProgressCompletion(payload.isError === true);
        progressDraft.markFinalReplyDelivered();
        if (!payload.isError && hadProgressDraft && streamSession) {
          pendingNativeProgressReceipt = progressReceipt.buildSummaryLine();
        }
        return;
      }

      if (hadProgressDraft) {
        // Best-effort settle of the working draft; a flush failure must never
        // suppress the fresh final send below.
        try {
          await draftStream?.flush();
        } catch (err) {
          logVerbose(`slack: progress draft flush before final failed (${formatSlackError(err)})`);
        }
      }
      const receiptChannelId = hadProgressDraft ? draftStream?.channelId() : undefined;
      const receiptMessageId = hadProgressDraft ? draftStream?.messageId() : undefined;
      // The draft already selected the reply thread; re-planning here could
      // route the fresh final elsewhere under stateful replyToMode values.
      const draftThreadTs = hadProgressDraft ? (usedReplyThreadTs ?? statusThreadTs) : undefined;
      await deliverNormally({
        payload,
        kind: info.kind,
        ...(draftThreadTs ? { forcedThreadTs: draftThreadTs } : {}),
      });
      progressDraft.markFinalReplyDelivered();
      if (!payload.isError && receiptChannelId && receiptMessageId && !progressReceiptCollapsed) {
        // Collapse only after the fresh final lands; a failed send leaves the
        // working draft untouched as the turn record.
        await collapseProgressReceipt({
          channelId: receiptChannelId,
          messageId: receiptMessageId,
          text: progressReceipt.buildSummaryLine(),
          threadTs: usedReplyThreadTs ?? statusThreadTs,
        });
      }
      return;
    }
    if (useNativeProgressStreaming) {
      await deliverNormally({
        payload,
        kind: info.kind,
        forcedThreadTs: streamSession?.threadTs ?? nativeProgressStreamThreadTs,
      });
      return;
    }
    if (useStreaming) {
      await deliverWithStreaming({ payload, kind: info.kind });
      return;
    }

    const reply = resolveSendableOutboundReplyParts(payload);
    const ttsSupplement = getReplyPayloadTtsSupplement(payload);
    const replySourceText = payload.text ?? ttsSupplement?.spokenText;
    const replyRenderPlan = resolveSlackReplyRenderPlan(payload, replySourceText);
    const plannedBlocks =
      replyRenderPlan.mode === "single"
        ? replyRenderPlan.blocks
        : replyRenderPlan.blockPart?.blocks;
    const slackBlocks = plannedBlocks;
    const requiresSeparateFallbackDelivery = replyRenderPlan.mode === "split";
    const trimmedFinalText =
      replyRenderPlan.mode === "single"
        ? replyRenderPlan.text.trim()
        : replyRenderPlan.fallbackText.trim();
    const previewFinalText =
      replyRenderPlan.mode === "single" && replyRenderPlan.textIsSlackMrkdwn
        ? trimmedFinalText
        : normalizeSlackOutboundText((replySourceText ?? "").trim());
    const shouldRestoreTtsSupplementTextForPreviewFallback =
      Boolean(ttsSupplement) &&
      ttsSupplement?.visibleTextAlreadyDelivered !== true &&
      Boolean(draftStream) &&
      !draftPreviewCommitted &&
      !observedFinalReplyDelivery &&
      previewStreamingEnabled &&
      !payload.text?.trim();

    if (
      info.kind === "final" &&
      ttsSupplement &&
      draftStream &&
      !draftPreviewCommitted &&
      !observedFinalReplyDelivery &&
      previewStreamingEnabled &&
      !payload.isError &&
      !requiresSeparateFallbackDelivery &&
      trimmedFinalText.length > 0
    ) {
      const channelId = draftStream.channelId();
      const messageId = draftStream.messageId();
      if (channelId && messageId) {
        const finalThreadTs = usedReplyThreadTs ?? statusThreadTs;
        await draftStream.flush();
        await draftStream.seal();
        try {
          await finalizeSlackPreviewEdit({
            client: slackClient,
            token: ctx.botToken,
            accountId: account.accountId,
            channelId,
            messageId,
            text: previewFinalText,
            ...(slackBlocks?.length ? { blocks: slackBlocks } : {}),
            threadTs: finalThreadTs,
          });
        } catch (err) {
          logVerbose(
            `slack: preview final edit failed; falling back to standard send (${formatSlackError(err)})`,
          );
          await draftStream.discardPending();
          let delivered = false;
          try {
            await deliverNormally({
              payload: payload.text?.trim()
                ? payload
                : {
                    ...payload,
                    // Keep presentation semantic here; deliverReplies adds its
                    // accessible chart summary exactly once.
                    text: ttsSupplement.spokenText,
                  },
              kind: info.kind,
              forcedThreadTs: finalThreadTs,
            });
            delivered = true;
          } finally {
            if (delivered) {
              await draftStream.clear();
            }
          }
          return;
        }
        draftPreviewCommitted = true;
        observedFinalReplyDelivery = true;
        observedReplyDelivery = true;
        replyPlan.markSent();
        await deliverNormally({
          payload: buildTtsSupplementMediaPayload(payload),
          kind: info.kind,
          forcedThreadTs: finalThreadTs,
        });
        markPreviewPayloadDelivered({ kind: info.kind, payload, threadTs: finalThreadTs });
        return;
      }
    }

    await deliverWithFinalizableLivePreviewAdapter({
      kind: info.kind,
      payload,
      adapter: defineFinalizableLivePreviewAdapter({
        draft:
          draftStream && !draftPreviewCommitted && !observedFinalReplyDelivery
            ? {
                flush: draftStream.flush,
                clear: draftStream.clear,
                discardPending: draftStream.discardPending,
                seal: draftStream.seal,
                id: () => {
                  const channelId = draftStream.channelId();
                  const messageId = draftStream.messageId();
                  return channelId && messageId ? { channelId, messageId } : undefined;
                },
              }
            : undefined,
        buildFinalEdit: () => {
          if (
            !previewStreamingEnabled ||
            (reply.hasMedia && !ttsSupplement) ||
            payload.isError ||
            requiresSeparateFallbackDelivery ||
            (trimmedFinalText.length === 0 && !slackBlocks?.length)
          ) {
            return undefined;
          }
          return {
            text: previewFinalText,
            blocks: slackBlocks,
            threadTs: usedReplyThreadTs ?? statusThreadTs,
          };
        },
        editFinal: async (preview, edit) => {
          if (deliveryTracker.hasDelivered({ kind: info.kind, payload, threadTs: edit.threadTs })) {
            return;
          }
          await finalizeSlackPreviewEdit({
            client: slackClient,
            token: ctx.botToken,
            accountId: account.accountId,
            channelId: preview.channelId,
            messageId: preview.messageId,
            text: edit.text,
            ...(edit.blocks?.length ? { blocks: edit.blocks } : {}),
            threadTs: edit.threadTs,
          });
          if (!ttsSupplement) {
            emitSlackMessageSentHooks({
              ...messageSentHookContext,
              to: messageSentHookTarget,
              accountId: account.accountId,
              content: trimmedFinalText,
              success: true,
              messageId: preview.messageId,
            });
          }
          draftPreviewCommitted = true;
          observedFinalReplyDelivery = true;
        },
        onPreviewFinalized: (_preview) => {
          // The preview edit promotes the draft message into the final answer.
          // Later same-turn payloads must not let fallback cleanup clear it.
          draftPreviewCommitted = true;
          observedFinalReplyDelivery = true;
          const finalThreadTs = usedReplyThreadTs ?? statusThreadTs;
          observedReplyDelivery = true;
          replyPlan.markSent();
          // Supplemental TTS media is the terminal delivery for the logical
          // payload. Marking the preview first would suppress that media send.
          if (!ttsSupplement) {
            markPreviewPayloadDelivered({ kind: info.kind, payload, threadTs: finalThreadTs });
          }
        },
        buildSupplementalPayload: () =>
          ttsSupplement ? buildTtsSupplementMediaPayload(payload) : undefined,
        deliverSupplemental: async (supplementalPayload) => {
          const previewThreadTs = usedReplyThreadTs ?? statusThreadTs;
          const supplementalThreadTs = await deliverNormally({
            payload: supplementalPayload,
            kind: info.kind,
            forcedThreadTs: previewThreadTs,
          });
          markPreviewPayloadDelivered({
            kind: info.kind,
            payload,
            threadTs: supplementalThreadTs,
          });
        },
        logPreviewEditFailure: (err) => {
          logVerbose(
            `slack: preview final edit failed; falling back to standard send (${formatSlackError(err)})`,
          );
        },
      }),
      deliverNormally: async () => {
        await deliverNormally({
          payload: shouldRestoreTtsSupplementTextForPreviewFallback
            ? {
                ...payload,
                text: ttsSupplement?.spokenText,
              }
            : payload,
          kind: info.kind,
        });
      },
    });
  };
  const onSlackDeliveryError = (err: unknown, info: { kind: string }) => {
    runtime.error?.(danger(`slack ${info.kind} reply failed: ${formatSlackError(err)}`));
    replyPipeline.typingCallbacks?.onIdle?.();
  };

  const draftStream = shouldUseDraftStream
    ? createSlackDraftStream({
        target: prepared.replyTarget,
        cfg,
        token: ctx.botToken,
        accountId: account.accountId,
        ...(prepared.eventScope ? { eventScope: prepared.eventScope } : {}),
        identity: slackIdentity,
        ...(slackMessageMetadata ? { metadata: slackMessageMetadata } : {}),
        maxChars: Math.min(ctx.textLimit, SLACK_TEXT_LIMIT),
        resolveThreadTs: () => {
          const ts = replyPlan.peekThreadTs();
          if (ts) {
            usedReplyThreadTs ??= ts;
          }
          return ts;
        },
        log: logVerbose,
        warn: logVerbose,
      })
    : undefined;
  let hasStreamedMessage = false;
  const streamMode = slackStreaming.draftMode;
  const useNativeProgressStreaming = useStreaming && slackStreaming.mode === "progress";
  const progressDraftActive = Boolean(draftStream) || useNativeProgressStreaming;
  const previewToolProgressEnabled =
    progressDraftActive && resolveChannelStreamingPreviewToolProgress(account.config);
  let shouldYieldDraftProgress: () => boolean = () => false;
  const suppressDefaultToolProgressMessages =
    resolveChannelStreamingSuppressDefaultToolProgressMessages(account.config, {
      draftStreamActive: Boolean(draftStream) || useNativeProgressStreaming,
      previewToolProgressEnabled,
      previewStreamingEnabled,
    });
  let previewToolProgressSuppressed = false;
  let legacyPreviewToolProgressLines: ChannelProgressDraftLine[] = [];
  // Last task rows emitted to the native stream; reconciliation terminalizes
  // ids that drop out (plan shrinks, tool-line <-> plan source switches).
  let nativeTaskState: SlackNativeTaskSnapshot = new Map();
  let appendRenderedText = "";
  let appendSourceText = "";
  let nativeProgressCompletionSent = false;
  // Terminal status of the turn's final payload; completion retries and
  // queued rotation must not repaint an errored turn as complete.
  let nativeProgressTerminalStatus: "complete" | "error" = "complete";
  let nativeProgressChunkKey: string | undefined;
  const progressReceipt = createChannelProgressReceiptTracker();
  let progressReceiptCollapsed = false;
  let pendingNativeProgressReceipt: string | undefined;
  const progressSeed = `${account.accountId}:${message.channel}`;
  const useRichProgressDraft =
    streamMode === "status_final" && resolveChannelProgressDraftRender(account.config) === "rich";
  const explicitProgressTitle = resolveExplicitSlackProgressTitle(account.config);
  const progressDraftMaxLineChars = resolveChannelProgressDraftMaxLineChars(account.config);

  const waitForNativeProgressStreamStart = async (): Promise<boolean> => {
    if (streamSession || !nativeProgressStreamStartPromise) {
      return true;
    }
    try {
      await nativeProgressStreamStartPromise;
    } catch {
      streamFailed = true;
      return false;
    }
    return !streamFailed;
  };

  const resolveStructuredProgressLines = (
    lines: readonly ChannelProgressDraftCompositorLine[],
  ): ChannelProgressDraftLine[] =>
    lines.map((line) => {
      if (typeof line !== "string") {
        return line;
      }
      const reasoning = line.startsWith("🧠 ");
      const text = line
        .replace(/^(?:🧠|💬)\s+/u, "")
        .replace(/^_(.*)_$/su, "$1")
        .trim();
      return {
        // Reasoning snapshots replace one rolling row; text-based ids would orphan it each delta.
        ...(reasoning ? { id: "reasoning" } : {}),
        kind: "item",
        text,
        label: reasoning ? "Reasoning" : "Update",
        prefix: false,
      };
    });

  // Native cards derive from the compositor snapshot. Empty plans fall back
  // to line tasks, and reconciliation retires rows from the prior source.
  const resolveNativeProgressPlan = (
    snapshot: ChannelProgressDraftCompositorSnapshot,
  ): readonly AgentPlanStep[] | undefined => (snapshot.plan?.length ? snapshot.plan : undefined);

  const resolveNativeProgressLines = (
    snapshot: ChannelProgressDraftCompositorSnapshot,
  ): ChannelProgressDraftLine[] => {
    const lines = resolveStructuredProgressLines(snapshot.lines);
    if (snapshot.plan?.length || !snapshot.planExplanation) {
      return lines;
    }
    const explanationLine = buildChannelProgressDraftLine({
      event: "plan",
      phase: "update",
      explanation: snapshot.planExplanation,
    });
    return explanationLine ? [...lines, explanationLine] : lines;
  };

  const combineProgressHeadlineAndExplanation = (
    headline: string | undefined,
    explanation: string | undefined,
  ) =>
    headline && explanation && headline !== explanation
      ? `${headline} — ${explanation}`
      : (headline ?? explanation);

  const resolveNativeProgressTitle = (snapshot: ChannelProgressDraftCompositorSnapshot) =>
    combineProgressHeadlineAndExplanation(
      explicitProgressTitle ?? snapshot.statusHeadline,
      snapshot.planExplanation,
    );

  const buildNativeProgressChunks = (snapshot: ChannelProgressDraftCompositorSnapshot) =>
    streamSession
      ? buildSlackProgressStreamUpdateChunks({
          title: resolveNativeProgressTitle(snapshot),
          lines: resolveNativeProgressLines(snapshot),
          plan: resolveNativeProgressPlan(snapshot),
          maxLineChars: progressDraftMaxLineChars,
        })
      : buildSlackProgressStreamStartChunks({
          title: resolveNativeProgressTitle(snapshot),
          lines: resolveNativeProgressLines(snapshot),
          plan: resolveNativeProgressPlan(snapshot),
          maxLineChars: progressDraftMaxLineChars,
        });

  const markNativeProgressDelivered = (session: SlackStreamSession, threadTs?: string) => {
    if (session.delivered) {
      observedReplyDelivery = true;
    }
    if (threadTs) {
      usedReplyThreadTs ??= threadTs;
      rememberDeliveredThreadTs("block", threadTs);
    }
  };

  const startNativeProgressStream = async (
    chunks: NonNullable<ReturnType<typeof buildSlackProgressStreamStartChunks>>,
    chunkKey: string,
  ) => {
    const streamThreadTs = replyPlan.nextThreadTs();
    if (!streamThreadTs) {
      logVerbose(
        "slack-stream: no reply thread target for native progress stream start, falling back",
      );
      streamFailed = true;
      return;
    }
    nativeProgressStreamThreadTs = streamThreadTs;
    const startPromise = (async () => {
      const session = await startSlackStream({
        client: slackClient,
        channel: message.channel,
        threadTs: streamThreadTs,
        chunks,
        taskDisplayMode: "plan",
        ...(slackIdentity ? { identity: slackIdentity } : {}),
        teamId: await resolveSlackStreamRecipientTeamId({
          client: slackClient,
          token: ctx.botToken,
          userId: message.user,
          fallbackTeamId: slackStreamFallbackTeamId,
        }),
        userId: message.user,
      });
      streamSession = session;
      return session;
    })();
    nativeProgressStreamStartPromise = startPromise;
    let startedSession: SlackStreamSession | null;
    try {
      startedSession = await startPromise;
    } finally {
      if (nativeProgressStreamStartPromise === startPromise) {
        nativeProgressStreamStartPromise = null;
      }
    }
    if (startedSession) {
      markNativeProgressDelivered(startedSession, streamThreadTs);
    }
    nativeProgressChunkKey = chunkKey;
    replyPlan.markSent();
  };

  const appendNativeProgressStream = async (
    chunks: NonNullable<ReturnType<typeof buildSlackProgressStreamUpdateChunks>>,
    chunkKey: string,
  ) => {
    if (!streamSession) {
      return;
    }
    await appendSlackStream({ session: streamSession, chunks });
    markNativeProgressDelivered(streamSession);
    nativeProgressChunkKey = chunkKey;
  };

  const updateNativeProgressStream = async () => {
    const snapshot = progressDraft.getSnapshot();
    const progressLines = resolveNativeProgressLines(snapshot);
    const hasRetirableNativeTasks = [...nativeTaskState.values()].some(
      (task) => task.status !== "complete" && task.status !== "error",
    );
    if (
      !useNativeProgressStreaming ||
      streamFailed ||
      (progressLines.length === 0 &&
        !snapshot.plan?.length &&
        !snapshot.statusHeadline &&
        !explicitProgressTitle &&
        !hasRetirableNativeTasks)
    ) {
      return;
    }
    const canContinue = await waitForNativeProgressStreamStart();
    if (!canContinue) {
      return;
    }
    const reconciled = reconcileSlackNativeTaskChunks({
      previousTasks: nativeTaskState,
      chunks: buildNativeProgressChunks(snapshot),
    });
    const chunks = reconciled.chunks;
    if (!chunks?.length) {
      return;
    }
    const chunkKey = JSON.stringify(chunks);
    if (chunkKey === nativeProgressChunkKey) {
      return;
    }
    try {
      if (!streamSession) {
        await startNativeProgressStream(chunks, chunkKey);
      } else {
        await appendNativeProgressStream(chunks, chunkKey);
      }
      // Commit only after Slack accepted the chunks; a failed emit must retry
      // the same reconciliation against the previous snapshot.
      nativeTaskState = reconciled.tasks;
    } catch (err) {
      runtime.error?.(
        danger(
          `slack-stream: native progress stream failed: ${formatSlackError(err)}, falling back`,
        ),
      );
      streamFailed = true;
    }
  };

  const resetProgressTurnState = () => {
    progressReceipt.reset();
    progressReceiptCollapsed = false;
    pendingNativeProgressReceipt = undefined;
  };

  const collapseProgressReceipt = async (
    params: Omit<Parameters<typeof finalizeSlackPreviewEdit>[0], "client" | "token" | "accountId">,
  ) => {
    const { botToken: token } = ctx;
    try {
      await finalizeSlackPreviewEdit({
        client: slackClient,
        token,
        accountId: account.accountId,
        ...params,
      });
      progressReceiptCollapsed = true;
    } catch (err) {
      logVerbose(`slack: progress receipt edit failed (${formatSlackError(err)})`);
    }
  };

  const progressDraft = createChannelProgressDraftCompositor({
    entry: account.config,
    mode: slackStreaming.mode,
    active: progressDraftActive && streamMode === "status_final",
    seed: progressSeed,
    formatLine: escapeSlackMrkdwn,
    reasoningLinePrefix: "🧠 ",
    commentaryLinePrefix: "💬 ",
    reasoningGate: previewToolProgressEnabled,
    commentaryItalics: false,
    updateOnLineChange: useNativeProgressStreaming || useRichProgressDraft,
    update: async (previewText, options) => {
      if (useNativeProgressStreaming) {
        await updateNativeProgressStream();
        return;
      }
      if (!draftStream) {
        return;
      }
      const snapshot = progressDraft.getSnapshot();
      const structuredLines = resolveStructuredProgressLines(options?.lines ?? snapshot.lines);
      const richNarration = combineProgressHeadlineAndExplanation(
        snapshot.statusHeadline,
        snapshot.planExplanation,
      );
      const richProgressBlocks = useRichProgressDraft
        ? buildSlackProgressDraftBlocks({
            title: explicitProgressTitle,
            lines: structuredLines,
            plan: snapshot.plan,
            narration: richNarration,
            maxLineChars: progressDraftMaxLineChars,
          })
        : undefined;
      draftStream.update(
        useRichProgressDraft && richProgressBlocks
          ? { text: previewText, blocks: richProgressBlocks }
          : previewText,
      );
      hasStreamedMessage = true;
      if (options?.flush) {
        await draftStream.flush();
      }
    },
  });
  const commentaryProgressEnabled = progressDraft.commentaryProgressEnabled;

  const buildNativeProgressCompletionChunks = (finalInProgressStatus: "complete" | "error") => {
    const snapshot = progressDraft.getSnapshot();
    const lines = resolveNativeProgressLines(snapshot);
    const hasRetirableNativeTasks = [...nativeTaskState.values()].some(
      (task) => task.status !== "complete" && task.status !== "error",
    );
    if (lines.length === 0 && !snapshot.plan?.length && !hasRetirableNativeTasks) {
      return undefined;
    }
    return reconcileSlackNativeTaskChunks({
      previousTasks: nativeTaskState,
      chunks: buildSlackProgressStreamCompletionChunks({
        title: resolveNativeProgressTitle(snapshot),
        lines,
        plan: resolveNativeProgressPlan(snapshot),
        maxLineChars: progressDraftMaxLineChars,
        finalInProgressStatus,
      }),
    }).chunks;
  };

  const finishNativeProgressTurn = async (
    completionChunks: ReturnType<typeof buildNativeProgressCompletionChunks>,
  ) => {
    if (nativeProgressStreamStartPromise) {
      await nativeProgressStreamStartPromise.catch(() => null);
    }
    const session = streamSession;
    if (session && !session.stopped) {
      try {
        if (completionChunks?.length) {
          nativeProgressCompletionSent = true;
        }
        const stopResult = await stopSlackStream({
          session,
          ...(completionChunks?.length ? { chunks: completionChunks } : {}),
          ...(slackMessageMetadata ? { metadata: slackMessageMetadata } : {}),
        });
        acknowledgeStoppedStreamedDeliveries(session, stopResult?.messageId);
        if (pendingNativeProgressReceipt && stopResult?.messageId) {
          await collapseProgressReceipt({
            channelId: session.channel,
            messageId: stopResult.messageId,
            text: pendingNativeProgressReceipt,
            threadTs: session.threadTs,
          });
        }
      } catch (err) {
        const error = formatSlackError(err);
        // stopSlackStream makes the one-shot session terminal before throwing.
        // Settle delivery bookkeeping before releasing that handle.
        emitAcknowledgedStreamedDeliveries();
        emitFailedPendingStreamedDeliveries(error);
        logVerbose(`slack-stream: failed to rotate native progress stream (${error})`);
      }
    }
    streamSession = null;
    nativeProgressStreamStartPromise = null;
    nativeProgressStreamThreadTs = undefined;
    streamFailed = false;
  };

  const pushPlanProgress = async (steps?: AgentPlanStep[], explanation?: string) => {
    if (streamMode === "status_final") {
      await progressDraft.pushPlanProgress(steps, { explanation });
      return;
    }
    if (previewToolProgressSuppressed || !draftStream) {
      return;
    }
    const text = formatChannelProgressDraftText({
      entry: account.config,
      lines: legacyPreviewToolProgressLines,
      seed: progressSeed,
      formatLine: escapeSlackMrkdwn,
      narration: explanation,
      plan: steps,
    });
    if (text) {
      draftStream.update(text);
      hasStreamedMessage = true;
    }
  };

  const pushPreviewProgress = async (
    line?: ChannelProgressDraftLine,
    options?: { toolName?: string },
  ) => {
    if (!draftStream && !useNativeProgressStreaming) {
      return;
    }
    if (options?.toolName !== undefined && !isChannelProgressDraftWorkToolName(options.toolName)) {
      return;
    }
    const normalized = line?.text.replace(/\s+/g, " ").trim();
    if (streamMode === "status_final") {
      if (!line || !normalized) {
        await progressDraft.noteActivity();
        return;
      }
      await progressDraft.pushToolProgress(line, options);
      return;
    }
    if (
      !line ||
      !normalized ||
      !draftStream ||
      !previewToolProgressEnabled ||
      previewToolProgressSuppressed
    ) {
      return;
    }
    const nextLines = mergeChannelProgressDraftLine(legacyPreviewToolProgressLines, line, {
      maxLines: resolveChannelProgressDraftMaxLines(account.config),
    });
    if (nextLines === legacyPreviewToolProgressLines) {
      return;
    }
    legacyPreviewToolProgressLines = nextLines;
    draftStream.update(
      formatChannelProgressDraftText({
        entry: account.config,
        lines: legacyPreviewToolProgressLines,
        seed: progressSeed,
        formatLine: escapeSlackMrkdwn,
      }),
    );
    hasStreamedMessage = true;
  };

  const updateDraftFromPartial = (text?: string) => {
    const trimmed = text?.trimEnd();
    if (!trimmed) {
      return;
    }

    if (streamMode === "append") {
      previewToolProgressSuppressed = true;
      legacyPreviewToolProgressLines = [];
      const next = applyAppendOnlyStreamUpdate({
        incoming: trimmed,
        rendered: appendRenderedText,
        source: appendSourceText,
      });
      appendRenderedText = next.rendered;
      appendSourceText = next.source;
      if (!next.changed) {
        return;
      }
      draftStream?.update(next.rendered);
      hasStreamedMessage = true;
      return;
    }

    if (streamMode === "status_final") {
      return;
    }

    previewToolProgressSuppressed = true;
    legacyPreviewToolProgressLines = [];
    draftStream?.update(trimmed);
    hasStreamedMessage = true;
  };
  const pushReasoningProgress = async (payload?: {
    text?: string;
    isReasoningSnapshot?: boolean;
  }) => {
    if (!payload?.text) {
      return;
    }
    if (streamMode !== "status_final") {
      const normalized = progressDraft
        .mergeReasoningProgress(payload.text, {
          snapshot: payload.isReasoningSnapshot === true,
        })
        .replace(/^_(.*)_$/su, "$1")
        .trim();
      if (!normalized) {
        return;
      }
      await pushPreviewProgress({
        id: "reasoning",
        kind: "item",
        text: normalized,
        label: "Reasoning",
      });
      return;
    }
    progressReceipt.noteReasoning();
    await progressDraft.pushReasoningProgress(payload.text, {
      snapshot: payload.isReasoningSnapshot === true,
    });
  };
  const resetDraftDeliveryState = () => {
    hasStreamedMessage = false;
    appendRenderedText = "";
    appendSourceText = "";
  };
  const resetDraftProgressState = () => {
    progressDraft.resetReasoningProgress();
    previewToolProgressSuppressed = false;
    legacyPreviewToolProgressLines = [];
  };
  const beginNewProgressTurn = async (options?: { force?: boolean }) => {
    const completionChunks =
      useNativeProgressStreaming && !nativeProgressCompletionSent
        ? buildNativeProgressCompletionChunks(nativeProgressTerminalStatus)
        : undefined;
    if (!progressDraft.beginNewTurn(options)) {
      return false;
    }
    // Native messages are one-shot streams. Stop the prior turn before the
    // reset compositor can publish the queued turn's first snapshot.
    if (useNativeProgressStreaming) {
      await finishNativeProgressTurn(completionChunks);
    } else {
      draftStream?.forceNewMessage();
    }
    resetProgressTurnState();
    nativeTaskState = new Map();
    nativeProgressCompletionSent = false;
    nativeProgressTerminalStatus = "complete";
    nativeProgressChunkKey = undefined;
    // A re-armed turn is a new visible reply: it must not dedupe against or
    // inherit delivery state from the settled turn (mirrors queued admission).
    draftPreviewCommitted = false;
    observedFinalReplyDelivery = false;
    deliveryTracker = createSlackEventDeliveryTracker();
    progressReceiptCollapsed = false;
    return true;
  };
  const onDraftBoundary =
    !shouldUseDraftStream && !useNativeProgressStreaming
      ? undefined
      : async () => {
          if (streamMode === "status_final") {
            await beginNewProgressTurn();
            return;
          }
          if (hasStreamedMessage) {
            draftStream?.forceNewMessage();
          }
          resetDraftDeliveryState();
          resetDraftProgressState();
        };

  const onQueuedFollowupAdmitted =
    !shouldUseDraftStream && !useNativeProgressStreaming
      ? undefined
      : async () => {
          // A queued input is a new visible reply even though it drains through
          // this turn's callbacks. Do not let it edit or dedupe against this run.
          await draftStream?.flush();
          draftPreviewCommitted = false;
          observedFinalReplyDelivery = false;
          if (streamMode === "status_final") {
            await beginNewProgressTurn({ force: true });
          } else {
            draftStream?.forceNewMessage();
          }
          deliveryTracker = createSlackEventDeliveryTracker();
          resetDraftDeliveryState();
          resetDraftProgressState();
        };

  let dispatchError: unknown;
  let queuedFinal = false;
  let counts: Partial<Record<ReplyDispatchKind, number>> = {};
  try {
    const turnResult = await dispatchChannelInboundTurn({
      cfg,
      channel: "slack",
      accountId: route.accountId,
      route: { agentId: route.agentId, sessionKey: route.sessionKey },
      ctxPayload: prepared.ctxPayload,
      dispatcherOptions: {
        ...replyPipeline,
        humanDelay: resolveHumanDelayConfig(cfg, route.agentId),
      },
      delivery: {
        deliver: deliverSlackPayload,
        onError: onSlackDeliveryError,
      },
      record: prepared.turn.record as InboundReplyRecordOptions,
      history: prepared.turn.history,
      botLoopProtection: resolveSlackBotLoopProtection(prepared),
      replyOptions: {
        ...(prepared.turnAdoptionLifecycle
          ? { turnAdoptionLifecycle: prepared.turnAdoptionLifecycle }
          : {}),
        skillFilter: prepared.channelConfig?.skills,
        sourceReplyDeliveryMode,
        // Room events are observe-style turns; Slack status indicators imply an
        // automatic visible reply and can auto-open assistant threads.
        suppressTyping: suppressRoomEventTyping ? true : undefined,
        hasRepliedRef,
        disableBlockStreaming,
        onModelSelected,
        suppressDefaultToolProgressMessages: suppressDefaultToolProgressMessages ? true : undefined,
        commentaryProgressEnabled: commentaryProgressEnabled ? true : undefined,
        progressPreambleEnabled:
          progressDraftActive && slackStreaming.mode === "progress" ? true : undefined,
        commentaryPayloadsEnabled: commentaryProgressEnabled ? true : undefined,
        onVerboseProgressVisibility: commentaryProgressEnabled
          ? (isActive) => {
              shouldYieldDraftProgress = isActive;
            }
          : undefined,
        allowProgressCallbacksWhenSourceDeliverySuppressed:
          sourceReplyDeliveryMode === "message_tool_only" && statusReactionsEnabled
            ? true
            : undefined,
        allowToolLifecycleWhenProgressHidden: statusReactionsEnabled ? true : undefined,
        onPartialReply: useStreaming
          ? undefined
          : !previewStreamingEnabled
            ? undefined
            : async (payload) => {
                updateDraftFromPartial(payload.text);
              },
        onAssistantMessageStart: onDraftBoundary,
        onReasoningEnd: async () => {
          progressReceipt.closeReasoning();
          await onDraftBoundary?.();
        },
        onQueuedFollowupAdmitted,
        onReasoningStream:
          statusReactionsEnabled || previewToolProgressEnabled
            ? async (payload) => {
                await pushReasoningProgress(payload);
                if (!statusReactionsEnabled) {
                  return;
                }
                await statusReactions.setThinking();
              }
            : undefined,
        onToolStart: async (payload) => {
          if (statusReactionsEnabled) {
            await statusReactions.setTool(payload.name);
          }
          if (payload.phase === "start") {
            progressReceipt.noteToolCall(payload.name);
          }
          await pushPreviewProgress(
            buildChannelProgressDraftLineForEntry(
              account.config,
              {
                event: "tool",
                itemId: payload.itemId,
                toolCallId: payload.toolCallId,
                name: payload.name,
                phase: payload.phase,
                args: payload.args,
              },
              payload.detailMode ? { detailMode: payload.detailMode } : undefined,
            ),
            { toolName: payload.name },
          );
        },
        onItemEvent: async (payload) => {
          if (streamMode === "status_final" && payload.kind === "preamble") {
            if (shouldYieldDraftProgress()) {
              return;
            }
            await progressDraft.pushPreambleHeadline(payload.progressText, {
              itemId: payload.itemId,
            });
            if (commentaryProgressEnabled) {
              const accepted = await progressDraft.pushCommentaryProgress(payload.progressText, {
                itemId: payload.itemId,
              });
              if (accepted) {
                progressReceipt.noteCommentary(payload.itemId, payload.progressText);
              }
            }
            return;
          }
          await pushPreviewProgress(
            buildChannelProgressDraftLineForEntry(account.config, {
              event: "item",
              itemId: payload.itemId,
              toolCallId: payload.toolCallId,
              itemKind: payload.kind,
              title: payload.title,
              name: payload.name,
              phase: payload.phase,
              status: payload.status,
              summary: payload.summary,
              progressText: payload.progressText,
              meta: payload.meta,
            }),
          );
        },
        onPlanUpdate: async (payload) => {
          if (payload.phase !== "update") {
            return;
          }
          await pushPlanProgress(payload.steps, payload.explanation);
        },
        onApprovalEvent: async (payload) => {
          if (payload.phase !== "requested") {
            return;
          }
          await pushPreviewProgress(
            buildChannelProgressDraftLine({
              event: "approval",
              phase: payload.phase,
              title: payload.title,
              command: payload.command,
              reason: payload.reason,
              message: payload.message,
            }),
          );
        },
        onCommandOutput: async (payload) => {
          if (payload.phase !== "end") {
            return;
          }
          await pushPreviewProgress(
            buildChannelProgressDraftLine({
              event: "command-output",
              itemId: payload.itemId,
              toolCallId: payload.toolCallId,
              phase: payload.phase,
              title: payload.title,
              name: payload.name,
              status: payload.status,
              exitCode: payload.exitCode,
            }),
          );
        },
        onPatchSummary: async (payload) => {
          if (payload.phase !== "end") {
            return;
          }
          await pushPreviewProgress(
            buildChannelProgressDraftLine({
              event: "patch",
              itemId: payload.itemId,
              toolCallId: payload.toolCallId,
              phase: payload.phase,
              title: payload.title,
              name: payload.name,
              added: payload.added,
              modified: payload.modified,
              deleted: payload.deleted,
              summary: payload.summary,
            }),
          );
        },
      },
    });
    if (turnResult.dispatched) {
      const result = turnResult.dispatchResult;
      queuedFinal = result.queuedFinal;
      counts = result.counts;
    }
  } catch (err) {
    dispatchError = err;
  } finally {
    progressDraft.cancel();
    await draftStream?.discardPending();
  }

  // -----------------------------------------------------------------------
  // Finalize the stream if one was started
  // -----------------------------------------------------------------------
  let streamFallbackDelivered = false;
  const finalStream = streamSession as SlackStreamSession | null;
  if (finalStream && !finalStream.stopped) {
    try {
      const completionChunks =
        useNativeProgressStreaming && !nativeProgressCompletionSent
          ? buildNativeProgressCompletionChunks(
              dispatchError ? "error" : nativeProgressTerminalStatus,
            )
          : undefined;
      if (completionChunks?.length) {
        nativeProgressCompletionSent = true;
      }
      const stopResult = await stopSlackStream({
        session: finalStream,
        ...(completionChunks?.length ? { chunks: completionChunks } : {}),
        ...(slackMessageMetadata ? { metadata: slackMessageMetadata } : {}),
      });
      // The stream finalized successfully, flushing any buffered text to Slack.
      // Emit the `message_sent` plugin hook for every streamed reply payload
      // here (the streaming happy-path never goes through deliverReplies, which
      // emits for the non-streaming/fallback paths). emitSlackMessageSentHooks
      // self-gates on registered listeners, so this is a no-op when unused.
      acknowledgeStoppedStreamedDeliveries(finalStream, stopResult?.messageId);
      if (pendingNativeProgressReceipt && stopResult?.messageId && !progressReceiptCollapsed) {
        await collapseProgressReceipt({
          channelId: finalStream.channel,
          messageId: stopResult.messageId,
          text: pendingNativeProgressReceipt,
          threadTs: finalStream.threadTs,
        });
      }
    } catch (err) {
      if (err instanceof SlackStreamNotDeliveredError) {
        streamFallbackDelivered = await deliverPendingStreamFallback(finalStream, err);
        if (!streamFallbackDelivered) {
          dispatchError ??= err;
        }
      } else {
        const error = formatSlackError(err);
        emitAcknowledgedStreamedDeliveries();
        emitFailedPendingStreamedDeliveries(error);
        runtime.error?.(danger(`slack-stream: failed to stop stream: ${error}`));
        if (!finalStream.delivered) {
          dispatchError ??= err;
        }
      }
    }
  }

  for (const kind of ["tool", "block", "final"] as const) {
    const failedStreamedCount = streamedDeliveries.filter(
      (delivery) => delivery.kind === kind && delivery.outcome === "failure",
    ).length;
    const additionalFailedStreamed = Math.max(
      0,
      failedStreamedCount - streamedFailuresOwnedByDispatcher[kind],
    );
    if (additionalFailedStreamed > 0) {
      counts = {
        ...counts,
        [kind]: Math.max(0, (counts[kind] ?? 0) - additionalFailedStreamed),
      };
    }
  }
  queuedFinal = queuedFinal && (counts.final ?? 0) > 0;

  const anyReplyDelivered = hasVisibleInboundReplyDispatch(
    { queuedFinal, counts },
    {
      observedReplyDelivery,
      fallbackDelivered: streamFallbackDelivered,
    },
  );

  if (statusReactionsEnabled) {
    if (dispatchError) {
      await statusReactions.setError();
      if (ctx.removeAckAfterReply) {
        void (async () => {
          await sleep(statusReactionTiming.errorHoldMs);
          if (anyReplyDelivered) {
            await statusReactions.clear();
          }
        })();
      }
    } else if (anyReplyDelivered) {
      await statusReactions.setDone();
      if (ctx.removeAckAfterReply) {
        void (async () => {
          await sleep(statusReactionTiming.doneHoldMs);
          await statusReactions.clear();
        })();
      } else {
        void statusReactions.restoreInitial();
      }
    } else {
      // Silent success should preserve queued state and clear any stall timers
      // instead of transitioning to terminal/stall reactions after return.
      await statusReactions.restoreInitial();
    }
  }

  // Record thread participation only when we actually delivered a reply and
  // know the thread ts that was used (set by deliverNormally, streaming start,
  // or draft stream). Falls back to statusThreadTs for edge cases.
  const participationThreadTs = usedReplyThreadTs ?? statusThreadTs;
  if (anyReplyDelivered && participationThreadTs) {
    recordSlackThreadParticipation(account.accountId, message.channel, participationThreadTs, {
      agentId: route.agentId,
      ...(prepared.eventScope ? { teamId: prepared.eventScope.teamId } : {}),
    });
  }
  if (dispatchError) {
    throw toLintErrorObject(dispatchError, "Slack dispatch failed");
  }
  if (!anyReplyDelivered && !draftPreviewCommitted) {
    await draftStream?.clear();
    return;
  }

  if (shouldLogVerbose()) {
    const finalCount = counts.final;
    logVerbose(
      `slack: delivered ${finalCount} reply${finalCount === 1 ? "" : "ies"} to ${prepared.replyTarget}`,
    );
  }

  if (!statusReactionsEnabled) {
    removeAckReactionAfterReply({
      removeAfterReply: ctx.removeAckAfterReply && anyReplyDelivered,
      ackReactionPromise: prepared.ackReactionPromise,
      ackReactionValue: prepared.ackReactionValue,
      remove: () =>
        removeSlackReaction(
          message.channel,
          prepared.ackReactionMessageTs ?? "",
          prepared.ackReactionValue,
          {
            token: ctx.botToken,
            client: slackClient,
          },
        ),
      onError: (err) => {
        logAckFailure({
          log: logVerbose,
          channel: "slack",
          target: `${message.channel}/${message.ts}`,
          error: err,
        });
      },
    });
  }
}

function toLintErrorObject(value: unknown, fallbackMessage: string): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  const error = new Error(fallbackMessage, { cause: value });
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.assign(error, value);
  }
  return error;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
