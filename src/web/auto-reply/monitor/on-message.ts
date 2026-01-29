import type { MsgContext } from "../../../auto-reply/templating.js";
import type { getReplyFromConfig } from "../../../auto-reply/reply.js";
import type { loadConfig } from "../../../config/config.js";
import { logVerbose } from "../../../globals.js";
import { resolveAgentRoute } from "../../../routing/resolve-route.js";
import { buildGroupHistoryKey } from "../../../routing/session-key.js";
import { normalizeE164 } from "../../../utils.js";
import type { MentionConfig } from "../mentions.js";
import type { WebInboundMsg } from "../types.js";
import { maybeBroadcastMessage } from "./broadcast.js";
import type { EchoTracker } from "./echo.js";
import type { GroupHistoryEntry } from "./group-gating.js";
import { applyGroupGating } from "./group-gating.js";
import { updateLastRouteInBackground } from "./last-route.js";
import { resolvePeerId } from "./peer.js";
import { processMessage } from "./process-message.js";
import {
  createEngagementDebouncer,
  DEFAULT_ENGAGEMENT_DEBOUNCE,
  type DebounceBatch,
} from "../../../channels/engagement-debounce.js";

/** Info needed to process a debounced message */
type DebouncedMessageInfo = {
  msg: WebInboundMsg;
  route: ReturnType<typeof resolveAgentRoute>;
  groupHistoryKey: string;
  historyEntry: GroupHistoryEntry;
};

export function createWebOnMessageHandler(params: {
  cfg: ReturnType<typeof loadConfig>;
  verbose: boolean;
  connectionId: string;
  maxMediaBytes: number;
  groupHistoryLimit: number;
  groupHistories: Map<string, GroupHistoryEntry[]>;
  groupMemberNames: Map<string, Map<string, string>>;
  echoTracker: EchoTracker;
  backgroundTasks: Set<Promise<unknown>>;
  replyResolver: typeof getReplyFromConfig;
  replyLogger: ReturnType<(typeof import("../../../logging.js"))["getChildLogger"]>;
  baseMentionConfig: MentionConfig;
  account: { authDir?: string; accountId?: string };
}) {
  // Debouncer for engagement mode - collects message bursts
  const engagementDebouncer = createEngagementDebouncer<DebouncedMessageInfo>(
    DEFAULT_ENGAGEMENT_DEBOUNCE,
  );

  const processForRoute = async (
    msg: WebInboundMsg,
    route: ReturnType<typeof resolveAgentRoute>,
    groupHistoryKey: string,
    opts?: {
      groupHistory?: GroupHistoryEntry[];
      suppressGroupHistoryClear?: boolean;
    },
  ) =>
    processMessage({
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
      groupHistory: opts?.groupHistory,
      suppressGroupHistoryClear: opts?.suppressGroupHistoryClear,
    });

  // Set up debounce callback - fires when message burst settles
  engagementDebouncer.onFlush(
    async (groupKey: string, batch: DebounceBatch<DebouncedMessageInfo>) => {
      if (batch.messages.length === 0) return;

      // Check if any message in the batch triggered engagement
      const hasTriggered = batch.messages.some((m) => m.triggered);
      if (!hasTriggered) {
        // No triggers in batch - just add all to history for future context
        for (const pending of batch.messages) {
          const existing = params.groupHistories.get(groupKey) ?? [];
          existing.push(pending.message.historyEntry);
          while (existing.length > params.groupHistoryLimit) existing.shift();
          params.groupHistories.set(groupKey, existing);
        }
        logVerbose(
          `[engagement-debounce] batch for ${groupKey} had no triggers, added ${batch.messages.length} to history`,
        );
        return;
      }

      // Build history from all messages except the last one (which is "current")
      const historyMessages = batch.messages.slice(0, -1).map((m) => m.message.historyEntry);
      const lastMessage = batch.messages[batch.messages.length - 1];

      logVerbose(
        `[engagement-debounce] processing batch for ${groupKey}: ${batch.messages.length} messages, ${historyMessages.length} as history`,
      );

      // Process with the batched history
      await processForRoute(
        lastMessage.message.msg,
        lastMessage.message.route,
        lastMessage.message.groupHistoryKey,
        {
          groupHistory: historyMessages,
          suppressGroupHistoryClear: true,
        },
      );
    },
  );

  return async (msg: WebInboundMsg) => {
    const conversationId = msg.conversationId ?? msg.from;
    const peerId = resolvePeerId(msg);
    const route = resolveAgentRoute({
      cfg: params.cfg,
      channel: "whatsapp",
      accountId: msg.accountId,
      peer: {
        kind: msg.chatType === "group" ? "group" : "dm",
        id: peerId,
      },
    });
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

    if (msg.chatType === "group") {
      const metaCtx = {
        From: msg.from,
        To: msg.to,
        SessionKey: route.sessionKey,
        AccountId: route.accountId,
        ChatType: msg.chatType,
        ConversationLabel: conversationId,
        GroupSubject: msg.groupSubject,
        SenderName: msg.senderName,
        SenderId: msg.senderJid?.trim() || msg.senderE164,
        SenderE164: msg.senderE164,
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

      const gating = applyGroupGating({
        cfg: params.cfg,
        msg,
        conversationId,
        groupHistoryKey,
        agentId: route.agentId,
        sessionKey: route.sessionKey,
        baseMentionConfig: params.baseMentionConfig,
        authDir: params.account.authDir,
        groupHistories: params.groupHistories,
        groupHistoryLimit: params.groupHistoryLimit,
        groupMemberNames: params.groupMemberNames,
        logVerbose,
        replyLogger: params.replyLogger,
      });
      // In engagement mode, use debouncing to collect message bursts
      if (gating.mode === "engagement") {
        const sender =
          msg.senderName && msg.senderE164
            ? `${msg.senderName} (${msg.senderE164})`
            : (msg.senderName ?? msg.senderE164 ?? "Unknown");

        const historyEntry: GroupHistoryEntry = {
          sender,
          body: msg.body,
          timestamp: msg.timestamp,
          id: msg.id,
          senderJid: msg.senderJid,
        };

        // Add to debouncer - it will fire callback after quiet period
        engagementDebouncer.addMessage(groupHistoryKey, {
          message: { msg, route, groupHistoryKey, historyEntry },
          timestamp: msg.timestamp ?? Date.now(),
          triggered: gating.shouldProcess,
        });

        logVerbose(
          `[engagement-debounce] added message to batch for ${conversationId}, triggered=${gating.shouldProcess}`,
        );
        return;
      }

      if (!gating.shouldProcess) return;
    } else {
      // Ensure `peerId` for DMs is stable and stored as E.164 when possible.
      if (!msg.senderE164 && peerId && peerId.startsWith("+")) {
        msg.senderE164 = normalizeE164(peerId) ?? msg.senderE164;
      }
    }

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
        processMessage: processForRoute,
      })
    ) {
      return;
    }

    await processForRoute(msg, route, groupHistoryKey);
  };
}
