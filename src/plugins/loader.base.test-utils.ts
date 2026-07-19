// Imported by loader.test.ts to keep its mocked suite in one Vitest module graph.
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { applyBootstrapHookOverrides } from "../agents/bootstrap-hooks.js";
import { getRegisteredAgentHarness } from "../agents/harness/registry.js";
import type { WorkspaceBootstrapFile } from "../agents/workspace.js";
import { resolveConfigEnvVars } from "../config/env-substitution.js";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import {
  clearInternalHooks,
  createInternalHookEvent,
  getRegisteredEventKeys,
  triggerInternalHook,
} from "../hooks/internal-hooks.js";
import { withEnv } from "../test-utils/env.js";
import { clearPluginCommands } from "./command-registry-state.js";
import { getPluginCommandSpecs } from "./command-specs.js";
import { getGlobalHookRunner, resetGlobalHookRunner } from "./hook-runner-global.js";
import { writePersistedInstalledPluginIndexInstallRecordsSync } from "./installed-plugin-index-records.js";
import {
  clearPluginInteractiveHandlers,
  resolvePluginInteractiveNamespaceMatch,
} from "./interactive-registry.js";
import { loadOpenClawPlugins, resolveRuntimePluginRegistry } from "./loader.js";
import {
  EMPTY_PLUGIN_SCHEMA,
  makeTempDir,
  type PluginLoadConfig,
  useNoBundledPlugins,
  writePlugin,
} from "./loader.test-fixtures.js";
import {
  cachedBundledTelegramDir,
  listRegisteredAgentHarnessIdsForTest,
  countMatching,
  updatePluginManifest,
  RESERVED_ADMIN_PLUGIN_METHOD,
  RESERVED_ADMIN_SCOPE_WARNING,
  writeBundledPlugin,
  loadBundledMemoryPluginRegistry,
  setupBundledTelegramPlugin,
  expectTelegramLoaded,
  loadRegistryFromSinglePlugin,
  loadRegistryFromAllowedPlugins,
  expectDiagnosticContaining,
  expectNoDiagnosticContaining,
  createStartupTraceRecorder,
  collectStartupTraceMetrics,
  globalAfterEach0,
  globalAfterAll1,
} from "./loader.test-harness.js";
import { loadPluginManifestRegistry } from "./manifest-registry.js";
import { createEmptyPluginRegistry } from "./registry.js";
import {
  getActivePluginRegistry,
  getActivePluginRegistryKey,
  listImportedRuntimePluginIds,
  setActivePluginRegistry,
} from "./runtime.js";

afterEach(globalAfterEach0);
afterAll(globalAfterAll1);

