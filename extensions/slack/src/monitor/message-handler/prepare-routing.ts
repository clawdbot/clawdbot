// Slack plugin module implements prepare routing behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  resolveConfiguredBindingRoute,
  resolveRuntimeConversationBindingRoute,
  type ConfiguredBindingRouteResult,
  type RuntimeConversationBindingRouteResult,
} from "openclaw/plugin-sdk/conversation-runtime";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { resolveThreadSessionKeys } from "openclaw/plugin-sdk/routing";
import { resolveSlackReplyToMode } from "../../account-reply-mode.js";
import type { ResolvedSlackAccount } from "../../accounts.js";
import { parseSlackTarget, type SlackTargetKind } from "../../targets.js";
import { resolveSlackThreadContext } from "../../threading.js";
import type { SlackMessageEvent } from "../../types.js";
import type { SlackChannelConfigResolved } from "../channel-config.js";
import type { SlackEventScope } from "../event-scope.js";

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

type SlackRouteBinding = NonNullable<OpenClawConfig["bindings"]>[number];
type SlackRouteBindingPeer = NonNullable<SlackRouteBinding["match"]["peer"]>;

const slackRouteBindingConfigCache = new WeakMap<
  OpenClawConfig,
  { bindingsRef: OpenClawConfig["bindings"]; normalizedCfg: OpenClawConfig }
>();

function slackTargetDefaultKindForPeer(kind: SlackRouteBindingPeer["kind"]): SlackTargetKind {
  return kind === "direct" ? "user" : "channel";
}

function slackTargetKindMatchesPeer(
  peerKind: SlackRouteBindingPeer["kind"],
  targetKind: SlackTargetKind,
): boolean {
  if (targetKind === "user") {
    return peerKind === "direct";
  }
  return peerKind === "channel" || peerKind === "group";
}

function normalizeSlackRouteBindingPeer(peer: SlackRouteBindingPeer): SlackRouteBindingPeer {
  const rawId = peer.id.trim();
  if (!rawId || rawId === "*") {
    return peer;
  }

  const target = (() => {
    try {
      return parseSlackTarget(rawId, {
        defaultKind: slackTargetDefaultKindForPeer(peer.kind),
      });
    } catch {
      return undefined;
    }
  })();
  if (!target || !slackTargetKindMatchesPeer(peer.kind, target.kind) || target.id === peer.id) {
    return peer;
  }
  return { ...peer, id: target.id };
}

function normalizeSlackRouteBindingConfig(cfg: OpenClawConfig): OpenClawConfig {
  const bindings = cfg.bindings;
  const cached = slackRouteBindingConfigCache.get(cfg);
  if (cached && cached.bindingsRef === bindings) {
    return cached.normalizedCfg;
  }
  if (!Array.isArray(bindings)) {
    return cfg;
  }

  let changed = false;
  const normalizedBindings = bindings.map((binding) => {
    if (binding.type === "acp" || binding.match.channel.trim().toLowerCase() !== "slack") {
      return binding;
    }
    const peer = binding.match.peer;
    if (!peer) {
      return binding;
    }
    const normalizedPeer = normalizeSlackRouteBindingPeer(peer);
    if (normalizedPeer === peer) {
      return binding;
    }
    changed = true;
    return {
      ...binding,
      match: {
        ...binding.match,
        peer: normalizedPeer,
      },
    };
  });

  const normalizedCfg = changed
    ? ({ ...cfg, bindings: normalizedBindings } as OpenClawConfig)
    : cfg;
  slackRouteBindingConfigCache.set(cfg, { bindingsRef: bindings, normalizedCfg });
  return normalizedCfg;
}

function resolveSlackBaseConversationId(params: {
  message: SlackMessageEvent;
  isDirectMessage: boolean;
  eventScope?: SlackEventScope;
}): string {
  const raw = params.isDirectMessage
    ? `user:${params.message.user ?? "unknown"}`
    : params.message.channel;
  return params.eventScope ? `team:${encodeURIComponent(params.eventScope.teamId)}:${raw}` : raw;
}

function qualifySlackPeerId(params: {
  id: string;
  kind: "user" | "channel";
  eventScope?: SlackEventScope;
}): string {
  if (!params.eventScope) {
    return params.id;
  }
  return `team:${encodeURIComponent(params.eventScope.teamId)}:${params.kind}:${encodeURIComponent(params.id)}`;
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
      id: qualifySlackPeerId({
        id: params.isDirectMessage ? (params.message.user ?? "unknown") : params.message.channel,
        kind: params.isDirectMessage ? "user" : "channel",
        eventScope: params.eventScope,
      }),
    },
  });
  if (!params.eventScope || !params.isDirectMessage || route.dmScope !== "main") {
    return route;
  }
  const partition = `account:${encodeURIComponent(params.account.accountId).toLowerCase()}:team:${encodeURIComponent(params.eventScope.teamId).toLowerCase()}`;
  const sessionKey = `${route.sessionKey}:${partition}`;
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
  const assistantThreadId = assistantThreadTs;
  // DM threads are a UI affordance, not a session boundary. Route all DM
  // messages, including thread replies, to the user's main DM session so
  // the agent sees them as part of the existing conversation. Slack assistant
  // threads are the exception: Slack treats each assistant thread as its own
  // conversation and sends the lifecycle context only on assistant events.
  const canonicalThreadId = isDirectMessage
    ? assistantThreadId
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
  const boundThreadRoute =
    !eventScope && runtimeBindingThreadId
      ? resolveRuntimeConversationBindingRoute({
          route,
          conversation: {
            channel: "slack",
            accountId: account.accountId,
            conversationId: runtimeBindingThreadId,
            parentConversationId: baseConversationId,
          },
        })
      : null;
  const runtimeRoute = eventScope
    ? { route, bindingRecord: null, boundSessionKey: undefined }
    : boundThreadRoute?.boundSessionKey || boundThreadRoute?.bindingRecord
      ? boundThreadRoute
      : resolveRuntimeConversationBindingRoute({
          route,
          conversation: {
            channel: "slack",
            accountId: account.accountId,
            conversationId: baseConversationId,
          },
        });
  let configuredBinding: ConfiguredBindingRouteResult["bindingResolution"] = null;
  let configuredBindingSessionKey = "";
  if (runtimeRoute.boundSessionKey || runtimeRoute.bindingRecord) {
    route = runtimeRoute.route;
  } else if (!eventScope) {
    const configuredRoute = resolveConfiguredBindingRoute({
      cfg: ctx.cfg,
      route,
      conversation: {
        channel: "slack",
        accountId: account.accountId,
        conversationId: baseConversationId,
      },
    });
    configuredBinding = configuredRoute.bindingResolution;
    configuredBindingSessionKey = configuredRoute.boundSessionKey ?? "";
    route = configuredRoute.route;
  }
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
