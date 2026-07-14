import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requireNodeSqlite } from "./node-sqlite.js";
import { createPrivateSqliteDirectory, createVerifiedSqliteSnapshot } from "./sqlite-snapshot.js";

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

  it("rejects staged bytes changed after validation", async () => {
    const tempDir = await createTempDir();
    const sourcePath = path.join(tempDir, "source.sqlite");
    const targetPath = path.join(tempDir, "snapshot.sqlite");
    const sqlite = requireNodeSqlite();
    new sqlite.DatabaseSync(sourcePath).close();
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
    new sqlite.DatabaseSync(sourcePath).close();
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
    new sqlite.DatabaseSync(sourcePath).close();
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
    new sqlite.DatabaseSync(sourcePath).close();
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
    new sqlite.DatabaseSync(sourcePath).close();
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
    new sqlite.DatabaseSync(sourcePath).close();

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
    new sqlite.DatabaseSync(sourcePath).close();
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
      new sqlite.DatabaseSync(sourcePath).close();
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
    new sqlite.DatabaseSync(sourcePath).close();
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
    new sqlite.DatabaseSync(sourcePath).close();
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
    new sqlite.DatabaseSync(sourcePath).close();
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
    new sqlite.DatabaseSync(sourcePath).close();
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
    new sqlite.DatabaseSync(sourcePath).close();
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
    new sqlite.DatabaseSync(sourcePath).close();
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
