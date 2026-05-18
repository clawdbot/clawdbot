import { beforeEach, describe, expect, it, vi } from "vitest";

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
const loadPluginMetadataSnapshotMock = vi.fn(() => metadataSnapshot);
const getCurrentPluginMetadataSnapshotMock = vi.fn(() => undefined);
const setCurrentPluginMetadataSnapshotMock = vi.fn();

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
  loadPluginMetadataSnapshot: loadPluginMetadataSnapshotMock,
}));

vi.mock("../current-plugin-metadata-snapshot.js", () => ({
  getCurrentPluginMetadataSnapshot: getCurrentPluginMetadataSnapshotMock,
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
    loadPluginMetadataSnapshotMock.mockClear();
    getCurrentPluginMetadataSnapshotMock.mockClear();
    setCurrentPluginMetadataSnapshotMock.mockClear();
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
    });
    expect(loadPluginMetadataSnapshotMock).toHaveBeenCalledWith({
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
      cache: false,
      activate: false,
      onlyPluginIds: ["demo"],
    });
  });
});
