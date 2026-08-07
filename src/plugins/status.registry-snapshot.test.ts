import fs from "node:fs";
import path from "node:path";
// Covers plugin status snapshots built from registry state.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it } from "vitest";
import {
  readPersistedInstalledPluginIndex,
  writePersistedInstalledPluginIndexSync,
} from "./installed-plugin-index-store.js";
import { loadInstalledPluginIndex } from "./installed-plugin-index.js";
import { refreshPluginRegistry } from "./plugin-registry.js";
import {
  buildPluginDiagnosticsReport,
  buildPluginRegistrySnapshotReport,
  buildPluginSnapshotReport,
} from "./status.js";
import {
  createColdPluginConfig,
  createColdPluginFixture,
  createColdPluginHermeticEnv,
  isColdPluginRuntimeLoaded,
} from "./test-helpers/cold-plugin-fixtures.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";
import { writeManagedNpmPlugin } from "./test-helpers/managed-npm-plugin.js";

const tempDirs: string[] = [];

function makeTempDir() {
  return makeTrackedTempDir("openclaw-plugin-status", tempDirs);
}

function createWorkspacePluginFixture(workspaceDir: string, pluginId: string) {
  const rootDir = path.join(workspaceDir, ".openclaw", "extensions", pluginId);
  fs.mkdirSync(rootDir, { recursive: true });
  return createColdPluginFixture({
    rootDir,
    pluginId,
    manifest: { id: pluginId, name: `Workspace ${pluginId}` },
  });
}

afterEach(() => {
  cleanupTrackedTempDirs(tempDirs);
});

const requireRecord = createRequireRecord("record", "expected-non-array-record");

function requirePlugin(
  plugins: readonly Record<string, unknown>[],
  id: string,
): Record<string, unknown> {
  const plugin = plugins.find((entry) => entry.id === id);
  if (!plugin) {
    throw new Error(`Expected plugin ${id}`);
  }
  return requireRecord(plugin);
}

function requireRecordArray(value: unknown): Record<string, unknown>[] {
  expect(Array.isArray(value)).toBe(true);
  return value as Record<string, unknown>[];
}

function requireNamedEntry(
  entries: readonly Record<string, unknown>[],
  name: string,
): Record<string, unknown> {
  const entry = entries.find((candidate) => candidate.name === name);
  if (!entry) {
    throw new Error(`Expected entry ${name}`);
  }
  return requireRecord(entry);
}

function expectFields(actual: Record<string, unknown>, expected: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(expected)) {
    expect(actual[key]).toEqual(value);
  }
}

