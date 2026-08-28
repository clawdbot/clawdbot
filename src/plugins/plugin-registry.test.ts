import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
// Covers plugin registry assembly, contribution lookup, and reset behavior.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { recordPluginCandidateInstallOwner } from "./candidate-install-owner.js";
import type { PluginCandidate } from "./discovery.js";
import { writePersistedInstalledPluginIndex } from "./installed-plugin-index-store-write.js";
import {
  resolveInstalledPluginIndexPolicyHash,
  type InstalledPluginIndex,
} from "./installed-plugin-index.js";
import { loadPluginLookUpTable } from "./plugin-lookup-table.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import {
  createPluginRegistryIdNormalizer,
  getPluginRecord,
  isPluginEnabled,
  listPluginContributionIds,
  loadPluginRegistrySnapshot,
  loadPluginRegistrySnapshotWithMetadata,
  normalizePluginsConfigWithRegistry,
  resolveManifestContractOwnerPluginId,
  resolveManifestContractPluginIds,
  resolvePluginContributionOwners,
} from "./plugin-registry.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const tempDirs: string[] = [];

function resolveProviderOwners(
  params: Omit<
    Parameters<typeof resolvePluginContributionOwners>[0],
    "contribution" | "matches"
  > & { providerId: string },
) {
  const providerId = params.providerId.trim().toLowerCase();
  const { providerId: _providerId, ...options } = params;
  return resolvePluginContributionOwners({
    ...options,
    contribution: "providers",
    matches: (candidate) => candidate.trim().toLowerCase() === providerId,
  });
}

function listPluginRecords(params: { index: InstalledPluginIndex }) {
  return params.index.plugins;
}

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

function createCandidate(
  rootDir: string,
  pluginId = "demo",
  installOwner?: string,
): PluginCandidate {
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
        compatibilityRuntimePaths: [`legacyProvider.${pluginId}-search.webhook`],
      },
    }),
    "utf8",
  );
  return recordPluginCandidateInstallOwner(
    {
      idHint: pluginId,
      source: path.join(rootDir, "index.ts"),
      rootDir,
      origin: "global",
    },
    installOwner,
  );
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
          agentHarnesses: [],
        },
        compat: [],
      },
    ],
    diagnostics: [],
    ...overrides,
  };
}

