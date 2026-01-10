import { formatAgentEnvelope } from "../auto-reply/envelope.js";
import { dispatchReplyFromConfig } from "../auto-reply/reply/dispatch-from-config.js";
import {
  buildHistoryContextFromMap,
  clearHistoryEntries,
  DEFAULT_GROUP_HISTORY_LIMIT,
  type HistoryEntry,
} from "../auto-reply/reply/history.js";
import type { ClawdbotConfig } from "../config/types.js";
import { danger, logVerbose, shouldLogVerbose } from "../globals.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import {
  readProviderAllowFromStore,
  upsertProviderPairingRequest,
} from "../pairing/pairing-store.js";
import { resolveAgentRoute } from "../routing/resolve-route.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  buildMSTeamsAttachmentPlaceholder,
  buildMSTeamsGraphMessageUrls,
  buildMSTeamsMediaPayload,
  downloadMSTeamsGraphMedia,
  downloadMSTeamsImageAttachments,
  type MSTeamsAttachmentLike,
  summarizeMSTeamsHtmlAttachments,
} from "./attachments.js";
import type {
  MSTeamsConversationStore,
  StoredConversationReference,
} from "./conversation-store.js";
import { formatUnknownError } from "./errors.js";
import {
  extractMSTeamsConversationMessageId,
  normalizeMSTeamsConversationId,
  parseMSTeamsActivityTimestamp,
  stripMSTeamsMentionTags,
  wasMSTeamsBotMentioned,
} from "./inbound.js";
import type { MSTeamsAdapter } from "./messenger.js";
import type { MSTeamsMonitorLogger } from "./monitor-types.js";
import {
  resolveMSTeamsReplyPolicy,
  resolveMSTeamsRouteConfig,
} from "./policy.js";
import { extractMSTeamsPollVote, type MSTeamsPollStore } from "./polls.js";
import { createMSTeamsReplyDispatcher } from "./reply-dispatcher.js";
import type { MSTeamsTurnContext } from "./sdk-types.js";

export type MSTeamsAccessTokenProvider = {
  getAccessToken: (scope: string) => Promise<string>;
};

export type MSTeamsActivityHandler = {
  onMessage: (
    handler: (context: unknown, next: () => Promise<void>) => Promise<void>,
  ) => MSTeamsActivityHandler;
  onMembersAdded: (
    handler: (context: unknown, next: () => Promise<void>) => Promise<void>,
  ) => MSTeamsActivityHandler;
};

export type MSTeamsMessageHandlerDeps = {
  cfg: ClawdbotConfig;
  runtime: RuntimeEnv;
  appId: string;
  adapter: MSTeamsAdapter;
  tokenProvider: MSTeamsAccessTokenProvider;
  textLimit: number;
  mediaMaxBytes: number;
  conversationStore: MSTeamsConversationStore;
  pollStore: MSTeamsPollStore;
  log: MSTeamsMonitorLogger;
};

export function registerMSTeamsHandlers<T extends MSTeamsActivityHandler>(
  handler: T,
  deps: MSTeamsMessageHandlerDeps,
): T {
  const handleTeamsMessage = createMSTeamsMessageHandler(deps);
  handler.onMessage(async (context, next) => {
    try {
      await handleTeamsMessage(context as MSTeamsTurnContext);
    } catch (err) {
      deps.runtime.error?.(danger(`msteams handler failed: ${String(err)}`));
    }
    await next();
  });

  handler.onMembersAdded(async (context, next) => {
    const membersAdded =
      (context as MSTeamsTurnContext).activity?.membersAdded ?? [];
    for (const member of membersAdded) {
      if (
        member.id !== (context as MSTeamsTurnContext).activity?.recipient?.id
      ) {
        deps.log.debug("member added", { member: member.id });
        // Don't send welcome message - let the user initiate conversation.
      }
    }
    await next();
  });

  return handler;
}

