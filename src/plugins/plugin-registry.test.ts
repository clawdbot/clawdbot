// Covers plugin registry assembly, contribution lookup, and reset behavior.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import type { PluginCandidate } from "./discovery.js";
import {
  readPersistedInstalledPluginIndex,
  writePersistedInstalledPluginIndex,
} from "./installed-plugin-index-store.js";
import {
  resolveInstalledPluginIndexPolicyHash,
  type InstalledPluginIndex,
} from "./installed-plugin-index.js";
import { loadPluginLookUpTable } from "./plugin-lookup-table.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import {
  DISABLE_PERSISTED_PLUGIN_REGISTRY_ENV,
  createPluginRegistryIdNormalizer,
  getPluginRecord,
  inspectPluginRegistry,
  isPluginEnabled,
  listPluginContributionIds,
  listPluginRecords,
  loadPluginRegistrySnapshot,
  loadPluginRegistrySnapshotWithMetadata,
  normalizePluginsConfigWithRegistry,
  refreshPluginRegistry,
  resolveManifestContractOwnerPluginId,
  resolveManifestContractPluginIds,
  resolveManifestContractPluginIdsByCompatibilityRuntimePath,
  resolvePluginContributionOwners,
  resolveProviderOwners,
} from "./plugin-registry.js";
import { resolvePluginPath } from "./registry.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const tempDirs: string[] = [];

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  clearPluginMetadataLifecycleCaches();
  cleanupTrackedTempDirs(tempDirs);
});

function makeTempDir() {
  return makeTrackedTempDir("openclaw-plugin-registry", tempDirs);
}

function hermeticEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
    OPENCLAW_VERSION: "2026.4.25",
    VITEST: "true",
    ...overrides,
  };
}

function hashFile(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function createCandidate(rootDir: string, pluginId = "demo"): PluginCandidate {
  fs.writeFileSync(
    path.join(rootDir, "index.ts"),
    "throw new Error('runtime entry should not load while reading plugin registry');\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(rootDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: pluginId,
      name: pluginId,
      configSchema: { type: "object" },
      providers: [pluginId],
      channels: [`${pluginId}-chat`],
      cliBackends: [`${pluginId}-cli`],
      setup: {
        providers: [{ id: `${pluginId}-setup`, envVars: ["DEMO_API_KEY"] }],
        cliBackends: [`${pluginId}-setup-cli`],
      },
      channelConfigs: {
        [`${pluginId}-chat`]: {
          schema: { type: "object" },
        },
      },
      modelCatalog: {
        aliases: {
          [`${pluginId}-alias`]: {
            provider: pluginId,
          },
        },
        providers: {
          [pluginId]: {
            models: [{ id: `${pluginId}-model` }],
          },
        },
      },
      commandAliases: [{ name: `${pluginId}-command` }],
      contracts: {
        tools: [`${pluginId}-tool`],
        webSearchProviders: [`${pluginId}-search`],
      },
      configContracts: {
        compatibilityRuntimePaths: [`tools.web.search.${pluginId}-search.apiKey`],
      },
    }),
    "utf8",
  );
  return {
    idHint: pluginId,
    source: path.join(rootDir, "index.ts"),
    rootDir,
    origin: "global",
  };
}

function createIndex(
  pluginId = "demo",
  overrides: Partial<InstalledPluginIndex> = {},
): InstalledPluginIndex {
  const pluginRoot = overrides.plugins?.[0]?.rootDir ?? `/plugins/${pluginId}`;
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
        pluginId,
        manifestPath: path.join(pluginRoot, "openclaw.plugin.json"),
        manifestHash: "manifest-hash",
        rootDir: pluginRoot,
        origin: "global",
        enabled: true,
        startup: {
          sidecar: false,
          memory: false,
          deferConfiguredChannelFullLoadUntilAfterListen: false,
          agentHarnesses: [],
        },
        compat: [],
      },
    ],
    diagnostics: [],
    ...overrides,
  };
}

