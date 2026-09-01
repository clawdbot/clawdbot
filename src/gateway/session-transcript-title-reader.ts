// Session-list title reads: bounded transcript probes plus a watermark-validated
// cache so list rendering never rescans transcripts that have not changed.
import { expectDefined } from "@openclaw/normalization-core";
import {
  isSessionTranscriptProjectionUnavailableError,
  readSessionTranscriptMessageEventPage,
  readSessionTranscriptTitleProbeBatch,
  readSessionTranscriptWatermark,
  readSessionTranscriptWatermarkBatch,
  type SessionTranscriptMessageEvent,
  type SessionTranscriptReadScope,
  type SessionTranscriptTitleProbe,
} from "../config/sessions/session-accessor.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import { hasInterSessionUserProvenance } from "../sessions/input-provenance.js";
import { projectSessionDisplayMessage } from "./session-display-projection.js";
import {
  resolveTranscriptReadTarget,
  sqliteMessageEventWithSeq,
  toTranscriptReadScope,
  type ResolvedTranscriptReadTarget,
} from "./session-transcript-readers.js";

type SessionTitleFields = {
  firstUserMessage: string | null;
  lastMessagePreview: string | null;
};

const EMPTY_SESSION_TITLE_FIELDS: SessionTitleFields = {
  firstUserMessage: null,
  lastMessagePreview: null,
};
// Degraded nulls advance the sessions.list cache fence so the completed result cannot
// outlive the projection rebuild that made those title fields temporarily unavailable.
let sessionTitleProjectionUnavailableVersion = 0;

export function readSessionTitleProjectionUnavailableVersion(): number {
  return sessionTitleProjectionUnavailableVersion;
}

// Session-list title probes must not scale with transcript size. Read at most
// this many active-path messages from either end, widening only once.
const SQLITE_TITLE_PROBE_INITIAL_MESSAGES = 20;
const SQLITE_TITLE_PROBE_MAX_MESSAGES = 100;
const SQLITE_TITLE_FIELD_CACHE_MAX_ENTRIES = 256;

type SqliteTitleFieldCacheEntry = ReturnType<typeof readSessionTranscriptWatermark> & {
  fields: Partial<Record<"default" | "includeInterSession", SessionTitleFields>>;
};

// Appends advance maxSeq while rewind, fork, and compaction rotate generation. Both tokens must
// match or stale titles can survive transcript replacement. Actively streaming sessions therefore
// miss by design; the store-batched probe bounds that load while this LRU still serves idle rows.
const sqliteTitleFieldCache = new Map<string, SqliteTitleFieldCacheEntry>();

function sqliteTitleFieldCacheKey(target: ResolvedTranscriptReadTarget): string {
  return `${target.agentId ?? ""}\0${target.sessionId}\0${target.storePath ?? ""}`;
}

function setSqliteTitleFieldCache(key: string, entry: SqliteTitleFieldCacheEntry): void {
  sqliteTitleFieldCache.delete(key);
  sqliteTitleFieldCache.set(key, entry);
  pruneMapToMaxSize(sqliteTitleFieldCache, SQLITE_TITLE_FIELD_CACHE_MAX_ENTRIES);
}

function readSqliteTitleProbeRange(
  scope: SessionTranscriptReadScope,
  totalMessages: number,
  start: number,
  endExclusive: number,
): SessionTranscriptMessageEvent[] {
  const end = Math.min(totalMessages, endExclusive);
  const boundedStart = Math.min(Math.max(0, start), end);
  if (boundedStart === end) {
    return [];
  }
  return readSessionTranscriptMessageEventPage(scope, {
    maxMessages: end - boundedStart,
    offset: totalMessages - end,
  }).events;
}

function findFirstTitleUserText(
  entries: readonly Parameters<typeof sqliteMessageEventWithSeq>[0][],
  includeInterSession: boolean,
): string | null {
  for (const entry of entries) {
    const message = sqliteMessageEventWithSeq(entry);
    const projected = projectSessionDisplayMessage(message);
    if (
      projected?.role === "user" &&
      (includeInterSession ||
        !hasInterSessionUserProvenance(message as { role?: unknown; provenance?: unknown }))
    ) {
      return projected.text;
    }
  }
  return null;
}

function findLastMessageText(
  entries: readonly Parameters<typeof sqliteMessageEventWithSeq>[0][],
): string | null {
  let text: string | null = null;
  entries.findLast((entry) => {
    const message = sqliteMessageEventWithSeq(entry);
    text = projectSessionDisplayMessage(message, { flattenMarkdown: true })?.text ?? null;
    return text !== null;
  });
  return text;
}

function copySessionTitleText(text: string | null): string | null {
  // V8 slices can pin whole transcript payloads behind a short cached preview.
  // Copy UTF-16 code units so ownership changes without altering lone surrogates.
  return text === null ? null : Buffer.from(text, "utf16le").toString("utf16le");
}

