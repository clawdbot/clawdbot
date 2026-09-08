import type { DatabaseSync } from "node:sqlite";
import { parseDateStringTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { expressionBuilder, type Expression, type SqlBool } from "kysely";
import {
  TRANSCRIPTS_EXPORT_MAX_BYTES,
  TRANSCRIPTS_LEGACY_MAX_UTTERANCES,
  TRANSCRIPTS_PAGE_DEFAULT,
  TRANSCRIPTS_PAGE_MAX,
  TRANSCRIPTS_LIST_MAX,
  TRANSCRIPTS_RESULT_MAX_BYTES,
  type TranscriptUtterance,
  type TranscriptsListParams,
} from "../../packages/gateway-protocol/src/schema/transcripts.js";
import { executeSqliteQueryTakeFirstSync, iterateSqliteQuerySync } from "../infra/kysely-sync.js";
import type { TranscriptSessionDescriptor } from "./provider-types.js";
import {
  meetingTranscriptDb,
  type meetingTranscriptSessionQuery,
  meetingTranscriptUtteranceQuery,
  sessionFromRow,
} from "./store-sqlite.js";
import type { TranscriptsSummary } from "./summary.js";

export class TranscriptLibraryError extends Error {
  constructor(
    readonly type:
      | "transcript_invalid_cursor"
      | "transcript_invalid_filter"
      | "transcript_session_not_found"
      | "transcript_result_too_large"
      | "transcript_export_too_large",
    message: string,
    readonly maxBytes?: number,
  ) {
    super(message);
  }
}

function transcriptPageLimit(limit = TRANSCRIPTS_PAGE_DEFAULT, max = TRANSCRIPTS_PAGE_MAX): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > max) {
    throw new TranscriptLibraryError(
      "transcript_invalid_filter",
      `Transcript page limit must be between 1 and ${max}.`,
    );
  }
  return limit;
}

export function assertTranscriptByteLimit(
  text: string,
  maxBytes = TRANSCRIPTS_RESULT_MAX_BYTES,
  exporting = false,
): void {
  assertTranscriptByteCount(Buffer.byteLength(text, "utf8"), maxBytes, exporting);
}

export function assertTranscriptByteCount(
  bytes: number,
  maxBytes = TRANSCRIPTS_RESULT_MAX_BYTES,
  exporting = false,
): void {
  if (bytes > maxBytes) {
    throw new TranscriptLibraryError(
      exporting ? "transcript_export_too_large" : "transcript_result_too_large",
      exporting
        ? "Transcript exceeds the download limit; use a local transcript export."
        : "Transcript response exceeds the read limit; request a smaller page or use a local transcript export.",
      maxBytes,
    );
  }
}

export type TranscriptReadPurpose = "page" | "export" | "legacy";

function byteLimit(purpose: TranscriptReadPurpose) {
  // The shipped unpaged reader bounded rows and projected text, not raw stored
  // inputs. Its public result budget is enforced after projection in library.ts.
  return purpose === "legacy"
    ? undefined
    : purpose === "export"
      ? TRANSCRIPTS_EXPORT_MAX_BYTES
      : TRANSCRIPTS_RESULT_MAX_BYTES;
}

function assertReadBytes(bytes: number, purpose: TranscriptReadPurpose) {
  const maxBytes = byteLimit(purpose);
  if (maxBytes !== undefined) {
    assertTranscriptByteCount(bytes, maxBytes, purpose === "export");
  }
}

function textBytes(...values: Expression<unknown>[]) {
  const eb = expressionBuilder();
  const bytes = values.reduce<Expression<number>>(
    (sum, value) => eb(sum, "+", eb.fn.coalesce(eb.fn<number>("octet_length", [value]), eb.val(0))),
    eb.val(0),
  );
  return eb.parens(bytes);
}

function boundedText<T extends string | null>(
  value: Expression<T>,
  bytes: Expression<number>,
  maxBytes: number | undefined,
) {
  if (maxBytes === undefined) {
    return expressionBuilder().parens(value);
  }
  // CASE pairs the size decision with its payload in one statement. The empty
  // branch preserves the row; callers reject its byte count before decoding.
  return expressionBuilder().case().when(bytes, "<=", maxBytes).then(value).else("").end();
}

