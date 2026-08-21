// Model list forward-compat tests cover list command behavior with future catalog shapes.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";

const OPENAI_CODEX_MODEL = {
  provider: "openai",
  id: "gpt-5.4",
  name: "GPT-5.4",
  api: "openai-chatgpt-responses",
  baseUrl: "https://chatgpt.com/backend-api",
  input: ["text"],
  contextWindow: 1_050_000,
  maxTokens: 128000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

const OPENAI_CODEX_53_MODEL = {
  ...OPENAI_CODEX_MODEL,
  id: "gpt-5.4",
  name: "GPT-5.3 Codex",
};

const mocks = vi.hoisted(() => {
  const emptyPluginIndex = {
    version: 1,
    hostContractVersion: "test",
    compatRegistryVersion: "test",
    migrationVersion: 1,
    policyHash: "models-list-command-forward-compat-test",
    generatedAtMs: 0,
    installRecords: {},
    plugins: [],
    diagnostics: [],
  };
  const knownModelProviderOwners = new Map(
    [
      "anthropic",
      "azure-openai-responses",
      "codex",
      "google",
      "moonshot",
      "openai",
      "opencode-go",
      "xiaomi",
      "z.ai",
    ].map((providerId) => [providerId, ["test-provider-plugin"]]),
  );
  const emptyPluginMetadataSnapshot = {
    policyHash: "models-list-command-forward-compat-test",
    configFingerprint: "models-list-command-forward-compat-test",
    index: emptyPluginIndex,
    registryDiagnostics: [],
    manifestRegistry: { plugins: [], diagnostics: [] },
    plugins: [],
    diagnostics: [],
    byPluginId: new Map(),
    normalizePluginId: (pluginId: string) => pluginId,
    owners: {
      channels: new Map(),
      channelConfigs: new Map(),
      providers: knownModelProviderOwners,
      modelCatalogProviders: new Map(),
      cliBackends: new Map(),
      setupProviders: new Map(),
      commandAliases: new Map(),
      contracts: new Map(),
    },
    metrics: {
      registrySnapshotMs: 0,
      manifestRegistryMs: 0,
      ownerMapsMs: 0,
      totalMs: 0,
      indexPluginCount: 0,
      manifestPluginCount: 0,
    },
  };
  const sourceConfig = {
    agents: { defaults: { model: { primary: "openai/gpt-5.4" } } },
    models: {
      providers: {
        openai: {
          apiKey: "$OPENAI_API_KEY", // pragma: allowlist secret
        },
      },
    },
  };
  const resolvedConfig = {
    agents: { defaults: { model: { primary: "openai/gpt-5.4" } } },
    models: {
      providers: {
        openai: {
          apiKey: "sk-resolved-runtime-value", // pragma: allowlist secret
        },
      },
    },
  };
  return {
    emptyPluginMetadataSnapshot,
    sourceConfig,
    resolvedConfig,
    loadModelsConfigWithSource: vi.fn(),
    ensureOpenClawModelsJson: vi.fn(),
    ensureAuthProfileStore: vi.fn(),
    resolveDefaultAgentDir: vi.fn(),
    resolveModelsTargetAgent: vi.fn(),
    loadModelRegistry: vi.fn(),
    loadModelCatalog: vi.fn(),
    resolveConfiguredEntries: vi.fn(),
    printModelTable: vi.fn(),
    applyPromotionClaimTags: vi.fn(),
    startPromotionsFeedRefresh: vi.fn(),
    printAvailablePromotionsSection: vi.fn(),
    resolveModelWithRegistry: vi.fn(),
    readPersistedInstalledPluginIndexSync: vi.fn(),
    loadManifestMetadataSnapshot: vi.fn(),
    loadPluginRegistrySnapshotWithMetadata: vi.fn(),
  };
});

function resetMocks() {
  mocks.loadModelsConfigWithSource.mockResolvedValue({
    sourceConfig: mocks.sourceConfig,
    resolvedConfig: mocks.resolvedConfig,
    diagnostics: [],
  });
  mocks.ensureOpenClawModelsJson.mockResolvedValue({ wrote: false });
  mocks.ensureAuthProfileStore.mockReturnValue({ version: 1, profiles: {}, order: {} });
  mocks.resolveDefaultAgentDir.mockReturnValue("/tmp/openclaw-agent");
  mocks.resolveModelsTargetAgent.mockReturnValue({
    agentId: "main",
    agentDir: "/tmp/openclaw-agent",
  });
  mocks.loadModelRegistry.mockResolvedValue({
    models: [],
    availableKeys: new Set(),
    registry: {
      getAll: () => [],
    },
  });
  mocks.loadModelCatalog.mockResolvedValue([]);
  mocks.resolveConfiguredEntries.mockReturnValue({
    entries: [
      {
        key: "openai/gpt-5.4",
        ref: { provider: "openai", model: "gpt-5.4" },
        tags: new Set(["configured"]),
        aliases: [],
      },
    ],
  });
  mocks.printModelTable.mockReset();
  mocks.applyPromotionClaimTags.mockReset();
  mocks.startPromotionsFeedRefresh.mockReset();
  mocks.printAvailablePromotionsSection.mockReset();
  mocks.resolveModelWithRegistry.mockReturnValue({ ...OPENAI_CODEX_MODEL });
  mocks.readPersistedInstalledPluginIndexSync.mockReturnValue(null);
  mocks.loadManifestMetadataSnapshot.mockReturnValue(mocks.emptyPluginMetadataSnapshot);
  mocks.loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
    source: "persisted",
    snapshot: { plugins: [] },
    diagnostics: [],
  });
}

