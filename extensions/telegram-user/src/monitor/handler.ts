import type { TelegramClient } from "@mtcute/node";
import type { MessageContext } from "@mtcute/dispatcher";
import type { RuntimeEnv } from "clawdbot/plugin-sdk";

import { resolveAckReaction } from "clawdbot/plugin-sdk";
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
  return { hasWildcard, usernames, ids };
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

async function resolveMediaAttachment(params: {
  client: TelegramClient;
  mediaMaxMb: number;
  media: MessageContext["media"];
}) {
  if (!params.media) return null;
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

export function createTelegramUserMessageHandler(params: TelegramUserHandlerParams) {
  const { client, cfg, runtime, accountId, accountConfig } = params;
  const core = getTelegramUserRuntime();
  const textLimit = accountConfig.textChunkLimit ?? DEFAULT_TEXT_LIMIT;
  const mediaMaxMb = accountConfig.mediaMaxMb ?? DEFAULT_MEDIA_MAX_MB;
  const dmPolicy = accountConfig.dmPolicy ?? "pairing";
  const allowFrom = accountConfig.allowFrom ?? [];

  return async (msg: MessageContext) => {
    try {
      if (msg.isOutgoing || msg.isService) return;
      if (msg.chat.type !== "user") return;

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

      if (dmPolicy === "disabled") return;
      if (
        dmPolicy !== "open" &&
        !isSenderAllowed({ allowFrom: combinedAllowFrom, senderId, senderUsername })
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

      const text = msg.text?.trim() ?? "";
      const media = await resolveMediaAttachment({
        client,
        mediaMaxMb,
        media: msg.media,
      }).catch((err) => {
        runtime.error?.(`telegram-user media download failed: ${String(err)}`);
        return null;
      });
      if (!text && !media) return;

      core.channel.activity.record({
        channel: "telegram-user",
        accountId,
        direction: "inbound",
      });

      const route = core.channel.routing.resolveAgentRoute({
        cfg,
        channel: "telegram-user",
        accountId,
        peer: {
          kind: "dm",
          id: senderId,
        },
      });
      const ackReactionScope = cfg.messages?.ackReactionScope ?? "group-mentions";
      const removeAckAfterReply = cfg.messages?.removeAckAfterReply ?? false;
      const ackReaction = resolveAckReaction(cfg, route.agentId);
      const shouldAckReaction =
        Boolean(ackReaction) && (ackReactionScope === "all" || ackReactionScope === "direct");
      const ackReactionPromise = shouldAckReaction
        ? client
            .sendReaction({
              chatId: senderPeer,
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
      const body = core.channel.reply.formatAgentEnvelope({
        channel: "Telegram User",
        from: senderName,
        timestamp: msg.date,
        previousTimestamp,
        envelope: envelopeOptions,
        body: text || "(media)",
      });

      const ctxPayload = core.channel.reply.finalizeInboundContext({
        Body: body,
        RawBody: text,
        CommandBody: text,
        From: `telegram-user:${senderId}`,
        To: `telegram-user:${senderId}`,
        SessionKey: route.sessionKey,
        AccountId: route.accountId,
        ChatType: "direct",
        ConversationLabel: senderName,
        SenderName: senderName,
        SenderId: senderId,
        SenderUsername: senderUsername ?? undefined,
        Provider: "telegram-user" as const,
        Surface: "telegram-user" as const,
        MessageSid: String(msg.id),
        ReplyToId: String(msg.id),
        Timestamp: msg.date,
        MediaPath: media?.path,
        MediaType: media?.contentType,
        MediaUrl: media?.path,
        CommandAuthorized: true,
        CommandSource: "text" as const,
        OriginatingChannel: "telegram-user" as const,
        OriginatingTo: `telegram-user:${senderId}`,
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

      await core.channel.session.updateLastRoute({
        storePath,
        sessionKey: route.mainSessionKey,
        channel: "telegram-user",
        to: `telegram-user:${senderId}`,
        accountId: route.accountId,
        ctx: ctxPayload,
      });

      let hasReplied = false;
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
              await sendMediaTelegramUser(`telegram-user:${senderId}`, replyText, {
                client,
                accountId,
                replyToId,
                mediaUrl,
                maxBytes: mediaMaxMb * 1024 * 1024,
              });
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
                await sendMessageTelegramUser(`telegram-user:${senderId}`, trimmed, {
                  client,
                  accountId,
                  replyToId,
                });
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
            await client.sendTyping(senderPeer).catch((err) => {
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
        replyOptions,
      });
      markDispatchIdle();

      if (removeAckAfterReply && ackReactionPromise) {
        const didAck = await ackReactionPromise;
        if (didAck) {
          await client
            .sendReaction({
              chatId: senderPeer,
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
