import { formatAgentEnvelope } from "../../auto-reply/envelope.js";
import { dispatchReplyFromConfig } from "../../auto-reply/reply/dispatch-from-config.js";
import {
  buildHistoryContextFromMap,
  clearHistoryEntries,
  DEFAULT_GROUP_HISTORY_LIMIT,
  type HistoryEntry,
} from "../../auto-reply/reply/history.js";
import { danger, logVerbose, shouldLogVerbose } from "../../globals.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import {
  readChannelAllowFromStore,
  upsertChannelPairingRequest,
} from "../../pairing/pairing-store.js";
import { resolveAgentRoute } from "../../routing/resolve-route.js";

import {
  buildMSTeamsAttachmentPlaceholder,
  buildMSTeamsMediaPayload,
  type MSTeamsAttachmentLike,
  summarizeMSTeamsHtmlAttachments,
} from "../attachments.js";
import type { StoredConversationReference } from "../conversation-store.js";
import { formatUnknownError } from "../errors.js";
import {
  extractMSTeamsConversationMessageId,
  normalizeMSTeamsConversationId,
  parseMSTeamsActivityTimestamp,
  stripMSTeamsMentionTags,
  wasMSTeamsBotMentioned,
} from "../inbound.js";
import type { MSTeamsMessageHandlerDeps } from "../monitor-handler.js";
import {
  isMSTeamsGroupAllowed,
  resolveMSTeamsReplyPolicy,
  resolveMSTeamsRouteConfig,
} from "../policy.js";
import { extractMSTeamsPollVote } from "../polls.js";
import { createMSTeamsReplyDispatcher } from "../reply-dispatcher.js";
import type { MSTeamsTurnContext } from "../sdk-types.js";
import { resolveMSTeamsInboundMedia } from "./inbound-media.js";

