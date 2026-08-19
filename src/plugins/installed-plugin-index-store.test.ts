// Covers installed plugin index store persistence and recovery behavior.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import {
  acquireStartupMigrationLease,
  STARTUP_MIGRATION_LEASE_TTL_MS,
} from "../infra/startup-migration-checkpoint.js";
import {
  closeOpenClawStateDatabaseForTest,
  OPENCLAW_STATE_SCHEMA_VERSION,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import type { PluginCandidate } from "./discovery.js";
import {
  readPersistedInstalledPluginIndexInstallRecords,
  writePersistedInstalledPluginIndexInstallRecords,
  writePersistedInstalledPluginIndexInstallRecordsWithLease,
} from "./installed-plugin-index-records.js";
import {
  readPersistedInstalledPluginIndex,
  refreshPersistedInstalledPluginIndex,
  resolveInstalledPluginIndexStorePath,
  restorePersistedInstalledPluginIndexIfCurrent,
  writePersistedInstalledPluginIndex,
  writePersistedInstalledPluginIndexWithLeaseSync,
} from "./installed-plugin-index-store.js";
import {
  resolveInstalledPluginIndexPolicyHash,
  type InstalledPluginIndex,
} from "./installed-plugin-index.js";
import { loadPluginRegistrySnapshotWithMetadata } from "./plugin-registry-snapshot.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const tempDirs: string[] = [];

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  cleanupTrackedTempDirs(tempDirs);
});

function makeTempDir() {
  return makeTrackedTempDir("openclaw-installed-plugin-index-store", tempDirs);
}

function createIndex(overrides: Partial<InstalledPluginIndex> = {}): InstalledPluginIndex {
  return {
    version: 1,
    hostContractVersion: "2026.4.25",
    compatRegistryVersion: "compat-v1",
    migrationVersion: 1,
    policyHash: "policy-v1",
    generatedAtMs: 1777118400000,
    installRecords: {},
    plugins: [
      {
        pluginId: "demo",
        manifestPath: "/plugins/demo/openclaw.plugin.json",
        manifestHash: "manifest-hash",
        rootDir: "/plugins/demo",
        origin: "global",
        packageBuild: { bundledDist: false },
        enabled: true,
        syntheticAuthRefs: ["demo"],
        startup: {
          sidecar: false,
          memory: false,
          agentHarnesses: [],
        },
        compat: [],
      },
    ],
    diagnostics: [],
    ...overrides,
  };
}

function createCandidate(
  rootDir: string,
  options: { id?: string; configPaths?: readonly string[] } = {},
): PluginCandidate {
  const id = options.id ?? "demo";
  fs.writeFileSync(
    path.join(rootDir, "index.ts"),
    "throw new Error('runtime entry should not load while persisting installed plugin index');\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(rootDir, "openclaw.plugin.json"),
    JSON.stringify({
      id,
      name: id === "demo" ? "Demo" : "Next Demo",
      configSchema: { type: "object" },
      providers: [id],
      ...(options.configPaths ? { activation: { onConfigPaths: options.configPaths } } : {}),
    }),
    "utf8",
  );
  return {
    idHint: id,
    source: path.join(rootDir, "index.ts"),
    rootDir,
    origin: "global",
  };
}

function requirePersisted(index: InstalledPluginIndex | null): InstalledPluginIndex {
  if (!index) {
    throw new Error("Expected persisted installed plugin index");
  }
  return index;
}

function requirePersistedRevision(revision: number | null): number {
  if (revision === null) {
    throw new Error("Expected persisted installed plugin index revision");
  }
  return revision;
}

function expectPluginIds(index: InstalledPluginIndex, expected: string[]) {
  expect(index.plugins.map((plugin) => plugin.pluginId)).toEqual(expected);
}

function expectPluginFields(
  index: InstalledPluginIndex,
  pluginId: string,
  expected: Record<string, unknown>,
) {
  const plugin = index.plugins.find((candidate) => candidate.pluginId === pluginId);
  if (!plugin) {
    throw new Error(`Missing plugin ${pluginId}`);
  }
  for (const [key, value] of Object.entries(expected)) {
    expect(plugin[key as keyof typeof plugin], key).toEqual(value);
  }
}

