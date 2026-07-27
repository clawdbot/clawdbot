// Backup verify tests cover archive inspection, gzip validation, and corrupted backup diagnostics.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { gzipSync } from "node:zlib";
import * as tar from "tar";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { buildBackupArchivePath, buildBackupArchiveRoot } from "./backup-shared.js";
import { backupVerifyCommand, testApi } from "./backup-verify.js";

const TEST_ARCHIVE_ROOT = "2026-03-09T00-00-00.000Z-openclaw-backup";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const createBackupVerifyRuntime = () => ({
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
});

function createBackupManifest(
  assetArchivePath: string,
  archiveRoot = TEST_ARCHIVE_ROOT,
  stateDir = "/tmp/.openclaw",
) {
  return {
    schemaVersion: 1,
    createdAt: "2026-03-09T00:00:00.000Z",
    archiveRoot,
    runtimeVersion: "test",
    platform: process.platform,
    nodeVersion: process.version,
    paths: {
      stateDir,
    },
    assets: [
      {
        kind: "state",
        sourcePath: stateDir,
        archivePath: assetArchivePath,
      },
    ],
  };
}

function encodeTarEntry(params: {
  path: string;
  contents?: string;
  type?: "File" | "Link";
  linkpath?: string;
}): Buffer {
  const body = Buffer.from(params.contents ?? "", "utf8");
  const header = new tar.Header({
    path: params.path,
    type: params.type ?? "File",
    size: params.type === "Link" ? 0 : body.length,
    mode: 0o600,
    uid: 0,
    gid: 0,
    mtime: new Date(0),
    ...(params.linkpath ? { linkpath: params.linkpath } : {}),
  });
  const headerBlock = Buffer.alloc(512);
  header.encode(headerBlock);
  if (params.type === "Link") {
    return headerBlock;
  }
  const padding = Buffer.alloc((512 - (body.length % 512)) % 512);
  return Buffer.concat([headerBlock, body, padding]);
}

function isTarSourcePath(entryPath: string, sourcePath: string): boolean {
  return path.resolve(entryPath) === path.resolve(sourcePath);
}

