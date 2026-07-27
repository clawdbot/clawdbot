// Whatsapp plugin module implements on message behavior.
import type { AckReactionHandle } from "openclaw/plugin-sdk/channel-feedback";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  ensureConfiguredBindingRouteReady,
  resolveConfiguredBindingRoute,
} from "openclaw/plugin-sdk/conversation-binding-runtime";
import type { getReplyFromConfig } from "openclaw/plugin-sdk/reply-runtime";
import type { MsgContext } from "openclaw/plugin-sdk/reply-runtime";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { buildGroupHistoryKey } from "openclaw/plugin-sdk/routing";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { resolveWhatsAppAccount } from "../../accounts.js";
import { resolveWhatsAppGroupSessionRoute } from "../../group-session-key.js";
import { getPrimaryIdentityId, getSenderIdentity } from "../../identity.js";
import {
  requireAdmittedWhatsAppInboundMessage,
  requireWhatsAppInboundAdmission,
} from "../../inbound/admission.js";
import {
  normalizeWebInboundMessage,
  withDeprecatedWebInboundMessageFlatAliases,
} from "../../inbound/message-aliases.js";
import type { AdmittedWebInboundMessage, WebInboundMessageInput } from "../../inbound/types.js";
import { normalizeE164 } from "../../text-runtime.js";
import { buildMentionConfig } from "../mentions.js";
import type { MentionConfig } from "../mentions.js";
import { maybeSendAckReaction } from "./ack-reaction.js";
import { maybeBroadcastMessage } from "./broadcast.js";
import type { EchoTracker } from "./echo.js";
import type { GroupHistoryEntry } from "./group-gating.js";
import { applyGroupGating } from "./group-gating.js";
import { updateLastRouteInBackground } from "./last-route.js";
import { resolvePeerId } from "./peer.js";
import { processMessage } from "./process-message.js";
import {
  createWhatsAppStatusReactionController,
  type StatusReactionController,
} from "./status-reaction.js";

