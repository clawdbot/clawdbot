// Slack plugin module owns workspace-qualified routing for deferred actions.
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { formatSlackTarget, type SlackTargetKind } from "../target-parsing.js";
import type { SlackInstallationIdentity } from "./enterprise-install.js";

export type SlackDeferredActionTarget = {
  teamId?: string;
  peerId: string;
  target: string;
};

export type SlackDeferredActionSessionTarget = SlackDeferredActionTarget & {
  baseConversationId: string;
  from: string;
  peerKind: "direct" | "group" | "channel";
};

export function resolveSlackDeferredActionTarget(params: {
  installationIdentity?: SlackInstallationIdentity;
  teamId?: string | null;
  kind: SlackTargetKind;
  id: string;
}): SlackDeferredActionTarget {
  const id = params.id.trim();
  if (!id) {
    throw new Error("Slack deferred action is missing a target ID");
  }

  const teamId = resolveSlackDeferredActionTeamId(params);
  if (!teamId) {
    return {
      peerId: id,
      target: `${params.kind}:${id}`,
    };
  }

  const target = formatSlackTarget({ teamId, kind: params.kind, id });
  return { teamId, peerId: target, target };
}

export function resolveSlackDeferredActionSessionTarget(params: {
  installationIdentity?: SlackInstallationIdentity;
  teamId?: string | null;
  channelId: string;
  senderId: string;
  isDirectMessage: boolean;
  isGroup: boolean;
}): SlackDeferredActionSessionTarget {
  const peerKind = params.isDirectMessage ? "direct" : params.isGroup ? "group" : "channel";
  const rawPeerId = params.isDirectMessage ? params.senderId || params.channelId : params.channelId;
  const targetKind = params.isDirectMessage && params.senderId ? "user" : "channel";
  const target = resolveSlackDeferredActionTarget({
    installationIdentity: params.installationIdentity,
    teamId: params.teamId,
    kind: targetKind,
    id: rawPeerId,
  });
  const from = params.isDirectMessage
    ? `slack:${target.teamId ? target.peerId : params.channelId || params.senderId}`
    : `slack:${params.isGroup ? "group" : "channel"}:${target.peerId}`;
  const baseConversationId = target.teamId
    ? params.isDirectMessage
      ? target.target
      : `team:${encodeURIComponent(target.teamId)}:${params.channelId}`
    : params.isDirectMessage && params.senderId
      ? `user:${params.senderId}`
      : params.channelId;
  return { ...target, baseConversationId, from, peerKind };
}

export function partitionSlackDeferredActionDmRoute<
  Route extends { dmScope?: string; sessionKey: string; mainSessionKey: string },
>(params: { route: Route; accountId: string; teamId?: string; isDirectMessage: boolean }): Route {
  if (!params.teamId || !params.isDirectMessage || params.route.dmScope !== "main") {
    return params.route;
  }
  const partition = `account:${encodeURIComponent(params.accountId).toLowerCase()}:team:${encodeURIComponent(params.teamId).toLowerCase()}`;
  const sessionKey = `${params.route.sessionKey}:${partition}`;
  return { ...params.route, sessionKey, mainSessionKey: sessionKey };
}

export function resolveSlackDeferredActionTeamId(params: {
  installationIdentity?: SlackInstallationIdentity;
  teamId?: string | null;
}): string | undefined {
  if (params.installationIdentity?.kind !== "enterprise") {
    return undefined;
  }
  const teamId = normalizeOptionalString(params.teamId);
  if (!teamId) {
    throw new Error("Slack Enterprise Grid deferred action is missing a workspace team ID");
  }
  if (!/^T[A-Z0-9]+$/i.test(teamId)) {
    throw new Error("Slack Enterprise Grid deferred action has an invalid workspace team ID");
  }
  return teamId;
}
