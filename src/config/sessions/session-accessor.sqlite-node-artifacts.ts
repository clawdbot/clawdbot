import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { ensureOpenClawAgentProgressCardSchemaInTransaction } from "../../state/openclaw-agent-progress-card-schema.js";
import { ensureSessionParticipantsSchema } from "../../state/openclaw-agent-session-participants-schema.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import { mergeSessionParticipantSource } from "./session-entry-provenance.js";
import { normalizeStoreSessionKey } from "./store-entry.js";

export function clearSessionCollaborationForKey(
  database: OpenClawAgentDatabase,
  sessionKey: string,
  options: { clearSuggestions?: boolean } = {},
): void {
  const presentTables = readSessionNodeArtifactTables(database);
  const db = getSessionKysely(database.db);
  if (presentTables.has("session_members")) {
    executeSqliteQuerySync(
      database.db,
      db.deleteFrom("session_members").where("session_key", "=", sessionKey),
    );
  }
  if (options.clearSuggestions !== false && presentTables.has("session_suggestions")) {
    executeSqliteQuerySync(
      database.db,
      db.deleteFrom("session_suggestions").where("session_key", "=", sessionKey),
    );
  }
}

/** Copy logical-session artifacts into their canonical node within one agent store or across two. */
export function copySessionNodeArtifactsForRepair(
  source: OpenClawAgentDatabase,
  destination: OpenClawAgentDatabase,
  sourceKeys: readonly string[],
  canonicalKey: string,
  options: { includeMembers?: boolean } = {},
): void {
  const keys = [...new Set(sourceKeys)];
  if (keys.length === 0) {
    return;
  }
  const sourceDb = getSessionKysely(source.db);
  const destinationDb = getSessionKysely(destination.db);
  const sourceKeyReferences = new Set(keys.flatMap((key) => [key, key.trim()]));
  const sourceTables = readSessionNodeArtifactTables(source);
  let destinationTables = readSessionNodeArtifactTables(destination);
  if (sourceTables.has("session_participants") && !destinationTables.has("session_participants")) {
    ensureSessionParticipantsSchema(destination.db);
    destinationTables = readSessionNodeArtifactTables(destination);
  }
  if (destinationTables.has("session_participants")) {
    ensureSessionParticipantsSchema(destination.db);
  }
  if (sourceTables.has("session_progress_cards")) {
    const progressCards = executeSqliteQuerySync(
      source.db,
      sourceDb.selectFrom("session_progress_cards").selectAll().where("session_key", "in", keys),
    ).rows;
    // Keep destination storage dormant unless an owned row actually needs transfer.
    if (progressCards.length > 0 && !destinationTables.has("session_progress_cards")) {
      ensureOpenClawAgentProgressCardSchemaInTransaction(destination.db);
      destinationTables = readSessionNodeArtifactTables(destination);
    }
    for (const progressCard of progressCards) {
      const canonicalProgressCard = { ...progressCard, session_key: canonicalKey };
      executeSqliteQuerySync(
        destination.db,
        destinationDb
          .insertInto("session_progress_cards")
          .values(canonicalProgressCard)
          .onConflict((conflict) =>
            conflict
              .column("session_key")
              .doUpdateSet(canonicalProgressCard)
              .where((eb) =>
                eb.or([
                  eb("revision", "<", progressCard.revision),
                  eb.and([
                    eb("revision", "=", progressCard.revision),
                    eb("updated_at", "<", progressCard.updated_at),
                  ]),
                ]),
              ),
          ),
      );
    }
  }
  if (
    sourceTables.has("board_tabs") &&
    sourceTables.has("board_widgets") &&
    destinationTables.has("board_tabs") &&
    destinationTables.has("board_widgets")
  ) {
    for (const tab of executeSqliteQuerySync(
      source.db,
      sourceDb.selectFrom("board_tabs").selectAll().where("session_key", "in", keys),
    ).rows) {
      executeSqliteQuerySync(
        destination.db,
        destinationDb
          .insertInto("board_tabs")
          .values({ ...tab, session_key: canonicalKey })
          .onConflict((conflict) =>
            conflict
              .columns(["session_key", "tab_id"])
              .doUpdateSet({
                title: tab.title,
                position: tab.position,
                chat_dock: tab.chat_dock,
                created_by: tab.created_by,
                revision: tab.revision,
              })
              .where("revision", "<", tab.revision),
          ),
      );
    }
    for (const widget of executeSqliteQuerySync(
      source.db,
      sourceDb.selectFrom("board_widgets").selectAll().where("session_key", "in", keys),
    ).rows) {
      executeSqliteQuerySync(
        destination.db,
        destinationDb
          .insertInto("board_widgets")
          .values({ ...widget, session_key: canonicalKey })
          .onConflict((conflict) =>
            conflict
              .columns(["session_key", "name"])
              .doUpdateSet({ ...widget, session_key: canonicalKey })
              .where((eb) =>
                eb.or([
                  eb("revision", "<", widget.revision),
                  eb.and([
                    eb("revision", "=", widget.revision),
                    eb("updated_at", "<", widget.updated_at),
                  ]),
                ]),
              ),
          ),
      );
    }
  }
  if (
    options.includeMembers !== false &&
    sourceTables.has("session_members") &&
    destinationTables.has("session_members")
  ) {
    for (const member of executeSqliteQuerySync(
      source.db,
      sourceDb.selectFrom("session_members").selectAll().where("session_key", "in", keys),
    ).rows) {
      executeSqliteQuerySync(
        destination.db,
        destinationDb
          .insertInto("session_members")
          .values({ ...member, session_key: canonicalKey })
          .onConflict((conflict) => conflict.columns(["session_key", "identity_id"]).doNothing()),
      );
    }
  }
  if (sourceTables.has("session_suggestions") && destinationTables.has("session_suggestions")) {
    if (source.db === destination.db) {
      executeSqliteQuerySync(
        destination.db,
        destinationDb
          .updateTable("session_suggestions")
          .set({ session_key: canonicalKey })
          .where("session_key", "in", keys),
      );
    } else {
      for (const suggestion of executeSqliteQuerySync(
        source.db,
        sourceDb.selectFrom("session_suggestions").selectAll().where("session_key", "in", keys),
      ).rows) {
        executeSqliteQuerySync(
          destination.db,
          destinationDb
            .insertInto("session_suggestions")
            .values({ ...suggestion, session_key: canonicalKey })
            .onConflict((conflict) => conflict.column("id").doNothing()),
        );
      }
    }
  }
  if (sourceTables.has("heartbeat_outcomes") && destinationTables.has("heartbeat_outcomes")) {
    for (const heartbeat of executeSqliteQuerySync(
      source.db,
      sourceDb.selectFrom("heartbeat_outcomes").selectAll().where("session_key", "in", keys),
    ).rows) {
      executeSqliteQuerySync(
        destination.db,
        destinationDb
          .insertInto("heartbeat_outcomes")
          .values({
            ...heartbeat,
            session_key: canonicalKey,
            run_session_key: sourceKeyReferences.has(heartbeat.run_session_key)
              ? canonicalKey
              : heartbeat.run_session_key,
          })
          .onConflict((conflict) =>
            conflict
              .column("session_key")
              .doUpdateSet({
                ...heartbeat,
                session_key: canonicalKey,
                run_session_key: sourceKeyReferences.has(heartbeat.run_session_key)
                  ? canonicalKey
                  : heartbeat.run_session_key,
              })
              .where((eb) =>
                eb.or([
                  eb("updated_at", "<", heartbeat.updated_at),
                  eb.and([
                    eb("updated_at", "=", heartbeat.updated_at),
                    eb("occurred_at", "<", heartbeat.occurred_at),
                  ]),
                ]),
              ),
          ),
      );
    }
  }
  if (sourceTables.has("session_participants") && destinationTables.has("session_participants")) {
    for (const participant of executeSqliteQuerySync(
      source.db,
      sourceDb.selectFrom("session_participants").selectAll().where("session_key", "in", keys),
    ).rows) {
      const existing = executeSqliteQueryTakeFirstSync(
        destination.db,
        destinationDb
          .selectFrom("session_participants")
          .select(["actor_source", "first_prompted_at", "last_prompted_at"])
          .where("session_key", "=", canonicalKey)
          .where("actor_type", "=", participant.actor_type)
          .where("actor_id", "=", participant.actor_id),
      );
      executeSqliteQuerySync(
        destination.db,
        destinationDb
          .insertInto("session_participants")
          .values({ ...participant, session_key: canonicalKey })
          .onConflict((conflict) =>
            conflict.columns(["session_key", "actor_type", "actor_id"]).doUpdateSet({
              actor_source: mergeSessionParticipantSource(
                existing?.actor_source,
                participant.actor_source,
              ),
              first_prompted_at: Math.min(
                existing?.first_prompted_at ?? participant.first_prompted_at,
                participant.first_prompted_at,
              ),
              last_prompted_at: Math.max(
                existing?.last_prompted_at ?? participant.last_prompted_at,
                participant.last_prompted_at,
              ),
            }),
          ),
      );
    }
  }
}

