import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import {
  resolveRuntimeConversationBindingRoute,
  type RuntimeConversationBindingRouteResult,
} from "openclaw/plugin-sdk/conversation-runtime";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { resolveThreadSessionKeys } from "openclaw/plugin-sdk/routing";
import { resolveSlackReplyToMode } from "../../account-reply-mode.js";
import type { ResolvedSlackAccount } from "../../accounts.js";
import { resolveSlackThreadContext } from "../../threading.js";
import type { SlackMessageEvent } from "../../types.js";

export type SlackRoutingContextDeps = {
  cfg: OpenClawConfig;
  teamId: string;
  threadInheritParent: boolean;
  threadHistoryScope: "thread" | "channel";
};

export type SlackRoutingContext = {
  route: ReturnType<typeof resolveAgentRoute>;
  runtimeBinding: RuntimeConversationBindingRouteResult["bindingRecord"];
  runtimeBoundSessionKey: string | undefined;
  chatType: "direct" | "group" | "channel";
  replyToMode: ReturnType<typeof resolveSlackReplyToMode>;
  threadContext: ReturnType<typeof resolveSlackThreadContext>;
  threadTs: string | undefined;
  isThreadReply: boolean;
  threadKeys: ReturnType<typeof resolveThreadSessionKeys>;
  sessionKey: string;
  historyKey: string;
};

function resolveSlackBaseConversationId(params: {
  message: SlackMessageEvent;
  isDirectMessage: boolean;
}): string {
  return params.isDirectMessage
    ? `user:${params.message.user ?? "unknown"}`
    : params.message.channel;
}

function resolveSlackInitialAgentRoute(params: {
  ctx: SlackRoutingContextDeps;
  account: ResolvedSlackAccount;
  message: SlackMessageEvent;
  isDirectMessage: boolean;
  isRoom: boolean;
}) {
  return resolveAgentRoute({
    cfg: params.ctx.cfg,
    channel: "slack",
    accountId: params.account.accountId,
    teamId: params.ctx.teamId || undefined,
    peer: {
      kind: params.isDirectMessage ? "direct" : params.isRoom ? "channel" : "group",
      id: params.isDirectMessage ? (params.message.user ?? "unknown") : params.message.channel,
    },
  });
}

export function resolveSlackRoutingContext(params: {
  ctx: SlackRoutingContextDeps;
  account: ResolvedSlackAccount;
  message: SlackMessageEvent;
  isDirectMessage: boolean;
  isGroupDm: boolean;
  isRoom: boolean;
  isRoomish: boolean;
  seedTopLevelRoomThread?: boolean;
}): SlackRoutingContext {
  const {
    ctx,
    account,
    message,
    isDirectMessage,
    isGroupDm,
    isRoom,
    isRoomish,
    seedTopLevelRoomThread,
  } = params;
  let route = resolveSlackInitialAgentRoute({
    ctx,
    account,
    message,
    isDirectMessage,
    isRoom,
  });

  const chatType = isDirectMessage ? "direct" : isGroupDm ? "group" : "channel";
  const replyToMode = resolveSlackReplyToMode(account, chatType);
  const threadContext = resolveSlackThreadContext({ message, replyToMode });
  const threadTs = threadContext.incomingThreadTs;
  const isThreadReply = threadContext.isThreadReply;
  // Keep true thread replies thread-scoped, but preserve channel-level sessions
  // for top-level room turns when replyToMode is off.
  // For DMs, preserve existing auto-thread behavior when replyToMode="all".
  const autoThreadId =
    !isThreadReply && replyToMode === "all" && threadContext.messageTs
      ? threadContext.messageTs
      : undefined;
  // Keep ordinary top-level room messages on the per-channel session for
  // continuity, but preserve Slack thread identity when the event already has
  // one or when an actionable app mention will seed a reply thread.
  // This keeps a thread root and its later replies on one parent session
  // without returning to the old "every channel message is its own thread"
  // behavior (regression from #10686).
  const seedCandidateThreadId = threadContext.incomingThreadTs ?? threadContext.messageTs;
  const seededRoomThreadId =
    !isThreadReply &&
    isRoom &&
    seedTopLevelRoomThread &&
    replyToMode !== "off" &&
    seedCandidateThreadId
      ? seedCandidateThreadId
      : undefined;
  const roomThreadId = isThreadReply && threadTs ? threadTs : undefined;
  const canonicalThreadId = isRoomish ? roomThreadId : isThreadReply ? threadTs : autoThreadId;
  const routedThreadId = canonicalThreadId ?? (isRoomish ? seededRoomThreadId : undefined);
  const baseConversationId = resolveSlackBaseConversationId({ message, isDirectMessage });
  const boundThreadRoute = routedThreadId
    ? resolveRuntimeConversationBindingRoute({
        route,
        conversation: {
          channel: "slack",
          accountId: account.accountId,
          conversationId: routedThreadId,
          parentConversationId: baseConversationId,
        },
      })
    : null;
  const runtimeRoute =
    boundThreadRoute?.boundSessionKey || boundThreadRoute?.bindingRecord
      ? boundThreadRoute
      : resolveRuntimeConversationBindingRoute({
          route,
          conversation: {
            channel: "slack",
            accountId: account.accountId,
            conversationId: baseConversationId,
          },
        });
  route = runtimeRoute.route;
  const threadKeys = runtimeRoute.boundSessionKey
    ? { sessionKey: route.sessionKey, parentSessionKey: undefined }
    : resolveThreadSessionKeys({
        baseSessionKey: route.sessionKey,
        threadId: routedThreadId,
        parentSessionKey: routedThreadId && ctx.threadInheritParent ? route.sessionKey : undefined,
      });
  const sessionKey = threadKeys.sessionKey;
  const historyKey =
    isThreadReply && ctx.threadHistoryScope === "thread" ? sessionKey : message.channel;

  return {
    route,
    runtimeBinding: runtimeRoute.bindingRecord,
    runtimeBoundSessionKey: runtimeRoute.boundSessionKey,
    chatType,
    replyToMode,
    threadContext,
    threadTs,
    isThreadReply,
    threadKeys,
    sessionKey,
    historyKey,
  };
}
