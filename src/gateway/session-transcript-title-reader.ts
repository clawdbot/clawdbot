// Session-list title reads: bounded transcript probes plus a watermark-validated
// cache so list rendering never rescans transcripts that have not changed.
import {
  isSessionTranscriptProjectionUnavailableError,
  readSessionTranscriptMessageEventPage,
  readSessionTranscriptTitleProbeBatch,
  readSessionTranscriptWatermark,
  readSessionTranscriptWatermarkBatch,
  type SessionTranscriptMessageEvent,
  type SessionTranscriptReadScope,
} from "../config/sessions/session-accessor.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";
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

type TitleFieldReadOptions = {
  // Include inter-session (relayed) user messages as title candidates outright.
  includeInterSession?: boolean;
  // Prefer a direct end-user message, but fall back to a relayed (inter-session)
  // one when none exists anywhere probed — so a relay-only session shows the
  // relayed text instead of an opaque sessionId. No-op when includeInterSession.
  fallbackToInterSession?: boolean;
};

type TitleFieldCacheVariant = "default" | "includeInterSession" | "defaultInterSessionFallback";

function titleFieldCacheVariant(opts?: TitleFieldReadOptions): TitleFieldCacheVariant {
  if (opts?.includeInterSession === true) {
    return "includeInterSession";
  }
  return opts?.fallbackToInterSession === true ? "defaultInterSessionFallback" : "default";
}

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
  fields: Partial<Record<TitleFieldCacheVariant, SessionTitleFields>>;
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
  opts?: TitleFieldReadOptions,
): SessionTitleFields {
  const scope = toTranscriptReadScope(target);
  const cacheKey = sqliteTitleFieldCacheKey(target);
  const watermark = readSessionTranscriptWatermark(scope);
  const variant = titleFieldCacheVariant(opts);
  const cached = sqliteTitleFieldCache.get(cacheKey);
  const cachedFields =
    cached?.generation === watermark.generation && cached.maxSeq === watermark.maxSeq
      ? cached.fields[variant]
      : undefined;
  if (cached && cachedFields) {
    setSqliteTitleFieldCache(cacheKey, cached);
    return { ...cachedFields };
  }
  let fields: SessionTitleFields;
  try {
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
    const includeInterSession = opts?.includeInterSession === true;
    let firstUser = findFirstTitleUserMessage(head, includeInterSession);
    // Read the widened range lazily (only when the head probe misses), reusing it
    // for the inter-session fallback below so that neither adds an extra DB read.
    let widened: SessionTranscriptMessageEvent[] | undefined;
    if (!firstUser && tail.totalMessages > SQLITE_TITLE_PROBE_INITIAL_MESSAGES) {
      widened = readSqliteTitleProbeRange(
        scope,
        tail.totalMessages,
        SQLITE_TITLE_PROBE_INITIAL_MESSAGES,
        SQLITE_TITLE_PROBE_MAX_MESSAGES,
      );
      firstUser = findFirstTitleUserMessage(widened, includeInterSession);
    }
    // Fallback: no direct end-user message exists anywhere probed. Accept a relayed
    // (inter-session) message as the title rather than deriveSessionTitle falling
    // through to the opaque sessionId. Re-scan the already-read pages only.
    if (!firstUser && opts?.fallbackToInterSession === true && !includeInterSession) {
      firstUser =
        findFirstTitleUserMessage(head, true) ??
        (widened ? findFirstTitleUserMessage(widened, true) : undefined);
    }
    fields = {
      firstUserMessage: firstUser ? extractMessageText(firstUser) : null,
      lastMessagePreview: lastText,
    };
  } catch (error) {
    if (!isSessionTranscriptProjectionUnavailableError(error)) {
      throw error;
    }
    // Titles are optional list decoration: degrade only this session while its projection rebuilds.
    // Do not cache nulls, so the next list can restore titles after reconciliation.
    sessionTitleProjectionUnavailableVersion += 1;
    return { ...EMPTY_SESSION_TITLE_FIELDS };
  }
  const fieldsByVariant =
    cached?.generation === watermark.generation && cached.maxSeq === watermark.maxSeq
      ? cached.fields
      : {};
  fieldsByVariant[variant] = fields;
  setSqliteTitleFieldCache(cacheKey, { ...watermark, fields: fieldsByVariant });
  return { ...fields };
}

function readSqliteTitleFieldsOrEmpty(
  target: ResolvedTranscriptReadTarget,
  opts?: TitleFieldReadOptions,
): SessionTitleFields {
  try {
    return readSqliteTitleFields(target, opts);
  } catch (error) {
    if (!isSessionTranscriptProjectionUnavailableError(error)) {
      throw error;
    }
    sessionTitleProjectionUnavailableVersion += 1;
    return { ...EMPTY_SESSION_TITLE_FIELDS };
  }
}

