// Matrix tests cover doctor contract state migrations.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type {
  OpenKeyedStoreOptions,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type { PluginDoctorStateMigrationContext } from "openclaw/plugin-sdk/runtime-doctor";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stateMigrations } from "./doctor-contract-api.js";
import { SqliteBackedMatrixSyncStore } from "./src/matrix/client/file-sync-store.js";
import {
  readMatrixIdbSnapshotJson,
  readMatrixLegacyCryptoMigrationState,
  readMatrixRecoveryKeyState,
} from "./src/matrix/crypto-state-store.js";
import { installMatrixTestRuntime } from "./src/test-runtime.js";

function createContext(): PluginDoctorStateMigrationContext {
  return {
    openPluginStateKeyedStore: <T>(options: OpenKeyedStoreOptions): PluginStateKeyedStore<T> =>
      createPluginStateKeyedStoreForTests<T>("matrix", options),
  };
}

function createMigrationParams(stateDir: string) {
  return {
    config: {} as OpenClawConfig,
    env: { OPENCLAW_STATE_DIR: stateDir },
    stateDir,
    oauthDir: path.join(stateDir, "oauth"),
    context: createContext(),
  };
}

function migrationById(id: string) {
  const migration = stateMigrations.find((entry) => entry.id === id);
  if (!migration) {
    throw new Error(`missing migration ${id}`);
  }
  return migration;
}

