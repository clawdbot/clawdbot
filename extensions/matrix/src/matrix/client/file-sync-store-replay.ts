// Matrix sync-cache replay provenance.
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

export type PendingReplayEvent = {
  key: string;
  roomId: string;
  event: Record<string, unknown>;
};

export function buildReplayEventKey(roomId: string, eventId: string): string | null {
  const normalizedRoomId = roomId.trim();
  const normalizedEventId = eventId.trim();
  if (!normalizedRoomId || !normalizedEventId) {
    return null;
  }
  return `${normalizedRoomId}\0${normalizedEventId}`;
}

export function normalizePendingReplayEvents(value: unknown): PendingReplayEvent[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const entries: PendingReplayEvent[] = [];
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      typeof entry.key !== "string" ||
      !entry.key ||
      typeof entry.roomId !== "string" ||
      !entry.roomId.trim() ||
      !isRecord(entry.event)
    ) {
      continue;
    }
    entries.push({
      key: entry.key,
      roomId: entry.roomId.trim(),
      event: entry.event,
    });
  }
  return entries;
}
