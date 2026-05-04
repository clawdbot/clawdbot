import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCompatibilityNotice,
  createCustomHook,
  createPluginLoadResult,
  createPluginRecord,
  createTypedHook,
  HOOK_ONLY_MESSAGE,
  LEGACY_BEFORE_AGENT_START_MESSAGE,
} from "./status.test-helpers.js";

const loadConfigMock = vi.fn();
const loadOpenClawPluginsMock = vi.fn();
const loadPluginMetadataRegistrySnapshotMock = vi.fn();
const loadPluginManifestRegistryForPluginRegistryMock = vi.fn();
const loadPluginRegistrySnapshotWithMetadataMock = vi.fn();
const loadPluginManifestRegistryForInstalledIndexMock = vi.fn();
const loadPluginMetadataSnapshotMock = vi.fn((rawParams: unknown = {}) => {
  const params = rawParams as { index?: unknown };
  const manifestRegistry = loadPluginManifestRegistryForInstalledIndexMock(params) ?? {
    plugins: [],
    diagnostics: [],
  };
  return {
    index: params.index ?? createInstalledPluginIndexSnapshot([]),
    manifestRegistry,
    plugins: manifestRegistry.plugins,
    byPluginId: new Map(
      manifestRegistry.plugins.map((plugin: { id: string }) => [plugin.id, plugin]),
    ),
  };
});
const applyPluginAutoEnableMock = vi.fn();
const resolveBundledProviderCompatPluginIdsMock = vi.fn();
const withBundledPluginAllowlistCompatMock = vi.fn();
const withBundledPluginEnablementCompatMock = vi.fn();
const listImportedBundledPluginFacadeIdsMock = vi.fn();
const listImportedRuntimePluginIdsMock = vi.fn();
let buildPluginSnapshotReport: typeof import("./status.js").buildPluginSnapshotReport;
let buildPluginRegistrySnapshotReport: typeof import("./status.js").buildPluginRegistrySnapshotReport;
let buildPluginDiagnosticsReport: typeof import("./status.js").buildPluginDiagnosticsReport;
let buildPluginInspectReport: typeof import("./status.js").buildPluginInspectReport;
let buildAllPluginInspectReports: typeof import("./status.js").buildAllPluginInspectReports;
let buildPluginCompatibilityNotices: typeof import("./status.js").buildPluginCompatibilityNotices;
let buildPluginCompatibilityWarnings: typeof import("./status.js").buildPluginCompatibilityWarnings;
let formatPluginCompatibilityNotice: typeof import("./status.js").formatPluginCompatibilityNotice;
let summarizePluginCompatibility: typeof import("./status.js").summarizePluginCompatibility;

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => loadConfigMock(),
  loadConfig: () => loadConfigMock(),
}));

vi.mock("../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: (...args: unknown[]) => applyPluginAutoEnableMock(...args),
}));

vi.mock("./loader.js", () => ({
  loadOpenClawPlugins: (...args: unknown[]) => loadOpenClawPluginsMock(...args),
}));

vi.mock("./runtime/metadata-registry-loader.js", () => ({
  loadPluginMetadataRegistrySnapshot: (...args: unknown[]) =>
    loadPluginMetadataRegistrySnapshotMock(...args),
}));

vi.mock("./plugin-registry.js", () => ({
  loadPluginManifestRegistryForPluginRegistry: (...args: unknown[]) =>
    loadPluginManifestRegistryForPluginRegistryMock(...args),
  loadPluginRegistrySnapshotWithMetadata: (...args: unknown[]) =>
    loadPluginRegistrySnapshotWithMetadataMock(...args),
}));

vi.mock("./manifest-registry-installed.js", () => ({
  loadPluginManifestRegistryForInstalledIndex: (...args: unknown[]) =>
    loadPluginManifestRegistryForInstalledIndexMock(...args),
}));

vi.mock("./plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: (...args: unknown[]) => loadPluginMetadataSnapshotMock(...args),
}));

