import { spawnSync } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  __setFsSafeTestHooksForTest(undefined);
  durabilityTestState.syncOutcome = undefined;
  vi.restoreAllMocks();
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

let sqlite: ReturnType<typeof requireNodeSqlite>;
let sourcePath: string;
let targetPath: string;
let tempDir: string;

beforeEach(async () => {
  tempDir = await createTempDir();
  sourcePath = path.join(tempDir, "source.sqlite");
  targetPath = path.join(tempDir, "snapshot.sqlite");
  sqlite = requireNodeSqlite();
  const database = new sqlite.DatabaseSync(sourcePath);
  try {
    database.exec("VACUUM;");
  } finally {
    database.close();
  }
});

type SnapshotOptions = Parameters<typeof createVerifiedSqliteSnapshot>[0];

async function expectSnapshotSuccess(options: SnapshotOptions): Promise<void> {
  await expect(createVerifiedSqliteSnapshot(options)).resolves.toEqual({
    path: options.targetPath,
    userVersion: 0,
  });
}

async function expectSnapshotFailureWithoutTarget(
  options: SnapshotOptions,
  pattern: RegExp,
): Promise<void> {
  await expect(createVerifiedSqliteSnapshot(options)).rejects.toThrow(pattern);
  await expect(fs.access(options.targetPath)).rejects.toMatchObject({ code: "ENOENT" });
}

