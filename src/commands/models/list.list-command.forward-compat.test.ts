import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const OPENAI_CODEX_MODEL = {
  provider: "openai-codex",
  id: "gpt-5.4",
  name: "GPT-5.4",
  api: "openai-codex-responses",
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
  const sourceConfig = {
    agents: { defaults: { model: { primary: "openai-codex/gpt-5.4" } } },
    models: {
      providers: {
        openai: {
          apiKey: "$OPENAI_API_KEY", // pragma: allowlist secret
        },
      },
    },
  };
  const resolvedConfig = {
    agents: { defaults: { model: { primary: "openai-codex/gpt-5.4" } } },
    models: {
      providers: {
        openai: {
          apiKey: "sk-resolved-runtime-value", // pragma: allowlist secret
        },
      },
    },
  };
  return {
    sourceConfig,
    resolvedConfig,
    loadModelsConfigWithSource: vi.fn(),
    ensureOpenClawModelsJson: vi.fn(),
    ensureAuthProfileStore: vi.fn(),
    resolveOpenClawAgentDir: vi.fn(),
    loadModelRegistry: vi.fn(),
    loadModelCatalog: vi.fn(),
    loadProviderCatalogModelsForList: vi.fn(),
    loadStaticManifestCatalogRowsForList: vi.fn(),
    loadSupplementalManifestCatalogRowsForList: vi.fn(),
    loadProviderIndexCatalogRowsForList: vi.fn(),
    hasProviderStaticCatalogForFilter: vi.fn(),
    resolveConfiguredEntries: vi.fn(),
    printModelTable: vi.fn(),
    resolveModelWithRegistry: vi.fn(),
    readPersistedInstalledPluginIndexSync: vi.fn(),
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
  mocks.resolveOpenClawAgentDir.mockReturnValue("/tmp/openclaw-agent");
  mocks.loadModelRegistry.mockResolvedValue({
    models: [],
    availableKeys: new Set(),
    registry: {
      getAll: () => [],
    },
  });
  mocks.loadModelCatalog.mockResolvedValue([]);
  mocks.loadProviderCatalogModelsForList.mockResolvedValue([]);
  mocks.loadStaticManifestCatalogRowsForList.mockReturnValue([]);
  mocks.loadSupplementalManifestCatalogRowsForList.mockReturnValue([]);
  mocks.loadProviderIndexCatalogRowsForList.mockReturnValue([]);
  mocks.hasProviderStaticCatalogForFilter.mockResolvedValue(false);
  mocks.resolveConfiguredEntries.mockReturnValue({
    entries: [
      {
        key: "openai-codex/gpt-5.4",
        ref: { provider: "openai-codex", model: "gpt-5.4" },
        tags: new Set(["configured"]),
        aliases: [],
      },
    ],
  });
  mocks.printModelTable.mockReset();
  mocks.resolveModelWithRegistry.mockReturnValue({ ...OPENAI_CODEX_MODEL });
  mocks.readPersistedInstalledPluginIndexSync.mockReturnValue(null);
  mocks.loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
    source: "persisted",
    snapshot: { plugins: [] },
    diagnostics: [],
  });
}

function createRuntime() {
  return { log: vi.fn(), error: vi.fn() };
}

