import {
  logAckFailure,
  removeAckReactionHandleAfterReply,
  type AckReactionHandle,
} from "openclaw/plugin-sdk/channel-feedback";
import {
  createInternalHookEvent,
  deriveInboundMessageHookContext,
  fireAndForgetBoundedHook,
  toInternalMessageReceivedContext,
  toPluginMessageContext,
  toPluginMessageReceivedEvent,
  triggerInternalHook,
} from "openclaw/plugin-sdk/hook-runtime";
import { getGlobalHookRunner } from "openclaw/plugin-sdk/plugin-runtime";
import { resolveBatchedReplyThreadingPolicy } from "openclaw/plugin-sdk/reply-reference";
import { getPrimaryIdentityId, getSelfIdentity, getSenderIdentity } from "../../identity.js";
import {
  resolveWhatsAppCommandAuthorized,
  resolveWhatsAppInboundPolicy,
  type ResolvedWhatsAppInboundPolicy,
} from "../../inbound-policy.js";
import { newConnectionId } from "../../reconnect.js";
import { formatError } from "../../session.js";
import {
  resolveWhatsAppDirectSystemPrompt,
  resolveWhatsAppGroupSystemPrompt,
} from "../../system-prompt.js";
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
  recordSessionMetaFromInbound,
  resolveChannelContextVisibilityMode,
  resolveInboundSessionEnvelopeContext,
  resolvePinnedMainDmOwnerFromAllowlist,
  shouldComputeCommandAuthorized,
  shouldLogVerbose,
  type getChildLogger,
  type getReplyFromConfig,
  type HistoryEntry,
  type LoadConfigFn,
  type resolveAgentRoute,
} from "./runtime-api.js";

const WHATSAPP_MESSAGE_RECEIVED_HOOK_LIMITS = {
  maxConcurrency: 8,
  maxQueue: 128,
  timeoutMs: 2_000,
};

type WhatsAppMessageReceivedHookConfig = {
  pluginHooks?: {
    messageReceived?: unknown;
  };
  accounts?: Record<string, unknown>;
};

function readWhatsAppMessageReceivedHookOptIn(value: unknown): boolean | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const pluginHooks = (value as WhatsAppMessageReceivedHookConfig).pluginHooks;
  return pluginHooks?.messageReceived === true ? true : undefined;
}

function shouldEmitWhatsAppMessageReceivedHooks(params: {
  cfg: ReturnType<LoadConfigFn>;
  accountId?: string;
}): boolean {
  const channelConfig = params.cfg.channels?.whatsapp as
    | WhatsAppMessageReceivedHookConfig
    | undefined;
  const accountConfig =
    params.accountId && channelConfig?.accounts
      ? channelConfig.accounts[params.accountId]
      : undefined;
  return (
    readWhatsAppMessageReceivedHookOptIn(accountConfig) ??
    readWhatsAppMessageReceivedHookOptIn(channelConfig) ??
    false
  );
}

function emitWhatsAppMessageReceivedHooks(params: {
  ctx: ReturnType<typeof buildWhatsAppInboundContext>;
  sessionKey: string;
}): void {
  const canonical = deriveInboundMessageHookContext(params.ctx);
  const hookRunner = getGlobalHookRunner();
  if (hookRunner?.hasHooks("message_received")) {
    fireAndForgetBoundedHook(
      () =>
        hookRunner.runMessageReceived(
          toPluginMessageReceivedEvent(canonical),
          toPluginMessageContext(canonical),
        ),
      "whatsapp: message_received plugin hook failed",
      undefined,
      WHATSAPP_MESSAGE_RECEIVED_HOOK_LIMITS,
    );
  }
  fireAndForgetBoundedHook(
    () =>
      triggerInternalHook(
        createInternalHookEvent(
          "message",
          "received",
          params.sessionKey,
          toInternalMessageReceivedContext(canonical),
        ),
      ),
    "whatsapp: message_received internal hook failed",
    undefined,
    WHATSAPP_MESSAGE_RECEIVED_HOOK_LIMITS,
  );
}

function emitWhatsAppMessageReceivedHooksIfEnabled(params: {
  cfg: ReturnType<LoadConfigFn>;
  ctx: ReturnType<typeof buildWhatsAppInboundContext>;
  accountId?: string;
  sessionKey: string;
}): void {
  if (
    !shouldEmitWhatsAppMessageReceivedHooks({
      cfg: params.cfg,
      accountId: params.accountId,
    })
  ) {
    return;
  }

  emitWhatsAppMessageReceivedHooks({
    ctx: params.ctx,
    sessionKey: params.sessionKey,
  });
}

