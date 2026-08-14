// Orphan-sidecar tests prove fresh database opens preserve recoverable SQLite families.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "./openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "./openclaw-agent-db.paths.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";

const tempStateDirs = useAutoCleanupTempDirTracker(afterEach);
const sidecarContents = Buffer.from("recoverable SQLite sidecar pages");

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

describe("orphan SQLite sidecar admission", () => {
  const cases = [
    { kind: "state" as const, suffix: "-wal" },
    { kind: "state" as const, suffix: "-shm" },
    { kind: "state" as const, suffix: "-journal" },
    { kind: "agent" as const, suffix: "-wal" },
    { kind: "agent" as const, suffix: "-shm" },
    { kind: "agent" as const, suffix: "-journal" },
  ];

  for (const testCase of cases) {
    it(`refuses a missing ${testCase.kind} database with an orphan ${testCase.suffix}`, () => {
      const stateDir = fs.realpathSync(tempStateDirs.make("openclaw-orphan-sidecar-"));
      const env = { OPENCLAW_STATE_DIR: stateDir };
      const databasePath =
        testCase.kind === "state"
          ? resolveOpenClawStateSqlitePath(env)
          : resolveOpenClawAgentSqlitePath({ agentId: "main", env });
      const sidecarPath = `${databasePath}${testCase.suffix}`;
      fs.mkdirSync(path.dirname(databasePath), { recursive: true });
      fs.writeFileSync(sidecarPath, sidecarContents);

      let thrown: unknown;
      try {
        if (testCase.kind === "state") {
          openOpenClawStateDatabase({ env });
        } else {
          openOpenClawAgentDatabase({ agentId: "main", env });
        }
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).name).toBe("SqliteOrphanedSidecarsError");
      expect((thrown as Error).message).toContain(databasePath);
      expect((thrown as Error).message).toContain(sidecarPath);
      expect((thrown as Error).message).toContain("Refusing to create a replacement database");
      expect(fs.existsSync(databasePath)).toBe(false);
      expect(fs.readFileSync(sidecarPath)).toEqual(sidecarContents);
    });
  }
});