/** Batch-hydrates list title fields once per store, with canonical widening only for misses. */
function readSessionTitleFieldsFromTranscriptBatchCurrent(
  scopes: readonly SessionTranscriptReadScope[],
  opts?: TitleFieldReadOptions,
): SessionTitleFields[] {
  const targets: ResolvedTranscriptReadTarget[] = [];
  const variant = titleFieldCacheVariant(opts);
  const results = new Map<number, SessionTitleFields>();
  const misses: Array<{
    cacheKey: string;
    index: number;
    scope: SessionTranscriptReadScope;
    target: ResolvedTranscriptReadTarget;
  }> = [];
  const cachedCandidates: Array<{
    cacheKey: string;
    cached: SqliteTitleFieldCacheEntry;
    cachedFields: SessionTitleFields;
    index: number;
    scope: SessionTranscriptReadScope;
    target: ResolvedTranscriptReadTarget;
  }> = [];

  for (const [index, scope] of scopes.entries()) {
    const target = resolveTranscriptReadTarget(scope);
    targets.push(target);
    const cacheKey = sqliteTitleFieldCacheKey(target);
    const cached = sqliteTitleFieldCache.get(cacheKey);
    const cachedFields = cached?.fields[variant];
    if (cached && cachedFields) {
      cachedCandidates.push({ cacheKey, cached, cachedFields, index, scope, target });
      continue;
    }
    misses.push({ cacheKey, index, scope, target });
  }

  const watermarks = readSessionTranscriptWatermarkBatch(
    cachedCandidates.map((candidate) => candidate.scope),
  );
  for (const [candidateIndex, candidate] of cachedCandidates.entries()) {
    const watermark = watermarks[candidateIndex];
    if (
      watermark &&
      candidate.cached.generation === watermark.generation &&
      candidate.cached.maxSeq === watermark.maxSeq
    ) {
      setSqliteTitleFieldCache(candidate.cacheKey, candidate.cached);
      results.set(candidate.index, { ...candidate.cachedFields });
      continue;
    }
    misses.push({
      cacheKey: candidate.cacheKey,
      index: candidate.index,
      scope: candidate.scope,
      target: candidate.target,
    });
  }

  const probes =
    misses.length > 0 ? readSessionTranscriptTitleProbeBatch(misses.map((miss) => miss.scope)) : [];
  for (const [probeIndex, miss] of misses.entries()) {
    const probe = probes[probeIndex];
    if (!probe) {
      results.set(miss.index, readSqliteTitleFieldsOrEmpty(miss.target, opts));
      continue;
    }
    const cached = sqliteTitleFieldCache.get(miss.cacheKey);
    const cachedFields =
      cached?.generation === probe.generation && cached.maxSeq === probe.maxSeq
        ? cached.fields[variant]
        : undefined;
    if (cached && cachedFields) {
      setSqliteTitleFieldCache(miss.cacheKey, cached);
      results.set(miss.index, { ...cachedFields });
      continue;
    }
    const includeInterSession = opts?.includeInterSession === true;
    let firstUser = findFirstTitleUserMessage(probe.head, includeInterSession);
    const lastText = findLastMessageText(probe.tail);
    if (probe.totalMessages > SQLITE_TITLE_PROBE_INITIAL_MESSAGES && (!firstUser || !lastText)) {
      // A widen is needed; delegate to the single-scope reader, which applies the
      // same inter-session fallback over the wider probe range.
      results.set(miss.index, readSqliteTitleFieldsOrEmpty(miss.target, opts));
      continue;
    }
    // Fallback within the head probe: a relay-only session has no direct-user
    // title candidate, so accept the relayed (inter-session) message rather than
    // letting deriveSessionTitle collapse to the opaque sessionId.
    if (!firstUser && opts?.fallbackToInterSession === true && !includeInterSession) {
      firstUser = findFirstTitleUserMessage(probe.head, true);
    }
    const fields = {
      firstUserMessage: firstUser ? extractMessageText(firstUser) : null,
      lastMessagePreview: lastText,
    };
    const fieldsByVariant =
      cached?.generation === probe.generation && cached.maxSeq === probe.maxSeq
        ? cached.fields
        : {};
    fieldsByVariant[variant] = fields;
    setSqliteTitleFieldCache(miss.cacheKey, {
      generation: probe.generation,
      maxSeq: probe.maxSeq,
      fields: fieldsByVariant,
    });
    results.set(miss.index, { ...fields });
  }

  return targets.map((target, index) => {
    const fields = results.get(index);
    if (!fields) {
      throw new Error(`Missing batched title fields for session ${target.sessionId}`);
    }
    return fields;
  });
}

/** Batch-hydrates list title fields while isolating a rebuilding projection to its session. */
export function readSessionTitleFieldsFromTranscriptBatch(
  scopes: readonly SessionTranscriptReadScope[],
  opts?: TitleFieldReadOptions,
): SessionTitleFields[] {
  try {
    return readSessionTitleFieldsFromTranscriptBatchCurrent(scopes, opts);
  } catch (error) {
    if (!isSessionTranscriptProjectionUnavailableError(error)) {
      throw error;
    }
    return scopes.map((scope) =>
      readSqliteTitleFieldsOrEmpty(resolveTranscriptReadTarget(scope), opts),
    );
  }
}

/** Reads title and preview text from a transcript through the reader seam. */
export function readSessionTitleFieldsFromTranscript(
  scope: SessionTranscriptReadScope,
  opts?: TitleFieldReadOptions,
): SessionTitleFields {
  return readSqliteTitleFieldsOrEmpty(resolveTranscriptReadTarget(scope), opts);
}

/** Reads title and preview text asynchronously through the reader seam. */
export async function readSessionTitleFieldsFromTranscriptAsync(
  scope: SessionTranscriptReadScope,
  opts?: TitleFieldReadOptions,
): Promise<SessionTitleFields> {
  return readSqliteTitleFieldsOrEmpty(resolveTranscriptReadTarget(scope), opts);
}