function resolvePinnedMainDmRecipient(params: {
  cfg: ReturnType<LoadConfigFn>;
  allowFrom?: string[];
}): string | null {
  return resolvePinnedMainDmOwnerFromAllowlist({
    dmScope: params.cfg.session?.dmScope,
    allowFrom: params.allowFrom,
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
  ackAlreadySent?: boolean;
  ackReaction?: AckReactionHandle | null;
  /** Pre-computed audio transcript from a caller-level preflight, used to avoid
   * re-transcribing the same voice note once per broadcast agent.
   * - string  → transcript obtained; use it directly, skip internal STT
   * - null    → preflight was attempted but failed / returned nothing; skip internal STT
   * - undefined (omitted) → caller did not attempt preflight; run internal STT as normal */
  preflightAudioTranscript?: string | null;
}) {
  const conversationId = params.msg.conversationId ?? params.msg.from;
  const self = getSelfIdentity(params.msg);
  const inboundPolicy = resolveWhatsAppInboundPolicy({
    cfg: params.cfg,
    accountId: params.route.accountId ?? params.msg.accountId,
    selfE164: self.e164 ?? null,
  });
  const account = inboundPolicy.account;
  const contextVisibilityMode = resolveChannelContextVisibilityMode({
    cfg: params.cfg,
    channel: "whatsapp",
    accountId: account.accountId,
  });
  const { storePath, envelopeOptions, previousTimestamp } = resolveInboundSessionEnvelopeContext({
    cfg: params.cfg,
    agentId: params.route.agentId,
    sessionKey: params.route.sessionKey,
  });
  // Preflight audio transcription: transcribe voice notes before building the
  // inbound context so the agent receives the transcript instead of <media:audio>.
  // Mirrors the preflight step added for Telegram in #61008.
  // When the caller already performed transcription (e.g. on-message.ts before
  // broadcast fan-out) the pre-computed result is reused to avoid N STT calls
  // for N broadcast agents on the same voice note.
  // preflightAudioTranscript semantics:
  //   string    → transcript ready, use it
  //   null      → caller attempted but got nothing; skip internal STT to avoid retry
  //   undefined → caller did not attempt; run internal STT
  let audioTranscript: string | undefined = params.preflightAudioTranscript ?? undefined;
  const hasAudioBody =
    params.msg.mediaType?.startsWith("audio/") === true && params.msg.body === "<media:audio>";
  if (params.preflightAudioTranscript === undefined && hasAudioBody && params.msg.mediaPath) {
    try {
      const { transcribeFirstAudio } = await import("./audio-preflight.runtime.js");
      audioTranscript = await transcribeFirstAudio({
        ctx: {
          MediaPaths: [params.msg.mediaPath],
          MediaTypes: params.msg.mediaType ? [params.msg.mediaType] : undefined,
        },
        cfg: params.cfg,
      });
    } catch {
      // Transcription failure is non-fatal: fall back to <media:audio> placeholder.
      if (shouldLogVerbose()) {
        logVerbose("whatsapp: audio preflight transcription failed, using placeholder");
      }
    }
  }

  // If we have a transcript, replace the agent-facing body so the agent sees the spoken text.
  // mediaPath and mediaType are intentionally preserved so that inboundAudio detection
  // (used by features such as messages.tts.auto: "inbound") still sees this as an
  // audio message. The transcript and transcribed media index are also stored on
  // context so downstream media understanding does not transcribe it again.
  const msgForAgent =
    audioTranscript !== undefined ? { ...params.msg, body: audioTranscript } : params.msg;

  let combinedBody = buildInboundLine({
    cfg: params.cfg,
    msg: msgForAgent,
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
          groupPolicy: inboundPolicy.groupPolicy,
          groupAllowFrom: inboundPolicy.groupAllowFrom,
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

  // Send ack reaction immediately upon message receipt (post-gating). Callers
  // that do preflight work before processMessage can send it first and set
  // ackAlreadySent so slow STT does not delay user-visible receipt feedback.
  let ackReaction = params.ackReaction ?? null;
  if (!ackReaction && params.ackAlreadySent !== true) {
    ackReaction = await maybeSendAckReaction({
      cfg: params.cfg,
      msg: params.msg,
      agentId: params.route.agentId,
      sessionKey: params.route.sessionKey,
      conversationId,
      verbose: params.verbose,
      accountId: account.accountId,
      info: params.replyLogger.info.bind(params.replyLogger),
      warn: params.replyLogger.warn.bind(params.replyLogger),
    });
  }

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
  const visibleReplyTo = resolveVisibleWhatsAppReplyContext({
    msg: params.msg,
    authDir: account.authDir,
    mode: contextVisibilityMode,
    groupPolicy: inboundPolicy.groupPolicy,
    groupAllowFrom: inboundPolicy.groupAllowFrom,
  });
  const dmRouteTarget = resolveWhatsAppDmRouteTarget({
    msg: params.msg,
    senderE164: sender.e164 ?? undefined,
    normalizeE164,
  });
  const commandAuthorized = shouldComputeCommandAuthorized(params.msg.body, params.cfg)
    ? await resolveWhatsAppCommandAuthorized({
        cfg: params.cfg,
        msg: params.msg,
        policy: inboundPolicy,
      })
    : undefined;
  const { onModelSelected, ...replyPipeline } = createChannelReplyPipeline({
    cfg: params.cfg,
    agentId: params.route.agentId,
    channel: "whatsapp",
    accountId: params.route.accountId,
  });
  const responsePrefix = resolveWhatsAppResponsePrefix({
    cfg: params.cfg,
    agentId: params.route.agentId,
    isSelfChat: params.msg.chatType !== "group" && inboundPolicy.isSelfChat,
    pipelineResponsePrefix: replyPipeline.responsePrefix,
  });
  const replyThreading = resolveBatchedReplyThreadingPolicy(
    account.replyToMode ?? "off",
    params.msg.isBatched === true,
  );

  // Resolve combined conversation system prompt using the group or direct surface.
  const conversationSystemPrompt =
    params.msg.chatType === "group"
      ? resolveWhatsAppGroupSystemPrompt({
          accountConfig: account,
          groupId: conversationId,
        })
      : resolveWhatsAppDirectSystemPrompt({
          accountConfig: account,
          peerId: dmRouteTarget ?? params.msg.from,
        });

  const ctxPayload = buildWhatsAppInboundContext({
    bodyForAgent: msgForAgent.body,
    combinedBody,
    commandBody: params.msg.body,
    commandAuthorized,
    conversationId,
    groupHistory: visibleGroupHistory,
    groupMemberRoster: params.groupMemberNames.get(params.groupHistoryKey),
    groupSystemPrompt: conversationSystemPrompt,
    msg: params.msg,
    rawBody: params.msg.body,
    route: params.route,
    sender: {
      id: getPrimaryIdentityId(sender) ?? undefined,
      name: sender.name ?? undefined,
      e164: sender.e164 ?? undefined,
    },
    ...(audioTranscript !== undefined ? { transcript: audioTranscript } : {}),
    ...(audioTranscript !== undefined ? { mediaTranscribedIndexes: [0] } : {}),
    replyThreading,
    visibleReplyTo: visibleReplyTo ?? undefined,
  });
  emitWhatsAppMessageReceivedHooksIfEnabled({
    cfg: params.cfg,
    ctx: ctxPayload,
    accountId: params.route.accountId,
    sessionKey: params.route.sessionKey,
  });

  const pinnedMainDmRecipient = resolvePinnedMainDmRecipient({
    cfg: params.cfg,
    allowFrom: inboundPolicy.configuredAllowFrom,
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

  const didSendReply = await dispatchWhatsAppBufferedReply({
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
  removeAckReactionHandleAfterReply({
    removeAfterReply: Boolean(params.cfg.messages?.removeAckAfterReply && didSendReply),
    ackReaction,
    onError: (err) => {
      logAckFailure({
        log: logVerbose,
        channel: "whatsapp",
        target: `${params.msg.chatId ?? conversationId}/${params.msg.id ?? "unknown"}`,
        error: err,
      });
    },
  });
  return didSendReply;
}

export const __testing = {
  resolveWhatsAppCommandAuthorized,
  resolveWhatsAppInboundPolicy: (
    params: Parameters<typeof resolveWhatsAppInboundPolicy>[0],
  ): ResolvedWhatsAppInboundPolicy => resolveWhatsAppInboundPolicy(params),
};
