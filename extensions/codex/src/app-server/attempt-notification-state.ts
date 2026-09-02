import { codexExecutionToolName, readCodexNotificationItem } from "./attempt-notifications.js";
import { isCodexNotificationForTurn } from "./notification-correlation.js";
import { readCodexTurnCompletedNotification } from "./protocol-validators.js";
import type { CodexServerNotification } from "./protocol.js";

type CodexExecutionPhase =
  | { phase: "turn_accepted" }
  | { phase: "assistant_output_started" }
  | { phase: "tool_execution_started"; itemId?: string; tool: string };

/** Emits coarse execution phases exactly once from app-server notifications. */
export function reportCodexExecutionNotification(params: {
  notification: CodexServerNotification;
  emitExecutionPhaseOnce: (key: string, info: CodexExecutionPhase) => void;
}): void {
  const { notification } = params;
  if (notification.method === "turn/started") {
    params.emitExecutionPhaseOnce("turn_accepted", { phase: "turn_accepted" });
    return;
  }
  if (notification.method === "item/agentMessage/delta") {
    params.emitExecutionPhaseOnce("assistant_output_started", {
      phase: "assistant_output_started",
    });
    return;
  }
  if (notification.method !== "item/started") {
    return;
  }
  const item = readCodexNotificationItem(notification.params);
  const tool = item ? codexExecutionToolName(item) : undefined;
  if (!item || !tool) {
    return;
  }
  params.emitExecutionPhaseOnce(`tool:${item.id}`, {
    phase: "tool_execution_started",
    tool,
    itemId: item.id,
  });
}

/** Returns true when a notification ends the current app-server turn. */
export function isTerminalCodexTurnNotificationForTurn(params: {
  notification: CodexServerNotification;
  threadId: string;
  turnId: string;
}): boolean {
  return (
    params.notification.method === "turn/completed" &&
    isCodexNotificationForTurn(params.notification.params, params.threadId, params.turnId) &&
    readCodexTurnCompletedNotification(params.notification.params) !== undefined
  );
}
