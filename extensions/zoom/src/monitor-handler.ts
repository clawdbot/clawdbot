import type { MoltbotConfig, RuntimeEnv, GroupPolicy } from "clawdbot/plugin-sdk";

import type { ZoomConversationStore } from "./conversation-store.js";
import { formatUnknownError } from "./errors.js";
import type { ZoomMonitorLogger } from "./monitor-types.js";
import { isZoomGroupAllowed, resolveZoomAllowlistMatch, resolveZoomReplyPolicy } from "./policy.js";
import type { ZoomConfig, ZoomCredentials, ZoomWebhookEvent } from "./types.js";
import { getZoomRuntime } from "./runtime.js";

export type ZoomMessageHandlerDeps = {
  cfg: MoltbotConfig;
  runtime: RuntimeEnv;
  creds: ZoomCredentials;
  textLimit: number;
  conversationStore: ZoomConversationStore;
  log: ZoomMonitorLogger;
};

/**
 * Extract mention of the bot from message text.
 * Zoom mentions format: @<display_name> or uses robot_jid in payload
 */
function extractBotMention(params: {
  text: string;
  botJid: string;
  robotJidInPayload?: string;
}): { mentioned: boolean; cleanText: string } {
  const { text, botJid, robotJidInPayload } = params;

  // Check if robot_jid in payload matches our bot
  if (robotJidInPayload && robotJidInPayload === botJid) {
    return { mentioned: true, cleanText: text.trim() };
  }

  // Clean up any @mention patterns (Zoom uses @DisplayName format)
  // The bot might be mentioned as @BotName - we'll preserve the text as-is
  // since the mention check already passed via robot_jid
  return { mentioned: false, cleanText: text.trim() };
}