function readQuery(
  query: ReturnType<typeof meetingTranscriptSessionQuery>,
  purpose: TranscriptReadPurpose = "page",
) {
  return query.select((eb) => {
    const notes = eb
      .selectFrom("meeting_transcript_summaries as notes")
      .whereRef("notes.session_id", "=", "meeting_transcript_sessions.session_id")
      .whereRef("notes.session_started_at", "=", "meeting_transcript_sessions.started_at");
    const overview = notes
      .select((n) =>
        n
          .fn<string | null>("json_extract", [n.ref("notes.summary_json"), n.val("$.overview")])
          .as("overview"),
      )
      .$asScalar();
    const summarySource = notes
      .select((n) =>
        n
          .fn<string | null>("json_extract", [n.ref("notes.summary_json"), n.val("$.source")])
          .as("source"),
      )
      .$asScalar();
    const utterances = eb
      .selectFrom("meeting_transcript_utterances as u")
      .whereRef("u.session_id", "=", "meeting_transcript_sessions.session_id")
      .whereRef("u.session_started_at", "=", "meeting_transcript_sessions.started_at");
    // Group and order in SQLite. The aggregate is byte-checked in this statement
    // before any participant strings cross into JavaScript.
    const speakers = utterances
      .select("u.speaker_label")
      .where("u.speaker_label", "is not", null)
      .where("u.speaker_label", "!=", "")
      .groupBy("u.speaker_label")
      .orderBy((u) => u.fn.min("u.sequence"), "asc");
    const participants = eb
      .selectFrom(speakers.as("speakers"))
      .select((s) =>
        s.fn<string>("json_group_array", [s.ref("speakers.speaker_label")]).as("participants"),
      )
      .$asScalar();
    const lastAt = eb
      .selectFrom("meeting_transcript_utterances as u")
      .select((u) => u.fn.coalesce("u.ended_at", "u.started_at").as("at"))
      .whereRef("u.session_id", "=", "meeting_transcript_sessions.session_id")
      .whereRef("u.session_started_at", "=", "meeting_transcript_sessions.started_at")
      .orderBy("u.sequence", "desc")
      .limit(1)
      .$asScalar();
    const identityBytes = textBytes(eb.ref("session_id"), eb.ref("started_at"), eb.ref("selector"));
    const bytes = textBytes(
      eb.ref("session_id"),
      eb.ref("started_at"),
      eb.ref("selector"),
      eb.ref("source_json"),
      eb.ref("metadata_json"),
      eb.ref("title"),
      eb.ref("stopped_at"),
      lastAt,
      overview,
      summarySource,
      participants,
    );
    const maxBytes = byteLimit(purpose);
    return [
      boundedText(eb.ref("session_id"), identityBytes, maxBytes).as("session_id"),
      boundedText(eb.ref("started_at"), identityBytes, maxBytes).as("started_at"),
      boundedText(eb.ref("selector"), identityBytes, maxBytes).as("selector"),
      boundedText(eb.ref("source_json"), bytes, maxBytes).as("source_json"),
      boundedText(eb.ref("metadata_json"), bytes, maxBytes).as("metadata_json"),
      boundedText(eb.ref("title"), bytes, maxBytes).as("title"),
      boundedText(eb.ref("stopped_at"), bytes, maxBytes).as("stopped_at"),
      boundedText(lastAt, bytes, maxBytes).as("last_utterance_at"),
      boundedText(overview, bytes, maxBytes).as("overview"),
      boundedText(summarySource, bytes, maxBytes).as("summary_source"),
      boundedText(participants, bytes, maxBytes).as("participants_json"),
      bytes.as("payload_bytes"),
      identityBytes.as("identity_bytes"),
      utterances
        .select((u) => u.fn.countAll<number>().as("count"))
        .$asScalar()
        .as("utterance_count"),
      "updated_at_ms",
      eb
        .exists(
          eb
            .selectFrom("meeting_transcript_summaries as summary")
            .select("summary.session_id")
            .whereRef("summary.session_id", "=", "meeting_transcript_sessions.session_id")
            .whereRef("summary.session_started_at", "=", "meeting_transcript_sessions.started_at"),
        )
        .as("has_summary"),
    ];
  });
}

type TranscriptReadRow = Awaited<
  ReturnType<ReturnType<typeof readQuery>["executeTakeFirstOrThrow"]>
>;

