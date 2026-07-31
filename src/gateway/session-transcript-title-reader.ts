// Session-list title reads: bounded transcript probes plus a watermark-validated
// cache so list rendering never rescans transcripts that have not changed.
import {
  readSessionTranscriptMessageEventPage,
  readSessionTranscriptWatermark,
  type SessionTranscriptMessageEvent,
  type SessionTranscriptReadScope,
} from "../config/sessions/session-accessor.js";
import { hasInterSessionUserProvenance } from "../sessions/input-provenance.js";
import {
  extractMessageRole,
  extractMessageText,
  resolveTranscriptReadTarget,
  sqliteMessageEventWithSeq,
  toTranscriptReadScope,
  type ResolvedTranscriptReadTarget,
} from "./session-transcript-readers.js";

type SessionTitleFields = {
  firstUserMessage: string | null;
  lastMessagePreview: string | null;
};

// Session-list title probes must not scale with transcript size. Read at most
// this many active-path messages from either end, widening only once.
const SQLITE_TITLE_PROBE_INITIAL_MESSAGES = 20;
const SQLITE_TITLE_PROBE_MAX_MESSAGES = 100;
const SQLITE_TITLE_FIELD_CACHE_MAX_ENTRIES = 256;

type SqliteTitleFieldCacheEntry = ReturnType<typeof readSessionTranscriptWatermark> & {
  fields: Partial<Record<"default" | "includeInterSession", SessionTitleFields>>;
};

// Appends advance maxSeq while rewind, fork, and compaction rotate generation. Both tokens must
// match or stale titles can survive transcript replacement; keep only a few list pages in memory.
const sqliteTitleFieldCache = new Map<string, SqliteTitleFieldCacheEntry>();

function sqliteTitleFieldCacheKey(target: ResolvedTranscriptReadTarget): string {
  return `${target.agentId ?? ""}\0${target.sessionId}\0${target.storePath ?? ""}`;
}

function setSqliteTitleFieldCache(key: string, entry: SqliteTitleFieldCacheEntry): void {
  sqliteTitleFieldCache.delete(key);
  sqliteTitleFieldCache.set(key, entry);
  if (sqliteTitleFieldCache.size <= SQLITE_TITLE_FIELD_CACHE_MAX_ENTRIES) {
    return;
  }
  const oldestKey = sqliteTitleFieldCache.keys().next().value;
  if (oldestKey !== undefined) {
    sqliteTitleFieldCache.delete(oldestKey);
  }
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

function findFirstTitleUserMessage(
  entries: readonly SessionTranscriptMessageEvent[],
  includeInterSession: boolean,
): unknown {
  return entries.map(sqliteMessageEventWithSeq).find((message) => {
    if (extractMessageRole(message) !== "user") {
      return false;
    }
    return (
      includeInterSession ||
      !hasInterSessionUserProvenance(message as { role?: unknown; provenance?: unknown })
    );
  });
}

function findLastMessageText(entries: readonly SessionTranscriptMessageEvent[]): string | null {
  return (
    entries.toReversed().map(sqliteMessageEventWithSeq).map(extractMessageText).find(Boolean) ??
    null
  );
}

function readSqliteTitleFields(
  target: ResolvedTranscriptReadTarget,
  opts?: { includeInterSession?: boolean },
): SessionTitleFields {
  const scope = toTranscriptReadScope(target);
  const cacheKey = sqliteTitleFieldCacheKey(target);
  const watermark = readSessionTranscriptWatermark(scope);
  const variant = opts?.includeInterSession === true ? "includeInterSession" : "default";
  const cached = sqliteTitleFieldCache.get(cacheKey);
  const cachedFields =
    cached?.generation === watermark.generation && cached.maxSeq === watermark.maxSeq
      ? cached.fields[variant]
      : undefined;
  if (cached && cachedFields) {
    setSqliteTitleFieldCache(cacheKey, cached);
    return { ...cachedFields };
  }
  const tail = readSessionTranscriptMessageEventPage(scope, {
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
    tail.totalMessages <= SQLITE_TITLE_PROBE_INITIAL_MESSAGES
      ? tail.events
      : readSqliteTitleProbeRange(
          scope,
          tail.totalMessages,
          0,
          SQLITE_TITLE_PROBE_INITIAL_MESSAGES,
        );
  let firstUser = findFirstTitleUserMessage(head, opts?.includeInterSession === true);
  if (!firstUser && tail.totalMessages > SQLITE_TITLE_PROBE_INITIAL_MESSAGES) {
    firstUser = findFirstTitleUserMessage(
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
    firstUserMessage: firstUser ? extractMessageText(firstUser) : null,
    lastMessagePreview: lastText,
  };
  const fieldsByVariant =
    cached?.generation === watermark.generation && cached.maxSeq === watermark.maxSeq
      ? cached.fields
      : {};
  fieldsByVariant[variant] = fields;
  setSqliteTitleFieldCache(cacheKey, { ...watermark, fields: fieldsByVariant });
  return { ...fields };
}

/** Reads title and preview text from a transcript through the reader seam. */
export function readSessionTitleFieldsFromTranscript(
  scope: SessionTranscriptReadScope,
  opts?: { includeInterSession?: boolean },
): SessionTitleFields {
  return readSqliteTitleFields(resolveTranscriptReadTarget(scope), opts);
}

/** Reads title and preview text asynchronously through the reader seam. */
export async function readSessionTitleFieldsFromTranscriptAsync(
  scope: SessionTranscriptReadScope,
  opts?: { includeInterSession?: boolean },
): Promise<SessionTitleFields> {
  return readSqliteTitleFields(resolveTranscriptReadTarget(scope), opts);
}
