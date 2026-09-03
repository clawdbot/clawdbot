import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { backupSqliteOnline } from "./sqlite-online-backup.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });
});

function createDatabasePaths(): { destinationPath: string; sourcePath: string } {
  const tempDir = tempDirs.make("openclaw-sqlite-online-backup-");
  const sourcePath = path.join(tempDir, "source.sqlite");
  const destinationPath = path.join(tempDir, "destination.sqlite");
  const sqlite = requireNodeSqlite();
  const source = new sqlite.DatabaseSync(sourcePath);
  source.exec("CREATE TABLE probe (value TEXT NOT NULL); INSERT INTO probe VALUES ('ready');");
  source.close();
  return { destinationPath, sourcePath };
}

function readPragmaValue(database: DatabaseSync, pragma: string): unknown {
  return Object.values(database.prepare(`PRAGMA ${pragma};`).get() ?? {})[0];
}

function expectContentionGuidance(error: unknown, sourcePath: string): void {
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain(sourcePath);
  expect((error as Error).message).toMatch(
    /being written concurrently.*running Gateway.*openclaw backup sqlite create --global.*stop the Gateway/iu,
  );
}

describe("backupSqliteOnline", () => {
  it("owns the pinned read transaction through backup and closes it afterward", async () => {
    const sqlite = requireNodeSqlite();
    const paths = createDatabasePaths();
    let pinnedSource: DatabaseSync | undefined;

    await backupSqliteOnline({
      ...paths,
      beforeBackup: (source) => {
        pinnedSource = source;
        expect(source.isTransaction).toBe(true);
        expect(readPragmaValue(source, "busy_timeout")).toBe(30_000);
        expect(readPragmaValue(source, "trusted_schema")).toBe(0);
      },
    });

    expect(pinnedSource?.isOpen).toBe(false);
    const destination = new sqlite.DatabaseSync(paths.destinationPath, { readOnly: true });
    expect(destination.prepare("SELECT value FROM probe").get()).toEqual({ value: "ready" });
    destination.close();
  });

  it("rejects repeated backup steps without net page progress", async () => {
    const sqlite = requireNodeSqlite();
    const paths = createDatabasePaths();
    vi.spyOn(sqlite, "backup").mockImplementation(async (_source, _destination, options) => {
      if (!options?.progress) {
        throw new Error("missing progress callback");
      }
      for (let attempt = 0; attempt < 100_000; attempt += 1) {
        options.progress({ remainingPages: 50, totalPages: 50 });
      }
      throw new Error("backup progress was not bounded");
    });

    const error = await backupSqliteOnline(paths).then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expectContentionGuidance(error, paths.sourcePath);
  });

  it("allows long backups whose remaining page count strictly decreases", async () => {
    const sqlite = requireNodeSqlite();
    const paths = createDatabasePaths();
    const backup = sqlite.backup.bind(sqlite);
    vi.spyOn(sqlite, "backup").mockImplementation(async (source, destination, options) => {
      if (!options?.progress) {
        throw new Error("missing progress callback");
      }
      for (let remainingPages = 20_001; remainingPages > 0; remainingPages -= 1) {
        options.progress({ remainingPages, totalPages: 20_001 });
      }
      return await backup(source, destination);
    });

    await backupSqliteOnline(paths);
    expect(fs.existsSync(paths.destinationPath)).toBe(true);
  });

  it("allows backup restarts that eventually reach a new page minimum", async () => {
    const sqlite = requireNodeSqlite();
    const paths = createDatabasePaths();
    const backup = sqlite.backup.bind(sqlite);
    vi.spyOn(sqlite, "backup").mockImplementation(async (source, destination, options) => {
      if (!options?.progress) {
        throw new Error("missing progress callback");
      }
      for (const remainingPages of [12, 10, 14, 16, 9, 11, 8, 0]) {
        options.progress({ remainingPages, totalPages: 16 });
      }
      return await backup(source, destination);
    });

    await backupSqliteOnline(paths);
    expect(fs.existsSync(paths.destinationPath)).toBe(true);
  });
});