/** Membership is authorization state; canonical repair replaces it from the selected winner. */
export function deleteSessionMembersForRepair(
  database: OpenClawAgentDatabase,
  sessionKey: string,
): void {
  if (!readSessionNodeArtifactTables(database).has("session_members")) {
    return;
  }
  const db = getSessionKysely(database.db);
  executeSqliteQuerySync(
    database.db,
    db.deleteFrom("session_members").where("session_key", "=", sessionKey),
  );
}

export function deleteSessionDeliveryArtifacts(
  database: OpenClawAgentDatabase,
  sessionKey: string,
  additionalKeys: readonly string[] = [],
): void {
  const db = getSessionKysely(database.db);
  const trimmedKey = sessionKey.trim();
  const lookupKeys = uniqueStrings([
    sessionKey,
    trimmedKey,
    normalizeStoreSessionKey(trimmedKey),
    ...additionalKeys,
  ]);
  const competingIdentities = new Set(
    executeSqliteQuerySync(
      database.db,
      db.selectFrom("session_nodes").select("session_key"),
    ).rows.flatMap((row) =>
      row.session_key === sessionKey ? [] : [normalizeStoreSessionKey(row.session_key.trim())],
    ),
  );
  const sessionKeys = lookupKeys.filter(
    (key) => key === sessionKey || !competingIdentities.has(normalizeStoreSessionKey(key.trim())),
  );
  executeSqliteQuerySync(
    database.db,
    db.deleteFrom("conversation_deliveries").where("source_session_key", "in", sessionKeys),
  );
}

