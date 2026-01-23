import type { TelegramClient } from "@mtcute/node";
import type { MessageContext } from "@mtcute/dispatcher";
import type { RuntimeEnv } from "clawdbot/plugin-sdk";

import {
  formatLocationText,
  resolveAckReaction,
  resolveMentionGatingWithBypass,
  toLocationContext,
  type NormalizedLocation,
} from "clawdbot/plugin-sdk";
import { getTelegramUserRuntime } from "../runtime.js";
import type { CoreConfig, TelegramUserAccountConfig } from "../types.js";
import { sendMediaTelegramUser, sendMessageTelegramUser } from "../send.js";

const DEFAULT_TEXT_LIMIT = 4000;
const DEFAULT_MEDIA_MAX_MB = 5;

type TelegramUserHandlerParams = {
  client: TelegramClient;
  cfg: CoreConfig;
  runtime: RuntimeEnv;
  accountId: string;
  accountConfig: TelegramUserAccountConfig;
  self?: { id: number; username?: string | null };
};

function normalizeAllowEntry(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  return trimmed
    .replace(/^(telegram-user|telegram|tg):/i, "")
    .replace(/^user:/i, "")
    .trim();
}

function parseAllowlist(entries: Array<string | number> | undefined) {
  const normalized = (entries ?? [])
    .map((entry) => normalizeAllowEntry(String(entry)))
    .filter(Boolean);
  const hasWildcard = normalized.includes("*");
  const usernames = new Set<string>();
  const ids = new Set<string>();
  for (const entry of normalized) {
    if (entry === "*") continue;
    if (/^-?\d+$/.test(entry)) {
      ids.add(entry);
      continue;
    }
    const username = entry.startsWith("@") ? entry.slice(1) : entry;
    if (username) usernames.add(username);
  }
  return { hasWildcard, usernames, ids, hasEntries: normalized.length > 0 };
}

function isSenderAllowed(params: {
  allowFrom: Array<string | number> | undefined;
  senderId: string;
  senderUsername?: string | null;
}): boolean {
  const parsed = parseAllowlist(params.allowFrom);
  if (parsed.hasWildcard) return true;
  if (parsed.ids.has(params.senderId)) return true;
  const username = params.senderUsername?.trim().toLowerCase();
  if (!username) return false;
  return parsed.usernames.has(username.replace(/^@/, ""));
}

