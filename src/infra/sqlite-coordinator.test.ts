import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase, tryAcquireExclusiveSqliteCoordinator } from "./node-sqlite.js";
import { ensurePrivateSqliteCoordinatorDirectory } from "./sqlite-coordinator.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const loader = new URL("../../scripts/tsx.mjs", import.meta.url).href;
const moduleUrl = new URL("./node-sqlite.ts", import.meta.url).href;

function observeDirectory(directory: string) {
  // Stat only: opening and closing the coordinator in this process could drop
  // the holder's POSIX locks and invalidate the contender observation.
  return [".", ...fs.readdirSync(directory).toSorted()].map((name) => {
    const stat = fs.lstatSync(path.join(directory, name), { bigint: true });
    return {
      name,
      dev: stat.dev,
      ino: stat.ino,
      mode: stat.mode,
      size: stat.size,
      mtimeNs: stat.mtimeNs,
      ctimeNs: stat.ctimeNs,
    };
  });
}

function runPeer(script: string, pathname: string) {
  return execFileSync(
    process.execPath,
    ["--import", loader, "--input-type=module", "-e", script, pathname],
    { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}

const acquirePeer = `
  import { tryAcquireExclusiveSqliteCoordinator } from ${JSON.stringify(moduleUrl)};
  const coordinator = tryAcquireExclusiveSqliteCoordinator(process.argv[1]);
  process.stdout.write(coordinator ? "held" : "blocked");
  coordinator?.release();
`;

describe("data-free SQLite coordinator", () => {
  it("leaves an existing coordinator unchanged while excluding current and default-journal peers", () => {
    const directory = tempDirs.make("openclaw-sqlite-coordinator-");
    const pathname = path.join(directory, "coordinator.sqlite");
    const initialize = openNodeSqliteDatabase(pathname);
    initialize.exec("BEGIN EXCLUSIVE; ROLLBACK;");
    initialize.close();
    const before = observeDirectory(directory);
    const bytes = fs.readFileSync(pathname);
    const coordinator = tryAcquireExclusiveSqliteCoordinator(pathname);
    expect(coordinator).not.toBeNull();
    try {
      expect(observeDirectory(directory)).toEqual(before);
      expect(runPeer(acquirePeer, pathname)).toBe("blocked");
      // Swift and older Node peers use the default rollback journal mode.
      expect(
        runPeer(
          `import { DatabaseSync } from "node:sqlite";
          const database = new DatabaseSync(process.argv[1]);
          try {
            database.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;");
            process.stdout.write("held");
            database.exec("ROLLBACK;");
          } catch (error) {
            if (error.errcode !== 5) throw error;
            process.stdout.write("blocked");
          } finally { database.close(); }`,
          pathname,
        ),
      ).toBe("blocked");
      expect(observeDirectory(directory)).toEqual(before);
    } finally {
      coordinator?.release();
    }
    expect(runPeer(acquirePeer, pathname)).toBe("held");
    expect(observeDirectory(directory)).toEqual(before);
    expect(fs.readFileSync(pathname)).toEqual(bytes);
  });

  it("creates a missing coordinator without a journal and permits retry after owner exit", () => {
    const directory = tempDirs.make("openclaw-sqlite-coordinator-exit-");
    const pathname = path.join(directory, "coordinator.sqlite");
    const coordinator = tryAcquireExclusiveSqliteCoordinator(pathname);
    expect(coordinator).not.toBeNull();
    try {
      expect(fs.readdirSync(directory)).toEqual(["coordinator.sqlite"]);
    } finally {
      coordinator?.release();
    }
    const before = observeDirectory(directory);
    expect(
      runPeer(
        `import { tryAcquireExclusiveSqliteCoordinator } from ${JSON.stringify(moduleUrl)};
        if (!tryAcquireExclusiveSqliteCoordinator(process.argv[1])) process.exit(1);
        process.stdout.write("held");
        process.exit(0);`,
        pathname,
      ),
    ).toBe("held");
    expect(runPeer(acquirePeer, pathname)).toBe("held");
    expect(observeDirectory(directory)).toEqual(before);
    expect(fs.readFileSync(pathname)).toHaveLength(0);
  });

  it("does not change ordinary state connection durability", () => {
    const directory = tempDirs.make("openclaw-sqlite-state-durability-");
    const pathname = path.join(directory, "state.sqlite");
    const database = openNodeSqliteDatabase(pathname);
    try {
      database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE probe(id);");
      const coordinator = tryAcquireExclusiveSqliteCoordinator(path.join(directory, "lock.sqlite"));
      expect(coordinator).not.toBeNull();
      try {
        expect(database.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
        expect(database.prepare("PRAGMA synchronous").get()).toEqual({ synchronous: 2 });
        database.exec("INSERT INTO probe VALUES(1);");
      } finally {
        coordinator?.release();
      }
    } finally {
      database.close();
    }
    const reopened = openNodeSqliteDatabase(pathname);
    try {
      expect(reopened.prepare("SELECT id FROM probe").all()).toEqual([{ id: 1 }]);
      expect(reopened.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    } finally {
      reopened.close();
    }
  });
});

describe.skipIf(process.platform === "win32")("private coordinator directory", () => {
  afterEach(() => vi.restoreAllMocks());

  it("does not mutate an already-private directory", () => {
    const directory = tempDirs.make("openclaw-private-coordinator-");
    fs.chmodSync(directory, 0o700);
    const before = observeDirectory(directory);
    const chmod = vi.spyOn(fs, "chmodSync");
    ensurePrivateSqliteCoordinatorDirectory(directory, "test");
    expect(chmod).not.toHaveBeenCalled();
    expect(observeDirectory(directory)).toEqual(before);
  });

  it.each([0o755, 0o500, 0o1700])("still hardens mode %s", (mode) => {
    const directory = tempDirs.make("openclaw-private-coordinator-mode-");
    fs.chmodSync(directory, mode);
    ensurePrivateSqliteCoordinatorDirectory(directory, "test");
    expect(fs.lstatSync(directory).mode & 0o7777).toBe(0o700);
  });

  it("rejects a symlink without changing its target", () => {
    const directory = tempDirs.make("openclaw-private-coordinator-link-");
    const target = path.join(directory, "target");
    const alias = path.join(directory, "alias");
    fs.mkdirSync(target, { mode: 0o755 });
    fs.symlinkSync(target, alias);
    const before = observeDirectory(directory);
    expect(() => ensurePrivateSqliteCoordinatorDirectory(alias, "test")).toThrow("real directory");
    expect(observeDirectory(directory)).toEqual(before);
  });

  it("refuses foreign ownership before chmod", () => {
    const directory = tempDirs.make("openclaw-private-coordinator-owner-");
    fs.chmodSync(directory, 0o755);
    const before = observeDirectory(directory);
    vi.spyOn(process, "getuid").mockReturnValue(fs.lstatSync(directory).uid + 1);
    const chmod = vi.spyOn(fs, "chmodSync");
    expect(() => ensurePrivateSqliteCoordinatorDirectory(directory, "test")).toThrow(
      "belongs to another user",
    );
    expect(chmod).not.toHaveBeenCalled();
    expect(observeDirectory(directory)).toEqual(before);
  });
});
