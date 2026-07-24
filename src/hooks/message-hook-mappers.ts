import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { FinalizedMsgContext } from "../auto-reply/templating.js";
import { getChannelPlugin, normalizeChannelId } from "../channels/plugins/index.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  freezeDiagnosticTraceContext,
  type DiagnosticTraceContext,
} from "../infra/diagnostic-trace-context.js";
import {
  hasStagedMediaProjection,
  resolveMediaFacts,
  resolveStagedMediaFacts,
} from "../media/media-facts.js";
import type {
  PluginHookInboundClaimContext,
  PluginHookInboundClaimEvent,
  PluginHookMessageContext,
  PluginHookMessageReceivedEvent,
  PluginHookMessageSentEvent,
} from "../plugins/hook-message.types.js";
import { internalSessionConversationId } from "../utils/message-channel-constants.js";
import { stripChannelPrefix } from "../utils/string-readers.js";
import type {
  MessagePreprocessedHookContext,
  MessageReceivedHookContext,
  MessageSentHookContext,
  MessageTranscribedHookContext,
} from "./internal-hooks.js";

type CanonicalInboundMessageHookContext = {
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
  agentId?: string;
  runId?: string;
  messageId?: string;
  senderId?: string;
  senderName?: string;
  senderUsername?: string;
  senderE164?: string;
  replyToId?: string;
  replyToIdFull?: string;
  replyToBody?: string;
  replyToSender?: string;
  replyToIsQuote?: boolean;
  provider?: string;
  surface?: string;
  threadId?: string | number;
  threadParentId?: string | number;
  // `mediaPath(s)` are files OpenClaw has already staged locally. `mediaUrl(s)`
  // are provider/media-server references that may not exist on this host.
  mediaPath?: string;
  mediaUrl?: string;
  mediaType?: string;
  mediaPaths?: string[];
  mediaUrls?: string[];
  mediaTypes?: string[];
  mediaRemoteHost?: string;
  mediaStagingPending?: boolean;
  originalMediaPath?: string;
  originalMediaUrl?: string;
  originalMediaType?: string;
  originalMediaPaths?: string[];
  originalMediaUrls?: string[];
  originalMediaTypes?: string[];
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

type CanonicalSentMessageHookContext = {
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

function readNonBlankString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function assignRemoteMediaStagingMetadata(
  target: Record<string, unknown>,
  canonical: CanonicalInboundMessageHookContext,
) {
  const metadata = {
    mediaRemoteHost: canonical.mediaRemoteHost,
    mediaStagingPending: canonical.mediaStagingPending,
    originalMediaPath: canonical.originalMediaPath,
    originalMediaUrl: canonical.originalMediaUrl,
    originalMediaType: canonical.originalMediaType,
    originalMediaPaths: canonical.originalMediaPaths,
    originalMediaUrls: canonical.originalMediaUrls,
    originalMediaTypes: canonical.originalMediaTypes,
  };
  for (const [key, value] of Object.entries(metadata)) {
    if (value !== undefined) {
      target[key] = value;
    }
  }
}

export function deriveInboundMessageHookContext(
  ctx: FinalizedMsgContext,
  overrides?: {
    content?: string;
    messageId?: string;
  },
): CanonicalInboundMessageHookContext {
  const content =
    overrides?.content ??
    readNonBlankString(ctx.BodyForCommands) ??
    readNonBlankString(ctx.RawBody) ??
    readNonBlankString(ctx.Body) ??
    "";
  const channelId = normalizeLowercaseStringOrEmpty(
    ctx.OriginatingChannel ?? ctx.Surface ?? ctx.Provider ?? "",
  );
  const conversationId =
    ctx.OriginatingTo ??
    ctx.To ??
    ctx.From ??
    internalSessionConversationId(channelId, ctx.SessionKey);
  const isGroup = Boolean(ctx.GroupSubject || ctx.GroupChannel);
  const media = hasStagedMediaProjection(ctx)
    ? resolveStagedMediaFacts(ctx)
    : resolveMediaFacts(ctx);
  const compact = (values: Array<string | undefined>) => {
    const entries = values.filter((value): value is string => Boolean(value));
    return entries.length > 0 ? entries : undefined;
  };
  const mediaPaths = compact(media.map((fact) => fact.path));
  const mediaUrls = compact(media.map((fact) => fact.url ?? fact.path));
  const mediaTypes = compact(media.map((fact) => fact.contentType ?? fact.kind));
  const firstMedia = media[0];
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
    agentId: ctx.AgentId,
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
    replyToId: ctx.ReplyToId,
    replyToIdFull: ctx.ReplyToIdFull,
    replyToBody: ctx.ReplyToBody,
    replyToSender: ctx.ReplyToSender,
    replyToIsQuote: ctx.ReplyToIsQuote,
    provider: ctx.Provider,
    surface: ctx.Surface,
    threadId: ctx.MessageThreadId,
    threadParentId: ctx.ThreadParentId,
    mediaPath: firstMedia?.path ?? mediaPaths?.[0],
    mediaUrl: firstMedia?.url ?? firstMedia?.path ?? mediaUrls?.[0],
    mediaType: firstMedia?.contentType ?? firstMedia?.kind ?? mediaTypes?.[0],
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

/** Resolves the outbound hook target for a reply produced by an inbound channel turn. */
export function resolveInboundReplyHookTarget(
  finalized: FinalizedMsgContext,
  hookCtx: CanonicalInboundMessageHookContext,
): string {
  if (typeof finalized.OriginatingTo === "string" && finalized.OriginatingTo.trim()) {
    return finalized.OriginatingTo;
  }
  if (hookCtx.isGroup) {
    return hookCtx.conversationId ?? hookCtx.to ?? hookCtx.from;
  }
  return hookCtx.from || hookCtx.conversationId || hookCtx.to || "";
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
  if ("replyToId" in canonical && canonical.replyToId !== undefined) {
    context.replyToId = canonical.replyToId;
  }
  if ("replyToIdFull" in canonical && canonical.replyToIdFull !== undefined) {
    context.replyToIdFull = canonical.replyToIdFull;
  }
  if ("replyToBody" in canonical && canonical.replyToBody !== undefined) {
    context.replyToBody = canonical.replyToBody;
  }
  if ("replyToSender" in canonical && canonical.replyToSender !== undefined) {
    context.replyToSender = canonical.replyToSender;
  }
  if ("replyToIsQuote" in canonical && canonical.replyToIsQuote !== undefined) {
    context.replyToIsQuote = canonical.replyToIsQuote;
  }
  assignTraceFields(context, canonical.trace);
  if (canonical.callDepth != null) {
    context.callDepth = canonical.callDepth;
  }
  return context;
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
        threadParentId: canonical.threadParentId,
        isGroup: canonical.isGroup,
      })
    : undefined;
  if (pluginResolved === null) {
    // A plugin-owned null is an explicit rejection, so generic parsing must not reclaim it.
    return {};
  }
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
    agentId: canonical.agentId,
    parentConversationId: conversation.parentConversationId,
    senderId: canonical.senderId,
    messageId: canonical.messageId,
    runId: canonical.runId,
    callDepth: canonical.callDepth,
  };
  if (canonical.replyToId !== undefined) {
    context.replyToId = canonical.replyToId;
  }
  if (canonical.replyToIdFull !== undefined) {
    context.replyToIdFull = canonical.replyToIdFull;
  }
  if (canonical.replyToBody !== undefined) {
    context.replyToBody = canonical.replyToBody;
  }
  if (canonical.replyToSender !== undefined) {
    context.replyToSender = canonical.replyToSender;
  }
  if (canonical.replyToIsQuote !== undefined) {
    context.replyToIsQuote = canonical.replyToIsQuote;
  }
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
    ...(canonical.replyToId !== undefined ? { replyToId: canonical.replyToId } : {}),
    ...(canonical.replyToIdFull !== undefined ? { replyToIdFull: canonical.replyToIdFull } : {}),
    ...(canonical.replyToBody !== undefined ? { replyToBody: canonical.replyToBody } : {}),
    ...(canonical.replyToSender !== undefined ? { replyToSender: canonical.replyToSender } : {}),
    ...(canonical.replyToIsQuote !== undefined ? { replyToIsQuote: canonical.replyToIsQuote } : {}),
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
      replyToId: canonical.replyToId,
      replyToIdFull: canonical.replyToIdFull,
      replyToBody: canonical.replyToBody,
      replyToSender: canonical.replyToSender,
      replyToIsQuote: canonical.replyToIsQuote,
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
  if (event.metadata) {
    assignRemoteMediaStagingMetadata(event.metadata, canonical);
  }
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
    ...(canonical.replyToId !== undefined ? { replyToId: canonical.replyToId } : {}),
    ...(canonical.replyToIdFull !== undefined ? { replyToIdFull: canonical.replyToIdFull } : {}),
    ...(canonical.replyToBody !== undefined ? { replyToBody: canonical.replyToBody } : {}),
    ...(canonical.replyToSender !== undefined ? { replyToSender: canonical.replyToSender } : {}),
    ...(canonical.replyToIsQuote !== undefined ? { replyToIsQuote: canonical.replyToIsQuote } : {}),
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
      replyToId: canonical.replyToId,
      replyToIdFull: canonical.replyToIdFull,
      replyToBody: canonical.replyToBody,
      replyToSender: canonical.replyToSender,
      replyToIsQuote: canonical.replyToIsQuote,
      mediaPath: canonical.mediaPath,
      mediaUrl: canonical.mediaUrl,
      mediaType: canonical.mediaType,
      mediaPaths: canonical.mediaPaths,
      mediaUrls: canonical.mediaUrls,
      mediaTypes: canonical.mediaTypes,
      guildId: canonical.guildId,
      channelName: canonical.channelName,
      topicName: canonical.topicName,
    },
  };
  if (event.metadata) {
    assignRemoteMediaStagingMetadata(event.metadata, canonical);
  }
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
  const context: MessageReceivedHookContext = {
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
      mediaPath: canonical.mediaPath,
      mediaUrl: canonical.mediaUrl,
      mediaType: canonical.mediaType,
      mediaPaths: canonical.mediaPaths,
      mediaUrls: canonical.mediaUrls,
      mediaTypes: canonical.mediaTypes,
      guildId: canonical.guildId,
      channelName: canonical.channelName,
      topicName: canonical.topicName,
    },
  };
  if (context.metadata) {
    assignRemoteMediaStagingMetadata(context.metadata, canonical);
  }
  return context;
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
