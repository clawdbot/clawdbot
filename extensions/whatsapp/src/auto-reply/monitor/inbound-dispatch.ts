import {
  DEFAULT_TIMING,
  type StatusReactionController,
} from "openclaw/plugin-sdk/channel-feedback";
import type { CommandTurnContext } from "openclaw/plugin-sdk/channel-inbound";
import { deliverInboundReplyWithMessageSendContext } from "openclaw/plugin-sdk/channel-message";
import { hasVisibleInboundReplyDispatch } from "openclaw/plugin-sdk/inbound-reply-dispatch";
import type { FinalizedMsgContext } from "openclaw/plugin-sdk/reply-runtime";
import {
  type DeliverableWhatsAppOutboundPayload,
  normalizeWhatsAppOutboundPayload,
  normalizeWhatsAppPayloadTextPreservingIndentation,
} from "../../outbound-media-contract.js";
import type { WhatsAppReplyDeliveryResult } from "../deliver-reply.js";
import type { WebInboundMsg } from "../types.js";
import { formatGroupMembers } from "./group-members.js";
import type { GroupHistoryEntry } from "./inbound-context.js";
import {
  createChannelMessageReplyPipeline,
  dispatchReplyWithBufferedBlockDispatcher,
  finalizeInboundContext,
  getAgentScopedMediaLocalRoots,
  jidToE164,
  logVerbose,
  resolveChannelMessageSourceReplyDeliveryMode,
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
  ReturnType<typeof createChannelMessageReplyPipeline>["onModelSelected"]
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

type ReplyDeliveryInfo = { kind: ReplyLifecycleKind };

type PendingWhatsAppMediaOnlyPayload = {
  info: ReplyDeliveryInfo;
  mediaUrls: Set<string>;
  payload: DeliverableWhatsAppOutboundPayload<ReplyPayload>;
};

type WhatsAppMediaOnlyFlushResult = {
  delivered: number;
  droppedDuplicateMedia: number;
};

function logWhatsAppReplyDeliveryError(params: {
  err: unknown;
  info: ReplyDeliveryInfo;
  connectionId: string;
  conversationId: string;
  msg: WebInboundMsg;
  replyLogger: ReturnType<typeof getChildLogger>;
}) {
  params.replyLogger.error(
    {
      err: params.err,
      replyKind: params.info.kind,
      correlationId: params.msg.id ?? null,
      connectionId: params.connectionId,
      conversationId: params.conversationId,
      chatId: params.msg.chatId ?? null,
      to: params.msg.from ?? null,
      from: params.msg.to ?? null,
    },
    "auto-reply delivery failed",
  );
}

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
  if (payload.isError === true) {
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

function getWhatsAppPayloadMediaUrls(payload: ReplyPayload): Set<string> {
  return new Set(
    [
      ...(Array.isArray(payload.mediaUrls) ? payload.mediaUrls : []),
      ...(typeof payload.mediaUrl === "string" ? [payload.mediaUrl] : []),
    ]
      .map((url) => url.trim())
      .filter(Boolean),
  );
}

function hasWhatsAppMediaUrlOverlap(left: Set<string>, right: Set<string>): boolean {
  for (const url of left) {
    if (right.has(url)) {
      return true;
    }
  }
  return false;
}

function shouldDeferWhatsAppMediaOnlyPayload(params: {
  info: ReplyDeliveryInfo;
  mediaUrls: Set<string>;
  reply: ReturnType<typeof resolveSendableOutboundReplyParts>;
}): boolean {
  return (
    params.info.kind !== "final" &&
    params.reply.hasMedia &&
    !params.reply.text.trim() &&
    params.mediaUrls.size > 0
  );
}

function createWhatsAppMediaOnlyReplyCoalescer(params: {
  deliver: (pending: PendingWhatsAppMediaOnlyPayload) => Promise<void>;
}) {
  const pendingMediaOnlyPayloads: PendingWhatsAppMediaOnlyPayload[] = [];
  const flushExceptDuplicateMedia = async (
    mediaUrls?: Set<string>,
  ): Promise<WhatsAppMediaOnlyFlushResult> => {
    const flushResult: WhatsAppMediaOnlyFlushResult = {
      delivered: 0,
      droppedDuplicateMedia: 0,
    };
    const pending = pendingMediaOnlyPayloads.splice(0);
    for (const candidate of pending) {
      if (mediaUrls && hasWhatsAppMediaUrlOverlap(candidate.mediaUrls, mediaUrls)) {
        flushResult.droppedDuplicateMedia += 1;
        continue;
      }
      await params.deliver(candidate);
      flushResult.delivered += 1;
    }
    return flushResult;
  };

  return {
    defer(pending: PendingWhatsAppMediaOnlyPayload) {
      pendingMediaOnlyPayloads.push(pending);
    },
    flushExceptDuplicateMedia,
    flushAll: () => flushExceptDuplicateMedia(),
  };
}

function logWhatsAppMediaOnlyFlushResult(result: WhatsAppMediaOnlyFlushResult) {
  if (!shouldLogVerbose()) {
    return;
  }
  if (result.droppedDuplicateMedia > 0) {
    logVerbose(
      `Dropped ${result.droppedDuplicateMedia} deferred media-only WhatsApp reply payload(s) superseded by captioned media`,
    );
  }
  if (result.delivered > 0) {
    logVerbose(`Flushed ${result.delivered} deferred media-only WhatsApp reply payload(s)`);
  }
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
  commandTurn?: CommandTurnContext;
  commandSource?: "text";
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
    CommandTurn: params.commandTurn,
    CommandSource:
      params.commandSource ??
      (params.commandTurn?.source === "native" || params.commandTurn?.source === "text"
        ? params.commandTurn.source
        : undefined),
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

function normalizeCommandTurnFromContext(value: unknown): CommandTurnContext | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Partial<CommandTurnContext>;
  const kind = record.kind;
  const source = record.source;
  if (kind === "native" && source === "native" && typeof record.authorized === "boolean") {
    return {
      kind: "native",
      source: "native",
      authorized: record.authorized,
      commandName: typeof record.commandName === "string" ? record.commandName : undefined,
      body: typeof record.body === "string" ? record.body : undefined,
    };
  }
  if (kind === "text-slash" && source === "text" && typeof record.authorized === "boolean") {
    return {
      kind: "text-slash",
      source: "text",
      authorized: record.authorized,
      commandName: typeof record.commandName === "string" ? record.commandName : undefined,
      body: typeof record.body === "string" ? record.body : undefined,
    };
  }
  if (kind === "normal" && source === "message") {
    return {
      kind: "normal",
      source: "message",
      authorized: false,
      commandName: typeof record.commandName === "string" ? record.commandName : undefined,
      body: typeof record.body === "string" ? record.body : undefined,
    };
  }
  return undefined;
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
    normalizedReplyResult?: DeliverableWhatsAppOutboundPayload<ReplyPayload>;
    msg: WebInboundMsg;
    mediaLocalRoots: readonly string[];
    maxMediaBytes: number;
    textLimit: number;
    chunkMode?: ReturnType<typeof resolveChunkMode>;
    replyLogger: ReturnType<typeof getChildLogger>;
    connectionId?: string;
    skipLog?: boolean;
    tableMode?: ReturnType<typeof resolveMarkdownTableMode>;
  }) => Promise<WhatsAppReplyDeliveryResult>;
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
  statusReactionController?: StatusReactionController | null;
}) {
  const statusReactionController = params.statusReactionController ?? null;
  const statusReactionTiming = {
    ...DEFAULT_TIMING,
    ...params.cfg.messages?.statusReactions?.timing,
  };
  const removeAckAfterReply = params.cfg.messages?.removeAckAfterReply ?? false;
  const textLimit = params.maxMediaTextChunkLimit ?? resolveTextChunkLimit(params.cfg, "whatsapp");
  const chunkMode = resolveChunkMode(params.cfg, "whatsapp", params.route.accountId);
  const tableMode = resolveMarkdownTableMode({
    cfg: params.cfg,
    channel: "whatsapp",
    accountId: params.route.accountId,
  });
  const mediaLocalRoots = getAgentScopedMediaLocalRoots(params.cfg, params.route.agentId);
  const sourceReplyChatType =
    typeof params.context.ChatType === "string" ? params.context.ChatType : params.msg.chatType;
  const sourceReplyCommandSource =
    params.context.CommandSource === "native" || params.context.CommandSource === "text"
      ? params.context.CommandSource
      : undefined;
  const sourceReplyCommandTurn = normalizeCommandTurnFromContext(params.context.CommandTurn);
  const sourceReplyCommandAuthorized =
    typeof params.context.CommandAuthorized === "boolean"
      ? params.context.CommandAuthorized
      : undefined;
  const sourceReplyDeliveryMode =
    sourceReplyChatType === "group" || sourceReplyChatType === "channel"
      ? resolveChannelMessageSourceReplyDeliveryMode({
          cfg: params.cfg,
          ctx: {
            ChatType: sourceReplyChatType,
            CommandTurn: sourceReplyCommandTurn,
            CommandSource: sourceReplyCommandSource,
            CommandAuthorized: sourceReplyCommandAuthorized,
          },
        })
      : undefined;
  const sourceRepliesAreToolOnly = sourceReplyDeliveryMode === "message_tool_only";
  const disableBlockStreaming = sourceRepliesAreToolOnly
    ? true
    : resolveWhatsAppDisableBlockStreaming(params.cfg);
  let didSendReply = false;
  let didLogHeartbeatStrip = false;

  const deliverNormalizedPayload = async (
    normalizedDeliveryPayload: DeliverableWhatsAppOutboundPayload<ReplyPayload>,
    info: ReplyDeliveryInfo,
  ) => {
    const reply = resolveSendableOutboundReplyParts(normalizedDeliveryPayload);
    if (!reply.hasMedia && !reply.text.trim()) {
      return;
    }
    const delivery = await params.deliverReply({
      replyResult: normalizedDeliveryPayload,
      normalizedReplyResult: normalizedDeliveryPayload,
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
    if (!delivery.providerAccepted) {
      params.replyLogger.warn(
        {
          correlationId: params.msg.id ?? null,
          connectionId: params.connectionId,
          conversationId: params.conversationId,
          chatId: params.msg.chatId,
          to: params.msg.from,
          from: params.msg.to,
          replyKind: info.kind,
        },
        "auto-reply was not accepted by WhatsApp provider",
      );
      return;
    }
    didSendReply = true;
    const shouldLog = normalizedDeliveryPayload.text ? true : undefined;
    params.rememberSentText(normalizedDeliveryPayload.text, {
      combinedBody: params.context.Body as string | undefined,
      combinedBodySessionKey: params.route.sessionKey,
      logVerboseMessage: shouldLog,
    });
    const fromDisplay =
      params.msg.chatType === "group" ? params.conversationId : (params.msg.from ?? "unknown");
    if (shouldLogVerbose()) {
      const preview = normalizedDeliveryPayload.text != null ? reply.text : "<media>";
      logVerbose(`Reply body: ${preview}${reply.hasMedia ? " (media)" : ""} -> ${fromDisplay}`);
    }
  };

  const mediaOnlyCoalescer = createWhatsAppMediaOnlyReplyCoalescer({
    deliver: async (pending) => {
      await deliverNormalizedPayload(pending.payload, pending.info);
    },
  });

  if (statusReactionController) {
    void statusReactionController.setThinking();
  }

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
        const normalizedOutboundPayload = normalizeWhatsAppOutboundPayload(deliveryPayload, {
          normalizeText: normalizeWhatsAppPayloadTextPreservingIndentation,
        });
        const normalizedDeliveryPayload =
          deliveryPayload.text === undefined
            ? { ...normalizedOutboundPayload, text: undefined }
            : normalizedOutboundPayload;
        const reply = resolveSendableOutboundReplyParts(normalizedDeliveryPayload);
        if (!reply.hasMedia && !reply.text.trim()) {
          return;
        }
        if (!reply.hasMedia) {
          logWhatsAppMediaOnlyFlushResult(await mediaOnlyCoalescer.flushAll());
          const durable = await deliverInboundReplyWithMessageSendContext({
            cfg: params.cfg,
            channel: "whatsapp",
            accountId: params.route.accountId,
            agentId: params.route.agentId,
            ctxPayload: params.context as FinalizedMsgContext,
            payload: normalizedDeliveryPayload,
            info,
            to: params.msg.from,
            formatting: {
              textLimit,
              tableMode,
              chunkMode,
            },
          });
          if (durable.status === "failed") {
            throw durable.error;
          }
          if (durable.status === "handled_visible") {
            didSendReply = true;
            const shouldLog = normalizedDeliveryPayload.text ? true : undefined;
            params.rememberSentText(normalizedDeliveryPayload.text, {
              combinedBody: params.context.Body as string | undefined,
              combinedBodySessionKey: params.route.sessionKey,
              logVerboseMessage: shouldLog,
            });
            return;
          }
          if (durable.status === "handled_no_send") {
            return;
          }
          await deliverNormalizedPayload(normalizedDeliveryPayload, info);
          return;
        }
        const mediaUrls = getWhatsAppPayloadMediaUrls(normalizedDeliveryPayload);
        if (shouldDeferWhatsAppMediaOnlyPayload({ info, mediaUrls, reply })) {
          mediaOnlyCoalescer.defer({
            info,
            mediaUrls,
            payload: normalizedDeliveryPayload,
          });
          return;
        }
        logWhatsAppMediaOnlyFlushResult(
          await mediaOnlyCoalescer.flushExceptDuplicateMedia(mediaUrls),
        );
        await deliverNormalizedPayload(normalizedDeliveryPayload, info);
      },
      onReplyStart: params.msg.sendComposing,
      ...(statusReactionController
        ? {
            onCompactionStart: async () => {
              await statusReactionController.setCompacting();
            },
            onCompactionEnd: async () => {
              statusReactionController.cancelPending();
              await statusReactionController.setThinking();
            },
          }
        : {}),
      onError: (err, info) => {
        logWhatsAppReplyDeliveryError({
          err,
          info,
          connectionId: params.connectionId,
          conversationId: params.conversationId,
          msg: params.msg,
          replyLogger: params.replyLogger,
        });
      },
    },
    replyOptions: {
      disableBlockStreaming,
      ...(sourceReplyDeliveryMode ? { sourceReplyDeliveryMode } : {}),
      onModelSelected: params.onModelSelected,
      ...(statusReactionController
        ? {
            onToolStart: async (payload: { name?: string }) => {
              const toolName = payload.name?.trim();
              if (toolName) {
                await statusReactionController.setTool(toolName);
              }
            },
          }
        : {}),
    },
  });
  logWhatsAppMediaOnlyFlushResult(await mediaOnlyCoalescer.flushAll());

  const didQueueVisibleReply = hasVisibleInboundReplyDispatch({ queuedFinal, counts });
  if (!didQueueVisibleReply) {
    if (statusReactionController) {
      void finalizeWhatsAppStatusReaction({
        controller: statusReactionController,
        outcome: "error",
        hasFinalResponse: false,
        removeAckAfterReply,
        timing: statusReactionTiming,
      });
    }
    if (params.shouldClearGroupHistory) {
      params.groupHistories.set(params.groupHistoryKey, []);
    }
    logVerbose("Skipping auto-reply: silent token or no text/media returned from resolver");
    return false;
  }

  if (statusReactionController) {
    void finalizeWhatsAppStatusReaction({
      controller: statusReactionController,
      outcome: didSendReply ? "done" : "error",
      hasFinalResponse: didSendReply,
      removeAckAfterReply,
      timing: statusReactionTiming,
    });
  }

  if (params.shouldClearGroupHistory) {
    params.groupHistories.set(params.groupHistoryKey, []);
  }

  return didSendReply;
}

async function finalizeWhatsAppStatusReaction(params: {
  controller: StatusReactionController;
  outcome: "done" | "error";
  hasFinalResponse: boolean;
  removeAckAfterReply: boolean;
  timing: typeof DEFAULT_TIMING;
}): Promise<void> {
  if (params.outcome === "done") {
    await params.controller.setDone();
    if (params.removeAckAfterReply) {
      await new Promise<void>((resolve) => setTimeout(resolve, params.timing.doneHoldMs));
      await params.controller.clear();
    } else {
      await params.controller.restoreInitial();
    }
    return;
  }
  await params.controller.setError();
  if (params.hasFinalResponse) {
    if (params.removeAckAfterReply) {
      await new Promise<void>((resolve) => setTimeout(resolve, params.timing.errorHoldMs));
      await params.controller.clear();
    } else {
      await params.controller.restoreInitial();
    }
    return;
  }
  if (params.removeAckAfterReply) {
    await new Promise<void>((resolve) => setTimeout(resolve, params.timing.errorHoldMs));
  }
  await params.controller.restoreInitial();
}
