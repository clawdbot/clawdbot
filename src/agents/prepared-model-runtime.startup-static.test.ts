import { beforeEach, describe, expect, it, vi } from "vitest";
import { getInstalledPluginIndexInstallRecordsCacheGeneration } from "../plugins/installed-plugin-index-record-cache.js";
import { resolvePluginMetadataEnvFingerprint } from "../plugins/plugin-metadata-env.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";
import type { ModelRegistry } from "./sessions/model-registry.js";

type CreateStaticCatalogResolver =
  typeof import("./embedded-agent-runner/model.static-catalog.js").createBundledStaticCatalogModelResolver;
type StaticCatalogResolver = ReturnType<CreateStaticCatalogResolver>;

const mocks = vi.hoisted(() => {
  const metadataSnapshot = {
    discovery: { candidates: [], diagnostics: [] },
    plugins: [],
    pluginIds: [],
    index: { plugins: [{ pluginId: "openai", enabled: true }] },
    manifestRegistry: { plugins: [], diagnostics: [] },
    owners: {
      channels: new Map(),
      channelConfigs: new Map(),
      providers: new Map([["openai", ["openai"]]]),
      modelCatalogProviders: new Map(),
      cliBackends: new Map(),
      setupProviders: new Map(),
      commandAliases: new Map(),
      contracts: new Map(),
    },
  };
  const authStorage = {
    getAll: vi.fn(() => ({ openai: { type: "api_key" as const, key: "test-openai-key" } })),
    getOAuthProviders: vi.fn(() => []),
  };
  const modelRegistry = {
    fork: vi.fn((nextAuthStorage: unknown) => ({ authStorage: nextAuthStorage })),
    getAll: vi.fn(() => []),
    find: vi.fn<ModelRegistry["find"]>(() => undefined),
  };
  const resolveSyntheticAuth = vi.fn<
    () => { apiKey: string; source: string; mode: "api-key" } | undefined
  >(() => ({
    apiKey: "synthetic-openai-key",
    source: "test",
    mode: "api-key",
  }));
  return {
    authStorage,
    modelRegistry,
    metadataSnapshot,
    resolvePluginMetadataSnapshot: vi.fn(() => metadataSnapshot),
    resolveAmbientCredentials: vi.fn((..._args: unknown[]) => ({})),
    discoverAuthStorage: vi.fn((_agentDir?: string, _options?: unknown) => authStorage),
    discoverModels: vi.fn(() => modelRegistry),
    ensureOpenClawModelsJson: vi.fn(
      async (_config: unknown, _agentDir: unknown, _options?: unknown) => ({
        agentDir: "/tmp/agent",
        wrote: false,
      }),
    ),
    planOpenClawModelsJsonSource: vi.fn(
      async (_config: unknown, agentDir: unknown, _options?: unknown) => ({
        agentDir: String(agentDir),
        modelsJsonContents: null,
        pluginCatalogs: [],
      }),
    ),
    buildPreparedModelCatalogSnapshot: vi.fn(async () => ({ entries: [], routeVariants: [] })),
    runPreparedModelCatalogWorker: vi.fn<() => Promise<ModelCatalogSnapshot>>(async () => ({
      entries: [],
      routeVariants: [],
    })),
    resolveProviderPolicySurface: vi.fn<
      typeof import("../plugins/provider-public-artifacts.js").resolveProviderPolicySurface
    >(() => null),
    loadAgentRuntimePluginRegistryHandle: vi.fn(),
    loadStaticCatalog: vi.fn(async () => []),
    prepareStaticCatalog: vi.fn(async (..._args: unknown[]) => ({
      providers: [
        {
          id: "openai",
          label: "OpenAI",
          auth: [],
          resolveSyntheticAuth,
        },
      ],
      entries: [
        {
          provider: { id: "openai", label: "OpenAI", auth: [] },
          result: {
            provider: {
              baseUrl: "https://api.openai.com/v1",
              api: "openai-responses",
              models: [
                {
                  id: "gpt-5.5",
                  name: "GPT-5.5",
                  reasoning: true,
                  thinkingLevelMap: { off: null, max: "max" },
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 128_000,
                  maxTokens: 8_192,
                },
              ],
            },
          },
        },
      ],
    })),
    resolveStaticCatalogModel: vi.fn<StaticCatalogResolver>(() => undefined),
    resolveSyntheticAuth,
    mutationListener: undefined as
      | ((event: { agentDir?: string; affectsInheritedStores: boolean }) => void)
      | undefined,
  };
});

