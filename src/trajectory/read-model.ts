import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sql } from "kysely";
import type {
  SessionsTrajectoryDetailResult,
  SessionsTrajectoryPageResult,
  TrajectoryRecord,
} from "../../packages/gateway-protocol/src/schema/trajectory.js";
import { sanitizeDiagnosticPayload } from "../agents/payload-redaction.js";
import type { SessionTranscriptReadScope } from "../config/sessions/session-accessor.js";
import { withCurrentProjectionSnapshot } from "../config/sessions/session-accessor.sqlite-active-projection.js";
import { projectChatDisplayMessage } from "../gateway/chat-display-projection.js";
import { projectTranscriptEntryMessage } from "../gateway/session-transcript-message.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { parseBooleanValue } from "../utils/boolean.js";

type TrajectoryReadDatabase = {
  session_transcript_active_events: {
    session_id: string;
    active_position: number;
    event_seq: number;
    message_position: number | null;
  };
  transcript_event_identities: {
    session_id: string;
    event_id: string;
    seq: number;
    event_type: string | null;
    parent_id: string | null;
  };
  transcript_events: {
    session_id: string;
    seq: number;
    event_json: string;
    created_at: number;
  };
  trajectory_runtime_events: {
    session_id: string;
    seq: number;
    run_id: string | null;
    event_json: string;
    created_at: number;
  };
};

type TrajectoryReadTarget = SessionTranscriptReadScope & {
  sessionKey: string;
  storePath: string;
};

type Source = "runtime" | "transcript";
type SourceRow = {
  source: Source;
  seq: number;
  createdAt: number;
  event: unknown;
};

type Cursor = {
  createdAt: number;
  source: Source;
  seq: number;
};

const DEFAULT_PAGE_SIZE = 80;
const MAX_PAGE_SIZE = 200;
const PREVIEW_MAX_CHARS = 320;

function parseStoredEvent(eventJson: string): unknown {
  try {
    return JSON.parse(eventJson) as unknown;
  } catch {
    return {
      type: "corrupt",
      data: {
        errorMessage: "Stored trajectory record could not be decoded.",
        truncated: true,
      },
    };
  }
}

function sqliteTranscriptTrajectoryRecordIsCanonical(sessionId: string) {
  // Runtime rows own the richer tool-result timing/payload record. Suppress the
  // transcript duplicate in the SQL domain so cursors page semantic rows only.
  return /* kysely-allow-raw: Cross-source identity lives inside two canonical JSON envelopes. */ sql<boolean>`NOT (
    json_valid(event.event_json)
    AND CASE WHEN json_valid(event.event_json)
      THEN json_extract(event.event_json, '$.message.role') END = 'toolResult'
    AND CASE WHEN json_valid(event.event_json)
      THEN json_extract(event.event_json, '$.message.toolCallId') END IS NOT NULL
    AND CASE WHEN json_valid(event.event_json)
      THEN json_extract(event.event_json, '$.message.toolCallId') END IN (
      SELECT CASE WHEN json_valid(runtime_result.event_json)
        THEN json_extract(runtime_result.event_json, '$.data.toolCallId') END
      FROM trajectory_runtime_events AS runtime_result
      WHERE runtime_result.session_id = ${sessionId}
        AND CASE WHEN json_valid(runtime_result.event_json)
          THEN json_extract(runtime_result.event_json, '$.type') END = 'tool.result'
    )
  )`;
}

function sourceRank(source: Source): number {
  return source === "runtime" ? 0 : 1;
}

function compareRows(left: SourceRow, right: SourceRow): number {
  return (
    left.createdAt - right.createdAt ||
    sourceRank(left.source) - sourceRank(right.source) ||
    left.seq - right.seq
  );
}

function encodeCursor(row: SourceRow): string {
  return Buffer.from(
    JSON.stringify({ createdAt: row.createdAt, source: row.source, seq: row.seq } satisfies Cursor),
    "utf8",
  ).toString("base64url");
}

function decodeCursor(value: string | undefined): Cursor | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (
      isRecord(parsed) &&
      typeof parsed.createdAt === "number" &&
      Number.isSafeInteger(parsed.createdAt) &&
      (parsed.source === "runtime" || parsed.source === "transcript") &&
      typeof parsed.seq === "number" &&
      Number.isSafeInteger(parsed.seq) &&
      parsed.seq >= 0
    ) {
      return { createdAt: parsed.createdAt, source: parsed.source, seq: parsed.seq };
    }
  } catch {
    // Invalid cursors are reported by the caller as an empty older window.
  }
  return undefined;
}