function lastPrintedRows<T>() {
  return (mocks.printModelTable.mock.calls.at(-1)?.[0] ?? []) as T[];
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
    shouldSuppressBuiltInModel: suppressOpenAiSpark,
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

  vi.doMock("./list.table.js", () => ({
    printModelTable: mocks.printModelTable,
  }));

  vi.doMock("./list.provider-catalog.js", () => ({
    hasProviderStaticCatalogForFilter: mocks.hasProviderStaticCatalogForFilter,
    loadProviderCatalogModelsForList: mocks.loadProviderCatalogModelsForList,
  }));

  vi.doMock("./list.manifest-catalog.js", () => ({
    loadStaticManifestCatalogRowsForList: mocks.loadStaticManifestCatalogRowsForList,
    loadSupplementalManifestCatalogRowsForList: mocks.loadSupplementalManifestCatalogRowsForList,
  }));

  vi.doMock("./list.provider-index-catalog.js", () => ({
    loadProviderIndexCatalogRowsForList: mocks.loadProviderIndexCatalogRowsForList,
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

  vi.doMock("../../agents/auth-profiles/store.js", () => ({
    loadAuthProfileStoreWithoutExternalProfiles: mocks.ensureAuthProfileStore,
  }));

  vi.doMock("../../agents/agent-paths.js", () => ({
    resolveOpenClawAgentDir: mocks.resolveOpenClawAgentDir,
  }));

  vi.doMock("../../agents/model-catalog.js", () => ({
    loadModelCatalog: mocks.loadModelCatalog,
  }));

  vi.doMock("../../agents/pi-embedded-runner/model.js", () => ({
    resolveModelWithRegistry: mocks.resolveModelWithRegistry,
  }));

  vi.doMock("../../agents/model-auth.js", () => ({
    hasUsableCustomProviderApiKey: vi.fn().mockReturnValue(false),
    hasSyntheticLocalProviderAuthConfig: vi.fn().mockReturnValue(false),
  }));

  vi.doMock("../../plugins/installed-plugin-index-store.js", () => ({
    readPersistedInstalledPluginIndexSync: mocks.readPersistedInstalledPluginIndexSync,
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
    authIndex: { hasProviderAuth: (provider: string) => provider === "openai-codex" },
    availableKeys: loaded.availableKeys,
    configuredByKey: new Map(),
    discoveredKeys: new Set(
      loaded.models.map(
        (model: { provider: string; id: string }) => `${model.provider}/${model.id}`,
      ),
    ),
    filter: { provider: "openai-codex" },
  };
  const seenKeys = await listRowsModule.appendDiscoveredRows({
    rows: rows as never,
    models: loaded.models as never,
    modelRegistry: loaded.registry as never,
    context: context as never,
  });
  if (opts.supplementCatalog !== false) {
    await listRowsModule.appendCatalogSupplementRows({
      rows: rows as never,
      modelRegistry: loaded.registry as never,
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
  describe("configured rows", () => {
    it("returns manifest catalog rows for provider filters without --all", async () => {
      mocks.resolveConfiguredEntries.mockReturnValueOnce({ entries: [] });
      mocks.loadStaticManifestCatalogRowsForList.mockReturnValueOnce([
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

      expect(mocks.loadModelRegistry).not.toHaveBeenCalled();
      expect(runtime.log).not.toHaveBeenCalledWith("No models found.");
      expect(lastPrintedRows<{ key: string }>()).toEqual([
        expect.objectContaining({ key: "moonshot/kimi-k2.6" }),
      ]);
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
      mocks.loadStaticManifestCatalogRowsForList.mockReturnValueOnce([
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

      expect(mocks.loadModelRegistry).not.toHaveBeenCalled();
      expect(lastPrintedRows<{ key: string; name: string; tags: string[] }>()).toEqual([
        expect.objectContaining({
          key: "moonshot/kimi-k2.6",
          name: "Kimi K2.6",
          tags: ["configured"],
        }),
      ]);
    });

    it("falls back to registry rows for unknown provider filters without --all", async () => {
      mocks.resolveConfiguredEntries.mockReturnValueOnce({ entries: [] });
      mocks.loadModelRegistry.mockResolvedValueOnce({
        models: [
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
        ],
        availableKeys: undefined,
        registry: {
          getAll: () => [
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
          ],
        },
      });
      const runtime = createRuntime();

      await modelsListCommand({ json: true, provider: "google" }, runtime as never);

      expect(mocks.loadModelRegistry).toHaveBeenCalled();
      expect(runtime.log).not.toHaveBeenCalledWith("No models found.");
      expect(lastPrintedRows<{ key: string }>()).toEqual([
        expect.objectContaining({ key: "google/gemini-2.5-pro" }),
      ]);
    });

    it("uses provider static catalog rows for provider filters without --all", async () => {
      mocks.resolveConfiguredEntries.mockReturnValueOnce({ entries: [] });
      mocks.hasProviderStaticCatalogForFilter.mockResolvedValueOnce(true);
      mocks.loadProviderCatalogModelsForList.mockResolvedValueOnce([
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

      expect(mocks.loadModelRegistry).not.toHaveBeenCalled();
      expect(mocks.loadProviderCatalogModelsForList).toHaveBeenCalledWith(
        expect.objectContaining({
          providerFilter: "google",
          staticOnly: true,
        }),
      );
      expect(lastPrintedRows<{ key: string }>()).toEqual([
        expect.objectContaining({ key: "google/gemini-2.5-pro" }),
      ]);
    });

    it("uses provider-index catalog rows for provider filters without --all", async () => {
      mocks.resolveConfiguredEntries.mockReturnValueOnce({ entries: [] });
      mocks.loadProviderIndexCatalogRowsForList.mockReturnValueOnce([
        {
          provider: "moonshot",
          id: "kimi-k2.6",
          ref: "moonshot/kimi-k2.6",
          mergeKey: "moonshot::kimi-k2.6",
          name: "Kimi K2.6",
          source: "provider-index",
          input: ["text", "image"],
          reasoning: false,
          status: "available",
          baseUrl: "https://api.moonshot.ai/v1",
          contextWindow: 262_144,
        },
      ]);
      const runtime = createRuntime();

      await modelsListCommand({ json: true, provider: "moonshot" }, runtime as never);

      expect(mocks.loadModelRegistry).not.toHaveBeenCalled();
      expect(lastPrintedRows<{ key: string }>()).toEqual([
        expect.objectContaining({ key: "moonshot/kimi-k2.6" }),
      ]);
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

      expect(mocks.loadModelRegistry).not.toHaveBeenCalled();
      const rows = lastPrintedRows<{ key: string; name: string; tags: string[] }>();
      expect(rows).toEqual([
        expect.objectContaining({
          key: "ollama/qwen2.5:7b",
          name: "Qwen 2.5 7B",
          tags: ["default"],
        }),
        expect.objectContaining({
          key: "ollama/llama3.2:3b",
          name: "Llama 3.2 3B",
          tags: [],
        }),
      ]);
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

      const codex = rows.find((row) => row.key === "openai-codex/gpt-5.4");
      expect(codex).toBeTruthy();
      expect(codex?.missing).toBe(false);
      expect(codex?.tags).not.toContain("missing");
    });

    it("does not mark configured codex mini as missing when forward-compat can build a fallback", async () => {
      mocks.resolveConfiguredEntries.mockReturnValueOnce({
        entries: [
          {
            key: "openai-codex/gpt-5.4-mini",
            ref: { provider: "openai-codex", model: "gpt-5.4-mini" },
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

      const codexMini = rows.find((row) => row.key === "openai-codex/gpt-5.4-mini");
      expect(codexMini).toBeTruthy();
      expect(codexMini?.missing).toBe(false);
      expect(codexMini?.tags).not.toContain("missing");
    });

    it("does not mark configured codex gpt-5.4-pro as missing when forward-compat can build a fallback", async () => {
      mocks.resolveConfiguredEntries.mockReturnValueOnce({
        entries: [
          {
            key: "openai-codex/gpt-5.4-pro",
            ref: { provider: "openai-codex", model: "gpt-5.4-pro" },
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

      const codexPro = rows.find((row) => row.key === "openai-codex/gpt-5.4-pro");
      expect(codexPro).toBeTruthy();
      expect(codexPro?.missing).toBe(false);
      expect(codexPro?.tags).not.toContain("missing");
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

      expect(mocks.printModelTable).toHaveBeenCalled();
      expect(lastPrintedRows<{ key: string }>()).toEqual([
        expect.objectContaining({
          key: "openai/gpt-5.4",
        }),
      ]);
    });
  });

  describe("availability fallback", () => {
    it("marks synthetic codex gpt-5.4 rows as available when provider auth exists", async () => {
      mocks.ensureAuthProfileStore.mockReturnValueOnce({
        version: 1,
        profiles: {
          "openai-codex:default": {
            type: "token",
            provider: "openai-codex",
            token: "codex-app-server",
          },
        },
        order: {},
      });
      const runtime = createRuntime();

      await modelsListCommand({ json: true }, runtime as never);

      expect(mocks.printModelTable).toHaveBeenCalled();
      expect(lastPrintedRows<{ key: string; available: boolean }>()).toContainEqual(
        expect.objectContaining({
          key: "openai-codex/gpt-5.4",
          available: true,
        }),
      );
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
    it("uses the provider catalog fast path for Codex provider lists", async () => {
      mocks.resolveConfiguredEntries.mockReturnValueOnce({ entries: [] });
      mocks.hasProviderStaticCatalogForFilter.mockResolvedValueOnce(true);
      mocks.loadProviderCatalogModelsForList.mockResolvedValueOnce([
        {
          provider: "codex",
          id: "gpt-5.4",
          name: "gpt-5.4",
          api: "openai-codex-responses",
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
      expect(mocks.loadModelRegistry).not.toHaveBeenCalled();
      expect(mocks.loadProviderCatalogModelsForList).toHaveBeenCalledWith({
        cfg: mocks.resolvedConfig,
        agentDir: "/tmp/openclaw-agent",
        providerFilter: "codex",
        staticOnly: true,
      });
      expect(lastPrintedRows<{ key: string; available: boolean }>()).toEqual([
        expect.objectContaining({
          key: "codex/gpt-5.4",
          available: true,
        }),
      ]);
    });

    it("uses manifest catalog rows before provider runtime catalog rows", async () => {
      mocks.resolveConfiguredEntries.mockReturnValueOnce({ entries: [] });
      mocks.loadStaticManifestCatalogRowsForList.mockReturnValueOnce([
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

      expect(mocks.loadModelRegistry).not.toHaveBeenCalled();
      expect(mocks.hasProviderStaticCatalogForFilter).not.toHaveBeenCalled();
      expect(mocks.loadProviderCatalogModelsForList).not.toHaveBeenCalled();
      expect(lastPrintedRows<{ key: string }>()).toEqual([
        expect.objectContaining({
          key: "moonshot/kimi-k2.6",
        }),
      ]);
    });

    it("keeps refreshable manifest catalog rows on the registry-backed provider path", async () => {
      mocks.resolveConfiguredEntries.mockReturnValueOnce({ entries: [] });
      mocks.loadSupplementalManifestCatalogRowsForList.mockReturnValueOnce([
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
      mocks.loadModelRegistry.mockResolvedValueOnce({
        models: [
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
        availableKeys: new Set(),
        registry: {
          getAll: () => [],
        },
      });
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

      expect(mocks.loadModelRegistry).toHaveBeenCalledWith(
        mocks.resolvedConfig,
        expect.objectContaining({
          providerFilter: "openai",
          normalizeModels: true,
        }),
      );
      expect(lastPrintedRows<{ key: string }>()).toEqual([
        expect.objectContaining({ key: "openai/gpt-5.4" }),
        expect.objectContaining({ key: "openai/gpt-5.5-pro" }),
      ]);
    });

    it("uses provider index preview rows when an installable provider is not installed", async () => {
      mocks.resolveConfiguredEntries.mockReturnValueOnce({ entries: [] });
      mocks.loadProviderIndexCatalogRowsForList.mockReturnValueOnce([
        {
          provider: "moonshot",
          id: "kimi-k2.6",
          ref: "moonshot/kimi-k2.6",
          mergeKey: "moonshot::kimi-k2.6",
          name: "Kimi K2.6",
          source: "provider-index",
          input: ["text", "image"],
          reasoning: false,
          status: "available",
          baseUrl: "https://api.moonshot.ai/v1",
          contextWindow: 262_144,
        },
      ]);
      const runtime = createRuntime();

      await modelsListCommand({ all: true, provider: "moonshot", json: true }, runtime as never);

      expect(mocks.loadModelRegistry).not.toHaveBeenCalled();
      expect(mocks.hasProviderStaticCatalogForFilter).not.toHaveBeenCalled();
      expect(mocks.loadProviderCatalogModelsForList).not.toHaveBeenCalled();
      expect(lastPrintedRows<{ key: string }>()).toEqual([
        expect.objectContaining({
          key: "moonshot/kimi-k2.6",
        }),
      ]);
    });

    it("does not load broad provider runtime catalogs for unfiltered all-model lists", async () => {
      mocks.resolveConfiguredEntries.mockReturnValueOnce({ entries: [] });
      mocks.loadModelRegistry.mockResolvedValueOnce({
        models: [{ ...OPENAI_CODEX_MODEL }],
        availableKeys: new Set(["openai-codex/gpt-5.4"]),
        registry: {
          getAll: () => [{ ...OPENAI_CODEX_MODEL }],
        },
      });
      mocks.loadSupplementalManifestCatalogRowsForList.mockReturnValueOnce([
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
      mocks.loadModelCatalog.mockResolvedValueOnce([]);
      const runtime = createRuntime();

      await modelsListCommand({ all: true, json: true }, runtime as never);

      expect(mocks.loadModelRegistry).toHaveBeenCalledWith(
        mocks.resolvedConfig,
        expect.objectContaining({
          providerFilter: undefined,
          normalizeModels: false,
        }),
      );
      expect(mocks.loadProviderCatalogModelsForList).not.toHaveBeenCalled();
      expect(mocks.resolveModelWithRegistry).not.toHaveBeenCalled();
      expect(mocks.loadModelCatalog).not.toHaveBeenCalled();
      expect(lastPrintedRows<{ key: string }>()).toEqual([
        expect.objectContaining({
          key: "openai-codex/gpt-5.4",
        }),
        expect.objectContaining({
          key: "moonshot/kimi-k2.6",
        }),
      ]);
    });

    it("falls back to registry-backed rows when the fast-path catalog is empty", async () => {
      mocks.resolveConfiguredEntries.mockReturnValueOnce({ entries: [] });
      mocks.hasProviderStaticCatalogForFilter.mockResolvedValueOnce(true);
      mocks.loadProviderCatalogModelsForList.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
      mocks.loadModelRegistry.mockResolvedValueOnce({
        models: [{ ...OPENAI_CODEX_MODEL }],
        availableKeys: new Set(["openai-codex/gpt-5.4"]),
        registry: {
          getAll: () => [{ ...OPENAI_CODEX_MODEL }],
        },
      });
      const runtime = createRuntime();

      await modelsListCommand(
        { all: true, provider: "openai-codex", json: true },
        runtime as never,
      );

      expect(mocks.loadModelRegistry).toHaveBeenCalledWith(
        mocks.resolvedConfig,
        expect.objectContaining({
          providerFilter: "openai-codex",
          normalizeModels: true,
        }),
      );
      expect(mocks.loadProviderCatalogModelsForList).toHaveBeenNthCalledWith(1, {
        cfg: mocks.resolvedConfig,
        agentDir: "/tmp/openclaw-agent",
        providerFilter: "openai-codex",
        staticOnly: true,
      });
      expect(mocks.loadProviderCatalogModelsForList).toHaveBeenNthCalledWith(2, {
        cfg: mocks.resolvedConfig,
        agentDir: "/tmp/openclaw-agent",
        providerFilter: "openai-codex",
        staticOnly: undefined,
      });
      expect(lastPrintedRows<{ key: string; available: boolean }>()).toEqual([
        expect.objectContaining({
          key: "openai-codex/gpt-5.4",
          available: true,
        }),
      ]);
    });

    it("falls back to registry rows for provider filters without catalog coverage", async () => {
      mocks.resolveConfiguredEntries.mockReturnValueOnce({ entries: [] });
      mocks.hasProviderStaticCatalogForFilter.mockResolvedValueOnce(false);
      mocks.loadModelRegistry.mockResolvedValueOnce({
        models: [
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
        ],
        availableKeys: undefined,
        registry: {
          getAll: () => [
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
          ],
        },
      });
      const runtime = createRuntime();

      await modelsListCommand({ all: true, provider: "anthropic", json: true }, runtime as never);

      expect(mocks.loadModelRegistry).toHaveBeenCalledWith(
        mocks.resolvedConfig,
        expect.objectContaining({
          providerFilter: "anthropic",
          normalizeModels: false,
          loadAvailability: false,
        }),
      );
      expect(lastPrintedRows<{ key: string }>()).toEqual([
        expect.objectContaining({
          key: "anthropic/claude-opus-4-7",
        }),
      ]);
    });

    it("includes provider-owned supplemental catalog rows with provider filters", async () => {
      mocks.resolveConfiguredEntries.mockReturnValueOnce({ entries: [] });
      mocks.hasProviderStaticCatalogForFilter.mockResolvedValueOnce(true);
      mocks.loadModelRegistry.mockResolvedValueOnce({
        models: [],
        availableKeys: new Set(["opencode-go/deepseek-v4-pro"]),
        registry: {
          getAll: () => [],
        },
      });
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

      expect(lastPrintedRows<{ key: string }>()).toEqual([
        expect.objectContaining({
          key: "opencode-go/deepseek-v4-pro",
        }),
      ]);
    });

    it("includes synthetic codex gpt-5.4 in --all output when catalog supports it", async () => {
      mocks.resolveConfiguredEntries.mockReturnValueOnce({ entries: [] });
      mocks.loadModelRegistry.mockResolvedValueOnce({
        models: [],
        availableKeys: new Set(["openai-codex/gpt-5.4"]),
        registry: {
          getAll: () => [],
        },
      });
      mocks.loadModelCatalog.mockResolvedValueOnce([
        {
          provider: "openai-codex",
          id: "gpt-5.4",
          name: "GPT-5.3 Codex",
          input: ["text"],
          contextWindow: 400000,
        },
      ]);
      mocks.resolveModelWithRegistry.mockImplementation(
        ({ provider, modelId }: { provider: string; modelId: string }) => {
          if (provider !== "openai-codex") {
            return undefined;
          }
          if (modelId === "gpt-5.4") {
            return { ...OPENAI_CODEX_53_MODEL };
          }
          return undefined;
        },
      );
      mocks.resolveModelWithRegistry.mockImplementationOnce(
        ({ provider, modelId }: { provider: string; modelId: string }) =>
          provider === "openai-codex" && modelId === "gpt-5.4"
            ? { ...OPENAI_CODEX_53_MODEL }
            : undefined,
      );
      const rows = await buildAllOpenAiCodexRows();
      expect(rows).toEqual([
        expect.objectContaining({
          key: "openai-codex/gpt-5.4",
          available: true,
        }),
      ]);
    });

    it("uses provider runtime metadata for discovered codex gpt-5.5 rows", async () => {
      mocks.resolveConfiguredEntries.mockReturnValueOnce({ entries: [] });
      mocks.hasProviderStaticCatalogForFilter.mockResolvedValueOnce(true);
      mocks.loadModelRegistry.mockResolvedValueOnce({
        models: [
          {
            provider: "openai-codex",
            id: "gpt-5.5",
            name: "GPT-5.5",
            api: "openai-codex-responses",
            baseUrl: "https://chatgpt.com/backend-api",
            input: ["text", "image"],
            contextWindow: 272000,
            maxTokens: 128000,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
        availableKeys: new Set(["openai-codex/gpt-5.5"]),
        registry: {
          getAll: () => [
            {
              provider: "openai-codex",
              id: "gpt-5.5",
              name: "GPT-5.5",
              api: "openai-codex-responses",
              baseUrl: "https://chatgpt.com/backend-api",
              input: ["text", "image"],
              contextWindow: 272000,
              maxTokens: 128000,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      });
      mocks.resolveModelWithRegistry.mockImplementation(
        ({ provider, modelId }: { provider: string; modelId: string }) =>
          provider === "openai-codex" && modelId === "gpt-5.5"
            ? {
                provider: "openai-codex",
                id: "gpt-5.5",
                name: "GPT-5.5",
                api: "openai-codex-responses",
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
      await modelsListCommand(
        { all: true, provider: "openai-codex", json: true },
        runtime as never,
      );

      expect(
        lastPrintedRows<{ key: string; contextWindow: number; contextTokens?: number }>(),
      ).toEqual([
        expect.objectContaining({
          key: "openai-codex/gpt-5.5",
          contextWindow: 400000,
          contextTokens: 272000,
        }),
      ]);
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
          authIndex: { hasProviderAuth: () => false },
          availableKeys: new Set(["openai-codex/gpt-5.4"]),
          configuredByKey: new Map(),
          discoveredKeys: new Set(),
          filter: {},
        } as never,
      });

      expect(rows).toEqual([
        expect.objectContaining({
          key: "openai-codex/gpt-5.4",
        }),
      ]);
    });
  });

  describe("provider filter canonicalization", () => {
    it("matches alias-valued discovered providers against canonical provider filters", async () => {
      mocks.resolveConfiguredEntries.mockReturnValueOnce({ entries: [] });
      mocks.hasProviderStaticCatalogForFilter.mockResolvedValueOnce(true);
      mocks.loadModelRegistry.mockResolvedValueOnce({
        models: [
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
        availableKeys: new Set(["z.ai/glm-4.5"]),
        registry: {
          getAll: () => [
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
        },
      });

      const runtime = createRuntime();

      await modelsListCommand({ all: true, provider: "z-ai", json: true }, runtime as never);

      expect(mocks.printModelTable).toHaveBeenCalled();
      expect(lastPrintedRows<{ key: string }>()).toEqual([
        expect.objectContaining({
          key: "z.ai/glm-4.5",
        }),
      ]);
    });
  });
});
