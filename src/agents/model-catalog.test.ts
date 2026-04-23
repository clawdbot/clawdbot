import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resetLogger, setLoggerOverride } from "../logging/logger.js";

type PiSdkModule = typeof import("./pi-model-discovery.js");

let __setModelCatalogImportForTest: typeof import("./model-catalog.js").__setModelCatalogImportForTest;
let findModelInCatalog: typeof import("./model-catalog.js").findModelInCatalog;
let loadModelCatalog: typeof import("./model-catalog.js").loadModelCatalog;
let resetModelCatalogCacheForTest: typeof import("./model-catalog.js").resetModelCatalogCacheForTest;
let augmentCatalogMock: ReturnType<typeof vi.fn>;

vi.mock("./model-suppression.runtime.js", () => ({
  shouldSuppressBuiltInModel: (params: { provider?: string; id?: string }) =>
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

describe("loadModelCatalog", () => {
  beforeAll(async () => {
    vi.doMock("./models-config.js", () => ({
      ensureOpenClawModelsJson: vi.fn().mockResolvedValue({ agentDir: "/tmp", wrote: false }),
    }));
    vi.doMock("./agent-paths.js", () => ({
      resolveOpenClawAgentDir: () => "/tmp/openclaw",
    }));
    vi.doMock("../plugins/provider-runtime.runtime.js", () => ({
      augmentModelCatalogWithProviderPlugins: vi.fn().mockResolvedValue([]),
    }));

    ({
      __setModelCatalogImportForTest,
      findModelInCatalog,
      loadModelCatalog,
      resetModelCatalogCacheForTest,
    } = await import("./model-catalog.js"));
    const providerRuntime = await import("../plugins/provider-runtime.runtime.js");
    augmentCatalogMock = vi.mocked(providerRuntime.augmentModelCatalogWithProviderPlugins);
  });

  beforeEach(() => {
    resetModelCatalogCacheForTest();
  });

  afterEach(() => {
    __setModelCatalogImportForTest();
    resetModelCatalogCacheForTest();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    vi.doUnmock("./models-config.js");
    vi.doUnmock("./agent-paths.js");
    vi.doUnmock("../plugins/provider-runtime.runtime.js");
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
});