function readRows(params: { target: TrajectoryReadTarget; cursor?: Cursor; limit: number }): {
  rows: SourceRow[];
  runtimeMinSeq?: number;
} {
  return withCurrentProjectionSnapshot(params.target, (projection) => {
    const db = getNodeSqliteKysely<TrajectoryReadDatabase>(projection.database.db);
    const queryLimit = params.limit + 1;
    let transcriptQuery = db
      .selectFrom("session_transcript_active_events as active")
      .innerJoin("transcript_events as event", (join) =>
        join
          .onRef("event.session_id", "=", "active.session_id")
          .onRef("event.seq", "=", "active.event_seq"),
      )
      .select(["event.seq", "event.created_at", "event.event_json"])
      .where("active.session_id", "=", projection.resolved.sessionId)
      .where(sqliteTranscriptTrajectoryRecordIsCanonical(projection.resolved.sessionId));
    let runtimeQuery = db
      .selectFrom("trajectory_runtime_events")
      .select(["seq", "created_at", "event_json"])
      .where("session_id", "=", projection.resolved.sessionId);
    const cursor = params.cursor;
    if (cursor) {
      const cursorRank = sourceRank(cursor.source);
      const transcriptRank = sourceRank("transcript");
      transcriptQuery = transcriptQuery.where((eb) =>
        transcriptRank < cursorRank
          ? eb("event.created_at", "<=", cursor.createdAt)
          : transcriptRank > cursorRank
            ? eb("event.created_at", "<", cursor.createdAt)
            : eb.or([
                eb("event.created_at", "<", cursor.createdAt),
                eb.and([
                  eb("event.created_at", "=", cursor.createdAt),
                  eb("event.seq", "<", cursor.seq),
                ]),
              ]),
      );
      const runtimeRank = sourceRank("runtime");
      runtimeQuery = runtimeQuery.where((eb) =>
        runtimeRank < cursorRank
          ? eb("created_at", "<=", cursor.createdAt)
          : runtimeRank > cursorRank
            ? eb("created_at", "<", cursor.createdAt)
            : eb.or([
                eb("created_at", "<", cursor.createdAt),
                eb.and([eb("created_at", "=", cursor.createdAt), eb("seq", "<", cursor.seq)]),
              ]),
      );
    }
    const transcriptRows = executeSqliteQuerySync(
      projection.database.db,
      transcriptQuery
        .orderBy("event.created_at", "desc")
        .orderBy("event.seq", "desc")
        .limit(queryLimit),
    ).rows.map(
      (row): SourceRow => ({
        source: "transcript",
        seq: row.seq,
        createdAt: row.created_at,
        event: parseStoredEvent(row.event_json),
      }),
    );
    const runtimeRows = executeSqliteQuerySync(
      projection.database.db,
      runtimeQuery.orderBy("created_at", "desc").orderBy("seq", "desc").limit(queryLimit),
    ).rows.map(
      (row): SourceRow => ({
        source: "runtime",
        seq: row.seq,
        createdAt: row.created_at,
        event: parseStoredEvent(row.event_json),
      }),
    );
    const runtimeMin = executeSqliteQuerySync(
      projection.database.db,
      db
        .selectFrom("trajectory_runtime_events")
        .select((eb) => eb.fn.min<number>("seq").as("min_seq"))
        .where("session_id", "=", projection.resolved.sessionId),
    ).rows[0]?.min_seq;
    return {
      rows: [...transcriptRows, ...runtimeRows].toSorted(compareRows),
      ...(typeof runtimeMin === "number" ? { runtimeMinSeq: runtimeMin } : {}),
    };
  });
}

function recordId(row: SourceRow): string {
  const entryId = isRecord(row.event) ? normalizeOptionalString(row.event.id) : undefined;
  return row.source === "runtime"
    ? `runtime:${row.seq}`
    : entryId
      ? `transcript:${entryId}`
      : `transcript-seq:${row.seq}`;
}

