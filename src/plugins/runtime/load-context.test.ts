// Load context tests cover agent and workspace context resolution for plugin runtimes.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

const loadConfigMock = vi.fn<typeof import("../../config/config.js").loadConfig>();
const applyPluginAutoEnableMock =
  vi.fn<typeof import("../../config/plugin-auto-enable.js").applyPluginAutoEnable>();
const fingerprintPluginAutoEnableConfigMock = vi.fn((config: OpenClawConfig) =>
  JSON.stringify(config),
);
const fingerprintPluginAutoEnableEnvMock = vi.fn((env: NodeJS.ProcessEnv) => JSON.stringify(env));
const resolvePluginControlPlaneWorkspaceMock = vi.fn(
  (params: { config: OpenClawConfig; env?: NodeJS.ProcessEnv; workspaceDir?: string }) => ({
    workspaceDir: params.workspaceDir ?? "/resolved-workspace",
    workspaceScope: "selected" as const,
  }),
);
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
const rebasePluginMetadataSnapshotManifestRegistryMock = vi.fn(
  (snapshot: MetadataSnapshotMock) => snapshot,
);
const resolveConfigWidePluginManifestRegistryMock = vi.fn(() => manifestRegistry);
const isPluginMetadataSnapshotCompatibleMock = vi.fn(() => true);

let resolvePluginRuntimeLoadContext: typeof import("./load-context.js").resolvePluginRuntimeLoadContext;
let buildPluginRuntimeLoadOptions: typeof import("./load-context.js").buildPluginRuntimeLoadOptions;
let clearRuntimeConfigSnapshot: typeof import("../../config/runtime-snapshot.js").clearRuntimeConfigSnapshot;
let setRuntimeConfigSnapshot: typeof import("../../config/runtime-snapshot.js").setRuntimeConfigSnapshot;
let clearPluginMetadataLifecycleCaches: typeof import("../plugin-metadata-lifecycle.js").clearPluginMetadataLifecycleCaches;

vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: loadConfigMock,
  loadConfig: loadConfigMock,
}));

vi.mock("../../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: applyPluginAutoEnableMock,
}));

vi.mock("../../config/plugin-auto-enable.apply.js", () => ({
  fingerprintPluginAutoEnableConfig: fingerprintPluginAutoEnableConfigMock,
  fingerprintPluginAutoEnableEnv: fingerprintPluginAutoEnableEnvMock,
}));

vi.mock("../control-plane-workspace.js", () => ({
  resolvePluginControlPlaneWorkspace: resolvePluginControlPlaneWorkspaceMock,
}));

vi.mock("../../config/io.plugin-metadata.js", () => ({
  resolveConfigWidePluginManifestRegistry: resolveConfigWidePluginManifestRegistryMock,
}));

vi.mock("../plugin-metadata-snapshot.js", () => ({
  isPluginMetadataSnapshotCompatible: isPluginMetadataSnapshotCompatibleMock,
  loadPluginMetadataSnapshot: loadPluginMetadataSnapshotMock,
  rebasePluginMetadataSnapshotManifestRegistry: rebasePluginMetadataSnapshotManifestRegistryMock,
  resolvePluginMetadataSnapshot: loadPluginMetadataSnapshotMock,
}));

