import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { sql } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import {
  getActiveTranscriptKysely,
  withCurrentProjectionSnapshot,
  type CurrentTranscriptProjection,
} from "./session-accessor.sqlite-active-projection.js";
import type {
  SessionTranscriptReadScope,
  TranscriptEvent,
} from "./session-accessor.sqlite-contract.js";
import {
  DEFAULT_VISIBLE_MESSAGE_MAX_BYTES,
  DEFAULT_VISIBLE_MESSAGE_MAX_MESSAGES,
  MAX_VISIBLE_MESSAGE_MAX_BYTES,
  MAX_VISIBLE_MESSAGE_MAX_MESSAGES,
  normalizeVisibleMessageLimit,
} from "./session-accessor.sqlite-visible-cursor.js";
import { resolveSqliteSessionTranscriptReadFence } from "./session-transcript-read-fence.js";

export type SessionTranscriptBoundedActiveContext = {
  activeLeafEntryId: string | null;
  opaqueParents: Map<string, string | null>;
  firstKeptRanges: Map<string, { startIndex: number; endIndex: number }>;
  boundaryCount: number;
  events: TranscriptEvent[];
  serializedBytes: number;
  totalEvents: number;
  truncated: boolean;
};

function readBoundedRetentionRanges(
  projection: CurrentTranscriptProjection,
  rows: Array<{ event: TranscriptEvent; seq: number }>,
  headerOffset: number,
): SessionTranscriptBoundedActiveContext["firstKeptRanges"] {
  const sequences = new Map<string, number>();
  const cuts = rows.flatMap(({ event, seq }, endIndex) => {
    const entry = asOptionalRecord(event);
    if (typeof entry?.id !== "string") {
      return [];
    }
    sequences.set(entry.id, seq);
    return (entry.type === "compaction" || entry.type === "reset") &&
      typeof entry.firstKeptEntryId === "string"
      ? [{ id: entry.id, firstKeptEntryId: entry.firstKeptEntryId, endIndex }]
      : [];
  });
  const missing = [...new Set(cuts.map((cut) => cut.firstKeptEntryId))].filter(
    (id) => !sequences.has(id),
  );
  if (missing.length > 0) {
    const lastSelectedSeq = Math.max(...rows.map((row) => row.seq));
    const db = getActiveTranscriptKysely(projection.database);
    const anchors = executeSqliteQuerySync(
      projection.database.db,
      db
        .selectFrom("transcript_event_identities as identity")
        .innerJoin("session_transcript_active_events as active", (join) =>
          join
            .onRef("active.session_id", "=", "identity.session_id")
            .onRef("active.event_seq", "=", "identity.seq"),
        )
        .select(["identity.event_id", "identity.seq"])
        .where("identity.session_id", "=", projection.resolved.sessionId)
        .where("identity.event_id", "in", missing)
        .where("identity.seq", "<=", lastSelectedSeq),
    ).rows;
    for (const anchor of anchors) {
      sequences.set(anchor.event_id, anchor.seq);
    }
  }
  const ranges: SessionTranscriptBoundedActiveContext["firstKeptRanges"] = new Map();
  for (const cut of cuts) {
    const firstSeq = sequences.get(cut.firstKeptEntryId);
    if (firstSeq === undefined) {
      continue;
    }
    const start = rows.findIndex(({ seq }, index) => index < cut.endIndex && seq >= firstSeq);
    ranges.set(cut.id, {
      startIndex: (start < 0 ? cut.endIndex : start) + headerOffset,
      endIndex: cut.endIndex + headerOffset,
    });
  }
  return ranges;
}

