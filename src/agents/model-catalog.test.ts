import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resetLogger, setLoggerOverride } from "../logging/logger.js";

type PiSdkModule = typeof import("./pi-model-discovery.js");

let __setModelCatalogImportForTest: typeof import("./model-catalog.js").__setModelCatalogImportForTest;
let findModelCatalogEntry: typeof import("./model-catalog.js").findModelCatalogEntry;
let findModelInCatalog: typeof import("./model-catalog.js").findModelInCatalog;
let loadManifestModelCatalog: typeof import("./model-catalog.js").loadManifestModelCatalog;
let loadModelCatalog: typeof import("./model-catalog.js").loadModelCatalog;
let modelSupportsInput: typeof import("./model-catalog.js").modelSupportsInput;
let resetModelCatalogCacheForTest: typeof import("./model-catalog.js").resetModelCatalogCacheForTest;
let augmentCatalogMock: ReturnType<typeof vi.fn>;
let ensureOpenClawModelsJsonMock: ReturnType<typeof vi.fn>;
let currentPluginMetadataSnapshotMock: ReturnType<typeof vi.fn>;
let loadPluginMetadataSnapshotMock: ReturnType<typeof vi.fn>;
let readFileMock: ReturnType<typeof vi.fn>;

vi.mock("./model-suppression.runtime.js", () => ({
  shouldSuppressBuiltInModel: (params: { provider?: string; id?: string }) =>
    (params.provider === "openai" ||
      params.provider === "azure-openai-responses" ||
      params.provider === "openai-codex") &&
    params.id === "gpt-5.3-codex-spark",
  buildShouldSuppressBuiltInModel: () => (params: { provider?: string; id?: string }) =>
    (params.provider === "openai" ||
      params.provider === "azure-openai-responses" ||
      params.provider === "openai-codex") &&
    params.id === "gpt-5.3-codex-spark",
}));

function mockCatalogImportFailThenRecover() {
  let call = 0;
  __setModelCatalogImportForTest(async () => {
    call += 1;
    if (call === 1) {
      throw new Error("boom");
    }
    return {
      discoverAuthStorage: () => ({}),
      AuthStorage: function AuthStorage() {},
      ModelRegistry: class {
        getAll() {
          return [{ id: "gpt-4.1", name: "GPT-4.1", provider: "openai" }];
        }
      },
    } as unknown as PiSdkModule;
  });
  return () => call;
}

function mockPiDiscoveryModels(models: unknown[]) {
  __setModelCatalogImportForTest(
    async () =>
      ({
        discoverAuthStorage: () => ({}),
        AuthStorage: function AuthStorage() {},
        ModelRegistry: class {
          getAll() {
            return models;
          }
        },
      }) as unknown as PiSdkModule,
  );
}

function mockSingleOpenAiCatalogModel() {
  mockPiDiscoveryModels([{ id: "gpt-4.1", provider: "openai", name: "GPT-4.1" }]);
}

function emptyPluginMetadataSnapshot() {
  return {
    policyHash: "test-policy",
    configFingerprint: "test-config",
    index: {
      policyHash: "test-policy",
      plugins: [],
    },
    plugins: [],
  };
}

