// Covers SQLite WAL maintenance configuration.
import { AsyncLocalStorage, createHook } from "node:async_hooks";
import childProcess, { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { expectDefined } from "@openclaw/normalization-core";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../shared/deferred.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import {
  configureSqliteConnectionPragmas,
  configureSqlitePreSchemaPragmas,
  configureSqliteWalMaintenance,
} from "./sqlite-wal.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createMockDb(): DatabaseSync {
  return {
    close: vi.fn(),
    exec: vi.fn(),
    isOpen: true,
    prepare: vi.fn((sql: string) => ({
      get: vi.fn(() =>
        sql.includes("wal_checkpoint")
          ? { busy: 0, log: 0, checkpointed: 0 }
          : { journal_mode: sql === "PRAGMA journal_mode;" ? "wal" : "delete" },
      ),
    })),
  } as unknown as DatabaseSync;
}

function statfsFixture(type: number): ReturnType<typeof fs.statfsSync> {
  return {
    type,
    bsize: 1024,
    blocks: 1,
    bfree: 1,
    bavail: 1,
    files: 0,
    frsize: 1024,
    ffree: 0,
  };
}

describe("sqlite WAL maintenance", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("uses rollback journaling for databases on NFS-backed volumes", () => {
    const tempDir = tempDirs.make("openclaw-sqlite-nfs-");
    const db = createMockDb();
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const statfs = vi.spyOn(fs, "statfsSync").mockReturnValue(statfsFixture(0x6969));

    const maintenance = configureSqliteWalMaintenance(db, {
      checkpointIntervalMs: 0,
      databasePath: path.join(tempDir, "missing", "openclaw.sqlite"),
    });

    expect(statfs).toHaveBeenCalledWith(fs.realpathSync(tempDir));
    expect(db["prepare"]).toHaveBeenCalledWith("PRAGMA journal_mode = DELETE;");
    expect(db["exec"]).not.toHaveBeenCalled();
    expect(maintenance.checkpoint()).toBe(true);
    expect(maintenance.close()).toBe(true);
    expect(db["exec"]).not.toHaveBeenCalled();
  });

  it.each([
    ["SMB", 0x517b],
    ["CIFS", 0xff534d42],
    ["SMB2", 0xfe534d42],
    ["9p (V9FS)", 0x01021997],
  ])("uses rollback journaling for databases on Linux %s volumes", (_label, fsType) => {
    const tempDir = tempDirs.make("openclaw-sqlite-network-");
    const db = createMockDb();
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    vi.spyOn(fs, "statfsSync").mockReturnValue(statfsFixture(fsType));

    configureSqliteWalMaintenance(db, {
      checkpointIntervalMs: 0,
      databasePath: path.join(tempDir, "openclaw.sqlite"),
    });

    expect(db["prepare"]).toHaveBeenCalledWith("PRAGMA journal_mode = DELETE;");
  });

  it.each([
    String.raw`\\server\share\openclaw.sqlite`,
    String.raw`\\?\UNC\server\share\openclaw.sqlite`,
    "//server/share/openclaw.sqlite",
    "//?/UNC/server/share/openclaw.sqlite",
  ])("uses rollback journaling for databases on Windows UNC paths: %s", (databasePath) => {
    const db = createMockDb();
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");

    configureSqliteWalMaintenance(db, {
      checkpointIntervalMs: 0,
      databasePath,
    });

    expect(db["prepare"]).toHaveBeenCalledWith("PRAGMA journal_mode = DELETE;");
    expect(db["exec"]).not.toHaveBeenCalled();
  });

  it("uses rollback journaling for mapped Windows network drives", () => {
    const db = createMockDb();
    const databasePath = String.raw`Z:\state\openclaw.sqlite`;
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const realpath = vi
      .spyOn(fs.realpathSync, "native")
      .mockReturnValue(String.raw`\\server\share\state\openclaw.sqlite`);

    configureSqliteWalMaintenance(db, {
      checkpointIntervalMs: 0,
      databasePath,
    });

    expect(realpath).toHaveBeenCalledWith(databasePath);
    expect(db["prepare"]).toHaveBeenCalledWith("PRAGMA journal_mode = DELETE;");
    expect(db["exec"]).not.toHaveBeenCalled();
  });

  it("does not treat namespaced Windows local drives as UNC paths", () => {
    const db = createMockDb();
    const databasePath = String.raw`\\?\C:\state\openclaw.sqlite`;
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const realpath = vi.spyOn(fs.realpathSync, "native").mockReturnValue(databasePath);

    configureSqliteWalMaintenance(db, {
      checkpointIntervalMs: 0,
      databasePath,
    });

    expect(realpath).toHaveBeenCalledWith(databasePath);
    expect(db["prepare"]).toHaveBeenCalledWith("PRAGMA journal_mode;");
    expect(db["exec"]).toHaveBeenNthCalledWith(1, "PRAGMA journal_mode = WAL;");
  });

  it("uses rollback journaling when Windows cannot classify an opened drive path", () => {
    const db = createMockDb();
    const databasePath = String.raw`Z:\restricted\openclaw.sqlite`;
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.spyOn(fs.realpathSync, "native").mockImplementation(() => {
      throw new Error("access denied");
    });

    configureSqliteWalMaintenance(db, {
      checkpointIntervalMs: 0,
      databasePath,
    });

    expect(db["prepare"]).toHaveBeenCalledWith("PRAGMA journal_mode = DELETE;");
    expect(db["exec"]).not.toHaveBeenCalled();
  });

  it("refuses network-backed databases when SQLite keeps WAL active", () => {
    const tempDir = tempDirs.make("openclaw-sqlite-nfs-");
    const db = createMockDb();
    vi.mocked(db["prepare"]).mockReturnValue({
      get: vi.fn(() => ({ journal_mode: "wal" })),
    } as unknown as ReturnType<DatabaseSync["prepare"]>);
    vi.spyOn(fs, "statfsSync").mockReturnValue(statfsFixture(0x6969));

    expect(() =>
      configureSqliteWalMaintenance(db, {
        checkpointIntervalMs: 0,
        databaseLabel: "test-db",
        databasePath: path.join(tempDir, "openclaw.sqlite"),
      }),
    ).toThrow(/test-db .*journal_mode=wal/);
  });

  it("accepts SQLite's memory journal for an in-memory database", () => {
    const sqlite = requireNodeSqlite();
    const db = new sqlite.DatabaseSync(":memory:");
    try {
      const maintenance = configureSqliteWalMaintenance(db, {
        checkpointIntervalMs: 0,
        databaseLabel: "in-memory-test-db",
      });

      expect(db.prepare("PRAGMA journal_mode;").get()).toEqual({ journal_mode: "memory" });
      expect(maintenance.checkpoint()).toBe(true);
      expect(maintenance.close()).toBe(true);
    } finally {
      db.close();
    }
  });

  it("reclaims an inflated WAL on the first commit after a completed checkpoint", () => {
    const sqlite = requireNodeSqlite();
    const dir = tempDirs.make("openclaw-sqlite-wal-size-");
    const dbPath = path.join(dir, "openclaw.sqlite");
    const walPath = `${dbPath}-wal`;
    const db = new sqlite.DatabaseSync(dbPath);
    let maintenance: ReturnType<typeof configureSqliteWalMaintenance> | undefined;
    try {
      maintenance = configureSqliteWalMaintenance(db, {
        autoCheckpointPages: 0,
        checkpointIntervalMs: 0,
        databaseLabel: "wal-size-default",
        databasePath: dbPath,
      });
      db.exec("CREATE TABLE payload (id INTEGER PRIMARY KEY, value TEXT NOT NULL);");
      db.prepare("INSERT INTO payload (value) VALUES (?)").run("before-checkpoint");

      const checkpoint = db.prepare("PRAGMA wal_checkpoint(PASSIVE);").get() as {
        busy: number;
        checkpointed: number;
        log: number;
      };
      expect(checkpoint.busy).toBe(0);
      expect(checkpoint.checkpointed).toBe(checkpoint.log);

      const sizeLimit = Number(
        (
          db.prepare("PRAGMA journal_size_limit;").get() as {
            journal_size_limit: number | bigint;
          }
        ).journal_size_limit,
      );
      expect(sizeLimit).toBe(64 * 1024 * 1024);
      // A sparse extension models a retained high-water WAL without writing a 65 MiB fixture.
      fs.truncateSync(walPath, sizeLimit + 1024 * 1024);

      db.prepare("INSERT INTO payload (value) VALUES (?)").run("after-checkpoint");

      expect(fs.statSync(walPath).size).toBe(sizeLimit);
    } finally {
      maintenance?.close();
      db.close();
    }
  });

  it("rejects a memory journal for a file-backed database", () => {
    const db = createMockDb();
    vi.mocked(db["prepare"]).mockImplementation(
      (sql) =>
        ({
          all: vi.fn(() =>
            sql === "PRAGMA database_list;"
              ? [{ seq: 0, name: "main", file: "/tmp/file-backed.sqlite" }]
              : [],
          ),
          get: vi.fn(() => ({ journal_mode: "memory" })),
        }) as unknown as ReturnType<DatabaseSync["prepare"]>,
    );

    expect(() =>
      configureSqliteWalMaintenance(db, {
        checkpointIntervalMs: 0,
        databaseLabel: "file-backed-test-db",
      }),
    ).toThrow("file-backed-test-db could not enable WAL; SQLite kept journal_mode=memory");
  });

  it.each([
    ["fuse.virtiofs", "Docker Desktop / OrbStack"],
    ["virtiofs", "Docker Desktop (alternate)"],
    ["9p", "VirtFS cross-VM"],
    ["9p2000.L", "VirtFS 2000.L"],
  ])("uses rollback journaling for %s mounts (%s)", (fsType, _label) => {
    const tempDir = tempDirs.make("openclaw-sqlite-virtiofs-");
    const db = createMockDb();
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    vi.spyOn(fs, "statfsSync").mockReturnValue(statfsFixture(0));
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      `42 12 0:41 / ${tempDir} rw,relatime - ${fsType} host0 rw\n`,
    );

    configureSqliteWalMaintenance(db, {
      checkpointIntervalMs: 0,
      databasePath: path.join(tempDir, "openclaw.sqlite"),
    });

    expect(db["prepare"]).toHaveBeenCalledWith("PRAGMA journal_mode = DELETE;");
    expect(db["exec"]).not.toHaveBeenCalled();
  });

  it("uses rollback journaling for virtiofs reported by macOS mount command", () => {
    const tempDir = tempDirs.make("openclaw-sqlite-virtiofs-mac-");
    const db = createMockDb();
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    vi.spyOn(fs, "statfsSync").mockReturnValue(statfsFixture(0));
    vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      throw new Error("no proc mountinfo");
    });
    vi.spyOn(childProcess, "execFileSync").mockReturnValue(
      Buffer.from(`hostdir on ${tempDir} (virtiofs, nodev, nosuid)\n`),
    );

    configureSqliteWalMaintenance(db, {
      checkpointIntervalMs: 0,
      databasePath: path.join(tempDir, "openclaw.sqlite"),
    });

    expect(db["prepare"]).toHaveBeenCalledWith("PRAGMA journal_mode = DELETE;");
    expect(db["exec"]).not.toHaveBeenCalled();
  });

  it("uses mountinfo filesystem names when statfs magic is not enough", () => {
    const tempDir = tempDirs.make("openclaw-sqlite-nfs-");
    const db = createMockDb();
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    vi.spyOn(fs, "statfsSync").mockReturnValue(statfsFixture(0));
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      `42 12 0:41 / ${tempDir} rw,relatime - nfs4 server:/share rw\n`,
    );

    configureSqliteWalMaintenance(db, {
      checkpointIntervalMs: 0,
      databasePath: path.join(tempDir, "openclaw.sqlite"),
    });

    expect(db["prepare"]).toHaveBeenCalledWith("PRAGMA journal_mode = DELETE;");
  });

  it("refuses fuse.sshfs mountinfo entries", () => {
    const tempDir = tempDirs.make("openclaw-sqlite-sshfs-");
    const db = createMockDb();
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    vi.spyOn(fs, "statfsSync").mockReturnValue(statfsFixture(0));
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      `42 12 0:41 / ${tempDir} rw,relatime - fuse.sshfs user@host:/share rw\n`,
    );

    expect(() =>
      configureSqliteWalMaintenance(db, {
        checkpointIntervalMs: 0,
        databaseLabel: "test-db",
        databasePath: path.join(tempDir, "openclaw.sqlite"),
      }),
    ).toThrow(/test-db .*SSHFS.*refusing to open/);

    expect(db["prepare"]).not.toHaveBeenCalled();
    expect(db["exec"]).not.toHaveBeenCalled();
  });

  it("refuses symlinked paths into fuse.sshfs mounts", () => {
    if (process.platform === "win32") {
      return;
    }
    const tempDir = tempDirs.make("openclaw-sqlite-sshfs-link-");
    const mountDir = path.join(tempDir, "mount");
    const linkedDir = path.join(tempDir, "linked");
    fs.mkdirSync(mountDir);
    fs.symlinkSync(mountDir, linkedDir);
    const canonicalMountDir = fs.realpathSync(mountDir);
    vi.spyOn(fs, "statfsSync").mockReturnValue(statfsFixture(0));
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      `42 12 0:41 / ${canonicalMountDir} rw,relatime - fuse.sshfs user@host:/share rw\n`,
    );

    expect(() =>
      configureSqliteWalMaintenance(createMockDb(), {
        checkpointIntervalMs: 0,
        databasePath: path.join(linkedDir, "openclaw.sqlite"),
      }),
    ).toThrow(/SSHFS.*refusing to open/);
  });

  it("matches raw mount paths when the existing path canonicalizes elsewhere", () => {
    if (process.platform === "win32") {
      return;
    }
    const tempDir = tempDirs.make("openclaw-sqlite-sshfs-prefix-");
    const canonicalMountDir = path.join(tempDir, "canonical-mount");
    const rawMountDir = path.join(tempDir, "raw-mount");
    fs.mkdirSync(canonicalMountDir);
    fs.symlinkSync(canonicalMountDir, rawMountDir);
    vi.spyOn(fs, "statfsSync").mockReturnValue(statfsFixture(0));
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      `42 12 0:41 / ${rawMountDir} rw,relatime - fuse.sshfs user@host:/share rw\n`,
    );

    expect(() =>
      configureSqliteWalMaintenance(createMockDb(), {
        checkpointIntervalMs: 0,
        databasePath: path.join(rawMountDir, "openclaw.sqlite"),
      }),
    ).toThrow(/SSHFS.*refusing to open/);
  });

  it("uses mount command filesystem names on platforms without proc mountinfo", () => {
    const tempDir = tempDirs.make("openclaw-sqlite-nfs-");
    const db = createMockDb();
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    vi.spyOn(fs, "statfsSync").mockReturnValue(statfsFixture(0));
    vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      throw new Error("no proc mountinfo");
    });
    const mount = vi
      .spyOn(childProcess, "execFileSync")
      .mockReturnValue(Buffer.from(`server:/share on ${tempDir} (nfs, nodev, nosuid)\n`));

    configureSqliteWalMaintenance(db, {
      checkpointIntervalMs: 0,
      databasePath: path.join(tempDir, "openclaw.sqlite"),
    });

    expect(mount).toHaveBeenCalledWith("mount", [], {
      killSignal: "SIGKILL",
      timeout: 1_000,
    });
    expect(mount).toHaveBeenCalledTimes(1);
    expect(db["prepare"]).toHaveBeenCalledWith("PRAGMA journal_mode = DELETE;");
  });

  it("uses rollback journaling when mount classification times out", () => {
    const tempDir = tempDirs.make("openclaw-sqlite-mount-timeout-");
    const db = createMockDb();
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    vi.spyOn(fs, "statfsSync").mockReturnValue(statfsFixture(0));
    vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      throw new Error("no proc mountinfo");
    });
    vi.spyOn(childProcess, "execFileSync").mockImplementation(() => {
      throw Object.assign(new Error("spawnSync mount ETIMEDOUT"), { code: "ETIMEDOUT" });
    });

    configureSqliteWalMaintenance(db, {
      checkpointIntervalMs: 0,
      databasePath: path.join(tempDir, "openclaw.sqlite"),
    });

    expect(db["prepare"]).toHaveBeenCalledWith("PRAGMA journal_mode = DELETE;");
    expect(db["exec"]).not.toHaveBeenCalled();
  });

  it("preserves WAL policy when mount classification fails without timing out", () => {
    const tempDir = tempDirs.make("openclaw-sqlite-mount-error-");
    const db = createMockDb();
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    vi.spyOn(fs, "statfsSync").mockReturnValue(statfsFixture(0));
    vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      throw new Error("no proc mountinfo");
    });
    vi.spyOn(childProcess, "execFileSync").mockImplementation(() => {
      throw Object.assign(new Error("spawnSync mount ENOENT"), { code: "ENOENT" });
    });

    configureSqliteWalMaintenance(db, {
      checkpointIntervalMs: 0,
      databasePath: path.join(tempDir, "openclaw.sqlite"),
    });

    expect(db["exec"]).toHaveBeenNthCalledWith(1, "PRAGMA journal_mode = WAL;");
    expect(db["prepare"]).toHaveBeenCalledWith("PRAGMA journal_mode;");
  });

  it("uses macOS SMB mount filesystem names", () => {
    const tempDir = tempDirs.make("openclaw-sqlite-smb-");
    const db = createMockDb();
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    vi.spyOn(fs, "statfsSync").mockReturnValue(statfsFixture(0));
    vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      throw new Error("no proc mountinfo");
    });
    vi.spyOn(childProcess, "execFileSync").mockReturnValue(
      Buffer.from(`//server/share on ${tempDir} (smbfs, nodev, nosuid)\n`),
    );

    configureSqliteWalMaintenance(db, {
      checkpointIntervalMs: 0,
      databasePath: path.join(tempDir, "openclaw.sqlite"),
    });

    expect(db["prepare"]).toHaveBeenCalledWith("PRAGMA journal_mode = DELETE;");
  });

  it.each([
    ["macfuse", "sshfs#user@host:/share"],
    ["macfuse", "host:/share"],
    ["macfuse", "user@host:"],
    ["osxfuse", "user@host:/share"],
    ["osxfuse", "sshfs@osxfuse0"],
  ])("refuses SSHFS reported as %s by mount", (fsType, source) => {
    const tempDir = tempDirs.make("openclaw-sqlite-sshfs-macfuse-");
    const db = createMockDb();
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    vi.spyOn(fs, "statfsSync").mockReturnValue(statfsFixture(0));
    vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      throw new Error("no proc mountinfo");
    });
    vi.spyOn(childProcess, "execFileSync").mockReturnValue(
      Buffer.from(`${source} on ${tempDir} (${fsType}, nodev, nosuid)\n`),
    );

    expect(() =>
      configureSqliteWalMaintenance(db, {
        checkpointIntervalMs: 0,
        databasePath: path.join(tempDir, "openclaw.sqlite"),
      }),
    ).toThrow(/refusing to open/);

    expect(db["exec"]).not.toHaveBeenCalled();
  });

  it("keeps WAL enabled for non-remote macFUSE mounts", () => {
    const tempDir = tempDirs.make("openclaw-sqlite-macfuse-");
    const db = createMockDb();
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    vi.spyOn(fs, "statfsSync").mockReturnValue(statfsFixture(0));
    vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      throw new Error("no proc mountinfo");
    });
    vi.spyOn(childProcess, "execFileSync").mockReturnValue(
      Buffer.from(`remote-volume on ${tempDir} (macfuse, nodev, nosuid)\n`),
    );

    configureSqliteWalMaintenance(db, {
      checkpointIntervalMs: 0,
      databasePath: path.join(tempDir, "openclaw.sqlite"),
    });

    expect(db["exec"]).toHaveBeenNthCalledWith(1, "PRAGMA journal_mode = WAL;");
  });

  it("parses Linux mount command filesystem names when proc mountinfo is unavailable", () => {
    const tempDir = tempDirs.make("openclaw-sqlite-nfs-");
    const db = createMockDb();
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    vi.spyOn(fs, "statfsSync").mockReturnValue(statfsFixture(0));
    vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      throw new Error("no proc mountinfo");
    });
    vi.spyOn(childProcess, "execFileSync").mockReturnValue(
      Buffer.from(`server:/share on ${tempDir} type nfs4 (rw,relatime)\n`),
    );

    configureSqliteWalMaintenance(db, {
      checkpointIntervalMs: 0,
      databasePath: path.join(tempDir, "openclaw.sqlite"),
    });

    expect(db["prepare"]).toHaveBeenCalledWith("PRAGMA journal_mode = DELETE;");
  });

  it("runs periodic maintenance outside request contexts and TRUNCATE on close", async () => {
    const requestScope = new AsyncLocalStorage<object>();
    const sessionScope = new AsyncLocalStorage<object>();
    const request = {};
    const session = {};
    const timerContexts: Array<[object | undefined, object | undefined]> = [];
    const periodic = createDeferredCore<[object | undefined, object | undefined]>();
    const hook = createHook({
      init(_asyncId, type) {
        if (type === "Timeout") {
          timerContexts.push([requestScope.getStore(), sessionScope.getStore()]);
        }
      },
    });
    const db = createMockDb();
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    vi.mocked(db["exec"]).mockImplementation((sql) => {
      if (sql === "PRAGMA incremental_vacuum(512);") {
        periodic.resolve([requestScope.getStore(), sessionScope.getStore()]);
      }
    });
    let maintenance: ReturnType<typeof configureSqliteWalMaintenance> | undefined;
    try {
      await requestScope.run(request, () =>
        sessionScope.run(session, async () => {
          hook.enable();
          try {
            maintenance = configureSqliteWalMaintenance(db, { checkpointIntervalMs: 5 });
          } finally {
            hook.disable();
          }
          expect(requestScope.getStore()).toBe(request);
          expect(sessionScope.getStore()).toBe(session);
          // The native resource must be detached at allocation, not only when its callback runs.
          expect(timerContexts).toEqual([[undefined, undefined]]);
          expect(db["exec"]).toHaveBeenCalledTimes(3);

          expect(await periodic.promise).toEqual([undefined, undefined]);
          expect(db["prepare"]).toHaveBeenCalledWith("PRAGMA wal_checkpoint(PASSIVE);");
          expect(db["exec"]).toHaveBeenCalledWith("PRAGMA incremental_vacuum(512);");
          expect(maintenance.close()).toBe(true);
          expect(db["prepare"]).toHaveBeenCalledWith("PRAGMA wal_checkpoint(TRUNCATE);");
          expect(requestScope.getStore()).toBe(request);
          expect(sessionScope.getStore()).toBe(session);
          const statementsAfterClose = vi.mocked(db).exec.mock.calls.length;

          await new Promise<void>((resolve) => {
            setTimeout(resolve, 10);
          });
          expect(db["exec"]).toHaveBeenCalledTimes(statementsAfterClose);
        }),
      );
    } finally {
      hook.disable();
      maintenance?.close();
      requestScope.disable();
      sessionScope.disable();
    }
  });

  it.runIf(process.platform === "linux").each([
    { kind: "unlinked", sidecar: "wal" },
    { kind: "unlinked", sidecar: "shm" },
    { kind: "replaced", sidecar: "wal" },
    { kind: "replaced", sidecar: "shm" },
  ] as const)("hard-stops without closing a $kind -$sidecar handle", ({ kind, sidecar }) => {
    vi.useFakeTimers();
    const tempDir = tempDirs.make("openclaw-sqlite-wal-split-brain-");
    const databasePath = path.join(tempDir, "state.sqlite");
    fs.writeFileSync(databasePath, "fixture");
    const db = createMockDb();
    const close = vi.spyOn(db, "close");
    const maintenance = configureSqliteWalMaintenance(db, {
      checkpointIntervalMs: 100,
      databaseLabel: "split-brain-test",
      databasePath,
    });
    const sidecarPath = `${databasePath}-${sidecar}`;
    vi.spyOn(fs, "readdirSync").mockReturnValue(["42"] as unknown as ReturnType<
      typeof fs.readdirSync
    >);
    vi.spyOn(fs, "readlinkSync").mockReturnValue(
      kind === "unlinked" ? `${sidecarPath} (deleted)` : sidecarPath,
    );
    vi.spyOn(fs, "fstatSync").mockReturnValue({
      dev: 10n,
      ino: 20n,
      nlink: kind === "unlinked" ? 0n : 1n,
    } as fs.BigIntStats);
    vi.spyOn(fs, "statSync").mockImplementation((pathname) => {
      if (pathname !== sidecarPath) {
        throw new Error(`unexpected stat: ${String(pathname)}`);
      }
      if (kind === "unlinked") {
        const error = new Error("missing sidecar") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
      return { dev: 10n, ino: 21n } as fs.BigIntStats;
    });
    const write = vi.spyOn(fs, "writeSync").mockReturnValue(1);
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    const abort = vi.spyOn(process, "abort").mockImplementation(() => {
      throw new Error("process abort intercepted");
    });

    expect(() => vi.advanceTimersByTime(100)).toThrow("process abort intercepted");

    expect(kill).toHaveBeenCalledWith(process.pid, "SIGKILL");
    expect(abort).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
    expect(maintenance.checkpoint()).toBe(false);
    expect(write).toHaveBeenCalledWith(
      process.stderr.fd,
      expect.stringContaining(`"sidecarPath":"${sidecarPath}"`),
    );
  });

  it.runIf(process.platform === "linux")(
    "preserves the replacement WAL family across fatal containment and reopen",
    async () => {
      const tempDir = tempDirs.make("openclaw-sqlite-wal-replacement-");
      const databasePath = path.join(tempDir, "state.sqlite");
      const staleCloseMarker = path.join(tempDir, "stale-close-marker");
      const childScript = path.join(tempDir, "split-brain-child.mts");
      const sqliteWalModuleUrl = pathToFileURL(path.resolve("src/infra/sqlite-wal.ts")).href;
      const { DatabaseSync } = requireNodeSqlite();
      const seed = new DatabaseSync(databasePath);
      seed.exec(
        "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE events (value TEXT PRIMARY KEY);",
      );
      seed.prepare("INSERT INTO events VALUES (?)").run("base");
      seed.exec("PRAGMA wal_checkpoint(TRUNCATE);");
      seed.close();
      fs.writeFileSync(
        childScript,
        `
          import fs from "node:fs";
          import { DatabaseSync } from "node:sqlite";
          import { configureSqliteWalMaintenance } from ${JSON.stringify(sqliteWalModuleUrl)};

          const role = process.argv[2];
          const databasePath = process.argv[3];
          const staleCloseMarker = process.argv[4];
          if (role === "stale") {
            const stale = new DatabaseSync(databasePath);
            setTimeout(() => {
              fs.writeFileSync(staleCloseMarker, stale.isOpen ? "open" : "closed");
              process.kill(process.pid, "SIGKILL");
            }, 5_000);
            configureSqliteWalMaintenance(stale, {
              autoCheckpointPages: 0,
              checkpointIntervalMs: 2_500,
              databaseLabel: "replacement-family-test",
              databasePath,
            });
            stale.prepare("INSERT INTO events VALUES (?)").run("stale");
            process.stdout.write("stale-ready\\n");
          } else {
            const current = new DatabaseSync(databasePath);
            current.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
            current.prepare("INSERT INTO events VALUES (?)").run("current");
            process.stdout.write("current-ready\\n");
          }
          setInterval(() => {}, 1_000);
        `,
      );

      const spawnRole = (role: "current" | "stale", readyLine: string) => {
        let stdout = "";
        let stderr = "";
        const child = spawn(
          process.execPath,
          ["--import", "tsx", childScript, role, databasePath, staleCloseMarker],
          {
            env: { ...process.env, OPENCLAW_TEST_CONSOLE: "1" },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        const ready = new Promise<void>((resolve, reject) => {
          child.stdout.on("data", (chunk) => {
            stdout += chunk;
            if (stdout.includes(readyLine)) {
              resolve();
            }
          });
          child.once("error", reject);
          child.once("close", (code, signal) => {
            if (!stdout.includes(readyLine)) {
              reject(new Error(`${role} exited before ready (${code}/${signal}): ${stderr}`));
            }
          });
        });
        child.stderr.on("data", (chunk) => (stderr += chunk));
        const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
          (resolve) => {
            child.once("close", (code, signal) => resolve({ code, signal }));
          },
        );
        return { child, closed, ready, stderr: () => stderr };
      };

      const stale = spawnRole("stale", "stale-ready");
      let current: ReturnType<typeof spawnRole> | undefined;
      try {
        await stale.ready;
        fs.unlinkSync(`${databasePath}-wal`);
        fs.unlinkSync(`${databasePath}-shm`);
        current = spawnRole("current", "current-ready");
        await current.ready;

        const timeout = setTimeout(() => stale.child.kill("SIGKILL"), 20_000);
        const childResult = await stale.closed;
        clearTimeout(timeout);

        expect(childResult, stale.stderr()).toEqual({ code: null, signal: "SIGKILL" });
        expect(stale.stderr()).toContain("SQLite WAL sidecar identity mismatch");
        expect(fs.existsSync(staleCloseMarker)).toBe(false);

        current.child.kill("SIGKILL");
        await current.closed;
      } finally {
        if (stale.child.exitCode === null && stale.child.signalCode === null) {
          stale.child.kill("SIGKILL");
        }
        if (current && current.child.exitCode === null && current.child.signalCode === null) {
          current.child.kill("SIGKILL");
          await current.closed;
        }
      }

      const reopened = new DatabaseSync(databasePath);
      try {
        expect(reopened.prepare("PRAGMA integrity_check;").get()).toEqual({
          integrity_check: "ok",
        });
        expect(reopened.prepare("SELECT value FROM events ORDER BY value").all()).toEqual([
          { value: "base" },
          { value: "current" },
        ]);
      } finally {
        reopened.close();
      }
    },
    30_000,
  );

  it.runIf(process.platform === "linux").each(["EACCES", "EPERM"] as const)(
    "disables split-brain detection after a %s scan error",
    (code) => {
      vi.useFakeTimers();
      const tempDir = tempDirs.make("openclaw-sqlite-wal-tripwire-error-");
      const databasePath = path.join(tempDir, "state.sqlite");
      const { DatabaseSync } = requireNodeSqlite();
      const writer = new DatabaseSync(databasePath);
      const maintenance = configureSqliteWalMaintenance(writer, {
        checkpointIntervalMs: 100,
        databasePath,
      });
      const prepare = vi.spyOn(writer, "prepare");
      const readdir = vi.spyOn(fs, "readdirSync").mockImplementationOnce(() => {
        const error = new Error("restricted procfs");
        (error as NodeJS.ErrnoException).code = code;
        throw error;
      });
      try {
        writer.exec("CREATE TABLE events (value TEXT NOT NULL);");

        expect(() => vi.advanceTimersByTime(100)).not.toThrow();
        expect(readdir).toHaveBeenCalledTimes(1);
        expect(() =>
          writer.prepare("INSERT INTO events VALUES (?)").run("still-open"),
        ).not.toThrow();

        fs.unlinkSync(`${databasePath}-wal`);
        fs.unlinkSync(`${databasePath}-shm`);
        expect(() => vi.advanceTimersByTime(100)).not.toThrow();

        expect(readdir).toHaveBeenCalledTimes(1);
        expect(
          prepare.mock.calls.filter(([sql]) => sql === "PRAGMA wal_checkpoint(PASSIVE);"),
        ).toHaveLength(2);
        expect(writer.isOpen).toBe(true);
      } finally {
        maintenance.close();
        if (writer.isOpen) {
          writer.close();
        }
      }
    },
  );

  it("clamps oversized checkpoint intervals before arming timers", () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const db = createMockDb();
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");

    const maintenance = configureSqliteWalMaintenance(db, {
      checkpointIntervalMs: Number.MAX_SAFE_INTEGER,
    });

    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
    maintenance.close();
  });

  it("honors explicit checkpoint mode overrides for periodic and close checkpoints", () => {
    vi.useFakeTimers();
    const db = createMockDb();
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");

    const maintenance = configureSqliteWalMaintenance(db, {
      checkpointIntervalMs: 100,
      checkpointMode: "FULL",
    });

    vi.advanceTimersByTime(100);
    expect(db["prepare"]).toHaveBeenCalledWith("PRAGMA wal_checkpoint(FULL);");
    expect(db["exec"]).toHaveBeenCalledWith("PRAGMA incremental_vacuum(512);");

    expect(maintenance.close({ checkpointMode: "PASSIVE" })).toBe(true);
    expect(db["prepare"]).toHaveBeenLastCalledWith("PRAGMA wal_checkpoint(PASSIVE);");
  });

  it("reports a busy checkpoint result as incomplete", () => {
    const db = createMockDb();
    const onCheckpointError = vi.fn();
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    vi.mocked(db["prepare"]).mockImplementation(
      (sql) =>
        ({
          get: vi.fn(() =>
            sql.includes("wal_checkpoint")
              ? { busy: 1, log: 4, checkpointed: 3 }
              : { journal_mode: sql === "PRAGMA journal_mode;" ? "wal" : "delete" },
          ),
        }) as unknown as ReturnType<DatabaseSync["prepare"]>,
    );

    const maintenance = configureSqliteWalMaintenance(db, {
      checkpointIntervalMs: 0,
      databaseLabel: "test-db",
      onCheckpointError,
    });

    expect(maintenance.checkpoint()).toBe(false);
    expect(onCheckpointError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "test-db WAL checkpoint TRUNCATE remained busy" }),
    );
  });

  it("detects a checkpoint blocked by another connection's reader", () => {
    const tempDir = tempDirs.make("openclaw-sqlite-checkpoint-busy-");
    const databasePath = path.join(tempDir, "state.sqlite");
    const { DatabaseSync } = requireNodeSqlite();
    const writer = new DatabaseSync(databasePath);
    let reader: InstanceType<typeof DatabaseSync> | undefined;
    let maintenance: ReturnType<typeof configureSqliteWalMaintenance> | undefined;
    try {
      writer.exec(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE events (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO events (value) VALUES ('before-reader');
        PRAGMA wal_checkpoint(TRUNCATE);
      `);
      reader = new DatabaseSync(databasePath);
      reader.exec("BEGIN;");
      reader.prepare("SELECT COUNT(*) FROM events").get();
      writer.prepare("INSERT INTO events (value) VALUES (?)").run("after-reader");

      maintenance = configureSqliteWalMaintenance(writer, { checkpointIntervalMs: 0 });

      expect(maintenance.checkpoint()).toBe(false);
      reader.exec("ROLLBACK;");
      expect(maintenance.checkpoint()).toBe(true);
    } finally {
      if (reader?.isOpen) {
        try {
          reader.exec("ROLLBACK;");
        } catch {}
        reader.close();
      }
      maintenance?.close();
      writer.close();
    }
  });

  it("reports checkpoint errors without throwing from background maintenance", () => {
    const db = createMockDb();
    const error = new Error("busy");
    const onCheckpointError = vi.fn();
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    vi.mocked(db["prepare"]).mockImplementation((sql) => {
      if (sql.includes("wal_checkpoint")) {
        throw error;
      }
      return {
        get: vi.fn(() => ({ journal_mode: sql === "PRAGMA journal_mode;" ? "wal" : "delete" })),
      } as unknown as ReturnType<DatabaseSync["prepare"]>;
    });

    const maintenance = configureSqliteWalMaintenance(db, {
      checkpointIntervalMs: 0,
      onCheckpointError,
    });

    expect(maintenance.checkpoint()).toBe(false);
    expect(onCheckpointError).toHaveBeenCalledWith(error);
  });

  it("retries the WAL transition when SQLite bypasses the busy handler", () => {
    const db = createMockDb();
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    let journalModeAttempts = 0;
    vi.mocked(db["exec"]).mockImplementation((sql) => {
      if (sql === "PRAGMA journal_mode = WAL;" && journalModeAttempts++ === 0) {
        throw Object.assign(new Error("database is locked"), {
          code: "ERR_SQLITE_ERROR",
          errcode: 5,
        });
      }
    });

    configureSqliteConnectionPragmas(db, {
      busyTimeoutMs: 50,
      checkpointIntervalMs: 0,
    });

    expect(journalModeAttempts).toBe(2);
    expect(
      vi.mocked(db["exec"]).mock.calls.filter(([sql]) => sql.startsWith("PRAGMA busy_timeout")),
    ).toEqual([
      ["PRAGMA busy_timeout = 50;"],
      ["PRAGMA busy_timeout = 0;"],
      ["PRAGMA busy_timeout = 50;"],
    ]);
  });

  it("rejects a WAL transition that SQLite silently declines", () => {
    const db = createMockDb();
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    vi.mocked(db["prepare"]).mockImplementation(
      (sql) =>
        ({
          get: vi.fn(() => ({ journal_mode: sql === "PRAGMA journal_mode;" ? "delete" : "wal" })),
        }) as unknown as ReturnType<DatabaseSync["prepare"]>,
    );

    expect(() =>
      configureSqliteConnectionPragmas(db, {
        busyTimeoutMs: 50,
        checkpointIntervalMs: 0,
        databaseLabel: "test-db",
      }),
    ).toThrow("test-db could not enable WAL; SQLite kept journal_mode=delete");
    expect(db["prepare"]).toHaveBeenCalledWith("PRAGMA journal_mode;");
  });

  it("configures lock retry before inspecting a fresh database header", () => {
    const db = createMockDb();
    vi.mocked(db["prepare"]).mockImplementation(
      (sql: string) =>
        ({
          get: vi.fn(() => (sql === "PRAGMA page_count" ? { page_count: 0 } : undefined)),
        }) as unknown as ReturnType<DatabaseSync["prepare"]>,
    );

    configureSqlitePreSchemaPragmas(db, { busyTimeoutMs: 5000 });

    expect(db["exec"]).toHaveBeenNthCalledWith(1, "PRAGMA busy_timeout = 5000;");
    expect(db["prepare"]).toHaveBeenCalledWith("PRAGMA page_count");
    expect(db["exec"]).toHaveBeenNthCalledWith(2, "PRAGMA auto_vacuum = INCREMENTAL;");
    expect(vi.mocked(db["exec"]).mock.invocationCallOrder[0]).toBeLessThan(
      expectDefined(
        vi.mocked(db["prepare"]).mock.invocationCallOrder[0],
        'vi.mocked(db["prepare"]).mock.invocationCallOrder[0] test invariant',
      ),
    );
  });

  it("sets busy timeout before rollback journaling on NFS-backed volumes", () => {
    const tempDir = tempDirs.make("openclaw-sqlite-nfs-");
    const db = createMockDb();
    vi.spyOn(fs, "statfsSync").mockReturnValue(statfsFixture(0x6969));

    configureSqliteConnectionPragmas(db, {
      busyTimeoutMs: 5000,
      checkpointIntervalMs: 0,
      databasePath: path.join(tempDir, "openclaw.sqlite"),
      synchronous: "NORMAL",
    });

    expect(db["exec"]).toHaveBeenNthCalledWith(1, "PRAGMA busy_timeout = 5000;");
    expect(db["prepare"]).toHaveBeenCalledWith("PRAGMA journal_mode = DELETE;");
    expect(db["exec"]).toHaveBeenNthCalledWith(2, "PRAGMA synchronous = NORMAL;");
  });
});
