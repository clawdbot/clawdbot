import { resolveEffectiveMessagesConfig, resolveIdentityName } from "../../../agents/identity.js";
import {
  extractShortModelName,
  type ResponsePrefixContext,
} from "../../../auto-reply/reply/response-prefix-template.js";
import { resolveTextChunkLimit } from "../../../auto-reply/chunk.js";
import { formatAgentEnvelope } from "../../../auto-reply/envelope.js";
import { buildHistoryContext } from "../../../auto-reply/reply/history.js";
import { dispatchReplyWithBufferedBlockDispatcher } from "../../../auto-reply/reply/provider-dispatcher.js";
import type { getReplyFromConfig } from "../../../auto-reply/reply.js";
import type { ReplyPayload } from "../../../auto-reply/types.js";
import { toLocationContext } from "../../../channels/location.js";
import type { loadConfig } from "../../../config/config.js";
import { logVerbose, shouldLogVerbose } from "../../../globals.js";
import type { getChildLogger } from "../../../logging.js";
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
import { updateLastRouteInBackground } from "./last-route.js";
import { buildInboundLine } from "./message-line.js";

export type GroupHistoryEntry = {
  sender: string;
  body: string;
  timestamp?: number;
  id?: string;
  senderJid?: string;
};

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
  let combinedBody = buildInboundLine({
    cfg: params.cfg,
    msg: params.msg,
    agentId: params.route.agentId,
  });
  let shouldClearGroupHistory = false;

  if (params.msg.chatType === "group") {
    const history = params.groupHistory ?? params.groupHistories.get(params.groupHistoryKey) ?? [];
    const historyWithoutCurrent = history.length > 0 ? history.slice(0, -1) : [];
    if (historyWithoutCurrent.length > 0) {
      const lineBreak = "\\n";
      const historyText = historyWithoutCurrent
        .map((m) => {
          const bodyWithId = m.id ? `${m.body}\n[message_id: ${m.id}]` : m.body;
          return formatAgentEnvelope({
            channel: "WhatsApp",
            from: conversationId,
            timestamp: m.timestamp,
            body: `${m.sender}: ${bodyWithId}`,
          });
        })
        .join(lineBreak);
      combinedBody = buildHistoryContext({
        historyText,
        currentMessage: combinedBody,
        lineBreak,
      });
    }
    // Always surface who sent the triggering message so the agent can address them.
    const senderLabel =
      params.msg.senderName && params.msg.senderE164
        ? `${params.msg.senderName} (${params.msg.senderE164})`
        : (params.msg.senderName ?? params.msg.senderE164 ?? "Unknown");
    combinedBody = `${combinedBody}\\n[from: ${senderLabel}]`;
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

  if (params.msg.chatType !== "group") {
    const to = (() => {
      if (params.msg.senderE164) return normalizeE164(params.msg.senderE164);
      // In direct chats, `msg.from` is already the canonical conversation id.
      if (params.msg.from.includes("@")) return jidToE164(params.msg.from);
      return normalizeE164(params.msg.from);
    })();
    if (to) {
      updateLastRouteInBackground({
        cfg: params.cfg,
        backgroundTasks: params.backgroundTasks,
        storeAgentId: params.route.agentId,
        sessionKey: params.route.mainSessionKey,
        channel: "whatsapp",
        to,
        accountId: params.route.accountId,
        warn: params.replyLogger.warn.bind(params.replyLogger),
      });
    }
  }

  const textLimit = params.maxMediaTextChunkLimit ?? resolveTextChunkLimit(params.cfg, "whatsapp");
  let didLogHeartbeatStrip = false;
  let didSendReply = false;
  const responsePrefix = resolveEffectiveMessagesConfig(
    params.cfg,
    params.route.agentId,
  ).responsePrefix;

  // Create mutable context for response prefix template interpolation
  let prefixContext: ResponsePrefixContext = {
    identityName: resolveIdentityName(params.cfg, params.route.agentId),
  };

  const { queuedFinal } = await dispatchReplyWithBufferedBlockDispatcher({
    ctx: {
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
      GroupSubject: params.msg.groupSubject,
      GroupMembers: formatGroupMembers({
        participants: params.msg.groupParticipants,
        roster: params.groupMemberNames.get(params.groupHistoryKey),
        fallbackE164: params.msg.senderE164,
      }),
      SenderName: params.msg.senderName,
      SenderId: params.msg.senderJid?.trim() || params.msg.senderE164,
      SenderE164: params.msg.senderE164,
      WasMentioned: params.msg.wasMentioned,
      ...(params.msg.location ? toLocationContext(params.msg.location) : {}),
      Provider: "whatsapp",
      Surface: "whatsapp",
      OriginatingChannel: "whatsapp",
      OriginatingTo: params.msg.from,
    },
    cfg: params.cfg,
    replyResolver: params.replyResolver,
    dispatcherOptions: {
      responsePrefix,
      responsePrefixContextProvider: () => prefixContext,
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
          replyLogger: params.replyLogger,
          connectionId: params.connectionId,
          // Tool + block updates are noisy; skip their log lines.
          skipLog: info.kind !== "final",
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
      onModelSelected: (ctx) => {
        // Mutate the object directly instead of reassigning to ensure the closure sees updates
        prefixContext.provider = ctx.provider;
        prefixContext.model = extractShortModelName(ctx.model);
        prefixContext.modelFull = `${ctx.provider}/${ctx.model}`;
        prefixContext.thinkingLevel = ctx.thinkLevel ?? "off";
      },
    },
  });

  if (!queuedFinal) {
    if (shouldClearGroupHistory && didSendReply) {
      params.groupHistories.set(params.groupHistoryKey, []);
    }
    logVerbose("Skipping auto-reply: silent token or no text/media returned from resolver");
    return false;
  }

  if (shouldClearGroupHistory && didSendReply) {
    params.groupHistories.set(params.groupHistoryKey, []);
  }

  return didSendReply;
}
