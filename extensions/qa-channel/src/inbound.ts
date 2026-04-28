import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { dispatchInboundReplyWithBase } from "openclaw/plugin-sdk/inbound-reply-dispatch";
import {
  buildAgentMediaPayload,
  saveMediaBuffer,
  saveMediaSource,
} from "openclaw/plugin-sdk/media-runtime";
import { buildQaTarget, sendQaBusMessage, type QaBusMessage } from "./bus-client.js";
import { getQaChannelRuntime } from "./runtime.js";
import type { CoreConfig, ResolvedQaChannelAccount } from "./types.js";

export function isHttpMediaUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

async function resolveQaInboundMediaPayload(attachments: QaBusMessage["attachments"]) {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return {};
  }
  const mediaList: Array<{ path: string; contentType?: string | null }> = [];
  for (const attachment of attachments) {
    if (!attachment?.mimeType) {
      continue;
    }
    if (typeof attachment.contentBase64 === "string" && attachment.contentBase64.trim()) {
      const saved = await saveMediaBuffer(
        Buffer.from(attachment.contentBase64, "base64"),
        attachment.mimeType,
        "inbound",
        undefined,
        attachment.fileName,
      );
      mediaList.push({
        path: saved.path,
        contentType: saved.contentType,
      });
      continue;
    }
    if (typeof attachment.url === "string" && attachment.url.trim()) {
      if (!isHttpMediaUrl(attachment.url)) {
        console.warn(
          `[qa-channel] inbound attachment URL rejected (non-http scheme): ${attachment.url}`,
        );
        continue;
      }
      const saved = await saveMediaSource(attachment.url, undefined, "inbound");
      mediaList.push({
        path: saved.path,
        contentType: saved.contentType,
      });
    }
  }
  return mediaList.length > 0 ? buildAgentMediaPayload(mediaList) : {};
}

export async function handleQaInbound(params: {
  channelId: string;
  channelLabel: string;
  account: ResolvedQaChannelAccount;
  config: CoreConfig;
  message: QaBusMessage;
}) {
  const runtime = getQaChannelRuntime();
  const inbound = params.message;
  const target = buildQaTarget({
    chatType: inbound.conversation.kind,
    conversationId: inbound.conversation.id,
    threadId: inbound.threadId,
  });
  const route = runtime.channel.routing.resolveAgentRoute({
    cfg: params.config as OpenClawConfig,
    channel: params.channelId,
    accountId: params.account.accountId,
    peer: {
      kind: inbound.conversation.kind === "direct" ? "direct" : "channel",
      id: target,
    },
  });
  const storePath = runtime.channel.session.resolveStorePath(params.config.session?.store, {
    agentId: route.agentId,
  });
  const previousTimestamp = runtime.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  const body = runtime.channel.reply.formatAgentEnvelope({
    channel: params.channelLabel,
    from: inbound.senderName || inbound.senderId,
    timestamp: inbound.timestamp,
    previousTimestamp,
    envelope: runtime.channel.reply.resolveEnvelopeFormatOptions(params.config as OpenClawConfig),
    body: inbound.text,
  });
  const mediaPayload = await resolveQaInboundMediaPayload(inbound.attachments);

  const ctxPayload = runtime.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: inbound.text,
    RawBody: inbound.text,
    CommandBody: inbound.text,
    From: buildQaTarget({
      chatType: inbound.conversation.kind,
      conversationId: inbound.senderId,
    }),
    To: target,
    SessionKey: route.sessionKey,
    AccountId: route.accountId ?? params.account.accountId,
    ChatType: inbound.conversation.kind === "direct" ? "direct" : "group",
    ConversationLabel:
      inbound.threadTitle ||
      inbound.conversation.title ||
      inbound.senderName ||
      inbound.conversation.id,
    GroupSubject:
      inbound.conversation.kind === "channel"
        ? inbound.threadTitle || inbound.conversation.title || inbound.conversation.id
        : undefined,
    GroupChannel: inbound.conversation.kind === "channel" ? inbound.conversation.id : undefined,
    NativeChannelId: inbound.conversation.id,
    MessageThreadId: inbound.threadId,
    ThreadLabel: inbound.threadTitle,
    ThreadParentId: inbound.threadId ? inbound.conversation.id : undefined,
    SenderName: inbound.senderName,
    SenderId: inbound.senderId,
    Provider: params.channelId,
    Surface: params.channelId,
    MessageSid: inbound.id,
    MessageSidFull: inbound.id,
    ReplyToId: inbound.replyToId,
    Timestamp: inbound.timestamp,
    OriginatingChannel: params.channelId,
    OriginatingTo: target,
    CommandAuthorized: true,
    ...mediaPayload,
  });

  await dispatchInboundReplyWithBase({
    cfg: params.config as OpenClawConfig,
    channel: params.channelId,
    accountId: params.account.accountId,
    route,
    storePath,
    ctxPayload,
    core: runtime,
    deliver: async (payload) => {
      const text =
        payload && typeof payload === "object" && "text" in payload
          ? ((payload as { text?: string }).text ?? "")
          : "";
      if (!text.trim()) {
        return;
      }
      await sendQaBusMessage({
        baseUrl: params.account.baseUrl,
        accountId: params.account.accountId,
        to: target,
        text,
        senderId: params.account.botUserId,
        senderName: params.account.botDisplayName,
        threadId: inbound.threadId,
        replyToId: inbound.id,
      });
    },
    onRecordError: (error) => {
      throw error instanceof Error
        ? error
        : new Error(`qa-channel session record failed: ${String(error)}`);
    },
    onDispatchError: (error) => {
      throw error instanceof Error
        ? error
        : new Error(`qa-channel dispatch failed: ${String(error)}`);
    },
  });
}