describe("buildPluginRegistrySnapshotReport", () => {
  it("does not project package-local dependency health onto bundled plugins", () => {
    const tempRoot = makeTempDir();
    const bundledRoot = path.join(tempRoot, "bundled");
    const pluginRoot = path.join(bundledRoot, "bundled-demo");
    fs.mkdirSync(pluginRoot, { recursive: true });
    createColdPluginFixture({
      rootDir: pluginRoot,
      pluginId: "bundled-demo",
      packageJson: { dependencies: { "missing-build-time-dependency": "1.0.0" } },
    });

    const report = buildPluginRegistrySnapshotReport({
      config: { plugins: { entries: { "bundled-demo": { enabled: true } } } },
      env: createColdPluginHermeticEnv(tempRoot, { bundledPluginsDir: bundledRoot }),
    });
    const plugin = requirePlugin(report.plugins, "bundled-demo");

    expectFields(plugin, { origin: "bundled", status: "loaded" });
    expect(plugin.dependencyStatus).toBeUndefined();
    expect(report.diagnostics).toEqual([]);
  });

  it("keeps recovered managed npm plugins visible when the persisted registry is stale", () => {
    const tempRoot = makeTempDir();
    const stateDir = path.join(tempRoot, "state");
    const env = {
      ...createColdPluginHermeticEnv(tempRoot, {
        bundledPluginsDir: makeTempDir(),
      }),
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_STATE_DIR: stateDir,
    };
    const config = {
      plugins: {
        entries: {
          whatsapp: { enabled: true },
        },
      },
    };
    const whatsappDir = writeManagedNpmPlugin({
      stateDir,
      packageName: "@openclaw/whatsapp",
      pluginId: "whatsapp",
      version: "2026.5.2",
      name: "WhatsApp",
    });
    const staleIndex = loadInstalledPluginIndex({
      config,
      env,
      installRecords: {},
    });
    expect(staleIndex.plugins.map((plugin) => plugin.pluginId)).not.toContain("whatsapp");
    writePersistedInstalledPluginIndexSync(staleIndex, { stateDir });

    const report = buildPluginRegistrySnapshotReport({
      config,
      env,
    });

    expect(report.registrySource).toBe("derived");
    expect(
      report.registryDiagnostics.some(
        (diagnostic) => diagnostic.code === "persisted-registry-stale-source",
      ),
    ).toBe(true);
    expectFields(requirePlugin(report.plugins, "whatsapp"), {
      id: "whatsapp",
      name: "WhatsApp",
      source: fs.realpathSync(path.join(whatsappDir, "dist", "index.js")),
      status: "loaded",
    });
  });

  it("reconstructs list metadata from indexed manifests without importing plugin runtime", () => {
    const fixture = createColdPluginFixture({
      rootDir: makeTempDir(),
      pluginId: "indexed-demo",
      packageName: "@example/openclaw-indexed-demo",
      packageVersion: "9.8.7",
      manifest: {
        id: "indexed-demo",
        name: "Indexed Demo",
        description: "Manifest-backed list metadata",
        version: "1.2.3",
        providers: ["indexed-provider"],
        contracts: {
          agentToolResultMiddleware: ["openclaw", "codex"],
          speechProviders: ["indexed-speech-provider"],
          realtimeTranscriptionProviders: ["indexed-transcription-provider"],
          realtimeVoiceProviders: ["indexed-voice-provider"],
          tools: ["indexed_echo", "indexed_search", "indexed_echo"],
          trustedToolPolicies: ["workflow-budget"],
        },
        commandAliases: [{ name: "indexed-demo" }],
        configSchema: {
          type: "object",
          additionalProperties: false,
          properties: {},
        },
      },
    });

    const report = buildPluginRegistrySnapshotReport({
      config: {
        plugins: {
          load: { paths: [fixture.rootDir] },
        },
      },
    });

    expectFields(requirePlugin(report.plugins, "indexed-demo"), {
      id: "indexed-demo",
      name: "Indexed Demo",
      description: "Manifest-backed list metadata",
      version: "9.8.7",
      format: "openclaw",
      providerIds: ["indexed-provider"],
      speechProviderIds: ["indexed-speech-provider"],
      realtimeTranscriptionProviderIds: ["indexed-transcription-provider"],
      realtimeVoiceProviderIds: ["indexed-voice-provider"],
      toolNames: ["indexed_echo", "indexed_search"],
      configSchema: true,
      contracts: {
        agentToolResultMiddleware: ["openclaw", "codex"],
        speechProviders: ["indexed-speech-provider"],
        realtimeTranscriptionProviders: ["indexed-transcription-provider"],
        realtimeVoiceProviders: ["indexed-voice-provider"],
        tools: ["indexed_echo", "indexed_search", "indexed_echo"],
        trustedToolPolicies: ["workflow-budget"],
      },
      commands: ["indexed-demo"],
      source: fs.realpathSync(fixture.runtimeSource),
      status: "loaded",
    });
    expect(isColdPluginRuntimeLoaded(fixture)).toBe(false);
  });

  it("discovers the configured default-agent workspace without importing plugin runtime", () => {
    const tempRoot = makeTempDir();
    const workspaceDir = path.join(tempRoot, "configured-workspace");
    const fixture = createWorkspacePluginFixture(workspaceDir, "configured-workspace-plugin");
    const env = {
      ...createColdPluginHermeticEnv(tempRoot, { bundledPluginsDir: makeTempDir() }),
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_STATE_DIR: path.join(tempRoot, "state"),
    };
    const config = {
      agents: { defaults: { workspace: workspaceDir } },
      plugins: {
        allow: [fixture.pluginId],
        entries: { [fixture.pluginId]: { enabled: true } },
      },
    };

    const report = buildPluginRegistrySnapshotReport({ config, env });

    expect(report.workspaceDir).toBe(workspaceDir);
    expectFields(requirePlugin(report.plugins, fixture.pluginId), {
      id: fixture.pluginId,
      origin: "workspace",
      configSchema: true,
    });
    expect(isColdPluginRuntimeLoaded(fixture)).toBe(false);
  });

  it("uses the selected default agent's workspace for cold plugin inventory", () => {
    const tempRoot = makeTempDir();
    const workspaceDir = path.join(tempRoot, "selected-agent-workspace");
    const fallbackWorkspace = path.join(tempRoot, "fallback-workspace");
    const fixture = createWorkspacePluginFixture(workspaceDir, "selected-agent-plugin");
    const env = {
      ...createColdPluginHermeticEnv(tempRoot, { bundledPluginsDir: makeTempDir() }),
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_STATE_DIR: path.join(tempRoot, "state"),
    };
    const config = {
      agents: {
        defaults: { workspace: fallbackWorkspace },
        list: [{ id: "main" }, { id: "research", default: true, workspace: workspaceDir }],
      },
      plugins: {
        allow: [fixture.pluginId],
        entries: { [fixture.pluginId]: { enabled: true } },
      },
    };

    const report = buildPluginRegistrySnapshotReport({ config, env });

    expect(report.workspaceDir).toBe(workspaceDir);
    expectFields(requirePlugin(report.plugins, fixture.pluginId), {
      id: fixture.pluginId,
      origin: "workspace",
    });
    expect(isColdPluginRuntimeLoaded(fixture)).toBe(false);
  });

  it("preserves an explicit workspace over the configured default agent", () => {
    const tempRoot = makeTempDir();
    const configuredWorkspace = path.join(tempRoot, "configured-workspace");
    const explicitWorkspace = path.join(tempRoot, "explicit-workspace");
    const configured = createWorkspacePluginFixture(configuredWorkspace, "configured-plugin");
    const explicit = createWorkspacePluginFixture(explicitWorkspace, "explicit-plugin");
    const env = {
      ...createColdPluginHermeticEnv(tempRoot, { bundledPluginsDir: makeTempDir() }),
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_STATE_DIR: path.join(tempRoot, "state"),
    };
    const config = {
      agents: { defaults: { workspace: configuredWorkspace } },
      plugins: {
        allow: [configured.pluginId, explicit.pluginId],
        entries: {
          [configured.pluginId]: { enabled: true },
          [explicit.pluginId]: { enabled: true },
        },
      },
    };

    const report = buildPluginRegistrySnapshotReport({
      config,
      env,
      workspaceDir: explicitWorkspace,
    });

    expect(report.workspaceDir).toBe(explicitWorkspace);
    expect(report.plugins.map((plugin) => plugin.id)).toEqual([explicit.pluginId]);
    expect(isColdPluginRuntimeLoaded(configured)).toBe(false);
    expect(isColdPluginRuntimeLoaded(explicit)).toBe(false);
  });

  it("keeps configured workspace plugins across manual and policy registry refreshes", async () => {
    const rootDir = makeTempDir();
    const stateDir = path.join(rootDir, "state");
    const workspaceDir = path.join(rootDir, "workspace");
    const fixture = createWorkspacePluginFixture(workspaceDir, "workspace-demo");
    const env = {
      ...createColdPluginHermeticEnv(rootDir, { bundledPluginsDir: makeTempDir() }),
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_STATE_DIR: stateDir,
    };
    const config = {
      agents: { defaults: { workspace: workspaceDir } },
      plugins: {
        allow: [fixture.pluginId],
        entries: { [fixture.pluginId]: { enabled: true } },
      },
    };

    const initial = await refreshPluginRegistry({ config, env, reason: "manual", stateDir });
    expect(initial.plugins.map((plugin) => plugin.pluginId)).toEqual([fixture.pluginId]);

    const disabledConfig = {
      ...config,
      plugins: { ...config.plugins, entries: { [fixture.pluginId]: { enabled: false } } },
    };
    const disabled = await refreshPluginRegistry({
      config: disabledConfig,
      env,
      policyPluginIds: [fixture.pluginId],
      reason: "policy-changed",
      stateDir,
    });
    expect(disabled.plugins).toEqual([
      expect.objectContaining({ pluginId: fixture.pluginId, origin: "workspace", enabled: false }),
    ]);

    const reenabled = await refreshPluginRegistry({
      config,
      env,
      policyPluginIds: [fixture.pluginId],
      reason: "policy-changed",
      stateDir,
    });
    expect(reenabled.plugins).toEqual([
      expect.objectContaining({ pluginId: fixture.pluginId, origin: "workspace", enabled: true }),
    ]);
    const persisted = await readPersistedInstalledPluginIndex({ stateDir });
    expect(persisted?.plugins.map((plugin) => plugin.pluginId)).toEqual([fixture.pluginId]);
    expect(isColdPluginRuntimeLoaded(fixture)).toBe(false);
  });

  it("preserves an explicit workspace when refreshing the configured plugin registry", async () => {
    const rootDir = makeTempDir();
    const stateDir = path.join(rootDir, "state");
    const configuredWorkspace = path.join(rootDir, "configured-workspace");
    const explicitWorkspace = path.join(rootDir, "explicit-workspace");
    const configured = createWorkspacePluginFixture(configuredWorkspace, "configured-plugin");
    const explicit = createWorkspacePluginFixture(explicitWorkspace, "explicit-plugin");
    const env = {
      ...createColdPluginHermeticEnv(rootDir, { bundledPluginsDir: makeTempDir() }),
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_STATE_DIR: stateDir,
    };

    const refreshed = await refreshPluginRegistry({
      config: {
        agents: { defaults: { workspace: configuredWorkspace } },
        plugins: { allow: [configured.pluginId, explicit.pluginId] },
      },
      env,
      reason: "manual",
      stateDir,
      workspaceDir: explicitWorkspace,
    });

    expect(refreshed.plugins).toEqual([
      expect.objectContaining({ pluginId: explicit.pluginId, origin: "workspace" }),
    ]);
    expect(isColdPluginRuntimeLoaded(configured)).toBe(false);
    expect(isColdPluginRuntimeLoaded(explicit)).toBe(false);
  });

  it("reports package dependency install state without importing plugin runtime", () => {
    const rootDir = makeTempDir();
    const fixture = createColdPluginFixture({
      rootDir,
      pluginId: "dependency-demo",
      packageJson: {
        dependencies: {
          "missing-required": "1.0.0",
          "present-required": "1.0.0",
        },
        optionalDependencies: {
          "missing-optional": "1.0.0",
        },
      },
      manifest: {
        id: "dependency-demo",
        name: "Dependency Demo",
      },
    });
    fs.mkdirSync(path.join(rootDir, "node_modules", "present-required"), { recursive: true });

    const report = buildPluginRegistrySnapshotReport({
      config: {
        plugins: {
          load: { paths: [fixture.rootDir] },
        },
      },
    });

    const plugin = requirePlugin(report.plugins, "dependency-demo");
    expectFields(plugin, {
      status: "error",
      error:
        'Plugin "dependency-demo" cannot load because required dependencies are missing: missing-required. Install the plugin dependencies or reinstall/update the plugin, then restart the Gateway.',
    });
    expect(report.diagnostics).toContainEqual({
      level: "error",
      pluginId: "dependency-demo",
      source: fs.realpathSync(fixture.runtimeSource),
      message:
        'Plugin "dependency-demo" cannot load because required dependencies are missing: missing-required. Install the plugin dependencies or reinstall/update the plugin, then restart the Gateway.',
    });
    const dependencyStatus = requireRecord(plugin.dependencyStatus);
    expectFields(dependencyStatus, {
      hasDependencies: true,
      installed: false,
      requiredInstalled: false,
      optionalInstalled: false,
      missing: ["missing-required"],
      missingOptional: ["missing-optional"],
    });
    const dependencies = requireRecordArray(dependencyStatus.dependencies);
    expect(dependencies).toHaveLength(2);
    expectFields(requireNamedEntry(dependencies, "missing-required"), {
      name: "missing-required",
      spec: "1.0.0",
      installed: false,
      optional: false,
    });
    expectFields(requireNamedEntry(dependencies, "present-required"), {
      name: "present-required",
      spec: "1.0.0",
      installed: true,
      optional: false,
    });
    const optionalDependencies = requireRecordArray(dependencyStatus.optionalDependencies);
    expect(optionalDependencies).toHaveLength(1);
    expectFields(requireNamedEntry(optionalDependencies, "missing-optional"), {
      name: "missing-optional",
      spec: "1.0.0",
      installed: false,
      optional: true,
    });
    expect(isColdPluginRuntimeLoaded(fixture)).toBe(false);
  });

  it("honors npm optional dependency precedence without reporting a false required failure", () => {
    const fixture = createColdPluginFixture({
      rootDir: makeTempDir(),
      pluginId: "optional-dependency-demo",
      packageJson: {
        dependencies: { "optional-runtime": "1.0.0" },
        optionalDependencies: { "optional-runtime": "2.0.0" },
      },
    });

    const report = buildPluginRegistrySnapshotReport({
      config: createColdPluginConfig(fixture.rootDir, fixture.pluginId),
    });
    const plugin = requirePlugin(report.plugins, fixture.pluginId);

    expectFields(plugin, { status: "loaded" });
    expectFields(requireRecord(plugin.dependencyStatus), {
      requiredInstalled: true,
      optionalInstalled: false,
      missing: [],
      missingOptional: ["optional-runtime"],
      dependencies: [],
    });
    expect(report.diagnostics).not.toContainEqual(
      expect.objectContaining({ pluginId: fixture.pluginId, level: "error" }),
    );
    expect(isColdPluginRuntimeLoaded(fixture)).toBe(false);
  });

  it("keeps disabled plugins with missing required dependencies diagnostic-free", () => {
    const fixture = createColdPluginFixture({
      rootDir: makeTempDir(),
      pluginId: "disabled-dependency-demo",
      packageJson: { dependencies: { "missing-required": "1.0.0" } },
      manifest: { contracts: { tools: ["disabled_demo_tool"] } },
    });

    const report = buildPluginRegistrySnapshotReport({
      config: {
        plugins: {
          load: { paths: [fixture.rootDir] },
          entries: { [fixture.pluginId]: { enabled: false } },
        },
      },
    });
    const plugin = requirePlugin(report.plugins, fixture.pluginId);

    expectFields(plugin, {
      enabled: false,
      status: "disabled",
      toolNames: ["disabled_demo_tool"],
    });
    expect(plugin.error).toBeUndefined();
    expect(requireRecord(plugin.dependencyStatus).missing).toEqual(["missing-required"]);
    expect(report.diagnostics).not.toContainEqual(
      expect.objectContaining({ pluginId: fixture.pluginId, level: "error" }),
    );
    expect(isColdPluginRuntimeLoaded(fixture)).toBe(false);
  });

  it("preserves the real runtime import error while explaining missing dependencies", () => {
    const rootDir = makeTempDir();
    const bundledRoot = makeTempDir();
    const fixture = createColdPluginFixture({
      rootDir,
      pluginId: "failed-runtime-dependency-demo",
      packageJson: {
        dependencies: { "missing-runtime": "1.0.0", "optional-runtime": "1.0.0" },
        optionalDependencies: { "optional-runtime": "2.0.0" },
      },
    });
    fs.writeFileSync(
      fixture.runtimeSource,
      `require("node:fs").writeFileSync(${JSON.stringify(fixture.runtimeMarker)}, "loaded");\n` +
        'require("missing-runtime");\n',
      "utf8",
    );

    const report = buildPluginDiagnosticsReport({
      config: createColdPluginConfig(rootDir, fixture.pluginId),
      workspaceDir: rootDir,
      env: createColdPluginHermeticEnv(rootDir, { bundledPluginsDir: bundledRoot }),
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    });
    const plugin = requirePlugin(report.plugins, fixture.pluginId);
    const diagnostics = report.diagnostics.filter((entry) => entry.pluginId === fixture.pluginId);

    expectFields(plugin, { status: "error" });
    expect(String(plugin.error)).toContain("Cannot find module");
    expect(String(plugin.error)).toContain("Install the plugin dependencies");
    expectFields(requireRecord(plugin.dependencyStatus), {
      missing: ["missing-runtime"],
      missingOptional: ["optional-runtime"],
    });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toContain("Cannot find module");
    expect(diagnostics[0]?.message).toContain("Install the plugin dependencies");
    expect(isColdPluginRuntimeLoaded(fixture)).toBe(true);
  });

  it("replays persisted list metadata without importing plugin runtime", async () => {
    const fixture = createColdPluginFixture({
      rootDir: makeTempDir(),
      pluginId: "persisted-demo",
      packageName: "@example/openclaw-persisted-demo",
      packageVersion: "2.0.0",
      manifest: {
        id: "persisted-demo",
        name: "Persisted Demo",
        description: "Persisted registry metadata",
        providers: ["persisted-provider"],
        commandAliases: [{ name: "persisted-demo" }],
      },
    });
    const workspaceDir = makeTempDir();
    const config = createColdPluginConfig(fixture.rootDir, fixture.pluginId);
    const env = createColdPluginHermeticEnv(workspaceDir, {
      bundledPluginsDir: makeTempDir(),
    });

    await refreshPluginRegistry({
      config,
      workspaceDir,
      env,
      reason: "manual",
    });
    expect(isColdPluginRuntimeLoaded(fixture)).toBe(false);

    const report = buildPluginRegistrySnapshotReport({
      config,
      workspaceDir,
      env,
    });

    expect(report.registrySource).toBe("persisted");
    expectFields(requirePlugin(report.plugins, "persisted-demo"), {
      id: "persisted-demo",
      name: "Persisted Demo",
      description: "Persisted registry metadata",
      version: "2.0.0",
      providerIds: ["persisted-provider"],
      commands: ["persisted-demo"],
      source: fs.realpathSync(fixture.runtimeSource),
      status: "loaded",
    });
    expect(isColdPluginRuntimeLoaded(fixture)).toBe(false);
  });

  it("builds read-only plugin status snapshots without importing plugin runtime", () => {
    const fixture = createColdPluginFixture({
      rootDir: makeTempDir(),
      pluginId: "snapshot-demo",
      manifest: {
        id: "snapshot-demo",
        name: "Snapshot Demo",
        description: "Status metadata",
        providers: ["snapshot-provider"],
      },
      providerId: "snapshot-provider",
      runtimeMessage: "runtime entry should not load for plugin status snapshot report",
    });
    const workspaceDir = makeTempDir();
    const report = buildPluginSnapshotReport({
      config: createColdPluginConfig(fixture.rootDir, fixture.pluginId),
      workspaceDir,
      env: createColdPluginHermeticEnv(workspaceDir, {
        bundledPluginsDir: makeTempDir(),
      }),
    });

    expectFields(requirePlugin(report.plugins, "snapshot-demo"), {
      id: "snapshot-demo",
      name: "Snapshot Demo",
      source: fs.realpathSync(fixture.runtimeSource),
      status: "loaded",
      imported: false,
    });
    expect(isColdPluginRuntimeLoaded(fixture)).toBe(false);
  });
});
