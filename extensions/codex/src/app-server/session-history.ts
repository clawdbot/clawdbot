/**
 * Reads OpenClaw session history for Codex transcript mirroring and sanitizes
 * image payloads before replaying messages into the app-server projector.
 */
import fs from "node:fs/promises";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { SessionEntry } from "openclaw/plugin-sdk/agent-sessions";
import {
  buildSessionContext,
  migrateSessionEntries,
  parseSessionEntries,
} from "openclaw/plugin-sdk/agent-sessions";
import {
  listSessionEntries,
  parseSqliteSessionFileMarker,
  type SqliteSessionFileMarker,
} from "openclaw/plugin-sdk/session-store-runtime";
import {
  readSessionTranscriptEvents,
  readSessionTranscriptRawDelta,
  readSessionTranscriptVisibleMessageDelta,
} from "openclaw/plugin-sdk/session-transcript-runtime";
import { sanitizeCodexHistoryImagePayloads } from "./image-payload-sanitizer.js";

const CODEX_HISTORY_PAGE_MAX_BYTES = 64 * 1024 * 1024;
const CODEX_HISTORY_PAGE_MAX_EVENTS = 10_000;

function isMissingFileError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

type CodexMirroredSessionHistoryTarget = {
  agentId?: string;
  sessionFile: string;
  sessionId: string;
  sessionKey?: string;
};

/** One prepared Codex history plus an optional append-stable SQLite continuation. */
export type CodexMirroredSessionHistorySnapshot = {
  messages: AgentMessage[];
  sqliteContinuation?: {
    appendTailEntryId: string | null;
    cursor: string;
  };
};

function selectPreferredSessionKey(
  matches: Array<{ entry: { updatedAt?: number }; sessionKey: string }>,
  sessionId: string,
): string | undefined {
  const structural = matches.filter(
    ({ sessionKey }) => sessionKey === sessionId || sessionKey.endsWith(`:${sessionId}`),
  );
  const candidates = structural.length > 0 ? structural : matches;
  if (candidates.length === 1) {
    return candidates[0]?.sessionKey;
  }
  const sorted = candidates.toSorted(
    (left, right) => (right.entry.updatedAt ?? 0) - (left.entry.updatedAt ?? 0),
  );
  return (sorted[0]?.entry.updatedAt ?? 0) > (sorted[1]?.entry.updatedAt ?? 0)
    ? sorted[0]?.sessionKey
    : undefined;
}

/** Returns sanitized session-context messages for a Codex mirrored session file. */
export async function readCodexMirroredSessionHistoryMessages(
  target: CodexMirroredSessionHistoryTarget,
): Promise<AgentMessage[] | undefined> {
  return (await readCodexMirroredSessionHistorySnapshot(target))?.messages;
}

/** Returns one prepared history snapshot that later SQLite appends can extend safely. */
export async function readCodexMirroredSessionHistorySnapshot(
  target: CodexMirroredSessionHistoryTarget,
): Promise<CodexMirroredSessionHistorySnapshot | undefined> {
  try {
    const sqliteMarker = parseSqliteSessionFileMarker(target.sessionFile);
    if (sqliteMarker) {
      return await readCodexMirroredSqliteSessionHistorySnapshot(target, sqliteMarker);
    }
    return buildCodexMirroredSessionHistorySnapshot(await readCodexMirroredSessionEntries(target));
  } catch (error) {
    // A new Codex session can be read before its transcript exists; other failures still warn.
    if (isMissingFileError(error)) {
      return { messages: [] };
    }
    return undefined;
  }
}

