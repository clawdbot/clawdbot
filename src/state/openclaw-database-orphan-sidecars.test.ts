// Orphan-sidecar tests prove fresh database opens preserve recoverable SQLite families.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { quarantineOrphanedSqliteSidecars } from "../infra/sqlite-files.js";
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
const rollbackJournalContents = Buffer.from("recoverable rollback journal content");
const shmIndexContents = Buffer.alloc(32 * 1024, 0x53);
const emptySidecar = Buffer.alloc(0);
const loggerMocks = vi.hoisted(() => ({ warn: vi.fn() }));

vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) =>
      subsystem === "state/sqlite"
        ? { ...actual.createSubsystemLogger(subsystem), warn: loggerMocks.warn }
        : actual.createSubsystemLogger(subsystem),
  };
});

function createWalFixture(): { header: Buffer; withFrames: Buffer } {
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
    return {
      header: Buffer.from(wal.subarray(0, 32)),
      withFrames: Buffer.from(wal),
    };
  } finally {
    database.close();
  }
}

const walFixture = createWalFixture();

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  loggerMocks.warn.mockReset();
  vi.restoreAllMocks();
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

function listQuarantinePaths(sourcePath: string): string[] {
  const prefix = `${path.basename(sourcePath)}.orphaned-`;
  return fs
    .readdirSync(path.dirname(sourcePath))
    .filter((entry) => entry.startsWith(prefix))
    .map((entry) => path.join(path.dirname(sourcePath), entry));
}

