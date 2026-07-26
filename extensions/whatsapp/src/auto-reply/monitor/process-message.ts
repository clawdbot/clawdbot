// Whatsapp plugin module implements process message behavior.
import {
  logAckFailure,
  removeAckReactionHandleAfterReply,
  type AckReactionHandle,
} from "openclaw/plugin-sdk/channel-feedback";
import {
  formatMediaPlaceholderText,
  runChannelInboundEvent,
} from "openclaw/plugin-sdk/channel-inbound";
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
} from "../../inbound-policy.js";
import { requireWhatsAppInboundAdmission } from "../../inbound/admission.js";
import type { AdmittedWebInboundMessage } from "../../inbound/types.js";
import { newConnectionId } from "../../reconnect.js";
import { formatError } from "../../session.js";
import {
  resolveWhatsAppDirectSystemPrompt,
  resolveWhatsAppGroupSystemPrompt,
} from "../../system-prompt.js";
import { deliverWebReply } from "../deliver-reply.js";
import { whatsappInboundLog } from "../loggers.js";
import { elide } from "../util.js";
import { maybeSendAckReaction } from "./ack-reaction.js";
import {
  resolveVisibleWhatsAppGroupHistory,
  resolveVisibleWhatsAppReplyContext,
  type GroupHistoryEntry,
} from "./inbound-context.js";
import {
  buildWhatsAppInboundContext,
  createWhatsAppReplyPlan,
  resolveWhatsAppDmRouteTarget,
  resolveWhatsAppResponsePrefix,
  updateWhatsAppMainLastRoute,
} from "./inbound-dispatch.js";
import { trackBackgroundTask, updateLastRouteInBackground } from "./last-route.js";
import { buildInboundLine } from "./message-line.js";
import {
  buildHistoryContextFromEntries,
  createChannelMessageReplyPipeline,
  formatInboundEnvelope,
  logVerbose,
  normalizeE164,
  resolveChannelContextVisibilityMode,
  resolveInboundSessionEnvelopeContext,
  resolvePinnedMainDmOwnerFromAllowlist,
  isControlCommandMessage,
  shouldComputeCommandAuthorized,
  shouldLogVerbose,
  type getChildLogger,
  type getReplyFromConfig,
  type HistoryEntry,
  type LoadConfigFn,
  type resolveAgentRoute,
} from "./runtime-api.js";
import {
  createWhatsAppStatusReactionController,
  type StatusReactionController,
} from "./status-reaction.js";

const WHATSAPP_MESSAGE_RECEIVED_HOOK_LIMITS = {
  maxConcurrency: 8,
  maxQueue: 128,
  timeoutMs: 2_000,
};

type WhatsAppMessageReceivedHookConfig = {
  pluginHooks?: {
    messageReceived?: boolean;
  };
  accounts?: Record<string, unknown>;
};

