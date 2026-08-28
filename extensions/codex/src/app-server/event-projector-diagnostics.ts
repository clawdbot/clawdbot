import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { redactSensitiveText } from "openclaw/plugin-sdk/logging-core";
import { sanitizeTerminalText } from "openclaw/plugin-sdk/text-chunking";
import { unknownItemStatus } from "./event-projector-items.js";
import {
  readCodexNotificationThreadId,
  readCodexNotificationTurnId,
} from "./notification-correlation.js";
import type { CodexServerNotification, CodexThreadItem, JsonObject } from "./protocol.js";

export function redactCodexEventKind(method: string): string {
  return redactSensitiveText(sanitizeTerminalText(method));
}

export class CodexProjectionDiagnostics {
  private readonly warningKeys = new Set<string>();

  constructor(
    private readonly threadId: string,
    private readonly turnId: string,
  ) {}

  warnUnknownItemStatus(item: CodexThreadItem | undefined): void {
    if (!item) {
      return;
    }
    const status = unknownItemStatus(item);
    if (!status) {
      return;
    }
    const safeStatus = redactCodexEventKind(status);
    const safeItemType = redactCodexEventKind(item.type);
    this.warnOnce(
      JSON.stringify(["status", item.type, status]),
      "codex app-server item reported unknown status; continuing projection",
      {
        itemId: item.id,
        itemType: safeItemType,
        status: safeStatus,
      },
    );
  }

  warnUnknownEvent(notification: CodexServerNotification, params: JsonObject): void {
    const notificationThreadId = readCodexNotificationThreadId(params);
    const notificationTurnId = readCodexNotificationTurnId(params);
    const eventKind = redactCodexEventKind(notification.method);
    this.warnOnce(
      JSON.stringify(["method", notification.method]),
      `codex app-server projector received unknown event kind; continuing: ${eventKind}`,
      {
        eventKind,
        activeThreadId: this.threadId,
        activeTurnId: this.turnId,
        threadId: notificationThreadId,
        turnId: notificationTurnId,
        matchesActiveThread: notificationThreadId === this.threadId,
        matchesActiveTurn: notificationTurnId === this.turnId,
      },
    );
  }

  private warnOnce(key: string, message: string, context: Record<string, unknown>): void {
    if (this.warningKeys.has(key)) {
      return;
    }
    this.warningKeys.add(key);
    embeddedAgentLog.warn(message, context);
  }
}
