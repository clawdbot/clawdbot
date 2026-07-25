import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";

export function clearSessionCollaborationForKey(
  database: OpenClawAgentDatabase,
  sessionKey: string,
): void {
  const presentTables = readSessionNodeArtifactTables(database);
  const db = getSessionKysely(database.db);
  if (presentTables.has("session_members")) {
    executeSqliteQuerySync(
      database.db,
      db.deleteFrom("session_members").where("session_key", "=", sessionKey),
    );
  }
  if (presentTables.has("session_suggestions")) {
    executeSqliteQuerySync(
      database.db,
      db.deleteFrom("session_suggestions").where("session_key", "=", sessionKey),
    );
  }
}

export function rehomeLegacySessionNodeArtifacts(
  database: OpenClawAgentDatabase,
  legacyKey: string,
  canonicalKey: string,
  options: { rehomeMembers?: boolean },
): void {
  const db = getSessionKysely(database.db);
  const presentTables = readSessionNodeArtifactTables(database);
  if (presentTables.has("board_tabs") && presentTables.has("board_widgets")) {
    const tabs = executeSqliteQuerySync(
      database.db,
      db.selectFrom("board_tabs").selectAll().where("session_key", "=", legacyKey),
    ).rows;
    for (const tab of tabs) {
      executeSqliteQuerySync(
        database.db,
        db
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
    const widgets = executeSqliteQuerySync(
      database.db,
      db.selectFrom("board_widgets").selectAll().where("session_key", "=", legacyKey),
    ).rows;
    for (const widget of widgets) {
      executeSqliteQuerySync(
        database.db,
        db
          .insertInto("board_widgets")
          .values({ ...widget, session_key: canonicalKey })
          .onConflict((conflict) =>
            conflict
              .columns(["session_key", "name"])
              .doUpdateSet({
                tab_id: widget.tab_id,
                title: widget.title,
                content_kind: widget.content_kind,
                html: widget.html,
                descriptor_json: widget.descriptor_json,
                sha256: widget.sha256,
                view_generation: widget.view_generation,
                revision: widget.revision,
                size_w: widget.size_w,
                size_h: widget.size_h,
                position: widget.position,
                manifest: widget.manifest,
                grant_state: widget.grant_state,
                granted_sha: widget.granted_sha,
                created_by: widget.created_by,
                created_at: widget.created_at,
                updated_at: widget.updated_at,
              })
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
  if (presentTables.has("heartbeat_outcomes")) {
    const heartbeat = executeSqliteQueryTakeFirstSync(
      database.db,
      db.selectFrom("heartbeat_outcomes").selectAll().where("session_key", "=", legacyKey),
    );
    if (heartbeat) {
      executeSqliteQuerySync(
        database.db,
        db
          .insertInto("heartbeat_outcomes")
          .values({ ...heartbeat, session_key: canonicalKey })
          .onConflict((conflict) =>
            conflict
              .column("session_key")
              .doUpdateSet({
                run_session_key: heartbeat.run_session_key,
                outcome: heartbeat.outcome,
                summary: heartbeat.summary,
                response_reason: heartbeat.response_reason,
                priority: heartbeat.priority,
                next_check: heartbeat.next_check,
                task_names_json: heartbeat.task_names_json,
                wake_source: heartbeat.wake_source,
                wake_reason: heartbeat.wake_reason,
                occurred_at: heartbeat.occurred_at,
                context_run_id: heartbeat.context_run_id,
                context_claimed_at: heartbeat.context_claimed_at,
                updated_at: heartbeat.updated_at,
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
  if (options.rehomeMembers !== false && presentTables.has("session_members")) {
    const members = executeSqliteQuerySync(
      database.db,
      db.selectFrom("session_members").selectAll().where("session_key", "=", legacyKey),
    ).rows;
    for (const member of members) {
      executeSqliteQuerySync(
        database.db,
        db
          .insertInto("session_members")
          .values({ ...member, session_key: canonicalKey })
          .onConflict((conflict) => conflict.columns(["session_key", "identity_id"]).doNothing()),
      );
    }
  }
  if (presentTables.has("session_suggestions")) {
    executeSqliteQuerySync(
      database.db,
      db
        .updateTable("session_suggestions")
        .set({ session_key: canonicalKey })
        .where("session_key", "=", legacyKey),
    );
  }
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
  if (presentTables.has("heartbeat_outcomes")) {
    executeSqliteQuerySync(
      database.db,
      db.deleteFrom("heartbeat_outcomes").where("session_key", "=", sessionKey),
    );
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
          "session_suggestions",
        ]),
    ).rows.flatMap((row) => (row.name ? [row.name] : [])),
  );
}
