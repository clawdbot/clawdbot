// Slack plugin module resolves system events to the same sessions as message events.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveRuntimeConversationBindingRoute } from "openclaw/plugin-sdk/conversation-runtime";
import { resolveAgentRoute, resolveThreadSessionKeys } from "openclaw/plugin-sdk/routing";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { SlackMessageEvent } from "../types.js";
import type { SlackEventScope } from "./event-scope.js";
import {
  qualifySlackConversationId,
  qualifySlackRoutePeerId,
  resolveSlackEnterpriseMainDmSessionKey,
} from "./workspace-routing.js";

export function resolveSlackSystemEventRouteSessionKey(params: {
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
