// Orphan-sidecar tests prove fresh database opens preserve recoverable SQLite families.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
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
const databaseKinds = ["state", "agent"] as const;
const walWithFrameBytes = Buffer.alloc(33, 0x57);
const rollbackJournalContents = Buffer.from("recoverable rollback journal content");
const shmIndexContents = Buffer.alloc(32 * 1024, 0x53);
const emptySidecar = Buffer.alloc(0);

function createWalHeaderOnly(): Buffer {
  const fixtureDir = fs.realpathSync(tempStateDirs.make("openclaw-wal-header-"));
  const databasePath = path.join(fixtureDir, "header.sqlite");
  const { DatabaseSync } = requireNodeSqlite();
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
    database.exec("CREATE TABLE header_probe (value TEXT);");
    const wal = fs.readFileSync(`${databasePath}-wal`);
    if (wal.length <= 32) {
      throw new Error("SQLite did not write a WAL frame for the header fixture");
    }
    return Buffer.from(wal.subarray(0, 32));
  } finally {
    database.close();
  }
}

const walHeaderOnly = createWalHeaderOnly();

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

function prepareCase(kind: (typeof databaseKinds)[number]) {
  const stateDir = fs.realpathSync(tempStateDirs.make("openclaw-orphan-sidecar-"));
  const env = { OPENCLAW_STATE_DIR: stateDir };
  const databasePath =
    kind === "state"
      ? resolveOpenClawStateSqlitePath(env)
      : resolveOpenClawAgentSqlitePath({ agentId: "main", env });
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  return { databasePath, env };
}

function openDatabase(kind: (typeof databaseKinds)[number], env: NodeJS.ProcessEnv) {
  return kind === "state"
    ? openOpenClawStateDatabase({ env })
    : openOpenClawAgentDatabase({ agentId: "main", env });
}

describe("orphan SQLite sidecar admission", () => {
  const blockingCases = [
    {
      label: "WAL with bytes beyond its header",
      suffix: "-wal",
      contents: walWithFrameBytes,
      benignSidecars: [
        { suffix: "-shm", contents: shmIndexContents },
        { suffix: "-journal", contents: emptySidecar },
      ],
    },
    {
      label: "non-empty rollback journal",
      suffix: "-journal",
      contents: rollbackJournalContents,
      benignSidecars: [
        { suffix: "-wal", contents: walHeaderOnly },
        { suffix: "-shm", contents: shmIndexContents },
      ],
    },
  ] as const;

  describe("blocking sidecars", () => {
    for (const testCase of blockingCases) {
      for (const kind of databaseKinds) {
        it(`refuses a missing ${kind} database with a ${testCase.label}`, () => {
          const { databasePath, env } = prepareCase(kind);
          const sidecars = [
            { suffix: testCase.suffix, contents: testCase.contents },
            ...testCase.benignSidecars,
          ].map((sidecar) => ({
            ...sidecar,
            path: `${databasePath}${sidecar.suffix}`,
          }));
          for (const sidecar of sidecars) {
            fs.writeFileSync(sidecar.path, sidecar.contents);
          }

          let thrown: unknown;
          try {
            openDatabase(kind, env);
          } catch (error) {
            thrown = error;
          }

          expect(thrown).toBeInstanceOf(Error);
          expect((thrown as Error).name).toBe("SqliteOrphanedSidecarsError");
          expect((thrown as Error).message).toContain(databasePath);
          expect((thrown as Error).message).toContain(`${databasePath}${testCase.suffix}`);
          for (const benign of testCase.benignSidecars) {
            expect((thrown as Error).message).not.toContain(`${databasePath}${benign.suffix}`);
          }
          expect((thrown as Error).message).toContain("Refusing to create a replacement database");
          expect(fs.existsSync(databasePath)).toBe(false);
          for (const sidecar of sidecars) {
            expect(fs.readFileSync(sidecar.path)).toEqual(sidecar.contents);
          }
        });
      }
    }
  });

  const nonBlockingCases = [
    { label: "lone SHM index", suffix: "-shm", contents: shmIndexContents },
    { label: "zero-byte WAL", suffix: "-wal", contents: emptySidecar },
    { label: "32-byte header-only WAL", suffix: "-wal", contents: walHeaderOnly },
    { label: "zero-byte rollback journal", suffix: "-journal", contents: emptySidecar },
  ] as const;

  describe("non-blocking sidecars", () => {
    for (const testCase of nonBlockingCases) {
      for (const kind of databaseKinds) {
        it(`creates a missing ${kind} database with a ${testCase.label}`, () => {
          const { databasePath, env } = prepareCase(kind);
          fs.writeFileSync(`${databasePath}${testCase.suffix}`, testCase.contents);

          const database = openDatabase(kind, env);

          expect(database.db.isOpen).toBe(true);
          expect(fs.existsSync(databasePath)).toBe(true);
          expect(database.db.prepare("PRAGMA integrity_check").get()).toEqual({
            integrity_check: "ok",
          });
        });
      }
    }
  });
});
