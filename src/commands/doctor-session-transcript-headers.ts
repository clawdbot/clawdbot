import fs from "node:fs";
import { note } from "../../packages/terminal-core/src/note.js";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { isIndexedSessionEntry } from "../agents/sessions/session-manager-codec.js";
import type { TranscriptEvent } from "../config/sessions/session-accessor.js";
import {
  readTranscriptStorageRows,
  type SqliteTranscriptStorageRow,
} from "../config/sessions/session-accessor.sqlite-read.js";
import { getSessionKysely } from "../config/sessions/session-accessor.sqlite-scope.js";
import { replaceSqliteTranscriptEventsInTransaction } from "../config/sessions/session-accessor.sqlite-transcript-store.js";
import { resolveAllAgentSessionStoreTargetsSync } from "../config/sessions/targets.js";
import { createSessionTranscriptHeader } from "../config/sessions/transcript-header.js";
import {
  isCanonicalSessionTranscriptEntry,
  isSessionTranscriptLeafControl,
} from "../config/sessions/transcript-tree.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { executeSqliteQueryTakeFirstSync } from "../infra/kysely-sync.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import {
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import {
  readOnlySqliteTranscriptSessionIds,
  readOnlySqliteTranscriptStorageSnapshot,
  resolveTargetSqlitePath,
} from "./doctor-session-sqlite-readers.js";

const NOTE_TITLE = "Session transcript headers";

type HeaderRepairContext = {
  sessionKey: string;
  spawnedCwd?: string;
};

type HeaderRepairReport = {
  found: number;
  repaired: number;
};

function parseCanonicalHeaderlessEvents(
  rows: readonly SqliteTranscriptStorageRow[],
  sessionId: string,
): TranscriptEvent[] | undefined {
  if (rows.length === 0) {
    return undefined;
  }
  const events: TranscriptEvent[] = [];
  const eventIds = new Set<string>([sessionId]);
  let indexedEntries = 0;
  for (const row of rows) {
    let event: TranscriptEvent;
    try {
      event = JSON.parse(row.eventJson) as TranscriptEvent;
    } catch {
      return undefined;
    }
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      return undefined;
    }
    const record = event as Record<string, unknown>;
    if (record.type === "session") {
      return undefined;
    }
    // Known transcript entries must already satisfy the current runtime schema. Opaque plugin
    // rows remain uninterpreted, but malformed leaf controls and duplicate identities would make
    // a delete-and-reinsert repair lossy or ambiguous, so fail closed on those shapes.
    if (isCanonicalSessionTranscriptEntry(record)) {
      if (!isIndexedSessionEntry(event)) {
        return undefined;
      }
      indexedEntries += 1;
    } else if (record.type === "leaf" && !isSessionTranscriptLeafControl(record)) {
      return undefined;
    }
    if (typeof record.id === "string") {
      const eventId = record.id.trim();
      if (!eventId || eventIds.has(eventId)) {
        return undefined;
      }
      eventIds.add(eventId);
    }
    events.push(event);
  }
  return indexedEntries > 0 ? events : undefined;
}

function snapshotsMatch(
  expected: readonly SqliteTranscriptStorageRow[],
  current: readonly SqliteTranscriptStorageRow[],
): boolean {
  return (
    expected.length === current.length &&
    expected.every(
      (row, index) =>
        row.seq === current[index]?.seq &&
        row.createdAt === current[index]?.createdAt &&
        row.eventJson === current[index]?.eventJson,
    )
  );
}

function readHeaderRepairContext(
  database: OpenClawAgentDatabase,
  sessionId: string,
): HeaderRepairContext | undefined {
  const db = getSessionKysely(database.db);
  const window = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("session_windows")
      .select("session_key")
      .where("session_id", "=", sessionId)
      .limit(1),
  );
  if (!window?.session_key) {
    return undefined;
  }
  const node = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("session_nodes")
      .select(["current_session_id", "entry_json"])
      .where("session_key", "=", window.session_key)
      .limit(1),
  );
  let spawnedCwd: string | undefined;
  // Historical windows can share a key; only the node's current session owns entry_json.
  if (node?.current_session_id === sessionId && node.entry_json) {
    try {
      const entry = JSON.parse(node.entry_json) as {
        sessionId?: unknown;
        spawnedCwd?: unknown;
      };
      if (
        entry.sessionId === sessionId &&
        typeof entry.spawnedCwd === "string" &&
        entry.spawnedCwd.trim()
      ) {
        spawnedCwd = entry.spawnedCwd.trim();
      }
    } catch {
      // The transcript can still be repaired with the configured agent workspace.
    }
  }
  return { sessionKey: window.session_key, ...(spawnedCwd ? { spawnedCwd } : {}) };
}

function formatHeaderTimestamp(createdAt: number): string | undefined {
  if (!Number.isFinite(createdAt)) {
    return undefined;
  }
  try {
    return new Date(createdAt).toISOString();
  } catch {
    return undefined;
  }
}

