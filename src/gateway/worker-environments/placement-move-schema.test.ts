import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { assertSqliteSchemaContains } from "../../infra/sqlite-schema-contract.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { getOpenClawStateRuntimeSchema } from "../../state/openclaw-state-schema-compatibility.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../../state/openclaw-state-schema.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

describe("worker placement move schema", () => {
  it("survives a same-version previous reader and candidate reopen", () => {
    const stateDir = tempDirs.make("openclaw-placement-move-schema-");
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const database = openOpenClawStateDatabase(options);
    const versionBefore = database.db.prepare("PRAGMA user_version").get();
    const metadataBefore = database.db
      .prepare("SELECT schema_version, updated_at FROM schema_meta WHERE meta_key = 'primary'")
      .get();
    const previousSchema = OPENCLAW_STATE_SCHEMA_SQL.replace("  target_machine_class TEXT,\n", "");
    const moveSchemaStart = previousSchema.indexOf(
      "CREATE TABLE IF NOT EXISTS worker_session_placement_moves (",
    );
    const moveSchemaEnd = previousSchema.indexOf(") STRICT;", moveSchemaStart);
    database.db.exec(`
      DROP TABLE worker_session_placement_moves;
      ${previousSchema.slice(moveSchemaStart, moveSchemaEnd + ") STRICT;".length)}
      INSERT INTO worker_environments (
        environment_id, provider_id, profile_id, profile_snapshot_json,
        provision_operation_id, lease_id, state, owner_epoch,
        attached_session_ids_json, created_at_ms, updated_at_ms, state_changed_at_ms
      ) VALUES (
        'environment-source', 'test', 'profile-source', '{}',
        'provision-source', 'lease-source', 'attached', 7,
        '["session-move"]', 1000, 1000, 1000
      );
      INSERT INTO worker_session_placements (
        session_id, agent_id, session_key, execution_mode, state, environment_id,
        transition_generation, active_owner_epoch, workspace_base_manifest_ref,
        remote_workspace_dir, worker_bundle_hash, created_at_ms, updated_at_ms,
        state_changed_at_ms
      ) VALUES (
        'session-move', 'main', 'agent:main:move', 'worker-turn', 'active',
        'environment-source', 4, 7, 'sha256:base', '/workspace/move',
        '${"a".repeat(64)}', 1000, 1000, 1000
      );
    `);
    const store = createWorkerSessionPlacementStore({ database, now: () => 2_000 });
    const begun = store.beginPlacementMove({
      sessionId: "session-move",
      source: { generation: 4, environmentId: "environment-source", ownerEpoch: 7 },
      target: { kind: "profile", profileId: "profile-destination", machineClass: "beast" },
    });
    expect(database.db.prepare("PRAGMA table_info(worker_session_placement_moves)").all()).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "target_machine_class" })]),
    );
    const databasePath = database.path;
    closeOpenClawStateDatabaseForTest();

    const previousReader = new DatabaseSync(databasePath);
    expect(() =>
      assertSqliteSchemaContains(
        previousReader,
        "previous state schema",
        getOpenClawStateRuntimeSchema({ includeVersionLazyAdditiveTables: false }),
      ),
    ).not.toThrow();
    expect(
      previousReader
        .prepare(
          "SELECT state, transition_generation FROM worker_session_placements WHERE session_id = ?",
        )
        .get("session-move"),
    ).toEqual({ state: "draining", transition_generation: 5 });
    previousReader.close();

    const reopened = openOpenClawStateDatabase(options);
    const reopenedStore = createWorkerSessionPlacementStore({ database: reopened });
    expect(reopenedStore.getPlacementMove("session-move")).toEqual(begun.intent);
    expect(reopened.db.prepare("PRAGMA user_version").get()).toEqual(versionBefore);
    expect(
      reopened.db
        .prepare("SELECT schema_version, updated_at FROM schema_meta WHERE meta_key = 'primary'")
        .get(),
    ).toEqual(metadataBefore);
  });
});
