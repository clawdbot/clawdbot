import { asOptionalRecord, readStringField } from "@openclaw/normalization-core/record-coerce";
import { sql } from "kysely";
import { decodeSqliteTextBytes, executeSqliteQueryTakeFirstSync } from "../../infra/kysely-sync.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";

// Collaboration guards need only the node/entry link, without full entry normalization.
// Decode raw JSON in JS so malformed JSON and duplicate keys retain their existing meaning.
export function readSessionEntryInstanceId(
  database: Pick<OpenClawAgentDatabase, "db">,
  sessionKey: string,
): string | undefined {
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    getSessionKysely(database.db)
      .selectFrom("session_nodes")
      // Project TEXT as BLOB before node:sqlite can truncate embedded NUL bytes.
      .select([
        /* kysely-allow-raw: preserve exact session identity bytes on affected node:sqlite builds. */ sql<Uint8Array>`CAST(current_session_id AS BLOB)`.as(
          "current_session_id_bytes",
        ),
        /* kysely-allow-raw: preserve exact session JSON bytes on affected node:sqlite builds. */ sql<Uint8Array>`CAST(entry_json AS BLOB)`.as(
          "entry_json_bytes",
        ),
      ])
      .where("session_key", "=", sessionKey),
  );
  if (!row?.entry_json_bytes) {
    return undefined;
  }
  try {
    const entryJson = decodeSqliteTextBytes(database.db, row.entry_json_bytes);
    const currentSessionId = decodeSqliteTextBytes(database.db, row.current_session_id_bytes);
    const sessionId = readStringField(asOptionalRecord(JSON.parse(entryJson)), "sessionId");
    return sessionId === currentSessionId ? sessionId : undefined;
  } catch {
    return undefined;
  }
}