vi.mock("../plugins/plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/plugin-metadata-snapshot.js")>()),
  isPluginMetadataSnapshotCompatible: () => true,
  loadPluginMetadataSnapshot: () => mocks.metadataSnapshot,
  resolvePluginMetadataSnapshot: mocks.resolvePluginMetadataSnapshot,
}));

vi.mock("../plugins/plugin-metadata-collection.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/plugin-metadata-collection.js")>()),
  preparePluginMetadata: ({
    workspaceDir,
    env,
  }: {
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
  }) => ({
    workspaces: new Map([[workspaceDir, mocks.metadataSnapshot]]),
    configWorkspaceDirs: [workspaceDir],
    agentWorkspaceDirs: new Map(workspaceDir ? [["default", workspaceDir]] : []),
    installRecordsGeneration: getInstalledPluginIndexInstallRecordsCacheGeneration(),
    envFingerprint: resolvePluginMetadataEnvFingerprint(env),
    selectedSnapshot: mocks.metadataSnapshot,
    manifestRegistry: mocks.metadataSnapshot.manifestRegistry,
    plugins: mocks.metadataSnapshot.plugins,
    owners: mocks.metadataSnapshot.owners,
  }),
  getPluginMetadataWorkspaceSnapshot: () => mocks.metadataSnapshot,
}));

vi.mock("./agent-auth-discovery.js", () => ({
  resolveAmbientAgentCredentialsForDiscovery: mocks.resolveAmbientCredentials,
}));

vi.mock("../plugins/provider-public-artifacts.js", () => ({
  resolveProviderPolicySurface: mocks.resolveProviderPolicySurface,
  resolveBundledProviderPolicySurface: mocks.resolveProviderPolicySurface,
}));

vi.mock("./prepared-model-catalog-worker.js", () => ({
  createPreparedModelCatalogWorkerInput: ({ agentFacts }: { agentFacts: unknown }) => ({
    generationFingerprint: "test-generation",
    input: (agentFacts as { input: unknown }).input,
  }),
  createPreparedModelCatalogWorker: () => ({
    loadCatalog: mocks.runPreparedModelCatalogWorker,
    loadAuth: async () => ({ authStore: { version: 1, profiles: {} }, authModes: {} }),
  }),
}));

vi.mock("./agent-model-discovery.js", () => ({
  discoverAuthStorageFacts: (agentDir: string, options?: unknown) => {
    const authStorage = mocks.discoverAuthStorage(agentDir, options);
    const credentials = authStorage.getAll();
    return {
      authStorage,
      store: {
        version: 1,
        profiles: Object.fromEntries(
          Object.entries(credentials).map(([provider, credential]) => [
            `${provider}:default`,
            { ...(credential as object), provider },
          ]),
        ),
      },
      credentials,
    };
  },
  discoverAuthStorage: mocks.discoverAuthStorage,
  discoverModels: mocks.discoverModels,
  discoverModelsFromCapturedSources: mocks.discoverModels,
}));

vi.mock("../plugins/synthetic-auth.runtime.js", () => ({
  resolveRuntimeSyntheticAuthProviderRefs: () => [],
}));

vi.mock("./legacy-inherited-auth-dir.js", () => ({
  resolveLegacyInheritedAuthDir: () => "/tmp/prepared-static-agent",
}));

vi.mock("./agent-scope-config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agent-scope-config.js")>()),
  listAgentIds: () => ["default"],
  resolveAgentDir: () => "/tmp/prepared-static-agent",
  resolveAgentWorkspaceDir: () => "/tmp/prepared-static-workspace",
}));

vi.mock("./auth-profiles/runtime-snapshots.js", () => ({
  getPreparedRuntimeAuthProfileStoreSnapshotCore: () => undefined,
  registerRuntimeAuthProfileStoreMutationListener: (
    listener: (event: { agentDir?: string; affectsInheritedStores: boolean }) => void,
  ) => {
    mocks.mutationListener = listener;
    return () => {};
  },
}));