vi.mock("./providers.js", () => ({
  resolveBundledProviderCompatPluginIds: (...args: unknown[]) =>
    resolveBundledProviderCompatPluginIdsMock(...args),
}));

vi.mock("./bundled-compat.js", () => ({
  withBundledPluginAllowlistCompat: (...args: unknown[]) =>
    withBundledPluginAllowlistCompatMock(...args),
  withBundledPluginEnablementCompat: (...args: unknown[]) =>
    withBundledPluginEnablementCompatMock(...args),
}));

vi.mock("../plugin-sdk/facade-runtime.js", () => ({
  listImportedBundledPluginFacadeIds: (...args: unknown[]) =>
    listImportedBundledPluginFacadeIdsMock(...args),
}));

vi.mock("./runtime.js", () => ({
  getActivePluginChannelRegistry: () => null,
  listImportedRuntimePluginIds: (...args: unknown[]) => listImportedRuntimePluginIdsMock(...args),
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: () => undefined,
  resolveDefaultAgentId: () => "default",
}));

vi.mock("../agents/workspace.js", () => ({
  resolveDefaultAgentWorkspaceDir: () => "/default-workspace",
}));

function setPluginLoadResult(overrides: Partial<ReturnType<typeof createPluginLoadResult>>) {
  const result = createPluginLoadResult({
    plugins: [],
    ...overrides,
  });
  loadOpenClawPluginsMock.mockReturnValue(result);
  loadPluginMetadataRegistrySnapshotMock.mockReturnValue(result);
}

function setSinglePluginLoadResult(
  plugin: ReturnType<typeof createPluginRecord>,
  overrides: Omit<Partial<ReturnType<typeof createPluginLoadResult>>, "plugins"> = {},
) {
  setPluginLoadResult({
    plugins: [plugin],
    ...overrides,
  });
}

function createInstalledPluginIndexSnapshot(
  plugins: Array<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    version: 1,
    warning: "test",
    hostContractVersion: "test",
    compatRegistryVersion: "test",
    migrationVersion: 1,
    policyHash: "test",
    generatedAtMs: 0,
    installRecords: {},
    plugins,
    diagnostics: [],
  };
}

function expectInspectReport(
  pluginId: string,
): NonNullable<ReturnType<typeof buildPluginInspectReport>> {
  const inspect = buildPluginInspectReport({ id: pluginId });
  expect(inspect).not.toBeNull();
  if (!inspect) {
    throw new Error(`expected inspect report for ${pluginId}`);
  }
  return inspect;
}

function expectPluginLoaderCall(params: {
  config?: unknown;
  activationSourceConfig?: unknown;
  autoEnabledReasons?: Record<string, string[]>;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  logger?: unknown;
  loadModules?: boolean;
}) {
  expect(loadOpenClawPluginsMock).toHaveBeenCalledWith(
    expect.objectContaining({
      ...(params.config !== undefined ? { config: params.config } : {}),
      ...(params.activationSourceConfig !== undefined
        ? { activationSourceConfig: params.activationSourceConfig }
        : {}),
      ...(params.autoEnabledReasons !== undefined
        ? { autoEnabledReasons: params.autoEnabledReasons }
        : {}),
      ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
      ...(params.env ? { env: params.env } : {}),
      ...(params.logger !== undefined ? { logger: params.logger } : {}),
      ...(params.loadModules !== undefined ? { loadModules: params.loadModules } : {}),
    }),
  );
}

function expectMetadataSnapshotLoaderCall(params: {
  config?: unknown;
  activationSourceConfig?: unknown;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  logger?: unknown;
  loadModules?: boolean;
}) {
  expect(loadPluginMetadataRegistrySnapshotMock).toHaveBeenCalledWith(
    expect.objectContaining({
      ...(params.config !== undefined ? { config: params.config } : {}),
      ...(params.activationSourceConfig !== undefined
        ? { activationSourceConfig: params.activationSourceConfig }
        : {}),
      ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
      ...(params.env ? { env: params.env } : {}),
      ...(params.logger !== undefined ? { logger: params.logger } : {}),
      ...(params.loadModules !== undefined ? { loadModules: params.loadModules } : {}),
    }),
  );
}

