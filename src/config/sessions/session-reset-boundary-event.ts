import { randomUUID } from "node:crypto";
import { selectRecentUserAssistantReplayRecords } from "./transcript-replay.js";
import { selectSessionTranscriptLeafControlledPath } from "./transcript-tree.js";

export type SessionResetBoundaryReason = "new" | "reset" | "idle" | "daily" | "cron-stale";

type SessionResetBoundaryEvent = {
  type: "reset";
  id: string;
  parentId: string | null;
  timestamp: string;
  reason: SessionResetBoundaryReason;
  firstKeptEntryId?: string;
};

function recordId(record: unknown): string | undefined {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return undefined;
  }
  const id = (record as { id?: unknown }).id;
  return typeof id === "string" && id.trim() ? id : undefined;
}

function uniqueBoundaryId(records: readonly unknown[]): string {
  const ids = new Set(records.flatMap((record) => (recordId(record) ? [recordId(record)!] : [])));
  for (;;) {
    const id = randomUUID().slice(0, 8);
    if (!ids.has(id)) {
      return id;
    }
  }
}

function projectLatestBoundaryWindow(entries: readonly unknown[]): unknown[] {
  const boundaryIndex = entries.findLastIndex((entry) => {
    const type =
      entry && typeof entry === "object" && !Array.isArray(entry)
        ? (entry as { type?: unknown }).type
        : undefined;
    return type === "compaction" || type === "reset";
  });
  if (boundaryIndex < 0) {
    return [...entries];
  }
  const boundary = entries[boundaryIndex] as {
    type?: unknown;
    firstKeptEntryId?: unknown;
  };
  const firstKeptIndex =
    typeof boundary.firstKeptEntryId === "string"
      ? entries.findIndex(
          (entry, index) => index < boundaryIndex && recordId(entry) === boundary.firstKeptEntryId,
        )
      : -1;
  const kept =
    firstKeptIndex < 0
      ? []
      : entries.slice(firstKeptIndex, boundaryIndex).filter((entry) => {
          const role = (entry as { message?: { role?: unknown } } | null)?.message?.role;
          return role === "user" || role === "assistant";
        });
  return [...kept, ...entries.slice(boundaryIndex + 1)];
}

export function buildSessionResetBoundaryEvent(params: {
  events: readonly unknown[];
  reason: SessionResetBoundaryReason;
}): SessionResetBoundaryEvent {
  const entries = params.events.filter(
    (event) =>
      event !== null &&
      typeof event === "object" &&
      !Array.isArray(event) &&
      (event as { type?: unknown }).type !== "session",
  );
  const activeEntries = selectSessionTranscriptLeafControlledPath(entries) ?? entries;
  const keptEntries = selectRecentUserAssistantReplayRecords(
    projectLatestBoundaryWindow(activeEntries),
  );
  const firstKeptEntryId = recordId(keptEntries[0]);
  return {
    type: "reset",
    id: uniqueBoundaryId(params.events),
    parentId: recordId(activeEntries.at(-1)) ?? null,
    timestamp: new Date().toISOString(),
    reason: params.reason,
    ...(firstKeptEntryId ? { firstKeptEntryId } : {}),
  };
}