function createMSTeamsMessageHandler(deps: MSTeamsMessageHandlerDeps) {
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
  const msteamsCfg = cfg.msteams;
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
    if (htmlSummary) {
      log.debug("html attachment summary", htmlSummary);
    }

    if (!from?.id) {
      log.debug("skipping message without from.id");
      return;
    }

    // Teams conversation.id may include ";messageid=..." suffix - strip it for session key
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

    // Check DM policy for direct messages
    if (isDirectMessage && msteamsCfg) {
      const dmPolicy = msteamsCfg.dmPolicy ?? "pairing";
      const allowFrom = msteamsCfg.allowFrom ?? [];

      if (dmPolicy === "disabled") {
        log.debug("dropping dm (dms disabled)");
        return;
      }

      if (dmPolicy !== "open") {
        // Check allowlist - look up from config and pairing store
        const storedAllowFrom = await readProviderAllowFromStore("msteams");
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
            const request = await upsertProviderPairingRequest({
              provider: "msteams",
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

    // Build conversation reference for proactive replies
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

    // Build Teams-specific identifiers
    const teamsFrom = isDirectMessage
      ? `msteams:${senderId}`
      : isChannel
        ? `msteams:channel:${conversationId}`
        : `msteams:group:${conversationId}`;
    const teamsTo = isDirectMessage
      ? `user:${senderId}`
      : `conversation:${conversationId}`;

    // Resolve routing
    const route = resolveAgentRoute({
      cfg,
      provider: "msteams",
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

    // Resolve team/channel config for channels and group chats
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

    // Check requireMention for channels and group chats
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

    // Format the message body with envelope
    const timestamp = parseMSTeamsActivityTimestamp(activity.timestamp);
    let mediaList = await downloadMSTeamsImageAttachments({
      attachments,
      maxBytes: mediaMaxBytes,
      tokenProvider: {
        getAccessToken: (scope) => tokenProvider.getAccessToken(scope),
      },
      allowHosts: msteamsCfg?.mediaAllowHosts,
    });
    if (mediaList.length === 0) {
      const onlyHtmlAttachments =
        attachments.length > 0 &&
        attachments.every((att) =>
          String(att.contentType ?? "").startsWith("text/html"),
        );
      if (onlyHtmlAttachments) {
        const messageUrls = buildMSTeamsGraphMessageUrls({
          conversationType,
          conversationId,
          messageId: activity.id ?? undefined,
          replyToId: activity.replyToId ?? undefined,
          conversationMessageId,
          channelData: activity.channelData,
        });
        if (messageUrls.length === 0) {
          log.debug("graph message url unavailable", {
            conversationType,
            hasChannelData: Boolean(activity.channelData),
            messageId: activity.id ?? undefined,
            replyToId: activity.replyToId ?? undefined,
          });
        } else {
          const attempts: Array<{
            url: string;
            hostedStatus?: number;
            attachmentStatus?: number;
            hostedCount?: number;
            attachmentCount?: number;
            tokenError?: boolean;
          }> = [];
          for (const messageUrl of messageUrls) {
            const graphMedia = await downloadMSTeamsGraphMedia({
              messageUrl,
              tokenProvider: {
                getAccessToken: (scope) => tokenProvider.getAccessToken(scope),
              },
              maxBytes: mediaMaxBytes,
              allowHosts: msteamsCfg?.mediaAllowHosts,
            });
            attempts.push({
              url: messageUrl,
              hostedStatus: graphMedia.hostedStatus,
              attachmentStatus: graphMedia.attachmentStatus,
              hostedCount: graphMedia.hostedCount,
              attachmentCount: graphMedia.attachmentCount,
              tokenError: graphMedia.tokenError,
            });
            if (graphMedia.media.length > 0) {
              mediaList = graphMedia.media;
              break;
            }
            if (graphMedia.tokenError) break;
          }
          if (mediaList.length === 0) {
            log.debug("graph media fetch empty", { attempts });
          }
        }
      }
    }
    if (mediaList.length > 0) {
      log.debug("downloaded image attachments", { count: mediaList.length });
    } else if (htmlSummary?.imgTags) {
      log.debug("inline images detected but none downloaded", {
        imgTags: htmlSummary.imgTags,
        srcHosts: htmlSummary.srcHosts,
        dataImages: htmlSummary.dataImages,
        cidImages: htmlSummary.cidImages,
      });
    }
    const mediaPayload = buildMSTeamsMediaPayload(mediaList);
    const body = formatAgentEnvelope({
      provider: "Teams",
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
            provider: "Teams",
            from: conversationType,
            timestamp: entry.timestamp,
            body: `${entry.sender}: ${entry.body}${
              entry.messageId ? ` [id:${entry.messageId}]` : ""
            }`,
          }),
      });
    }

    // Build context payload for agent
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

    // Create reply dispatcher
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

    // Dispatch to agent
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
        clearHistoryEntries({
          historyMap: conversationHistories,
          historyKey,
        });
      }
    } catch (err) {
      log.error("dispatch failed", { error: String(err) });
      runtime.error?.(danger(`msteams dispatch failed: ${String(err)}`));
      // Try to send error message back to Teams.
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