function transcriptReadEntryFromRow(
  row: TranscriptReadRow,
  purpose: TranscriptReadPurpose = "page",
) {
  assertReadBytes(row.payload_bytes, purpose);
  const session = sessionFromRow(row);
  const summarySource: TranscriptsSummary["source"] | undefined =
    row.summary_source === "model" || row.summary_source === "heuristic"
      ? row.summary_source
      : undefined;
  return {
    session,
    // Doctor owns historical selector repair; reads return the handle that actually resolves.
    selector: row.selector,
    hasSummary: Boolean(row.has_summary),
    utteranceCount: row.utterance_count,
    // SAFETY: readQuery aggregates only non-null STRICT TEXT speaker labels into a JSON array.
    participants: JSON.parse(row.participants_json ?? "[]") as string[],
    overview: typeof row.overview === "string" ? row.overview : undefined,
    summarySource,
    updatedAt: new Date(row.updated_at_ms).toISOString(),
    lastUtteranceAt: row.last_utterance_at ?? null,
  };
}

export type TranscriptReadEntry = ReturnType<typeof transcriptReadEntryFromRow>;
export type TranscriptReadOptions = Omit<TranscriptsListParams, "cursor"> & {
  after?: { startedAt: string; sessionId: string };
  offset?: number;
  session?: Pick<TranscriptSessionDescriptor, "sessionId" | "startedAt">;
};

const dateReaders = new WeakSet<DatabaseSync>();

function registerTranscriptDateReader(database: DatabaseSync): void {
  if (dateReaders.has(database)) {
    return;
  }
  // Canonical database reopen creates a new handle. Date parsing is not
  // deterministic because timezone-free strings depend on the process timezone.
  database.function(
    "openclaw_transcript_date_ms",
    (value) => parseDateStringTimestampMs(value) ?? null,
  );
  dateReaders.add(database);
}

function transcriptStartTime(startedAt: Expression<string>) {
  const eb = expressionBuilder();
  // Bound the native-to-JavaScript argument before invoking the parser.
  return eb
    .case()
    .when(eb.fn<number>("octet_length", [startedAt]), "<=", TRANSCRIPTS_RESULT_MAX_BYTES)
    .then(eb.fn<number | null>("openclaw_transcript_date_ms", [startedAt]))
    .end();
}

/** Chronological key selection scans candidates; filters never turn into ownership. */
export function* iterateTranscriptReadEntries(
  database: DatabaseSync,
  options: TranscriptReadOptions,
): Generator<TranscriptReadEntry, boolean> {
  const limit = transcriptPageLimit(options.limit, TRANSCRIPTS_LIST_MAX);
  registerTranscriptDateReader(database);
  let query = meetingTranscriptDb(database).selectFrom("meeting_transcript_sessions");
  if (options.session) {
    query = query
      .where("session_id", "=", options.session.sessionId)
      .where("started_at", "=", options.session.startedAt);
  }
  if (options.offset !== undefined) {
    query = query.offset(options.offset);
  }
  if (options.providerId) {
    query = query.where("provider_id", "=", options.providerId);
  }
  if (options.accountId) {
    const accountId = options.accountId;
    query = query.where((eb) =>
      eb(
        eb.fn<string>("json_extract", [eb.ref("source_json"), eb.val("$.accountId")]),
        "=",
        accountId,
      ),
    );
  }
  if (options.agentId) {
    const agentId = options.agentId;
    query = query.where((eb) =>
      eb(
        eb.fn<string>("json_extract", [eb.ref("metadata_json"), eb.val("$.agentId")]),
        "=",
        agentId,
      ),
    );
  }
  if (options.startedAfter) {
    const startedAfter = parseDateStringTimestampMs(options.startedAfter) ?? null;
    query = query.where((eb) => eb(transcriptStartTime(eb.ref("started_at")), ">=", startedAfter));
  }
  if (options.startedBefore) {
    const startedBefore = parseDateStringTimestampMs(options.startedBefore) ?? null;
    query = query.where((eb) => eb(transcriptStartTime(eb.ref("started_at")), "<", startedBefore));
  }
  if (options.after) {
    const after = options.after;
    const afterTime = parseDateStringTimestampMs(after.startedAt);
    query = query.where((eb) => {
      const time = transcriptStartTime(eb.ref("started_at"));
      const afterIdentity = eb(
        eb.refTuple("session_id", "started_at"),
        ">",
        eb.tuple(after.sessionId, after.startedAt),
      );
      return afterTime === undefined
        ? eb.and([eb(time, "is", null), afterIdentity])
        : eb.or([
            eb(time, "<", afterTime),
            eb(time, "is", null),
            eb.and([eb(time, "=", afterTime), afterIdentity]),
          ]);
    });
  }
  if (options.query) {
    const search = options.query;
    query = query.where((eb) => {
      const fields = [
        eb.ref("title"),
        eb.ref("session_id"),
        eb.ref("provider_id"),
        // Raw meeting URLs can contain credentials or tokens hidden by the public
        // projection. Search must not expose those values through result membership.
        ...["accountId", "guildId", "channelId", "threadTs", "fileId"].map((key) =>
          eb.fn<string>("json_extract", [eb.ref("source_json"), eb.val(`$.${key}`)]),
        ),
      ];
      return eb.or(
        fields.map((field): Expression<SqlBool> =>
          eb(
            eb.fn<number>("instr", [eb.fn("lower", [field]), eb.fn("lower", [eb.val(search)])]),
            ">",
            0,
          ),
        ),
      );
    });
  }
  const keys = query
    .select(["session_id", "started_at"])
    .orderBy((eb) => transcriptStartTime(eb.ref("started_at")), "desc")
    .orderBy("session_id", "asc")
    .orderBy("started_at", "asc")
    .limit(limit + 1);
  // Select identities before projecting notes and participants, so the scan
  // evaluates expensive payloads only for this page and its lookahead.
  const rows = iterateSqliteQuerySync(
    database,
    readQuery(
      meetingTranscriptDb(database)
        .selectFrom("meeting_transcript_sessions")
        .where((eb) =>
          eb(
            eb.refTuple("session_id", "started_at"),
            "in",
            keys.$asTuple("session_id", "started_at"),
          ),
        ),
    )
      .orderBy(
        (eb) => transcriptStartTime(eb.ref("meeting_transcript_sessions.started_at")),
        "desc",
      )
      .orderBy("meeting_transcript_sessions.session_id", "asc")
      .orderBy("meeting_transcript_sessions.started_at", "asc"),
  );
  let count = 0;
  for (const row of rows) {
    // Lookahead establishes presence only, even when its payload exceeds the cap.
    if (count++ === limit) {
      return true;
    }
    yield transcriptReadEntryFromRow(row);
  }
  return false;
}