async function createArchiveWithManifestContent(
  options: {
    tempPrefix: string;
    manifestContent: string;
    payloadArchivePath?: string;
  },
  run: (archivePath: string) => Promise<void>,
) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), options.tempPrefix));
  const archivePath = path.join(tempDir, "broken.tar.gz");
  const manifestPath = path.join(tempDir, "manifest.json");
  const payloadPath = path.join(tempDir, "payload.txt");
  const payloadArchivePath =
    options.payloadArchivePath ?? `${TEST_ARCHIVE_ROOT}/payload/posix/tmp/.openclaw/payload.txt`;
  try {
    await fs.writeFile(manifestPath, options.manifestContent, "utf8");
    await fs.writeFile(payloadPath, "payload\n", "utf8");
    await tar.c(
      {
        file: archivePath,
        gzip: true,
        portable: true,
        preservePaths: true,
        onWriteEntry: (entry) => {
          if (isTarSourcePath(entry.path, manifestPath)) {
            entry.path = `${TEST_ARCHIVE_ROOT}/manifest.json`;
            return;
          }
          if (isTarSourcePath(entry.path, payloadPath)) {
            entry.path = payloadArchivePath;
          }
        },
      },
      [manifestPath, payloadPath],
    );
    await run(archivePath);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function withBrokenArchiveFixture(
  options: {
    tempPrefix: string;
    manifestAssetArchivePath: string;
    manifest?: ReturnType<typeof createBackupManifest>;
    payloads: Array<{ fileName: string; contents: string | Uint8Array; archivePath?: string }>;
    buildTarEntries?: (paths: { manifestPath: string; payloadPaths: string[] }) => string[];
  },
  run: (archivePath: string) => Promise<void>,
) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), options.tempPrefix));
  const archivePath = path.join(tempDir, "broken.tar.gz");
  const manifestPath = path.join(tempDir, "manifest.json");
  const payloadSpecs = await Promise.all(
    options.payloads.map(async (payload) => {
      const payloadPath = path.join(tempDir, payload.fileName);
      await fs.writeFile(payloadPath, payload.contents, "utf8");
      return {
        path: payloadPath,
        archivePath: payload.archivePath ?? options.manifestAssetArchivePath,
      };
    }),
  );
  const payloadEntryPathBySource = new Map(
    payloadSpecs.map((payload) => [path.resolve(payload.path), payload.archivePath]),
  );

  try {
    await fs.writeFile(
      manifestPath,
      `${JSON.stringify(options.manifest ?? createBackupManifest(options.manifestAssetArchivePath), null, 2)}\n`,
      "utf8",
    );
    await tar.c(
      {
        file: archivePath,
        gzip: true,
        portable: true,
        preservePaths: true,
        onWriteEntry: (entry) => {
          if (isTarSourcePath(entry.path, manifestPath)) {
            entry.path = `${TEST_ARCHIVE_ROOT}/manifest.json`;
            return;
          }
          const payloadEntryPath = payloadEntryPathBySource.get(path.resolve(entry.path));
          if (payloadEntryPath) {
            entry.path = payloadEntryPath;
          }
        },
      },
      options.buildTarEntries?.({
        manifestPath,
        payloadPaths: payloadSpecs.map((payload) => payload.path),
      }) ?? [manifestPath, ...payloadSpecs.map((payload) => payload.path)],
    );
    await run(archivePath);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function createSqlitePayload(setup: (database: DatabaseSync) => void): Promise<Buffer> {
  const tempDir = tempDirs.make("openclaw-backup-verify-sqlite-db-");
  const databasePath = path.join(tempDir, "snapshot.sqlite");
  try {
    const sqlite = requireNodeSqlite();
    const database = new sqlite.DatabaseSync(databasePath);
    try {
      setup(database);
    } finally {
      database.close();
    }
    return await fs.readFile(databasePath);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

describe("backupVerifyCommand", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
  });

  it("verifies a valid backup archive", async () => {
    const archiveDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-verify-out-"));
    try {
      const runtime = createBackupVerifyRuntime();
      const nowMs = Date.UTC(2026, 2, 9, 0, 0, 0);
      const archiveRoot = buildBackupArchiveRoot(nowMs);
      const archivePath = path.join(archiveDir, "backup.tar.gz");
      const manifestPath = path.join(archiveDir, "manifest.json");
      const payloadPath = path.join(archiveDir, "state.txt");
      const payloadArchivePath = `${archiveRoot}/payload/posix/tmp/.openclaw/state.txt`;
      await fs.writeFile(
        manifestPath,
        `${JSON.stringify(createBackupManifest(payloadArchivePath, archiveRoot), null, 2)}\n`,
        "utf8",
      );
      await fs.writeFile(payloadPath, "hello\n", "utf8");
      await tar.c(
        {
          file: archivePath,
          gzip: true,
          portable: true,
          preservePaths: true,
          onWriteEntry: (entry) => {
            if (isTarSourcePath(entry.path, manifestPath)) {
              entry.path = `${archiveRoot}/manifest.json`;
              return;
            }
            if (isTarSourcePath(entry.path, payloadPath)) {
              entry.path = payloadArchivePath;
            }
          },
        },
        [manifestPath, payloadPath],
      );
      const verified = await backupVerifyCommand(runtime, { archive: archivePath });

      expect(verified.ok).toBe(true);
      expect(verified.archiveRoot).toBe(archiveRoot);
      expect(verified.assetCount).toBeGreaterThan(0);
    } finally {
      await fs.rm(archiveDir, { recursive: true, force: true });
    }
  });

  it("verifies SQLite integrity and the canonical shared-state role", async () => {
    const stateAssetArchivePath = `${TEST_ARCHIVE_ROOT}/payload/posix/tmp/.openclaw`;
    const sqliteArchivePath = `${stateAssetArchivePath}/state/openclaw.sqlite`;
    const sqlitePayload = await createSqlitePayload((database) => {
      database.exec(`
        CREATE TABLE schema_meta (
          meta_key TEXT NOT NULL PRIMARY KEY,
          role TEXT NOT NULL
        );
        INSERT INTO schema_meta (meta_key, role) VALUES ('primary', 'global');
      `);
    });

    await withBrokenArchiveFixture(
      {
        tempPrefix: "openclaw-backup-valid-sqlite-",
        manifestAssetArchivePath: stateAssetArchivePath,
        payloads: [
          {
            fileName: "openclaw.sqlite",
            contents: sqlitePayload,
            archivePath: sqliteArchivePath,
          },
        ],
      },
      async (archivePath) => {
        const runtime = createBackupVerifyRuntime();
        await expect(backupVerifyCommand(runtime, { archive: archivePath })).resolves.toMatchObject(
          {
            ok: true,
          },
        );
      },
    );
  });

  it.runIf(process.platform === "win32")(
    "verifies a canonical global SQLite backup beyond MAX_PATH",
    async () => {
      const stateDir = String.raw`C:\Users\OpenClaw\.openclaw`;
      const stateAssetArchivePath = buildBackupArchivePath(TEST_ARCHIVE_ROOT, stateDir);
      const sqliteArchivePath = `${stateAssetArchivePath}/state/openclaw.sqlite`;
      const sqlitePayload = await createSqlitePayload((database) => {
        database.exec(`
          CREATE TABLE schema_meta (
            meta_key TEXT NOT NULL PRIMARY KEY,
            role TEXT NOT NULL
          );
          INSERT INTO schema_meta (meta_key, role) VALUES ('primary', 'global');
        `);
      });

      await withBrokenArchiveFixture(
        {
          tempPrefix: "openclaw-backup-windows-long-path-",
          manifestAssetArchivePath: stateAssetArchivePath,
          manifest: createBackupManifest(stateAssetArchivePath, TEST_ARCHIVE_ROOT, stateDir),
          payloads: [
            {
              fileName: "openclaw.sqlite",
              contents: sqlitePayload,
              archivePath: sqliteArchivePath,
            },
          ],
        },
        async (archivePath) => {
          const verificationTempBase = tempDirs.make("openclaw-backup-verify-long-path-");
          let verificationTempRoot = verificationTempBase;
          const resolveMinimumExtractedPath = () =>
            path.join(
              verificationTempRoot,
              "openclaw-backup-verify-sqlite-",
              ...sqliteArchivePath.split("/"),
            );
          while (resolveMinimumExtractedPath().length <= 260) {
            verificationTempRoot = path.join(verificationTempRoot, `segment-${"x".repeat(24)}`);
          }
          await fs.mkdir(verificationTempRoot, { recursive: true });
          expect(verificationTempRoot.startsWith("\\\\?\\")).toBe(false);
          expect(resolveMinimumExtractedPath().length).toBeGreaterThan(260);

          const tmpdirSpy = vi.spyOn(os, "tmpdir").mockReturnValue(verificationTempRoot);
          try {
            const runtime = createBackupVerifyRuntime();
            await expect(
              backupVerifyCommand(runtime, { archive: archivePath }),
            ).resolves.toMatchObject({ ok: true });
            await expect(fs.readdir(verificationTempRoot)).resolves.toEqual([]);
          } finally {
            tmpdirSpy.mockRestore();
          }
        },
      );
    },
  );

  it("rejects canonical SQLite snapshots with foreign-key violations", async () => {
    const stateAssetArchivePath = `${TEST_ARCHIVE_ROOT}/payload/posix/tmp/.openclaw`;
    const sqliteArchivePath = `${stateAssetArchivePath}/state/openclaw.sqlite`;
    const sqlitePayload = await createSqlitePayload((database) => {
      database.exec(`
        PRAGMA foreign_keys = OFF;
        CREATE TABLE schema_meta (
          meta_key TEXT NOT NULL PRIMARY KEY,
          role TEXT NOT NULL
        );
        INSERT INTO schema_meta (meta_key, role) VALUES ('primary', 'global');
        CREATE TABLE parents (id INTEGER PRIMARY KEY);
        CREATE TABLE children (
          id INTEGER PRIMARY KEY,
          parent_id INTEGER NOT NULL REFERENCES parents(id)
        );
        INSERT INTO children (id, parent_id) VALUES (1, 99);
      `);
    });

    await withBrokenArchiveFixture(
      {
        tempPrefix: "openclaw-backup-foreign-key-",
        manifestAssetArchivePath: stateAssetArchivePath,
        payloads: [
          {
            fileName: "openclaw.sqlite",
            contents: sqlitePayload,
            archivePath: sqliteArchivePath,
          },
        ],
      },
      async (archivePath) => {
        const runtime = createBackupVerifyRuntime();
        await expect(backupVerifyCommand(runtime, { archive: archivePath })).rejects.toThrow(
          /Backup SQLite snapshot failed verification.*foreign_key_check failed.*children row 1 references parents \(foreign key 0\)/iu,
        );
      },
    );
  });

  it("does not interpret plugin-owned SQLite schemas without their owner runtime", async () => {
    const stateAssetArchivePath = `${TEST_ARCHIVE_ROOT}/payload/posix/tmp/.openclaw`;
    const sqliteArchivePath = `${stateAssetArchivePath}/plugins/dedicated/custom.sqlite`;
    const sqlitePayload = await createSqlitePayload((database) => {
      database.function("plugin_double", { deterministic: true }, (value) => Number(value) * 2);
      database.exec(`
        CREATE TABLE records (value INTEGER NOT NULL);
        INSERT INTO records (value) VALUES (1), (2);
        CREATE INDEX records_double ON records(plugin_double(value));
      `);
    });

    await withBrokenArchiveFixture(
      {
        tempPrefix: "openclaw-backup-plugin-owned-sqlite-",
        manifestAssetArchivePath: stateAssetArchivePath,
        payloads: [
          {
            fileName: "custom.sqlite",
            contents: sqlitePayload,
            archivePath: sqliteArchivePath,
          },
        ],
      },
      async (archivePath) => {
        const runtime = createBackupVerifyRuntime();
        await expect(backupVerifyCommand(runtime, { archive: archivePath })).resolves.toMatchObject(
          {
            ok: true,
          },
        );
      },
    );
  });

  it("rejects a structurally valid archive containing a malformed SQLite snapshot", async () => {
    const stateAssetArchivePath = `${TEST_ARCHIVE_ROOT}/payload/posix/tmp/.openclaw`;
    const sqliteArchivePath = `${stateAssetArchivePath}/state/openclaw.sqlite`;
    const invalidSqlite = Buffer.from("not a sqlite database", "utf8");
    expect(invalidSqlite.byteLength).toBe(21);

    await withBrokenArchiveFixture(
      {
        tempPrefix: "openclaw-backup-invalid-sqlite-",
        manifestAssetArchivePath: stateAssetArchivePath,
        payloads: [
          {
            fileName: "openclaw.sqlite",
            contents: invalidSqlite,
            archivePath: sqliteArchivePath,
          },
        ],
      },
      async (archivePath) => {
        const verificationTempRoot = tempDirs.make("openclaw-backup-verify-cleanup-");
        const tmpdirSpy = vi.spyOn(os, "tmpdir").mockReturnValue(verificationTempRoot);
        try {
          const runtime = createBackupVerifyRuntime();
          await expect(backupVerifyCommand(runtime, { archive: archivePath })).rejects.toThrow(
            /Backup SQLite snapshot failed verification.*openclaw\.sqlite/iu,
          );
          await expect(fs.readdir(verificationTempRoot)).resolves.toEqual([]);
        } finally {
          tmpdirSpy.mockRestore();
          await fs.rm(verificationTempRoot, { recursive: true, force: true });
        }
      },
    );
  });

  it("rejects an empty SQLite snapshot instead of accepting a new empty database", async () => {
    const stateAssetArchivePath = `${TEST_ARCHIVE_ROOT}/payload/posix/tmp/.openclaw`;
    const sqliteArchivePath = `${stateAssetArchivePath}/plugins/dedicated/empty.sqlite`;

    await withBrokenArchiveFixture(
      {
        tempPrefix: "openclaw-backup-empty-sqlite-",
        manifestAssetArchivePath: stateAssetArchivePath,
        payloads: [
          {
            fileName: "empty.sqlite",
            contents: new Uint8Array(),
            archivePath: sqliteArchivePath,
          },
        ],
      },
      async (archivePath) => {
        const runtime = createBackupVerifyRuntime();
        await expect(backupVerifyCommand(runtime, { archive: archivePath })).rejects.toThrow(
          /SQLite snapshot is empty.*empty\.sqlite/iu,
        );
      },
    );
  });

  it.each(["-wal", "-WAL"])(
    "rejects SQLite sidecars that could change restored snapshot contents (%s)",
    async (sidecarSuffix) => {
      const stateAssetArchivePath = `${TEST_ARCHIVE_ROOT}/payload/posix/tmp/.openclaw`;
      const sqliteArchivePath = `${stateAssetArchivePath}/state/openclaw.sqlite`;
      const sqlitePayload = await createSqlitePayload((database) => {
        database.exec(`
        CREATE TABLE schema_meta (
          meta_key TEXT NOT NULL PRIMARY KEY,
          role TEXT NOT NULL
        );
        INSERT INTO schema_meta (meta_key, role) VALUES ('primary', 'global');
      `);
      });

      await withBrokenArchiveFixture(
        {
          tempPrefix: "openclaw-backup-sqlite-sidecar-",
          manifestAssetArchivePath: stateAssetArchivePath,
          payloads: [
            {
              fileName: "openclaw.sqlite",
              contents: sqlitePayload,
              archivePath: sqliteArchivePath,
            },
            {
              fileName: "openclaw.sqlite-wal",
              contents: "unverified transaction data",
              archivePath: `${sqliteArchivePath}${sidecarSuffix}`,
            },
          ],
        },
        async (archivePath) => {
          const runtime = createBackupVerifyRuntime();
          await expect(backupVerifyCommand(runtime, { archive: archivePath })).rejects.toThrow(
            /contains a SQLite snapshot sidecar.*openclaw\.sqlite-wal/iu,
          );
        },
      );
    },
  );

  it("rejects case-mangled canonical SQLite paths", async () => {
    const stateAssetArchivePath = `${TEST_ARCHIVE_ROOT}/payload/posix/tmp/.openclaw`;
    const sqliteArchivePath = `${stateAssetArchivePath}/State/OpenClaw.SQLITE`;
    const sqlitePayload = await createSqlitePayload((database) => {
      database.exec(`
        CREATE TABLE schema_meta (
          meta_key TEXT NOT NULL PRIMARY KEY,
          role TEXT NOT NULL
        );
        INSERT INTO schema_meta (meta_key, role) VALUES ('primary', 'global');
      `);
    });

    await withBrokenArchiveFixture(
      {
        tempPrefix: "openclaw-backup-sqlite-case-alias-",
        manifestAssetArchivePath: stateAssetArchivePath,
        payloads: [
          {
            fileName: "openclaw.sqlite",
            contents: sqlitePayload,
            archivePath: sqliteArchivePath,
          },
        ],
      },
      async (archivePath) => {
        const runtime = createBackupVerifyRuntime();
        await expect(backupVerifyCommand(runtime, { archive: archivePath })).rejects.toThrow(
          /case-mangled canonical SQLite path.*State\/OpenClaw\.SQLITE/u,
        );
      },
    );
  });

  it("rejects case-mangled aliases of the state asset root", async () => {
    const stateAssetArchivePath = `${TEST_ARCHIVE_ROOT}/payload/posix/tmp/.openclaw`;
    const statePayloadArchivePath = `${stateAssetArchivePath}/payload.txt`;
    const aliasSidecarArchivePath = `${TEST_ARCHIVE_ROOT}/PAYLOAD/posix/tmp/.openclaw/plugins/dedicated/custom.sqlite-wal`;

    await withBrokenArchiveFixture(
      {
        tempPrefix: "openclaw-backup-state-root-case-alias-",
        manifestAssetArchivePath: stateAssetArchivePath,
        payloads: [
          {
            fileName: "payload.txt",
            contents: "payload\n",
            archivePath: statePayloadArchivePath,
          },
          {
            fileName: "custom.sqlite-wal",
            contents: "unverified transaction data",
            archivePath: aliasSidecarArchivePath,
          },
        ],
      },
      async (archivePath) => {
        const runtime = createBackupVerifyRuntime();
        await expect(backupVerifyCommand(runtime, { archive: archivePath })).rejects.toThrow(
          /case-mangled state asset path.*PAYLOAD.*custom\.sqlite-wal/iu,
        );
      },
    );
  });

  it("rejects a truncated SQLite snapshot with a valid database header", async () => {
    const stateAssetArchivePath = `${TEST_ARCHIVE_ROOT}/payload/posix/tmp/.openclaw`;
    const sqliteArchivePath = `${stateAssetArchivePath}/plugins/dedicated/corrupt.sqlite`;
    const sqlitePayload = await createSqlitePayload((database) => {
      database.exec("CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT NOT NULL);");
      const insert = database.prepare("INSERT INTO records (value) VALUES (?)");
      for (let index = 0; index < 100; index += 1) {
        insert.run(`record-${index}-${"x".repeat(100)}`);
      }
    });
    const encodedPageSize = sqlitePayload.readUInt16BE(16);
    const pageSize = encodedPageSize === 1 ? 65_536 : encodedPageSize;
    const truncatedPayload = sqlitePayload.subarray(
      0,
      sqlitePayload.byteLength - Math.floor(pageSize / 2),
    );
    expect(truncatedPayload.subarray(0, 16).toString("utf8")).toBe("SQLite format 3\u0000");
    expect(truncatedPayload.byteLength % pageSize).not.toBe(0);

    await withBrokenArchiveFixture(
      {
        tempPrefix: "openclaw-backup-corrupt-sqlite-",
        manifestAssetArchivePath: stateAssetArchivePath,
        payloads: [
          {
            fileName: "corrupt.sqlite",
            contents: truncatedPayload,
            archivePath: sqliteArchivePath,
          },
        ],
      },
      async (archivePath) => {
        const runtime = createBackupVerifyRuntime();
        await expect(backupVerifyCommand(runtime, { archive: archivePath })).rejects.toThrow(
          /Backup SQLite snapshot failed verification.*corrupt\.sqlite/iu,
        );
      },
    );
  });

  it("rejects a page-aligned truncated plugin SQLite snapshot", async () => {
    const stateAssetArchivePath = `${TEST_ARCHIVE_ROOT}/payload/posix/tmp/.openclaw`;
    const sqliteArchivePath = `${stateAssetArchivePath}/plugins/dedicated/corrupt.sqlite`;
    const sqlitePayload = await createSqlitePayload((database) => {
      database.exec("CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT NOT NULL);");
      const insert = database.prepare("INSERT INTO records (value) VALUES (?)");
      for (let index = 0; index < 100; index += 1) {
        insert.run(`record-${index}-${"x".repeat(100)}`);
      }
    });
    const encodedPageSize = sqlitePayload.readUInt16BE(16);
    const pageSize = encodedPageSize === 1 ? 65_536 : encodedPageSize;
    const declaredPageCount = sqlitePayload.readUInt32BE(28);
    expect(sqlitePayload.readUInt32BE(24)).toBe(sqlitePayload.readUInt32BE(92));
    expect(declaredPageCount).toBeGreaterThan(1);
    expect(declaredPageCount).toBe(sqlitePayload.byteLength / pageSize);
    const truncatedPayload = sqlitePayload.subarray(0, sqlitePayload.byteLength - pageSize);
    expect(truncatedPayload.byteLength % pageSize).toBe(0);

    await withBrokenArchiveFixture(
      {
        tempPrefix: "openclaw-backup-page-truncated-sqlite-",
        manifestAssetArchivePath: stateAssetArchivePath,
        payloads: [
          {
            fileName: "corrupt.sqlite",
            contents: truncatedPayload,
            archivePath: sqliteArchivePath,
          },
        ],
      },
      async (archivePath) => {
        const runtime = createBackupVerifyRuntime();
        await expect(backupVerifyCommand(runtime, { archive: archivePath })).rejects.toThrow(
          /Backup SQLite snapshot failed verification.*corrupt\.sqlite/iu,
        );
      },
    );
  });

  it("rejects a canonical SQLite snapshot with the wrong database role", async () => {
    const stateAssetArchivePath = `${TEST_ARCHIVE_ROOT}/payload/posix/tmp/.openclaw`;
    const sqliteArchivePath = `${stateAssetArchivePath}/state/openclaw.sqlite`;
    const sqlitePayload = await createSqlitePayload((database) => {
      database.exec(`
        CREATE TABLE schema_meta (
          meta_key TEXT NOT NULL PRIMARY KEY,
          role TEXT NOT NULL
        );
        INSERT INTO schema_meta (meta_key, role) VALUES ('primary', 'agent');
      `);
    });

    await withBrokenArchiveFixture(
      {
        tempPrefix: "openclaw-backup-wrong-sqlite-role-",
        manifestAssetArchivePath: stateAssetArchivePath,
        payloads: [
          {
            fileName: "openclaw.sqlite",
            contents: sqlitePayload,
            archivePath: sqliteArchivePath,
          },
        ],
      },
      async (archivePath) => {
        const runtime = createBackupVerifyRuntime();
        await expect(backupVerifyCommand(runtime, { archive: archivePath })).rejects.toThrow(
          /has role agent; expected global/iu,
        );
      },
    );
  });

  it("validates a canonical agent database whose agent id is node_modules", async () => {
    const stateAssetArchivePath = `${TEST_ARCHIVE_ROOT}/payload/posix/tmp/.openclaw`;
    const sqliteArchivePath = `${stateAssetArchivePath}/agents/node_modules/agent/openclaw-agent.sqlite`;
    const sqlitePayload = await createSqlitePayload((database) => {
      database.exec(`
        CREATE TABLE schema_meta (
          meta_key TEXT NOT NULL PRIMARY KEY,
          role TEXT NOT NULL
        );
        INSERT INTO schema_meta (meta_key, role) VALUES ('primary', 'global');
      `);
    });

    await withBrokenArchiveFixture(
      {
        tempPrefix: "openclaw-backup-agent-node-modules-",
        manifestAssetArchivePath: stateAssetArchivePath,
        payloads: [
          {
            fileName: "openclaw-agent.sqlite",
            contents: sqlitePayload,
            archivePath: sqliteArchivePath,
          },
        ],
      },
      async (archivePath) => {
        const runtime = createBackupVerifyRuntime();
        await expect(backupVerifyCommand(runtime, { archive: archivePath })).rejects.toThrow(
          /has role global; expected agent/iu,
        );
      },
    );
  });

  it("rejects a state asset root that does not encode its declared source path", async () => {
    const declaredStateAssetRoot = `${TEST_ARCHIVE_ROOT}/payload`;
    const sqliteArchivePath = `${declaredStateAssetRoot}/posix/tmp/.openclaw/state/openclaw.sqlite`;
    const sqlitePayload = await createSqlitePayload((database) => {
      database.exec(`
        CREATE TABLE schema_meta (
          meta_key TEXT NOT NULL PRIMARY KEY,
          role TEXT NOT NULL
        );
        INSERT INTO schema_meta (meta_key, role) VALUES ('primary', 'agent');
      `);
    });

    await withBrokenArchiveFixture(
      {
        tempPrefix: "openclaw-backup-state-root-bypass-",
        manifestAssetArchivePath: declaredStateAssetRoot,
        manifest: createBackupManifest(declaredStateAssetRoot),
        payloads: [
          {
            fileName: "openclaw.sqlite",
            contents: sqlitePayload,
            archivePath: sqliteArchivePath,
          },
        ],
      },
      async (archivePath) => {
        const runtime = createBackupVerifyRuntime();
        await expect(backupVerifyCommand(runtime, { archive: archivePath })).rejects.toThrow(
          /state asset archivePath does not match its sourcePath/iu,
        );
      },
    );
  });

  it("rejects SQLite extraction before writing when temporary space is insufficient", () => {
    expect(() =>
      testApi.assertSqliteExtractionBudget({
        entries: [
          {
            raw: "backup/payload/state/openclaw.sqlite",
            normalized: "backup/payload/state/openclaw.sqlite",
            stateAssetRoot: "backup/payload",
            type: "File",
            size: 2 * 1024 * 1024,
          },
        ],
        tempRoot: "/tmp",
        readDiskSpace: () => ({
          targetPath: "/tmp",
          checkedPath: "/tmp",
          availableBytes: 128 * 1024 * 1024,
          totalBytes: 1024 * 1024 * 1024,
        }),
      }),
    ).toThrow(/only 128 MiB is available/iu);
  });

  it("rejects SQLite extraction beyond the verification hard limit", () => {
    expect(() =>
      testApi.assertSqliteExtractionBudget({
        entries: [
          {
            raw: "backup/payload/state/openclaw.sqlite",
            normalized: "backup/payload/state/openclaw.sqlite",
            stateAssetRoot: "backup/payload",
            type: "File",
            size: 64 * 1024 * 1024 * 1024 + 1,
          },
        ],
        tempRoot: "/tmp",
        readDiskSpace: () => null,
      }),
    ).toThrow(/verification limit is 64 GiB/iu);
  });

  it("ignores package-owned and transient SQLite-shaped state files", async () => {
    const stateAssetArchivePath = `${TEST_ARCHIVE_ROOT}/payload/posix/tmp/.openclaw`;
    const transientId = "11111111-2222-3333-4444-555555555555";
    const invalidSqlite = "not a sqlite database";

    await withBrokenArchiveFixture(
      {
        tempPrefix: "openclaw-backup-excluded-sqlite-",
        manifestAssetArchivePath: stateAssetArchivePath,
        payloads: [
          {
            fileName: "root-fixture.sqlite",
            contents: invalidSqlite,
            archivePath: `${stateAssetArchivePath}/node_modules/root-dep/fixture.sqlite`,
          },
          {
            fileName: "root-fixture.sqlite-wal",
            contents: invalidSqlite,
            archivePath: `${stateAssetArchivePath}/node_modules/root-dep/fixture.sqlite-wal`,
          },
          {
            fileName: "managed-fixture.sqlite",
            contents: invalidSqlite,
            archivePath: `${stateAssetArchivePath}/npm/projects/demo/node_modules/dep/fixture.sqlite`,
          },
          {
            fileName: "reindex-lock.sqlite",
            contents: invalidSqlite,
            archivePath: `${stateAssetArchivePath}/memory/main.sqlite.reindex-lock.sqlite`,
          },
          {
            fileName: "reindex-tmp",
            contents: invalidSqlite,
            archivePath: `${stateAssetArchivePath}/memory/main.sqlite.tmp-${transientId}`,
          },
          {
            fileName: "reindex-backup",
            contents: invalidSqlite,
            archivePath: `${stateAssetArchivePath}/memory/main.sqlite.backup-${transientId}`,
          },
          {
            fileName: "memory-reindex",
            contents: invalidSqlite,
            archivePath: `${stateAssetArchivePath}/agents/main/agent.sqlite.memory-reindex-${transientId}`,
          },
        ],
      },
      async (archivePath) => {
        const runtime = createBackupVerifyRuntime();
        await expect(backupVerifyCommand(runtime, { archive: archivePath })).resolves.toMatchObject(
          {
            ok: true,
          },
        );
      },
    );
  });

  it("fails when the archive does not contain a manifest", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-no-manifest-"));
    const archivePath = path.join(tempDir, "broken.tar.gz");
    try {
      const root = path.join(tempDir, "root");
      await fs.mkdir(path.join(root, "payload"), { recursive: true });
      await fs.writeFile(path.join(root, "payload", "data.txt"), "x\n", "utf8");
      await tar.c({ file: archivePath, gzip: true, cwd: tempDir }, ["root"]);

      const runtime = createBackupVerifyRuntime();
      await expect(backupVerifyCommand(runtime, { archive: archivePath })).rejects.toThrow(
        /expected exactly one backup manifest entry/i,
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("fails when the manifest references a missing asset payload", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-missing-asset-"));
    const archivePath = path.join(tempDir, "broken.tar.gz");
    try {
      const rootName = "2026-03-09T00-00-00.000Z-openclaw-backup";
      const root = path.join(tempDir, rootName);
      await fs.mkdir(root, { recursive: true });
      const manifest = {
        schemaVersion: 1,
        createdAt: "2026-03-09T00:00:00.000Z",
        archiveRoot: rootName,
        runtimeVersion: "test",
        platform: process.platform,
        nodeVersion: process.version,
        assets: [
          {
            kind: "state",
            sourcePath: "/tmp/.openclaw",
            archivePath: `${rootName}/payload/posix/tmp/.openclaw`,
          },
        ],
      };
      await fs.writeFile(
        path.join(root, "manifest.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
      );
      await tar.c({ file: archivePath, gzip: true, cwd: tempDir }, [rootName]);

      const runtime = createBackupVerifyRuntime();
      await expect(backupVerifyCommand(runtime, { archive: archivePath })).rejects.toThrow(
        /missing payload for manifest asset/i,
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("reports malformed manifest JSON without leaking parser internals", async () => {
    await createArchiveWithManifestContent(
      {
        tempPrefix: "openclaw-backup-bad-manifest-json-",
        manifestContent: '{"schemaVersion":1,',
      },
      async (archivePath) => {
        const runtime = createBackupVerifyRuntime();
        await expect(backupVerifyCommand(runtime, { archive: archivePath })).rejects.toThrow(
          /^Backup manifest is not valid JSON\.$/u,
        );
        await expect(backupVerifyCommand(runtime, { archive: archivePath })).rejects.not.toThrow(
          /position|Unexpected|Expected|SyntaxError/u,
        );
      },
    );
  });

  it("rejects oversized manifest entries without retaining the full body", async () => {
    await createArchiveWithManifestContent(
      {
        tempPrefix: "openclaw-backup-huge-manifest-",
        manifestContent: "x".repeat(1024 * 1024 + 1),
      },
      async (archivePath) => {
        const runtime = createBackupVerifyRuntime();
        await expect(backupVerifyCommand(runtime, { archive: archivePath })).rejects.toThrow(
          /Backup manifest exceeds 1048576 byte limit/,
        );
      },
    );
  });

  it("rejects unsafe archive paths", async () => {
    for (const { tempPrefix, archivePath, error } of [
      {
        tempPrefix: "openclaw-backup-traversal-",
        archivePath: `${TEST_ARCHIVE_ROOT}/payload/../escaped.txt`,
        error: /path traversal segments/i,
      },
      {
        tempPrefix: "openclaw-backup-backslash-",
        archivePath: `${TEST_ARCHIVE_ROOT}/payload\\escaped.txt`,
        error: /forward slashes/i,
      },
    ]) {
      await withBrokenArchiveFixture(
        {
          tempPrefix,
          manifestAssetArchivePath: archivePath,
          payloads: [{ fileName: "payload.txt", contents: "payload\n", archivePath }],
        },
        async (brokenArchivePath) => {
          const runtime = createBackupVerifyRuntime();
          await expect(
            backupVerifyCommand(runtime, { archive: brokenArchivePath }),
          ).rejects.toThrow(error);
        },
      );
    }
  });

  it("rejects unsafe hardlink targets", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-linkpath-"));
    const archivePath = path.join(tempDir, "broken.tar.gz");
    const payloadArchivePath = `${TEST_ARCHIVE_ROOT}/payload/posix/tmp/.openclaw/target.txt`;
    const hardlinkArchivePath = `${TEST_ARCHIVE_ROOT}/payload/posix/tmp/.openclaw/hardlink.txt`;
    try {
      const archive = gzipSync(
        Buffer.concat([
          encodeTarEntry({
            path: `${TEST_ARCHIVE_ROOT}/manifest.json`,
            contents: `${JSON.stringify(createBackupManifest(payloadArchivePath), null, 2)}\n`,
          }),
          encodeTarEntry({ path: payloadArchivePath, contents: "payload\n" }),
          encodeTarEntry({
            path: hardlinkArchivePath,
            type: "Link",
            linkpath: `${TEST_ARCHIVE_ROOT}/payload/../escaped.txt`,
          }),
          Buffer.alloc(1024),
        ]),
      );
      await fs.writeFile(archivePath, archive);

      const runtime = createBackupVerifyRuntime();
      await expect(backupVerifyCommand(runtime, { archive: archivePath })).rejects.toThrow(
        /hardlink target.*path traversal segments/i,
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("accepts root-relative internal hardlink targets from older backups", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-rootless-linkpath-"));
    const archivePath = path.join(tempDir, "backup.tar.gz");
    const rootRelativeTargetPath = "payload/posix/tmp/.openclaw/target.txt";
    const payloadArchivePath = `${TEST_ARCHIVE_ROOT}/${rootRelativeTargetPath}`;
    const hardlinkArchivePath = `${TEST_ARCHIVE_ROOT}/payload/posix/tmp/.openclaw/hardlink.txt`;
    try {
      const archive = gzipSync(
        Buffer.concat([
          encodeTarEntry({
            path: `${TEST_ARCHIVE_ROOT}/manifest.json`,
            contents: `${JSON.stringify(createBackupManifest(payloadArchivePath), null, 2)}\n`,
          }),
          encodeTarEntry({ path: payloadArchivePath, contents: "payload\n" }),
          encodeTarEntry({
            path: hardlinkArchivePath,
            type: "Link",
            linkpath: rootRelativeTargetPath,
          }),
          Buffer.alloc(1024),
        ]),
      );
      await fs.writeFile(archivePath, archive);

      const runtime = createBackupVerifyRuntime();
      await expect(backupVerifyCommand(runtime, { archive: archivePath })).resolves.toMatchObject({
        ok: true,
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects hardlink targets missing from archive entries", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-missing-linkpath-"));
    const archivePath = path.join(tempDir, "broken.tar.gz");
    const payloadArchivePath = `${TEST_ARCHIVE_ROOT}/payload/posix/tmp/.openclaw/target.txt`;
    const hardlinkArchivePath = `${TEST_ARCHIVE_ROOT}/payload/posix/tmp/.openclaw/hardlink.txt`;
    const missingTargetPath = `${TEST_ARCHIVE_ROOT}/payload/posix/tmp/.openclaw/missing-target.txt`;
    try {
      const archive = gzipSync(
        Buffer.concat([
          encodeTarEntry({
            path: `${TEST_ARCHIVE_ROOT}/manifest.json`,
            contents: `${JSON.stringify(createBackupManifest(payloadArchivePath), null, 2)}\n`,
          }),
          encodeTarEntry({ path: payloadArchivePath, contents: "payload\n" }),
          encodeTarEntry({
            path: hardlinkArchivePath,
            type: "Link",
            linkpath: missingTargetPath,
          }),
          Buffer.alloc(1024),
        ]),
      );
      await fs.writeFile(archivePath, archive);

      const runtime = createBackupVerifyRuntime();
      await expect(backupVerifyCommand(runtime, { archive: archivePath })).rejects.toThrow(
        /hardlink target is missing from archive entries/i,
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("ignores payload manifest.json files when locating the backup manifest", async () => {
    const archiveDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-verify-out-"));
    try {
      const runtime = createBackupVerifyRuntime();
      const nowMs = Date.UTC(2026, 2, 9, 2, 0, 0);
      const archiveRoot = buildBackupArchiveRoot(nowMs);
      const archivePath = path.join(archiveDir, "backup.tar.gz");
      const manifestPath = path.join(archiveDir, "manifest.json");
      const statePayloadPath = path.join(archiveDir, "state.txt");
      const workspaceManifestPayloadPath = path.join(archiveDir, "workspace-manifest.json");
      const stateArchivePath = `${archiveRoot}/payload/posix/tmp/.openclaw/state.txt`;
      const workspaceArchivePath = `${archiveRoot}/payload/posix/tmp/workspace/manifest.json`;
      await fs.writeFile(
        manifestPath,
        `${JSON.stringify(
          {
            ...createBackupManifest(stateArchivePath, archiveRoot),
            assets: [
              {
                kind: "state",
                sourcePath: "/tmp/.openclaw",
                archivePath: stateArchivePath,
              },
              {
                kind: "workspace",
                sourcePath: "/tmp/workspace",
                archivePath: workspaceArchivePath,
              },
            ],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await fs.writeFile(statePayloadPath, "hello\n", "utf8");
      await fs.writeFile(
        workspaceManifestPayloadPath,
        JSON.stringify({ name: "workspace-payload" }),
        "utf8",
      );
      await tar.c(
        {
          file: archivePath,
          gzip: true,
          portable: true,
          preservePaths: true,
          onWriteEntry: (entry) => {
            if (isTarSourcePath(entry.path, manifestPath)) {
              entry.path = `${archiveRoot}/manifest.json`;
              return;
            }
            if (isTarSourcePath(entry.path, statePayloadPath)) {
              entry.path = stateArchivePath;
              return;
            }
            if (isTarSourcePath(entry.path, workspaceManifestPayloadPath)) {
              entry.path = workspaceArchivePath;
            }
          },
        },
        [manifestPath, statePayloadPath, workspaceManifestPayloadPath],
      );
      const verified = await backupVerifyCommand(runtime, { archive: archivePath });

      expect(verified.ok).toBe(true);
      expect(verified.assetCount).toBeGreaterThanOrEqual(2);
    } finally {
      await fs.rm(archiveDir, { recursive: true, force: true });
    }
  });

  it("rejects duplicate manifest and payload entries", async () => {
    const payloadArchivePath = `${TEST_ARCHIVE_ROOT}/payload/posix/tmp/.openclaw/payload.txt`;
    for (const options of [
      {
        tempPrefix: "openclaw-backup-duplicate-manifest-",
        payloads: [{ fileName: "payload.txt", contents: "payload\n" }],
        buildTarEntries: ({
          manifestPath,
          payloadPaths,
        }: {
          manifestPath: string;
          payloadPaths: string[];
        }) => [manifestPath, manifestPath, ...payloadPaths],
        error: /expected exactly one backup manifest entry, found 2/i,
      },
      {
        tempPrefix: "openclaw-backup-duplicate-payload-",
        payloads: [
          { fileName: "payload-a.txt", contents: "payload-a\n", archivePath: payloadArchivePath },
          { fileName: "payload-b.txt", contents: "payload-b\n", archivePath: payloadArchivePath },
        ],
        error: /duplicate entry path/i,
      },
      {
        tempPrefix: "openclaw-backup-portable-path-collision-",
        payloads: [
          { fileName: "payload-a.txt", contents: "payload-a\n", archivePath: payloadArchivePath },
          {
            fileName: "payload-b.txt",
            contents: "payload-b\n",
            archivePath: payloadArchivePath.toUpperCase(),
          },
        ],
        error: /portable path collision/i,
      },
    ]) {
      await withBrokenArchiveFixture(
        {
          tempPrefix: options.tempPrefix,
          manifestAssetArchivePath: payloadArchivePath,
          payloads: options.payloads,
          buildTarEntries: options.buildTarEntries,
        },
        async (archivePath) => {
          const runtime = createBackupVerifyRuntime();
          await expect(backupVerifyCommand(runtime, { archive: archivePath })).rejects.toThrow(
            options.error,
          );
        },
      );
    }
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
