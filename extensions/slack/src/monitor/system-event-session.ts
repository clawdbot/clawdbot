// Slack plugin module owns session routing for non-message events.
import { resolveDefaultAgentId } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig, SessionScope } from "openclaw/plugin-sdk/config-contracts";
import { resolveRuntimeConversationBindingRoute } from "openclaw/plugin-sdk/conversation-runtime";
import { resolveAgentRoute, resolveThreadSessionKeys } from "openclaw/plugin-sdk/routing";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { SlackMessageEvent } from "../types.js";
import { normalizeSlackChannelType } from "./channel-type.js";
import { resolveSessionKey } from "./config.runtime.js";
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

export function createSlackSystemEventSessionKeyResolver(params: {
  cfg: OpenClawConfig;
  accountId: string;
  getTeamId: () => string;
  mainKey: string;
  sessionScope: SessionScope;
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
      return params.mainKey;
    }
    const isGroup = channelType === "mpim";
    const routeSessionKey = resolveSlackSystemEventRouteSessionKey({
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
    if (routeSessionKey) {
      return routeSessionKey;
    }

    const from = isDirectMessage
      ? `slack:${channelId || senderId}`
      : isGroup
        ? `slack:group:${channelId}`
        : `slack:channel:${channelId}`;
    const fallbackFrom = event.eventScope
      ? `slack:${qualifySlackRoutePeerId({
          id: isDirectMessage ? senderId : channelId,
          kind: isDirectMessage ? "user" : "channel",
          eventScope: event.eventScope,
        })}`
      : from;
    const legacySessionKey = resolveSessionKey(
      params.sessionScope,
      {
        From: fallbackFrom,
        ChatType: isDirectMessage ? "direct" : isGroup ? "group" : "channel",
        Provider: "slack",
      },
      params.mainKey,
      resolveDefaultAgentId(params.cfg),
    );
    const threadTs = normalizeOptionalString(event.threadTs);
    return resolveThreadSessionKeys({
      baseSessionKey: legacySessionKey,
      threadId: threadTs,
      parentSessionKey: threadTs && params.threadInheritParent ? legacySessionKey : undefined,
    }).sessionKey;
  };
}

function resolveSlackSystemEventRouteSessionKey(params: {
  cfg: OpenClawConfig;
  accountId: string;
  teamId: string;
  threadInheritParent: boolean;
  channelId: string;
  channelType: SlackMessageEvent["channel_type"];
  senderId: string;
  threadTs?: string | null;
  eventScope?: SlackEventScope;
}): string | undefined {
  const isDirectMessage = params.channelType === "im";
  const peerId = isDirectMessage ? params.senderId : params.channelId;
  if (!peerId) {
    return undefined;
  }

  try {
    const peerKind = isDirectMessage
      ? "direct"
      : params.channelType === "mpim"
        ? "group"
        : "channel";
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
      return runtimeRoute.route.sessionKey;
    }
    return resolveThreadSessionKeys({
      baseSessionKey: runtimeRoute.route.sessionKey,
      threadId: threadTs,
      parentSessionKey:
        threadTs && params.threadInheritParent ? runtimeRoute.route.sessionKey : undefined,
    }).sessionKey;
  } catch {
    return undefined;
  }
}