export function createWebOnMessageHandler(params: {
  cfg: OpenClawConfig;
  loadConfig?: () => OpenClawConfig;
  verbose: boolean;
  connectionId: string;
  maxMediaBytes: number;
  groupHistoryLimit: number;
  groupHistories: Map<string, GroupHistoryEntry[]>;
  groupMemberNames: Map<string, Map<string, string>>;
  echoTracker: EchoTracker;
  backgroundTasks: Set<Promise<unknown>>;
  replyResolver: typeof getReplyFromConfig;
  replyLogger: ReturnType<(typeof import("openclaw/plugin-sdk/runtime-env"))["getChildLogger"]>;
  baseMentionConfig: MentionConfig;
  account: { authDir?: string; accountId?: string; selfChatMode?: boolean };
}) {
  const hasExplicitlyPassedInboundAccess = (msg: WebInboundMessageInput): boolean =>
    msg.admission ? msg.admission.ingress.decision === "allow" : msg.accessControlPassed === true;

  const withDirectSenderPeer = (
    msg: AdmittedWebInboundMessage,
    peerId: string,
  ): AdmittedWebInboundMessage => {
    const admission = requireWhatsAppInboundAdmission(msg);
    if (
      admission.conversation.kind === "group" ||
      msg.platform.sender?.e164 ||
      msg.platform.senderE164 ||
      !peerId.startsWith("+")
    ) {
      return msg;
    }
    const normalized = normalizeE164(peerId);
    if (!normalized) {
      return msg;
    }
    return requireAdmittedWhatsAppInboundMessage(
      withDeprecatedWebInboundMessageFlatAliases({
        ...msg,
        platform: {
          ...msg.platform,
          sender: { ...msg.platform.sender, e164: normalized },
          senderE164: normalized,
        },
      }),
    );
  };

  const processForRoute = async (
    cfg: OpenClawConfig,
    msg: AdmittedWebInboundMessage,
    route: ReturnType<typeof resolveAgentRoute>,
    groupHistoryKey: string,
    opts?: {
      groupHistory?: GroupHistoryEntry[];
      suppressGroupHistoryClear?: boolean;
      preflightAudioTranscript?: string | null;
      ackAlreadySent?: boolean;
      ackReaction?: AckReactionHandle | null;
      statusReactionController?: StatusReactionController | null;
    },
  ) => {
    const processParams: Parameters<typeof processMessage>[0] = {
      cfg,
      msg,
      route,
      groupHistoryKey,
      groupHistories: params.groupHistories,
      groupHistoryLimit: params.groupHistoryLimit,
      groupMemberNames: params.groupMemberNames,
      connectionId: params.connectionId,
      verbose: params.verbose,
      maxMediaBytes: params.maxMediaBytes,
      replyResolver: params.replyResolver,
      replyLogger: params.replyLogger,
      backgroundTasks: params.backgroundTasks,
      rememberSentText: params.echoTracker.rememberText,
      echoHas: params.echoTracker.has,
      echoForget: params.echoTracker.forget,
      buildCombinedEchoKey: params.echoTracker.buildCombinedKey,
    };
    if (opts?.groupHistory !== undefined) {
      processParams.groupHistory = opts.groupHistory;
    }
    if (opts?.suppressGroupHistoryClear !== undefined) {
      processParams.suppressGroupHistoryClear = opts.suppressGroupHistoryClear;
    }
    if (opts?.preflightAudioTranscript !== undefined) {
      processParams.preflightAudioTranscript = opts.preflightAudioTranscript;
    }
    if (opts?.ackAlreadySent === true) {
      processParams.ackAlreadySent = true;
    }
    if (opts?.ackReaction !== undefined) {
      processParams.ackReaction = opts.ackReaction;
    }
    if (opts?.statusReactionController !== undefined) {
      processParams.statusReactionController = opts.statusReactionController;
    }
    return processMessage(processParams);
  };

  return async (rawMsg: WebInboundMessageInput) => {
    const canRunDirectEarlyAudioPreflight = hasExplicitlyPassedInboundAccess(rawMsg);
    const normalizedMsg = requireAdmittedWhatsAppInboundMessage(normalizeWebInboundMessage(rawMsg));
    const cfg = params.loadConfig?.() ?? params.cfg;
    const peerId = resolvePeerId(normalizedMsg);
    const msg = withDirectSenderPeer(normalizedMsg, peerId);
    const admission = requireWhatsAppInboundAdmission(msg);
    if (admission.ingress.admission !== "dispatch" && admission.ingress.admission !== "observe") {
      return;
    }
    const conversationId = admission.conversation.id;
    const conversationKind = admission.conversation.kind;
    const baseRoute = resolveAgentRoute({
      cfg,
      channel: "whatsapp",
      accountId: admission.accountId,
      peer: {
        kind: conversationKind,
        id: peerId,
      },
    });
    const baseConversationRoute =
      conversationKind === "group" ? resolveWhatsAppGroupSessionRoute(baseRoute) : baseRoute;
    const routeAccountId = baseConversationRoute.accountId ?? admission.accountId;
    const account = resolveWhatsAppAccount({
      cfg,
      accountId: routeAccountId,
    });
    const baseMentionConfig = buildMentionConfig(cfg);

    // Same-phone mode logging retained
    if (conversationId === msg.platform.recipientJid) {
      logVerbose(`📱 Same-phone mode detected (from === to: ${conversationId})`);
    }

    // Skip if this is a message we just sent (echo detection)
    if (params.echoTracker.has(msg.payload.body)) {
      logVerbose("Skipping auto-reply: detected echo (message matches recently sent text)");
      params.echoTracker.forget(msg.payload.body);
      return;
    }

    const configuredRoute = resolveConfiguredBindingRoute({
      cfg,
      route: baseConversationRoute,
      channel: "whatsapp",
      accountId: routeAccountId,
      conversationId: peerId,
    });
    // Bound route facts intentionally feed group activation/mention policy.
    // Side-effectful ACP readiness still waits until the group turn is admitted.
    const route = configuredRoute.route;
    const groupHistoryKey =
      conversationKind === "group"
        ? buildGroupHistoryKey({
            channel: "whatsapp",
            accountId: route.accountId,
            peerKind: "group",
            peerId,
          })
        : route.sessionKey;

    // Preflight audio transcription: run once before broadcast fan-out so all
    // agents share the same transcript instead of each making a separate STT call.
    // For DMs, only do this on the real inbound path after access-control/pairing
    // checks have already passed in inbound/monitor.ts. For groups, the first
    // gating pass must approve the group/sender before STT is attempted.
    // null = preflight was attempted but produced no transcript (failed / disabled / no audio);
    // undefined = preflight was not attempted (non-audio message).
    let preflightAudioTranscript: string | null | undefined;
    const hasAudioBody =
      (msg.payload.media?.kind === "audio" ||
        msg.payload.media?.type?.startsWith("audio/") === true) &&
      !msg.payload.body.trim();
    const canRunEarlyAudioPreflight =
      conversationKind === "group" || canRunDirectEarlyAudioPreflight;
    let ackAlreadySent = false;
    let ackReaction: AckReactionHandle | null = null;
    let statusReactionController: StatusReactionController | null = null;
    let recordAcceptedConfiguredGroupRoute: (() => void) | null = null;
    const clearPreDispatchReaction = async () => {
      try {
        if (statusReactionController) {
          const controller = statusReactionController;
          statusReactionController = null;
          controller.cancelPending();
          await controller.clear();
          return;
        }
        if (ackReaction && (await ackReaction.ackReactionPromise)) {
          await ackReaction.remove();
        }
      } catch (err) {
        params.replyLogger.warn(
          { error: String(err) },
          "whatsapp: failed to clear pre-dispatch reaction after pre-dispatch rejection",
        );
      }
    };
    const transcribeAudioOnce = async () => {
      if (preflightAudioTranscript !== undefined || !hasAudioBody || !msg.payload.media?.path) {
        return;
      }
      try {
        const { transcribeFirstAudio } = await import("./audio-preflight.runtime.js");
        // transcribeFirstAudio returns undefined on failure/disabled; store null so
        // processMessage knows the attempt was already made and does not retry.
        preflightAudioTranscript =
          (await transcribeFirstAudio({
            ctx: {
              media: [
                {
                  path: msg.payload.media.path,
                  contentType: msg.payload.media.type,
                  kind: msg.payload.media.kind ?? undefined,
                },
              ],
              From: conversationId,
              To: msg.platform.recipientJid,
              Provider: "whatsapp",
              Surface: "whatsapp",
              OriginatingChannel: "whatsapp",
              OriginatingTo: conversationId,
              AccountId: route.accountId,
            },
            cfg,
          })) ?? null;
      } catch {
        // Non-fatal: store null so per-agent retries are suppressed.
        preflightAudioTranscript = null;
      }
    };
    const runAudioPreflightOnce = async () => {
      if (
        preflightAudioTranscript !== undefined ||
        !canRunEarlyAudioPreflight ||
        !hasAudioBody ||
        !msg.payload.media?.path
      ) {
        return;
      }
      if (cfg.messages?.statusReactions?.enabled === true) {
        statusReactionController = await createWhatsAppStatusReactionController({
          cfg,
          msg,
          agentId: route.agentId,
          sessionKey: route.sessionKey,
          verbose: params.verbose,
        });
        if (statusReactionController) {
          await statusReactionController.setQueued();
        }
      } else {
        ackReaction = await maybeSendAckReaction({
          cfg,
          msg,
          agentId: route.agentId,
          sessionKey: route.sessionKey,
          verbose: params.verbose,
          info: params.replyLogger.info.bind(params.replyLogger),
          warn: params.replyLogger.warn.bind(params.replyLogger),
        });
        ackAlreadySent = ackReaction !== null;
      }
      await transcribeAudioOnce();
    };

    if (conversationKind === "group") {
      const sender = getSenderIdentity(msg);
      const metaCtx = {
        From: conversationId,
        To: msg.platform.recipientJid,
        SessionKey: route.sessionKey,
        AccountId: route.accountId,
        ChatType: conversationKind,
        ConversationLabel: conversationId,
        GroupSubject: msg.group?.subject,
        SenderName: sender.name ?? undefined,
        SenderId: getPrimaryIdentityId(sender) ?? undefined,
        SenderE164: sender.e164 ?? undefined,
        Provider: "whatsapp",
        Surface: "whatsapp",
        OriginatingChannel: "whatsapp",
        OriginatingTo: conversationId,
      } satisfies MsgContext;
      const recordGroupRoute = () =>
        updateLastRouteInBackground({
          cfg,
          backgroundTasks: params.backgroundTasks,
          storeAgentId: route.agentId,
          sessionKey: route.sessionKey,
          channel: "whatsapp",
          to: conversationId,
          accountId: route.accountId,
          ctx: metaCtx,
          warn: params.replyLogger.warn.bind(params.replyLogger),
        });
      // Last-route state is a dispatch side effect. Group gating must admit the
      // message first; configured ACP routes also wait for backend readiness.
      recordAcceptedConfiguredGroupRoute = recordGroupRoute;

      let gating = await applyGroupGating({
        cfg,
        msg,
        deferMissingMention: hasAudioBody && Boolean(msg.payload.media?.path),
        groupHistoryKey,
        agentId: route.agentId,
        sessionKey: route.sessionKey,
        baseMentionConfig,
        providerMentionPatterns: account.mentionPatterns,
        authDir: account.authDir,
        selfChatMode: account.selfChatMode,
        groupHistories: params.groupHistories,
        groupHistoryLimit: params.groupHistoryLimit,
        groupMemberNames: params.groupMemberNames,
        logVerbose,
        replyLogger: params.replyLogger,
      });
      if (
        !gating.shouldProcess &&
        "needsMentionText" in gating &&
        gating.needsMentionText === true
      ) {
        await runAudioPreflightOnce();
        gating = await applyGroupGating({
          cfg,
          msg,
          ...(typeof preflightAudioTranscript === "string"
            ? { mentionText: preflightAudioTranscript }
            : {}),
          groupHistoryKey,
          agentId: route.agentId,
          sessionKey: route.sessionKey,
          baseMentionConfig,
          providerMentionPatterns: account.mentionPatterns,
          authDir: account.authDir,
          selfChatMode: account.selfChatMode,
          groupHistories: params.groupHistories,
          groupHistoryLimit: params.groupHistoryLimit,
          groupMemberNames: params.groupMemberNames,
          logVerbose,
          replyLogger: params.replyLogger,
        });
      }
      if (!gating.shouldProcess) {
        await clearPreDispatchReaction();
        return;
      }
    }

    if (configuredRoute.bindingResolution) {
      const ensured = await ensureConfiguredBindingRouteReady({
        cfg,
        bindingResolution: configuredRoute.bindingResolution,
      });
      if (!ensured.ok) {
        params.replyLogger.warn(
          `whatsapp: configured ACP binding unavailable for conversation ${configuredRoute.bindingResolution.record.conversation.conversationId}: ${ensured.error}`,
        );
        await clearPreDispatchReaction();
        return;
      }
    }
    if (recordAcceptedConfiguredGroupRoute && !configuredRoute.bindingResolution) {
      recordAcceptedConfiguredGroupRoute();
      recordAcceptedConfiguredGroupRoute = null;
    }

    await runAudioPreflightOnce();

    const hasBroadcastTargets =
      !configuredRoute.bindingResolution &&
      Array.isArray(cfg.broadcast?.[peerId]) &&
      cfg.broadcast[peerId].length > 0;
    if (hasBroadcastTargets && statusReactionController) {
      await clearPreDispatchReaction();
    }
    if (hasBroadcastTargets && !canRunEarlyAudioPreflight) {
      await transcribeAudioOnce();
    }

    if (
      !configuredRoute.bindingResolution &&
      (await maybeBroadcastMessage({
        cfg,
        msg,
        peerId,
        route,
        groupHistoryKey,
        groupHistories: params.groupHistories,
        ...(preflightAudioTranscript !== undefined ? { preflightAudioTranscript } : {}),
        // Group ack eligibility depends on the target agent/session, so a
        // preflight ack attempt on the base route must not suppress downstream
        // per-agent checks during broadcast fan-out.
        ...(ackAlreadySent && conversationKind !== "group" ? { ackAlreadySent: true } : {}),
        ...(ackReaction && conversationKind !== "group" ? { ackReaction } : {}),
        ...(statusReactionController && conversationKind !== "group"
          ? { ackAlreadySent: true }
          : {}),
        processMessage: (m, r, k, opts) => processForRoute(cfg, m, r, k, opts),
      }))
    ) {
      return;
    }

    recordAcceptedConfiguredGroupRoute?.();

    await processForRoute(cfg, msg, route, groupHistoryKey, {
      ...(preflightAudioTranscript !== undefined ? { preflightAudioTranscript } : {}),
      ...(ackAlreadySent ? { ackAlreadySent: true } : {}),
      ...(ackReaction ? { ackReaction } : {}),
      ...(statusReactionController ? { statusReactionController } : {}),
    });
  };
}