async function expectRejectedPublicationGuard(
  phase: "afterPublish" | "beforePublish",
  message: string,
): Promise<void> {
  let guarded = false;
  const reject = () => {
    guarded = true;
    throw new Error(message);
  };
  const options: SnapshotOptions =
    phase === "afterPublish"
      ? { sourcePath, targetPath, afterPublish: reject }
      : { sourcePath, targetPath, beforePublish: reject };
  await expect(createVerifiedSqliteSnapshot(options)).rejects.toThrow(message);
  expect(guarded).toBe(true);
  await expect(fs.access(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
}

function withReadOnlySnapshot<T>(
  sqliteModule: ReturnType<typeof requireNodeSqlite>,
  snapshotPath: string,
  operation: (snapshot: import("node:sqlite").DatabaseSync) => T,
): T {
  const snapshot = new sqliteModule.DatabaseSync(snapshotPath, { readOnly: true });
  try {
    return operation(snapshot);
  } finally {
    snapshot.close();
  }
}

describe("createVerifiedSqliteSnapshot", () => {
  it.runIf(process.platform === "win32")(
    "creates private staging directories exclusively under races",
    async () => {
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
      let targetDirectory = tempDir;
      while (targetDirectory.length < 205) {
        targetDirectory = path.join(targetDirectory, `segment-${"x".repeat(24)}`);
      }
      await fs.mkdir(targetDirectory, { recursive: true });
      const longTargetPath = path.join(targetDirectory, "snapshot.sqlite");
      const longestStagingPath = path.join(
        targetDirectory,
        `.sqlite-publish-${"0".repeat(36)}-${"0".repeat(36)}`,
        "database.sqlite",
      );
      expect(longTargetPath.length).toBeLessThan(260);
      expect(longestStagingPath.length).toBeGreaterThan(260);
      const source = new sqlite.DatabaseSync(sourcePath);
      source.exec("CREATE TABLE records (value TEXT NOT NULL); INSERT INTO records VALUES ('ok');");
      source.close();

      await expectSnapshotSuccess({ sourcePath, targetPath: longTargetPath });
      withReadOnlySnapshot(sqlite, longTargetPath, (snapshot) => {
        expect(snapshot.prepare("SELECT value FROM records").get()).toEqual({ value: "ok" });
      });
    },
  );

  it("captures committed WAL state and removes deleted page contents", async () => {
    const deletedValue = `deleted-secret-${"x".repeat(256)}`;
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

      withReadOnlySnapshot(sqlite, targetPath, (snapshot) => {
        expect(snapshot.prepare("SELECT value FROM records").all()).toEqual([
          { value: "survivor" },
        ]);
        expect(snapshot.prepare("PRAGMA journal_mode;").get()).toEqual({
          journal_mode: "delete",
        });
      });
      await expect(fs.access(`${targetPath}-wal`)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.access(`${targetPath}-shm`)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      source.close();
    }
  });

  it.skipIf(process.platform === "win32")(
    "snapshots committed state from a hot rollback journal without recovering the source",
    async () => {
      createHotRollbackJournal(sourcePath);
      const sourceBefore = await fs.readFile(sourcePath);
      const journalBefore = await fs.readFile(`${sourcePath}-journal`);

      await expectSnapshotSuccess({ sourcePath, targetPath });

      await expect(fs.readFile(sourcePath)).resolves.toEqual(sourceBefore);
      await expect(fs.readFile(`${sourcePath}-journal`)).resolves.toEqual(journalBefore);
      withReadOnlySnapshot(sqlite, targetPath, (snapshot) => {
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
      });
      await expect(fs.access(`${targetPath}-journal`)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.skipIf(process.platform === "win32")(
    "rechecks for a hot rollback journal after the direct source open fails",
    async () => {
      createHotRollbackJournal(sourcePath);
      const canonicalJournalPath = `${fsSync.realpathSync.native(sourcePath)}-journal`;
      const lstatSync = fsSync.lstatSync.bind(fsSync);
      let hidJournal = false;
      vi.spyOn(fsSync, "lstatSync").mockImplementation(((pathname, options) => {
        if (!hidJournal && path.resolve(String(pathname)) === canonicalJournalPath) {
          hidJournal = true;
          const error = new Error("missing");
          (error as NodeJS.ErrnoException).code = "ENOENT";
          throw error;
        }
        return lstatSync(pathname, options as never);
      }) as typeof fsSync.lstatSync);

      await expectSnapshotSuccess({ sourcePath, targetPath });
      expect(hidJournal).toBe(true);
      withReadOnlySnapshot(sqlite, targetPath, (snapshot) => {
        expect(
          snapshot.prepare("SELECT COUNT(*) AS count FROM records WHERE value = 'committed'").get(),
        ).toEqual({ count: 256 });
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "refuses private recovery when a hot journal depends on a super-journal",
    async () => {
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
    const source = new sqlite.DatabaseSync(sourcePath);
    source.exec("CREATE TABLE records (value TEXT NOT NULL); INSERT INTO records VALUES ('ok');");
    source.close();
    const staleJournal = Buffer.alloc(4096, 0x5a);
    await fs.writeFile(`${sourcePath}-journal`, staleJournal);
    const sourceBefore = await fs.readFile(sourcePath);

    await expectSnapshotSuccess({ sourcePath, targetPath });

    await expect(fs.readFile(sourcePath)).resolves.toEqual(sourceBefore);
    await expect(fs.readFile(`${sourcePath}-journal`)).resolves.toEqual(staleJournal);
    withReadOnlySnapshot(sqlite, targetPath, (snapshot) => {
      expect(snapshot.prepare("SELECT value FROM records").get()).toEqual({ value: "ok" });
    });
  });

  it("uses online backup before compacting the private copy", async () => {
    const setup = new sqlite.DatabaseSync(sourcePath);
    setup.exec("CREATE TABLE records (value TEXT NOT NULL); INSERT INTO records VALUES ('ok');");
    setup.close();
    const backupSpy = vi.spyOn(sqlite, "backup");
    const prepareSpy = vi.spyOn(sqlite.DatabaseSync.prototype, "prepare");

    await createVerifiedSqliteSnapshot({ sourcePath, targetPath });
    expect(backupSpy).toHaveBeenCalledTimes(1);
    expect(prepareSpy.mock.calls.some(([sql]) => /\bVACUUM\s+INTO\b/iu.test(sql))).toBe(false);
    withReadOnlySnapshot(sqlite, targetPath, (snapshot) => {
      expect(snapshot.prepare("SELECT value FROM records").get()).toEqual({ value: "ok" });
    });
  });

  it("pins validation and backup to one WAL snapshot", async () => {
    const writer = new sqlite.DatabaseSync(sourcePath);
    writer.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA wal_autocheckpoint = 0;
      CREATE TABLE records (value TEXT NOT NULL);
      INSERT INTO records VALUES ('before');
      PRAGMA wal_checkpoint(TRUNCATE);
    `);
    const backup = sqlite.backup.bind(sqlite);
    vi.spyOn(sqlite, "backup").mockImplementationOnce(async (...args) => {
      writer.prepare("INSERT INTO records VALUES (?)").run("during");
      return await backup(...args);
    });

    try {
      await createVerifiedSqliteSnapshot({ sourcePath, targetPath });

      expect(writer.prepare("SELECT value FROM records ORDER BY rowid").all()).toEqual([
        { value: "before" },
        { value: "during" },
      ]);
      withReadOnlySnapshot(sqlite, targetPath, (snapshot) => {
        expect(snapshot.prepare("SELECT value FROM records ORDER BY rowid").all()).toEqual([
          { value: "before" },
        ]);
      });
    } finally {
      writer.close();
    }
  });

  it("rejects unsafe index drift and removes the failed target", async () => {
    createUnsafeIndexDrift(sourcePath);

    await expectSnapshotFailureWithoutTarget(
      { sourcePath, targetPath },
      /integrity_check failed|malformed database schema/iu,
    );
  });

  it("snapshots a zero-byte generic source as an empty SQLite database", async () => {
    await fs.writeFile(sourcePath, "");

    await expectSnapshotSuccess({ sourcePath, targetPath });
    expect((await fs.stat(targetPath)).size).toBeGreaterThan(0);
  });

  it("rejects a zero-byte source when nonempty input is required", async () => {
    await fs.writeFile(sourcePath, "");

    await expectSnapshotFailureWithoutTarget(
      {
        sourcePath,
        targetPath,
        requireNonEmptySource: true,
      },
      /snapshot source must not be empty/u,
    );
  });

  it("rejects an existing target without modifying it", async () => {
    await fs.writeFile(targetPath, "keep");

    await expect(createVerifiedSqliteSnapshot({ sourcePath, targetPath })).rejects.toThrow(
      /target already exists/u,
    );
    await expect(fs.readFile(targetPath, "utf8")).resolves.toBe("keep");
  });

  it("preserves a target created while the snapshot is being prepared", async () => {
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
    const originalOpen = fs.open.bind(fs);
    let stagedReadCount = 0;
    vi.spyOn(fs, "open").mockImplementation(async (filePath, flags, mode) => {
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

    await expectSnapshotFailureWithoutTarget(
      { sourcePath, targetPath },
      /size mismatch|hash mismatch/u,
    );
  });

  it("runs the final caller guard before publishing the target", async () => {
    await expectRejectedPublicationGuard("beforePublish", "publication refused");
  });

  it("removes its published target when the caller rejects it", async () => {
    await expectRejectedPublicationGuard("afterPublish", "published target refused");
  });

  it("rejects an asynchronous after-publication guard", async () => {
    const asynchronousGuard = (async () => {}) as unknown as () => void;

    await expectSnapshotFailureWithoutTarget(
      {
        sourcePath,
        targetPath,
        afterPublish: asynchronousGuard,
      },
      /after-publication guard must be synchronous/u,
    );
  });

  it("rejects an asynchronous final publication check", async () => {
    const asynchronousFinalCheck = (async () => {}) as unknown as () => void;

    await expectSnapshotFailureWithoutTarget(
      {
        sourcePath,
        targetPath,
        afterPublish: (guard) => {
          guard.assertTargetUnchanged(asynchronousFinalCheck);
        },
      },
      /publication final check must be synchronous/u,
    );
  });

  it("preserves a target replaced by the caller after publication", async () => {
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
    const originalLink = fs.link.bind(fs);
    vi.spyOn(fs, "link").mockImplementation(async (source, target) => {
      await originalLink(source, target);
      if (path.resolve(String(target)) === targetPath) {
        await fs.unlink(targetPath);
        await fs.writeFile(targetPath, "racer");
      }
    });

    await expect(createVerifiedSqliteSnapshot({ sourcePath, targetPath })).rejects.toThrow(
      /target changed during publication|staging path changed|snapshot file changed/u,
    );
    await expect(fs.readFile(targetPath, "utf8")).resolves.toBe("racer");
  });

  it.runIf(process.platform !== "win32")(
    "removes target bytes linked from a replaced staging pathname",
    async () => {
      const originalLink = fs.link.bind(fs);
      vi.spyOn(fs, "link").mockImplementation(async (source, target) => {
        if (path.resolve(String(target)) === targetPath) {
          await fs.unlink(source);
          const replacement = new sqlite.DatabaseSync(String(source));
          replacement.exec("CREATE TABLE replacement (value TEXT NOT NULL);");
          replacement.close();
        }
        await originalLink(source, target);
      });

      await expectSnapshotFailureWithoutTarget(
        { sourcePath, targetPath },
        /staging file changed during publication|size mismatch|hash mismatch/u,
      );
    },
  );

  it("removes its target when inspection fails after atomic publication", async () => {
    let failedInspection = false;
    __setFsSafeTestHooksForTest({
      afterPublishTargetCreated: (method, publishedPath) => {
        if (
          method === "hardlink" &&
          !failedInspection &&
          path.resolve(publishedPath) === targetPath
        ) {
          failedInspection = true;
          throw Object.assign(new Error("target inspection failed"), { code: "EIO" });
        }
      },
    });

    await expectSnapshotFailureWithoutTarget(
      { sourcePath, targetPath },
      /target inspection failed/u,
    );
  });

  it("uses a private sibling staging file for atomic publication", async () => {
    const originalOpen = fs.open.bind(fs);
    const openSpy = vi.spyOn(fs, "open").mockImplementation(originalOpen);

    await createVerifiedSqliteSnapshot({ sourcePath, targetPath });
    expect(
      openSpy.mock.calls.some(
        ([filePath, flags]) =>
          flags === "wx+" &&
          path.basename(path.dirname(String(filePath))).startsWith(".sqlite-publish-"),
      ),
    ).toBe(true);
  });

  it("falls back to an exclusive copy when hard links are unavailable", async () => {
    vi.spyOn(fs, "link").mockRejectedValue(
      Object.assign(new Error("hard links unsupported"), { code: "ENOTSUP" }),
    );

    await expectSnapshotSuccess({ sourcePath, targetPath });
    const restored = new sqlite.DatabaseSync(targetPath, { readOnly: true });
    restored.close();
  });

  it("removes a fallback target whose copied bytes fail verification", async () => {
    vi.spyOn(fs, "link").mockImplementation(async (source, target) => {
      if (path.resolve(String(target)) === targetPath) {
        await fs.appendFile(source, "changed-before-fallback");
      }
      throw Object.assign(new Error("hard links unsupported"), { code: "ENOTSUP" });
    });

    await expectSnapshotFailureWithoutTarget(
      { sourcePath, targetPath },
      /size mismatch|hash mismatch/u,
    );
  });

  it("removes its hard link when opening the published target fails", async () => {
    const originalLink = fs.link.bind(fs);
    const originalOpen = fs.open.bind(fs);
    let linked = false;
    vi.spyOn(fs, "link").mockImplementation(async (source, target) => {
      await originalLink(source, target);
      if (path.resolve(String(target)) === targetPath) {
        linked = true;
      }
    });
    vi.spyOn(fs, "open").mockImplementation(async (filePath, flags, mode) => {
      if (linked && path.resolve(String(filePath)) === targetPath && flags === "r") {
        throw Object.assign(new Error("target open failed"), { code: "EIO" });
      }
      return await originalOpen(filePath, flags, mode);
    });

    await expectSnapshotFailureWithoutTarget({ sourcePath, targetPath }, /target open failed/u);
  });

  it("cleans publication staging when initialization fails", async () => {
    const originalChmod = fs.chmod.bind(fs);
    vi.spyOn(fs, "chmod").mockImplementation(async (filePath, mode) => {
      if (path.basename(String(filePath)).startsWith(".sqlite-publish-")) {
        throw Object.assign(new Error("chmod refused"), { code: "EACCES" });
      }
      await originalChmod(filePath, mode);
    });

    await expect(createVerifiedSqliteSnapshot({ sourcePath, targetPath })).rejects.toThrow(
      /chmod refused/u,
    );
    expect((await fs.readdir(tempDir)).every((name) => !name.startsWith(".sqlite-publish-"))).toBe(
      true,
    );
  });

  it("removes its published target when final directory sync fails", async () => {
    const originalOpen = fs.open.bind(fs);
    let targetDirectoryOpenCount = 0;
    vi.spyOn(fs, "open").mockImplementation(async (filePath, flags, mode) => {
      if (isDirectoryOpen(flags) && path.resolve(String(filePath)) === tempDir) {
        targetDirectoryOpenCount += 1;
      }
      if (targetDirectoryOpenCount === 2 && path.resolve(String(filePath)) === tempDir) {
        throw Object.assign(new Error("directory sync failed"), { code: "EIO" });
      }
      return await originalOpen(filePath, flags, mode);
    });

    await expectSnapshotFailureWithoutTarget({ sourcePath, targetPath }, /directory sync failed/u);
  });

  it.runIf(process.platform !== "win32")(
    "removes its published target when directory sync is unsupported",
    async () => {
      durabilityTestState.syncOutcome = { status: "unsupported", code: "ENOTSUP" };

      await expectSnapshotFailureWithoutTarget(
        { sourcePath, targetPath },
        /SQLite publication directory does not support crash-durable directory synchronization \(ENOTSUP\)/u,
      );
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects a transient publication directory replacement during sync",
    async () => {
      const displacedPath = `${tempDir}.displaced`;
      const replacementPath = `${tempDir}.replacement`;
      const originalOpen = fs.open.bind(fs);
      let targetDirectoryOpenCount = 0;
      let replaced = false;
      vi.spyOn(fs, "open").mockImplementation(async (filePath, flags, mode) => {
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
        await fs.rm(replacementPath, { recursive: true, force: true });
        await fs.rename(displacedPath, tempDir).catch(() => undefined);
      }
    },
  );

  it("validates both the source and transformed snapshot", async () => {
    const removedValue = `removed-secret-${"x".repeat(256)}`;
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
    withReadOnlySnapshot(sqlite, targetPath, (snapshot) => {
      expect(snapshot.prepare("SELECT value FROM records").get()).toEqual({ value: "new" });
    });
  });
});