describe("loadOpenClawPlugins", () => {
  it("emits loader startup trace timings for normal plugin load and register", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "trace-plugin",
      filename: "trace-plugin.cjs",
      body: `module.exports = { id: "trace-plugin", register() {} };`,
    });
    const { details, startupTrace } = createStartupTraceRecorder();

    loadRegistryFromSinglePlugin({
      plugin,
      pluginConfig: {
        allow: ["trace-plugin"],
      },
      options: {
        startupTrace,
      },
    });

    const metrics = collectStartupTraceMetrics(details, "plugins.gateway-load.plugin.trace-plugin");
    expect(metrics.loadMs).toEqual(expect.any(Number));
    expect(metrics.loadFailedCount).toBe(0);
    expect(metrics.registerMs).toEqual(expect.any(Number));
    expect(metrics.registerFailedCount).toBe(0);
    expect(metrics.loadAndRegisterMs).toEqual(expect.any(Number));
  });

  it("passes normalized config payloads to mixed-case runtime plugin ids", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "Config-Probe",
      filename: "config-probe.cjs",
      configSchema: {
        type: "object",
        additionalProperties: false,
        properties: { token: { type: "string" } },
        required: ["token"],
      },
      body: `module.exports = {
  id: "Config-Probe",
  register(api) { globalThis.mixedCaseConfigProbe = api.pluginConfig; },
};`,
    });
    const probe = globalThis as unknown as Record<string, unknown>;
    delete probe.mixedCaseConfigProbe;

    const registry = loadRegistryFromSinglePlugin({
      plugin,
      pluginConfig: {
        allow: ["config-probe"],
        entries: { "config-probe": { config: { token: "ok" } } },
      },
    });

    expect(registry.plugins.find((entry) => entry.id === "Config-Probe")?.status).toBe("loaded");
    expect(probe.mixedCaseConfigProbe).toEqual({ token: "ok" });
    delete probe.mixedCaseConfigProbe;
  });

  it("resolves ${ENV_VAR} references in plugin config before handing config to the plugin", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "env-config-probe",
      filename: "env-config-probe.cjs",
      // Schema must permit apiKey, otherwise the empty-schema guard rejects the
      // config before register() runs and the env substitution is never exercised.
      configSchema: {
        type: "object",
        additionalProperties: false,
        properties: { apiKey: { type: "string" } },
      },
      body: `module.exports = {
    id: "env-config-probe",
    register(api) {
      globalThis.envConfigProbeResult = api.pluginConfig;
    },
  };`,
    });
    const probe = globalThis as unknown as Record<string, unknown>;
    const entries = {
      "env-config-probe": { config: { apiKey: "${ENV_CONFIG_PROBE_SECRET}" } },
    };

    // Case 1: the referenced variable is present in process.env.
    delete probe.envConfigProbeResult;
    withEnv({ ENV_CONFIG_PROBE_SECRET: "process-env-secret" }, () => {
      loadRegistryFromSinglePlugin({
        plugin,
        pluginConfig: { allow: ["env-config-probe"], entries },
        options: { resolveRawConfigEnvVars: true },
      });
    });
    // Before the fix, the plugin received the literal "${ENV_CONFIG_PROBE_SECRET}".
    expect(probe.envConfigProbeResult).toMatchObject({ apiKey: "process-env-secret" });

    // Case 2: the referenced variable lives only in the loader's explicit env,
    // not in process.env — proving the substitution honors the per-load env.
    delete probe.envConfigProbeResult;
    expect(process.env.ENV_CONFIG_PROBE_SECRET).toBeUndefined();
    loadRegistryFromSinglePlugin({
      plugin,
      pluginConfig: { allow: ["env-config-probe"], entries },
      options: {
        env: { ...process.env, ENV_CONFIG_PROBE_SECRET: "explicit-env-secret" },
        resolveRawConfigEnvVars: true,
      },
    });
    expect(probe.envConfigProbeResult).toMatchObject({ apiKey: "explicit-env-secret" });

    // Case 3: config.env.vars participates in the same effective env as config IO.
    delete probe.envConfigProbeResult;
    withEnv({ ENV_CONFIG_PROBE_SECRET: undefined }, () => {
      loadOpenClawPlugins({
        cache: false,
        workspaceDir: plugin.dir,
        config: {
          env: {
            vars: {
              ENV_CONFIG_PROBE_PLUGIN_FILE: plugin.file,
              ENV_CONFIG_PROBE_SECRET: "config-env-secret",
            },
          },
          plugins: {
            load: { paths: ["${ENV_CONFIG_PROBE_PLUGIN_FILE}"] },
            allow: ["env-config-probe"],
            entries,
          },
        },
        resolveRawConfigEnvVars: true,
      });
    });
    expect(probe.envConfigProbeResult).toMatchObject({ apiKey: "config-env-secret" });

    // Case 4: config that already went through read-time substitution must not
    // be processed again. Escaped placeholders intentionally become literals.
    delete probe.envConfigProbeResult;
    const resolvedEscapedEntries = resolveConfigEnvVars(
      {
        "env-config-probe": { config: { apiKey: "$${ENV_CONFIG_PROBE_SECRET}" } },
      },
      { ENV_CONFIG_PROBE_SECRET: "should-not-leak" } as NodeJS.ProcessEnv,
    ) as typeof entries;
    withEnv({ ENV_CONFIG_PROBE_SECRET: "process-env-secret" }, () => {
      loadRegistryFromSinglePlugin({
        plugin,
        pluginConfig: {
          allow: ["env-config-probe"],
          entries: structuredClone(resolvedEscapedEntries),
        },
      });
    });
    expect(probe.envConfigProbeResult).toMatchObject({
      apiKey: "${ENV_CONFIG_PROBE_SECRET}",
    });
  });

  it("emits loader startup trace failure counts for load and register failures", () => {
    useNoBundledPlugins();
    const loadFailPlugin = writePlugin({
      id: "trace-load-fail",
      filename: "trace-load-fail.cjs",
      body: `throw new Error("load boom");`,
    });
    const registerFailPlugin = writePlugin({
      id: "trace-register-fail",
      filename: "trace-register-fail.cjs",
      body: `module.exports = { id: "trace-register-fail", register() { throw new Error("register boom"); } };`,
    });
    const { details, startupTrace } = createStartupTraceRecorder();

    loadOpenClawPlugins({
      cache: false,
      config: {
        plugins: {
          load: { paths: [loadFailPlugin.file, registerFailPlugin.file] },
          allow: ["trace-load-fail", "trace-register-fail"],
        },
      },
      startupTrace,
    });

    const loadFailMetrics = collectStartupTraceMetrics(
      details,
      "plugins.gateway-load.plugin.trace-load-fail",
    );
    expect(loadFailMetrics.loadMs).toEqual(expect.any(Number));
    expect(loadFailMetrics.loadFailedCount).toBe(1);
    expect(loadFailMetrics.registerMs).toBeUndefined();

    const registerFailMetrics = collectStartupTraceMetrics(
      details,
      "plugins.gateway-load.plugin.trace-register-fail",
    );
    expect(registerFailMetrics.loadFailedCount).toBe(0);
    expect(registerFailMetrics.registerMs).toEqual(expect.any(Number));
    expect(registerFailMetrics.registerFailedCount).toBe(1);
    expect(registerFailMetrics.loadAndRegisterMs).toEqual(expect.any(Number));
  });

  it("rolls back trusted policies when plugin register fails", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "trusted-policy-register-fail",
      filename: "trusted-policy-register-fail.cjs",
      body: `module.exports = { id: "trusted-policy-register-fail", register(api) {
    api.registerTrustedToolPolicy({
      id: "failed-policy",
      description: "Must be removed after register failure",
      evaluate: () => ({ block: true, blockReason: "stale failed policy" })
    });
    throw new Error("register boom");
  } };`,
    });
    updatePluginManifest(plugin, {
      contracts: { trustedToolPolicies: ["failed-policy"] },
    });

    const registry = loadRegistryFromSinglePlugin({
      plugin,
      pluginConfig: {
        allow: ["trusted-policy-register-fail"],
      },
    });

    expect(registry.trustedToolPolicies).toHaveLength(0);
    const loaded = registry.plugins.find((entry) => entry.id === "trusted-policy-register-fail");
    expect(loaded?.status).toBe("error");
    expect(loaded?.error).toContain("register boom");
    expectDiagnosticContaining({
      registry,
      level: "error",
      pluginId: "trusted-policy-register-fail",
      message: "plugin failed during register: Error: register boom",
    });
  });

  it("rolls back worker providers when plugin register fails", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "worker-provider-register-fail",
      filename: "worker-provider-register-fail.cjs",
      body: `module.exports = { id: "worker-provider-register-fail", register(api) {
    api.registerWorkerProvider({
      id: "failed-worker",
      provision: async () => { throw new Error("not called"); },
      inspect: async () => ({ status: "unknown" }),
      destroy: async () => {}
    });
    throw new Error("register boom");
  } };`,
    });
    updatePluginManifest(plugin, {
      contracts: { workerProviders: ["failed-worker"] },
    });

    const registry = loadRegistryFromSinglePlugin({
      plugin,
      pluginConfig: {
        allow: ["worker-provider-register-fail"],
      },
    });

    expect(registry.workerProviders.size).toBe(0);
    const loaded = registry.plugins.find((entry) => entry.id === "worker-provider-register-fail");
    expect(loaded?.status).toBe("error");
    expect(loaded?.error).toContain("register boom");
  });

  it("loads declared installed trusted policies through plugin manifests", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "trusted-policy-success",
      filename: "trusted-policy-success.cjs",
      body: `module.exports = { id: "trusted-policy-success", register(api) {
    api.registerTrustedToolPolicy({
      id: "declared-policy",
      description: "Declared installed policy",
      evaluate: () => ({ allow: true })
    });
  } };`,
    });
    updatePluginManifest(plugin, {
      contracts: { trustedToolPolicies: ["declared-policy"] },
    });

    const registry = loadRegistryFromSinglePlugin({
      plugin,
      pluginConfig: {
        allow: ["trusted-policy-success"],
      },
    });

    expect(registry.trustedToolPolicies.map((entry) => [entry.pluginId, entry.policy.id])).toEqual([
      ["trusted-policy-success", "declared-policy"],
    ]);
    expect(registry.diagnostics).not.toContainEqual(
      expect.objectContaining({
        pluginId: "trusted-policy-success",
        message: "plugin must declare contracts.trustedToolPolicies for: declared-policy",
      }),
    );
  });

  it("keeps earlier trusted policies when a later plugin register fails", () => {
    useNoBundledPlugins();
    const stablePlugin = writePlugin({
      id: "stable-trusted-policy",
      filename: "stable-trusted-policy.cjs",
      body: `module.exports = { id: "stable-trusted-policy", register(api) {
    api.registerTrustedToolPolicy({
      id: "stable-policy",
      description: "Stable policy must survive later failures",
      evaluate: () => ({ allow: true })
    });
  } };`,
    });
    updatePluginManifest(stablePlugin, {
      contracts: { trustedToolPolicies: ["stable-policy"] },
    });
    const failingPlugin = writePlugin({
      id: "later-trusted-policy-register-fail",
      filename: "later-trusted-policy-register-fail.cjs",
      body: `module.exports = { id: "later-trusted-policy-register-fail", register(api) {
    api.registerTrustedToolPolicy({
      id: "failed-policy",
      description: "Must be removed after register failure",
      evaluate: () => ({ block: true, blockReason: "stale failed policy" })
    });
    throw new Error("register boom");
  } };`,
    });
    updatePluginManifest(failingPlugin, {
      contracts: { trustedToolPolicies: ["failed-policy"] },
    });

    const registry = loadRegistryFromAllowedPlugins([stablePlugin, failingPlugin]);

    expect(registry.trustedToolPolicies.map((entry) => [entry.pluginId, entry.policy.id])).toEqual([
      ["stable-trusted-policy", "stable-policy"],
    ]);
    const failed = registry.plugins.find(
      (entry) => entry.id === "later-trusted-policy-register-fail",
    );
    expect(failed?.status).toBe("error");
    expect(failed?.error).toContain("register boom");
    expectDiagnosticContaining({
      registry,
      level: "error",
      pluginId: "later-trusted-policy-register-fail",
      message: "plugin failed during register: Error: register boom",
    });
  });

  it("can load scoped plugins from a supplied manifest registry without rereading manifests", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "supplied-manifest",
      body: `module.exports = { id: "supplied-manifest", register() {} };`,
    });
    const config = {
      plugins: {
        load: { paths: [plugin.file] },
        allow: [plugin.id],
      },
    };
    const manifestRegistry = loadPluginManifestRegistry({ config });
    fs.rmSync(path.join(plugin.dir, "openclaw.plugin.json"));

    const registry = loadOpenClawPlugins({
      cache: false,
      config,
      manifestRegistry,
      onlyPluginIds: [plugin.id],
    });

    expect(registry.plugins.find((entry) => entry.id === plugin.id)?.status).toBe("loaded");
  });

  it("loads installed plugin packages discovered from persisted install records", () => {
    useNoBundledPlugins();
    const stateDir = makeTempDir();
    const plugin = writePlugin({
      id: "installed-record-plugin",
      body: `module.exports = { id: "installed-record-plugin", register() {} };`,
    });
    writePersistedInstalledPluginIndexInstallRecordsSync(
      {
        [plugin.id]: {
          source: "git",
          spec: "git:file:///tmp/installed-record-plugin.git@abc123",
          installPath: plugin.dir,
          gitUrl: "file:///tmp/installed-record-plugin.git",
          gitCommit: "abc123",
        },
      },
      { stateDir },
    );

    const registry = withEnv({ OPENCLAW_STATE_DIR: stateDir }, () =>
      loadOpenClawPlugins({
        cache: false,
        config: {
          plugins: {
            entries: {
              [plugin.id]: { enabled: true },
            },
          },
        },
      }),
    );

    const record = registry.plugins.find((entry) => entry.id === plugin.id);
    expect(record?.id).toBe(plugin.id);
    expect(record?.status).toBe("loaded");
    expect(record?.rootDir).toBe(fs.realpathSync.native(plugin.dir));
  });

  it("disables bundled plugins by default", () => {
    const bundledDir = makeTempDir();
    writePlugin({
      id: "bundled",
      body: `module.exports = { id: "bundled", register() {} };`,
      dir: bundledDir,
      filename: "bundled.cjs",
    });
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledDir;

    const registry = loadOpenClawPlugins({
      cache: false,
      config: {
        plugins: {
          allow: ["bundled"],
        },
      },
    });

    const bundled = registry.plugins.find((entry) => entry.id === "bundled");
    expect(bundled?.status).toBe("disabled");
  });

  it("loads bundled plugins with plugin-sdk imports from a package dist root", () => {
    const packageRoot = makeTempDir();
    const bundledDir = path.join(packageRoot, "dist", "extensions");
    const pluginRoot = path.join(bundledDir, "discord");
    fs.mkdirSync(path.join(packageRoot, "dist", "plugin-sdk"), { recursive: true });
    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2026.4.22", type: "module" }),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(packageRoot, "dist", "plugin-sdk", "string-coerce-runtime.js"),
      "export const normalizeLowercaseStringOrEmpty = (value) => String(value).toLowerCase();\n",
      "utf-8",
    );
    const aliasRoot = path.join(bundledDir, "node_modules", "openclaw");
    const aliasPluginSdkDir = path.join(aliasRoot, "plugin-sdk");
    fs.mkdirSync(aliasPluginSdkDir, { recursive: true });
    fs.writeFileSync(
      path.join(aliasRoot, "package.json"),
      JSON.stringify({
        name: "openclaw",
        type: "module",
        exports: {
          "./plugin-sdk/string-coerce-runtime": "./plugin-sdk/string-coerce-runtime.js",
        },
      }),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(aliasPluginSdkDir, "string-coerce-runtime.js"),
      "export * from '../../../../plugin-sdk/string-coerce-runtime.js';\n",
      "utf-8",
    );
    fs.writeFileSync(
      path.join(pluginRoot, "index.js"),
      [
        `import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";`,
        `export default {`,
        `  id: "discord",`,
        `  register(api) {`,
        `    api.registerCommand({ name: normalizeLowercaseStringOrEmpty("DISCORD"), handler: () => "ok" });`,
        `  },`,
        `};`,
        "",
      ].join("\n"),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(pluginRoot, "package.json"),
      JSON.stringify(
        {
          name: "@openclaw/discord",
          version: "1.0.0",
          type: "module",
          openclaw: { extensions: ["./index.js"] },
        },
        null,
        2,
      ),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(pluginRoot, "openclaw.plugin.json"),
      JSON.stringify(
        {
          id: "discord",
          enabledByDefault: true,
          configSchema: EMPTY_PLUGIN_SCHEMA,
        },
        null,
        2,
      ),
      "utf-8",
    );
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledDir;

    const registry = loadOpenClawPlugins({
      cache: false,
      config: {
        plugins: {
          enabled: true,
        },
      },
    });

    const record = registry.plugins.find((entry) => entry.id === "discord");
    expect(
      record?.status,
      JSON.stringify({ error: record?.error, diagnostics: registry.diagnostics }, null, 2),
    ).toBe("loaded");
  });

  it("registers standalone text transforms", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "text-shim",
      filename: "text-shim.cjs",
      body: `module.exports = {
          id: "text-shim",
          register(api) {
            api.registerTextTransforms({
              input: [{ from: /red basket/g, to: "blue basket" }],
              output: [{ from: /blue basket/g, to: "red basket" }],
            });
          },
        };`,
    });

    const registry = loadRegistryFromSinglePlugin({
      plugin,
      pluginConfig: { allow: ["text-shim"] },
    });

    expect(registry.textTransforms).toHaveLength(1);
    const transformRegistration = registry.textTransforms[0];
    expect(transformRegistration?.pluginId).toBe("text-shim");
    expect(transformRegistration?.transforms.input).toEqual([
      { from: /red basket/g, to: "blue basket" },
    ]);
    expect(transformRegistration?.transforms.output).toEqual([
      { from: /blue basket/g, to: "red basket" },
    ]);
  });

  it.each([
    {
      name: "loads bundled telegram plugin when enabled",
      config: {
        plugins: {
          allow: ["telegram"],
          entries: {
            telegram: { enabled: true },
          },
        },
      } satisfies PluginLoadConfig,
      assert: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
        expectTelegramLoaded(registry);
      },
    },
    {
      name: "loads bundled channel plugins when channels.<id>.enabled=true",
      config: {
        channels: {
          telegram: {
            enabled: true,
          },
        },
        plugins: {
          enabled: true,
        },
      } satisfies PluginLoadConfig,
      assert: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
        expectTelegramLoaded(registry);
      },
    },
    {
      name: "lets explicit bundled channel enablement bypass restrictive allowlists",
      config: {
        channels: {
          telegram: {
            enabled: true,
          },
        },
        plugins: {
          allow: ["browser"],
        },
      } satisfies PluginLoadConfig,
      assert: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
        const telegram = registry.plugins.find((entry) => entry.id === "telegram");
        expect(telegram?.status).toBe("loaded");
        expect(telegram?.error).toBeUndefined();
        expect(telegram?.explicitlyEnabled).toBe(true);
      },
    },
    {
      name: "still respects explicit disable via plugins.entries for bundled channels",
      config: {
        channels: {
          telegram: {
            enabled: true,
          },
        },
        plugins: {
          entries: {
            telegram: { enabled: false },
          },
        },
      } satisfies PluginLoadConfig,
      assert: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
        const telegram = registry.plugins.find((entry) => entry.id === "telegram");
        expect(telegram?.status).toBe("disabled");
        expect(telegram?.error).toBe("disabled in config");
      },
    },
  ] as const)(
    "handles bundled telegram plugin enablement and override rules: $name",
    ({ config, assert }) => {
      setupBundledTelegramPlugin();
      const registry = loadOpenClawPlugins({
        cache: false,
        workspaceDir: cachedBundledTelegramDir,
        config,
      });
      assert(registry);
    },
  );

  it("marks auto-enabled bundled channels as activated but not explicitly enabled", () => {
    setupBundledTelegramPlugin();
    const rawConfig = {
      channels: {
        telegram: {
          botToken: "x",
        },
      },
      plugins: {
        enabled: true,
      },
    } satisfies PluginLoadConfig;
    const autoEnabled = applyPluginAutoEnable({
      config: rawConfig,
      env: {},
    });

    const registry = loadOpenClawPlugins({
      cache: false,
      workspaceDir: cachedBundledTelegramDir,
      config: autoEnabled.config,
      activationSourceConfig: rawConfig,
      autoEnabledReasons: autoEnabled.autoEnabledReasons,
    });

    const telegram = registry.plugins.find((entry) => entry.id === "telegram");
    expect(telegram?.explicitlyEnabled).toBe(false);
    expect(telegram?.activated).toBe(true);
    expect(telegram?.activationSource).toBe("auto");
    expect(telegram?.activationReason).toBe("telegram configured");
  });

  it("materializes auto-enabled bundled channels into restrictive allowlists", () => {
    setupBundledTelegramPlugin();
    const rawConfig = {
      channels: {
        telegram: {
          botToken: "x",
        },
      },
      plugins: {
        allow: ["browser"],
      },
    } satisfies PluginLoadConfig;
    const autoEnabled = applyPluginAutoEnable({
      config: rawConfig,
      env: {},
    });

    const registry = loadOpenClawPlugins({
      cache: false,
      workspaceDir: cachedBundledTelegramDir,
      config: autoEnabled.config,
      activationSourceConfig: rawConfig,
      autoEnabledReasons: autoEnabled.autoEnabledReasons,
    });

    const telegram = registry.plugins.find((entry) => entry.id === "telegram");
    expect(autoEnabled.config.plugins?.allow).toEqual(["browser", "telegram"]);
    expect(telegram?.status).toBe("loaded");
    expect(telegram?.error).toBeUndefined();
    expect(telegram?.explicitlyEnabled).toBe(false);
    expect(telegram?.activated).toBe(true);
    expect(telegram?.activationSource).toBe("auto");
    expect(telegram?.activationReason).toBe("telegram configured");
  });

  it("preserves all auto-enable reasons in activation metadata", () => {
    setupBundledTelegramPlugin();
    const rawConfig = {
      channels: {
        telegram: {
          botToken: "x",
        },
      },
      plugins: {
        enabled: true,
      },
    } satisfies PluginLoadConfig;

    const registry = loadOpenClawPlugins({
      cache: false,
      workspaceDir: cachedBundledTelegramDir,
      config: {
        ...rawConfig,
        plugins: {
          enabled: true,
          entries: {
            telegram: {
              enabled: true,
            },
          },
        },
      },
      activationSourceConfig: rawConfig,
      autoEnabledReasons: {
        telegram: ["telegram configured", "telegram selected for startup"],
      },
    });

    const telegram = registry.plugins.find((entry) => entry.id === "telegram");
    expect(telegram?.explicitlyEnabled).toBe(false);
    expect(telegram?.activated).toBe(true);
    expect(telegram?.activationSource).toBe("auto");
    expect(telegram?.activationReason).toBe("telegram configured; telegram selected for startup");
  });

  it("keeps explicit plugin enablement distinct from derived activation", () => {
    const { bundledDir } = writeBundledPlugin({
      id: "demo",
    });
    const config = {
      plugins: {
        entries: {
          demo: {
            enabled: true,
          },
        },
      },
    } satisfies PluginLoadConfig;

    const registry = loadOpenClawPlugins({
      cache: false,
      workspaceDir: bundledDir,
      config,
      activationSourceConfig: config,
    });

    const demo = registry.plugins.find((entry) => entry.id === "demo");
    expect(demo?.explicitlyEnabled).toBe(true);
    expect(demo?.activated).toBe(true);
    expect(demo?.activationSource).toBe("explicit");
    expect(demo?.activationReason).toBe("enabled in config");
  });

  it("preserves package.json metadata for bundled memory plugins", () => {
    const registry = loadBundledMemoryPluginRegistry({
      packageMeta: {
        name: "@openclaw/memory-core",
        version: "1.2.3",
        description: "Memory plugin package",
      },
      pluginBody:
        'module.exports = { id: "memory-core", kind: "memory", name: "Memory (Core)", register() {} };',
    });

    const memory = registry.plugins.find((entry) => entry.id === "memory-core");
    expect(memory?.status).toBe("loaded");
    expect(memory?.origin).toBe("bundled");
    expect(memory?.name).toBe("Memory (Core)");
    expect(memory?.version).toBe("1.2.3");
  });

  it.each([
    {
      label: "loads plugins from config paths",
      run: () => {
        useNoBundledPlugins();
        const plugin = writePlugin({
          id: "allowed-config-path",
          filename: "allowed-config-path.cjs",
          body: `module.exports = {
    id: "allowed-config-path",
    register(api) {
      api.registerGatewayMethod("allowed-config-path.ping", ({ respond }) => respond(true, { ok: true }));
    },
  };`,
        });

        const registry = loadOpenClawPlugins({
          cache: false,
          workspaceDir: plugin.dir,
          config: {
            plugins: {
              load: { paths: [plugin.file] },
              allow: ["allowed-config-path"],
            },
          },
        });

        const loaded = registry.plugins.find((entry) => entry.id === "allowed-config-path");
        expect(loaded?.status).toBe("loaded");
        expect(Object.keys(registry.gatewayHandlers)).toContain("allowed-config-path.ping");
        expect(registry.gatewayMethodDescriptors).toMatchObject([
          {
            name: "allowed-config-path.ping",
            owner: { kind: "plugin", pluginId: "allowed-config-path" },
          },
        ]);
      },
    },
    {
      label: "adapts returned plugin gateway method values into responses",
      run: async () => {
        useNoBundledPlugins();
        const plugin = writePlugin({
          id: "returned-gateway-method",
          filename: "returned-gateway-method.cjs",
          body: `module.exports = {
    id: "returned-gateway-method",
    register(api) {
      api.registerGatewayMethod("returned-gateway-method.status", async () => ({ ok: true, status: "ready" }));
    },
  };`,
        });

        const registry = loadOpenClawPlugins({
          cache: false,
          workspaceDir: plugin.dir,
          config: {
            plugins: {
              load: { paths: [plugin.file] },
              allow: ["returned-gateway-method"],
            },
          },
        });

        const responses: unknown[] = [];
        await registry.gatewayHandlers["returned-gateway-method.status"]?.({
          params: {},
          respond: (ok: boolean, payload: unknown, error?: unknown) =>
            responses.push({ ok, payload, error }),
        } as never);

        expect(responses).toEqual([
          { ok: true, payload: { ok: true, status: "ready" }, error: undefined },
        ]);
      },
    },
    {
      label: "keeps explicit plugin gateway responses authoritative",
      run: async () => {
        useNoBundledPlugins();
        const plugin = writePlugin({
          id: "explicit-gateway-method",
          filename: "explicit-gateway-method.cjs",
          body: `module.exports = {
    id: "explicit-gateway-method",
    register(api) {
      api.registerGatewayMethod("explicit-gateway-method.status", ({ respond }) => {
        respond(true, { status: "responded" });
        return { status: "returned" };
      });
    },
  };`,
        });

        const registry = loadOpenClawPlugins({
          cache: false,
          workspaceDir: plugin.dir,
          config: {
            plugins: {
              load: { paths: [plugin.file] },
              allow: ["explicit-gateway-method"],
            },
          },
        });

        const responses: unknown[] = [];
        await registry.gatewayHandlers["explicit-gateway-method.status"]?.({
          params: {},
          respond: (ok: boolean, payload: unknown, error?: unknown) =>
            responses.push({ ok, payload, error }),
        } as never);

        expect(responses).toEqual([
          { ok: true, payload: { status: "responded" }, error: undefined },
        ]);
      },
    },
    {
      label: "coerces reserved gateway method namespaces to operator.admin",
      run: () => {
        useNoBundledPlugins();
        const plugin = writePlugin({
          id: "reserved-gateway-scope",
          filename: "reserved-gateway-scope.cjs",
          body: `module.exports = {
    id: "reserved-gateway-scope",
    register(api) {
      api.registerGatewayMethod(
        ${JSON.stringify(RESERVED_ADMIN_PLUGIN_METHOD)},
        ({ respond }) => respond(true, { ok: true }),
        { scope: "operator.read" },
      );
    },
  };`,
        });

        const registry = loadOpenClawPlugins({
          cache: false,
          workspaceDir: plugin.dir,
          config: {
            plugins: {
              load: { paths: [plugin.file] },
              allow: ["reserved-gateway-scope"],
            },
          },
        });

        expect(Object.keys(registry.gatewayHandlers)).toContain(RESERVED_ADMIN_PLUGIN_METHOD);
        expect(registry.gatewayMethodDescriptors[0]?.scope).toBe("operator.admin");
        expectDiagnosticContaining({
          registry,
          message: `${RESERVED_ADMIN_SCOPE_WARNING}: ${RESERVED_ADMIN_PLUGIN_METHOD}`,
        });
      },
    },
    {
      label: "rejects gateway methods that collide with hidden core methods",
      run: () => {
        useNoBundledPlugins();
        const plugin = writePlugin({
          id: "hidden-core-collision",
          filename: "hidden-core-collision.cjs",
          body: `module.exports = {
    id: "hidden-core-collision",
    register(api) {
      api.registerGatewayMethod("config.openFile", ({ respond }) => respond(true, { ok: true }));
    },
  };`,
        });

        const registry = loadOpenClawPlugins({
          cache: false,
          workspaceDir: plugin.dir,
          coreGatewayMethodNames: ["config.openFile"],
          config: {
            plugins: {
              load: { paths: [plugin.file] },
              allow: ["hidden-core-collision"],
            },
          },
        });

        expect(Object.keys(registry.gatewayHandlers)).not.toContain("config.openFile");
        expectDiagnosticContaining({
          registry,
          level: "error",
          pluginId: "hidden-core-collision",
          message: "gateway method already registered: config.openFile",
        });
      },
    },
    {
      label: "rejects async register functions instead of silently loading them",
      run: () => {
        useNoBundledPlugins();
        const plugin = writePlugin({
          id: "async-register",
          filename: "async-register.cjs",
          body: `module.exports = {
    id: "async-register",
    async register(api) {
      await Promise.resolve();
      api.registerGatewayMethod("async-register.ping", ({ respond }) => respond(true, { ok: true }));
    },
  };`,
        });

        const registry = loadOpenClawPlugins({
          cache: false,
          config: {
            plugins: {
              load: { paths: [plugin.file] },
              allow: ["async-register"],
            },
          },
        });

        const loaded = registry.plugins.find((entry) => entry.id === "async-register");
        expect(loaded?.status).toBe("error");
        expect(loaded?.failurePhase).toBe("register");
        expect(loaded?.error).toContain("plugin register must be synchronous");
        expect(Object.keys(registry.gatewayHandlers)).not.toContain("async-register.ping");
      },
    },
    {
      label: "limits imports to the requested plugin ids",
      run: () => {
        useNoBundledPlugins();
        const allowed = writePlugin({
          id: "allowed-scoped-only",
          filename: "allowed-scoped-only.cjs",
          body: `module.exports = { id: "allowed-scoped-only", register() {} };`,
        });
        const skippedMarker = path.join(makeTempDir(), "skipped-loaded.txt");
        const skipped = writePlugin({
          id: "skipped-scoped-only",
          filename: "skipped-scoped-only.cjs",
          body: `require("node:fs").writeFileSync(${JSON.stringify(skippedMarker)}, "loaded", "utf-8");
  module.exports = { id: "skipped-scoped-only", register() { throw new Error("skipped plugin should not load"); } };`,
        });

        const registry = loadOpenClawPlugins({
          cache: false,
          config: {
            plugins: {
              load: { paths: [allowed.file, skipped.file] },
              allow: ["allowed-scoped-only", "skipped-scoped-only"],
            },
          },
          onlyPluginIds: ["allowed-scoped-only"],
        });

        expect(registry.plugins.map((entry) => entry.id)).toEqual(["allowed-scoped-only"]);
        expect(fs.existsSync(skippedMarker)).toBe(false);
      },
    },
    {
      label: "can build a manifest-only snapshot without importing plugin modules",
      run: () => {
        useNoBundledPlugins();
        const importedMarker = path.join(makeTempDir(), "manifest-only-imported.txt");
        const plugin = writePlugin({
          id: "manifest-only-plugin",
          filename: "manifest-only-plugin.cjs",
          body: `require("node:fs").writeFileSync(${JSON.stringify(importedMarker)}, "loaded", "utf-8");
  module.exports = { id: "manifest-only-plugin", register() { throw new Error("manifest-only snapshot should not register"); } };`,
        });

        const registry = loadOpenClawPlugins({
          cache: false,
          activate: false,
          loadModules: false,
          config: {
            plugins: {
              load: { paths: [plugin.file] },
              allow: ["manifest-only-plugin"],
              entries: {
                "manifest-only-plugin": { enabled: true },
              },
            },
          },
        });

        expect(fs.existsSync(importedMarker)).toBe(false);
        const record = registry.plugins.find((entry) => entry.id === "manifest-only-plugin");
        expect(record?.status).toBe("loaded");
      },
    },
    {
      label: "includes manifest-owned surfaces in manifest-only snapshots",
      run: () => {
        useNoBundledPlugins();
        const importedMarker = path.join(makeTempDir(), "manifest-surfaces-imported.txt");
        const plugin = writePlugin({
          id: "manifest-surfaces-plugin",
          filename: "manifest-surfaces-plugin.cjs",
          body: `require("node:fs").writeFileSync(${JSON.stringify(importedMarker)}, "loaded", "utf-8");
  module.exports = { id: "manifest-surfaces-plugin", register() { throw new Error("manifest-only snapshot should not register"); } };`,
        });
        fs.writeFileSync(
          path.join(plugin.dir, "openclaw.plugin.json"),
          JSON.stringify(
            {
              id: "manifest-surfaces-plugin",
              configSchema: EMPTY_PLUGIN_SCHEMA,
              channels: ["manifest-surfaces-channel"],
              providers: ["manifest-surfaces-provider"],
              cliBackends: ["manifest-surfaces-cli"],
              setup: { cliBackends: ["manifest-surfaces-setup-cli"] },
              commandAliases: [{ name: "manifest-surfaces-command" }],
            },
            null,
            2,
          ),
          "utf-8",
        );

        const registry = loadOpenClawPlugins({
          cache: false,
          activate: false,
          loadModules: false,
          config: {
            plugins: {
              load: { paths: [plugin.file] },
              allow: ["manifest-surfaces-plugin"],
              entries: {
                "manifest-surfaces-plugin": { enabled: true },
              },
            },
          },
        });

        const record = registry.plugins.find((entry) => entry.id === "manifest-surfaces-plugin");
        expect(fs.existsSync(importedMarker)).toBe(false);
        expect(record?.channelIds).toEqual(["manifest-surfaces-channel"]);
        expect(record?.providerIds).toEqual(["manifest-surfaces-provider"]);
        expect(record?.cliBackendIds).toEqual([
          "manifest-surfaces-cli",
          "manifest-surfaces-setup-cli",
        ]);
        expect(record?.commands).toEqual(["manifest-surfaces-command"]);
      },
    },
    {
      label: "marks a selected memory slot as matched during manifest-only snapshots",
      run: () => {
        useNoBundledPlugins();
        const memoryPlugin = writePlugin({
          id: "memory-demo",
          filename: "memory-demo.cjs",
          body: `module.exports = {
    id: "memory-demo",
    kind: "memory",
    register() {},
  };`,
        });
        fs.writeFileSync(
          path.join(memoryPlugin.dir, "openclaw.plugin.json"),
          JSON.stringify(
            {
              id: "memory-demo",
              kind: "memory",
              configSchema: EMPTY_PLUGIN_SCHEMA,
            },
            null,
            2,
          ),
          "utf-8",
        );

        const registry = loadOpenClawPlugins({
          cache: false,
          activate: false,
          loadModules: false,
          config: {
            plugins: {
              load: { paths: [memoryPlugin.file] },
              allow: ["memory-demo"],
              slots: { memory: "memory-demo" },
              entries: {
                "memory-demo": { enabled: true },
              },
            },
          },
        });

        expectNoDiagnosticContaining({
          registry,
          message: "memory slot plugin not found or not marked as memory: memory-demo",
        });
        const record = registry.plugins.find((entry) => entry.id === "memory-demo");
        expect(record?.memorySlotSelected).toBe(true);
      },
    },
    {
      label: "tracks plugins as imported when module evaluation throws after top-level execution",
      run: () => {
        useNoBundledPlugins();
        const importMarker = "__openclaw_loader_import_throw_marker";
        Reflect.deleteProperty(globalThis, importMarker);

        const plugin = writePlugin({
          id: "throws-after-import",
          filename: "throws-after-import.cjs",
          body: `globalThis.${importMarker} = (globalThis.${importMarker} ?? 0) + 1;
  throw new Error("boom after import");
  module.exports = { id: "throws-after-import", register() {} };`,
        });

        const registry = loadOpenClawPlugins({
          cache: false,
          activate: false,
          config: {
            plugins: {
              load: { paths: [plugin.file] },
              allow: ["throws-after-import"],
            },
          },
        });

        try {
          const record = registry.plugins.find((entry) => entry.id === "throws-after-import");
          expect(record?.status).toBe("error");
          expect(listImportedRuntimePluginIds()).toContain("throws-after-import");
          expect(Number(Reflect.get(globalThis, importMarker) ?? 0)).toBeGreaterThan(0);
        } finally {
          Reflect.deleteProperty(globalThis, importMarker);
        }
      },
    },
    {
      label: "fails loudly when a plugin reenters the same snapshot load during register",
      run: () => {
        useNoBundledPlugins();
        const marker = "__openclaw_loader_reentry_error";
        const reenterFnMarker = "__openclaw_loader_reentry_fn";
        Reflect.deleteProperty(globalThis, marker);
        Reflect.set(
          globalThis,
          reenterFnMarker,
          (options: Parameters<typeof loadOpenClawPlugins>[0]) => loadOpenClawPlugins(options),
        );
        const pluginDir = makeTempDir();
        const pluginFile = path.join(pluginDir, "reentrant-snapshot.cjs");
        const nestedOptions = {
          cache: false,
          activate: false,
          workspaceDir: pluginDir,
          config: {
            plugins: {
              load: { paths: [pluginFile] },
              allow: ["reentrant-snapshot"],
            },
          },
        } satisfies Parameters<typeof loadOpenClawPlugins>[0];
        writePlugin({
          id: "reentrant-snapshot",
          dir: pluginDir,
          filename: "reentrant-snapshot.cjs",
          body: `module.exports = {
    id: "reentrant-snapshot",
    register() {
      try {
        globalThis.${reenterFnMarker}(${JSON.stringify(nestedOptions)});
      } catch (error) {
        globalThis.${marker} = {
          name: error?.name,
          message: String(error?.message ?? error),
        };
        throw error;
      }
    },
  };`,
        });

        const registry = loadOpenClawPlugins(nestedOptions);

        try {
          const reentryError = Reflect.get(globalThis, marker) as
            | { name?: unknown; message?: unknown }
            | undefined;
          expect(reentryError?.name).toBe("PluginLoadReentryError");
          expect(String(reentryError?.message)).toContain("plugin load reentry detected");
          const record = registry.plugins.find((entry) => entry.id === "reentrant-snapshot");
          expect(record?.status).toBe("error");
          expect(record?.error).toContain("plugin load reentry detected");
          expect(record?.failurePhase).toBe("register");
        } finally {
          Reflect.deleteProperty(globalThis, marker);
          Reflect.deleteProperty(globalThis, reenterFnMarker);
        }
      },
    },
    {
      label: "lets resolveRuntimePluginRegistry short-circuit during same snapshot load",
      run: () => {
        useNoBundledPlugins();
        const marker = "__openclaw_runtime_registry_reentry_marker";
        const resolverMarker = "__openclaw_runtime_registry_reentry_fn";
        Reflect.deleteProperty(globalThis, marker);
        Reflect.set(
          globalThis,
          resolverMarker,
          (options: Parameters<typeof resolveRuntimePluginRegistry>[0]) =>
            resolveRuntimePluginRegistry(options),
        );
        const pluginDir = makeTempDir();
        const pluginFile = path.join(pluginDir, "runtime-registry-reentry.cjs");
        const nestedOptions = {
          cache: false,
          activate: false,
          workspaceDir: pluginDir,
          config: {
            plugins: {
              load: { paths: [pluginFile] },
              allow: ["runtime-registry-reentry"],
            },
          },
        } satisfies Parameters<typeof loadOpenClawPlugins>[0];
        writePlugin({
          id: "runtime-registry-reentry",
          dir: pluginDir,
          filename: "runtime-registry-reentry.cjs",
          body: `module.exports = {
    id: "runtime-registry-reentry",
    register() {
      const registry = globalThis.${resolverMarker}(${JSON.stringify(nestedOptions)});
      globalThis.${marker} = registry === undefined ? "undefined" : "loaded";
    },
  };`,
        });

        const registry = loadOpenClawPlugins(nestedOptions);

        try {
          expect(Reflect.get(globalThis, marker)).toBe("undefined");
          const record = registry.plugins.find((entry) => entry.id === "runtime-registry-reentry");
          expect(record?.status).toBe("loaded");
        } finally {
          Reflect.deleteProperty(globalThis, marker);
          Reflect.deleteProperty(globalThis, resolverMarker);
        }
      },
    },
    {
      label: "keeps scoped plugin loads in a separate cache entry",
      run: () => {
        useNoBundledPlugins();
        const allowed = writePlugin({
          id: "allowed-cache-scope",
          filename: "allowed-cache-scope.cjs",
          body: `module.exports = { id: "allowed-cache-scope", register() {} };`,
        });
        const extra = writePlugin({
          id: "extra-cache-scope",
          filename: "extra-cache-scope.cjs",
          body: `module.exports = { id: "extra-cache-scope", register() {} };`,
        });
        const options = {
          config: {
            plugins: {
              load: { paths: [allowed.file, extra.file] },
              allow: ["allowed-cache-scope", "extra-cache-scope"],
            },
          },
        };

        const full = loadOpenClawPlugins(options);
        const scoped = loadOpenClawPlugins({
          ...options,
          onlyPluginIds: ["allowed-cache-scope"],
        });
        const scopedAgain = loadOpenClawPlugins({
          ...options,
          onlyPluginIds: ["allowed-cache-scope"],
        });

        expect(full.plugins.map((entry) => entry.id).toSorted()).toEqual([
          "allowed-cache-scope",
          "extra-cache-scope",
        ]);
        expect(scoped).not.toBe(full);
        expect(scoped.plugins.map((entry) => entry.id)).toEqual(["allowed-cache-scope"]);
        expect(scopedAgain).toBe(scoped);
      },
    },
    {
      label: "can load a scoped registry without replacing the active global registry",
      run: () => {
        useNoBundledPlugins();
        const plugin = writePlugin({
          id: "allowed-nonactivating-scope",
          filename: "allowed-nonactivating-scope.cjs",
          body: `module.exports = { id: "allowed-nonactivating-scope", register() {} };`,
        });
        const previousRegistry = createEmptyPluginRegistry();
        setActivePluginRegistry(previousRegistry, "existing-registry");
        resetGlobalHookRunner();

        const scoped = loadOpenClawPlugins({
          cache: false,
          activate: false,
          workspaceDir: plugin.dir,
          config: {
            plugins: {
              load: { paths: [plugin.file] },
              allow: ["allowed-nonactivating-scope"],
            },
          },
          onlyPluginIds: ["allowed-nonactivating-scope"],
        });

        expect(scoped.plugins.map((entry) => entry.id)).toEqual(["allowed-nonactivating-scope"]);
        expect(getActivePluginRegistry()).toBe(previousRegistry);
        expect(getActivePluginRegistryKey()).toBe("existing-registry");
        expect(getGlobalHookRunner()).toBeNull();
      },
    },
  ] as const)("handles config-path and scoped plugin loads: $label", async ({ run }) => {
    await run();
  });

  it("treats an explicit empty plugin scope as scoped-empty instead of unscoped", () => {
    useNoBundledPlugins();
    const allowed = writePlugin({
      id: "allowed-empty-scope",
      filename: "allowed-empty-scope.cjs",
      body: `module.exports = { id: "allowed-empty-scope", register() {} };`,
    });
    const extra = writePlugin({
      id: "extra-empty-scope",
      filename: "extra-empty-scope.cjs",
      body: `module.exports = { id: "extra-empty-scope", register() {} };`,
    });

    const registry = loadOpenClawPlugins({
      cache: false,
      activate: false,
      config: {
        plugins: {
          load: { paths: [allowed.file, extra.file] },
          allow: ["allowed-empty-scope", "extra-empty-scope"],
        },
      },
      onlyPluginIds: [],
    });

    expect(registry.plugins).toStrictEqual([]);
  });

  it("skips discovery and manifest registry loading entirely when onlyPluginIds is an explicit empty array", async () => {
    useNoBundledPlugins();
    const allowed = writePlugin({
      id: "allowed-empty-scope",
      filename: "allowed-empty-scope.cjs",
      body: `module.exports = { id: "allowed-empty-scope", register() {} };`,
    });

    const discovery = await import("./discovery.js");
    const manifestRegistry = await import("./manifest-registry.js");
    const discoverySpy = vi.spyOn(discovery, "discoverOpenClawPlugins");
    const manifestSpy = vi.spyOn(manifestRegistry, "loadPluginManifestRegistry");

    const registry = loadOpenClawPlugins({
      cache: false,
      activate: false,
      config: {
        plugins: {
          load: { paths: [allowed.file] },
          allow: ["allowed-empty-scope"],
        },
      },
      onlyPluginIds: [],
    });

    expect(registry.plugins).toStrictEqual([]);
    expect(discoverySpy).not.toHaveBeenCalled();
    expect(manifestSpy).not.toHaveBeenCalled();

    discoverySpy.mockRestore();
    manifestSpy.mockRestore();
  });

  it("only publishes command and interactive globals during activating loads", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "command-plugin",
      filename: "command-plugin.cjs",
      body: `module.exports = {
          id: "command-plugin",
          register(api) {
            api.registerCommand({
              name: "pair",
              description: "Pair device",
              acceptsArgs: true,
              handler: async ({ args }) => ({ text: \`paired:\${args ?? ""}\` }),
            });
            api.registerInteractiveHandler({
              channel: "telegram",
              namespace: "pair",
              handle: async () => ({ handled: true }),
            });
          },
        };`,
    });
    clearPluginCommands();
    clearPluginInteractiveHandlers();

    const scoped = loadOpenClawPlugins({
      cache: false,
      activate: false,
      workspaceDir: plugin.dir,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["command-plugin"],
        },
      },
      onlyPluginIds: ["command-plugin"],
    });

    expect(scoped.plugins.find((entry) => entry.id === "command-plugin")?.status).toBe("loaded");
    expect(scoped.commands.map((entry) => entry.command.name)).toEqual(["pair"]);
    expect(scoped.interactiveHandlers).toEqual([
      expect.objectContaining({
        channel: "telegram",
        namespace: "pair",
        pluginId: "command-plugin",
      }),
    ]);
    expect(getPluginCommandSpecs("telegram")).toStrictEqual([]);
    expect(resolvePluginInteractiveNamespaceMatch("telegram", "pair:device")).toBeNull();

    const active = loadOpenClawPlugins({
      cache: false,
      workspaceDir: plugin.dir,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["command-plugin"],
        },
      },
      onlyPluginIds: ["command-plugin"],
    });

    expect(active.plugins.find((entry) => entry.id === "command-plugin")?.status).toBe("loaded");
    expect(getPluginCommandSpecs()).toEqual([
      {
        name: "pair",
        description: "Pair device",
        acceptsArgs: true,
      },
    ]);
    expect(resolvePluginInteractiveNamespaceMatch("telegram", "pair:device")).toMatchObject({
      namespace: "pair",
      payload: "device",
      registration: {
        pluginId: "command-plugin",
      },
    });

    clearPluginCommands();
    clearPluginInteractiveHandlers();
  });

  it("clears plugin agent harnesses during activating reloads", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "codex-harness",
      filename: "codex-harness.cjs",
      body: `module.exports = {
          id: "codex-harness",
          register(api) {
            api.registerAgentHarness({
              id: "codex",
              label: "Codex",
              supports: () => ({ supported: true }),
              runAttempt: async () => ({ ok: false, error: "unused" }),
            });
          },
        };`,
    });

    loadOpenClawPlugins({
      cache: false,
      workspaceDir: plugin.dir,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["codex-harness"],
        },
      },
      onlyPluginIds: ["codex-harness"],
    });
    expect(listRegisteredAgentHarnessIdsForTest()).toEqual(["codex"]);

    loadOpenClawPlugins({
      cache: false,
      workspaceDir: makeTempDir(),
      config: {
        plugins: {
          allow: [],
        },
      },
    });
    expect(listRegisteredAgentHarnessIdsForTest()).toStrictEqual([]);
  });

  it("restores cleared runtime registrations when an activating reload throws before activation", async () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "reload-rollback",
      filename: "reload-rollback.cjs",
      body: `module.exports = {
        id: "reload-rollback",
        register(api) {
          api.registerAgentHarness({
            id: "codex",
            label: "Codex",
            supports: () => ({ supported: true }),
            runAttempt: async () => ({ ok: false, error: "unused" }),
          });
          api.registerCommand({
            name: "pair",
            description: "Pair device",
            acceptsArgs: true,
            handler: async () => ({ text: "paired" }),
          });
          api.registerProvider({
            id: "rollback-provider",
            label: "Rollback Provider",
            auth: [],
          });
          api.registerAgentToolResultMiddleware(() => undefined, {
            runtimes: ["openclaw"],
          });
          api.on("gateway_stop", async () => {});
        },
      };`,
    });
    updatePluginManifest(plugin, {
      providers: ["rollback-provider"],
      contracts: { agentToolResultMiddleware: ["openclaw"] },
    });

    const loadOptions = {
      cache: false,
      workspaceDir: plugin.dir,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["reload-rollback"],
        },
      },
      onlyPluginIds: ["reload-rollback"],
    };

    const activeRegistry = loadOpenClawPlugins(loadOptions);
    const expectRegistrationsIntact = () => {
      expect(getActivePluginRegistry()).toBe(activeRegistry);
      expect(getRegisteredAgentHarness("codex")).toBeDefined();
      expect(getPluginCommandSpecs().map((entry) => entry.name)).toEqual(["pair"]);
      expect(activeRegistry.providers.map((entry) => entry.provider.id)).toEqual([
        "rollback-provider",
      ]);
      expect(activeRegistry.agentToolResultMiddlewares).toHaveLength(1);
      expect(activeRegistry.typedHooks.map((entry) => entry.hookName)).toEqual(["gateway_stop"]);
    };
    expectRegistrationsIntact();

    const manifestRegistry = await import("./manifest-registry.js");
    const manifestSpy = vi
      .spyOn(manifestRegistry, "loadPluginManifestRegistry")
      .mockImplementation(() => {
        throw new Error("corrupt plugin manifest");
      });

    try {
      expect(() => loadOpenClawPlugins(loadOptions)).toThrow("corrupt plugin manifest");
      expectRegistrationsIntact();
    } finally {
      manifestSpy.mockRestore();
    }

    const failingPlugin = writePlugin({
      id: "reload-rollback-failure",
      filename: "reload-rollback-failure.cjs",
      body: `module.exports = {
        id: "reload-rollback-failure",
        register() { throw new Error("register failed"); },
      };`,
    });
    expect(() =>
      loadOpenClawPlugins({
        ...loadOptions,
        throwOnLoadError: true,
        config: {
          plugins: {
            load: { paths: [plugin.file, failingPlugin.file] },
            allow: ["reload-rollback", "reload-rollback-failure"],
          },
        },
        onlyPluginIds: ["reload-rollback", "reload-rollback-failure"],
      }),
    ).toThrow("plugin load failed: reload-rollback-failure: Error: register failed");
    expectRegistrationsIntact();
  });

  it("rejects malformed plugin agent harness registrations", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "bad-harness",
      filename: "bad-harness.cjs",
      body: `module.exports = {
          id: "bad-harness",
          register(api) {
            api.registerAgentHarness({
              id: "broken",
              label: "Broken",
            });
          },
        };`,
    });

    const registry = loadOpenClawPlugins({
      cache: false,
      workspaceDir: plugin.dir,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["bad-harness"],
        },
      },
      onlyPluginIds: ["bad-harness"],
    });

    expect(listRegisteredAgentHarnessIdsForTest()).toStrictEqual([]);
    const diagnostic = registry.diagnostics.find(
      (entry) =>
        entry.level === "error" &&
        entry.pluginId === "bad-harness" &&
        entry.message === 'agent harness "broken" registration missing required runtime methods',
    );
    if (!diagnostic) {
      throw new Error("Expected bad-harness runtime methods diagnostic");
    }
  });

  it("does not register internal hooks globally during non-activating loads", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "internal-hook-snapshot",
      filename: "internal-hook-snapshot.cjs",
      body: `module.exports = {
          id: "internal-hook-snapshot",
          register(api) {
            api.registerHook("gateway:startup", () => {}, { name: "snapshot-hook" });
          },
        };`,
    });

    clearInternalHooks();
    const scoped = loadOpenClawPlugins({
      cache: false,
      activate: false,
      workspaceDir: plugin.dir,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["internal-hook-snapshot"],
        },
      },
      onlyPluginIds: ["internal-hook-snapshot"],
    });

    expect(scoped.plugins.find((entry) => entry.id === "internal-hook-snapshot")?.status).toBe(
      "loaded",
    );
    expect(scoped.hooks.map((entry) => entry.entry.hook.name)).toEqual(["snapshot-hook"]);
    expect(getRegisteredEventKeys()).toStrictEqual([]);

    clearInternalHooks();
  });

  it("replaces prior plugin hook registrations on activating reloads", async () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "internal-hook-reload",
      filename: "internal-hook-reload.cjs",
      body: `module.exports = {
          id: "internal-hook-reload",
          register(api) {
            api.registerHook(
              "gateway:startup",
              (event) => {
                event.messages.push("reload-hook-fired");
              },
              { name: "reload-hook" },
            );
          },
        };`,
    });

    clearInternalHooks();

    const loadOptions = {
      cache: false,
      workspaceDir: plugin.dir,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["internal-hook-reload"],
        },
      },
      onlyPluginIds: ["internal-hook-reload"],
    };

    loadOpenClawPlugins(loadOptions);
    loadOpenClawPlugins(loadOptions);

    const event = createInternalHookEvent("gateway", "startup", "gateway:startup");
    await triggerInternalHook(event);
    expect(countMatching(event.messages, (message) => message === "reload-hook-fired")).toBe(1);

    clearInternalHooks();
  });

  it("injects plugin config into internal hook event context", async () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "hook-config-context",
      filename: "hook-config-context.cjs",
      body: `module.exports = {
          id: "hook-config-context",
          register(api) {
            api.registerHook(
              "gateway:startup",
              (event) => {
                event.messages.push(event.context.pluginConfig?.marker);
              },
              { name: "hook-config-context" },
            );
          },
        };`,
    });
    fs.writeFileSync(
      path.join(plugin.dir, "openclaw.plugin.json"),
      JSON.stringify(
        {
          id: "hook-config-context",
          configSchema: { type: "object" },
        },
        null,
        2,
      ),
      "utf-8",
    );

    clearInternalHooks();

    loadOpenClawPlugins({
      cache: false,
      workspaceDir: plugin.dir,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["hook-config-context"],
          entries: {
            "hook-config-context": {
              config: {
                marker: "plugin-config-visible",
              },
            },
          },
        },
      },
      onlyPluginIds: ["hook-config-context"],
    });

    const event = createInternalHookEvent("gateway", "startup", "gateway:startup");
    await triggerInternalHook(event);
    expect(event.messages).toEqual(["plugin-config-visible"]);
    expect(event.context).toStrictEqual({});

    clearInternalHooks();
  });

  it("preserves plugin hook context mutations for bootstrap hooks", async () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "hook-bootstrap-mutation",
      filename: "hook-bootstrap-mutation.cjs",
      body: `module.exports = {
          id: "hook-bootstrap-mutation",
          register(api) {
            api.registerHook(
              "agent:bootstrap",
              (event) => {
                event.context.bootstrapFiles = [
                  {
                    name: "AGENTS.md",
                    path: "/tmp/override-AGENTS.md",
                    content: "override bootstrap rules",
                    missing: false,
                  },
                ];
              },
              { name: "hook-bootstrap-mutation" },
            );
          },
        };`,
    });

    clearInternalHooks();

    loadRegistryFromSinglePlugin({
      plugin,
      pluginConfig: {
        allow: ["hook-bootstrap-mutation"],
      },
      options: {
        onlyPluginIds: ["hook-bootstrap-mutation"],
      },
    });

    const updated = await applyBootstrapHookOverrides({
      files: [
        {
          name: "AGENTS.md",
          path: "/tmp/base-AGENTS.md",
          content: "base bootstrap rules",
          missing: false,
        } satisfies WorkspaceBootstrapFile,
      ],
      workspaceDir: "/tmp",
      sessionKey: "agent:main:subagent:test-bootstrap",
    });

    expect(updated).toEqual([
      {
        name: "AGENTS.md",
        path: "/tmp/override-AGENTS.md",
        content: "override bootstrap rules",
        missing: false,
      },
    ]);

    clearInternalHooks();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