function readWhatsAppMessageReceivedHookOptIn(value: unknown): boolean | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const pluginHooks = (value as WhatsAppMessageReceivedHookConfig).pluginHooks;
  if (pluginHooks?.messageReceived === undefined) {
    return undefined;
  }
  return pluginHooks.messageReceived;
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
  ctx: Awaited<ReturnType<typeof buildWhatsAppInboundContext>>;
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
  ctx: Awaited<ReturnType<typeof buildWhatsAppInboundContext>>;
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
  msg: AdmittedWebInboundMessage;
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
  groupHistoryLimit?: number;
  suppressGroupHistoryClear?: boolean;
  ackAlreadySent?: boolean;
  ackReaction?: AckReactionHandle | null;
  statusReactionController?: StatusReactionController | null;
  /** Pre-computed audio transcript from a caller-level preflight, used to avoid
   * re-transcribing the same voice note once per broadcast agent.
   * - string  → transcript obtained; use it directly, skip internal STT
   * - null    → preflight was attempted but failed / returned nothing; skip internal STT
   * - undefined (omitted) → caller did not attempt preflight; run internal STT as normal */
  preflightAudioTranscript?: string | null;
}) {
  const admission = requireWhatsAppInboundAdmission(params.msg);
  if (admission.ingress.admission !== "dispatch" && admission.ingress.admission !== "observe") {
    return false;
  }
  const conversationId = admission.conversation.id;
  const conversationKind = admission.conversation.kind;
  const self = getSelfIdentity(params.msg);
  const inboundPolicy = resolveWhatsAppInboundPolicy({
    cfg: params.cfg,
    accountId: params.route.accountId ?? admission.accountId,
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
  // inbound context so the agent receives the transcript instead of an empty audio caption.
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
    (params.msg.payload.media?.kind === "audio" ||
      params.msg.payload.media?.type?.startsWith("audio/") === true) &&
    !params.msg.payload.body.trim();
  if (
    params.preflightAudioTranscript === undefined &&
    hasAudioBody &&
    params.msg.payload.media?.path
  ) {
    try {
      const { transcribeFirstAudio } = await import("./audio-preflight.runtime.js");
      audioTranscript = await transcribeFirstAudio({
        ctx: {
          media: [
            {
              path: params.msg.payload.media.path,
              contentType: params.msg.payload.media.type,
              kind: params.msg.payload.media.kind ?? undefined,
            },
          ],
          From: conversationId,
          To: params.msg.platform.recipientJid,
          Provider: "whatsapp",
          Surface: "whatsapp",
          OriginatingChannel: "whatsapp",
          OriginatingTo: conversationId,
          AccountId: params.route.accountId,
        },
        cfg: params.cfg,
      });
    } catch {
      // Transcription failure is non-fatal: keep the empty caption and structured audio fact.
      if (shouldLogVerbose()) {
        logVerbose("whatsapp: audio preflight transcription failed, keeping structured audio");
      }
    }
  }

  // If we have a transcript, replace the agent-facing body so the agent sees the spoken text.
  // mediaPath and mediaType are intentionally preserved so that inboundAudio detection
  // (used by features such as tts.auto: "inbound") still sees this as an
  // audio message. The transcript and transcribed media index are also stored on
  // context so downstream media understanding does not transcribe it again.
  const msgForAgent: AdmittedWebInboundMessage =
    audioTranscript !== undefined
      ? { ...params.msg, payload: { ...params.msg.payload, body: audioTranscript } }
      : params.msg;
  const visibleReplyTo = resolveVisibleWhatsAppReplyContext({
    msg: params.msg,
    authDir: account.authDir,
    mode: contextVisibilityMode,
    groupPolicy: inboundPolicy.groupPolicy,
    groupAllowFrom: inboundPolicy.groupAllowFrom,
  });

  let combinedBody = buildInboundLine({
    cfg: params.cfg,
    msg: msgForAgent,
    agentId: params.route.agentId,
    previousTimestamp,
    envelope: envelopeOptions,
    visibleReplyTo,
  });
  let shouldClearGroupHistory = false;
  const visibleGroupHistory =
    conversationKind === "group"
      ? resolveVisibleWhatsAppGroupHistory({
          history: params.groupHistory ?? params.groupHistories.get(params.groupHistoryKey) ?? [],
          mode: contextVisibilityMode,
          groupPolicy: inboundPolicy.groupPolicy,
          groupAllowFrom: inboundPolicy.groupAllowFrom,
          authDir: account.authDir,
        })
      : undefined;

  if (conversationKind === "group") {
    const history = visibleGroupHistory ?? [];
    if (history.length > 0) {
      const historyEntries: HistoryEntry[] = history.map((m) => ({
        sender: m.sender,
        body: m.body,
        timestamp: m.timestamp,
        media: m.media,
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
            body: [entry.body, formatMediaPlaceholderText(entry.media ?? [])]
              .filter(Boolean)
              .join("\n"),
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

  // When statusReactions.enabled, a StatusReactionController takes over lifecycle
  // signaling (queued → thinking → tool → done/error). The plain ackReaction is
  // skipped so the same message slot isn't used for two competing systems.
  const statusReactionController =
    params.statusReactionController ??
    (params.cfg.messages?.statusReactions?.enabled === true && !params.ackAlreadySent
      ? await createWhatsAppStatusReactionController({
          cfg: params.cfg,
          msg: params.msg,
          agentId: params.route.agentId,
          sessionKey: params.route.sessionKey,
          verbose: params.verbose,
        })
      : null);

  if (statusReactionController && !params.statusReactionController) {
    void statusReactionController.setQueued();
  }

  // Send ack reaction immediately upon message receipt (post-gating). Callers
  // that do preflight work before processMessage can send it first and set
  // ackAlreadySent so slow STT does not delay user-visible receipt feedback.
  // Skip if the status reaction controller is handling lifecycle signaling.
  let ackReaction = params.ackReaction ?? null;
  if (!statusReactionController && !ackReaction && params.ackAlreadySent !== true) {
    ackReaction = await maybeSendAckReaction({
      cfg: params.cfg,
      msg: params.msg,
      agentId: params.route.agentId,
      sessionKey: params.route.sessionKey,
      verbose: params.verbose,
      info: params.replyLogger.info.bind(params.replyLogger),
      warn: params.replyLogger.warn.bind(params.replyLogger),
    });
  }

  const correlationId = params.msg.event.id ?? newConnectionId();
  params.replyLogger.info(
    {
      connectionId: params.connectionId,
      correlationId,
      from: conversationId,
      to: params.msg.platform.recipientJid,
      body: elide(combinedBody, 240),
      mediaType: params.msg.payload.media?.type ?? null,
      mediaPath: params.msg.payload.media?.path ?? null,
    },
    "inbound web message",
  );

  const fromDisplay = conversationId;
  const kindLabel = params.msg.payload.media?.type ? `, ${params.msg.payload.media?.type}` : "";
  whatsappInboundLog.info(
    `Inbound message ${fromDisplay} -> ${params.msg.platform.recipientJid} (${conversationKind}${kindLabel}, ${combinedBody.length} chars)`,
  );
  if (shouldLogVerbose()) {
    whatsappInboundLog.debug(`Inbound body: ${elide(combinedBody, 400)}`);
  }

  const sender = getSenderIdentity(params.msg);
  const commandBody = params.msg.payload.commandBody ?? params.msg.payload.body;
  const dmRouteTarget = resolveWhatsAppDmRouteTarget({
    msg: params.msg,
    senderE164: sender.e164 ?? undefined,
    normalizeE164,
  });
  const shouldCheckCommandAuth = shouldComputeCommandAuthorized(commandBody, params.cfg);
  const isTextCommand = isControlCommandMessage(commandBody, params.cfg);
  const commandAuthorized = shouldCheckCommandAuth
    ? await resolveWhatsAppCommandAuthorized({
        cfg: params.cfg,
        msg: params.msg,
        policy: inboundPolicy,
        authDir: account.authDir,
      })
    : undefined;
  const { onModelSelected, ...replyPipeline } = createChannelMessageReplyPipeline({
    cfg: params.cfg,
    agentId: params.route.agentId,
    channel: "whatsapp",
    accountId: params.route.accountId,
  });
  const responsePrefix = resolveWhatsAppResponsePrefix({
    cfg: params.cfg,
    agentId: params.route.agentId,
    isSelfChat: conversationKind !== "group" && inboundPolicy.isSelfChat,
    pipelineResponsePrefix: replyPipeline.responsePrefix,
  });
  const replyThreading = resolveBatchedReplyThreadingPolicy(
    account.replyToMode ?? "off",
    params.msg.event.isBatched === true,
  );

  // Resolve combined conversation system prompt using the group or direct surface.
  const conversationSystemPrompt =
    conversationKind === "group"
      ? resolveWhatsAppGroupSystemPrompt({
          accountConfig: account,
          groupId: conversationId,
        })
      : resolveWhatsAppDirectSystemPrompt({
          accountConfig: account,
          peerId: dmRouteTarget ?? conversationId,
        });

  const ctxPayload = await buildWhatsAppInboundContext({
    bodyForAgent: msgForAgent.payload.body,
    combinedBody,
    command: {
      kind: isTextCommand ? "text-slash" : "normal",
      body: commandBody,
      authorized: commandAuthorized,
    },
    groupHistory: visibleGroupHistory,
    groupHistoryLimit: params.groupHistoryLimit,
    groupMemberRoster: params.groupMemberNames.get(params.groupHistoryKey),
    groupSystemPrompt: conversationSystemPrompt,
    msg: params.msg,
    rawBody: commandBody,
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
    suppressMessageReceivedHooks: true,
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
  let finalizeReply: ReturnType<typeof createWhatsAppReplyPlan>["finalize"] | undefined;

  const turnResult = await runChannelInboundEvent({
    channel: "whatsapp",
    accountId: params.route.accountId,
    raw: params.msg,
    adapter: {
      ingest: () => ({
        id: params.msg.event.id ?? `${conversationId}:${Date.now()}`,
        timestamp: params.msg.event.timestamp,
        rawText: ctxPayload.RawBody ?? "",
        textForAgent: ctxPayload.BodyForAgent,
        textForCommands: ctxPayload.CommandBody,
        raw: params.msg,
      }),
      preflight: () => {
        const reason = admission.ingress.reasonCode;
        if (admission.ingress.admission === "dispatch") {
          return { admission: { kind: "dispatch", reason } };
        }
        if (admission.ingress.admission === "observe") {
          return { admission: { kind: "observeOnly", reason } };
        }
        if (admission.ingress.admission === "skip") {
          return { admission: { kind: "handled", reason } };
        }
        return {
          admission: {
            kind: "drop",
            reason,
            recordHistory: false,
          },
        };
      },
      resolveTurn: () => {
        const { finalize, ...replyPlan } = createWhatsAppReplyPlan({
          cfg: params.cfg,
          connectionId: params.connectionId,
          context: ctxPayload,
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
          statusReactionController,
        });
        finalizeReply = finalize;
        return {
          cfg: params.cfg,
          channel: "whatsapp",
          accountId: params.route.accountId,
          route: { agentId: params.route.agentId, sessionKey: params.route.sessionKey },
          ctxPayload,
          record: {
            onRecordError: (err) => {
              params.replyLogger.warn(
                {
                  error: formatError(err),
                  storePath,
                  sessionKey: params.route.sessionKey,
                },
                "failed updating session meta",
              );
            },
            trackSessionMetaTask: (task) => {
              trackBackgroundTask(params.backgroundTasks, task);
            },
          },
          ...replyPlan,
        };
      },
    },
  });
  const didSendReply = turnResult.dispatched
    ? (finalizeReply?.(turnResult.dispatchResult) ?? false)
    : false;
  removeAckReactionHandleAfterReply({
    removeAfterReply: false,
    ackReaction,
    onError: (err) => {
      logAckFailure({
        log: logVerbose,
        channel: "whatsapp",
        target: `${params.msg.platform.chatJid ?? conversationId}/${params.msg.event.id ?? "unknown"}`,
        error: err,
      });
    },
  });
  return didSendReply;
}
