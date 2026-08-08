import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  DEFAULT_REPLAY_MAX_MESSAGES,
  replayableTranscriptRole,
  selectRecentUserAssistantReplayRecords,
} from "./transcript-replay.js";
import { streamSessionTranscriptLinesReverse } from "./transcript-stream.js";
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

export type SessionResetBoundaryPlan = {
  event: SessionResetBoundaryEvent;
  seedEvents: unknown[];
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

function buildSessionResetBoundaryEvent(params: {
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

async function readLegacyTranscriptEvents(sessionFile: string | undefined): Promise<unknown[]> {
  const filePath = sessionFile?.trim();
  if (!filePath || !path.isAbsolute(filePath) || !filePath.endsWith(".jsonl")) {
    return [];
  }
  try {
    const newestFirst: unknown[] = [];
    let boundaryFirstKeptEntryId: string | undefined;
    let foundBoundary = false;
    for await (const line of streamSessionTranscriptLinesReverse(filePath)) {
      let record: unknown;
      try {
        record = JSON.parse(line) as unknown;
      } catch {
        continue;
      }
      const type =
        record && typeof record === "object" && !Array.isArray(record)
          ? (record as { type?: unknown }).type
          : undefined;
      if (!foundBoundary && (type === "reset" || type === "compaction")) {
        foundBoundary = true;
        const firstKept = (record as { firstKeptEntryId?: unknown }).firstKeptEntryId;
        boundaryFirstKeptEntryId =
          typeof firstKept === "string" && firstKept.trim() ? firstKept : undefined;
        if (!boundaryFirstKeptEntryId) {
          break;
        }
        continue;
      }
      if (foundBoundary && (type === "reset" || type === "compaction")) {
        break;
      }
      if (replayableTranscriptRole(record as Parameters<typeof replayableTranscriptRole>[0])) {
        newestFirst.push(record);
      }
      if (
        newestFirst.length >= DEFAULT_REPLAY_MAX_MESSAGES ||
        (foundBoundary && recordId(record) === boundaryFirstKeptEntryId)
      ) {
        break;
      }
    }
    const selected = selectRecentUserAssistantReplayRecords(newestFirst.toReversed());
    return selected.map((record, index) =>
      Object.assign({}, record as Record<string, unknown>, {
        parentId: index === 0 ? null : (recordId(selected[index - 1]) ?? null),
      }),
    );
  } catch {
    return [];
  }
}

export async function buildSessionResetBoundaryPlan(params: {
  events: readonly unknown[];
  legacySessionFile?: string;
  reason: SessionResetBoundaryReason;
}): Promise<SessionResetBoundaryPlan> {
  const hasConversationEvents = params.events.some((event) => {
    const type =
      event !== null && typeof event === "object" && !Array.isArray(event)
        ? (event as { type?: unknown }).type
        : undefined;
    return type === "message" || type === "compaction" || type === "reset";
  });
  const legacyEvents = hasConversationEvents
    ? []
    : await readLegacyTranscriptEvents(params.legacySessionFile);
  const seedEvents = legacyEvents.filter(
    (event) =>
      event !== null &&
      typeof event === "object" &&
      !Array.isArray(event) &&
      (event as { type?: unknown }).type !== "session",
  );
  const events = seedEvents.length > 0 ? [...params.events, ...seedEvents] : params.events;
  return {
    event: buildSessionResetBoundaryEvent({ events, reason: params.reason }),
    seedEvents,
  };
}
