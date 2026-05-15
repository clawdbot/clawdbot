import type { AckReactionHandle } from "openclaw/plugin-sdk/channel-feedback";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { getReplyFromConfig } from "openclaw/plugin-sdk/reply-runtime";
import type { MsgContext } from "openclaw/plugin-sdk/reply-runtime";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { buildGroupHistoryKey } from "openclaw/plugin-sdk/routing";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { resolveWhatsAppAccount } from "../../accounts.js";
import { resolveWhatsAppGroupSessionRoute } from "../../group-session-key.js";
import { getPrimaryIdentityId, getSenderIdentity } from "../../identity.js";
import { normalizeE164 } from "../../text-runtime.js";
import { buildMentionConfig } from "../mentions.js";
import type { MentionConfig } from "../mentions.js";
import type { WebInboundMsg } from "../types.js";
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
  const processForRoute = async (
    cfg: OpenClawConfig,
    msg: WebInboundMsg,
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

  return async (msg: WebInboundMsg) => {
    const cfg = params.loadConfig?.() ?? params.cfg;
    const conversationId = msg.conversationId ?? msg.from;
    const peerId = resolvePeerId(msg);
    const baseRoute = resolveAgentRoute({
      cfg,
      channel: "whatsapp",
      accountId: msg.accountId,
      peer: {
        kind: msg.chatType === "group" ? "group" : "direct",
        id: peerId,
      },
    });
    const route =
      msg.chatType === "group" ? resolveWhatsAppGroupSessionRoute(baseRoute) : baseRoute;
    const groupHistoryKey =
      msg.chatType === "group"
        ? buildGroupHistoryKey({
            channel: "whatsapp",
            accountId: route.accountId,
            peerKind: "group",
            peerId,
          })
        : route.sessionKey;
    const account = resolveWhatsAppAccount({
      cfg,
      accountId: route.accountId ?? msg.accountId ?? params.account.accountId,
    });
    const baseMentionConfig = buildMentionConfig(cfg);

    // Same-phone mode logging retained
    if (msg.from === msg.to) {
      logVerbose(`📱 Same-phone mode detected (from === to: ${msg.from})`);
    }

    // Skip if this is a message we just sent (echo detection)
    if (params.echoTracker.has(msg.body)) {
      logVerbose("Skipping auto-reply: detected echo (message matches recently sent text)");
      params.echoTracker.forget(msg.body);
      return;
    }

    // Preflight audio transcription: run once before broadcast fan-out so all
    // agents share the same transcript instead of each making a separate STT call.
    // For DMs, only do this on the real inbound path after access-control/pairing
    // checks have already passed in inbound/monitor.ts. For groups, the first
    // gating pass must approve the group/sender before STT is attempted.
    // null = preflight was attempted but produced no transcript (failed / disabled / no audio);
    // undefined = preflight was not attempted (non-audio message).
    let preflightAudioTranscript: string | null | undefined;
    const hasAudioBody =
      msg.mediaType?.startsWith("audio/") === true && msg.body === "<media:audio>";
    const canRunEarlyAudioPreflight = msg.chatType === "group" || msg.accessControlPassed === true;
    let ackAlreadySent = false;
    let ackReaction: AckReactionHandle | null = null;
    let statusReactionController: StatusReactionController | null = null;
    const runAudioPreflightOnce = async () => {
      if (
        preflightAudioTranscript !== undefined ||
        !canRunEarlyAudioPreflight ||
        !hasAudioBody ||
        !msg.mediaPath
      ) {
        return;
      }
      if (cfg.messages?.statusReactions?.enabled === true) {
        statusReactionController = await createWhatsAppStatusReactionController({
          cfg,
          msg,
          agentId: route.agentId,
          sessionKey: route.sessionKey,
          conversationId,
          verbose: params.verbose,
          accountId: route.accountId,
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
          conversationId,
          verbose: params.verbose,
          accountId: route.accountId,
          info: params.replyLogger.info.bind(params.replyLogger),
          warn: params.replyLogger.warn.bind(params.replyLogger),
        });
        ackAlreadySent = ackReaction !== null;
      }
      try {
        const { transcribeFirstAudio } = await import("./audio-preflight.runtime.js");
        // transcribeFirstAudio returns undefined on failure/disabled; store null so
        // processMessage knows the attempt was already made and does not retry.
        preflightAudioTranscript =
          (await transcribeFirstAudio({
            ctx: {
              MediaPaths: [msg.mediaPath],
              MediaTypes: msg.mediaType ? [msg.mediaType] : undefined,
              From: msg.from,
              To: msg.to,
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

    if (msg.chatType === "group") {
      const sender = getSenderIdentity(msg);
      const metaCtx = {
        From: msg.from,
        To: msg.to,
        SessionKey: route.sessionKey,
        AccountId: route.accountId,
        ChatType: msg.chatType,
        ConversationLabel: conversationId,
        GroupSubject: msg.groupSubject,
        SenderName: sender.name ?? undefined,
        SenderId: getPrimaryIdentityId(sender) ?? undefined,
        SenderE164: sender.e164 ?? undefined,
        Provider: "whatsapp",
        Surface: "whatsapp",
        OriginatingChannel: "whatsapp",
        OriginatingTo: conversationId,
      } satisfies MsgContext;
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

      let gating = await applyGroupGating({
        cfg,
        msg,
        deferMissingMention: hasAudioBody && Boolean(msg.mediaPath),
        conversationId,
        groupHistoryKey,
        agentId: route.agentId,
        sessionKey: route.sessionKey,
        baseMentionConfig,
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
          conversationId,
          groupHistoryKey,
          agentId: route.agentId,
          sessionKey: route.sessionKey,
          baseMentionConfig,
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
        return;
      }
    } else {
      // Ensure `peerId` for DMs is stable and stored as E.164 when possible.
      if (!msg.sender?.e164 && !msg.senderE164 && peerId && peerId.startsWith("+")) {
        const normalized = normalizeE164(peerId);
        if (normalized) {
          msg.sender = { ...msg.sender, e164: normalized };
          msg.senderE164 = normalized;
        }
      }
    }

    await runAudioPreflightOnce();

    // Broadcast groups: when we'd reply anyway, run multiple agents.
    // Does not bypass group mention/activation gating above.
    if (
      await maybeBroadcastMessage({
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
        ...(ackAlreadySent && msg.chatType !== "group" ? { ackAlreadySent: true } : {}),
        ...(ackReaction && msg.chatType !== "group" ? { ackReaction } : {}),
        ...(statusReactionController && msg.chatType !== "group" ? { ackAlreadySent: true } : {}),
        processMessage: (m, r, k, opts) => processForRoute(cfg, m, r, k, opts),
      })
    ) {
      return;
    }

    await processForRoute(cfg, msg, route, groupHistoryKey, {
      ...(preflightAudioTranscript !== undefined ? { preflightAudioTranscript } : {}),
      ...(ackAlreadySent ? { ackAlreadySent: true } : {}),
      ...(ackReaction ? { ackReaction } : {}),
      ...(statusReactionController ? { statusReactionController } : {}),
    });
  };
}
