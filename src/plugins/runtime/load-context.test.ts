// Load context tests cover agent and workspace context resolution for plugin runtimes.
import { inspect } from "node:util";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createPluginCache, withPluginCache } from "../plugin-cache.js";
import type { PluginMetadataSnapshot } from "../plugin-metadata-snapshot.types.js";
import { createEmptyPluginRegistry } from "../registry-empty.js";

const loadConfigMock = vi.fn<typeof import("../../config/config.js").loadConfig>();
const applyPluginAutoEnableMock =
  vi.fn<typeof import("../../config/plugin-auto-enable.js").applyPluginAutoEnable>();
const resolvePluginControlPlaneWorkspaceMock = vi.fn(
  (params: { config: OpenClawConfig; env?: NodeJS.ProcessEnv; workspaceDir?: string }) => ({
    workspaceDir: params.workspaceDir ?? "/resolved-workspace",
    workspaceScope: "selected" as const,
  }),
);
const manifestRegistry = { diagnostics: [], plugins: [] };
const index: PluginMetadataSnapshot["index"] = {
  version: 1,
  hostContractVersion: "test",
  compatRegistryVersion: "test",
  migrationVersion: 1,
  generatedAtMs: 1,
  installRecords: {},
  plugins: [],
  policyHash: "policy",
  diagnostics: [],
};
const metadataSnapshot: PluginMetadataSnapshot = {
  configFingerprint: "fingerprint",
  diagnostics: [],
  index,
  registryIndex: index,
  manifestRegistry,
  registryDiagnostics: [],
  plugins: [],
  byPluginId: new Map(),
  normalizePluginId: (id) => id,
  declaredProviderOwners: new Map(),
  owners: {
    channels: new Map(),
    channelConfigs: new Map(),
    providers: new Map(),
    modelCatalogProviders: new Map(),
    cliBackends: new Map(),
    setupProviders: new Map(),
    commandAliases: new Map(),
    contracts: new Map(),
    modelIdNormalizationPolicies: new Map(),
  },
  metrics: {
    registrySnapshotMs: 0,
    manifestRegistryMs: 0,
    ownerMapsMs: 0,
    totalMs: 0,
    indexPluginCount: 0,
    manifestPluginCount: 0,
  },
  policyHash: "policy",
  workspaceDir: "/resolved-workspace",
};
const resolvePluginMetadataSnapshotMock = vi.fn(() => metadataSnapshot);
const resolveConfigWidePluginMetadataSnapshotMock = vi.fn(() => metadataSnapshot);

let resolvePluginRuntimeLoadContext: typeof import("./load-context.resolve.js").resolvePluginRuntimeLoadContext;
let buildPluginRuntimeLoadOptions: typeof import("./load-context.js").buildPluginRuntimeLoadOptions;
let setPluginRuntimeLoadContext: typeof import("./load-context.js").setPluginRuntimeLoadContext;
let getPluginRuntimeLoadContext: typeof import("./load-context.js").getPluginRuntimeLoadContext;
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
  resolveConfigWidePluginMetadataSnapshot: resolveConfigWidePluginMetadataSnapshotMock,
}));

vi.mock("../plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugin-metadata-snapshot.js")>()),
  resolvePluginMetadataSnapshot: resolvePluginMetadataSnapshotMock,
}));

