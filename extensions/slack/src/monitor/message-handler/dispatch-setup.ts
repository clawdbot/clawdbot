import { resolveAgentConfig } from "openclaw/plugin-sdk/agent-runtime";
import {
  createStatusReactionController,
  DEFAULT_TIMING,
  logAckFailure,
  logTypingFailure,
  type StatusReactionAdapter,
} from "openclaw/plugin-sdk/channel-feedback";
import {
  createChannelMessageReplyPipeline,
  createTypingKeepaliveLoop,
  resolveAgentOutboundIdentity,
  resolveChannelMessageSourceReplyDeliveryMode,
  resolveChannelStreamingBlockEnabled,
  resolveChannelStreamingNativeTransport,
} from "openclaw/plugin-sdk/channel-outbound";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import { getGlobalHookRunner } from "openclaw/plugin-sdk/plugin-runtime";
import {
  isSilentReplyText,
  SILENT_REPLY_TOKEN,
  type GetReplyOptions,
} from "openclaw/plugin-sdk/reply-runtime";
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

type SlackThreadStatusOwners = {
  owners: number;
  queuedOwners: number;
  visible: boolean;
  keepalive?: ReturnType<typeof createTypingKeepaliveLoop>;
  runningQueuedTyping?: Set<() => void>;
};

const slackThreadStatusOwners = new WeakMap<
  PreparedSlackMessage["ctx"],
  Map<string, SlackThreadStatusOwners>
