import { resolveWhatsAppAccount } from "../../accounts.js";
import { getPrimaryIdentityId, getSelfIdentity, getSenderIdentity } from "../../identity.js";
import { newConnectionId } from "../../reconnect.js";
import { formatError } from "../../session.js";
import { deliverWebReply } from "../deliver-reply.js";
import { whatsappInboundLog } from "../loggers.js";
import type { WebInboundMsg } from "../types.js";
import { elide } from "../util.js";
import { maybeSendAckReaction } from "./ack-reaction.js";
import {
  resolveVisibleWhatsAppGroupHistory,
  resolveVisibleWhatsAppReplyContext,
  type GroupHistoryEntry,
} from "./inbound-context.js";
import {
  buildWhatsAppInboundContext,
  dispatchWhatsAppBufferedReply,
  resolveWhatsAppDmRouteTarget,
  resolveWhatsAppResponsePrefix,
  updateWhatsAppMainLastRoute,
} from "./inbound-dispatch.js";
import { trackBackgroundTask, updateLastRouteInBackground } from "./last-route.js";
import { buildInboundLine } from "./message-line.js";
import {
  buildHistoryContextFromEntries,
  createChannelReplyPipeline,
  formatInboundEnvelope,
  logVerbose,
  normalizeE164,
  readStoreAllowFromForDmPolicy,
  recordSessionMetaFromInbound,
  resolveChannelContextVisibilityMode,
  resolveInboundSessionEnvelopeContext,
  resolvePinnedMainDmOwnerFromAllowlist,
  resolveDmGroupAccessWithCommandGate,
  shouldComputeCommandAuthorized,
  shouldLogVerbose,
  type getChildLogger,
  type getReplyFromConfig,
  type HistoryEntry,
  type LoadConfigFn,
  type resolveAgentRoute,
} from "./runtime-api.js";

async function resolveWhatsAppCommandAuthorized(params: {
  cfg: ReturnType<LoadConfigFn>;
  msg: WebInboundMsg;
}): Promise<boolean> {
  const useAccessGroups = params.cfg.commands?.useAccessGroups !== false;
  if (!useAccessGroups) {
    return true;
  }

  const isGroup = params.msg.chatType === "group";
  const sender = getSenderIdentity(params.msg);
  const self = getSelfIdentity(params.msg);
  const senderE164 = normalizeE164(
    isGroup ? (sender.e164 ?? "") : (sender.e164 ?? params.msg.from ?? ""),
  );
  if (!senderE164) {
    return false;
  }

  const account = resolveWhatsAppAccount({ cfg: params.cfg, accountId: params.msg.accountId });
  const dmPolicy = account.dmPolicy ?? "pairing";
  const groupPolicy = account.groupPolicy ?? "allowlist";
  const configuredAllowFrom = account.allowFrom ?? [];
  const configuredGroupAllowFrom =
    account.groupAllowFrom ?? (configuredAllowFrom.length > 0 ? configuredAllowFrom : undefined);

  const storeAllowFrom = isGroup
    ? []
    : await readStoreAllowFromForDmPolicy({
        provider: "whatsapp",
        accountId: params.msg.accountId,
        dmPolicy,
      });
  const dmAllowFrom =
    configuredAllowFrom.length > 0 ? configuredAllowFrom : self.e164 ? [self.e164] : [];
  const access = resolveDmGroupAccessWithCommandGate({
    isGroup,
    dmPolicy,
    groupPolicy,
    allowFrom: dmAllowFrom,
    groupAllowFrom: configuredGroupAllowFrom,
    storeAllowFrom,
    isSenderAllowed: (allowEntries) => {
      if (allowEntries.includes("*")) {
        return true;
      }
      const normalizedEntries = allowEntries
        .map((entry) => normalizeE164(entry))
        .filter((entry): entry is string => Boolean(entry));
      return normalizedEntries.includes(senderE164);
    },
    command: {
      useAccessGroups,
      allowTextCommands: true,
      hasControlCommand: true,
    },
  });
  return access.commandAuthorized;
}

function resolvePinnedMainDmRecipient(params: {
  cfg: ReturnType<LoadConfigFn>;
  msg: WebInboundMsg;
}): string | null {
  const account = resolveWhatsAppAccount({ cfg: params.cfg, accountId: params.msg.accountId });
  return resolvePinnedMainDmOwnerFromAllowlist({
    dmScope: params.cfg.session?.dmScope,
    allowFrom: account.allowFrom,
    normalizeEntry: (entry) => normalizeE164(entry),
  });
}