vi.mock("./model-catalog.js", () => ({
  buildPreparedModelCatalogSnapshot: mocks.buildPreparedModelCatalogSnapshot,
}));

vi.mock("./models-config.js", () => ({
  ensureOpenClawModelsJson: mocks.ensureOpenClawModelsJson,
  planOpenClawModelsJsonSource: mocks.planOpenClawModelsJsonSource,
}));

vi.mock("./models-config.providers.implicit.js", () => ({
  prepareImplicitProviderStaticCatalog: mocks.prepareStaticCatalog,
}));

vi.mock("./runtime-plugins.js", () => ({
  loadAgentRuntimePluginRegistryHandle: mocks.loadAgentRuntimePluginRegistryHandle,
}));

vi.mock("./embedded-agent-runner/model.static-catalog.js", () => ({
  loadBundledProviderStaticCatalogContextModels: mocks.loadStaticCatalog,
  createBundledStaticCatalogModelResolver: () => mocks.resolveStaticCatalogModel,
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ warn: vi.fn() }),
}));

const {
  getPreparedModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
  registerPreparedModelRuntimePublicationListener,
} = await import("./prepared-model-runtime.js");
const { getAvailablePreparedModelCatalogSnapshot } = await import("./prepared-model-catalog.js");
const {
  prepareScopedReadOnlyLiveModelCatalog,
  prepareScopedReadOnlyModelAuthModes,
  prepareScopedReadOnlyModelCatalog,
} = await import("./prepared-model-runtime.scoped-catalog.js");
const { resetPreparedModelRuntimeSnapshotsForTest } =
  await import("./prepared-model-runtime.test-support.js");
const { resolveThinkingProfile } = await import("../auto-reply/thinking.js");

beforeEach(() => {
  resetPreparedModelRuntimeSnapshotsForTest();
  mocks.loadAgentRuntimePluginRegistryHandle
    .mockReset()
    .mockReturnValue(createEmptyPluginRegistry());
  vi.clearAllMocks();
  mocks.modelRegistry.find.mockReset();
  mocks.resolveStaticCatalogModel.mockReturnValue(undefined);
  mocks.resolveProviderPolicySurface.mockReset().mockReturnValue(null);
});

describe("prepareScopedReadOnlyModelAuthModes", () => {
  function usePreparedSyntheticAuth() {
    mocks.resolveAmbientCredentials.mockImplementationOnce((...args: unknown[]) => {
      const params = args[0] as {
        syntheticAuthProviderRefs: string[];
        resolveSyntheticAuth: (provider: string) => { apiKey?: string } | undefined;
      };
      return Object.fromEntries(
        params.syntheticAuthProviderRefs.flatMap((provider) => {
          const key = params.resolveSyntheticAuth(provider)?.apiKey;
          return key ? [[provider, { type: "api_key", key }]] : [];
        }),
      );
    });
  }

  it("returns a verified provider-owned auth mode", async () => {
    usePreparedSyntheticAuth();

    await expect(
      prepareScopedReadOnlyModelAuthModes(
        { config: {}, env: {}, workspaceDir: "/tmp/workspace" },
        ["openai"],
        mocks.metadataSnapshot as never,
      ),
    ).resolves.toEqual({ openai: "api_key" });
  });

  it("keeps a missing native login unknown", async () => {
    mocks.resolveSyntheticAuth.mockReturnValueOnce(undefined);
    usePreparedSyntheticAuth();

    await expect(
      prepareScopedReadOnlyModelAuthModes(
        { config: {}, env: {}, workspaceDir: "/tmp/workspace" },
        ["openai"],
        mocks.metadataSnapshot as never,
      ),
    ).resolves.toEqual({});
  });

  it("does not resolve auth for a disabled provider", async () => {
    mocks.prepareStaticCatalog.mockResolvedValueOnce({ providers: [], entries: [] });
    usePreparedSyntheticAuth();

    await expect(
      prepareScopedReadOnlyModelAuthModes(
        { config: {}, env: {}, workspaceDir: "/tmp/workspace" },
        ["openai"],
        mocks.metadataSnapshot as never,
      ),
    ).resolves.toEqual({});
    expect(mocks.resolveSyntheticAuth).not.toHaveBeenCalled();
  });
});

