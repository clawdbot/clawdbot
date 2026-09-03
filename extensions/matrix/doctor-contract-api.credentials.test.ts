// Matrix tests cover credential-state migrations owned by the doctor contract.
import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type {
  OpenKeyedStoreOptions,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  getPluginStateCapacityForTests,
  importPluginStateEntriesForDoctorForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type { PluginDoctorStateMigrationContext } from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stateMigrations } from "./doctor-contract-api.js";
import {
  MATRIX_CREDENTIALS_MAX_ENTRIES,
  MATRIX_CREDENTIALS_NAMESPACE,
  matrixCredentialsStoreKey,
  type MatrixCredentialStateRecord,
  type MatrixStoredCredentialRecord,
} from "./src/matrix/credentials-state.js";
import { installMatrixTestRuntime } from "./src/test-runtime.js";
import { useAutoCleanupTempDirTracker } from "./test-support.js";

function createContext(env?: NodeJS.ProcessEnv): PluginDoctorStateMigrationContext {
  return {
    getPluginStateCapacity() {
      return getPluginStateCapacityForTests("matrix", env);
    },
    importPluginStateEntries(options, entries) {
      importPluginStateEntriesForDoctorForTests("matrix", options, entries);
    },
    openPluginStateKeyedStore: <T>(options: OpenKeyedStoreOptions): PluginStateKeyedStore<T> =>
      createPluginStateKeyedStoreForTests<T>("matrix", options),
  };
}

function createMigrationParams(stateDir: string) {
  const env = { OPENCLAW_STATE_DIR: stateDir };
  return {
    config: {} as OpenClawConfig,
    env,
    stateDir,
    oauthDir: path.join(stateDir, "oauth"),
    context: createContext(env),
  };
}

function migrationById(id: string) {
  const migration = stateMigrations.find((entry) => entry.id === id);
  if (!migration) {
    throw new Error(`missing migration ${id}`);
  }
  return migration;
}

describe("matrix doctor credential state migrations", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  beforeEach(() => {
    resetPluginStateStoreForTests();
    installMatrixTestRuntime();
  });

  afterEach(() => {
    resetPluginStateStoreForTests();
  });

  it("imports account credentials into SQLite before archiving the JSON", async () => {
    const stateDir = tempDirs.make("openclaw-matrix-doctor-");
    const credentialsDir = path.join(stateDir, "credentials", "matrix");
    const filePath = path.join(credentialsDir, "credentials-ops.json");
    const credentials = {
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      accessToken: "secret-token",
      deviceId: "DEVICE123",
      createdAt: "2026-07-01T12:00:00.000Z",
      lastUsedAt: "2026-07-02T12:00:00.000Z",
    };
    fs.mkdirSync(credentialsDir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(credentials));
    const migration = migrationById("matrix-credentials-json-to-plugin-state");
    const params = createMigrationParams(stateDir);

    await expect(migration.detectLegacyState(params)).resolves.toEqual({
      preview: ["Matrix credential JSON can migrate to SQLite (1 file)"],
    });
    const result = await migration.migrateLegacyState(params);

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([
      "Migrated Matrix credentials for account ops to SQLite",
      expect.stringContaining("Archived Matrix credentials legacy source"),
    ]);
    const store = params.context.openPluginStateKeyedStore<MatrixStoredCredentialRecord>({
      namespace: MATRIX_CREDENTIALS_NAMESPACE,
      maxEntries: MATRIX_CREDENTIALS_MAX_ENTRIES,
      overflowPolicy: "reject-new",
    });
    await expect(store.lookup(matrixCredentialsStoreKey("ops"))).resolves.toEqual({
      accountId: "ops",
      ...credentials,
    });
    expect(fs.existsSync(`${filePath}.migrated`)).toBe(true);
  });

  it("archives legacy credentials without restoring an explicitly cleared account", async () => {
    const stateDir = tempDirs.make("openclaw-matrix-doctor-");
    const credentialsDir = path.join(stateDir, "credentials", "matrix");
    const filePath = path.join(credentialsDir, "credentials-ops.json");
    fs.mkdirSync(credentialsDir, { recursive: true });
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
        accessToken: "legacy-token",
        createdAt: "2026-07-01T12:00:00.000Z",
      }),
    );
    const params = createMigrationParams(stateDir);
    const credentialStore = params.context.openPluginStateKeyedStore<MatrixCredentialStateRecord>({
      namespace: MATRIX_CREDENTIALS_NAMESPACE,
      maxEntries: MATRIX_CREDENTIALS_MAX_ENTRIES,
      overflowPolicy: "reject-new",
    });
    await credentialStore.register(matrixCredentialsStoreKey("ops"), {
      accountId: "ops",
      kind: "revoked",
      revokedAt: "2026-07-02T12:00:00.000Z",
    });

    const result = await migrationById(
      "matrix-credentials-json-to-plugin-state",
    ).migrateLegacyState(params);

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([
      "Archived revoked Matrix credential legacy source for account ops",
      expect.stringContaining("Archived Matrix credentials legacy source"),
    ]);
    expect(fs.existsSync(`${filePath}.migrated`)).toBe(true);
  });

  it("keeps canonical SQLite credentials and archives a differing legacy source", async () => {
    const stateDir = tempDirs.make("openclaw-matrix-doctor-");
    const credentialsDir = path.join(stateDir, "credentials", "matrix");
    const filePath = path.join(credentialsDir, "credentials-agent1.json");
    fs.mkdirSync(credentialsDir, { recursive: true });
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        homeserver: "https://matrix.example.org",
        userId: "@agent1:example.org",
        accessToken: "legacy-token",
        deviceId: "LEGACYDEVICE",
        createdAt: "2026-07-02T12:00:00.000Z",
      }),
    );
    const params = createMigrationParams(stateDir);
    const credentialStore = params.context.openPluginStateKeyedStore<MatrixCredentialStateRecord>({
      namespace: MATRIX_CREDENTIALS_NAMESPACE,
      maxEntries: MATRIX_CREDENTIALS_MAX_ENTRIES,
      overflowPolicy: "reject-new",
    });
    const canonical: MatrixStoredCredentialRecord = {
      accountId: "agent1",
      homeserver: "https://matrix.example.org",
      userId: "@agent1:example.org",
      accessToken: "canonical-token",
      deviceId: "CANONICALDEVICE",
      createdAt: "2026-07-01T12:00:00.000Z",
    };
    await credentialStore.register(matrixCredentialsStoreKey("agent1"), canonical);

    const result = await migrationById(
      "matrix-credentials-json-to-plugin-state",
    ).migrateLegacyState(params);

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([
      "Kept existing Matrix credentials for account agent1",
      expect.stringContaining("Archived Matrix credentials legacy source"),
    ]);
    await expect(credentialStore.lookup(matrixCredentialsStoreKey("agent1"))).resolves.toEqual(
      canonical,
    );
    expect(fs.existsSync(filePath)).toBe(false);
    expect(fs.existsSync(`${filePath}.migrated`)).toBe(true);
    expect(JSON.parse(fs.readFileSync(`${filePath}.migrated`, "utf8"))).toMatchObject({
      accessToken: "legacy-token",
      deviceId: "LEGACYDEVICE",
    });
  });
});