function boundedPreview(value: unknown): string {
  const parts: string[] = [];
  const visit = (candidate: unknown, depth: number) => {
    if (parts.join(" ").length >= PREVIEW_MAX_CHARS || depth > 5) {
      return;
    }
    if (typeof candidate === "string") {
      const text = candidate.replace(/\s+/gu, " ").trim();
      if (text) {
        parts.push(text);
      }
      return;
    }
    if (Array.isArray(candidate)) {
      for (const item of candidate.slice(0, 8)) {
        visit(item, depth + 1);
      }
      return;
    }
    if (!isRecord(candidate)) {
      return;
    }
    for (const key of ["text", "summary", "message", "content", "result", "errorMessage"]) {
      if (Object.hasOwn(candidate, key)) {
        visit(candidate[key], depth + 1);
      }
    }
  };
  visit(value, 0);
  const preview = parts.join(" · ");
  return preview.length <= PREVIEW_MAX_CHARS
    ? preview
    : `${preview.slice(0, PREVIEW_MAX_CHARS - 1)}…`;
}

function isFailed(data: Record<string, unknown> | undefined): boolean {
  return Boolean(
    data?.error === true ||
    data?.isError === true ||
    data?.failed === true ||
    data?.status === "failed" ||
    data?.status === "error" ||
    data?.terminalError,
  );
}

function runtimeRecord(row: SourceRow): { detail: unknown; record: TrajectoryRecord } {
  const event = isRecord(row.event) ? row.event : {};
  const type = normalizeOptionalString(event.type) ?? "runtime.unknown";
  const data = isRecord(event.data) ? event.data : undefined;
  const runId = normalizeOptionalString(event.runId);
  const toolCallId = normalizeOptionalString(data?.toolCallId);
  const callId = normalizeOptionalString(data?.callId);
  const toolName = normalizeOptionalString(data?.toolName ?? data?.name);
  const provider = normalizeOptionalString(event.provider ?? data?.provider);
  const model = normalizeOptionalString(event.modelId ?? data?.model ?? data?.modelId);
  let kind: TrajectoryRecord["kind"] = "lifecycle";
  let lane: TrajectoryRecord["lane"] = "model";
  let title = type.replaceAll(".", " ");
  let status: TrajectoryRecord["status"] = isFailed(data) ? "failed" : "completed";
  if (type === "context.compiled") {
    kind = "system";
    lane = "input";
    title = "System prompt and tools";
  } else if (type === "prompt.submitted" || type === "prompt.skipped") {
    kind = "context";
    lane = "input";
    title = type === "prompt.skipped" ? "Prompt skipped" : "Prompt submitted";
  } else if (type === "model.call.started") {
    kind = "request";
    title = "Model request";
    status = "pending";
  } else if (type === "model.call.completed" || type === "model.completed") {
    title = "Model response";
  } else if (type === "model.call.error") {
    title = "Model request failed";
    status = "failed";
  } else if (type === "model.fallback_step") {
    kind = "request";
    title = "Model fallback";
    status = data?.status === "succeeded" ? "completed" : "failed";
  } else if (type.includes("compaction")) {
    kind = "compacted";
    title = "Compaction";
    status = type.endsWith("started") ? "pending" : status;
  } else if (type.startsWith("tool.") || type.includes("approval")) {
    const parentToolCallId = normalizeOptionalString(data?.parentToolCallId);
    kind = parentToolCallId ? "subtool" : "tool";
    lane = "tools";
    title = toolName ?? (type.includes("approval") ? "Approval" : "Tool call");
    status = type === "tool.call" || type.endsWith("requested") ? "pending" : status;
  } else if (type === "session.ended") {
    title = "Run ended";
  }
  const durationMs =
    typeof data?.durationMs === "number" && Number.isFinite(data.durationMs)
      ? Math.max(0, data.durationMs)
      : undefined;
  const record: TrajectoryRecord = {
    id: recordId(row),
    source: "runtime",
    sourceSeq: row.seq,
    kind,
    lane,
    status,
    type,
    timestamp: row.createdAt,
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(runId ? { runId } : {}),
    ...(callId || runId ? { requestId: callId ?? runId } : {}),
    ...(toolCallId ? { toolCallId } : {}),
    ...(toolName ? { toolName } : {}),
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    title,
    preview: boundedPreview(data ?? type),
    ...(data?.usage !== undefined ? { usage: data.usage } : {}),
    ...(data?.timing !== undefined || data?.timeToFirstByteMs !== undefined
      ? {
          timing: {
            ...(isRecord(data?.timing) ? data.timing : {}),
            ...(typeof data?.timeToFirstByteMs === "number"
              ? { timeToFirstByteMs: data.timeToFirstByteMs }
              : {}),
          },
        }
      : {}),
    ...(data?.truncated === true ? { truncated: true } : {}),
  };
  return {
    record,
    detail: sanitizeDiagnosticPayload({
      type,
      ...(data ? { data } : {}),
    }),
  };
}

