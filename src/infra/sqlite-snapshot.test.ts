import { spawnSync } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requireNodeSqlite } from "./node-sqlite.js";
import { createPrivateSqliteDirectory } from "./sqlite-private-directory.js";

const durabilityTestState = vi.hoisted(() => ({
  syncOutcome: undefined as
    | { status: "synced" }
    | { status: "unsupported"; code?: string }
    | undefined,
}));

vi.mock("@openclaw/fs-safe/durability", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openclaw/fs-safe/durability")>();
  return {
    ...actual,
    syncDirectory: async (...args: Parameters<typeof actual.syncDirectory>) =>
      durabilityTestState.syncOutcome ?? (await actual.syncDirectory(...args)),
  };
});

import { createVerifiedSqliteSnapshot } from "./sqlite-snapshot.js";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sqlite-snapshot-"));
  tempDirs.push(tempDir);
  if (process.platform === "win32") {
    const privateTempDir = path.join(tempDir, "private");
    await createPrivateSqliteDirectory(privateTempDir);
    return privateTempDir;
  }
  return tempDir;
}

function isDirectoryOpen(flags: string | number | undefined): boolean {
  return (
    flags === "r" || (typeof flags === "number" && (flags & fsSync.constants.O_DIRECTORY) !== 0)
  );
}

afterEach(async () => {
  durabilityTestState.syncOutcome = undefined;
  await Promise.all(tempDirs.splice(0).map((tempDir) => fs.rm(tempDir, { recursive: true })));
});

function createUnsafeIndexDrift(sqlitePath: string): void {
  const sqlite = requireNodeSqlite();
  const database = new sqlite.DatabaseSync(sqlitePath);
  try {
    database.exec(`
      CREATE TABLE records (
        id INTEGER PRIMARY KEY,
        indexed_value TEXT NOT NULL,
        alternate_value TEXT NOT NULL
      );
      CREATE INDEX records_value ON records(indexed_value);
      INSERT INTO records (indexed_value, alternate_value)
      VALUES ('alpha', 'zeta'), ('beta', 'eta'), ('gamma', 'theta');
    `);
    database.enableDefensive?.(false);
    database.exec("PRAGMA writable_schema = ON;");
    database
      .prepare(
        "UPDATE sqlite_schema SET sql = 'CREATE INDEX records_value ON records(alternate_value)' WHERE name = 'records_value'",
      )
      .run();
    const schemaVersion = Number(
      Object.values(database.prepare("PRAGMA schema_version;").get() as Record<string, unknown>)[0],
    );
    database.exec(`PRAGMA writable_schema = OFF; PRAGMA schema_version = ${schemaVersion + 1};`);
  } finally {
    database.close();
  }
}

function createHotRollbackJournal(sqlitePath: string): void {
  const sqlite = requireNodeSqlite();
  const database = new sqlite.DatabaseSync(sqlitePath);
  try {
    database.exec(`
      PRAGMA journal_mode = DELETE;
      PRAGMA synchronous = FULL;
      CREATE TABLE records (
        id INTEGER PRIMARY KEY,
        value TEXT NOT NULL,
        payload BLOB NOT NULL
      );
      WITH RECURSIVE rows(id) AS (
        SELECT 1
        UNION ALL
        SELECT id + 1 FROM rows WHERE id < 256
      )
      INSERT INTO records (id, value, payload)
      SELECT id, 'committed', zeroblob(8192) FROM rows;
    `);
  } finally {
    database.close();
  }
  const crashed = spawnSync(
    process.execPath,
    [
      "--no-warnings",
      "--input-type=module",
      "-e",
      `
        import { DatabaseSync } from "node:sqlite";
        const database = new DatabaseSync(process.env.OPENCLAW_HOT_JOURNAL_PATH);
        database.exec(
          "PRAGMA journal_mode = DELETE; " +
          "PRAGMA synchronous = FULL; " +
          "PRAGMA cache_size = 2; " +
          "PRAGMA cache_spill = ON; " +
          "BEGIN IMMEDIATE; " +
          "UPDATE records SET value = 'uncommitted';"
        );
        process.kill(process.pid, "SIGKILL");
      `,
    ],
    {
      env: { ...process.env, OPENCLAW_HOT_JOURNAL_PATH: sqlitePath },
      encoding: "utf8",
    },
  );
  if (crashed.signal !== "SIGKILL") {
    throw new Error(
      `hot rollback writer did not exit with SIGKILL: code=${String(crashed.status)} stderr=${crashed.stderr}`,
    );
  }
  if (!fsSync.existsSync(`${sqlitePath}-journal`)) {
    throw new Error("hot rollback writer did not leave a journal");
  }
}

