import {
  buildChannelInboundEventContext,
  resolveChannelInboundRouteEnvelope,
} from "openclaw/plugin-sdk/channel-inbound";
// Qa Channel plugin module implements inbound behavior.
import { resolveStableChannelMessageIngress } from "openclaw/plugin-sdk/channel-ingress-runtime";
import { resolveNativeCommandSessionTargets } from "openclaw/plugin-sdk/command-auth-native";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  buildAgentMediaPayload,
  saveMediaBuffer,
  saveMediaSource,
} from "openclaw/plugin-sdk/media-runtime";
import {
  sanitizeQaBusToolCallArguments,
  type QaBusToolCall,
} from "openclaw/plugin-sdk/qa-channel-protocol";
import {
  buildQaTarget,
  deleteQaBusMessage,
  editQaBusMessage,
  sendQaBusMessage,
  type QaBusMessage,
} from "./bus-client.js";
import { getQaChannelRuntime } from "./runtime.js";
import type { CoreConfig, ResolvedQaChannelAccount } from "./types.js";

function isHttpMediaUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeBase64ForCompare(value: string): string {
  return value.replace(/=+$/u, "").replace(/-/gu, "+").replace(/_/gu, "/");
}

function decodeAttachmentBase64(value: string): Buffer | null {
  const buffer = Buffer.from(value, "base64");
  if (normalizeBase64ForCompare(buffer.toString("base64")) !== normalizeBase64ForCompare(value)) {
    return null;
  }
  return buffer;
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
      const buffer = decodeAttachmentBase64(attachment.contentBase64);
      if (!buffer) {
        console.warn("[qa-channel] inbound attachment contentBase64 rejected (invalid base64)");
        continue;
      }
      const saved = await saveMediaBuffer(
        buffer,
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

function formatQaErrorForLog(error: unknown): string {
  let escaped = "";
  const message = formatErrorMessage(error) || Object.prototype.toString.call(error);
  for (const character of message) {
    const codePoint = character.codePointAt(0) ?? 0;
    const isControl = codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
    const isLineSeparator = codePoint === 0x2028 || codePoint === 0x2029;
    escaped +=
      isControl || isLineSeparator ? `\\u${codePoint.toString(16).padStart(4, "0")}` : character;
  }
  return escaped;
}

function createQaReplyPreview(params: {
  account: ResolvedQaChannelAccount;
  inbound: QaBusMessage;
  target: string;
  toolCalls: QaBusToolCall[];
}) {
  let messageId: string | null = null;
  let currentText = "";
  let pending = Promise.resolve();

  const write = (text: string) => {
    if (!text.trim() || text === currentText) {
      return pending;
    }
    pending = pending.then(async () => {
      if (messageId) {
        await editQaBusMessage({
          baseUrl: params.account.baseUrl,
          accountId: params.account.accountId,
          messageId,
          text,
        });
      } else {
        const response = await sendQaBusMessage({
          baseUrl: params.account.baseUrl,
          accountId: params.account.accountId,
          to: params.target,
          text,
          senderId: params.account.botUserId,
          senderName: params.account.botDisplayName,
          threadId: params.inbound.threadId,
          replyToId: params.inbound.id,
          toolCalls: params.toolCalls,
        });
        messageId = response.message.id;
      }
      currentText = text;
    });
    return pending;
  };

  const clear = async () => {
    await pending.catch(() => undefined);
    if (!messageId) {
      return;
    }
    await deleteQaBusMessage({
      baseUrl: params.account.baseUrl,
      accountId: params.account.accountId,
      messageId,
    });
    messageId = null;
    currentText = "";
  };

  const sendDurable = async (text: string) => {
    if (!text.trim()) {
      return;
    }
    await sendQaBusMessage({
      baseUrl: params.account.baseUrl,
      accountId: params.account.accountId,
      to: params.target,
      text,
      senderId: params.account.botUserId,
      senderName: params.account.botDisplayName,
      threadId: params.inbound.threadId,
      replyToId: params.inbound.id,
      toolCalls: params.toolCalls,
    });
  };

  return {
    clear,
    async deliver(text: string, kind: string) {
      await pending;
      if (kind === "final" && messageId && params.toolCalls.length === 0) {
        await write(text);
        return;
      }
      await clear();
      await sendDurable(text);
    },
    update: write,
  };
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
  const toolCalls: QaBusToolCall[] = [];
  const preview = createQaReplyPreview({
    account: params.account,
    inbound,
    target,
    toolCalls,
  });
  const { route, buildEnvelope } = resolveChannelInboundRouteEnvelope({
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
  const body = buildEnvelope({
    channel: params.channelLabel,
    from: inbound.senderName || inbound.senderId,
    timestamp: inbound.timestamp,
    body: inbound.text,
  });
  const mediaPayload = await resolveQaInboundMediaPayload(inbound.attachments);
  const nativeCommand = inbound.nativeCommand;
  const commandTargets = nativeCommand
    ? resolveNativeCommandSessionTargets({
        agentId: route.agentId,
        sessionPrefix: "qa-channel:slash",
        userId: inbound.senderId,
        targetSessionKey: route.sessionKey,
      })
    : undefined;
  const commandBody = nativeCommand ? `/${nativeCommand.name}` : inbound.text;

  const sessionKey = commandTargets?.sessionKey ?? route.sessionKey;
  const ctxPayload = buildChannelInboundEventContext({
    channel: params.channelId,
    accountId: route.accountId ?? params.account.accountId,
    messageId: inbound.id,
    messageIdFull: inbound.id,
    timestamp: inbound.timestamp,
    from: target,
    sender: { id: inbound.senderId, name: inbound.senderName },
    conversation: {
      kind: inbound.conversation.kind === "direct" ? "direct" : "group",
      id: inbound.conversation.id,
      label:
        inbound.threadTitle ||
        inbound.conversation.title ||
        inbound.senderName ||
        inbound.conversation.id,
      threadId: inbound.threadId,
      nativeChannelId: inbound.conversation.id,
    },
    route: {
      agentId: route.agentId,
      dmScope: route.dmScope,
      accountId: route.accountId,
      routeSessionKey: sessionKey,
      dispatchSessionKey: sessionKey,
    },
    reply: {
      to: target,
      originatingTo: target,
      replyToId: inbound.replyToId,
      messageThreadId: inbound.threadId,
      threadParentId: inbound.threadId ? inbound.conversation.id : undefined,
    },
    message: { body, bodyForAgent: inbound.text, rawBody: inbound.text, commandBody },
    access: {
      commands: { authorized: true },
      mentions: { canDetectMention: isGroup, wasMentioned: Boolean(wasMentioned) },
    },
    command: nativeCommand
      ? { kind: "native", name: nativeCommand.name, body: commandBody, authorized: true }
      : undefined,
    extra: {
      CommandTargetSessionKey: commandTargets?.commandTargetSessionKey,
      GroupSubject: isGroup
        ? inbound.threadTitle || inbound.conversation.title || inbound.conversation.id
        : undefined,
      GroupChannel: inbound.conversation.kind === "channel" ? inbound.conversation.id : undefined,
      ThreadLabel: inbound.threadTitle,
      ...mediaPayload,
    },
  });

  await runtime.channel.inbound.dispatch({
    cfg: params.config as OpenClawConfig,
    channel: params.channelId,
    accountId: params.account.accountId,
    route: { agentId: route.agentId, dmScope: route.dmScope, sessionKey: route.sessionKey },
    ctxPayload,
    delivery: {
      deliver: async (payload, info) => {
        const text =
          payload && typeof payload === "object" && "text" in payload
            ? ((payload as { text?: string }).text ?? "")
            : "";
        if (!text.trim()) {
          return;
        }
        await preview.deliver(text, info?.kind ?? "final");
      },
      onError: (error) => {
        void preview.clear().catch((clearError: unknown) => {
          console.warn(
            `[qa-channel] failed to clear reply preview after dispatch error: ${formatQaErrorForLog(clearError)}`,
          );
        });
        console.warn(`[qa-channel] reply dispatch failed: ${formatQaErrorForLog(error)}`);
      },
    },
    replyOptions: {
      allowToolLifecycleWhenProgressHidden: true,
      onPartialReply: async (payload) => {
        await preview.update(payload.text ?? "");
      },
      onToolStart: (payload) => {
        if (payload.phase && payload.phase !== "start") {
          return;
        }
        const name = payload.name?.trim();
        if (!name) {
          return;
        }
        const args = sanitizeQaBusToolCallArguments(payload.args);
        toolCalls.push({
          name,
          ...(args && Object.keys(args).length > 0 ? { arguments: args } : {}),
        });
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
