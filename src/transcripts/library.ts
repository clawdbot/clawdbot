import { createHash } from "node:crypto";
import {
  asSafeIntegerInRange,
  parseDateStringTimestampMs,
} from "@openclaw/normalization-core/number-coercion";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  TRANSCRIPTS_EXPORT_MAX_BYTES,
  TRANSCRIPTS_LEGACY_MAX_TEXT_LENGTH,
  TRANSCRIPTS_LEGACY_RESULT_MAX_BYTES,
  TRANSCRIPTS_RESULT_MAX_BYTES,
  type TranscriptSessionSummary,
  type TranscriptsExportParams,
  type TranscriptsExportResult,
  type TranscriptsGetParams,
  type TranscriptsGetResult,
  type TranscriptsListParams,
  type TranscriptsListResult,
} from "../../packages/gateway-protocol/src/schema/transcripts.js";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { readTranscriptCaptureSnapshot } from "./capture.js";
import {
  projectTranscriptMarkdown,
  projectTranscriptSession,
  projectTranscriptUtterance,
  readTranscriptNotes,
} from "./read.js";
import {
  assertTranscriptByteLimit,
  assertTranscriptByteCount,
  TranscriptLibraryError,
  type TranscriptReadOptions,
  type TranscriptReadPurpose,
} from "./store-read.js";
import { safeTranscriptPathSegment, type TranscriptsStore } from "./store.js";
import { renderTranscriptsMarkdown } from "./summary.js";

function cursorScope(values: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(values)).digest("hex");
}

function encodeCursor(scope: string, position: [string, string] | [number]): string {
  return Buffer.from(JSON.stringify([1, scope, ...position])).toString("base64url");
}

function decodeCursor(cursor: string | undefined, scope: string): unknown[] | undefined {
  if (cursor === undefined) {
    return undefined;
  }
  try {
    if (cursor.length > TRANSCRIPTS_RESULT_MAX_BYTES || !/^[A-Za-z0-9_-]+$/u.test(cursor)) {
      throw new Error();
    }
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (Array.isArray(value) && value[0] === 1 && value[1] === scope) {
      return value.slice(2);
    }
  } catch {
    /* Invalid or cross-query cursors are never used as selectors. */
  }
  throw new TranscriptLibraryError(
    "transcript_invalid_cursor",
    "Invalid transcript cursor; restart pagination with the current filters.",
  );
}

function normalizeDate(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const time = parseDateStringTimestampMs(value);
  if (time === undefined) {
    throw new TranscriptLibraryError(
      "transcript_invalid_filter",
      "Invalid transcript date filter.",
    );
  }
  return new Date(time).toISOString();
}

function requireEntry(
  store: TranscriptsStore,
  selector: string,
  purpose: TranscriptReadPurpose = "page",
) {
  const entry = store.readEntry(selector, purpose);
  if (!entry) {
    throw new TranscriptLibraryError(
      "transcript_session_not_found",
      "Transcript not found; refresh the library and use its full selector.",
    );
  }
  return entry;
}

export function listTranscriptLibrary(
  store: TranscriptsStore,
  params: TranscriptsListParams,
  providerName?: (providerId: string) => string | undefined,
): TranscriptsListResult {
  const { cursor, ...filters } = params;
  const startedAfter = normalizeDate(filters.startedAfter);
  const startedBefore = normalizeDate(filters.startedBefore);
  if (startedAfter && startedBefore && startedAfter >= startedBefore) {
    throw new TranscriptLibraryError(
      "transcript_invalid_filter",
      "Transcript date range must end after it starts.",
    );
  }
  const scope = cursorScope([
    "list",
    filters.query,
    filters.providerId,
    filters.accountId,
    filters.agentId,
    startedAfter,
    startedBefore,
  ]);
  const position = decodeCursor(cursor, scope);
  let after: TranscriptReadOptions["after"];
  if (position) {
    const [startedAt, sessionId] = position;
    if (position.length !== 2 || typeof startedAt !== "string" || typeof sessionId !== "string") {
      throw new TranscriptLibraryError(
        "transcript_invalid_cursor",
        "Invalid transcript library cursor.",
      );
    }
    after = { startedAt, sessionId };
  }
  const page = store.iterateReadEntries({ ...filters, startedAfter, startedBefore, after });
  const captures = readTranscriptCaptureSnapshot();
  const sessions: TranscriptSessionSummary[] = [];
  let bytes = 0;
  let hasMore = false;
  try {
    for (let step = page.next(); ; step = page.next()) {
      if (step.done) {
        hasMore = step.value;
        break;
      }
      const entry = projectTranscriptSession(
        step.value,
        undefined,
        providerName?.(step.value.session.source.providerId),
        captures,
      );
      bytes += Buffer.byteLength(JSON.stringify(entry), "utf8");
      assertTranscriptByteCount(bytes);
      sessions.push(entry);
    }
  } finally {
    page.return(false);
  }
  const last = sessions.at(-1);
  const result = {
    sessions,
    nextCursor: hasMore && last ? encodeCursor(scope, [last.startedAt, last.sessionId]) : null,
  };
  assertTranscriptByteLimit(JSON.stringify(result));
  return result;
}

