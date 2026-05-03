import { formatAllowlistMatchMeta } from "openclaw/plugin-sdk/allow-from";
import { resolveInboundMentionDecision } from "openclaw/plugin-sdk/channel-inbound";
import {
  logInboundDrop,
  resolveInboundSessionEnvelopeContext,
} from "openclaw/plugin-sdk/channel-inbound";
import { resolveDualTextControlCommandGate } from "openclaw/plugin-sdk/command-gating";
import {
  filterSupplementalContextItems,
  resolveChannelContextVisibilityMode,
  shouldIncludeSupplementalContext,
} from "openclaw/plugin-sdk/context-visibility-runtime";
import { evaluateSenderGroupAccessForPolicy } from "openclaw/plugin-sdk/group-access";
import {
  dispatchReplyFromConfigWithSettledDispatcher,
  hasFinalInboundReplyDispatch,
  resolveInboundReplyDispatchCounts,
} from "openclaw/plugin-sdk/inbound-reply-dispatch";
import {
  buildPendingHistoryContextFromMap,
  DEFAULT_GROUP_HISTORY_LIMIT,
  recordPendingHistoryEntryIfEnabled,
  type HistoryEntry,
} from "openclaw/plugin-sdk/reply-history";
import {
  buildMSTeamsAttachmentPlaceholder,
  buildMSTeamsMediaPayload,
  type MSTeamsAttachmentLike,
  summarizeMSTeamsHtmlAttachments,
} from "../attachments.js";
import { isRecord } from "../attachments/shared.js";
import type { StoredConversationReference } from "../conversation-store.js";
import { formatUnknownError } from "../errors.js";
import {
  fetchThreadReplies,
  formatThreadContext,
  resolveTeamGroupId,
  type GraphThreadMessage,
} from "../graph-thread.js";
import { resolveGraphChatId } from "../graph-upload.js";
import {
  extractMSTeamsConversationMessageId,
  extractMSTeamsQuoteInfo,
  normalizeMSTeamsConversationId,
  parseMSTeamsActivityTimestamp,
  stripMSTeamsMentionTags,
  translateMSTeamsDmConversationIdForGraph,
  wasMSTeamsBotMentioned,
} from "../inbound.js";
import {
  fetchParentMessageCached,
  formatParentContextEvent,
  markParentContextInjected,
  shouldInjectParentContext,
  summarizeParentMessage,
} from "../thread-parent-context.js";

function extractTextFromHtmlAttachments(attachments: MSTeamsAttachmentLike[]): string {
  for (const attachment of attachments) {
    if (attachment.contentType !== "text/html") {
      continue;
    }
    const content = attachment.content;
    const raw =
      typeof content === "string"
        ? content
        : isRecord(content) && typeof content.text === "string"
          ? content.text
          : isRecord(content) && typeof content.body === "string"
            ? content.body
            : "";
    if (!raw) {
      continue;
    }
    const text = raw
      .replace(/<at[^>]*>.*?<\/at>/gis, " ")
      .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gis, "$2 $1")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/\s+/g, " ")
      .trim();
    if (text) {
      return text;
    }
  }
  return "";
}
import type { MSTeamsMessageHandlerDeps } from "../monitor-handler.types.js";
import {
  isMSTeamsGroupAllowed,
  resolveMSTeamsAllowlistMatch,
  resolveMSTeamsReplyPolicy,
} from "../policy.js";
import { extractMSTeamsPollVote } from "../polls.js";
import { createMSTeamsReplyDispatcher } from "../reply-dispatcher.js";
import { getMSTeamsRuntime } from "../runtime.js";
import type { MSTeamsTurnContext } from "../sdk-types.js";
import {
  recordMSTeamsSentMessage,
  wasMSTeamsMessageSentWithPersistence,
} from "../sent-message-cache.js";
import { resolveMSTeamsSenderAccess } from "./access.js";
import { resolveMSTeamsInboundMedia } from "./inbound-media.js";
import { resolveMSTeamsRouteSessionKey } from "./thread-session.js";