function expectAutoEnabledStatusLoad(params: { rawConfig: unknown }) {
  expect(applyPluginAutoEnableMock).toHaveBeenCalledWith(
    expect.objectContaining({
      config: params.rawConfig,
      env: process.env,
    }),
  );
}

function createCompatChainFixture() {
  const config = { plugins: { allow: ["telegram"] } };
  const pluginIds = ["anthropic", "openai"];
  const compatConfig = { plugins: { allow: ["telegram", ...pluginIds] } };
  const enabledConfig = {
    plugins: {
      allow: ["telegram", ...pluginIds],
      entries: {
        anthropic: { enabled: true },
        openai: { enabled: true },
      },
    },
  };
  return { config, pluginIds, compatConfig, enabledConfig };
}

function expectBundledCompatChainApplied(params: {
  config: unknown;
  pluginIds: string[];
  compatConfig: unknown;
  enabledConfig: unknown;
  loadModules: boolean;
}) {
  expect(withBundledPluginAllowlistCompatMock).toHaveBeenCalledWith({
    config: params.config,
    pluginIds: params.pluginIds,
  });
  expect(withBundledPluginEnablementCompatMock).toHaveBeenCalledWith({
    config: params.compatConfig,
    pluginIds: params.pluginIds,
  });
  if (params.loadModules) {
    expectPluginLoaderCall({ config: params.enabledConfig, loadModules: true });
    return;
  }
  expectMetadataSnapshotLoaderCall({ config: params.enabledConfig, loadModules: false });
}

function createAutoEnabledStatusConfig(
  entries: Record<string, unknown>,
  rawConfigOverrides?: Record<string, unknown>,
) {
  const rawConfig = {
    plugins: {},
    ...rawConfigOverrides,
  };
  const autoEnabledConfig = {
    ...rawConfig,
    plugins: {
      entries,
    },
  };
  return { rawConfig, autoEnabledConfig };
}

function expectAutoEnabledDemoCompatibilityNoticesPreserveRawConfig() {
  const { rawConfig, autoEnabledConfig } = createAutoEnabledStatusConfig(
    {
      demo: { enabled: true },
    },
    { channels: { demo: { enabled: true } } },
  );
  const autoEnabledReasons = {
    demo: ["demo configured"],
  };
  applyPluginAutoEnableMock.mockReturnValue({
    config: autoEnabledConfig,
    changes: [],
    autoEnabledReasons,
  });
  setSinglePluginLoadResult(
    createPluginRecord({
      id: "demo",
      name: "Demo",
      description: "Auto-enabled plugin",
      origin: "bundled",
      hookCount: 1,
    }),
    {
      typedHooks: [createTypedHook({ pluginId: "demo", hookName: "before_agent_start" })],
    },
  );

  expect(buildPluginCompatibilityNotices({ config: rawConfig })).toEqual([
    createCompatibilityNotice({ pluginId: "demo", code: "legacy-before-agent-start" }),
    createCompatibilityNotice({ pluginId: "demo", code: "hook-only" }),
  ]);

  expectAutoEnabledStatusLoad({
    rawConfig,
  });
  expectPluginLoaderCall({
    config: autoEnabledConfig,
    activationSourceConfig: rawConfig,
    autoEnabledReasons,
    loadModules: true,
  });
}

function expectNoCompatibilityWarnings() {
  expect(buildPluginCompatibilityNotices()).toEqual([]);
  expect(buildPluginCompatibilityWarnings()).toEqual([]);
}

function expectCompatibilityOutput(params: { notices?: unknown[]; warnings?: string[] }) {
  if (params.notices) {
    expect(buildPluginCompatibilityNotices()).toEqual(params.notices);
  }
  if (params.warnings) {
    expect(buildPluginCompatibilityWarnings()).toEqual(params.warnings);
  }
}

function expectCapabilityKinds(
  inspect: NonNullable<ReturnType<typeof buildPluginInspectReport>>,
  kinds: readonly string[],
) {
  expect(inspect.capabilities.map((entry) => entry.kind)).toEqual(kinds);
}

