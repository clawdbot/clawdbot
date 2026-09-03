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
    /no net page progress.*(stop the Gateway|otherwise quiesce writes).*back up only configuration.*only-config/iu,
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

  it("rejects a reported jump-up livelock", async () => {
    const sqlite = requireNodeSqlite();
    const paths = createDatabasePaths();
    vi.spyOn(sqlite, "backup").mockImplementation(async (_source, _destination, options) => {
      if (!options?.progress) {
        throw new Error("missing progress callback");
      }
      options.progress({ remainingPages: 100, totalPages: 120 });
      for (let cycle = 0; cycle < 100; cycle += 1) {
        for (let remainingPages = 101; remainingPages <= 120; remainingPages += 1) {
          options.progress({ remainingPages, totalPages: 120 });
        }
      }
      throw new Error("backup progress was not bounded");
    });

    const error = await backupSqliteOnline(paths).then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expectContentionGuidance(error, paths.sourcePath);
  });

  it("rejects a flat progress stream", async () => {
    const sqlite = requireNodeSqlite();
    const paths = createDatabasePaths();
    vi.spyOn(sqlite, "backup").mockImplementation(async (_source, _destination, options) => {
      if (!options?.progress) {
        throw new Error("missing progress callback");
      }
      for (let step = 0; step < 20_000; step += 1) {
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

  it("rejects when a real node:sqlite progress callback throws", async () => {
    const sqlite = requireNodeSqlite();
    const paths = createDatabasePaths();
    const source = new sqlite.DatabaseSync(paths.sourcePath);
    try {
      source.exec("PRAGMA page_size = 4096; VACUUM; CREATE TABLE payload (data BLOB NOT NULL);");
      const insert = source.prepare("INSERT INTO payload (data) VALUES (?)");
      for (let index = 0; index < 64; index += 1) {
        insert.run(Buffer.alloc(8192, index));
      }
    } finally {
      source.close();
    }

    const reopened = new sqlite.DatabaseSync(paths.sourcePath, { readOnly: true });
    const progressError = new Error("real progress callback throw");
    let progressCalls = 0;
    try {
      await expect(
        sqlite.backup(reopened, paths.destinationPath, {
          rate: 1,
          progress: () => {
            progressCalls += 1;
            throw progressError;
          },
        }),
      ).rejects.toBe(progressError);
    } finally {
      reopened.close();
    }

    expect(progressCalls).toBe(1);
  });

  it("allows strictly decreasing backups much longer than both contention bounds", async () => {
    const sqlite = requireNodeSqlite();
    const paths = createDatabasePaths();
    const backup = sqlite.backup.bind(sqlite);
    vi.spyOn(sqlite, "backup").mockImplementation(async (source, destination, options) => {
      if (!options?.progress) {
        throw new Error("missing progress callback");
      }
      const totalPages = 50_001;
      for (let remainingPages = totalPages; remainingPages > 0; remainingPages -= 1) {
        options.progress({ remainingPages, totalPages });
      }
      return await backup(source, destination);
    });

    await backupSqliteOnline(paths);
    expect(fs.existsSync(paths.destinationPath)).toBe(true);
  });

  it("allows many restarts when every pass reaches a new all-time minimum", async () => {
    const sqlite = requireNodeSqlite();
    const paths = createDatabasePaths();
    const backup = sqlite.backup.bind(sqlite);
    vi.spyOn(sqlite, "backup").mockImplementation(async (source, destination, options) => {
      if (!options?.progress) {
        throw new Error("missing progress callback");
      }
      const totalPages = 2_000;
      options.progress({ remainingPages: totalPages - 1, totalPages });
      for (let newMinimum = totalPages - 2; newMinimum >= 0; newMinimum -= 1) {
        options.progress({ remainingPages: totalPages, totalPages });
        options.progress({ remainingPages: newMinimum, totalPages });
      }
      return await backup(source, destination);
    });

    await backupSqliteOnline(paths);
    expect(fs.existsSync(paths.destinationPath)).toBe(true);
  });

  it("allows one restart followed by recovery much longer than both contention bounds", async () => {
    const sqlite = requireNodeSqlite();
    const paths = createDatabasePaths();
    const backup = sqlite.backup.bind(sqlite);
    vi.spyOn(sqlite, "backup").mockImplementation(async (source, destination, options) => {
      if (!options?.progress) {
        throw new Error("missing progress callback");
      }
      const totalPages = 50_002;
      options.progress({ remainingPages: 1, totalPages });
      options.progress({ remainingPages: totalPages, totalPages });
      for (let remainingPages = totalPages - 1; remainingPages >= 0; remainingPages -= 1) {
        options.progress({ remainingPages, totalPages });
      }
      return await backup(source, destination);
    });

    await backupSqliteOnline(paths);
    expect(fs.existsSync(paths.destinationPath)).toBe(true);
  });

  it("rejects partial-progress cycles that never beat the best remaining page count", async () => {
    const sqlite = requireNodeSqlite();
    const paths = createDatabasePaths();
    const backup = sqlite.backup.bind(sqlite);
    vi.spyOn(sqlite, "backup").mockImplementation(async (source, destination, options) => {
      if (!options?.progress) {
        throw new Error("missing progress callback");
      }
      options.progress({ remainingPages: 100, totalPages: 110 });
      for (let cycle = 0; cycle < 20_000; cycle += 1) {
        for (const remainingPages of [110, 109, 108]) {
          options.progress({ remainingPages, totalPages: 110 });
        }
      }
      return await backup(source, destination);
    });

    const error = await backupSqliteOnline(paths).then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expectContentionGuidance(error, paths.sourcePath);
  });
});
