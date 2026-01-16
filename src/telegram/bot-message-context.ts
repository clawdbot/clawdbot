// @ts-nocheck
import { resolveAckReaction } from "../agents/identity.js";
import { hasControlCommand } from "../auto-reply/command-detection.js";
import { normalizeCommandBody } from "../auto-reply/commands-registry.js";
import { formatAgentEnvelope } from "../auto-reply/envelope.js";
import { buildHistoryContextFromMap } from "../auto-reply/reply/history.js";
import { buildMentionRegexes, matchesMentionPatterns } from "../auto-reply/reply/mentions.js";
import { formatLocationText, toLocationContext } from "../channels/location.js";
import { resolveStorePath, updateLastRoute } from "../config/sessions.js";
import { logVerbose, shouldLogVerbose } from "../globals.js";
import { recordChannelActivity } from "../infra/channel-activity.js";
import { resolveAgentRoute } from "../routing/resolve-route.js";
import {
  buildGroupFromLabel,
  buildGroupLabel,
  buildSenderLabel,
  buildSenderName,
  buildTelegramGroupFrom,
  buildTelegramGroupPeerId,
  buildTelegramThreadParams,
  buildTypingThreadParams,
  describeReplyTarget,
  extractTelegramLocation,
  hasBotMention,
  resolveTelegramForumThreadId,
} from "./bot/helpers.js";
import { firstDefined, isSenderAllowed, normalizeAllowFrom } from "./bot-access.js";
import { upsertTelegramPairingRequest } from "./pairing-store.js";

