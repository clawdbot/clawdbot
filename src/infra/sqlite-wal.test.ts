// Covers SQLite WAL maintenance configuration.
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import {
  configureSqliteConnectionPragmas,
  configureSqlitePreSchemaPragmas,
  configureSqliteWalMaintenance,
} from "./sqlite-wal.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createMockDb(): DatabaseSync {
  return {
    exec: vi.fn(),
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
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sqlite-nfs-"));
    try {
      const db = createMockDb();
      vi.spyOn(process, "platform", "get").mockReturnValue("linux");
      const statfs = vi.spyOn(fs, "statfsSync").mockReturnValue(statfsFixture(0x6969));

      const maintenance = configureSqliteWalMaintenance(db, {
        checkpointIntervalMs: 0,
        databasePath: path.join(tempDir, "missing", "openclaw.sqlite"),
      });

      expect(statfs).toHaveBeenCalledWith(fs.realpathSync(tempDir));
      expect(db["prepare"]).toHaveBeenCalledWith("PRAGMA journal_mode = DELETE;");
      expect(db["exec"]).toHaveBeenCalledExactlyOnceWith("PRAGMA mmap_size = 0;");
      expect(maintenance.checkpoint()).toBe(true);
      expect(maintenance.close()).toBe(true);
      expect(db["exec"]).toHaveBeenCalledExactlyOnceWith("PRAGMA mmap_size = 0;");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it.each([
    ["SMB", 0x517b],
    ["CIFS", 0xff534d42],
    ["SMB2", 0xfe534d42],
  ])("uses rollback journaling for databases on Linux %s volumes", (_label, fsType) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sqlite-network-"));
    try {
      const db = createMockDb();
      vi.spyOn(process, "platform", "get").mockReturnValue("linux");
      vi.spyOn(fs, "statfsSync").mockReturnValue(statfsFixture(fsType));

      configureSqliteWalMaintenance(db, {
        checkpointIntervalMs: 0,
        databasePath: path.join(tempDir, "openclaw.sqlite"),
      });

      expect(db["prepare"]).toHaveBeenCalledWith("PRAGMA journal_mode = DELETE;");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
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
    expect(db["exec"]).toHaveBeenCalledExactlyOnceWith("PRAGMA mmap_size = 0;");
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
    expect(db["exec"]).toHaveBeenCalledExactlyOnceWith("PRAGMA mmap_size = 0;");
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
    expect(db["exec"]).toHaveBeenCalledExactlyOnceWith("PRAGMA mmap_size = 0;");
  });

  it("refuses network-backed databases when SQLite keeps WAL active", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sqlite-nfs-"));
    try {
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
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
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

  it("uses mountinfo filesystem names when statfs magic is not enough", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sqlite-nfs-"));
    try {
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
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("refuses fuse.sshfs mountinfo entries", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sqlite-sshfs-"));
    try {
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
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("refuses symlinked paths into fuse.sshfs mounts", () => {
    if (process.platform === "win32") {
      return;
    }
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sqlite-sshfs-link-"));
    const mountDir = path.join(tempDir, "mount");
    const linkedDir = path.join(tempDir, "linked");
    try {
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
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("matches raw mount paths when the existing path canonicalizes elsewhere", () => {
    if (process.platform === "win32") {
      return;
    }
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sqlite-sshfs-prefix-"));
    const canonicalMountDir = path.join(tempDir, "canonical-mount");
    const rawMountDir = path.join(tempDir, "raw-mount");
    try {
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
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("never memory-maps a symlinked local mount whose canonical target is unrecognized", () => {
    // The lexical path can sit on an allowlisted local mount while its
    // realpath target lands on a different, unrecognized mount (e.g. a
    // symlink into a 9p share) - both representations describe the same
    // underlying file, so a positive match on the lexical alias must not
    // outvote the canonical target's unverified result.
    if (process.platform === "win32") {
      return;
    }
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sqlite-alias-"));
    const localMountDir = path.join(tempDir, "local-mount");
    const remoteTargetDir = path.join(tempDir, "remote-target");
    try {
      fs.mkdirSync(remoteTargetDir);
      fs.symlinkSync(remoteTargetDir, localMountDir);
      vi.spyOn(process, "platform", "get").mockReturnValue("linux");
      vi.spyOn(fs, "statfsSync").mockReturnValue(statfsFixture(0));
      vi.spyOn(fs, "readFileSync").mockReturnValue(
        `42 12 0:41 / ${localMountDir} rw,relatime - ext4 /dev/sda1 rw\n` +
          `43 12 0:42 / ${remoteTargetDir} rw,relatime - 9p host rw\n`,
      );
      const db = createMockDb();

      configureSqliteWalMaintenance(db, {
        checkpointIntervalMs: 0,
        databasePath: path.join(localMountDir, "openclaw.sqlite"),
      });

      expect(db["exec"]).toHaveBeenNthCalledWith(1, "PRAGMA journal_mode = WAL;");
      const sql = vi.mocked(db["exec"]).mock.calls.map(([statement]) => statement);
      expect(sql).toContain("PRAGMA mmap_size = 0;");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("uses mount command filesystem names on platforms without proc mountinfo", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sqlite-nfs-"));
    try {
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
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
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
    expect(db["exec"]).toHaveBeenCalledExactlyOnceWith("PRAGMA mmap_size = 0;");
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
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sqlite-smb-"));
    try {
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
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it.each([
    ["macfuse", "sshfs#user@host:/share"],
    ["macfuse", "host:/share"],
    ["macfuse", "user@host:"],
    ["osxfuse", "user@host:/share"],
    ["osxfuse", "sshfs@osxfuse0"],
  ])("refuses SSHFS reported as %s by mount", (fsType, source) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sqlite-sshfs-macfuse-"));
    try {
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
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps WAL enabled but never memory-maps non-remote macFUSE mounts", () => {
    // A non-SSHFS MacFUSE/OSXFUSE report is not the network-coordination
    // hazard SSHFS is, so WAL stays enabled. But it is still a FUSE
    // passthrough that can front an arbitrary, possibly network-backed,
    // filesystem, so it must never be treated as verified-local for mmap.
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sqlite-macfuse-"));
    try {
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
      const sql = vi.mocked(db["exec"]).mock.calls.map(([statement]) => statement);
      expect(sql).toContain("PRAGMA mmap_size = 0;");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps WAL enabled but never memory-maps generic FUSE mounts", () => {
    // A non-SSHFS fuse.* mount (e.g. fuse.rclone) is not specifically named
    // like macFUSE/OSXFUSE, but it is the same passthrough hazard: it can
    // front an arbitrary, possibly network-backed filesystem, so it must
    // never be treated as verified-local for mmap.
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sqlite-fuse-generic-"));
    try {
      const db = createMockDb();
      vi.spyOn(process, "platform", "get").mockReturnValue("linux");
      vi.spyOn(fs, "statfsSync").mockReturnValue(statfsFixture(0));
      vi.spyOn(fs, "readFileSync").mockReturnValue(
        `42 12 0:41 / ${tempDir} rw,relatime - fuse.rclone rclone:remote rw\n`,
      );

      configureSqliteWalMaintenance(db, {
        checkpointIntervalMs: 0,
        databasePath: path.join(tempDir, "openclaw.sqlite"),
      });

      expect(db["exec"]).toHaveBeenNthCalledWith(1, "PRAGMA journal_mode = WAL;");
      const sql = vi.mocked(db["exec"]).mock.calls.map(([statement]) => statement);
      expect(sql).toContain("PRAGMA mmap_size = 0;");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps WAL enabled but never memory-maps an unrecognized mount type", () => {
    // A matched mount type that is not on the network/FUSE blocklist is not
    // proof of mmap safety - it may be a remote or virtual filesystem this
    // classifier does not recognize (9p backs VM host-shared folders, e.g.
    // WSL2/Lima virtiofs, which can point at a remote host path). Only a
    // positive match against the local-disk allowlist is mmap-eligible.
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sqlite-unrecognized-"));
    try {
      const db = createMockDb();
      vi.spyOn(process, "platform", "get").mockReturnValue("linux");
      vi.spyOn(fs, "statfsSync").mockReturnValue(statfsFixture(0));
      vi.spyOn(fs, "readFileSync").mockReturnValue(
        `42 12 0:41 / ${tempDir} rw,relatime - 9p host rw\n`,
      );

      configureSqliteWalMaintenance(db, {
        checkpointIntervalMs: 0,
        databasePath: path.join(tempDir, "openclaw.sqlite"),
      });

      expect(db["exec"]).toHaveBeenNthCalledWith(1, "PRAGMA journal_mode = WAL;");
      const sql = vi.mocked(db["exec"]).mock.calls.map(([statement]) => statement);
      expect(sql).toContain("PRAGMA mmap_size = 0;");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("parses Linux mount command filesystem names when proc mountinfo is unavailable", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sqlite-nfs-"));
    try {
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
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("runs lightweight periodic PASSIVE checkpoints and TRUNCATE on close", () => {
    vi.useFakeTimers();
    const db = createMockDb();
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");

    const maintenance = configureSqliteWalMaintenance(db, { checkpointIntervalMs: 100 });
    // journal_mode=WAL, wal_autocheckpoint, journal_size_limit, mmap_size = 0.
    // No databasePath is supplied, so the filesystem was never verified and
    // mmap_size is explicitly disabled rather than left at the build default.
    expect(db["exec"]).toHaveBeenCalledTimes(4);

    vi.advanceTimersByTime(100);
    expect(db["prepare"]).toHaveBeenCalledWith("PRAGMA wal_checkpoint(PASSIVE);");
    expect(db["exec"]).toHaveBeenNthCalledWith(5, "PRAGMA incremental_vacuum(512);");
    expect(db["exec"]).toHaveBeenCalledTimes(5);

    expect(maintenance.close()).toBe(true);
    expect(db["prepare"]).toHaveBeenCalledWith("PRAGMA wal_checkpoint(TRUNCATE);");
    expect(db["exec"]).toHaveBeenCalledTimes(5);

    vi.advanceTimersByTime(200);
    expect(db["exec"]).toHaveBeenCalledTimes(5);
  });

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
    expect(db["exec"]).toHaveBeenNthCalledWith(5, "PRAGMA incremental_vacuum(512);");

    expect(maintenance.close()).toBe(true);
    expect(db["prepare"]).toHaveBeenLastCalledWith("PRAGMA wal_checkpoint(FULL);");
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
      fs.rmSync(tempDir, { recursive: true, force: true });
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
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sqlite-nfs-"));
    try {
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
      expect(db["exec"]).toHaveBeenNthCalledWith(2, "PRAGMA mmap_size = 0;");
      expect(db["exec"]).toHaveBeenNthCalledWith(3, "PRAGMA synchronous = NORMAL;");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("enables memory-mapped reads on the local-filesystem WAL path", () => {
    const tempDir = tempDirs.make("openclaw-sqlite-mmap-local-");
    const db = createMockDb();
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");

    configureSqliteWalMaintenance(db, {
      checkpointIntervalMs: 0,
      databasePath: path.join(tempDir, "openclaw.sqlite"),
    });

    const sql = vi.mocked(db["exec"]).mock.calls.map(([statement]) => statement);
    expect(sql).toContain("PRAGMA mmap_size = 67108864;");
    // Strictly after the journal-mode sequence: reordering that is what the
    // surrounding lock-retry logic exists to prevent.
    expect(sql.indexOf("PRAGMA mmap_size = 67108864;")).toBeGreaterThan(
      sql.indexOf("PRAGMA journal_mode = WAL;"),
    );
  });

  it("enables memory-mapped reads on a local ZFS mount", () => {
    // Confirmed in production (openclaw/openclaw#115138): on Linux, OpenZFS
    // reads bypass the kernel page cache but mmap reads populate it, so ZFS
    // is a case where this pragma matters even though zfs was already on
    // LOCAL_DISK_FILESYSTEM_TYPES without dedicated coverage.
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sqlite-zfs-"));
    try {
      const db = createMockDb();
      vi.spyOn(process, "platform", "get").mockReturnValue("linux");
      vi.spyOn(fs, "statfsSync").mockReturnValue(statfsFixture(0));
      vi.spyOn(fs, "readFileSync").mockReturnValue(
        `42 12 0:41 / ${tempDir} rw,relatime - zfs tank/openclaw rw\n`,
      );

      configureSqliteWalMaintenance(db, {
        checkpointIntervalMs: 0,
        databasePath: path.join(tempDir, "openclaw.sqlite"),
      });

      const sql = vi.mocked(db["exec"]).mock.calls.map(([statement]) => statement);
      expect(sql).toContain("PRAGMA mmap_size = 67108864;");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("never memory-maps a verified local Windows drive", () => {
    // SQLite cannot truncate a memory-mapped database file on Windows, which
    // conflicts with the incremental auto_vacuum/incremental_vacuum
    // maintenance this helper runs. A verified local drive still reaches the
    // WAL branch (see "does not treat namespaced Windows local drives as UNC
    // paths" above), but must not reach the mmap pragma.
    const db = createMockDb();
    const databasePath = String.raw`\\?\C:\state\openclaw.sqlite`;
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.spyOn(fs.realpathSync, "native").mockReturnValue(databasePath);

    configureSqliteWalMaintenance(db, {
      checkpointIntervalMs: 0,
      databasePath,
    });

    const sql = vi.mocked(db["exec"]).mock.calls.map(([statement]) => statement);
    expect(sql).toContain("PRAGMA journal_mode = WAL;");
    expect(sql).toContain("PRAGMA mmap_size = 0;");
  });

  it("never memory-maps a database when no path was supplied to verify the filesystem", () => {
    // A caller that omits databasePath never had its filesystem checked against
    // the NFS/SMB/CIFS/SMB2 rollback boundary above. Treating that as "local" for
    // mmap would let an unverified network-backed connection reach the pragma
    // that produced the #60349 SIGBUS crashes.
    const db = createMockDb();
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");

    configureSqliteWalMaintenance(db, { checkpointIntervalMs: 0 });

    const sql = vi.mocked(db["exec"]).mock.calls.map(([statement]) => statement);
    expect(sql).toContain("PRAGMA mmap_size = 0;");
  });

  it("explicitly disables mmap on an ineligible path rather than omitting the pragma", () => {
    // Omitting the pragma is not equivalent to disabling mmap: SQLite's
    // default mmap_size is a build-time constant (SQLITE_DEFAULT_MMAP_SIZE)
    // and some builds compile it nonzero. Skipping the pragma would leave
    // that build default in effect instead of fail-closing to 0.
    const db = createMockDb();
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");

    configureSqliteWalMaintenance(db, { checkpointIntervalMs: 0 });

    expect(db["exec"]).toHaveBeenCalledWith("PRAGMA mmap_size = 0;");
  });

  it("never memory-maps a supplied path whose filesystem cannot be classified", () => {
    // A supplied databasePath that resolvePathJournalPolicy could not match to
    // any mount entry still uses WAL (compatibility default), but that is not
    // proof of a local filesystem - the mount table simply had no entry to
    // check against. Treating "no match" as "local" would enable mmap on a
    // filesystem that was never actually verified.
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sqlite-mmap-unclassified-"));
    try {
      const db = createMockDb();
      vi.spyOn(process, "platform", "get").mockReturnValue("linux");
      vi.spyOn(fs, "statfsSync").mockImplementation(() => {
        throw new Error("statfs unavailable");
      });
      vi.spyOn(fs, "readFileSync").mockImplementation(() => {
        throw new Error("no proc mountinfo");
      });
      vi.spyOn(childProcess, "execFileSync").mockReturnValue(Buffer.from(""));

      configureSqliteWalMaintenance(db, {
        checkpointIntervalMs: 0,
        databasePath: path.join(tempDir, "openclaw.sqlite"),
      });

      expect(db["exec"]).toHaveBeenNthCalledWith(1, "PRAGMA journal_mode = WAL;");
      const sql = vi.mocked(db["exec"]).mock.calls.map(([statement]) => statement);
      expect(sql).toContain("PRAGMA mmap_size = 0;");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it.each([
    ["NFS", 0x6969],
    ["SMB", 0x517b],
    ["CIFS", 0xff534d42],
    ["SMB2", 0xfe534d42],
  ])("never memory-maps a database on a %s volume", (_label, fsType) => {
    // mmap over a network filesystem is what produced the SIGBUS crashes in
    // #60349: an I/O error on a mapped page raises a signal SQLite cannot
    // catch. These volumes take the rollback branch and must explicitly zero
    // the pragma rather than merely omit it, since some SQLite builds compile
    // a nonzero SQLITE_DEFAULT_MMAP_SIZE.
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sqlite-mmap-net-"));
    try {
      const db = createMockDb();
      vi.spyOn(process, "platform", "get").mockReturnValue("linux");
      vi.spyOn(fs, "statfsSync").mockReturnValue(statfsFixture(fsType));

      configureSqliteConnectionPragmas(db, {
        busyTimeoutMs: 5000,
        checkpointIntervalMs: 0,
        databasePath: path.join(tempDir, "openclaw.sqlite"),
        synchronous: "NORMAL",
      });

      expect(db["exec"]).toHaveBeenCalledWith("PRAGMA mmap_size = 0;");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