function appendSuperJournalPointer(journalPath: string, superJournalPath: string): void {
  const name = Buffer.from(superJournalPath, "utf8");
  const trailer = Buffer.alloc(4 + name.length + 4 + 4 + 8);
  name.copy(trailer, 4);
  trailer.writeUInt32BE(name.length, 4 + name.length);
  let checksum = 0;
  for (const byte of name) {
    checksum = (checksum + byte) >>> 0;
  }
  trailer.writeUInt32BE(checksum, 8 + name.length);
  Buffer.from([0xd9, 0xd5, 0x05, 0xf9, 0x20, 0xa1, 0x63, 0xd7]).copy(trailer, 12 + name.length);
  fsSync.appendFileSync(journalPath, trailer);
}

function createEmptySqliteDatabase(
  sqlite: ReturnType<typeof requireNodeSqlite>,
  sqlitePath: string,
): void {
  const database = new sqlite.DatabaseSync(sqlitePath);
  try {
    database.exec("VACUUM;");
  } finally {
    database.close();
  }
}

describe("createVerifiedSqliteSnapshot", () => {
  it.runIf(process.platform === "win32")(
    "creates private staging directories exclusively under races",
    async () => {
      const tempDir = await createTempDir();
      const directoryPath = path.join(tempDir, "private");
      const results = await Promise.allSettled([
        createPrivateSqliteDirectory(directoryPath),
        createPrivateSqliteDirectory(directoryPath),
      ]);

      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const rejected = results.find((result) => result.status === "rejected");
      expect(rejected).toBeDefined();
      expect((rejected as PromiseRejectedResult).reason).toMatchObject({ code: "EEXIST" });
      await expect(fs.lstat(directoryPath)).resolves.toMatchObject({});
    },
  );

  it.runIf(process.platform === "win32")(
    "snapshots when its private staging path exceeds MAX_PATH",
    async () => {
      const tempDir = await createTempDir();
      let targetDirectory = tempDir;
      while (targetDirectory.length < 205) {
        targetDirectory = path.join(targetDirectory, `segment-${"x".repeat(24)}`);
      }
      await fs.mkdir(targetDirectory, { recursive: true });
      const sourcePath = path.join(tempDir, "source.sqlite");
      const targetPath = path.join(targetDirectory, "snapshot.sqlite");
      const longestStagingPath = path.join(
        targetDirectory,
        `.sqlite-publish-${"0".repeat(36)}-${"0".repeat(36)}`,
        "database.sqlite",
      );
      expect(targetPath.length).toBeLessThan(260);
      expect(longestStagingPath.length).toBeGreaterThan(260);
      const sqlite = requireNodeSqlite();
      const source = new sqlite.DatabaseSync(sourcePath);
      source.exec("CREATE TABLE records (value TEXT NOT NULL); INSERT INTO records VALUES ('ok');");
      source.close();

      await expect(createVerifiedSqliteSnapshot({ sourcePath, targetPath })).resolves.toEqual({
        path: targetPath,
        userVersion: 0,
      });
      const snapshot = new sqlite.DatabaseSync(targetPath, { readOnly: true });
      try {
        expect(snapshot.prepare("SELECT value FROM records").get()).toEqual({ value: "ok" });
      } finally {
        snapshot.close();
      }
    },
  );

  it("captures committed WAL state and removes deleted page contents", async () => {
    const tempDir = await createTempDir();
    const sourcePath = path.join(tempDir, "source.sqlite");
    const targetPath = path.join(tempDir, "snapshot.sqlite");
    const deletedValue = `deleted-secret-${"x".repeat(256)}`;
    const sqlite = requireNodeSqlite();
    const source = new sqlite.DatabaseSync(sourcePath);
    try {
      source.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA wal_autocheckpoint = 0;
        PRAGMA secure_delete = OFF;
        CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
        PRAGMA wal_checkpoint(TRUNCATE);
      `);
      source.prepare("INSERT INTO records (value) VALUES (?)").run("survivor");
      source.prepare("INSERT INTO records (value) VALUES (?)").run(deletedValue);
      source.prepare("DELETE FROM records WHERE value = ?").run(deletedValue);

      const result = await createVerifiedSqliteSnapshot({ sourcePath, targetPath });
      expect(result).toEqual({ path: targetPath, userVersion: 0 });
      expect((await fs.readFile(targetPath)).includes(deletedValue)).toBe(false);

      const snapshot = new sqlite.DatabaseSync(targetPath, { readOnly: true });
      try {
        expect(snapshot.prepare("SELECT value FROM records").all()).toEqual([
          { value: "survivor" },
        ]);
        expect(snapshot.prepare("PRAGMA journal_mode;").get()).toEqual({
          journal_mode: "delete",
        });
      } finally {
        snapshot.close();
      }
      await expect(fs.access(`${targetPath}-wal`)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.access(`${targetPath}-shm`)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      source.close();
    }
  });

  it.skipIf(process.platform === "win32")(
    "snapshots committed state from a hot rollback journal without recovering the source",
    async () => {
      const tempDir = await createTempDir();
      const sourcePath = path.join(tempDir, "source.sqlite");
      const targetPath = path.join(tempDir, "snapshot.sqlite");
      createHotRollbackJournal(sourcePath);
      const sourceBefore = await fs.readFile(sourcePath);
      const journalBefore = await fs.readFile(`${sourcePath}-journal`);

      await expect(createVerifiedSqliteSnapshot({ sourcePath, targetPath })).resolves.toEqual({
        path: targetPath,
        userVersion: 0,
      });

      await expect(fs.readFile(sourcePath)).resolves.toEqual(sourceBefore);
      await expect(fs.readFile(`${sourcePath}-journal`)).resolves.toEqual(journalBefore);
      const sqlite = requireNodeSqlite();
      const snapshot = new sqlite.DatabaseSync(targetPath, { readOnly: true });
      try {
        expect(
          snapshot.prepare("SELECT COUNT(*) AS count FROM records WHERE value = 'committed'").get(),
        ).toEqual({ count: 256 });
        expect(
          snapshot
            .prepare("SELECT COUNT(*) AS count FROM records WHERE value = 'uncommitted'")
            .get(),
        ).toEqual({ count: 0 });
        expect(snapshot.prepare("PRAGMA integrity_check").get()).toEqual({
          integrity_check: "ok",
        });
      } finally {
        snapshot.close();
      }
      await expect(fs.access(`${targetPath}-journal`)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.skipIf(process.platform === "win32")(
    "rechecks for a hot rollback journal after the direct source open fails",
    async () => {
      const tempDir = await createTempDir();
      const sourcePath = path.join(tempDir, "source.sqlite");
      const targetPath = path.join(tempDir, "snapshot.sqlite");
      createHotRollbackJournal(sourcePath);
      const journalPath = `${sourcePath}-journal`;
      const lstatSync = fsSync.lstatSync.bind(fsSync);
      let hidJournal = false;
      vi.spyOn(fsSync, "lstatSync").mockImplementation(((pathname, options) => {
        if (!hidJournal && path.resolve(String(pathname)) === path.resolve(journalPath)) {
          hidJournal = true;
          const error = new Error("missing");
          (error as NodeJS.ErrnoException).code = "ENOENT";
          throw error;
        }
        return lstatSync(pathname, options as never);
      }) as typeof fsSync.lstatSync);

      await expect(createVerifiedSqliteSnapshot({ sourcePath, targetPath })).resolves.toEqual({
        path: targetPath,
        userVersion: 0,
      });
      expect(hidJournal).toBe(true);
      const sqlite = requireNodeSqlite();
      const snapshot = new sqlite.DatabaseSync(targetPath, { readOnly: true });
      expect(
        snapshot.prepare("SELECT COUNT(*) AS count FROM records WHERE value = 'committed'").get(),
      ).toEqual({ count: 256 });
      snapshot.close();
    },
  );

  it.skipIf(process.platform === "win32")(
    "refuses private recovery when a hot journal depends on a super-journal",
    async () => {
      const tempDir = await createTempDir();
      const sourcePath = path.join(tempDir, "source.sqlite");
      const targetPath = path.join(tempDir, "snapshot.sqlite");
      const superJournalPath = path.join(tempDir, "source-mj000000900");
      createHotRollbackJournal(sourcePath);
      await fs.writeFile(superJournalPath, "super-journal");
      appendSuperJournalPointer(`${sourcePath}-journal`, superJournalPath);
      const sourceBefore = await fs.readFile(sourcePath);
      const journalBefore = await fs.readFile(`${sourcePath}-journal`);
      const superJournalBefore = await fs.readFile(superJournalPath);

      await expect(createVerifiedSqliteSnapshot({ sourcePath, targetPath })).rejects.toThrow(
        /super-journal.*cannot be recovered privately/iu,
      );

      await expect(fs.readFile(sourcePath)).resolves.toEqual(sourceBefore);
      await expect(fs.readFile(`${sourcePath}-journal`)).resolves.toEqual(journalBefore);
      await expect(fs.readFile(superJournalPath)).resolves.toEqual(superJournalBefore);
      await expect(fs.access(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("ignores a stale rollback journal without changing the source family", async () => {
    const tempDir = await createTempDir();
    const sourcePath = path.join(tempDir, "source.sqlite");
    const targetPath = path.join(tempDir, "snapshot.sqlite");
    const sqlite = requireNodeSqlite();
    const source = new sqlite.DatabaseSync(sourcePath);
    source.exec("CREATE TABLE records (value TEXT NOT NULL); INSERT INTO records VALUES ('ok');");
    source.close();
    const staleJournal = Buffer.alloc(4096, 0x5a);
    await fs.writeFile(`${sourcePath}-journal`, staleJournal);
    const sourceBefore = await fs.readFile(sourcePath);

    await expect(createVerifiedSqliteSnapshot({ sourcePath, targetPath })).resolves.toEqual({
      path: targetPath,
      userVersion: 0,
    });

    await expect(fs.readFile(sourcePath)).resolves.toEqual(sourceBefore);
    await expect(fs.readFile(`${sourcePath}-journal`)).resolves.toEqual(staleJournal);
    const snapshot = new sqlite.DatabaseSync(targetPath, { readOnly: true });
    expect(snapshot.prepare("SELECT value FROM records").get()).toEqual({ value: "ok" });
    snapshot.close();
  });

  it("uses online backup before compacting the private copy", async () => {
    const tempDir = await createTempDir();
    const sourcePath = path.join(tempDir, "source.sqlite");
    const targetPath = path.join(tempDir, "snapshot.sqlite");
    const sqlite = requireNodeSqlite();
    const source = new sqlite.DatabaseSync(sourcePath);
    source.exec("CREATE TABLE records (value TEXT NOT NULL); INSERT INTO records VALUES ('ok');");
    source.close();
    const backupSpy = vi.spyOn(sqlite, "backup");
    const prepareSpy = vi.spyOn(sqlite.DatabaseSync.prototype, "prepare");

    try {
      await createVerifiedSqliteSnapshot({ sourcePath, targetPath });

      expect(backupSpy).toHaveBeenCalledTimes(1);
      expect(prepareSpy.mock.calls.some(([sql]) => /\bVACUUM\s+INTO\b/iu.test(sql))).toBe(false);
      const snapshot = new sqlite.DatabaseSync(targetPath, { readOnly: true });
      try {
        expect(snapshot.prepare("SELECT value FROM records").get()).toEqual({ value: "ok" });
      } finally {
        snapshot.close();
      }
    } finally {
      prepareSpy.mockRestore();
      backupSpy.mockRestore();
    }
  });

  it("pins validation and backup to one WAL snapshot", async () => {
    const tempDir = await createTempDir();
    const sourcePath = path.join(tempDir, "source.sqlite");
    const targetPath = path.join(tempDir, "snapshot.sqlite");
    const sqlite = requireNodeSqlite();
    const writer = new sqlite.DatabaseSync(sourcePath);
    writer.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA wal_autocheckpoint = 0;
      CREATE TABLE records (value TEXT NOT NULL);
      INSERT INTO records VALUES ('before');
      PRAGMA wal_checkpoint(TRUNCATE);
    `);
    const backup = sqlite.backup.bind(sqlite);
    const backupSpy = vi.spyOn(sqlite, "backup").mockImplementationOnce(async (...args) => {
      writer.prepare("INSERT INTO records VALUES (?)").run("during");
      return await backup(...args);
    });

    try {
      await createVerifiedSqliteSnapshot({ sourcePath, targetPath });

      expect(writer.prepare("SELECT value FROM records ORDER BY rowid").all()).toEqual([
        { value: "before" },
        { value: "during" },
      ]);
      const snapshot = new sqlite.DatabaseSync(targetPath, { readOnly: true });
      try {
        expect(snapshot.prepare("SELECT value FROM records ORDER BY rowid").all()).toEqual([
          { value: "before" },
        ]);
      } finally {
        snapshot.close();
      }
    } finally {
      backupSpy.mockRestore();
      writer.close();
    }
  });

  it("rejects unsafe index drift and removes the failed target", async () => {
    const tempDir = await createTempDir();
    const sourcePath = path.join(tempDir, "source.sqlite");
    const targetPath = path.join(tempDir, "snapshot.sqlite");
    createUnsafeIndexDrift(sourcePath);

    await expect(createVerifiedSqliteSnapshot({ sourcePath, targetPath })).rejects.toThrow(
      /integrity_check failed|malformed database schema/iu,
    );
    await expect(fs.access(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("snapshots a zero-byte generic source as an empty SQLite database", async () => {
    const tempDir = await createTempDir();
    const sourcePath = path.join(tempDir, "source.sqlite");
    const targetPath = path.join(tempDir, "snapshot.sqlite");
    await fs.writeFile(sourcePath, "");

    await expect(createVerifiedSqliteSnapshot({ sourcePath, targetPath })).resolves.toEqual({
      path: targetPath,
      userVersion: 0,
    });
    expect((await fs.stat(targetPath)).size).toBeGreaterThan(0);
  });

  it("rejects a zero-byte source when nonempty input is required", async () => {
    const tempDir = await createTempDir();
    const sourcePath = path.join(tempDir, "source.sqlite");
    const targetPath = path.join(tempDir, "snapshot.sqlite");
    await fs.writeFile(sourcePath, "");

    await expect(
      createVerifiedSqliteSnapshot({
        sourcePath,
        targetPath,
        requireNonEmptySource: true,
      }),
    ).rejects.toThrow(/snapshot source must not be empty/u);
    await expect(fs.access(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an existing target without modifying it", async () => {
    const tempDir = await createTempDir();
    const sourcePath = path.join(tempDir, "source.sqlite");
    const targetPath = path.join(tempDir, "snapshot.sqlite");
    const sqlite = requireNodeSqlite();
    createEmptySqliteDatabase(sqlite, sourcePath);
    await fs.writeFile(targetPath, "keep");

    await expect(createVerifiedSqliteSnapshot({ sourcePath, targetPath })).rejects.toThrow(
      /target already exists/u,
    );
    await expect(fs.readFile(targetPath, "utf8")).resolves.toBe("keep");
  });

  it("preserves a target created while the snapshot is being prepared", async () => {
    const tempDir = await createTempDir();
    const sourcePath = path.join(tempDir, "source.sqlite");
    const targetPath = path.join(tempDir, "snapshot.sqlite");
    const sqlite = requireNodeSqlite();
    createEmptySqliteDatabase(sqlite, sourcePath);

    await expect(
      createVerifiedSqliteSnapshot({
        sourcePath,
        targetPath,
        transform: async () => {
          await fs.writeFile(targetPath, "racer");
        },
      }),
    ).rejects.toThrow(/EEXIST|already exists/iu);
    await expect(fs.readFile(targetPath, "utf8")).resolves.toBe("racer");
  });

  it("rejects staged bytes changed after validation", async () => {
    const tempDir = await createTempDir();
    const sourcePath = path.join(tempDir, "source.sqlite");
    const targetPath = path.join(tempDir, "snapshot.sqlite");
    const sqlite = requireNodeSqlite();
    createEmptySqliteDatabase(sqlite, sourcePath);
    const originalOpen = fs.open.bind(fs);
    let stagedReadCount = 0;
    const openSpy = vi.spyOn(fs, "open").mockImplementation(async (filePath, flags, mode) => {
      const resolvedPath = path.resolve(String(filePath));
      if (
        flags === "r" &&
        path.basename(resolvedPath) === "database.sqlite" &&
        path.basename(path.dirname(resolvedPath)).startsWith(".sqlite-snapshot-")
      ) {
        stagedReadCount += 1;
        if (stagedReadCount === 2) {
          await fs.appendFile(resolvedPath, "changed-after-validation");
        }
      }
      return await originalOpen(filePath, flags, mode);
    });

    try {
      await expect(createVerifiedSqliteSnapshot({ sourcePath, targetPath })).rejects.toThrow(
        /size mismatch|hash mismatch/u,
      );
      await expect(fs.access(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      openSpy.mockRestore();
    }
  });

  it("runs the final caller guard before publishing the target", async () => {
    const tempDir = await createTempDir();
    const sourcePath = path.join(tempDir, "source.sqlite");
    const targetPath = path.join(tempDir, "snapshot.sqlite");
    const sqlite = requireNodeSqlite();
    createEmptySqliteDatabase(sqlite, sourcePath);
    let guarded = false;

    await expect(
      createVerifiedSqliteSnapshot({
        sourcePath,
        targetPath,
        beforePublish: () => {
          guarded = true;
          throw new Error("publication refused");
        },
      }),
    ).rejects.toThrow(/publication refused/u);
    expect(guarded).toBe(true);
    await expect(fs.access(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes its published target when the caller rejects it", async () => {
    const tempDir = await createTempDir();
    const sourcePath = path.join(tempDir, "source.sqlite");
    const targetPath = path.join(tempDir, "snapshot.sqlite");
    const sqlite = requireNodeSqlite();
    createEmptySqliteDatabase(sqlite, sourcePath);
    let guarded = false;

    await expect(
      createVerifiedSqliteSnapshot({
        sourcePath,
        targetPath,
        afterPublish: () => {
          guarded = true;
          throw new Error("published target refused");
        },
      }),
    ).rejects.toThrow(/published target refused/u);
    expect(guarded).toBe(true);
    await expect(fs.access(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an asynchronous after-publication guard", async () => {
    const tempDir = await createTempDir();
    const sourcePath = path.join(tempDir, "source.sqlite");
    const targetPath = path.join(tempDir, "snapshot.sqlite");
    const sqlite = requireNodeSqlite();
    createEmptySqliteDatabase(sqlite, sourcePath);
    const asynchronousGuard = (async () => {}) as unknown as () => void;

    await expect(
      createVerifiedSqliteSnapshot({
        sourcePath,
        targetPath,
        afterPublish: asynchronousGuard,
      }),
    ).rejects.toThrow(/after-publication guard must be synchronous/u);
    await expect(fs.access(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an asynchronous final publication check", async () => {
    const tempDir = await createTempDir();
    const sourcePath = path.join(tempDir, "source.sqlite");
    const targetPath = path.join(tempDir, "snapshot.sqlite");
    const sqlite = requireNodeSqlite();
    createEmptySqliteDatabase(sqlite, sourcePath);
    const asynchronousFinalCheck = (async () => {}) as unknown as () => void;

    await expect(
      createVerifiedSqliteSnapshot({
        sourcePath,
        targetPath,
        afterPublish: (guard) => {
          guard.assertTargetUnchanged(asynchronousFinalCheck);
        },
      }),
    ).rejects.toThrow(/publication final check must be synchronous/u);
    await expect(fs.access(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves a target replaced by the caller after publication", async () => {
    const tempDir = await createTempDir();
    const sourcePath = path.join(tempDir, "source.sqlite");
    const targetPath = path.join(tempDir, "snapshot.sqlite");
    const sqlite = requireNodeSqlite();
    createEmptySqliteDatabase(sqlite, sourcePath);

    await expect(
      createVerifiedSqliteSnapshot({
        sourcePath,
        targetPath,
        afterPublish: (guard) => {
          fsSync.unlinkSync(targetPath);
          fsSync.writeFileSync(targetPath, "racer");
          guard.assertTargetUnchanged();
        },
      }),
    ).rejects.toThrow(/snapshot file changed|hash mismatch|size mismatch/u);
    await expect(fs.readFile(targetPath, "utf8")).resolves.toBe("racer");
  });

  it("rejects a target replaced after atomic publication", async () => {
    const tempDir = await createTempDir();
    const sourcePath = path.join(tempDir, "source.sqlite");
    const targetPath = path.join(tempDir, "snapshot.sqlite");
    const sqlite = requireNodeSqlite();
    createEmptySqliteDatabase(sqlite, sourcePath);
    const originalLink = fs.link.bind(fs);
    const linkSpy = vi.spyOn(fs, "link").mockImplementation(async (source, target) => {
      await originalLink(source, target);
      if (path.resolve(String(target)) === targetPath) {
        await fs.unlink(targetPath);
        await fs.writeFile(targetPath, "racer");
      }
    });

    try {
      await expect(createVerifiedSqliteSnapshot({ sourcePath, targetPath })).rejects.toThrow(
        /target changed during publication|staging path changed|snapshot file changed/u,
      );
      await expect(fs.readFile(targetPath, "utf8")).resolves.toBe("racer");
    } finally {
      linkSpy.mockRestore();
    }
  });

  it.runIf(process.platform !== "win32")(
    "removes target bytes linked from a replaced staging pathname",
    async () => {
      const tempDir = await createTempDir();
      const sourcePath = path.join(tempDir, "source.sqlite");
      const targetPath = path.join(tempDir, "snapshot.sqlite");
      const sqlite = requireNodeSqlite();
      createEmptySqliteDatabase(sqlite, sourcePath);
      const originalLink = fs.link.bind(fs);
      const linkSpy = vi.spyOn(fs, "link").mockImplementation(async (source, target) => {
        if (path.resolve(String(target)) === targetPath) {
          await fs.unlink(source);
          const replacement = new sqlite.DatabaseSync(String(source));
          replacement.exec("CREATE TABLE replacement (value TEXT NOT NULL);");
          replacement.close();
        }
        await originalLink(source, target);
      });

      try {
        await expect(createVerifiedSqliteSnapshot({ sourcePath, targetPath })).rejects.toThrow(
          /staging file changed during publication|size mismatch|hash mismatch/u,
        );
        await expect(fs.access(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        linkSpy.mockRestore();
      }
    },
  );

  it("removes its target when inspection fails after atomic publication", async () => {
    const tempDir = await createTempDir();
    const sourcePath = path.join(tempDir, "source.sqlite");
    const targetPath = path.join(tempDir, "snapshot.sqlite");
    const sqlite = requireNodeSqlite();
    createEmptySqliteDatabase(sqlite, sourcePath);
    const originalLink = fs.link.bind(fs);
    const originalLstat = fs.lstat.bind(fs);
    let linked = false;
    let failedInspection = false;
    const linkSpy = vi.spyOn(fs, "link").mockImplementation(async (source, target) => {
      await originalLink(source, target);
      if (path.resolve(String(target)) === targetPath) {
        linked = true;
      }
    });
    const lstatSpy = vi.spyOn(fs, "lstat").mockImplementation(async (filePath) => {
      if (linked && !failedInspection && path.resolve(String(filePath)) === targetPath) {
        failedInspection = true;
        throw Object.assign(new Error("target inspection failed"), { code: "EIO" });
      }
      return await originalLstat(filePath);
    });

    try {
      await expect(createVerifiedSqliteSnapshot({ sourcePath, targetPath })).rejects.toThrow(
        /target inspection failed/u,
      );
      await expect(fs.access(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      lstatSpy.mockRestore();
      linkSpy.mockRestore();
    }
  });

  it("uses a private sibling staging file for atomic publication", async () => {
    const tempDir = await createTempDir();
    const sourcePath = path.join(tempDir, "source.sqlite");
    const targetPath = path.join(tempDir, "snapshot.sqlite");
    const sqlite = requireNodeSqlite();
    createEmptySqliteDatabase(sqlite, sourcePath);
    const originalOpen = fs.open.bind(fs);
    const openSpy = vi.spyOn(fs, "open").mockImplementation(originalOpen);

    try {
      await createVerifiedSqliteSnapshot({ sourcePath, targetPath });
      expect(
        openSpy.mock.calls.some(
          ([filePath, flags]) =>
            flags === "wx+" &&
            path.basename(path.dirname(String(filePath))).startsWith(".sqlite-publish-"),
        ),
      ).toBe(true);
    } finally {
      openSpy.mockRestore();
    }
  });

  it("falls back to an exclusive copy when hard links are unavailable", async () => {
    const tempDir = await createTempDir();
    const sourcePath = path.join(tempDir, "source.sqlite");
    const targetPath = path.join(tempDir, "snapshot.sqlite");
    const sqlite = requireNodeSqlite();
    createEmptySqliteDatabase(sqlite, sourcePath);
    const linkSpy = vi
      .spyOn(fs, "link")
      .mockRejectedValue(Object.assign(new Error("hard links unsupported"), { code: "ENOTSUP" }));

    try {
      await expect(createVerifiedSqliteSnapshot({ sourcePath, targetPath })).resolves.toEqual({
        path: targetPath,
        userVersion: 0,
      });
      const restored = new sqlite.DatabaseSync(targetPath, { readOnly: true });
      restored.close();
    } finally {
      linkSpy.mockRestore();
    }
  });

  it("removes a fallback target whose copied bytes fail verification", async () => {
    const tempDir = await createTempDir();
    const sourcePath = path.join(tempDir, "source.sqlite");
    const targetPath = path.join(tempDir, "snapshot.sqlite");
    const sqlite = requireNodeSqlite();
    createEmptySqliteDatabase(sqlite, sourcePath);
    const linkSpy = vi.spyOn(fs, "link").mockImplementation(async (source, target) => {
      if (path.resolve(String(target)) === targetPath) {
        await fs.appendFile(source, "changed-before-fallback");
      }
      throw Object.assign(new Error("hard links unsupported"), { code: "ENOTSUP" });
    });

    try {
      await expect(createVerifiedSqliteSnapshot({ sourcePath, targetPath })).rejects.toThrow(
        /size mismatch|hash mismatch/u,
      );
      await expect(fs.access(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      linkSpy.mockRestore();
    }
  });

  it("removes its hard link when opening the published target fails", async () => {
    const tempDir = await createTempDir();
    const sourcePath = path.join(tempDir, "source.sqlite");
    const targetPath = path.join(tempDir, "snapshot.sqlite");
    const sqlite = requireNodeSqlite();
    createEmptySqliteDatabase(sqlite, sourcePath);
    const originalLink = fs.link.bind(fs);
    const originalOpen = fs.open.bind(fs);
    let linked = false;
    const linkSpy = vi.spyOn(fs, "link").mockImplementation(async (source, target) => {
      await originalLink(source, target);
      if (path.resolve(String(target)) === targetPath) {
        linked = true;
      }
    });
    const openSpy = vi.spyOn(fs, "open").mockImplementation(async (filePath, flags, mode) => {
      if (linked && path.resolve(String(filePath)) === targetPath && flags === "r") {
        throw Object.assign(new Error("target open failed"), { code: "EIO" });
      }
      return await originalOpen(filePath, flags, mode);
    });

    try {
      await expect(createVerifiedSqliteSnapshot({ sourcePath, targetPath })).rejects.toThrow(
        /target open failed/u,
      );
      await expect(fs.access(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      openSpy.mockRestore();
      linkSpy.mockRestore();
    }
  });

  it("cleans publication staging when initialization fails", async () => {
    const tempDir = await createTempDir();
    const sourcePath = path.join(tempDir, "source.sqlite");
    const targetPath = path.join(tempDir, "snapshot.sqlite");
    const sqlite = requireNodeSqlite();
    createEmptySqliteDatabase(sqlite, sourcePath);
    const originalChmod = fs.chmod.bind(fs);
    const chmodSpy = vi.spyOn(fs, "chmod").mockImplementation(async (filePath, mode) => {
      if (path.basename(String(filePath)).startsWith(".sqlite-publish-")) {
        throw Object.assign(new Error("chmod refused"), { code: "EACCES" });
      }
      await originalChmod(filePath, mode);
    });

    try {
      await expect(createVerifiedSqliteSnapshot({ sourcePath, targetPath })).rejects.toThrow(
        /chmod refused/u,
      );
      expect(
        (await fs.readdir(tempDir)).every((name) => !name.startsWith(".sqlite-publish-")),
      ).toBe(true);
    } finally {
      chmodSpy.mockRestore();
    }
  });

  it("removes its published target when final directory sync fails", async () => {
    const tempDir = await createTempDir();
    const sourcePath = path.join(tempDir, "source.sqlite");
    const targetPath = path.join(tempDir, "snapshot.sqlite");
    const sqlite = requireNodeSqlite();
    createEmptySqliteDatabase(sqlite, sourcePath);
    const originalOpen = fs.open.bind(fs);
    let targetDirectoryOpenCount = 0;
    const openSpy = vi.spyOn(fs, "open").mockImplementation(async (filePath, flags, mode) => {
      if (isDirectoryOpen(flags) && path.resolve(String(filePath)) === tempDir) {
        targetDirectoryOpenCount += 1;
      }
      if (targetDirectoryOpenCount === 2 && path.resolve(String(filePath)) === tempDir) {
        throw Object.assign(new Error("directory sync failed"), { code: "EIO" });
      }
      return await originalOpen(filePath, flags, mode);
    });

    try {
      await expect(createVerifiedSqliteSnapshot({ sourcePath, targetPath })).rejects.toThrow(
        /directory sync failed/u,
      );
      await expect(fs.access(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      openSpy.mockRestore();
    }
  });

  it.runIf(process.platform !== "win32")(
    "removes its published target when directory sync is unsupported",
    async () => {
      const tempDir = await createTempDir();
      const sourcePath = path.join(tempDir, "source.sqlite");
      const targetPath = path.join(tempDir, "snapshot.sqlite");
      const sqlite = requireNodeSqlite();
      createEmptySqliteDatabase(sqlite, sourcePath);
      durabilityTestState.syncOutcome = { status: "unsupported", code: "ENOTSUP" };

      await expect(createVerifiedSqliteSnapshot({ sourcePath, targetPath })).rejects.toThrow(
        /SQLite publication directory does not support crash-durable directory synchronization \(ENOTSUP\)/u,
      );
      await expect(fs.access(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects a transient publication directory replacement during sync",
    async () => {
      const tempDir = await createTempDir();
      const sourcePath = path.join(tempDir, "source.sqlite");
      const targetPath = path.join(tempDir, "snapshot.sqlite");
      const displacedPath = `${tempDir}.displaced`;
      const replacementPath = `${tempDir}.replacement`;
      const sqlite = requireNodeSqlite();
      createEmptySqliteDatabase(sqlite, sourcePath);
      const originalOpen = fs.open.bind(fs);
      let targetDirectoryOpenCount = 0;
      let replaced = false;
      const openSpy = vi.spyOn(fs, "open").mockImplementation(async (filePath, flags, mode) => {
        const resolvedPath = path.resolve(String(filePath));
        if (isDirectoryOpen(flags) && resolvedPath === tempDir) {
          targetDirectoryOpenCount += 1;
          if (targetDirectoryOpenCount === 2) {
            replaced = true;
            await fs.rename(tempDir, displacedPath);
            await fs.mkdir(tempDir);
            const replacementHandle = await originalOpen(filePath, flags, mode);
            await fs.rename(tempDir, replacementPath);
            await fs.rename(displacedPath, tempDir);
            return replacementHandle;
          }
        }
        return await originalOpen(filePath, flags, mode);
      });

      try {
        await expect(createVerifiedSqliteSnapshot({ sourcePath, targetPath })).rejects.toThrow(
          /handle changed during directory sync/u,
        );
        expect(replaced).toBe(true);
        await expect(fs.access(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        openSpy.mockRestore();
        await fs.rm(replacementPath, { recursive: true, force: true });
        await fs.rename(displacedPath, tempDir).catch(() => undefined);
      }
    },
  );

  it("validates both the source and transformed snapshot", async () => {
    const tempDir = await createTempDir();
    const sourcePath = path.join(tempDir, "source.sqlite");
    const targetPath = path.join(tempDir, "snapshot.sqlite");
    const removedValue = `removed-secret-${"x".repeat(256)}`;
    const sqlite = requireNodeSqlite();
    const source = new sqlite.DatabaseSync(sourcePath);
    source.exec("PRAGMA secure_delete = OFF; CREATE TABLE records (value TEXT NOT NULL);");
    source.prepare("INSERT INTO records VALUES (?)").run(removedValue);
    source.close();
    const labels: string[] = [];

    await createVerifiedSqliteSnapshot({
      sourcePath,
      targetPath,
      transform: (database) => {
        database.exec("DELETE FROM records;");
        database.prepare("INSERT INTO records VALUES (?)").run("new");
      },
      validate: (_database, label) => labels.push(label),
    });

    expect(labels).toEqual([sourcePath, targetPath, targetPath]);
    expect((await fs.readFile(targetPath)).includes(removedValue)).toBe(false);
    const snapshot = new sqlite.DatabaseSync(targetPath, { readOnly: true });
    try {
      expect(snapshot.prepare("SELECT value FROM records").get()).toEqual({ value: "new" });
    } finally {
      snapshot.close();
    }
  });
});