describe("resolvePluginRuntimeLoadContext", () => {
  beforeAll(async () => {
    ({ clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } =
      await import("../../config/runtime-snapshot.js"));
    ({ clearPluginMetadataLifecycleCaches } = await import("../plugin-metadata-lifecycle.js"));
    ({ resolvePluginRuntimeLoadContext, buildPluginRuntimeLoadOptions } =
      await import("./load-context.js"));
  });

  beforeEach(() => {
    loadConfigMock.mockReset();
    applyPluginAutoEnableMock.mockReset();
    fingerprintPluginAutoEnableConfigMock.mockClear();
    fingerprintPluginAutoEnableEnvMock.mockClear();
    isPluginMetadataSnapshotCompatibleMock.mockReset();
    isPluginMetadataSnapshotCompatibleMock.mockReturnValue(true);
    loadPluginMetadataSnapshotMock.mockClear();
    rebasePluginMetadataSnapshotManifestRegistryMock.mockClear();
    resolveConfigWidePluginManifestRegistryMock.mockClear();
    resolvePluginControlPlaneWorkspaceMock.mockClear();

    loadConfigMock.mockReturnValue({ plugins: {} });
    applyPluginAutoEnableMock.mockImplementation((params) => ({
      config: params.config ?? {},
      changes: [],
      autoEnabledReasons: {},
    }));
    clearRuntimeConfigSnapshot();
    clearPluginMetadataLifecycleCaches();
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
      metadataSnapshot,
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
    expect(resolvePluginControlPlaneWorkspaceMock).toHaveBeenNthCalledWith(1, {
      config: rawConfig,
      env,
      workspaceDir: undefined,
    });
    expect(resolvePluginControlPlaneWorkspaceMock).toHaveBeenNthCalledWith(2, {
      config: resolvedConfig,
      env,
      workspaceDir: undefined,
    });
    expect(resolveConfigWidePluginManifestRegistryMock).toHaveBeenCalledWith({
      config: rawConfig,
      env,
    });
  });

  it("reuses a prepared metadata snapshot without resolving metadata again", () => {
    const config = { plugins: {} };
    const env = { HOME: "/tmp/openclaw-home" } as NodeJS.ProcessEnv;

    const context = resolvePluginRuntimeLoadContext({
      config,
      env,
      metadataSnapshot: metadataSnapshot as never,
      workspaceDir: "/resolved-workspace",
    });

    expect(context.metadataSnapshot).toBe(metadataSnapshot);
    expect(loadPluginMetadataSnapshotMock).not.toHaveBeenCalled();
  });

  it("keeps derived metadata operation-local", () => {
    const derivedSnapshot = { ...metadataSnapshot } as typeof metadataSnapshot & {
      registrySource: "derived";
    };
    derivedSnapshot.registrySource = "derived";
    loadPluginMetadataSnapshotMock.mockReturnValueOnce(derivedSnapshot);

    const context = resolvePluginRuntimeLoadContext({
      config: { plugins: {} },
      env: { HOME: "/tmp/openclaw-home" } as NodeJS.ProcessEnv,
    });

    expect(context.metadataSnapshot).toBe(derivedSnapshot);
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

  it("uses reference fast paths, content fingerprints, and lifecycle invalidation", () => {
    const firstConfig: OpenClawConfig = { plugins: {} };
    const env = process.env;
    const first = resolvePluginRuntimeLoadContext({ config: firstConfig, env });

    for (let index = 0; index < 20; index += 1) {
      expect(resolvePluginRuntimeLoadContext({ config: firstConfig, env }).config).toBe(
        first.config,
      );
    }
    expect(applyPluginAutoEnableMock).toHaveBeenCalledTimes(1);
    expect(fingerprintPluginAutoEnableConfigMock).toHaveBeenCalledTimes(1);
    expect(fingerprintPluginAutoEnableEnvMock).toHaveBeenCalledTimes(1);

    const replacementConfig: OpenClawConfig = { plugins: {} };
    expect(resolvePluginRuntimeLoadContext({ config: replacementConfig, env }).config).toBe(
      first.config,
    );
    expect(applyPluginAutoEnableMock).toHaveBeenCalledTimes(1);
    expect(fingerprintPluginAutoEnableConfigMock).toHaveBeenCalledTimes(2);
    expect(fingerprintPluginAutoEnableEnvMock).toHaveBeenCalledTimes(1);

    clearPluginMetadataLifecycleCaches();
    resolvePluginRuntimeLoadContext({ config: replacementConfig, env });

    expect(applyPluginAutoEnableMock).toHaveBeenCalledTimes(2);
    expect(fingerprintPluginAutoEnableConfigMock).toHaveBeenCalledTimes(3);
    expect(fingerprintPluginAutoEnableEnvMock).toHaveBeenCalledTimes(2);
  });

  it("threads install records from the metadata snapshot into the context and load options", () => {
    const snapshotWithRecords = {
      ...metadataSnapshot,
      index: {
        installRecords: {
          demo: { source: "npm", version: "1.0.0" },
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
      demo: { source: "npm", version: "1.0.0" },
    });
    expect(buildPluginRuntimeLoadOptions(context).installRecords).toEqual({
      demo: { source: "npm", version: "1.0.0" },
    });
  });

  it.each([
    { scope: "explicit empty", pluginIds: [] },
    { scope: "explicit owner", pluginIds: ["demo"] },
  ])("keeps $scope plugin metadata scoped before activation", ({ pluginIds }) => {
    const config = { plugins: {} };
    const env = { HOME: "/tmp/openclaw-home" } as NodeJS.ProcessEnv;
    loadPluginMetadataSnapshotMock.mockReturnValueOnce({ ...metadataSnapshot, pluginIds });

    resolvePluginRuntimeLoadContext({ config, env, onlyPluginIds: pluginIds });

    expect(loadPluginMetadataSnapshotMock).toHaveBeenCalledExactlyOnceWith({
      allowWorkspaceScopedCurrent: true,
      config,
      env,
      pluginIds,
      workspaceDir: "/resolved-workspace",
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
