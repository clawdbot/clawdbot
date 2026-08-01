/**
 * Correlates Codex app-server notifications with the active thread/turn so
 * projectors can ignore global or stale events without losing diagnostics.
 */
import { isJsonObject, type JsonObject, type JsonValue } from "./protocol.js";

/** Returns true when a notification payload belongs to the exact active thread and turn. */
export function isCodexNotificationForTurn(
  value: JsonValue | undefined,
  threadId: string,
  turnId: string,
): boolean {
  if (!isJsonObject(value)) {
    return false;
  }
  return (
    readCodexNotificationThreadId(value) === threadId &&
    readCodexNotificationTurnId(value) === turnId
  );
}

/**
 * Reads a thread id from canonical top-level or nested thread payloads.
 * The generated v2 schemas require top-level `threadId` on turn/item-scoped
 * notifications and define `Turn` without one, so `turn.threadId` is not a
 * wire shape and is deliberately not read here.
 */
export function readCodexNotificationThreadId(record: JsonObject): string | undefined {
  const thread = isJsonObject(record.thread) ? record.thread : undefined;
  return readString(record, "threadId") ?? (thread ? readString(thread, "id") : undefined);
}

/** Reads a turn id from either top-level notification params or nested turn payloads. */
export function readCodexNotificationTurnId(record: JsonObject): string | undefined {
  return readNestedTurnId(record) ?? readString(record, "turnId");
}

function readNestedTurnId(record: JsonObject): string | undefined {
  const turn = record.turn;
  return isJsonObject(turn) ? readString(turn, "id") : undefined;
}

function readString(record: JsonObject, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