function resolveTelegramUserPeer(target: string): number | string {
  if (/^-?\d+$/.test(target)) {
    const parsed = Number.parseInt(target, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return target;
}

function isDestroyedClientError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /client is destroyed/i.test(message);
}

function firstDefined<T>(...values: Array<T | undefined>): T | undefined {
  for (const value of values) {
    if (typeof value !== "undefined") return value;
  }
  return undefined;
}

function buildTelegramUserGroupPeerId(chatId: number | string, threadId?: number) {
  return threadId != null ? `${chatId}:topic:${threadId}` : String(chatId);
}

function buildTelegramUserGroupFrom(chatId: number | string, threadId?: number) {
  return `telegram-user:group:${buildTelegramUserGroupPeerId(chatId, threadId)}`;
}

function buildTelegramUserGroupLabel(
  title: string | undefined,
  chatId: number | string,
  threadId?: number,
) {
  const topicSuffix = threadId != null ? ` topic:${threadId}` : "";
  if (title) return `${title} id:${chatId}${topicSuffix}`;
  return `group:${chatId}${topicSuffix}`;
}

function resolveTelegramUserGroupConfig(
  accountConfig: TelegramUserAccountConfig,
  chatId: number | string,
  threadId?: number,
) {
  const groups = accountConfig.groups ?? {};
  const chatKey = String(chatId);
  const groupConfig = groups[chatKey] ?? groups["*"];
  if (!threadId) return { groupConfig, topicConfig: undefined };
  const topicKey = String(threadId);
  const topicConfig =
    groupConfig?.topics?.[topicKey] ?? groups["*"]?.topics?.[topicKey];
  return { groupConfig, topicConfig };
}

function extractTelegramUserLocation(
  media: MessageContext["media"],
): NormalizedLocation | null {
  if (!media) return null;
  const typed = media as { type?: string };
  if (typed.type === "venue") {
    const venue = media as {
      location: { latitude: number; longitude: number; radius?: number };
      title: string;
      address: string;
    };
    return {
      latitude: venue.location.latitude,
      longitude: venue.location.longitude,
      accuracy: venue.location.radius,
      name: venue.title,
      address: venue.address,
      source: "place",
      isLive: false,
    };
  }
  if (typed.type === "location" || typed.type === "live_location") {
    const location = media as {
      latitude: number;
      longitude: number;
      radius?: number;
    };
    const isLive = typed.type === "live_location";
    return {
      latitude: location.latitude,
      longitude: location.longitude,
      accuracy: location.radius,
      source: isLive ? "live" : "pin",
      isLive,
    };
  }
  return null;
}

function formatTelegramUserPoll(media: MessageContext["media"]): string | null {
  if (!media) return null;
  const typed = media as { type?: string };
  if (typed.type !== "poll") return null;
  const poll = media as {
    question: string;
    answers: Array<{ text: string }>;
    isMultiple?: boolean;
    isQuiz?: boolean;
  };
  const mode = poll.isQuiz ? "quiz" : poll.isMultiple ? "multi" : null;
  const header = `📊 Poll${mode ? ` (${mode})` : ""}: ${poll.question}`;
  const options = poll.answers.map((ans, idx) => `${idx + 1}) ${ans.text}`);
  return [header, ...options].join("\n");
}

function describeReplySender(sender: unknown): string | undefined {
  const typed = sender as {
    type?: string;
    displayName?: string;
    title?: string;
    id?: number;
  };
  if (!typed || typeof typed !== "object") return undefined;
  if (typed.type === "anonymous" && typed.displayName) return typed.displayName;
  if (typed.type === "user" && typed.displayName) return typed.displayName;
  if (typed.type === "chat") {
    if (typed.title) return typed.title;
    if (typed.id != null) return `chat:${typed.id}`;
  }
  return undefined;
}

async function resolveMediaAttachment(params: {
  client: TelegramClient;
  mediaMaxMb: number;
  media: MessageContext["media"];
}) {
  if (!params.media) return null;
  const typed = params.media as { type?: string };
  if (
    typed.type === "location" ||
    typed.type === "live_location" ||
    typed.type === "venue" ||
    typed.type === "poll"
  ) {
    return null;
  }
  const core = getTelegramUserRuntime();
  const maxBytes = Math.max(1, params.mediaMaxMb) * 1024 * 1024;
  if ("fileSize" in params.media && typeof params.media.fileSize === "number") {
    if (params.media.fileSize > maxBytes) {
      throw new Error(`Media exceeds ${(maxBytes / (1024 * 1024)).toFixed(0)}MB limit`);
    }
  }
  const buffer = Buffer.from(await params.client.downloadAsBuffer(params.media));
  const fileName =
    params.media && "fileName" in params.media && typeof params.media.fileName === "string"
      ? params.media.fileName
      : undefined;
  const contentType =
    params.media && "mimeType" in params.media && typeof params.media.mimeType === "string"
      ? params.media.mimeType
      : await core.media.detectMime({ buffer, filePath: fileName });
  const saved = await core.channel.media.saveMediaBuffer(
    buffer,
    contentType,
    "telegram-user",
    maxBytes,
    fileName,
  );
  return {
    path: saved.path,
    contentType: saved.contentType ?? contentType,
  };
}

async function resolveMediaAttachments(params: {
  client: TelegramClient;
  mediaMaxMb: number;
  messages: MessageContext[];
  runtime: RuntimeEnv;
}): Promise<Array<{ path: string; contentType?: string }>> {
  const results: Array<{ path: string; contentType?: string }> = [];
  for (const message of params.messages) {
    if (!message.media) continue;
    const resolved = await resolveMediaAttachment({
      client: params.client,
      mediaMaxMb: params.mediaMaxMb,
      media: message.media,
    }).catch((err) => {
      params.runtime.error?.(`telegram-user media download failed: ${String(err)}`);
      return null;
    });
    if (resolved) results.push(resolved);
  }
  return results;
}

export function createTelegramUserMessageHandler(params: TelegramUserHandlerParams) {
  const { client, cfg, runtime, accountId, accountConfig, self } = params;
  const core = getTelegramUserRuntime();
  const textLimit = accountConfig.textChunkLimit ?? DEFAULT_TEXT_LIMIT;
  const mediaMaxMb = accountConfig.mediaMaxMb ?? DEFAULT_MEDIA_MAX_MB;
  const dmPolicy = accountConfig.dmPolicy ?? "pairing";
  const allowFrom = accountConfig.allowFrom ?? [];
  const groupAllowFrom = accountConfig.groupAllowFrom ?? allowFrom;

  return async (msg: MessageContext) => {
    try {
      if (msg.isOutgoing || msg.isService) return;
      const messageGroup = msg.isMessageGroup ? msg.messages : [msg];
      const isDirect = msg.chat.type === "user";
      const isGroup =
        msg.chat.type === "chat" && msg.chat.chatType !== "channel";
      if (!isDirect && !isGroup) return;

      const sender = await msg.getCompleteSender().catch(() => msg.sender);
      if (sender.type !== "user") return;
      if ("isSelf" in sender && sender.isSelf) return;

      const senderId = String(sender.id);
      const senderPeer = resolveTelegramUserPeer(senderId);
      const senderUsername = "username" in sender ? sender.username : null;
      const senderName = "displayName" in sender ? sender.displayName : senderId;
      const storeAllowFrom = await core.channel.pairing
        .readAllowFromStore("telegram-user")
        .catch(() => []);
      const combinedAllowFrom = [...allowFrom, ...storeAllowFrom];
      const chatId = msg.chat.type === "chat" ? msg.chat.id : undefined;
      const isForum = msg.chat.type === "chat" && msg.chat.isForum === true;
      const threadId =
        isGroup && msg.isTopicMessage
          ? msg.replyToMessage?.threadId ?? undefined
          : undefined;
      const { groupConfig, topicConfig } =
        isGroup && chatId != null
          ? resolveTelegramUserGroupConfig(accountConfig, chatId, threadId)
          : { groupConfig: undefined, topicConfig: undefined };

      const groupAllowOverride = firstDefined(
        topicConfig?.allowFrom,
        groupConfig?.allowFrom,
      );
      const groupAllowEntries = [
        ...((groupAllowOverride ?? groupAllowFrom) as Array<string | number>),
        ...storeAllowFrom,
      ];
      const effectiveGroupAllow = parseAllowlist(groupAllowEntries);
      const effectiveDmAllow = parseAllowlist(combinedAllowFrom);

      if (isDirect) {
        if (dmPolicy === "disabled") return;
        if (
          dmPolicy !== "open" &&
          !isSenderAllowed({
            allowFrom: combinedAllowFrom,
            senderId,
            senderUsername,
          })
        ) {
          if (dmPolicy === "pairing") {
            const pairing = await core.channel.pairing.upsertPairingRequest({
              channel: "telegram-user",
              id: senderId,
              meta: {
                username: senderUsername ?? undefined,
                name: senderName,
              },
            });
            const reply = core.channel.pairing.buildPairingReply({
              channel: "telegram-user",
              idLine: `Telegram user id: ${senderId}`,
              code: pairing.code,
            });
            await sendMessageTelegramUser(`telegram-user:${senderId}`, reply, {
              client,
              accountId,
            });
          }
          return;
        }
      } else if (isGroup) {
        if (groupConfig?.enabled === false) return;
        if (topicConfig?.enabled === false) return;
        if (typeof groupAllowOverride !== "undefined") {
          const allowed = isSenderAllowed({
            allowFrom: groupAllowEntries,
            senderId,
            senderUsername,
          });
          if (!allowed) return;
        }
        const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
        const groupPolicy =
          accountConfig.groupPolicy ?? defaultGroupPolicy ?? "allowlist";
        if (groupPolicy === "disabled") return;
        if (groupPolicy === "allowlist") {
          if (!senderId) return;
          if (!effectiveGroupAllow.hasEntries) return;
          if (
            !isSenderAllowed({
              allowFrom: groupAllowEntries,
              senderId,
              senderUsername,
            })
          ) {
            return;
          }
        }
        if (chatId != null) {
          const groupAllowlist = core.channel.groups.resolveGroupPolicy({
            cfg,
            channel: "telegram-user",
            groupId: String(chatId),
            accountId,
          });
          if (groupAllowlist.allowlistEnabled && !groupAllowlist.allowed) return;
        }
      }

      const primaryMessage =
        messageGroup.find((entry) => entry.text?.trim()) ?? msg;
      const text = primaryMessage.text?.trim() ?? "";
      const locationData = extractTelegramUserLocation(primaryMessage.media);
      const locationText = locationData ? formatLocationText(locationData) : undefined;
      const pollText = formatTelegramUserPoll(primaryMessage.media);
      const allMedia = await resolveMediaAttachments({
        client,
        mediaMaxMb,
        messages: messageGroup,
        runtime,
      });
      const media = allMedia[0] ?? null;
      const rawBody = [text, locationText, pollText].filter(Boolean).join("\n").trim();
      if (!rawBody && !media) return;
      const timestampMs = msg.date ? msg.date * 1000 : undefined;
      const replyInfo = msg.replyToMessage ?? null;
      const replyToId = replyInfo?.id != null ? String(replyInfo.id) : undefined;
      const replyToSender = replyInfo?.sender
        ? describeReplySender(replyInfo.sender)
        : undefined;
      let replyToBody: string | undefined;
      if (replyToId) {
        const replyMessage = await msg.getReplyTo().catch(() => null);
        replyToBody = replyMessage?.text?.trim() || undefined;
      }

      core.channel.activity.record({
        channel: "telegram-user",
        accountId,
        direction: "inbound",
      });

      const groupPeerId =
        isGroup && chatId != null
          ? buildTelegramUserGroupPeerId(chatId, threadId)
          : null;
      const route = core.channel.routing.resolveAgentRoute({
        cfg,
        channel: "telegram-user",
        accountId,
        peer: {
          kind: isGroup ? "group" : "dm",
          id: isGroup && groupPeerId ? groupPeerId : senderId,
        },
      });
      const mentionRegexes = core.channel.mentions.buildMentionRegexes(cfg, route.agentId);
      const hasAnyMention = msg.entities.some(
        (ent) => ent.kind === "mention" || ent.kind === "text_mention",
      );
      const hasControlCommandInMessage = core.channel.text.hasControlCommand(text, cfg, {
        botUsername: self?.username?.trim().toLowerCase(),
      });
      const allowForCommands = isGroup ? effectiveGroupAllow : effectiveDmAllow;
      const senderAllowedForCommands = isSenderAllowed({
        allowFrom: isGroup ? groupAllowEntries : combinedAllowFrom,
        senderId,
        senderUsername,
      });
      const useAccessGroups = cfg.commands?.useAccessGroups !== false;
      const commandAuthorized = core.channel.commands.resolveCommandAuthorizedFromAuthorizers({
        useAccessGroups,
        authorizers: [{ configured: allowForCommands.hasEntries, allowed: senderAllowedForCommands }],
      });
      if (isGroup && hasControlCommandInMessage && !commandAuthorized) return;

      const computedWasMentioned =
        msg.isMention || core.channel.mentions.matchesMentionPatterns(text, mentionRegexes);
      const baseRequireMention = isGroup
        ? core.channel.groups.resolveRequireMention({
            cfg,
            channel: "telegram-user",
            groupId: chatId != null ? String(chatId) : undefined,
            accountId,
          })
        : false;
      const requireMention = firstDefined(
        topicConfig?.requireMention,
        groupConfig?.requireMention,
        baseRequireMention,
      );
      const replySenderId =
        msg.replyToMessage?.sender?.type === "user"
          ? msg.replyToMessage.sender.id
          : undefined;
      const implicitMention =
        isGroup && Boolean(requireMention) && self?.id != null && replySenderId === self.id;
      const canDetectMention =
        Boolean(self?.username) || mentionRegexes.length > 0 || msg.isMention;
      const mentionGate = resolveMentionGatingWithBypass({
        isGroup,
        requireMention: Boolean(requireMention),
        canDetectMention,
        wasMentioned: computedWasMentioned,
        implicitMention,
        hasAnyMention,
        allowTextCommands: true,
        hasControlCommand: hasControlCommandInMessage,
        commandAuthorized,
      });
      const effectiveWasMentioned = mentionGate.effectiveWasMentioned;
      if (isGroup && requireMention && canDetectMention && mentionGate.shouldSkip) {
        return;
      }

      const ackReactionScope = cfg.messages?.ackReactionScope ?? "group-mentions";
      const removeAckAfterReply = cfg.messages?.removeAckAfterReply ?? false;
      const ackReaction = resolveAckReaction(cfg, route.agentId);
      const shouldAckReaction = () => {
        if (!ackReaction) return false;
        if (ackReactionScope === "all") return true;
        if (ackReactionScope === "direct") return !isGroup;
        if (ackReactionScope === "group-all") return isGroup;
        if (ackReactionScope === "group-mentions") {
          return isGroup && Boolean(requireMention) && canDetectMention && effectiveWasMentioned;
        }
        return false;
      };
      const ackReactionPromise = shouldAckReaction()
        ? client
            .sendReaction({
              chatId: isGroup && chatId != null ? chatId : senderPeer,
              message: msg.id,
              emoji: ackReaction,
            })
            .then(() => true)
            .catch((err) => {
              runtime.error?.(`telegram-user ack reaction failed: ${String(err)}`);
              return false;
            })
        : null;
      const storePath = core.channel.session.resolveStorePath(cfg.session?.store, {
        agentId: route.agentId,
      });
      const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(cfg);
      const previousTimestamp = core.channel.session.readSessionUpdatedAt({
        storePath,
        sessionKey: route.sessionKey,
      });
      const groupTitle = msg.chat.type === "chat" ? msg.chat.title : undefined;
      const conversationLabel = isGroup && chatId != null
        ? buildTelegramUserGroupLabel(groupTitle, chatId, threadId)
        : senderName;
      const skillFilter = firstDefined(
        topicConfig?.skills,
        groupConfig?.skills,
      );
      const systemPromptParts = [
        groupConfig?.systemPrompt?.trim() || null,
        topicConfig?.systemPrompt?.trim() || null,
      ].filter((entry): entry is string => Boolean(entry));
      const groupSystemPrompt =
        systemPromptParts.length > 0 ? systemPromptParts.join("\n\n") : undefined;
      const mediaSuffix =
        !rawBody && allMedia.length > 1 ? ` (${allMedia.length} items)` : "";
      const body = core.channel.reply.formatAgentEnvelope({
        channel: "Telegram User",
        from: senderName,
        timestamp: timestampMs,
        previousTimestamp,
        envelope: envelopeOptions,
        body: rawBody || `(media${mediaSuffix})`,
      });

      const ctxPayload = core.channel.reply.finalizeInboundContext({
        Body: body,
        RawBody: text,
        CommandBody: text,
        From: isGroup && chatId != null ? buildTelegramUserGroupFrom(chatId, threadId) : `telegram-user:${senderId}`,
        To: isGroup && chatId != null ? buildTelegramUserGroupFrom(chatId, threadId) : `telegram-user:${senderId}`,
        SessionKey: route.sessionKey,
        AccountId: route.accountId,
        ChatType: isGroup ? "group" : "direct",
        ConversationLabel: conversationLabel,
        GroupSubject: isGroup ? groupTitle ?? undefined : undefined,
        GroupSystemPrompt: isGroup ? groupSystemPrompt : undefined,
        SenderName: senderName,
        SenderId: senderId,
        SenderUsername: senderUsername ?? undefined,
        Provider: "telegram-user" as const,
        Surface: "telegram-user" as const,
        MessageSid: String(msg.id),
        ReplyToId: replyToId ?? String(msg.id),
        ReplyToBody: replyToBody,
        ReplyToSender: replyToSender,
        Timestamp: timestampMs,
        MediaPath: media?.path,
        MediaType: media?.contentType,
        MediaUrl: media?.path,
        MediaPaths: allMedia.length > 0 ? allMedia.map((item) => item.path) : undefined,
        MediaUrls: allMedia.length > 0 ? allMedia.map((item) => item.path) : undefined,
        MediaTypes:
          allMedia.length > 0
            ? (allMedia
                .map((item) => item.contentType)
                .filter(Boolean) as string[])
            : undefined,
        CommandAuthorized: commandAuthorized,
        CommandSource: "text" as const,
        OriginatingChannel: "telegram-user" as const,
        OriginatingTo:
          isGroup && chatId != null
            ? buildTelegramUserGroupFrom(chatId, threadId)
            : `telegram-user:${senderId}`,
        WasMentioned: isGroup ? effectiveWasMentioned : undefined,
        MessageThreadId: threadId,
        IsForum: isForum,
        ...(locationData ? toLocationContext(locationData) : undefined),
      });

      void core.channel.session
        .recordSessionMetaFromInbound({
          storePath,
          sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
          ctx: ctxPayload,
        })
        .catch((err) => {
          runtime.error?.(`telegram-user failed to update session meta: ${String(err)}`);
        });

      if (!isGroup) {
        await core.channel.session.updateLastRoute({
          storePath,
          sessionKey: route.mainSessionKey,
          channel: "telegram-user",
          to: `telegram-user:${senderId}`,
          accountId: route.accountId,
          ctx: ctxPayload,
        });
      }

      let hasReplied = false;
      const replyTarget =
        isGroup && chatId != null ? `telegram-user:${chatId}` : `telegram-user:${senderId}`;
      const typingTarget = isGroup && chatId != null ? chatId : senderPeer;
      const typingParams = isGroup && threadId != null ? { threadId } : undefined;
      const { dispatcher, replyOptions, markDispatchIdle } =
        core.channel.reply.createReplyDispatcherWithTyping({
          responsePrefix: core.channel.reply.resolveEffectiveMessagesConfig(cfg, route.agentId)
            .responsePrefix,
          humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, route.agentId),
          deliver: async (payload) => {
            const replyToId = hasReplied ? undefined : msg.id;
            const replyText = payload.text ?? "";
            const mediaUrl = payload.mediaUrl;
            if (mediaUrl) {
              if (payload.audioAsVoice) {
                await client
                  .sendTyping(typingTarget, "record_voice", typingParams)
                  .catch((err) => {
                    runtime.error?.(`telegram-user voice typing failed: ${String(err)}`);
                  });
              }
              try {
                await sendMediaTelegramUser(replyTarget, replyText, {
                  client,
                  accountId,
                  replyToId,
                  mediaUrl,
                  maxBytes: mediaMaxMb * 1024 * 1024,
                });
              } catch (err) {
                if (isDestroyedClientError(err)) return;
                throw err;
              }
              hasReplied = true;
              core.channel.activity.record({
                channel: "telegram-user",
                accountId,
                direction: "outbound",
              });
              return;
            }
            if (replyText) {
              for (const chunk of core.channel.text.chunkMarkdownText(replyText, textLimit)) {
                const trimmed = chunk.trim();
                if (!trimmed) continue;
                try {
                  await sendMessageTelegramUser(replyTarget, trimmed, {
                    client,
                    accountId,
                    replyToId,
                  });
                } catch (err) {
                  if (isDestroyedClientError(err)) return;
                  throw err;
                }
                hasReplied = true;
                core.channel.activity.record({
                  channel: "telegram-user",
                  accountId,
                  direction: "outbound",
                });
              }
            }
          },
          onReplyStart: async () => {
            await client.sendTyping(typingTarget, "typing", typingParams).catch((err) => {
              if (isDestroyedClientError(err)) return;
              runtime.error?.(`telegram-user typing failed: ${String(err)}`);
            });
          },
          onError: (err) => {
            runtime.error?.(`telegram-user reply failed: ${String(err)}`);
          },
        });

      await core.channel.reply.dispatchReplyFromConfig({
        ctx: ctxPayload,
        cfg,
        dispatcher,
        replyOptions: {
          ...replyOptions,
          skillFilter,
        },
      });
      markDispatchIdle();

      if (removeAckAfterReply && ackReactionPromise) {
        const didAck = await ackReactionPromise;
        if (didAck) {
          await client
            .sendReaction({
              chatId: isGroup && chatId != null ? chatId : senderPeer,
              message: msg.id,
              emoji: null,
            })
            .catch((err) => {
              runtime.error?.(`telegram-user ack reaction cleanup failed: ${String(err)}`);
            });
        }
      }
    } catch (err) {
      runtime.error?.(`telegram-user handler failed: ${String(err)}`);
    }
  };
}
