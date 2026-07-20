// Discord plugin module owns inbound ack and status-reaction lifecycle.
import { resolveAckReaction } from "openclaw/plugin-sdk/agent-runtime";
import {
  createStatusReactionController,
  DEFAULT_TIMING,
  logAckFailure,
  shouldAckReaction as shouldAckReactionGate,
  type StatusReactionController,
} from "openclaw/plugin-sdk/channel-feedback";
import { logVerbose, sleep } from "openclaw/plugin-sdk/runtime-env";
import { createDiscordRestClient } from "../client.js";
import { removeReactionDiscord } from "../send.js";
import { resolveDiscordTargetChannelId } from "../send.shared.js";
import { resolveDiscordChannelId } from "../targets.js";
import {
  createDiscordAckReactionAdapter,
  createDiscordAckReactionContext,
  queueInitialDiscordAckReaction,
} from "./ack-reactions.js";
import type { DiscordMessagePreflightContext } from "./message-handler.preflight.js";

type ToolStartPayload = {
  name?: string;
  phase?: string;
  args?: Record<string, unknown>;
};

function readToolStringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readToolBooleanArg(args: Record<string, unknown>, key: string): boolean {
  return args[key] === true;
}

export function createDiscordMessageReactionRuntime(params: {
  ctx: DiscordMessagePreflightContext;
  sourceRepliesAreToolOnly: boolean;
  isRoomEvent: boolean;
}) {
  const { ctx } = params;
  const {
    cfg,
    accountId,
    token,
    ackReactionScope,
    message,
    messageChannelId,
    isGuildMessage,
    isDirectMessage,
    isGroupDm,
    shouldRequireMention,
    canDetectMention,
    effectiveWasMentioned,
    shouldBypassMention,
    route,
  } = ctx;
  const ackReaction = resolveAckReaction(cfg, route.agentId, {
    channel: "discord",
    accountId,
  });
  const removeAckAfterReply = cfg.messages?.removeAckAfterReply ?? false;
  const shouldSendAckReaction = Boolean(
    ackReaction &&
    shouldAckReactionGate({
      scope: ackReactionScope,
      inboundEventKind: ctx.inboundEventKind,
      isDirect: isDirectMessage,
      isGroup: isGuildMessage || isGroupDm,
      isMentionableGroup: isGuildMessage,
      requireMention: shouldRequireMention,
      canDetectMention,
      effectiveWasMentioned,
      shouldBypassMention,
    }),
  );
  const statusReactionsExplicitlyEnabled = cfg.messages?.statusReactions?.enabled === true;
  const statusReactionsEnabled =
    !params.isRoomEvent &&
    shouldSendAckReaction &&
    cfg.messages?.statusReactions?.enabled !== false &&
    (!params.sourceRepliesAreToolOnly || statusReactionsExplicitlyEnabled);
  const feedbackRest = createDiscordRestClient({ cfg, token, accountId }).rest;
  const deliveryRest = createDiscordRestClient({ cfg, token, accountId }).rest;
  // Discord outbound helpers expect the internal REST client shape explicitly.
  const ackReactionContext = createDiscordAckReactionContext({
    rest: feedbackRest,
    cfg,
    accountId,
  });
  const discordAdapter = createDiscordAckReactionAdapter({
    channelId: messageChannelId,
    messageId: message.id,
    reactionContext: ackReactionContext,
  });
  const statusReactionTiming = DEFAULT_TIMING;
  let statusReactionTarget = `${messageChannelId}/${message.id}`;
  let statusReactionsActive = statusReactionsEnabled;
  let statusReactions: StatusReactionController = createStatusReactionController({
    enabled: statusReactionsEnabled,
    adapter: discordAdapter,
    initialEmoji: ackReaction,
    emojis: cfg.messages?.statusReactions?.emojis,
    timing: statusReactionTiming,
    onError: (err) => {
      logAckFailure({
        log: logVerbose,
        channel: "discord",
        target: statusReactionTarget,
        error: err,
      });
    },
  });

  const resolveTrackedReactionChannelId = async (
    args: Record<string, unknown>,
  ): Promise<string> => {
    const target =
      readToolStringArg(args, "channelId") ??
      readToolStringArg(args, "channel_id") ??
      readToolStringArg(args, "to");
    if (!target) {
      return messageChannelId;
    }
    try {
      return resolveDiscordChannelId(target);
    } catch {
      return (
        await resolveDiscordTargetChannelId(target, {
          cfg,
          token,
          accountId,
        })
      ).channelId;
    }
  };

  const maybeBindToToolReaction = async (payload: ToolStartPayload) => {
    if (
      params.sourceRepliesAreToolOnly ||
      cfg.messages?.statusReactions?.enabled === false ||
      payload.phase !== "start" ||
      payload.name !== "message" ||
      !payload.args
    ) {
      return;
    }
    const args = payload.args;
    if (readToolStringArg(args, "action")?.toLowerCase() !== "react") {
      return;
    }
    const shouldTrack =
      readToolBooleanArg(args, "trackToolCalls") || readToolBooleanArg(args, "track_tool_calls");
    if (!shouldTrack) {
      return;
    }
    const emoji = readToolStringArg(args, "emoji");
    if (!emoji || readToolBooleanArg(args, "remove")) {
      return;
    }
    const trackedMessageId =
      readToolStringArg(args, "messageId") ?? readToolStringArg(args, "message_id") ?? message.id;
    let trackedChannelId: string;
    try {
      trackedChannelId = await resolveTrackedReactionChannelId(args);
    } catch (err) {
      logAckFailure({
        log: logVerbose,
        channel: "discord",
        target: `${readToolStringArg(args, "to") ?? readToolStringArg(args, "channelId") ?? messageChannelId}/${trackedMessageId}`,
        error: err,
      });
      return;
    }
    statusReactionTarget = `${trackedChannelId}/${trackedMessageId}`;
    if (statusReactionsActive) {
      void statusReactions.clear();
    }
    statusReactions = createStatusReactionController({
      enabled: true,
      adapter: createDiscordAckReactionAdapter({
        channelId: trackedChannelId,
        messageId: trackedMessageId,
        reactionContext: ackReactionContext,
      }),
      initialEmoji: emoji,
      emojis: cfg.messages?.statusReactions?.emojis,
      timing: statusReactionTiming,
      onError: (err) => {
        logAckFailure({
          log: logVerbose,
          channel: "discord",
          target: statusReactionTarget,
          error: err,
        });
      },
    });
    statusReactionsActive = true;
    void statusReactions.setQueued();
  };

  let initialAckReactionQueued = false;
  const queueInitialAckReactionAfterRecord = () => {
    if (initialAckReactionQueued) {
      return;
    }
    initialAckReactionQueued = true;
    if (statusReactionsEnabled) {
      statusReactionsActive = true;
    }
    queueInitialDiscordAckReaction({
      enabled: statusReactionsEnabled,
      shouldSendAckReaction,
      ackReaction,
      statusReactions,
      reactionAdapter: discordAdapter,
      target: `${messageChannelId}/${message.id}`,
    });
  };

  const finish = async (result: {
    dispatchAborted: boolean;
    dispatchError: boolean;
    finalDeliveryFailed: boolean;
  }) => {
    if (statusReactionsActive) {
      if (result.dispatchAborted) {
        if (removeAckAfterReply) {
          void statusReactions.clear();
        } else {
          void statusReactions.restoreInitial();
        }
        return;
      }
      if (result.dispatchError || result.finalDeliveryFailed) {
        await statusReactions.setError();
      } else {
        await statusReactions.setDone();
      }
      if (removeAckAfterReply) {
        void (async () => {
          await sleep(
            result.dispatchError || result.finalDeliveryFailed
              ? statusReactionTiming.errorHoldMs
              : statusReactionTiming.doneHoldMs,
          );
          await statusReactions.clear();
        })();
      } else {
        void statusReactions.restoreInitial();
      }
      return;
    }
    if (shouldSendAckReaction && ackReaction && removeAckAfterReply) {
      void removeReactionDiscord(
        messageChannelId,
        message.id,
        ackReaction,
        ackReactionContext,
      ).catch((err: unknown) => {
        logAckFailure({
          log: logVerbose,
          channel: "discord",
          target: `${messageChannelId}/${message.id}`,
          error: err,
        });
      });
    }
  };

  return {
    feedbackRest,
    deliveryRest,
    statusReactionsExplicitlyEnabled,
    statusReactionsEnabled,
    get controller() {
      return statusReactions;
    },
    maybeBindToToolReaction,
    queueInitialAckReactionAfterRecord,
    finish,
  };
}
