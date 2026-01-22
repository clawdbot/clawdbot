import {
  buildPendingHistoryContextFromMap,
  clearHistoryEntries,
  DEFAULT_GROUP_HISTORY_LIMIT,
  recordPendingHistoryEntry,
  resolveMentionGating,
  formatAllowlistMatchMeta,
  type HistoryEntry,
} from "clawdbot/plugin-sdk";

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
  resolveMSTeamsAllowlistMatch,
  resolveMSTeamsReplyPolicy,
  resolveMSTeamsRouteConfig,
} from "../policy.js";
import { extractMSTeamsPollVote } from "../polls.js";
import { createMSTeamsReplyDispatcher } from "../reply-dispatcher.js";
import { recordMSTeamsSentMessage, wasMSTeamsMessageSent } from "../sent-message-cache.js";
import type { MSTeamsTurnContext } from "../sdk-types.js";
import { resolveMSTeamsInboundMedia } from "./inbound-media.js";
import { getMSTeamsRuntime } from "../runtime.js";

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
  const core = getMSTeamsRuntime();
  const logVerboseMessage = (message: string) => {
    if (core.logging.shouldLogVerbose()) {
      log.debug(message);
    }
  };
  const msteamsCfg = cfg.channels?.msteams;
  const historyLimit = Math.max(
    0,
    msteamsCfg?.historyLimit ??
      cfg.messages?.groupChat?.historyLimit ??
      DEFAULT_GROUP_HISTORY_LIMIT,
  );
  const conversationHistories = new Map<string, HistoryEntry[]>();
  const inboundDebounceMs = core.channel.debounce.resolveInboundDebounceMs({
    cfg,
    channel: "msteams",
  });

  type MSTeamsDebounceEntry = {
    context: MSTeamsTurnContext;
    rawText: string;
    text: string;
    attachments: MSTeamsAttachmentLike[];
    wasMentioned: boolean;
    implicitMention: boolean;
  };

  const handleTeamsMessageNow = async (params: MSTeamsDebounceEntry) => {
    const context = params.context;
    const activity = context.activity;
    const rawText = params.rawText;
    const text = params.text;
    const attachments = params.attachments;
    const attachmentPlaceholder = buildMSTeamsAttachmentPlaceholder(attachments);
    const rawBody = text || attachmentPlaceholder;
    const from = activity.from;
    const conversation = activity.conversation;

    const attachmentTypes = attachments
      .map((att) => (typeof att.contentType === "string" ? att.contentType : undefined))
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
    const conversationMessageId = extractMSTeamsConversationMessageId(rawConversationId);
    const conversationType = conversation?.conversationType ?? "personal";
    const isGroupChat = conversationType === "groupChat" || conversation?.isGroup === true;
    const isChannel = conversationType === "channel";
    const isDirectMessage = !isGroupChat && !isChannel;

    const senderName = from.name ?? from.id;
    const senderId = from.aadObjectId ?? from.id;
    const storedAllowFrom = await core.channel.pairing
      .readAllowFromStore("msteams")
      .catch(() => []);
    const useAccessGroups = cfg.commands?.useAccessGroups !== false;

    // Check DM policy for direct messages.
    const dmAllowFrom = msteamsCfg?.allowFrom ?? [];
    const effectiveDmAllowFrom = [...dmAllowFrom.map((v) => String(v)), ...storedAllowFrom];
    if (isDirectMessage && msteamsCfg) {
      const dmPolicy = msteamsCfg.dmPolicy ?? "pairing";
      const allowFrom = dmAllowFrom;

      if (dmPolicy === "disabled") {
        log.debug("dropping dm (dms disabled)");
        return;
      }

      if (dmPolicy !== "open") {
        const effectiveAllowFrom = [...allowFrom.map((v) => String(v)), ...storedAllowFrom];
        const allowMatch = resolveMSTeamsAllowlistMatch({
          allowFrom: effectiveAllowFrom,
          senderId,
          senderName,
        });

        if (!allowMatch.allowed) {
          if (dmPolicy === "pairing") {
            const request = await core.channel.pairing.upsertPairingRequest({
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
            allowlistMatch: formatAllowlistMatchMeta(allowMatch),
          });
          return;
        }
      }
    }

    const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
    const groupPolicy =
      !isDirectMessage && msteamsCfg
        ? (msteamsCfg.groupPolicy ?? defaultGroupPolicy ?? "allowlist")
        : "disabled";
    const groupAllowFrom =
      !isDirectMessage && msteamsCfg
        ? (msteamsCfg.groupAllowFrom ??
          (msteamsCfg.allowFrom && msteamsCfg.allowFrom.length > 0 ? msteamsCfg.allowFrom : []))
        : [];
    const effectiveGroupAllowFrom =
      !isDirectMessage && msteamsCfg
        ? [...groupAllowFrom.map((v) => String(v)), ...storedAllowFrom]
        : [];
    const teamId = activity.channelData?.team?.id;
    const teamName = activity.channelData?.team?.name;
    const channelName = activity.channelData?.channel?.name;
    const channelGate = resolveMSTeamsRouteConfig({
      cfg: msteamsCfg,
      teamId,
      teamName,
      conversationId,
      channelName,
    });

    if (!isDirectMessage && msteamsCfg) {
      if (groupPolicy === "disabled") {
        log.debug("dropping group message (groupPolicy: disabled)", {
          conversationId,
        });
        return;
      }

      if (groupPolicy === "allowlist") {
        if (channelGate.allowlistConfigured && !channelGate.allowed) {
          log.debug("dropping group message (not in team/channel allowlist)", {
            conversationId,
            teamKey: channelGate.teamKey ?? "none",
            channelKey: channelGate.channelKey ?? "none",
            channelMatchKey: channelGate.channelMatchKey ?? "none",
            channelMatchSource: channelGate.channelMatchSource ?? "none",
          });
          return;
        }
        if (effectiveGroupAllowFrom.length === 0 && !channelGate.allowlistConfigured) {
          log.debug("dropping group message (groupPolicy: allowlist, no allowlist)", {
            conversationId,
          });
          return;
        }
        if (effectiveGroupAllowFrom.length > 0) {
          const allowMatch = resolveMSTeamsAllowlistMatch({
            groupPolicy,
            allowFrom: effectiveGroupAllowFrom,
            senderId,
            senderName,
          });
          if (!allowMatch.allowed) {
            log.debug("dropping group message (not in groupAllowFrom)", {
              sender: senderId,
              label: senderName,
              allowlistMatch: formatAllowlistMatchMeta(allowMatch),
            });
            return;
          }
        }
      }
    }

    const ownerAllowedForCommands = isMSTeamsGroupAllowed({
      groupPolicy: "allowlist",
      allowFrom: effectiveDmAllowFrom,
      senderId,
      senderName,
    });
    const groupAllowedForCommands = isMSTeamsGroupAllowed({
      groupPolicy: "allowlist",
      allowFrom: effectiveGroupAllowFrom,
      senderId,
      senderName,
    });
    const commandAuthorized = core.channel.commands.resolveCommandAuthorizedFromAuthorizers({
      useAccessGroups,
      authorizers: [
        { configured: effectiveDmAllowFrom.length > 0, allowed: ownerAllowedForCommands },
        { configured: effectiveGroupAllowFrom.length > 0, allowed: groupAllowedForCommands },
      ],
    });
    if (core.channel.text.hasControlCommand(text, cfg) && !commandAuthorized) {
      logVerboseMessage(`msteams: drop control command from unauthorized sender ${senderId}`);
      return;
    }

    // Build conversation reference for proactive replies.
    const agent = activity.recipient;
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
    const teamsTo = isDirectMessage ? `user:${senderId}` : `conversation:${conversationId}`;

    const route = core.channel.routing.resolveAgentRoute({
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

    core.system.enqueueSystemEvent(`${inboundLabel}: ${preview}`, {
      sessionKey: route.sessionKey,
      contextKey: `msteams:message:${conversationId}:${activity.id ?? "unknown"}`,
    });

    const channelId = conversationId;
    const { teamConfig, channelConfig } = channelGate;
    const { requireMention, replyStyle } = resolveMSTeamsReplyPolicy({
      isDirectMessage,
      globalConfig: msteamsCfg,
      teamConfig,
      channelConfig,
    });
    const timestamp = parseMSTeamsActivityTimestamp(activity.timestamp);

    if (!isDirectMessage) {
      const mentionGate = resolveMentionGating({
        requireMention: Boolean(requireMention),
        canDetectMention: true,
        wasMentioned: params.wasMentioned,
        implicitMention: params.implicitMention,
        shouldBypassMention: false,
      });
      const mentioned = mentionGate.effectiveWasMentioned;
      if (requireMention && mentionGate.shouldSkip) {
        log.debug("skipping message (mention required)", {
          teamId,
          channelId,
          requireMention,
          mentioned,
        });
        if (historyLimit > 0) {
          recordPendingHistoryEntry({
            historyMap: conversationHistories,
            historyKey: conversationId,
            limit: historyLimit,
            entry: {
              sender: senderName,
              body: rawBody,
              timestamp: timestamp?.getTime(),
              messageId: activity.id ?? undefined,
            },
          });
        }
        return;
      }
    }
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
      preserveFilenames: cfg.media?.preserveFilenames,
    });

	    const mediaPayload = buildMSTeamsMediaPayload(mediaList);
	    const envelopeFrom = isDirectMessage ? senderName : conversationType;
	    const storePath = core.channel.session.resolveStorePath(cfg.session?.store, {
	      agentId: route.agentId,
	    });
	    const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(cfg);
	    const previousTimestamp = core.channel.session.readSessionUpdatedAt({
	      storePath,
	      sessionKey: route.sessionKey,
	    });
	    const body = core.channel.reply.formatAgentEnvelope({
	      channel: "Teams",
	      from: envelopeFrom,
	      timestamp,
	      previousTimestamp,
	      envelope: envelopeOptions,
	      body: rawBody,
	    });
    let combinedBody = body;
    const isRoomish = !isDirectMessage;
    const historyKey = isRoomish ? conversationId : undefined;
    if (isRoomish && historyKey && historyLimit > 0) {
      combinedBody = buildPendingHistoryContextFromMap({
        historyMap: conversationHistories,
        historyKey,
        limit: historyLimit,
        currentMessage: combinedBody,
	        formatEntry: (entry) =>
	          core.channel.reply.formatAgentEnvelope({
	            channel: "Teams",
	            from: conversationType,
	            timestamp: entry.timestamp,
	            body: `${entry.sender}: ${entry.body}${entry.messageId ? ` [id:${entry.messageId}]` : ""}`,
	            envelope: envelopeOptions,
	          }),
	      });
	    }

	    const ctxPayload = core.channel.reply.finalizeInboundContext({
	      Body: combinedBody,
	      RawBody: rawBody,
	      CommandBody: rawBody,
	      From: teamsFrom,
	      To: teamsTo,
	      SessionKey: route.sessionKey,
	      AccountId: route.accountId,
      ChatType: isDirectMessage ? "direct" : isChannel ? "channel" : "group",
      ConversationLabel: envelopeFrom,
      GroupSubject: !isDirectMessage ? conversationType : undefined,
      SenderName: senderName,
      SenderId: senderId,
      Provider: "msteams" as const,
      Surface: "msteams" as const,
      MessageSid: activity.id,
      Timestamp: timestamp?.getTime() ?? Date.now(),
	      WasMentioned: isDirectMessage || params.wasMentioned || params.implicitMention,
	      CommandAuthorized: commandAuthorized,
	      OriginatingChannel: "msteams" as const,
	      OriginatingTo: teamsTo,
	      ...mediaPayload,
	    });

	    void core.channel.session.recordSessionMetaFromInbound({
	      storePath,
      sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
      ctx: ctxPayload,
    }).catch((err) => {
      logVerboseMessage(`msteams: failed updating session meta: ${String(err)}`);
    });

    logVerboseMessage(`msteams inbound: from=${ctxPayload.From} preview="${preview}"`);

    const sharePointSiteId = msteamsCfg?.sharePointSiteId;
    const { dispatcher, replyOptions, markDispatchIdle } = createMSTeamsReplyDispatcher({
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
      onSentMessageIds: (ids) => {
        for (const id of ids) {
          recordMSTeamsSentMessage(conversationId, id);
        }
      },
      tokenProvider,
      sharePointSiteId,
    });

    log.info("dispatching to agent", { sessionKey: route.sessionKey });
    try {
      const { queuedFinal, counts } = await core.channel.reply.dispatchReplyFromConfig({
        ctx: ctxPayload,
        cfg,
        dispatcher,
        replyOptions,
      });

      markDispatchIdle();
      log.info("dispatch complete", { queuedFinal, counts });

      const didSendReply = counts.final + counts.tool + counts.block > 0;
      if (!queuedFinal) {
        if (isRoomish && historyKey && historyLimit > 0) {
          clearHistoryEntries({
            historyMap: conversationHistories,
            historyKey,
          });
        }
        return;
      }
      const finalCount = counts.final;
      logVerboseMessage(
        `msteams: delivered ${finalCount} reply${finalCount === 1 ? "" : "ies"} to ${teamsTo}`,
      );
      if (isRoomish && historyKey && historyLimit > 0) {
        clearHistoryEntries({ historyMap: conversationHistories, historyKey });
      }
    } catch (err) {
      log.error("dispatch failed", { error: String(err) });
      runtime.error?.(`msteams dispatch failed: ${String(err)}`);
      try {
        await context.sendActivity(
          `⚠️ Agent failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      } catch {
        // Best effort.
      }
    }
  };

  const inboundDebouncer = core.channel.debounce.createInboundDebouncer<MSTeamsDebounceEntry>({
    debounceMs: inboundDebounceMs,
    buildKey: (entry) => {
      const conversationId = normalizeMSTeamsConversationId(
        entry.context.activity.conversation?.id ?? "",
      );
      const senderId =
        entry.context.activity.from?.aadObjectId ?? entry.context.activity.from?.id ?? "";
      if (!senderId || !conversationId) return null;
      return `msteams:${appId}:${conversationId}:${senderId}`;
    },
    shouldDebounce: (entry) => {
      if (!entry.text.trim()) return false;
      if (entry.attachments.length > 0) return false;
      return !core.channel.text.hasControlCommand(entry.text, cfg);
    },
    onFlush: async (entries) => {
      const last = entries.at(-1);
      if (!last) return;
      if (entries.length === 1) {
        await handleTeamsMessageNow(last);
        return;
      }
      const combinedText = entries
        .map((entry) => entry.text)
        .filter(Boolean)
        .join("\n");
      if (!combinedText.trim()) return;
      const combinedRawText = entries
        .map((entry) => entry.rawText)
        .filter(Boolean)
        .join("\n");
      const wasMentioned = entries.some((entry) => entry.wasMentioned);
      const implicitMention = entries.some((entry) => entry.implicitMention);
      await handleTeamsMessageNow({
        context: last.context,
        rawText: combinedRawText,
        text: combinedText,
        attachments: [],
        wasMentioned,
        implicitMention,
      });
    },
    onError: (err) => {
      runtime.error?.(`msteams debounce flush failed: ${String(err)}`);
    },
  });

  return async function handleTeamsMessage(context: MSTeamsTurnContext) {
    const activity = context.activity;
    const rawText = activity.text?.trim() ?? "";
    const text = stripMSTeamsMentionTags(rawText);
    const attachments = Array.isArray(activity.attachments)
      ? (activity.attachments as unknown as MSTeamsAttachmentLike[])
      : [];
    const wasMentioned = wasMSTeamsBotMentioned(activity);
    const conversationId = normalizeMSTeamsConversationId(activity.conversation?.id ?? "");
    const replyToId = activity.replyToId ?? undefined;
    const implicitMention = Boolean(
      conversationId && replyToId && wasMSTeamsMessageSent(conversationId, replyToId),
    );

    await inboundDebouncer.enqueue({
      context,
      rawText,
      text,
      attachments,
      wasMentioned,
      implicitMention,
    });
  };
}