export async function processMessage(params: {
  cfg: ReturnType<LoadConfigFn>;
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
  const account = resolveWhatsAppAccount({
    cfg: params.cfg,
    accountId: params.route.accountId ?? params.msg.accountId,
  });
  const contextVisibilityMode = resolveChannelContextVisibilityMode({
    cfg: params.cfg,
    channel: "whatsapp",
    accountId: account.accountId,
  });
  const configuredAllowFrom = account.allowFrom ?? [];
  const configuredGroupAllowFrom =
    account.groupAllowFrom ?? (configuredAllowFrom.length > 0 ? configuredAllowFrom : undefined);
  const groupAllowFrom = configuredGroupAllowFrom ?? [];
  const groupPolicy = account.groupPolicy ?? "allowlist";
  const { storePath, envelopeOptions, previousTimestamp } = resolveInboundSessionEnvelopeContext({
    cfg: params.cfg,
    agentId: params.route.agentId,
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
  const visibleGroupHistory =
    params.msg.chatType === "group"
      ? resolveVisibleWhatsAppGroupHistory({
          history: params.groupHistory ?? params.groupHistories.get(params.groupHistoryKey) ?? [],
          mode: contextVisibilityMode,
          groupPolicy,
          groupAllowFrom,
        })
      : undefined;

  if (params.msg.chatType === "group") {
    const history = visibleGroupHistory ?? [];
    if (history.length > 0) {
      const historyEntries: HistoryEntry[] = history.map((m) => ({
        sender: m.sender,
        body: m.body,
        timestamp: m.timestamp,
      }));
      combinedBody = buildHistoryContextFromEntries({
        entries: historyEntries,
        currentMessage: combinedBody,
        excludeLast: false,
        formatEntry: (entry) => {
          return formatInboundEnvelope({
            channel: "WhatsApp",
            from: conversationId,
            timestamp: entry.timestamp,
            body: entry.body,
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

  const sender = getSenderIdentity(params.msg);
  const self = getSelfIdentity(params.msg);
  const visibleReplyTo = resolveVisibleWhatsAppReplyContext({
    msg: params.msg,
    authDir: account.authDir,
    mode: contextVisibilityMode,
    groupPolicy,
    groupAllowFrom,
  });
  const dmRouteTarget = resolveWhatsAppDmRouteTarget({
    msg: params.msg,
    senderE164: sender.e164 ?? undefined,
    normalizeE164,
  });
  const commandAuthorized = shouldComputeCommandAuthorized(params.msg.body, params.cfg)
    ? await resolveWhatsAppCommandAuthorized({ cfg: params.cfg, msg: params.msg })
    : undefined;
  const { onModelSelected, ...replyPipeline } = createChannelReplyPipeline({
    cfg: params.cfg,
    agentId: params.route.agentId,
    channel: "whatsapp",
    accountId: params.route.accountId,
  });
  const isSelfChat =
    params.msg.chatType !== "group" &&
    Boolean(self.e164) &&
    normalizeE164(params.msg.from) === normalizeE164(self.e164 ?? "");
  const responsePrefix = resolveWhatsAppResponsePrefix({
    cfg: params.cfg,
    agentId: params.route.agentId,
    isSelfChat,
    pipelineResponsePrefix: replyPipeline.responsePrefix,
  });

  const ctxPayload = buildWhatsAppInboundContext({
    combinedBody,
    commandAuthorized,
    conversationId,
    groupHistory: visibleGroupHistory,
    groupMemberRoster: params.groupMemberNames.get(params.groupHistoryKey),
    msg: params.msg,
    route: params.route,
    sender: {
      id: getPrimaryIdentityId(sender) ?? undefined,
      name: sender.name ?? undefined,
      e164: sender.e164 ?? undefined,
    },
    visibleReplyTo: visibleReplyTo ?? undefined,
  });

  const pinnedMainDmRecipient = resolvePinnedMainDmRecipient({
    cfg: params.cfg,
    msg: params.msg,
  });
  updateWhatsAppMainLastRoute({
    backgroundTasks: params.backgroundTasks,
    cfg: params.cfg,
    ctx: ctxPayload,
    dmRouteTarget,
    pinnedMainDmRecipient,
    route: params.route,
    updateLastRoute: updateLastRouteInBackground,
    warn: params.replyLogger.warn.bind(params.replyLogger),
  });

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

  return dispatchWhatsAppBufferedReply({
    cfg: params.cfg,
    connectionId: params.connectionId,
    context: ctxPayload,
    conversationId,
    deliverReply: deliverWebReply,
    groupHistories: params.groupHistories,
    groupHistoryKey: params.groupHistoryKey,
    maxMediaBytes: params.maxMediaBytes,
    maxMediaTextChunkLimit: params.maxMediaTextChunkLimit,
    msg: params.msg,
    onModelSelected,
    rememberSentText: params.rememberSentText,
    replyLogger: params.replyLogger,
    replyPipeline: {
      ...replyPipeline,
      responsePrefix,
    },
    replyResolver: params.replyResolver,
    route: params.route,
    shouldClearGroupHistory,
  });
}
