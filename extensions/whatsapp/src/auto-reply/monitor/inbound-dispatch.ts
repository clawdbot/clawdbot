import type { WebInboundMsg } from "../types.js";
import { formatGroupMembers } from "./group-members.js";
import type { GroupHistoryEntry } from "./inbound-context.js";
import {
  createChannelReplyPipeline,
  dispatchReplyWithBufferedBlockDispatcher,
  finalizeInboundContext,
  getAgentScopedMediaLocalRoots,
  jidToE164,
  logVerbose,
  resolveChunkMode,
  resolveIdentityNamePrefix,
  resolveInboundLastRouteSessionKey,
  resolveMarkdownTableMode,
  resolveSendableOutboundReplyParts,
  resolveTextChunkLimit,
  shouldLogVerbose,
  toLocationContext,
  type getChildLogger,
  type getReplyFromConfig,
  type LoadConfigFn,
  type ReplyPayload,
  type resolveAgentRoute,
} from "./inbound-dispatch.runtime.js";

type ReplyLifecycleKind = "tool" | "block" | "final";
type ChannelReplyOnModelSelected = NonNullable<
  ReturnType<typeof createChannelReplyPipeline>["onModelSelected"]
>;

type WhatsAppDispatchPipeline = {
  responsePrefix?: string;
} & Record<string, unknown>;

type VisibleReplyTarget = {
  id?: string;
  body?: string;
  sender?: {
    label?: string | null;
  } | null;
};

type ReplyThreadingContext = {
  implicitCurrentMessage?: "default" | "allow" | "deny";
};

type SenderContext = {
  id?: string;
  name?: string;
  e164?: string;
};

function resolveWhatsAppDisableBlockStreaming(cfg: ReturnType<LoadConfigFn>): boolean | undefined {
  if (typeof cfg.channels?.whatsapp?.blockStreaming !== "boolean") {
    return undefined;
  }
  return !cfg.channels.whatsapp.blockStreaming;
}

function resolveWhatsAppDeliverablePayload(
  payload: ReplyPayload,
  info: { kind: ReplyLifecycleKind },
): ReplyPayload | null {
  if (payload.isReasoning === true || payload.isCompactionNotice === true) {
    return null;
  }
  if (info.kind === "tool") {
    if (!resolveSendableOutboundReplyParts(payload).hasMedia) {
      return null;
    }
    return { ...payload, text: undefined };
  }
  return payload;
}

export function resolveWhatsAppResponsePrefix(params: {
  cfg: ReturnType<LoadConfigFn>;
  agentId: string;
  isSelfChat: boolean;
  pipelineResponsePrefix?: string;
}): string | undefined {
  const configuredResponsePrefix = params.cfg.messages?.responsePrefix;
  return (
    params.pipelineResponsePrefix ??
    (configuredResponsePrefix === undefined && params.isSelfChat
      ? resolveIdentityNamePrefix(params.cfg, params.agentId)
      : undefined)
  );
}