function expectInstallRecord(
  index: InstalledPluginIndex,
  pluginId: string,
  expected: Record<string, unknown>,
) {
  const record = index.installRecords[pluginId];
  if (!record) {
    throw new Error(`Missing install record ${pluginId}`);
  }
  for (const [key, value] of Object.entries(expected)) {
    expect(record[key as keyof typeof record], key).toEqual(value);
  }
}

function dropStartupConfigPaths(
  plugin: InstalledPluginIndex["plugins"][number],
): InstalledPluginIndex["plugins"][number] {
  return {
    ...plugin,
    startup: {
      sidecar: plugin.startup.sidecar,
      memory: plugin.startup.memory,
      agentHarnesses: plugin.startup.agentHarnesses,
    },
  };
}

async function expectPersistedIndex(
  stateDir: string,
  expected: {
    refreshReason?: string;
    pluginIds?: string[];
    installRecords?: Record<string, Record<string, unknown>>;
  },
) {
  const persisted = requirePersisted(await readPersistedInstalledPluginIndex({ stateDir }));
  if (expected.refreshReason !== undefined) {
    expect(persisted.refreshReason).toBe(expected.refreshReason);
  }
  if (expected.pluginIds) {
    expectPluginIds(persisted, expected.pluginIds);
  }
  for (const [pluginId, fields] of Object.entries(expected.installRecords ?? {})) {
    expectInstallRecord(persisted, pluginId, fields);
  }
  return persisted;
}

function insertPersistedIndexRow(
  stateDir: string,
  values: {
    version?: number;
    migrationVersion?: number;
    installRecordsJson?: string;
    pluginsJson?: string;
    diagnosticsJson?: string;
  },
) {
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      db.prepare(
        `
          INSERT OR REPLACE INTO installed_plugin_index (
            index_key, version, host_contract_version, compat_registry_version,
            migration_version, policy_hash, generated_at_ms, refresh_reason,
            install_records_json, plugins_json, diagnostics_json, warning, updated_at_ms
          ) VALUES (
            'installed-plugin-index', @version, '2026.4.25', 'compat-v1',
            @migration_version, 'policy-hash', 123, NULL,
            @install_records_json, @plugins_json, @diagnostics_json, NULL, 123
          )
        `,
      ).run({
        version: values.version ?? 1,
        migration_version: values.migrationVersion ?? 1,
        install_records_json: values.installRecordsJson ?? "{}",
        plugins_json: values.pluginsJson ?? "[]",
        diagnostics_json: values.diagnosticsJson ?? "[]",
      });
    },
    { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } },
  );
}

function readPersistedIndexRevision(stateDir: string): number | null {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const row = db
        .prepare(
          `
            SELECT updated_at_ms
              FROM installed_plugin_index
             WHERE index_key = 'installed-plugin-index'
          `,
        )
        .get() as { updated_at_ms: number | bigint } | undefined;
      return row ? Number(row.updated_at_ms) : null;
    },
    { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } },
  );
}