describe("prepared model runtime Gateway catalog mode", () => {
  it.each([
    {
      name: "native orchestration",
      profile: {
        levels: [{ id: "off" }, { id: "max" }, { id: "ultra" }],
        defaultLevel: "ultra",
      },
    },
    {
      name: "binary thinking",
      profile: {
        levels: [{ id: "off" }, { id: "low", label: "on" }],
        defaultLevel: "low",
      },
    },
  ] as const)(
    "publishes $name policy for lightweight configured and full catalog reads",
    async ({ profile }) => {
      const config = { agents: { defaults: { model: { primary: "openai/gpt-5.5" } } } };
      const policy = { resolveThinkingProfile: () => profile };
      mocks.resolveProviderPolicySurface.mockReturnValue(policy);
      await refreshPreparedModelRuntimeSnapshots(config, {
        gatewayLifecycle: true,
        catalogMode: "static",
      });
      const snapshot = getPreparedModelRuntimeSnapshot({
        agentId: "default",
        config,
        agentDir: "/tmp/prepared-static-agent",
        inheritedAuthDir: "/tmp/prepared-static-agent",
        workspaceDir: "/tmp/prepared-static-workspace",
      });
      expect(snapshot).toBeDefined();
      expect(snapshot!.pluginRegistry?.providers).toEqual([]);
      const configuredCatalog = snapshot!.modelCatalog;
      expect(configuredCatalog.entries).toHaveLength(1);
      const project = (
        catalog: ModelCatalogSnapshot,
        providerPolicySource: Parameters<
          typeof resolveThinkingProfile
        >[0]["providerPolicySource"] = "active",
      ) => {
        const resolved = resolveThinkingProfile({
          provider: "openai",
          model: "gpt-5.5",
          catalog: catalog.entries,
          agentRuntime: "codex",
          providerPolicySource,
        });
        return {
          levels: resolved.levels.map(({ id, label }) => ({ id, label })),
          defaultLevel: resolved.defaultLevel,
        };
      };
      const expected = {
        levels: profile.levels.map((level) => ({
          id: level.id,
          label: "label" in level ? level.label : level.id,
        })),
        defaultLevel: profile.defaultLevel,
      };
      mocks.resolveProviderPolicySurface.mockImplementation(() => {
        throw new Error("lightweight projection must not load provider artifacts");
      });
      expect(project(configuredCatalog)).toEqual(expected);
      expect(project(configuredCatalog, snapshot!.pluginRegistry)).toEqual(expected);

      // Full catalogs cross a worker boundary; prepare their new rows before publication too.
      mocks.resolveProviderPolicySurface.mockReturnValue(policy);
      const workerCatalog = structuredClone(configuredCatalog);
      expect(JSON.stringify(configuredCatalog)).toBe(JSON.stringify(workerCatalog));
      for (const entry of workerCatalog.entries) {
        expect(Object.getOwnPropertySymbols(entry)).toEqual([]);
      }
      mocks.runPreparedModelCatalogWorker.mockResolvedValueOnce(workerCatalog);
      const fullCatalog = await snapshot!.loadFullModelCatalog!();
      mocks.resolveProviderPolicySurface.mockImplementation(() => {
        throw new Error("lightweight projection must not load provider artifacts");
      });
      expect(project(fullCatalog)).toEqual(expected);
      expect(project(fullCatalog, snapshot!.pluginRegistry)).toEqual(expected);
      expect(project(configuredCatalog)).toEqual(expected);
      expect(project(configuredCatalog, snapshot!.pluginRegistry)).toEqual(expected);
    },
  );

  it("imports and materializes only configured and auth-candidate providers", async () => {
    const config = {
      models: {
        providers: {
          alpha: {
            api: "openai-completions" as const,
            baseUrl: "https://alpha.invalid",
            models: [],
          },
          beta: { api: "openai-completions" as const, baseUrl: "https://beta.invalid", models: [] },
        },
      },
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.5" },
          modelPolicy: { allow: ["vllm/*"] },
        },
      },
    };

    await prepareScopedReadOnlyModelCatalog(
      {
        agentId: "default",
        agentDir: "/tmp/prepared-static-agent",
        config,
        inheritedAuthDir: "/tmp/prepared-static-agent",
        workspaceDir: "/tmp/prepared-static-workspace",
        env: {},
        readOnly: true,
      },
      ["anthropic", "local-runtime"],
    );

    expect(mocks.prepareStaticCatalog).toHaveBeenCalledWith(
      expect.objectContaining({
        providerDiscoveryProviderIds: ["anthropic", "local-runtime", "openai", "vllm"],
        staticCatalogProviderIds: ["anthropic", "local-runtime", "openai"],
      }),
    );
    expect(mocks.planOpenClawModelsJsonSource).toHaveBeenCalledWith(
      config,
      "/tmp/prepared-static-agent",
      expect.objectContaining({
        providerDiscoveryEntriesOnly: true,
        providerDiscoveryProviderIds: ["anthropic", "local-runtime", "openai", "vllm"],
      }),
    );
    expect(mocks.ensureOpenClawModelsJson).not.toHaveBeenCalled();
  });

  it("uses live provider catalogs for an explicit read-only list scope", async () => {
    const config = {
      agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
    };

    await prepareScopedReadOnlyLiveModelCatalog(
      {
        agentId: "default",
        agentDir: "/tmp/prepared-live-agent",
        config,
        inheritedAuthDir: "/tmp/prepared-live-agent",
        workspaceDir: "/tmp/prepared-live-workspace",
        env: {},
        readOnly: true,
      },
      ["anthropic"],
    );

    expect(mocks.planOpenClawModelsJsonSource).toHaveBeenCalledWith(
      config,
      "/tmp/prepared-live-agent",
      expect.objectContaining({
        providerDiscoveryProviderIds: ["anthropic"],
        providerDiscoveryTimeoutMs: expect.any(Number),
      }),
    );
    expect(mocks.planOpenClawModelsJsonSource).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ providerDiscoveryEntriesOnly: true }),
    );
    expect(mocks.ensureOpenClawModelsJson).not.toHaveBeenCalled();
  });

  it("does not publish a static catalog generation superseded while its hook is running", async () => {
    const staleConfig = { agents: { defaults: { model: "openai/gpt-5.5" } } };
    const latestConfig = { agents: { defaults: { model: "openai/gpt-5.6" } } };
    const defaultPrepareStaticCatalog = mocks.prepareStaticCatalog.getMockImplementation();
    let releaseStaleHook: (() => void) | undefined;
    let staleHookStarted!: () => void;
    const staleHookPending = new Promise<void>((resolve) => {
      staleHookStarted = resolve;
    });
    mocks.prepareStaticCatalog.mockImplementationOnce(async (...args: unknown[]) => {
      staleHookStarted();
      await new Promise<void>((resolve) => {
        releaseStaleHook = resolve;
      });
      if (!defaultPrepareStaticCatalog) {
        throw new Error("expected default static catalog implementation");
      }
      return await defaultPrepareStaticCatalog(...args);
    });

    const stale = refreshPreparedModelRuntimeSnapshots(staleConfig, {
      gatewayLifecycle: true,
      catalogMode: "static",
    });
    // Surface refresh failures before hook entry instead of waiting for the test timeout.
    await Promise.race([
      staleHookPending,
      stale.then(() => {
        throw new Error("static catalog refresh completed before its hook");
      }),
    ]);
    const latest = refreshPreparedModelRuntimeSnapshots(latestConfig, {
      gatewayLifecycle: true,
      catalogMode: "static",
    });
    releaseStaleHook?.();

    await expect(stale).rejects.toThrow("superseded");
    await latest;
    expect(
      getPreparedModelRuntimeSnapshot({
        agentId: "default",
        config: latestConfig,
        agentDir: "/tmp/prepared-static-agent",
        inheritedAuthDir: "/tmp/prepared-static-agent",
        workspaceDir: "/tmp/prepared-static-workspace",
      })?.config,
    ).toBe(latestConfig);
    expect(mocks.prepareStaticCatalog).toHaveBeenCalledTimes(2);
    expect(mocks.discoverModels).toHaveBeenCalledOnce();
  });

  it("publishes configured turn facts without eagerly building a full catalog", async () => {
    const config = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.5" },
          models: { "openai/gpt-5.5": { agentRuntime: { id: "openclaw" } } },
        },
      },
    };

    let configuredRuntimeModelCount = 0;
    let generatedCatalogReadCount = -1;
    await refreshPreparedModelRuntimeSnapshots(config, {
      gatewayLifecycle: true,
      catalogMode: "static",
      onBuildStats: (stats) => {
        configuredRuntimeModelCount = stats.configuredRuntimeModelCount;
        generatedCatalogReadCount = stats.generatedCatalogReadCount;
      },
    });

    expect(mocks.ensureOpenClawModelsJson).not.toHaveBeenCalled();
    expect(mocks.loadAgentRuntimePluginRegistryHandle).toHaveBeenCalledTimes(2);
    expect(mocks.loadAgentRuntimePluginRegistryHandle.mock.calls[0]?.[0]).not.toHaveProperty(
      "selections",
    );
    expect(mocks.loadAgentRuntimePluginRegistryHandle.mock.calls[1]?.[0]).toMatchObject({
      selections: [{ provider: "openai", modelId: "gpt-5.5", runtime: "openclaw" }],
    });
    expect(mocks.prepareStaticCatalog).toHaveBeenCalledWith(
      expect.objectContaining({
        providerDiscoveryProviderIds: ["openai"],
        staticCatalogProviderIds: ["openai"],
      }),
    );
    expect(mocks.resolveAmbientCredentials).toHaveBeenCalledWith(
      expect.objectContaining({
        syntheticAuthProviderRefs: ["openai"],
        resolveSyntheticAuth: expect.any(Function),
      }),
    );
    const ambientOptions = mocks.resolveAmbientCredentials.mock.calls[0]?.[0] as
      | { resolveSyntheticAuth?: (provider: string) => { apiKey?: string } | undefined }
      | undefined;
    expect(ambientOptions?.resolveSyntheticAuth?.("openai")).toMatchObject({
      apiKey: "synthetic-openai-key",
    });
    expect(mocks.resolveSyntheticAuth).toHaveBeenCalledWith({
      config,
      provider: "openai",
      providerConfig: undefined,
    });
    expect(mocks.discoverModels).toHaveBeenLastCalledWith(
      mocks.authStorage,
      expect.objectContaining({
        config,
        includePluginCatalogs: true,
        modelsJsonContents: null,
        pluginCatalogs: [],
        pluginMetadataSnapshot: mocks.metadataSnapshot,
        workspaceDir: "/tmp/prepared-static-workspace",
      }),
    );
    expect(mocks.buildPreparedModelCatalogSnapshot).not.toHaveBeenCalled();
    expect(mocks.loadStaticCatalog).not.toHaveBeenCalled();
    expect(configuredRuntimeModelCount).toBe(1);
    expect(generatedCatalogReadCount).toBe(0);
    const snapshot = getPreparedModelRuntimeSnapshot({
      agentId: "default",
      config,
      agentDir: "/tmp/prepared-static-agent",
      inheritedAuthDir: "/tmp/prepared-static-agent",
      workspaceDir: "/tmp/prepared-static-workspace",
    });
    expect(
      getAvailablePreparedModelCatalogSnapshot({
        agentId: "default",
        config,
        agentDir: "/tmp/prepared-static-agent",
        workspaceDir: "/tmp/prepared-static-workspace",
      }),
    ).toBe(snapshot?.modelCatalog);
    expect(snapshot?.configuredRuntimeModels).toHaveLength(1);
    expect(snapshot?.pluginRegistry).toBeDefined();
    expect(snapshot?.messageToolCatalog).toBeUndefined();
    expect(snapshot?.mediaCapabilityProviders).toBeDefined();
    const catalogPublicationEvents: string[] = [];
    const unregisterCatalogPublication = registerPreparedModelRuntimePublicationListener((event) =>
      catalogPublicationEvents.push(event.phase),
    );
    await snapshot?.loadFullModelCatalog?.();
    expect(catalogPublicationEvents).toEqual(["catalog-published"]);
    expect(mocks.ensureOpenClawModelsJson).not.toHaveBeenCalled();
    expect(mocks.runPreparedModelCatalogWorker).toHaveBeenCalledOnce();
    expect(mocks.loadAgentRuntimePluginRegistryHandle).toHaveBeenCalledTimes(2);

    await expect(snapshot?.loadFullModelCatalog?.()).resolves.toEqual({
      entries: [],
      routeVariants: [],
    });
    expect(mocks.ensureOpenClawModelsJson).not.toHaveBeenCalled();
    expect(mocks.runPreparedModelCatalogWorker).toHaveBeenCalledOnce();
    expect(snapshot?.readFullModelCatalog?.()).toEqual({ entries: [], routeVariants: [] });
    expect(
      getAvailablePreparedModelCatalogSnapshot({
        agentId: "default",
        config,
        agentDir: "/tmp/prepared-static-agent",
        workspaceDir: "/tmp/prepared-static-workspace",
      }),
    ).toEqual({ entries: [], routeVariants: [] });
    expect(mocks.runPreparedModelCatalogWorker).toHaveBeenCalledOnce();
    expect(catalogPublicationEvents).toEqual(["catalog-published"]);

    await snapshot?.loadFullModelCatalog?.({ refresh: true });
    expect(catalogPublicationEvents).toEqual(["catalog-published", "catalog-published"]);
    expect(mocks.runPreparedModelCatalogWorker).toHaveBeenCalledTimes(2);
    mocks.runPreparedModelCatalogWorker.mockRejectedValueOnce(new Error("refresh failed"));
    await expect(snapshot?.loadFullModelCatalog?.({ refresh: true })).rejects.toThrow(
      "refresh failed",
    );
    expect(catalogPublicationEvents).toEqual(["catalog-published", "catalog-published"]);
    unregisterCatalogPublication();
    expect(snapshot?.readFullModelCatalog?.()).toEqual({ entries: [], routeVariants: [] });
    expect(mocks.runPreparedModelCatalogWorker).toHaveBeenCalledTimes(3);
    expect(mocks.prepareStaticCatalog).toHaveBeenCalledOnce();
    expect(mocks.discoverModels).toHaveBeenCalledOnce();

    mocks.mutationListener?.({
      agentDir: "/tmp/prepared-static-agent",
      affectsInheritedStores: false,
    });
    await expect(snapshot?.loadFullModelCatalog?.()).rejects.toThrow("superseded");
    expect(mocks.runPreparedModelCatalogWorker).toHaveBeenCalledTimes(3);
  });

  it("publishes exact dynamic configured models without building a live catalog", async () => {
    const provider = "fixture-provider";
    const modelId = "fixture-model-2026-08-09";
    const registry = createEmptyPluginRegistry();
    const resolveDynamicModel = vi.fn(
      (context: { provider: string; modelId: string; modelRegistry: unknown }) => ({
        id: context.modelId,
        name: "Fixture dated model",
        provider: context.provider,
        api: "openai-responses" as const,
        baseUrl: "https://fixture.invalid/v1",
        reasoning: false,
        input: ["text" as const],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 64_000,
        maxTokens: 8_192,
      }),
    );
    registry.providers.push({
      pluginId: provider,
      provider: { id: provider, label: "Fixture provider", auth: [], resolveDynamicModel },
      source: "test",
    });
    mocks.loadAgentRuntimePluginRegistryHandle.mockReturnValue(registry);
    mocks.modelRegistry.find.mockImplementation((registryProvider, registryModelId) =>
      registryProvider === "registry-only" && registryModelId === "MIXED"
        ? {
            provider: registryProvider,
            id: registryModelId,
            name: "Exact-case registry model",
            api: "openai-responses",
            baseUrl: "https://registry.invalid/v1",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 32_000,
            maxTokens: 4096,
          }
        : undefined,
    );
    const providerConfig = {
      api: "openai-responses" as const,
      baseUrl: "https://configured.fixture.invalid/v1",
      models: [],
    };
    const config = {
      models: { providers: { [provider]: providerConfig } },
      agents: {
        defaults: {
          model: {
            primary: `${provider}/${modelId}`,
            fallbacks: [
              "openai/gpt-5.5",
              `${provider}/${modelId}`,
              "registry-only/mixed",
              "REGISTRY-ONLY/MIXED",
              "bare-alias",
              "provider-only/",
            ],
          },
        },
      },
    };

    await refreshPreparedModelRuntimeSnapshots(config, {
      gatewayLifecycle: true,
      catalogMode: "static",
    });

    expect(resolveDynamicModel).toHaveBeenCalledOnce();
    expect(mocks.discoverModels.mock.invocationCallOrder[0]).toBeLessThan(
      resolveDynamicModel.mock.invocationCallOrder[0]!,
    );
    expect(resolveDynamicModel).toHaveBeenCalledWith({
      config,
      agentDir: "/tmp/prepared-static-agent",
      workspaceDir: "/tmp/prepared-static-workspace",
      provider,
      modelId,
      modelRegistry: mocks.modelRegistry,
      providerConfig,
    });
    const snapshot = getPreparedModelRuntimeSnapshot({
      agentId: "default",
      config,
      agentDir: "/tmp/prepared-static-agent",
      inheritedAuthDir: "/tmp/prepared-static-agent",
      workspaceDir: "/tmp/prepared-static-workspace",
    });
    expect(
      snapshot?.configuredRuntimeModels.map(
        (configured) => `${configured.provider}/${configured.modelId}`,
      ),
    ).toEqual([`${provider}/${modelId}`, "openai/gpt-5.5"]);
    expect(snapshot?.configuredRuntimeModels[0]?.model).toMatchObject({
      provider,
      id: modelId,
      name: "Fixture dated model",
      api: "openai-responses",
      baseUrl: "https://fixture.invalid/v1",
    });
    for (const entries of [snapshot?.modelCatalog.entries, snapshot?.modelCatalog.routeVariants]) {
      expect(entries?.map((entry) => `${entry.provider}/${entry.id}`)).toEqual([
        `${provider}/${modelId}`,
        "openai/gpt-5.5",
        "registry-only/MIXED",
      ]);
    }
    expect(
      snapshot?.modelCatalog.staticEntries?.map((entry) => `${entry.provider}/${entry.id}`),
    ).toEqual([`${provider}/${modelId}`, "openai/gpt-5.5"]);
    expect(
      snapshot?.modelCatalog.staticEntries?.find((entry) => entry.provider === "openai")
        ?.thinkingLevelMap,
    ).toEqual({ off: null, max: "max" });
    expect(mocks.prepareStaticCatalog).toHaveBeenCalledWith(
      expect.objectContaining({
        providerDiscoveryProviderIds: [provider, "openai", "provider-only", "registry-only"],
        staticCatalogProviderIds: [provider, "openai", "registry-only"],
      }),
    );
    expect(mocks.discoverModels).toHaveBeenCalledOnce();
    expect(mocks.buildPreparedModelCatalogSnapshot).not.toHaveBeenCalled();
    expect(mocks.loadStaticCatalog).not.toHaveBeenCalled();
    expect(mocks.planOpenClawModelsJsonSource).not.toHaveBeenCalled();
    expect(mocks.ensureOpenClawModelsJson).not.toHaveBeenCalled();
  });

  it("does not request a static provider hook when manifest facts resolve the configured model", async () => {
    mocks.resolveStaticCatalogModel.mockReturnValue({
      id: "gpt-5.5",
      name: "GPT-5.5",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8_192,
    });
    const config = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.5" },
        },
      },
    };

    await refreshPreparedModelRuntimeSnapshots(config, {
      gatewayLifecycle: true,
      catalogMode: "static",
    });

    expect(mocks.prepareStaticCatalog).toHaveBeenCalledWith(
      expect.objectContaining({
        providerDiscoveryProviderIds: ["openai"],
        staticCatalogProviderIds: [],
      }),
    );
    const snapshot = getPreparedModelRuntimeSnapshot({
      agentId: "default",
      config,
      agentDir: "/tmp/prepared-static-agent",
      inheritedAuthDir: "/tmp/prepared-static-agent",
      workspaceDir: "/tmp/prepared-static-workspace",
    });
    expect(snapshot?.configuredRuntimeModels).toHaveLength(1);
  });
});
