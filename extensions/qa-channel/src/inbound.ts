import { resolveStableChannelMessageIngress } from "openclaw/plugin-sdk/channel-ingress-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveInboundRouteEnvelopeBuilderWithRuntime } from "openclaw/plugin-sdk/inbound-envelope";
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

function resolveQaGroupConfig(params: {
  account: ResolvedQaChannelAccount;
  conversationId: string;
  target: string;
}) {
  const groups = params.account.config.groups;
  return groups?.[params.conversationId] ?? groups?.[params.target] ?? groups?.["*"];
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
  const { route, buildEnvelope } = resolveInboundRouteEnvelopeBuilderWithRuntime({
    cfg: params.config as OpenClawConfig,
    channel: params.channelId,
    accountId: params.account.accountId,
    peer: {
      kind:
        inbound.conversation.kind === "direct"
          ? "direct"
          : inbound.conversation.kind === "group"
            ? "group"
            : "channel",
      id: target,
    },
    runtime: runtime.channel,
    sessionStore: params.config.session?.store,
  });
  const isGroup = inbound.conversation.kind !== "direct";
  const wasMentioned = isGroup
    ? runtime.channel.mentions.matchesMentionPatterns(
        inbound.text,
        runtime.channel.mentions.buildMentionRegexes(
          params.config as OpenClawConfig,
          route.agentId,
        ),
      )
    : undefined;
  const groupConfig = isGroup
    ? resolveQaGroupConfig({
        account: params.account,
        conversationId: inbound.conversation.id,
        target,
      })
    : undefined;
  const access = await resolveStableChannelMessageIngress({
    channelId: params.channelId,
    accountId: params.account.accountId,
    identity: { key: "sender", entryIdPrefix: "qa-entry" },
    groupAllowFromFallbackToAllowFrom: true,
    subject: { stableId: inbound.senderId },
    conversation: {
      kind: inbound.conversation.kind,
      id: inbound.conversation.id,
      threadId: inbound.threadId,
      title: inbound.conversation.title,
    },
    mentionFacts: isGroup
      ? {
          canDetectMention: true,
          wasMentioned: wasMentioned ?? false,
        }
      : undefined,
    dmPolicy: "open",
    groupPolicy: params.account.config.groupPolicy ?? "open",
    policy: {
      activation: isGroup
        ? {
            requireMention: groupConfig?.requireMention ?? false,
            allowTextCommands: true,
          }
        : undefined,
    },
    allowFrom: params.account.config.allowFrom,
    groupAllowFrom: params.account.config.groupAllowFrom,
  });
  if (access.ingress.admission !== "dispatch") {
    return;
  }
  const { storePath, body } = buildEnvelope({
    channel: params.channelLabel,
    from: inbound.senderName || inbound.senderId,
    timestamp: inbound.timestamp,
    body: inbound.text,
  });
  const mediaPayload = await resolveQaInboundMediaPayload(inbound.attachments);

  const ctxPayload = runtime.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: inbound.text,
    RawBody: inbound.text,
    CommandBody: inbound.text,
    From: target,
    To: target,
    SessionKey: route.sessionKey,
    AccountId: route.accountId ?? params.account.accountId,
    ChatType: inbound.conversation.kind === "direct" ? "direct" : "group",
    WasMentioned: wasMentioned,
    ConversationLabel:
      inbound.threadTitle ||
      inbound.conversation.title ||
      inbound.senderName ||
      inbound.conversation.id,
    GroupSubject: isGroup
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

  await runtime.channel.turn.runAssembled({
    cfg: params.config as OpenClawConfig,
    channel: params.channelId,
    accountId: params.account.accountId,
    agentId: route.agentId,
    routeSessionKey: route.sessionKey,
    storePath,
    ctxPayload,
    recordInboundSession: runtime.channel.session.recordInboundSession,
    dispatchReplyWithBufferedBlockDispatcher:
      runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher,
    delivery: {
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
      onError: (error) => {
        throw error instanceof Error
          ? error
          : new Error(`qa-channel dispatch failed: ${String(error)}`);
      },
    },
    replyPipeline: {},
    record: {
      onRecordError: (error) => {
        throw error instanceof Error
          ? error
          : new Error(`qa-channel session record failed: ${String(error)}`);
      },
    },
  });
}