function transcriptRecord(row: SourceRow): { detail: unknown; record: TrajectoryRecord } {
  const event = isRecord(row.event) ? row.event : {};
  const eventType = normalizeOptionalString(event.type) ?? "unknown";
  const message = isRecord(event.message) ? event.message : undefined;
  const role = normalizeOptionalString(message?.role);
  const projected = message
    ? projectChatDisplayMessage(projectTranscriptEntryMessage(event, row.seq))
    : undefined;
  const safeMessage =
    projected ?? (message ? { role, content: "Context details unavailable" } : event);
  let kind: TrajectoryRecord["kind"] = "unknown";
  let lane: TrajectoryRecord["lane"] = "model";
  let title = eventType.replaceAll("_", " ");
  let status: TrajectoryRecord["status"] = "completed";
  if (eventType === "compaction") {
    kind = "compacted";
    title = "Compacted history";
  } else if (eventType === "reset") {
    kind = "lifecycle";
    title = "Session reset";
  } else if (eventType === "model_change") {
    kind = "request";
    title = "Model changed";
  } else if (eventType === "custom_message" || role === "custom") {
    kind = "context";
    lane = "input";
    title = "Context";
  } else if (role === "user") {
    kind = "user";
    lane = "input";
    title = "User input";
  } else if (role === "assistant") {
    kind = "assistant";
    title = "Assistant";
    status = message?.stopReason === "error" ? "failed" : "completed";
  } else if (role === "toolResult") {
    kind = normalizeOptionalString(
      isRecord(message?.details) ? message.details.parentToolCallId : undefined,
    )
      ? "subtool"
      : "tool";
    lane = "tools";
    title = normalizeOptionalString(message?.toolName) ?? "Tool result";
    status = message?.isError === true ? "failed" : "completed";
  }
  const entryId = normalizeOptionalString(event.id);
  const parentEntryId = normalizeOptionalString(event.parentId);
  const toolCallId = normalizeOptionalString(message?.toolCallId);
  const provider = normalizeOptionalString(message?.provider ?? event.provider);
  const model = normalizeOptionalString(message?.model ?? event.modelId);
  const record: TrajectoryRecord = {
    id: recordId(row),
    source: "transcript",
    sourceSeq: row.seq,
    kind,
    lane,
    status,
    type: eventType === "message" ? `message.${role ?? "unknown"}` : eventType,
    timestamp: row.createdAt,
    ...(parentEntryId ? { parentId: `transcript:${parentEntryId}` } : {}),
    ...(toolCallId ? { toolCallId } : {}),
    ...(normalizeOptionalString(message?.toolName)
      ? { toolName: normalizeOptionalString(message?.toolName) }
      : {}),
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    title,
    preview: boundedPreview(safeMessage),
    ...(message?.usage !== undefined ? { usage: message.usage } : {}),
  };
  return {
    record,
    detail: sanitizeDiagnosticPayload({
      ...(entryId ? { entryId } : {}),
      type: eventType,
      message: safeMessage,
      ...(eventType === "compaction"
        ? {
            summary: event.summary,
            tokensBefore: event.tokensBefore,
            details: event.details,
          }
        : {}),
    }),
  };
}

function projectRow(row: SourceRow): { detail: unknown; record: TrajectoryRecord } {
  return row.source === "runtime" ? runtimeRecord(row) : transcriptRecord(row);
}

function pairRuntimeSpans(records: TrajectoryRecord[]): void {
  const pendingRequests = new Map<string, TrajectoryRecord>();
  const pendingTools = new Map<string, TrajectoryRecord>();
  for (const record of records) {
    if (record.type === "model.call.started" && record.requestId) {
      pendingRequests.set(record.requestId, record);
      continue;
    }
    if (
      (record.type === "model.call.completed" || record.type === "model.call.error") &&
      record.requestId
    ) {
      const started = pendingRequests.get(record.requestId);
      if (started) {
        started.endTimestamp = record.timestamp;
        started.durationMs = Math.max(0, record.timestamp - started.timestamp);
        started.status = record.status;
        started.usage = record.usage;
        started.timing = record.timing;
      }
      continue;
    }
    if (record.type === "tool.call" && record.toolCallId) {
      pendingTools.set(record.toolCallId, record);
      continue;
    }
    if (record.type === "tool.result" && record.toolCallId) {
      const started = pendingTools.get(record.toolCallId);
      if (started) {
        started.endTimestamp = record.timestamp;
        started.durationMs = Math.max(0, record.timestamp - started.timestamp);
        started.status = record.status;
      }
    }
  }
}