export function createMSTeamsMessageHandler(deps: MSTeamsMessageHandlerDeps) {
  const {
    cfg,
    runtime,
    appId,
    adapter,
    tokenProvider,
    textLimit,
    mediaMaxBytes,
    conversationStore,
    pollStore,
    log,
  } = deps;
  const msteamsCfg = cfg.channels?.msteams;
  const historyLimit = Math.max(
    0,
    msteamsCfg?.historyLimit ??
      cfg.messages?.groupChat?.historyLimit ??
      DEFAULT_GROUP_HISTORY_LIMIT,
  );
  const conversationHistories = new Map<string, HistoryEntry[]>();

  return async function handleTeamsMessage(context: MSTeamsTurnContext) {
    const activity = context.activity;
    const rawText = activity.text?.trim() ?? "";
    const text = stripMSTeamsMentionTags(rawText);
    const attachments = Array.isArray(activity.attachments)
      ? (activity.attachments as unknown as MSTeamsAttachmentLike[])
      : [];
    const attachmentPlaceholder =
      buildMSTeamsAttachmentPlaceholder(attachments);
    const rawBody = text || attachmentPlaceholder;
    const from = activity.from;
    const conversation = activity.conversation;

    const attachmentTypes = attachments
      .map((att) =>
        typeof att.contentType === "string" ? att.contentType : undefined,
      )
      .filter(Boolean)
      .slice(0, 3);
    const htmlSummary = summarizeMSTeamsHtmlAttachments(attachments);

    log.info("received message", {
      rawText: rawText.slice(0, 50),
      text: text.slice(0, 50),
      attachments: attachments.length,
      attachmentTypes,
      from: from?.id,
      conversation: conversation?.id,
    });
    if (htmlSummary) log.debug("html attachment summary", htmlSummary);

    if (!from?.id) {
      log.debug("skipping message without from.id");
      return;
    }

    // Teams conversation.id may include ";messageid=..." suffix - strip it for session key.
    const rawConversationId = conversation?.id ?? "";
    const conversationId = normalizeMSTeamsConversationId(rawConversationId);
    const conversationMessageId =
      extractMSTeamsConversationMessageId(rawConversationId);
    const conversationType = conversation?.conversationType ?? "personal";
    const isGroupChat =
      conversationType === "groupChat" || conversation?.isGroup === true;
    const isChannel = conversationType === "channel";
    const isDirectMessage = !isGroupChat && !isChannel;

    const senderName = from.name ?? from.id;
    const senderId = from.aadObjectId ?? from.id;
    const storedAllowFrom = await readChannelAllowFromStore("msteams").catch(
      () => [],
    );

    // Check DM policy for direct messages.
    if (isDirectMessage && msteamsCfg) {
      const dmPolicy = msteamsCfg.dmPolicy ?? "pairing";
      const allowFrom = msteamsCfg.allowFrom ?? [];

      if (dmPolicy === "disabled") {
        log.debug("dropping dm (dms disabled)");
        return;
      }

      if (dmPolicy !== "open") {
        const effectiveAllowFrom = [
          ...allowFrom.map((v) => String(v).toLowerCase()),
          ...storedAllowFrom,
        ];

        const senderLower = senderId.toLowerCase();
        const senderNameLower = senderName.toLowerCase();
        const allowed =
          effectiveAllowFrom.includes("*") ||
          effectiveAllowFrom.includes(senderLower) ||
          effectiveAllowFrom.includes(senderNameLower);

        if (!allowed) {
          if (dmPolicy === "pairing") {
            const request = await upsertChannelPairingRequest({
              channel: "msteams",
              id: senderId,
              meta: { name: senderName },
            });
            if (request) {
              log.info("msteams pairing request created", {
                sender: senderId,
                label: senderName,
              });
            }
          }
          log.debug("dropping dm (not allowlisted)", {
            sender: senderId,
            label: senderName,
          });
          return;
        }
      }
    }

    if (!isDirectMessage && msteamsCfg) {
      const groupPolicy = msteamsCfg.groupPolicy ?? "allowlist";
      const groupAllowFrom =
        msteamsCfg.groupAllowFrom ??
        (msteamsCfg.allowFrom && msteamsCfg.allowFrom.length > 0
          ? msteamsCfg.allowFrom
          : []);
      const effectiveGroupAllowFrom = [
        ...groupAllowFrom.map((v) => String(v)),
        ...storedAllowFrom,
      ];

      if (groupPolicy === "disabled") {
        log.debug("dropping group message (groupPolicy: disabled)", {
          conversationId,
        });
        return;
      }

      if (groupPolicy === "allowlist") {
        if (effectiveGroupAllowFrom.length === 0) {
          log.debug(
            "dropping group message (groupPolicy: allowlist, no groupAllowFrom)",
            {
              conversationId,
            },
          );
          return;
        }
        const allowed = isMSTeamsGroupAllowed({
          groupPolicy,
          allowFrom: effectiveGroupAllowFrom,
          senderId,
          senderName,
        });
        if (!allowed) {
          log.debug("dropping group message (not in groupAllowFrom)", {
            sender: senderId,
            label: senderName,
          });
          return;
        }
      }
    }

    // Build conversation reference for proactive replies.
    const agent = activity.recipient;
    const teamId = activity.channelData?.team?.id;
    const conversationRef: StoredConversationReference = {
      activityId: activity.id,
      user: { id: from.id, name: from.name, aadObjectId: from.aadObjectId },
      agent,
      bot: agent ? { id: agent.id, name: agent.name } : undefined,
      conversation: {
        id: conversationId,
        conversationType,
        tenantId: conversation?.tenantId,
      },
      teamId,
      channelId: activity.channelId,
      serviceUrl: activity.serviceUrl,
      locale: activity.locale,
    };
    conversationStore.upsert(conversationId, conversationRef).catch((err) => {
      log.debug("failed to save conversation reference", {
        error: formatUnknownError(err),
      });
    });

    const pollVote = extractMSTeamsPollVote(activity);
    if (pollVote) {
      try {
        const poll = await pollStore.recordVote({
          pollId: pollVote.pollId,
          voterId: senderId,
          selections: pollVote.selections,
        });
        if (!poll) {
          log.debug("poll vote ignored (poll not found)", {
            pollId: pollVote.pollId,
          });
        } else {
          log.info("recorded poll vote", {
            pollId: pollVote.pollId,
            voter: senderId,
            selections: pollVote.selections,
          });
        }
      } catch (err) {
        log.error("failed to record poll vote", {
          pollId: pollVote.pollId,
          error: formatUnknownError(err),
        });
      }
      return;
    }

    if (!rawBody) {
      log.debug("skipping empty message after stripping mentions");
      return;
    }

    const teamsFrom = isDirectMessage
      ? `msteams:${senderId}`
      : isChannel
        ? `msteams:channel:${conversationId}`
        : `msteams:group:${conversationId}`;
    const teamsTo = isDirectMessage
      ? `user:${senderId}`
      : `conversation:${conversationId}`;

    const route = resolveAgentRoute({
      cfg,
      channel: "msteams",
      peer: {
        kind: isDirectMessage ? "dm" : isChannel ? "channel" : "group",
        id: isDirectMessage ? senderId : conversationId,
      },
    });

    const preview = rawBody.replace(/\s+/g, " ").slice(0, 160);
    const inboundLabel = isDirectMessage
      ? `Teams DM from ${senderName}`
      : `Teams message in ${conversationType} from ${senderName}`;

    enqueueSystemEvent(`${inboundLabel}: ${preview}`, {
      sessionKey: route.sessionKey,
      contextKey: `msteams:message:${conversationId}:${activity.id ?? "unknown"}`,
    });

    const channelId = conversationId;
    const { teamConfig, channelConfig } = resolveMSTeamsRouteConfig({
      cfg: msteamsCfg,
      teamId,
      conversationId: channelId,
    });
    const { requireMention, replyStyle } = resolveMSTeamsReplyPolicy({
      isDirectMessage,
      globalConfig: msteamsCfg,
      teamConfig,
      channelConfig,
    });

    if (!isDirectMessage) {
      const mentioned = wasMSTeamsBotMentioned(activity);
      if (requireMention && !mentioned) {
        log.debug("skipping message (mention required)", {
          teamId,
          channelId,
          requireMention,
          mentioned,
        });
        return;
      }
    }

    const timestamp = parseMSTeamsActivityTimestamp(activity.timestamp);
    const mediaList = await resolveMSTeamsInboundMedia({
      attachments,
      htmlSummary: htmlSummary ?? undefined,
      maxBytes: mediaMaxBytes,
      tokenProvider,
      allowHosts: msteamsCfg?.mediaAllowHosts,
      conversationType,
      conversationId,
      conversationMessageId: conversationMessageId ?? undefined,
      activity: {
        id: activity.id,
        replyToId: activity.replyToId,
        channelData: activity.channelData,
      },
      log,
    });

    const mediaPayload = buildMSTeamsMediaPayload(mediaList);
    const body = formatAgentEnvelope({
      channel: "Teams",
      from: senderName,
      timestamp,
      body: rawBody,
    });
    let combinedBody = body;
    const isRoomish = !isDirectMessage;
    const historyKey = isRoomish ? conversationId : undefined;
    if (isRoomish && historyKey && historyLimit > 0) {
      combinedBody = buildHistoryContextFromMap({
        historyMap: conversationHistories,
        historyKey,
        limit: historyLimit,
        entry: {
          sender: senderName,
          body: rawBody,
          timestamp: timestamp?.getTime(),
          messageId: activity.id ?? undefined,
        },
        currentMessage: combinedBody,
        formatEntry: (entry) =>
          formatAgentEnvelope({
            channel: "Teams",
            from: conversationType,
            timestamp: entry.timestamp,
            body: `${entry.sender}: ${entry.body}${entry.messageId ? ` [id:${entry.messageId}]` : ""}`,
          }),
      });
    }

    const ctxPayload = {
      Body: combinedBody,
      RawBody: rawBody,
      CommandBody: rawBody,
      From: teamsFrom,
      To: teamsTo,
      SessionKey: route.sessionKey,
      AccountId: route.accountId,
      ChatType: isDirectMessage ? "direct" : isChannel ? "room" : "group",
      GroupSubject: !isDirectMessage ? conversationType : undefined,
      SenderName: senderName,
      SenderId: senderId,
      Provider: "msteams" as const,
      Surface: "msteams" as const,
      MessageSid: activity.id,
      Timestamp: timestamp?.getTime() ?? Date.now(),
      WasMentioned: isDirectMessage || wasMSTeamsBotMentioned(activity),
      CommandAuthorized: true,
      OriginatingChannel: "msteams" as const,
      OriginatingTo: teamsTo,
      ...mediaPayload,
    };

    if (shouldLogVerbose()) {
      logVerbose(
        `msteams inbound: from=${ctxPayload.From} preview="${preview}"`,
      );
    }

    const { dispatcher, replyOptions, markDispatchIdle } =
      createMSTeamsReplyDispatcher({
        cfg,
        agentId: route.agentId,
        runtime,
        log,
        adapter,
        appId,
        conversationRef,
        context,
        replyStyle,
        textLimit,
      });

    log.info("dispatching to agent", { sessionKey: route.sessionKey });
    try {
      const { queuedFinal, counts } = await dispatchReplyFromConfig({
        ctx: ctxPayload,
        cfg,
        dispatcher,
        replyOptions,
      });

      markDispatchIdle();
      log.info("dispatch complete", { queuedFinal, counts });

      const didSendReply = counts.final + counts.tool + counts.block > 0;
      if (!queuedFinal) {
        if (isRoomish && historyKey && historyLimit > 0 && didSendReply) {
          clearHistoryEntries({
            historyMap: conversationHistories,
            historyKey,
          });
        }
        return;
      }
      if (shouldLogVerbose()) {
        const finalCount = counts.final;
        logVerbose(
          `msteams: delivered ${finalCount} reply${finalCount === 1 ? "" : "ies"} to ${teamsTo}`,
        );
      }
      if (isRoomish && historyKey && historyLimit > 0 && didSendReply) {
        clearHistoryEntries({ historyMap: conversationHistories, historyKey });
      }
    } catch (err) {
      log.error("dispatch failed", { error: String(err) });
      runtime.error?.(danger(`msteams dispatch failed: ${String(err)}`));
      try {
        await context.sendActivity(
          `⚠️ Agent failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      } catch {
        // Best effort.
      }
    }
  };
}
