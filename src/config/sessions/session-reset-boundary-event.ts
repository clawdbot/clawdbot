import { randomUUID } from "node:crypto";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { loadTranscriptEventsFromDatabase } from "./session-accessor.sqlite-read.js";
import type { ResolvedTranscriptScope } from "./session-accessor.sqlite-scope.js";
import { appendTranscriptEventsInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import { createSessionTranscriptHeader } from "./transcript-header.js";
import { selectRecentUserAssistantReplayRecords } from "./transcript-replay.js";
import { selectSessionTranscriptLeafControlledPath } from "./transcript-tree.js";

type SessionResetBoundaryReason = "new" | "reset" | "idle" | "daily" | "cron-stale";

export type SessionResetBoundaryRequest =
  | { context: "clear"; reason: Extract<SessionResetBoundaryReason, "new" | "reset"> }
  | {
      context: "preserve-tail";
      reason: Extract<SessionResetBoundaryReason, "reset" | "idle" | "daily" | "cron-stale">;
    };

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

/**
 * Appends a reset boundary, prepending a canonical session header only when
 * the transcript is empty. Fresh /new resets otherwise persist the reset as
 * seq 0 and later turns fail the runtime legacy-transcript assertion.
 * Nonempty headerless transcripts stay headerless so doctor can rewrite the
 * header at seq 0.
 */
export function appendSessionResetBoundaryEventsInTransaction(
  database: OpenClawAgentDatabase,
  scope: ResolvedTranscriptScope,
  request: SessionResetBoundaryRequest,
  options: { cwd?: string } = {},
): number {
  const storedEvents = loadTranscriptEventsFromDatabase(database, scope.sessionId);
  const events = loadTranscriptEventsFromDatabase(database, scope.sessionId, {
    projection: "reset-boundary",
  });
  const event = buildSessionResetBoundaryEvent({
    events,
    ...request,
  });
  // Only physically empty transcripts need a header here. Reset-boundary
  // projection can hide existing rows, and a nonempty headerless transcript
  // must stay headerless so doctor can rewrite the header at seq 0.
  const batch =
    storedEvents.length === 0
      ? [createSessionTranscriptHeader({ cwd: options.cwd, sessionId: scope.sessionId }), event]
      : [event];
  const appended = appendTranscriptEventsInTransaction(database, scope, batch);
  if (appended !== batch.length) {
    throw new Error(`Failed to append reset boundary for ${scope.sessionKey}`);
  }
  return appended;
}

export function buildSessionResetBoundaryEvent(
  params: {
    events: readonly unknown[];
  } & SessionResetBoundaryRequest,
): SessionResetBoundaryEvent {
  const entries = params.events.filter(
    (event) =>
      event !== null &&
      typeof event === "object" &&
      !Array.isArray(event) &&
      (event as { type?: unknown }).type !== "session",
  );
  const activeEntries = selectSessionTranscriptLeafControlledPath(entries) ?? entries;
  const keptEntries =
    params.context === "preserve-tail"
      ? selectRecentUserAssistantReplayRecords(projectLatestBoundaryWindow(activeEntries))
      : [];
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