describe("installed plugin index persistence", () => {
  it("resolves the persisted index path to the shared state database", () => {
    const stateDir = makeTempDir();

    expect(resolveInstalledPluginIndexStorePath({ stateDir })).toBe(
      path.join(stateDir, "state", "openclaw.sqlite"),
    );
  });

  it("writes and reads the installed plugin index atomically", async () => {
    const stateDir = makeTempDir();
    const filePath = resolveInstalledPluginIndexStorePath({ stateDir });
    const index = createIndex({ workspaceDir: "/agents/gadget/workspace" });

    await expect(writePersistedInstalledPluginIndex(index, { stateDir })).resolves.toBe(filePath);

    if (process.platform !== "win32") {
      expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
    }
    const persisted = requirePersisted(await readPersistedInstalledPluginIndex({ stateDir }));
    expect(persisted.version).toBe(index.version);
    expect(persisted.warning).toContain("DO NOT EDIT.");
    expect(persisted.policyHash).toBe(index.policyHash);
    expect(persisted.workspaceDir).toBe("/agents/gadget/workspace");
    expectPluginIds(persisted, ["demo"]);
    expectPluginFields(persisted, "demo", { packageBuild: { bundledDist: false } });
  });

  it("reads indexes written before workspace identity was persisted", async () => {
    const stateDir = makeTempDir();
    insertPersistedIndexRow(stateDir, {});

    const persisted = requirePersisted(await readPersistedInstalledPluginIndex({ stateDir }));
    expect(persisted.workspaceDir).toBeUndefined();
  });

  it("atomically captures the predecessor and revision for a leased install-record write", async () => {
    const stateDir = makeTempDir();
    const lease = { assertOwnedInTransaction: vi.fn() };
    await writePersistedInstalledPluginIndex(createIndex({ policyHash: "successor" }), {
      stateDir,
    });
    const predecessor = requirePersisted(await readPersistedInstalledPluginIndex({ stateDir }));

    const receipt = await writePersistedInstalledPluginIndexInstallRecordsWithLease(
      {},
      {
        stateDir,
        candidates: [],
        lease,
      },
    );

    expect(receipt.previous).toEqual(predecessor);
    expect(receipt.revision).toBe(requirePersistedRevision(readPersistedIndexRevision(stateDir)));
    expect(lease.assertOwnedInTransaction).toHaveBeenCalledOnce();
  });

  it("conditionally restores a matching tentative index revision", async () => {
    const stateDir = makeTempDir();
    const lease = { assertOwnedInTransaction: vi.fn() };
    await writePersistedInstalledPluginIndex(createIndex({ policyHash: "previous" }), {
      stateDir,
    });
    const previous = requirePersisted(await readPersistedInstalledPluginIndex({ stateDir }));
    await writePersistedInstalledPluginIndex(createIndex({ policyHash: "tentative" }), {
      stateDir,
    });
    const tentativeRevision = requirePersistedRevision(readPersistedIndexRevision(stateDir));

    await expect(
      restorePersistedInstalledPluginIndexIfCurrent(previous, tentativeRevision, {
        stateDir,
        lease,
      }),
    ).resolves.toBe(true);

    await expect(readPersistedInstalledPluginIndex({ stateDir })).resolves.toEqual(previous);
    expect(lease.assertOwnedInTransaction).toHaveBeenCalledOnce();
  });

  it("conditionally restores matching prior index absence", async () => {
    const stateDir = makeTempDir();
    const lease = { assertOwnedInTransaction: vi.fn() };
    await writePersistedInstalledPluginIndex(createIndex({ policyHash: "tentative" }), {
      stateDir,
    });
    const tentativeRevision = requirePersistedRevision(readPersistedIndexRevision(stateDir));

    await expect(
      restorePersistedInstalledPluginIndexIfCurrent(null, tentativeRevision, {
        stateDir,
        lease,
      }),
    ).resolves.toBe(true);

    await expect(readPersistedInstalledPluginIndex({ stateDir })).resolves.toBeNull();
  });

  it("keeps a successor index when conditional rollback sees a newer revision", async () => {
    const stateDir = makeTempDir();
    const lease = { assertOwnedInTransaction: vi.fn() };
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);
    try {
      await writePersistedInstalledPluginIndex(createIndex({ policyHash: "previous" }), {
        stateDir,
      });
      const previous = requirePersisted(await readPersistedInstalledPluginIndex({ stateDir }));
      await writePersistedInstalledPluginIndex(createIndex({ policyHash: "tentative" }), {
        stateDir,
      });
      const tentativeRevision = requirePersistedRevision(readPersistedIndexRevision(stateDir));
      await writePersistedInstalledPluginIndex(createIndex({ policyHash: "successor" }), {
        stateDir,
      });
      const successorRevision = requirePersistedRevision(readPersistedIndexRevision(stateDir));

      expect(successorRevision).toBeGreaterThan(tentativeRevision);
      await expect(
        restorePersistedInstalledPluginIndexIfCurrent(previous, tentativeRevision, {
          stateDir,
          lease,
        }),
      ).resolves.toBe(false);
      expect(
        requirePersisted(await readPersistedInstalledPluginIndex({ stateDir })).policyHash,
      ).toBe("successor");
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("rejects a stale leased write without replacing the successor index", async () => {
    const stateDir = makeTempDir();
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const nowMs = Date.now();
    const staleLease = acquireStartupMigrationLease({ env, nowMs, owner: "stale" });
    const successorLease = acquireStartupMigrationLease({
      env,
      nowMs: nowMs + STARTUP_MIGRATION_LEASE_TTL_MS + 1,
      owner: "successor",
    });
    const successorIndex = createIndex({ policyHash: "successor" });

    try {
      writePersistedInstalledPluginIndexWithLeaseSync(successorIndex, {
        env,
        lease: successorLease,
      });

      expect(() =>
        writePersistedInstalledPluginIndexWithLeaseSync(createIndex({ policyHash: "stale" }), {
          env,
          lease: staleLease,
        }),
      ).toThrow("startup migration lease was lost");
      expect(requirePersisted(await readPersistedInstalledPluginIndex({ env })).policyHash).toBe(
        "successor",
      );
    } finally {
      staleLease.release();
      successorLease.release();
    }
  });

  it("rereads install-record writes under their non-default policy", async () => {
    const stateDir = makeTempDir();
    const pluginDir = path.join(stateDir, "plugins", "demo");
    fs.mkdirSync(pluginDir, { recursive: true });
    const candidate = createCandidate(pluginDir);
    const config = {
      plugins: {
        entries: {
          demo: { enabled: false },
        },
      },
    };
    const env = {
      OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
      OPENCLAW_VERSION: "2026.4.25",
      VITEST: "true",
    };

    await writePersistedInstalledPluginIndexInstallRecords(
      { demo: { source: "npm", spec: "demo@1.0.0", installPath: pluginDir } },
      { stateDir, candidates: [candidate], config, env },
    );
    const result = loadPluginRegistrySnapshotWithMetadata({
      stateDir,
      candidates: [candidate],
      config,
      env,
    });

    expect(result.source).toBe("persisted");
    expect(result.diagnostics).toStrictEqual([]);
    expect(result.snapshot.policyHash).toBe(resolveInstalledPluginIndexPolicyHash(config));
    expectPluginFields(result.snapshot, "demo", { enabled: false });
  });

  it("hashes and persists resolved doctor contract artifacts", async () => {
    const stateDir = makeTempDir();
    const pluginDir = path.join(stateDir, "plugins", "demo");
    fs.mkdirSync(pluginDir, { recursive: true });
    const candidate = createCandidate(pluginDir);
    const contractPath = path.join(pluginDir, "doctor-contract-api.ts");
    const env = {
      OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
      OPENCLAW_VERSION: "2026.4.25",
      VITEST: "true",
    };
    fs.writeFileSync(contractPath, "export const legacyConfigRules = [];\n", "utf8");

    const first = await refreshPersistedInstalledPluginIndex({
      reason: "manual",
      stateDir,
      candidates: [candidate],
      env,
    });
    const firstPlugin = first.plugins[0];
    const firstHash = firstPlugin?.doctorContractHash;
    const firstFile = firstPlugin?.doctorContractFile;
    expect(firstHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(firstFile).toEqual({
      size: fs.statSync(contractPath).size,
      mtimeMs: fs.statSync(contractPath).mtimeMs,
      ctimeMs: fs.statSync(contractPath).ctimeMs,
    });
    expectPluginFields(
      requirePersisted(await readPersistedInstalledPluginIndex({ stateDir })),
      "demo",
      {
        doctorContractHash: firstHash,
        doctorContractFile: firstFile,
      },
    );

    fs.writeFileSync(
      contractPath,
      "export const legacyConfigRules = [{ path: ['demo'], message: 'changed' }];\n",
      "utf8",
    );
    const second = await refreshPersistedInstalledPluginIndex({
      reason: "manual",
      stateDir,
      candidates: [candidate],
      env,
    });
    const secondPlugin = second.plugins[0];
    const secondHash = secondPlugin?.doctorContractHash;
    const secondFile = secondPlugin?.doctorContractFile;
    expect(secondHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(secondHash).not.toBe(firstHash);
    expect(secondFile).not.toEqual(firstFile);
    expectPluginFields(
      requirePersisted(await readPersistedInstalledPluginIndex({ stateDir })),
      "demo",
      {
        doctorContractHash: secondHash,
        doctorContractFile: secondFile,
      },
    );
  });

  it("strips retired startup fields from persisted indexes", async () => {
    const stateDir = makeTempDir();
    const index = createIndex();
    const plugin = index.plugins[0];
    if (!plugin) {
      throw new Error("Expected demo plugin fixture");
    }
    insertPersistedIndexRow(stateDir, {
      pluginsJson: JSON.stringify([
        {
          ...plugin,
          startup: {
            ...plugin.startup,
            deferConfiguredChannelFullLoadUntilAfterListen: true,
          },
        },
      ]),
    });

    const persisted = requirePersisted(await readPersistedInstalledPluginIndex({ stateDir }));
    expect(persisted.plugins[0]?.startup).not.toHaveProperty(
      "deferConfiguredChannelFullLoadUntilAfterListen",
    );
  });

  it("does not repair shared state schema while reading the index", async () => {
    const stateDir = makeTempDir();
    const filePath = resolveInstalledPluginIndexStorePath({ stateDir });
    await writePersistedInstalledPluginIndex(createIndex(), { stateDir });
    closeOpenClawStateDatabaseForTest();

    const sqlite = requireNodeSqlite();
    const mutate = new sqlite.DatabaseSync(filePath);
    mutate.exec("DROP INDEX idx_operator_approvals_resolution_ref;");
    mutate.close();

    const expectCanonicalIndexMissing = () => {
      const verify = new sqlite.DatabaseSync(filePath, { readOnly: true });
      try {
        expect(
          verify
            .prepare(
              "SELECT 1 FROM sqlite_schema WHERE type = 'index' AND name = 'idx_operator_approvals_resolution_ref'",
            )
            .get(),
        ).toBeUndefined();
      } finally {
        verify.close();
      }
    };

    await expect(readPersistedInstalledPluginIndex({ stateDir })).resolves.toMatchObject({
      version: 1,
    });
    expectCanonicalIndexMissing();

    await expect(readPersistedInstalledPluginIndexInstallRecords({ stateDir })).resolves.toEqual(
      {},
    );
    expectCanonicalIndexMissing();
  });

  it("preserves startup config paths across persisted index roundtrips", async () => {
    const stateDir = makeTempDir();
    const index = createIndex({
      plugins: [
        {
          pluginId: "browser",
          manifestPath: "/plugins/browser/openclaw.plugin.json",
          manifestHash: "browser-manifest-hash",
          rootDir: "/plugins/browser",
          origin: "bundled",
          enabled: true,
          enabledByDefault: true,
          startup: {
            sidecar: true,
            memory: false,
            agentHarnesses: [],
            configPaths: ["browser"],
          },
          compat: ["activation-config-path-hint"],
        },
      ],
    });

    await writePersistedInstalledPluginIndex(index, { stateDir });

    const persisted = requirePersisted(await readPersistedInstalledPluginIndex({ stateDir }));
    expect(persisted.plugins[0]?.startup.configPaths).toEqual(["browser"]);
    expect(persisted.plugins[0]?.compat).toEqual(["activation-config-path-hint"]);
  });

  it("preserves contribution metadata across persisted index roundtrips", async () => {
    const stateDir = makeTempDir();
    const index = createIndex({
      plugins: [
        {
          pluginId: "provider-owner",
          manifestPath: "/plugins/provider-owner/openclaw.plugin.json",
          manifestHash: "provider-owner-manifest-hash",
          rootDir: "/plugins/provider-owner",
          origin: "bundled",
          enabled: true,
          startup: {
            sidecar: false,
            memory: false,
            agentHarnesses: [],
          },
          contributions: {
            channels: ["demo-channel"],
            channelConfigs: ["demo-channel"],
            providers: ["demo-provider"],
            modelCatalogProviders: ["demo-provider"],
            modelSupportPrefixes: ["demo-"],
            modelSupportPatterns: ["^demo-[0-9]+$"],
            autoEnableProviderIds: ["demo-auth"],
            commandAliases: ["demo-command"],
            contracts: {
              webSearchProviders: ["demo-search"],
            },
          },
          compat: [],
        },
      ],
    });

    await writePersistedInstalledPluginIndex(index, { stateDir });

    const persisted = requirePersisted(await readPersistedInstalledPluginIndex({ stateDir }));
    expect(persisted.plugins[0]?.contributions).toEqual({
      channels: ["demo-channel"],
      channelConfigs: ["demo-channel"],
      providers: ["demo-provider"],
      modelCatalogProviders: ["demo-provider"],
      modelSupportPrefixes: ["demo-"],
      modelSupportPatterns: ["^demo-[0-9]+$"],
      autoEnableProviderIds: ["demo-auth"],
      commandAliases: ["demo-command"],
      contracts: {
        webSearchProviders: ["demo-search"],
      },
    });
  });

  it("marks legacy config-path startup indexes stale so update rebuilds them", async () => {
    const stateDir = makeTempDir();
    const pluginDir = path.join(stateDir, "plugins", "demo");
    fs.mkdirSync(pluginDir, { recursive: true });
    const env = {
      OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
      OPENCLAW_VERSION: "2026.4.25",
      VITEST: "true",
    };
    const candidate = createCandidate(pluginDir, { configPaths: ["browser"] });
    const current = await refreshPersistedInstalledPluginIndex({
      reason: "manual",
      stateDir,
      candidates: [candidate],
      env,
    });
    const legacy = {
      ...current,
      plugins: current.plugins.map(dropStartupConfigPaths),
    };
    await writePersistedInstalledPluginIndex(legacy, { stateDir });

    const inspection = loadPluginRegistrySnapshotWithMetadata({
      stateDir,
      candidates: [candidate],
      env,
    });
    expect(inspection.source).toBe("derived");

    const refreshed = await refreshPersistedInstalledPluginIndex({
      reason: "policy-changed",
      stateDir,
      candidates: [candidate],
      env,
    });
    expect(refreshed.plugins[0]?.startup.configPaths).toEqual(["browser"]);
    const persisted = requirePersisted(await readPersistedInstalledPluginIndex({ stateDir }));
    expect(persisted.plugins[0]?.startup.configPaths).toEqual(["browser"]);
  });

  it("does not allocate a revision or rewrite an invalid predecessor", async () => {
    const stateDir = makeTempDir();
    const installRecordsJson = '{"__proto__":{"source":"bogus"}}';
    insertPersistedIndexRow(stateDir, { installRecordsJson });

    await expect(writePersistedInstalledPluginIndex(createIndex(), { stateDir })).rejects.toThrow(
      "Persisted plugin install records are invalid",
    );
    const row = runOpenClawStateWriteTransaction(
      ({ db }) =>
        db
          .prepare(
            `SELECT install_records_json, updated_at_ms
               FROM installed_plugin_index
              WHERE index_key = 'installed-plugin-index'`,
          )
          .get() as { install_records_json: string; updated_at_ms: number | bigint },
      { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } },
    );
    expect(row).toEqual({ install_records_json: installRecordsJson, updated_at_ms: 123 });
  });

  it("returns null for missing or invalid persisted indexes", async () => {
    const stateDir = makeTempDir();
    await expect(readPersistedInstalledPluginIndex({ stateDir })).resolves.toBeNull();

    insertPersistedIndexRow(stateDir, { version: 999 });

    await expect(readPersistedInstalledPluginIndex({ stateDir })).resolves.toBeNull();
  });

  it("preserves newer shared-state schema errors while reading the index", async () => {
    const stateDir = makeTempDir();
    await writePersistedInstalledPluginIndex(createIndex(), { stateDir });
    closeOpenClawStateDatabaseForTest();
    const databasePath = resolveInstalledPluginIndexStorePath({ stateDir });
    const { DatabaseSync } = requireNodeSqlite();
    const database = new DatabaseSync(databasePath);
    database.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION + 1};`);
    database.close();

    await expect(readPersistedInstalledPluginIndex({ stateDir })).rejects.toMatchObject({
      name: "SqliteSchemaVersionError",
      message: expect.stringContaining(
        `uses newer schema version ${OPENCLAW_STATE_SCHEMA_VERSION + 1}`,
      ),
    });
  });

  it("leaves retired JSON index files to the doctor migration owner", async () => {
    const stateDir = makeTempDir();
    const filePath = path.join(stateDir, "installs.json");
    fs.writeFileSync(filePath, JSON.stringify(createIndex()), "utf8");

    await expect(readPersistedInstalledPluginIndex({ filePath })).resolves.toBeNull();
    await expect(readPersistedInstalledPluginIndexInstallRecords({ filePath })).resolves.toBeNull();
  });

  it("rejects pre-migration persisted indexes so update can rebuild them", async () => {
    const stateDir = makeTempDir();
    insertPersistedIndexRow(stateDir, { migrationVersion: 0 });

    await expect(readPersistedInstalledPluginIndex({ stateDir })).resolves.toBeNull();
  });

  it("refreshes and persists a rebuilt index without loading plugin runtime", async () => {
    const stateDir = makeTempDir();
    const pluginDir = path.join(stateDir, "plugins", "demo");
    fs.mkdirSync(pluginDir, { recursive: true });
    const candidate = createCandidate(pluginDir);

    const index = await refreshPersistedInstalledPluginIndex({
      reason: "manual",
      stateDir,
      candidates: [candidate],
      env: {
        OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
        OPENCLAW_VERSION: "2026.4.25",
        VITEST: "true",
      },
    });

    expect(index.refreshReason).toBe("manual");
    expect(index.plugins.map((plugin) => plugin.pluginId)).toEqual(["demo"]);
    await expectPersistedIndex(stateDir, {
      refreshReason: "manual",
      pluginIds: ["demo"],
    });
  });

  it("refreshes policy state from the persisted registry without rebuilding source records", async () => {
    const stateDir = makeTempDir();
    const pluginDir = path.join(stateDir, "plugins", "demo");
    fs.mkdirSync(pluginDir, { recursive: true });
    const candidate = createCandidate(pluginDir);
    const env = {
      OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
      OPENCLAW_VERSION: "2026.4.25",
      VITEST: "true",
    };
    const initial = await refreshPersistedInstalledPluginIndex({
      reason: "manual",
      stateDir,
      candidates: [candidate],
      env,
    });
    fs.writeFileSync(
      path.join(pluginDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "demo",
        name: "Demo",
        configSchema: { type: "object" },
        providers: ["demo", "changed"],
      }),
      "utf8",
    );

    const refreshed = await refreshPersistedInstalledPluginIndex({
      reason: "policy-changed",
      stateDir,
      candidates: [candidate],
      env,
      config: {
        plugins: {
          entries: {
            demo: {
              enabled: false,
            },
          },
        },
      },
      policyPluginIds: ["demo"],
    });

    expect(refreshed.plugins).toHaveLength(initial.plugins.length);
    expectPluginFields(refreshed, "demo", {
      pluginId: "demo",
      enabled: false,
      manifestHash: initial.plugins[0]?.manifestHash,
    });
    expect(refreshed.policyHash).not.toBe(initial.policyHash);
  });

  it("falls back to a source rebuild when a policy refresh target is missing", async () => {
    const stateDir = makeTempDir();
    const pluginDir = path.join(stateDir, "plugins", "demo");
    const nextPluginDir = path.join(stateDir, "plugins", "next-demo");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.mkdirSync(nextPluginDir, { recursive: true });
    const candidate = createCandidate(pluginDir);
    const nextCandidate = createCandidate(nextPluginDir, { id: "next-demo" });
    const env = {
      OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
      OPENCLAW_VERSION: "2026.4.25",
      VITEST: "true",
    };
    await refreshPersistedInstalledPluginIndex({
      reason: "manual",
      stateDir,
      candidates: [candidate],
      env,
    });

    const refreshed = await refreshPersistedInstalledPluginIndex({
      reason: "policy-changed",
      stateDir,
      candidates: [candidate, nextCandidate],
      env,
      config: {
        plugins: {
          entries: {
            "next-demo": {
              enabled: false,
            },
          },
        },
      },
      policyPluginIds: ["next-demo"],
    });

    expect(refreshed.plugins.map((plugin) => plugin.pluginId)).toContain("next-demo");
  });

  it("preserves existing install records when refreshing the manifest cache", async () => {
    const stateDir = makeTempDir();
    await writePersistedInstalledPluginIndex(
      createIndex({
        installRecords: {
          missing: {
            source: "npm",
            spec: "missing-plugin@1.0.0",
            installPath: path.join(stateDir, "plugins", "missing"),
          },
        },
        plugins: [],
      }),
      { stateDir },
    );

    const index = await refreshPersistedInstalledPluginIndex({
      reason: "manual",
      stateDir,
      candidates: [],
      env: {
        OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
        OPENCLAW_VERSION: "2026.4.25",
        VITEST: "true",
      },
    });

    expectInstallRecord(index, "missing", {
      source: "npm",
      spec: "missing-plugin@1.0.0",
      installPath: path.join(stateDir, "plugins", "missing"),
    });
    expectPluginIds(index, []);
    await expectPersistedIndex(stateDir, {
      pluginIds: [],
      installRecords: {
        missing: {
          source: "npm",
          spec: "missing-plugin@1.0.0",
          installPath: path.join(stateDir, "plugins", "missing"),
        },
      },
    });
  });

  it("preserves ClawHub ClawPack source facts when refreshing the manifest cache", async () => {
    const stateDir = makeTempDir();
    const installPath = path.join(stateDir, "plugins", "clawpack-demo");
    await writePersistedInstalledPluginIndex(
      createIndex({
        installRecords: {
          "clawpack-demo": {
            source: "clawhub",
            spec: "clawhub:clawpack-demo@2026.5.1-beta.2",
            installPath,
            version: "2026.5.1-beta.2",
            integrity: "sha256-archive",
            resolvedAt: "2026-05-01T00:00:00.000Z",
            clawhubUrl: "https://clawhub.ai",
            clawhubPackage: "clawpack-demo",
            clawhubFamily: "code-plugin",
            clawhubChannel: "official",
            artifactKind: "npm-pack",
            artifactFormat: "tgz",
            npmIntegrity: "sha512-clawpack",
            npmShasum: "1".repeat(40),
            npmTarballName: "clawpack-demo-2026.5.1-beta.2.tgz",
            clawpackSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            clawpackSpecVersion: 1,
            clawpackManifestSha256:
              "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            clawpackSize: 4096,
          },
        },
        plugins: [],
      }),
      { stateDir },
    );

    const index = await refreshPersistedInstalledPluginIndex({
      reason: "manual",
      stateDir,
      candidates: [],
      env: {
        OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
        OPENCLAW_VERSION: "2026.4.25",
        VITEST: "true",
      },
    });

    const expectedRecord = {
      source: "clawhub",
      spec: "clawhub:clawpack-demo@2026.5.1-beta.2",
      installPath,
      version: "2026.5.1-beta.2",
      integrity: "sha256-archive",
      resolvedAt: "2026-05-01T00:00:00.000Z",
      clawhubUrl: "https://clawhub.ai",
      clawhubPackage: "clawpack-demo",
      clawhubFamily: "code-plugin",
      clawhubChannel: "official",
      artifactKind: "npm-pack",
      artifactFormat: "tgz",
      npmIntegrity: "sha512-clawpack",
      npmShasum: "1".repeat(40),
      npmTarballName: "clawpack-demo-2026.5.1-beta.2.tgz",
      clawpackSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      clawpackSpecVersion: 1,
      clawpackManifestSha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      clawpackSize: 4096,
    };
    expectInstallRecord(index, "clawpack-demo", expectedRecord);
    expectPluginIds(index, []);
    await expectPersistedIndex(stateDir, {
      pluginIds: [],
      installRecords: {
        "clawpack-demo": expectedRecord,
      },
    });
  });
});
