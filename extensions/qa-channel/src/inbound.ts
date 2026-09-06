import { createAsyncLock } from "openclaw/plugin-sdk/async-lock-runtime";
import {
  buildChannelInboundEventContext,
  formatInboundMediaUnavailableText,
  resolveChannelInboundRouteEnvelope,
  toInboundMediaFactsWithMetadata,
} from "openclaw/plugin-sdk/channel-inbound";
// Qa Channel plugin module implements inbound behavior.
import { resolveStableChannelMessageIngress } from "openclaw/plugin-sdk/channel-ingress-runtime";
import { resolveNativeCommandSessionTargets } from "openclaw/plugin-sdk/command-auth-native";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { getAgentScopedMediaLocalRoots } from "openclaw/plugin-sdk/media-local-roots";
import { saveMediaBuffer, saveMediaSource } from "openclaw/plugin-sdk/media-store";
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
import { sendQaChannelMediaBatch, sendQaChannelText } from "./outbound.js";
import type { PluginRuntime } from "./runtime-api.js";
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

async function resolveQaInboundMediaFacts(
  attachments: QaBusMessage["attachments"],
  maxBytes?: number,
) {
  let unavailableCount = 0;
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return { media: [], unavailableCount };
  }
  const mediaList: Array<{ path?: string; url?: string; contentType?: string | null }> = [];
  for (const attachment of attachments) {
    try {
      if (!attachment?.mimeType) {
        throw new Error("attachment MIME type is missing");
      }
      if (typeof attachment.contentBase64 === "string" && attachment.contentBase64.trim()) {
        const buffer = decodeAttachmentBase64(attachment.contentBase64);
        if (!buffer) {
          throw new Error("invalid base64");
        }
        const saved = await saveMediaBuffer(
          buffer,
          attachment.mimeType,
          "inbound",
          maxBytes,
          attachment.fileName,
        );
        mediaList.push(
          attachment.mediaFactCarrier === "media-store-url"
            ? {
                url: `media://inbound/${saved.id}`,
                contentType: saved.contentType,
              }
            : {
                path: saved.path,
                contentType: saved.contentType,
              },
        );
        continue;
      }
      if (typeof attachment.url === "string" && attachment.url.trim()) {
        if (!isHttpMediaUrl(attachment.url)) {
          throw new Error("attachment URL has a non-http scheme");
        }
        const saved = await saveMediaSource(attachment.url, undefined, "inbound", maxBytes);
        mediaList.push({
          path: saved.path,
          contentType: saved.contentType,
        });
        continue;
      }
      throw new Error("attachment has no content");
    } catch (error) {
      unavailableCount++;
      console.warn(`[qa-channel] inbound attachment unavailable: ${formatQaErrorForLog(error)}`);
    }
  }
  return { media: await toInboundMediaFactsWithMetadata(mediaList), unavailableCount };
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

function normalizeQaToolCallSnapshotValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeQaToolCallSnapshotValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, normalizeQaToolCallSnapshotValue(entry)]),
    );
  }
  return value;
}

function serializeQaToolCallSnapshot(toolCalls: QaBusToolCall[]): string {
  // Call order is chronological trace data; nested argument keys are the
  // unordered surface that must be canonicalized before comparison.
  return JSON.stringify(
    toolCalls.map((toolCall) => ({
      name: toolCall.name,
      ...(toolCall.arguments
        ? { arguments: normalizeQaToolCallSnapshotValue(toolCall.arguments) }
        : {}),
    })),
  );
}

