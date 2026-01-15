import { resolveAckReaction } from "../../../agents/identity.js";
import { hasControlCommand } from "../../../auto-reply/command-detection.js";
import { shouldHandleTextCommands } from "../../../auto-reply/commands-registry.js";
import { formatAgentEnvelope, formatThreadStarterEnvelope } from "../../../auto-reply/envelope.js";
import { buildHistoryContextFromMap } from "../../../auto-reply/reply/history.js";
import { buildMentionRegexes, matchesMentionPatterns } from "../../../auto-reply/reply/mentions.js";
import { logVerbose, shouldLogVerbose } from "../../../globals.js";
import { enqueueSystemEvent } from "../../../infra/system-events.js";
import { buildPairingReply } from "../../../pairing/pairing-messages.js";
import { upsertChannelPairingRequest } from "../../../pairing/pairing-store.js";
import { resolveAgentRoute } from "../../../routing/resolve-route.js";
import { resolveThreadSessionKeys } from "../../../routing/session-key.js";

import type { ResolvedSlackAccount } from "../../accounts.js";
import { reactSlackMessage } from "../../actions.js";
import { sendMessageSlack } from "../../send.js";
import type { SlackMessageEvent } from "../../types.js";

import { allowListMatches, resolveSlackUserAllowed } from "../allow-list.js";
import { isSlackSenderAllowListed, resolveSlackEffectiveAllowFrom } from "../auth.js";
import { resolveSlackChannelConfig } from "../channel-config.js";
import { normalizeSlackChannelType, type SlackMonitorContext } from "../context.js";
import { resolveSlackMedia, resolveSlackThreadStarter } from "../media.js";

import type { PreparedSlackMessage } from "./types.js";

