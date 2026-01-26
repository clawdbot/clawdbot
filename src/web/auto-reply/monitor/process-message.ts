import { resolveIdentityNamePrefix } from "../../../agents/identity.js";
import { resolveChunkMode, resolveTextChunkLimit } from "../../../auto-reply/chunk.js";
import {
  formatInboundEnvelope,
  resolveEnvelopeFormatOptions,
} from "../../../auto-reply/envelope.js";
import {
  buildHistoryContextFromEntries,
  type HistoryEntry,
} from "../../../auto-reply/reply/history.js";
import { dispatchReplyWithBufferedBlockDispatcher } from "../../../auto-reply/reply/provider-dispatcher.js";
import type { getReplyFromConfig } from "../../../auto-reply/reply.js";
import type { ReplyPayload } from "../../../auto-reply/types.js";
import { shouldComputeCommandAuthorized } from "../../../auto-reply/command-detection.js";
import { finalizeInboundContext } from "../../../auto-reply/reply/inbound-context.js";
import { toLocationContext } from "../../../channels/location.js";
import { createReplyPrefixContext } from "../../../channels/reply-prefix.js";
import type { loadConfig } from "../../../config/config.js";
import {
  readSessionUpdatedAt,
  recordSessionMetaFromInbound,
  resolveStorePath,
} from "../../../config/sessions.js";
import { resolveMarkdownTableMode } from "../../../config/markdown-tables.js";
import { logVerbose, shouldLogVerbose } from "../../../globals.js";
import type { getChildLogger } from "../../../logging.js";
import { readChannelAllowFromStore } from "../../../pairing/pairing-store.js";
import type { resolveAgentRoute } from "../../../routing/resolve-route.js";
import { jidToE164, normalizeE164 } from "../../../utils.js";
import { newConnectionId } from "../../reconnect.js";
import { formatError } from "../../session.js";
import { deliverWebReply } from "../deliver-reply.js";
import { whatsappInboundLog, whatsappOutboundLog } from "../loggers.js";
import type { WebInboundMsg } from "../types.js";
import { elide } from "../util.js";
import { maybeSendAckReaction } from "./ack-reaction.js";
import { formatGroupMembers } from "./group-members.js";
import { trackBackgroundTask, updateLastRouteInBackground } from "./last-route.js";
import { buildInboundLine } from "./message-line.js";

export type GroupHistoryEntry = {
  sender: string;
  body: string;
  timestamp?: number;
  id?: string;
  senderJid?: string;
};

function normalizeAllowFromE164(values: Array<string | number> | undefined): string[] {
  const list = Array.isArray(values) ? values : [];
  return list
    .map((entry) => String(entry).trim())
    .filter((entry) => entry && entry !== "*")
    .map((entry) => normalizeE164(entry))
    .filter((entry): entry is string => Boolean(entry));
}

async function resolveWhatsAppCommandAuthorized(params: {
  cfg: ReturnType<typeof loadConfig>;
  msg: WebInboundMsg;
}): Promise<boolean> {
  const useAccessGroups = params.cfg.commands?.useAccessGroups !== false;
  if (!useAccessGroups) return true;

  const isGroup = params.msg.chatType === "group";
  const senderE164 = normalizeE164(
    isGroup ? (params.msg.senderE164 ?? "") : (params.msg.senderE164 ?? params.msg.from ?? ""),
  );
  if (!senderE164) return false;

  const configuredAllowFrom = params.cfg.channels?.whatsapp?.allowFrom ?? [];
  const configuredGroupAllowFrom =
    params.cfg.channels?.whatsapp?.groupAllowFrom ??
    (configuredAllowFrom.length > 0 ? configuredAllowFrom : undefined);

  if (isGroup) {
    if (!configuredGroupAllowFrom || configuredGroupAllowFrom.length === 0) return false;
    if (configuredGroupAllowFrom.some((v) => String(v).trim() === "*")) return true;
    return normalizeAllowFromE164(configuredGroupAllowFrom).includes(senderE164);
  }

  const storeAllowFrom = await readChannelAllowFromStore("whatsapp").catch(() => []);
  const combinedAllowFrom = Array.from(
    new Set([...(configuredAllowFrom ?? []), ...storeAllowFrom]),
  );
  const allowFrom =
    combinedAllowFrom.length > 0
      ? combinedAllowFrom
      : params.msg.selfE164
        ? [params.msg.selfE164]
        : [];
  if (allowFrom.some((v) => String(v).trim() === "*")) return true;
  return normalizeAllowFromE164(allowFrom).includes(senderE164);
}