export function readTrajectoryPage(params: {
  target: TrajectoryReadTarget;
  cursor?: string;
  limit?: number;
  env?: NodeJS.ProcessEnv;
}): SessionsTrajectoryPageResult {
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(params.limit ?? DEFAULT_PAGE_SIZE)));
  const cursor = decodeCursor(params.cursor);
  if (params.cursor && !cursor) {
    return {
      records: [],
      hasMore: false,
      capture:
        parseBooleanValue((params.env ?? process.env).OPENCLAW_TRAJECTORY) === false
          ? "disabled"
          : "empty",
      trimmedPrefix: false,
    };
  }
  const { rows, runtimeMinSeq } = readRows({ target: params.target, cursor, limit });
  const selected = rows.slice(Math.max(0, rows.length - limit));
  const records = selected.map((row) => projectRow(row).record);
  pairRuntimeSpans(records);
  const hasMore = rows.length > limit;
  const captureDisabled =
    parseBooleanValue((params.env ?? process.env).OPENCLAW_TRAJECTORY) === false;
  return {
    records,
    ...(hasMore && selected[0] ? { cursor: encodeCursor(selected[0]) } : {}),
    hasMore,
    capture: captureDisabled ? "disabled" : records.length === 0 ? "empty" : "enabled",
    trimmedPrefix: typeof runtimeMinSeq === "number" && runtimeMinSeq > 0,
  };
}

function readDetailRow(target: TrajectoryReadTarget, recordIdValue: string): SourceRow | undefined {
  return withCurrentProjectionSnapshot(target, (projection) => {
    const db = getNodeSqliteKysely<TrajectoryReadDatabase>(projection.database.db);
    if (recordIdValue.startsWith("runtime:")) {
      const seq = Number(recordIdValue.slice("runtime:".length));
      if (!Number.isSafeInteger(seq) || seq < 0) {
        return undefined;
      }
      const row = executeSqliteQuerySync(
        projection.database.db,
        db
          .selectFrom("trajectory_runtime_events")
          .select(["seq", "created_at", "event_json"])
          .where("session_id", "=", projection.resolved.sessionId)
          .where("seq", "=", seq)
          .limit(1),
      ).rows[0];
      return row
        ? {
            source: "runtime",
            seq: row.seq,
            createdAt: row.created_at,
            event: parseStoredEvent(row.event_json),
          }
        : undefined;
    }
    const bySeq = recordIdValue.startsWith("transcript-seq:");
    const entryId = recordIdValue.startsWith("transcript:")
      ? recordIdValue.slice("transcript:".length)
      : undefined;
    const seq = bySeq ? Number(recordIdValue.slice("transcript-seq:".length)) : undefined;
    if (!entryId && (!Number.isSafeInteger(seq) || (seq ?? -1) < 0)) {
      return undefined;
    }
    let query = db
      .selectFrom("session_transcript_active_events as active")
      .innerJoin("transcript_events as event", (join) =>
        join
          .onRef("event.session_id", "=", "active.session_id")
          .onRef("event.seq", "=", "active.event_seq"),
      )
      .innerJoin("transcript_event_identities as identity", (join) =>
        join
          .onRef("identity.session_id", "=", "event.session_id")
          .onRef("identity.seq", "=", "event.seq"),
      )
      .select(["event.seq", "event.created_at", "event.event_json"])
      .where("active.session_id", "=", projection.resolved.sessionId);
    query = entryId
      ? query.where("identity.event_id", "=", entryId)
      : query.where("event.seq", "=", seq!);
    const row = executeSqliteQuerySync(projection.database.db, query.limit(1)).rows[0];
    return row
      ? {
          source: "transcript",
          seq: row.seq,
          createdAt: row.created_at,
          event: parseStoredEvent(row.event_json),
        }
      : undefined;
  });
}

export function readTrajectoryDetail(params: {
  target: TrajectoryReadTarget;
  recordId: string;
}): SessionsTrajectoryDetailResult {
  const row = readDetailRow(params.target, params.recordId);
  if (!row) {
    return { ok: false, unavailableReason: "not_found" };
  }
  const projected = projectRow(row);
  return { ok: true, record: projected.record, detail: projected.detail };
}
