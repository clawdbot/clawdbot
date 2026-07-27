import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { isInternalSessionEffectsKey } from "./internal-session-key.js";
import type { SessionTranscriptInstance } from "./session-accessor.sqlite-contract.js";
import { formatSqliteSessionFileMarker } from "./sqlite-marker.js";
import type { SessionEntry } from "./types.js";

export function listSqliteTranscriptInstancesFromDatabase(params: {
  agentId: string;
  currentEntries: ReadonlyMap<string, SessionEntry>;
  database: OpenClawAgentDatabase;
  databasePath: string;
}): SessionTranscriptInstance[] {
  const db = getNodeSqliteKysely<OpenClawAgentKyselyDatabase>(params.database.db);
  const rows = executeSqliteQuerySync(
    params.database.db,
    db
      .selectFrom("session_windows")
      .select([
        "session_id",
        "session_key",
        "transcript_updated_at",
        "session_entry_provenance",
        "acp_owned",
        "plugin_owner_id",
        "hook_external_content_source",
        "parent_session_key",
        "spawned_by",
        "chat_type",
      ])
      .where("transcript_updated_at", "is not", null)
      .orderBy("transcript_updated_at", "desc")
      .orderBy("session_id", "asc"),
  ).rows;
  return rows
    .map((row): SessionTranscriptInstance | undefined => {
      if (isInternalSessionEffectsKey(row.session_key) || row.transcript_updated_at === null) {
        return undefined;
      }
      const updatedAtMs = row.transcript_updated_at;
      const current = params.currentEntries.get(row.session_key);
      // Matching identities cannot classify transcript content written before provenance existed.
      const currentIsExact = current?.sessionId === row.session_id;
      const provenanceKnown = row.session_entry_provenance === 1;
      const hookExternalContentSource =
        row.hook_external_content_source === "gmail" ||
        row.hook_external_content_source === "webhook"
          ? row.hook_external_content_source
          : undefined;
      const chatType =
        row.chat_type === "direct" || row.chat_type === "group" || row.chat_type === "channel"
          ? row.chat_type
          : undefined;
      const entry: SessionEntry = {
        ...(currentIsExact && current ? structuredClone(current) : {}),
        sessionId: row.session_id,
        sessionFile: formatSqliteSessionFileMarker({
          agentId: params.agentId,
          sessionId: row.session_id,
          storePath: params.databasePath,
        }),
        updatedAt: updatedAtMs,
        ...(row.parent_session_key ? { parentSessionKey: row.parent_session_key } : {}),
        ...(row.spawned_by ? { spawnedBy: row.spawned_by, spawnDepth: 1 } : {}),
        ...(chatType ? { chatType } : {}),
        ...(provenanceKnown && row.plugin_owner_id ? { pluginOwnerId: row.plugin_owner_id } : {}),
        ...(provenanceKnown && hookExternalContentSource ? { hookExternalContentSource } : {}),
      };
      return {
        acpOwned: row.acp_owned === 1 || Boolean(currentIsExact && current?.acp),
        entry,
        provenanceKnown,
        sessionId: row.session_id,
        sessionKey: row.session_key,
        updatedAtMs,
      };
    })
    .filter((entry): entry is SessionTranscriptInstance => entry !== undefined);
}
