import { getSessionBindingService } from "openclaw/plugin-sdk/conversation-runtime";
import { matrixApprovalCapability } from "../../approval-native.js";
import {
  resolveMatrixApprovalReactionTarget,
  unregisterMatrixApprovalReactionTarget,
} from "../../approval-reactions.js";
import { isApprovalNotFoundError, resolveMatrixApproval } from "../../exec-approval-resolver.js";
import type { CoreConfig } from "../../types.js";
import { resolveMatrixAccountConfig } from "../account-config.js";
import { extractMatrixReactionAnnotation } from "../reaction-common.js";
import type { MatrixClient } from "../sdk.js";
import { resolveMatrixInboundRoute } from "./route.js";
import type { PluginRuntime } from "./runtime-api.js";
import { resolveMatrixThreadRootId, resolveMatrixThreadRouting } from "./threads.js";
import type { MatrixRawEvent, RoomMessageEventContent } from "./types.js";

export type MatrixReactionNotificationMode = "off" | "own";

export function resolveMatrixReactionNotificationMode(params: {
  cfg: CoreConfig;
  accountId: string;
}): MatrixReactionNotificationMode {
  const matrixConfig = params.cfg.channels?.matrix;
  const accountConfig = resolveMatrixAccountConfig({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  return accountConfig.reactionNotifications ?? matrixConfig?.reactionNotifications ?? "own";
}

async function maybeResolveMatrixApprovalReaction(params: {
  cfg: CoreConfig;
  accountId: string;
  senderId: string;
  target: ReturnType<typeof resolveMatrixApprovalReactionTarget>;
  targetEventId: string;
  roomId: string;
  logVerboseMessage: (message: string) => void;
}): Promise<boolean> {
  if (!params.target) {
    return false;
  }
  if (
    !matrixApprovalCapability.authorizeActorAction?.({
      cfg: params.cfg,
      accountId: params.accountId,
      senderId: params.senderId,
      action: "approve",
      approvalKind: params.target.approvalId.startsWith("plugin:") ? "plugin" : "exec",
    })?.authorized
  ) {
    return false;
  }
  try {
    await resolveMatrixApproval({
      cfg: params.cfg,
      approvalId: params.target.approvalId,
      decision: params.target.decision,
      senderId: params.senderId,
    });
    params.logVerboseMessage(
      `matrix: approval reaction resolved id=${params.target.approvalId} sender=${params.senderId} decision=${params.target.decision}`,
    );
    return true;
  } catch (err) {
    if (isApprovalNotFoundError(err)) {
      unregisterMatrixApprovalReactionTarget({
        roomId: params.roomId,
        eventId: params.targetEventId,
      });
      params.logVerboseMessage(
        `matrix: approval reaction ignored for expired approval id=${params.target.approvalId} sender=${params.senderId}`,
      );
      return true;
    }
    params.logVerboseMessage(
      `matrix: approval reaction failed id=${params.target.approvalId} sender=${params.senderId}: ${String(err)}`,
    );
    return true;
  }
}

export async function handleInboundMatrixReaction(params: {
  client: MatrixClient;
  core: PluginRuntime;
  cfg: CoreConfig;
  accountId: string;
  roomId: string;
  event: MatrixRawEvent;
  senderId: string;
  senderLabel: string;
  selfUserId: string;
  isDirectMessage: boolean;
  logVerboseMessage: (message: string) => void;
}): Promise<void> {
  const reaction = extractMatrixReactionAnnotation(params.event.content);
  if (!reaction?.eventId) {
    return;
  }
  if (params.senderId === params.selfUserId) {
    return;
  }
  const approvalTarget = resolveMatrixApprovalReactionTarget({
    roomId: params.roomId,
    eventId: reaction.eventId,
    reactionKey: reaction.key,
  });
  if (
    await maybeResolveMatrixApprovalReaction({
      cfg: params.cfg,
      accountId: params.accountId,
      senderId: params.senderId,
      target: approvalTarget,
      targetEventId: reaction.eventId,
      roomId: params.roomId,
      logVerboseMessage: params.logVerboseMessage,
    })
  ) {
    return;
  }
  const notificationMode = resolveMatrixReactionNotificationMode({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  if (notificationMode === "off") {
    return;
  }

  const targetEvent = await params.client.getEvent(params.roomId, reaction.eventId).catch((err) => {
    params.logVerboseMessage(
      `matrix: failed resolving reaction target room=${params.roomId} id=${reaction.eventId}: ${String(err)}`,
    );
    return null;
  });
  const targetSender =
    targetEvent && typeof targetEvent.sender === "string" ? targetEvent.sender.trim() : "";
  if (!targetSender) {
    return;
  }
  if (notificationMode === "own" && targetSender !== params.selfUserId) {
    return;
  }

  const targetContent =
    targetEvent && targetEvent.content && typeof targetEvent.content === "object"
      ? (targetEvent.content as RoomMessageEventContent)
      : undefined;
  const threadRootId = targetContent
    ? resolveMatrixThreadRootId({
        event: targetEvent as MatrixRawEvent,
        content: targetContent,
      })
    : undefined;
  const accountConfig = resolveMatrixAccountConfig({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  const thread = resolveMatrixThreadRouting({
    isDirectMessage: params.isDirectMessage,
    threadReplies: accountConfig.threadReplies ?? "inbound",
    dmThreadReplies: accountConfig.dm?.threadReplies,
    messageId: reaction.eventId,
    threadRootId,
  });
  const { route, runtimeBindingId } = resolveMatrixInboundRoute({
    cfg: params.cfg,
    accountId: params.accountId,
    roomId: params.roomId,
    senderId: params.senderId,
    isDirectMessage: params.isDirectMessage,
    dmSessionScope: accountConfig.dm?.sessionScope ?? "per-user",
    threadId: thread.threadId,
    eventTs: params.event.origin_server_ts,
    resolveAgentRoute: params.core.channel.routing.resolveAgentRoute,
  });
  if (runtimeBindingId) {
    getSessionBindingService().touch(runtimeBindingId, params.event.origin_server_ts);
  }
  const text = `Matrix reaction added: ${reaction.key} by ${params.senderLabel} on msg ${reaction.eventId}`;
  params.core.system.enqueueSystemEvent(text, {
    sessionKey: route.sessionKey,
    contextKey: `matrix:reaction:add:${params.roomId}:${reaction.eventId}:${params.senderId}:${reaction.key}`,
  });
  params.logVerboseMessage(
    `matrix: reaction event enqueued room=${params.roomId} target=${reaction.eventId} sender=${params.senderId} emoji=${reaction.key}`,
  );
}
