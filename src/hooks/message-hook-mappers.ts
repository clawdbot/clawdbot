import type { FinalizedMsgContext } from "../auto-reply/templating.js";
import { getChannelPlugin, normalizeChannelId } from "../channels/plugins/index.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  freezeDiagnosticTraceContext,
  type DiagnosticTraceContext,
} from "../infra/diagnostic-trace-context.js";
import type {
  PluginHookInboundClaimContext,
  PluginHookInboundClaimEvent,
  PluginHookMessageContext,
  PluginHookMessageReceivedEvent,
  PluginHookMessageSentEvent,
} from "../plugins/hook-message.types.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import type {
  MessagePreprocessedHookContext,
  MessageReceivedHookContext,
  MessageSentHookContext,
  MessageTranscribedHookContext,
} from "./internal-hooks.js";

export type CanonicalInboundMessageHookContext = {
  from: string;
  to?: string;
  content: string;
  body?: string;
  bodyForAgent?: string;
  transcript?: string;
  timestamp?: number;
  channelId: string;
  accountId?: string;
  conversationId?: string;
  sessionKey?: string;
  runId?: string;
  messageId?: string;
  senderId?: string;
  senderName?: string;
  senderUsername?: string;
  senderE164?: string;
  provider?: string;
  surface?: string;
  threadId?: string | number;
  // `mediaPath(s)` are files OpenClaw has already staged locally. `mediaUrl(s)`
  // are provider/media-server references that may not exist on this host.
  mediaPath?: string;
  mediaUrl?: string;
  mediaType?: string;
  mediaPaths?: string[];
  mediaUrls?: string[];
  mediaTypes?: string[];
  originatingChannel?: string;
  originatingTo?: string;
  guildId?: string;
  channelName?: string;
  isGroup: boolean;
  groupId?: string;
  topicName?: string;
  trace?: DiagnosticTraceContext;
  callDepth?: number;
};

export type CanonicalSentMessageHookContext = {
  to: string;
  content: string;
  success: boolean;
  error?: string;
  channelId: string;
  accountId?: string;
  conversationId?: string;
  sessionKey?: string;
  runId?: string;
  messageId?: string;
  trace?: DiagnosticTraceContext;
  callDepth?: number;
  isGroup?: boolean;
  groupId?: string;
};

export function deriveInboundMessageHookContext(
  ctx: FinalizedMsgContext,
  overrides?: {
    content?: string;
    messageId?: string;
  },
): CanonicalInboundMessageHookContext {
  const content =
    overrides?.content ??
    (typeof ctx.BodyForCommands === "string"
      ? ctx.BodyForCommands
      : typeof ctx.RawBody === "string"
        ? ctx.RawBody
        : typeof ctx.Body === "string"
          ? ctx.Body
          : "");
  const channelId = normalizeLowercaseStringOrEmpty(
    ctx.OriginatingChannel ?? ctx.Surface ?? ctx.Provider ?? "",
  );
  const conversationId = ctx.OriginatingTo ?? ctx.To ?? ctx.From ?? undefined;
  const isGroup = Boolean(ctx.GroupSubject || ctx.GroupChannel);
  const mediaPaths = Array.isArray(ctx.MediaPaths)
    ? ctx.MediaPaths.filter(
        (value): value is string => typeof value === "string" && value.length > 0,
      )
    : undefined;
  const mediaTypes = Array.isArray(ctx.MediaTypes)
    ? ctx.MediaTypes.filter(
        (value): value is string => typeof value === "string" && value.length > 0,
      )
    : undefined;
  const mediaUrls = Array.isArray(ctx.MediaUrls)
    ? ctx.MediaUrls.filter(
        (value): value is string => typeof value === "string" && value.length > 0,
      )
    : undefined;
  return {
    from: ctx.From ?? "",
    to: ctx.To,
    content,
    body: ctx.Body,
    bodyForAgent: ctx.BodyForAgent,
    transcript: ctx.Transcript,
    timestamp:
      typeof ctx.Timestamp === "number" && Number.isFinite(ctx.Timestamp)
        ? ctx.Timestamp
        : undefined,
    channelId,
    accountId: ctx.AccountId,
    conversationId,
    sessionKey: ctx.SessionKey,
    messageId:
      overrides?.messageId ??
      ctx.MessageSidFull ??
      ctx.MessageSid ??
      ctx.MessageSidFirst ??
      ctx.MessageSidLast,
    senderId: ctx.SenderId,
    senderName: ctx.SenderName,
    senderUsername: ctx.SenderUsername,
    senderE164: ctx.SenderE164,
    provider: ctx.Provider,
    surface: ctx.Surface,
    threadId: ctx.MessageThreadId,
    mediaPath: ctx.MediaPath ?? mediaPaths?.[0],
    mediaUrl: ctx.MediaUrl ?? mediaUrls?.[0],
    mediaType: ctx.MediaType ?? mediaTypes?.[0],
    mediaPaths,
    mediaUrls,
    mediaTypes,
    originatingChannel: ctx.OriginatingChannel,
    originatingTo: ctx.OriginatingTo,
    guildId: ctx.GroupSpace,
    channelName: ctx.GroupChannel,
    isGroup,
    groupId: isGroup ? conversationId : undefined,
    topicName: ctx.TopicName,
  };
}

