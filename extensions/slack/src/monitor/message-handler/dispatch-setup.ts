import {
  createStatusReactionController,
  DEFAULT_TIMING,
  logAckFailure,
  logTypingFailure,
  type StatusReactionAdapter,
} from "openclaw/plugin-sdk/channel-feedback";
import {
  createChannelMessageReplyPipeline,
  resolveAgentOutboundIdentity,
  resolveChannelMessageSourceReplyDeliveryMode,
  resolveChannelStreamingBlockEnabled,
  resolveChannelStreamingNativeTransport,
} from "openclaw/plugin-sdk/channel-outbound";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { getGlobalHookRunner } from "openclaw/plugin-sdk/plugin-runtime";
import { resolveInboundLastRouteSessionKey } from "openclaw/plugin-sdk/routing";
import { danger, logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { resolvePinnedMainDmOwnerFromAllowlist } from "openclaw/plugin-sdk/security-runtime";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { reactSlackMessage, removeSlackReaction } from "../../actions.js";
import { formatSlackError } from "../../errors.js";
import { resolveSlackStreamingConfig } from "../../stream-mode.js";
import { resolveSlackThreadTargets } from "../../threading.js";
import { normalizeSlackAllowOwnerEntry } from "../allow-list.js";
import { resolveStorePath, updateLastRoute } from "../config.runtime.js";
import { createSlackReplyDeliveryPlan } from "../replies.js";
import {
  isSlackStreamingEnabled,
  resolveSlackDisableBlockStreaming,
  resolveSlackNativeProgressTaskCards,
  resolveSlackStreamingThreadHint,
  shouldEnableSlackPreviewStreaming,
  shouldInitializeSlackDraftStream,
  shouldUseStreaming,
} from "./dispatch-helpers.js";
import type { PreparedSlackMessage } from "./types.js";

export async function createSlackDispatchSetup(prepared: PreparedSlackMessage) {
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
          to: prepared.ctxPayload.OriginatingTo ?? prepared.ctxPayload.To ?? `user:${message.user}`,
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
  const statusReactions = createStatusReactionController({
    enabled: statusReactionsEnabled,
    adapter: slackStatusAdapter,
    initialEmoji: prepared.ackReactionValue || "eyes",
    emojis: undefined,
    timing: DEFAULT_TIMING,
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
      return payload;
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
  const hookRunner = getGlobalHookRunner();
  const modifyingHooksRegistered =
    (hookRunner?.hasHooks("reply_payload_sending") ?? false) ||
    (hookRunner?.hasHooks("message_sending") ?? false);
  // Portable previews and native progress cards exist before outbound modifiers accept the
  // payload. Native answer streaming stays enabled because it begins after both hook gates.
  const allowPreHookProviderStreaming = !modifyingHooksRegistered;
  const previewStreamingEnabled =
    allowPreHookProviderStreaming &&
    !sourceRepliesAreToolOnly &&
    shouldEnableSlackPreviewStreaming({
      mode: slackStreaming.mode,
    });
  const hasSlackCustomIdentity = Boolean(
    slackIdentity?.username || slackIdentity?.iconUrl || slackIdentity?.iconEmoji,
  );
  const streamingEnabled =
    !sourceRepliesAreToolOnly &&
    (allowPreHookProviderStreaming || slackStreaming.mode !== "progress") &&
    isSlackStreamingEnabled({
      mode: slackStreaming.mode,
      nativeStreaming: slackStreaming.nativeStreaming,
      nativeProgressTaskCards: resolveSlackNativeProgressTaskCards(account.config),
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

  const onSlackDeliveryError = (err: unknown, info: { kind: string }) => {
    runtime.error?.(danger(`slack ${info.kind} reply failed: ${formatSlackError(err)}`));
    replyPipeline.typingCallbacks?.onIdle?.();
  };

  return {
    prepared,
    ctx,
    account,
    message,
    route,
    slackClient,
    slackStreamFallbackTeamId,
    cfg,
    runtime,
    slackIdentity,
    forcedReplyThreadTs,
    slackMessageMetadata,
    statusThreadTs,
    isThreadReply,
    replyDeliveryMode,
    sourceReplyDeliveryMode,
    sourceRepliesAreToolOnly,
    suppressRoomEventTyping,
    messageSentHookTarget,
    messageSentHookContext,
    messageSentDeliveryHookContext,
    incomingThreadTs,
    messageTs,
    statusReactionsEnabled,
    statusReactions,
    hasRepliedRef,
    replyPlan,
    onModelSelected,
    replyPipeline,
    slackStreaming,
    streamThreadHint,
    previewStreamingEnabled,
    hasSlackCustomIdentity,
    shouldUseDraftStream,
    disableBlockStreaming,
    useStreaming,
    onSlackDeliveryError,
  };
}

export type SlackDispatchSetup = Awaited<ReturnType<typeof createSlackDispatchSetup>>;