/** Checks whether a mirrored history has any visible messages without loading all payload rows. */
export async function hasCodexMirroredSessionHistory(
  target: CodexMirroredSessionHistoryTarget,
): Promise<boolean | undefined> {
  try {
    const sqliteMarker = parseSqliteSessionFileMarker(target.sessionFile);
    if (!sqliteMarker) {
      const snapshot = await readCodexMirroredSessionHistorySnapshot(target);
      return snapshot ? snapshot.messages.length > 0 : undefined;
    }
    const sqliteTarget = resolveCodexMirroredSqliteTarget(target, sqliteMarker);
    if (!sqliteTarget) {
      return false;
    }
    const page = await readSessionTranscriptVisibleMessageDelta({
      ...sqliteTarget,
      maxBytes: CODEX_HISTORY_PAGE_MAX_BYTES,
      maxMessages: 1,
    });
    if (page.kind === "page") {
      return page.entries.length > 0
        ? true
        : page.requiredBytes !== undefined || page.hasMore
          ? undefined
          : false;
    }
    return page.kind === "missing" ? false : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Refreshes a prepared snapshot from its SQLite cursor.
 *
 * Only a proven linear message append is applied in memory. Any rewrite,
 * branch/control entry, or parent discontinuity falls back to a full read.
 */
export async function refreshCodexMirroredSessionHistorySnapshot(
  target: CodexMirroredSessionHistoryTarget,
  snapshot: CodexMirroredSessionHistorySnapshot,
): Promise<CodexMirroredSessionHistorySnapshot | undefined> {
  try {
    const sqliteMarker = parseSqliteSessionFileMarker(target.sessionFile);
    const continuation = snapshot.sqliteContinuation;
    if (!sqliteMarker || !continuation) {
      return await readCodexMirroredSessionHistorySnapshot(target);
    }
    const sqliteTarget = resolveCodexMirroredSqliteTarget(target, sqliteMarker);
    if (!sqliteTarget) {
      return { messages: [] };
    }
    const delta = await readCodexMirroredSqliteDelta(sqliteTarget, continuation.cursor);
    if (!delta) {
      return await readCodexMirroredSessionHistorySnapshot(target);
    }
    let appendTailEntryId: string | null = continuation.appendTailEntryId;
    const appendedMessages: AgentMessage[] = [];
    for (const event of delta.events) {
      const entry = asLinearMessageAppend(event, appendTailEntryId);
      if (!entry) {
        return await readCodexMirroredSessionHistorySnapshot(target);
      }
      appendTailEntryId = entry.id;
      appendedMessages.push(entry.message);
    }
    return {
      messages:
        appendedMessages.length === 0
          ? snapshot.messages
          : snapshot.messages.concat(
              sanitizeCodexHistoryImagePayloads(appendedMessages, "codex mirrored history"),
            ),
      sqliteContinuation: {
        appendTailEntryId,
        cursor: delta.cursor,
      },
    };
  } catch {
    return undefined;
  }
}

function buildCodexMirroredSessionHistorySnapshot(
  entries: SessionEntry[],
  sqliteCursor?: string,
  expectedSessionId?: string,
): CodexMirroredSessionHistorySnapshot | undefined {
  if (entries.length === 0) {
    return { messages: [] };
  }
  const firstEntry = entries[0] as { type?: unknown; id?: unknown } | undefined;
  if (firstEntry?.type !== "session") {
    // A well-formed transcript that does not open with a `session` marker is
    // simply not a Codex-mirrored session (e.g. a non-Codex model run reusing
    // this hook) — an empty mirror, not a read failure, so callers must not
    // warn. `undefined` stays reserved for genuine failures: read/parse errors
    // (caught below) and malformed `session` headers (next check).
    return { messages: [] };
  }
  if (
    typeof firstEntry.id !== "string" ||
    (expectedSessionId !== undefined && firstEntry.id !== expectedSessionId)
  ) {
    // A `session` header without a string id is a corrupted Codex transcript,
    // not a foreign one — keep it on the warn path.
    return undefined;
  }
  const appendTailEntryId =
    sqliteCursor !== undefined ? readLinearAppendTailEntryId(entries) : undefined;
  migrateSessionEntries(entries);
  const sessionEntries = entries.filter((entry): entry is SessionEntry => {
    return (
      entry !== null &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      (entry as { type?: unknown }).type !== "session"
    );
  });
  return {
    messages: sanitizeCodexHistoryImagePayloads(
      buildSessionContext(sessionEntries).messages,
      "codex mirrored history",
    ),
    ...(sqliteCursor !== undefined && appendTailEntryId !== undefined
      ? {
          sqliteContinuation: {
            appendTailEntryId,
            cursor: sqliteCursor,
          },
        }
      : {}),
  };
}

function readLinearAppendTailEntryId(entries: readonly SessionEntry[]): string | null | undefined {
  let tailEntryId: string | null = null;
  for (const value of entries.slice(1)) {
    const entry = value as unknown as Record<string, unknown>;
    if (
      entry.type === "leaf" ||
      typeof entry.id !== "string" ||
      (entry.parentId !== null && typeof entry.parentId !== "string") ||
      entry.parentId !== tailEntryId
    ) {
      return undefined;
    }
    tailEntryId = entry.id;
  }
  return tailEntryId;
}

function asLinearMessageAppend(
  value: unknown,
  expectedParentId: string | null,
): { id: string; message: AgentMessage } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const entry = value as Record<string, unknown>;
  if (
    entry.type !== "message" ||
    typeof entry.id !== "string" ||
    entry.parentId !== expectedParentId ||
    !entry.message ||
    typeof entry.message !== "object" ||
    Array.isArray(entry.message)
  ) {
    return undefined;
  }
  return { id: entry.id, message: entry.message as AgentMessage };
}

async function readCodexMirroredSessionEntries(
  target: CodexMirroredSessionHistoryTarget,
): Promise<SessionEntry[]> {
  const sqliteMarker = parseSqliteSessionFileMarker(target.sessionFile);
  if (sqliteMarker) {
    if (
      sqliteMarker.sessionId !== target.sessionId ||
      (target.agentId !== undefined && sqliteMarker.agentId !== target.agentId)
    ) {
      return [];
    }
    const sessionKey = resolveSqliteMarkerSessionKey(target, sqliteMarker);
    if (!sessionKey) {
      return [];
    }
    return (await readSessionTranscriptEvents({
      agentId: sqliteMarker.agentId,
      sessionId: sqliteMarker.sessionId,
      sessionKey,
      storePath: sqliteMarker.storePath,
    })) as SessionEntry[];
  }
  return parseSessionEntries(await fs.readFile(target.sessionFile, "utf-8")) as SessionEntry[];
}

function resolveCodexMirroredSqliteTarget(
  target: CodexMirroredSessionHistoryTarget,
  marker: SqliteSessionFileMarker,
):
  | {
      agentId: string;
      sessionId: string;
      sessionKey: string;
      storePath: string;
    }
  | undefined {
  if (
    marker.sessionId !== target.sessionId ||
    (target.agentId !== undefined && marker.agentId !== target.agentId)
  ) {
    return undefined;
  }
  // Active Codex mirroring can publish transcript rows before the session-list
  // projection is visible. The exact caller key remains safe because the
  // marker already proves agent/session identity and the transcript header is
  // validated before any messages are returned.
  const sessionKey = resolveSqliteMarkerSessionKey(target, marker) ?? target.sessionKey?.trim();
  return sessionKey
    ? {
        agentId: marker.agentId,
        sessionId: marker.sessionId,
        sessionKey,
        storePath: marker.storePath,
      }
    : undefined;
}

async function readCodexMirroredSqliteSessionHistorySnapshot(
  target: CodexMirroredSessionHistoryTarget,
  marker: SqliteSessionFileMarker,
): Promise<CodexMirroredSessionHistorySnapshot | undefined> {
  const sqliteTarget = resolveCodexMirroredSqliteTarget(target, marker);
  if (!sqliteTarget) {
    return { messages: [] };
  }
  const delta = await readCodexMirroredSqliteDelta(sqliteTarget);
  if (!delta) {
    return buildCodexMirroredSessionHistorySnapshot(
      (await readSessionTranscriptEvents(sqliteTarget)) as SessionEntry[],
      undefined,
      sqliteTarget.sessionId,
    );
  }
  return buildCodexMirroredSessionHistorySnapshot(
    delta.events as SessionEntry[],
    delta.cursor,
    sqliteTarget.sessionId,
  );
}

async function readCodexMirroredSqliteDelta(
  target: {
    agentId: string;
    sessionId: string;
    sessionKey: string;
    storePath: string;
  },
  initialCursor?: string,
): Promise<{ cursor: string; events: unknown[] } | undefined> {
  const events: unknown[] = [];
  let cursor = initialCursor;
  while (true) {
    const page = await readSessionTranscriptRawDelta({
      ...target,
      ...(cursor !== undefined ? { cursor } : {}),
      maxBytes: CODEX_HISTORY_PAGE_MAX_BYTES,
      maxEvents: CODEX_HISTORY_PAGE_MAX_EVENTS,
    });
    if (page.kind !== "page") {
      return undefined;
    }
    events.push(...page.events.map((row) => row.event));
    cursor = page.cursor;
    if (!page.hasMore) {
      return { cursor, events };
    }
    if (page.events.length === 0) {
      return undefined;
    }
  }
}

function resolveSqliteMarkerSessionKey(
  target: CodexMirroredSessionHistoryTarget,
  marker: SqliteSessionFileMarker,
): string | undefined {
  const explicitSessionKey = target.sessionKey?.trim();
  const entries = listSessionEntries({
    agentId: marker.agentId,
    readOnly: true,
    storePath: marker.storePath,
  });
  if (explicitSessionKey) {
    const explicitEntry = entries.find(({ sessionKey }) => sessionKey === explicitSessionKey);
    if (explicitEntry) {
      return explicitEntry.entry.sessionId === marker.sessionId ? explicitSessionKey : undefined;
    }
  }
  const matches = entries.filter(({ entry }) => entry.sessionId === marker.sessionId);
  return selectPreferredSessionKey(matches, marker.sessionId);
}