export function deleteSessionNodeArtifacts(
  database: OpenClawAgentDatabase,
  sessionKey: string,
): void {
  const db = getSessionKysely(database.db);
  const presentTables = readSessionNodeArtifactTables(database);
  if (presentTables.has("board_tabs") && presentTables.has("board_widgets")) {
    executeSqliteQuerySync(
      database.db,
      db.deleteFrom("board_widgets").where("session_key", "=", sessionKey),
    );
    executeSqliteQuerySync(
      database.db,
      db.deleteFrom("board_tabs").where("session_key", "=", sessionKey),
    );
  }
  for (const table of [
    "heartbeat_outcomes",
    "session_participants",
    "session_progress_cards",
  ] as const) {
    if (!presentTables.has(table)) {
      continue;
    }
    executeSqliteQuerySync(database.db, db.deleteFrom(table).where("session_key", "=", sessionKey));
  }
  clearSessionCollaborationForKey(database, sessionKey);
}

function readSessionNodeArtifactTables(database: OpenClawAgentDatabase): Set<string> {
  const db = getSessionKysely(database.db);
  return new Set(
    executeSqliteQuerySync(
      database.db,
      db
        .selectFrom("sqlite_schema")
        .select("name")
        .where("type", "=", "table")
        .where("name", "in", [
          "board_tabs",
          "board_widgets",
          "heartbeat_outcomes",
          "session_members",
          "session_participants",
          "session_progress_cards",
          "session_suggestions",
        ]),
    ).rows.flatMap((row) => (row.name ? [row.name] : [])),
  );
}
