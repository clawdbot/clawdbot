// Load context tests cover agent and workspace context resolution for plugin runtimes.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

const loadConfigMock = vi.fn<typeof import("../../config/config.js").loadConfig>();
const applyPluginAutoEnableMock =
  vi.fn<typeof import("../../config/plugin-auto-enable.js").applyPluginAutoEnable>();
const resolveAgentWorkspaceDirMock = vi.fn<
  typeof import("../../agents/agent-scope.js").resolveAgentWorkspaceDir
>(() => "/resolved-workspace");
const resolveDefaultAgentIdMock = vi.fn<
  typeof import("../../agents/agent-scope.js").resolveDefaultAgentId
>(() => "default");
const manifestRegistry = { diagnostics: [], plugins: [] };
const metadataSnapshot = {
  configFingerprint: "fingerprint",
  diagnostics: [],
  index: { plugins: [], policyHash: "policy" },
  manifestRegistry,
  plugins: [],
  policyHash: "policy",
  workspaceDir: "/resolved-workspace",
};
type MetadataSnapshotMock = typeof metadataSnapshot & { pluginIds?: readonly string[] };
const loadPluginMetadataSnapshotMock = vi.fn((): MetadataSnapshotMock => metadataSnapshot);
const isPluginMetadataSnapshotCompatibleMock = vi.fn(() => true);
const getCurrentPluginMetadataSnapshotMock = vi.fn(() => undefined);
const setCurrentPluginMetadataSnapshotMock = vi.fn();
const clearCurrentPluginMetadataSnapshotMock = vi.fn();

let resolvePluginRuntimeLoadContext: typeof import("./load-context.js").resolvePluginRuntimeLoadContext;
let buildPluginRuntimeLoadOptions: typeof import("./load-context.js").buildPluginRuntimeLoadOptions;
let clearRuntimeConfigSnapshot: typeof import("../../config/runtime-snapshot.js").clearRuntimeConfigSnapshot;
let setRuntimeConfigSnapshot: typeof import("../../config/runtime-snapshot.js").setRuntimeConfigSnapshot;

vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: loadConfigMock,
  loadConfig: loadConfigMock,
}));

vi.mock("../../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: applyPluginAutoEnableMock,
}));

vi.mock("../../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: resolveAgentWorkspaceDirMock,
  resolveDefaultAgentId: resolveDefaultAgentIdMock,
}));

vi.mock("../plugin-metadata-snapshot.js", () => ({
  isPluginMetadataSnapshotCompatible: isPluginMetadataSnapshotCompatibleMock,
  loadPluginMetadataSnapshot: loadPluginMetadataSnapshotMock,
  resolvePluginMetadataSnapshot: loadPluginMetadataSnapshotMock,
}));

vi.mock("../current-plugin-metadata-snapshot.js", () => ({
  clearCurrentPluginMetadataSnapshot: clearCurrentPluginMetadataSnapshotMock,
  getCurrentPluginMetadataSnapshot: getCurrentPluginMetadataSnapshotMock,
  isReusableCurrentPluginMetadataSnapshot: (
    _snapshot: typeof metadataSnapshot & { registrySource?: "derived" },
  ) => true,
  setCurrentPluginMetadataSnapshot: setCurrentPluginMetadataSnapshotMock,
}));

