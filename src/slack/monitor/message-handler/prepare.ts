import { resolveAckReaction } from "../../../agents/identity.js";
import { hasControlCommand } from "../../../auto-reply/command-detection.js";
import { shouldHandleTextCommands } from "../../../auto-reply/commands-registry.js";
import type { FinalizedMsgContext } from "../../../auto-reply/templating.js";
import {
  formatInboundEnvelope,
  formatThreadStarterEnvelope,
  resolveEnvelopeFormatOptions,
} from "../../../auto-reply/envelope.js";
import {
  buildPendingHistoryContextFromMap,
  recordPendingHistoryEntryIfEnabled,
} from "../../../auto-reply/reply/history.js";
import { finalizeInboundContext } from "../../../auto-reply/reply/inbound-context.js";
import {
  buildMentionRegexes,
  matchesMentionWithExplicit,
} from "../../../auto-reply/reply/mentions.js";
import { logVerbose, shouldLogVerbose } from "../../../globals.js";
import { enqueueSystemEvent } from "../../../infra/system-events.js";
import { buildPairingReply } from "../../../pairing/pairing-messages.js";
import { upsertChannelPairingRequest } from "../../../pairing/pairing-store.js";
import { resolveAgentRoute } from "../../../routing/resolve-route.js";
import { resolveThreadSessionKeys } from "../../../routing/session-key.js";
import {
  shouldAckReaction as shouldAckReactionGate,
  type AckReactionScope,
} from "../../../channels/ack-reactions.js";
import { resolveMentionGatingWithBypass } from "../../../channels/mention-gating.js";
import { resolveConversationLabel } from "../../../channels/conversation-label.js";
import { resolveControlCommandGate } from "../../../channels/command-gating.js";
import { logInboundDrop } from "../../../channels/logging.js";
import { formatAllowlistMatchMeta } from "../../../channels/allowlist-match.js";
import { recordInboundSession } from "../../../channels/session.js";
import { readSessionUpdatedAt, resolveStorePath } from "../../../config/sessions.js";

import type { ResolvedSlackAccount } from "../../accounts.js";
import { reactSlackMessage } from "../../actions.js";
import { sendMessageSlack } from "../../send.js";
import type { SlackMessageEvent } from "../../types.js";
import { resolveSlackThreadContext } from "../../threading.js";