export const buildTelegramMessageContext = async ({
  primaryCtx,
  allMedia,
  storeAllowFrom,
  options,
  bot,
  cfg,
  account,
  historyLimit,
  groupHistories,
  dmPolicy,
  allowFrom,
  groupAllowFrom,
  ackReactionScope,
  logger,
  resolveGroupActivation,
  resolveGroupRequireMention,
  resolveTelegramGroupConfig,
}) => {
  const msg = primaryCtx.message;
  recordChannelActivity({
    channel: "telegram",
    accountId: account.accountId,
    direction: "inbound",
  });
  const chatId = msg.chat.id;
  const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
  const messageThreadId = (msg as { message_thread_id?: number }).message_thread_id;
  const isForum = (msg.chat as { is_forum?: boolean }).is_forum === true;
  const resolvedThreadId = resolveTelegramForumThreadId({
    isForum,
    messageThreadId,
  });
  const { groupConfig, topicConfig } = resolveTelegramGroupConfig(chatId, resolvedThreadId);
  const peerId = isGroup ? buildTelegramGroupPeerId(chatId, resolvedThreadId) : String(chatId);
  const route = resolveAgentRoute({
    cfg,
    channel: "telegram",
    accountId: account.accountId,
    peer: {
      kind: isGroup ? "group" : "dm",
      id: peerId,
    },
  });
  const mentionRegexes = buildMentionRegexes(cfg, route.agentId);
  const effectiveDmAllow = normalizeAllowFrom([...(allowFrom ?? []), ...storeAllowFrom]);
  const groupAllowOverride = firstDefined(topicConfig?.allowFrom, groupConfig?.allowFrom);
  const effectiveGroupAllow = normalizeAllowFrom([
    ...(groupAllowOverride ?? groupAllowFrom ?? []),
    ...storeAllowFrom,
  ]);
  const hasGroupAllowOverride = typeof groupAllowOverride !== "undefined";

  if (isGroup && groupConfig?.enabled === false) {
    logVerbose(`Blocked telegram group ${chatId} (group disabled)`);
    return null;
  }
  if (isGroup && topicConfig?.enabled === false) {
    logVerbose(
      `Blocked telegram topic ${chatId} (${resolvedThreadId ?? "unknown"}) (topic disabled)`,
    );
    return null;
  }

  const sendTyping = async () => {
    try {
      await bot.api.sendChatAction(chatId, "typing", buildTypingThreadParams(resolvedThreadId));
    } catch (err) {
      logVerbose(`telegram typing cue failed for chat ${chatId}: ${String(err)}`);
    }
  };

  // DM access control (secure defaults): "pairing" (default) / "allowlist" / "open" / "disabled"
  if (!isGroup) {
    if (dmPolicy === "disabled") return null;

    if (dmPolicy !== "open") {
      const candidate = String(chatId);
      const senderUsername = msg.from?.username ?? "";
      const allowed =
        effectiveDmAllow.hasWildcard ||
        (effectiveDmAllow.hasEntries &&
          isSenderAllowed({
            allow: effectiveDmAllow,
            senderId: candidate,
            senderUsername,
          }));
      if (!allowed) {
        if (dmPolicy === "pairing") {
          try {
            const from = msg.from as
              | {
                  first_name?: string;
                  last_name?: string;
                  username?: string;
                  id?: number;
                }
              | undefined;
            const telegramUserId = from?.id ? String(from.id) : candidate;
            const { code, created } = await upsertTelegramPairingRequest({
              chatId: candidate,
              username: from?.username,
              firstName: from?.first_name,
              lastName: from?.last_name,
            });
            if (created) {
              logger.info(
                {
                  chatId: candidate,
                  username: from?.username,
                  firstName: from?.first_name,
                  lastName: from?.last_name,
                },
                "telegram pairing request",
              );
              await bot.api.sendMessage(
                chatId,
                [
                  "Clawdbot: access not configured.",
                  "",
                  `Your Telegram user id: ${telegramUserId}`,
                  "",
                  `Pairing code: ${code}`,
                  "",
                  "Ask the bot owner to approve with:",
                  "clawdbot pairing approve telegram <code>",
                ].join("\n"),
              );
            }
          } catch (err) {
            logVerbose(`telegram pairing reply failed for chat ${chatId}: ${String(err)}`);
          }
        } else {
          logVerbose(`Blocked unauthorized telegram sender ${candidate} (dmPolicy=${dmPolicy})`);
        }
        return null;
      }
    }
  }

  const botUsername = primaryCtx.me?.username?.toLowerCase();
  const senderId = msg.from?.id ? String(msg.from.id) : "";
  const senderUsername = msg.from?.username ?? "";
  if (isGroup && hasGroupAllowOverride) {
    const allowed = isSenderAllowed({
      allow: effectiveGroupAllow,
      senderId,
      senderUsername,
    });
    if (!allowed) {
      logVerbose(
        `Blocked telegram group sender ${senderId || "unknown"} (group allowFrom override)`,
      );
      return null;
    }
  }
  const commandAuthorized = isSenderAllowed({
    allow: isGroup ? effectiveGroupAllow : effectiveDmAllow,
    senderId,
    senderUsername,
  });
  const computedWasMentioned =
    (Boolean(botUsername) && hasBotMention(msg, botUsername)) ||
    matchesMentionPatterns(msg.text ?? msg.caption ?? "", mentionRegexes);
  const wasMentioned = options?.forceWasMentioned === true ? true : computedWasMentioned;
  const hasAnyMention = (msg.entities ?? msg.caption_entities ?? []).some(
    (ent) => ent.type === "mention",
  );
  const activationOverride = resolveGroupActivation({
    chatId,
    messageThreadId: resolvedThreadId,
    sessionKey: route.sessionKey,
    agentId: route.agentId,
  });
  const baseRequireMention = resolveGroupRequireMention(chatId);
  const requireMention = firstDefined(
    activationOverride,
    topicConfig?.requireMention,
    groupConfig?.requireMention,
    baseRequireMention,
  );
  const shouldBypassMention =
    isGroup &&
    requireMention &&
    !wasMentioned &&
    !hasAnyMention &&
    commandAuthorized &&
    hasControlCommand(msg.text ?? msg.caption ?? "", cfg, { botUsername });
  const effectiveWasMentioned = wasMentioned || shouldBypassMention;
  const canDetectMention = Boolean(botUsername) || mentionRegexes.length > 0;
  if (isGroup && requireMention && canDetectMention) {
    if (!wasMentioned && !shouldBypassMention) {
      logger.info({ chatId, reason: "no-mention" }, "skipping group message");
      return null;
    }
  }

  // ACK reactions
  const ackReaction = resolveAckReaction(cfg, route.agentId);
  const removeAckAfterReply = cfg.messages?.removeAckAfterReply ?? false;
  const shouldAckReaction = () => {
    if (!ackReaction) return false;
    if (ackReactionScope === "all") return true;
    if (ackReactionScope === "direct") return !isGroup;
    if (ackReactionScope === "group-all") return isGroup;
    if (ackReactionScope === "group-mentions") {
      if (!isGroup) return false;
      if (!requireMention) return false;
      if (!canDetectMention) return false;
      return wasMentioned || shouldBypassMention;
    }
    return false;
  };
  const api = bot.api as unknown as {
    setMessageReaction?: (
      chatId: number | string,
      messageId: number,
      reactions: Array<{ type: "emoji"; emoji: string }>,
    ) => Promise<void>;
  };
  const reactionApi =
    typeof api.setMessageReaction === "function" ? api.setMessageReaction.bind(api) : null;
  const ackReactionPromise =
    shouldAckReaction() && msg.message_id && reactionApi
      ? reactionApi(chatId, msg.message_id, [{ type: "emoji", emoji: ackReaction }]).then(
          () => true,
          (err) => {
            logVerbose(`telegram react failed for chat ${chatId}: ${String(err)}`);
            return false;
          },
        )
      : null;

  let placeholder = "";
  if (msg.photo) placeholder = "<media:image>";
  else if (msg.video) placeholder = "<media:video>";
  else if (msg.audio || msg.voice) placeholder = "<media:audio>";
  else if (msg.document) placeholder = "<media:document>";

  const replyTarget = describeReplyTarget(msg);
  const locationData = extractTelegramLocation(msg);
  const locationText = locationData ? formatLocationText(locationData) : undefined;
  const rawText = (msg.text ?? msg.caption ?? "").trim();
  let rawBody = [rawText, locationText].filter(Boolean).join("\n").trim();
  if (!rawBody) rawBody = placeholder;
  if (!rawBody && allMedia.length === 0) return null;

  let bodyText = rawBody;
  if (!bodyText && allMedia.length > 0) {
    bodyText = `<media:image>${allMedia.length > 1 ? ` (${allMedia.length} images)` : ""}`;
  }

  const replySuffix = replyTarget
    ? `\n\n[Replying to ${replyTarget.sender}${
        replyTarget.id ? ` id:${replyTarget.id}` : ""
      }]\n${replyTarget.body}\n[/Replying]`
    : "";
  const groupLabel = isGroup ? buildGroupLabel(msg, chatId, resolvedThreadId) : undefined;
  const body = formatAgentEnvelope({
    channel: "Telegram",
    from: isGroup
      ? buildGroupFromLabel(msg, chatId, senderId, resolvedThreadId)
      : buildSenderLabel(msg, senderId || chatId),
    timestamp: msg.date ? msg.date * 1000 : undefined,
    body: `${bodyText}${replySuffix}`,
  });
  let combinedBody = body;
  const historyKey = isGroup ? buildTelegramGroupPeerId(chatId, resolvedThreadId) : undefined;
  if (isGroup && historyKey && historyLimit > 0) {
    combinedBody = buildHistoryContextFromMap({
      historyMap: groupHistories,
      historyKey,
      limit: historyLimit,
      entry: {
        sender: buildSenderLabel(msg, senderId || chatId),
        body: rawBody,
        timestamp: msg.date ? msg.date * 1000 : undefined,
        messageId: typeof msg.message_id === "number" ? String(msg.message_id) : undefined,
      },
      currentMessage: combinedBody,
      formatEntry: (entry) =>
        formatAgentEnvelope({
          channel: "Telegram",
          from: groupLabel ?? `group:${chatId}`,
          timestamp: entry.timestamp,
          body: `${entry.sender}: ${entry.body} [id:${entry.messageId ?? "unknown"} chat:${chatId}]`,
        }),
    });
  }

  const skillFilter = firstDefined(topicConfig?.skills, groupConfig?.skills);
  const systemPromptParts = [
    groupConfig?.systemPrompt?.trim() || null,
    topicConfig?.systemPrompt?.trim() || null,
  ].filter((entry): entry is string => Boolean(entry));
  const groupSystemPrompt =
    systemPromptParts.length > 0 ? systemPromptParts.join("\n\n") : undefined;
  const commandBody = normalizeCommandBody(rawBody, { botUsername });
  const ctxPayload = {
    Body: combinedBody,
    RawBody: rawBody,
    CommandBody: commandBody,
    From: isGroup ? buildTelegramGroupFrom(chatId, resolvedThreadId) : `telegram:${chatId}`,
    To: `telegram:${chatId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isGroup ? "group" : "direct",
    GroupSubject: isGroup ? (msg.chat.title ?? undefined) : undefined,
    GroupSystemPrompt: isGroup ? groupSystemPrompt : undefined,
    SenderName: buildSenderName(msg),
    SenderId: senderId || undefined,
    SenderUsername: senderUsername || undefined,
    Provider: "telegram",
    Surface: "telegram",
    MessageSid: options?.messageIdOverride ?? String(msg.message_id),
    ReplyToId: replyTarget?.id,
    ReplyToBody: replyTarget?.body,
    ReplyToSender: replyTarget?.sender,
    Timestamp: msg.date ? msg.date * 1000 : undefined,
    WasMentioned: isGroup ? effectiveWasMentioned : undefined,
    MediaPath: allMedia[0]?.path,
    MediaType: allMedia[0]?.contentType,
    MediaUrl: allMedia[0]?.path,
    MediaPaths: allMedia.length > 0 ? allMedia.map((m) => m.path) : undefined,
    MediaUrls: allMedia.length > 0 ? allMedia.map((m) => m.path) : undefined,
    MediaTypes:
      allMedia.length > 0
        ? (allMedia.map((m) => m.contentType).filter(Boolean) as string[])
        : undefined,
    ...(locationData ? toLocationContext(locationData) : undefined),
    CommandAuthorized: commandAuthorized,
    MessageThreadId: resolvedThreadId,
    IsForum: isForum,
    // Originating channel for reply routing.
    OriginatingChannel: "telegram" as const,
    OriginatingTo: `telegram:${chatId}`,
  };

  if (replyTarget && shouldLogVerbose()) {
    const preview = replyTarget.body.replace(/\s+/g, " ").slice(0, 120);
    logVerbose(
      `telegram reply-context: replyToId=${replyTarget.id} replyToSender=${replyTarget.sender} replyToBody="${preview}"`,
    );
  }

  if (!isGroup) {
    const sessionCfg = cfg.session;
    const storePath = resolveStorePath(sessionCfg?.store, {
      agentId: route.agentId,
    });
    await updateLastRoute({
      storePath,
      sessionKey: route.mainSessionKey,
      channel: "telegram",
      to: String(chatId),
      accountId: route.accountId,
    });
  }

  if (shouldLogVerbose()) {
    const preview = body.slice(0, 200).replace(/\n/g, "\\n");
    const mediaInfo = allMedia.length > 1 ? ` mediaCount=${allMedia.length}` : "";
    const topicInfo = resolvedThreadId != null ? ` topic=${resolvedThreadId}` : "";
    logVerbose(
      `telegram inbound: chatId=${chatId} from=${ctxPayload.From} len=${body.length}${mediaInfo}${topicInfo} preview="${preview}"`,
    );
  }

  return {
    ctxPayload,
    primaryCtx,
    msg,
    chatId,
    isGroup,
    resolvedThreadId,
    isForum,
    historyKey,
    historyLimit,
    groupHistories,
    route,
    skillFilter,
    sendTyping,
    ackReactionPromise,
    reactionApi,
    removeAckAfterReply,
    accountId: account.accountId,
  };
};