>();
const slackThreadStatusUpdates = new KeyedAsyncQueue();

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
  const typingTarget = statusThreadTs ? `${message.channel}/${statusThreadTs}` : message.channel;
  const onTypingStopError = (error: unknown) => {
    logTypingFailure({
      log: (messageLocal) => runtime.error?.(danger(messageLocal)),
      channel: "slack",
      action: "stop",
      target: typingTarget,
      error,
    });
  };
  const onTypingStartError = (error: unknown) => {
    logTypingFailure({
      log: (messageValue) => runtime.error?.(danger(messageValue)),
      channel: "slack",
      action: "start",
      target: typingTarget,
      error,
    });
  };
  let didSetStatus = false;
  let queuedStatusOwner = false;
  let hasStatusOwner = false;
  let pendingTypingReaction: Promise<void> | undefined;
  const statusTargetKey = statusThreadTs
    ? JSON.stringify([
        route.accountId,
        prepared.eventScope?.apiAppId,
        prepared.eventScope?.enterpriseId,
        slackStreamFallbackTeamId,
        message.channel,
        statusThreadTs,
      ])
    : undefined;
  let threadStatusOwners = slackThreadStatusOwners.get(ctx);
  if (statusTargetKey && !threadStatusOwners) {
    threadStatusOwners = new Map();
    slackThreadStatusOwners.set(ctx, threadStatusOwners);
  }
  const ensureStatusTarget = () => {
    if (!threadStatusOwners || !statusTargetKey) {
      return;
    }
    let target = threadStatusOwners.get(statusTargetKey);
    if (!target) {
      target = { owners: 0, queuedOwners: 0, visible: false };
      threadStatusOwners.set(statusTargetKey, target);
    }
    return target;
  };
  const acquireStatusOwner = () => {
    if (hasStatusOwner) {
      return;
    }
    const target = ensureStatusTarget();
    if (!target) {
      return;
    }
    target.owners += 1;
    if (queuedStatusOwner) {
      target.queuedOwners += 1;
    }
    hasStatusOwner = true;
  };
  const refreshThreadStatus = (target: SlackThreadStatusOwners) => {
    if (!target.visible || target.queuedOwners === 0) {
      target.keepalive?.stop();
      return;
    }
    // Slack expires assistant status after two minutes; queued controllers
    // are sealed, so their transport owner must renew the visible lease.
    target.keepalive ??= createTypingKeepaliveLoop({
      intervalMs: Math.min((cfg.agents?.defaults?.typingIntervalSeconds ?? 60) * 1_000, 60_000),
      onTick: async () => {
        if (target.queuedOwners > 0) {
          await updateThreadStatus("is typing...").catch((err: unknown) => {
            logVerbose(`slack status refresh failed: ${formatSlackError(err)}`);
          });
        }
      },
    });
    target.keepalive.start();
  };
  const updateThreadStatus = async (status: string): Promise<void> => {
    const target = statusTargetKey ? threadStatusOwners?.get(statusTargetKey) : undefined;
    const update = async () => {
      if (status === "" && target) {
        if (target.owners > 0) {
          return;
        }
        if (!target.visible) {
          if (
            !target.runningQueuedTyping?.size &&
            threadStatusOwners?.get(statusTargetKey ?? "") === target
          ) {
            threadStatusOwners.delete(statusTargetKey ?? "");
          }
          return;
        }
      }
      await ctx.setSlackThreadStatus({
        channelId: message.channel,
        threadTs: statusThreadTs,
        status,
        eventScope: prepared.eventScope,
      });
      if (target) {
        target.visible = status !== "";
        if (!target.visible && target.owners > 0) {
          await ctx.setSlackThreadStatus({
            channelId: message.channel,
            threadTs: statusThreadTs,
            status: "is typing...",
            eventScope: prepared.eventScope,
          });
          target.visible = true;
        }
        refreshThreadStatus(target);
      }
      if (
        status === "" &&
        target &&
        target.owners === 0 &&
        !target.runningQueuedTyping?.size &&
        threadStatusOwners?.get(statusTargetKey ?? "") === target
      ) {
        threadStatusOwners.delete(statusTargetKey ?? "");
      }
    };
    if (!target) {
      await update();
      return;
    }
    await slackThreadStatusUpdates.enqueue(statusTargetKey ?? "", update);
  };
  const removeTypingReaction = async () => {
    if (!ctx.typingReaction || !message.ts) {
      return;
    }
    await pendingTypingReaction;
    await removeSlackReaction(message.channel, message.ts, ctx.typingReaction, {
      token: ctx.botToken,
      client: slackClient,
    }).catch((err: unknown) => {
      logVerbose(`slack send: typing reaction removal failed: ${formatSlackError(err)}`);
    });
  };
  const stopTyping = async () => {
    if (!didSetStatus && !hasStatusOwner) {
      return;
    }
    const didStartTyping = didSetStatus;
    didSetStatus = false;
    if (queuedStatusOwner) {
      if (didStartTyping) {
        await removeTypingReaction();
      }
      return;
    }
    if (hasStatusOwner && statusTargetKey) {
      hasStatusOwner = false;
      const target = threadStatusOwners?.get(statusTargetKey);
      if (target) {
        target.owners -= 1;
        refreshThreadStatus(target);
      }
      if (target?.owners === 0) {
        await updateThreadStatus("");
      }
    } else if (didStartTyping) {
      await updateThreadStatus("");
    }
    if (didStartTyping) {
      await removeTypingReaction();
    }
  };
  const typingReaction = ctx.typingReaction;
  const startTyping = async () => {
    didSetStatus = true;
    acquireStatusOwner();
    await updateThreadStatus("is typing...");
    if (!didSetStatus) {
      return;
    }
    if (typingReaction && message.ts) {
      pendingTypingReaction = reactSlackMessage(message.channel, message.ts, typingReaction, {
        token: ctx.botToken,
        client: slackClient,
      }).catch((err: unknown) => {
        logVerbose(`slack send: typing reaction failed: ${formatSlackError(err)}`);
      });
      await pendingTypingReaction;
    }
  };
  const startQueuedTyping = () => {
    if (queuedStatusOwner && !didSetStatus) {
      void startTyping().catch(onTypingStartError);
    }
  };
  const typingMode =
    resolveAgentConfig(cfg, route.agentId)?.typingMode ?? cfg.agents?.defaults?.typingMode;
  const startsTypingImmediately =
    typingMode === "instant" ||
    (!typingMode &&
      (sourceRepliesAreToolOnly ||
        !prepared.isRoomish ||
        prepared.ctxPayload.WasMentioned === true));
  const turnLifecycle = prepared.turnAdoptionLifecycle as
    | NonNullable<GetReplyOptions["turnAdoptionLifecycle"]>
    | undefined;
  if (turnLifecycle && statusTargetKey && !suppressRoomEventTyping && typingMode !== "never") {
    const onAdopted = turnLifecycle.onAdopted;
    const onDeferred = turnLifecycle.onDeferred;
    const onSettled = turnLifecycle.onSettled;
    const releaseQueuedStatusOwner = () => {
      if (!queuedStatusOwner) {
        return;
      }
      const target = threadStatusOwners?.get(statusTargetKey);
      target?.runningQueuedTyping?.delete(startQueuedTyping);
      if (hasStatusOwner && target) {
        target.queuedOwners -= 1;
      }
      queuedStatusOwner = false;
      turnLifecycle.abortSignal?.removeEventListener("abort", releaseQueuedStatusOwner);
      void stopTyping().catch(onTypingStopError);
      if (
        target &&
        target.owners === 0 &&
        !target.visible &&
        !target.runningQueuedTyping?.size &&
        threadStatusOwners?.get(statusTargetKey) === target
      ) {
        threadStatusOwners.delete(statusTargetKey);
      }
    };
    turnLifecycle.onAdopted = async () => {
      await onAdopted();
      if (queuedStatusOwner && !startsTypingImmediately) {
        // The newest runner can own the controller while an older queued turn runs.
        const target = ensureStatusTarget();
        if (target) {
          (target.runningQueuedTyping ??= new Set()).add(startQueuedTyping);
        }
      }
    };
    turnLifecycle.onDeferred = () => {
      const result = onDeferred?.();
      if (result === false) {
        return false;
      }
      queuedStatusOwner = true;
      // Queue admission precedes typing; retain ownership before either turn
      // can settle, but preserve deferred thinking/message start policies.
      if (hasStatusOwner) {
        const target = threadStatusOwners?.get(statusTargetKey);
        if (target) {
          target.queuedOwners += 1;
        }
      } else if (startsTypingImmediately) {
        acquireStatusOwner();
      }
      const target = threadStatusOwners?.get(statusTargetKey);
      if (target) {
        refreshThreadStatus(target);
      }
      if (turnLifecycle.abortSignal?.aborted) {
        releaseQueuedStatusOwner();
        return result;
      }
      turnLifecycle.abortSignal?.addEventListener("abort", releaseQueuedStatusOwner, {
        once: true,
      });
      return result;
    };
    turnLifecycle.onSettled = () => {
      try {
        onSettled?.();
      } finally {
        releaseQueuedStatusOwner();
      }
    };
  }
  const onQueuedTypingController: NonNullable<GetReplyOptions["onTypingController"]> | undefined =
    turnLifecycle && statusTargetKey && !suppressRoomEventTyping && typingMode !== "never"
      ? (typing) => {
          // Followups reuse sealed controllers; preserve core's policy-approved start signals.
          const startTypingLoop = typing.startTypingLoop.bind(typing);
          const startTypingOnText = typing.startTypingOnText.bind(typing);
          const resumeQueuedTyping = () => {
            threadStatusOwners
              ?.get(statusTargetKey)
              ?.runningQueuedTyping?.values()
              .next()
              .value?.();
          };
          typing.startTypingLoop = async () => {
            await startTypingLoop();
            resumeQueuedTyping();
          };
          typing.startTypingOnText = async (text) => {
            await startTypingOnText(text);
            const trimmed = text?.trim();
            if (
              !trimmed ||
              isSilentReplyText(trimmed) ||
              (trimmed.length > 1 &&
                trimmed === trimmed.toUpperCase() &&
                SILENT_REPLY_TOKEN.startsWith(trimmed))
            ) {
              return;
            }
            resumeQueuedTyping();
          };
        }
      : undefined;
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

  const rearmQueuedThreadStatus = () => {
    const target = statusTargetKey ? threadStatusOwners?.get(statusTargetKey) : undefined;
    if (target?.visible && target.queuedOwners > 0) {
      void updateThreadStatus("is typing...").catch((error: unknown) => {
        logVerbose(`slack queued status rearm failed: ${formatSlackError(error)}`);
      });
    }
  };

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
      start: startTyping,
      stop: stopTyping,
      onStartError: onTypingStartError,
      onStopError: onTypingStopError,
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
    onQueuedTypingController,
    rearmQueuedThreadStatus,
  };
}

export type SlackDispatchSetup = Awaited<ReturnType<typeof createSlackDispatchSetup>>;