describe("resolvePluginRuntimeLoadContext", () => {
  beforeAll(async () => {
    ({ clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } =
      await import("../../config/runtime-snapshot.js"));
    ({ clearPluginMetadataLifecycleCaches } = await import("../plugin-metadata-lifecycle.js"));
    ({ resolvePluginRuntimeLoadContext } = await import("./load-context.resolve.js"));
    ({ buildPluginRuntimeLoadOptions, setPluginRuntimeLoadContext, getPluginRuntimeLoadContext } =
      await import("./load-context.js"));
  });

  beforeEach(() => {
    loadConfigMock.mockReset();
    applyPluginAutoEnableMock.mockReset();
    resolvePluginMetadataSnapshotMock.mockReset().mockReturnValue(metadataSnapshot);
    resolveConfigWidePluginMetadataSnapshotMock.mockReset().mockReturnValue(metadataSnapshot);
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
      preferBuiltPluginArtifacts: undefined,
    });
    expect(resolvePluginMetadataSnapshotMock).not.toHaveBeenCalled();
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
    expect(resolveConfigWidePluginMetadataSnapshotMock).toHaveBeenCalledExactlyOnceWith({
      config: rawConfig,
      env,
    });
  });

  it("keeps prepared metadata when auto-enable changes the activation policy", () => {
    const config = { plugins: {} };
    const activatedConfig = { plugins: { entries: { demo: { enabled: true } } } };
    const env = { HOME: "/tmp/openclaw-home" } as NodeJS.ProcessEnv;
    applyPluginAutoEnableMock.mockReturnValue({
      config: activatedConfig,
      changes: [],
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
    expect(resolvePluginMetadataSnapshotMock).not.toHaveBeenCalled();
    expect(resolveConfigWidePluginMetadataSnapshotMock).not.toHaveBeenCalled();
  });

  it("keeps derived metadata operation-local", () => {
    const derivedSnapshot = { ...metadataSnapshot } as typeof metadataSnapshot & {
      registrySource: "derived";
    };
    derivedSnapshot.registrySource = "derived";
    resolveConfigWidePluginMetadataSnapshotMock.mockReturnValueOnce(derivedSnapshot);

    const context = resolvePluginRuntimeLoadContext({
      config: { plugins: {} },
      env: { HOME: "/tmp/openclaw-home" } as NodeJS.ProcessEnv,
    });

    expect(context.metadataSnapshot).toBe(derivedSnapshot);
  });

  it("uses the source runtime snapshot for plugin activation source config", () => {
    const env = { HOME: "/tmp/openclaw-home" };
    const runtimeConfig = { plugins: {} };
    const sourceConfig = {
      plugins: {
        allow: ["trusted-plugin"],
      },
    };

    setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);
    loadConfigMock.mockReturnValue(runtimeConfig);

    const context = resolvePluginRuntimeLoadContext({ env });

    expect(context.rawConfig).toBe(runtimeConfig);
    expect(context.activationSourceConfig).toBe(sourceConfig);
    expect(applyPluginAutoEnableMock).toHaveBeenCalledWith({
      config: runtimeConfig,
      env,
      manifestRegistry,
    });
  });

  it("applies auto-enable against each operation's exact prepared metadata", () => {
    const env = { HOME: "/tmp/openclaw-home" };
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
      resolvePluginRuntimeLoadContext({ config, env, metadataSnapshot: firstSnapshot }),
    );
    const second = withPluginCache(createPluginCache(), () =>
      resolvePluginRuntimeLoadContext({ config, env, metadataSnapshot: secondSnapshot }),
    );
    expect(first.config).toBe(firstConfig);
    expect(second.config).toBe(secondConfig);
    expect(second.manifestRegistry).toBe(secondRegistry);
    expect(applyPluginAutoEnableMock).toHaveBeenNthCalledWith(2, {
      config,
      env,
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
    resolveConfigWidePluginMetadataSnapshotMock.mockReturnValueOnce(snapshotWithRecords);

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
  ])("projects $scope metadata from the prepared config-wide inventory", ({ pluginIds }) => {
    const config = { plugins: {} };
    const env = { HOME: "/tmp/openclaw-home" } as NodeJS.ProcessEnv;

    const context = resolvePluginRuntimeLoadContext({ config, env, onlyPluginIds: pluginIds });

    expect(context.metadataSnapshot?.pluginIds).toEqual(pluginIds);
    expect(context.metadataSnapshot?.index).toBe(metadataSnapshot.index);
    expect(resolveConfigWidePluginMetadataSnapshotMock).toHaveBeenCalledExactlyOnceWith({
      config,
      env,
    });
    expect(resolvePluginMetadataSnapshotMock).not.toHaveBeenCalled();
  });

  it("keeps private load facts out of diagnostics while preserving registry copies", () => {
    const configSentinel = "synthetic-private-config-sentinel";
    const envSentinel = "synthetic-private-env-sentinel";
    const config: OpenClawConfig = {
      plugins: { entries: { demo: { config: { sentinel: configSentinel } } } },
    };
    const env = { HOME: "/tmp/openclaw-home", PRIVATE_CONTEXT_TEST: envSentinel };
    const context = resolvePluginRuntimeLoadContext({ config, env });
    const registry = createEmptyPluginRegistry();
    setPluginRuntimeLoadContext(registry, context, "original-registration");
    const bound = getPluginRuntimeLoadContext(registry);
    expect(bound).toMatchObject(context);
    expect(bound?.config).toBe(config);
    expect(bound?.env).toBe(env);

    const copy = { ...registry };
    expect(getPluginRuntimeLoadContext(copy)).toBe(bound);
    const reboundContext = {
      ...context,
      workspaceDir: "/rebound-workspace",
      env: { ...env, PRIVATE_CONTEXT_TEST: `${envSentinel}-rebound` },
    };
    setPluginRuntimeLoadContext(copy, reboundContext, "replacement-registration");
    expect(getPluginRuntimeLoadContext(copy)).toMatchObject({
      ...reboundContext,
      registrationConfigKey: "original-registration",
    });
    expect(getPluginRuntimeLoadContext(copy)?.env).toBe(reboundContext.env);
    expect(getPluginRuntimeLoadContext(registry)).toBe(bound);

    for (const carrier of [registry, copy]) {
      for (const showHidden of [false, true]) {
        const diagnostic = inspect(carrier, { depth: null, showHidden });
        expect(diagnostic).not.toContain(configSentinel);
        expect(diagnostic).not.toContain(envSentinel);
      }
    }
  });

  it("builds plugin load options from the shared runtime context", () => {
    const context = resolvePluginRuntimeLoadContext({
      config: { plugins: {} },
      env: { HOME: "/tmp/openclaw-home" } as NodeJS.ProcessEnv,
      preferBuiltPluginArtifacts: true,
      workspaceDir: "/explicit-workspace",
    });

    expect(resolvePluginMetadataSnapshotMock).toHaveBeenCalledExactlyOnceWith({
      allowWorkspaceScopedCurrent: true,
      config: context.rawConfig,
      env: context.env,
      workspaceDir: "/explicit-workspace",
    });
    expect(resolveConfigWidePluginMetadataSnapshotMock).not.toHaveBeenCalled();
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
