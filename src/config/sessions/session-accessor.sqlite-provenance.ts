import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { SessionEntry } from "./types.js";

type SessionProvenanceRow = {
  acp_owned: number;
  hook_external_content_source: "gmail" | "webhook" | null;
  plugin_owner_id: string | null;
  session_entry_provenance: number;
};

export function bindSessionEntryProvenance(entry: SessionEntry): SessionProvenanceRow {
  const hookSource = entry.hookExternalContentSource;
  return {
    session_entry_provenance: 1,
    acp_owned: entry.acp ? 1 : 0,
    plugin_owner_id:
      typeof entry.pluginOwnerId === "string" && entry.pluginOwnerId.trim()
        ? entry.pluginOwnerId.trim()
        : null,
    hook_external_content_source:
      hookSource === "gmail" || hookSource === "webhook" ? hookSource : null,
  };
}

export function resolveSessionEntryProvenanceRow<T extends SessionProvenanceRow>(params: {
  boundSessionRow: T;
  database: OpenClawAgentDatabase;
  entry: SessionEntry;
  previousEntry?: SessionEntry;
}): T {
  const db = getNodeSqliteKysely<OpenClawAgentKyselyDatabase>(params.database.db);
  const existingRoot = executeSqliteQueryTakeFirstSync(
    params.database.db,
    db
      .selectFrom("session_windows")
      .select([
        "session_entry_provenance",
        "acp_owned",
        "plugin_owner_id",
        "hook_external_content_source",
      ])
      .where("session_id", "=", params.entry.sessionId),
  );
  const hasTranscript = Boolean(
    executeSqliteQueryTakeFirstSync(
      params.database.db,
      db
        .selectFrom("transcript_events")
        .select("seq")
        .where("session_id", "=", params.entry.sessionId)
        .limit(1),
    ),
  );
  // Updates cannot prove provenance for a migrated transcript. Known exclusion metadata is monotonic.
  if (
    existingRoot?.session_entry_provenance === 0 &&
    (params.previousEntry?.sessionId === params.entry.sessionId || hasTranscript)
  ) {
    return {
      ...params.boundSessionRow,
      session_entry_provenance: 0,
      acp_owned: 0,
      plugin_owner_id: null,
      hook_external_content_source: null,
    };
  }
  return existingRoot?.session_entry_provenance === 1
    ? {
        ...params.boundSessionRow,
        acp_owned: existingRoot.acp_owned === 1 ? 1 : params.boundSessionRow.acp_owned,
        plugin_owner_id: params.boundSessionRow.plugin_owner_id ?? existingRoot.plugin_owner_id,
        hook_external_content_source:
          params.boundSessionRow.hook_external_content_source ??
          existingRoot.hook_external_content_source,
      }
    : params.boundSessionRow;
}