const requireRecord = createRequireRecord("object", "expected-label");

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

  it("keeps missing disabled records inspectable from the persisted registry", async () => {
    const stateDir = makeTempDir();
    const rootDir = makeTempDir();
    const config = { plugins: { entries: { demo: { enabled: false } } } };
    const env = hermeticEnv();
    const persisted = loadPluginRegistrySnapshot({
      candidates: [createCandidate(rootDir)],
      config,
      env,
      preferPersisted: false,
    });
    await writePersistedInstalledPluginIndex(persisted, { stateDir });
    fs.rmSync(rootDir, { recursive: true });

    const result = loadPluginRegistrySnapshotWithMetadata({ stateDir, config, env });

    expect(result.source).toBe("persisted");
    expectPluginRecordFields(getPluginRecord({ index: result.snapshot, pluginId: "demo" }), {
      pluginId: "demo",
      enabled: false,
    });
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
    for (const [contribution, matches] of [
      ["providers", "demo"],
      ["channels", "demo-chat"],
      ["channelConfigs", "demo-chat"],
      ["cliBackends", "demo-cli"],
      ["cliBackends", "demo-setup-cli"],
      ["setupProviders", "demo-setup"],
      ["modelCatalogProviders", "demo-alias"],
      ["commandAliases", "demo-command"],
      ["contracts", "tools"],
    ] as const) {
      const query = { lookUpTable, contribution, matches };
      expect(resolvePluginContributionOwners(query), contribution).toEqual(["demo"]);
      expect(
        resolvePluginContributionOwners({ ...query, matches: "missing" }),
        contribution,
      ).toEqual([]);
    }

    const policies: Array<[OpenClawConfig["plugins"], boolean]> = [
      [undefined, true],
      [{ enabled: false }, false],
      [{ deny: ["demo"] }, false],
      [{ allow: ["other"] }, false],
      [{ allow: ["demo"] }, true],
      [{ entries: { demo: { enabled: false } } }, false],
      [{ entries: { demo: { enabled: true } } }, true],
    ];
    for (const matches of ["demo-alias", (id: string) => id === "demo-alias"]) {
      for (const [plugins, enabled] of policies) {
        const params = {
          lookUpTable,
          ...(plugins ? { config: { plugins } } : {}),
          contribution: "modelCatalogProviders" as const,
          matches,
        };
        expect(resolvePluginContributionOwners(params)).toEqual(enabled ? ["demo"] : []);
        expect(resolvePluginContributionOwners({ ...params, includeDisabled: true })).toEqual([
          "demo",
        ]);
      }
    }
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

  it("treats explicit discovered candidates as authoritative", async () => {
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

    expect(result.source).toBe("derived");
    expectDiagnosticCodes(result.diagnostics, ["persisted-registry-stale-source"]);
    expect(listPluginRecords({ index: result.snapshot }).map((plugin) => plugin.pluginId)).toEqual([
      "demo",
    ]);
  });

  it("keeps content-equivalent timestamp changes on the persisted path", async () => {
    const stateDir = makeTempDir();
    const rootDir = makeTempDir();
    const env = hermeticEnv();
    const persisted = loadPluginRegistrySnapshot({
      candidates: [createCandidate(rootDir)],
      env,
      preferPersisted: false,
    });
    await writePersistedInstalledPluginIndex(
      {
        ...persisted,
        plugins: [
          {
            ...expectDefined(persisted.plugins[0], "persisted plugin test invariant"),
            syntheticAuthRefs: ["demo"],
          },
          ...persisted.plugins.slice(1),
        ],
      },
      { stateDir },
    );
    const manifestPath = path.join(rootDir, "openclaw.plugin.json");
    const future = new Date(Date.now() + 1_000);
    fs.utimesSync(manifestPath, future, future);

    const result = loadPluginRegistrySnapshotWithMetadata({ stateDir, env });

    expect(result.source).toBe("persisted");
    expect(result.snapshot.plugins[0]?.syntheticAuthRefs).toEqual(["demo"]);
  });

  it("reads install records from a custom SQLite registry path", async () => {
    const tempDir = makeTempDir();
    const rootDir = makeTempDir();
    const filePath = path.join(tempDir, "custom-registry.sqlite");
    const env = hermeticEnv({
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_STATE_DIR: tempDir,
    });
    const installRecords = {
      demo: { source: "npm" as const, spec: "demo@1.0.0", installPath: rootDir },
    };
    const persisted = loadPluginRegistrySnapshot({
      candidates: [createCandidate(rootDir, "demo", "demo")],
      installRecords,
      env,
      preferPersisted: false,
    });
    await writePersistedInstalledPluginIndex(persisted, { filePath });

    const result = loadPluginRegistrySnapshotWithMetadata({ filePath, env });

    expect(result.source).toBe("persisted");
    expectInstallRecord(result.snapshot.installRecords, "demo", {
      source: "npm",
      spec: "demo@1.0.0",
      installPath: rootDir,
    });
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

  it("derives config-scoped registries for cold callers", () => {
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
    expect(manifestReadsAfterSecond).toBeGreaterThan(manifestReadsAfterFirst);
  });

  it("reloads profile extensions after the metadata lifecycle is cleared", () => {
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
    clearPluginMetadataLifecycleCaches();
    const second = loadPluginRegistrySnapshotWithMetadata({ stateDir, env });

    expect(first.source).toBe("derived");
    expect(second.source).toBe("derived");
    expectSnapshotPluginIds(first.snapshot, ["first"]);
    expectSnapshotPluginIds(second.snapshot, ["first", "second"]);
  });

  it("derives the resolved host contract version", () => {
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
});
