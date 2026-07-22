// Msteams plugin module implements message handler behavior.
import { formatAllowlistMatchMeta } from "openclaw/plugin-sdk/allow-from";
import {
  buildChannelInboundEventContext,
  createChannelInboundEnvelopeBuilder,
  formatMediaPlaceholderText,
  logInboundDrop,
  resolveInboundMentionDecision,
  resolveInboundSupplementalSenderAllowed,
  toInboundMediaFacts,
} from "openclaw/plugin-sdk/channel-inbound";
import {
  hasFinalInboundReplyDispatch,
  resolveInboundReplyDispatchCounts,
} from "openclaw/plugin-sdk/channel-inbound";
import { bindIngressLifecycleToReplyOptions } from "openclaw/plugin-sdk/channel-outbound";
import {
  filterSupplementalContextItems,
  resolveChannelContextVisibilityMode,
} from "openclaw/plugin-sdk/context-visibility-runtime";
import {
  DEFAULT_GROUP_HISTORY_LIMIT,
  createChannelHistoryWindow,
  type HistoryEntry,
} from "openclaw/plugin-sdk/reply-history";
import { sliceUtf16Safe, truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { serializeMSTeamsAdaptiveCardActionValue } from "../adaptive-card-submit.js";
import {
  resolveMSTeamsAdvertisedMedia,
  summarizeMSTeamsHtmlAttachments,
  type MSTeamsAttachmentLike,
} from "../attachments.js";
import { extractHtmlFromAttachment } from "../attachments/shared.js";
import { tryNormalizeBotFrameworkServiceUrl } from "../bot-framework-service-url.js";
import type { StoredConversationReference } from "../conversation-store.js";
import { formatUnknownError } from "../errors.js";
import {
  fetchChannelMessage,
  fetchChatMessageText,
  fetchThreadReplies,
  formatThreadContext,
  type GraphThreadMessage,
} from "../graph-thread.js";
import {
  extractMSTeamsConversationMessageId,
  extractMSTeamsQuoteInfo,
  normalizeMSTeamsConversationId,
  parseMSTeamsActivityTimestamp,
  stripMSTeamsMentionTags,
  wasMSTeamsBotMentioned,
} from "../inbound.js";
import { createMSTeamsInboundDeadline, withMSTeamsRequestDeadline } from "../request-timeout.js";
import {
  fetchParentMessageCached,
  formatParentContextEvent,
  markParentContextInjected,
  shouldInjectParentContext,
  summarizeParentMessage,
} from "../thread-parent-context.js";

function extractTextFromHtmlAttachments(attachments: MSTeamsAttachmentLike[]): string {
  for (const attachment of attachments) {
    const raw = extractHtmlFromAttachment(attachment);
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
import type { MSTeamsIngressLifecycle } from "../msteams-ingress.js";
import { resolveMSTeamsAllowlistMatch, resolveMSTeamsReplyPolicy } from "../policy.js";
import { extractMSTeamsPollVote } from "../polls.js";
import { createMSTeamsReplyDispatcher } from "../reply-dispatcher.js";
import { getMSTeamsRuntime } from "../runtime.js";
import type { MSTeamsTurnContext } from "../sdk-types.js";
import {
  recordMSTeamsSentMessage,
  wasMSTeamsMessageSentWithPersistence,
} from "../sent-message-cache.js";
import { resolveTeamGroupId } from "../team-identity.js";
import { resolveMSTeamsSenderAccess } from "./access.js";
import {
  resolveMSTeamsInboundMedia,
  resolveMSTeamsInboundMediaBody,
  mergeMSTeamsMediaFacts,
  shouldAttemptMSTeamsGraphMediaFallback,
} from "./inbound-media.js";
import { resolveMSTeamsRouteSessionKey } from "./thread-session.js";

function formatMSTeamsSenderReason(params: {
  reasonCode: string;
  dmPolicy?: string;
  groupPolicy?: string;
}): string {
  switch (params.reasonCode) {
    case "dm_policy_open":
      return "dmPolicy=open";
    case "dm_policy_disabled":
      return "dmPolicy=disabled";
    case "dm_policy_pairing_required":
      return "dmPolicy=pairing (not allowlisted)";
    case "dm_policy_allowlisted":
      return `dmPolicy=${params.dmPolicy ?? "allowlist"} (allowlisted)`;
    case "dm_policy_not_allowlisted":
      return `dmPolicy=${params.dmPolicy ?? "allowlist"} (not allowlisted)`;
    case "group_policy_disabled":
      return "groupPolicy=disabled";
    case "group_policy_empty_allowlist":
    case "route_sender_empty":
      return "groupPolicy=allowlist (empty allowlist)";
    case "group_policy_not_allowlisted":
      return "groupPolicy=allowlist (not allowlisted)";
    case "group_policy_open":
      return "groupPolicy=open";
    case "group_policy_allowed":
      return `groupPolicy=${params.groupPolicy ?? "allowlist"}`;
    default:
      return params.reasonCode;
  }
}

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
  const serviceUrl = tryNormalizeBotFrameworkServiceUrl(activity.serviceUrl);
  return {
    activityId: activity.id,
    user: from ? { id: from.id, name: from.name, aadObjectId: from.aadObjectId } : undefined,
    agent,
    conversation: {
      id: conversationId,
      conversationType,
      tenantId,
    },
    ...(tenantId ? { tenantId } : {}),
    ...(aadObjectId ? { aadObjectId } : {}),
    teamId,
    channelId: activity.channelId,
    ...(serviceUrl ? { serviceUrl } : {}),
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
    app,
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
    turnAdoptionLifecycle?: MSTeamsIngressLifecycle;
  };

  const handleTeamsMessageNow = async (params: MSTeamsDebounceEntry) => {
    const context = params.context;
    const activity = context.activity;
    const rawText = params.rawText;
    const text = params.text;
    const attachments = params.attachments;
    const advertisedMedia = resolveMSTeamsAdvertisedMedia(attachments, {
      maxInlineBytes: mediaMaxBytes,
      maxInlineTotalBytes: mediaMaxBytes,
    });
    const rawBody = text;
    const historyBody = [text, formatMediaPlaceholderText(advertisedMedia)]
      .filter(Boolean)
      .join("\n");
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
      rawText: truncateUtf16Safe(rawText, 50),
      text: truncateUtf16Safe(text, 50),
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
    const graphChannelId = activity.channelData?.channel?.id?.trim() || conversationId;
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

    const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
      cfg,
      surface: "msteams",
    });
    const isControlCommand =
      allowTextCommands && core.channel.commands.isControlCommandMessage(text, cfg);
    const {
      dmPolicy,
      senderId,
      senderName,
      pairing,
      isDirectMessage,
      channelGate,
      senderAccess,
      commandAccess,
      allowNameMatching,
      groupPolicy,
    } = await resolveMSTeamsSenderAccess({
      cfg,
      activity,
      hasControlCommand: isControlCommand,
    });
    const commandAuthorized = commandAccess.requested ? commandAccess.authorized : undefined;
    const effectiveDmAllowFrom = senderAccess.effectiveAllowFrom;
    const effectiveGroupAllowFrom = senderAccess.effectiveGroupAllowFrom;
    const isChannel = conversationType === "channel";

    if (isDirectMessage && msteamsCfg && senderAccess.decision !== "allow") {
      if (senderAccess.reasonCode === "dm_policy_disabled") {
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
      if (senderAccess.decision === "pairing") {
        conversationStore.upsert(conversationId, conversationRef).catch((err: unknown) => {
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
        reason: formatMSTeamsSenderReason({
          reasonCode: senderAccess.reasonCode,
          dmPolicy,
          groupPolicy,
        }),
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

      if (!senderAccess.allowed && senderAccess.reasonCode === "group_policy_disabled") {
        log.info("dropping group message (groupPolicy: disabled)", {
          conversationId,
        });
        log.debug?.("dropping group message (groupPolicy: disabled)", {
          conversationId,
        });
        return;
      }
      if (
        !senderAccess.allowed &&
        (senderAccess.reasonCode === "group_policy_empty_allowlist" ||
          senderAccess.reasonCode === "route_sender_empty")
      ) {
        log.info("dropping group message (groupPolicy: allowlist, no allowlist)", {
          conversationId,
        });
        log.debug?.("dropping group message (groupPolicy: allowlist, no allowlist)", {
          conversationId,
        });
        return;
      }
      if (!senderAccess.allowed && senderAccess.reasonCode === "group_policy_not_allowlisted") {
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

    if (commandAccess.shouldBlockControlCommand) {
      logInboundDrop({
        log: logVerboseMessage,
        channel: "msteams",
        reason: "control command (unauthorized)",
        target: senderId,
      });
      return;
    }

    conversationStore.upsert(conversationId, conversationRef).catch((err: unknown) => {
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

    const mayRecoverGraphMedia =
      Boolean(htmlSummary?.attachmentIds.length) ||
      shouldAttemptMSTeamsGraphMediaFallback({
        conversationType,
        htmlSummary: htmlSummary ?? undefined,
        graphMediaFallback: msteamsCfg?.graphMediaFallback,
      });
    if (!rawBody && advertisedMedia.length === 0 && !mayRecoverGraphMedia) {
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

    const preview = sliceUtf16Safe(rawBody.replace(/\s+/g, " "), 0, 160);
    const inboundLabel = isDirectMessage
      ? `Teams DM from ${senderName}`
      : `Teams message in ${conversationType} from ${senderName}`;

    const enqueuePrimaryMessageSystemEvent = () =>
      core.system.enqueueSystemEvent(inboundLabel, {
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
        allowTextCommands,
        hasControlCommand: isControlCommand,
        commandAuthorized: commandAuthorized === true,
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
        if (historyBody) {
          enqueuePrimaryMessageSystemEvent();
          createChannelHistoryWindow({ historyMap: conversationHistories }).record({
            historyKey: conversationId,
            limit: historyLimit,
            entry: {
              sender: senderName,
              body: historyBody,
              timestamp: timestamp?.getTime(),
              messageId: activity.id ?? undefined,
            },
          });
        }
        return;
      }
    }
    const preprocessingDeadline = createMSTeamsInboundDeadline();
    let teamAadGroupId = activity.channelData?.team?.aadGroupId?.trim() || undefined;
    const conversationTeamId = isChannel ? teamId : undefined;
    let teamGroupIdPromise: Promise<string | undefined> | undefined;
    const resolveChannelTeamGroupId = async (): Promise<string | undefined> => {
      if (!conversationTeamId) {
        return undefined;
      }
      teamGroupIdPromise ??= resolveTeamGroupId({
        conversationTeamId,
        aadGroupId: teamAadGroupId,
        getTeamDetails: context.getTeamDetails,
        deadline: preprocessingDeadline,
      }).catch((err: unknown) => {
        log.debug?.("failed to resolve Teams AAD group ID", {
          teamId: conversationTeamId,
          error: formatUnknownError(err),
        });
        return undefined;
      });
      teamAadGroupId = await teamGroupIdPromise;
      return teamAadGroupId;
    };
    let mediaList = [] as Awaited<ReturnType<typeof resolveMSTeamsInboundMedia>>;
    try {
      mediaList = await withMSTeamsRequestDeadline({
        deadline: preprocessingDeadline,
        label: "MS Teams inbound media",
        work: () =>
          resolveMSTeamsInboundMedia({
            attachments,
            htmlSummary: htmlSummary ?? undefined,
            maxBytes: mediaMaxBytes,
            tokenProvider,
            allowHosts: msteamsCfg?.mediaAllowHosts,
            authAllowHosts: msteamsCfg?.mediaAuthAllowHosts,
            graphMediaFallback: msteamsCfg?.graphMediaFallback,
            conversationType,
            conversationId,
            conversationMessageId: conversationMessageId ?? undefined,
            teamAadGroupId,
            resolveTeamAadGroupId: resolveChannelTeamGroupId,
            serviceUrl: activity.serviceUrl,
            activity: {
              id: activity.id,
              replyToId: activity.replyToId,
              channelData: activity.channelData,
            },
            log,
            deadline: preprocessingDeadline,
            preserveFilenames: false,
          }),
      });
    } catch (err) {
      log.debug?.("failed to resolve inbound Teams media", {
        error: formatUnknownError(err),
      });
    }

    const inboundMedia = mergeMSTeamsMediaFacts(advertisedMedia, mediaList);
    const nativeMediaForComparison = [
      ...advertisedMedia,
      ...mediaList.slice(advertisedMedia.length).map((media) => ({
        contentType: media.contentType,
        kind: media.kind,
      })),
    ];
    const agentBody = resolveMSTeamsInboundMediaBody({
      body: rawBody,
      nativeMedia: nativeMediaForComparison,
      materializedMedia: inboundMedia,
    });
    if (!agentBody && inboundMedia.length === 0) {
      log.debug?.("skipping empty message after Graph media recovery");
      return;
    }
    enqueuePrimaryMessageSystemEvent();
    teamAadGroupId = await resolveChannelTeamGroupId();

    // Media is the primary payload, so optional quote enrichment only gets the
    // remaining preprocessing budget. DMs alone may fetch the full quote: group
    // and channel quotes retain their visibility-filtered preview.
    let quoteBodyFull: string | undefined;
    const quoteMessageId = quoteInfo?.id;
    if (quoteMessageId && isDirectMessage && conversationId.startsWith("19:")) {
      try {
        const graphToken = await withMSTeamsRequestDeadline({
          deadline: preprocessingDeadline,
          label: "MS Teams quote token",
          work: () => tokenProvider.getAccessToken("https://graph.microsoft.com"),
        });
        quoteBodyFull = await withMSTeamsRequestDeadline({
          deadline: preprocessingDeadline,
          label: "MS Teams quote lookup",
          work: () =>
            fetchChatMessageText(graphToken, conversationId, quoteMessageId, preprocessingDeadline),
        });
      } catch (err) {
        log.debug?.("failed to fetch full quoted message text", {
          error: formatUnknownError(err),
        });
      }
    }

    // Fetch thread history when the message is a reply inside a Teams channel thread.
    // This is a best-effort enhancement; errors are logged and do not block the reply.
    //
    // We also enqueue a compact `Replying to @sender: …` system event when the parent
    // is resolvable. On brand-new thread sessions (see PR #62713), this gives the agent
    // immediate parent context even before the fuller `[Thread history]` block is assembled.
    // Parent fetches are cached (5 min LRU, 100 entries) and per-session deduped so
    // consecutive replies in the same thread do not re-inject identical context.
    let threadContext: string | undefined;
    const threadParentId = activity.replyToId;
    const channelGroupId = teamAadGroupId;
    if (threadParentId && isChannel && channelGroupId) {
      try {
        const graphToken = await withMSTeamsRequestDeadline({
          deadline: preprocessingDeadline,
          label: "MS Teams thread token",
          work: () => tokenProvider.getAccessToken("https://graph.microsoft.com"),
        });
        // Use allSettled so a failure in one fetch does not discard the other.
        // For example, reply-fetch 403 should not throw away a successful parent fetch.
        const [parentResult, repliesResult] = await withMSTeamsRequestDeadline({
          deadline: preprocessingDeadline,
          label: "MS Teams thread history",
          work: () =>
            Promise.allSettled([
              fetchParentMessageCached(
                graphToken,
                channelGroupId,
                conversationId,
                threadParentId,
                (token, groupId, requestedChannelId, messageId) =>
                  fetchChannelMessage(
                    token,
                    groupId,
                    requestedChannelId,
                    messageId,
                    preprocessingDeadline,
                  ),
              ),
              fetchThreadReplies(
                graphToken,
                channelGroupId,
                conversationId,
                threadParentId,
                50,
                preprocessingDeadline,
              ),
            ]),
        });
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
          resolveInboundSupplementalSenderAllowed({
            isGroup: isChannel,
            groupPolicy,
            allowFrom: effectiveGroupAllowFrom,
            isSenderAllowed: (allowFrom) =>
              resolveMSTeamsAllowlistMatch({
                allowFrom,
                senderId: msg.from?.user?.id ?? "",
                senderName: msg.from?.user?.displayName,
                allowNameMatching,
              }).allowed,
          });
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
          shouldInjectParentContext(route.sessionKey, threadParentId)
        ) {
          core.system.enqueueSystemEvent(formatParentContextEvent(parentSummary), {
            sessionKey: route.sessionKey,
            contextKey: `msteams:thread-parent:${conversationId}:${threadParentId}`,
          });
          markParentContextInjected(route.sessionKey, threadParentId);
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
    const buildEnvelope = createChannelInboundEnvelopeBuilder({ cfg, route });
    const body = buildEnvelope({
      channel: "Teams",
      from: envelopeFrom,
      timestamp,
      body: agentBody,
    });
    let combinedBody = body;
    const isRoomish = !isDirectMessage;
    const historyKey = isRoomish ? conversationId : undefined;
    if (isRoomish && historyKey) {
      const channelHistory = createChannelHistoryWindow({ historyMap: conversationHistories });
      combinedBody = channelHistory.buildPendingContext({
        historyKey,
        limit: historyLimit,
        currentMessage: combinedBody,
        formatEntry: (entry) =>
          buildEnvelope({
            channel: "Teams",
            from: conversationType,
            timestamp: entry.timestamp,
            previousTimestamp: null,
            body: `${entry.sender}: ${entry.body}${entry.messageId ? ` [id:${entry.messageId}]` : ""}`,
          }),
      });
    }

    const inboundHistory =
      isRoomish && historyKey && historyLimit > 0
        ? createChannelHistoryWindow({ historyMap: conversationHistories }).buildInboundHistory({
            historyKey,
            limit: historyLimit,
          })
        : undefined;
    const commandBody = text.trim();
    const quoteSenderAllowed =
      quoteInfo && quoteInfo.sender
        ? resolveInboundSupplementalSenderAllowed({
            isGroup: !isDirectMessage,
            groupPolicy,
            allowFrom: effectiveGroupAllowFrom,
            isSenderAllowed: (allowFrom) =>
              resolveMSTeamsAllowlistMatch({
                allowFrom,
                senderId: quoteSenderId ?? "",
                senderName: quoteSenderName,
                allowNameMatching,
              }).allowed,
          })
        : true;
    // Prepend thread history to the agent body so the agent has full thread context.
    const bodyForAgent = threadContext
      ? `[Thread history]\n${threadContext}\n[/Thread history]\n\n${agentBody}`
      : agentBody;

    // For Teams *channel* messages (not group chats / DMs), preserve the
    // `aadGroupId/channelId` pair on NativeChannelId so downstream action handlers
    // can route through `/teams/{aadGroupId}/channels/{channelId}` via Graph API.
    // The bare conversation id (`19:...@thread.tacv2`) is insufficient on its
    // own because channel Graph endpoints require the owning team id too.
    const nativeChannelId =
      isChannel && teamAadGroupId ? `${teamAadGroupId}/${graphChannelId}` : undefined;
    const ctxPayload = buildChannelInboundEventContext({
      channel: "msteams",
      contextVisibility: contextVisibilityMode,
      supplemental: {
        quote: quoteInfo
          ? {
              id: quoteInfo.id ?? activity.replyToId ?? undefined,
              body: quoteBodyFull ?? quoteInfo.body,
              sender: quoteInfo.sender,
              senderAllowed: quoteSenderAllowed,
              isQuote: true,
            }
          : undefined,
      },
      media: toInboundMediaFacts(inboundMedia),
      messageId: activity.id,
      timestamp: timestamp?.getTime() ?? Date.now(),
      from: teamsFrom,
      sender: {
        id: senderId,
        name: senderName,
      },
      conversation: {
        kind: isDirectMessage ? "direct" : isChannel ? "channel" : "group",
        id: conversationId,
        label: envelopeFrom,
        spaceId: teamId,
        nativeChannelId,
      },
      route: {
        agentId: route.agentId,
        dmScope: route.dmScope,
        accountId: route.accountId,
        routeSessionKey: route.sessionKey,
      },
      reply: {
        to: teamsTo,
        replyToId: activity.replyToId ?? undefined,
        nativeChannelId,
      },
      message: {
        body: combinedBody,
        bodyForAgent,
        inboundHistory,
        rawBody,
        commandBody,
      },
      sessionTranscript: { historyLimit: isRoomish ? historyLimit : 0 },
      access: {
        mentions: {
          canDetectMention: !isDirectMessage,
          wasMentioned: isDirectMessage || mentionDecision.effectiveWasMentioned,
        },
        commands: {
          authorized: commandAuthorized === true,
        },
      },
      extra: {
        GroupSubject: !isDirectMessage ? conversationType : undefined,
        ReplyToIsQuote: quoteInfo ? true : undefined,
      },
    });

    logVerboseMessage(`msteams inbound: from=${ctxPayload.From} preview="${preview}"`);

    const sharePointSiteId = msteamsCfg?.sharePointSiteId;
    const { dispatcherOptions, delivery, replyOptions } = createMSTeamsReplyDispatcher({
      cfg,
      agentId: route.agentId,
      sessionKey: route.sessionKey,
      accountId: route.accountId,
      runtime,
      log,
      app,
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
    const turnConfig =
      senderTimezone && !cfg.agents?.defaults?.userTimezone
        ? {
            ...cfg,
            agents: {
              ...cfg.agents,
              defaults: { ...cfg.agents?.defaults, userTimezone: senderTimezone },
            },
          }
        : cfg;
    log.info("dispatching to agent", { sessionKey: route.sessionKey });
    try {
      const turnResult = await core.channel.inbound.run({
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
            cfg: turnConfig,
            channel: "msteams",
            accountId: route.accountId,
            route: { agentId: route.agentId, sessionKey: route.sessionKey },
            ctxPayload,
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
            dispatcherOptions,
            delivery,
            replyOptions: {
              ...replyOptions,
              ...(params.turnAdoptionLifecycle
                ? bindIngressLifecycleToReplyOptions(params.turnAdoptionLifecycle)
                : {}),
            },
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
      runtime.error(`msteams dispatch failed: ${formatUnknownError(err)}`);
      if (params.turnAdoptionLifecycle) {
        throw err;
      }
      try {
        await context.sendActivity("⚠️ Something went wrong. Please try again.");
      } catch {
        // Best effort.
      }
    }
  };

  // One debounced turn owns every constituent queue claim. Fan adoption and
  // abandonment to all of them; otherwise merged messages replay after restart.
  function buildFlushIngressLifecycle(entries: MSTeamsDebounceEntry[]): {
    lifecycle: MSTeamsIngressLifecycle | undefined;
    settle: () => Promise<void>;
  } {
    const lifecycles = entries
      .map((entry) => entry.turnAdoptionLifecycle)
      .filter((lifecycle) => lifecycle !== undefined);
    const [firstLifecycle] = lifecycles;
    if (!firstLifecycle) {
      return { lifecycle: undefined, settle: async () => {} };
    }
    let handedOff = false;
    const adoptAll = async () => {
      for (const lifecycle of lifecycles) {
        await lifecycle.onAdopted();
      }
    };
    return {
      lifecycle: {
        abortSignal:
          lifecycles.length === 1
            ? firstLifecycle.abortSignal
            : AbortSignal.any(lifecycles.map((lifecycle) => lifecycle.abortSignal)),
        onAdopted: async () => {
          handedOff = true;
          await adoptAll();
        },
        onDeferred: () => {
          handedOff = true;
          for (const lifecycle of lifecycles) {
            lifecycle.onDeferred();
          }
        },
        onAdoptionFinalizing: () => {
          for (const lifecycle of lifecycles) {
            lifecycle.onAdoptionFinalizing();
          }
        },
        onAbandoned: async () => {
          handedOff = true;
          for (const lifecycle of lifecycles) {
            await lifecycle.onAbandoned();
          }
        },
      },
      // Gated, blank, and other terminal no-dispatch turns are handled work.
      // Tombstone them instead of leaving deferred claims to stall-watchdog.
      settle: async () => {
        if (!handedOff) {
          await adoptAll();
        }
      },
    };
  }

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
      return !core.channel.commands.isControlCommandMessage(entry.text, cfg);
    },
    onFlush: async (entries) => {
      const last = entries.at(-1);
      if (!last) {
        return;
      }
      const { lifecycle, settle } = buildFlushIngressLifecycle(entries);
      try {
        if (entries.length === 1) {
          await handleTeamsMessageNow(
            lifecycle ? { ...last, turnAdoptionLifecycle: lifecycle } : last,
          );
        } else {
          const combinedText = entries
            .map((entry) => entry.text)
            .filter(Boolean)
            .join("\n");
          if (combinedText.trim()) {
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
              ...(lifecycle ? { turnAdoptionLifecycle: lifecycle } : {}),
            });
          }
        }
        await settle();
      } catch (err) {
        await lifecycle?.onAbandoned();
        throw err;
      }
    },
    onError: (err) => {
      runtime.error(`msteams debounce flush failed: ${formatUnknownError(err)}`);
    },
  });

  return async function handleTeamsMessage(
    context: MSTeamsTurnContext,
    turnAdoptionLifecycle?: MSTeamsIngressLifecycle,
  ) {
    const activity = context.activity;
    const attachments = Array.isArray(activity.attachments)
      ? (activity.attachments as unknown as MSTeamsAttachmentLike[])
      : [];
    const rawText = activity.text?.trim() ?? "";
    const htmlText = extractTextFromHtmlAttachments(attachments);
    const valueText =
      rawText || htmlText ? "" : serializeMSTeamsAdaptiveCardActionValue(activity.value);
    const text = stripMSTeamsMentionTags(rawText || htmlText || valueText || "");
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
      turnAdoptionLifecycle,
    });
    if (turnAdoptionLifecycle) {
      // Keep the durable claim held across the debounce window. The merged
      // flush completes it only when the reply lane adopts (or terminally skips).
      return { kind: "deferred" } as const;
    }
    return undefined;
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
