// Process regression for schema-17 repair rollback through the shipped Doctor command.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  createBuiltRuntime,
  runBuiltRuntime,
  seedV17AdditiveRepairDatabase,
} from "./doctor-config-preflight.process.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterAll);

describe("doctor schema-17 repair atomicity", () => {
  it("rolls back rejected v17 repair through doctor --fix", () => {
    const root = fs.realpathSync(tempDirs.make("openclaw-doctor-v17-atomicity-"));
    const stateDir = path.join(root, "state");
    const configPath = path.join(stateDir, "openclaw.json");
    fs.mkdirSync(path.join(stateDir, "agents", "main", "sessions"), { recursive: true });
    fs.writeFileSync(configPath, "{}\n");
    const databasePath = seedV17AdditiveRepairDatabase(stateDir, {
      participantDependency: true,
    });
    const runtimeRoot = createBuiltRuntime(root);
    const result = runBuiltRuntime(
      runtimeRoot,
      {
        ...process.env,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_TEST_FAST: "1",
        NO_COLOR: "1",
      },
      ["doctor", "--fix", "--non-interactive", "--yes", "--no-workspace-suggestions"],
      60_000,
    );
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.error, output).toBeUndefined();
    expect(output).toContain("Skipped agent database migration");
    expect(output).toContain("Participant migration cannot rebuild unknown indexes");

    const rejected = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(rejected.prepare("PRAGMA user_version").get()?.user_version).toBe(17);
      expect(
        rejected
          .prepare(
            "SELECT name FROM pragma_table_info('session_conversations') WHERE name = 'route_context_json'",
          )
          .get(),
      ).toBeUndefined();
      expect(
        rejected
          .prepare(
            "SELECT name FROM sqlite_schema WHERE type = 'trigger' AND name = 'session_conversations_route_context_invalidate_after_update'",
          )
          .get(),
      ).toBeUndefined();
      expect(
        rejected
          .prepare(
            "SELECT name FROM sqlite_schema WHERE type = 'index' AND name = 'idx_agent_transcript_event_identity_sequence'",
          )
          .get(),
      ).toBeUndefined();
      expect(
        rejected
          .prepare(
            "SELECT name FROM sqlite_schema WHERE type = 'index' AND name = 'idx_test_participant_dependency'",
          )
          .get(),
      ).toEqual({ name: "idx_test_participant_dependency" });
    } finally {
      rejected.close();
    }
  });
});
