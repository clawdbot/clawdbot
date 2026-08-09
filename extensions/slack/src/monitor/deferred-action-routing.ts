// Slack plugin module owns workspace-qualified routing for deferred actions.
import type { SlackTargetKind } from "../target-parsing.js";
import type { SlackEventScope } from "./event-scope.js";

export type SlackDeferredActionTarget = {
  peerId: string;
  target: string;
};

export type SlackDeferredActionSessionTarget = SlackDeferredActionTarget & {
  baseConversationId: string;
  from: string;
  peerKind: "direct" | "group" | "channel";
};

export function resolveSlackDeferredActionTarget(params: {
  eventScope?: SlackEventScope;
  kind: SlackTargetKind;
  id: string;
}): SlackDeferredActionTarget {
  if (!params.id) {
    throw new Error("Slack deferred action is missing a target ID");
  }
  if (!params.eventScope) {
    return { peerId: params.id, target: `${params.kind}:${params.id}` };
  }
  const target = `team:${encodeURIComponent(params.eventScope.teamId)}:${params.kind}:${encodeURIComponent(params.id)}`;
  return { peerId: target, target };
}

export function resolveSlackDeferredActionSessionTarget(params: {
  eventScope?: SlackEventScope;
  channelId: string;
  senderId: string;
  isDirectMessage: boolean;
  isGroup: boolean;
}): SlackDeferredActionSessionTarget {
  const peerKind = params.isDirectMessage ? "direct" : params.isGroup ? "group" : "channel";
  const rawPeerId = params.isDirectMessage ? params.senderId || params.channelId : params.channelId;
  const targetKind = params.isDirectMessage && params.senderId ? "user" : "channel";
  const target = resolveSlackDeferredActionTarget({
    eventScope: params.eventScope,
    kind: targetKind,
    id: rawPeerId,
  });
  const from = params.isDirectMessage
    ? `slack:${params.eventScope ? target.peerId : params.channelId || params.senderId}`
    : `slack:${params.isGroup ? "group" : "channel"}:${target.peerId}`;
  const baseConversationId = params.eventScope
    ? params.isDirectMessage
      ? target.target
      : `team:${encodeURIComponent(params.eventScope.teamId)}:${params.channelId}`
    : params.isDirectMessage && params.senderId
      ? `user:${params.senderId}`
      : params.channelId;
  return { ...target, baseConversationId, from, peerKind };
}

export function partitionSlackDeferredActionDmRoute<
  Route extends { dmScope?: string; sessionKey: string; mainSessionKey: string },
>(params: {
  route: Route;
  accountId: string;
  eventScope?: SlackEventScope;
  isDirectMessage: boolean;
}): Route {
  if (!params.eventScope || !params.isDirectMessage || params.route.dmScope !== "main") {
    return params.route;
  }
  const partition = `account:${encodeURIComponent(params.accountId).toLowerCase()}:team:${encodeURIComponent(params.eventScope.teamId).toLowerCase()}`;
  const sessionKey = `${params.route.sessionKey}:${partition}`;
  return { ...params.route, sessionKey, mainSessionKey: sessionKey };
}