describe("orphan SQLite sidecar admission", () => {
  const recoverableCases = [
    {
      label: "real WAL with committed frames",
      suffix: "-wal",
      contents: walFixture.withFrames,
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
        { suffix: "-wal", contents: walFixture.header },
        { suffix: "-shm", contents: shmIndexContents },
      ],
    },
  ] as const;

  describe("recoverable sidecars", () => {
    for (const testCase of recoverableCases) {
      for (const kind of databaseKinds) {
        const regression =
          kind === "state" && testCase.suffix === "-wal" ? " (plugin lifecycle regression)" : "";
        it(`opens a missing ${kind} database after copying a ${testCase.label}${regression}`, () => {
          const { databasePath, env } = prepareCase(kind);
          const sidecars = [
            { suffix: testCase.suffix, contents: testCase.contents },
            ...testCase.benignSidecars,
          ].map((sidecar) => ({
            contents: sidecar.contents,
            path: `${databasePath}${sidecar.suffix}`,
            suffix: sidecar.suffix,
          }));
          for (const sidecar of sidecars) {
            fs.writeFileSync(sidecar.path, sidecar.contents);
          }

          const database = openDatabase(kind, env);
          const sourcePath = `${databasePath}${testCase.suffix}`;
          const quarantinePaths = listQuarantinePaths(sourcePath);

          expect(database.db.isOpen).toBe(true);
          expect(fs.existsSync(databasePath)).toBe(true);
          expect(quarantinePaths).toHaveLength(1);
          const quarantinePath = quarantinePaths.at(0);
          if (!quarantinePath) {
            throw new Error(`missing quarantine for ${sourcePath}`);
          }
          expect(fs.readFileSync(quarantinePath)).toEqual(testCase.contents);
          if (fs.existsSync(sourcePath)) {
            // A successful WAL-mode open may create a new sidecar at the canonical path.
            expect(fs.readFileSync(sourcePath)).not.toEqual(testCase.contents);
          }
          expect(loggerMocks.warn).toHaveBeenCalledOnce();
          expect(loggerMocks.warn).toHaveBeenCalledWith(
            expect.stringContaining(quarantinePath),
            expect.objectContaining({
              databasePath,
              copiedSidecars: [{ quarantinePath, sourcePath }],
            }),
          );
          expect(String(loggerMocks.warn.mock.calls[0]?.[0])).toContain(
            "Committed frames could not be applied because the main database is missing",
          );
          expect(String(loggerMocks.warn.mock.calls[0]?.[0])).toContain(
            "Recovery requires restoring the main database and pairing it with the quarantined file",
          );
        });
      }
    }
  });

  const nonBlockingCases = [
    { label: "lone SHM index", suffix: "-shm", contents: shmIndexContents },
    { label: "zero-byte WAL", suffix: "-wal", contents: emptySidecar },
    { label: "32-byte header-only WAL", suffix: "-wal", contents: walFixture.header },
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
          expect(listQuarantinePaths(`${databasePath}${testCase.suffix}`)).toEqual([]);
          expect(loggerMocks.warn).not.toHaveBeenCalled();
        });
      }
    }
  });

  it("uses a unique suffix instead of overwriting an existing quarantine", () => {
    const { databasePath, env } = prepareCase("state");
    const sourcePath = `${databasePath}-wal`;
    const epochMs = 1_786_738_000_000;
    const existingQuarantinePath = `${sourcePath}.orphaned-${epochMs}`;
    const newQuarantinePath = `${existingQuarantinePath}-1`;
    const existingContents = Buffer.from("previously quarantined WAL");
    fs.writeFileSync(sourcePath, walFixture.withFrames);
    fs.writeFileSync(existingQuarantinePath, existingContents);
    vi.spyOn(Date, "now").mockReturnValue(epochMs);

    const database = openDatabase("state", env);

    expect(database.db.isOpen).toBe(true);
    expect(fs.readFileSync(existingQuarantinePath)).toEqual(existingContents);
    expect(fs.readFileSync(newQuarantinePath)).toEqual(walFixture.withFrames);
    expect(loggerMocks.warn).toHaveBeenCalledWith(
      expect.stringContaining(newQuarantinePath),
      expect.any(Object),
    );
  });

  it("leaves the live sidecar untouched and reuses an identical preserved copy", () => {
    const { databasePath } = prepareCase("state");
    const sourcePath = `${databasePath}-wal`;
    fs.writeFileSync(sourcePath, walFixture.withFrames);

    quarantineOrphanedSqliteSidecars(databasePath);
    const quarantinePaths = listQuarantinePaths(sourcePath);

    expect(quarantinePaths).toHaveLength(1);
    expect(fs.readFileSync(sourcePath)).toEqual(walFixture.withFrames);
    expect(fs.readFileSync(quarantinePaths[0] ?? "")).toEqual(walFixture.withFrames);
    loggerMocks.warn.mockClear();

    quarantineOrphanedSqliteSidecars(databasePath);

    expect(listQuarantinePaths(sourcePath)).toEqual(quarantinePaths);
    expect(fs.readFileSync(sourcePath)).toEqual(walFixture.withFrames);
    expect(loggerMocks.warn).not.toHaveBeenCalled();
  });

  it("fails closed with the typed error when quarantine copy fails", () => {
    const { databasePath, env } = prepareCase("state");
    const sourcePath = `${databasePath}-wal`;
    fs.writeFileSync(sourcePath, walFixture.withFrames);
    const copyError = Object.assign(new Error("read-only volume"), { code: "EROFS" });
    vi.spyOn(fs, "copyFileSync").mockImplementationOnce(() => {
      throw copyError;
    });

    let thrown: unknown;
    try {
      openDatabase("state", env);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).name).toBe("SqliteOrphanedSidecarsError");
    expect((thrown as Error).message).toContain(databasePath);
    expect((thrown as Error).message).toContain(sourcePath);
    expect((thrown as Error).message).toContain("restore the main database");
    expect(fs.existsSync(databasePath)).toBe(false);
    expect(fs.readFileSync(sourcePath)).toEqual(walFixture.withFrames);
    expect(listQuarantinePaths(sourcePath)).toEqual([]);
    expect(loggerMocks.warn).not.toHaveBeenCalled();
  });
});
