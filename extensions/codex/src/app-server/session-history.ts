/** Reads model context separately from full-fidelity Codex mirror evidence. */
import fs from "node:fs/promises";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { SessionEntry } from "openclaw/plugin-sdk/agent-sessions";
import {
  buildSessionContext,
  migrateSessionEntries,
  parseSessionEntries,
  SessionManager,
} from "openclaw/plugin-sdk/agent-sessions";
import {
  getSessionEntry,
  parseSqliteSessionFileMarker,
  resolveTranscriptSessionKeyBySessionId,
  type SqliteSessionFileMarker,
} from "openclaw/plugin-sdk/session-store-runtime";
import type {
  TranscriptTurnAdmission,
  SessionTranscriptTargetParams,
} from "openclaw/plugin-sdk/session-transcript-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { sanitizeCodexHistoryImagePayloads } from "./image-payload-sanitizer.js";

type CodexHistoryView = "native-evidence" | "model-context";
export type CodexMirroredSessionHistoryTarget = {
  agentId?: string;
  sessionFile: string;
  sessionId: string;
  sessionKey?: string;
  sessionTarget?: Partial<SessionTranscriptTargetParams>;
};

/** Returns sanitized session-context messages for consumers that need an owned array. */
export async function readCodexMirroredSessionHistoryMessages(
  target: CodexMirroredSessionHistoryTarget,
  admission?: TranscriptTurnAdmission,
  view: CodexHistoryView = "native-evidence",
): Promise<AgentMessage[] | undefined> {
  return readCodexMirroredSessionHistory(
    target,
    (messages) => Array.from(messages),
    admission,
    view,
  );
}

/** The synchronous consumer can reject before further SQLite message payloads are acquired. */
export async function readCodexMirroredSessionHistory<T>(
  target: CodexMirroredSessionHistoryTarget,
  read: (messages: Iterable<AgentMessage>) => T,
  admission?: TranscriptTurnAdmission,
  view: CodexHistoryView = "native-evidence",
): Promise<T | undefined> {
  const consume = (
    messages: Iterable<AgentMessage>,
    header: unknown,
    imageLabel = "codex mirrored history",
  ): T | undefined => {
    // Foreign or absent headers are empty history; malformed session headers are read failures.
    if (!isRecord(header) || header.type !== "session") {
      return read([]);
    }
    if (typeof header.id !== "string") {
      return undefined;
    }
    if (header.id !== target.sessionId) {
      return read([]);
    }
    return read(
      (function* () {
        for (const message of messages) {
          yield sanitizeCodexHistoryImagePayloads(message, imageLabel);
        }
      })(),
    );
  };
  const readTarget = (
    transcriptTarget: Required<
      Pick<SessionTranscriptTargetParams, "agentId" | "sessionId" | "sessionKey" | "storePath">
    >,
  ) => {
    if (view === "native-evidence") {
      return SessionManager.readSessionContext(transcriptTarget, consume, { admission });
    }
    const loaded = SessionManager.openModelContext(transcriptTarget, { admission });
    return consume(
      loaded.buildSessionContext().messages,
      loaded.getHeader(),
      "codex mirrored model context",
    );
  };
  try {
    if (target.sessionTarget) {
      const { agentId, sessionId, sessionKey, storePath } = target.sessionTarget;
      if (
        !agentId ||
        !sessionId ||
        !sessionKey ||
        !storePath ||
        sessionId !== target.sessionId ||
        (target.agentId !== undefined && agentId !== target.agentId) ||
        (target.sessionKey !== undefined && sessionKey !== target.sessionKey)
      ) {
        return read([]);
      }
      return readTarget({ agentId, sessionId, sessionKey, storePath });
    }
    const sqliteMarker = parseSqliteSessionFileMarker(target.sessionFile);
    if (sqliteMarker) {
      if (
        sqliteMarker.sessionId !== target.sessionId ||
        (target.agentId !== undefined && sqliteMarker.agentId !== target.agentId)
      ) {
        return read([]);
      }
      const sessionKey = resolveSqliteMarkerSessionKey(target, sqliteMarker);
      if (!sessionKey) {
        return read([]);
      }
      return readTarget({
        agentId: sqliteMarker.agentId,
        sessionId: sqliteMarker.sessionId,
        sessionKey,
        storePath: sqliteMarker.storePath,
      });
    }
    if (admission) {
      if (
        admission.sessionId !== target.sessionId ||
        (target.agentId !== undefined && admission.agentId !== target.agentId) ||
        (target.sessionKey !== undefined && admission.sessionKey !== target.sessionKey)
      ) {
        return read([]);
      }
      return readTarget({
        agentId: admission.agentId,
        sessionId: admission.sessionId,
        sessionKey: admission.sessionKey,
        storePath: admission.storePath,
      });
    }
    // File-only callers retain the legacy import codec; runtime identities never read this path.
    const entries = parseSessionEntries(await fs.readFile(target.sessionFile, "utf-8"));
    return consume(
      (function* () {
        migrateSessionEntries(entries);
        const sessionEntries = entries.filter(
          (entry): entry is SessionEntry => isRecord(entry) && entry.type !== "session",
        );
        yield* buildSessionContext(sessionEntries).messages;
      })(),
      entries[0],
    );
  } catch (error) {
    // A new session can be read before its transcript exists; other failures still warn.
    if (isRecord(error) && error.code === "ENOENT") {
      return read([]);
    }
    return undefined;
  }
}

function resolveSqliteMarkerSessionKey(
  target: CodexMirroredSessionHistoryTarget,
  marker: SqliteSessionFileMarker,
): string | undefined {
  const explicitSessionKey = target.sessionKey?.trim();
  if (explicitSessionKey) {
    // The SDK exact-entry accessor uses a read-only database handle.
    const explicitEntry = getSessionEntry({
      agentId: marker.agentId,
      sessionKey: explicitSessionKey,
      storePath: marker.storePath,
    });
    if (explicitEntry) {
      return explicitEntry.sessionId === marker.sessionId ? explicitSessionKey : undefined;
    }
  }
  return resolveTranscriptSessionKeyBySessionId({
    agentId: marker.agentId,
    sessionId: marker.sessionId,
    storePath: marker.storePath,
  });
}
