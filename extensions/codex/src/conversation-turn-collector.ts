import {
  isJsonObject,
  type CodexServerNotification,
  type JsonObject,
} from "./app-server/protocol.js";

export type CodexConversationTurnCollector = ReturnType<
  typeof createCodexConversationTurnCollector
>;

export function createCodexConversationTurnCollector(threadId: string) {
  let turnId: string | undefined;
  let completed = false;
  let failedError: string | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const assistantTextByItem = new Map<string, string>();
  const assistantOrder: string[] = [];
  let resolveCompletion: ((value: { replyText: string }) => void) | undefined;
  let rejectCompletion: ((error: Error) => void) | undefined;

  const rememberItem = (itemId: string) => {
    if (!assistantOrder.includes(itemId)) {
      assistantOrder.push(itemId);
    }
  };
  const collectReplyText = (): string => {
    const texts = assistantOrder
      .map((itemId) => assistantTextByItem.get(itemId)?.trim())
      .filter((text): text is string => Boolean(text));
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

  return {
    setTurnId(nextTurnId: string) {
      turnId = nextTurnId;
    },
    handleNotification(notification: CodexServerNotification) {
      const params = isJsonObject(notification.params) ? notification.params : undefined;
      if (!params || !isNotificationForTurn(params, threadId, turnId)) {
        return;
      }
      if (notification.method === "item/agentMessage/delta") {
        const itemId = readString(params, "itemId") ?? readString(params, "id") ?? "assistant";
        const delta = readTextString(params, "delta");
        if (!delta) {
          return;
        }
        rememberItem(itemId);
        assistantTextByItem.set(itemId, `${assistantTextByItem.get(itemId) ?? ""}${delta}`);
        return;
      }
      if (notification.method === "item/completed") {
        const item = isJsonObject(params.item) ? params.item : undefined;
        if (item?.type === "agentMessage") {
          const itemId = readString(item, "id") ?? readString(params, "itemId") ?? "assistant";
          const text = readTextString(item, "text");
          if (text) {
            rememberItem(itemId);
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
        }
        const items = Array.isArray(turn?.items) ? turn.items : [];
        for (const item of items) {
          if (!isJsonObject(item) || item.type !== "agentMessage") {
            continue;
          }
          const itemId = readString(item, "id") ?? `assistant-${assistantOrder.length + 1}`;
          const text = readTextString(item, "text");
          if (text) {
            rememberItem(itemId);
            assistantTextByItem.set(itemId, text);
          }
        }
        finish();
      }
    },
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
            reject(new Error("codex app-server bound turn timed out"));
            clearWaitState();
          },
          Math.max(100, params.timeoutMs),
        );
        timeout.unref?.();
      });
    },
  };
}

function isNotificationForTurn(
  params: JsonObject,
  threadId: string,
  turnId: string | undefined,
): boolean {
  if (readString(params, "threadId") !== threadId) {
    return false;
  }
  if (!turnId) {
    return true;
  }
  const directTurnId = readString(params, "turnId");
  if (directTurnId) {
    return directTurnId === turnId;
  }
  const turn = isJsonObject(params.turn) ? params.turn : undefined;
  return !turn || readString(turn, "id") === turnId;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(record: Record<string, unknown> | JsonObject | undefined, key: string) {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readTextString(record: Record<string, unknown> | JsonObject | undefined, key: string) {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