function hydrateSqliteTitleFields(
  target: ResolvedTranscriptReadTarget,
  opts?: { includeInterSession?: boolean },
  probe?: SessionTranscriptTitleProbe,
): SessionTitleFields {
  try {
    const scope = toTranscriptReadScope(target);
    const cacheKey = sqliteTitleFieldCacheKey(target);
    const watermark = probe ?? readSessionTranscriptWatermark(scope);
    const variant = opts?.includeInterSession === true ? "includeInterSession" : "default";
    const cached = sqliteTitleFieldCache.get(cacheKey);
    const current =
      cached?.generation === watermark.generation && cached.maxSeq === watermark.maxSeq;
    const cachedFields = current ? cached.fields[variant] : undefined;
    if (cached && cachedFields) {
      setSqliteTitleFieldCache(cacheKey, cached);
      return { ...cachedFields };
    }
    // Reset windows and rebuilding projections cannot use the batched probe. The canonical
    // page reader preserves reset visibility and schedules reconciliation when needed.
    const tail = probe
      ? { events: probe.tail, totalMessages: probe.totalMessages }
      : readSessionTranscriptMessageEventPage(scope, {
          maxMessages: SQLITE_TITLE_PROBE_INITIAL_MESSAGES,
          offset: 0,
        });
    let lastText = findLastMessageText(tail.events);
    if (!lastText && tail.totalMessages > SQLITE_TITLE_PROBE_INITIAL_MESSAGES) {
      lastText = findLastMessageText(
        readSqliteTitleProbeRange(
          scope,
          tail.totalMessages,
          tail.totalMessages - SQLITE_TITLE_PROBE_MAX_MESSAGES,
          tail.totalMessages - SQLITE_TITLE_PROBE_INITIAL_MESSAGES,
        ),
      );
    }
    const head =
      probe?.head ??
      (tail.totalMessages <= SQLITE_TITLE_PROBE_INITIAL_MESSAGES
        ? tail.events
        : readSqliteTitleProbeRange(
            scope,
            tail.totalMessages,
            0,
            SQLITE_TITLE_PROBE_INITIAL_MESSAGES,
          ));
    let firstText = findFirstTitleUserText(head, opts?.includeInterSession === true);
    if (!firstText && tail.totalMessages > SQLITE_TITLE_PROBE_INITIAL_MESSAGES) {
      firstText = findFirstTitleUserText(
        readSqliteTitleProbeRange(
          scope,
          tail.totalMessages,
          SQLITE_TITLE_PROBE_INITIAL_MESSAGES,
          SQLITE_TITLE_PROBE_MAX_MESSAGES,
        ),
        opts?.includeInterSession === true,
      );
    }
    const fields = {
      firstUserMessage: copySessionTitleText(firstText),
      lastMessagePreview: copySessionTitleText(lastText),
    };
    const fieldsByVariant = current ? cached.fields : {};
    fieldsByVariant[variant] = fields;
    // Retain only the watermark and bounded strings, never the probe's transcript payloads.
    setSqliteTitleFieldCache(cacheKey, {
      generation: watermark.generation,
      maxSeq: watermark.maxSeq,
      fields: fieldsByVariant,
    });
    return { ...fields };
  } catch (error) {
    if (!isSessionTranscriptProjectionUnavailableError(error)) {
      throw error;
    }
    // Do not cache degraded nulls: the completed-list fence must advance until reconciliation.
    sessionTitleProjectionUnavailableVersion += 1;
    return { ...EMPTY_SESSION_TITLE_FIELDS };
  }
}

/** Batch-hydrates titles while isolating a rebuilding projection to its session. */
export function readSessionTitleFieldsFromTranscriptBatch(
  scopes: readonly SessionTranscriptReadScope[],
  opts?: { includeInterSession?: boolean },
): SessionTitleFields[] {
  try {
    const variant = opts?.includeInterSession === true ? "includeInterSession" : "default";
    const reads = scopes.map((scope) => {
      const target = resolveTranscriptReadTarget(scope);
      const cacheKey = sqliteTitleFieldCacheKey(target);
      const cached = sqliteTitleFieldCache.get(cacheKey);
      return { target, cacheKey, cached, fields: cached?.fields[variant] };
    });
    const cachedReads = reads.filter((read) => read.fields);
    const watermarks = readSessionTranscriptWatermarkBatch(
      cachedReads.map((read) => toTranscriptReadScope(read.target)),
    );
    for (const [index, read] of cachedReads.entries()) {
      const watermark = watermarks[index];
      if (
        watermark &&
        read.cached &&
        read.fields &&
        read.cached.generation === watermark.generation &&
        read.cached.maxSeq === watermark.maxSeq
      ) {
        setSqliteTitleFieldCache(read.cacheKey, read.cached);
        read.fields = { ...read.fields };
      } else {
        read.fields = undefined;
      }
    }
    const misses = reads.filter((read) => !read.fields);
    const probes =
      misses.length > 0
        ? readSessionTranscriptTitleProbeBatch(
            misses.map((read) => toTranscriptReadScope(read.target)),
          )
        : [];
    for (const [index, read] of misses.entries()) {
      read.fields = hydrateSqliteTitleFields(read.target, opts, probes[index]);
    }
    return reads.map((read) =>
      expectDefined(read.fields, `title fields for session ${read.target.sessionId}`),
    );
  } catch (error) {
    if (!isSessionTranscriptProjectionUnavailableError(error)) {
      throw error;
    }
    return scopes.map((scope) =>
      hydrateSqliteTitleFields(resolveTranscriptReadTarget(scope), opts),
    );
  }
}

// Scalar callers retain page admission: older same-version writers can leave unclassified
// projections that the batch accessor does not reject. Both entries share hydration and caching.
/** Reads title and preview text from one transcript. */
export function readSessionTitleFieldsFromTranscript(
  scope: SessionTranscriptReadScope,
  opts?: { includeInterSession?: boolean },
): SessionTitleFields {
  return hydrateSqliteTitleFields(resolveTranscriptReadTarget(scope), opts);
}
