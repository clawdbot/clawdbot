// Msteams plugin module owns thread routing and Graph parent context.
import { resolveInboundSupplementalSenderAllowed } from "openclaw/plugin-sdk/channel-inbound";
import { filterSupplementalContextItems } from "openclaw/plugin-sdk/context-visibility-runtime";
import type { OpenClawConfig } from "../../runtime-api.js";
import { formatUnknownError } from "../errors.js";
import {
  fetchChannelMessage,
  fetchChatMessageText,
  fetchThreadReplies,
  formatThreadContext,
  type GraphThreadMessage,
} from "../graph-thread.js";
import type { extractMSTeamsQuoteInfo } from "../inbound.js";
import type { MSTeamsMessageHandlerDeps } from "../monitor-handler.types.js";
import { resolveMSTeamsAllowlistMatch } from "../policy.js";
import { createMSTeamsInboundDeadline, withMSTeamsRequestDeadline } from "../request-timeout.js";
import { getMSTeamsRuntime } from "../runtime.js";
import type { MSTeamsTurnContext } from "../sdk-types.js";
import { resolveTeamGroupId } from "../team-identity.js";
import {
  fetchParentMessageCached,
  formatParentContextEvent,
  markParentContextInjected,
  shouldInjectParentContext,
  summarizeParentMessage,
} from "../thread-parent-context.js";
import { resolveMSTeamsRouteSessionKey } from "./thread-session.js";

export function prepareMSTeamsThreadRouting(params: {
  cfg: OpenClawConfig;
  accountId: string;
  context: MSTeamsTurnContext;
  isDirectMessage: boolean;
  isChannel: boolean;
  senderId: string;
  conversationId: string;
  conversationMessageId?: string;
  teamId?: string;
  log: MSTeamsMessageHandlerDeps["log"];
}) {
  const core = getMSTeamsRuntime();
  const route = core.channel.routing.resolveAgentRoute({
    cfg: params.cfg,
    channel: "msteams",
    accountId: params.accountId,
    teamId: params.teamId,
    peer: {
      kind: params.isDirectMessage ? "direct" : params.isChannel ? "channel" : "group",
      id: params.isDirectMessage ? params.senderId : params.conversationId,
    },
  });
  route.sessionKey = resolveMSTeamsRouteSessionKey({
    baseSessionKey: route.sessionKey,
    isChannel: params.isChannel,
    conversationMessageId: params.conversationMessageId,
    replyToId: params.context.activity.replyToId,
  });

  const deadline = createMSTeamsInboundDeadline();
  let teamAadGroupId = params.context.activity.channelData?.team?.aadGroupId?.trim() || undefined;
  const conversationTeamId = params.isChannel ? params.teamId : undefined;
  let teamGroupIdPromise: Promise<string | undefined> | undefined;
  const resolveTeamAadGroupId = async (): Promise<string | undefined> => {
    if (!conversationTeamId) {
      return undefined;
    }
    teamGroupIdPromise ??= resolveTeamGroupId({
      conversationTeamId,
      aadGroupId: teamAadGroupId,
      getTeamDetails: params.context.getTeamDetails,
      deadline,
    }).catch((err: unknown) => {
      params.log.debug?.("failed to resolve Teams AAD group ID", {
        teamId: conversationTeamId,
        error: formatUnknownError(err),
      });
      return undefined;
    });
    teamAadGroupId = await teamGroupIdPromise;
    return teamAadGroupId;
  };

  return {
    route,
    deadline,
    resolveTeamAadGroupId,
    getTeamAadGroupId: () => teamAadGroupId,
  };
}