export function buildCanonicalSentMessageHookContext(params: {
  to: string;
  content: string;
  success: boolean;
  error?: string;
  channelId: string;
  accountId?: string;
  conversationId?: string;
  sessionKey?: string;
  runId?: string;
  messageId?: string;
  trace?: DiagnosticTraceContext;
  callDepth?: number;
  isGroup?: boolean;
  groupId?: string;
}): CanonicalSentMessageHookContext {
  return {
    to: params.to,
    content: params.content,
    success: params.success,
    error: params.error,
    channelId: params.channelId,
    accountId: params.accountId,
    conversationId: params.conversationId ?? params.to,
    sessionKey: params.sessionKey,
    runId: params.runId,
    messageId: params.messageId,
    trace: params.trace,
    callDepth: params.callDepth,
    isGroup: params.isGroup,
    groupId: params.groupId,
  };
}

type DiagnosticTraceHookFields = Pick<
  PluginHookMessageContext,
  "trace" | "traceId" | "spanId" | "parentSpanId"
>;

function assignTraceFields(
  target: DiagnosticTraceHookFields,
  trace?: DiagnosticTraceContext,
): void {
  if (!trace) {
    return;
  }
  const safeTrace = freezeDiagnosticTraceContext(trace);
  target.trace = safeTrace;
  target.traceId = safeTrace.traceId;
  if (safeTrace.spanId) {
    target.spanId = safeTrace.spanId;
  }
  if (safeTrace.parentSpanId) {
    target.parentSpanId = safeTrace.parentSpanId;
  }
}

export function toPluginMessageContext(
  canonical: CanonicalInboundMessageHookContext | CanonicalSentMessageHookContext,
): PluginHookMessageContext {
  const context: PluginHookMessageContext = {
    channelId: canonical.channelId,
    accountId: canonical.accountId,
    conversationId: canonical.conversationId,
  };
  if (canonical.sessionKey) {
    context.sessionKey = canonical.sessionKey;
  }
  if (canonical.runId) {
    context.runId = canonical.runId;
  }
  if (canonical.messageId) {
    context.messageId = canonical.messageId;
  }
  if ("senderId" in canonical && canonical.senderId) {
    context.senderId = canonical.senderId;
  }
  assignTraceFields(context, canonical.trace);
  if (canonical.callDepth != null) {
    context.callDepth = canonical.callDepth;
  }
  return context;
}

