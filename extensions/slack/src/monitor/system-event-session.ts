// Slack plugin module owns session routing for non-message events.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveRuntimeConversationBindingRoute } from "openclaw/plugin-sdk/conversation-runtime";
import {
  resolveAgentRoute,
  resolveThreadSessionKeys,
  type ResolvedAgentRoute,
} from "openclaw/plugin-sdk/routing";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { SlackMessageEvent } from "../types.js";
import { normalizeSlackChannelType } from "./channel-type.js";
import type { SlackEventScope } from "./event-scope.js";
import {
  qualifySlackConversationId,
  qualifySlackRoutePeerId,
  resolveSlackEnterpriseMainDmSessionKey,
} from "./workspace-routing.js";

type SlackSystemEventSessionKeyParams = {
  channelId?: string | null;
  channelType?: string | null;
  senderId?: string | null;
  threadTs?: string | null;
  eventScope?: SlackEventScope;
};

type SlackSystemEventRoute = Pick<ResolvedAgentRoute, "agentId" | "sessionKey">;

export function createSlackSystemEventRouteResolver(params: {
  cfg: OpenClawConfig;
  accountId: string;
  getTeamId: () => string;
  mainKey: string;
  threadInheritParent: boolean;
  recallSlackChannelType: (
    channelId: string | null | undefined,
    eventScope?: SlackEventScope,
  ) => SlackMessageEvent["channel_type"] | undefined;
}) {
  return (event: SlackSystemEventSessionKeyParams) => {
    const channelId = normalizeOptionalString(event.channelId) ?? "";
    const senderId = normalizeOptionalString(event.senderId) ?? "";
    // System events can omit channel_type too; prefer a type already seen on events
    // for this channel over C-prefix inference so they key the same session (#102676).
    const channelType = normalizeSlackChannelType(
      event.channelType ?? params.recallSlackChannelType(channelId, event.eventScope),
      channelId,
    );
    const isDirectMessage = channelType === "im";
    if (!channelId && (!isDirectMessage || !senderId)) {
      const route = resolveAgentRoute({
        cfg: params.cfg,
        channel: "slack",
        accountId: params.accountId,
        teamId: event.eventScope?.teamId ?? params.getTeamId(),
      });
      return { agentId: route.agentId, sessionKey: params.mainKey };
    }
    const route = resolveSlackSystemEventRoute({
      cfg: params.cfg,
      accountId: params.accountId,
      teamId: params.getTeamId(),
      threadInheritParent: params.threadInheritParent,
      channelId,
      channelType,
      senderId,
      threadTs: event.threadTs,
      eventScope: event.eventScope,
    });
    if (route) {
      return route;
    }
    throw new Error("Slack system event route requires a peer");
  };
}

function resolveSlackSystemEventRoute(params: {
  cfg: OpenClawConfig;
  accountId: string;
  teamId: string;
  threadInheritParent: boolean;
  channelId: string;
  channelType: SlackMessageEvent["channel_type"];
  senderId: string;
  threadTs?: string | null;
  eventScope?: SlackEventScope;
}): SlackSystemEventRoute | undefined {
  const isDirectMessage = params.channelType === "im";
  const peerId = isDirectMessage ? params.senderId : params.channelId;
  if (!peerId) {
    return undefined;
  }

  const peerKind = isDirectMessage ? "direct" : params.channelType === "mpim" ? "group" : "channel";
  let route = resolveAgentRoute({
    cfg: params.cfg,
    channel: "slack",
    accountId: params.accountId,
    teamId: params.eventScope?.teamId ?? params.teamId,
    peer: {
      kind: peerKind,
      id: qualifySlackRoutePeerId({
        id: peerId,
        kind: isDirectMessage ? "user" : "channel",
        eventScope: params.eventScope,
      }),
    },
  });
  if (params.eventScope && isDirectMessage && route.dmScope === "main") {
    const sessionKey = resolveSlackEnterpriseMainDmSessionKey({
      baseSessionKey: route.sessionKey,
      accountId: params.accountId,
      eventScope: params.eventScope,
    });
    route = { ...route, sessionKey, mainSessionKey: sessionKey };
  }

  const threadTs = normalizeOptionalString(params.threadTs);
  const baseConversationId = qualifySlackConversationId(
    isDirectMessage ? `user:${params.senderId}` : params.channelId,
    params.eventScope,
  );
  const threadBindingRoute =
    !params.eventScope && threadTs
      ? resolveRuntimeConversationBindingRoute({
          route,
          conversation: {
            channel: "slack",
            accountId: params.accountId,
            conversationId: threadTs,
            parentConversationId: baseConversationId,
          },
        })
      : null;
  const runtimeRoute = params.eventScope
    ? { route, bindingRecord: null, boundSessionKey: undefined }
    : threadBindingRoute?.boundSessionKey || threadBindingRoute?.bindingRecord
      ? threadBindingRoute
      : resolveRuntimeConversationBindingRoute({
          route,
          conversation: {
            channel: "slack",
            accountId: params.accountId,
            conversationId: baseConversationId,
          },
        });
  if (runtimeRoute.boundSessionKey) {
    return runtimeRoute.route;
  }
  const sessionKey = resolveThreadSessionKeys({
    baseSessionKey: runtimeRoute.route.sessionKey,
    threadId: threadTs,
    parentSessionKey:
      threadTs && params.threadInheritParent ? runtimeRoute.route.sessionKey : undefined,
  }).sessionKey;
  return { agentId: runtimeRoute.route.agentId, sessionKey };
}