import { resolveSlackAllowListMatch, resolveSlackUserAllowed } from "../allow-list.js";
import { resolveSlackEffectiveAllowFrom } from "../auth.js";
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
      const allowMatch = resolveSlackAllowListMatch({
        allowList: allowFromLower,
        id: directUserId,
      });
      const allowMatchMeta = formatAllowlistMatchMeta(allowMatch);
      if (!allowMatch.allowed) {
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
              `slack pairing request sender=${directUserId} name=${
                senderName ?? "unknown"
              } (${allowMatchMeta})`,
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
            `Blocked unauthorized slack sender ${message.user} (dmPolicy=${ctx.dmPolicy}, ${allowMatchMeta})`,
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

  const baseSessionKey = route.sessionKey;
  const threadContext = resolveSlackThreadContext({ message, replyToMode: ctx.replyToMode });
  const threadTs = threadContext.incomingThreadTs;
  const isThreadReply = threadContext.isThreadReply;
  const threadKeys = resolveThreadSessionKeys({
    baseSessionKey,
    threadId: isThreadReply ? threadTs : undefined,
    parentSessionKey: isThreadReply && ctx.threadInheritParent ? baseSessionKey : undefined,
  });
  const sessionKey = threadKeys.sessionKey;
  const historyKey =
    isThreadReply && ctx.threadHistoryScope === "thread" ? sessionKey : message.channel;

  const mentionRegexes = buildMentionRegexes(cfg, route.agentId);
  const hasAnyMention = /<@[^>]+>/.test(message.text ?? "");
  const explicitlyMentioned = Boolean(
    ctx.botUserId && message.text?.includes(`<@${ctx.botUserId}>`),
  );
  const wasMentioned =
    opts.wasMentioned ??
    (!isDirectMessage &&
      matchesMentionWithExplicit({
        text: message.text ?? "",
        mentionRegexes,
        explicit: {
          hasAnyMention,
          isExplicitlyMentioned: explicitlyMentioned,
          canResolveExplicit: Boolean(ctx.botUserId),
        },
      }));
  const implicitMention = Boolean(
    !isDirectMessage &&
    ctx.botUserId &&
    message.thread_ts &&
    message.parent_user_id === ctx.botUserId,
  );

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

  const allowTextCommands = shouldHandleTextCommands({
    cfg,
    surface: "slack",
  });
  const hasControlCommandInMessage = hasControlCommand(message.text ?? "", cfg);

  const ownerAuthorized = resolveSlackAllowListMatch({
    allowList: allowFromLower,
    id: senderId,
    name: senderName,
  }).allowed;
  const channelUsersAllowlistConfigured =
    isRoom && Array.isArray(channelConfig?.users) && channelConfig.users.length > 0;
  const channelCommandAuthorized =
    isRoom && channelUsersAllowlistConfigured
      ? resolveSlackUserAllowed({
          allowList: channelConfig?.users,
          userId: senderId,
          userName: senderName,
        })
      : false;
  const commandGate = resolveControlCommandGate({
    useAccessGroups: ctx.useAccessGroups,
    authorizers: [
      { configured: allowFromLower.length > 0, allowed: ownerAuthorized },
      { configured: channelUsersAllowlistConfigured, allowed: channelCommandAuthorized },
    ],
    allowTextCommands,
    hasControlCommand: hasControlCommandInMessage,
  });
  const commandAuthorized = commandGate.commandAuthorized;

  if (isRoomish && commandGate.shouldBlock) {
    logInboundDrop({
      log: logVerbose,
      channel: "slack",
      reason: "control command (unauthorized)",
      target: senderId,
    });
    return null;
  }

  const shouldRequireMention = isRoom
    ? (channelConfig?.requireMention ?? ctx.defaultRequireMention)
    : false;

  // Allow "control commands" to bypass mention gating if sender is authorized.
  const canDetectMention = Boolean(ctx.botUserId) || mentionRegexes.length > 0;
  const mentionGate = resolveMentionGatingWithBypass({
    isGroup: isRoom,
    requireMention: Boolean(shouldRequireMention),
    canDetectMention,
    wasMentioned,
    implicitMention,
    hasAnyMention,
    allowTextCommands,
    hasControlCommand: hasControlCommandInMessage,
    commandAuthorized,
  });
  const effectiveWasMentioned = mentionGate.effectiveWasMentioned;
  if (isRoom && shouldRequireMention && mentionGate.shouldSkip) {
    ctx.logger.info({ channel: message.channel, reason: "no-mention" }, "skipping channel message");
    const pendingText = (message.text ?? "").trim();
    const fallbackFile = message.files?.[0]?.name
      ? `[Slack file: ${message.files[0].name}]`
      : message.files?.length
        ? "[Slack file]"
        : "";
    const pendingBody = pendingText || fallbackFile;
    recordPendingHistoryEntryIfEnabled({
      historyMap: ctx.channelHistories,
      historyKey,
      limit: ctx.historyLimit,
      entry: pendingBody
        ? {
            sender: senderName,
            body: pendingBody,
            timestamp: message.ts ? Math.round(Number(message.ts) * 1000) : undefined,
            messageId: message.ts,
          }
        : null,
    });
    return null;
  }

  const media = await resolveSlackMedia({
    files: message.files,
    token: ctx.botToken,
    maxBytes: ctx.mediaMaxBytes,
  });
  const rawBody = (message.text ?? "").trim() || media?.placeholder || "";

  // Handle ack reactions BEFORE checking for message content
  // This ensures reactions work even for messages with no text body
  const ackReaction = resolveAckReaction(cfg, route.agentId);
  const ackReactionValue = ackReaction ?? "";

  const shouldAckReaction = () =>
    Boolean(
      ackReaction &&
      shouldAckReactionGate({
        scope: ctx.ackReactionScope as AckReactionScope | undefined,
        isDirect: isDirectMessage,
        isGroup: isRoomish,
        isMentionableGroup: isRoom,
        requireMention: Boolean(shouldRequireMention),
        canDetectMention,
        effectiveWasMentioned,
        shouldBypassMention: mentionGate.shouldBypassMention,
      }),
    );

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

  if (!rawBody) return null;

  const roomLabel = channelName ? `#${channelName}` : `#${message.channel}`;
  const preview = rawBody.replace(/\s+/g, " ").slice(0, 160);
  const inboundLabel = isDirectMessage
    ? `Slack DM from ${senderName}`
    : `Slack message in ${roomLabel} from ${senderName}`;
  const slackFrom = isDirectMessage
    ? `slack:${message.user}`
    : isRoom
      ? `slack:channel:${message.channel}`
      : `slack:group:${message.channel}`;

  enqueueSystemEvent(`${inboundLabel}: ${preview}`, {
    sessionKey,
    contextKey: `slack:message:${message.channel}:${message.ts ?? "unknown"}`,
  });

  const envelopeFrom =
    resolveConversationLabel({
      ChatType: isDirectMessage ? "direct" : "channel",
      SenderName: senderName,
      GroupSubject: isRoomish ? roomLabel : undefined,
      From: slackFrom,
    }) ?? (isDirectMessage ? senderName : roomLabel);
  const textWithId = `${rawBody}\n[slack message id: ${message.ts} channel: ${message.channel}]`;
  const storePath = resolveStorePath(ctx.cfg.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = resolveEnvelopeFormatOptions(ctx.cfg);
  const previousTimestamp = readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  const body = formatInboundEnvelope({
    channel: "Slack",
    from: envelopeFrom,
    timestamp: message.ts ? Math.round(Number(message.ts) * 1000) : undefined,
    body: textWithId,
    chatType: isDirectMessage ? "direct" : "channel",
    sender: { name: senderName, id: senderId },
    previousTimestamp,
    envelope: envelopeOptions,
  });

  let combinedBody = body;
  if (isRoomish && ctx.historyLimit > 0) {
    combinedBody = buildPendingHistoryContextFromMap({
      historyMap: ctx.channelHistories,
      historyKey,
      limit: ctx.historyLimit,
      currentMessage: combinedBody,
      formatEntry: (entry) =>
        formatInboundEnvelope({
          channel: "Slack",
          from: roomLabel,
          timestamp: entry.timestamp,
          body: `${entry.body}${
            entry.messageId ? ` [id:${entry.messageId} channel:${message.channel}]` : ""
          }`,
          chatType: "channel",
          senderLabel: entry.sender,
          envelope: envelopeOptions,
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
  let threadStarterMedia: Awaited<ReturnType<typeof resolveSlackMedia>> = null;
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
        envelope: envelopeOptions,
      });
      const snippet = starter.text.replace(/\s+/g, " ").slice(0, 80);
      threadLabel = `Slack thread ${roomLabel}${snippet ? `: ${snippet}` : ""}`;
      // If current message has no files but thread starter does, fetch starter's files
      if (!media && starter.files && starter.files.length > 0) {
        threadStarterMedia = await resolveSlackMedia({
          files: starter.files,
          token: ctx.botToken,
          maxBytes: ctx.mediaMaxBytes,
        });
        if (threadStarterMedia) {
          logVerbose(
            `slack: hydrated thread starter file ${threadStarterMedia.placeholder} from root message`,
          );
        }
      }
    } else {
      threadLabel = `Slack thread ${roomLabel}`;
    }
  }

  // Use thread starter media if current message has none
  const effectiveMedia = media ?? threadStarterMedia;

  const ctxPayload = finalizeInboundContext({
    Body: combinedBody,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: slackFrom,
    To: slackTo,
    SessionKey: sessionKey,
    AccountId: route.accountId,
    ChatType: isDirectMessage ? "direct" : "channel",
    ConversationLabel: envelopeFrom,
    GroupSubject: isRoomish ? roomLabel : undefined,
    GroupSystemPrompt: isRoomish ? groupSystemPrompt : undefined,
    SenderName: senderName,
    SenderId: senderId,
    Provider: "slack" as const,
    Surface: "slack" as const,
    MessageSid: message.ts,
    ReplyToId: threadContext.replyToId,
    // Preserve thread context for routed tool notifications.
    MessageThreadId: threadContext.messageThreadId,
    ParentSessionKey: threadKeys.parentSessionKey,
    ThreadStarterBody: threadStarterBody,
    ThreadLabel: threadLabel,
    Timestamp: message.ts ? Math.round(Number(message.ts) * 1000) : undefined,
    WasMentioned: isRoomish ? effectiveWasMentioned : undefined,
    MediaPath: effectiveMedia?.path,
    MediaType: effectiveMedia?.contentType,
    MediaUrl: effectiveMedia?.path,
    CommandAuthorized: commandAuthorized,
    OriginatingChannel: "slack" as const,
    OriginatingTo: slackTo,
  }) satisfies FinalizedMsgContext;

  await recordInboundSession({
    storePath,
    sessionKey,
    ctx: ctxPayload,
    updateLastRoute: isDirectMessage
      ? {
          sessionKey: route.mainSessionKey,
          channel: "slack",
          to: `user:${message.user}`,
          accountId: route.accountId,
        }
      : undefined,
    onRecordError: (err) => {
      ctx.logger.warn(
        {
          error: String(err),
          storePath,
          sessionKey,
        },
        "failed updating session meta",
      );
    },
  });

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