describe("matrix doctor contract state migrations", () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    resetPluginStateStoreForTests();
    installMatrixTestRuntime();
  });

  afterEach(() => {
    resetPluginStateStoreForTests();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("migrates legacy sync cache JSON to SQLite plugin state", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-matrix-doctor-"));
    tempDirs.push(stateDir);
    const storageRootDir = path.join(
      stateDir,
      "matrix",
      "accounts",
      "default",
      "matrix.example.org__bot",
      "token-hash",
    );
    fs.mkdirSync(storageRootDir, { recursive: true });
    fs.writeFileSync(
      path.join(storageRootDir, "bot-storage.json"),
      JSON.stringify({
        version: 1,
        savedSync: {
          nextBatch: "legacy-token",
          accountData: [],
          roomsData: {
            join: {},
            invite: {},
            leave: {},
            knock: {},
          },
        },
        cleanShutdown: true,
      }),
    );

    const migration = migrationById("matrix-sync-cache-json-to-plugin-state");
    await expect(migration.detectLegacyState(createMigrationParams(stateDir))).resolves.toEqual({
      preview: [`Matrix sync cache JSON can migrate to SQLite: ${storageRootDir}`],
    });

    await expect(migration.migrateLegacyState(createMigrationParams(stateDir))).resolves.toEqual({
      changes: [
        `Migrated Matrix sync cache JSON to SQLite for ${storageRootDir}`,
        `Archived Matrix sync cache legacy source -> ${path.join(storageRootDir, "bot-storage.json")}.migrated`,
      ],
      warnings: [],
    });

    const store = new SqliteBackedMatrixSyncStore(storageRootDir);
    expect(store.hasSavedSync()).toBe(true);
    expect(store.hasSavedSyncFromCleanShutdown()).toBe(true);
    await expect(store.getSavedSyncToken()).resolves.toBe("legacy-token");
    expect(fs.existsSync(path.join(storageRootDir, "bot-storage.json"))).toBe(false);
  });

  it("does not archive the legacy flat sync cache into an unread SQLite root", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-matrix-doctor-"));
    tempDirs.push(stateDir);
    const flatRoot = path.join(stateDir, "matrix");
    fs.mkdirSync(flatRoot, { recursive: true });
    fs.writeFileSync(
      path.join(flatRoot, "bot-storage.json"),
      JSON.stringify({
        next_batch: "flat-token",
        rooms: { join: {} },
        account_data: { events: [] },
      }),
    );

    const migration = migrationById("matrix-sync-cache-json-to-plugin-state");
    await expect(migration.detectLegacyState(createMigrationParams(stateDir))).resolves.toBeNull();
    await expect(migration.migrateLegacyState(createMigrationParams(stateDir))).resolves.toEqual({
      changes: [],
      warnings: [],
    });
    expect(fs.existsSync(path.join(flatRoot, "bot-storage.json"))).toBe(true);
  });

  it("migrates Matrix recovery-key JSON to SQLite plugin state", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-matrix-doctor-"));
    tempDirs.push(stateDir);
    const storageRootDir = path.join(
      stateDir,
      "matrix",
      "accounts",
      "default",
      "matrix.example.org__bot",
      "token-hash",
    );
    fs.mkdirSync(storageRootDir, { recursive: true });
    fs.writeFileSync(
      path.join(storageRootDir, "recovery-key.json"),
      JSON.stringify({
        version: 1,
        createdAt: "2026-03-12T00:00:00.000Z",
        keyId: "SSSS",
        privateKeyBase64: Buffer.from([1, 2, 3, 4]).toString("base64"),
      }),
    );

    const migration = migrationById("matrix-recovery-key-json-to-plugin-state");
    await expect(migration.detectLegacyState(createMigrationParams(stateDir))).resolves.toEqual({
      preview: [`Matrix recovery-key JSON can migrate to SQLite: ${storageRootDir}`],
    });

    await expect(migration.migrateLegacyState(createMigrationParams(stateDir))).resolves.toEqual({
      changes: [
        `Migrated Matrix recovery-key JSON to SQLite for ${storageRootDir}`,
        `Archived Matrix recovery key legacy source -> ${path.join(storageRootDir, "recovery-key.json")}.migrated`,
      ],
      warnings: [],
    });

    expect(readMatrixRecoveryKeyState(storageRootDir)?.keyId).toBe("SSSS");
    expect(fs.existsSync(path.join(storageRootDir, "recovery-key.json"))).toBe(false);
  });

  it("migrates Matrix IndexedDB snapshot JSON to SQLite plugin state", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-matrix-doctor-"));
    tempDirs.push(stateDir);
    const storageRootDir = path.join(
      stateDir,
      "matrix",
      "accounts",
      "default",
      "matrix.example.org__bot",
      "token-hash",
    );
    fs.mkdirSync(storageRootDir, { recursive: true });
    const snapshot = [
      {
        name: "openclaw-matrix::matrix-sdk-crypto",
        version: 1,
        stores: [
          {
            name: "sessions",
            keyPath: null,
            autoIncrement: false,
            indexes: [],
            records: [{ key: "room-1", value: { session: "abc123" } }],
          },
        ],
      },
    ];
    fs.writeFileSync(
      path.join(storageRootDir, "crypto-idb-snapshot.json"),
      JSON.stringify(snapshot),
    );

    const migration = migrationById("matrix-idb-snapshot-json-to-plugin-state");
    await expect(migration.detectLegacyState(createMigrationParams(stateDir))).resolves.toEqual({
      preview: [`Matrix IndexedDB snapshot JSON can migrate to SQLite: ${storageRootDir}`],
    });

    await expect(migration.migrateLegacyState(createMigrationParams(stateDir))).resolves.toEqual({
      changes: [
        `Migrated Matrix IndexedDB snapshot JSON to SQLite for ${storageRootDir}`,
        `Archived Matrix IndexedDB snapshot legacy source -> ${path.join(storageRootDir, "crypto-idb-snapshot.json")}.migrated`,
      ],
      warnings: [],
    });

    expect(JSON.parse(readMatrixIdbSnapshotJson(storageRootDir) ?? "null")).toEqual(snapshot);
    expect(fs.existsSync(path.join(storageRootDir, "crypto-idb-snapshot.json"))).toBe(false);
  });

  it("migrates Matrix legacy crypto migration JSON to SQLite plugin state", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-matrix-doctor-"));
    tempDirs.push(stateDir);
    const storageRootDir = path.join(
      stateDir,
      "matrix",
      "accounts",
      "default",
      "matrix.example.org__bot",
      "token-hash",
    );
    fs.mkdirSync(storageRootDir, { recursive: true });
    fs.writeFileSync(
      path.join(storageRootDir, "legacy-crypto-migration.json"),
      JSON.stringify({
        version: 1,
        source: "matrix-bot-sdk-rust",
        accountId: "default",
        deviceId: "DEVICE",
        roomKeyCounts: { total: 2, backedUp: 2 },
        backupVersion: "1",
        decryptionKeyImported: true,
        restoreStatus: "pending",
        detectedAt: "2026-03-12T00:00:00.000Z",
        lastError: null,
      }),
    );

    const migration = migrationById("matrix-legacy-crypto-migration-json-to-plugin-state");
    await expect(migration.detectLegacyState(createMigrationParams(stateDir))).resolves.toEqual({
      preview: [`Matrix legacy crypto migration JSON can migrate to SQLite: ${storageRootDir}`],
    });

    await expect(migration.migrateLegacyState(createMigrationParams(stateDir))).resolves.toEqual({
      changes: [
        `Migrated Matrix legacy crypto migration JSON to SQLite for ${storageRootDir}`,
        `Archived Matrix legacy crypto migration legacy source -> ${path.join(storageRootDir, "legacy-crypto-migration.json")}.migrated`,
      ],
      warnings: [],
    });

    expect(readMatrixLegacyCryptoMigrationState(storageRootDir)?.restoreStatus).toBe("pending");
    expect(fs.existsSync(path.join(storageRootDir, "legacy-crypto-migration.json"))).toBe(false);
  });
});
