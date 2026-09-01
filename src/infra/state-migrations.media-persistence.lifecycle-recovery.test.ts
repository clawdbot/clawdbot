import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { GATEWAY_AGENT_MEDIA_MIGRATION_REQUIRED_REASON } from "../state/openclaw-agent-db-migration-required.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  completeGatewayBootLifecycle,
  inspectGatewayCrashLoopBreaker,
  recordGatewayBootStart,
} from "./gateway-boot-lifecycle.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { migrateLegacyMediaPersistence } from "./state-migrations.media-persistence.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

describe("media persistence gateway lifecycle recovery", () => {
  it("repairs repeated typed startup failures after a successful v14 migration", async () => {
    const stateDir = tempDirs.make("media-persistence-startup-recovery-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const databasePath = openOpenClawAgentDatabase({ agentId: "main", env }).path;
    closeOpenClawAgentDatabasesForTest();

    const { DatabaseSync } = requireNodeSqlite();
    const database = new DatabaseSync(databasePath);
    database.exec(`
      DROP TABLE session_participants;
      PRAGMA user_version = 14;
      UPDATE schema_meta SET schema_version = 14 WHERE meta_key = 'primary';
    `);
    database.close();

    const nowMs = 1_000_000;
    for (let index = 0; index < 3; index += 1) {
      const bootId = recordGatewayBootStart(env, nowMs + index);
      completeGatewayBootLifecycle(
        bootId,
        {
          outcome: "startup_failed",
          reason: `migration required ${index}`,
          startupReason: GATEWAY_AGENT_MEDIA_MIGRATION_REQUIRED_REASON,
        },
        env,
        nowMs + index + 1,
      );
    }
    expect(inspectGatewayCrashLoopBreaker(env, nowMs + 4).tripped).toBe(true);

    const result = await migrateLegacyMediaPersistence({ env });

    expect(result.warnings).toEqual([]);
    expect(result.changes.join("\n")).toContain(
      "Repaired 3 gateway startup failure records after media migration.",
    );
    expect(inspectGatewayCrashLoopBreaker(env, nowMs + 5)).toMatchObject({
      tripped: false,
      uncleanBoots: 0,
    });
  });
});
