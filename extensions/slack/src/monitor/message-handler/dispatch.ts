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
  createChannelMessageReplyPipeline,
  defineFinalizableLivePreviewAdapter,
  deliverWithFinalizableLivePreviewAdapter,
  resolveChannelMessageSourceReplyDeliveryMode,
} from "openclaw/plugin-sdk/channel-message";
import {
  buildChannelProgressDraftLine,
  buildChannelProgressDraftLineForEntry,
  createChannelProgressDraftGate,
  formatChannelProgressDraftText,
  isChannelProgressDraftWorkToolName,
  resolveChannelProgressDraftMaxLines,
  resolveChannelProgressDraftLabel,
  resolveChannelProgressDraftRender,
  resolveChannelStreamingBlockEnabled,
  resolveChannelStreamingNativeTransport,
  resolveChannelStreamingPreviewToolProgress,
  resolveChannelStreamingSuppressDefaultToolProgressMessages,
  type ChannelProgressDraftLine,
} from "openclaw/plugin-sdk/channel-streaming";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  type ChannelBotLoopProtectionFacts,
  type ChannelTurnRecordOptions,
  hasVisibleInboundReplyDispatch,
  runInboundReplyTurn,
} from "openclaw/plugin-sdk/inbound-reply-dispatch";
import { resolveAgentOutboundIdentity } from "openclaw/plugin-sdk/outbound-runtime";
import { mergePairLoopGuardConfig } from "openclaw/plugin-sdk/pair-loop-guard-runtime";
import { clearHistoryEntriesIfEnabled } from "openclaw/plugin-sdk/reply-history";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
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
import { buildSlackProgressDraftBlocks } from "../../progress-blocks.js";
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
import { recordInboundSession } from "../conversation.runtime.js";
import { escapeSlackMrkdwn } from "../mrkdwn.js";
import {
  createSlackReplyDeliveryPlan,
  deliverReplies,
  readSlackReplyBlocks,
  resolveDeliveredSlackReplyThreadTs,
  resolveSlackThreadTs,
} from "../replies.js";
import {
  createReplyDispatcherWithTyping,
  dispatchInboundMessage,
  settleReplyDispatcher,
} from "../reply.runtime.js";
import { finalizeSlackPreviewEdit } from "./preview-finalize.js";
import type { PreparedSlackMessage } from "./types.js";

// Slack reactions.add/remove expect shortcode names, not raw unicode emoji.
const UNICODE_TO_SLACK: Record<string, string> = {
  "👀": "eyes",
  "🤔": "thinking_face",
  "🔥": "fire",
  "👨‍💻": "male-technologist",
  "👨💻": "male-technologist",
  "👩‍💻": "female-technologist",
  "⚡": "zap",
  "🌐": "globe_with_meridians",
  "✅": "white_check_mark",
  "👍": "thumbsup",
  "❌": "x",
  "😱": "scream",
  "🥱": "yawning_face",
  "😨": "fearful",
  "⏳": "hourglass_flowing_sand",
  "⚠️": "warning",
  "✍": "writing_hand",
  "🧠": "brain",
  "🛠️": "hammer_and_wrench",
  "💻": "computer",
};

