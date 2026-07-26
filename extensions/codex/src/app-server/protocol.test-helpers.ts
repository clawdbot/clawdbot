// Codex plugin module provides compact protocol fixtures for app-server tests.
import type { CodexServerNotification, JsonObject } from "./protocol.js";

export function itemNotification(
  method: "item/started" | "item/completed",
  item: JsonObject,
): CodexServerNotification {
  return { method, params: { threadId: "thread-1", turnId: "turn-1", item } };
}

export function rawItemCompleted(item: JsonObject): CodexServerNotification {
  return {
    method: "rawResponseItem/completed",
    params: { threadId: "thread-1", turnId: "turn-1", item },
  };
}

export function turnCompleted(turn: JsonObject): CodexServerNotification {
  return {
    method: "turn/completed",
    params: { threadId: "thread-1", turnId: "turn-1", turn },
  };
}