export async function prepareSlackMessage(params: {
  ctx: SlackMonitorContext;
  account: ResolvedSlackAccount;
  message: SlackMessageEvent;
  opts: { source: "message" | "app_mention"; wasMentioned?: boolean };
}): Promise<PreparedSlackMessage | null> {
  const { ctx, account, message, opts } = params;
  const cfg = ctx.cfg;

  let channelInfo: {
    name?: string;
    type?: SlackMessageEvent["channel_type"];
    topic?: string;
    purpose?: string;
  } = {};
  let channelType = message.channel_type;
  if (!channelType || channelType !== "im") {
    channelInfo = await ctx.resolveChannelName(message.channel);
    channelType = channelType ?? channelInfo.type;
  }
  const channelName = channelInfo?.name;
  const resolvedChannelType = normalizeSlackChannelType(channelType, message.channel);
  const isDirectMessage = resolvedChannelType === "im";
  const isGroupDm = resolvedChannelType === "mpim";
  const isRoom = resolvedChannelType === "channel" || resolvedChannelType === "group";
  const isRoomish = isRoom || isGroupDm;

  const channelConfig = isRoom
    ? resolveSlackChannelConfig({
        channelId: message.channel,
        channelName,
        channels: ctx.channelsConfig,
        defaultRequireMention: ctx.defaultRequireMention,
      })
    : null;

  const allowBots =
    channelConfig?.allowBots ??
    account.config?.allowBots ??
    cfg.channels?.slack?.allowBots ??
    false;

  const isBotMessage = Boolean(message.bot_id);
  if (isBotMessage) {
    if (message.user && ctx.botUserId && message.user === ctx.botUserId) return null;
    if (!allowBots) {
      logVerbose(`slack: drop bot message ${message.bot_id ?? "unknown"} (allowBots=false)`);
      return null;
    }
  }

  if (isDirectMessage && !message.user) {
    logVerbose("slack: drop dm message (missing user id)");
    return null;
  }

  const senderId = message.user ?? (isBotMessage ? message.bot_id : undefined);
  if (!senderId) {
    logVerbose("slack: drop message (missing sender id)");
    return null;
  }

  if (
    !ctx.isChannelAllowed({
      channelId: message.channel,
      channelName,
      channelType: resolvedChannelType,
    })
  ) {
    logVerbose("slack: drop message (channel not allowed)");
    return null;
  }

  const { allowFromLower } = await resolveSlackEffectiveAllowFrom(ctx);

  if (isDirectMessage) {
    const directUserId = message.user;
    if (!directUserId) {
      logVerbose("slack: drop dm message (missing user id)");
      return null;
    }
    if (!ctx.dmEnabled || ctx.dmPolicy === "disabled") {
      logVerbose("slack: drop dm (dms disabled)");
      return null;
    }
    if (ctx.dmPolicy !== "open") {
      const permitted = allowListMatches({
        allowList: allowFromLower,
        id: directUserId,
      });
      if (!permitted) {
        if (ctx.dmPolicy === "pairing") {
          const sender = await ctx.resolveUserName(directUserId);
          const senderName = sender?.name ?? undefined;
          const { code, created } = await upsertChannelPairingRequest({
            channel: "slack",
            id: directUserId,
            meta: { name: senderName },
          });
          if (created) {
            logVerbose(
              `slack pairing request sender=${directUserId} name=${senderName ?? "unknown"}`,
            );
            try {
              await sendMessageSlack(
                message.channel,
                buildPairingReply({
                  channel: "slack",
                  idLine: `Your Slack user id: ${directUserId}`,
                  code,
                }),
                {
                  token: ctx.botToken,
                  client: ctx.app.client,
                  accountId: account.accountId,
                },
              );
            } catch (err) {
              logVerbose(`slack pairing reply failed for ${message.user}: ${String(err)}`);
            }
          }
        } else {
          logVerbose(
            `Blocked unauthorized slack sender ${message.user} (dmPolicy=${ctx.dmPolicy})`,
          );
        }
        return null;
      }
    }
  }

  const route = resolveAgentRoute({
    cfg,
    channel: "slack",
    accountId: account.accountId,
    teamId: ctx.teamId || undefined,
    peer: {
      kind: isDirectMessage ? "dm" : isRoom ? "channel" : "group",
      id: isDirectMessage ? (message.user ?? "unknown") : message.channel,
    },
  });

  const mentionRegexes = buildMentionRegexes(cfg, route.agentId);
  const wasMentioned =
    opts.wasMentioned ??
    (!isDirectMessage &&
      (Boolean(ctx.botUserId && message.text?.includes(`<@${ctx.botUserId}>`)) ||
        matchesMentionPatterns(message.text ?? "", mentionRegexes)));

  const sender = message.user ? await ctx.resolveUserName(message.user) : null;
  const senderName =
    sender?.name ?? message.username?.trim() ?? message.user ?? message.bot_id ?? "unknown";

  const channelUserAuthorized = isRoom
    ? resolveSlackUserAllowed({
        allowList: channelConfig?.users,
        userId: senderId,
        userName: senderName,
      })
    : true;
  if (isRoom && !channelUserAuthorized) {
    logVerbose(`Blocked unauthorized slack sender ${senderId} (not in channel users)`);
    return null;
  }

  const commandAuthorized =
    isSlackSenderAllowListed({
      allowListLower: allowFromLower,
      senderId,
      senderName,
    }) && channelUserAuthorized;

  const hasAnyMention = /<@[^>]+>/.test(message.text ?? "");
  const allowTextCommands = shouldHandleTextCommands({
    cfg,
    surface: "slack",
  });
  const shouldRequireMention = isRoom
    ? (channelConfig?.requireMention ?? ctx.defaultRequireMention)
    : false;

  // Allow "control commands" to bypass mention gating if sender is authorized.
  const shouldBypassMention =
    allowTextCommands &&
    isRoom &&
    shouldRequireMention &&
    !wasMentioned &&
    !hasAnyMention &&
    commandAuthorized &&
    hasControlCommand(message.text ?? "", cfg);

  const effectiveWasMentioned = wasMentioned || shouldBypassMention;
  const canDetectMention = Boolean(ctx.botUserId) || mentionRegexes.length > 0;
  if (isRoom && shouldRequireMention && canDetectMention && !wasMentioned && !shouldBypassMention) {
    ctx.logger.info({ channel: message.channel, reason: "no-mention" }, "skipping room message");
    return null;
  }

  const media = await resolveSlackMedia({
    files: message.files,
    token: ctx.botToken,
    maxBytes: ctx.mediaMaxBytes,
  });
  const rawBody = (message.text ?? "").trim() || media?.placeholder || "";
  if (!rawBody) return null;

  const ackReaction = resolveAckReaction(cfg, route.agentId);
  const ackReactionValue = ackReaction ?? "";

  const shouldAckReaction = () => {
    if (!ackReaction) return false;
    if (ctx.ackReactionScope === "all") return true;
    if (ctx.ackReactionScope === "direct") return isDirectMessage;
    if (ctx.ackReactionScope === "group-all") return isRoomish;
    if (ctx.ackReactionScope === "group-mentions") {
      if (!isRoom) return false;
      if (!shouldRequireMention) return false;
      if (!canDetectMention) return false;
      return wasMentioned || shouldBypassMention;
    }
    return false;
  };

  const ackReactionMessageTs = message.ts;
  const ackReactionPromise =
    shouldAckReaction() && ackReactionMessageTs && ackReactionValue
      ? reactSlackMessage(message.channel, ackReactionMessageTs, ackReactionValue, {
          token: ctx.botToken,
          client: ctx.app.client,
        }).then(
          () => true,
          (err) => {
            logVerbose(`slack react failed for channel ${message.channel}: ${String(err)}`);
            return false;
          },
        )
      : null;

  const roomLabel = channelName ? `#${channelName}` : `#${message.channel}`;
  const historyEntry =
    isRoomish && ctx.historyLimit > 0
      ? {
          sender: senderName,
          body: rawBody,
          timestamp: message.ts ? Math.round(Number(message.ts) * 1000) : undefined,
          messageId: message.ts,
        }
      : undefined;

  const preview = rawBody.replace(/\s+/g, " ").slice(0, 160);
  const inboundLabel = isDirectMessage
    ? `Slack DM from ${senderName}`
    : `Slack message in ${roomLabel} from ${senderName}`;
  const slackFrom = isDirectMessage
    ? `slack:${message.user}`
    : isRoom
      ? `slack:channel:${message.channel}`
      : `slack:group:${message.channel}`;

  const baseSessionKey = route.sessionKey;
  const threadTs = message.thread_ts;
  const hasThreadTs = typeof threadTs === "string" && threadTs.length > 0;
  const isThreadReply = hasThreadTs && (threadTs !== message.ts || Boolean(message.parent_user_id));
  const threadKeys = resolveThreadSessionKeys({
    baseSessionKey,
    threadId: isThreadReply ? threadTs : undefined,
    parentSessionKey: isThreadReply && ctx.threadInheritParent ? baseSessionKey : undefined,
  });
  const sessionKey = threadKeys.sessionKey;
  const historyKey =
    isThreadReply && ctx.threadHistoryScope === "thread" ? sessionKey : message.channel;
  enqueueSystemEvent(`${inboundLabel}: ${preview}`, {
    sessionKey,
    contextKey: `slack:message:${message.channel}:${message.ts ?? "unknown"}`,
  });

  const textWithId = `${rawBody}\n[slack message id: ${message.ts} channel: ${message.channel}]`;
  const body = formatAgentEnvelope({
    channel: "Slack",
    from: senderName,
    timestamp: message.ts ? Math.round(Number(message.ts) * 1000) : undefined,
    body: textWithId,
  });

  let combinedBody = body;
  if (isRoomish && ctx.historyLimit > 0) {
    combinedBody = buildHistoryContextFromMap({
      historyMap: ctx.channelHistories,
      historyKey,
      limit: ctx.historyLimit,
      entry: historyEntry,
      currentMessage: combinedBody,
      formatEntry: (entry) =>
        formatAgentEnvelope({
          channel: "Slack",
          from: roomLabel,
          timestamp: entry.timestamp,
          body: `${entry.sender}: ${entry.body}${
            entry.messageId ? ` [id:${entry.messageId} channel:${message.channel}]` : ""
          }`,
        }),
    });
  }

  const slackTo = isDirectMessage ? `user:${message.user}` : `channel:${message.channel}`;

  const channelDescription = [channelInfo?.topic, channelInfo?.purpose]
    .map((entry) => entry?.trim())
    .filter((entry): entry is string => Boolean(entry))
    .filter((entry, index, list) => list.indexOf(entry) === index)
    .join("\n");
  const systemPromptParts = [
    channelDescription ? `Channel description: ${channelDescription}` : null,
    channelConfig?.systemPrompt?.trim() || null,
  ].filter((entry): entry is string => Boolean(entry));
  const groupSystemPrompt =
    systemPromptParts.length > 0 ? systemPromptParts.join("\n\n") : undefined;

  let threadStarterBody: string | undefined;
  let threadLabel: string | undefined;
  if (isThreadReply && threadTs) {
    const starter = await resolveSlackThreadStarter({
      channelId: message.channel,
      threadTs,
      client: ctx.app.client,
    });
    if (starter?.text) {
      const starterUser = starter.userId ? await ctx.resolveUserName(starter.userId) : null;
      const starterName = starterUser?.name ?? starter.userId ?? "Unknown";
      const starterWithId = `${starter.text}\n[slack message id: ${starter.ts ?? threadTs} channel: ${message.channel}]`;
      threadStarterBody = formatThreadStarterEnvelope({
        channel: "Slack",
        author: starterName,
        timestamp: starter.ts ? Math.round(Number(starter.ts) * 1000) : undefined,
        body: starterWithId,
      });
      const snippet = starter.text.replace(/\s+/g, " ").slice(0, 80);
      threadLabel = `Slack thread ${roomLabel}${snippet ? `: ${snippet}` : ""}`;
    } else {
      threadLabel = `Slack thread ${roomLabel}`;
    }
  }

  const ctxPayload = {
    Body: combinedBody,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: slackFrom,
    To: slackTo,
    SessionKey: sessionKey,
    AccountId: route.accountId,
    ChatType: isDirectMessage ? "direct" : isRoom ? "room" : "group",
    GroupSubject: isRoomish ? roomLabel : undefined,
    GroupSystemPrompt: isRoomish ? groupSystemPrompt : undefined,
    SenderName: senderName,
    SenderId: senderId,
    Provider: "slack" as const,
    Surface: "slack" as const,
    MessageSid: message.ts,
    ReplyToId: message.thread_ts ?? message.ts,
    ParentSessionKey: threadKeys.parentSessionKey,
    ThreadStarterBody: threadStarterBody,
    ThreadLabel: threadLabel,
    Timestamp: message.ts ? Math.round(Number(message.ts) * 1000) : undefined,
    WasMentioned: isRoomish ? effectiveWasMentioned : undefined,
    MediaPath: media?.path,
    MediaType: media?.contentType,
    MediaUrl: media?.path,
    CommandAuthorized: commandAuthorized,
    OriginatingChannel: "slack" as const,
    OriginatingTo: slackTo,
  } satisfies Record<string, unknown>;

  const replyTarget = ctxPayload.To ?? undefined;
  if (!replyTarget) return null;

  if (shouldLogVerbose()) {
    logVerbose(`slack inbound: channel=${message.channel} from=${slackFrom} preview="${preview}"`);
  }

  return {
    ctx,
    account,
    message,
    route,
    channelConfig,
    replyTarget,
    ctxPayload,
    isDirectMessage,
    isRoomish,
    historyKey,
    preview,
    ackReactionMessageTs,
    ackReactionValue,
    ackReactionPromise,
  };
}
