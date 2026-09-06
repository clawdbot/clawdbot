import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { TranscriptDisplayPosition } from "../../chat/transcript-display-position.js";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { readNestedToolActivity } from "../../sessions/nested-tool-activity.js";
import {
  createTranscriptDisplayPosition,
  createTranscriptDisplaySource,
} from "../../sessions/transcript-display-position.js";
import {
  getActiveTranscriptKysely,
  readTranscriptProjectionGeneration,
  type CurrentTranscriptProjection,
} from "./session-accessor.sqlite-active-projection.js";
import type { TranscriptEvent } from "./session-accessor.sqlite-contract.js";
import { resolveSqliteSessionTranscriptReadFence } from "./session-transcript-read-fence.js";

export function readTranscriptDisplaySource(
  projection: CurrentTranscriptProjection,
): string | undefined {
  const generation = readTranscriptProjectionGeneration(projection);
  return generation
    ? createTranscriptDisplaySource([
        "sqlite",
        projection.database.path,
        projection.resolved.agentId,
        projection.resolved.sessionId,
        generation,
      ])
    : undefined;
}

/** Enrich only selected rows, in their existing snapshot; anchor lookups never load payloads. */
export function positionTranscriptDisplayEvents<
  T extends { event: TranscriptEvent; eventSeq: number },
>(
  projection: CurrentTranscriptProjection,
  source: string | undefined,
  events: T[],
): Array<T & { displayPosition?: TranscriptDisplayPosition }> {
  if (!source || events.length === 0) {
    return events;
  }
  const anchors = [
    ...new Set(
      events.flatMap(({ event }) => {
        const id = readNestedToolActivity(asOptionalRecord(event)?.message)?.details.afterEntryId;
        return typeof id === "string" ? [id] : [];
      }),
    ),
  ];
  const sequences = new Map<string, number>();
  const beforeRawSeq = resolveSqliteSessionTranscriptReadFence({
    database: projection.database,
    ...projection.resolved,
  })?.beforeRawSeq;
  const maxSeq = Math.min(
    projection.state.indexedSeq,
    beforeRawSeq === undefined ? Infinity : beforeRawSeq - 1,
  );
  const db = getActiveTranscriptKysely(projection.database);
  // Full-history readers can exceed SQLite's binding limit; each lookup stays below 999.
  for (let offset = 0; offset < anchors.length; offset += 500) {
    const rows = executeSqliteQuerySync(
      projection.database.db,
      db
        .selectFrom("transcript_event_identities")
        .select(["event_id", "seq"])
        .where("session_id", "=", projection.resolved.sessionId)
        .where("event_id", "in", anchors.slice(offset, offset + 500))
        .where("seq", "<=", maxSeq),
    ).rows;
    for (const row of rows) {
      sequences.set(row.event_id, row.seq);
    }
  }
  return events.map((row) => ({
    ...row,
    displayPosition: createTranscriptDisplayPosition(
      source,
      row.eventSeq,
      asOptionalRecord(row.event)?.message,
      (id) => sequences.get(id),
    ),
  }));
}
