// Covers SQLite WAL maintenance configuration.
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_TIMER_TIMEOUT_MS } from "../shared/number-coercion.js";
import {
  DEFAULT_SQLITE_WAL_AUTOCHECKPOINT_PAGES,
  configureSqliteConnectionPragmas,
  configureSqliteWalMaintenance,
} from "./sqlite-wal.js";

function createMockDb(): DatabaseSync {
  return {
    exec: vi.fn(),
    prepare: vi.fn(() => ({
      get: vi.fn(() => ({ journal_mode: "delete" })),
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

  it("enables WAL mode and explicit autocheckpointing", () => {
    const db = createMockDb();
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");

    configureSqliteWalMaintenance(db, { checkpointIntervalMs: 0 });

    expect(db["exec"]).toHaveBeenNthCalledWith(1, "PRAGMA journal_mode = WAL;");
    expect(db["exec"]).toHaveBeenNthCalledWith(
      2,
      `PRAGMA wal_autocheckpoint = ${DEFAULT_SQLITE_WAL_AUTOCHECKPOINT_PAGES};`,
    );
  });

  it("enables fullfsync barriers for WAL checkpoints on macOS", () => {
    const db = createMockDb();
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");

    configureSqliteWalMaintenance(db, { checkpointIntervalMs: 0 });

    expect(db["exec"]).toHaveBeenNthCalledWith(1, "PRAGMA journal_mode = WAL;");
    expect(db["exec"]).toHaveBeenNthCalledWith(2, "PRAGMA checkpoint_fullfsync = 1;");
    expect(db["exec"]).toHaveBeenNthCalledWith(
      3,
      `PRAGMA wal_autocheckpoint = ${DEFAULT_SQLITE_WAL_AUTOCHECKPOINT_PAGES};`,
    );
  });

  it("continues WAL setup if macOS checkpoint fullfsync is unavailable", () => {
    const db = createMockDb();
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    vi.mocked(db["exec"]).mockImplementation((sql) => {
      if (sql.includes("checkpoint_fullfsync")) {
        throw new Error("unsupported pragma");
      }
    });

    configureSqliteWalMaintenance(db, { checkpointIntervalMs: 0 });

    expect(db["exec"]).toHaveBeenNthCalledWith(1, "PRAGMA journal_mode = WAL;");
    expect(db["exec"]).toHaveBeenNthCalledWith(2, "PRAGMA checkpoint_fullfsync = 1;");
    expect(db["exec"]).toHaveBeenNthCalledWith(
      3,
      `PRAGMA wal_autocheckpoint = ${DEFAULT_SQLITE_WAL_AUTOCHECKPOINT_PAGES};`,
    );
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
      expect(db["exec"]).not.toHaveBeenCalled();
      expect(maintenance.checkpoint()).toBe(true);
      expect(maintenance.close()).toBe(true);
      expect(db["exec"]).not.toHaveBeenCalled();
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
    expect(db["prepare"]).not.toHaveBeenCalled();
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

  it("uses mount command filesystem names on platforms without proc mountinfo", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sqlite-nfs-"));
    try {
      const db = createMockDb();
      vi.spyOn(process, "platform", "get").mockReturnValue("linux");
      vi.spyOn(fs, "statfsSync").mockReturnValue(statfsFixture(0));
      vi.spyOn(fs, "readFileSync").mockImplementation(() => {
        throw new Error("no proc mountinfo");
      });
      vi.spyOn(childProcess, "execFileSync").mockReturnValue(
        Buffer.from(`server:/share on ${tempDir} (nfs, nodev, nosuid)\n`),
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

  it("keeps WAL enabled for non-remote macFUSE mounts", () => {
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
    expect(db["exec"]).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(100);
    expect(db["exec"]).toHaveBeenNthCalledWith(3, "PRAGMA wal_checkpoint(PASSIVE);");
    expect(db["exec"]).toHaveBeenNthCalledWith(4, "PRAGMA incremental_vacuum(512);");
    expect(db["exec"]).toHaveBeenCalledTimes(4);

    expect(maintenance.close()).toBe(true);
    expect(db["exec"]).toHaveBeenLastCalledWith("PRAGMA wal_checkpoint(TRUNCATE);");
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
    expect(db["exec"]).toHaveBeenNthCalledWith(3, "PRAGMA wal_checkpoint(FULL);");
    expect(db["exec"]).toHaveBeenNthCalledWith(4, "PRAGMA incremental_vacuum(512);");

    expect(maintenance.close()).toBe(true);
    expect(db["exec"]).toHaveBeenLastCalledWith("PRAGMA wal_checkpoint(FULL);");
  });

  it("reports checkpoint errors without throwing from background maintenance", () => {
    const db = createMockDb();
    const error = new Error("busy");
    const onCheckpointError = vi.fn();
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    vi.mocked(db["exec"]).mockImplementation((sql) => {
      if (sql.includes("wal_checkpoint")) {
        throw error;
      }
    });

    const maintenance = configureSqliteWalMaintenance(db, {
      checkpointIntervalMs: 0,
      onCheckpointError,
    });

    expect(maintenance.checkpoint()).toBe(false);
    expect(onCheckpointError).toHaveBeenCalledWith(error);
  });

  it("configures connection pragmas before WAL maintenance", () => {
    const db = createMockDb();
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");

    configureSqliteConnectionPragmas(db, {
      busyTimeoutMs: 30_000,
      checkpointIntervalMs: 0,
      foreignKeys: true,
      synchronous: "NORMAL",
    });

    expect(db["exec"]).toHaveBeenNthCalledWith(1, "PRAGMA busy_timeout = 30000;");
    expect(db["exec"]).toHaveBeenNthCalledWith(2, "PRAGMA journal_mode = WAL;");
    expect(db["exec"]).toHaveBeenNthCalledWith(
      3,
      `PRAGMA wal_autocheckpoint = ${DEFAULT_SQLITE_WAL_AUTOCHECKPOINT_PAGES};`,
    );
    expect(db["exec"]).toHaveBeenNthCalledWith(4, "PRAGMA synchronous = NORMAL;");
    expect(db["exec"]).toHaveBeenNthCalledWith(5, "PRAGMA foreign_keys = ON;");
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
      expect(db["exec"]).toHaveBeenNthCalledWith(2, "PRAGMA synchronous = NORMAL;");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
