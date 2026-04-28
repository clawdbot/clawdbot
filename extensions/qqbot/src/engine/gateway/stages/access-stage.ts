/**
 * Access stage — resolves routing target + runs access control.
 *
 * Split from the pipeline so it is trivially unit-testable: given a raw
 * event and the runtime's routing info, the stage returns either:
 *   - `{ kind: "allow", ... }` — proceed through the rest of the pipeline
 *   - `{ kind: "block", context }` — short-circuit; the caller returns
 *     `context` directly to its own caller.
 */

import { resolveQQBotAccess, type QQBotAccessResult } from "../../access/index.js";
import type { InboundContext, InboundPipelineDeps } from "../inbound-context.js";
import type { QueuedMessage } from "../message-queue.js";
import { buildBlockedInboundContext } from "./stub-contexts.js";

// ─────────────────────────── Types ───────────────────────────

export interface AccessStageAllow {
  kind: "allow";
  isGroupChat: boolean;
  peerId: string;
  qualifiedTarget: string;
  fromAddress: string;
  route: { sessionKey: string; accountId: string; agentId?: string };
  access: QQBotAccessResult;
}

export interface AccessStageBlock {
  kind: "block";
  context: InboundContext;
}

export type AccessStageResult = AccessStageAllow | AccessStageBlock;

// ─────────────────────────── Stage ───────────────────────────

/**
 * Resolve the routing target, walk the access policy, and decide whether
 * the inbound message should proceed to the rest of the pipeline.
 */
export function runAccessStage(event: QueuedMessage, deps: InboundPipelineDeps): AccessStageResult {
  const { account, cfg, runtime, log } = deps;

  const isGroupChat = event.type === "guild" || event.type === "group";
  const peerId = resolvePeerId(event, isGroupChat);
  const qualifiedTarget = buildQualifiedTarget(event, isGroupChat);

  const route = runtime.channel.routing.resolveAgentRoute({
    cfg,
    channel: "qqbot",
    accountId: account.accountId,
    peer: { kind: isGroupChat ? "group" : "direct", id: peerId },
  });

  const access = resolveQQBotAccess({
    isGroup: isGroupChat,
    senderId: event.senderId,
    allowFrom: account.config?.allowFrom,
    groupAllowFrom: account.config?.groupAllowFrom,
    dmPolicy: account.config?.dmPolicy,
    groupPolicy: account.config?.groupPolicy,
  });

  if (access.decision !== "allow") {
    log?.info(
      `Blocked qqbot inbound: decision=${access.decision} reasonCode=${access.reasonCode} ` +
        `reason=${access.reason} senderId=${event.senderId} ` +
        `accountId=${account.accountId} isGroup=${isGroupChat}`,
    );
    return {
      kind: "block",
      context: buildBlockedInboundContext({
        event,
        route,
        isGroupChat,
        peerId,
        qualifiedTarget,
        fromAddress: qualifiedTarget,
        access,
      }),
    };
  }

  return {
    kind: "allow",
    isGroupChat,
    peerId,
    qualifiedTarget,
    fromAddress: qualifiedTarget,
    route,
    access,
  };
}

// ─────────────────────────── Internal helpers ───────────────────────────

function resolvePeerId(event: QueuedMessage, isGroupChat: boolean): string {
  if (event.type === "guild") {
    return event.channelId ?? "unknown";
  }
  if (event.type === "group") {
    return event.groupOpenid ?? "unknown";
  }
  if (isGroupChat) {
    return "unknown";
  } // defensive, should never hit
  return event.senderId;
}

function buildQualifiedTarget(event: QueuedMessage, isGroupChat: boolean): string {
  if (isGroupChat) {
    return event.type === "guild"
      ? `qqbot:channel:${event.channelId}`
      : `qqbot:group:${event.groupOpenid}`;
  }
  return event.type === "dm" ? `qqbot:dm:${event.guildId}` : `qqbot:c2c:${event.senderId}`;
}

/**
 * Decide whether the access decision permits running text-based control
 * commands. Placed in the access stage because the rule is an
 * access-policy derivative, not a gate derivative.
 */
export function resolveCommandAuthorized(access: QQBotAccessResult): boolean {
  return (
    access.reasonCode === "dm_policy_open" ||
    access.reasonCode === "dm_policy_allowlisted" ||
    (access.reasonCode === "group_policy_allowed" &&
      access.effectiveGroupAllowFrom.length > 0 &&
      access.groupPolicy === "allowlist")
  );
}