function createRuntime() {
  return { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
}

function primeModelRegistry(
  models: unknown[],
  availableKeys?: Set<string>,
  registryModels: unknown[] = models,
) {
  return mocks.loadModelRegistry.mockResolvedValueOnce({
    models,
    availableKeys,
    registry: { getAll: () => registryModels },
  });
}

function lastPrintedRows<T>() {
  const calls = mocks.printModelTable.mock.calls;
  return (calls[calls.length - 1]?.[0] ?? []) as T[];
}

function requireRow<T extends { key: string }>(rows: T[], key: string): T {
  const row = rows.find((entry) => entry.key === key);
  if (!row) {
    throw new Error(`expected model row ${key}`);
  }
  return row;
}

function expectRowKeys(rows: Array<{ key: string }>, keys: string[]) {
  expect(rows.map((row) => row.key)).toEqual(keys);
}

function expectFirstRegistryConfig() {
  const [cfg] = mocks.loadModelRegistry.mock.calls[0] ?? [];
  expect(cfg).toBe(mocks.resolvedConfig);
}

function expectRowFields(
  rows: Array<{ key: string } & Record<string, unknown>>,
  key: string,
  fields: Record<string, unknown>,
) {
  const row = requireRow(rows, key);
  for (const [field, value] of Object.entries(fields)) {
    expect(row[field]).toEqual(value);
  }
}

function modelRegistryOptions(index = 0): Record<string, unknown> {
  const options = mocks.loadModelRegistry.mock.calls[index]?.[1];
  if (!options || typeof options !== "object") {
    throw new Error(`expected model registry options ${index}`);
  }
  return options as Record<string, unknown>;
}

let modelsListCommand: typeof import("./list.list-command.js").modelsListCommand;
let listRowsModule: typeof import("./list.rows.js");
let listRegistryModule: typeof import("./list.registry.js");

function installModelsListCommandForwardCompatMocks() {
  const suppressOpenAiSpark = ({
    provider,
    id,
  }: {
    provider?: string | null;
    id?: string | null;
  }) =>
    (provider === "openai" || provider === "azure-openai-responses") &&
    id === "gpt-5.3-codex-spark";

  vi.doMock("../../agents/model-suppression.js", () => ({
    shouldSuppressBuiltInModelCore: suppressOpenAiSpark,
    shouldSuppressBuiltInModelFromManifest: suppressOpenAiSpark,
    createManifestBuiltInModelSuppressor: vi.fn(
      () => (model: { provider?: string | null; id?: string | null }) => suppressOpenAiSpark(model),
    ),
  }));

  vi.doMock("./load-config.js", () => ({
    loadModelsConfigWithSource: mocks.loadModelsConfigWithSource,
  }));

  vi.doMock("./list.configured.js", () => ({
    resolveConfiguredEntries: mocks.resolveConfiguredEntries,
  }));

  vi.doMock("./shared.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("./shared.js")>()),
    resolveModelsTargetAgent: mocks.resolveModelsTargetAgent,
  }));

  vi.doMock("./list.table.js", () => ({
    printModelTable: mocks.printModelTable,
  }));

  vi.doMock("./list.promotions.js", () => ({
    applyPromotionClaimTags: mocks.applyPromotionClaimTags,
    startPromotionsFeedRefresh: mocks.startPromotionsFeedRefresh,
    printAvailablePromotionsSection: mocks.printAvailablePromotionsSection,
  }));

  vi.doMock("./list.registry-load.js", () => ({
    loadListModelRegistry: async (
      cfg: unknown,
      opts?: { providerFilter?: string; normalizeModels?: boolean; loadAvailability?: boolean },
    ): Promise<{
      models: Array<{ provider: string; id: string }>;
      availableKeys?: Set<string>;
      registry?: unknown;
      discoveredKeys: Set<string>;
    }> => {
      const loaded = await mocks.loadModelRegistry(cfg, opts);
      return {
        ...loaded,
        discoveredKeys: new Set(
          loaded.models.map(
            (model: { provider: string; id: string }) => `${model.provider}/${model.id}`,
          ),
        ),
      };
    },
    loadConfiguredListModelRegistry: (
      _cfg: unknown,
      _entries: unknown,
      opts?: { providerFilter?: string; normalizeModels?: boolean },
    ) => {
      mocks.loadModelRegistry(mocks.resolvedConfig, opts);
      return {
        registry: {
          find: () => undefined,
          hasConfiguredAuth: () => false,
        },
        discoveredKeys: new Set(),
        availableKeys: new Set(),
      };
    },
  }));

  vi.doMock("../../agents/auth-profiles/store.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../agents/auth-profiles/store.js")>()),
    loadAuthProfileStoreWithoutExternalProfiles: mocks.ensureAuthProfileStore,
  }));

  vi.doMock("../../agents/agent-scope.js", () => ({
    listAgentEntries: vi.fn(() => []),
    resolveAgentWorkspaceDir: vi.fn(() => "/tmp/openclaw-workspace"),
    resolveDefaultAgentDir: mocks.resolveDefaultAgentDir,
    resolveDefaultAgentId: vi.fn(() => "main"),
    resolveSessionAgentIds: vi.fn(() => ({ defaultAgentId: "main", sessionAgentId: "main" })),
  }));

  vi.doMock("../../agents/prepared-model-catalog.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../agents/prepared-model-catalog.js")>()),
    loadPreparedModelCatalog: mocks.loadModelCatalog,
    loadPreparedModelCatalogSnapshot: async (...args: unknown[]) => {
      const entries = await mocks.loadModelCatalog(...args);
      return { entries, routeVariants: entries };
    },
  }));

  vi.doMock("./list.scoped-catalog.js", () => ({
    loadScopedListModelCatalogSnapshot: async (params: {
      providerIds: readonly string[];
      runtimeProviderIds?: readonly string[];
      manifestFallbackProviderIds?: readonly string[];
    }) => {
      const entries = await mocks.loadModelCatalog({
        providerDiscoveryProviderIds: params.providerIds,
        providerRuntimeDiscoveryProviderIds: params.runtimeProviderIds,
        providerManifestFallbackProviderIds: params.manifestFallbackProviderIds,
      });
      return { entries, routeVariants: entries };
    },
  }));

  vi.doMock("../../agents/embedded-agent-runner/model.js", () => ({
    resolveModelWithRegistry: mocks.resolveModelWithRegistry,
  }));

  vi.doMock("../../agents/model-auth.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../agents/model-auth.js")>()),
    hasUsableCustomProviderApiKey: vi.fn().mockReturnValue(false),
    hasSyntheticLocalProviderAuthConfig: vi.fn().mockReturnValue(false),
  }));

  vi.doMock("../../plugins/installed-plugin-index-store.js", () => ({
    readPersistedInstalledPluginIndexSync: mocks.readPersistedInstalledPluginIndexSync,
  }));

  vi.doMock("../../plugins/manifest-contract-eligibility.js", () => ({
    loadManifestMetadataSnapshot: mocks.loadManifestMetadataSnapshot,
  }));

  vi.doMock("../../plugins/plugin-registry.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../plugins/plugin-registry.js")>();
    return {
      ...actual,
      loadPluginRegistrySnapshotWithMetadata: mocks.loadPluginRegistrySnapshotWithMetadata,
    };
  });
}

beforeAll(async () => {
  installModelsListCommandForwardCompatMocks();
  listRowsModule = await import("./list.rows.js");
  listRegistryModule = await import("./list.registry.js");
  vi.spyOn(listRegistryModule, "loadModelRegistry").mockImplementation(mocks.loadModelRegistry);
  ({ modelsListCommand } = await import("./list.list-command.js"));
});

async function buildAllOpenAiCodexRows(opts: { supplementCatalog?: boolean } = {}) {
  const loaded = await mocks.loadModelRegistry();
  const rows: unknown[] = [];
  const context = {
    cfg: mocks.resolvedConfig,
    agentDir: "/tmp/openclaw-agent",
    authIndex: {
      evaluateModelAuth: (provider: string) => ({
        availability: provider === "openai",
        routeResolution: null,
      }),
    },
    availableKeys: loaded.availableKeys,
    configuredByKey: new Map(),
    discoveredKeys: new Set(
      loaded.models.map(
        (model: { provider: string; id: string }) => `${model.provider}/${model.id}`,
      ),
    ),
    filter: { provider: "openai" },
  };
  const seenKeys = await listRowsModule.appendDiscoveredRows({
    rows: rows as never,
    models: loaded.models as never,
    modelRegistry: loaded.registry as never,
    context: context as never,
  });
  if (opts.supplementCatalog !== false) {
    await listRowsModule.appendPreparedModelCatalogRows({
      rows: rows as never,
      context: context as never,
      seenKeys,
    });
  }
  return rows;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetMocks();
});