/** Selectors are unique; identity and payload bounds remain in the same SQLite statement. */
export function readTranscriptEntry(
  database: DatabaseSync,
  selector: string,
  purpose: TranscriptReadPurpose = "page",
) {
  const row = executeSqliteQueryTakeFirstSync(
    database,
    readQuery(
      meetingTranscriptDb(database)
        .selectFrom("meeting_transcript_sessions")
        .where("selector", "=", selector),
      purpose,
    ),
  );
  if (!row) {
    return undefined;
  }
  assertReadBytes(row.identity_bytes, purpose);
  return row.selector === selector ? transcriptReadEntryFromRow(row, purpose) : undefined;
}

export function readLatestTranscriptEntry(database: DatabaseSync) {
  const row = executeSqliteQueryTakeFirstSync(
    database,
    readQuery(meetingTranscriptDb(database).selectFrom("meeting_transcript_sessions"))
      .where("next_utterance_seq", ">", 0)
      .orderBy("updated_at_ms", "desc")
      .orderBy("meeting_transcript_sessions.started_at", "desc")
      .orderBy("meeting_transcript_sessions.session_id", "asc")
      .limit(1),
  );
  return row ? transcriptReadEntryFromRow(row) : undefined;
}

export function queryTranscriptReadEntries(database: DatabaseSync, options: TranscriptReadOptions) {
  const entries: TranscriptReadEntry[] = [];
  let bytes = 0;
  for (const entry of iterateTranscriptReadEntries(database, options)) {
    // Reads need attribution, while provider authorization uses the unchanged source.
    const agentId = entry.session.metadata?.agentId;
    entry.session.metadata = typeof agentId === "string" ? { agentId } : undefined;
    bytes += Buffer.byteLength(JSON.stringify(entry), "utf8");
    assertTranscriptByteCount(bytes);
    entries.push(entry);
  }
  return entries;
}

function utteranceQuery(
  database: DatabaseSync,
  session: TranscriptSessionDescriptor,
  purpose: TranscriptReadPurpose,
) {
  return meetingTranscriptUtteranceQuery(database, session).select((eb) => {
    const maxBytes = byteLimit(purpose);
    const utteranceId = purpose === "legacy" ? eb.val(null) : eb.ref("utterance_id");
    const bytes = textBytes(
      utteranceId,
      eb.ref("started_at"),
      eb.ref("ended_at"),
      eb.ref("speaker_id"),
      eb.ref("speaker_label"),
      eb.ref("text"),
    );
    return [
      boundedText(utteranceId, bytes, maxBytes).as("utterance_id"),
      boundedText(eb.ref("started_at"), bytes, maxBytes).as("started_at"),
      boundedText(eb.ref("ended_at"), bytes, maxBytes).as("ended_at"),
      boundedText(eb.ref("speaker_id"), bytes, maxBytes).as("speaker_id"),
      boundedText(eb.ref("speaker_label"), bytes, maxBytes).as("speaker_label"),
      boundedText(eb.ref("text"), bytes, maxBytes).as("text"),
      bytes.as("payload_bytes"),
      "sequence",
      "final",
    ];
  });
}

