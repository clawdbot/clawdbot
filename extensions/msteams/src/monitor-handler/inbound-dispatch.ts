// Msteams plugin module dispatches prepared inbound turns and owns reply lifecycle handling.
import {
  createChannelInboundEnvelopeBuilder,
  hasFinalInboundReplyDispatch,
  resolveInboundReplyDispatchCounts,
  resolveInboundSupplementalSenderAllowed,
  toInboundMediaFactsWithMetadata,
} from "openclaw/plugin-sdk/channel-inbound";
import { bindIngressLifecycleToReplyOptions } from "openclaw/plugin-sdk/channel-outbound";
import { createChannelHistoryWindow, type HistoryEntry } from "openclaw/plugin-sdk/reply-history";
import { sliceUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import type { RuntimeEnv } from "../../runtime-api.js";
import { formatUnknownError } from "../errors.js";
import type { MSTeamsMessageHandlerDeps } from "../monitor-handler.types.js";
import { resolveMSTeamsAllowlistMatch, resolveMSTeamsReplyPolicy } from "../policy.js";
import { createMSTeamsReplyDispatcher } from "../reply-dispatcher.js";
import { getMSTeamsRuntime } from "../runtime.js";
import { recordMSTeamsSentMessage } from "../sent-message-cache.js";
import type { admitMSTeamsMessage } from "./access.js";
import { resolveMSTeamsSenderAccess } from "./access.js";
import type { prepareMSTeamsInboundContent } from "./inbound-content.js";
import type { assembleMSTeamsInboundFacts } from "./inbound-facts.js";
import type { prepareMSTeamsThreadRouting, resolveMSTeamsThreadContext } from "./thread-context.js";

type MSTeamsInboundDispatchResult =
  | { kind: "completed"; finalResponses: number }
  | { kind: "failed" };

export async function dispatchMSTeamsInboundTurn(params: {
  cfg: MSTeamsMessageHandlerDeps["cfg"];
  runtime: RuntimeEnv;
  appId: string;
  app: MSTeamsMessageHandlerDeps["app"];
  tokenProvider: MSTeamsMessageHandlerDeps["tokenProvider"];
  textLimit: number;
  log: MSTeamsMessageHandlerDeps["log"];
  logVerboseMessage: (message: string) => void;
  facts: ReturnType<typeof assembleMSTeamsInboundFacts>;
  admission: NonNullable<Awaited<ReturnType<typeof admitMSTeamsMessage>>>;
  content: NonNullable<Awaited<ReturnType<typeof prepareMSTeamsInboundContent>>>;
  routing: ReturnType<typeof prepareMSTeamsThreadRouting>;
  thread: Awaited<ReturnType<typeof resolveMSTeamsThreadContext>>;
  replyStyle: ReturnType<typeof resolveMSTeamsReplyPolicy>["replyStyle"];
  timestamp?: Date;
  contextVisibilityMode: "all" | "allowlist" | "allowlist_quote";
  mentionWasEffective: boolean;
  conversationHistories: Map<string, HistoryEntry[]>;
  historyLimit: number;
}): Promise<MSTeamsInboundDispatchResult> {
  const core = getMSTeamsRuntime();
  const {
    cfg,
    runtime,
    appId,
    app,
    tokenProvider,
    textLimit,
    log,
    logVerboseMessage,
    facts,
    admission,
    content,
    routing,
    thread,
    replyStyle,
    timestamp,
    contextVisibilityMode,
    conversationHistories,
    historyLimit,
  } = params;
  const { context, activity, rawBody, text, quoteInfo, conversationRef } = facts;
  const {
    senderId,
    senderName,
    isDirectMessage,
    allowNameMatching,
    groupPolicy,
    commandAuthorized,
    effectiveGroupAllowFrom,
    msteamsCfg,
  } = admission;
  const { route } = routing;
  const { agentBody, inboundMedia } = content;
  const { teamAadGroupId, quoteBodyFull, quoteSenderId, quoteSenderName, threadContext } = thread;
  const { conversationId, conversationType, isChannel, teamId, graphChannelId } = facts;
  const teamsFrom = isDirectMessage
    ? `msteams:${senderId}`
    : isChannel
      ? `msteams:channel:${conversationId}`
      : `msteams:group:${conversationId}`;
  const teamsTo = isDirectMessage ? `user:${senderId}` : `conversation:${conversationId}`;
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
  const bodyForAgent = threadContext
    ? `[Thread history]\n${threadContext}\n[/Thread history]\n\n${agentBody}`
    : agentBody;
  // Teams channel actions need both the AAD group and Graph channel ids.
  const nativeChannelId =
    isChannel && teamAadGroupId ? `${teamAadGroupId}/${graphChannelId}` : undefined;
  // Thread routing owns the final session key, so mint the bound result at dispatch preparation.
  const boundIngress = await resolveMSTeamsSenderAccess({
    cfg,
    accountId: route.accountId,
    activity,
    hasControlCommand: admission.isControlCommand,
    conversationThreadId: facts.threadId,
    contextBinding: {
      agentId: route.agentId,
      sessionKey: route.sessionKey,
      ...(activity.id ? { messageId: activity.id } : {}),
      ...(nativeChannelId ? { nativeChannelId } : {}),
      inboundEventKind: "user_request",
    },
  });
  const ctxPayload = core.channel.inbound.buildContext({
    channelIngress: boundIngress.channelIngress,
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
    media: await toInboundMediaFactsWithMetadata(inboundMedia),
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
      // A user target is a mutable lookup alias; the conversation id is the
      // authoritative route for message-tool reply suppression.
      originatingTo: `conversation:${conversationId}`,
      // Channel-only thread root (facts.threadId) so messaging-tool evidence matches
      // session/origin thread ids; keep replyToId as parent. Undefined for DM/group.
      messageThreadId: facts.threadId ?? undefined,
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
        wasMentioned: isDirectMessage || params.mentionWasEffective,
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

  const preview = sliceUtf16Safe(rawBody.replace(/\s+/g, " "), 0, 160);
  logVerboseMessage(`msteams inbound: from=${ctxPayload.From} preview="${preview}"`);

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
        recordMSTeamsSentMessage(conversationId, id, { accountId: route.accountId });
      }
    },
    tokenProvider,
    sharePointSiteId: msteamsCfg?.sharePointSiteId,
  });

  const activityClientInfo = activity.entities?.find((entity) => entity.type === "clientInfo") as
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
            ...(facts.turnAdoptionLifecycle
              ? bindIngressLifecycleToReplyOptions(facts.turnAdoptionLifecycle)
              : {}),
          },
        }),
      },
    });
    const dispatchResult = turnResult.dispatched ? turnResult.dispatchResult : undefined;
    const counts = resolveInboundReplyDispatchCounts(dispatchResult);
    log.info("dispatch complete", {
      counts,
    });
    if (hasFinalInboundReplyDispatch(dispatchResult)) {
      logVerboseMessage(
        `msteams: delivered ${counts.final} repl${counts.final === 1 ? "y" : "ies"} to ${teamsTo}`,
      );
    }
    return { kind: "completed", finalResponses: counts.final };
  } catch (err) {
    log.error("dispatch failed", { error: formatUnknownError(err) });
    runtime.error(`msteams dispatch failed: ${formatUnknownError(err)}`);
    if (facts.turnAdoptionLifecycle) {
      throw err;
    }
    try {
      await context.sendActivity("⚠️ Something went wrong. Please try again.");
    } catch {
      // Best effort.
    }
    return { kind: "failed" };
  }
}
