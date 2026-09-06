// Slack plugin module implements prepare routing behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type {
  ConfiguredBindingRouteResult,
  RuntimeConversationBindingRouteResult,
} from "openclaw/plugin-sdk/conversation-runtime";
import { resolveAgentRoute, resolveThreadSessionKeys } from "openclaw/plugin-sdk/routing";
import { getConversationSession } from "openclaw/plugin-sdk/session-store-runtime";
import { resolveSlackReplyToMode } from "../../account-reply-mode.js";
import type { ResolvedSlackAccount } from "../../accounts.js";
import {
  normalizeSlackRouteBindingConfig,
  resolveSlackConversationBindingRoute,
} from "../../conversation-binding-route.js";
import { resolveSlackThreadContext } from "../../threading.js";
import type { SlackMessageEvent } from "../../types.js";
import { readSlackAssistantThreadContext } from "../assistant-thread-context.js";
import type { SlackChannelConfigResolved } from "../channel-config.js";
import { resolveStorePath } from "../config.runtime.js";
import type { SlackMonitorContext } from "../context.js";
import type { SlackEventScope } from "../event-scope.js";
import { captureSlackSessionTargetGuard, getSlackSessionRuns } from "../session-run-targets.js";
import {
  qualifySlackConversationId,
  qualifySlackRoutePeerId,
  resolveSlackEnterpriseMainDmSessionKey,
} from "../workspace-routing.js";

type SlackRoutingContextDeps = {
  cfg: OpenClawConfig;
  teamId: string;
  threadInheritParent: boolean;
  threadHistoryScope: "thread" | "channel";
};

type SlackRoutingContext = {
  route: ReturnType<typeof resolveAgentRoute>;
  runtimeBinding: RuntimeConversationBindingRouteResult["bindingRecord"];
  runtimeBoundSessionKey: string | undefined;
  configuredBinding: ConfiguredBindingRouteResult["bindingResolution"];
  configuredBindingSessionKey: string;
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
  eventScope?: SlackEventScope;
}): string {
  const raw = params.isDirectMessage
    ? `user:${params.message.user ?? "unknown"}`
    : params.message.channel;
  return qualifySlackConversationId(raw, params.eventScope);
}

function resolveSlackInitialAgentRoute(params: {
  ctx: SlackRoutingContextDeps;
  account: ResolvedSlackAccount;
  message: SlackMessageEvent;
  isDirectMessage: boolean;
  isRoom: boolean;
  eventScope?: SlackEventScope;
}) {
  const route = resolveAgentRoute({
    cfg: normalizeSlackRouteBindingConfig(params.ctx.cfg),
    channel: "slack",
    accountId: params.account.accountId,
    teamId: params.eventScope?.teamId || params.ctx.teamId || undefined,
    peer: {
      kind: params.isDirectMessage ? "direct" : params.isRoom ? "channel" : "group",
      id: qualifySlackRoutePeerId({
        id: params.isDirectMessage ? (params.message.user ?? "unknown") : params.message.channel,
        kind: params.isDirectMessage ? "user" : "channel",
        eventScope: params.eventScope,
      }),
    },
  });
  if (!params.eventScope || !params.isDirectMessage || route.dmScope !== "main") {
    return route;
  }
  const sessionKey = resolveSlackEnterpriseMainDmSessionKey({
    baseSessionKey: route.sessionKey,
    accountId: params.account.accountId,
    eventScope: params.eventScope,
  });
  return { ...route, sessionKey, mainSessionKey: sessionKey };
}