function assertRepairPreservedEvents(params: {
  before: readonly SqliteTranscriptStorageRow[];
  database: OpenClawAgentDatabase;
  sessionId: string;
}): void {
  const after = readTranscriptStorageRows(params.database, params.sessionId);
  if (after.length !== params.before.length + 1) {
    throw new Error(`header repair changed the event count for ${params.sessionId}`);
  }
  for (const [index, beforeRow] of params.before.entries()) {
    const afterRow = after[index + 1];
    if (!afterRow || afterRow.createdAt !== beforeRow.createdAt) {
      throw new Error(`header repair changed row timestamps for ${params.sessionId}`);
    }
    const beforeEvent = JSON.parse(beforeRow.eventJson) as Record<string, unknown>;
    const afterEvent = JSON.parse(afterRow.eventJson) as Record<string, unknown>;
    if (
      beforeEvent.id !== afterEvent.id ||
      beforeEvent.parentId !== afterEvent.parentId ||
      beforeEvent.targetId !== afterEvent.targetId ||
      beforeEvent.appendParentId !== afterEvent.appendParentId
    ) {
      throw new Error(`header repair changed event identity for ${params.sessionId}`);
    }
  }
}

function formatCount(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

/** Reports or repairs canonical SQLite transcripts whose first header was never persisted. */
export async function noteSessionTranscriptHeaderHealth(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  shouldRepair: boolean;
}): Promise<HeaderRepairReport> {
  const env = params.env ?? process.env;
  let found = 0;
  let repaired = 0;

  const targetsBySqlitePath = new Map<string, { agentId: string; storePath: string }>();
  for (const target of resolveAllAgentSessionStoreTargetsSync(params.cfg, { env })) {
    const sqlitePath = resolveTargetSqlitePath(target);
    if (!targetsBySqlitePath.has(sqlitePath)) {
      targetsBySqlitePath.set(sqlitePath, target);
    }
  }

  for (const [sqlitePath, target] of targetsBySqlitePath) {
    if (!fs.existsSync(sqlitePath)) {
      continue;
    }
    const databaseOptions = { agentId: target.agentId, env, path: sqlitePath };
    try {
      for (const sessionId of readOnlySqliteTranscriptSessionIds(sqlitePath)) {
        const snapshot = readOnlySqliteTranscriptStorageSnapshot(sqlitePath, sessionId);
        if (!snapshot.ok) {
          const detail = formatErrorMessage(snapshot.error).replace(/\s+/g, " ").trim();
          note(
            `- Failed to read transcript ${sessionId} (${target.agentId}): ${detail}`,
            NOTE_TITLE,
          );
          continue;
        }
        if (!snapshot.sessionKey || !parseCanonicalHeaderlessEvents(snapshot.rows, sessionId)) {
          continue;
        }
        const headerTimestamp = formatHeaderTimestamp(snapshot.rows[0]?.createdAt ?? Number.NaN);
        if (!headerTimestamp) {
          note(
            `- Failed to repair transcript ${sessionId} (${target.agentId}): invalid first-row timestamp`,
            NOTE_TITLE,
          );
          continue;
        }
        found += 1;
        if (!params.shouldRepair) {
          continue;
        }

        const logicalAgentId = parseAgentSessionKey(snapshot.sessionKey)?.agentId ?? target.agentId;
        const workspaceCwd = resolveAgentWorkspaceDir(params.cfg, logicalAgentId, env);
        try {
          runOpenClawAgentWriteTransaction(
            (database) => {
              const currentRows = readTranscriptStorageRows(database, sessionId);
              if (!snapshotsMatch(snapshot.rows, currentRows)) {
                throw new Error(
                  `transcript changed while preparing header repair for ${sessionId}`,
                );
              }
              const events = parseCanonicalHeaderlessEvents(currentRows, sessionId);
              if (!events) {
                throw new Error(
                  `transcript is no longer a canonical headerless session: ${sessionId}`,
                );
              }
              const context = readHeaderRepairContext(database, sessionId);
              if (!context || context.sessionKey !== snapshot.sessionKey) {
                throw new Error(
                  `session binding changed while preparing header repair for ${sessionId}`,
                );
              }
              const header = createSessionTranscriptHeader({
                cwd: context.spawnedCwd ?? workspaceCwd,
                sessionId,
                timestamp: headerTimestamp,
              });
              replaceSqliteTranscriptEventsInTransaction(
                database,
                {
                  agentId: target.agentId,
                  env,
                  path: sqlitePath,
                  sessionId,
                  sessionKey: context.sessionKey,
                },
                [header, ...events],
                {
                  createdAtByIndex: [
                    currentRows[0]?.createdAt ?? Date.parse(headerTimestamp),
                    ...currentRows.map((row) => row.createdAt),
                  ],
                  preserveSessionWindowRecency: true,
                },
              );
              assertRepairPreservedEvents({ before: currentRows, database, sessionId });
            },
            databaseOptions,
            { operationLabel: "doctor.session-transcript-headers" },
          );
          repaired += 1;
        } catch (error) {
          const detail = formatErrorMessage(error).replace(/\s+/g, " ").trim();
          note(
            `- Failed to repair transcript ${sessionId} (${target.agentId}): ${detail}`,
            NOTE_TITLE,
          );
        }
      }
    } catch (error) {
      const detail = formatErrorMessage(error).replace(/\s+/g, " ").trim();
      note(
        `- Failed to inspect transcript headers for ${target.agentId} (${sqlitePath}): ${detail}`,
        NOTE_TITLE,
      );
    }
  }

  if (params.shouldRepair && repaired > 0) {
    note(
      `- Prepended current headers to ${formatCount(repaired, "session transcript")}.`,
      NOTE_TITLE,
    );
  } else if (!params.shouldRepair && found > 0) {
    note(
      [
        `- Found ${formatCount(found, "canonical session transcript")} without a header.`,
        `- Run "openclaw doctor --fix" to repair ${found === 1 ? "it" : "them"} before resuming the session.`,
      ].join("\n"),
      NOTE_TITLE,
    );
  }

  return { found, repaired };
}