describe("loadModelCatalog", () => {
  beforeAll(async () => {
    readFileMock = vi.fn();
    vi.doMock("node:fs/promises", async (importOriginal) => ({
      ...(await importOriginal<typeof import("node:fs/promises")>()),
      readFile: readFileMock,
    }));
    ensureOpenClawModelsJsonMock = vi.fn().mockResolvedValue({ agentDir: "/tmp", wrote: false });
    vi.doMock("./models-config.js", () => ({
      ensureOpenClawModelsJson: ensureOpenClawModelsJsonMock,
    }));
    vi.doMock("./agent-paths.js", () => ({
      resolveOpenClawAgentDir: () => "/tmp/openclaw",
    }));
    vi.doMock("../plugins/provider-runtime.runtime.js", () => ({
      augmentModelCatalogWithProviderPlugins: vi.fn().mockResolvedValue([]),
    }));
    currentPluginMetadataSnapshotMock = vi.fn();
    loadPluginMetadataSnapshotMock = vi.fn();
    vi.doMock("../plugins/current-plugin-metadata-snapshot.js", () => ({
      getCurrentPluginMetadataSnapshot: currentPluginMetadataSnapshotMock,
    }));
    vi.doMock("../plugins/plugin-metadata-snapshot.js", () => ({
      loadPluginMetadataSnapshot: loadPluginMetadataSnapshotMock,
    }));

    ({
      __setModelCatalogImportForTest,
      findModelCatalogEntry,
      findModelInCatalog,
      loadManifestModelCatalog,
      loadModelCatalog,
      modelSupportsInput,
      resetModelCatalogCacheForTest,
    } = await import("./model-catalog.js"));
    const providerRuntime = await import("../plugins/provider-runtime.runtime.js");
    augmentCatalogMock = vi.mocked(providerRuntime.augmentModelCatalogWithProviderPlugins);
  });

  beforeEach(() => {
    resetModelCatalogCacheForTest();
    readFileMock.mockReset();
    readFileMock.mockRejectedValue(
      Object.assign(new Error("models.json missing"), { code: "ENOENT" }),
    );
    ensureOpenClawModelsJsonMock.mockClear();
    augmentCatalogMock.mockClear();
    currentPluginMetadataSnapshotMock.mockReset();
    currentPluginMetadataSnapshotMock.mockReturnValue(emptyPluginMetadataSnapshot());
    loadPluginMetadataSnapshotMock.mockReset();
    loadPluginMetadataSnapshotMock.mockReturnValue(emptyPluginMetadataSnapshot());
  });

  afterEach(() => {
    __setModelCatalogImportForTest();
    resetModelCatalogCacheForTest();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    vi.doUnmock("node:fs/promises");
    vi.doUnmock("./models-config.js");
    vi.doUnmock("./agent-paths.js");
    vi.doUnmock("../plugins/provider-runtime.runtime.js");
    vi.doUnmock("../plugins/current-plugin-metadata-snapshot.js");
    vi.doUnmock("../plugins/plugin-metadata-snapshot.js");
  });

  it("retries after import failure without poisoning the cache", async () => {
    setLoggerOverride({ level: "silent", consoleLevel: "warn" });
    try {
      const getCallCount = mockCatalogImportFailThenRecover();

      const cfg = {} as OpenClawConfig;
      const first = await loadModelCatalog({ config: cfg });
      expect(first).toEqual([]);

      const second = await loadModelCatalog({ config: cfg });
      expect(second).toEqual([{ id: "gpt-4.1", name: "GPT-4.1", provider: "openai" }]);
      expect(getCallCount()).toBe(2);
    } finally {
      setLoggerOverride(null);
      resetLogger();
    }
  });

  it("reloads dynamic registry entries after clearing the cache", async () => {
    const models = [{ id: "existing", name: "Existing", provider: "ollama" }];
    mockPiDiscoveryModels(models);

    const first = await loadModelCatalog({ config: {} as OpenClawConfig });
    expect(first).toContainEqual({ id: "existing", name: "Existing", provider: "ollama" });

    models.push({ id: "glm-5.1:cloud", name: "GLM 5.1 Cloud", provider: "ollama" });
    resetModelCatalogCacheForTest();
    mockPiDiscoveryModels(models);

    const second = await loadModelCatalog({ config: {} as OpenClawConfig });
    expect(second).toContainEqual({ id: "existing", name: "Existing", provider: "ollama" });
    expect(second).toContainEqual({
      id: "glm-5.1:cloud",
      name: "GLM 5.1 Cloud",
      provider: "ollama",
    });
  });

  it("returns partial results on discovery errors", async () => {
    setLoggerOverride({ level: "silent", consoleLevel: "warn" });
    try {
      __setModelCatalogImportForTest(
        async () =>
          ({
            discoverAuthStorage: () => ({}),
            AuthStorage: function AuthStorage() {},
            ModelRegistry: class {
              getAll() {
                return [
                  { id: "gpt-4.1", name: "GPT-4.1", provider: "openai" },
                  {
                    get id() {
                      throw new Error("boom");
                    },
                    provider: "openai",
                    name: "bad",
                  },
                ];
              }
            },
          }) as unknown as PiSdkModule,
      );

      const result = await loadModelCatalog({ config: {} as OpenClawConfig });
      expect(result).toEqual([{ id: "gpt-4.1", name: "GPT-4.1", provider: "openai" }]);
    } finally {
      setLoggerOverride(null);
      resetLogger();
    }
  });

  it("does not prepare models.json or import provider discovery when loading fallback catalog in read-only mode", async () => {
    const importPiSdk = vi.fn(async () => {
      throw new Error("provider discovery should not load");
    });
    __setModelCatalogImportForTest(importPiSdk as unknown as () => Promise<PiSdkModule>);
    currentPluginMetadataSnapshotMock.mockReturnValueOnce(undefined);
    loadPluginMetadataSnapshotMock.mockImplementationOnce(() => {
      throw new Error("metadata scan should not run");
    });

    const result = await loadModelCatalog({
      config: {
        models: {
          providers: {
            openai: {
              baseUrl: "https://openai.example.com/v1",
              models: [
                {
                  id: "gpt-test",
                  name: "GPT Test",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 200_000,
                  maxTokens: 8192,
                },
              ],
            },
          },
        },
      } as OpenClawConfig,
      readOnly: true,
    });

    expect(result).toContainEqual(
      expect.objectContaining({ id: "gpt-test", name: "GPT Test", provider: "openai" }),
    );
    expect(ensureOpenClawModelsJsonMock).not.toHaveBeenCalled();
    expect(importPiSdk).not.toHaveBeenCalled();
    expect(loadPluginMetadataSnapshotMock).not.toHaveBeenCalled();
  });

  it("filters suppressed built-ins from persisted read-only catalog rows", async () => {
    readFileMock.mockResolvedValueOnce(
      JSON.stringify({
        providers: {
          "openai-codex": {
            models: [
              {
                id: "gpt-5.3-codex-spark",
                name: "GPT-5.3 Codex Spark",
                reasoning: true,
                contextWindow: 128000,
                input: ["text"],
              },
              {
                id: "gpt-5.4",
                name: "GPT-5.4",
                reasoning: true,
                contextWindow: 272000,
                input: ["text", "image"],
              },
            ],
          },
          openai: {
            models: [
              {
                id: "gpt-5.3-codex-spark",
                name: "GPT-5.3 Codex Spark",
              },
            ],
          },
        },
      }),
    );

    const result = await loadModelCatalog({ config: {} as OpenClawConfig, readOnly: true });

    expect(result).toEqual([
      {
        provider: "openai-codex",
        id: "gpt-5.4",
        name: "GPT-5.4",
        reasoning: true,
        contextWindow: 272000,
        input: ["text", "image"],
        compat: undefined,
      },
    ]);
    expect(ensureOpenClawModelsJsonMock).not.toHaveBeenCalled();
    expect(augmentCatalogMock).not.toHaveBeenCalled();
  });

  it("falls back to manifest catalog rows when persisted read-only catalog has no model rows", async () => {
    readFileMock.mockResolvedValueOnce(
      JSON.stringify({
        providers: {
          openai: {
            modelOverrides: {
              "gpt-4.1": {
                contextWindow: 128000,
              },
            },
          },
        },
      }),
    );
    currentPluginMetadataSnapshotMock.mockReturnValueOnce({
      policyHash: "policy",
      index: {
        policyHash: "policy",
        plugins: [
          {
            pluginId: "external-provider",
            enabled: true,
            origin: "global",
          },
        ],
      },
      plugins: [
        {
          id: "external-provider",
          origin: "global",
          modelCatalog: {
            providers: {
              external: {
                models: [{ id: "external-fast", name: "External Fast" }],
              },
            },
          },
        },
      ],
    });
    const importPiSdk = vi.fn(async () => {
      throw new Error("provider discovery should not load");
    });
    __setModelCatalogImportForTest(importPiSdk as unknown as () => Promise<PiSdkModule>);

    const result = await loadModelCatalog({ config: {} as OpenClawConfig, readOnly: true });

    expect(result).toEqual([
      {
        provider: "external",
        id: "external-fast",
        name: "External Fast",
        input: ["text"],
        reasoning: false,
      },
    ]);
    expect(ensureOpenClawModelsJsonMock).not.toHaveBeenCalled();
    expect(importPiSdk).not.toHaveBeenCalled();
  });

  it("preserves registry defaults for minimal persisted read-only catalog rows", async () => {
    readFileMock.mockResolvedValueOnce(
      JSON.stringify({
        providers: {
          custom: {
            models: [{ id: "local-tiny" }],
          },
        },
      }),
    );

    const result = await loadModelCatalog({ config: {} as OpenClawConfig, readOnly: true });

    expect(result).toEqual([
      {
        provider: "custom",
        id: "local-tiny",
        name: "local-tiny",
        reasoning: false,
        contextWindow: 128000,
        input: ["text"],
        compat: undefined,
      },
    ]);
    expect(ensureOpenClawModelsJsonMock).not.toHaveBeenCalled();
    expect(augmentCatalogMock).not.toHaveBeenCalled();
  });

  it("preserves provider context defaults for persisted read-only catalog rows", async () => {
    readFileMock.mockResolvedValueOnce(
      JSON.stringify({
        providers: {
          custom: {
            contextWindow: 262144,
            models: [
              { id: "inherits-provider-context" },
              { id: "overrides-context", contextWindow: 65536 },
            ],
          },
        },
      }),
    );

    const result = await loadModelCatalog({ config: {} as OpenClawConfig, readOnly: true });

    expect(result).toEqual([
      {
        provider: "custom",
        id: "inherits-provider-context",
        name: "inherits-provider-context",
        reasoning: false,
        contextWindow: 262144,
        input: ["text"],
        compat: undefined,
      },
      {
        provider: "custom",
        id: "overrides-context",
        name: "overrides-context",
        reasoning: false,
        contextWindow: 65536,
        input: ["text"],
        compat: undefined,
      },
    ]);
    expect(ensureOpenClawModelsJsonMock).not.toHaveBeenCalled();
    expect(augmentCatalogMock).not.toHaveBeenCalled();
  });

  it("does not synthesize stale openai-codex/gpt-5.3-codex-spark entries from gpt-5.4", async () => {
    mockPiDiscoveryModels([
      {
        id: "gpt-5.4",
        provider: "openai-codex",
        name: "GPT-5.3 Codex",
        reasoning: true,
        contextWindow: 200000,
        input: ["text"],
      },
      {
        id: "gpt-5.2-codex",
        provider: "openai-codex",
        name: "GPT-5.2 Codex",
      },
    ]);

    const result = await loadModelCatalog({ config: {} as OpenClawConfig });
    expect(result).not.toContainEqual(
      expect.objectContaining({
        provider: "openai-codex",
        id: "gpt-5.3-codex-spark",
      }),
    );
    expect(result).toContainEqual(
      expect.objectContaining({
        provider: "openai-codex",
        id: "gpt-5.4",
        name: "GPT-5.3 Codex",
      }),
    );
  });

  it("filters stale gpt-5.3-codex-spark built-ins from the catalog", async () => {
    mockPiDiscoveryModels([
      {
        id: "gpt-5.3-codex-spark",
        provider: "openai",
        name: "GPT-5.3 Codex Spark",
        reasoning: true,
        contextWindow: 128000,
        input: ["text", "image"],
      },
      {
        id: "gpt-5.3-codex-spark",
        provider: "azure-openai-responses",
        name: "GPT-5.3 Codex Spark",
        reasoning: true,
        contextWindow: 128000,
        input: ["text", "image"],
      },
      {
        id: "gpt-5.3-codex-spark",
        provider: "openai-codex",
        name: "GPT-5.3 Codex Spark",
        reasoning: true,
        contextWindow: 128000,
        input: ["text"],
      },
    ]);

    const result = await loadModelCatalog({ config: {} as OpenClawConfig });
    expect(result).not.toContainEqual(
      expect.objectContaining({
        provider: "openai",
        id: "gpt-5.3-codex-spark",
      }),
    );
    expect(result).not.toContainEqual(
      expect.objectContaining({
        provider: "azure-openai-responses",
        id: "gpt-5.3-codex-spark",
      }),
    );
    expect(result).not.toContainEqual(
      expect.objectContaining({
        provider: "openai-codex",
        id: "gpt-5.3-codex-spark",
      }),
    );
  });

  it("does not synthesize gpt-5.4 OpenAI forward-compat entries from template models", async () => {
    mockPiDiscoveryModels([
      {
        id: "gpt-5.2",
        provider: "openai",
        name: "GPT-5.2",
        reasoning: true,
        contextWindow: 1_050_000,
        input: ["text", "image"],
      },
      {
        id: "gpt-5.2-pro",
        provider: "openai",
        name: "GPT-5.2 Pro",
        reasoning: true,
        contextWindow: 1_050_000,
        input: ["text", "image"],
      },
      {
        id: "gpt-5-mini",
        provider: "openai",
        name: "GPT-5 mini",
        reasoning: true,
        contextWindow: 400_000,
        input: ["text", "image"],
      },
      {
        id: "gpt-5-nano",
        provider: "openai",
        name: "GPT-5 nano",
        reasoning: true,
        contextWindow: 400_000,
        input: ["text", "image"],
      },
      {
        id: "gpt-5.4",
        provider: "openai-codex",
        name: "GPT-5.3 Codex",
        reasoning: true,
        contextWindow: 272000,
        input: ["text", "image"],
      },
    ]);

    const result = await loadModelCatalog({ config: {} as OpenClawConfig });

    expect(
      result.some((entry) => entry.provider === "openai" && entry.id.startsWith("gpt-5.4")),
    ).toBe(false);
    expect(result).toContainEqual(
      expect.objectContaining({
        provider: "openai-codex",
        id: "gpt-5.4",
        name: "GPT-5.3 Codex",
      }),
    );
    expect(
      result.some((entry) => entry.provider === "openai-codex" && entry.id === "gpt-5.4-mini"),
    ).toBe(false);
  });

  it("merges provider-owned supplemental catalog entries", async () => {
    mockSingleOpenAiCatalogModel();
    augmentCatalogMock.mockResolvedValueOnce([
      {
        provider: "kilocode",
        id: "google/gemini-3-pro-preview",
        name: "Gemini 3 Pro Preview",
        input: ["text", "image"],
        reasoning: true,
        contextWindow: 1048576,
      },
    ]);

    const result = await loadModelCatalog({ config: {} as OpenClawConfig });

    expect(result).toContainEqual(
      expect.objectContaining({
        provider: "kilocode",
        id: "google/gemini-3-pro-preview",
        name: "Gemini 3 Pro Preview",
      }),
    );
  });

  it("loads manifest catalog rows from the current metadata snapshot without provider runtime", () => {
    const snapshot = {
      policyHash: "policy",
      index: {
        policyHash: "policy",
        plugins: [
          {
            pluginId: "external-provider",
            enabled: true,
            origin: "global",
          },
        ],
      },
      plugins: [
        {
          id: "external-provider",
          origin: "global",
          modelCatalog: {
            providers: {
              external: {
                models: [
                  {
                    id: "external-fast",
                    name: "External Fast",
                    input: ["text", "image"],
                    reasoning: true,
                    contextWindow: 32000,
                  },
                ],
              },
            },
          },
        },
      ],
    };
    currentPluginMetadataSnapshotMock.mockReturnValue(snapshot);

    const result = loadManifestModelCatalog({ config: {} as OpenClawConfig });

    expect(loadPluginMetadataSnapshotMock).not.toHaveBeenCalled();
    expect(augmentCatalogMock).not.toHaveBeenCalled();
    expect(result).toEqual([
      {
        provider: "external",
        id: "external-fast",
        name: "External Fast",
        input: ["text", "image"],
        reasoning: true,
        contextWindow: 32000,
      },
    ]);
  });

  it("dedupes supplemental models against registry entries", async () => {
    mockSingleOpenAiCatalogModel();
    augmentCatalogMock.mockResolvedValueOnce([
      {
        provider: "ollama",
        id: "llama3.2",
        name: "Llama 3.2",
        reasoning: true,
        input: ["text"],
        contextWindow: 1048576,
      },
      {
        provider: "openai",
        id: "gpt-4.1",
        name: "Duplicate GPT-4.1",
      },
    ]);

    const result = await loadModelCatalog({ config: {} as OpenClawConfig });

    expect(result).toContainEqual(
      expect.objectContaining({ provider: "ollama", id: "llama3.2", name: "Llama 3.2" }),
    );
    expect(
      result.filter((entry) => entry.provider === "openai" && entry.id === "gpt-4.1"),
    ).toHaveLength(1);
  });

  it("includes configured provider models missing from discovery", async () => {
    mockSingleOpenAiCatalogModel();

    const result = await loadModelCatalog({
      config: {
        models: {
          providers: {
            modelscope: {
              baseUrl: "https://api-inference.modelscope.cn/v1",
              models: [
                {
                  id: "Qwen/Qwen3.5-35B-A3B",
                  name: "Qwen3.5 35B",
                  input: ["text", "image"],
                  reasoning: true,
                  contextWindow: 128_000,
                  maxTokens: 8192,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                },
              ],
            },
          },
        },
      } as OpenClawConfig,
    });

    expect(result).toContainEqual(
      expect.objectContaining({
        provider: "modelscope",
        id: "Qwen/Qwen3.5-35B-A3B",
        name: "Qwen3.5 35B",
        input: ["text", "image"],
        reasoning: true,
        contextWindow: 128_000,
      }),
    );
  });

  it("dedupes configured models against discovered provider aliases", async () => {
    mockPiDiscoveryModels([{ id: "glm-5", provider: "z.ai", name: "GLM-5" }]);

    const result = await loadModelCatalog({
      config: {
        models: {
          providers: {
            "z-ai": {
              baseUrl: "https://api.z.ai/v1",
              models: [
                {
                  id: "glm-5",
                  name: "Configured GLM-5",
                  input: ["text", "image"],
                  reasoning: false,
                  contextWindow: 128_000,
                  maxTokens: 8192,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                },
              ],
            },
          },
        },
      } as OpenClawConfig,
    });

    const matches = result.filter((entry) => findModelInCatalog([entry], "z-ai", "glm-5"));
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ provider: "z.ai", id: "glm-5", name: "GLM-5" });
  });

  it("does not add unrelated models when provider plugins return nothing", async () => {
    mockSingleOpenAiCatalogModel();

    const result = await loadModelCatalog({ config: {} as OpenClawConfig });

    expect(
      result.some((entry) => entry.provider === "qianfan" && entry.id === "deepseek-v3.2"),
    ).toBe(false);
  });

  it("does not duplicate provider-owned supplemental models already present in ModelRegistry", async () => {
    mockPiDiscoveryModels([
      {
        id: "kilo/auto",
        provider: "kilocode",
        name: "Kilo Auto",
      },
    ]);
    augmentCatalogMock.mockResolvedValueOnce([
      {
        provider: "kilocode",
        id: "kilo/auto",
        name: "Configured Kilo Auto",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 1000000,
      },
    ]);

    const result = await loadModelCatalog({ config: {} as OpenClawConfig });

    const matches = result.filter(
      (entry) => entry.provider === "kilocode" && entry.id === "kilo/auto",
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]?.name).toBe("Kilo Auto");
  });

  it("matches models across canonical provider aliases", () => {
    expect(
      findModelInCatalog([{ provider: "z.ai", id: "glm-5", name: "GLM-5" }], "z-ai", "glm-5"),
    ).toEqual({
      provider: "z.ai",
      id: "glm-5",
      name: "GLM-5",
    });
  });

  it("resolves catalog entries with explicit providers and unique providerless matches", () => {
    const catalog = [
      { provider: "first", id: "shared", name: "First", input: ["text"] },
      { provider: "second", id: "shared", name: "Second", input: ["text", "image"] },
      { provider: "modelscope", id: "qwen/qwen3.5-35b-a3b", name: "Qwen", input: ["text"] },
    ] satisfies Awaited<ReturnType<typeof loadModelCatalog>>;

    expect(findModelCatalogEntry(catalog, { provider: "second", modelId: "SHARED" })).toEqual(
      catalog[1],
    );
    expect(
      findModelCatalogEntry(catalog, { provider: "modelscope", modelId: "Qwen/Qwen3.5-35B-A3B" }),
    ).toEqual(catalog[2]);
    expect(findModelCatalogEntry(catalog, { modelId: "shared" })).toBeUndefined();
    expect(findModelCatalogEntry(catalog, { modelId: "Qwen/Qwen3.5-35B-A3B" })).toEqual(catalog[2]);
    expect(modelSupportsInput(catalog[1], "image")).toBe(true);
    expect(modelSupportsInput(catalog[2], "image")).toBe(false);
  });
});