describe("resolvePluginRuntimeLoadContext", () => {
  beforeEach(async () => {
    vi.resetModules();
    ({ clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } =
      await import("../../config/runtime-snapshot.js"));
    ({ resolvePluginRuntimeLoadContext, buildPluginRuntimeLoadOptions } =
      await import("./load-context.js"));
    loadConfigMock.mockReset();
    applyPluginAutoEnableMock.mockReset();
    getCurrentPluginMetadataSnapshotMock.mockReset();
    getCurrentPluginMetadataSnapshotMock.mockReturnValue(undefined);
    isPluginMetadataSnapshotCompatibleMock.mockReset();
    isPluginMetadataSnapshotCompatibleMock.mockReturnValue(true);
    loadPluginMetadataSnapshotMock.mockClear();
    getCurrentPluginMetadataSnapshotMock.mockClear();
    setCurrentPluginMetadataSnapshotMock.mockClear();
    clearCurrentPluginMetadataSnapshotMock.mockClear();
    resolveAgentWorkspaceDirMock.mockClear();
    resolveDefaultAgentIdMock.mockClear();

    loadConfigMock.mockReturnValue({ plugins: {} });
    applyPluginAutoEnableMock.mockImplementation((params) => ({
      config: params.config ?? {},
      changes: [],
      autoEnabledReasons: {},
    }));
    clearRuntimeConfigSnapshot();
  });

  it("builds the runtime plugin load context from the auto-enabled config", () => {
    const rawConfig = { plugins: {} };
    const resolvedConfig = {
      plugins: {
        entries: {
          demo: { enabled: true },
        },
      },
    };
    const env = { HOME: "/tmp/openclaw-home" } as NodeJS.ProcessEnv;

    applyPluginAutoEnableMock.mockReturnValue({
      config: resolvedConfig,
      changes: [],
      autoEnabledReasons: {
        demo: ["demo configured"],
      },
    });

    const context = resolvePluginRuntimeLoadContext({
      config: rawConfig,
      env,
    });

    expect(context).toEqual({
      rawConfig,
      config: resolvedConfig,
      activationSourceConfig: rawConfig,
      autoEnabledReasons: {
        demo: ["demo configured"],
      },
      workspaceDir: "/resolved-workspace",
      env,
      logger: context.logger,
      manifestRegistry,
      installRecords: {},
    });
    expect(loadPluginMetadataSnapshotMock).toHaveBeenCalledWith({
      allowWorkspaceScopedCurrent: true,
      config: rawConfig,
      env,
      workspaceDir: "/resolved-workspace",
    });
    expect(applyPluginAutoEnableMock).toHaveBeenCalledWith({
      config: rawConfig,
      env,
      manifestRegistry,
    });
    expect(setCurrentPluginMetadataSnapshotMock).toHaveBeenCalledWith(metadataSnapshot, {
      config: rawConfig,
      compatibleConfigs: [resolvedConfig, rawConfig],
      env,
      workspaceDir: "/resolved-workspace",
    });
    expect(resolveDefaultAgentIdMock).toHaveBeenCalledWith(resolvedConfig);
    expect(resolveAgentWorkspaceDirMock).toHaveBeenCalledWith(resolvedConfig, "default");
  });

  it("stores derived metadata as the reusable runtime snapshot", () => {
    const derivedSnapshot = { ...metadataSnapshot } as typeof metadataSnapshot & {
      registrySource: "derived";
    };
    derivedSnapshot.registrySource = "derived";
    loadPluginMetadataSnapshotMock.mockReturnValueOnce(derivedSnapshot);

    resolvePluginRuntimeLoadContext({
      config: { plugins: {} },
      env: { HOME: "/tmp/openclaw-home" } as NodeJS.ProcessEnv,
    });

    expect(setCurrentPluginMetadataSnapshotMock).toHaveBeenCalledWith(derivedSnapshot, {
      config: { plugins: {} },
      compatibleConfigs: [{ plugins: {} }, { plugins: {} }],
      env: { HOME: "/tmp/openclaw-home" },
      workspaceDir: "/resolved-workspace",
    });
    expect(clearCurrentPluginMetadataSnapshotMock).not.toHaveBeenCalled();
  });

  it("uses the source runtime snapshot for plugin activation source config", () => {
    const runtimeConfig = { plugins: {} };
    const sourceConfig = {
      plugins: {
        allow: ["trusted-plugin"],
      },
    };

    setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);
    loadConfigMock.mockReturnValue(runtimeConfig);

    const context = resolvePluginRuntimeLoadContext();

    expect(context.rawConfig).toBe(runtimeConfig);
    expect(context.activationSourceConfig).toBe(sourceConfig);
    expect(applyPluginAutoEnableMock).toHaveBeenCalledWith({
      config: runtimeConfig,
      env: process.env,
      manifestRegistry,
    });
  });

  it("reuses auto-enable results until Gateway config or metadata changes", () => {
    const rawConfig = { plugins: {} };
    const env = process.env;
    const initialSnapshot = { ...metadataSnapshot, pluginIds: ["openai"] };
    loadPluginMetadataSnapshotMock
      .mockReturnValueOnce(initialSnapshot)
      .mockReturnValueOnce({ ...initialSnapshot, pluginIds: ["openai"] })
      .mockReturnValueOnce({ ...initialSnapshot, policyHash: "changed" })
      .mockReturnValueOnce(initialSnapshot);

    const first = resolvePluginRuntimeLoadContext({ config: rawConfig, env });
    const second = resolvePluginRuntimeLoadContext({ config: rawConfig, env });
    resolvePluginRuntimeLoadContext({ config: rawConfig, env });
    resolvePluginRuntimeLoadContext({ config: { plugins: {} }, env });

    expect(second.config).toBe(first.config);
    expect(applyPluginAutoEnableMock).toHaveBeenCalledTimes(3);
  });

  it("invalidates auto-enable results when config or process env mutates in place", () => {
    const rawConfig: OpenClawConfig = { plugins: {} };
    const env = process.env;
    const envKey = "OPENCLAW_TEST_PLUGIN_AUTO_ENABLE_FINGERPRINT";
    const previousEnvValue = env[envKey];
    delete env[envKey];

    try {
      resolvePluginRuntimeLoadContext({ config: rawConfig, env });
      resolvePluginRuntimeLoadContext({ config: rawConfig, env });
      rawConfig.plugins = { entries: { demo: { enabled: true } } };
      resolvePluginRuntimeLoadContext({ config: rawConfig, env });
      env[envKey] = "changed";
      resolvePluginRuntimeLoadContext({ config: rawConfig, env });

      expect(applyPluginAutoEnableMock).toHaveBeenCalledTimes(3);
    } finally {
      if (previousEnvValue === undefined) {
        delete env[envKey];
      } else {
        env[envKey] = previousEnvValue;
      }
    }
  });

  it("threads install records from the metadata snapshot into the context and load options", () => {
    const snapshotWithRecords = {
      ...metadataSnapshot,
      index: {
        installRecords: {
          demo: { source: "registry", version: "1.0.0" },
        },
        plugins: [],
        policyHash: "policy",
      },
    };
    loadPluginMetadataSnapshotMock.mockReturnValueOnce(snapshotWithRecords);

    const context = resolvePluginRuntimeLoadContext({
      config: { plugins: {} },
      env: { HOME: "/tmp/openclaw-home" } as NodeJS.ProcessEnv,
    });

    expect(context.installRecords).toEqual({
      demo: { source: "registry", version: "1.0.0" },
    });
    expect(buildPluginRuntimeLoadOptions(context).installRecords).toEqual({
      demo: { source: "registry", version: "1.0.0" },
    });
  });

  it("builds plugin load options from the shared runtime context", () => {
    const context = resolvePluginRuntimeLoadContext({
      config: { plugins: {} },
      env: { HOME: "/tmp/openclaw-home" } as NodeJS.ProcessEnv,
      workspaceDir: "/explicit-workspace",
    });

    expect(
      buildPluginRuntimeLoadOptions(context, {
        cache: false,
        activate: false,
        onlyPluginIds: ["demo"],
      }),
    ).toEqual({
      config: context.config,
      activationSourceConfig: context.activationSourceConfig,
      autoEnabledReasons: context.autoEnabledReasons,
      workspaceDir: "/explicit-workspace",
      env: context.env,
      logger: context.logger,
      manifestRegistry,
      installRecords: {},
      cache: false,
      activate: false,
      onlyPluginIds: ["demo"],
    });
  });
});
