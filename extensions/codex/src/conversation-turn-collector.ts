// Codex plugin module implements conversation turn collector behavior.
import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import { asOptionalRecord as readRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { isAssistantCommentaryCompletionNotification } from "./app-server/attempt-notifications.js";
import { isCodexNotificationForTurn } from "./app-server/notification-correlation.js";
import {
  isJsonObject,
  type CodexServerNotification,
  type JsonObject,
} from "./app-server/protocol.js";

/** Identifies a timer that expired in the bound-turn collector itself. */
export class CodexConversationTurnTimeoutError extends Error {
  constructor() {
    super("codex app-server bound turn timed out");
    this.name = "CodexConversationTurnTimeoutError";
  }
}

export function createCodexConversationTurnCollector(threadId: string) {
  let turnId: string | undefined;
  let completed = false;
  let failedError: string | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const assistantTextByItem = new Map<string, string>();
  let resolveCompletion: ((value: { replyText: string }) => void) | undefined;
  let rejectCompletion: ((error: Error) => void) | undefined;

  const collectReplyText = (): string => {
    const texts = [...assistantTextByItem.values()].map((text) => text.trim()).filter(Boolean);
    return texts.at(-1) ?? "";
  };
  const clearWaitState = () => {
    if (timeout) {
      clearTimeout(timeout);
      timeout = undefined;
    }
    resolveCompletion = undefined;
    rejectCompletion = undefined;
  };
  const finish = () => {
    if (completed) {
      return;
    }
    completed = true;
    if (failedError) {
      rejectCompletion?.(new Error(failedError));
    } else {
      resolveCompletion?.({ replyText: collectReplyText() });
    }
    clearWaitState();
  };

  const handleNotification = (notification: CodexServerNotification) => {
    const params = isJsonObject(notification.params) ? notification.params : undefined;
    if (!params || !turnId || !isCodexNotificationForTurn(params, threadId, turnId)) {
      return;
    }
    if (notification.method === "item/agentMessage/delta") {
      const itemId = readString(params, "itemId") ?? "assistant";
      const delta = readTextString(params, "delta");
      if (!delta) {
        return;
      }
      assistantTextByItem.set(itemId, `${assistantTextByItem.get(itemId) ?? ""}${delta}`);
      return;
    }
    if (notification.method === "item/completed") {
      const item = isJsonObject(params.item) ? params.item : undefined;
      if (item?.type === "agentMessage") {
        const itemId = readString(item, "id") ?? readString(params, "itemId") ?? "assistant";
        assistantTextByItem.delete(itemId);
        if (isAssistantCommentaryCompletionNotification(notification)) {
          return;
        }
        const text = readTextString(item, "text");
        if (text?.trim()) {
          assistantTextByItem.set(itemId, text);
        }
      }
      return;
    }
    if (notification.method === "turn/completed") {
      const turn = isJsonObject(params.turn) ? params.turn : undefined;
      const status = readString(turn, "status");
      if (status === "failed") {
        failedError =
          readString(readRecord(turn?.error), "message") ?? "codex app-server turn failed";
      } else if (status === "interrupted") {
        // Codex reports an interrupted turn as a terminal completion without a
        // final answer; streamed partial text must not become a successful reply.
        failedError = "codex app-server turn interrupted";
      } else if (status !== "completed") {
        failedError = "codex app-server turn completed without a valid terminal status";
      }
      if (status === "completed") {
        const items = Array.isArray(turn?.items) ? turn.items : [];
        for (const item of items) {
          if (!isJsonObject(item) || item.type !== "agentMessage") {
            continue;
          }
          const itemId = readString(item, "id") ?? `assistant-${assistantTextByItem.size + 1}`;
          assistantTextByItem.delete(itemId);
          const text = item.phase === "commentary" ? undefined : readTextString(item, "text");
          if (text?.trim()) {
            assistantTextByItem.set(itemId, text);
          }
        }
      }
      finish();
    }
  };

  return {
    setTurnId(nextTurnId: string) {
      turnId = nextTurnId;
    },
    handleNotification,
    wait(params: { timeoutMs: number }): Promise<{ replyText: string }> {
      if (completed) {
        return failedError
          ? Promise.reject(new Error(failedError))
          : Promise.resolve({ replyText: collectReplyText() });
      }
      return new Promise<{ replyText: string }>((resolve, reject) => {
        resolveCompletion = resolve;
        rejectCompletion = reject;
        timeout = setTimeout(
          () => {
            completed = true;
            reject(new CodexConversationTurnTimeoutError());
            clearWaitState();
          },
          resolveTimerTimeoutMs(params.timeoutMs, 100, 100),
        );
        timeout.unref?.();
      });
    },
  };
}

function readString(record: Record<string, unknown> | JsonObject | undefined, key: string) {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readTextString(record: Record<string, unknown> | JsonObject | undefined, key: string) {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
