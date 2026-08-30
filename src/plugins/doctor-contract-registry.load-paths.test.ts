// Covers doctor contract registry load paths for plugins.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { findLegacyConfigIssues } from "../config/legacy.js";
import type { OpenClawConfig } from "../config/types.js";
import { getCurrentPluginMetadataSnapshot } from "./current-plugin-metadata-snapshot.js";
import {
  applyPluginDoctorCompatibilityMigrations,
  listPluginDoctorLegacyConfigRules,
  listPluginDoctorSessionRouteStateOwners,
  listPluginDoctorStateMigrationEntries,
} from "./doctor-contract-registry.js";
import { clearPluginDoctorContractRegistryCache } from "./doctor-contract-registry.test-fixtures.js";
import {
  createPluginMetadataOwner,
  withPluginMetadataCollectionScope,
} from "./plugin-metadata-collection.js";

const tempDirs = createTempDirTracker();

function makeHermeticDoctorEnv(stateDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: stateDir,
    OPENCLAW_HOME: stateDir,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
  };
}

function writeDoctorPlugin(pluginRoot: string, pluginId: string): void {
  fs.mkdirSync(pluginRoot, { recursive: true });
  fs.writeFileSync(
    path.join(pluginRoot, "openclaw.plugin.json"),
    JSON.stringify(
      {
        id: pluginId,
        name: "Load Path Doctor",
        version: "0.0.0-test",
        configSchema: {},
      },
      null,
      2,
    ),
    "utf8",
  );
  fs.writeFileSync(path.join(pluginRoot, "index.cjs"), "module.exports = {};\n", "utf8");
  fs.writeFileSync(
    path.join(pluginRoot, "doctor-contract-api.cjs"),
    `
const pluginId = ${JSON.stringify(pluginId)};

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

module.exports = {
  legacyConfigRules: [
    {
      path: ["plugins", "entries", pluginId, "config", "summaryModel"],
      message: "load-path doctor contract warning",
    },
  ],
  normalizeCompatibilityConfig({ cfg }) {
    const root = isRecord(cfg) ? { ...cfg } : {};
    const plugins = isRecord(root.plugins) ? { ...root.plugins } : {};
    const entries = isRecord(plugins.entries) ? { ...plugins.entries } : {};
    const entry = isRecord(entries[pluginId]) ? { ...entries[pluginId] } : {};
    const llm = isRecord(entry.llm) ? { ...entry.llm } : {};
    const allowedModels = Array.isArray(llm.allowedModels) ? [...llm.allowedModels] : [];
    if (!allowedModels.includes("openai/gpt-5.4-mini")) {
      allowedModels.push("openai/gpt-5.4-mini");
    }
    root.plugins = plugins;
    plugins.entries = entries;
    entries[pluginId] = entry;
    entry.llm = {
      ...llm,
      allowModelOverride: true,
      allowedModels,
    };
    return {
      config: root,
      changes: ["configured load-path doctor contract LLM policy"],
    };
  },
};
`,
    "utf8",
  );
}

