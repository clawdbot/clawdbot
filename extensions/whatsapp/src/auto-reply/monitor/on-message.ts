import type { AckReactionHandle } from "openclaw/plugin-sdk/channel-feedback";
import type { getReplyFromConfig } from "openclaw/plugin-sdk/reply-runtime";
import type { MsgContext } from "openclaw/plugin-sdk/reply-runtime";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { buildGroupHistoryKey } from "openclaw/plugin-sdk/routing";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { resolveWhatsAppGroupSessionRoute } from "../../group-session-key.js";
import { getPrimaryIdentityId, getSenderIdentity } from "../../identity.js";
import { normalizeE164 } from "../../text-runtime.js";
import { getRuntimeConfig } from "../config.runtime.js";
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

export function createWebOnMessageHandler(params: {
  cfg: ReturnType<typeof getRuntimeConfig>;
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
    msg: WebInboundMsg,
    route: ReturnType<typeof resolveAgentRoute>,
    groupHistoryKey: string,
    opts?: {
      groupHistory?: GroupHistoryEntry[];
      suppressGroupHistoryClear?: boolean;
      preflightAudioTranscript?: string | null;
      ackAlreadySent?: boolean;
      ackReaction?: AckReactionHandle | null;
    },
  ) => {
    const processParams: Parameters<typeof processMessage>[0] = {
      cfg: params.cfg,
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
    return processMessage(processParams);
  };

  return async (msg: WebInboundMsg) => {
    const conversationId = msg.conversationId ?? msg.from;
    const peerId = resolvePeerId(msg);
    // Fresh config for bindings lookup; other routing inputs are payload-derived.
    const baseRoute = resolveAgentRoute({
      cfg: getRuntimeConfig(),
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
    const runAudioPreflightOnce = async () => {
      if (
        preflightAudioTranscript !== undefined ||
        !canRunEarlyAudioPreflight ||
        !hasAudioBody ||
        !msg.mediaPath
      ) {
        return;
      }
      ackReaction = await maybeSendAckReaction({
        cfg: params.cfg,
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
      try {
        const { transcribeFirstAudio } = await import("./audio-preflight.runtime.js");
        // transcribeFirstAudio returns undefined on failure/disabled; store null so
        // processMessage knows the attempt was already made and does not retry.
        preflightAudioTranscript =
          (await transcribeFirstAudio({
            ctx: {
              MediaPaths: [msg.mediaPath],
              MediaTypes: msg.mediaType ? [msg.mediaType] : undefined,
            },
            cfg: params.cfg,
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
        cfg: params.cfg,
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
        cfg: params.cfg,
        msg,
        deferMissingMention: hasAudioBody && Boolean(msg.mediaPath),
        conversationId,
        groupHistoryKey,
        agentId: route.agentId,
        sessionKey: route.sessionKey,
        baseMentionConfig: params.baseMentionConfig,
        authDir: params.account.authDir,
        selfChatMode: params.account.selfChatMode,
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
          cfg: params.cfg,
          msg,
          ...(typeof preflightAudioTranscript === "string"
            ? { mentionText: preflightAudioTranscript }
            : {}),
          conversationId,
          groupHistoryKey,
          agentId: route.agentId,
          sessionKey: route.sessionKey,
          baseMentionConfig: params.baseMentionConfig,
          authDir: params.account.authDir,
          selfChatMode: params.account.selfChatMode,
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
        cfg: params.cfg,
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
        processMessage: (m, r, k, opts) => processForRoute(m, r, k, opts),
      })
    ) {
      return;
    }

    await processForRoute(msg, route, groupHistoryKey, {
      ...(preflightAudioTranscript !== undefined ? { preflightAudioTranscript } : {}),
      ...(ackAlreadySent ? { ackAlreadySent: true } : {}),
      ...(ackReaction ? { ackReaction } : {}),
    });
  };
}