function createPersistableIndex(pluginId: string): InstalledPluginIndex {
  const index = createIndex(pluginId);
  const plugins = index.plugins.map((plugin) => Object.assign({}, plugin, { enabled: false }));
  return {
    ...index,
    plugins,
  };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error(`expected ${label}`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string): Array<unknown> {
  expect(Array.isArray(value), label).toBe(true);
  return value as Array<unknown>;
}

function expectFields(record: Record<string, unknown>, expected: Record<string, unknown>) {
  for (const [key, value] of Object.entries(expected)) {
    expect(record[key], key).toEqual(value);
  }
}

function expectPluginRecordFields(record: unknown, expected: Record<string, unknown>) {
  expectFields(requireRecord(record, "plugin record"), expected);
}

function expectDiagnosticCodes(diagnostics: unknown, expectedCodes: string[]) {
  const codes: Array<unknown> = [];
  for (const diagnostic of requireArray(diagnostics, "diagnostics")) {
    codes.push(requireRecord(diagnostic, "diagnostic").code);
  }
  expect(codes).toEqual(expectedCodes);
}

function expectInstallRecord(
  installRecords: unknown,
  pluginId: string,
  expected: Record<string, unknown>,
) {
  const records = requireRecord(installRecords, "install records");
  expectFields(requireRecord(records[pluginId], `${pluginId} install record`), expected);
}

function expectSnapshotPluginIds(snapshot: InstalledPluginIndex, expectedPluginIds: string[]) {
  expect(listPluginRecords({ index: snapshot }).map((plugin) => plugin.pluginId)).toEqual(
    expectedPluginIds,
  );
}

describe("plugin registry facade", () => {
  it("resolves relative plugin API paths against the plugin root", () => {
    const pluginRoot = path.join(makeTempDir(), "plugins", "demo");

    expect(resolvePluginPath("data/cache.json", pluginRoot)).toBe(
      path.join(pluginRoot, "data", "cache.json"),
    );
    expect(resolvePluginPath("./data/cache.json", pluginRoot)).toBe(
      path.join(pluginRoot, "data", "cache.json"),
    );
  });

  it("keeps absolute and home plugin API paths user-resolved", () => {
    const pluginRoot = path.join(makeTempDir(), "plugins", "demo");
    const absolute = path.resolve(pluginRoot, "..", "outside.txt");

    expect(resolvePluginPath(absolute, pluginRoot)).toBe(resolvePluginPath(absolute, undefined));
    expect(resolvePluginPath("~/openclaw/plugin.txt", pluginRoot)).toBe(
      resolvePluginPath("~/openclaw/plugin.txt", undefined),
    );
  });

  it("resolves cold plugin records and contribution owners without loading runtime", () => {
    const rootDir = makeTempDir();
    const candidate = createCandidate(rootDir);
    const index = loadPluginRegistrySnapshot({
      candidates: [candidate],
      env: hermeticEnv(),
      preferPersisted: false,
    });

    expect(listPluginRecords({ index }).map((plugin) => plugin.pluginId)).toEqual(["demo"]);
    expectPluginRecordFields(getPluginRecord({ index, pluginId: "demo" }), {
      pluginId: "demo",
      enabled: true,
    });
    expect(isPluginEnabled({ index, pluginId: "demo" })).toBe(true);
    expect(listPluginContributionIds({ index, contribution: "providers" })).toEqual(["demo"]);
    expect(listPluginContributionIds({ index, contribution: "modelCatalogProviders" })).toEqual([
      "demo",
      "demo-alias",
    ]);
    expect(resolveProviderOwners({ index, providerId: "demo" })).toEqual(["demo"]);
    expect(
      resolvePluginContributionOwners({
        index,
        contribution: "modelCatalogProviders",
        matches: "demo-alias",
      }),
    ).toEqual(["demo"]);
    expect(
      resolvePluginContributionOwners({
        index,
        contribution: "channels",
        matches: "demo-chat",
      }),
    ).toEqual(["demo"]);
    expect(
      resolvePluginContributionOwners({
        index,
        contribution: "cliBackends",
        matches: "demo-cli",
      }),
    ).toEqual(["demo"]);
    expect(
      resolvePluginContributionOwners({
        index,
        contribution: "cliBackends",
        matches: (contributionId) => contributionId === "demo-cli",
      }),
    ).toEqual(["demo"]);
    expect(
      resolvePluginContributionOwners({
        index,
        contribution: "setupProviders",
        matches: "demo-setup",
      }),
    ).toEqual(["demo"]);
    expect(resolveManifestContractPluginIds({ index, contract: "webSearchProviders" })).toEqual([
      "demo",
    ]);
    expect(
      resolveManifestContractOwnerPluginId({
        index,
        contract: "webSearchProviders",
        value: "demo-search",
      }),
    ).toBe("demo");
    expect(
      resolveManifestContractPluginIdsByCompatibilityRuntimePath({
        index,
        contract: "webSearchProviders",
        path: "tools.web.search.demo-search.apiKey",
      }),
    ).toEqual(["demo"]);
  });

  it("keeps disabled records inspectable while excluding owners by default", () => {
    const rootDir = makeTempDir();
    const candidate = createCandidate(rootDir);
    const index = loadPluginRegistrySnapshot({
      candidates: [candidate],
      config: {
        plugins: {
          entries: {
            demo: {
              enabled: false,
            },
          },
        },
      },
      env: hermeticEnv(),
      preferPersisted: false,
    });

    expectPluginRecordFields(getPluginRecord({ index, pluginId: "demo" }), {
      pluginId: "demo",
      enabled: false,
    });
    const config = {
      plugins: {
        entries: {
          demo: {
            enabled: false,
          },
        },
      },
    };
    expect(isPluginEnabled({ index, pluginId: "demo", config })).toBe(false);
    expect(resolveProviderOwners({ index, providerId: "demo", config })).toStrictEqual([]);
    expect(
      resolveProviderOwners({ index, providerId: "demo", config, includeDisabled: true }),
    ).toEqual(["demo"]);
  });

  it("resolves contribution owners from a plugin lookup table without rereading manifests", () => {
    const rootDir = makeTempDir();
    const candidate = createCandidate(rootDir);
    const env = hermeticEnv();
    const index = loadPluginRegistrySnapshot({
      candidates: [candidate],
      env,
      preferPersisted: false,
    });
    const lookUpTable = loadPluginLookUpTable({
      config: {},
      env,
      index,
    });
    fs.unlinkSync(path.join(rootDir, "openclaw.plugin.json"));

    expect(listPluginContributionIds({ lookUpTable, contribution: "providers" })).toEqual(["demo"]);
    expect(resolveProviderOwners({ lookUpTable, providerId: "DEMO" })).toEqual(["demo"]);
    expect(
      resolvePluginContributionOwners({
        lookUpTable,
        contribution: "channels",
        matches: "demo-chat",
      }),
    ).toEqual(["demo"]);
    expect(
      resolvePluginContributionOwners({
        lookUpTable,
        contribution: "cliBackends",
        matches: "demo-cli",
      }),
    ).toEqual(["demo"]);
    expect(
      resolvePluginContributionOwners({
        lookUpTable,
        contribution: "setupProviders",
        matches: "demo-setup",
      }),
    ).toEqual(["demo"]);
    expect(
      resolvePluginContributionOwners({
        lookUpTable,
        contribution: "commandAliases",
        matches: "demo-command",
      }),
    ).toEqual(["demo"]);
    expect(
      resolvePluginContributionOwners({
        lookUpTable,
        contribution: "cliBackends",
        matches: "demo-setup-cli",
      }),
    ).toEqual(["demo"]);
    expect(
      resolvePluginContributionOwners({
        lookUpTable,
        contribution: "contracts",
        matches: "tools",
      }),
    ).toEqual(["demo"]);
  });

  it("normalizes plugin config ids through registry contribution aliases", () => {
    const rootDir = makeTempDir();
    fs.writeFileSync(path.join(rootDir, "index.ts"), "", "utf8");
    fs.writeFileSync(
      path.join(rootDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "openai",
        legacyPluginIds: ["openai-codex"],
        configSchema: { type: "object" },
        providers: ["openai", "openai"],
        channels: ["openai-chat"],
      }),
      "utf8",
    );
    const index = createIndex("openai", {
      plugins: [
        {
          ...expectDefined(
            createIndex("openai").plugins[0],
            'createIndex("openai").plugins[0] test invariant',
          ),
          manifestPath: path.join(rootDir, "openclaw.plugin.json"),
          source: path.join(rootDir, "index.ts"),
          rootDir,
        },
      ],
    });

    const normalizePluginId = createPluginRegistryIdNormalizer(index);
    expect(normalizePluginId("OpenAI-Codex")).toBe("openai");
    expect(normalizePluginId("openai-chat")).toBe("openai");
    expect(normalizePluginId("unknown-plugin")).toBe("unknown-plugin");

    const normalizedConfig = normalizePluginsConfigWithRegistry(
      {
        allow: ["openai-chat"],
        entries: {
          "OpenAI-Codex": {
            enabled: false,
          },
        },
      },
      index,
    );
    expect(normalizedConfig.allow).toEqual(["openai"]);
    expect(normalizedConfig.entries?.openai?.enabled).toBe(false);
  });

  it("normalizes plugin config ids from a provided manifest registry without rereading manifests", () => {
    const rootDir = makeTempDir();
    const candidate = createCandidate(rootDir);
    const env = hermeticEnv();
    const index = loadPluginRegistrySnapshot({
      candidates: [candidate],
      env,
      preferPersisted: false,
    });
    const lookUpTable = loadPluginLookUpTable({
      config: {},
      env,
      index,
    });
    fs.unlinkSync(path.join(rootDir, "openclaw.plugin.json"));

    const normalizePluginId = createPluginRegistryIdNormalizer(index, {
      manifestRegistry: lookUpTable.manifestRegistry,
    });

    expect(normalizePluginId("demo-chat")).toBe("demo");
    const normalizedConfig = normalizePluginsConfigWithRegistry(
      {
        allow: ["demo-chat"],
      },
      index,
      { manifestRegistry: lookUpTable.manifestRegistry },
    );
    expect(normalizedConfig.allow).toEqual(["demo"]);
  });

  it("reads the persisted registry before deriving from discovered candidates", async () => {
    const stateDir = makeTempDir();
    const rootDir = makeTempDir();
    const persistedRootDir = makeTempDir();
    const candidate = createCandidate(rootDir);
    const config = {} as const;
    fs.writeFileSync(path.join(persistedRootDir, "index.ts"), "", "utf8");
    fs.writeFileSync(
      path.join(persistedRootDir, "openclaw.plugin.json"),
      JSON.stringify({ id: "persisted", configSchema: { type: "object" } }),
      "utf8",
    );
    await writePersistedInstalledPluginIndex(
      createIndex("persisted", {
        policyHash: resolveInstalledPluginIndexPolicyHash(config),
        plugins: [
          {
            ...expectDefined(
              createIndex("persisted").plugins[0],
              'createIndex("persisted").plugins[0] test invariant',
            ),
            manifestPath: path.join(persistedRootDir, "openclaw.plugin.json"),
            manifestHash: hashFile(path.join(persistedRootDir, "openclaw.plugin.json")),
            source: path.join(persistedRootDir, "index.ts"),
            rootDir: persistedRootDir,
          },
        ],
      }),
      { stateDir },
    );

    const result = loadPluginRegistrySnapshotWithMetadata({
      stateDir,
      candidates: [candidate],
      config,
      env: hermeticEnv(),
    });

    expect(result.source).toBe("persisted");
    expect(result.diagnostics).toStrictEqual([]);
    expect(listPluginRecords({ index: result.snapshot }).map((plugin) => plugin.pluginId)).toEqual([
      "persisted",
    ]);
  });

  it("falls back to the derived registry when persisted source paths are missing", async () => {
    const stateDir = makeTempDir();
    const rootDir = makeTempDir();
    const candidate = createCandidate(rootDir);
    const config = {} as const;
    await writePersistedInstalledPluginIndex(
      createIndex("persisted", {
        policyHash: resolveInstalledPluginIndexPolicyHash(config),
      }),
      { stateDir },
    );

    const result = loadPluginRegistrySnapshotWithMetadata({
      stateDir,
      candidates: [candidate],
      config,
      env: hermeticEnv(),
    });

    expect(result.source).toBe("derived");
    expectDiagnosticCodes(result.diagnostics, ["persisted-registry-stale-source"]);
    expectSnapshotPluginIds(result.snapshot, ["demo"]);
  });

  it("falls back to the derived registry when persisted manifest metadata is stale", async () => {
    const stateDir = makeTempDir();
    const rootDir = makeTempDir();
    const candidate = createCandidate(rootDir);
    const config = {} as const;
    const persisted = loadPluginRegistrySnapshot({
      candidates: [candidate],
      config,
      env: hermeticEnv(),
      preferPersisted: false,
    });
    await writePersistedInstalledPluginIndex(persisted, { stateDir });
    fs.writeFileSync(
      path.join(rootDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "demo",
        name: "Demo",
        configSchema: { type: "object" },
        providers: ["demo", "demo-next"],
      }),
      "utf8",
    );

    const result = loadPluginRegistrySnapshotWithMetadata({
      stateDir,
      candidates: [candidate],
      config,
      env: hermeticEnv(),
    });

    expect(result.source).toBe("derived");
    expectDiagnosticCodes(result.diagnostics, ["persisted-registry-stale-source"]);
    expect(result.snapshot.plugins[0]?.manifestHash).not.toBe(persisted.plugins[0]?.manifestHash);
  });

  it("falls back to the derived registry when persisted package metadata is stale", async () => {
    const stateDir = makeTempDir();
    const rootDir = makeTempDir();
    fs.writeFileSync(
      path.join(rootDir, "package.json"),
      JSON.stringify({ name: "demo-plugin", version: "1.0.0" }),
      "utf8",
    );
    const candidate = {
      ...createCandidate(rootDir),
      packageDir: rootDir,
      packageName: "demo-plugin",
      packageVersion: "1.0.0",
    } satisfies PluginCandidate;
    const config = {} as const;
    const persisted = loadPluginRegistrySnapshot({
      candidates: [candidate],
      config,
      env: hermeticEnv(),
      preferPersisted: false,
    });
    await writePersistedInstalledPluginIndex(persisted, { stateDir });
    fs.writeFileSync(
      path.join(rootDir, "package.json"),
      JSON.stringify({ name: "demo-plugin", version: "1.0.1" }),
      "utf8",
    );

    const result = loadPluginRegistrySnapshotWithMetadata({
      stateDir,
      candidates: [candidate],
      config,
      env: hermeticEnv(),
    });

    expect(result.source).toBe("derived");
    expectDiagnosticCodes(result.diagnostics, ["persisted-registry-stale-source"]);
    expect(result.snapshot.plugins[0]?.packageJson?.hash).not.toBe(
      persisted.plugins[0]?.packageJson?.hash,
    );
  });

  it("falls back to the derived registry when persisted package metadata disappears", async () => {
    const stateDir = makeTempDir();
    const rootDir = makeTempDir();
    fs.writeFileSync(
      path.join(rootDir, "package.json"),
      JSON.stringify({ name: "demo-plugin", version: "1.0.0" }),
      "utf8",
    );
    const candidate = {
      ...createCandidate(rootDir),
      packageDir: rootDir,
      packageName: "demo-plugin",
      packageVersion: "1.0.0",
    } satisfies PluginCandidate;
    const config = {} as const;
    const persisted = loadPluginRegistrySnapshot({
      candidates: [candidate],
      config,
      env: hermeticEnv(),
      preferPersisted: false,
    });
    await writePersistedInstalledPluginIndex(persisted, { stateDir });
    fs.rmSync(path.join(rootDir, "package.json"));

    const result = loadPluginRegistrySnapshotWithMetadata({
      stateDir,
      candidates: [candidate],
      config,
      env: hermeticEnv(),
    });

    expect(result.source).toBe("derived");
    expectDiagnosticCodes(result.diagnostics, ["persisted-registry-stale-source"]);
    expect(result.snapshot.plugins[0]?.packageJson).toBeUndefined();
  });

  it("falls back to the derived registry when persisted bundled roots point at another checkout", async () => {
    const stateDir = makeTempDir();
    const rootDir = makeTempDir();
    const staleBundledRootDir = makeTempDir();
    const candidate = createCandidate(rootDir);
    createCandidate(staleBundledRootDir);
    await writePersistedInstalledPluginIndex(
      createIndex("persisted", {
        plugins: [
          {
            ...expectDefined(
              createIndex("persisted").plugins[0],
              'createIndex("persisted").plugins[0] test invariant',
            ),
            manifestPath: path.join(staleBundledRootDir, "openclaw.plugin.json"),
            source: path.join(staleBundledRootDir, "index.ts"),
            rootDir: staleBundledRootDir,
            origin: "bundled",
          },
        ],
      }),
      { stateDir },
    );

    const result = loadPluginRegistrySnapshotWithMetadata({
      stateDir,
      candidates: [candidate],
      env: hermeticEnv({ OPENCLAW_BUNDLED_PLUGINS_DIR: rootDir }),
    });

    expect(result.source).toBe("derived");
    expectDiagnosticCodes(result.diagnostics, ["persisted-registry-stale-source"]);
    expectSnapshotPluginIds(result.snapshot, ["demo"]);
  });

  it("refreshes stale built records and accepts source records for dist-opt-out plugins", async () => {
    const tempRoot = makeTempDir();
    const stateDir = path.join(tempRoot, "state");
    const packageRoot = path.join(tempRoot, "openclaw");
    const sourceRoot = path.join(packageRoot, "extensions", "demo");
    const builtRoot = path.join(packageRoot, "dist", "extensions", "demo");
    fs.mkdirSync(path.join(packageRoot, ".git"), { recursive: true });
    fs.mkdirSync(path.join(packageRoot, "src"), { recursive: true });
    fs.mkdirSync(sourceRoot, { recursive: true });
    fs.mkdirSync(builtRoot, { recursive: true });
    fs.writeFileSync(path.join(packageRoot, "pnpm-workspace.yaml"), "packages: []\n");
    const sourceCandidate = {
      ...createCandidate(sourceRoot),
      origin: "bundled" as const,
      packageDir: sourceRoot,
      packageManifest: { extensions: ["./index.ts"], build: { bundledDist: false } },
    } satisfies PluginCandidate;
    const packageJson = JSON.stringify({
      openclaw: sourceCandidate.packageManifest,
    });
    fs.writeFileSync(path.join(sourceRoot, "package.json"), packageJson);
    fs.copyFileSync(
      path.join(sourceRoot, "openclaw.plugin.json"),
      path.join(builtRoot, "openclaw.plugin.json"),
    );
    fs.copyFileSync(path.join(sourceRoot, "index.ts"), path.join(builtRoot, "index.ts"));
    fs.writeFileSync(path.join(builtRoot, "package.json"), packageJson);
    const env = hermeticEnv({
      OPENCLAW_BUNDLED_PLUGINS_DIR: path.dirname(builtRoot),
      OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
    });
    const freshIndex = loadPluginRegistrySnapshot({
      candidates: [sourceCandidate],
      env,
      preferPersisted: false,
    });
    await writePersistedInstalledPluginIndex(freshIndex, { stateDir });

    const persisted = loadPluginRegistrySnapshotWithMetadata({
      stateDir,
      candidates: [sourceCandidate],
      env,
    });
    expect(persisted.source).toBe("persisted");
    expect(persisted.diagnostics).toStrictEqual([]);

    const legacySourceIndex = structuredClone(freshIndex);
    for (const plugin of legacySourceIndex.plugins) {
      delete plugin.packageBuild;
    }
    await writePersistedInstalledPluginIndex(legacySourceIndex, { stateDir });
    const migrated = loadPluginRegistrySnapshotWithMetadata({
      stateDir,
      candidates: [sourceCandidate],
      env,
    });
    expect(migrated.source).toBe("derived");
    expectDiagnosticCodes(migrated.diagnostics, ["persisted-registry-stale-source"]);

    const staleBuiltIndex = structuredClone(freshIndex);
    for (const plugin of staleBuiltIndex.plugins) {
      plugin.rootDir = builtRoot;
      plugin.source = path.join(builtRoot, "index.ts");
      plugin.manifestPath = path.join(builtRoot, "openclaw.plugin.json");
      delete plugin.packageBuild;
    }
    await writePersistedInstalledPluginIndex(staleBuiltIndex, { stateDir });
    const refreshed = loadPluginRegistrySnapshotWithMetadata({
      stateDir,
      candidates: [sourceCandidate],
      env,
    });
    expect(refreshed.source).toBe("derived");
    expectDiagnosticCodes(refreshed.diagnostics, ["persisted-registry-stale-source"]);
    expect(refreshed.snapshot.plugins[0]?.rootDir).toBe(sourceRoot);
  });

  it("falls back to the derived registry when persisted policy is stale", async () => {
    const stateDir = makeTempDir();
    const rootDir = makeTempDir();
    const candidate = createCandidate(rootDir);
    await writePersistedInstalledPluginIndex(
      createIndex("persisted", {
        policyHash: resolveInstalledPluginIndexPolicyHash({
          plugins: { entries: { persisted: { enabled: true } } },
        }),
        installRecords: {
          persisted: {
            source: "npm",
            spec: "persisted-plugin@1.0.0",
            installPath: path.join(stateDir, "plugins", "persisted"),
          },
        },
      }),
      { stateDir },
    );

    const result = loadPluginRegistrySnapshotWithMetadata({
      stateDir,
      candidates: [candidate],
      config: {
        plugins: { entries: { demo: { enabled: true } } },
      },
      env: hermeticEnv(),
    });

    expect(result.source).toBe("derived");
    expectDiagnosticCodes(result.diagnostics, ["persisted-registry-stale-policy"]);
    expectSnapshotPluginIds(result.snapshot, ["demo"]);
    expectInstallRecord(result.snapshot.installRecords, "persisted", {
      source: "npm",
      spec: "persisted-plugin@1.0.0",
    });
  });

  it("falls back to the derived registry when the persisted registry is missing", () => {
    const stateDir = makeTempDir();
    const rootDir = makeTempDir();
    const candidate = createCandidate(rootDir);

    const result = loadPluginRegistrySnapshotWithMetadata({
      stateDir,
      candidates: [candidate],
      env: hermeticEnv(),
    });

    expect(result.source).toBe("derived");
    expectDiagnosticCodes(result.diagnostics, ["persisted-registry-missing"]);
    expectSnapshotPluginIds(result.snapshot, ["demo"]);
  });

  it("reuses config-scoped derived registries within the process", () => {
    const stateDir = makeTempDir();
    const workspaceDir = makeTempDir();
    const bundledRoot = makeTempDir();
    const rootDir = path.join(bundledRoot, "demo");
    fs.mkdirSync(rootDir, { recursive: true });
    createCandidate(rootDir);
    const env = hermeticEnv({ OPENCLAW_BUNDLED_PLUGINS_DIR: bundledRoot });
    const config = { plugins: { entries: { demo: { enabled: true } } } } as const;
    const readFileSyncSpy = vi.spyOn(fs, "readFileSync");

    const first = loadPluginRegistrySnapshotWithMetadata({
      stateDir,
      workspaceDir,
      config,
      env,
    });
    const manifestReadsAfterFirst = readFileSyncSpy.mock.calls.filter((call) =>
      String(call[0]).endsWith("openclaw.plugin.json"),
    ).length;

    const second = loadPluginRegistrySnapshotWithMetadata({
      stateDir,
      workspaceDir,
      config,
      env,
    });
    const manifestReadsAfterSecond = readFileSyncSpy.mock.calls.filter((call) =>
      String(call[0]).endsWith("openclaw.plugin.json"),
    ).length;

    expect(first.source).toBe("derived");
    expect(second.source).toBe("derived");
    expect(manifestReadsAfterFirst).toBeGreaterThan(0);
    expect(manifestReadsAfterSecond).toBe(manifestReadsAfterFirst);
  });

  it("does not reuse the process registry memo after profile extensions change", () => {
    const stateDir = makeTempDir();
    const configDir = makeTempDir();
    const extensionsDir = path.join(configDir, "extensions");
    const firstRoot = path.join(extensionsDir, "first");
    fs.mkdirSync(firstRoot, { recursive: true });
    createCandidate(firstRoot, "first");
    const env = hermeticEnv({
      OPENCLAW_CONFIG_PATH: path.join(configDir, "openclaw.json"),
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    });

    const first = loadPluginRegistrySnapshotWithMetadata({ stateDir, env });
    const secondRoot = path.join(extensionsDir, "second");
    fs.mkdirSync(secondRoot, { recursive: true });
    createCandidate(secondRoot, "second");
    const second = loadPluginRegistrySnapshotWithMetadata({ stateDir, env });

    expect(first.source).toBe("derived");
    expect(second.source).toBe("derived");
    expectSnapshotPluginIds(first.snapshot, ["first"]);
    expectSnapshotPluginIds(second.snapshot, ["first", "second"]);
  });

  it("keys the process registry memo by resolved host contract version", () => {
    const stateDir = makeTempDir();
    const bundledRoot = makeTempDir();
    const rootDir = path.join(bundledRoot, "demo");
    fs.mkdirSync(rootDir, { recursive: true });
    createCandidate(rootDir);
    const config = { plugins: { entries: { demo: { enabled: true } } } } as const;

    const first = loadPluginRegistrySnapshotWithMetadata({
      stateDir,
      config,
      env: hermeticEnv({ OPENCLAW_BUNDLED_PLUGINS_DIR: bundledRoot }),
    });
    const second = loadPluginRegistrySnapshotWithMetadata({
      stateDir,
      config,
      env: hermeticEnv({
        OPENCLAW_BUNDLED_PLUGINS_DIR: bundledRoot,
        OPENCLAW_VERSION: "2026.4.26",
      }),
    });

    expect(first.snapshot.hostContractVersion).toBe("2026.4.25");
    expect(second.snapshot.hostContractVersion).toBe("2026.4.26");
  });

  it("clears the process registry memo after persisted registry writes", async () => {
    const stateDir = makeTempDir();
    const env = hermeticEnv();
    await writePersistedInstalledPluginIndex(createPersistableIndex("first"), { stateDir });

    const first = loadPluginRegistrySnapshotWithMetadata({ stateDir, env });
    await writePersistedInstalledPluginIndex(createPersistableIndex("second"), { stateDir });
    const second = loadPluginRegistrySnapshotWithMetadata({ stateDir, env });

    expect(first.source).toBe("persisted");
    expect(second.source).toBe("persisted");
    expectSnapshotPluginIds(first.snapshot, ["first"]);
    expectSnapshotPluginIds(second.snapshot, ["second"]);
  });

  it("does not reuse the process registry memo after the persisted registry file changes", async () => {
    const stateDir = makeTempDir();
    const env = hermeticEnv();
    await writePersistedInstalledPluginIndex(createPersistableIndex("first"), { stateDir });
    const first = loadPluginRegistrySnapshotWithMetadata({ stateDir, env });
    const external = createPersistableIndex("second-external");
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        db.prepare(
          `
            UPDATE installed_plugin_index
               SET plugins_json = ?,
                   install_records_json = ?,
                   diagnostics_json = ?,
                   updated_at_ms = ?
             WHERE index_key = 'installed-plugin-index'
          `,
        ).run(
          JSON.stringify(external.plugins),
          JSON.stringify(external.installRecords),
          JSON.stringify(external.diagnostics),
          Date.now(),
        );
      },
      { env: { ...env, OPENCLAW_STATE_DIR: stateDir } },
    );
    const second = loadPluginRegistrySnapshotWithMetadata({ stateDir, env });

    expect(first.source).toBe("persisted");
    expect(second.source).toBe("persisted");
    expectSnapshotPluginIds(first.snapshot, ["first"]);
    expectSnapshotPluginIds(second.snapshot, ["second-external"]);
  });

  it("falls back to the derived registry when persisted reads are disabled", async () => {
    const stateDir = makeTempDir();
    const rootDir = makeTempDir();
    const candidate = createCandidate(rootDir);
    await writePersistedInstalledPluginIndex(createIndex("persisted"), { stateDir });

    const result = loadPluginRegistrySnapshotWithMetadata({
      stateDir,
      candidates: [candidate],
      env: hermeticEnv({ [DISABLE_PERSISTED_PLUGIN_REGISTRY_ENV]: "1" }),
    });

    expect(result.source).toBe("derived");
    expectDiagnosticCodes(result.diagnostics, ["persisted-registry-disabled"]);
    expect(String(requireRecord(result.diagnostics[0], "diagnostic").message)).toContain(
      "deprecated break-glass compatibility switch",
    );
    expectSnapshotPluginIds(result.snapshot, ["demo"]);
  });

  it("derives a fresh registry without persisted install records when caller disables persisted reads", async () => {
    const stateDir = makeTempDir();
    const rootDir = makeTempDir();
    const candidate = createCandidate(rootDir);
    await writePersistedInstalledPluginIndex(
      createIndex("persisted", {
        installRecords: {
          persisted: {
            source: "npm",
            spec: "persisted-plugin@1.0.0",
            installPath: path.join(stateDir, "plugins", "persisted"),
          },
        },
      }),
      { stateDir },
    );

    const result = loadPluginRegistrySnapshotWithMetadata({
      stateDir,
      candidates: [candidate],
      env: hermeticEnv(),
      preferPersisted: false,
    });

    expect(result.source).toBe("derived");
    expectSnapshotPluginIds(result.snapshot, ["demo"]);
    expect(result.snapshot.installRecords).not.toHaveProperty("persisted");
  });

  it("exposes explicit persisted registry inspect and refresh operations", async () => {
    const stateDir = makeTempDir();
    const pluginDir = path.join(stateDir, "plugins", "demo");
    fs.mkdirSync(pluginDir, { recursive: true });
    const candidate = createCandidate(pluginDir);
    const env = hermeticEnv();

    const missingInspect = await inspectPluginRegistry({ stateDir, candidates: [candidate], env });
    expect(missingInspect.state).toBe("missing");
    expect(missingInspect.refreshReasons).toEqual(["missing"]);
    expect(missingInspect.persisted).toBeNull();
    expect(missingInspect.current.plugins.map((plugin) => plugin.pluginId)).toEqual(["demo"]);

    await refreshPluginRegistry({
      reason: "manual",
      stateDir,
      candidates: [candidate],
      env,
    });

    const freshInspect = await inspectPluginRegistry({ stateDir, candidates: [candidate], env });
    expect(freshInspect.state).toBe("fresh");
    expect(freshInspect.refreshReasons).toEqual([]);
    expect(freshInspect.persisted?.plugins.map((plugin) => plugin.pluginId)).toEqual(["demo"]);
  });

  it("preserves install records when refreshing the persisted registry", async () => {
    const stateDir = makeTempDir();
    await writePersistedInstalledPluginIndex(
      createIndex("missing", {
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

    await refreshPluginRegistry({
      reason: "manual",
      stateDir,
      candidates: [],
      env: hermeticEnv(),
    });

    const persisted = await readPersistedInstalledPluginIndex({ stateDir });
    if (!persisted) {
      throw new Error("Expected persisted plugin index");
    }
    expectInstallRecord(persisted.installRecords, "missing", {
      source: "npm",
      spec: "missing-plugin@1.0.0",
      installPath: path.join(stateDir, "plugins", "missing"),
    });
    expect(persisted.plugins).toEqual([]);
  });
});
