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
import { resolveTranscriptBoundaryWindow } from "./session-accessor.sqlite-reset-window.js";
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
    const transcript = db
      .selectFrom("transcript_events")
      .where("session_id", "=", projection.resolved.sessionId);
    // Migrated transcripts may place a delivery mirror before the header or lack the auxiliary
    // identity rows entirely. Select the canonical stored event by type so runtime keeps its version.
    const header = executeSqliteQueryTakeFirstSync(
      projection.database.db,
      transcript
        .select("seq")
        .where(
          /* kysely-allow-raw: the canonical transcript event type is stored inside event_json. */
          sql<string>`json_extract(event_json, '$.type')`,
          "=",
          "session",
        )
        .orderBy("seq", "asc")
        .limit(1),
    );
    const headerBytes = header
      ? executeSqliteQueryTakeFirstSync(
          projection.database.db,
          transcript
            .select(
              /* kysely-allow-raw: reject an oversized header before acquiring its JSON payload. */
              sql<number>`OCTET_LENGTH(event_json) + 1`.as("serialized_bytes"),
            )
            .where("seq", "=", header.seq),
        )!.serialized_bytes
      : 0;
    if (headerBytes > maxBytes) {
      throw new RangeError("Session transcript header exceeds the active-context byte limit");
    }
    // Explicit reset retention wins over ordinary exclusion. The window owner
    // selects paired entries; only its newest candidates can fit this bounded read.
    const retained =
      resolveTranscriptBoundaryWindow(
        projection,
        "context",
        fence?.beforeRawSeq,
      )?.keptMessagePositions.slice(-(maxEvents + 1)) ?? [];
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
          "active.event_seq",
          /* kysely-allow-raw: active-context byte caps exclude rows before fetching or parsing. */
          sql<number>`OCTET_LENGTH(event.event_json) + 1`.as("serialized_bytes"),
        ])
        .where("active.session_id", "=", projection.resolved.sessionId)
        .$if(fence !== undefined, (query) =>
          query.where("active.event_seq", "<", fence!.beforeRawSeq),
        )
        .where((eb) =>
          retained.length > 0
            ? eb.or([
                eb("active.context_eligible", "=", 1),
                eb("active.message_position", "in", retained),
              ])
            : eb("active.context_eligible", "=", 1),
        )
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
    const boundary = executeSqliteQueryTakeFirstSync(
      projection.database.db,
      db
        .selectFrom(
          db
            .selectFrom("transcript_event_identities as identity")
            .innerJoin("session_transcript_active_events as active", (join) =>
              join
                .onRef("active.session_id", "=", "identity.session_id")
                .onRef("active.event_seq", "=", "identity.seq"),
            )
            .select((eb) => [
              "identity.seq",
              eb.fn.count<number>("identity.seq").over().as("boundary_count"),
            ])
            .where("identity.session_id", "=", projection.resolved.sessionId)
            .where("identity.event_type", "in", ["compaction", "reset"])
            .$if(fence !== undefined, (query) =>
              query.where("identity.seq", "<", fence!.beforeRawSeq),
            )
            .orderBy("active.active_position", "desc")
            .limit(1)
            .as("boundary"),
        )
        .innerJoin("transcript_events as event", (join) =>
          join
            .on("event.session_id", "=", projection.resolved.sessionId)
            .onRef("event.seq", "=", "boundary.seq"),
        )
        .select([
          "boundary.seq",
          "boundary.boundary_count",
          /* kysely-allow-raw: count boundaries without carrying payloads through the window query. */
          sql<number>`OCTET_LENGTH(event.event_json) + 1`.as("serialized_bytes"),
        ]),
    );
    const contextSequences = selectedSequences.toSorted((left, right) => left - right);
    let injectedBoundarySeq: number | undefined;
    let boundaryOmitted = false;
    if (boundary && !selectedSequences.includes(boundary.seq)) {
      if (serializedBytes + boundary.serialized_bytes <= maxBytes) {
        injectedBoundarySeq = boundary.seq;
        contextSequences.unshift(boundary.seq);
        serializedBytes += boundary.serialized_bytes;
      } else {
        boundaryOmitted = true;
      }
    }
    const payloadSequences = header ? [header.seq, ...contextSequences] : contextSequences;
    // One payload read follows all byte decisions; header-first ordering also supports migrated mirrors.
    const payloads = new Map<number, TranscriptEvent>(
      (payloadSequences.length === 0
        ? []
        : executeSqliteQuerySync(
            projection.database.db,
            transcript.select(["seq", "event_json"]).where("seq", "in", payloadSequences),
          ).rows
      ).map((row) => [row.seq, JSON.parse(row.event_json)]),
    );
    const events: TranscriptEvent[] = header ? [payloads.get(header.seq)!] : [];
    const rows = contextSequences.map((seq) => ({ event: payloads.get(seq)!, seq }));
    const opaqueParents = new Map<string, string | null>();
    let previousId: unknown;
    for (const { event, seq } of rows) {
      const entry = asOptionalRecord(event);
      if (seq === injectedBoundarySeq) {
        previousId = entry?.id;
      } else if (entry && "id" in entry && "parentId" in entry) {
        // Omitted display payloads retain an opaque ancestry link, never a fabricated event.
        if (
          typeof previousId === "string" &&
          typeof entry.parentId === "string" &&
          entry.parentId !== previousId
        ) {
          opaqueParents.set(entry.parentId, previousId);
        }
        previousId = entry.id;
      }
      events.push(event);
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
      boundaryCount: boundary?.boundary_count ?? 0,
      events,
      serializedBytes,
      totalEvents: projection.state.activeEventCount,
      truncated: boundaryOmitted || metadata.length > selectedSequences.length,
    };
  });
}