/** Reads one byte-bounded active branch without materializing abandoned transcript history. */
export function readSessionTranscriptBoundedActiveContextCore(
  scope: SessionTranscriptReadScope,
  options: { maxBytes: number; maxEvents: number },
): SessionTranscriptBoundedActiveContext {
  const maxBytes = normalizeVisibleMessageLimit(
    options.maxBytes,
    DEFAULT_VISIBLE_MESSAGE_MAX_BYTES,
    MAX_VISIBLE_MESSAGE_MAX_BYTES,
    "maxBytes",
  );
  const maxEvents = normalizeVisibleMessageLimit(
    options.maxEvents,
    DEFAULT_VISIBLE_MESSAGE_MAX_MESSAGES,
    MAX_VISIBLE_MESSAGE_MAX_MESSAGES,
    "maxEvents",
  );
  return withCurrentProjectionSnapshot(scope, (projection) => {
    const db = getActiveTranscriptKysely(projection.database);
    const fence = resolveSqliteSessionTranscriptReadFence({
      database: projection.database,
      ...projection.resolved,
    });
    // Migrated transcripts may place a delivery mirror before the header or lack the auxiliary
    // identity rows entirely. Select the canonical stored event by type so runtime keeps its version.
    const header = executeSqliteQueryTakeFirstSync(
      projection.database.db,
      db
        .selectFrom("transcript_events")
        .select("event_json")
        .where("session_id", "=", projection.resolved.sessionId)
        .where(
          /* kysely-allow-raw: the canonical transcript event type is stored inside event_json. */
          sql<string>`json_extract(event_json, '$.type')`,
          "=",
          "session",
        )
        .orderBy("seq", "asc")
        .limit(1),
    );
    const headerBytes = header ? Buffer.byteLength(header.event_json, "utf8") + 1 : 0;
    if (headerBytes > maxBytes) {
      throw new RangeError("Session transcript header exceeds the active-context byte limit");
    }
    const metadata = executeSqliteQuerySync(
      projection.database.db,
      db
        .selectFrom("session_transcript_active_events as active")
        .innerJoin("transcript_events as event", (join) =>
          join
            .onRef("event.session_id", "=", "active.session_id")
            .onRef("event.seq", "=", "active.event_seq"),
        )
        .select([
          "active.active_position",
          "active.event_seq",
          /* kysely-allow-raw: active-context byte caps exclude rows before fetching or parsing. */
          sql<number>`OCTET_LENGTH(event.event_json) + 1`.as("serialized_bytes"),
        ])
        .where("active.session_id", "=", projection.resolved.sessionId)
        .$if(fence !== undefined, (query) =>
          query.where("active.event_seq", "<", fence!.beforeRawSeq),
        )
        .where("active.context_eligible", "=", 1)
        .orderBy("active.active_position", "desc")
        .limit(maxEvents + 1),
    ).rows;
    const selectedSequences: number[] = [];
    let serializedBytes = headerBytes;
    for (const row of metadata) {
      if (
        selectedSequences.length >= maxEvents ||
        serializedBytes + row.serialized_bytes > maxBytes
      ) {
        break;
      }
      selectedSequences.push(row.event_seq);
      serializedBytes += row.serialized_bytes;
    }
    const selectedRows =
      selectedSequences.length === 0
        ? []
        : executeSqliteQuerySync(
            projection.database.db,
            db
              .selectFrom("transcript_events")
              .select(["event_json", "seq"])
              .where("session_id", "=", projection.resolved.sessionId)
              .where("seq", "in", selectedSequences)
              .orderBy("seq", "asc"),
          ).rows;
    const boundary = executeSqliteQueryTakeFirstSync(
      projection.database.db,
      db
        .selectFrom("transcript_event_identities as identity")
        .innerJoin("session_transcript_active_events as active", (join) =>
          join
            .onRef("active.session_id", "=", "identity.session_id")
            .onRef("active.event_seq", "=", "identity.seq"),
        )
        .innerJoin("transcript_events as event", (join) =>
          join
            .onRef("event.session_id", "=", "identity.session_id")
            .onRef("event.seq", "=", "identity.seq"),
        )
        .select(["event.event_json", "identity.seq"])
        .where("identity.session_id", "=", projection.resolved.sessionId)
        .where("identity.event_type", "in", ["compaction", "reset"])
        .$if(fence !== undefined, (query) => query.where("identity.seq", "<", fence!.beforeRawSeq))
        .orderBy("active.active_position", "desc")
        .limit(1),
    );
    const boundaryCount = executeSqliteQueryTakeFirstSync(
      projection.database.db,
      db
        .selectFrom("transcript_event_identities as identity")
        .innerJoin("session_transcript_active_events as active", (join) =>
          join
            .onRef("active.session_id", "=", "identity.session_id")
            .onRef("active.event_seq", "=", "identity.seq"),
        )
        .select((eb) => eb.fn.count<number>("identity.seq").as("boundary_count"))
        .where("identity.session_id", "=", projection.resolved.sessionId)
        .where("identity.event_type", "in", ["compaction", "reset"])
        .$if(fence !== undefined, (query) => query.where("identity.seq", "<", fence!.beforeRawSeq)),
    )?.boundary_count;
    const events: TranscriptEvent[] = header ? [JSON.parse(header.event_json)] : [];
    const rows: Array<{ event: TranscriptEvent; seq: number }> = [];
    let injectedBoundary: { id?: unknown } | undefined;
    let boundaryOmitted = false;
    if (boundary && !selectedSequences.includes(boundary.seq)) {
      const boundaryBytes = Buffer.byteLength(boundary.event_json, "utf8") + 1;
      if (serializedBytes + boundaryBytes <= maxBytes) {
        const event: TranscriptEvent = JSON.parse(boundary.event_json);
        events.push(event);
        rows.push({ event, seq: boundary.seq });
        if (event !== null && typeof event === "object" && "id" in event) {
          injectedBoundary = event;
        }
        serializedBytes += boundaryBytes;
      } else {
        boundaryOmitted = true;
      }
    }
    const opaqueParents = new Map<string, string | null>();
    let previousId = injectedBoundary?.id;
    for (const row of selectedRows) {
      const event: TranscriptEvent = JSON.parse(row.event_json);
      if (event !== null && typeof event === "object" && "id" in event && "parentId" in event) {
        // Omitted display payloads retain an opaque ancestry link, never a fabricated event.
        if (
          typeof previousId === "string" &&
          typeof event.parentId === "string" &&
          event.parentId !== previousId
        ) {
          opaqueParents.set(event.parentId, previousId);
        }
        previousId = event.id;
      }
      events.push(event);
      rows.push({ event, seq: row.seq });
    }
    const activeLeafEntryId = fence
      ? fence.admission.effectiveParentId
      : projection.state.leafEventId;
    if (activeLeafEntryId && previousId !== activeLeafEntryId) {
      opaqueParents.set(activeLeafEntryId, typeof previousId === "string" ? previousId : null);
    }
    // Retention moves forward from a cut; append ancestry moves backward. Keep both
    // outside the byte-counted events so excluded payloads cannot change either boundary.
    const firstKeptRanges = readBoundedRetentionRanges(projection, rows, header ? 1 : 0);
    return {
      activeLeafEntryId,
      opaqueParents,
      firstKeptRanges,
      boundaryCount: boundaryCount ?? 0,
      events,
      serializedBytes,
      totalEvents: projection.state.activeEventCount,
      truncated: boundaryOmitted || metadata.length > selectedSequences.length,
    };
  });
}