function buildStoredConversationReference(params: {
  activity: MSTeamsTurnContext["activity"];
  conversationId: string;
  conversationType: string;
  teamId?: string;
  /** Thread root message ID for channel thread messages. */
  threadId?: string;
}): StoredConversationReference {
  const { activity, conversationId, conversationType, teamId, threadId } = params;
  const from = activity.from;
  const conversation = activity.conversation;
  const agent = activity.recipient;
  const clientInfo = activity.entities?.find((e) => e.type === "clientInfo") as
    | { timezone?: string }
    | undefined;
  // Bot Framework requires `tenantId` on outbound proactive activities so the
  // connector can route them to the correct Azure AD tenant; missing it causes
  // HTTP 403. Channel activities often leave `conversation.tenantId` unset, so
  // prefer the canonical `channelData.tenant.id` source when available.
  const channelDataTenantId = activity.channelData?.tenant?.id;
  const tenantId = channelDataTenantId ?? conversation?.tenantId;
  const aadObjectId = from?.aadObjectId;
  return {
    activityId: activity.id,
    user: from ? { id: from.id, name: from.name, aadObjectId: from.aadObjectId } : undefined,
    agent,
    bot: agent ? { id: agent.id, name: agent.name } : undefined,
    conversation: {
      id: conversationId,
      conversationType,
      tenantId,
    },
    ...(tenantId ? { tenantId } : {}),
    ...(aadObjectId ? { aadObjectId } : {}),
    teamId,
    channelId: activity.channelId,
    serviceUrl: activity.serviceUrl,
    locale: activity.locale,
    ...(clientInfo?.timezone ? { timezone: clientInfo.timezone } : {}),
    ...(threadId ? { threadId } : {}),
  };
}

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
      log.debug?.(message);
    }
  };
  const msteamsCfg = cfg.channels?.msteams;
  const contextVisibilityMode = resolveChannelContextVisibilityMode({
    cfg,
    channel: "msteams",
  });
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
    implicitMentionKinds: Array<"reply_to_bot">;
  };

  const handleTeamsMessageNow = async (params: MSTeamsDebounceEntry) => {
    const context = params.context;
    const activity = context.activity;
    const rawText = params.rawText;
    const text = params.text;
    const attachments = params.attachments;
    const attachmentPlaceholder = buildMSTeamsAttachmentPlaceholder(attachments, {
      maxInlineBytes: mediaMaxBytes,
      maxInlineTotalBytes: mediaMaxBytes,
    });
    const rawBody = text || attachmentPlaceholder;
    const quoteInfo = extractMSTeamsQuoteInfo(attachments);
    let quoteSenderId: string | undefined;
    let quoteSenderName: string | undefined;
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
    if (htmlSummary) {
      log.debug?.("html attachment summary", htmlSummary);
    }

    if (!from?.id) {
      log.debug?.("skipping message without from.id");
      return;
    }

    // Teams conversation.id may include ";messageid=..." suffix - strip it for session key.
    const rawConversationId = conversation?.id ?? "";
    const conversationId = normalizeMSTeamsConversationId(rawConversationId);
    const conversationMessageId = extractMSTeamsConversationMessageId(rawConversationId);
    const conversationType = conversation?.conversationType ?? "personal";
    const teamId = activity.channelData?.team?.id;
    // For channel thread messages, resolve the thread root message ID so outbound
    // replies land in the correct thread. The root ID comes from the `messageid=`
    // portion of conversation.id (preferred) or from activity.replyToId.
    const threadId =
      conversationType === "channel"
        ? (conversationMessageId ?? activity.replyToId ?? undefined)
        : undefined;
    const conversationRef = buildStoredConversationReference({
      activity,
      conversationId,
      conversationType,
      teamId,
      threadId,
    });

    const {
      dmPolicy,
      senderId,
      senderName,
      pairing,
      isDirectMessage,
      channelGate,
      access,
      configuredDmAllowFrom,
      effectiveDmAllowFrom,
      effectiveGroupAllowFrom,
      allowNameMatching,
      groupPolicy,
    } = await resolveMSTeamsSenderAccess({
      cfg,
      activity,
    });
    const useAccessGroups = cfg.commands?.useAccessGroups !== false;
    const isChannel = conversationType === "channel";

    if (isDirectMessage && msteamsCfg && access.decision !== "allow") {
      if (access.reason === "dmPolicy=disabled") {
        log.info("dropping dm (dms disabled)", {
          sender: senderId,
          label: senderName,
        });
        log.debug?.("dropping dm (dms disabled)");
        return;
      }
      const allowMatch = resolveMSTeamsAllowlistMatch({
        allowFrom: effectiveDmAllowFrom,
        senderId,
        senderName,
        allowNameMatching,
      });
      if (access.decision === "pairing") {
        conversationStore.upsert(conversationId, conversationRef).catch((err) => {
          log.debug?.("failed to save conversation reference", {
            error: formatUnknownError(err),
          });
        });
        const request = await pairing.upsertPairingRequest({
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
      log.debug?.("dropping dm (not allowlisted)", {
        sender: senderId,
        label: senderName,
        allowlistMatch: formatAllowlistMatchMeta(allowMatch),
      });
      log.info("dropping dm (not allowlisted)", {
        sender: senderId,
        label: senderName,
        dmPolicy,
        reason: access.reason,
        allowlistMatch: formatAllowlistMatchMeta(allowMatch),
      });
      return;
    }

    if (!isDirectMessage && msteamsCfg) {
      if (channelGate.allowlistConfigured && !channelGate.allowed) {
        log.info("dropping group message (not in team/channel allowlist)", {
          conversationId,
          teamKey: channelGate.teamKey ?? "none",
          channelKey: channelGate.channelKey ?? "none",
          channelMatchKey: channelGate.channelMatchKey ?? "none",
          channelMatchSource: channelGate.channelMatchSource ?? "none",
        });
        log.debug?.("dropping group message (not in team/channel allowlist)", {
          conversationId,
          teamKey: channelGate.teamKey ?? "none",
          channelKey: channelGate.channelKey ?? "none",
          channelMatchKey: channelGate.channelMatchKey ?? "none",
          channelMatchSource: channelGate.channelMatchSource ?? "none",
        });
        return;
      }
      const senderGroupAccess = evaluateSenderGroupAccessForPolicy({
        groupPolicy,
        groupAllowFrom: effectiveGroupAllowFrom,
        senderId,
        isSenderAllowed: (_senderId, allowFrom) =>
          resolveMSTeamsAllowlistMatch({
            allowFrom,
            senderId,
            senderName,
            allowNameMatching,
          }).allowed,
      });

      if (!senderGroupAccess.allowed && senderGroupAccess.reason === "disabled") {
        log.info("dropping group message (groupPolicy: disabled)", {
          conversationId,
        });
        log.debug?.("dropping group message (groupPolicy: disabled)", {
          conversationId,
        });
        return;
      }
      if (!senderGroupAccess.allowed && senderGroupAccess.reason === "empty_allowlist") {
        log.info("dropping group message (groupPolicy: allowlist, no allowlist)", {
          conversationId,
        });
        log.debug?.("dropping group message (groupPolicy: allowlist, no allowlist)", {
          conversationId,
        });
        return;
      }
      if (!senderGroupAccess.allowed && senderGroupAccess.reason === "sender_not_allowlisted") {
        const allowMatch = resolveMSTeamsAllowlistMatch({
          allowFrom: effectiveGroupAllowFrom,
          senderId,
          senderName,
          allowNameMatching,
        });
        log.debug?.("dropping group message (not in groupAllowFrom)", {
          sender: senderId,
          label: senderName,
          allowlistMatch: formatAllowlistMatchMeta(allowMatch),
        });
        log.info("dropping group message (not in groupAllowFrom)", {
          sender: senderId,
          label: senderName,
          allowlistMatch: formatAllowlistMatchMeta(allowMatch),
        });
        return;
      }
    }

    const commandDmAllowFrom = isDirectMessage ? effectiveDmAllowFrom : configuredDmAllowFrom;
    const ownerAllowedForCommands = isMSTeamsGroupAllowed({
      groupPolicy: "allowlist",
      allowFrom: commandDmAllowFrom,
      senderId,
      senderName,
      allowNameMatching,
    });
    const groupAllowedForCommands = isMSTeamsGroupAllowed({
      groupPolicy: "allowlist",
      allowFrom: effectiveGroupAllowFrom,
      senderId,
      senderName,
      allowNameMatching,
    });
    const { commandAuthorized, shouldBlock } = resolveDualTextControlCommandGate({
      useAccessGroups,
      primaryConfigured: commandDmAllowFrom.length > 0,
      primaryAllowed: ownerAllowedForCommands,
      secondaryConfigured: effectiveGroupAllowFrom.length > 0,
      secondaryAllowed: groupAllowedForCommands,
      hasControlCommand: core.channel.text.hasControlCommand(text, cfg),
    });
    if (shouldBlock) {
      logInboundDrop({
        log: logVerboseMessage,
        channel: "msteams",
        reason: "control command (unauthorized)",
        target: senderId,
      });
      return;
    }

    conversationStore.upsert(conversationId, conversationRef).catch((err) => {
      log.debug?.("failed to save conversation reference", {
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
          log.debug?.("poll vote ignored (poll not found)", {
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
      log.debug?.("skipping empty message after stripping mentions");
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
      teamId,
      peer: {
        kind: isDirectMessage ? "direct" : isChannel ? "channel" : "group",
        id: isDirectMessage ? senderId : conversationId,
      },
    });

    // Isolate channel thread sessions: each thread gets its own session key so
    // context does not bleed across threads. Prefer conversationMessageId (the
    // ;messageid= portion of conversation.id, i.e. the thread root) over
    // activity.replyToId (which may point to a non-root parent in deep threads).
    // DMs and group chats are unaffected — only channel thread replies fork.
    route.sessionKey = resolveMSTeamsRouteSessionKey({
      baseSessionKey: route.sessionKey,
      isChannel,
      conversationMessageId,
      replyToId: activity.replyToId,
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
    const mentionDecision = resolveInboundMentionDecision({
      facts: {
        canDetectMention: true,
        wasMentioned: params.wasMentioned,
        implicitMentionKinds: params.implicitMentionKinds,
      },
      policy: {
        isGroup: !isDirectMessage,
        requireMention,
        allowTextCommands: false,
        hasControlCommand: false,
        commandAuthorized: false,
      },
    });

    if (!isDirectMessage) {
      const mentioned = mentionDecision.effectiveWasMentioned;
      if (requireMention && mentionDecision.shouldSkip) {
        log.debug?.("skipping message (mention required)", {
          teamId,
          channelId,
          requireMention,
          mentioned,
        });
        recordPendingHistoryEntryIfEnabled({
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
        return;
      }
    }
    let graphConversationId = translateMSTeamsDmConversationIdForGraph({
      isDirectMessage,
      conversationId,
      aadObjectId: from.aadObjectId,
      appId,
    });

    // For personal DMs the Bot Framework conversation ID (`a:...`) and the
    // synthetic `19:{userId}_{appId}@unq.gbl.spaces` format produced by
    // translateMSTeamsDmConversationIdForGraph are not always accepted by the
    // Graph `/chats/{chatId}/messages` endpoint. Resolve the real Graph chat
    // ID via the API (with conversation store caching) so the Graph media
    // download fallback works when the direct Bot Framework download fails.
    if (isDirectMessage && conversationId.startsWith("a:")) {
      const cached = await conversationStore.get(conversationId);
      if (cached?.graphChatId) {
        graphConversationId = cached.graphChatId;
      } else {
        try {
          const resolved = await resolveGraphChatId({
            botFrameworkConversationId: conversationId,
            userAadObjectId: from.aadObjectId ?? undefined,
            tokenProvider,
          });
          if (resolved) {
            graphConversationId = resolved;
            conversationStore
              .upsert(conversationId, { ...conversationRef, graphChatId: resolved })
              .catch(() => {});
          }
        } catch {
          log.debug?.("failed to resolve Graph chat ID for inbound media", { conversationId });
        }
      }
    }

    const mediaList = await resolveMSTeamsInboundMedia({
      attachments,
      htmlSummary: htmlSummary ?? undefined,
      maxBytes: mediaMaxBytes,
      tokenProvider,
      allowHosts: msteamsCfg?.mediaAllowHosts,
      authAllowHosts: msteamsCfg?.mediaAuthAllowHosts,
      conversationType,
      conversationId: graphConversationId,
      conversationMessageId: conversationMessageId ?? undefined,
      serviceUrl: activity.serviceUrl,
      activity: {
        id: activity.id,
        replyToId: activity.replyToId,
        channelData: activity.channelData,
      },
      log,
      preserveFilenames: (cfg as { media?: { preserveFilenames?: boolean } }).media
        ?.preserveFilenames,
    });

    const mediaPayload = buildMSTeamsMediaPayload(mediaList);

    // Fetch thread history when the message is a reply inside a Teams channel thread.
    // This is a best-effort enhancement; errors are logged and do not block the reply.
    //
    // We also enqueue a compact `Replying to @sender: …` system event when the parent
    // is resolvable. On brand-new thread sessions (see PR #62713), this gives the agent
    // immediate parent context even before the fuller `[Thread history]` block is assembled.
    // Parent fetches are cached (5 min LRU, 100 entries) and per-session deduped so
    // consecutive replies in the same thread do not re-inject identical context.
    let threadContext: string | undefined;
    if (activity.replyToId && isChannel && teamId) {
      try {
        const graphToken = await tokenProvider.getAccessToken("https://graph.microsoft.com");
        const groupId = await resolveTeamGroupId(graphToken, teamId);
        // Use allSettled so a failure in one fetch does not discard the other.
        // For example, reply-fetch 403 should not throw away a successful parent fetch.
        const [parentResult, repliesResult] = await Promise.allSettled([
          fetchParentMessageCached(graphToken, groupId, conversationId, activity.replyToId),
          fetchThreadReplies(graphToken, groupId, conversationId, activity.replyToId),
        ]);
        const parentMsg = parentResult.status === "fulfilled" ? parentResult.value : undefined;
        const replies = repliesResult.status === "fulfilled" ? repliesResult.value : [];
        if (parentResult.status === "rejected") {
          log.debug?.("failed to fetch parent message", {
            error: formatUnknownError(parentResult.reason),
          });
        }
        if (repliesResult.status === "rejected") {
          log.debug?.("failed to fetch thread replies", {
            error: formatUnknownError(repliesResult.reason),
          });
        }
        const isThreadSenderAllowed = (msg: GraphThreadMessage) =>
          groupPolicy === "allowlist"
            ? resolveMSTeamsAllowlistMatch({
                allowFrom: effectiveGroupAllowFrom,
                senderId: msg.from?.user?.id ?? "",
                senderName: msg.from?.user?.displayName,
                allowNameMatching,
              }).allowed
            : true;
        const parentSummary = summarizeParentMessage(parentMsg);
        const visibleParentMessages = parentMsg
          ? filterSupplementalContextItems({
              items: [parentMsg],
              mode: contextVisibilityMode,
              kind: "thread",
              isSenderAllowed: isThreadSenderAllowed,
            }).items
          : [];
        if (
          parentSummary &&
          visibleParentMessages.length > 0 &&
          shouldInjectParentContext(route.sessionKey, activity.replyToId)
        ) {
          core.system.enqueueSystemEvent(formatParentContextEvent(parentSummary), {
            sessionKey: route.sessionKey,
            contextKey: `msteams:thread-parent:${conversationId}:${activity.replyToId}`,
          });
          markParentContextInjected(route.sessionKey, activity.replyToId);
        }
        const allMessages = parentMsg ? [parentMsg, ...replies] : replies;
        quoteSenderId = parentMsg?.from?.user?.id ?? parentMsg?.from?.application?.id ?? undefined;
        quoteSenderName =
          parentMsg?.from?.user?.displayName ??
          parentMsg?.from?.application?.displayName ??
          quoteInfo?.sender;
        const { items: threadMessages } = filterSupplementalContextItems({
          items: allMessages,
          mode: contextVisibilityMode,
          kind: "thread",
          isSenderAllowed: isThreadSenderAllowed,
        });
        const formatted = formatThreadContext(threadMessages, activity.id);
        if (formatted) {
          threadContext = formatted;
        }
      } catch (err) {
        log.debug?.("failed to fetch thread history", { error: formatUnknownError(err) });
        // Graceful degradation: thread history is an optional enhancement.
      }
    }
    quoteSenderName ??= quoteInfo?.sender;

    const envelopeFrom = isDirectMessage ? senderName : conversationType;
    const { storePath, envelopeOptions, previousTimestamp } = resolveInboundSessionEnvelopeContext({
      cfg,
      agentId: route.agentId,
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
    if (isRoomish && historyKey) {
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

    const inboundHistory =
      isRoomish && historyKey && historyLimit > 0
        ? (conversationHistories.get(historyKey) ?? []).map((entry) => ({
            sender: entry.sender,
            body: entry.body,
            timestamp: entry.timestamp,
          }))
        : undefined;
    const commandBody = text.trim();
    const quoteSenderAllowed =
      quoteInfo && quoteInfo.sender
        ? !isChannel || groupPolicy !== "allowlist"
          ? true
          : resolveMSTeamsAllowlistMatch({
              allowFrom: effectiveGroupAllowFrom,
              senderId: quoteSenderId ?? "",
              senderName: quoteSenderName,
              allowNameMatching,
            }).allowed
        : true;
    const includeQuoteContext =
      quoteInfo &&
      shouldIncludeSupplementalContext({
        mode: contextVisibilityMode,
        kind: "quote",
        senderAllowed: quoteSenderAllowed,
      });

    // Prepend thread history to the agent body so the agent has full thread context.
    const bodyForAgent = threadContext
      ? `[Thread history]\n${threadContext}\n[/Thread history]\n\n${rawBody}`
      : rawBody;

    // For Teams *channel* messages (not group chats / DMs), preserve the
    // `teamId/channelId` pair on NativeChannelId so downstream action handlers
    // can route through `/teams/{teamId}/channels/{channelId}` via Graph API.
    // The bare conversation id (`19:...@thread.tacv2`) is insufficient on its
    // own because channel Graph endpoints require the owning team id too.
    const nativeChannelId = isChannel && teamId ? `${teamId}/${conversationId}` : undefined;

    const ctxPayload = core.channel.reply.finalizeInboundContext({
      Body: combinedBody,
      BodyForAgent: bodyForAgent,
      InboundHistory: inboundHistory,
      RawBody: rawBody,
      CommandBody: commandBody,
      BodyForCommands: commandBody,
      From: teamsFrom,
      To: teamsTo,
      SessionKey: route.sessionKey,
      AccountId: route.accountId,
      ChatType: isDirectMessage ? "direct" : isChannel ? "channel" : "group",
      ConversationLabel: envelopeFrom,
      GroupSubject: !isDirectMessage ? conversationType : undefined,
      GroupSpace: teamId,
      SenderName: senderName,
      SenderId: senderId,
      Provider: "msteams" as const,
      Surface: "msteams" as const,
      MessageSid: activity.id,
      Timestamp: timestamp?.getTime() ?? Date.now(),
      WasMentioned: isDirectMessage || mentionDecision.effectiveWasMentioned,
      CommandAuthorized: commandAuthorized,
      OriginatingChannel: "msteams" as const,
      OriginatingTo: teamsTo,
      NativeChannelId: nativeChannelId,
      ReplyToId: activity.replyToId ?? undefined,
      ReplyToBody: includeQuoteContext ? quoteInfo?.body : undefined,
      ReplyToSender: includeQuoteContext ? quoteInfo?.sender : undefined,
      ReplyToIsQuote: quoteInfo ? true : undefined,
      ...mediaPayload,
    });

    logVerboseMessage(`msteams inbound: from=${ctxPayload.From} preview="${preview}"`);

    const sharePointSiteId = msteamsCfg?.sharePointSiteId;
    const { dispatcher, replyOptions, markDispatchIdle } = createMSTeamsReplyDispatcher({
      cfg,
      agentId: route.agentId,
      sessionKey: route.sessionKey,
      accountId: route.accountId,
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

    // Use Teams clientInfo timezone if no explicit userTimezone is configured.
    // This ensures the agent knows the sender's timezone for time-aware responses
    // and proactive sends within the same session.
    const activityClientInfo = activity.entities?.find((e) => e.type === "clientInfo") as
      | { timezone?: string }
      | undefined;
    const senderTimezone = activityClientInfo?.timezone || conversationRef.timezone;
    const configOverride =
      senderTimezone && !cfg.agents?.defaults?.userTimezone
        ? {
            agents: {
              defaults: { ...cfg.agents?.defaults, userTimezone: senderTimezone },
            },
          }
        : undefined;

    log.info("dispatching to agent", { sessionKey: route.sessionKey });
    try {
      const turnResult = await core.channel.turn.run({
        channel: "msteams",
        accountId: route.accountId,
        raw: context,
        adapter: {
          ingest: () => ({
            id: activity.id ?? `${teamsFrom}:${Date.now()}`,
            timestamp: timestamp?.getTime(),
            rawText: rawBody,
            textForAgent: bodyForAgent,
            textForCommands: commandBody,
            raw: activity,
          }),
          resolveTurn: () => ({
            channel: "msteams",
            accountId: route.accountId,
            routeSessionKey: route.sessionKey,
            storePath,
            ctxPayload,
            recordInboundSession: core.channel.session.recordInboundSession,
            record: {
              onRecordError: (err) => {
                logVerboseMessage(
                  `msteams: failed updating session meta: ${formatUnknownError(err)}`,
                );
              },
            },
            history: {
              isGroup: isRoomish,
              historyKey,
              historyMap: conversationHistories,
              limit: historyLimit,
            },
            onPreDispatchFailure: () =>
              core.channel.reply.settleReplyDispatcher({
                dispatcher,
                onSettled: () => markDispatchIdle(),
              }),
            runDispatch: () =>
              dispatchReplyFromConfigWithSettledDispatcher({
                cfg,
                ctxPayload,
                dispatcher,
                onSettled: () => markDispatchIdle(),
                replyOptions,
                configOverride,
              }),
          }),
        },
      });
      const dispatchResult = turnResult.dispatched ? turnResult.dispatchResult : undefined;
      const queuedFinal = dispatchResult?.queuedFinal ?? false;
      const counts = resolveInboundReplyDispatchCounts(dispatchResult);
      const hasFinalResponse = hasFinalInboundReplyDispatch(dispatchResult);

      log.info("dispatch complete", { queuedFinal, counts });

      if (!hasFinalResponse) {
        return;
      }
      const finalCount = counts.final;
      logVerboseMessage(
        `msteams: delivered ${finalCount} reply${finalCount === 1 ? "" : "ies"} to ${teamsTo}`,
      );
    } catch (err) {
      log.error("dispatch failed", { error: formatUnknownError(err) });
      runtime.error?.(`msteams dispatch failed: ${formatUnknownError(err)}`);
      try {
        await context.sendActivity("⚠️ Something went wrong. Please try again.");
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
      if (!senderId || !conversationId) {
        return null;
      }
      return `msteams:${appId}:${conversationId}:${senderId}`;
    },
    shouldDebounce: (entry) => {
      if (!entry.text.trim()) {
        return false;
      }
      if (entry.attachments.length > 0) {
        return false;
      }
      return !core.channel.text.hasControlCommand(entry.text, cfg);
    },
    onFlush: async (entries) => {
      const last = entries.at(-1);
      if (!last) {
        return;
      }
      if (entries.length === 1) {
        await handleTeamsMessageNow(last);
        return;
      }
      const combinedText = entries
        .map((entry) => entry.text)
        .filter(Boolean)
        .join("\n");
      if (!combinedText.trim()) {
        return;
      }
      const combinedRawText = entries
        .map((entry) => entry.rawText)
        .filter(Boolean)
        .join("\n");
      const wasMentioned = entries.some((entry) => entry.wasMentioned);
      const implicitMentionKinds = entries.flatMap((entry) => entry.implicitMentionKinds);
      await handleTeamsMessageNow({
        context: last.context,
        rawText: combinedRawText,
        text: combinedText,
        attachments: [],
        wasMentioned,
        implicitMentionKinds,
      });
    },
    onError: (err) => {
      runtime.error?.(`msteams debounce flush failed: ${formatUnknownError(err)}`);
    },
  });

  return async function handleTeamsMessage(context: MSTeamsTurnContext) {
    const activity = context.activity;
    const attachments = Array.isArray(activity.attachments)
      ? (activity.attachments as unknown as MSTeamsAttachmentLike[])
      : [];
    const rawText = activity.text?.trim() ?? "";
    const htmlText = extractTextFromHtmlAttachments(attachments);
    const text = stripMSTeamsMentionTags(rawText || htmlText);
    const wasMentioned = wasMSTeamsBotMentioned(activity);
    const conversationId = normalizeMSTeamsConversationId(activity.conversation?.id ?? "");
    const replyToId = activity.replyToId ?? undefined;
    const implicitMentionKinds: Array<"reply_to_bot"> =
      conversationId &&
      replyToId &&
      (await wasMSTeamsMessageSentWithPersistence({ conversationId, messageId: replyToId }))
        ? ["reply_to_bot"]
        : [];

    await inboundDebouncer.enqueue({
      context,
      rawText,
      text,
      attachments,
      wasMentioned,
      implicitMentionKinds,
    });
  };
}
