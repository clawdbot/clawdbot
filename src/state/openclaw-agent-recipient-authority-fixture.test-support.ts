import type { DatabaseSync } from "node:sqlite";
import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import { withLegacySessionParticipantsSchema } from "./openclaw-agent-participants-migration.js";
import { sessionParticipantsSchemaSql } from "./openclaw-agent-session-participants-schema.js";

export type RecipientAuthorityV18FixtureLineage = "covenant" | "upstream";

type RecipientAuthorityV18FixtureParams = {
  database: DatabaseSync;
  importedEpoch: string;
  lineage: RecipientAuthorityV18FixtureLineage;
  malformedSessionKey: string;
  retainedEpoch: string;
  validSessionKey: string;
};

export type RecipientAuthorityV18FixtureReceipt = {
  expectedEpoch: string;
  originalMalformedEntryJson: string;
  originalValidEntryJson: string;
};

function readSessionEntryJson(database: DatabaseSync, sessionKey: string): string {
  const row = database
    .prepare("SELECT entry_json FROM session_nodes WHERE session_key = ?")
    .get(sessionKey) as { entry_json?: unknown } | undefined;
  if (typeof row?.entry_json !== "string") {
    throw new Error(`Missing session entry JSON for ${sessionKey}`);
  }
  return row.entry_json;
}

/**
 * Recreates the two accepted physical v18 lineages before the canonical v19
 * migration. Keep this test-only owner shared so proof drivers cannot invent a
 * third historical shape that production never supported.
 */
export function stageRecipientAuthorityV18Fixture(
  params: RecipientAuthorityV18FixtureParams,
): RecipientAuthorityV18FixtureReceipt {
  const { database, importedEpoch, lineage, malformedSessionKey, retainedEpoch, validSessionKey } =
    params;
  const originalValidEntryJson = readSessionEntryJson(database, validSessionKey);
  const originalMalformedEntryJson = readSessionEntryJson(database, malformedSessionKey);

  if (lineage === "covenant") {
    database.exec("DROP TABLE session_participants;");
    database.exec(withLegacySessionParticipantsSchema(sessionParticipantsSchemaSql()));
    database
      .prepare(
        `INSERT INTO session_participants (
           session_key, actor_type, actor_id, actor_source,
           contribution_count, first_prompted_at, last_prompted_at
         ) VALUES (?, 'human', 'profile-a', 'profile', 3, 30, 50)`,
      )
      .run(validSessionKey);
    database
      .prepare(
        `INSERT INTO session_recipient_authority (
           session_key, epoch, created_at, updated_at
         ) VALUES (?, ?, 1, 1)`,
      )
      .run(validSessionKey, retainedEpoch);
  } else {
    const validEntry = safeParseJsonRecord(originalValidEntryJson);
    const malformedEntry = safeParseJsonRecord(originalMalformedEntryJson);
    if (!validEntry || !malformedEntry) {
      throw new Error("Current session fixture contains malformed entry JSON");
    }
    database
      .prepare(
        `INSERT INTO session_participants (
           session_key, identity_namespace, actor_id, contribution_count,
           first_prompted_at, last_prompted_at
         ) VALUES (?, '{"type":"profile"}', 'profile-a', 3, NULL, NULL)`,
      )
      .run(validSessionKey);
    database.prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?").run(
      JSON.stringify({
        ...validEntry,
        recipientAuthorityEpoch: importedEpoch,
      }),
      validSessionKey,
    );
    database.prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?").run(
      JSON.stringify({
        ...malformedEntry,
        recipientAuthorityEpoch: "not-an-epoch",
      }),
      malformedSessionKey,
    );
    database
      .prepare("UPDATE session_nodes SET entry_valid = 1 WHERE session_key IN (?, ?)")
      .run(validSessionKey, malformedSessionKey);
    database.exec("DROP TABLE session_recipient_authority;");
  }

  database.exec(`
    PRAGMA user_version = 18;
    UPDATE schema_meta SET schema_version = 18 WHERE meta_key = 'primary';
  `);
  return {
    expectedEpoch: lineage === "covenant" ? retainedEpoch : importedEpoch,
    originalMalformedEntryJson,
    originalValidEntryJson,
  };
}
