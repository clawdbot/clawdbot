import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PluginCandidate } from "./discovery.js";
import {
  readPersistedInstalledPluginIndex,
  writePersistedInstalledPluginIndex,
} from "./installed-plugin-index-store.js";
import {
  resolveInstalledPluginIndexPolicyHash,
  type InstalledPluginIndex,
} from "./installed-plugin-index.js";
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
    OPENCLAW_DISABLE_PLUGIN_DISCOVERY_CACHE: "1",
    OPENCLAW_DISABLE_PLUGIN_MANIFEST_CACHE: "1",
    OPENCLAW_VERSION: "2026.4.25",
    VITEST: "true",
    ...overrides,
  };
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
        manifestPath: `/plugins/${pluginId}/openclaw.plugin.json`,
        manifestHash: "manifest-hash",
        rootDir: `/plugins/${pluginId}`,
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
    expect(resolveProviderOwners({ index, providerId: "demo" })).toEqual(["demo"]);
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

  it("reads the persisted registry before deriving from discovered candidates", async () => {
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

    expect(result.source).toBe("persisted");
    expect(result.diagnostics).toEqual([]);
    expect(listPluginRecords({ index: result.snapshot }).map((plugin) => plugin.pluginId)).toEqual([
      "persisted",
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
