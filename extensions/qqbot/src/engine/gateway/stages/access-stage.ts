import type { QQBotInboundAccess } from "../../adapter/index.js";
import type { InboundContext, InboundPipelineDeps } from "../inbound-context.js";
import type { QueuedMessage } from "../message-queue.js";
import { buildBlockedInboundContext } from "./stub-contexts.js";

type AccessStageResult =
  | {
      kind: "allow";
      isGroupChat: boolean;
      peerId: string;
      qualifiedTarget: string;
      fromAddress: string;
      route: { sessionKey: string; accountId: string; agentId?: string };
      access: QQBotInboundAccess;
    }
  | { kind: "block"; context: InboundContext };

export async function runAccessStage(
  event: QueuedMessage,
  deps: InboundPipelineDeps,
): Promise<AccessStageResult> {
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

  const access = await deps.adapters.access.resolveInboundAccess({
    cfg,
    accountId: account.accountId,
    isGroup: isGroupChat,
    senderId: event.senderId,
    conversationId: peerId,
    allowFrom: account.config?.allowFrom,
    groupAllowFrom: account.config?.groupAllowFrom,
    dmPolicy: account.config?.dmPolicy,
    groupPolicy: account.config?.groupPolicy,
  });

  if (access.senderAccess.decision !== "allow") {
    log?.info(
      `Blocked qqbot inbound: decision=${access.senderAccess.decision} reasonCode=${access.senderAccess.reasonCode} ` +
        `senderId=${event.senderId} accountId=${account.accountId} isGroup=${isGroupChat}`,
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
  }
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
