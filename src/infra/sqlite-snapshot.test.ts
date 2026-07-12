import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requireNodeSqlite } from "./node-sqlite.js";
import { createVerifiedSqliteSnapshot } from "./sqlite-snapshot.js";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sqlite-snapshot-"));
  tempDirs.push(tempDir);
  return tempDir;
}

afterEach(async () => {
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

describe("createVerifiedSqliteSnapshot", () => {
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
      } finally {
        snapshot.close();
      }
    } finally {
      source.close();
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

  it("rejects an existing target without modifying it", async () => {
    const tempDir = await createTempDir();
    const sourcePath = path.join(tempDir, "source.sqlite");
    const targetPath = path.join(tempDir, "snapshot.sqlite");
    const sqlite = requireNodeSqlite();
    new sqlite.DatabaseSync(sourcePath).close();
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
    new sqlite.DatabaseSync(sourcePath).close();

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

  it("preserves a target replaced after hard-link publication", async () => {
    const tempDir = await createTempDir();
    const sourcePath = path.join(tempDir, "source.sqlite");
    const targetPath = path.join(tempDir, "snapshot.sqlite");
    const sqlite = requireNodeSqlite();
    new sqlite.DatabaseSync(sourcePath).close();
    const originalLink = fs.link.bind(fs);
    const linkSpy = vi.spyOn(fs, "link").mockImplementation(async (source, target) => {
      await originalLink(source, target);
      await fs.unlink(target);
      await fs.writeFile(target, "racer");
    });

    try {
      await expect(createVerifiedSqliteSnapshot({ sourcePath, targetPath })).rejects.toThrow(
        /target changed during publication/u,
      );
      await expect(fs.readFile(targetPath, "utf8")).resolves.toBe("racer");
    } finally {
      linkSpy.mockRestore();
    }
  });

  it("rejects a target replaced after exclusive-copy publication", async () => {
    const tempDir = await createTempDir();
    const sourcePath = path.join(tempDir, "source.sqlite");
    const targetPath = path.join(tempDir, "snapshot.sqlite");
    const sqlite = requireNodeSqlite();
    new sqlite.DatabaseSync(sourcePath).close();
    const originalOpen = fs.open.bind(fs);
    const linkSpy = vi.spyOn(fs, "link").mockRejectedValue(
      Object.assign(new Error("hard links unsupported"), {
        code: "EPERM",
      }),
    );
    const openSpy = vi.spyOn(fs, "open").mockImplementation(async (filePath, flags, mode) => {
      const handle = await originalOpen(filePath, flags, mode);
      if (path.resolve(String(filePath)) === targetPath && flags === "wx+") {
        const originalSync = handle.sync.bind(handle);
        vi.spyOn(handle, "sync").mockImplementationOnce(async () => {
          await originalSync();
          await fs.unlink(targetPath);
          await fs.writeFile(targetPath, "racer");
        });
      }
      return handle;
    });

    try {
      await expect(createVerifiedSqliteSnapshot({ sourcePath, targetPath })).rejects.toThrow(
        /target changed during publication/u,
      );
      await expect(fs.readFile(targetPath, "utf8")).resolves.toBe("racer");
    } finally {
      openSpy.mockRestore();
      linkSpy.mockRestore();
    }
  });

  it("syncs fallback copies before reporting success", async () => {
    const tempDir = await createTempDir();
    const sourcePath = path.join(tempDir, "source.sqlite");
    const targetPath = path.join(tempDir, "snapshot.sqlite");
    const sqlite = requireNodeSqlite();
    new sqlite.DatabaseSync(sourcePath).close();
    const originalOpen = fs.open.bind(fs);
    const openSpy = vi.spyOn(fs, "open").mockImplementation(originalOpen);
    const linkSpy = vi.spyOn(fs, "link").mockRejectedValue(
      Object.assign(new Error("hard links unsupported"), {
        code: "EPERM",
      }),
    );

    try {
      await createVerifiedSqliteSnapshot({ sourcePath, targetPath });
      expect(
        openSpy.mock.calls.some(([filePath]) => path.resolve(String(filePath)) === targetPath),
      ).toBe(true);
    } finally {
      linkSpy.mockRestore();
      openSpy.mockRestore();
    }
  });

  it("removes its published target when final directory sync fails", async () => {
    const tempDir = await createTempDir();
    const sourcePath = path.join(tempDir, "source.sqlite");
    const targetPath = path.join(tempDir, "snapshot.sqlite");
    const sqlite = requireNodeSqlite();
    new sqlite.DatabaseSync(sourcePath).close();
    const originalOpen = fs.open.bind(fs);
    const openSpy = vi.spyOn(fs, "open").mockImplementation(async (filePath, flags, mode) => {
      if (path.resolve(String(filePath)) === tempDir) {
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

    expect(labels).toEqual([sourcePath, targetPath]);
    expect((await fs.readFile(targetPath)).includes(removedValue)).toBe(false);
    const snapshot = new sqlite.DatabaseSync(targetPath, { readOnly: true });
    try {
      expect(snapshot.prepare("SELECT value FROM records").get()).toEqual({ value: "new" });
    } finally {
      snapshot.close();
    }
  });
});
