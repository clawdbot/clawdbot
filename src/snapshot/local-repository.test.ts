import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { createPrivateSqliteDirectory } from "../infra/sqlite-snapshot.js";
import { runExec } from "../process/exec.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "../state/openclaw-agent-schema.generated.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../state/openclaw-state-schema.generated.js";
import { createLocalSqliteSnapshotProvider } from "./local-repository.js";
import { hashSnapshotArtifact, readSnapshotManifest } from "./manifest.js";
import {
  SNAPSHOT_MANIFEST_FILENAME,
  SNAPSHOT_SQLITE_FILENAME,
  type SnapshotManifest,
  type SnapshotResult,
} from "./snapshot-provider.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const TRANSIENT_PLUGIN_BLOB_MARKER = `transient-plugin-blob-${"sensitive".repeat(32)}`;
const DURABLE_PLUGIN_BLOB_MARKER = "durable-plugin-blob-control";
const STATE_LEASE_MARKER = "snapshot-must-not-retain-active-lease";

async function createTempDir(): Promise<string> {
  const tempDir = tempDirs.make("openclaw-snapshot-repository-");
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

function createGenericDatabase(
  databasePath: string,
  options: { userVersion?: number; values?: string[]; wal?: boolean } = {},
): void {
  const sqlite = requireNodeSqlite();
  const database = new sqlite.DatabaseSync(databasePath);
  try {
    database.exec(`
      ${options.wal ? "PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;" : ""}
      PRAGMA user_version = ${options.userVersion ?? 7};
      CREATE TABLE entries (
        id INTEGER PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    const insert = database.prepare("INSERT INTO entries (value) VALUES (?)");
    for (const value of options.values ?? ["one"]) {
      insert.run(value);
    }
  } finally {
    database.close();
  }
}

function createGlobalDatabase(databasePath: string): void {
  const sqlite = requireNodeSqlite();
  const database = new sqlite.DatabaseSync(databasePath);
  try {
    database.exec(`
      ${OPENCLAW_STATE_SCHEMA_SQL}
      PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION};
    `);
    database
      .prepare(
        `
          INSERT INTO schema_meta (
            meta_key,
            role,
            schema_version,
            agent_id,
            app_version,
            created_at,
            updated_at
          ) VALUES ('primary', 'global', ?, NULL, NULL, 1, 1)
        `,
      )
      .run(OPENCLAW_STATE_SCHEMA_VERSION);
    database
      .prepare(
        `
          INSERT INTO delivery_queue_entries (
            queue_name,
            id,
            status,
            entry_json,
            enqueued_at,
            updated_at
          ) VALUES ('delivery', 'queued', 'pending', ?, 1, 1)
        `,
      )
      .run('{"payload":"do-not-restore"}');
  } finally {
    database.close();
  }
}

function seedGlobalPluginBlobSnapshotFixtures(databasePath: string): void {
  const sqlite = requireNodeSqlite();
  const database = new sqlite.DatabaseSync(databasePath);
  try {
    const insertPluginBlob = database.prepare(
      `
        INSERT INTO plugin_blob_entries (
          plugin_id, namespace, entry_key, metadata_json, blob, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
    );
    insertPluginBlob.run(
      "diffs",
      "viewer-artifacts",
      "transient",
      JSON.stringify({ marker: TRANSIENT_PLUGIN_BLOB_MARKER }),
      Buffer.from(`<html>${TRANSIENT_PLUGIN_BLOB_MARKER}</html>`),
      1,
      Date.UTC(2099, 0, 1),
    );
    insertPluginBlob.run(
      "durable-plugin",
      "documents",
      "durable",
      JSON.stringify({ kind: "durable" }),
      Buffer.from(DURABLE_PLUGIN_BLOB_MARKER),
      1,
      null,
    );
  } finally {
    database.close();
  }
}

function createAgentDatabase(databasePath: string, agentId: string): void {
  const sqlite = requireNodeSqlite();
  const database = new sqlite.DatabaseSync(databasePath);
  try {
    database.exec(`
      ${OPENCLAW_AGENT_SCHEMA_SQL}
      PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION};
    `);
    database
      .prepare(
        `
          INSERT INTO schema_meta (
            meta_key,
            role,
            schema_version,
            agent_id,
            app_version,
            created_at,
            updated_at
          ) VALUES ('primary', 'agent', ?, ?, NULL, 1, 1)
        `,
      )
      .run(OPENCLAW_AGENT_SCHEMA_VERSION, agentId);
  } finally {
    database.close();
  }
}

function seedStateLease(databasePath: string): void {
  const sqlite = requireNodeSqlite();
  const database = new sqlite.DatabaseSync(databasePath);
  try {
    database
      .prepare(
        `
          INSERT INTO state_leases (
            scope, lease_key, owner, expires_at, heartbeat_at, payload_json, created_at, updated_at
          ) VALUES (?, 'write', 'worker', 9999999999999, 1, NULL, 1, 1)
        `,
      )
      .run(STATE_LEASE_MARKER);
  } finally {
    database.close();
  }
}

function disableDefensiveModeForSchemaCorruption(database: object): void {
  (
    database as {
      enableDefensive?: (active: boolean) => void;
    }
  ).enableDefensive?.(false);
}

function createUnsafeIndexDrift(databasePath: string): void {
  const sqlite = requireNodeSqlite();
  const database = new sqlite.DatabaseSync(databasePath);
  try {
    disableDefensiveModeForSchemaCorruption(database);
    database.exec(`
      CREATE TABLE records (
        id INTEGER PRIMARY KEY,
        indexed_value TEXT NOT NULL,
        alternate_value TEXT NOT NULL
      );
      CREATE INDEX records_value ON records(indexed_value);
      INSERT INTO records (indexed_value, alternate_value)
      VALUES ('alpha', 'zeta'), ('beta', 'eta'), ('gamma', 'theta');
      PRAGMA writable_schema = ON;
    `);
    database
      .prepare(
        "UPDATE sqlite_schema SET sql = 'CREATE INDEX records_value ON records(alternate_value)' WHERE name = 'records_value'",
      )
      .run();
    const schemaVersion = Number(
      Object.values(database.prepare("PRAGMA schema_version").get() as Record<string, unknown>)[0],
    );
    database.exec(`PRAGMA writable_schema = OFF; PRAGMA schema_version = ${schemaVersion + 1};`);
  } finally {
    database.close();
  }
}

async function rewriteManifest(
  result: SnapshotResult,
  mutate: (manifest: SnapshotManifest) => SnapshotManifest,
): Promise<void> {
  const manifestPath = path.join(result.ref.path, SNAPSHOT_MANIFEST_FILENAME);
  const manifest = await readSnapshotManifest(result.ref.path);
  await fs.writeFile(manifestPath, `${JSON.stringify(mutate(manifest), null, 2)}\n`);
}

async function refreshArtifactManifest(result: SnapshotResult): Promise<void> {
  const digest = await hashSnapshotArtifact(result.ref.path);
  await rewriteManifest(result, (manifest) => ({
    ...manifest,
    artifact: {
      ...manifest.artifact,
      sha256: digest.sha256,
      sizeBytes: digest.sizeBytes,
    },
  }));
}

describe("local SQLite snapshot repository", () => {
  it("creates, lists, verifies, and fresh-restores committed WAL state", async () => {
    const tempDir = await createTempDir();
    const sourcePath = path.join(tempDir, "source.sqlite");
    const repositoryPath = path.join(
      tempDir,
      process.platform === "win32" ? "snapshots-\u00e9 #" : "snapshots ? #",
    );
    const restorePath = path.join(tempDir, "restore", "source.sqlite");
    const sqlite = requireNodeSqlite();
    const source = new sqlite.DatabaseSync(sourcePath);
    try {
      source.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA wal_autocheckpoint = 0;
        PRAGMA user_version = 42;
        CREATE TABLE entries (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO entries (value) VALUES ('checkpointed');
        PRAGMA wal_checkpoint(TRUNCATE);
        INSERT INTO entries (value) VALUES ('committed-in-wal');
      `);
      const provider = createLocalSqliteSnapshotProvider({
        repositoryPath,
        now: () => new Date("2026-07-12T14:00:00.000Z"),
      });
      const snapshot = await provider.create({
        path: sourcePath,
        identity: { role: "generic", id: "test-database" },
      });

      expect(snapshot.manifest).toMatchObject({
        schemaVersion: 1,
        createdAt: "2026-07-12T14:00:00.000Z",
        database: {
          role: "generic",
          id: "test-database",
          basename: "source.sqlite",
          userVersion: 42,
        },
        artifact: {
          path: SNAPSHOT_SQLITE_FILENAME,
        },
      });
      expect(snapshot.manifest.artifact.sha256).toMatch(/^[a-f0-9]{64}$/u);
      await expect(provider.verify(snapshot.ref)).resolves.toEqual({
        ok: true,
        manifest: snapshot.manifest,
      });
      await expect(provider.list()).resolves.toEqual([snapshot]);
      await expect(provider.restoreFresh(snapshot.ref, restorePath)).resolves.toEqual({
        ok: true,
        manifest: snapshot.manifest,
      });
      await expect(fs.readFile(restorePath)).resolves.toEqual(
        await fs.readFile(path.join(snapshot.ref.path, SNAPSHOT_SQLITE_FILENAME)),
      );
      expect((await fs.readdir(repositoryPath)).every((name) => !name.startsWith(".tmp-"))).toBe(
        true,
      );
      await expect(fs.readdir(path.dirname(restorePath))).resolves.toEqual(["source.sqlite"]);
    } finally {
      source.close();
    }

    const restored = new sqlite.DatabaseSync(restorePath, { readOnly: true });
    try {
      expect(restored.prepare("SELECT value FROM entries ORDER BY id").all()).toEqual([
        { value: "checkpointed" },
        { value: "committed-in-wal" },
      ]);
      expect(restored.prepare("PRAGMA user_version").get()).toEqual({ user_version: 42 });
    } finally {
      restored.close();
    }
    if (process.platform !== "win32") {
      expect((await fs.stat(repositoryPath)).mode & 0o777).toBe(0o700);
      expect((await fs.stat(restorePath)).mode & 0o777).toBe(0o600);
    }
  });

  it.runIf(process.platform !== "win32").each([
    { label: "000", mode: 0o000 },
    { label: "200", mode: 0o200 },
    { label: "300", mode: 0o300 },
    { label: "777", mode: 0o777 },
  ])(
    "repairs an existing private repository from mode $label before pinning it",
    async (testCase) => {
      const tempDir = await createTempDir();
      const sourcePath = path.join(tempDir, "source.sqlite");
      const repositoryPath = path.join(tempDir, "snapshots");
      createGenericDatabase(sourcePath);
      await fs.mkdir(repositoryPath, { mode: testCase.mode });
      await fs.chmod(repositoryPath, testCase.mode);
      const provider = createLocalSqliteSnapshotProvider({ repositoryPath });

      try {
        await expect(
          provider.create({
            path: sourcePath,
            identity: { role: "generic", id: "repair-existing-repository" },
          }),
        ).resolves.toBeDefined();
        expect((await fs.stat(repositoryPath)).mode & 0o777).toBe(0o700);
      } finally {
        await fs.chmod(repositoryPath, 0o700).catch(() => undefined);
      }
    },
  );

  it("fails creation when a nested repository parent edge cannot be synced", async () => {
    const tempDir = await createTempDir();
    const sourcePath = path.join(tempDir, "source.sqlite");
    const repositoryPath = path.join(tempDir, "nested", "repository", "snapshots");
    createGenericDatabase(sourcePath);
    const provider = createLocalSqliteSnapshotProvider({ repositoryPath });
    const canonicalTempDir = await fs.realpath(tempDir);
    const originalOpen = fs.open.bind(fs);
    let syncFailed = false;
    const openSpy = vi.spyOn(fs, "open").mockImplementation(async (filePath, flags, mode) => {
      const handle = await originalOpen(filePath, flags, mode);
      if (isDirectoryOpen(flags) && path.resolve(String(filePath)) === canonicalTempDir) {
        const originalSync = handle.sync.bind(handle);
        vi.spyOn(handle, "sync").mockImplementation(async () => {
          if (!syncFailed && fsSync.existsSync(repositoryPath)) {
            syncFailed = true;
            throw Object.assign(new Error("repository parent sync failed"), { code: "EIO" });
          }
          await originalSync();
        });
      }
      return handle;
    });

    try {
      await expect(
        provider.create({
          path: sourcePath,
          identity: { role: "generic", id: "nested-parent-sync" },
        }),
      ).rejects.toThrow(/could not sync created directory edge/u);
    } finally {
      openSpy.mockRestore();
    }
    expect(syncFailed).toBe(true);
    await expect(fs.readdir(repositoryPath)).resolves.toEqual([]);
  });

  it("fails restore when a nested target parent edge cannot be synced", async () => {
    const tempDir = await createTempDir();
    const sourcePath = path.join(tempDir, "source.sqlite");
    const repositoryPath = path.join(tempDir, "snapshots");
    const restorePath = path.join(tempDir, "restore", "nested", "source.sqlite");
    createGenericDatabase(sourcePath);
    const provider = createLocalSqliteSnapshotProvider({ repositoryPath });
    const snapshot = await provider.create({
      path: sourcePath,
      identity: { role: "generic", id: "nested-restore-parent-sync" },
    });
    const canonicalTempDir = await fs.realpath(tempDir);
    const originalOpen = fs.open.bind(fs);
    let syncFailed = false;
    const openSpy = vi.spyOn(fs, "open").mockImplementation(async (filePath, flags, mode) => {
      const handle = await originalOpen(filePath, flags, mode);
      if (isDirectoryOpen(flags) && path.resolve(String(filePath)) === canonicalTempDir) {
        const originalSync = handle.sync.bind(handle);
        vi.spyOn(handle, "sync").mockImplementation(async () => {
          if (
            !syncFailed &&
            fsSync.existsSync(path.dirname(restorePath)) &&
            !fsSync.existsSync(restorePath)
          ) {
            syncFailed = true;
            throw Object.assign(new Error("restore parent sync failed"), { code: "EIO" });
          }
          await originalSync();
        });
      }
      return handle;
    });

    try {
      await expect(provider.restoreFresh(snapshot.ref, restorePath)).rejects.toThrow(
        /could not sync created directory edge/u,
      );
    } finally {
      openSpy.mockRestore();
    }
    expect(syncFailed).toBe(true);
    await expect(fs.access(restorePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cleans a pending marker whose file sync fails", async () => {
    const tempDir = await createTempDir();
    const sourcePath = path.join(tempDir, "source.sqlite");
    const repositoryPath = path.join(tempDir, "snapshots");
    createGenericDatabase(sourcePath);
    const provider = createLocalSqliteSnapshotProvider({ repositoryPath });
    const originalOpen = fs.open.bind(fs);
    let syncFailed = false;
    const openSpy = vi.spyOn(fs, "open").mockImplementation(async (filePath, flags, mode) => {
      const handle = await originalOpen(filePath, flags, mode);
      if (!syncFailed && flags === "wx+" && path.basename(String(filePath)) === ".pending") {
        vi.spyOn(handle, "sync").mockImplementation(async () => {
          syncFailed = true;
          throw Object.assign(new Error("pending sync failed"), { code: "EIO" });
        });
      }
      return handle;
    });

    try {
      await expect(
        provider.create({
          path: sourcePath,
          identity: { role: "generic", id: "pending-sync-failure" },
        }),
      ).rejects.toThrow(/pending sync failed/u);
    } finally {
      openSpy.mockRestore();
    }
    expect(syncFailed).toBe(true);
    await expect(fs.readdir(repositoryPath)).resolves.toEqual([]);
  });

  it.runIf(process.platform !== "win32")(
    "publishes payload only after the pending directory is durable",
    async () => {
      const tempDir = await createTempDir();
      const sourcePath = path.join(tempDir, "source.sqlite");
      const repositoryPath = path.join(tempDir, "snapshots");
      createGenericDatabase(sourcePath);
      await fs.mkdir(repositoryPath, { mode: 0o700 });
      const provider = createLocalSqliteSnapshotProvider({
        repositoryPath,
        now: () => new Date("2026-07-24T16:00:00.000Z"),
      });
      const events: string[] = [];
      let snapshotDir: string | undefined;
      const originalOpen = fs.open.bind(fs);
      const openSpy = vi.spyOn(fs, "open").mockImplementation(async (filePath, flags, mode) => {
        const resolvedPath = path.resolve(String(filePath));
        const handle = await originalOpen(filePath, flags, mode);
        if (flags === "wx+" && path.basename(resolvedPath) === ".pending") {
          snapshotDir = path.dirname(resolvedPath);
          const originalSync = handle.sync.bind(handle);
          vi.spyOn(handle, "sync").mockImplementation(async () => {
            events.push("pending-sync");
            await originalSync();
          });
        } else if (isDirectoryOpen(flags) && snapshotDir && resolvedPath === snapshotDir) {
          const originalSync = handle.sync.bind(handle);
          vi.spyOn(handle, "sync").mockImplementation(async () => {
            events.push("snapshot-sync");
            await originalSync();
          });
        } else if (isDirectoryOpen(flags) && resolvedPath === repositoryPath) {
          const originalSync = handle.sync.bind(handle);
          vi.spyOn(handle, "sync").mockImplementation(async () => {
            events.push("repository-sync");
            await originalSync();
          });
        }
        return handle;
      });
      const originalLink = fs.link.bind(fs);
      const linkSpy = vi.spyOn(fs, "link").mockImplementation(async (source, target) => {
        if (snapshotDir && path.dirname(String(target)) === snapshotDir) {
          events.push(`publish:${path.basename(String(target))}`);
        }
        await originalLink(source, target);
      });
      const originalUnlink = fsSync.unlinkSync.bind(fsSync);
      const unlinkSpy = vi.spyOn(fsSync, "unlinkSync").mockImplementation((filePath) => {
        if (path.basename(String(filePath)) === ".pending") {
          events.push("pending-unlink");
        }
        originalUnlink(filePath);
      });

      try {
        await provider.create({
          path: sourcePath,
          identity: { role: "generic", id: "publication-order" },
        });
      } finally {
        openSpy.mockRestore();
        linkSpy.mockRestore();
        unlinkSpy.mockRestore();
      }

      const pendingSync = events.indexOf("pending-sync");
      const repositorySync = events.indexOf("repository-sync");
      const artifactPublish = events.indexOf(`publish:${SNAPSHOT_SQLITE_FILENAME}`);
      const manifestPublish = events.indexOf(`publish:${SNAPSHOT_MANIFEST_FILENAME}`);
      const pendingUnlink = events.indexOf("pending-unlink");
      const snapshotSyncs = events
        .map((event, index) => (event === "snapshot-sync" ? index : -1))
        .filter((index) => index >= 0);
      expect(snapshotSyncs).toHaveLength(3);
      expect(pendingSync).toBeLessThan(snapshotSyncs[0] ?? -1);
      expect(snapshotSyncs[0]).toBeLessThan(repositorySync);
      expect(repositorySync).toBeLessThan(artifactPublish);
      expect(artifactPublish).toBeLessThan(manifestPublish);
      expect(manifestPublish).toBeLessThan(snapshotSyncs[1] ?? -1);
      expect(snapshotSyncs[1]).toBeLessThan(pendingUnlink);
      expect(pendingUnlink).toBeLessThan(snapshotSyncs[2] ?? -1);
    },
  );

  it("sorts snapshots newest first and ignores incomplete staging directories", async () => {
    const tempDir = await createTempDir();
    const sourcePath = path.join(tempDir, "source.sqlite");
    const repositoryPath = path.join(tempDir, "snapshots");
    createGenericDatabase(sourcePath);
    const dates = [new Date("2026-07-12T14:00:00.000Z"), new Date("2026-07-12T14:01:00.000Z")];
    const provider = createLocalSqliteSnapshotProvider({
      repositoryPath,
      now: () => dates.shift() ?? new Date("invalid"),
    });
    const first = await provider.create({
      path: sourcePath,
      identity: { role: "generic", id: "test-database" },
    });
    const second = await provider.create({
      path: sourcePath,
      identity: { role: "generic", id: "test-database" },
    });
    await fs.mkdir(path.join(repositoryPath, ".tmp-interrupted"));
    await fs.mkdir(path.join(repositoryPath, "interrupted-final"));
    await fs.writeFile(path.join(repositoryPath, "interrupted-final", ".pending"), "");
    await fs.mkdir(path.join(repositoryPath, "empty-final"));

    await expect(provider.list()).resolves.toEqual([second, first]);
  });

  it.each([SNAPSHOT_SQLITE_FILENAME, SNAPSHOT_MANIFEST_FILENAME])(
    "rejects markerless partial snapshot directories containing only %s",
    async (entryName) => {
      const tempDir = await createTempDir();
      const repositoryPath = path.join(tempDir, "snapshots");
      const partialPath = path.join(repositoryPath, "markerless-partial");
      await fs.mkdir(partialPath, { recursive: true });
      await fs.writeFile(path.join(partialPath, entryName), "partial");
      const provider = createLocalSqliteSnapshotProvider({ repositoryPath });

      await expect(provider.list()).rejects.toThrow();
    },
  );

  it("rejects unknown entries inside an incomplete snapshot directory", async () => {
    const tempDir = await createTempDir();
    const repositoryPath = path.join(tempDir, "snapshots");
    await fs.mkdir(path.join(repositoryPath, "interrupted"), { recursive: true });
    await fs.writeFile(path.join(repositoryPath, "interrupted", ".pending"), "");
    await fs.writeFile(path.join(repositoryPath, "interrupted", "unexpected"), "");
    const provider = createLocalSqliteSnapshotProvider({ repositoryPath });

    await expect(provider.list()).rejects.toThrow(/unexpected incomplete entry/u);
  });

  it("uses caller-owned verification scratch and stages restore beside the target", async () => {
    const tempDir = await createTempDir();
    const sourcePath = path.join(tempDir, "source.sqlite");
    const repositoryPath = path.join(tempDir, "snapshots");
    const validationRootPath = path.join(tempDir, "validation");
    const restoreParentPath = path.join(tempDir, "restore");
    const restorePath = path.join(restoreParentPath, "source.sqlite");
    createGenericDatabase(sourcePath);
    await fs.mkdir(validationRootPath, { mode: 0o700 });
    await fs.chmod(validationRootPath, 0o700);
    const provider = createLocalSqliteSnapshotProvider({
      repositoryPath,
      validationRootPath,
    });
    const snapshot = await provider.create({
      path: sourcePath,
      identity: { role: "generic", id: "protected-scratch" },
    });
    const canonicalTempDir = await fs.realpath(tempDir);
    const originalMkdtemp = fs.mkdtemp.bind(fs);
    const prefixes: string[] = [];
    const mkdtempSpy = vi.spyOn(fs, "mkdtemp").mockImplementation(async (prefix, options) => {
      prefixes.push(prefix);
      return await originalMkdtemp(prefix, options);
    });

    try {
      await provider.verify(snapshot.ref);
      await provider.restoreFresh(snapshot.ref, restorePath);
    } finally {
      mkdtempSpy.mockRestore();
    }

    if (process.platform === "win32") {
      expect(prefixes).toEqual([]);
    } else {
      expect(prefixes.filter((prefix) => path.basename(prefix).startsWith(".tmp-"))).toEqual([
        path.join(canonicalTempDir, "validation", ".tmp-verify-"),
        path.join(canonicalTempDir, "restore", ".tmp-restore-"),
        path.join(canonicalTempDir, "restore", ".tmp-verify-"),
      ]);
    }
  });

  it("fails loudly when private verification scratch cannot be removed", async () => {
    const tempDir = await createTempDir();
    const sourcePath = path.join(tempDir, "source.sqlite");
    const repositoryPath = path.join(tempDir, "snapshots");
    const validationRootPath = path.join(tempDir, "validation");
    createGenericDatabase(sourcePath);
    await fs.mkdir(validationRootPath, { mode: 0o700 });
    await fs.chmod(validationRootPath, 0o700);
    const provider = createLocalSqliteSnapshotProvider({
      repositoryPath,
      validationRootPath,
    });
    const snapshot = await provider.create({
      path: sourcePath,
      identity: { role: "generic", id: "cleanup-failure" },
    });
    const originalUnlink = fs.unlink.bind(fs);
    const unlinkSpy = vi.spyOn(fs, "unlink").mockImplementation(async (filePath) => {
      if (path.basename(path.dirname(String(filePath))).startsWith(".tmp-verify-")) {
        throw Object.assign(new Error("cleanup denied"), { code: "EACCES" });
      }
      return await originalUnlink(filePath);
    });

    try {
      await expect(provider.verify(snapshot.ref)).rejects.toThrow(
        /Failed to clean private SQLite staging directory/u,
      );
    } finally {
      unlinkSpy.mockRestore();
    }
    expect(
      (await fs.readdir(validationRootPath)).some((entry) => entry.startsWith(".tmp-verify-")),
    ).toBe(true);
  });

  it("removes SQLite sidecars left in private verification scratch", async () => {
    const tempDir = await createTempDir();
    const sourcePath = path.join(tempDir, "source.sqlite");
    const repositoryPath = path.join(tempDir, "snapshots");
    const validationRootPath = path.join(tempDir, "validation");
    createGenericDatabase(sourcePath, { wal: true });
    await fs.mkdir(validationRootPath, { mode: 0o700 });
    await fs.chmod(validationRootPath, 0o700);
    const provider = createLocalSqliteSnapshotProvider({
      repositoryPath,
      validationRootPath,
    });
    const snapshot = await provider.create({
      path: sourcePath,
      identity: { role: "generic", id: "validation-sidecars" },
    });
    const originalReaddir = fs.readdir.bind(fs);
    let injectedSidecars = false;
    const readdirSpy = vi.spyOn(fs, "readdir").mockImplementation((async (...args: unknown[]) => {
      const directoryPath = path.resolve(String(args[0]));
      if (!injectedSidecars && path.basename(directoryPath).startsWith(".tmp-verify-")) {
        injectedSidecars = true;
        await Promise.all(
          ["-wal", "-shm", "-journal"].map(
            async (suffix) =>
              await fs.writeFile(
                path.join(directoryPath, `${SNAPSHOT_SQLITE_FILENAME}${suffix}`),
                "sqlite sidecar",
                { mode: 0o600 },
              ),
          ),
        );
      }
      return await (originalReaddir as (...readdirArgs: unknown[]) => Promise<unknown>)(...args);
    }) as typeof fs.readdir);

    try {
      await expect(provider.verify(snapshot.ref)).resolves.toMatchObject({ ok: true });
    } finally {
      readdirSpy.mockRestore();
    }
    expect(injectedSidecars).toBe(true);
    await expect(fs.readdir(validationRootPath)).resolves.toEqual([]);
  });

  it.runIf(process.platform !== "win32")(
    "rejects snapshot repositories beneath a replaceable ancestor",
    async () => {
      const tempDir = await createTempDir();
      const sourcePath = path.join(tempDir, "source.sqlite");
      const sharedPath = path.join(tempDir, "shared");
      const repositoryPath = path.join(sharedPath, "snapshots");
      createGenericDatabase(sourcePath);
      await fs.mkdir(sharedPath, { mode: 0o777 });
      await fs.chmod(sharedPath, 0o777);
      const provider = createLocalSqliteSnapshotProvider({ repositoryPath });

      await expect(
        provider.create({
          path: sourcePath,
          identity: { role: "generic", id: "replaceable-repository-ancestor" },
        }),
      ).rejects.toThrow(/ancestor must not allow another user/u);
      await expect(fs.readdir(repositoryPath)).resolves.toEqual([]);
    },
  );

  it.runIf(process.platform === "win32")(
    "rejects snapshot repositories with inheritable Everyone access",
    async () => {
      const tempDir = await createTempDir();
      const sourcePath = path.join(tempDir, "source.sqlite");
      const sharedPath = path.join(tempDir, "shared");
      const repositoryPath = path.join(sharedPath, "snapshots");
      const icacls = path.join(
        process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows",
        "System32",
        "icacls.exe",
      );
      createGenericDatabase(sourcePath);
      await fs.mkdir(sharedPath);
      await runExec(icacls, [sharedPath, "/grant", "*S-1-1-0:(OI)(CI)(F)"]);
      const provider = createLocalSqliteSnapshotProvider({ repositoryPath });

      try {
        await expect(
          provider.create({
            path: sourcePath,
            identity: { role: "generic", id: "windows-everyone-repository" },
          }),
        ).rejects.toThrow(/Windows ACL permits untrusted SQLite staging access/u);
        await expect(fs.readdir(repositoryPath)).resolves.toEqual([]);
      } finally {
        await runExec(icacls, [sharedPath, "/remove:g", "*S-1-1-0"]).catch(() => undefined);
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects verification and restore staging roots writable by other users",
    async () => {
      const tempDir = await createTempDir();
      const sourcePath = path.join(tempDir, "source.sqlite");
      const repositoryPath = path.join(tempDir, "snapshots");
      const validationRootPath = path.join(tempDir, "validation");
      const restoreParentPath = path.join(tempDir, "restore");
      const restorePath = path.join(restoreParentPath, "source.sqlite");
      createGenericDatabase(sourcePath);
      await fs.mkdir(validationRootPath, { mode: 0o777 });
      await fs.chmod(validationRootPath, 0o777);
      await fs.mkdir(restoreParentPath, { mode: 0o777 });
      await fs.chmod(restoreParentPath, 0o777);
      const provider = createLocalSqliteSnapshotProvider({
        repositoryPath,
        validationRootPath,
      });
      const snapshot = await provider.create({
        path: sourcePath,
        identity: { role: "generic", id: "untrusted-staging-root" },
      });

      await expect(provider.verify(snapshot.ref)).rejects.toThrow(/not writable by other users/u);
      await expect(provider.restoreFresh(snapshot.ref, restorePath)).rejects.toThrow(
        /not writable by other users/u,
      );
      await expect(fs.access(restorePath)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects private staging roots beneath a replaceable ancestor",
    async () => {
      const tempDir = await createTempDir();
      const sourcePath = path.join(tempDir, "source.sqlite");
      const repositoryPath = path.join(tempDir, "snapshots");
      const sharedPath = path.join(tempDir, "shared");
      const validationRootPath = path.join(sharedPath, "validation");
      const restoreParentPath = path.join(sharedPath, "restore");
      const restorePath = path.join(restoreParentPath, "source.sqlite");
      createGenericDatabase(sourcePath);
      await fs.mkdir(validationRootPath, { recursive: true, mode: 0o700 });
      await fs.chmod(validationRootPath, 0o700);
      await fs.mkdir(restoreParentPath, { mode: 0o700 });
      await fs.chmod(restoreParentPath, 0o700);
      await fs.chmod(sharedPath, 0o777);
      const provider = createLocalSqliteSnapshotProvider({
        repositoryPath,
        validationRootPath,
      });
      const snapshot = await provider.create({
        path: sourcePath,
        identity: { role: "generic", id: "replaceable-ancestor" },
      });

      await expect(provider.verify(snapshot.ref)).rejects.toThrow(
        /ancestor must not allow another user/u,
      );
      await expect(provider.restoreFresh(snapshot.ref, restorePath)).rejects.toThrow(
        /ancestor must not allow another user/u,
      );
      await expect(fs.access(restorePath)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects sticky staging ancestors owned by another user",
    async () => {
      const tempDir = await createTempDir();
      const sourcePath = path.join(tempDir, "source.sqlite");
      const repositoryPath = path.join(tempDir, "snapshots");
      const sharedPath = path.join(tempDir, "shared");
      const validationRootPath = path.join(sharedPath, "validation");
      createGenericDatabase(sourcePath);
      await fs.mkdir(validationRootPath, { recursive: true, mode: 0o700 });
      await fs.chmod(validationRootPath, 0o700);
      await fs.chmod(sharedPath, 0o1777);
      const provider = createLocalSqliteSnapshotProvider({
        repositoryPath,
        validationRootPath,
      });
      const snapshot = await provider.create({
        path: sourcePath,
        identity: { role: "generic", id: "untrusted-sticky-owner" },
      });
      const canonicalSharedPath = await fs.realpath(sharedPath);
      const originalLstat = fs.lstat.bind(fs);
      const lstatSpy = vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
        const stat = await originalLstat(...args);
        if (path.resolve(String(args[0])) !== canonicalSharedPath) {
          return stat;
        }
        return new Proxy(stat, {
          get(target, property, receiver) {
            if (property === "uid") {
              return typeof target.uid === "bigint" ? target.uid + 1n : target.uid + 1;
            }
            const value = Reflect.get(target, property, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      });

      try {
        await expect(provider.verify(snapshot.ref)).rejects.toThrow(
          /ancestor must not allow another user/u,
        );
        await fs.chmod(sharedPath, 0o755);
        await expect(provider.verify(snapshot.ref)).rejects.toThrow(
          /ancestor must not allow another user/u,
        );
        await fs.chmod(sharedPath, 0o555);
        await expect(provider.verify(snapshot.ref)).rejects.toThrow(
          /ancestor must not allow another user/u,
        );
      } finally {
        await fs.chmod(sharedPath, 0o700);
        lstatSpy.mockRestore();
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "accepts protected symlinked ancestors through their canonical path",
    async () => {
      const tempDir = await createTempDir();
      const sourcePath = path.join(tempDir, "source.sqlite");
      const repositoryPath = path.join(tempDir, "snapshots");
      const realSharedPath = path.join(tempDir, "real-shared");
      const aliasSharedPath = path.join(tempDir, "alias-shared");
      const validationRootPath = path.join(aliasSharedPath, "validation");
      const restorePath = path.join(aliasSharedPath, "restore", "source.sqlite");
      createGenericDatabase(sourcePath, { values: ["canonical-staging"] });
      await fs.mkdir(path.join(realSharedPath, "validation"), { recursive: true, mode: 0o700 });
      await fs.chmod(path.join(realSharedPath, "validation"), 0o700);
      await fs.symlink(realSharedPath, aliasSharedPath, "dir");
      const provider = createLocalSqliteSnapshotProvider({
        repositoryPath,
        validationRootPath,
      });
      const snapshot = await provider.create({
        path: sourcePath,
        identity: { role: "generic", id: "canonical-staging" },
      });

      await expect(provider.verify(snapshot.ref)).resolves.toMatchObject({ ok: true });
      await expect(provider.restoreFresh(snapshot.ref, restorePath)).resolves.toMatchObject({
        ok: true,
      });
      const sqlite = requireNodeSqlite();
      const restored = new sqlite.DatabaseSync(restorePath, { readOnly: true });
      try {
        expect(restored.prepare("SELECT value FROM entries").all()).toEqual([
          { value: "canonical-staging" },
        ]);
      } finally {
        restored.close();
      }
    },
  );

  it.runIf(process.platform === "darwin")(
    "rejects snapshot repositories beneath a granting macOS ACL",
    async () => {
      const tempDir = await createTempDir();
      const sourcePath = path.join(tempDir, "source.sqlite");
      const sharedPath = path.join(tempDir, "shared");
      const repositoryPath = path.join(sharedPath, "snapshots");
      createGenericDatabase(sourcePath);
      await fs.mkdir(sharedPath, { mode: 0o700 });
      await runExec("/bin/chmod", ["+a", "everyone allow add_file,delete_child", sharedPath]);
      const provider = createLocalSqliteSnapshotProvider({ repositoryPath });

      try {
        await expect(
          provider.create({
            path: sourcePath,
            identity: { role: "generic", id: "macos-acl-repository" },
          }),
        ).rejects.toThrow(/macOS ACL permits untrusted SQLite staging access/u);
        await expect(fs.readdir(repositoryPath)).resolves.toEqual([]);
      } finally {
        await runExec("/bin/chmod", ["-N", sharedPath]).catch(() => undefined);
      }
    },
  );

  it.runIf(process.platform === "darwin")(
    "rejects granting macOS ACLs on private roots, ancestors, and staging directories",
    async () => {
      const tempDir = await createTempDir();
      const sourcePath = path.join(tempDir, "source.sqlite");
      const repositoryPath = path.join(tempDir, "snapshots");
      const sharedPath = path.join(tempDir, "shared");
      const validationRootPath = path.join(sharedPath, "validation");
      createGenericDatabase(sourcePath);
      await fs.mkdir(validationRootPath, { recursive: true, mode: 0o700 });
      await fs.chmod(validationRootPath, 0o700);
      const provider = createLocalSqliteSnapshotProvider({
        repositoryPath,
        validationRootPath,
      });
      const snapshot = await provider.create({
        path: sourcePath,
        identity: { role: "generic", id: "macos-acl" },
      });

      try {
        await runExec("/bin/chmod", [
          "+a",
          `${os.userInfo().username} allow read,write,delete`,
          validationRootPath,
        ]);
        await expect(provider.verify(snapshot.ref)).resolves.toMatchObject({ ok: true });
        await runExec("/bin/chmod", ["-N", validationRootPath]);

        await runExec("/bin/chmod", ["+a", "everyone deny delete", validationRootPath]);
        await expect(provider.verify(snapshot.ref)).resolves.toMatchObject({ ok: true });
        await runExec("/bin/chmod", ["-N", validationRootPath]);

        await runExec("/bin/chmod", ["+a", "everyone allow read,write,delete", validationRootPath]);
        await expect(provider.verify(snapshot.ref)).rejects.toThrow(
          /macOS ACL permits untrusted SQLite staging access/u,
        );
        await runExec("/bin/chmod", ["-N", validationRootPath]);

        await runExec("/bin/chmod", ["+a", "everyone allow add_file,delete_child", sharedPath]);
        await expect(provider.verify(snapshot.ref)).rejects.toThrow(
          /macOS ACL permits untrusted SQLite staging access/u,
        );
        await runExec("/bin/chmod", ["-N", sharedPath]);

        const originalMkdtemp = fs.mkdtemp.bind(fs);
        const mkdtempSpy = vi.spyOn(fs, "mkdtemp").mockImplementation(async (prefix, options) => {
          const directoryPath = await originalMkdtemp(prefix, options);
          if (path.basename(directoryPath).startsWith(".tmp-verify-")) {
            await runExec("/bin/chmod", ["+a", "everyone allow read,write,delete", directoryPath]);
          }
          return directoryPath;
        });
        try {
          await expect(provider.verify(snapshot.ref)).rejects.toThrow(
            /macOS ACL permits untrusted SQLite staging access/u,
          );
        } finally {
          mkdtempSpy.mockRestore();
        }
      } finally {
        await Promise.all(
          [validationRootPath, sharedPath].map(
            async (pathname) =>
              await runExec("/bin/chmod", ["-N", pathname]).catch(() => undefined),
          ),
        );
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "restores from a read-only snapshot repository without changing its permissions",
    async () => {
      const tempDir = await createTempDir();
      const sourcePath = path.join(tempDir, "source.sqlite");
      const repositoryPath = path.join(tempDir, "snapshots");
      const restorePath = path.join(tempDir, "restore", "source.sqlite");
      createGenericDatabase(sourcePath, { values: ["read-only-source"] });
      const provider = createLocalSqliteSnapshotProvider({ repositoryPath });
      const snapshot = await provider.create({
        path: sourcePath,
        identity: { role: "generic", id: "read-only-repository" },
      });
      const snapshotEntries = [
        path.join(snapshot.ref.path, SNAPSHOT_MANIFEST_FILENAME),
        path.join(snapshot.ref.path, SNAPSHOT_SQLITE_FILENAME),
      ];
      for (const entryPath of snapshotEntries) {
        await fs.chmod(entryPath, 0o400);
      }
      await fs.chmod(snapshot.ref.path, 0o500);
      await fs.chmod(repositoryPath, 0o500);

      try {
        await expect(provider.list()).resolves.toEqual([snapshot]);
        await expect(provider.verify(snapshot.ref)).resolves.toMatchObject({ ok: true });
        await expect(provider.restoreFresh(snapshot.ref, restorePath)).resolves.toMatchObject({
          ok: true,
        });
        expect((await fs.stat(repositoryPath)).mode & 0o777).toBe(0o500);
        expect((await fs.stat(snapshot.ref.path)).mode & 0o777).toBe(0o500);
        const sqlite = requireNodeSqlite();
        const restored = new sqlite.DatabaseSync(restorePath, { readOnly: true });
        try {
          expect(restored.prepare("SELECT value FROM entries").all()).toEqual([
            { value: "read-only-source" },
          ]);
        } finally {
          restored.close();
        }
      } finally {
        await fs.chmod(repositoryPath, 0o700);
        await fs.chmod(snapshot.ref.path, 0o700);
        for (const entryPath of snapshotEntries) {
          await fs.chmod(entryPath, 0o600);
        }
      }
    },
  );

  it("preserves both restore and cleanup failures", async () => {
    const tempDir = await createTempDir();
    const sourcePath = path.join(tempDir, "source.sqlite");
    const repositoryPath = path.join(tempDir, "snapshots");
    const restorePath = path.join(tempDir, "restore", "source.sqlite");
    createGenericDatabase(sourcePath);
    const provider = createLocalSqliteSnapshotProvider({ repositoryPath });
    const snapshot = await provider.create({
      path: sourcePath,
      identity: { role: "generic", id: "combined-failure" },
    });
    const linkSpy = vi
      .spyOn(fs, "link")
      .mockRejectedValue(Object.assign(new Error("hard links unsupported"), { code: "ENOTSUP" }));
    const originalUnlink = fs.unlink.bind(fs);
    const unlinkSpy = vi.spyOn(fs, "unlink").mockImplementation(async (filePath) => {
      if (path.basename(path.dirname(String(filePath))).startsWith(".tmp-restore-")) {
        throw Object.assign(new Error("cleanup denied"), { code: "EACCES" });
      }
      return await originalUnlink(filePath);
    });

    try {
      const error = await provider
        .restoreFresh(snapshot.ref, restorePath)
        .catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors.map(String)).toEqual([
        expect.stringMatching(/requires hard-link support/u),
        expect.stringMatching(/cleanup denied/u),
      ]);
    } finally {
      unlinkSpy.mockRestore();
      linkSpy.mockRestore();
    }
  });

  it("preserves a published restore when staging cleanup fails", async () => {
    const tempDir = await createTempDir();
    const sourcePath = path.join(tempDir, "source.sqlite");
    const repositoryPath = path.join(tempDir, "snapshots");
    const restorePath = path.join(tempDir, "restore", "source.sqlite");
    createGenericDatabase(sourcePath, { values: ["published-before-cleanup"] });
    const provider = createLocalSqliteSnapshotProvider({ repositoryPath });
    const snapshot = await provider.create({
      path: sourcePath,
      identity: { role: "generic", id: "restore-cleanup-failure" },
    });
    const originalUnlink = fs.unlink.bind(fs);
    const unlinkSpy = vi.spyOn(fs, "unlink").mockImplementation(async (filePath) => {
      if (path.basename(path.dirname(String(filePath))).startsWith(".tmp-restore-")) {
        throw Object.assign(new Error("restore cleanup denied"), { code: "EACCES" });
      }
      return await originalUnlink(filePath);
    });

    try {
      await expect(provider.restoreFresh(snapshot.ref, restorePath)).rejects.toThrow(
        /Failed to clean private SQLite staging directory/u,
      );
    } finally {
      unlinkSpy.mockRestore();
    }
    const sqlite = requireNodeSqlite();
    const restored = new sqlite.DatabaseSync(restorePath, { readOnly: true });
    try {
      expect(restored.prepare("SELECT value FROM entries").all()).toEqual([
        { value: "published-before-cleanup" },
      ]);
    } finally {
      restored.close();
    }
  });

  it("fails restore when the final cleanup directory sync fails", async () => {
    const tempDir = await createTempDir();
    const sourcePath = path.join(tempDir, "source.sqlite");
    const repositoryPath = path.join(tempDir, "snapshots");
    const restoreParentPath = path.join(tempDir, "restore");
    const restorePath = path.join(restoreParentPath, "source.sqlite");
    createGenericDatabase(sourcePath);
    const provider = createLocalSqliteSnapshotProvider({ repositoryPath });
    const snapshot = await provider.create({
      path: sourcePath,
      identity: { role: "generic", id: "best-effort-directory-sync" },
    });
    const originalOpen = fs.open.bind(fs);
    const openSpy = vi.spyOn(fs, "open").mockImplementation(async (filePath, flags, mode) => {
      if (path.resolve(String(filePath)) === restoreParentPath && isDirectoryOpen(flags)) {
        const entries = await fs.readdir(restoreParentPath);
        if (
          entries.includes(path.basename(restorePath)) &&
          entries.every((entry) => !entry.startsWith(".tmp-restore-"))
        ) {
          throw Object.assign(new Error("directory sync unavailable"), { code: "EIO" });
        }
      }
      return await originalOpen(filePath, flags, mode);
    });

    try {
      await expect(provider.restoreFresh(snapshot.ref, restorePath)).rejects.toThrow(
        /directory sync unavailable/u,
      );
    } finally {
      openSpy.mockRestore();
    }
    await expect(fs.access(restorePath)).resolves.toBeUndefined();
  });

  it.runIf(process.platform !== "win32")(
    "never replaces a snapshot directory raced into place",
    async () => {
      const tempDir = await createTempDir();
      const sourcePath = path.join(tempDir, "source.sqlite");
      const repositoryPath = path.join(tempDir, "snapshots");
      createGenericDatabase(sourcePath);
      const provider = createLocalSqliteSnapshotProvider({
        repositoryPath,
        now: () => new Date("2026-07-12T14:00:00.000Z"),
      });
      const originalMkdir = fs.mkdir.bind(fs);
      let racedPath: string | undefined;
      const mkdirSpy = vi.spyOn(fs, "mkdir").mockImplementation(async (directoryPath, options) => {
        const resolvedPath = path.resolve(String(directoryPath));
        if (
          path.basename(path.dirname(resolvedPath)) === path.basename(repositoryPath) &&
          !path.basename(resolvedPath).startsWith(".tmp-")
        ) {
          racedPath = resolvedPath;
          await originalMkdir(resolvedPath, options);
          await fs.writeFile(path.join(resolvedPath, "keep"), "racer");
        }
        return await originalMkdir(directoryPath, options);
      });

      try {
        await expect(
          provider.create({
            path: sourcePath,
            identity: { role: "generic", id: "directory-race" },
          }),
        ).rejects.toThrow(/directory already exists/u);
      } finally {
        mkdirSpy.mockRestore();
      }
      expect(racedPath).toBeDefined();
      await expect(fs.readFile(path.join(racedPath!, "keep"), "utf8")).resolves.toBe("racer");
    },
  );

  it("rejects an artifact changed after entering the final directory", async () => {
    const tempDir = await createTempDir();
    const sourcePath = path.join(tempDir, "source.sqlite");
    const repositoryPath = path.join(tempDir, "snapshots");
    createGenericDatabase(sourcePath);
    const provider = createLocalSqliteSnapshotProvider({ repositoryPath });
    const originalLink = fs.link.bind(fs);
    const linkSpy = vi.spyOn(fs, "link").mockImplementation(async (source, target) => {
      await originalLink(source, target);
      if (
        path.basename(String(target)) === SNAPSHOT_MANIFEST_FILENAME &&
        !path.basename(path.dirname(String(target))).startsWith(".tmp-")
      ) {
        await fs.appendFile(
          path.join(path.dirname(String(target)), SNAPSHOT_SQLITE_FILENAME),
          "changed-after-final-move",
        );
      }
    });

    try {
      await expect(
        provider.create({
          path: sourcePath,
          identity: { role: "generic", id: "final-directory-race" },
        }),
      ).rejects.toThrow(/size mismatch/u);
      await expect(provider.list()).resolves.toEqual([]);
    } finally {
      linkSpy.mockRestore();
    }
  });

  it("rejects an artifact changed after removing the commit marker", async () => {
    const tempDir = await createTempDir();
    const sourcePath = path.join(tempDir, "source.sqlite");
    const repositoryPath = path.join(tempDir, "snapshots");
    createGenericDatabase(sourcePath);
    const provider = createLocalSqliteSnapshotProvider({ repositoryPath });
    const originalUnlink = fsSync.unlinkSync.bind(fsSync);
    let mutated = false;
    const unlinkSpy = vi.spyOn(fsSync, "unlinkSync").mockImplementation((filePath) => {
      originalUnlink(filePath);
      if (!mutated && path.basename(String(filePath)) === ".pending") {
        fsSync.appendFileSync(
          path.join(path.dirname(String(filePath)), SNAPSHOT_SQLITE_FILENAME),
          "changed-after-commit-marker",
        );
        mutated = true;
      }
    });

    try {
      await expect(
        provider.create({
          path: sourcePath,
          identity: { role: "generic", id: "post-commit-artifact-race" },
        }),
      ).rejects.toThrow(/size mismatch/u);
    } finally {
      unlinkSpy.mockRestore();
    }
    expect(mutated).toBe(true);
    await expect(fs.readdir(repositoryPath)).resolves.toEqual([]);
  });

  it.runIf(process.platform !== "win32")(
    "rejects a snapshot directory restored after commit-marker removal",
    async () => {
      const tempDir = await createTempDir();
      const sourcePath = path.join(tempDir, "source.sqlite");
      const repositoryPath = path.join(tempDir, "snapshots");
      createGenericDatabase(sourcePath);
      const provider = createLocalSqliteSnapshotProvider({ repositoryPath });
      const originalUnlink = fsSync.unlinkSync.bind(fsSync);
      let raced = false;
      const unlinkSpy = vi.spyOn(fsSync, "unlinkSync").mockImplementation((filePath) => {
        if (raced || path.basename(String(filePath)) !== ".pending") {
          originalUnlink(filePath);
          return;
        }
        const snapshotDir = path.dirname(String(filePath));
        const displacedDir = `${snapshotDir}.displaced`;
        fsSync.renameSync(snapshotDir, displacedDir);
        fsSync.mkdirSync(snapshotDir, { mode: 0o700 });
        fsSync.writeFileSync(path.join(snapshotDir, ".pending"), "", { mode: 0o600 });
        originalUnlink(filePath);
        fsSync.rmdirSync(snapshotDir);
        fsSync.renameSync(displacedDir, snapshotDir);
        raced = true;
      });

      try {
        await expect(
          provider.create({
            path: sourcePath,
            identity: { role: "generic", id: "post-commit-directory-race" },
          }),
        ).rejects.toThrow(/unexpected entry/u);
      } finally {
        unlinkSpy.mockRestore();
      }
      expect(raced).toBe(true);
      await expect(fs.readdir(repositoryPath)).resolves.toEqual([]);
    },
  );

  it("cleans a linked entry when post-link inspection fails", async () => {
    const tempDir = await createTempDir();
    const sourcePath = path.join(tempDir, "source.sqlite");
    const repositoryPath = path.join(tempDir, "snapshots");
    createGenericDatabase(sourcePath);
    const provider = createLocalSqliteSnapshotProvider({ repositoryPath });
    const originalLink = fs.link.bind(fs);
    const originalLstat = fs.lstat.bind(fs);
    let linkedArtifactPath: string | undefined;
    let failedInspection = false;
    const linkSpy = vi.spyOn(fs, "link").mockImplementation(async (source, target) => {
      await originalLink(source, target);
      if (
        path.basename(String(target)) === SNAPSHOT_SQLITE_FILENAME &&
        !path.basename(path.dirname(String(target))).startsWith(".tmp-")
      ) {
        linkedArtifactPath = path.resolve(String(target));
      }
    });
    const lstatSpy = vi.spyOn(fs, "lstat").mockImplementation(async (filePath) => {
      if (
        linkedArtifactPath &&
        !failedInspection &&
        path.resolve(String(filePath)) === linkedArtifactPath
      ) {
        failedInspection = true;
        throw Object.assign(new Error("post-link inspection failed"), { code: "EIO" });
      }
      return await originalLstat(filePath);
    });

    try {
      await expect(
        provider.create({
          path: sourcePath,
          identity: { role: "generic", id: "post-link-inspection" },
        }),
      ).rejects.toThrow(/post-link inspection failed/u);
      await expect(provider.list()).resolves.toEqual([]);
      await expect(fs.readdir(repositoryPath)).resolves.toEqual([]);
    } finally {
      lstatSpy.mockRestore();
      linkSpy.mockRestore();
    }
  });

  it("never overwrites a file raced into the final snapshot directory", async () => {
    const tempDir = await createTempDir();
    const sourcePath = path.join(tempDir, "source.sqlite");
    const repositoryPath = path.join(tempDir, "snapshots");
    createGenericDatabase(sourcePath);
    const provider = createLocalSqliteSnapshotProvider({ repositoryPath });
    const originalLink = fs.link.bind(fs);
    let racedPath: string | undefined;
    const linkSpy = vi.spyOn(fs, "link").mockImplementation(async (source, target) => {
      const targetPath = path.resolve(String(target));
      if (
        path.basename(targetPath) === SNAPSHOT_SQLITE_FILENAME &&
        path.dirname(targetPath) !== repositoryPath &&
        !path.basename(path.dirname(targetPath)).startsWith(".tmp-")
      ) {
        racedPath = targetPath;
        await fs.writeFile(targetPath, "racer", { flag: "wx" });
      }
      await originalLink(source, target);
    });

    try {
      await expect(
        provider.create({
          path: sourcePath,
          identity: { role: "generic", id: "entry-race" },
        }),
      ).rejects.toThrow(/EEXIST/u);
    } finally {
      linkSpy.mockRestore();
    }
    expect(racedPath).toBeDefined();
    await expect(fs.readFile(racedPath!, "utf8")).resolves.toBe("racer");
  });

  it("sanitizes transient global rows and enforces the global owner", async () => {
    const tempDir = await createTempDir();
    const sourcePath = path.join(tempDir, "openclaw.sqlite");
    const repositoryPath = path.join(tempDir, "snapshots");
    createGlobalDatabase(sourcePath);
    seedGlobalPluginBlobSnapshotFixtures(sourcePath);
    seedStateLease(sourcePath);
    const provider = createLocalSqliteSnapshotProvider({ repositoryPath });
    const snapshot = await provider.create({
      path: sourcePath,
      identity: { role: "global" },
    });
    const artifactPath = path.join(snapshot.ref.path, SNAPSHOT_SQLITE_FILENAME);
    const artifactBytes = await fs.readFile(artifactPath);
    expect(artifactBytes.includes("do-not-restore")).toBe(false);
    expect(artifactBytes.includes(TRANSIENT_PLUGIN_BLOB_MARKER)).toBe(false);
    expect(artifactBytes.includes(DURABLE_PLUGIN_BLOB_MARKER)).toBe(true);
    expect(artifactBytes.includes(STATE_LEASE_MARKER)).toBe(false);
    const sqlite = requireNodeSqlite();
    const artifact = new sqlite.DatabaseSync(artifactPath, { readOnly: true });
    try {
      expect(
        artifact.prepare("SELECT COUNT(*) AS count FROM delivery_queue_entries").get(),
      ).toEqual({ count: 0 });
      expect(
        artifact
          .prepare(
            "SELECT plugin_id, entry_key FROM plugin_blob_entries ORDER BY plugin_id, entry_key",
          )
          .all(),
      ).toEqual([{ plugin_id: "durable-plugin", entry_key: "durable" }]);
      expect(artifact.prepare("SELECT COUNT(*) AS count FROM state_leases").get()).toEqual({
        count: 0,
      });
    } finally {
      artifact.close();
    }

    const source = new sqlite.DatabaseSync(sourcePath, { readOnly: true });
    try {
      expect(source.prepare("SELECT COUNT(*) AS count FROM delivery_queue_entries").get()).toEqual({
        count: 1,
      });
      expect(
        source
          .prepare(
            "SELECT plugin_id, entry_key FROM plugin_blob_entries ORDER BY plugin_id, entry_key",
          )
          .all(),
      ).toEqual([
        { plugin_id: "diffs", entry_key: "transient" },
        { plugin_id: "durable-plugin", entry_key: "durable" },
      ]);
      expect(source.prepare("SELECT COUNT(*) AS count FROM state_leases").get()).toEqual({
        count: 1,
      });
    } finally {
      source.close();
    }

    const wrongRolePath = path.join(tempDir, "wrong-role.sqlite");
    createAgentDatabase(wrongRolePath, "main");
    const wrongRole = new sqlite.DatabaseSync(wrongRolePath);
    wrongRole.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION};`);
    wrongRole.close();
    await expect(
      provider.create({ path: wrongRolePath, identity: { role: "global" } }),
    ).rejects.toThrow(/expected global/u);
  });

  it("sanitizes transient leases from agent snapshots without touching the source", async () => {
    const tempDir = await createTempDir();
    const sourcePath = path.join(tempDir, "openclaw-agent.sqlite");
    const repositoryPath = path.join(tempDir, "snapshots");
    createAgentDatabase(sourcePath, "worker-1");
    seedStateLease(sourcePath);
    const provider = createLocalSqliteSnapshotProvider({ repositoryPath });

    const snapshot = await provider.create({
      path: sourcePath,
      identity: { role: "agent", agentId: "worker-1" },
    });
    const sqlite = requireNodeSqlite();
    const artifact = new sqlite.DatabaseSync(
      path.join(snapshot.ref.path, SNAPSHOT_SQLITE_FILENAME),
      { readOnly: true },
    );
    const source = new sqlite.DatabaseSync(sourcePath, { readOnly: true });
    try {
      expect(artifact.prepare("SELECT COUNT(*) AS count FROM state_leases").get()).toEqual({
        count: 0,
      });
      expect(source.prepare("SELECT COUNT(*) AS count FROM state_leases").get()).toEqual({
        count: 1,
      });
    } finally {
      source.close();
      artifact.close();
    }
  });

  it("enforces the exact agent owner and canonical agent id", async () => {
    const tempDir = await createTempDir();
    const sourcePath = path.join(tempDir, "openclaw-agent.sqlite");
    const repositoryPath = path.join(tempDir, "snapshots");
    createAgentDatabase(sourcePath, "worker-1");
    const provider = createLocalSqliteSnapshotProvider({ repositoryPath });

    await expect(
      provider.create({
        path: sourcePath,
        identity: { role: "agent", agentId: "worker-2" },
      }),
    ).rejects.toThrow(/belongs to agent worker-1/u);
    await expect(
      provider.create({
        path: sourcePath,
        identity: { role: "agent", agentId: "Worker-1" },
      }),
    ).rejects.toThrow(/must be canonical/u);
    await expect(
      provider.create({
        path: sourcePath,
        identity: { role: "agent", agentId: "worker-1" },
      }),
    ).resolves.toMatchObject({
      manifest: {
        database: {
          role: "agent",
          agentId: "worker-1",
          userVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
        },
      },
    });
  });

  it("rejects foreign-key violations and unsafe index definitions at creation", async () => {
    const tempDir = await createTempDir();
    const repositoryPath = path.join(tempDir, "snapshots");
    const foreignKeyPath = path.join(tempDir, "foreign-key.sqlite");
    const sqlite = requireNodeSqlite();
    const foreignKeyDatabase = new sqlite.DatabaseSync(foreignKeyPath);
    try {
      foreignKeyDatabase.exec(`
        PRAGMA foreign_keys = OFF;
        CREATE TABLE parents (id INTEGER PRIMARY KEY);
        CREATE TABLE children (
          id INTEGER PRIMARY KEY,
          parent_id INTEGER REFERENCES parents(id)
        );
        INSERT INTO children VALUES (1, 99);
      `);
    } finally {
      foreignKeyDatabase.close();
    }
    const unsafeIndexPath = path.join(tempDir, "unsafe-index.sqlite");
    createUnsafeIndexDrift(unsafeIndexPath);
    const provider = createLocalSqliteSnapshotProvider({ repositoryPath });

    await expect(
      provider.create({
        path: foreignKeyPath,
        identity: { role: "generic", id: "foreign-key" },
      }),
    ).rejects.toThrow(/foreign_key_check failed/u);
    await expect(
      provider.create({
        path: unsafeIndexPath,
        identity: { role: "generic", id: "unsafe-index" },
      }),
    ).rejects.toThrow(/integrity_check failed|malformed database schema/iu);
    await expect(provider.list()).resolves.toEqual([]);
  });

  it("detects artifact hash, user_version, and unsafe-index drift after creation", async () => {
    const tempDir = await createTempDir();
    const sourcePath = path.join(tempDir, "source.sqlite");
    const repositoryPath = path.join(tempDir, "snapshots");
    createGenericDatabase(sourcePath);
    const provider = createLocalSqliteSnapshotProvider({ repositoryPath });

    const hashSnapshot = await provider.create({
      path: sourcePath,
      identity: { role: "generic", id: "hash" },
    });
    await fs.appendFile(path.join(hashSnapshot.ref.path, SNAPSHOT_SQLITE_FILENAME), "tamper");
    await expect(provider.verify(hashSnapshot.ref)).rejects.toThrow(/size mismatch/u);

    const versionSnapshot = await provider.create({
      path: sourcePath,
      identity: { role: "generic", id: "version" },
    });
    const sqlite = requireNodeSqlite();
    const versionDatabase = new sqlite.DatabaseSync(
      path.join(versionSnapshot.ref.path, SNAPSHOT_SQLITE_FILENAME),
    );
    versionDatabase.exec("PRAGMA user_version = 99;");
    versionDatabase.close();
    await refreshArtifactManifest(versionSnapshot);
    await expect(provider.verify(versionSnapshot.ref)).rejects.toThrow(/user_version mismatch/u);

    const unsafeSnapshot = await provider.create({
      path: sourcePath,
      identity: { role: "generic", id: "unsafe" },
    });
    const unsafePath = path.join(unsafeSnapshot.ref.path, SNAPSHOT_SQLITE_FILENAME);
    const unsafeDatabase = new sqlite.DatabaseSync(unsafePath);
    try {
      disableDefensiveModeForSchemaCorruption(unsafeDatabase);
      unsafeDatabase.exec(`
        CREATE TABLE indexed_records (
          id INTEGER PRIMARY KEY,
          indexed_value TEXT NOT NULL,
          alternate_value TEXT NOT NULL
        );
        CREATE INDEX indexed_records_value ON indexed_records(indexed_value);
        INSERT INTO indexed_records (indexed_value, alternate_value)
        VALUES ('alpha', 'zeta'), ('beta', 'eta');
        PRAGMA writable_schema = ON;
      `);
      unsafeDatabase
        .prepare(
          "UPDATE sqlite_schema SET sql = 'CREATE INDEX indexed_records_value ON indexed_records(alternate_value)' WHERE name = 'indexed_records_value'",
        )
        .run();
      const schemaVersion = Number(
        Object.values(
          unsafeDatabase.prepare("PRAGMA schema_version").get() as Record<string, unknown>,
        )[0],
      );
      unsafeDatabase.exec(
        `PRAGMA writable_schema = OFF; PRAGMA schema_version = ${schemaVersion + 1};`,
      );
    } finally {
      unsafeDatabase.close();
    }
    await refreshArtifactManifest(unsafeSnapshot);
    await expect(provider.verify(unsafeSnapshot.ref)).rejects.toThrow(
      /integrity_check failed|malformed database schema/iu,
    );
  });

  it("never overwrites an existing target or orphan SQLite sidecar", async () => {
    const tempDir = await createTempDir();
    const sourcePath = path.join(tempDir, "source.sqlite");
    const repositoryPath = path.join(tempDir, "snapshots");
    const restorePath = path.join(tempDir, "restore", "source.sqlite");
    createGenericDatabase(sourcePath);
    const provider = createLocalSqliteSnapshotProvider({ repositoryPath });
    const snapshot = await provider.create({
      path: sourcePath,
      identity: { role: "generic", id: "restore" },
    });
    await fs.mkdir(path.dirname(restorePath), { recursive: true });
    await fs.writeFile(restorePath, "keep");

    await expect(provider.restoreFresh(snapshot.ref, restorePath)).rejects.toThrow(
      /restore path already exists/u,
    );
    await expect(fs.readFile(restorePath, "utf8")).resolves.toBe("keep");

    await fs.unlink(restorePath);
    await fs.writeFile(`${restorePath}-wal`, "keep-wal");
    await expect(provider.restoreFresh(snapshot.ref, restorePath)).rejects.toThrow(
      /restore path already exists/u,
    );
    await expect(fs.readFile(`${restorePath}-wal`, "utf8")).resolves.toBe("keep-wal");
    await expect(fs.access(restorePath)).rejects.toMatchObject({ code: "ENOENT" });

    if (process.platform !== "win32") {
      await fs.unlink(`${restorePath}-wal`);
      const externalPath = path.join(tempDir, "external.sqlite");
      await fs.writeFile(externalPath, "external");
      await fs.symlink(externalPath, restorePath);
      await expect(provider.restoreFresh(snapshot.ref, restorePath)).rejects.toThrow(
        /restore path already exists/u,
      );
      await expect(fs.readFile(externalPath, "utf8")).resolves.toBe("external");
      expect((await fs.lstat(restorePath)).isSymbolicLink()).toBe(true);
    }
  });

  it("fails closed when fresh restore cannot publish atomically", async () => {
    const tempDir = await createTempDir();
    const sourcePath = path.join(tempDir, "source.sqlite");
    const repositoryPath = path.join(tempDir, "snapshots");
    const restorePath = path.join(tempDir, "restore", "source.sqlite");
    createGenericDatabase(sourcePath);
    const provider = createLocalSqliteSnapshotProvider({ repositoryPath });
    const snapshot = await provider.create({
      path: sourcePath,
      identity: { role: "generic", id: "atomic-restore" },
    });
    const linkSpy = vi
      .spyOn(fs, "link")
      .mockRejectedValue(Object.assign(new Error("hard links unsupported"), { code: "ENOTSUP" }));

    try {
      await expect(provider.restoreFresh(snapshot.ref, restorePath)).rejects.toThrow(
        /requires hard-link support/u,
      );
      await expect(fs.access(restorePath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      linkSpy.mockRestore();
    }
  });

  it("rejects restore targets inside the snapshot repository", async () => {
    const tempDir = await createTempDir();
    const sourcePath = path.join(tempDir, "source.sqlite");
    const repositoryPath = path.join(tempDir, "snapshots");
    createGenericDatabase(sourcePath);
    const provider = createLocalSqliteSnapshotProvider({ repositoryPath });
    const snapshot = await provider.create({
      path: sourcePath,
      identity: { role: "generic", id: "repository-boundary" },
    });

    await expect(
      provider.restoreFresh(snapshot.ref, path.join(repositoryPath, "restored.sqlite")),
    ).rejects.toThrow(/outside snapshot repository/u);
    await expect(
      provider.restoreFresh(snapshot.ref, path.join(snapshot.ref.path, "restored.sqlite")),
    ).rejects.toThrow(/outside snapshot repository/u);
    await expect(provider.verify(snapshot.ref)).resolves.toMatchObject({ ok: true });
  });

  it.runIf(process.platform !== "win32")(
    "rejects a restore parent redirected after directory creation",
    async () => {
      const tempDir = await createTempDir();
      const sourcePath = path.join(tempDir, "source.sqlite");
      const repositoryPath = path.join(tempDir, "snapshots");
      const restoreParentPath = path.join(tempDir, "redirected");
      const restorePath = path.join(restoreParentPath, "restored.sqlite");
      createGenericDatabase(sourcePath);
      const provider = createLocalSqliteSnapshotProvider({ repositoryPath });
      const snapshot = await provider.create({
        path: sourcePath,
        identity: { role: "generic", id: "restore-parent-race" },
      });
      const canonicalRestoreParentPath = path.join(
        await fs.realpath(tempDir),
        path.basename(restoreParentPath),
      );
      const originalRealpath = fs.realpath.bind(fs);
      let redirected = false;
      const realpathSpy = vi.spyOn(fs, "realpath").mockImplementation(async (...args) => {
        const pathname = path.resolve(String(args[0]));
        if (!redirected && pathname === canonicalRestoreParentPath) {
          redirected = true;
          await fs.rmdir(canonicalRestoreParentPath);
          await fs.symlink(snapshot.ref.path, canonicalRestoreParentPath, "dir");
        }
        return await originalRealpath(...args);
      });

      try {
        await expect(provider.restoreFresh(snapshot.ref, restorePath)).rejects.toThrow(
          /restore target changed|outside snapshot repository|must be a real directory|not a directory/u,
        );
      } finally {
        realpathSpy.mockRestore();
      }
      expect(redirected).toBe(true);
      await expect(
        fs.access(path.join(snapshot.ref.path, path.basename(restorePath))),
      ).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.runIf(process.platform !== "win32")(
    "binds restore to the exact artifact bytes recorded by the manifest",
    async () => {
      const tempDir = await createTempDir();
      const sourcePath = path.join(tempDir, "source.sqlite");
      const repositoryPath = path.join(tempDir, "snapshots");
      const restorePath = path.join(tempDir, "restore", "source.sqlite");
      createGenericDatabase(sourcePath);
      const provider = createLocalSqliteSnapshotProvider({ repositoryPath });
      const snapshot = await provider.create({
        path: sourcePath,
        identity: { role: "generic", id: "verified-bytes" },
      });
      const artifactPath = path.join(snapshot.ref.path, SNAPSHOT_SQLITE_FILENAME);
      const originalOpen = fs.open.bind(fs);
      const openSpy = vi.spyOn(fs, "open").mockImplementation(async (filePath, flags, mode) => {
        const handle = await originalOpen(filePath, flags, mode);
        if (
          flags === "wx+" &&
          path.basename(String(filePath)) === SNAPSHOT_SQLITE_FILENAME &&
          path.basename(path.dirname(String(filePath))).startsWith(".tmp-restore-")
        ) {
          const sqlite = requireNodeSqlite();
          const database = new sqlite.DatabaseSync(artifactPath);
          database.prepare("INSERT INTO entries (value) VALUES (?)").run("raced");
          database.close();
        }
        return handle;
      });

      try {
        await expect(provider.restoreFresh(snapshot.ref, restorePath)).rejects.toThrow(
          /hash mismatch|size mismatch/u,
        );
        await expect(fs.access(restorePath)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        openSpy.mockRestore();
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "never publishes replacement bytes when the pinned staging pathname changes",
    async () => {
      const tempDir = await createTempDir();
      const sourcePath = path.join(tempDir, "source.sqlite");
      const repositoryPath = path.join(tempDir, "snapshots");
      const restorePath = path.join(tempDir, "restore", "source.sqlite");
      createGenericDatabase(sourcePath, { values: ["original"] });
      const provider = createLocalSqliteSnapshotProvider({ repositoryPath });
      const snapshot = await provider.create({
        path: sourcePath,
        identity: { role: "generic", id: "pinned-staging" },
      });
      const originalOpen = fs.open.bind(fs);
      const openSpy = vi.spyOn(fs, "open").mockImplementation(async (filePath, flags, mode) => {
        if (
          flags === "wx+" &&
          path.basename(path.dirname(String(filePath))).startsWith(".sqlite-publish-")
        ) {
          const stagingEntry = (await fs.readdir(path.dirname(restorePath))).find((entry) =>
            entry.startsWith(".tmp-restore-"),
          );
          if (!stagingEntry) {
            throw new Error("restore staging directory was not created");
          }
          const stagedPath = path.join(
            path.dirname(restorePath),
            stagingEntry,
            SNAPSHOT_SQLITE_FILENAME,
          );
          await fs.unlink(stagedPath);
          createGenericDatabase(stagedPath, { values: ["replacement"] });
        }
        return await originalOpen(filePath, flags, mode);
      });

      let restored = false;
      try {
        await provider.restoreFresh(snapshot.ref, restorePath);
        restored = true;
      } catch (error) {
        expect(String(error)).toMatch(/file changed while reading/u);
      } finally {
        openSpy.mockRestore();
      }
      if (!restored) {
        await expect(fs.access(restorePath)).rejects.toMatchObject({ code: "ENOENT" });
        return;
      }
      const sqlite = requireNodeSqlite();
      const database = new sqlite.DatabaseSync(restorePath, { readOnly: true });
      try {
        expect(database.prepare("SELECT value FROM entries").all()).toEqual([
          { value: "original" },
        ]);
      } finally {
        database.close();
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "removes only its restored target when a sidecar races publication",
    async () => {
      const tempDir = await createTempDir();
      const sourcePath = path.join(tempDir, "source.sqlite");
      const repositoryPath = path.join(tempDir, "snapshots");
      const restorePath = path.join(tempDir, "restore", "source.sqlite");
      createGenericDatabase(sourcePath);
      const provider = createLocalSqliteSnapshotProvider({ repositoryPath });
      const snapshot = await provider.create({
        path: sourcePath,
        identity: { role: "generic", id: "restore-race" },
      });
      const canonicalRestorePath = path.join(
        await fs.realpath(tempDir),
        "restore",
        "source.sqlite",
      );
      const originalLink = fs.link.bind(fs);
      const linkSpy = vi.spyOn(fs, "link").mockImplementation(async (source, target) => {
        await originalLink(source, target);
        if (path.resolve(String(target)) === canonicalRestorePath) {
          await fs.writeFile(`${canonicalRestorePath}-wal`, "racer");
        }
      });

      try {
        await expect(provider.restoreFresh(snapshot.ref, restorePath)).rejects.toThrow(
          /unexpected sidecar/u,
        );
        await expect(fs.access(restorePath)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(fs.readFile(`${restorePath}-wal`, "utf8")).resolves.toBe("racer");
      } finally {
        linkSpy.mockRestore();
      }
    },
  );

  it("rejects snapshots outside the configured repository and unexpected contents", async () => {
    const tempDir = await createTempDir();
    const sourcePath = path.join(tempDir, "source.sqlite");
    const repositoryPath = path.join(tempDir, "snapshots");
    createGenericDatabase(sourcePath);
    const provider = createLocalSqliteSnapshotProvider({ repositoryPath });
    const snapshot = await provider.create({
      path: sourcePath,
      identity: { role: "generic", id: "boundary" },
    });

    await expect(provider.verify({ path: tempDir })).rejects.toThrow(/immediate child/u);
    await fs.writeFile(path.join(snapshot.ref.path, `${SNAPSHOT_SQLITE_FILENAME}-wal`), "orphan");
    await expect(provider.verify(snapshot.ref)).rejects.toThrow(/unexpected entry/u);
    await expect(provider.list()).rejects.toThrow(/unexpected (?:incomplete )?entry/u);
  });

  it("bounds manifest reads before parsing untrusted snapshot metadata", async () => {
    const tempDir = await createTempDir();
    const sourcePath = path.join(tempDir, "source.sqlite");
    const repositoryPath = path.join(tempDir, "snapshots");
    createGenericDatabase(sourcePath);
    const provider = createLocalSqliteSnapshotProvider({ repositoryPath });
    const snapshot = await provider.create({
      path: sourcePath,
      identity: { role: "generic", id: "bounded-manifest" },
    });
    await fs.writeFile(
      path.join(snapshot.ref.path, SNAPSHOT_MANIFEST_FILENAME),
      Buffer.alloc(1024 * 1024 + 1, 0x20),
    );

    await expect(provider.verify(snapshot.ref)).rejects.toThrow(/1048576 bytes/u);
  });

  it.runIf(process.platform !== "win32")(
    "rejects symlinked repositories, snapshot files, and hardlinked artifacts",
    async () => {
      const tempDir = await createTempDir();
      const sourcePath = path.join(tempDir, "source.sqlite");
      const realRepositoryPath = path.join(tempDir, "real-snapshots");
      const repositoryLink = path.join(tempDir, "snapshot-link");
      createGenericDatabase(sourcePath);
      await fs.mkdir(realRepositoryPath);
      await fs.symlink(realRepositoryPath, repositoryLink);
      const linkedProvider = createLocalSqliteSnapshotProvider({
        repositoryPath: repositoryLink,
      });
      await expect(
        linkedProvider.create({
          path: sourcePath,
          identity: { role: "generic", id: "symlink-repository" },
        }),
      ).rejects.toThrow(/symlink|Invalid path|real directory/iu);

      const provider = createLocalSqliteSnapshotProvider({
        repositoryPath: realRepositoryPath,
      });
      const snapshot = await provider.create({
        path: sourcePath,
        identity: { role: "generic", id: "links" },
      });
      const artifactPath = path.join(snapshot.ref.path, SNAPSHOT_SQLITE_FILENAME);
      const externalArtifact = path.join(tempDir, "external.sqlite");
      await fs.link(artifactPath, externalArtifact);
      await expect(provider.verify(snapshot.ref)).rejects.toThrow(/hardlink/iu);
      await fs.unlink(externalArtifact);

      const manifestPath = path.join(snapshot.ref.path, SNAPSHOT_MANIFEST_FILENAME);
      const realManifest = path.join(tempDir, "manifest.json");
      await fs.rename(manifestPath, realManifest);
      await fs.symlink(realManifest, manifestPath);
      await expect(provider.verify(snapshot.ref)).rejects.toThrow(/regular file|symlink/iu);

      await fs.unlink(manifestPath);
      await fs.rename(realManifest, manifestPath);
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects repository restore targets reached through another filesystem spelling",
    async () => {
      const tempDir = await createTempDir();
      const sourcePath = path.join(tempDir, "source.sqlite");
      const repositoryPath = path.join(tempDir, "snapshots");
      createGenericDatabase(sourcePath);
      const provider = createLocalSqliteSnapshotProvider({ repositoryPath });
      const snapshot = await provider.create({
        path: sourcePath,
        identity: { role: "generic", id: "canonical-boundary" },
      });
      const aliasRoot = path.join(tempDir, "alias");
      await fs.symlink(tempDir, aliasRoot);
      const aliasRepositoryPath = path.join(aliasRoot, "snapshots");
      const aliasProvider = createLocalSqliteSnapshotProvider({
        repositoryPath: aliasRepositoryPath,
      });
      const aliasSnapshot = {
        path: path.join(aliasRepositoryPath, path.basename(snapshot.ref.path)),
      };

      await expect(
        aliasProvider.restoreFresh(aliasSnapshot, path.join(repositoryPath, "restored.sqlite")),
      ).rejects.toThrow(/outside snapshot repository/u);
      await expect(provider.verify(snapshot.ref)).resolves.toMatchObject({ ok: true });
    },
  );
});

describe("snapshot manifest parser", () => {
  const snapshotId = "snapshot";
  const validManifest: SnapshotManifest = {
    schemaVersion: 1,
    snapshotId,
    createdAt: "2026-07-12T14:00:00.000Z",
    database: {
      role: "agent",
      agentId: "worker-1",
      basename: "openclaw-agent.sqlite",
      userVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
    },
    artifact: {
      path: SNAPSHOT_SQLITE_FILENAME,
      sha256: "a".repeat(64),
      sizeBytes: 4096,
    },
  };

  it.each([
    ["unknown top-level field", { ...validManifest, extra: true }, /fields must be exactly/u],
    ["wrong directory id", validManifest, /does not match directory/u, "other"],
    [
      "noncanonical timestamp",
      { ...validManifest, createdAt: "2026-07-12T14:00:00Z" },
      /not canonical/u,
    ],
    [
      "artifact path traversal",
      { ...validManifest, artifact: { ...validManifest.artifact, path: "../database.sqlite" } },
      /artifact\.path must be database\.sqlite/u,
    ],
    [
      "prefixed digest",
      {
        ...validManifest,
        artifact: { ...validManifest.artifact, sha256: `sha256:${"a".repeat(64)}` },
      },
      /sha256 is invalid/u,
    ],
    [
      "noncanonical agent id",
      { ...validManifest, database: { ...validManifest.database, agentId: "Worker-1" } },
      /agentId is invalid/u,
    ],
    [
      "unsafe basename",
      { ...validManifest, database: { ...validManifest.database, basename: "../db.sqlite" } },
      /basename is invalid/u,
    ],
    [
      "out-of-range user version",
      { ...validManifest, database: { ...validManifest.database, userVersion: 2 ** 31 } },
      /userVersion is invalid/u,
    ],
    [
      "zero-byte artifact",
      { ...validManifest, artifact: { ...validManifest.artifact, sizeBytes: 0 } },
      /sizeBytes is invalid/u,
    ],
  ])("rejects %s", async (_name, value, error, expectedId = snapshotId) => {
    const snapshotDir = path.join(await createTempDir(), snapshotId);
    await fs.mkdir(snapshotDir);
    await fs.writeFile(
      path.join(snapshotDir, SNAPSHOT_MANIFEST_FILENAME),
      JSON.stringify(value),
      "utf8",
    );

    await expect(readSnapshotManifest(snapshotDir, expectedId)).rejects.toThrow(error);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