export async function resolveMSTeamsThreadContext(params: {
  routing: ReturnType<typeof prepareMSTeamsThreadRouting>;
  context: MSTeamsTurnContext;
  tokenProvider: MSTeamsMessageHandlerDeps["tokenProvider"];
  quoteInfo: ReturnType<typeof extractMSTeamsQuoteInfo>;
  isDirectMessage: boolean;
  isChannel: boolean;
  conversationId: string;
  contextVisibilityMode: "all" | "allowlist" | "allowlist_quote";
  groupPolicy: Parameters<typeof resolveInboundSupplementalSenderAllowed>[0]["groupPolicy"];
  effectiveGroupAllowFrom: readonly (string | number)[];
  allowNameMatching: boolean;
  log: MSTeamsMessageHandlerDeps["log"];
}) {
  const core = getMSTeamsRuntime();
  const activity = params.context.activity;
  const { route, deadline } = params.routing;
  const teamAadGroupId = await params.routing.resolveTeamAadGroupId();
  let quoteBodyFull: string | undefined;
  let quoteSenderId: string | undefined;
  let quoteSenderName: string | undefined;
  const quoteMessageId = params.quoteInfo?.id;
  if (quoteMessageId && params.isDirectMessage && params.conversationId.startsWith("19:")) {
    try {
      const graphToken = await withMSTeamsRequestDeadline({
        deadline,
        label: "MS Teams quote token",
        work: () => params.tokenProvider.getAccessToken("https://graph.microsoft.com"),
      });
      quoteBodyFull = await withMSTeamsRequestDeadline({
        deadline,
        label: "MS Teams quote lookup",
        work: () =>
          fetchChatMessageText(graphToken, params.conversationId, quoteMessageId, deadline),
      });
    } catch (err) {
      params.log.debug?.("failed to fetch full quoted message text", {
        error: formatUnknownError(err),
      });
    }
  }

  let threadContext: string | undefined;
  const threadParentId = activity.replyToId;
  if (threadParentId && params.isChannel && teamAadGroupId) {
    try {
      const graphToken = await withMSTeamsRequestDeadline({
        deadline,
        label: "MS Teams thread token",
        work: () => params.tokenProvider.getAccessToken("https://graph.microsoft.com"),
      });
      // Keep successful parent context when the replies endpoint fails, and vice versa.
      const [parentResult, repliesResult] = await withMSTeamsRequestDeadline({
        deadline,
        label: "MS Teams thread history",
        work: () =>
          Promise.allSettled([
            fetchParentMessageCached(
              graphToken,
              teamAadGroupId,
              params.conversationId,
              threadParentId,
              (token, groupId, requestedChannelId, messageId) =>
                fetchChannelMessage(token, groupId, requestedChannelId, messageId, deadline),
            ),
            fetchThreadReplies(
              graphToken,
              teamAadGroupId,
              params.conversationId,
              threadParentId,
              50,
              deadline,
            ),
          ]),
      });
      const parentMsg = parentResult.status === "fulfilled" ? parentResult.value : undefined;
      const replies = repliesResult.status === "fulfilled" ? repliesResult.value : [];
      if (parentResult.status === "rejected") {
        params.log.debug?.("failed to fetch parent message", {
          error: formatUnknownError(parentResult.reason),
        });
      }
      if (repliesResult.status === "rejected") {
        params.log.debug?.("failed to fetch thread replies", {
          error: formatUnknownError(repliesResult.reason),
        });
      }
      const isThreadSenderAllowed = (message: GraphThreadMessage) =>
        resolveInboundSupplementalSenderAllowed({
          isGroup: params.isChannel,
          groupPolicy: params.groupPolicy,
          allowFrom: params.effectiveGroupAllowFrom,
          isSenderAllowed: (allowFrom) =>
            resolveMSTeamsAllowlistMatch({
              allowFrom,
              senderId: message.from?.user?.id ?? "",
              senderName: message.from?.user?.displayName,
              allowNameMatching: params.allowNameMatching,
            }).allowed,
        });
      const parentSummary = summarizeParentMessage(parentMsg);
      const visibleParentMessages = parentMsg
        ? filterSupplementalContextItems({
            items: [parentMsg],
            mode: params.contextVisibilityMode,
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
          contextKey: `msteams:thread-parent:${params.conversationId}:${threadParentId}`,
        });
        markParentContextInjected(route.sessionKey, threadParentId);
      }
      const allMessages = parentMsg ? [parentMsg, ...replies] : replies;
      quoteSenderId = parentMsg?.from?.user?.id ?? parentMsg?.from?.application?.id ?? undefined;
      quoteSenderName =
        parentMsg?.from?.user?.displayName ??
        parentMsg?.from?.application?.displayName ??
        params.quoteInfo?.sender;
      const { items: threadMessages } = filterSupplementalContextItems({
        items: allMessages,
        mode: params.contextVisibilityMode,
        kind: "thread",
        isSenderAllowed: isThreadSenderAllowed,
      });
      threadContext = formatThreadContext(threadMessages, activity.id) || undefined;
    } catch (err) {
      params.log.debug?.("failed to fetch thread history", {
        error: formatUnknownError(err),
      });
    }
  }
  quoteSenderName ??= params.quoteInfo?.sender;

  return {
    teamAadGroupId,
    quoteBodyFull,
    quoteSenderId,
    quoteSenderName,
    threadContext,
  };
}
