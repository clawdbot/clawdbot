import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  resolveChannelOwners,
  resolveCliBackendOwners,
  resolveManifestContractOwnerPluginId,
  resolveManifestContractPluginIds,
  resolveManifestContractPluginIdsByCompatibilityRuntimePath,
  resolvePluginContributionOwners,
  resolveProviderOwners,
  resolveSetupProviderOwners,
} from "./plugin-registry.js";
import { resolvePluginPath } from "./registry.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const tempDirs: string[] = [];

afterEach(() => {
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

function createCandidate(rootDir: string): PluginCandidate {
  fs.writeFileSync(
    path.join(rootDir, "index.ts"),
    "throw new Error('runtime entry should not load while reading plugin registry');\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(rootDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: "demo",
      name: "Demo",
      configSchema: { type: "object" },
      providers: ["demo"],
      channels: ["demo-chat"],
      cliBackends: ["demo-cli"],
      setup: {
        providers: [{ id: "demo-setup", envVars: ["DEMO_API_KEY"] }],
        cliBackends: ["demo-setup-cli"],
      },
      channelConfigs: {
        "demo-chat": {
          schema: { type: "object" },
        },
      },
      modelCatalog: {
        aliases: {
          "demo-alias": {
            provider: "demo",
          },
        },
        providers: {
          demo: {
            models: [{ id: "demo-model" }],
          },
        },
      },
      commandAliases: [{ name: "demo-command" }],
      contracts: {
        tools: ["demo-tool"],
        webSearchProviders: ["demo-search"],
      },
      configContracts: {
        compatibilityRuntimePaths: ["tools.web.search.demo-search.apiKey"],
      },
    }),
    "utf8",
  );
  return {
    idHint: "demo",
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
    expect(getPluginRecord({ index, pluginId: "demo" })).toMatchObject({
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
    expect(resolveChannelOwners({ index, channelId: "demo-chat" })).toEqual(["demo"]);
    expect(resolveCliBackendOwners({ index, cliBackendId: "demo-cli" })).toEqual(["demo"]);
    expect(
      resolvePluginContributionOwners({
        index,
        contribution: "cliBackends",
        matches: (contributionId) => contributionId === "demo-cli",
      }),
    ).toEqual(["demo"]);
    expect(resolveSetupProviderOwners({ index, setupProviderId: "demo-setup" })).toEqual(["demo"]);
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

    expect(getPluginRecord({ index, pluginId: "demo" })).toMatchObject({
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
    expect(resolveProviderOwners({ index, providerId: "demo", config })).toEqual([]);
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
    expect(resolveChannelOwners({ lookUpTable, channelId: "demo-chat" })).toEqual(["demo"]);
    expect(resolveCliBackendOwners({ lookUpTable, cliBackendId: "demo-cli" })).toEqual(["demo"]);
    expect(resolveCliBackendOwners({ lookUpTable, cliBackendId: "demo-setup-cli" })).toEqual([
      "demo",
    ]);
    expect(resolveSetupProviderOwners({ lookUpTable, setupProviderId: "demo-setup" })).toEqual([
      "demo",
    ]);
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
        configSchema: { type: "object" },
        providers: ["openai", "openai-codex"],
        channels: ["openai-chat"],
      }),
      "utf8",
    );
    const index = createIndex("openai", {
      plugins: [
        {
          ...createIndex("openai").plugins[0],
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

    expect(
      normalizePluginsConfigWithRegistry(
        {
          allow: ["openai-chat"],
          entries: {
            "OpenAI-Codex": {
              enabled: false,
            },
          },
        },
        index,
      ),
    ).toMatchObject({
      allow: ["openai"],
      entries: {
        openai: {
          enabled: false,
        },
      },
    });
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
    expect(
      normalizePluginsConfigWithRegistry(
        {
          allow: ["demo-chat"],
        },
        index,
        { manifestRegistry: lookUpTable.manifestRegistry },
      ),
    ).toMatchObject({
      allow: ["demo"],
    });
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
            ...createIndex("persisted").plugins[0],
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
    expect(result.diagnostics).toEqual([]);
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
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "persisted-registry-stale-source" }),
    ]);
    expect(listPluginRecords({ index: result.snapshot }).map((plugin) => plugin.pluginId)).toEqual([
      "demo",
    ]);
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
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "persisted-registry-stale-source" }),
    ]);
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
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "persisted-registry-stale-source" }),
    ]);
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
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "persisted-registry-stale-source" }),
    ]);
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
            ...createIndex("persisted").plugins[0],
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
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "persisted-registry-stale-source" }),
    ]);
    expect(listPluginRecords({ index: result.snapshot }).map((plugin) => plugin.pluginId)).toEqual([
      "demo",
    ]);
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
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "persisted-registry-stale-policy" }),
    ]);
    expect(listPluginRecords({ index: result.snapshot }).map((plugin) => plugin.pluginId)).toEqual([
      "demo",
    ]);
    expect(result.snapshot.installRecords).toMatchObject({
      persisted: {
        source: "npm",
        spec: "persisted-plugin@1.0.0",
      },
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
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "persisted-registry-missing" }),
    ]);
    expect(listPluginRecords({ index: result.snapshot }).map((plugin) => plugin.pluginId)).toEqual([
      "demo",
    ]);
  });

  it("derives fresh config-scoped registries when the persisted registry is missing", () => {
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
    expect(second).not.toBe(first);
    expect(manifestReadsAfterFirst).toBeGreaterThan(0);
    expect(manifestReadsAfterSecond).toBeGreaterThan(manifestReadsAfterFirst);
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
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "persisted-registry-disabled",
        message: expect.stringContaining("deprecated break-glass compatibility switch"),
      }),
    ]);
    expect(listPluginRecords({ index: result.snapshot }).map((plugin) => plugin.pluginId)).toEqual([
      "demo",
    ]);
  });

  it("derives a fresh registry without dropping persisted install records", async () => {
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
    expect(listPluginRecords({ index: result.snapshot }).map((plugin) => plugin.pluginId)).toEqual([
      "demo",
    ]);
    expect(result.snapshot.installRecords).toMatchObject({
      persisted: {
        source: "npm",
        spec: "persisted-plugin@1.0.0",
      },
    });
  });

  it("exposes explicit persisted registry inspect and refresh operations", async () => {
    const stateDir = makeTempDir();
    const pluginDir = path.join(stateDir, "plugins", "demo");
    fs.mkdirSync(pluginDir, { recursive: true });
    const candidate = createCandidate(pluginDir);
    const env = hermeticEnv();

    await expect(
      inspectPluginRegistry({ stateDir, candidates: [candidate], env }),
    ).resolves.toMatchObject({
      state: "missing",
      refreshReasons: ["missing"],
      persisted: null,
      current: {
        plugins: [expect.objectContaining({ pluginId: "demo" })],
      },
    });

    await refreshPluginRegistry({
      reason: "manual",
      stateDir,
      candidates: [candidate],
      env,
    });

    await expect(
      inspectPluginRegistry({ stateDir, candidates: [candidate], env }),
    ).resolves.toMatchObject({
      state: "fresh",
      refreshReasons: [],
      persisted: {
        plugins: [expect.objectContaining({ pluginId: "demo" })],
      },
    });
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

    await expect(readPersistedInstalledPluginIndex({ stateDir })).resolves.toMatchObject({
      installRecords: {
        missing: {
          source: "npm",
          spec: "missing-plugin@1.0.0",
          installPath: path.join(stateDir, "plugins", "missing"),
        },
      },
      plugins: [],
    });
  });
});