export function createZoomMessageHandler(deps: ZoomMessageHandlerDeps) {
  const { cfg, runtime, creds, textLimit, conversationStore, log } = deps;
  const zoomCfg = cfg.channels?.zoom as ZoomConfig | undefined;
  const core = getZoomRuntime();

  return async (event: ZoomWebhookEvent) => {
    const eventType = event.event;

    log.debug("received webhook event", { event: eventType });

    // Handle bot notification (slash commands / direct messages to bot)
    if (eventType === "bot_notification") {
      await handleBotNotification(event);
      return;
    }

    // Handle channel mentions (when bot is @mentioned in a channel)
    if (eventType === "chat_message.posted" || eventType === "team_chat.app_mention") {
      await handleChannelMessage(event);
      return;
    }

    log.info(`ignoring unhandled event type: ${eventType}`);
  };

  async function handleBotNotification(event: ZoomWebhookEvent) {
    // Debug: log full event structure
    log.info(`bot_notification event: ${JSON.stringify(event)}`);

    const payload = event.payload?.object ?? event.payload;
    if (!payload) {
      log.debug("bot_notification missing payload object");
      return;
    }

    const userJid = payload.userJid ?? payload.operator;
    const userName = payload.userName ?? payload.user_name ?? payload.operator;
    const userEmail = payload.user_email;
    const toJid = payload.toJid;
    const channelName = payload.channelName;
    // For bot notifications, text comes from payload.text or payload.cmd
    const messageText = payload.text ?? payload.cmd ?? "";

    if (!userJid || !messageText) {
      log.debug("bot_notification missing required fields", { userJid, hasMessage: Boolean(messageText) });
      return;
    }

    // Detect if this is a channel message (toJid contains @conference.)
    const isChannelMessage = toJid?.includes("@conference.") ?? false;
    const conversationId = isChannelMessage ? toJid : userJid;

    log.debug("processing bot notification", {
      userJid,
      userName,
      toJid,
      isChannelMessage,
      textLength: messageText.length,
    });

    if (isChannelMessage) {
      // Channel message - check group policy
      const groupPolicy: GroupPolicy = zoomCfg?.groupPolicy ?? "open";

      if (groupPolicy === "disabled") {
        log.debug("group policy disabled, ignoring channel message");
        return;
      }

      // Store channel conversation reference
      await conversationStore.upsert(toJid, {
        channelJid: toJid,
        channelName,
        robotJid: creds.botJid,
        accountId: creds.accountId,
        conversationType: "channel",
      });

      // Route to agent with channel context
      await routeToAgent({
        conversationId: toJid,
        senderId: userJid,
        senderName: userName,
        senderEmail: userEmail,
        text: messageText,
        isDirect: false,
        channelJid: toJid,
        channelName,
      });
    } else {
      // Direct message - check DM policy
      const dmPolicy = zoomCfg?.dmPolicy ?? "pairing";
      const allowFrom = zoomCfg?.allowFrom ?? [];

      if (dmPolicy === "disabled") {
        log.debug("dm policy disabled, ignoring message");
        return;
      }

      if (dmPolicy !== "open") {
        const match = resolveZoomAllowlistMatch({
          allowFrom,
          senderId: userJid,
          senderName: userName,
          senderEmail: userEmail,
        });

        if (!match.allowed) {
          log.debug("sender not in allowlist", { userJid, userName });
          return;
        }
      }

      // Store DM conversation reference
      await conversationStore.upsert(userJid, {
        userJid,
        userName,
        userEmail,
        robotJid: creds.botJid,
        accountId: creds.accountId,
        conversationType: "direct",
      });

      // Route to agent
      await routeToAgent({
        conversationId: userJid,
        senderId: userJid,
        senderName: userName,
        senderEmail: userEmail,
        text: messageText,
        isDirect: true,
      });
    }
  }

  async function handleChannelMessage(event: ZoomWebhookEvent) {
    const payload = event.payload?.object;
    if (!payload) {
      log.debug("channel message missing payload object");
      return;
    }

    const channelJid = payload.channel_jid;
    const channelName = payload.channel_name;
    const message = payload.message;
    const senderId = message?.sender ?? message?.sender_member_id;
    const senderName = message?.sender_display_name;
    const robotJidInPayload = message?.robot_jid ?? payload.robot_jid;
    const messageText = message?.message ?? "";
    const messageId = message?.id;

    if (!channelJid || !senderId || !messageText) {
      log.debug("channel message missing required fields", {
        hasChannel: Boolean(channelJid),
        hasSender: Boolean(senderId),
        hasMessage: Boolean(messageText),
      });
      return;
    }

    log.debug("processing channel message", {
      channelJid,
      channelName,
      senderId,
      textLength: messageText.length,
    });

    // Check group policy
    const groupPolicy: GroupPolicy = zoomCfg?.groupPolicy ?? "allowlist";
    const groupAllowFrom = zoomCfg?.groupAllowFrom ?? [];

    if (!isZoomGroupAllowed({
      groupPolicy,
      allowFrom: groupAllowFrom,
      senderId,
      senderName,
    })) {
      log.debug("sender not allowed in group", { senderId, senderName, groupPolicy });
      return;
    }

    // Check mention requirement
    const replyPolicy = resolveZoomReplyPolicy({
      isDirectMessage: false,
      globalConfig: zoomCfg,
    });

    const { mentioned, cleanText } = extractBotMention({
      text: messageText,
      botJid: creds.botJid,
      robotJidInPayload,
    });

    if (replyPolicy.requireMention && !mentioned) {
      log.debug("message does not mention bot, ignoring", { channelJid });
      return;
    }

    // Store conversation reference
    await conversationStore.upsert(channelJid, {
      channelJid,
      channelName,
      robotJid: creds.botJid,
      accountId: creds.accountId,
      conversationType: "channel",
      lastMessageId: messageId,
    });

    // Route to Moltbot agent
    await routeToAgent({
      conversationId: channelJid,
      senderId,
      senderName,
      text: cleanText,
      isDirect: false,
      channelJid,
      channelName,
      replyToMessageId: messageId,
    });
  }

  async function routeToAgent(params: {
    conversationId: string;
    senderId: string;
    senderName?: string;
    senderEmail?: string;
    text: string;
    isDirect: boolean;
    channelJid?: string;
    channelName?: string;
    replyToMessageId?: string;
  }) {
    try {
      const { conversationId, senderId, senderName, text, isDirect, channelJid, channelName } = params;

      log.debug("routing to agent", {
        conversationId,
        senderId,
        isDirect,
        textLength: text.length,
      });

      // Resolve the agent route
      const route = core.channel.routing.resolveAgentRoute({
        cfg,
        channel: "zoom",
        chatType: isDirect ? "direct" : "channel",
        from: senderId,
        to: conversationId,
        groupId: channelJid,
      });

      // Build finalized inbound context
      const ctxPayload = core.channel.reply.finalizeInboundContext({
        Body: text,
        RawBody: text,
        CommandBody: text,
        From: isDirect ? `zoom:${senderId}` : `zoom:channel:${channelJid}`,
        To: conversationId,
        SessionKey: route.sessionKey,
        AccountId: route.accountId,
        ChatType: isDirect ? "direct" : "channel",
        ConversationLabel: senderName ?? senderId,
        SenderName: senderName,
        SenderId: senderId,
        GroupSubject: isDirect ? undefined : channelName,
        GroupChannel: isDirect ? undefined : channelJid,
        Provider: "zoom" as const,
        Surface: "zoom" as const,
        CommandAuthorized: true,
        CommandSource: "text" as const,
        OriginatingChannel: "zoom" as const,
        OriginatingTo: conversationId,
      });

      // Create reply dispatcher with delivery function
      const { dispatcher, replyOptions, markDispatchIdle } =
        core.channel.reply.createReplyDispatcherWithTyping({
          humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, route.agentId),
          deliver: async (payload) => {
            const { sendZoomTextMessage } = await import("./send.js");
            if (payload.text) {
              await sendZoomTextMessage({
                cfg,
                to: conversationId,
                text: payload.text,
                isChannel: !isDirect,
              });
            }
          },
          onError: (err, info) => {
            const errMsg = err instanceof Error ? err.message : String(err);
            log.error(`zoom ${info.kind} reply failed: ${errMsg}`);
          },
        });

      // Dispatch to agent
      const { queuedFinal, counts } = await core.channel.reply.dispatchReplyFromConfig({
        ctx: ctxPayload,
        cfg,
        dispatcher,
        replyOptions,
      });

      markDispatchIdle();

      if (queuedFinal) {
        const finalCount = counts.final;
        log.info(`delivered ${finalCount} reply${finalCount === 1 ? "" : "ies"} to ${conversationId}`);
      }
    } catch (err) {
      log.error("failed to route to agent", { error: formatUnknownError(err) });
    }
  }
}