function stripChannelPrefix(value: string | undefined, channelId: string): string | undefined {
  if (!value) {
    return undefined;
  }
  const genericPrefixes = ["channel:", "chat:", "user:"];
  for (const prefix of genericPrefixes) {
    if (value.startsWith(prefix)) {
      return value.slice(prefix.length);
    }
  }
  const prefix = `${channelId}:`;
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

function resolveInboundConversation(canonical: CanonicalInboundMessageHookContext): {
  conversationId?: string;
  parentConversationId?: string;
} {
  const channelId = normalizeChannelId(canonical.channelId);
  const pluginResolved = channelId
    ? getChannelPlugin(channelId)?.messaging?.resolveInboundConversation?.({
        from: canonical.from,
        to: canonical.to ?? canonical.originatingTo,
        conversationId: canonical.conversationId,
        threadId: canonical.threadId,
        isGroup: canonical.isGroup,
      })
    : null;
  if (pluginResolved) {
    return {
      conversationId: normalizeOptionalString(pluginResolved.conversationId),
      parentConversationId: normalizeOptionalString(pluginResolved.parentConversationId),
    };
  }
  const baseConversationId = stripChannelPrefix(
    canonical.to ?? canonical.originatingTo ?? canonical.conversationId,
    canonical.channelId,
  );
  return { conversationId: baseConversationId };
}

export function toPluginInboundClaimContext(
  canonical: CanonicalInboundMessageHookContext,
): PluginHookInboundClaimContext {
  const conversation = resolveInboundConversation(canonical);
  const context: PluginHookInboundClaimContext = {
    channelId: canonical.channelId,
    accountId: canonical.accountId,
    conversationId: conversation.conversationId,
    sessionKey: canonical.sessionKey,
    parentConversationId: conversation.parentConversationId,
    senderId: canonical.senderId,
    messageId: canonical.messageId,
    runId: canonical.runId,
    callDepth: canonical.callDepth,
  };
  assignTraceFields(context, canonical.trace);
  return context;
}

export function toPluginInboundClaimEvent(
  canonical: CanonicalInboundMessageHookContext,
  extras?: {
    commandAuthorized?: boolean;
    wasMentioned?: boolean;
  },
): PluginHookInboundClaimEvent {
  const context = toPluginInboundClaimContext(canonical);
  const event: PluginHookInboundClaimEvent = {
    content: canonical.content,
    body: canonical.body,
    bodyForAgent: canonical.bodyForAgent,
    transcript: canonical.transcript,
    timestamp: canonical.timestamp,
    channel: canonical.channelId,
    accountId: canonical.accountId,
    conversationId: context.conversationId,
    parentConversationId: context.parentConversationId,
    senderId: canonical.senderId,
    senderName: canonical.senderName,
    senderUsername: canonical.senderUsername,
    threadId: canonical.threadId,
    messageId: canonical.messageId,
    sessionKey: canonical.sessionKey,
    runId: canonical.runId,
    isGroup: canonical.isGroup,
    commandAuthorized: extras?.commandAuthorized,
    wasMentioned: extras?.wasMentioned,
    metadata: {
      from: canonical.from,
      to: canonical.to,
      provider: canonical.provider,
      surface: canonical.surface,
      originatingChannel: canonical.originatingChannel,
      originatingTo: canonical.originatingTo,
      senderE164: canonical.senderE164,
      mediaPath: canonical.mediaPath,
      mediaUrl: canonical.mediaUrl,
      mediaType: canonical.mediaType,
      mediaPaths: canonical.mediaPaths,
      mediaUrls: canonical.mediaUrls,
      mediaTypes: canonical.mediaTypes,
      guildId: canonical.guildId,
      channelName: canonical.channelName,
      groupId: canonical.groupId,
      topicName: canonical.topicName,
    },
  };
  assignTraceFields(event, canonical.trace);
  return event;
}

export function toPluginMessageReceivedEvent(
  canonical: CanonicalInboundMessageHookContext,
): PluginHookMessageReceivedEvent {
  const event: PluginHookMessageReceivedEvent = {
    from: canonical.from,
    content: canonical.content,
    timestamp: canonical.timestamp,
    threadId: canonical.threadId,
    messageId: canonical.messageId,
    senderId: canonical.senderId,
    sessionKey: canonical.sessionKey,
    runId: canonical.runId,
    metadata: {
      to: canonical.to,
      provider: canonical.provider,
      surface: canonical.surface,
      threadId: canonical.threadId,
      originatingChannel: canonical.originatingChannel,
      originatingTo: canonical.originatingTo,
      messageId: canonical.messageId,
      senderId: canonical.senderId,
      senderName: canonical.senderName,
      senderUsername: canonical.senderUsername,
      senderE164: canonical.senderE164,
      guildId: canonical.guildId,
      channelName: canonical.channelName,
      topicName: canonical.topicName,
    },
  };
  assignTraceFields(event, canonical.trace);
  return event;
}

export function toPluginMessageSentEvent(
  canonical: CanonicalSentMessageHookContext,
): PluginHookMessageSentEvent {
  const event: PluginHookMessageSentEvent = {
    to: canonical.to,
    content: canonical.content,
    success: canonical.success,
    ...(canonical.messageId ? { messageId: canonical.messageId } : {}),
    ...(canonical.sessionKey ? { sessionKey: canonical.sessionKey } : {}),
    ...(canonical.runId ? { runId: canonical.runId } : {}),
    ...(canonical.error ? { error: canonical.error } : {}),
  };
  assignTraceFields(event, canonical.trace);
  return event;
}

export function toInternalMessageReceivedContext(
  canonical: CanonicalInboundMessageHookContext,
): MessageReceivedHookContext {
  return {
    from: canonical.from,
    content: canonical.content,
    timestamp: canonical.timestamp,
    channelId: canonical.channelId,
    accountId: canonical.accountId,
    conversationId: canonical.conversationId,
    messageId: canonical.messageId,
    metadata: {
      to: canonical.to,
      provider: canonical.provider,
      surface: canonical.surface,
      threadId: canonical.threadId,
      senderId: canonical.senderId,
      senderName: canonical.senderName,
      senderUsername: canonical.senderUsername,
      senderE164: canonical.senderE164,
      guildId: canonical.guildId,
      channelName: canonical.channelName,
      topicName: canonical.topicName,
    },
  };
}

export function toInternalMessageTranscribedContext(
  canonical: CanonicalInboundMessageHookContext,
  cfg: OpenClawConfig,
): MessageTranscribedHookContext & { cfg: OpenClawConfig } {
  const shared = toInternalInboundMessageHookContextBase(canonical);
  return {
    ...shared,
    transcript: canonical.transcript ?? "",
    cfg,
  };
}

export function toInternalMessagePreprocessedContext(
  canonical: CanonicalInboundMessageHookContext,
  cfg: OpenClawConfig,
): MessagePreprocessedHookContext & { cfg: OpenClawConfig } {
  const shared = toInternalInboundMessageHookContextBase(canonical);
  return {
    ...shared,
    transcript: canonical.transcript,
    isGroup: canonical.isGroup,
    groupId: canonical.groupId,
    cfg,
  };
}

function toInternalInboundMessageHookContextBase(canonical: CanonicalInboundMessageHookContext) {
  return {
    from: canonical.from,
    to: canonical.to,
    body: canonical.body,
    bodyForAgent: canonical.bodyForAgent,
    timestamp: canonical.timestamp,
    channelId: canonical.channelId,
    conversationId: canonical.conversationId,
    messageId: canonical.messageId,
    senderId: canonical.senderId,
    senderName: canonical.senderName,
    senderUsername: canonical.senderUsername,
    provider: canonical.provider,
    surface: canonical.surface,
    mediaPath: canonical.mediaPath,
    mediaType: canonical.mediaType,
  };
}

export function toInternalMessageSentContext(
  canonical: CanonicalSentMessageHookContext,
): MessageSentHookContext {
  return {
    to: canonical.to,
    content: canonical.content,
    success: canonical.success,
    ...(canonical.error ? { error: canonical.error } : {}),
    channelId: canonical.channelId,
    accountId: canonical.accountId,
    conversationId: canonical.conversationId,
    messageId: canonical.messageId,
    ...(canonical.isGroup != null ? { isGroup: canonical.isGroup } : {}),
    ...(canonical.groupId ? { groupId: canonical.groupId } : {}),
  };
}
