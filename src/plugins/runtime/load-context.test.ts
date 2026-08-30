// Load context tests cover agent and workspace context resolution for plugin runtimes.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPluginMetadataSnapshot,
  makeRegistry,
} from "../../config/plugin-auto-enable.test-helpers.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createPluginCache, withPluginCache } from "../plugin-cache.js";
import type { PluginMetadataSnapshot } from "../plugin-metadata-snapshot.types.js";

const loadConfigMock = vi.fn<typeof import("../../config/config.js").loadConfig>();
const applyPluginAutoEnableMock =
  vi.fn<typeof import("../../config/plugin-auto-enable.js").applyPluginAutoEnable>();
const resolvePluginControlPlaneWorkspaceMock = vi.fn(
  (params: { config: OpenClawConfig; env?: NodeJS.ProcessEnv; workspaceDir?: string }) => ({
    workspaceDir: params.workspaceDir ?? "/resolved-workspace",
    workspaceScope: "selected" as const,
  }),
);
const manifestRegistry: ReturnType<typeof makeRegistry> = { diagnostics: [], plugins: [] };
const metadataSnapshot = createPluginMetadataSnapshot({
  manifestRegistry,
  workspaceDir: "/resolved-workspace",
});
const loadPluginMetadataSnapshotMock = vi.fn(
  (_params?: unknown): PluginMetadataSnapshot => metadataSnapshot,
);
const resolveConfigWidePluginManifestRegistryMock = vi.fn<
  typeof import("../../config/io.plugin-metadata.js").resolveConfigWidePluginManifestRegistry
>(() => manifestRegistry);

let resolvePluginRuntimeLoadContext: typeof import("./load-context.resolve.js").resolvePluginRuntimeLoadContext;
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

vi.mock("../control-plane-workspace.js", () => ({
  resolvePluginControlPlaneWorkspace: resolvePluginControlPlaneWorkspaceMock,
}));

vi.mock("../../config/io.plugin-metadata.js", () => ({
  resolveConfigWidePluginManifestRegistry: resolveConfigWidePluginManifestRegistryMock,
}));

vi.mock("../plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugin-metadata-snapshot.js")>()),
  loadPluginMetadataSnapshot: loadPluginMetadataSnapshotMock,
  resolvePluginMetadataSnapshot: loadPluginMetadataSnapshotMock,
}));

vi.mock("../plugin-metadata-collection.js", async () => {
  const { projectPluginMetadataSnapshot } = await import("../plugin-metadata-snapshot.js");
  return {
    getCurrentPluginMetadataOwner: () => undefined,
    getScopedPluginMetadata: () => undefined,
    withPluginMetadataCollectionScope: (_metadata: unknown, run: () => unknown) => run(),
    preparePluginMetadata: (params: unknown) => ({
      selectedSnapshot: loadPluginMetadataSnapshotMock(params),
    }),
    getPluginMetadataWorkspaceSnapshot: (
      metadata: { selectedSnapshot: PluginMetadataSnapshot },
      params: { pluginIds?: readonly string[] },
    ) => projectPluginMetadataSnapshot(metadata.selectedSnapshot, params.pluginIds),
  };
});

