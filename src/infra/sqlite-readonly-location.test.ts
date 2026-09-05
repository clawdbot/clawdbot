import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { startSqliteConcurrentWriter } from "./sqlite-concurrent-writer.test-support.js";
import { readMainDatabasePosixLocks } from "./sqlite-posix-locks.test-support.js";
import {
  prepareSqliteReadOnlyLocation,
  prepareSqliteReadOnlyLocationInProcess,
  prepareSqliteReadOnlyLocationSync,
  prepareSqliteReadOnlyLocationSyncInProcess,
} from "./sqlite-readonly-location.js";

const writers: Array<ReturnType<typeof startSqliteConcurrentWriter>> = [];
const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    vi.restoreAllMocks();
    try {
      await Promise.all(writers.splice(0).map((writer) => writer.stop()));
    } finally {
      cleanup();
    }
  });
});

function createTempDatabasePath(): string {
  const tempDir = tempDirs.make("openclaw-sqlite-readonly-");
  return path.join(tempDir, "state.sqlite");
}

async function expectPublicSnapshot(
  prepare: (
    pathname: string,
  ) =>
    | { cleanup: () => boolean; location: string }
    | Promise<{ cleanup: () => boolean; location: string }>,
): Promise<void> {
  const sqlite = requireNodeSqlite();
  const databasePath = createTempDatabasePath();
  const writer = new sqlite.DatabaseSync(databasePath);
  let cleanup: (() => boolean) | undefined;
  try {
    writer.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA wal_autocheckpoint = 0;
      CREATE TABLE probe (value TEXT NOT NULL);
      INSERT INTO probe VALUES ('from-wal');
    `);
    expect(fs.existsSync(`${databasePath}-wal`)).toBe(true);

    const prepared = await prepare(databasePath);
    cleanup = prepared.cleanup;
    const snapshot = new sqlite.DatabaseSync(prepared.location, { readOnly: true });
    try {
      expect(snapshot.prepare("SELECT value FROM probe").all()).toEqual([{ value: "from-wal" }]);
    } finally {
      snapshot.close();
    }
    expect(prepared.cleanup()).toBe(true);
    cleanup = undefined;
  } finally {
    cleanup?.();
    writer.close();
  }
}

function readFamily(pathname: string): Map<string, Buffer> {
  const family = new Map<string, Buffer>();
  for (const suffix of ["", "-journal", "-shm", "-wal"]) {
    const memberPath = `${pathname}${suffix}`;
    if (fs.existsSync(memberPath)) {
      family.set(suffix, fs.readFileSync(memberPath));
    }
  }
  return family;
}

function readLogicalFamily(pathname: string): Map<string, Buffer> {
  const family = readFamily(pathname);
  family.delete("-shm");
  return family;
}

describe("prepareSqliteReadOnlyLocation", () => {
  it("prepares a readable WAL snapshot through the async public entry point", async () => {
    await expectPublicSnapshot(prepareSqliteReadOnlyLocation);
  });

  it("prepares a readable WAL snapshot through the sync public entry point", async () => {
    await expectPublicSnapshot(prepareSqliteReadOnlyLocationSync);
  });

  it.each([
    { mode: "async", prepare: prepareSqliteReadOnlyLocation },
    { mode: "sync", prepare: prepareSqliteReadOnlyLocationSync },
  ])("stages the $mode isolated worker snapshot in the private user cache", async ({ prepare }) => {
    const cacheRoot = tempDirs.make("openclaw-sqlite-snapshot-cache-");
    const sqlite = requireNodeSqlite();
    const databasePath = createTempDatabasePath();
    const database = new sqlite.DatabaseSync(databasePath);
    database.exec("CREATE TABLE probe (value TEXT); INSERT INTO probe VALUES ('cached');");
    database.close();

    await withEnvAsync({ XDG_CACHE_HOME: cacheRoot }, async () => {
      const prepared = await prepare(databasePath);
      try {
        expect(prepared.location.startsWith(`${cacheRoot}${path.sep}`)).toBe(true);
        expect(fs.statSync(path.dirname(prepared.location)).mode & 0o777).toBe(0o700);
        const snapshot = new sqlite.DatabaseSync(prepared.location, { readOnly: true });
        expect(snapshot.prepare("SELECT value FROM probe").all()).toEqual([{ value: "cached" }]);
        snapshot.close();
      } finally {
        expect(prepared.cleanup()).toBe(true);
      }
    });
  });

  it("avoids an exhausted OS temp root when a private cache can hold the snapshot", async () => {
    const cacheRoot = tempDirs.make("openclaw-sqlite-snapshot-quota-");
    const sqlite = requireNodeSqlite();
    const databasePath = createTempDatabasePath();
    const database = new sqlite.DatabaseSync(databasePath);
    database.exec("CREATE TABLE probe (value TEXT); INSERT INTO probe VALUES ('survived');");
    database.close();
    const before = readFamily(databasePath);
    const quotaError = Object.assign(new Error("disk I/O error"), {
      code: "ERR_SQLITE_ERROR",
      errcode: 778,
    });
    const backup = sqlite.backup.bind(sqlite);
    vi.spyOn(sqlite, "backup").mockImplementation(async (source, destination, options) => {
      if (!String(destination).startsWith(`${cacheRoot}${path.sep}`)) {
        throw quotaError;
      }
      return await (options ? backup(source, destination, options) : backup(source, destination));
    });

    await withEnvAsync({ XDG_CACHE_HOME: cacheRoot }, async () => {
      const prepared = await prepareSqliteReadOnlyLocationInProcess(databasePath);
      try {
        expect(prepared.location.startsWith(`${cacheRoot}${path.sep}`)).toBe(true);
        expect(readFamily(databasePath)).toEqual(before);
      } finally {
        expect(prepared.cleanup()).toBe(true);
      }
    });
  });

  it.each([13, 778, 1034, 1290])(
    "retains SQLite destination write failure %i and identifies the snapshot cache",
    async (errcode) => {
      const cacheRoot = tempDirs.make("openclaw-sqlite-snapshot-full-");
      const sqlite = requireNodeSqlite();
      const databasePath = createTempDatabasePath();
      const database = new sqlite.DatabaseSync(databasePath);
      database.exec("CREATE TABLE probe (value TEXT);");
      database.close();
      const quotaError = Object.assign(new Error("disk I/O error"), {
        code: "ERR_SQLITE_ERROR",
        errcode,
      });
      vi.spyOn(sqlite, "backup").mockRejectedValueOnce(quotaError);

      await withEnvAsync({ XDG_CACHE_HOME: cacheRoot }, async () => {
        await expect(prepareSqliteReadOnlyLocationInProcess(databasePath)).rejects.toMatchObject({
          cause: quotaError,
          message: expect.stringContaining(`SQLite errcode=${errcode}`),
        });
      });
      expect(fs.readdirSync(path.join(cacheRoot, "openclaw"))).toEqual([]);
    },
  );

  it.each(
    [
      {
        mode: "async backup",
        prepare: prepareSqliteReadOnlyLocationInProcess,
        empty: false,
        sync: false,
      },
      {
        mode: "async copy",
        prepare: prepareSqliteReadOnlyLocationInProcess,
        empty: true,
        sync: false,
      },
      {
        mode: "sync copy",
        prepare: prepareSqliteReadOnlyLocationSyncInProcess,
        empty: false,
        sync: true,
      },
    ].flatMap((scenario) =>
      ["ENOSPC", "EDQUOT", "EACCES", "EPERM", "EROFS"].map((code) =>
        Object.assign({}, scenario, { code }),
      ),
    ),
  )(
    "identifies $mode private cache allocation failure $code before backup or copying",
    async ({ code, empty, prepare, sync }) => {
      const cacheRoot = tempDirs.make("openclaw-sqlite-snapshot-allocation-");
      const databasePath = createTempDatabasePath();
      const sqlite = requireNodeSqlite();
      if (empty) {
        fs.writeFileSync(databasePath, "");
      } else {
        const database = new sqlite.DatabaseSync(databasePath);
        database.exec("CREATE TABLE probe (value TEXT);");
        database.close();
      }
      const stagingRoot = path.join(cacheRoot, "openclaw");
      const allocationError = Object.assign(new Error("snapshot directory allocation failed"), {
        code,
        path: path.join(stagingRoot, "openclaw-sqlite-readonly-stage"),
      });
      const backup = vi.spyOn(sqlite, "backup");
      const write = vi.spyOn(fs, "writeSync");
      if (sync) {
        vi.spyOn(fs, "mkdtempSync").mockImplementationOnce(() => {
          throw allocationError;
        });
      } else {
        vi.spyOn(fs.promises, "mkdtemp").mockRejectedValueOnce(allocationError);
      }

      await withEnvAsync({ XDG_CACHE_HOME: cacheRoot }, async () => {
        const error = await Promise.resolve()
          .then(() => prepare(databasePath))
          .catch((cause: unknown) => cause);
        expect(error).toMatchObject({
          cause: allocationError,
          message: expect.stringContaining(stagingRoot),
        });
        expect((error as Error).message).toContain("XDG_CACHE_HOME");
      });

      expect(backup).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
      expect(fs.readdirSync(stagingRoot)).toEqual([]);
    },
  );

  it.each([
    { mode: "async", prepare: prepareSqliteReadOnlyLocationInProcess, sync: false },
    { mode: "sync", prepare: prepareSqliteReadOnlyLocationSyncInProcess, sync: true },
  ])(
    "identifies sanitized $mode Windows allocation failures without losing their causes",
    async ({ prepare, sync }) => {
      const cacheRoot = tempDirs.make("openclaw-sqlite-snapshot-windows-allocation-");
      const databasePath = createTempDatabasePath();
      const sqlite = requireNodeSqlite();
      const database = new sqlite.DatabaseSync(databasePath);
      database.exec("CREATE TABLE probe (value TEXT);");
      database.close();
      const stagingRoot = path.join(cacheRoot, "openclaw");
      const directoryPath = path.join(stagingRoot, "openclaw-sqlite-readonly-stage");
      const allocationError = new Error("PowerShell failed (status=1); stderr: Access is denied.");
      const windowsError = new Error(
        `Unable to create private Windows SQLite directory: ${directoryPath}`,
        { cause: allocationError },
      );
      if (sync) {
        vi.spyOn(fs, "mkdtempSync").mockImplementationOnce(() => {
          throw windowsError;
        });
      } else {
        vi.spyOn(fs.promises, "mkdtemp").mockRejectedValueOnce(windowsError);
      }

      await withEnvAsync({ XDG_CACHE_HOME: cacheRoot }, async () => {
        const error = await Promise.resolve()
          .then(() => prepare(databasePath))
          .catch((cause: unknown) => cause);
        expect(error).toMatchObject({ cause: windowsError });
        expect((error as Error).message).toContain(windowsError.message);
        expect((error as Error).message).toContain(stagingRoot);
        expect((error as Error).message).toContain("XDG_CACHE_HOME");
        expect(((error as Error).cause as Error).cause).toBe(allocationError);
      });

      expect(fs.readdirSync(stagingRoot)).toEqual([]);
    },
  );

  it.each([
    { label: "SQLite source read", code: "ERR_SQLITE_ERROR", errcode: 266 },
    { label: "SQLite source locking", code: "ERR_SQLITE_ERROR", errcode: 5 },
    { label: "filesystem source read", code: "EACCES", errcode: undefined },
  ])("preserves $label failures without staging guidance", async ({ label, code, errcode }) => {
    const cacheRoot = tempDirs.make("openclaw-sqlite-snapshot-source-failure-");
    const sqlite = requireNodeSqlite();
    const databasePath = createTempDatabasePath();
    const database = new sqlite.DatabaseSync(databasePath);
    database.exec("CREATE TABLE probe (value TEXT);");
    database.close();
    const sourceError = Object.assign(new Error(label), {
      code,
      ...(errcode === undefined ? { path: databasePath } : { errcode }),
    });
    vi.spyOn(sqlite, "backup").mockRejectedValueOnce(sourceError);

    await withEnvAsync({ XDG_CACHE_HOME: cacheRoot }, async () => {
      await expect(prepareSqliteReadOnlyLocationInProcess(databasePath)).rejects.toBe(sourceError);
    });
    expect(fs.readdirSync(path.join(cacheRoot, "openclaw"))).toEqual([]);
  });

  it("preserves source failures inside the snapshot cache without staging guidance", async () => {
    const cacheRoot = tempDirs.make("openclaw-sqlite-snapshot-cached-source-");
    const stagingRoot = path.join(cacheRoot, "openclaw");
    fs.mkdirSync(stagingRoot, { mode: 0o700 });
    const databasePath = path.join(stagingRoot, "source.sqlite");
    const sqlite = requireNodeSqlite();
    const database = new sqlite.DatabaseSync(databasePath);
    database.exec("CREATE TABLE probe (value TEXT);");
    database.close();
    const sourceError = Object.assign(new Error("source permission denied"), {
      code: "EACCES",
      path: databasePath,
    });
    vi.spyOn(sqlite, "backup").mockRejectedValueOnce(sourceError);

    await withEnvAsync({ XDG_CACHE_HOME: cacheRoot }, async () => {
      const error = await prepareSqliteReadOnlyLocationInProcess(databasePath).catch(
        (cause: unknown) => cause,
      );
      expect(error).toBe(sourceError);
      expect((error as Error).message).not.toMatch(/staging|quota|XDG_CACHE_HOME/u);
    });
    expect(fs.readdirSync(stagingRoot)).toEqual(["source.sqlite"]);
  });

  it("identifies filesystem failures whose path belongs to the staging destination", async () => {
    const cacheRoot = tempDirs.make("openclaw-sqlite-snapshot-destination-path-");
    const sqlite = requireNodeSqlite();
    const databasePath = createTempDatabasePath();
    const database = new sqlite.DatabaseSync(databasePath);
    database.exec("CREATE TABLE probe (value TEXT);");
    database.close();
    vi.spyOn(sqlite, "backup").mockImplementationOnce(async (_source, destination) => {
      throw Object.assign(new Error("destination permission denied"), {
        code: "EACCES",
        path: String(destination),
      });
    });

    await withEnvAsync({ XDG_CACHE_HOME: cacheRoot }, async () => {
      await expect(prepareSqliteReadOnlyLocationInProcess(databasePath)).rejects.toMatchObject({
        cause: { code: "EACCES", path: expect.stringContaining(cacheRoot) },
        message: expect.stringContaining(cacheRoot),
      });
    });
    expect(fs.readdirSync(path.join(cacheRoot, "openclaw"))).toEqual([]);
  });

  it("preserves source corruption without reporting a snapshot staging quota failure", async () => {
    const cacheRoot = tempDirs.make("openclaw-sqlite-snapshot-corrupt-source-");
    const sqlite = requireNodeSqlite();
    const databasePath = createTempDatabasePath();
    const database = new sqlite.DatabaseSync(databasePath);
    database.exec("CREATE TABLE probe (value TEXT); INSERT INTO probe VALUES ('corrupt');");
    database.close();

    const descriptor = fs.openSync(databasePath, "r+");
    try {
      fs.writeSync(descriptor, Buffer.from([0]), 0, 1, 100);
    } finally {
      fs.closeSync(descriptor);
    }

    const corruptSource = new sqlite.DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(() => corruptSource.prepare("PRAGMA quick_check;").get()).toThrow(
        /database disk image is malformed/u,
      );
    } finally {
      corruptSource.close();
    }

    await withEnvAsync({ XDG_CACHE_HOME: cacheRoot }, async () => {
      const inProcessError = await prepareSqliteReadOnlyLocationInProcess(databasePath).catch(
        (error: unknown) => error,
      );
      const workerError = await prepareSqliteReadOnlyLocation(databasePath).catch(
        (error: unknown) => error,
      );

      expect(inProcessError).toMatchObject({
        code: "ERR_SQLITE_ERROR",
        errcode: 11,
        message: "database disk image is malformed",
      });
      expect(workerError).toBeInstanceOf(Error);
      expect((workerError as Error).message).toContain(
        "database disk image is malformed (code=ERR_SQLITE_ERROR, errcode=11)",
      );
      expect((workerError as Error).message).not.toMatch(/staging|quota|XDG_CACHE_HOME/u);
    });
  });

  it.each(["EDQUOT", "ENOSPC"])(
    "keeps synchronous destination %s failures actionable without changing the source",
    async (code) => {
      const cacheRoot = tempDirs.make("openclaw-sqlite-snapshot-sync-full-");
      const sqlite = requireNodeSqlite();
      const databasePath = createTempDatabasePath();
      const database = new sqlite.DatabaseSync(databasePath);
      database.exec("CREATE TABLE probe (value TEXT);");
      database.close();
      const before = readFamily(databasePath);
      const quotaError = Object.assign(new Error("Disk quota exceeded"), { code });
      vi.spyOn(fs, "writeSync").mockImplementationOnce(() => {
        throw quotaError;
      });

      await withEnvAsync({ XDG_CACHE_HOME: cacheRoot }, async () => {
        expect(() => prepareSqliteReadOnlyLocationSyncInProcess(databasePath)).toThrowError(
          expect.objectContaining({
            cause: quotaError,
            message: expect.stringContaining(cacheRoot),
          }),
        );
      });
      expect(readFamily(databasePath)).toEqual(before);
      expect(fs.readdirSync(path.join(cacheRoot, "openclaw"))).toEqual([]);
    },
  );

  it("keeps a newly created cache root on the requested cache filesystem", async () => {
    const cacheRoot = path.join(tempDirs.make("openclaw-sqlite-snapshot-new-cache-"), "missing");
    const sqlite = requireNodeSqlite();
    const databasePath = createTempDatabasePath();
    const database = new sqlite.DatabaseSync(databasePath);
    database.exec("CREATE TABLE probe (value TEXT);");
    database.close();

    await withEnvAsync({ XDG_CACHE_HOME: cacheRoot }, async () => {
      const prepared = await prepareSqliteReadOnlyLocation(databasePath);
      try {
        expect(prepared.location.startsWith(`${cacheRoot}${path.sep}`)).toBe(true);
        expect(fs.statSync(path.dirname(prepared.location)).mode & 0o777).toBe(0o700);
      } finally {
        expect(prepared.cleanup()).toBe(true);
      }
    });
  });

  it.runIf(process.platform !== "win32")(
    "reports the real SQLite write errcode across the isolated worker boundary",
    () => {
      const cacheRoot = tempDirs.make("openclaw-sqlite-snapshot-worker-full-");
      const sqlite = requireNodeSqlite();
      const databasePath = createTempDatabasePath();
      const database = new sqlite.DatabaseSync(databasePath);
      database.exec(
        "CREATE TABLE probe (payload BLOB); INSERT INTO probe VALUES (zeroblob(8192));",
      );
      database.close();
      const workerUrl = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.sqliteReadOnly);
      const extension = workerUrl.pathname.endsWith(".ts") ? ".ts" : ".js";
      const moduleUrl = new URL(`./sqlite-readonly-location${extension}`, workerUrl).href;
      const script = `
        const { prepareSqliteReadOnlyLocation } = await import(${JSON.stringify(moduleUrl)});
        try {
          await prepareSqliteReadOnlyLocation(${JSON.stringify(databasePath)});
          process.exitCode = 24;
        } catch (error) {
          console.log(JSON.stringify({ message: error.message }));
        }
      `;
      const child = spawnSync(
        "/bin/sh",
        [
          "-c",
          'ulimit -f 1; exec "$@"',
          "openclaw-sqlite-snapshot-quota",
          process.execPath,
          ...resolveRuntimeWorkerArgv(workerUrl).slice(0, -1),
          "--input-type=module",
          "-e",
          script,
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: { ...process.env, XDG_CACHE_HOME: cacheRoot },
        },
      );

      expect(child.status, child.stderr).toBe(0);
      const reported = JSON.parse(child.stdout) as { message: string };
      expect(reported.message).toContain(cacheRoot);
      expect(reported.message).toMatch(/free.*space|quota/iu);
      expect(reported.message).toContain("(code=ERR_SQLITE_ERROR, errcode=778)");
    },
  );

  it("propagates async public entry point failures", async () => {
    const missingPath = path.join(tempDirs.make("openclaw-sqlite-readonly-missing-"), "missing.db");
    await expect(prepareSqliteReadOnlyLocation(missingPath)).rejects.toThrow(
      /SQLite read-only worker .*ENOENT.*\(code=ENOENT\)/u,
    );
  });

  it("propagates sync public entry point failures", () => {
    const missingPath = path.join(tempDirs.make("openclaw-sqlite-readonly-missing-"), "missing.db");
    expect(() => prepareSqliteReadOnlyLocationSync(missingPath)).toThrow(
      /SQLite read-only worker .*ENOENT.*\(code=ENOENT\)/u,
    );
  });

  it.runIf(process.platform === "linux")(
    "keeps a live WAL connection's POSIX locks in the owning process",
    async () => {
      const sqlite = requireNodeSqlite();
      const databasePath = createTempDatabasePath();
      const writer = new sqlite.DatabaseSync(databasePath);
      writer.exec(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE writes (id INTEGER PRIMARY KEY);
        INSERT INTO writes DEFAULT VALUES;
      `);
      const locksBefore = readMainDatabasePosixLocks(databasePath);
      const cleanups: Array<() => boolean> = [];
      try {
        expect(locksBefore).toEqual([
          { length: 510, pid: process.pid, start: 1073741826, type: "read" },
        ]);

        const preparedAsync = await prepareSqliteReadOnlyLocation(databasePath);
        cleanups.push(preparedAsync.cleanup);
        expect(readMainDatabasePosixLocks(databasePath)).toEqual(locksBefore);
        expect(preparedAsync.cleanup()).toBe(true);

        const preparedSync = prepareSqliteReadOnlyLocationSync(databasePath);
        cleanups.push(preparedSync.cleanup);
        expect(readMainDatabasePosixLocks(databasePath)).toEqual(locksBefore);
        expect(preparedSync.cleanup()).toBe(true);

        const characterized = prepareSqliteReadOnlyLocationSyncInProcess(databasePath);
        cleanups.push(characterized.cleanup);
        expect(readMainDatabasePosixLocks(databasePath)).toEqual([]);
        expect(characterized.cleanup()).toBe(true);
      } finally {
        for (const cleanup of cleanups) {
          cleanup();
        }
        writer.close();
      }
    },
  );

  it("retries a same-size WAL reset instead of accepting an impossible pair", async () => {
    const sqlite = requireNodeSqlite();
    const livePath = createTempDatabasePath();
    const writer = new sqlite.DatabaseSync(livePath);
    writer.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA wal_autocheckpoint = 0;
      CREATE TABLE before_reset (value TEXT PRIMARY KEY);
      CREATE TABLE after_reset (value TEXT PRIMARY KEY);
      PRAGMA wal_checkpoint(TRUNCATE);
      INSERT INTO before_reset VALUES ('A');
    `);
    const databasePath = createTempDatabasePath();
    fs.copyFileSync(livePath, databasePath);
    fs.copyFileSync(`${livePath}-wal`, `${databasePath}-wal`);
    writer.close();
    expect(fs.existsSync(`${databasePath}-shm`)).toBe(false);
    const walSizeBeforeReset = fs.statSync(`${databasePath}-wal`).size;
    const fsyncSync = fs.fsyncSync.bind(fs);
    let injected = false;
    let raceWriter: DatabaseSync | undefined;
    let sourceAfterReset: Map<string, Buffer> | undefined;
    vi.spyOn(fs, "fsyncSync").mockImplementation((descriptor) => {
      fsyncSync(descriptor);
      if (!injected) {
        injected = true;
        raceWriter = new sqlite.DatabaseSync(databasePath);
        raceWriter.exec(`
          PRAGMA wal_checkpoint(TRUNCATE);
          INSERT INTO after_reset VALUES ('B');
        `);
        sourceAfterReset = readLogicalFamily(databasePath);
      }
    });

    const prepared = await prepareSqliteReadOnlyLocationInProcess(databasePath);
    expect(injected).toBe(true);
    expect(fs.statSync(`${databasePath}-wal`).size).toBe(walSizeBeforeReset);
    const snapshot = new sqlite.DatabaseSync(prepared.location, { readOnly: true });
    expect(snapshot.prepare("SELECT value FROM before_reset").all()).toEqual([{ value: "A" }]);
    expect(snapshot.prepare("SELECT value FROM after_reset").all()).toEqual([{ value: "B" }]);
    expect(snapshot.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    snapshot.close();
    expect(readLogicalFamily(databasePath)).toEqual(sourceAfterReset);
    expect(prepared.cleanup()).toBe(true);
    raceWriter?.close();
  });

  it("backs up an active WAL database while another connection keeps writing", async () => {
    const sqlite = requireNodeSqlite();
    const databasePath = createTempDatabasePath();
    const seed = new sqlite.DatabaseSync(databasePath);
    seed.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA wal_autocheckpoint = 0;
      CREATE TABLE writes (sequence INTEGER PRIMARY KEY);
      CREATE TABLE payload (data BLOB NOT NULL);
      INSERT INTO payload VALUES (zeroblob(16777216));
      PRAGMA wal_checkpoint(TRUNCATE);
    `);
    seed.close();
    const writer = startSqliteConcurrentWriter(databasePath, "WAL");
    writers.push(writer);
    try {
      const ready = await writer.waitFor("ready");
      expect(ready.commits).toBeGreaterThan(0);
      expect(writer.pid).not.toBe(process.pid);

      const prepared = await prepareSqliteReadOnlyLocationInProcess(databasePath);
      const snapshot = new sqlite.DatabaseSync(prepared.location, { readOnly: true });
      try {
        expect(snapshot.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
        expect(snapshot.prepare("SELECT COUNT(*) AS count FROM payload").get()).toEqual({
          count: 1,
        });
        expect(
          snapshot.prepare("SELECT COUNT(*) AS count FROM writes").get()?.count,
        ).toBeGreaterThan(0);
      } finally {
        snapshot.close();
        expect(prepared.cleanup()).toBe(true);
      }
      expect((await writer.progress()).commits).toBeGreaterThan(ready.commits);
    } finally {
      await writer.stop();
    }
  });

  it("retries when backup fallback inspection sees a replaced source", async () => {
    const sqlite = requireNodeSqlite();
    const databasePath = createTempDatabasePath();
    const writer = new sqlite.DatabaseSync(databasePath);
    writer.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA wal_autocheckpoint = 0;
      CREATE TABLE probe (value TEXT);
      INSERT INTO probe VALUES ('ok');
    `);
    const canonicalDatabasePath = fs.realpathSync.native(databasePath);
    let failNextSourceStat = false;
    vi.spyOn(sqlite, "backup").mockImplementationOnce(async () => {
      failNextSourceStat = true;
      throw new Error("simulated backup race");
    });
    const statSync = fs.statSync.bind(fs);
    vi.spyOn(fs, "statSync").mockImplementation(((pathname, options) => {
      if (failNextSourceStat && path.resolve(String(pathname)) === canonicalDatabasePath) {
        failNextSourceStat = false;
        const error = new Error("missing");
        (error as NodeJS.ErrnoException).code = "ENOENT";
        throw error;
      }
      return statSync(pathname, options as never);
    }) as typeof fs.statSync);

    const prepared = await prepareSqliteReadOnlyLocationInProcess(databasePath);
    const snapshot = new sqlite.DatabaseSync(prepared.location, { readOnly: true });
    expect(snapshot.prepare("SELECT value FROM probe").all()).toEqual([{ value: "ok" }]);
    snapshot.close();
    expect(prepared.cleanup()).toBe(true);
    writer.close();
  });

  it("rolls back contended MEMORY writes before committing another batch", async () => {
    const sqlite = requireNodeSqlite();
    const databasePath = createTempDatabasePath();
    const reader = new sqlite.DatabaseSync(databasePath);
    reader.exec(
      "CREATE TABLE pair (name TEXT PRIMARY KEY, value INTEGER NOT NULL); INSERT INTO pair VALUES ('left', 0), ('right', 0); BEGIN;",
    );
    expect(reader.prepare("SELECT value FROM pair ORDER BY name").all()).toEqual([
      { value: 0 },
      { value: 0 },
    ]);
    const writer = startSqliteConcurrentWriter(databasePath, "MEMORY", 0);
    writers.push(writer);
    try {
      // Hold a native reader until COMMIT reports BUSY. Only the producer
      // wait is disabled; real locking and rollback still own the outcome.
      expect(await writer.waitFor("busy")).toEqual({
        event: "busy",
        commits: 0,
        transaction: false,
      });
      expect(reader.prepare("SELECT value FROM pair ORDER BY name").all()).toEqual([
        { value: 0 },
        { value: 0 },
      ]);
      reader.exec("ROLLBACK");
      expect((await writer.waitFor("ready")).commits).toBeGreaterThan(0);
      expect((await writer.progress()).commits).toBeGreaterThan(1);
      await writer.stop();
      const values = reader
        .prepare("SELECT value FROM pair ORDER BY name")
        .all()
        .map((row) => row.value);
      expect(values).toHaveLength(2);
      expect(values[0]).toBeGreaterThan(0);
      expect(values[0]).toBe(values[1]);
      expect(reader.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    } finally {
      reader.close();
      await writer.stop();
    }
  });

  it("backs up live MEMORY-journal transactions atomically", async () => {
    const sqlite = requireNodeSqlite();
    const databasePath = createTempDatabasePath();
    const seed = new sqlite.DatabaseSync(databasePath);
    seed.exec(`
      CREATE TABLE pair (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
      INSERT INTO pair VALUES ('left', 0), ('right', 0);
      CREATE TABLE payload (data BLOB NOT NULL);
      INSERT INTO payload VALUES (zeroblob(8388608));
    `);
    seed.close();
    const writer = startSqliteConcurrentWriter(databasePath, "MEMORY");
    writers.push(writer);
    try {
      const ready = await writer.waitFor("ready");
      expect(ready.commits).toBeGreaterThan(0);
      expect(writer.pid).not.toBe(process.pid);
      // Hold a real half-written transaction so read admission does not race
      // an unbounded stream of commits; the snapshot must exclude that write.
      const held = await writer.holdTransaction();
      expect(held.commits).toBeGreaterThanOrEqual(ready.commits);
      expect(held.transaction).toBe(true);
      expect(held.values).toEqual([held.commits + 1, held.commits]);

      const prepared = await prepareSqliteReadOnlyLocationInProcess(databasePath);
      const snapshot = new sqlite.DatabaseSync(prepared.location, { readOnly: true });
      try {
        const values = snapshot
          .prepare("SELECT value FROM pair ORDER BY name")
          .all()
          .map((row) => (row as { value: number }).value);
        expect(values).toEqual([held.commits, held.commits]);
        expect(snapshot.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      } finally {
        snapshot.close();
        expect(prepared.cleanup()).toBe(true);
      }
      const progress = await writer.progress();
      expect(progress.commits).toBeGreaterThan(held.commits);
      expect(progress.transaction).toBe(false);
      const unfinished = await writer.holdTransaction();
      expect(unfinished.transaction).toBe(true);
      expect(unfinished.values).toEqual([unfinished.commits + 1, unfinished.commits]);
      await writer.stop();
      const source = new sqlite.DatabaseSync(databasePath, { readOnly: true });
      try {
        expect(source.prepare("SELECT value FROM pair ORDER BY name").all()).toEqual([
          { value: unfinished.commits },
          { value: unfinished.commits },
        ]);
        expect(source.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      } finally {
        source.close();
      }
    } finally {
      await writer.stop();
    }
  });

  it("keeps a rollback-to-WAL transition off the source path", async () => {
    const sqlite = requireNodeSqlite();
    const databasePath = createTempDatabasePath();
    const seed = new sqlite.DatabaseSync(databasePath);
    seed.exec("CREATE TABLE probe (value TEXT); INSERT INTO probe VALUES ('ok');");
    seed.close();
    const fsyncSync = fs.fsyncSync.bind(fs);
    let injected = false;
    let sourceAfterTransition: Map<string, Buffer> | undefined;
    vi.spyOn(fs, "fsyncSync").mockImplementation((descriptor) => {
      fsyncSync(descriptor);
      if (!injected) {
        injected = true;
        const writer = new sqlite.DatabaseSync(databasePath);
        writer.exec("PRAGMA journal_mode = WAL; PRAGMA wal_checkpoint(TRUNCATE);");
        writer.close();
        sourceAfterTransition = readFamily(databasePath);
      }
    });

    const prepared = await prepareSqliteReadOnlyLocationInProcess(databasePath);
    expect(injected).toBe(true);
    expect(path.resolve(prepared.location)).not.toBe(path.resolve(databasePath));
    const snapshot = new sqlite.DatabaseSync(prepared.location, { readOnly: true });
    expect(snapshot.prepare("SELECT value FROM probe").all()).toEqual([{ value: "ok" }]);
    snapshot.close();
    expect(readFamily(databasePath)).toEqual(sourceAfterTransition);
    expect(prepared.cleanup()).toBe(true);
  });

  it.runIf(process.platform !== "win32")(
    "finds WAL state beside a canonical symlink target",
    async () => {
      const sqlite = requireNodeSqlite();
      const databasePath = createTempDatabasePath();
      const writer = new sqlite.DatabaseSync(databasePath);
      writer.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA wal_autocheckpoint = 0;
        CREATE TABLE probe (value TEXT);
        PRAGMA wal_checkpoint(TRUNCATE);
        INSERT INTO probe VALUES ('from-wal');
      `);
      const symlinkPath = path.join(path.dirname(databasePath), "state-link.sqlite");
      fs.symlinkSync(path.basename(databasePath), symlinkPath);

      const prepared = await prepareSqliteReadOnlyLocationInProcess(symlinkPath);
      const snapshot = new sqlite.DatabaseSync(prepared.location, { readOnly: true });
      expect(snapshot.prepare("SELECT value FROM probe").all()).toEqual([{ value: "from-wal" }]);
      snapshot.close();
      expect(fs.existsSync(`${symlinkPath}-wal`)).toBe(false);
      expect(fs.existsSync(`${symlinkPath}-shm`)).toBe(false);
      expect(prepared.cleanup()).toBe(true);
      writer.close();
    },
  );

  it("retries when a pathname disappears after its file is opened", async () => {
    const sqlite = requireNodeSqlite();
    const databasePath = createTempDatabasePath();
    const seed = new sqlite.DatabaseSync(databasePath);
    seed.exec("CREATE TABLE probe (value TEXT); INSERT INTO probe VALUES ('ok');");
    seed.close();
    const canonicalDatabasePath = fs.realpathSync.native(databasePath);
    const statSync = fs.statSync.bind(fs);
    let injected = false;
    vi.spyOn(fs, "statSync").mockImplementation(((pathname, options) => {
      if (!injected && path.resolve(String(pathname)) === canonicalDatabasePath) {
        injected = true;
        const error = new Error("missing");
        (error as NodeJS.ErrnoException).code = "ENOENT";
        throw error;
      }
      return statSync(pathname, options as never);
    }) as typeof fs.statSync);

    const prepared = await prepareSqliteReadOnlyLocationInProcess(databasePath);
    expect(injected).toBe(true);
    const snapshot = new sqlite.DatabaseSync(prepared.location, { readOnly: true });
    expect(snapshot.prepare("SELECT value FROM probe").all()).toEqual([{ value: "ok" }]);
    snapshot.close();
    expect(prepared.cleanup()).toBe(true);
  });

  it("retries cleanup after a transient removal failure", async () => {
    const sqlite = requireNodeSqlite();
    const databasePath = createTempDatabasePath();
    const seed = new sqlite.DatabaseSync(databasePath);
    seed.exec("CREATE TABLE probe (value TEXT);");
    seed.close();
    const prepared = await prepareSqliteReadOnlyLocationInProcess(databasePath);
    const privateDirectory = path.dirname(prepared.location);
    const rmSync = fs.rmSync.bind(fs);
    let failRemoval = true;
    vi.spyOn(fs, "rmSync").mockImplementation(((pathname, options) => {
      if (failRemoval && path.resolve(String(pathname)) === path.resolve(privateDirectory)) {
        failRemoval = false;
        const error = new Error("busy");
        (error as NodeJS.ErrnoException).code = "EBUSY";
        throw error;
      }
      return rmSync(pathname, options);
    }) as typeof fs.rmSync);

    expect(prepared.cleanup()).toBe(false);
    expect(fs.existsSync(privateDirectory)).toBe(true);
    expect(prepared.cleanup()).toBe(true);
    expect(fs.existsSync(privateDirectory)).toBe(false);
  });

  it("copies an orphan SHM privately without creating a source WAL", async () => {
    const sqlite = requireNodeSqlite();
    const databasePath = createTempDatabasePath();
    const seed = new sqlite.DatabaseSync(databasePath);
    seed.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE probe (value TEXT);
      INSERT INTO probe VALUES ('committed');
      PRAGMA wal_checkpoint(TRUNCATE);
    `);
    seed.close();
    fs.rmSync(`${databasePath}-wal`, { force: true });
    const orphanShm = Buffer.alloc(32 * 1024, 0x5a);
    fs.writeFileSync(`${databasePath}-shm`, orphanShm, { mode: 0o600 });
    const beforeMain = fs.readFileSync(databasePath);
    const beforeEntries = fs.readdirSync(path.dirname(databasePath)).toSorted();

    const prepared = await prepareSqliteReadOnlyLocationInProcess(databasePath);
    const snapshot = new sqlite.DatabaseSync(prepared.location, { readOnly: true });
    expect(snapshot.prepare("SELECT value FROM probe").all()).toEqual([{ value: "committed" }]);
    snapshot.close();
    expect(prepared.cleanup()).toBe(true);

    expect(fs.existsSync(`${databasePath}-wal`)).toBe(false);
    expect(fs.readFileSync(`${databasePath}-shm`)).toEqual(orphanShm);
    expect(fs.readFileSync(databasePath)).toEqual(beforeMain);
    expect(fs.readdirSync(path.dirname(databasePath)).toSorted()).toEqual(beforeEntries);
  });
});
