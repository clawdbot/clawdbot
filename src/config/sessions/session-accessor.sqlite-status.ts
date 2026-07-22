import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type {
  SessionEntryStatus,
  SessionEntrySummary,
} from "./session-accessor.sqlite-contract.js";
import type { SessionEntry } from "./types.js";

type SessionStatusDatabase = Pick<OpenClawAgentKyselyDatabase, "session_entries">;

export function normalizeSqliteStatus(value: unknown): SessionEntryStatus | null {
  return value === "running" ||
    value === "done" ||
    value === "failed" ||
    value === "killed" ||
    value === "timeout"
    ? value
    : null;
}

function normalizeSessionCreatorIdentity(value: unknown): SessionEntry["createdBy"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as { id?: unknown; label?: unknown };
  const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
  if (!id) {
    return undefined;
  }
  const label = typeof candidate.label === "string" ? candidate.label.trim() : "";
  return { id, ...(label ? { label } : {}) };
}

export function serializeSqliteSessionCreatorIdentity(
  createdBy: SessionEntry["createdBy"],
): string | null {
  const normalized = normalizeSessionCreatorIdentity(createdBy);
  return normalized ? JSON.stringify(normalized) : null;
}

export function parseSqliteSessionEntryJson(row: { entry_json: string }): SessionEntry | null {
  try {
    const parsed = JSON.parse(row.entry_json) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const entry = parsed as SessionEntry;
    // entry_json stays authoritative across downgrade/upgrade cycles: an older
    // binary can rewrite it without knowing about the additive projection column.
    const createdBy = normalizeSessionCreatorIdentity(entry.createdBy);
    if (createdBy) {
      entry.createdBy = createdBy;
    } else {
      delete entry.createdBy;
    }
    return entry;
  } catch {
    return null;
  }
}

export function readSqliteSessionEntriesByStatus(
  database: OpenClawAgentDatabase,
  statuses: readonly SessionEntryStatus[],
  sessionKeys?: readonly string[],
): SessionEntrySummary[] {
  const selectedStatuses = [...new Set(statuses)];
  const selectedSessionKeys = sessionKeys ? [...new Set(sessionKeys)] : undefined;
  if (selectedStatuses.length === 0 || selectedSessionKeys?.length === 0) {
    return [];
  }
  const db = getNodeSqliteKysely<SessionStatusDatabase>(database.db);
  let query = db
    .selectFrom("session_entries")
    .select(["session_key", "entry_json", "session_id", "updated_at"])
    .where("status", "in", selectedStatuses);
  if (selectedSessionKeys) {
    query = query.where("session_key", "in", selectedSessionKeys);
  }
  return executeSqliteQuerySync(database.db, query)
    .rows.flatMap((row) => {
      const entry = parseSqliteSessionEntryJson(row);
      return entry ? [{ entry, sessionKey: row.session_key }] : [];
    })
    .toSorted((a, b) => a.sessionKey.localeCompare(b.sessionKey));
}