export function buildWhatsAppInboundContext(params: {
  bodyForAgent?: string;
  combinedBody: string;
  commandBody?: string;
  commandAuthorized?: boolean;
  conversationId: string;
  groupHistory?: GroupHistoryEntry[];
  groupMemberRoster?: Map<string, string>;
  groupSystemPrompt?: string;
  msg: WebInboundMsg;
  rawBody?: string;
  route: ReturnType<typeof resolveAgentRoute>;
  sender: SenderContext;
  transcript?: string;
  mediaTranscribedIndexes?: number[];
  replyThreading?: ReplyThreadingContext;
  visibleReplyTo?: VisibleReplyTarget;
}) {
  const inboundHistory =
    params.msg.chatType === "group"
      ? (params.groupHistory ?? []).map((entry) => ({
          sender: entry.sender,
          body: entry.body,
          timestamp: entry.timestamp,
        }))
      : undefined;

  const result = finalizeInboundContext({
    Body: params.combinedBody,
    BodyForAgent: params.bodyForAgent ?? params.msg.body,
    InboundHistory: inboundHistory,
    RawBody: params.rawBody ?? params.msg.body,
    CommandBody: params.commandBody ?? params.msg.body,
    Transcript: params.transcript,
    From: params.msg.from,
    To: params.msg.to,
    SessionKey: params.route.sessionKey,
    AccountId: params.route.accountId,
    MessageSid: params.msg.id,
    ReplyToId: params.visibleReplyTo?.id,
    ReplyToBody: params.visibleReplyTo?.body,
    ReplyToSender: params.visibleReplyTo?.sender?.label,
    MediaPath: params.msg.mediaPath,
    MediaUrl: params.msg.mediaUrl,
    MediaType: params.msg.mediaType,
    MediaTranscribedIndexes: params.mediaTranscribedIndexes,
    ChatType: params.msg.chatType,
    Timestamp: params.msg.timestamp,
    ConversationLabel: params.msg.chatType === "group" ? params.conversationId : params.msg.from,
    GroupSubject: params.msg.groupSubject,
    GroupMembers: formatGroupMembers({
      participants: params.msg.groupParticipants,
      roster: params.groupMemberRoster,
      fallbackE164: params.sender.e164,
    }),
    SenderName: params.sender.name,
    SenderId: params.sender.id ?? params.sender.e164,
    SenderE164: params.sender.e164,
    CommandAuthorized: params.commandAuthorized,
    ReplyThreading: params.replyThreading,
    WasMentioned: params.msg.wasMentioned,
    GroupSystemPrompt: params.groupSystemPrompt,
    UntrustedStructuredContext: params.msg.untrustedStructuredContext,
    ...(params.msg.location ? toLocationContext(params.msg.location) : {}),
    Provider: "whatsapp",
    Surface: "whatsapp",
    OriginatingChannel: "whatsapp",
    OriginatingTo: params.msg.from,
  });
  return result;
}

export function resolveWhatsAppDmRouteTarget(params: {
  msg: WebInboundMsg;
  senderE164?: string;
  normalizeE164: (value: string) => string | null;
}): string | undefined {
  if (params.msg.chatType === "group") {
    return undefined;
  }
  if (params.senderE164) {
    return params.normalizeE164(params.senderE164) ?? undefined;
  }
  if (params.msg.from.includes("@")) {
    return jidToE164(params.msg.from) ?? undefined;
  }
  return params.normalizeE164(params.msg.from) ?? undefined;
}

export function updateWhatsAppMainLastRoute(params: {
  backgroundTasks: Set<Promise<unknown>>;
  cfg: ReturnType<LoadConfigFn>;
  ctx: Record<string, unknown>;
  dmRouteTarget?: string;
  pinnedMainDmRecipient: string | null;
  route: ReturnType<typeof resolveAgentRoute>;
  updateLastRoute: (params: {
    cfg: ReturnType<LoadConfigFn>;
    backgroundTasks: Set<Promise<unknown>>;
    storeAgentId: string;
    sessionKey: string;
    channel: "whatsapp";
    to: string;
    accountId?: string;
    ctx: Record<string, unknown>;
    warn: ReturnType<typeof getChildLogger>["warn"];
  }) => void;
  warn: ReturnType<typeof getChildLogger>["warn"];
}) {
  const shouldUpdateMainLastRoute =
    !params.pinnedMainDmRecipient || params.pinnedMainDmRecipient === params.dmRouteTarget;
  const inboundLastRouteSessionKey = resolveInboundLastRouteSessionKey({
    route: params.route,
    sessionKey: params.route.sessionKey,
  });

  if (
    params.dmRouteTarget &&
    inboundLastRouteSessionKey === params.route.mainSessionKey &&
    shouldUpdateMainLastRoute
  ) {
    params.updateLastRoute({
      cfg: params.cfg,
      backgroundTasks: params.backgroundTasks,
      storeAgentId: params.route.agentId,
      sessionKey: params.route.mainSessionKey,
      channel: "whatsapp",
      to: params.dmRouteTarget,
      accountId: params.route.accountId,
      ctx: params.ctx,
      warn: params.warn,
    });
    return;
  }

  if (
    params.dmRouteTarget &&
    inboundLastRouteSessionKey === params.route.mainSessionKey &&
    params.pinnedMainDmRecipient
  ) {
    logVerbose(
      `Skipping main-session last route update for ${params.dmRouteTarget} (pinned owner ${params.pinnedMainDmRecipient})`,
    );
  }
}