function expectInspectShape(
  inspect: NonNullable<ReturnType<typeof buildPluginInspectReport>>,
  params: {
    shape: string;
    capabilityMode: string;
    capabilityKinds: readonly string[];
  },
) {
  expect(inspect.shape).toBe(params.shape);
  expect(inspect.capabilityMode).toBe(params.capabilityMode);
  expectCapabilityKinds(inspect, params.capabilityKinds);
}

function expectInspectPolicy(
  inspect: NonNullable<ReturnType<typeof buildPluginInspectReport>>,
  expected: Record<string, unknown>,
) {
  expect(inspect.policy).toEqual(expected);
}

function expectBundleInspectState(
  inspect: NonNullable<ReturnType<typeof buildPluginInspectReport>>,
  params: {
    bundleCapabilities: readonly string[];
    shape: string;
  },
) {
  expect(inspect.bundleCapabilities).toEqual(params.bundleCapabilities);
  expect(inspect.mcpServers).toEqual([]);
  expect(inspect.shape).toBe(params.shape);
}

describe("plugin status reports", () => {
  beforeAll(async () => {
    ({
      buildAllPluginInspectReports,
      buildPluginCompatibilityNotices,
      buildPluginDiagnosticsReport,
      buildPluginCompatibilityWarnings,
      buildPluginInspectReport,
      buildPluginRegistrySnapshotReport,
      buildPluginSnapshotReport,
      formatPluginCompatibilityNotice,
      summarizePluginCompatibility,
    } = await import("./status.js"));
  });

  beforeEach(() => {
    loadConfigMock.mockReset();
    loadOpenClawPluginsMock.mockReset();
    loadPluginMetadataRegistrySnapshotMock.mockReset();
    loadPluginManifestRegistryForPluginRegistryMock.mockReset();
    loadPluginRegistrySnapshotWithMetadataMock.mockReset();
    loadPluginManifestRegistryForInstalledIndexMock.mockReset();
    loadPluginMetadataSnapshotMock.mockClear();
    applyPluginAutoEnableMock.mockReset();
    resolveBundledProviderCompatPluginIdsMock.mockReset();
    withBundledPluginAllowlistCompatMock.mockReset();
    withBundledPluginEnablementCompatMock.mockReset();
    listImportedBundledPluginFacadeIdsMock.mockReset();
    listImportedRuntimePluginIdsMock.mockReset();
    loadConfigMock.mockReturnValue({});
    loadPluginRegistrySnapshotWithMetadataMock.mockReturnValue({
      snapshot: createInstalledPluginIndexSnapshot([]),
      source: "derived",
      diagnostics: [],
    });
    loadPluginManifestRegistryForPluginRegistryMock.mockReturnValue({
      plugins: [],
      diagnostics: [],
    });
    loadPluginManifestRegistryForInstalledIndexMock.mockReturnValue({
      plugins: [],
      diagnostics: [],
    });
    applyPluginAutoEnableMock.mockImplementation((params: { config: unknown }) => ({
      config: params.config,
      changes: [],
      autoEnabledReasons: {},
    }));
    resolveBundledProviderCompatPluginIdsMock.mockReturnValue([]);
    withBundledPluginAllowlistCompatMock.mockImplementation(
      (params: { config: unknown }) => params.config,
    );
    withBundledPluginEnablementCompatMock.mockImplementation(
      (params: { config: unknown }) => params.config,
    );
    listImportedBundledPluginFacadeIdsMock.mockReturnValue([]);
    listImportedRuntimePluginIdsMock.mockReturnValue([]);
    setPluginLoadResult({ plugins: [] });
  });

  it("forwards an explicit env to plugin loading", () => {
    const env = { HOME: "/tmp/openclaw-home" } as NodeJS.ProcessEnv;

    buildPluginSnapshotReport({
      config: {},
      workspaceDir: "/workspace",
      env,
    });

    expectMetadataSnapshotLoaderCall({
      config: {},
      workspaceDir: "/workspace",
      env,
      loadModules: false,
    });
  });

  it("forwards an explicit logger to plugin loading", () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    buildPluginSnapshotReport({
      config: {},
      logger,
      workspaceDir: "/workspace",
    });

    expectMetadataSnapshotLoaderCall({
      config: {},
      logger,
      workspaceDir: "/workspace",
      loadModules: false,
    });
  });

  it("carries installed-index compatibility metadata into registry snapshot reports", () => {
    loadPluginRegistrySnapshotWithMetadataMock.mockReturnValue({
      snapshot: createInstalledPluginIndexSnapshot([
        {
          pluginId: "provider-env-plugin",
          manifestPath: "/tmp/provider-env-plugin/openclaw.plugin.json",
          manifestHash: "manifest-hash",
          rootDir: "/tmp/provider-env-plugin",
          origin: "workspace",
          enabled: true,
          startup: {
            sidecar: false,
            memory: false,
            deferConfiguredChannelFullLoadUntilAfterListen: false,
            agentHarnesses: [],
          },
          compat: ["provider-auth-env-vars"],
        },
      ]),
      source: "derived",
      diagnostics: [],
    });
    loadPluginManifestRegistryForInstalledIndexMock.mockReturnValue({
      plugins: [{ id: "provider-env-plugin", name: "Provider Env Plugin" }],
      diagnostics: [],
    });

    const report = buildPluginRegistrySnapshotReport({ config: {} });

    expect(report.plugins[0]).toMatchObject({
      id: "provider-env-plugin",
      compat: ["provider-auth-env-vars"],
    });
  });

  it("uses a metadata snapshot load for snapshot reports", () => {
    buildPluginSnapshotReport({ config: {}, workspaceDir: "/workspace" });

    expect(loadPluginMetadataRegistrySnapshotMock).toHaveBeenCalledWith(
      expect.objectContaining({
        loadModules: false,
      }),
    );
    expect(loadOpenClawPluginsMock).not.toHaveBeenCalled();
  });

  it("loads plugin status from the auto-enabled config snapshot", () => {
    const { rawConfig, autoEnabledConfig } = createAutoEnabledStatusConfig(
      {
        demo: { enabled: true },
      },
      { channels: { demo: { enabled: true } } },
    );
    applyPluginAutoEnableMock.mockReturnValue({
      config: autoEnabledConfig,
      changes: [],
      autoEnabledReasons: {
        demo: ["demo configured"],
      },
    });

    buildPluginSnapshotReport({ config: rawConfig });

    expectAutoEnabledStatusLoad({
      rawConfig,
    });
    expectMetadataSnapshotLoaderCall({
      config: autoEnabledConfig,
      activationSourceConfig: rawConfig,
      loadModules: false,
    });
  });

  it("uses the auto-enabled config snapshot for inspect policy summaries", () => {
    const { rawConfig, autoEnabledConfig } = createAutoEnabledStatusConfig(
      {
        demo: {
          enabled: true,
          subagent: {
            allowModelOverride: true,
            allowedModels: ["openai/gpt-5.5"],
            hasAllowedModelsConfig: true,
          },
        },
      },
      { channels: { demo: { enabled: true } } },
    );
    applyPluginAutoEnableMock.mockReturnValue({
      config: autoEnabledConfig,
      changes: [],
      autoEnabledReasons: {
        demo: ["demo configured"],
      },
    });
    setSinglePluginLoadResult(
      createPluginRecord({
        id: "demo",
        name: "Demo",
        description: "Auto-enabled plugin",
        origin: "bundled",
        providerIds: ["demo"],
      }),
    );

    const inspect = buildPluginInspectReport({ id: "demo", config: rawConfig });

    expect(inspect).not.toBeNull();
    expectInspectPolicy(inspect!, {
      allowPromptInjection: undefined,
      allowConversationAccess: undefined,
      hookTimeoutMs: undefined,
      hookTimeouts: undefined,
      allowModelOverride: true,
      allowedModels: ["openai/gpt-5.5"],
      hasAllowedModelsConfig: true,
    });
    expectPluginLoaderCall({ loadModules: true });
  });

  it("preserves raw config activation context when compatibility notices build their own report", () => {
    expectAutoEnabledDemoCompatibilityNoticesPreserveRawConfig();
  });

  it("applies the full bundled provider compat chain before loading plugins", () => {
    const { config, pluginIds, compatConfig, enabledConfig } = createCompatChainFixture();
    loadConfigMock.mockReturnValue(config);
    resolveBundledProviderCompatPluginIdsMock.mockReturnValue(pluginIds);
    withBundledPluginAllowlistCompatMock.mockReturnValue(compatConfig);
    withBundledPluginEnablementCompatMock.mockReturnValue(enabledConfig);

    buildPluginSnapshotReport({ config });

    expectBundledCompatChainApplied({
      config,
      pluginIds,
      compatConfig,
      enabledConfig,
      loadModules: false,
    });
  });

  it("preserves raw config activation context for compatibility-derived reports", () => {
    expectAutoEnabledDemoCompatibilityNoticesPreserveRawConfig();
  });

  it("normalizes bundled plugin versions to the core base release", () => {
    setSinglePluginLoadResult(
      createPluginRecord({
        id: "whatsapp",
        name: "WhatsApp",
        description: "Bundled channel plugin",
        version: "2026.3.22",
        origin: "bundled",
        channelIds: ["whatsapp"],
      }),
    );

    const report = buildPluginDiagnosticsReport({
      config: {},
      env: {
        OPENCLAW_VERSION: "2026.3.23-1",
      } as NodeJS.ProcessEnv,
    });

    expect(report.plugins[0]?.version).toBe("2026.3.23");
  });

  it("marks plugins as imported when runtime or facade state has loaded them", () => {
    setPluginLoadResult({
      plugins: [
        createPluginRecord({ id: "runtime-loaded" }),
        createPluginRecord({ id: "facade-loaded" }),
        createPluginRecord({ id: "bundle-loaded", format: "bundle" }),
        createPluginRecord({ id: "cold-plugin" }),
      ],
    });
    listImportedRuntimePluginIdsMock.mockReturnValue(["runtime-loaded", "bundle-loaded"]);
    listImportedBundledPluginFacadeIdsMock.mockReturnValue(["facade-loaded"]);

    const report = buildPluginSnapshotReport({ config: {} });

    expect(report.plugins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "runtime-loaded", imported: true }),
        expect.objectContaining({ id: "facade-loaded", imported: true }),
        expect.objectContaining({ id: "bundle-loaded", imported: false }),
        expect.objectContaining({ id: "cold-plugin", imported: false }),
      ]),
    );
  });

  it("marks snapshot-loaded plugin modules as imported during full report loads", () => {
    setPluginLoadResult({
      plugins: [
        createPluginRecord({ id: "runtime-loaded" }),
        createPluginRecord({ id: "bundle-loaded", format: "bundle" }),
      ],
    });

    const report = buildPluginDiagnosticsReport({ config: {} });

    expect(report.plugins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "runtime-loaded", imported: true }),
        expect.objectContaining({ id: "bundle-loaded", imported: false }),
      ]),
    );
  });

  it("marks errored plugin modules as imported when full diagnostics already evaluated them", () => {
    setPluginLoadResult({
      plugins: [createPluginRecord({ id: "broken-plugin", status: "error" })],
    });
    listImportedRuntimePluginIdsMock.mockReturnValue(["broken-plugin"]);

    const report = buildPluginDiagnosticsReport({ config: {} });

    expect(report.plugins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "broken-plugin", status: "error", imported: true }),
      ]),
    );
  });

  it("builds an inspect report with capability shape and policy", () => {
    loadConfigMock.mockReturnValue({
      plugins: {
        entries: {
          google: {
            hooks: { allowPromptInjection: false, allowConversationAccess: true },
            subagent: {
              allowModelOverride: true,
              allowedModels: ["openai/gpt-5.5"],
            },
          },
        },
      },
    });
    setPluginLoadResult({
      plugins: [
        createPluginRecord({
          id: "google",
          name: "Google",
          description: "Google provider plugin",
          origin: "bundled",
          providerIds: ["google"],
          mediaUnderstandingProviderIds: ["google"],
          imageGenerationProviderIds: ["google"],
          webSearchProviderIds: ["google"],
        }),
      ],
      diagnostics: [{ level: "warn", pluginId: "google", message: "watch this surface" }],
      typedHooks: [createTypedHook({ pluginId: "google", hookName: "before_agent_start" })],
    });

    const inspect = buildPluginInspectReport({ id: "google" });

    expect(inspect).not.toBeNull();
    expectInspectShape(inspect!, {
      shape: "hybrid-capability",
      capabilityMode: "hybrid",
      capabilityKinds: ["text-inference", "media-understanding", "image-generation", "web-search"],
    });
    expect(inspect?.usesLegacyBeforeAgentStart).toBe(true);
    expect(inspect?.compatibility).toEqual([
      createCompatibilityNotice({ pluginId: "google", code: "legacy-before-agent-start" }),
    ]);
    expectInspectPolicy(inspect!, {
      allowPromptInjection: false,
      allowConversationAccess: true,
      hookTimeoutMs: undefined,
      hookTimeouts: undefined,
      allowModelOverride: true,
      allowedModels: ["openai/gpt-5.5"],
      hasAllowedModelsConfig: true,
    });
    expect(inspect?.diagnostics).toEqual([
      { level: "warn", pluginId: "google", message: "watch this surface" },
    ]);
  });

  it("builds inspect reports for every loaded plugin", () => {
    setPluginLoadResult({
      plugins: [
        createPluginRecord({
          id: "lca",
          name: "LCA",
          description: "Legacy hook plugin",
          hookCount: 1,
        }),
        createPluginRecord({
          id: "microsoft",
          name: "Microsoft",
          description: "Hybrid capability plugin",
          origin: "bundled",
          providerIds: ["microsoft"],
          webSearchProviderIds: ["microsoft"],
        }),
      ],
      hooks: [createCustomHook({ pluginId: "lca", events: ["message"] })],
      typedHooks: [createTypedHook({ pluginId: "lca", hookName: "before_agent_start" })],
    });

    const inspect = buildAllPluginInspectReports();

    expect(inspect.map((entry) => entry.plugin.id)).toEqual(["lca", "microsoft"]);
    expect(inspect.map((entry) => entry.shape)).toEqual(["hook-only", "hybrid-capability"]);
    expect(inspect[0]?.usesLegacyBeforeAgentStart).toBe(true);
    expectCapabilityKinds(inspect[1], ["text-inference", "web-search"]);
  });

  it("treats a CLI-command-only plugin as a plain capability", () => {
    setSinglePluginLoadResult(
      createPluginRecord({
        id: "anthropic",
        name: "Anthropic",
        cliBackendIds: ["claude-cli"],
      }),
    );

    const inspect = expectInspectReport("anthropic");

    expectInspectShape(inspect, {
      shape: "plain-capability",
      capabilityMode: "plain",
      capabilityKinds: ["cli-backend"],
    });
    expect(inspect.capabilities).toEqual([{ kind: "cli-backend", ids: ["claude-cli"] }]);
  });

  it("treats a context-engine plugin as a plain capability", () => {
    setPluginLoadResult({
      plugins: [
        createPluginRecord({
          id: "moon",
          name: "Moon",
          kind: "context-engine",
          contextEngineIds: ["moon-engine"],
          hookCount: 1,
        }),
      ],
      hooks: [createCustomHook({ pluginId: "moon", events: ["message"] })],
    });

    const inspect = expectInspectReport("moon");

    expectInspectShape(inspect, {
      shape: "plain-capability",
      capabilityMode: "plain",
      capabilityKinds: ["context-engine"],
    });
    expect(inspect.capabilities).toEqual([{ kind: "context-engine", ids: ["moon-engine"] }]);
    expect(inspect.compatibility).toEqual([]);
    expectNoCompatibilityWarnings();
  });

  it("builds compatibility warnings for legacy compatibility paths", () => {
    setPluginLoadResult({
      plugins: [
        createPluginRecord({
          id: "lca",
          name: "LCA",
          description: "Legacy hook plugin",
          hookCount: 1,
        }),
      ],
      typedHooks: [createTypedHook({ pluginId: "lca", hookName: "before_agent_start" })],
    });

    expectCompatibilityOutput({
      warnings: [`lca ${LEGACY_BEFORE_AGENT_START_MESSAGE}`, `lca ${HOOK_ONLY_MESSAGE}`],
    });
  });

  it("builds structured compatibility notices with deterministic ordering", () => {
    setPluginLoadResult({
      plugins: [
        createPluginRecord({
          id: "hook-only",
          name: "Hook Only",
          hookCount: 1,
        }),
        createPluginRecord({
          id: "legacy-only",
          name: "Legacy Only",
          providerIds: ["legacy-only"],
          hookCount: 1,
        }),
      ],
      hooks: [createCustomHook({ pluginId: "hook-only", events: ["message"] })],
      typedHooks: [createTypedHook({ pluginId: "legacy-only", hookName: "before_agent_start" })],
    });

    expectCompatibilityOutput({
      notices: [
        createCompatibilityNotice({ pluginId: "hook-only", code: "hook-only" }),
        createCompatibilityNotice({ pluginId: "legacy-only", code: "legacy-before-agent-start" }),
      ],
    });
  });

  it("does not warn for explicit startup-lazy metadata", () => {
    setSinglePluginLoadResult(
      createPluginRecord({
        id: "modern-startup-lazy",
        name: "Modern Startup Lazy",
        compat: [],
      }),
    );

    expectNoCompatibilityWarnings();
  });

  it("returns no compatibility warnings for modern capability plugins", () => {
    setSinglePluginLoadResult(
      createPluginRecord({
        id: "modern",
        name: "Modern",
        providerIds: ["modern"],
      }),
    );

    expectNoCompatibilityWarnings();
  });

  it.each([
    {
      name: "populates bundleCapabilities from plugin record",
      plugin: createPluginRecord({
        id: "claude-bundle",
        name: "Claude Bundle",
        description: "A bundle plugin with skills and commands",
        source: "/tmp/claude-bundle/.claude-plugin/plugin.json",
        format: "bundle",
        bundleFormat: "claude",
        bundleCapabilities: ["skills", "commands", "agents", "settings"],
        rootDir: "/tmp/claude-bundle",
      }),
      expectedId: "claude-bundle",
      expectedBundleCapabilities: ["skills", "commands", "agents", "settings"],
      expectedShape: "non-capability",
    },
    {
      name: "returns empty bundleCapabilities and mcpServers for non-bundle plugins",
      plugin: createPluginRecord({
        id: "plain-plugin",
        name: "Plain Plugin",
        description: "A regular plugin",
        providerIds: ["plain"],
      }),
      expectedId: "plain-plugin",
      expectedBundleCapabilities: [],
      expectedShape: "plain-capability",
    },
  ])("$name", ({ plugin, expectedId, expectedBundleCapabilities, expectedShape }) => {
    setSinglePluginLoadResult(plugin);

    const inspect = expectInspectReport(expectedId);

    expectBundleInspectState(inspect, {
      bundleCapabilities: expectedBundleCapabilities,
      shape: expectedShape,
    });
  });

  it("formats and summarizes compatibility notices", () => {
    const notice = createCompatibilityNotice({
      pluginId: "legacy-plugin",
      code: "legacy-before-agent-start",
    });

    expect(formatPluginCompatibilityNotice(notice)).toBe(
      `legacy-plugin ${LEGACY_BEFORE_AGENT_START_MESSAGE}`,
    );
    expect(
      summarizePluginCompatibility([
        notice,
        createCompatibilityNotice({ pluginId: "legacy-plugin", code: "hook-only" }),
      ]),
    ).toEqual({
      noticeCount: 2,
      pluginCount: 1,
    });
  });
});