function resolveSlackMessageTimestampMs(message: SlackMessageEvent): number | undefined {
  const ts = message.event_ts ?? message.ts;
  if (!ts) {
    return undefined;
  }
  const parsed = Number(ts);
  return Number.isFinite(parsed) ? Math.trunc(parsed * 1000) : undefined;
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

function toSlackEmojiName(emoji: string): string {
  let trimmed = emoji.trim();
  while (trimmed.startsWith(":")) {
    trimmed = trimmed.slice(1);
  }
  while (trimmed.endsWith(":")) {
    trimmed = trimmed.slice(0, -1);
  }
  return UNICODE_TO_SLACK[trimmed] ?? trimmed;
}

export function isSlackStreamingEnabled(params: {
  mode: "off" | "partial" | "block" | "progress";
  nativeStreaming: boolean;
}): boolean {
  if (params.mode !== "partial") {
    return false;
  }
  return params.nativeStreaming;
}

export function shouldEnableSlackPreviewStreaming(params: {
  mode: "off" | "partial" | "block" | "progress";
}): boolean {
  return params.mode !== "off";
}

export function shouldInitializeSlackDraftStream(params: {
  previewStreamingEnabled: boolean;
  useStreaming: boolean;
}): boolean {
  return params.previewStreamingEnabled && !params.useStreaming;
}

export function resolveSlackDisableBlockStreaming(params: {
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

export function resolveSlackStreamingThreadHint(params: {
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

type SlackTurnDeliveryAttempt = {
  kind: ReplyDispatchKind;
  payload: ReplyPayload;
  threadTs?: string;
  textOverride?: string;
};

const SLACK_STREAM_RECIPIENT_TEAM_CACHE_MAX = 2000;
const slackStreamRecipientTeamCache = new Map<string, string>();

function buildSlackTurnDeliveryKey(params: SlackTurnDeliveryAttempt): string | null {
  const reply = resolveSendableOutboundReplyParts(params.payload, {
    text: params.textOverride,
  });
  const slackBlocks = readSlackReplyBlocks(params.payload);
  if (!reply.hasContent && !slackBlocks?.length) {
    return null;
  }
  return JSON.stringify({
    kind: params.kind,
    threadTs: params.threadTs ?? "",
    replyToId: params.payload.replyToId ?? null,
    text: reply.trimmedText,
    mediaUrls: reply.mediaUrls,
    blocks: slackBlocks ?? null,
  });
}

function readSlackStreamRecipientTeamCache(params: {
  fallbackTeamId?: string;
  userId?: string;
}): string | undefined {
  if (!params.fallbackTeamId || !params.userId) {
    return undefined;
  }
  const cacheKey = `${params.fallbackTeamId}:${params.userId}`;
  const cached = slackStreamRecipientTeamCache.get(cacheKey);
  if (!cached) {
    return undefined;
  }
  slackStreamRecipientTeamCache.delete(cacheKey);
  slackStreamRecipientTeamCache.set(cacheKey, cached);
  return cached;
}

function rememberSlackStreamRecipientTeam(params: {
  fallbackTeamId?: string;
  userId?: string;
  teamId: string;
}): void {
  if (!params.fallbackTeamId || !params.userId) {
    return;
  }
  const cacheKey = `${params.fallbackTeamId}:${params.userId}`;
  if (slackStreamRecipientTeamCache.has(cacheKey)) {
    slackStreamRecipientTeamCache.delete(cacheKey);
  }
  slackStreamRecipientTeamCache.set(cacheKey, params.teamId);
  if (slackStreamRecipientTeamCache.size > SLACK_STREAM_RECIPIENT_TEAM_CACHE_MAX) {
    const oldest = slackStreamRecipientTeamCache.keys().next().value;
    if (oldest) {
      slackStreamRecipientTeamCache.delete(oldest);
    }
  }
}

export function resetSlackStreamRecipientTeamCacheForTests(): void {
  slackStreamRecipientTeamCache.clear();
}

export function createSlackTurnDeliveryTracker() {
  const deliveredKeys = new Set<string>();
  return {
    hasDelivered(params: SlackTurnDeliveryAttempt) {
      const key = buildSlackTurnDeliveryKey(params);
      return key ? deliveredKeys.has(key) : false;
    },
    markDelivered(params: SlackTurnDeliveryAttempt) {
      const key = buildSlackTurnDeliveryKey(params);
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

export async function resolveSlackStreamRecipientTeamId(params: {
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
    : undefined;

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
    const skipMainUpdate =
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
        sessionKey: resolveInboundLastRouteSessionKey({
          route,
          sessionKey: prepared.ctxPayload.SessionKey ?? route.sessionKey,
        }),
        deliveryContext: {
          channel: "slack",
          to: `user:${message.user}`,
          accountId: route.accountId,
          threadId: prepared.ctxPayload.MessageThreadId,
        },
        ctx: prepared.ctxPayload,
      });
    }
  }

  const { statusThreadTs, isThreadReply } = resolveSlackThreadTargets({
    message,
    replyToMode: prepared.replyToMode,
  });
  const sourceReplyDeliveryMode = resolveChannelMessageSourceReplyDeliveryMode({
    cfg,
    ctx: prepared.ctxPayload,
  });
  const sourceRepliesAreToolOnly = sourceReplyDeliveryMode === "message_tool_only";

  const reactionMessageTs = prepared.ackReactionMessageTs;
  const messageTs = message.ts ?? message.event_ts;
  const incomingThreadTs = message.thread_ts;
  let didSetStatus = false;
  const statusReactionsEnabled =
    Boolean(prepared.ackReactionPromise) &&
    Boolean(reactionMessageTs) &&
    cfg.messages?.statusReactions?.enabled !== false;
  const slackStatusAdapter: StatusReactionAdapter = {
    setReaction: async (emoji) => {
      await reactSlackMessage(message.channel, reactionMessageTs ?? "", toSlackEmojiName(emoji), {
        token: ctx.botToken,
        client: ctx.app.client,
      }).catch((err) => {
        if (formatErrorMessage(err).includes("already_reacted")) {
          return;
        }
        throw err;
      });
    },
    removeReaction: async (emoji) => {
      await removeSlackReaction(message.channel, reactionMessageTs ?? "", toSlackEmojiName(emoji), {
        token: ctx.botToken,
        client: ctx.app.client,
      }).catch((err) => {
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
    replyToMode: prepared.replyToMode,
    incomingThreadTs,
    messageTs,
    hasRepliedRef,
    isThreadReply,
  });

  const typingTarget = statusThreadTs ? `${message.channel}/${statusThreadTs}` : message.channel;
  const typingReaction = ctx.typingReaction;
  const { onModelSelected, ...replyPipeline } = createChannelMessageReplyPipeline({
    cfg,
    agentId: route.agentId,
    channel: "slack",
    accountId: route.accountId,
    transformReplyPayload: (payload) =>
      isSlackInteractiveRepliesEnabled({ cfg, accountId: route.accountId })
        ? compileSlackInteractiveReplies(payload)
        : payload,
    typing: {
      start: async () => {
        didSetStatus = true;
        await ctx.setSlackThreadStatus({
          channelId: message.channel,
          threadTs: statusThreadTs,
          status: "is typing...",
        });
        if (typingReaction && message.ts) {
          await reactSlackMessage(message.channel, message.ts, typingReaction, {
            token: ctx.botToken,
            client: ctx.app.client,
          }).catch(() => {});
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
        });
        if (typingReaction && message.ts) {
          await removeSlackReaction(message.channel, message.ts, typingReaction, {
            token: ctx.botToken,
            client: ctx.app.client,
          }).catch(() => {});
        }
      },
      onStartError: (err) => {
        logTypingFailure({
          log: (message) => runtime.error?.(danger(message)),
          channel: "slack",
          action: "start",
          target: typingTarget,
          error: err,
        });
      },
      onStopError: (err) => {
        logTypingFailure({
          log: (message) => runtime.error?.(danger(message)),
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
  const streamThreadHint = resolveSlackStreamingThreadHint({
    replyToMode: prepared.replyToMode,
    incomingThreadTs,
    messageTs,
    isThreadReply,
  });
  const previewStreamingEnabled =
    !sourceRepliesAreToolOnly &&
    shouldEnableSlackPreviewStreaming({
      mode: slackStreaming.mode,
    });
  const streamingEnabled =
    !sourceRepliesAreToolOnly &&
    isSlackStreamingEnabled({
      mode: slackStreaming.mode,
      nativeStreaming: slackStreaming.nativeStreaming,
    });
  const useStreaming = shouldUseStreaming({
    streamingEnabled,
    threadTs: streamThreadHint,
  });
  const shouldUseDraftStream = shouldInitializeSlackDraftStream({
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
  let streamFailed = false;
  let usedReplyThreadTs: string | undefined;
  let usedBlockReplyThreadTs: string | undefined;
  let observedReplyDelivery = false;
  const deliveryTracker = createSlackTurnDeliveryTracker();
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
    // The Slack SDK still owns this text in-memory; no streaming API call has
    // acknowledged it. Route through deliverReplies so pendingText that
    // exceeds Slack's per-message text limit still lands (a single
    // chat.postMessage would have failed with msg_too_long), and so the
    // fallback respects the configured replyToMode/identity the same way
    // normal replies do.
    const fallbackText = err.pendingText.trim();
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
        replyThreadTs: session.threadTs,
        replyToMode: prepared.replyToMode,
        ...(slackIdentity ? { identity: slackIdentity } : {}),
      });
      markSlackStreamFallbackDelivered(session);
      observedReplyDelivery = true;
      usedReplyThreadTs ??= session.threadTs;
      logVerbose(
        `slack-stream: streamed delivery failed (${err.slackCode}); delivered ${fallbackText.length} chars via deliverReplies fallback`,
      );
      return true;
    } catch (postErr) {
      runtime.error?.(
        danger(
          `slack-stream: fallback deliverReplies failed after ${err.slackCode}: ${formatErrorMessage(postErr)}`,
        ),
      );
      return false;
    }
  };

  const deliverNormally = async (params: {
    payload: ReplyPayload;
    kind: ReplyDispatchKind;
    forcedThreadTs?: string;
  }): Promise<void> => {
    const replyThreadTs = resolveDeliveryThreadTs(params);
    if (
      deliveryTracker.hasDelivered({
        kind: params.kind,
        payload: params.payload,
        threadTs: replyThreadTs,
      })
    ) {
      logVerbose("slack: suppressed duplicate normal delivery within the same turn");
      return;
    }
    await deliverReplies({
      cfg: ctx.cfg,
      replies: [params.payload],
      target: prepared.replyTarget,
      token: ctx.botToken,
      accountId: account.accountId,
      runtime,
      textLimit: ctx.textLimit,
      replyThreadTs,
      replyToMode: prepared.replyToMode,
      ...(slackIdentity ? { identity: slackIdentity } : {}),
    });
    observedReplyDelivery = true;
    const deliveredThreadTs = resolveDeliveredSlackReplyThreadTs({
      replyToMode: prepared.replyToMode,
      payloadReplyToId: params.payload.replyToId,
      replyThreadTs,
    });
    // Record the thread ts only after confirmed delivery success.
    rememberDeliveredThreadTs(params.kind, deliveredThreadTs);
    replyPlan.markSent();
    deliveryTracker.markDelivered({
      kind: params.kind,
      payload: params.payload,
      threadTs: replyThreadTs,
    });
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
      return false;
    }
    replyPlan.markSent();
    deliveryTracker.markDelivered({
      kind: params.kind,
      payload: params.payload,
      threadTs: params.session.threadTs,
      textOverride: params.textOverride,
    });
    rememberDeliveredThreadTs(params.kind, params.session.threadTs);
    return true;
  };

  const deliverWithStreaming = async (params: {
    payload: ReplyPayload;
    kind: ReplyDispatchKind;
  }): Promise<void> => {
    if (params.payload.isReasoning === true) {
      return;
    }
    const reply = resolveSendableOutboundReplyParts(params.payload);
    if (
      streamFailed ||
      reply.hasMedia ||
      readSlackReplyBlocks(params.payload)?.length ||
      !reply.hasText
    ) {
      await deliverNormally({
        payload: params.payload,
        kind: params.kind,
        forcedThreadTs: streamSession?.threadTs,
      });
      return;
    }

    const text = reply.trimmedText;
    let plannedThreadTs: string | undefined;
    try {
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
          client: ctx.app.client,
          channel: message.channel,
          threadTs: streamThreadTs,
          text,
          teamId: await resolveSlackStreamRecipientTeamId({
            client: ctx.app.client,
            token: ctx.botToken,
            userId: message.user,
            fallbackTeamId: ctx.teamId,
          }),
          userId: message.user,
        });
        // startSlackStream may only buffer locally. Count delivery only after
        // the SDK reports a real Slack response.
        if (streamSession.delivered) {
          observedReplyDelivery = true;
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

      await appendSlackStream({
        session: streamSession,
        text: "\n" + text,
      });
      // appendSlackStream also buffers locally below the SDK threshold; avoid
      // optimistic "done" status until Slack acknowledges a flush.
      if (streamSession.delivered) {
        observedReplyDelivery = true;
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
      }
      await deliverNormally({
        payload: params.payload,
        kind: params.kind,
        forcedThreadTs: streamSession?.threadTs ?? plannedThreadTs,
      });
    }
  };

  const { dispatcher, replyOptions, markDispatchIdle } = createReplyDispatcherWithTyping({
    ...replyPipeline,
    humanDelay: resolveHumanDelayConfig(cfg, route.agentId),
    deliver: async (payload, info) => {
      if (useStreaming) {
        await deliverWithStreaming({ payload, kind: info.kind });
        return;
      }

      const reply = resolveSendableOutboundReplyParts(payload);
      const slackBlocks = readSlackReplyBlocks(payload);
      const trimmedFinalText = reply.trimmedText;

      const result = await deliverWithFinalizableLivePreviewAdapter({
        kind: info.kind,
        payload,
        adapter: defineFinalizableLivePreviewAdapter({
          draft: draftStream
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
              reply.hasMedia ||
              payload.isError ||
              (trimmedFinalText.length === 0 && !slackBlocks?.length)
            ) {
              return undefined;
            }
            return {
              text: normalizeSlackOutboundText(trimmedFinalText),
              blocks: slackBlocks,
              threadTs: usedReplyThreadTs ?? statusThreadTs,
            };
          },
          editFinal: async (preview, edit) => {
            if (
              deliveryTracker.hasDelivered({ kind: info.kind, payload, threadTs: edit.threadTs })
            ) {
              return;
            }
            await finalizeSlackPreviewEdit({
              client: ctx.app.client,
              token: ctx.botToken,
              accountId: account.accountId,
              channelId: preview.channelId,
              messageId: preview.messageId,
              text: edit.text,
              ...(edit.blocks?.length ? { blocks: edit.blocks } : {}),
              threadTs: edit.threadTs,
            });
          },
          onPreviewFinalized: (_preview) => {
            const finalThreadTs = usedReplyThreadTs ?? statusThreadTs;
            observedReplyDelivery = true;
            replyPlan.markSent();
            deliveryTracker.markDelivered({ kind: info.kind, payload, threadTs: finalThreadTs });
          },
          logPreviewEditFailure: (err) => {
            logVerbose(
              `slack: preview final edit failed; falling back to standard send (${formatSlackError(err)})`,
            );
          },
        }),
        deliverNormally: async () => {
          await deliverNormally({
            payload,
            kind: info.kind,
          });
        },
      });

      if (result.kind === "preview-finalized") {
        return;
      }
    },
    onError: (err, info) => {
      runtime.error?.(danger(`slack ${info.kind} reply failed: ${formatSlackError(err)}`));
      replyPipeline.typingCallbacks?.onIdle?.();
    },
  });

  const draftStream = shouldUseDraftStream
    ? createSlackDraftStream({
        target: prepared.replyTarget,
        cfg,
        token: ctx.botToken,
        accountId: account.accountId,
        identity: slackIdentity,
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
  const previewToolProgressEnabled =
    Boolean(draftStream) && resolveChannelStreamingPreviewToolProgress(account.config);
  const suppressDefaultToolProgressMessages =
    resolveChannelStreamingSuppressDefaultToolProgressMessages(account.config, {
      draftStreamActive: Boolean(draftStream),
      previewToolProgressEnabled,
      previewStreamingEnabled,
    });
  let previewToolProgressSuppressed = false;
  let previewToolProgressLines: ChannelProgressDraftLine[] = [];
  let appendRenderedText = "";
  let appendSourceText = "";
  let statusUpdateCount = 0;
  const progressSeed = `${account.accountId}:${message.channel}`;
  const useRichProgressDraft =
    streamMode === "status_final" && resolveChannelProgressDraftRender(account.config) === "rich";

  const renderProgressDraft = () => {
    if (!draftStream || streamMode !== "status_final") {
      return;
    }
    const previewText = formatChannelProgressDraftText({
      entry: account.config,
      lines: previewToolProgressLines,
      seed: progressSeed,
      formatLine: escapeSlackMrkdwn,
    });
    if (!previewText) {
      return;
    }
    draftStream.update(
      useRichProgressDraft
        ? {
            text: previewText,
            blocks: buildSlackProgressDraftBlocks({
              label: resolveChannelProgressDraftLabel({
                entry: account.config,
                seed: progressSeed,
              }),
              lines: previewToolProgressLines,
            }),
          }
        : previewText,
    );
    hasStreamedMessage = true;
  };
  const progressDraftGate = createChannelProgressDraftGate({
    onStart: renderProgressDraft,
  });

  const pushPreviewToolProgress = async (
    line?: ChannelProgressDraftLine,
    options?: { toolName?: string },
  ) => {
    if (!draftStream) {
      return;
    }
    if (options?.toolName !== undefined && !isChannelProgressDraftWorkToolName(options.toolName)) {
      return;
    }
    const normalized = line?.text.replace(/\s+/g, " ").trim();
    if (!line || !normalized) {
      if (streamMode !== "status_final") {
        return;
      }
      const alreadyStarted = progressDraftGate.hasStarted;
      await progressDraftGate.noteWork();
      if (alreadyStarted && progressDraftGate.hasStarted) {
        renderProgressDraft();
      }
      return;
    }
    if (streamMode !== "status_final") {
      if (!previewToolProgressEnabled || previewToolProgressSuppressed) {
        return;
      }
      const previous = previewToolProgressLines.at(-1);
      if (previous?.text === normalized) {
        return;
      }
      previewToolProgressLines = [...previewToolProgressLines, line].slice(
        -resolveChannelProgressDraftMaxLines(account.config),
      );
      draftStream.update(
        formatChannelProgressDraftText({
          entry: account.config,
          lines: previewToolProgressLines,
          seed: progressSeed,
          formatLine: escapeSlackMrkdwn,
        }),
      );
      hasStreamedMessage = true;
      return;
    }
    if (previewToolProgressEnabled && !previewToolProgressSuppressed) {
      const previous = previewToolProgressLines.at(-1);
      if (previous?.text !== normalized) {
        previewToolProgressLines = [...previewToolProgressLines, line].slice(
          -resolveChannelProgressDraftMaxLines(account.config),
        );
      }
    }
    const alreadyStarted = progressDraftGate.hasStarted;
    await progressDraftGate.noteWork();
    if (alreadyStarted && progressDraftGate.hasStarted) {
      renderProgressDraft();
    }
  };

  const updateDraftFromPartial = (text?: string) => {
    const trimmed = text?.trimEnd();
    if (!trimmed) {
      return;
    }

    if (streamMode === "append") {
      previewToolProgressSuppressed = true;
      previewToolProgressLines = [];
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
      if (!progressDraftGate.hasStarted) {
        return;
      }
      statusUpdateCount += 1;
      if (statusUpdateCount > 1 && statusUpdateCount % 4 !== 0) {
        return;
      }
      renderProgressDraft();
      return;
    }

    previewToolProgressSuppressed = true;
    previewToolProgressLines = [];
    draftStream?.update(trimmed);
    hasStreamedMessage = true;
  };
  const onDraftBoundary = !shouldUseDraftStream
    ? undefined
    : async () => {
        if (hasStreamedMessage) {
          draftStream?.forceNewMessage();
          hasStreamedMessage = false;
          appendRenderedText = "";
          appendSourceText = "";
          statusUpdateCount = 0;
        }
        previewToolProgressSuppressed = false;
        previewToolProgressLines = [];
      };

  let dispatchError: unknown;
  let queuedFinal = false;
  let counts: { final?: number; block?: number } = {};
  let dispatchSettledBeforeStart = false;
  try {
    const turnResult = await runInboundReplyTurn({
      channel: "slack",
      accountId: route.accountId,
      raw: prepared.message,
      adapter: {
        ingest: () => ({
          id: prepared.message.ts ?? `${prepared.ctxPayload.From}:${Date.now()}`,
          timestamp: prepared.message.ts ? Number(prepared.message.ts) * 1000 : undefined,
          rawText: prepared.ctxPayload.RawBody ?? "",
          textForAgent: prepared.ctxPayload.BodyForAgent,
          textForCommands: prepared.ctxPayload.CommandBody,
          raw: prepared.message,
        }),
        resolveTurn: () => ({
          channel: "slack",
          accountId: route.accountId,
          routeSessionKey: route.sessionKey,
          storePath: prepared.turn.storePath,
          ctxPayload: prepared.ctxPayload,
          recordInboundSession,
          record: prepared.turn.record as ChannelTurnRecordOptions,
          botLoopProtection: resolveSlackBotLoopProtection(prepared),
          onPreDispatchFailure: async () => {
            dispatchSettledBeforeStart = true;
            await settleReplyDispatcher({
              dispatcher,
              onSettled: () => markDispatchIdle(),
            });
          },
          runDispatch: () =>
            dispatchInboundMessage({
              ctx: prepared.ctxPayload,
              cfg,
              dispatcher,
              replyOptions: {
                ...replyOptions,
                skillFilter: prepared.channelConfig?.skills,
                sourceReplyDeliveryMode,
                hasRepliedRef,
                disableBlockStreaming,
                onModelSelected,
                suppressDefaultToolProgressMessages: suppressDefaultToolProgressMessages
                  ? true
                  : undefined,
                onPartialReply: useStreaming
                  ? undefined
                  : !previewStreamingEnabled
                    ? undefined
                    : async (payload) => {
                        updateDraftFromPartial(payload.text);
                      },
                onAssistantMessageStart: onDraftBoundary,
                onReasoningEnd: onDraftBoundary,
                onReasoningStream: statusReactionsEnabled
                  ? async () => {
                      await statusReactions.setThinking();
                    }
                  : undefined,
                onToolStart: async (payload) => {
                  if (statusReactionsEnabled) {
                    await statusReactions.setTool(payload.name);
                  }
                  await pushPreviewToolProgress(
                    buildChannelProgressDraftLineForEntry(
                      account.config,
                      {
                        event: "tool",
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
                  await pushPreviewToolProgress(
                    buildChannelProgressDraftLineForEntry(account.config, {
                      event: "item",
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
                  await pushPreviewToolProgress(
                    buildChannelProgressDraftLine({
                      event: "plan",
                      phase: payload.phase,
                      title: payload.title,
                      explanation: payload.explanation,
                      steps: payload.steps,
                    }),
                  );
                },
                onApprovalEvent: async (payload) => {
                  if (payload.phase !== "requested") {
                    return;
                  }
                  await pushPreviewToolProgress(
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
                  await pushPreviewToolProgress(
                    buildChannelProgressDraftLine({
                      event: "command-output",
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
                  await pushPreviewToolProgress(
                    buildChannelProgressDraftLine({
                      event: "patch",
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
            }),
        }),
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
    progressDraftGate.cancel();
    await draftStream?.discardPending();
    if (!dispatchSettledBeforeStart) {
      markDispatchIdle();
    }
  }

  // -----------------------------------------------------------------------
  // Finalize the stream if one was started
  // -----------------------------------------------------------------------
  let streamFallbackDelivered = false;
  const finalStream = streamSession as SlackStreamSession | null;
  if (finalStream && !finalStream.stopped) {
    try {
      await stopSlackStream({ session: finalStream });
    } catch (err) {
      if (err instanceof SlackStreamNotDeliveredError) {
        streamFallbackDelivered = await deliverPendingStreamFallback(finalStream, err);
      } else {
        runtime.error?.(danger(`slack-stream: failed to stop stream: ${formatSlackError(err)}`));
      }
    }
  }

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

  if (dispatchError) {
    throw dispatchError;
  }

  // Record thread participation only when we actually delivered a reply and
  // know the thread ts that was used (set by deliverNormally, streaming start,
  // or draft stream). Falls back to statusThreadTs for edge cases.
  const participationThreadTs = usedReplyThreadTs ?? statusThreadTs;
  if (anyReplyDelivered && participationThreadTs) {
    recordSlackThreadParticipation(account.accountId, message.channel, participationThreadTs, {
      agentId: route.agentId,
    });
  }

  if (!anyReplyDelivered) {
    await draftStream?.clear();
    if (prepared.isRoomish && prepared.requireMention) {
      clearHistoryEntriesIfEnabled({
        historyMap: ctx.channelHistories,
        historyKey: prepared.historyKey,
        limit: ctx.historyLimit,
      });
    }
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
            client: ctx.app.client,
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

  if (prepared.isRoomish && prepared.requireMention) {
    clearHistoryEntriesIfEnabled({
      historyMap: ctx.channelHistories,
      historyKey: prepared.historyKey,
      limit: ctx.historyLimit,
    });
  }
}