describe("resolvePluginRuntimeLoadContext", () => {
  beforeAll(async () => {
    ({ clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } =
      await import("../../config/runtime-snapshot.js"));
    ({ clearPluginMetadataLifecycleCaches } = await import("../plugin-metadata-lifecycle.js"));
    ({ resolvePluginRuntimeLoadContext } = await import("./load-context.resolve.js"));
    ({ buildPluginRuntimeLoadOptions } = await import("./load-context.js"));
  });

  beforeEach(() => {
    loadConfigMock.mockReset();
    applyPluginAutoEnableMock.mockReset();
    loadPluginMetadataSnapshotMock.mockReset().mockReturnValue(metadataSnapshot);
    resolveConfigWidePluginManifestRegistryMock.mockReset().mockReturnValue(manifestRegistry);
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

  afterEach(() => vi.unstubAllEnvs());

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
      preferBuiltPluginArtifacts: false,
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
      discovery: undefined,
    });
    expect(resolvePluginControlPlaneWorkspaceMock).toHaveBeenNthCalledWith(1, {
      config: rawConfig,
      env,
      workspaceDir: undefined,
    });
    expect(resolveConfigWidePluginManifestRegistryMock).toHaveBeenCalledWith({
      config: rawConfig,
      env,
      metadata: expect.anything(),
    });
  });

  it("keeps prepared metadata when auto-enable changes the activation policy", () => {
    const config = { plugins: {} };
    const activatedConfig = { plugins: { entries: { demo: { enabled: true } } } };
    const env = { HOME: "/tmp/openclaw-home" } as NodeJS.ProcessEnv;
    applyPluginAutoEnableMock.mockReturnValue({
      config: activatedConfig,
      changes: ["demo configured"],
      autoEnabledReasons: { demo: ["demo configured"] },
    });

    const context = resolvePluginRuntimeLoadContext({
      config,
      env,
      metadataSnapshot,
      workspaceDir: "/resolved-workspace",
    });

    expect(context.metadataSnapshot).toBe(metadataSnapshot);
    expect(context.config).toBe(activatedConfig);
    expect(context.activationSourceConfig).toBe(config);
    expect(context.manifestRegistry).toBe(metadataSnapshot.manifestRegistry);
    expect(loadPluginMetadataSnapshotMock).not.toHaveBeenCalled();
    expect(resolveConfigWidePluginManifestRegistryMock).not.toHaveBeenCalled();
  });

  it("keeps config-wide activation policy separate from the executable workspace inventory", () => {
    const selectedRegistry = makeRegistry([{ id: "selected", channels: [] }]);
    const wideRegistry = makeRegistry([
      { id: "selected", channels: [] },
      { id: "another-workspace", channels: [] },
    ]);
    const snapshot = {
      ...metadataSnapshot,
      manifestRegistry: selectedRegistry,
      plugins: selectedRegistry.plugins,
    };
    loadPluginMetadataSnapshotMock.mockReturnValueOnce(snapshot);
    resolveConfigWidePluginManifestRegistryMock.mockReturnValueOnce(wideRegistry);

    const context = resolvePluginRuntimeLoadContext({ config: {}, env: {} });

    expect(applyPluginAutoEnableMock).toHaveBeenCalledWith(
      expect.objectContaining({ manifestRegistry: wideRegistry }),
    );
    expect(context.manifestRegistry).toBe(selectedRegistry);
    expect(context.metadataSnapshot).toBe(snapshot);
    expect(context.metadataSnapshot?.plugins.map((plugin) => plugin.id)).toEqual(["selected"]);
  });

  it("keeps derived metadata operation-local", () => {
    const derivedSnapshot: PluginMetadataSnapshot = {
      ...metadataSnapshot,
      registrySource: "derived",
    };
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
      discovery: undefined,
    });
  });

  it("re-evaluates current environment selection without replacing the prepared inventory", async () => {
    const rawConfig = { plugins: {} };
    const env = process.env;
    applyPluginAutoEnableMock.mockImplementation(({ env: currentEnv }) => ({
      config: {
        plugins: {
          entries: { demo: { enabled: currentEnv?.OPENCLAW_TEST_RUNTIME_SELECTION === "enabled" } },
        },
      },
      changes: [],
      autoEnabledReasons: {},
    }));
    const options = { config: rawConfig, env, metadataSnapshot };
    vi.stubEnv("OPENCLAW_TEST_RUNTIME_SELECTION", "disabled");
    const first = resolvePluginRuntimeLoadContext(options);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    vi.stubEnv("OPENCLAW_TEST_RUNTIME_SELECTION", "enabled");
    const second = resolvePluginRuntimeLoadContext(options);

    expect(first.config.plugins?.entries?.demo?.enabled).toBe(false);
    expect(second.config.plugins?.entries?.demo?.enabled).toBe(true);
    expect(second.metadataSnapshot).toBe(first.metadataSnapshot);
    expect(loadPluginMetadataSnapshotMock).not.toHaveBeenCalled();
  });

  it("applies auto-enable against each operation's exact prepared metadata", () => {
    const config = { plugins: {} };
    const firstRegistry = { diagnostics: [], plugins: [] };
    const secondRegistry = { diagnostics: [], plugins: [] };
    const firstSnapshot = { ...metadataSnapshot, manifestRegistry: firstRegistry };
    const secondSnapshot = { ...metadataSnapshot, manifestRegistry: secondRegistry };
    const firstConfig = { plugins: { entries: { first: { enabled: true } } } };
    const secondConfig = { plugins: { entries: { second: { enabled: true } } } };
    applyPluginAutoEnableMock
      .mockReturnValueOnce({ config: firstConfig, changes: [], autoEnabledReasons: {} })
      .mockReturnValueOnce({ config: secondConfig, changes: [], autoEnabledReasons: {} });

    const first = withPluginCache(createPluginCache(), () =>
      resolvePluginRuntimeLoadContext({ config, metadataSnapshot: firstSnapshot }),
    );
    const second = withPluginCache(createPluginCache(), () =>
      resolvePluginRuntimeLoadContext({ config, metadataSnapshot: secondSnapshot }),
    );
    expect(first.config).toBe(firstConfig);
    expect(second.config).toBe(secondConfig);
    expect(second.manifestRegistry).toBe(secondRegistry);
    expect(applyPluginAutoEnableMock).toHaveBeenNthCalledWith(2, {
      config,
      env: process.env,
      manifestRegistry: secondRegistry,
      discovery: undefined,
    });
  });

  it("threads install records from the metadata snapshot into the context and load options", () => {
    const snapshotWithRecords: PluginMetadataSnapshot = {
      ...metadataSnapshot,
      index: {
        ...metadataSnapshot.index,
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
    const context = resolvePluginRuntimeLoadContext({ config, env, onlyPluginIds: pluginIds });

    expect(context.metadataSnapshot?.pluginIds).toEqual(pluginIds);
    expect(context.metadataSnapshot?.index).toBe(metadataSnapshot.index);
    expect(loadPluginMetadataSnapshotMock).toHaveBeenCalledExactlyOnceWith({
      config,
      env,
      workspaceDir: "/resolved-workspace",
    });
  });

  it("builds plugin load options from the shared runtime context", () => {
    const context = resolvePluginRuntimeLoadContext({
      config: { plugins: {} },
      env: { HOME: "/tmp/openclaw-home" } as NodeJS.ProcessEnv,
      preferBuiltPluginArtifacts: true,
      workspaceDir: "/explicit-workspace",
    });

    expect(loadPluginMetadataSnapshotMock).toHaveBeenCalledExactlyOnceWith({
      config: context.rawConfig,
      env: context.env,
      workspaceDir: "/explicit-workspace",
    });
    expect(resolveConfigWidePluginManifestRegistryMock).not.toHaveBeenCalled();
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
      preferBuiltPluginArtifacts: true,
      cache: false,
      activate: false,
      onlyPluginIds: ["demo"],
    });
  });
});