export async function processMessage(params: {
  cfg: ReturnType<typeof loadConfig>;
  msg: WebInboundMsg;
  route: ReturnType<typeof resolveAgentRoute>;
  groupHistoryKey: string;
  groupHistories: Map<string, GroupHistoryEntry[]>;
  groupMemberNames: Map<string, Map<string, string>>;
  connectionId: string;
  verbose: boolean;
  maxMediaBytes: number;
  replyResolver: typeof getReplyFromConfig;
  replyLogger: ReturnType<typeof getChildLogger>;
  backgroundTasks: Set<Promise<unknown>>;
  rememberSentText: (
    text: string | undefined,
    opts: {
      combinedBody?: string;
      combinedBodySessionKey?: string;
      logVerboseMessage?: boolean;
    },
  ) => void;
  echoHas: (key: string) => boolean;
  echoForget: (key: string) => void;
  buildCombinedEchoKey: (p: { sessionKey: string; combinedBody: string }) => string;
  maxMediaTextChunkLimit?: number;
  groupHistory?: GroupHistoryEntry[];
  suppressGroupHistoryClear?: boolean;
}) {
  const conversationId = params.msg.conversationId ?? params.msg.from;
  const storePath = resolveStorePath(params.cfg.session?.store, {
    agentId: params.route.agentId,
  });
  const envelopeOptions = resolveEnvelopeFormatOptions(params.cfg);
  const previousTimestamp = readSessionUpdatedAt({
    storePath,
    sessionKey: params.route.sessionKey,
  });
  let combinedBody = buildInboundLine({
    cfg: params.cfg,
    msg: params.msg,
    agentId: params.route.agentId,
    previousTimestamp,
    envelope: envelopeOptions,
  });
  let shouldClearGroupHistory = false;

  if (params.msg.chatType === "group") {
    const history = params.groupHistory ?? params.groupHistories.get(params.groupHistoryKey) ?? [];
    if (history.length > 0) {
      const historyEntries: HistoryEntry[] = history.map((m) => ({
        sender: m.sender,
        body: m.body,
        timestamp: m.timestamp,
        messageId: m.id,
      }));
      combinedBody = buildHistoryContextFromEntries({
        entries: historyEntries,
        currentMessage: combinedBody,
        excludeLast: false,
        formatEntry: (entry) => {
          const bodyWithId = entry.messageId
            ? `${entry.body}\n[message_id: ${entry.messageId}]`
            : entry.body;
          return formatInboundEnvelope({
            channel: "WhatsApp",
            from: conversationId,
            timestamp: entry.timestamp,
            body: bodyWithId,
            chatType: "group",
            senderLabel: entry.sender,
            envelope: envelopeOptions,
          });
        },
      });
    }
    shouldClearGroupHistory = !(params.suppressGroupHistoryClear ?? false);
  }

  // Echo detection uses combined body so we don't respond twice.
  const combinedEchoKey = params.buildCombinedEchoKey({
    sessionKey: params.route.sessionKey,
    combinedBody,
  });
  if (params.echoHas(combinedEchoKey)) {
    logVerbose("Skipping auto-reply: detected echo for combined message");
    params.echoForget(combinedEchoKey);
    return false;
  }

  // Send ack reaction immediately upon message receipt (post-gating)
  maybeSendAckReaction({
    cfg: params.cfg,
    msg: params.msg,
    agentId: params.route.agentId,
    sessionKey: params.route.sessionKey,
    conversationId,
    verbose: params.verbose,
    accountId: params.route.accountId,
    info: params.replyLogger.info.bind(params.replyLogger),
    warn: params.replyLogger.warn.bind(params.replyLogger),
  });

  const correlationId = params.msg.id ?? newConnectionId();
  params.replyLogger.info(
    {
      connectionId: params.connectionId,
      correlationId,
      from: params.msg.chatType === "group" ? conversationId : params.msg.from,
      to: params.msg.to,
      body: elide(combinedBody, 240),
      mediaType: params.msg.mediaType ?? null,
      mediaPath: params.msg.mediaPath ?? null,
    },
    "inbound web message",
  );

  const fromDisplay = params.msg.chatType === "group" ? conversationId : params.msg.from;
  const kindLabel = params.msg.mediaType ? `, ${params.msg.mediaType}` : "";
  whatsappInboundLog.info(
    `Inbound message ${fromDisplay} -> ${params.msg.to} (${params.msg.chatType}${kindLabel}, ${combinedBody.length} chars)`,
  );
  if (shouldLogVerbose()) {
    whatsappInboundLog.debug(`Inbound body: ${elide(combinedBody, 400)}`);
  }

  const dmRouteTarget =
    params.msg.chatType !== "group"
      ? (() => {
          if (params.msg.senderE164) return normalizeE164(params.msg.senderE164);
          // In direct chats, `msg.from` is already the canonical conversation id.
          if (params.msg.from.includes("@")) return jidToE164(params.msg.from);
          return normalizeE164(params.msg.from);
        })()
      : undefined;

  const textLimit = params.maxMediaTextChunkLimit ?? resolveTextChunkLimit(params.cfg, "whatsapp");
  const chunkMode = resolveChunkMode(params.cfg, "whatsapp", params.route.accountId);
  const tableMode = resolveMarkdownTableMode({
    cfg: params.cfg,
    channel: "whatsapp",
    accountId: params.route.accountId,
  });
  let didLogHeartbeatStrip = false;
  let didSendReply = false;
  const commandAuthorized = shouldComputeCommandAuthorized(params.msg.body, params.cfg)
    ? await resolveWhatsAppCommandAuthorized({ cfg: params.cfg, msg: params.msg })
    : undefined;
  const configuredResponsePrefix = params.cfg.messages?.responsePrefix;
  const prefixContext = createReplyPrefixContext({
    cfg: params.cfg,
    agentId: params.route.agentId,
  });
  const isSelfChat =
    params.msg.chatType !== "group" &&
    Boolean(params.msg.selfE164) &&
    normalizeE164(params.msg.from) === normalizeE164(params.msg.selfE164 ?? "");
  const responsePrefix =
    prefixContext.responsePrefix ??
    (configuredResponsePrefix === undefined && isSelfChat
      ? (resolveIdentityNamePrefix(params.cfg, params.route.agentId) ?? "[clawdbot]")
      : undefined);

  const ctxPayload = finalizeInboundContext({
    Body: combinedBody,
    RawBody: params.msg.body,
    CommandBody: params.msg.body,
    From: params.msg.from,
    To: params.msg.to,
    SessionKey: params.route.sessionKey,
    AccountId: params.route.accountId,
    MessageSid: params.msg.id,
    ReplyToId: params.msg.replyToId,
    ReplyToBody: params.msg.replyToBody,
    ReplyToSender: params.msg.replyToSender,
    MediaPath: params.msg.mediaPath,
    MediaUrl: params.msg.mediaUrl,
    MediaType: params.msg.mediaType,
    ChatType: params.msg.chatType,
    ConversationLabel: params.msg.chatType === "group" ? conversationId : params.msg.from,
    GroupSubject: params.msg.groupSubject,
    GroupMembers: formatGroupMembers({
      participants: params.msg.groupParticipants,
      roster: params.groupMemberNames.get(params.groupHistoryKey),
      fallbackE164: params.msg.senderE164,
    }),
    SenderName: params.msg.senderName,
    SenderId: params.msg.senderJid?.trim() || params.msg.senderE164,
    SenderE164: params.msg.senderE164,
    CommandAuthorized: commandAuthorized,
    WasMentioned: params.msg.wasMentioned,
    ...(params.msg.location ? toLocationContext(params.msg.location) : {}),
    Provider: "whatsapp",
    Surface: "whatsapp",
    OriginatingChannel: "whatsapp",
    OriginatingTo: params.msg.from,
  });

  if (dmRouteTarget) {
    updateLastRouteInBackground({
      cfg: params.cfg,
      backgroundTasks: params.backgroundTasks,
      storeAgentId: params.route.agentId,
      sessionKey: params.route.mainSessionKey,
      channel: "whatsapp",
      to: dmRouteTarget,
      accountId: params.route.accountId,
      ctx: ctxPayload,
      warn: params.replyLogger.warn.bind(params.replyLogger),
    });
  }

  const metaTask = recordSessionMetaFromInbound({
    storePath,
    sessionKey: params.route.sessionKey,
    ctx: ctxPayload,
  }).catch((err) => {
    params.replyLogger.warn(
      {
        error: formatError(err),
        storePath,
        sessionKey: params.route.sessionKey,
      },
      "failed updating session meta",
    );
  });
  trackBackgroundTask(params.backgroundTasks, metaTask);

  const { queuedFinal } = await dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: params.cfg,
    replyResolver: params.replyResolver,
    dispatcherOptions: {
      responsePrefix,
      responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
      onHeartbeatStrip: () => {
        if (!didLogHeartbeatStrip) {
          didLogHeartbeatStrip = true;
          logVerbose("Stripped stray HEARTBEAT_OK token from web reply");
        }
      },
      deliver: async (payload: ReplyPayload, info) => {
        await deliverWebReply({
          replyResult: payload,
          msg: params.msg,
          maxMediaBytes: params.maxMediaBytes,
          textLimit,
          chunkMode,
          replyLogger: params.replyLogger,
          connectionId: params.connectionId,
          // Tool + block updates are noisy; skip their log lines.
          skipLog: info.kind !== "final",
          tableMode,
        });
        didSendReply = true;
        if (info.kind === "tool") {
          params.rememberSentText(payload.text, {});
          return;
        }
        const shouldLog = info.kind === "final" && payload.text ? true : undefined;
        params.rememberSentText(payload.text, {
          combinedBody,
          combinedBodySessionKey: params.route.sessionKey,
          logVerboseMessage: shouldLog,
        });
        if (info.kind === "final") {
          const fromDisplay =
            params.msg.chatType === "group" ? conversationId : (params.msg.from ?? "unknown");
          const hasMedia = Boolean(payload.mediaUrl || payload.mediaUrls?.length);
          whatsappOutboundLog.info(`Auto-replied to ${fromDisplay}${hasMedia ? " (media)" : ""}`);
          if (shouldLogVerbose()) {
            const preview = payload.text != null ? elide(payload.text, 400) : "<media>";
            whatsappOutboundLog.debug(`Reply body: ${preview}${hasMedia ? " (media)" : ""}`);
          }
        }
      },
      onError: (err, info) => {
        const label =
          info.kind === "tool"
            ? "tool update"
            : info.kind === "block"
              ? "block update"
              : "auto-reply";
        whatsappOutboundLog.error(
          `Failed sending web ${label} to ${params.msg.from ?? conversationId}: ${formatError(err)}`,
        );
      },
      onReplyStart: params.msg.sendComposing,
    },
    replyOptions: {
      disableBlockStreaming:
        typeof params.cfg.channels?.whatsapp?.blockStreaming === "boolean"
          ? !params.cfg.channels.whatsapp.blockStreaming
          : undefined,
      onModelSelected: prefixContext.onModelSelected,
    },
  });

  if (!queuedFinal) {
    if (shouldClearGroupHistory) {
      params.groupHistories.set(params.groupHistoryKey, []);
    }
    logVerbose("Skipping auto-reply: silent token or no text/media returned from resolver");
    return false;
  }

  if (shouldClearGroupHistory) {
    params.groupHistories.set(params.groupHistoryKey, []);
  }

  return didSendReply;
}