export async function getTranscriptLibrary(
  store: TranscriptsStore,
  params: TranscriptsGetParams,
  providerName?: (providerId: string) => string | undefined,
): Promise<TranscriptsGetResult> {
  const purpose =
    params.limit === undefined && params.cursor === undefined && params.query === undefined
      ? "legacy"
      : "page";
  const entry = requireEntry(store, params.selector, purpose);
  const scope = cursorScope(["get", entry.selector, params.query]);
  const position = decodeCursor(params.cursor, scope);
  const after = asSafeIntegerInRange(position?.[0], { min: 0 });
  if (position && (position.length !== 1 || after === undefined)) {
    throw new TranscriptLibraryError(
      "transcript_invalid_cursor",
      "Invalid transcript reader cursor.",
    );
  }
  const page = params.includeUtterances
    ? store.readUtterancePage(
        entry.session,
        { limit: params.limit, query: params.query, after },
        purpose,
      )
    : undefined;
  const utterances = page?.utterances.map((utterance) => {
    const projected = projectTranscriptUtterance(utterance);
    if (purpose === "legacy") {
      projected.text = truncateUtf16Safe(projected.text, TRANSCRIPTS_LEGACY_MAX_TEXT_LENGTH);
    }
    return projected;
  });
  const last = utterances?.at(-1);
  const result: TranscriptsGetResult = {
    session: projectTranscriptSession(
      entry,
      undefined,
      providerName?.(entry.session.source.providerId),
    ),
    ...(utterances ? { utterances } : {}),
    nextCursor: page?.hasMore && last ? encodeCursor(scope, [last.sequence]) : null,
    summary: await readTranscriptNotes(store, entry.session, purpose),
  };
  assertTranscriptByteLimit(
    JSON.stringify(result),
    purpose === "legacy" ? TRANSCRIPTS_LEGACY_RESULT_MAX_BYTES : TRANSCRIPTS_RESULT_MAX_BYTES,
  );
  return result;
}

export async function exportTranscriptLibrary(
  store: TranscriptsStore,
  params: TranscriptsExportParams,
): Promise<TranscriptsExportResult> {
  const entry = requireEntry(store, params.selector, "export");
  const parts: string[] = [];
  let sizeBytes = 0;
  for (const utterance of store.iterateUtterances(entry.session)) {
    const text =
      params.format === "jsonl"
        ? `${JSON.stringify(projectTranscriptUtterance(utterance))}\n`
        : sanitizeTerminalText(utterance.text).trim();
    const speaker = sanitizeTerminalText(utterance.speakerLabel ?? "").trim();
    const line = params.format === "markdown" && speaker ? `${speaker}: ${text}` : text;
    // Include Markdown list/newline overhead while accumulating, before rendering the body.
    sizeBytes += Buffer.byteLength(line, "utf8") + (params.format === "markdown" ? 3 : 0);
    assertTranscriptByteCount(sizeBytes, TRANSCRIPTS_EXPORT_MAX_BYTES, true);
    parts.push(line);
  }
  const notes = params.format === "markdown" ? store.readNotes(entry.session, "export") : undefined;
  const summary = notes?.summary;
  const title = sanitizeTerminalText(entry.session.title ?? "").trim() || "Transcript";
  const body =
    params.format === "jsonl"
      ? parts.join("")
      : notes?.markdown !== undefined
        ? [
            projectTranscriptMarkdown(notes.markdown),
            ...(summary ? [`Summary covers ${summary.utteranceCount} saved utterances.`] : []),
            `## Full Transcript\n${parts.map((line) => `- ${line}`).join("\n")}`,
            `Transcript utterances: ${entry.utteranceCount}\n`,
          ].join("\n\n")
        : summary
          ? `${renderTranscriptsMarkdown({ ...summary, title, transcript: parts, utteranceCount: entry.utteranceCount })}\n\nSummary covers ${summary.utteranceCount} saved utterances.\n`
          : `# ${title}\n\nSession: ${sanitizeTerminalText(entry.session.sessionId)}\nStarted: ${entry.session.startedAt}\n\n## Transcript\n${parts.map((line) => `- ${line}`).join("\n")}\n`;
  assertTranscriptByteLimit(body, TRANSCRIPTS_EXPORT_MAX_BYTES, true);
  const digest = createHash("sha256").update(entry.selector).digest("hex").slice(0, 12);
  const filename = `transcript-${safeTranscriptPathSegment(entry.session.startedAt.slice(0, 10))}-${digest}.${params.format === "markdown" ? "md" : "jsonl"}`;
  return {
    selector: entry.selector,
    filename,
    mimeType:
      params.format === "markdown"
        ? "text/markdown;charset=utf-8"
        : "application/x-ndjson;charset=utf-8",
    encoding: "base64",
    data: Buffer.from(body, "utf8").toString("base64"),
    sizeBytes: Buffer.byteLength(body, "utf8"),
  };
}