function writeDistDoctorPlugin(pluginRoot: string, pluginId: string): void {
  fs.mkdirSync(path.join(pluginRoot, "dist"), { recursive: true });
  fs.writeFileSync(
    path.join(pluginRoot, "openclaw.plugin.json"),
    JSON.stringify(
      {
        id: pluginId,
        name: "Dist Doctor",
        version: "0.0.0-test",
        configSchema: {},
      },
      null,
      2,
    ),
    "utf8",
  );
  fs.writeFileSync(
    path.join(pluginRoot, "package.json"),
    JSON.stringify(
      {
        name: `@openclaw/${pluginId}`,
        version: "0.0.0-test",
        type: "module",
        openclaw: {
          extensions: ["./dist/index.js"],
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  fs.writeFileSync(path.join(pluginRoot, "dist", "index.js"), "export {};\n", "utf8");
  fs.writeFileSync(
    path.join(pluginRoot, "dist", "doctor-contract-api.cjs"),
    `
module.exports = {
  legacyConfigRules: [
    {
      path: ["plugins", "entries", ${JSON.stringify(pluginId)}, "config", "distOnly"],
      message: "dist doctor contract warning",
    },
  ],
};
`,
    "utf8",
  );
}

function writeLegacyRuntimeDoctorPlugin(params: {
  pluginRoot: string;
  pluginId: string;
  importedSymbols: readonly string[];
}): void {
  fs.mkdirSync(path.join(params.pluginRoot, "dist"), { recursive: true });
  fs.writeFileSync(
    path.join(params.pluginRoot, "openclaw.plugin.json"),
    JSON.stringify({
      id: params.pluginId,
      doctorContract: { configRepair: true },
      configSchema: {},
    }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(params.pluginRoot, "package.json"),
    JSON.stringify({
      name: `@openclaw/${params.pluginId}`,
      version: "2026.7.2-beta.7",
      type: "module",
      openclaw: { extensions: ["./dist/index.js"] },
    }),
    "utf8",
  );
  fs.writeFileSync(path.join(params.pluginRoot, "dist", "index.js"), "export {};\n", "utf8");
  fs.writeFileSync(
    path.join(params.pluginRoot, "dist", "doctor-contract-api.js"),
    `import { ${params.importedSymbols.join(", ")} } from "openclaw/plugin-sdk/runtime-doctor";
const importedHelpers = [${params.importedSymbols.join(", ")}];
if (importedHelpers.some((helper) => typeof helper !== "function")) {
  throw new Error("legacy runtime-doctor helper missing");
}
export const legacyConfigRules = [{
  path: ["plugins", "entries", ${JSON.stringify(params.pluginId)}, "config", "legacyDoctor"],
  message: ${JSON.stringify(`${params.pluginId} legacy doctor contract loaded`)},
}];
`,
    "utf8",
  );
}

function writeLegacyChannelMigrationPlugin(params: {
  pluginRoot: string;
  pluginId: string;
  namespace: string;
  sourceFile: string;
  stateKey: string;
  label?: string;
}): void {
  fs.mkdirSync(params.pluginRoot, { recursive: true });
  fs.writeFileSync(
    path.join(params.pluginRoot, "openclaw.plugin.json"),
    JSON.stringify({ id: params.pluginId, channels: [params.pluginId], configSchema: {} }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(params.pluginRoot, "package.json"),
    JSON.stringify({
      name: `@openclaw/${params.pluginId}`,
      version: "2026.7.1",
      type: "commonjs",
      openclaw: {
        extensions: ["./index.cjs"],
        setupEntry: "./setup-entry.cjs",
        setupFeatures: { legacyStateMigrations: true },
      },
    }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(params.pluginRoot, "index.cjs"),
    "throw new Error('legacy discovery loaded the channel runtime');\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(params.pluginRoot, "doctor-contract-api.cjs"),
    "module.exports = { legacyConfigRules: [] };\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(params.pluginRoot, "setup-entry.cjs"),
    `const fs = require('node:fs');
const path = require('node:path');
const pluginId = ${JSON.stringify(params.pluginId)};
const namespace = ${JSON.stringify(params.namespace)};
const sourceFile = ${JSON.stringify(params.sourceFile)};
const stateKey = ${JSON.stringify(params.stateKey)};
const label = ${JSON.stringify(params.label ?? `${params.pluginId} preserved channel state`)};
module.exports = {
  kind: 'bundled-channel-setup-entry',
  features: { legacyStateMigrations: true },
  loadSetupPlugin() {
    throw new Error('direct detector activated the setup plugin');
  },
  loadLegacyStateMigrationDetector() {
    return ({ stateDir }) => {
      const sourcePath = path.join(stateDir, pluginId, sourceFile);
      if (!fs.existsSync(sourcePath)) return [];
      return [{
        kind: 'plugin-state-import',
        label,
        sourcePath,
        targetPath: 'plugin state:' + namespace,
        pluginId,
        namespace,
        maxEntries: 1000,
        scopeKey: '',
        cleanupSource: 'rename',
        readEntries: () => [{ key: stateKey, value: JSON.parse(fs.readFileSync(sourcePath, 'utf8')) }],
      }];
    };
  },
};\n`,
    "utf8",
  );
}

function writeModernBundledChannelMigrationPlugin(params: {
  pluginRoot: string;
  pluginId: string;
}): void {
  fs.mkdirSync(params.pluginRoot, { recursive: true });
  fs.writeFileSync(
    path.join(params.pluginRoot, "openclaw.plugin.json"),
    JSON.stringify({
      id: params.pluginId,
      channels: [params.pluginId],
      doctorContract: { stateMigrations: true },
      configSchema: {},
    }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(params.pluginRoot, "package.json"),
    JSON.stringify({
      name: `@openclaw/${params.pluginId}`,
      version: "2026.7.1",
      type: "commonjs",
      openclaw: {
        extensions: ["./index.cjs"],
        setupEntry: "./setup-entry.cjs",
      },
    }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(params.pluginRoot, "index.cjs"),
    "throw new Error('shadowed bundled channel runtime loaded');\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(params.pluginRoot, "setup-entry.cjs"),
    `module.exports = {
  kind: 'bundled-channel-setup-entry',
  loadSetupPlugin() { return {}; },
};\n`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(params.pluginRoot, "doctor-contract-api.cjs"),
    `module.exports = { stateMigrations: [{
  id: 'bundled-modern-state',
  label: 'Bundled modern state',
  detectLegacyState: () => null,
  migrateLegacyState: () => ({ changes: [], warnings: [] }),
}] };\n`,
    "utf8",
  );
}

function writeDoctorSessionOwnerPlugin(pluginRoot: string, pluginId: string): void {
  fs.mkdirSync(pluginRoot, { recursive: true });
  fs.writeFileSync(
    path.join(pluginRoot, "openclaw.plugin.json"),
    JSON.stringify(
      {
        id: pluginId,
        name: "Load Path Session Owner",
        version: "0.0.0-test",
        configSchema: {},
        sessionRouteStateOwners: [
          {
            id: "load-path-session-owner",
            label: "Load Path Session Owner",
            providerIds: ["load-path-provider"],
            runtimeIds: ["load-path-runtime"],
            cliSessionKeys: ["load-path-cli"],
            authProfilePrefixes: ["load-path:"],
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );
  fs.writeFileSync(path.join(pluginRoot, "index.cjs"), "module.exports = {};\n", "utf8");
}

function writeLegacyDoctorSessionOwnerPlugin(pluginRoot: string, pluginId: string): void {
  fs.mkdirSync(pluginRoot, { recursive: true });
  fs.writeFileSync(
    path.join(pluginRoot, "openclaw.plugin.json"),
    JSON.stringify({ id: pluginId, configSchema: {} }),
    "utf8",
  );
  fs.writeFileSync(path.join(pluginRoot, "index.cjs"), "module.exports = {};\n", "utf8");
  fs.writeFileSync(
    path.join(pluginRoot, "doctor-contract-api.cjs"),
    `module.exports = {
  sessionRouteStateOwners: [{
    id: "legacy-load-path-owner",
    label: "Legacy Load Path Owner",
    providerIds: ["legacy-provider"],
  }],
};
`,
    "utf8",
  );
}

function createDoctorPluginConfig(pluginRoot: string, pluginId: string): OpenClawConfig {
  return {
    plugins: {
      load: { paths: [pluginRoot] },
      entries: {
        [pluginId]: {
          enabled: true,
          config: {
            summaryModel: "gpt-5.4-mini",
          },
        },
      },
    },
  };
}

function readPluginLlmPolicy(config: OpenClawConfig, pluginId: string): Record<string, unknown> {
  const entry = config.plugins?.entries?.[pluginId] as { llm?: unknown } | undefined;
  return entry?.llm && typeof entry.llm === "object" && !Array.isArray(entry.llm)
    ? (entry.llm as Record<string, unknown>)
    : {};
}

beforeEach(() => {
  clearPluginDoctorContractRegistryCache();
});

afterEach(() => {
  clearPluginDoctorContractRegistryCache();
  tempDirs.cleanup();
});

describe("doctor contract registry load-path plugins", () => {
  it("keeps config-wide Doctor rules separate from exact workspace contracts until repair refresh", () => {
    const stateDir = fs.realpathSync(tempDirs.make("openclaw-doctor-contract-workspaces-"));
    const workspaceDirs = [path.join(stateDir, "ops"), path.join(stateDir, "research")];
    const pluginIds = ["ops-doctor", "research-doctor"];
    const pluginRoots = workspaceDirs.map((workspaceDir, index) => {
      const pluginRoot = path.join(workspaceDir, ".openclaw", "extensions", pluginIds[index]!);
      writeDoctorPlugin(pluginRoot, pluginIds[index]!);
      return pluginRoot;
    });
    const config: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        entries: {
          ops: { workspace: workspaceDirs[0] },
          research: { workspace: workspaceDirs[1] },
        },
      },
      plugins: {
        entries: Object.fromEntries(pluginIds.map((id) => [id, { enabled: true }])),
      },
    };
    const env = makeHermeticDoctorEnv(stateDir);
    const owner = createPluginMetadataOwner();
    const before = getCurrentPluginMetadataSnapshot();
    const prepared = owner.prepare({ config, env, allowCurrent: false });
    const readRules = (metadata: typeof prepared, workspaceDir?: string) =>
      withPluginMetadataCollectionScope(
        metadata,
        () =>
          listPluginDoctorLegacyConfigRules({ config, env, workspaceDir }).map(
            (rule) => rule.path[2],
          ),
        { config, env, workspaceDir: workspaceDirs[0] },
      );

    expect(readRules(prepared)).toEqual(pluginIds);
    expect(readRules(prepared, workspaceDirs[0])).toEqual([pluginIds[0]]);
    const manifestPath = path.join(pluginRoots[1]!, "openclaw.plugin.json");
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        ...JSON.parse(fs.readFileSync(manifestPath, "utf8")),
        doctorContract: { configRepair: false },
      }),
    );
    expect(readRules(prepared)).toEqual(pluginIds);
    expect(readRules(prepared, workspaceDirs[1])).toEqual([pluginIds[1]]);

    owner.invalidatePreparation();
    const refreshed = owner.prepare({ config, env, allowCurrent: false });
    expect(readRules(refreshed)).toEqual([pluginIds[0]]);
    expect(getCurrentPluginMetadataSnapshot()).toBe(before);
    owner.dispose();
  });

  it.each([
    {
      pluginId: "telegram",
      namespace: "telegram.update-offsets",
      sourceFile: "update-offset-default.json",
      stateKey: "default",
      state: { version: 3, lastUpdateId: 731, botId: null, tokenFingerprint: null },
    },
    {
      pluginId: "discord",
      namespace: "thread-bindings",
      sourceFile: "thread-bindings.json",
      stateKey: "default:thread-123",
      state: {
        accountId: "default",
        threadId: "thread-123",
        channelId: "channel-123",
        targetSessionKey: "agent:main:discord:channel:thread-123",
      },
    },
  ])(
    "migrates real $pluginId state through a released external setup-entry contract",
    async ({ pluginId, namespace, sourceFile, stateKey, state }) => {
      const stateDir = tempDirs.make("openclaw-doctor-contract-load-paths-");
      const pluginRoot = tempDirs.make("openclaw-doctor-contract-load-paths-");
      writeLegacyChannelMigrationPlugin({ pluginRoot, pluginId, namespace, sourceFile, stateKey });
      const bundledPluginsDir = path.join(stateDir, "bundled");
      const shadowedBundledRoot = path.join(bundledPluginsDir, pluginId);
      writeModernBundledChannelMigrationPlugin({
        pluginRoot: shadowedBundledRoot,
        pluginId,
      });
      const config = createDoctorPluginConfig(pluginRoot, pluginId);
      const env = {
        ...makeHermeticDoctorEnv(stateDir),
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "0",
        OPENCLAW_BUNDLED_PLUGINS_DIR: bundledPluginsDir,
        OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
      };
      const sourcePath = path.join(stateDir, pluginId, sourceFile);
      fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
      fs.writeFileSync(sourcePath, JSON.stringify(state), "utf8");

      const entries = listPluginDoctorStateMigrationEntries({ config, env, pluginIds: [pluginId] });
      expect(entries.map((entry) => entry.pluginId)).toEqual([pluginId]);
      const entry = entries[0];
      if (!entry) {
        throw new Error(`missing ${pluginId} released migration contract`);
      }
      expect(entry.migration.id).toBe(`${pluginId}-legacy-channel-state`);
      const input = {
        config,
        env,
        stateDir,
        oauthDir: path.join(stateDir, "credentials"),
        context: {
          openPluginStateKeyedStore: () => {
            throw new Error("plan-based migration should use its canonical state owner");
          },
        },
      };
      await expect(entry.migration.detectLegacyState(input)).resolves.toEqual({
        preview: [`- ${pluginId} preserved channel state: ${sourcePath}`],
      });

      const { createPluginStateKeyedStore, resetPluginStateStoreForTests } =
        await import("../plugin-state/plugin-state-store.js");
      try {
        const result = await entry.migration.migrateLegacyState(input);
        expect(result.warnings).toEqual([]);
        expect(result.changes.length).toBeGreaterThan(0);
        expect(fs.existsSync(sourcePath)).toBe(false);
        expect(fs.existsSync(`${sourcePath}.migrated`)).toBe(true);
        const store = createPluginStateKeyedStore(pluginId, { namespace, maxEntries: 1000, env });
        await expect(store.lookup(stateKey)).resolves.toEqual(state);
      } finally {
        resetPluginStateStoreForTests();
      }
    },
  );

  it("reloads a selected legacy setup entry after the plugin metadata lifecycle clears", async () => {
    const stateDir = tempDirs.make("openclaw-doctor-contract-load-paths-");
    const pluginRoot = tempDirs.make("openclaw-doctor-contract-load-paths-");
    const pluginId = "legacy-refresh";
    const sourceFile = "refresh.json";
    const config = createDoctorPluginConfig(pluginRoot, pluginId);
    const env = makeHermeticDoctorEnv(stateDir);
    const sourcePath = path.join(stateDir, pluginId, sourceFile);
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(sourcePath, "{}", "utf8");
    const writePlugin = (label: string) =>
      writeLegacyChannelMigrationPlugin({
        pluginRoot,
        pluginId,
        namespace: "legacy-refresh",
        sourceFile,
        stateKey: "default",
        label,
      });
    const detectPreview = async () => {
      const [entry] = listPluginDoctorStateMigrationEntries({
        config,
        env,
        pluginIds: [pluginId],
      });
      if (!entry) {
        throw new Error("missing selected legacy setup-entry migration");
      }
      return entry.migration.detectLegacyState({
        config,
        env,
        stateDir,
        oauthDir: path.join(stateDir, "credentials"),
        context: {
          openPluginStateKeyedStore: () => {
            throw new Error("legacy detection should not open plugin state");
          },
        },
      });
    };

    writePlugin("Legacy refresh v1");
    await expect(detectPreview()).resolves.toEqual({
      preview: [`- Legacy refresh v1: ${sourcePath}`],
    });

    writePlugin("Legacy refresh v2");
    clearPluginDoctorContractRegistryCache();

    await expect(detectPreview()).resolves.toEqual({
      preview: [`- Legacy refresh v2: ${sourcePath}`],
    });
  });

  it("discovers doctor warning rules from plugins.load.paths", () => {
    const stateDir = tempDirs.make("openclaw-doctor-contract-load-paths-");
    const pluginRoot = tempDirs.make("openclaw-doctor-contract-load-paths-");
    const pluginId = "load-path-doctor";
    writeDoctorPlugin(pluginRoot, pluginId);
    const config = createDoctorPluginConfig(pluginRoot, pluginId);

    const rules = listPluginDoctorLegacyConfigRules({
      config,
      env: makeHermeticDoctorEnv(stateDir),
      pluginIds: [pluginId],
    });
    expect(rules).toEqual([
      {
        path: ["plugins", "entries", pluginId, "config", "summaryModel"],
        message: "load-path doctor contract warning",
      },
    ]);
    expect(findLegacyConfigIssues(config, config, rules)).toEqual([
      {
        path: `plugins.entries.${pluginId}.config.summaryModel`,
        message: "load-path doctor contract warning",
      },
    ]);
  });

  it("discovers doctor warning rules from package dist contracts", () => {
    const stateDir = tempDirs.make("openclaw-doctor-contract-load-paths-");
    const pluginRoot = tempDirs.make("openclaw-doctor-contract-load-paths-");
    const pluginId = "dist-doctor";
    writeDistDoctorPlugin(pluginRoot, pluginId);
    const config = createDoctorPluginConfig(pluginRoot, pluginId);

    const rules = listPluginDoctorLegacyConfigRules({
      config,
      env: makeHermeticDoctorEnv(stateDir),
      pluginIds: [pluginId],
    });
    expect(rules).toEqual([
      {
        path: ["plugins", "entries", pluginId, "config", "distOnly"],
        message: "dist doctor contract warning",
      },
    ]);
  });

  it.each([
    {
      pluginId: "clickclack-legacy-doctor",
      importedSymbols: ["asObjectRecord"],
    },
    {
      pluginId: "codex-legacy-doctor",
      importedSymbols: ["archiveLegacyStateSource", "legacyStateFileExists"],
    },
    {
      pluginId: "discord-legacy-doctor",
      importedSymbols: [
        "asObjectRecord",
        "collectChannelAccountScopes",
        "collectProviderDangerousNameMatchingScopes",
        "defineChannelAliasMigration",
        "defineKeyMoveMigration",
        "hasLegacyAccountStreamingAliases",
        "normalizeChannelAccounts",
        "stripRetiredChannelKeys",
      ],
    },
  ])("loads the preserved $pluginId package contract", ({ pluginId, importedSymbols }) => {
    const stateDir = tempDirs.make("openclaw-doctor-contract-legacy-package-");
    const pluginRoot = tempDirs.make("openclaw-doctor-contract-legacy-package-");
    writeLegacyRuntimeDoctorPlugin({ pluginRoot, pluginId, importedSymbols });
    const config = createDoctorPluginConfig(pluginRoot, pluginId);

    expect(
      listPluginDoctorLegacyConfigRules({
        config,
        env: makeHermeticDoctorEnv(stateDir),
        pluginIds: [pluginId],
      }),
    ).toEqual([
      {
        path: ["plugins", "entries", pluginId, "config", "legacyDoctor"],
        message: `${pluginId} legacy doctor contract loaded`,
      },
    ]);
  });

  it("applies compatibility normalizers from plugins.load.paths", () => {
    const stateDir = tempDirs.make("openclaw-doctor-contract-load-paths-");
    const pluginRoot = tempDirs.make("openclaw-doctor-contract-load-paths-");
    const pluginId = "load-path-doctor";
    writeDoctorPlugin(pluginRoot, pluginId);
    const config = createDoctorPluginConfig(pluginRoot, pluginId);

    const result = applyPluginDoctorCompatibilityMigrations(config, {
      config,
      env: makeHermeticDoctorEnv(stateDir),
      pluginIds: [pluginId],
    });
    const llm = readPluginLlmPolicy(result.config, pluginId);

    expect(result.changes).toEqual(["configured load-path doctor contract LLM policy"]);
    expect(llm).toEqual({
      allowModelOverride: true,
      allowedModels: ["openai/gpt-5.4-mini"],
    });
  });

  it("discovers session route-state owners from plugins.load.paths", () => {
    const stateDir = tempDirs.make("openclaw-doctor-contract-load-paths-");
    const pluginRoot = tempDirs.make("openclaw-doctor-contract-load-paths-");
    const pluginId = "load-path-session-owner";
    writeDoctorSessionOwnerPlugin(pluginRoot, pluginId);
    const config = createDoctorPluginConfig(pluginRoot, pluginId);

    expect(
      listPluginDoctorSessionRouteStateOwners({
        config,
        env: makeHermeticDoctorEnv(stateDir),
      }),
    ).toEqual([
      {
        id: "load-path-session-owner",
        label: "Load Path Session Owner",
        providerIds: ["load-path-provider"],
        runtimeIds: ["load-path-runtime"],
        cliSessionKeys: ["load-path-cli"],
        authProfilePrefixes: ["load-path:"],
      },
    ]);
  });

  it("keeps the deprecated module owner route for external load-path plugins", () => {
    const stateDir = tempDirs.make("openclaw-doctor-contract-load-paths-");
    const pluginRoot = tempDirs.make("openclaw-doctor-contract-load-paths-");
    const pluginId = "legacy-load-path-owner";
    writeLegacyDoctorSessionOwnerPlugin(pluginRoot, pluginId);
    const config = createDoctorPluginConfig(pluginRoot, pluginId);

    expect(
      listPluginDoctorSessionRouteStateOwners({
        config,
        env: makeHermeticDoctorEnv(stateDir),
      }),
    ).toEqual([
      {
        id: "legacy-load-path-owner",
        label: "Legacy Load Path Owner",
        providerIds: ["legacy-provider"],
        runtimeIds: [],
        cliSessionKeys: [],
        authProfilePrefixes: [],
      },
    ]);
  });
});