export async function dispatchWhatsAppBufferedReply(params: {
  cfg: ReturnType<LoadConfigFn>;
  connectionId: string;
  context: Record<string, unknown>;
  conversationId: string;
  deliverReply: (params: {
    replyResult: ReplyPayload;
    msg: WebInboundMsg;
    mediaLocalRoots: readonly string[];
    maxMediaBytes: number;
    textLimit: number;
    chunkMode?: ReturnType<typeof resolveChunkMode>;
    replyLogger: ReturnType<typeof getChildLogger>;
    connectionId?: string;
    skipLog?: boolean;
    tableMode?: ReturnType<typeof resolveMarkdownTableMode>;
  }) => Promise<void>;
  groupHistories: Map<string, GroupHistoryEntry[]>;
  groupHistoryKey: string;
  maxMediaBytes: number;
  maxMediaTextChunkLimit?: number;
  msg: WebInboundMsg;
  onModelSelected?: ChannelReplyOnModelSelected;
  rememberSentText: (
    text: string | undefined,
    opts: {
      combinedBody?: string;
      combinedBodySessionKey?: string;
      logVerboseMessage?: boolean;
    },
  ) => void;
  replyLogger: ReturnType<typeof getChildLogger>;
  replyPipeline: WhatsAppDispatchPipeline;
  replyResolver: typeof getReplyFromConfig;
  route: ReturnType<typeof resolveAgentRoute>;
  shouldClearGroupHistory: boolean;
}) {
  const textLimit = params.maxMediaTextChunkLimit ?? resolveTextChunkLimit(params.cfg, "whatsapp");
  const chunkMode = resolveChunkMode(params.cfg, "whatsapp", params.route.accountId);
  const tableMode = resolveMarkdownTableMode({
    cfg: params.cfg,
    channel: "whatsapp",
    accountId: params.route.accountId,
  });
  const mediaLocalRoots = getAgentScopedMediaLocalRoots(params.cfg, params.route.agentId);
  const disableBlockStreaming = resolveWhatsAppDisableBlockStreaming(params.cfg);
  let didSendReply = false;
  let didLogHeartbeatStrip = false;

  const { queuedFinal, counts } = await dispatchReplyWithBufferedBlockDispatcher({
    ctx: params.context,
    cfg: params.cfg,
    replyResolver: params.replyResolver,
    dispatcherOptions: {
      ...params.replyPipeline,
      onHeartbeatStrip: () => {
        if (!didLogHeartbeatStrip) {
          didLogHeartbeatStrip = true;
          logVerbose("Stripped stray HEARTBEAT_OK token from web reply");
        }
      },
      deliver: async (payload: ReplyPayload, info: { kind: ReplyLifecycleKind }) => {
        const deliveryPayload = resolveWhatsAppDeliverablePayload(payload, info);
        if (!deliveryPayload) {
          return;
        }
        await params.deliverReply({
          replyResult: deliveryPayload,
          msg: params.msg,
          mediaLocalRoots,
          maxMediaBytes: params.maxMediaBytes,
          textLimit,
          chunkMode,
          replyLogger: params.replyLogger,
          connectionId: params.connectionId,
          skipLog: false,
          tableMode,
        });
        didSendReply = true;
        const shouldLog = deliveryPayload.text ? true : undefined;
        params.rememberSentText(deliveryPayload.text, {
          combinedBody: params.context.Body as string | undefined,
          combinedBodySessionKey: params.route.sessionKey,
          logVerboseMessage: shouldLog,
        });
        const fromDisplay =
          params.msg.chatType === "group" ? params.conversationId : (params.msg.from ?? "unknown");
        const reply = resolveSendableOutboundReplyParts(deliveryPayload);
        if (shouldLogVerbose()) {
          const preview = deliveryPayload.text != null ? reply.text : "<media>";
          logVerbose(`Reply body: ${preview}${reply.hasMedia ? " (media)" : ""} -> ${fromDisplay}`);
        }
      },
      onReplyStart: params.msg.sendComposing,
    },
    replyOptions: {
      disableBlockStreaming,
      onModelSelected: params.onModelSelected,
    },
  });

  const didQueueVisibleReply =
    queuedFinal || counts.tool > 0 || counts.block > 0 || counts.final > 0;
  if (!didQueueVisibleReply) {
    if (params.shouldClearGroupHistory) {
      params.groupHistories.set(params.groupHistoryKey, []);
    }
    logVerbose("Skipping auto-reply: silent token or no text/media returned from resolver");
    return false;
  }

  if (params.shouldClearGroupHistory) {
    params.groupHistories.set(params.groupHistoryKey, []);
  }

  return didSendReply;
}