export function resolveSlackRoutingContext(params: {
  ctx: SlackRoutingContextDeps;
  account: ResolvedSlackAccount;
  message: SlackMessageEvent;
  isDirectMessage: boolean;
  isGroupDm: boolean;
  isRoom: boolean;
  isRoomish: boolean;
  channelConfig?: SlackChannelConfigResolved | null;
  seedTopLevelRoomThread?: boolean;
  assistantThreadTs?: string;
  agentViewThreadTs?: string;
  eventScope?: SlackEventScope;
}): SlackRoutingContext {
  const {
    ctx,
    account,
    message,
    isDirectMessage,
    isGroupDm,
    isRoom,
    isRoomish,
    channelConfig,
    seedTopLevelRoomThread,
    assistantThreadTs,
    agentViewThreadTs,
    eventScope,
  } = params;
  let route = resolveSlackInitialAgentRoute({
    ctx,
    account,
    message,
    isDirectMessage,
    isRoom,
    eventScope,
  });

  const chatType = isDirectMessage ? "direct" : isGroupDm ? "group" : "channel";
  const replyToMode = channelConfig?.replyToMode ?? resolveSlackReplyToMode(account, chatType);
  const threadContext = resolveSlackThreadContext({ message, replyToMode, isDirectMessage });
  const threadTs = threadContext.incomingThreadTs;
  const isThreadReply = threadContext.isThreadReply;
  // Keep true thread replies thread-scoped, while top-level DMs keep their
  // stable direct-message session even when reply delivery targets a Slack UI
  // thread.
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
  const directAgentThreadId = assistantThreadTs ?? agentViewThreadTs;
  // DM threads are a UI affordance, not a session boundary. Route all DM
  // messages, including thread replies, to the user's main DM session so
  // the agent sees them as part of the existing conversation. Slack Assistant
  // View and Agent View threads are the exception: each visible root is its
  // own conversation.
  const canonicalThreadId = isDirectMessage
    ? directAgentThreadId
    : isRoomish
      ? roomThreadId
      : isThreadReply
        ? threadTs
        : autoThreadId;
  const routedThreadId = canonicalThreadId ?? (isRoomish ? seededRoomThreadId : undefined);
  const baseConversationId = resolveSlackBaseConversationId({
    message,
    isDirectMessage,
    eventScope,
  });
  const runtimeBindingThreadId =
    routedThreadId ?? (isDirectMessage && isThreadReply ? threadTs : undefined);
  const bindingRoute = resolveSlackConversationBindingRoute({
    cfg: ctx.cfg,
    route,
    accountId: account.accountId,
    baseConversationId,
    runtimeBindingThreadId,
    bindingsEnabled: !eventScope,
  });
  const runtimeRoute = bindingRoute.runtimeRoute;
  const configuredBinding = bindingRoute.configuredRoute?.bindingResolution ?? null;
  const configuredBindingSessionKey = bindingRoute.configuredRoute?.boundSessionKey ?? "";
  route = bindingRoute.route;
  const threadKeys =
    runtimeRoute.boundSessionKey || configuredBindingSessionKey
      ? { sessionKey: route.sessionKey, parentSessionKey: undefined }
      : resolveThreadSessionKeys({
          baseSessionKey: route.sessionKey,
          threadId: routedThreadId,
          parentSessionKey:
            routedThreadId && ctx.threadInheritParent ? route.sessionKey : undefined,
        });
  const sessionKey = threadKeys.sessionKey;
  const historyKey =
    isThreadReply && ctx.threadHistoryScope === "thread"
      ? sessionKey
      : eventScope
        ? `${account.accountId}:${eventScope.teamId}:${message.channel}`
        : message.channel;

  return {
    route,
    runtimeBinding: runtimeRoute.bindingRecord,
    runtimeBoundSessionKey: runtimeRoute.boundSessionKey,
    configuredBinding,
    configuredBindingSessionKey,
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

export async function resolveSlackSessionEventRoutingContext(
  params: Omit<
    Parameters<typeof resolveSlackRoutingContext>[0],
    "ctx" | "assistantThreadTs" | "agentViewThreadTs"
  > & { ctx: SlackMonitorContext; intent: "stop" | "title" },
): Promise<SlackRoutingContext & { isCurrentSession: () => boolean }> {
  const { ctx, message, eventScope } = params;
  const threadTs = message.thread_ts;
  const routing = resolveSlackRoutingContext(params);
  const address = {
    agentId: routing.route.agentId,
    storePath: resolveStorePath(ctx.cfg.session?.store, { agentId: routing.route.agentId }),
    channel: "slack",
    accountId: params.account.accountId,
    kind: routing.chatType,
    peerId: qualifySlackRoutePeerId({
      id: params.isDirectMessage ? (message.user ?? "unknown") : message.channel,
      kind: params.isDirectMessage ? "user" : "channel",
      eventScope,
    }),
  };
  const threadAddress = { ...address, threadId: threadTs };
  const liveAddress = { channelId: message.channel, threadTs, eventScope };
  let allowDirectParent = false;
  const readOwner = ():
    | {
        route: SlackRoutingContext["route"];
        source: "recorded" | "live" | "parent";
        isActive?: () => boolean;
      }
    | undefined => {
    const recorded = getConversationSession(threadAddress);
    if (recorded) {
      return {
        route: { ...routing.route, sessionKey: recorded.sessionKey },
        source: "recorded",
      };
    }
    // First-mode roots publish in a native thread with an unthreaded ingress address.
    const live = getSlackSessionRuns(ctx, liveAddress).at(-1);
    if (live) {
      return { route: live.route, source: "live", isActive: live.isActive };
    }
    const parent = allowDirectParent ? getConversationSession(address) : undefined;
    return parent
      ? { route: { ...routing.route, sessionKey: parent.sessionKey }, source: "parent" }
      : undefined;
  };
  let owner = readOwner();
  if (owner?.source === "live" && params.isDirectMessage) {
    // Keep a proven ordinary DM parent after its publisher finishes, without
    // borrowing a parent for a managed thread that never had that live owner.
    allowDirectParent = getConversationSession(address)?.sessionKey === owner.route.sessionKey;
  }
  if (!owner && params.isDirectMessage && threadTs) {
    const assistantContext = ctx.getSlackAssistantThreadContext(
      message.channel,
      threadTs,
      eventScope,
    );
    const managedThread =
      !eventScope &&
      ((await ctx.isSlackManagedViewThread(message.channel, threadTs)) ||
        (await ctx.isSlackAgentView()));
    const assistantThread =
      assistantContext ??
      (managedThread
        ? undefined
        : await readSlackAssistantThreadContext({
            client: eventScope?.client ?? ctx.app.client,
            channelId: message.channel,
            threadTs,
            userId: message.user,
          }));
    allowDirectParent = !assistantThread && !managedThread;
    owner = readOwner();
  }
  if (!owner) {
    throw new Error("No recorded session owns this Slack conversation");
  }
  const { route } = owner;
  const isCurrentIncarnation =
    params.intent === "stop"
      ? captureSlackSessionTargetGuard(ctx, route, owner.isActive)
      : undefined;
  return {
    ...routing,
    route,
    sessionKey: route.sessionKey,
    // Re-read only prepared local facts after command admission or writer waits.
    isCurrentSession: () =>
      readOwner()?.route.sessionKey === route.sessionKey && isCurrentIncarnation?.() !== false,
  };
}