describe("modelsListCommand forward-compat", () => {
  it("uses the explicitly selected agent for auth and catalog discovery", async () => {
    mocks.resolveModelsTargetAgent.mockReturnValueOnce({
      agentId: "research",
      agentDir: "/tmp/openclaw-agent-research",
    });

    await modelsListCommand({ agent: "research", json: true }, createRuntime() as never);

    expect(mocks.resolveModelsTargetAgent).toHaveBeenCalledWith(mocks.resolvedConfig, "research", {
      kind: "read",
    });
    expect(mocks.ensureAuthProfileStore).toHaveBeenCalledWith("/tmp/openclaw-agent-research");
  });

  it("rejects unknown provider filters before loading the model registry", async () => {
    const runtime = createRuntime();
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    let observedExitCode: number | undefined;

    try {
      await modelsListCommand(
        { provider: "autoqa-no-such-provider", json: true },
        runtime as never,
      );
      observedExitCode = process.exitCode;
    } finally {
      process.exitCode = previousExitCode;
    }

    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining('Unknown provider filter "autoqa-no-such-provider"'),
    );
    expect(observedExitCode).toBe(1);
    expect(mocks.loadModelRegistry).not.toHaveBeenCalled();
    expect(mocks.loadModelCatalog).not.toHaveBeenCalled();
    expect(mocks.printModelTable).not.toHaveBeenCalled();
  });

  describe("empty model lists", () => {
    it.each([
      { name: "JSON", options: { json: true } },
      { name: "plain text", options: { plain: true } },
    ])("renders empty $name output through the canonical model table", async ({ options }) => {
      mocks.resolveConfiguredEntries.mockReturnValueOnce({ entries: [] });
      const runtime = createRuntime();
      const opts = { ...options, provider: "openai" };

      await modelsListCommand(opts, runtime as never);

      expect(mocks.printModelTable).toHaveBeenCalledWith([], runtime, opts);
      expect(mocks.startPromotionsFeedRefresh).not.toHaveBeenCalled();
      expect(runtime.log).not.toHaveBeenCalledWith("No models found.");
    });

    it("preserves the human-readable message for an empty model list", async () => {
      mocks.resolveConfiguredEntries.mockReturnValueOnce({ entries: [] });
      const refreshToken = { nowMs: 1, statePromise: Promise.resolve() };
      mocks.startPromotionsFeedRefresh.mockReturnValueOnce(refreshToken);
      const runtime = createRuntime();

      await modelsListCommand({ provider: "openai" }, runtime as never);

      expect(runtime.log).toHaveBeenCalledWith("No models found.");
      expect(mocks.printModelTable).not.toHaveBeenCalled();
      expect(mocks.startPromotionsFeedRefresh).toHaveBeenCalledOnce();
      expect(mocks.printAvailablePromotionsSection).toHaveBeenCalledWith(
        expect.objectContaining({ refresh: refreshToken }),
      );
    });
  });

  describe("promotion refresh scheduling", () => {
    it("does not start refresh when config resolution fails", async () => {
      mocks.loadModelsConfigWithSource.mockRejectedValueOnce(new Error("config failed"));

      await expect(modelsListCommand({}, createRuntime() as never)).rejects.toThrow(
        "config failed",
      );

      expect(mocks.startPromotionsFeedRefresh).not.toHaveBeenCalled();
    });

    it("does not start refresh when registry loading fails", async () => {
      mocks.loadModelRegistry.mockRejectedValueOnce(new Error("registry failed"));
      const runtime = createRuntime();

      await modelsListCommand({ all: true }, runtime as never);

      expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("registry failed"));
      expect(mocks.startPromotionsFeedRefresh).not.toHaveBeenCalled();
      expect(mocks.printAvailablePromotionsSection).not.toHaveBeenCalled();
    });

    it.each([{ json: true }, { plain: true }])(
      "does not start refresh for machine output",
      async (options) => {
        await modelsListCommand(options, createRuntime() as never);

        expect(mocks.startPromotionsFeedRefresh).not.toHaveBeenCalled();
        expect(mocks.printAvailablePromotionsSection).not.toHaveBeenCalled();
      },
    );

    it("starts refresh before row construction finishes and appends output after the table", async () => {
      const refresh = createDeferred();
      const rowConstructionStarted = createDeferred();
      const releaseRowConstruction = createDeferred();
      const tablePrinted = createDeferred();
      const refreshToken = {
        nowMs: 1,
        statePromise: refresh.promise,
      };
      mocks.loadModelCatalog.mockImplementationOnce(async () => {
        rowConstructionStarted.resolve();
        await releaseRowConstruction.promise;
        return [];
      });
      mocks.startPromotionsFeedRefresh.mockReturnValueOnce(refreshToken);
      mocks.printModelTable.mockImplementationOnce((_rows, runtime) => {
        runtime.log("model table");
        tablePrinted.resolve();
      });
      mocks.printAvailablePromotionsSection.mockImplementationOnce(
        async ({ refresh: pendingRefresh, runtime }) => {
          await pendingRefresh.statePromise;
          runtime.log("promotion section");
        },
      );
      const runtime = createRuntime();

      const commandPromise = modelsListCommand({}, runtime as never);
      await rowConstructionStarted.promise;

      expect(mocks.startPromotionsFeedRefresh).toHaveBeenCalledOnce();
      expect(mocks.printModelTable).not.toHaveBeenCalled();

      releaseRowConstruction.resolve();
      await tablePrinted.promise;

      expectRowKeys(lastPrintedRows<{ key: string }>(), ["openai/gpt-5.4"]);
      expect(runtime.log.mock.calls).toEqual([["model table"]]);

      refresh.resolve();
      await commandPromise;

      expect(runtime.log.mock.calls).toEqual([["model table"], ["promotion section"]]);
      expect(mocks.printAvailablePromotionsSection).toHaveBeenCalledWith(
        expect.objectContaining({ refresh: refreshToken }),
      );
    });

    it("keeps a rejected refresh fail-silent", async () => {
      const refresh = createDeferred();
      const sectionStarted = createDeferred();
      mocks.startPromotionsFeedRefresh.mockReturnValueOnce({
        nowMs: 1,
        statePromise: refresh.promise,
      });
      mocks.printAvailablePromotionsSection.mockImplementationOnce(
        async ({ refresh: pendingRefresh }) => {
          sectionStarted.resolve();
          await pendingRefresh.statePromise;
        },
      );

      const commandPromise = modelsListCommand({}, createRuntime() as never);
      await sectionStarted.promise;
      refresh.reject(new Error("refresh failed"));

      await expect(commandPromise).resolves.toBeUndefined();
    });
  });

  describe("configured rows", () => {
    it("projects prepared catalog rows for provider filters without --all", async () => {
      mocks.resolveConfiguredEntries.mockReturnValueOnce({ entries: [] });
      mocks.loadModelCatalog.mockResolvedValueOnce([
        {
          provider: "moonshot",
          id: "kimi-k2.6",
          ref: "moonshot/kimi-k2.6",
          mergeKey: "moonshot::kimi-k2.6",
          name: "Kimi K2.6",
          source: "manifest",
          input: ["text", "image"],
          reasoning: false,
          status: "available",
          baseUrl: "https://api.moonshot.ai/v1",
          contextWindow: 262_144,
        },
      ]);
      const runtime = createRuntime();

      await modelsListCommand({ json: true, provider: "moonshot" }, runtime as never);

      expect(mocks.loadModelRegistry).toHaveBeenCalledOnce();
      expect(mocks.loadModelCatalog).toHaveBeenCalledOnce();
      expect(runtime.log).not.toHaveBeenCalledWith("No models found.");
      expectRowKeys(lastPrintedRows<{ key: string }>(), ["moonshot/kimi-k2.6"]);
    });

    it("canonicalizes a manifest provider alias before reading the prepared catalog", async () => {
      mocks.resolveConfiguredEntries.mockReturnValueOnce({ entries: [] });
      mocks.loadManifestMetadataSnapshot.mockReturnValueOnce({
        ...mocks.emptyPluginMetadataSnapshot,
        manifestRegistry: {
          diagnostics: [],
          plugins: [
            {
              id: "moonshot",
              origin: "bundled",
              rootDir: "/tmp/openclaw-moonshot",
              modelCatalog: {
                aliases: {
                  kimi: { provider: "moonshot" },
                },
              },
            },
          ],
        },
      });
      mocks.loadModelCatalog.mockResolvedValueOnce([
        {
          provider: "moonshot",
          id: "kimi-k2.6",
          name: "Kimi K2.6",
          input: ["text", "image"],
          baseUrl: "https://api.moonshot.ai/v1",
          contextWindow: 262_144,
        },
      ]);
      const runtime = createRuntime();

      await modelsListCommand({ json: true, provider: "kimi" }, runtime as never);

      expect(modelRegistryOptions().providerFilter).toBe("moonshot");
      expectRowKeys(lastPrintedRows<{ key: string }>(), ["moonshot/kimi-k2.6"]);
    });

    it("keeps catalog metadata when provider-filtered configured entries overlap", async () => {
      mocks.resolveConfiguredEntries.mockReturnValueOnce({
        entries: [
          {
            key: "moonshot/kimi-k2.6",
            ref: { provider: "moonshot", model: "kimi-k2.6" },
            tags: new Set(["configured"]),
            aliases: [],
          },
        ],
      });
      mocks.loadModelCatalog.mockResolvedValueOnce([
        {
          provider: "moonshot",
          id: "kimi-k2.6",
          ref: "moonshot/kimi-k2.6",
          mergeKey: "moonshot::kimi-k2.6",
          name: "Kimi K2.6",
          source: "manifest",
          input: ["text", "image"],
          reasoning: false,
          status: "available",
          baseUrl: "https://api.moonshot.ai/v1",
          contextWindow: 262_144,
        },
      ]);
      const runtime = createRuntime();

      await modelsListCommand({ json: true, provider: "moonshot" }, runtime as never);

      expect(mocks.loadModelRegistry).toHaveBeenCalledOnce();
      expect(mocks.loadModelCatalog).toHaveBeenCalledOnce();
      const rows = lastPrintedRows<{ key: string; name: string; tags: string[] }>();
      expectRowKeys(rows, ["moonshot/kimi-k2.6"]);
      expectRowFields(rows, "moonshot/kimi-k2.6", {
        name: "Kimi K2.6",
        tags: ["configured"],
      });
    });

    it("falls back to registry rows for unknown provider filters without --all", async () => {
      mocks.resolveConfiguredEntries.mockReturnValueOnce({ entries: [] });
      primeModelRegistry([
        {
          provider: "google",
          id: "gemini-2.5-pro",
          name: "Gemini 2.5 Pro",
          api: "google-gemini",
          baseUrl: "https://generativelanguage.googleapis.com/v1beta",
          input: ["text", "image"],
          contextWindow: 1_048_576,
          maxTokens: 65_536,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ]);
      const runtime = createRuntime();

      await modelsListCommand({ json: true, provider: "google" }, runtime as never);

      expect(mocks.loadModelRegistry).toHaveBeenCalled();
      expect(runtime.log).not.toHaveBeenCalledWith("No models found.");
      expectRowKeys(lastPrintedRows<{ key: string }>(), ["google/gemini-2.5-pro"]);
    });

    it("keeps scoped provider fallback rows filtered by model suppression", async () => {
      mocks.resolveConfiguredEntries.mockReturnValueOnce({ entries: [] });
      const currentModel = {
        provider: "openai",
        id: "gpt-5.5",
        name: "GPT-5.5",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        input: ["text", "image"],
        contextWindow: 1_048_576,
        maxTokens: 65_536,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      };
      const suppressedModel = {
        ...currentModel,
        id: "gpt-5.3-codex-spark",
        name: "GPT-5.3 Codex Spark",
      };
      primeModelRegistry([currentModel], undefined, [currentModel, suppressedModel]);
      const runtime = createRuntime();

      await modelsListCommand({ json: true, provider: "openai" }, runtime as never);

      expectRowKeys(lastPrintedRows<{ key: string }>(), ["openai/gpt-5.5"]);
    });

    it("projects static provider rows from the committed catalog", async () => {
      mocks.resolveConfiguredEntries.mockReturnValueOnce({ entries: [] });
      mocks.loadModelCatalog.mockResolvedValueOnce([
        {
          provider: "google",
          id: "gemini-2.5-pro",
          name: "gemini-2.5-pro",
          api: "google-gemini",
          baseUrl: "https://generativelanguage.googleapis.com/v1beta",
          input: ["text", "image"],
          contextWindow: 1_048_576,
          maxTokens: 65_536,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ]);
      const runtime = createRuntime();

      await modelsListCommand({ json: true, provider: "google" }, runtime as never);

      expect(mocks.loadModelRegistry).toHaveBeenCalledOnce();
      expect(mocks.loadModelCatalog).toHaveBeenCalledOnce();
      expectRowKeys(lastPrintedRows<{ key: string }>(), ["google/gemini-2.5-pro"]);
    });

    it("does not invent installable preview rows outside the committed catalog", async () => {
      mocks.resolveConfiguredEntries.mockReturnValueOnce({ entries: [] });
      const runtime = createRuntime();

      await modelsListCommand({ json: true, provider: "moonshot" }, runtime as never);

      expect(mocks.loadModelRegistry).toHaveBeenCalledOnce();
      expect(mocks.loadModelCatalog).toHaveBeenCalledOnce();
      expectRowKeys(lastPrintedRows<{ key: string }>(), []);
    });

    it("includes configured provider model rows for provider-filtered lists", async () => {
      const ollamaConfig = {
        agents: { defaults: { model: { primary: "ollama/qwen2.5:7b" } } },
        models: {
          providers: {
            ollama: {
              api: "ollama",
              apiKey: "ollama-local",
              baseUrl: "http://127.0.0.1:11434",
              models: [
                { id: "qwen2.5:7b", name: "Qwen 2.5 7B", input: ["text"] },
                { id: "llama3.2:3b", name: "Llama 3.2 3B", input: ["text"] },
              ],
            },
          },
        },
      };
      mocks.loadModelsConfigWithSource.mockResolvedValueOnce({
        sourceConfig: ollamaConfig,
        resolvedConfig: ollamaConfig,
        diagnostics: [],
      });
      mocks.resolveConfiguredEntries.mockReturnValueOnce({
        entries: [
          {
            key: "ollama/qwen2.5:7b",
            ref: { provider: "ollama", model: "qwen2.5:7b" },
            tags: new Set(["default"]),
            aliases: [],
          },
        ],
      });
      const runtime = createRuntime();

      await modelsListCommand({ json: true, provider: "ollama" }, runtime as never);

      expect(mocks.loadModelRegistry).toHaveBeenCalledOnce();
      const rows = lastPrintedRows<{ key: string; name: string; tags: string[] }>();
      expectRowKeys(rows, ["ollama/qwen2.5:7b", "ollama/llama3.2:3b"]);
      expectRowFields(rows, "ollama/qwen2.5:7b", {
        name: "Qwen 2.5 7B",
        tags: ["default"],
      });
      expectRowFields(rows, "ollama/llama3.2:3b", {
        name: "Llama 3.2 3B",
        tags: [],
      });
    });

    it.each([
      {
        mode: "merge" as const,
        expectedKeys: ["xiaomi/mimo-v2.5-pro", "xiaomi/mimo-v2.5", "google/gemini-3.1-flash-lite"],
      },
      {
        mode: "replace" as const,
        expectedKeys: ["xiaomi/mimo-v2.5-pro", "xiaomi/mimo-v2.5"],
      },
    ])("honors $mode mode in configured lists", async ({ mode, expectedKeys }) => {
      const config = {
        agents: { defaults: { model: { primary: "xiaomi/mimo-v2.5-pro" } } },
        models: {
          mode,
          providers: {
            xiaomi: {
              ...(mode === "merge" ? { api: "openai-completions" as const } : {}),
              apiKey: "tp-fixture",
              baseUrl: "https://api.xiaomi.example/v1",
              models: [
                { id: "mimo-v2.5-pro", name: "MiMo V2.5 Pro", input: ["text"] },
                { id: "mimo-v2.5", name: "MiMo V2.5", input: ["text", "image"] },
              ],
            },
          },
        },
      };
      mocks.loadModelsConfigWithSource.mockResolvedValueOnce({
        sourceConfig: config,
        resolvedConfig: config,
        diagnostics: [],
      });
      mocks.ensureAuthProfileStore.mockReturnValueOnce({
        version: 1,
        profiles: {
          "google:default": {
            type: "api_key",
            provider: "google",
            key: "google-fixture",
          },
          "openai:platform": {
            type: "api_key",
            provider: "openai",
            key: "openai-fixture",
          },
        },
        order: {},
      });
      mocks.resolveConfiguredEntries.mockReturnValueOnce({
        entries: [
          {
            key: "xiaomi/mimo-v2.5-pro",
            ref: { provider: "xiaomi", model: "mimo-v2.5-pro" },
            tags: new Set(["default"]),
            aliases: [],
          },
          ...(mode === "replace"
            ? [
                {
                  key: "google/gemini-stale",
                  ref: { provider: "google", model: "gemini-stale" },
                  tags: new Set(["fallback#1"]),
                  aliases: [],
                },
                {
                  key: "openai/gpt-stale",
                  ref: { provider: "openai", model: "gpt-stale" },
                  tags: new Set(["configured"]),
                  aliases: [],
                },
              ]
            : []),
        ],
      });
      mocks.loadModelCatalog.mockResolvedValueOnce([
        {
          provider: "google",
          id: "gemini-3.1-flash-lite",
          name: "Gemini 3.1 Flash Lite",
          input: ["text"],
          contextWindow: 1_000_000,
        },
      ]);
      const runtime = createRuntime();

      await modelsListCommand({ json: true }, runtime as never);

      expect(mocks.loadModelRegistry).not.toHaveBeenCalled();
      if (mode === "merge") {
        expect(mocks.loadModelCatalog).toHaveBeenCalledWith(
          expect.objectContaining({
            providerDiscoveryProviderIds: ["google", "openai", "xiaomi"],
            providerRuntimeDiscoveryProviderIds: [],
            providerManifestFallbackProviderIds: ["google", "openai"],
          }),
        );
      } else {
        expect(mocks.loadModelCatalog).not.toHaveBeenCalled();
      }
      const rows = lastPrintedRows<{ key: string; name: string; available: boolean }>();
      expectRowKeys(rows, expectedKeys);
      expectRowFields(rows, "xiaomi/mimo-v2.5-pro", { name: "MiMo V2.5 Pro" });
      expectRowFields(rows, "xiaomi/mimo-v2.5", { name: "MiMo V2.5" });
      if (mode === "merge") {
        expectRowFields(rows, "google/gemini-3.1-flash-lite", {
          name: "Gemini 3.1 Flash Lite",
          available: true,
        });
      }
    });

    it.each([
      { name: "--all", options: { all: true } },
      { name: "--provider", options: { provider: "google" } },
    ])("keeps explicit $name browsing in replace mode", async ({ options }) => {
      const config = {
        agents: { defaults: { model: { primary: "xiaomi/mimo-v2.5-pro" } } },
        models: {
          mode: "replace" as const,
          providers: {
            xiaomi: {
              baseUrl: "https://api.xiaomi.example/v1",
              models: [{ id: "mimo-v2.5-pro", name: "MiMo V2.5 Pro", input: ["text"] }],
            },
          },
        },
      };
      mocks.loadModelsConfigWithSource.mockResolvedValueOnce({
        sourceConfig: config,
        resolvedConfig: config,
        diagnostics: [],
      });
      mocks.resolveConfiguredEntries.mockReturnValueOnce({
        entries: [
          {
            key: "xiaomi/mimo-v2.5-pro",
            ref: { provider: "xiaomi", model: "mimo-v2.5-pro" },
            tags: new Set(["default"]),
            aliases: [],
          },
        ],
      });
      mocks.loadModelCatalog.mockResolvedValueOnce([
        {
          provider: "google",
          id: "gemini-3.1-flash-lite",
          name: "Gemini 3.1 Flash Lite",
          input: ["text"],
          contextWindow: 1_000_000,
        },
      ]);
      const runtime = createRuntime();

      await modelsListCommand({ ...options, json: true }, runtime as never);

      expect(lastPrintedRows<{ key: string }>().map((row) => row.key)).toContain(
        "google/gemini-3.1-flash-lite",
      );
    });

    it("does not mark configured codex model as missing when forward-compat can build a fallback", async () => {
      const runtime = createRuntime();

      await modelsListCommand({ json: true }, runtime as never);

      expect(mocks.printModelTable).toHaveBeenCalled();
      const rows = lastPrintedRows<{
        key: string;
        tags: string[];
        missing: boolean;
      }>();

      const codex = requireRow(rows, "openai/gpt-5.4");
      expect(codex.missing).toBe(false);
      expect(codex.tags).not.toContain("missing");
    });

    it("does not mark configured codex mini as missing when forward-compat can build a fallback", async () => {
      mocks.resolveConfiguredEntries.mockReturnValueOnce({
        entries: [
          {
            key: "openai/gpt-5.4-mini",
            ref: { provider: "openai", model: "gpt-5.4-mini" },
            tags: new Set(["configured"]),
            aliases: [],
          },
        ],
      });
      const runtime = createRuntime();

      await modelsListCommand({ json: true }, runtime as never);

      expect(mocks.printModelTable).toHaveBeenCalled();
      const rows = lastPrintedRows<{
        key: string;
        tags: string[];
        missing: boolean;
      }>();

      const codexMini = requireRow(rows, "openai/gpt-5.4-mini");
      expect(codexMini.missing).toBe(false);
      expect(codexMini.tags).not.toContain("missing");
    });

    it("does not mark configured codex gpt-5.4-pro as missing when forward-compat can build a fallback", async () => {
      mocks.resolveConfiguredEntries.mockReturnValueOnce({
        entries: [
          {
            key: "openai/gpt-5.4-pro",
            ref: { provider: "openai", model: "gpt-5.4-pro" },
            tags: new Set(["configured"]),
            aliases: [],
          },
        ],
      });
      const runtime = createRuntime();

      await modelsListCommand({ json: true }, runtime as never);

      expect(mocks.printModelTable).toHaveBeenCalled();
      const rows = lastPrintedRows<{
        key: string;
        tags: string[];
        missing: boolean;
      }>();

      const codexPro = requireRow(rows, "openai/gpt-5.4-pro");
      expect(codexPro.missing).toBe(false);
      expect(codexPro.tags).not.toContain("missing");
    });

    it("does not load the model registry for configured-mode listing", async () => {
      const runtime = createRuntime();

      await modelsListCommand({ json: true }, runtime as never);

      expect(mocks.loadModelRegistry).not.toHaveBeenCalled();
    });

    it("keeps configured local openai gpt-5.4 entries visible in --local output", async () => {
      mocks.resolveConfiguredEntries.mockReturnValueOnce({
        entries: [
          {
            key: "openai/gpt-5.4",
            ref: { provider: "openai", model: "gpt-5.4" },
            tags: new Set(["configured"]),
            aliases: [],
          },
        ],
      });
      mocks.resolveModelWithRegistry.mockReturnValueOnce({
        provider: "openai",
        id: "gpt-5.4",
        name: "GPT-5.4",
        api: "openai-responses",
        baseUrl: "http://localhost:4000/v1",
        input: ["text", "image"],
        contextWindow: 1_050_000,
        maxTokens: 128_000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      });
      const runtime = createRuntime();

      await modelsListCommand({ json: true, local: true }, runtime as never);

      expect(mocks.loadModelRegistry).toHaveBeenCalledWith(
        mocks.resolvedConfig,
        expect.objectContaining({
          agentId: "main",
          agentDir: "/tmp/openclaw-agent",
        }),
      );
      expect(mocks.printModelTable).toHaveBeenCalled();
      expectRowKeys(lastPrintedRows<{ key: string }>(), ["openai/gpt-5.4"]);
    });
  });

  describe("availability fallback", () => {
    it("marks synthetic codex gpt-5.4 rows available with compatible OAuth auth", async () => {
      const oauthConfig = {
        agents: { defaults: { model: { primary: "openai/gpt-5.4" } } },
        models: { providers: { openai: {} } },
      };
      mocks.loadModelsConfigWithSource.mockResolvedValueOnce({
        sourceConfig: oauthConfig,
        resolvedConfig: oauthConfig,
        diagnostics: [],
      });
      mocks.ensureAuthProfileStore.mockReturnValueOnce({
        version: 1,
        profiles: {
          "openai:default": {
            type: "oauth",
            provider: "openai",
            access: "oauth-access",
            refresh: "oauth-refresh",
            expires: Date.now() + 60_000,
          },
        },
        order: {},
      });
      const runtime = createRuntime();

      await modelsListCommand({ json: true }, runtime as never);

      expect(mocks.printModelTable).toHaveBeenCalled();
      expectRowFields(lastPrintedRows<{ key: string; available: boolean }>(), "openai/gpt-5.4", {
        available: true,
      });
    });

    it("does not require the all-model registry result for configured-mode listing", async () => {
      const previousExitCode = process.exitCode;
      process.exitCode = undefined;
      const runtime = createRuntime();
      let observedExitCode: number | undefined;

      try {
        await modelsListCommand({ json: true }, runtime as never);
        observedExitCode = process.exitCode;
      } finally {
        process.exitCode = previousExitCode;
      }

      expect(runtime.error).not.toHaveBeenCalled();
      expect(observedExitCode).toBeUndefined();
      expect(mocks.loadModelRegistry).not.toHaveBeenCalled();
      expect(mocks.printModelTable).toHaveBeenCalled();
    });
  });

  describe("--all catalog supplementation", () => {
    it("includes refreshed runtime models from the committed provider generation", async () => {
      mocks.resolveConfiguredEntries.mockReturnValueOnce({ entries: [] });
      mocks.loadModelCatalog.mockResolvedValueOnce([
        {
          provider: "anthropic",
          id: "claude-live",
          name: "Claude Live",
          api: "anthropic-messages",
          baseUrl: "https://api.anthropic.com",
          input: ["text"],
          contextWindow: 200_000,
          maxTokens: 4096,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
        {
          provider: "anthropic",
          id: "claude-refreshed",
          ref: "anthropic/claude-refreshed",
          mergeKey: "anthropic::claude-refreshed",
          name: "Claude Refreshed",
          source: "runtime-refresh",
          input: ["text"],
          reasoning: false,
          status: "available",
          baseUrl: "https://api.anthropic.com",
          contextWindow: 200_000,
        },
      ]);
      const runtime = createRuntime();

      await modelsListCommand({ all: true, provider: "anthropic", json: true }, runtime as never);

      expect(mocks.loadModelRegistry).toHaveBeenCalledOnce();
      expect(mocks.loadModelCatalog).toHaveBeenCalledOnce();
      expectRowKeys(lastPrintedRows<{ key: string }>(), [
        "anthropic/claude-live",
        "anthropic/claude-refreshed",
      ]);
    });

    it("keeps OpenAI runtime rows authoritative while adding refreshed models once", async () => {
      mocks.resolveConfiguredEntries.mockReturnValueOnce({ entries: [] });
      mocks.loadModelCatalog.mockResolvedValueOnce([
        {
          provider: "openai",
          id: "gpt-live",
          name: "Live GPT",
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          input: ["text"],
          contextWindow: 200_000,
          maxTokens: 4096,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
        {
          provider: "openai",
          id: "gpt-refreshed",
          ref: "openai/gpt-refreshed",
          mergeKey: "openai::gpt-refreshed",
          name: "Refreshed GPT",
          source: "runtime-refresh",
          input: ["text"],
          reasoning: false,
          status: "available",
          baseUrl: "https://api.openai.com/v1",
          contextWindow: 200_000,
        },
      ]);
      const runtime = createRuntime();

      await modelsListCommand({ all: true, provider: "openai", json: true }, runtime as never);

      expect(mocks.loadModelRegistry).toHaveBeenCalledOnce();
      expect(mocks.loadModelCatalog).toHaveBeenCalledOnce();
      const rows = lastPrintedRows<{ key: string; name: string }>();
      expectRowKeys(rows, ["openai/gpt-live", "openai/gpt-refreshed"]);
      expect(requireRow(rows, "openai/gpt-live").name).toBe("Live GPT");
    });

    it("keeps provider-catalog Codex availability indeterminate without model auth", async () => {
      mocks.resolveConfiguredEntries.mockReturnValueOnce({ entries: [] });
      mocks.loadModelCatalog.mockResolvedValueOnce([
        {
          provider: "codex",
          id: "gpt-5.4",
          name: "gpt-5.4",
          api: "openai-chatgpt-responses",
          baseUrl: "https://chatgpt.com/backend-api",
          input: ["text", "image"],
          contextWindow: 272_000,
          maxTokens: 128_000,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ]);
      mocks.loadPluginRegistrySnapshotWithMetadata.mockReturnValueOnce({
        source: "persisted",
        snapshot: {
          plugins: [{ enabled: true, syntheticAuthRefs: ["codex"] }],
        },
        diagnostics: [],
      });
      const runtime = createRuntime();

      await modelsListCommand({ all: true, provider: "codex", json: true }, runtime as never);

      expect(mocks.ensureOpenClawModelsJson).not.toHaveBeenCalled();
      expect(mocks.loadModelRegistry).toHaveBeenCalledOnce();
      expect(mocks.loadModelCatalog).toHaveBeenCalledOnce();
      const rows = lastPrintedRows<{ key: string; available: boolean | null }>();
      expectRowKeys(rows, ["codex/gpt-5.4"]);
      expectRowFields(rows, "codex/gpt-5.4", { available: null });
    });

    it("uses committed catalog rows without separately loading provider runtimes", async () => {
      mocks.resolveConfiguredEntries.mockReturnValueOnce({ entries: [] });
      mocks.loadModelCatalog.mockResolvedValueOnce([
        {
          provider: "moonshot",
          id: "kimi-k2.6",
          ref: "moonshot/kimi-k2.6",
          mergeKey: "moonshot::kimi-k2.6",
          name: "Kimi K2.6",
          source: "manifest",
          input: ["text", "image"],
          reasoning: false,
          status: "available",
          baseUrl: "https://api.moonshot.ai/v1",
          contextWindow: 262_144,
        },
      ]);
      const runtime = createRuntime();

      await modelsListCommand({ all: true, provider: "moonshot", json: true }, runtime as never);

      expect(mocks.loadModelRegistry).toHaveBeenCalledOnce();
      expect(mocks.loadModelCatalog).toHaveBeenCalledOnce();
      expectRowKeys(lastPrintedRows<{ key: string }>(), ["moonshot/kimi-k2.6"]);
    });

    it("keeps refreshable manifest catalog rows on the registry-backed provider path", async () => {
      mocks.resolveConfiguredEntries.mockReturnValueOnce({ entries: [] });
      mocks.loadModelCatalog.mockResolvedValueOnce([
        {
          provider: "openai",
          id: "gpt-5.5-pro",
          ref: "openai/gpt-5.5-pro",
          mergeKey: "openai::gpt-5.5-pro",
          name: "gpt-5.5-pro",
          source: "manifest",
          input: ["text", "image"],
          reasoning: true,
          status: "available",
          baseUrl: "https://api.openai.com/v1",
          contextWindow: 1_000_000,
        },
      ]);
      primeModelRegistry(
        [
          {
            provider: "openai",
            id: "gpt-5.4",
            name: "GPT-5.4",
            api: "openai-responses",
            baseUrl: "https://api.openai.com/v1",
            input: ["text", "image"],
            contextWindow: 1_050_000,
            maxTokens: 128_000,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
        new Set(),
        [],
      );
      mocks.resolveModelWithRegistry.mockImplementation(
        ({ provider, modelId }: { provider: string; modelId: string }) =>
          provider === "openai" && modelId === "gpt-5.4"
            ? {
                provider,
                id: modelId,
                name: "GPT-5.4",
                api: "openai-responses",
                baseUrl: "https://api.openai.com/v1",
                input: ["text", "image"],
                contextWindow: 1_050_000,
                maxTokens: 128_000,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              }
            : undefined,
      );
      const runtime = createRuntime();

      await modelsListCommand({ all: true, provider: "openai", json: true }, runtime as never);

      expectFirstRegistryConfig();
      expect(modelRegistryOptions().providerFilter).toBe("openai");
      expect(modelRegistryOptions().normalizeModels).toBe(true);
      expectRowKeys(lastPrintedRows<{ key: string }>(), ["openai/gpt-5.4", "openai/gpt-5.5-pro"]);
    });

    it("keeps uninstalled provider previews out of the authoritative all-model view", async () => {
      mocks.resolveConfiguredEntries.mockReturnValueOnce({ entries: [] });
      const runtime = createRuntime();

      await modelsListCommand({ all: true, provider: "moonshot", json: true }, runtime as never);

      expect(mocks.loadModelRegistry).toHaveBeenCalledOnce();
      expect(mocks.loadModelCatalog).toHaveBeenCalledOnce();
      expectRowKeys(lastPrintedRows<{ key: string }>(), []);
    });

    it("does not load broad provider runtime catalogs for unfiltered all-model lists", async () => {
      mocks.resolveConfiguredEntries.mockReturnValueOnce({ entries: [] });
      primeModelRegistry(
        [
          {
            ...OPENAI_CODEX_MODEL,
            api: "openai-responses",
            baseUrl: "https://api.openai.com/v1",
          },
        ],
        new Set(["openai/gpt-5.4"]),
      );
      mocks.loadModelCatalog.mockResolvedValueOnce([
        {
          provider: "moonshot",
          id: "kimi-k2.6",
          ref: "moonshot/kimi-k2.6",
          mergeKey: "moonshot::kimi-k2.6",
          name: "Kimi K2.6",
          source: "manifest",
          input: ["text", "image"],
          reasoning: false,
          status: "available",
          baseUrl: "https://api.moonshot.ai/v1",
          contextWindow: 262_144,
        },
      ]);
      const runtime = createRuntime();

      await modelsListCommand({ all: true, json: true }, runtime as never);

      expectFirstRegistryConfig();
      expect(modelRegistryOptions().providerFilter).toBeUndefined();
      expect(modelRegistryOptions().normalizeModels).toBe(false);
      expect(mocks.resolveModelWithRegistry).not.toHaveBeenCalled();
      expect(mocks.loadModelCatalog).toHaveBeenCalledOnce();
      expect(mocks.loadModelCatalog).toHaveBeenCalledWith(
        expect.not.objectContaining({
          providerDiscoveryProviderIds: expect.anything(),
        }),
      );
      expectRowKeys(lastPrintedRows<{ key: string }>(), ["openai/gpt-5.4", "moonshot/kimi-k2.6"]);
    });

    it("falls back to registry-backed rows when the fast-path catalog is empty", async () => {
      mocks.resolveConfiguredEntries.mockReturnValueOnce({ entries: [] });
      primeModelRegistry([{ ...OPENAI_CODEX_MODEL }], new Set(["openai/gpt-5.4"]));
      const runtime = createRuntime();

      await modelsListCommand({ all: true, provider: "openai", json: true }, runtime as never);

      expectFirstRegistryConfig();
      expect(modelRegistryOptions().providerFilter).toBe("openai");
      expect(modelRegistryOptions().normalizeModels).toBe(true);
      expect(mocks.loadModelCatalog).toHaveBeenCalledOnce();
      expect(mocks.loadModelCatalog).toHaveBeenCalledWith(
        expect.objectContaining({
          providerDiscoveryProviderIds: ["openai"],
        }),
      );
      const rows = lastPrintedRows<{ key: string; available: boolean }>();
      expectRowKeys(rows, ["openai/gpt-5.4"]);
      expectRowFields(rows, "openai/gpt-5.4", { available: true });
    });

    it("falls back to registry rows for provider filters without catalog coverage", async () => {
      mocks.resolveConfiguredEntries.mockReturnValueOnce({ entries: [] });
      primeModelRegistry([
        {
          provider: "anthropic",
          id: "claude-opus-4-7",
          name: "Claude Opus 4.7",
          api: "anthropic-messages",
          baseUrl: "https://api.anthropic.com/v1",
          input: ["text", "image"],
          contextWindow: 1_000_000,
          maxTokens: 64_000,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ]);
      const runtime = createRuntime();

      await modelsListCommand({ all: true, provider: "anthropic", json: true }, runtime as never);

      expectFirstRegistryConfig();
      expect(modelRegistryOptions().providerFilter).toBe("anthropic");
      expect(modelRegistryOptions().normalizeModels).toBe(true);
      expect(mocks.loadModelCatalog).toHaveBeenCalledOnce();
      expectRowKeys(lastPrintedRows<{ key: string }>(), ["anthropic/claude-opus-4-7"]);
    });

    it("includes provider-owned supplemental catalog rows with provider filters", async () => {
      mocks.resolveConfiguredEntries.mockReturnValueOnce({ entries: [] });
      primeModelRegistry([], new Set(["opencode-go/deepseek-v4-pro"]));
      mocks.loadModelCatalog.mockResolvedValueOnce([
        {
          provider: "opencode-go",
          id: "deepseek-v4-pro",
          name: "DeepSeek V4 Pro",
          input: ["text"],
          contextWindow: 1_000_000,
        },
      ]);
      mocks.resolveModelWithRegistry.mockImplementation(
        ({ provider, modelId }: { provider: string; modelId: string }) =>
          provider === "opencode-go" && modelId === "deepseek-v4-pro"
            ? {
                provider,
                id: modelId,
                name: "DeepSeek V4 Pro",
                api: "anthropic-messages",
                baseUrl: "https://opencode.ai/zen/go",
                input: ["text"],
                contextWindow: 1_000_000,
                maxTokens: 384_000,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              }
            : undefined,
      );
      const runtime = createRuntime();

      await modelsListCommand({ all: true, provider: "opencode-go", json: true }, runtime as never);

      expectRowKeys(lastPrintedRows<{ key: string }>(), ["opencode-go/deepseek-v4-pro"]);
    });

    it("includes synthetic codex gpt-5.4 in --all output when catalog supports it", async () => {
      mocks.resolveConfiguredEntries.mockReturnValueOnce({ entries: [] });
      primeModelRegistry([], new Set(["openai/gpt-5.4"]));
      mocks.loadModelCatalog.mockResolvedValueOnce([
        {
          provider: "openai",
          id: "gpt-5.4",
          name: "GPT-5.3 Codex",
          input: ["text"],
          contextWindow: 400000,
        },
      ]);
      const rows = await buildAllOpenAiCodexRows();
      expectRowKeys(rows as Array<{ key: string }>, ["openai/gpt-5.4"]);
      expectRowFields(rows as Array<{ key: string; available: boolean }>, "openai/gpt-5.4", {
        available: true,
      });
    });

    it("uses provider runtime metadata for discovered codex gpt-5.5 rows", async () => {
      mocks.resolveConfiguredEntries.mockReturnValueOnce({ entries: [] });
      const oauthConfig = {
        agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
        models: { providers: { openai: {} } },
      };
      mocks.loadModelsConfigWithSource.mockResolvedValueOnce({
        sourceConfig: oauthConfig,
        resolvedConfig: oauthConfig,
        diagnostics: [],
      });
      mocks.ensureAuthProfileStore.mockReturnValueOnce({
        version: 1,
        profiles: {
          "openai:default": {
            type: "oauth",
            provider: "openai",
            access: "oauth-access",
            refresh: "oauth-refresh",
            expires: Date.now() + 60_000,
          },
        },
        order: {},
      });
      primeModelRegistry(
        [
          {
            provider: "openai",
            id: "gpt-5.5",
            name: "GPT-5.5",
            api: "openai-chatgpt-responses",
            baseUrl: "https://chatgpt.com/backend-api",
            input: ["text", "image"],
            contextWindow: 272000,
            maxTokens: 128000,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
        new Set(["openai/gpt-5.5"]),
      );
      mocks.resolveModelWithRegistry.mockImplementation(
        ({ provider, modelId }: { provider: string; modelId: string }) =>
          provider === "openai" && modelId === "gpt-5.5"
            ? {
                provider: "openai",
                id: "gpt-5.5",
                name: "GPT-5.5",
                api: "openai-chatgpt-responses",
                baseUrl: "https://chatgpt.com/backend-api",
                input: ["text", "image"],
                contextWindow: 400000,
                contextTokens: 272000,
                maxTokens: 128000,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              }
            : undefined,
      );

      const runtime = createRuntime();
      await modelsListCommand({ all: true, provider: "openai", json: true }, runtime as never);

      const rows = lastPrintedRows<{
        key: string;
        contextWindow: number;
        contextTokens?: number;
      }>();
      expectRowKeys(rows, ["openai/gpt-5.5"]);
      expectRowFields(rows, "openai/gpt-5.5", {
        contextWindow: 400000,
        contextTokens: 272000,
      });
    });

    it("suppresses direct openai gpt-5.3-codex-spark rows in --all output", async () => {
      mocks.resolveConfiguredEntries.mockReturnValueOnce({ entries: [] });
      const rows: unknown[] = [];
      await listRowsModule.appendDiscoveredRows({
        rows: rows as never,
        models: [
          {
            provider: "openai",
            id: "gpt-5.3-codex-spark",
            name: "GPT-5.3 Codex Spark",
            api: "openai-responses",
            baseUrl: "https://api.openai.com/v1",
            input: ["text", "image"],
            contextWindow: 128000,
            maxTokens: 32000,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
          {
            provider: "azure-openai-responses",
            id: "gpt-5.3-codex-spark",
            name: "GPT-5.3 Codex Spark",
            api: "azure-openai-responses",
            baseUrl: "https://example.openai.azure.com/openai/v1",
            input: ["text", "image"],
            contextWindow: 128000,
            maxTokens: 32000,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
          { ...OPENAI_CODEX_53_MODEL },
        ] as never,
        context: {
          cfg: mocks.resolvedConfig,
          authIndex: {
            evaluateModelAuth: () => ({ availability: false, routeResolution: null }),
          },
          availableKeys: new Set(["openai/gpt-5.4"]),
          configuredByKey: new Map(),
          discoveredKeys: new Set(),
          filter: {},
        } as never,
      });

      expectRowKeys(rows as Array<{ key: string }>, ["openai/gpt-5.4"]);
    });
  });

  describe("provider filter matching", () => {
    it("matches discovered providers against exact provider filters", async () => {
      mocks.resolveConfiguredEntries.mockReturnValueOnce({ entries: [] });
      primeModelRegistry(
        [
          {
            provider: "z.ai",
            id: "glm-4.5",
            name: "GLM-4.5",
            api: "openai-responses",
            baseUrl: "https://api.z.ai/v1",
            input: ["text"],
            contextWindow: 128_000,
            maxTokens: 16_384,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
        new Set(["z.ai/glm-4.5"]),
      );

      const runtime = createRuntime();

      await modelsListCommand({ all: true, provider: "z.ai", json: true }, runtime as never);

      expect(mocks.printModelTable).toHaveBeenCalled();
      expectRowKeys(lastPrintedRows<{ key: string }>(), ["z.ai/glm-4.5"]);
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