function transcriptReadUtteranceFromRow(
  row: Awaited<ReturnType<ReturnType<typeof utteranceQuery>["executeTakeFirstOrThrow"]>>,
): TranscriptUtterance {
  return {
    sequence: row.sequence,
    id: row.utterance_id ?? undefined,
    startedAt: row.started_at ?? undefined,
    endedAt: row.ended_at ?? undefined,
    speakerId: row.speaker_id ?? undefined,
    speakerLabel: row.speaker_label ?? undefined,
    text: row.text,
    final: row.final === null ? undefined : row.final === 1,
  };
}

export function readTranscriptUtterancePage(
  database: DatabaseSync,
  session: TranscriptSessionDescriptor,
  options: { limit?: number; after?: number; query?: string },
  purpose: "page" | "legacy" = "page",
) {
  const recent = purpose === "legacy";
  const limit = recent ? TRANSCRIPTS_LEGACY_MAX_UTTERANCES : transcriptPageLimit(options.limit);
  let query = utteranceQuery(database, session, purpose);
  if (options.after !== undefined) {
    query = query.where("sequence", ">", options.after);
  }
  if (options.query) {
    const search = options.query;
    query = query.where((eb) =>
      eb(
        eb.fn<number>("instr", [
          eb.fn("lower", [eb.ref("text")]),
          eb.fn("lower", [eb.val(search)]),
        ]),
        ">",
        0,
      ),
    );
  }
  const rows = iterateSqliteQuerySync(
    database,
    query.orderBy("sequence", recent ? "desc" : "asc").limit(recent ? limit : limit + 1),
  );
  const utterances: TranscriptUtterance[] = [];
  let bytes = 0;
  for (const row of rows) {
    if (utterances.length === limit) {
      return { utterances, hasMore: true };
    }
    bytes += row.payload_bytes;
    assertReadBytes(bytes, purpose);
    utterances.push(transcriptReadUtteranceFromRow(row));
  }
  return { utterances: recent ? utterances.toReversed() : utterances, hasMore: false };
}

/** Omit the duplicated transcript inside SQLite before materializing the stored summary. */
export function readStoredTranscriptNotes(
  database: DatabaseSync,
  session: TranscriptSessionDescriptor,
  purpose: TranscriptReadPurpose = "page",
): { summary?: Omit<TranscriptsSummary, "transcript">; markdown?: string } {
  const row = executeSqliteQueryTakeFirstSync(
    database,
    meetingTranscriptDb(database)
      .selectFrom("meeting_transcript_summaries")
      .select((eb) => {
        const summary = eb.fn<string | null>("json_remove", [
          eb.ref("summary_json"),
          eb.val("$.transcript"),
        ]);
        const bytes = textBytes(summary, eb.ref("markdown"));
        return [
          boundedText(summary, bytes, byteLimit(purpose)).as("summary"),
          boundedText(eb.ref("markdown"), bytes, byteLimit(purpose)).as("markdown"),
          bytes.as("payload_bytes"),
        ];
      })
      .where("session_id", "=", session.sessionId)
      .where("session_started_at", "=", session.startedAt),
  );
  if (!row) {
    return {};
  }
  assertReadBytes(row.payload_bytes, purpose);
  let summary: Omit<TranscriptsSummary, "transcript"> | undefined;
  if (row.summary) {
    // SAFETY: writeSummary/legacy import own the summary shape; this query removes only transcript.
    summary = JSON.parse(row.summary) as Omit<TranscriptsSummary, "transcript">;
  }
  return {
    summary,
    markdown: row.markdown ?? undefined,
  };
}

/** Iterate canonical rows for downloads without materializing export files or an unbounded array. */
export function* iterateTranscriptUtterances(
  database: DatabaseSync,
  session: TranscriptSessionDescriptor,
): Generator<TranscriptUtterance> {
  for (const row of iterateSqliteQuerySync(
    database,
    utteranceQuery(database, session, "export").orderBy("sequence", "asc"),
  )) {
    assertTranscriptByteCount(row.payload_bytes, TRANSCRIPTS_EXPORT_MAX_BYTES, true);
    yield transcriptReadUtteranceFromRow(row);
  }
}