function createQaReplyPreview(params: {
  config: CoreConfig;
  account: ResolvedQaChannelAccount;
  inbound: QaBusMessage;
  target: string;
  toolCalls: QaBusToolCall[];
  mediaLocalRoots: readonly string[];
}) {
  let messageId: string | null = null;
  let currentText = "";
  let lastDurableText = "";
  let lastDurableToolCallSnapshot = "[]";
  // Partials run concurrently with delivery callbacks. Keep edits, deletion,
  // and durable delivery in one queue without poisoning it after an error.
  const withPreviewLock = createAsyncLock();

  const write = async (text: string) => {
    if (!text.trim() || text === currentText) {
      return;
    }
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
  };

  const clear = async () => {
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

  const sendDurable = async (text: string, isError?: boolean, mediaUrls: string[] = []) => {
    if (!text.trim() && mediaUrls.length === 0) {
      return;
    }
    // Media loading can yield while new tools start. Record only the trace that
    // accompanies this successful durable send, never later or failed work.
    const toolCalls = [...params.toolCalls];
    const toolCallSnapshot = serializeQaToolCallSnapshot(toolCalls);
    const message = {
      cfg: params.config,
      accountId: params.account.accountId,
      to: params.target,
      text,
      isError,
      threadId: params.inbound.threadId,
      replyToId: params.inbound.id,
      toolCalls,
    };
    if (mediaUrls.length > 0) {
      await sendQaChannelMediaBatch({
        ...message,
        mediaUrls,
        mediaLocalRoots: params.mediaLocalRoots,
      });
    } else {
      await sendQaChannelText(message);
    }
    lastDurableText = text;
    lastDurableToolCallSnapshot = toolCallSnapshot;
  };

  return {
    clear: () => withPreviewLock(clear),
    deliver: (text: string, kind: string, isError?: boolean, mediaUrls: string[] = []) =>
      withPreviewLock(async () => {
        if (mediaUrls.length > 0) {
          // Tool/block callbacks acknowledge real delivery, not a preview. A new
          // attachment must survive even when its caption matches an earlier send.
          await clear();
          await sendDurable(text, isError, mediaUrls);
          return;
        }
        if (isError === true) {
          // Preview edits cannot add the typed failure marker. Replace any preview
          // with one durable marked message so QA Lab cannot accept it as success.
          await clear();
          await sendDurable(text, true);
          return;
        }
        // Core may close a streamed block with an identical final payload.
        // The block is already durable, so posting the final again duplicates the reply.
        if (
          kind === "final" &&
          text === lastDurableText &&
          serializeQaToolCallSnapshot(params.toolCalls) === lastDurableToolCallSnapshot
        ) {
          // Count equality is not record equality: a same-count final with changed
          // tool records must still be delivered.
          await clear();
          return;
        }
        if (kind === "final" && messageId && params.toolCalls.length === 0) {
          await write(text);
          return;
        }
        await clear();
        await sendDurable(text);
      }),
    update: (text: string) => withPreviewLock(() => write(text)),
  };
}

export async function handleQaInbound(params: {
  channelId: string;
  channelLabel: string;
  account: ResolvedQaChannelAccount;
  config: CoreConfig;
  message: QaBusMessage;
  buildContext?: typeof buildChannelInboundEventContext;
  channelRuntime?: PluginRuntime["channel"];
}) {
  const channelRuntime = params.channelRuntime ?? getQaChannelRuntime().channel;
  const inbound = params.message;
  const target = buildQaTarget({
    chatType: inbound.conversation.kind,
    conversationId: inbound.conversation.id,
    threadId: inbound.threadId,
  });
  const toolCalls: QaBusToolCall[] = [];
  const { route, buildEnvelope } = resolveChannelInboundRouteEnvelope({
    cfg: params.config,
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
  const preview = createQaReplyPreview({
    config: params.config,
    account: params.account,
    inbound,
    target,
    toolCalls,
    mediaLocalRoots: getAgentScopedMediaLocalRoots(params.config, route.agentId),
  });
  const isGroup = inbound.conversation.kind !== "direct";
  const wasMentioned = isGroup
    ? channelRuntime.mentions.matchesMentionPatterns(
        inbound.text,
        channelRuntime.mentions.buildMentionRegexes(params.config, route.agentId),
      )
    : undefined;
  const groupConfig = isGroup
    ? resolveQaGroupConfig({
        account: params.account,
        conversationId: inbound.conversation.id,
        target,
      })
    : undefined;
  const nativeCommand = inbound.nativeCommand;
  const commandTargets = nativeCommand
    ? resolveNativeCommandSessionTargets({
        agentId: route.agentId,
        sessionPrefix: "qa-channel:slash",
        userId: inbound.senderId,
        targetSessionKey: route.sessionKey,
      })
    : undefined;
  const sessionKey = commandTargets?.sessionKey ?? route.sessionKey;
  const access = await resolveStableChannelMessageIngress({
    cfg: params.config,
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
    contextBinding: {
      agentId: route.agentId,
      sessionKey,
      messageId: inbound.id,
      inboundEventKind: "user_request",
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
  const { media, unavailableCount } = await resolveQaInboundMediaFacts(
    inbound.attachments,
    params.account.mediaMaxBytes,
  );
  const bodyForAgent = unavailableCount
    ? formatInboundMediaUnavailableText({
        body: inbound.text,
        notice: `[${unavailableCount} QA attachment${unavailableCount === 1 ? "" : "s"} unavailable]`,
      })
    : inbound.text;
  const body = buildEnvelope({
    channel: params.channelLabel,
    from: inbound.senderName || inbound.senderId,
    timestamp: inbound.timestamp,
    body: bodyForAgent,
  });
  const ctxPayload = (params.buildContext ?? buildChannelInboundEventContext)({
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
    message: { body, bodyForAgent, rawBody: inbound.text, commandBody: inbound.text },
    media,
    channelIngress: access,
    access: {
      commands: { authorized: true },
      mentions: { canDetectMention: isGroup, wasMentioned: Boolean(wasMentioned) },
    },
    command: nativeCommand
      ? { kind: "native", name: nativeCommand.name, body: inbound.text, authorized: true }
      : undefined,
    extra: {
      CommandTargetSessionKey: commandTargets?.commandTargetSessionKey,
      GroupSubject: isGroup
        ? inbound.threadTitle || inbound.conversation.title || inbound.conversation.id
        : undefined,
      GroupChannel: inbound.conversation.kind === "channel" ? inbound.conversation.id : undefined,
      ThreadLabel: inbound.threadTitle,
    },
  });

  await channelRuntime.inbound.dispatch({
    cfg: params.config,
    channel: params.channelId,
    accountId: params.account.accountId,
    route: { agentId: route.agentId, dmScope: route.dmScope, sessionKey: route.sessionKey },
    ctxPayload,
    delivery: {
      deliver: async (payload, info) => {
        const reply =
          payload && typeof payload === "object"
            ? (payload as {
                text?: string;
                mediaUrl?: string;
                mediaUrls?: string[];
                isError?: boolean;
              })
            : undefined;
        const text = reply?.text ?? "";
        const mediaUrls = Array.from(
          new Set(
            [reply?.mediaUrl, ...(reply?.mediaUrls ?? [])].filter(
              (mediaUrl): mediaUrl is string =>
                typeof mediaUrl === "string" && mediaUrl.trim().length > 0,
            ),
          ),
        );
        if (!text.trim() && mediaUrls.length === 0) {
          return;
        }
        await preview.deliver(text, info?.kind ?? "final", reply?.isError, mediaUrls);
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
