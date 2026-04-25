import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let modelsListCommand: typeof import("./models/list.list-command.js").modelsListCommand;
let loadModelRegistry: typeof import("./models/list.registry.js").loadModelRegistry;
let toModelRow: typeof import("./models/list.registry.js").toModelRow;

const getRuntimeConfig = vi.fn();
const readConfigFileSnapshotForWrite = vi.fn().mockResolvedValue({
  snapshot: { valid: false, resolved: {} },
  writeOptions: {},
});
const setRuntimeConfigSnapshot = vi.fn();
const ensureOpenClawModelsJson = vi.fn().mockResolvedValue(undefined);
const resolveOpenClawAgentDir = vi.fn().mockReturnValue("/tmp/openclaw-agent");
const ensureAuthProfileStore = vi.fn().mockReturnValue({ version: 1, profiles: {} });
const listProfilesForProvider = vi.fn().mockReturnValue([]);
const resolveEnvApiKey = vi.fn().mockReturnValue(undefined);
const resolveAwsSdkEnvVarName = vi.fn().mockReturnValue(undefined);
const hasUsableCustomProviderApiKey = vi.fn().mockReturnValue(false);
const loadModelCatalog = vi.fn(async () => []);
const loadProviderCatalogModelsForList = vi.fn<() => Promise<Array<Record<string, unknown>>>>(
  async () => [],
);
const hasProviderStaticCatalogForFilter = vi.fn().mockResolvedValue(false);
const shouldSuppressBuiltInModel = vi.fn().mockReturnValue(false);
const modelRegistryState = {
  models: [] as Array<Record<string, unknown>>,
  available: [] as Array<Record<string, unknown>>,
  getAllError: undefined as unknown,
  getAvailableError: undefined as unknown,
  findError: undefined as unknown,
};
let previousExitCode: typeof process.exitCode;

vi.mock("./models/load-config.js", () => ({
  loadModelsConfigWithSource: vi.fn(async () => {
    const resolvedConfig = getRuntimeConfig();
    const sourceConfig = await loadSourceConfigSnapshotForTest(resolvedConfig);
    setRuntimeConfigSnapshot(resolvedConfig, sourceConfig);
    return {
      sourceConfig,
      resolvedConfig,
      diagnostics: [],
    };
  }),
}));

vi.mock("./models/list.runtime.js", () => {
  class MockModelRegistry {
    find(provider: string, id: string) {
      if (modelRegistryState.findError !== undefined) {
        throw modelRegistryState.findError;
      }
      return (
        modelRegistryState.models.find((model) => model.provider === provider && model.id === id) ??
        null
      );
    }

    getAll() {
      if (modelRegistryState.getAllError !== undefined) {
        throw modelRegistryState.getAllError;
      }
      return modelRegistryState.models;
    }

    getAvailable() {
      if (modelRegistryState.getAvailableError !== undefined) {
        throw modelRegistryState.getAvailableError;
      }
      return modelRegistryState.available;
    }

    hasConfiguredAuth(model: { provider: string; id: string }) {
      return modelRegistryState.available.some(
        (available) => available.provider === model.provider && available.id === model.id,
      );
    }
  }

  return {
    ensureAuthProfileStore,
    ensureOpenClawModelsJson,
    resolveOpenClawAgentDir,
    listProfilesForProvider,
    resolveEnvApiKey,
    resolveAwsSdkEnvVarName,
    hasUsableCustomProviderApiKey,
    hasProviderStaticCatalogForFilter,
    loadModelCatalog,
    loadProviderCatalogModelsForList,
    discoverAuthStorage: () => ({}) as unknown,
    discoverModels: () => new MockModelRegistry() as unknown,
    resolveModelWithRegistry: ({
      provider,
      modelId,
      modelRegistry,
    }: {
      provider: string;
      modelId: string;
      modelRegistry: { find: (provider: string, id: string) => unknown };
    }) => {
      return modelRegistry.find(provider, modelId);
    },
  };
});

vi.mock("./models/list.provider-catalog.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./models/list.provider-catalog.js")>();
  return {
    ...actual,
    hasProviderStaticCatalogForFilter,
  };
});

vi.mock("../agents/model-suppression.js", () => ({
  shouldSuppressBuiltInModel,
}));

function makeRuntime() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
}

function expectModelRegistryUnavailable(
  runtime: ReturnType<typeof makeRuntime>,
  expectedDetail: string,
) {
  expect(runtime.error).toHaveBeenCalledTimes(1);
  expect(runtime.error.mock.calls[0]?.[0]).toContain("Model registry unavailable:");
  expect(runtime.error.mock.calls[0]?.[0]).toContain(expectedDetail);
  expect(runtime.log).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(1);
}

async function loadSourceConfigSnapshotForTest(fallback: unknown): Promise<unknown> {
  try {
    const { snapshot } = await readConfigFileSnapshotForWrite();
    if (snapshot.valid) {
      return snapshot.sourceConfig;
    }
  } catch {
    // Match load-config: source snapshot is a best-effort write-preservation input.
  }
  return fallback;
}

beforeEach(() => {
  previousExitCode = process.exitCode;
  process.exitCode = undefined;
  modelRegistryState.getAllError = undefined;
  modelRegistryState.getAvailableError = undefined;
  modelRegistryState.findError = undefined;
  getRuntimeConfig.mockReset();
  getRuntimeConfig.mockReturnValue({});
  listProfilesForProvider.mockReturnValue([]);
  ensureOpenClawModelsJson.mockClear();
  loadModelCatalog.mockClear();
  loadModelCatalog.mockResolvedValue([]);
  loadProviderCatalogModelsForList.mockReset();
  loadProviderCatalogModelsForList.mockResolvedValue([]);
  hasProviderStaticCatalogForFilter.mockReset();
  hasProviderStaticCatalogForFilter.mockResolvedValue(false);
  shouldSuppressBuiltInModel.mockReset();
  shouldSuppressBuiltInModel.mockReturnValue(false);
  readConfigFileSnapshotForWrite.mockClear();
  readConfigFileSnapshotForWrite.mockResolvedValue({
    snapshot: { valid: false, resolved: {} },
    writeOptions: {},
  });
  setRuntimeConfigSnapshot.mockClear();
});

afterEach(() => {
  process.exitCode = previousExitCode;
});

describe("models list/status", () => {
  const ZAI_MODEL = {
    provider: "zai",
    id: "glm-4.7",
    name: "GLM-4.7",
    input: ["text"],
    baseUrl: "https://api.z.ai/v1",
    contextWindow: 128000,
  };
  const OPENAI_MODEL = {
    provider: "openai",
    id: "gpt-4.1-mini",
    name: "GPT-4.1 mini",
    input: ["text"],
    baseUrl: "https://api.openai.com/v1",
    contextWindow: 128000,
  };
  const OPENAI_SPARK_MODEL = {
    provider: "openai",
    id: "gpt-5.3-codex-spark",
    name: "GPT-5.3 Codex Spark",
    input: ["text", "image"],
    baseUrl: "https://api.openai.com/v1",
    contextWindow: 128000,
  };
  const MOONSHOT_MODEL = {
    provider: "moonshot",
    id: "kimi-k2.6",
    name: "Kimi K2.6",
    input: ["text", "image"],
    baseUrl: "https://api.moonshot.ai/v1",
    contextWindow: 262144,
  };
  const AZURE_OPENAI_SPARK_MODEL = {
    provider: "azure-openai-responses",
    id: "gpt-5.3-codex-spark",
    name: "GPT-5.3 Codex Spark",
    input: ["text", "image"],
    baseUrl: "https://example.openai.azure.com/openai/v1",
    contextWindow: 128000,
  };
  const GOOGLE_ANTIGRAVITY_TEMPLATE_BASE = {
    provider: "google-antigravity",
    api: "google-gemini-cli",
    input: ["text", "image"],
    baseUrl: "https://daily-cloudcode-pa.sandbox.googleapis.com",
    contextWindow: 200000,
    maxTokens: 64000,
    reasoning: true,
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  };

  function setDefaultModel(model: string) {
    getRuntimeConfig.mockReturnValue({
      agents: { defaults: { model } },
    });
  }

  function configureModelAsConfigured(model: string) {
    getRuntimeConfig.mockReturnValue({
      agents: {
        defaults: {
          model,
          models: {
            [model]: {},
          },
        },
      },
    });
  }

  function configureGoogleAntigravityModel(modelId: string) {
    configureModelAsConfigured(`google-antigravity/${modelId}`);
  }

  function makeGoogleAntigravityTemplate(id: string, name: string) {
    return {
      ...GOOGLE_ANTIGRAVITY_TEMPLATE_BASE,
      id,
      name,
    };
  }

  function enableGoogleAntigravityAuthProfile() {
    listProfilesForProvider.mockImplementation((_: unknown, provider: string) =>
      provider === "google-antigravity"
        ? ([{ id: "profile-1" }] as Array<Record<string, unknown>>)
        : [],
    );
  }

  function parseJsonLog(runtime: ReturnType<typeof makeRuntime>) {
    expect(runtime.log).toHaveBeenCalledTimes(1);
    return JSON.parse(String(runtime.log.mock.calls[0]?.[0]));
  }

  async function expectZaiProviderFilter(provider: string) {
    setDefaultZaiRegistry();
    const runtime = makeRuntime();

    await modelsListCommand({ all: true, provider, json: true }, runtime);

    const payload = parseJsonLog(runtime);
    expect(payload.count).toBe(1);
    expect(payload.models[0]?.key).toBe("zai/glm-4.7");
  }

  function setDefaultZaiRegistry(params: { available?: boolean } = {}) {
    const available = params.available ?? true;
    setDefaultModel("z.ai/glm-4.7");
    modelRegistryState.models = [ZAI_MODEL, OPENAI_MODEL];
    modelRegistryState.available = available ? [ZAI_MODEL, OPENAI_MODEL] : [];
  }

  beforeAll(async () => {
    ({ modelsListCommand } = await import("./models/list.list-command.js"));
    ({ loadModelRegistry, toModelRow } = await import("./models/list.registry.js"));
  });

  it("models list runs model discovery without auth.json sync", async () => {
    setDefaultZaiRegistry();
    const runtime = makeRuntime();

    await modelsListCommand({ all: true, json: true }, runtime);
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("models list outputs canonical zai key for configured z.ai model", async () => {
    setDefaultZaiRegistry();
    const runtime = makeRuntime();

    await modelsListCommand({ json: true }, runtime);

    const payload = parseJsonLog(runtime);
    expect(payload.models[0]?.key).toBe("zai/glm-4.7");
  });

  it("models list plain outputs canonical zai key", async () => {
    getRuntimeConfig.mockReturnValue({
      agents: { defaults: { model: "z.ai/glm-4.7" } },
    });
    const runtime = makeRuntime();

    modelRegistryState.models = [ZAI_MODEL];
    modelRegistryState.available = [ZAI_MODEL];
    await modelsListCommand({ plain: true }, runtime);

    expect(runtime.log).toHaveBeenCalledTimes(1);
    expect(runtime.log.mock.calls[0]?.[0]).toBe("zai/glm-4.7");
  });

  it("models list plain keeps canonical OpenRouter native ids", async () => {
    getRuntimeConfig.mockReturnValue({
      agents: { defaults: { model: "openrouter/hunter-alpha" } },
    });
    const runtime = makeRuntime();

    modelRegistryState.models = [
      {
        provider: "openrouter",
        id: "openrouter/hunter-alpha",
        name: "Hunter Alpha",
        input: ["text"],
        baseUrl: "https://openrouter.ai/api/v1",
        contextWindow: 1048576,
      },
    ];
    modelRegistryState.available = modelRegistryState.models;
    await modelsListCommand({ plain: true }, runtime);

    expect(runtime.log).toHaveBeenCalledTimes(1);
    expect(runtime.log.mock.calls[0]?.[0]).toBe("openrouter/hunter-alpha");
  });

  it.each(["z.ai", "Z.AI", "z-ai"] as const)(
    "models list provider filter normalizes %s alias",
    async (provider) => {
      await expectZaiProviderFilter(provider);
    },
  );

  it("models list marks auth as unavailable when ZAI key is missing", async () => {
    setDefaultZaiRegistry({ available: false });
    const runtime = makeRuntime();

    await modelsListCommand({ all: true, json: true }, runtime);

    const payload = parseJsonLog(runtime);
    expect(payload.models[0]?.available).toBe(false);
  });

  it("models list all includes unauthenticated provider catalog rows", async () => {
    setDefaultZaiRegistry({ available: false });
    hasProviderStaticCatalogForFilter.mockResolvedValueOnce(true);
    loadProviderCatalogModelsForList.mockResolvedValueOnce([MOONSHOT_MODEL]);
    const runtime = makeRuntime();

    await modelsListCommand({ all: true, provider: "moonshot", json: true }, runtime);

    const payload = parseJsonLog(runtime);
    expect(loadModelCatalog).not.toHaveBeenCalled();
    expect(payload.models).toEqual([
      expect.objectContaining({
        key: "moonshot/kimi-k2.6",
        name: "Kimi K2.6",
        available: false,
        missing: false,
      }),
    ]);
  });

  it("models list rejects provider display labels", async () => {
    setDefaultZaiRegistry({ available: false });
    const runtime = makeRuntime();

    await modelsListCommand({ all: true, provider: "Moonshot AI", json: true }, runtime);

    expect(runtime.error).toHaveBeenCalledWith(
      'Invalid provider filter "Moonshot AI". Use a provider id such as "moonshot", not a display label.',
    );
    expect(runtime.log).not.toHaveBeenCalled();
    expect(loadModelCatalog).not.toHaveBeenCalled();
    expect(loadProviderCatalogModelsForList).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("models list all local skips unauthenticated provider catalog rows", async () => {
    setDefaultZaiRegistry({ available: false });
    loadProviderCatalogModelsForList.mockResolvedValueOnce([MOONSHOT_MODEL]);
    const runtime = makeRuntime();

    await modelsListCommand({ all: true, local: true, json: true }, runtime);

    expect(loadProviderCatalogModelsForList).not.toHaveBeenCalled();
  });

  it("models list default does not enumerate all registry models", async () => {
    configureGoogleAntigravityModel("claude-opus-4-6-thinking");
    modelRegistryState.models = [
      makeGoogleAntigravityTemplate("claude-opus-4-6-thinking", "Claude Opus 4.6 Thinking"),
    ];
    modelRegistryState.available = modelRegistryState.models;
    modelRegistryState.getAllError = Object.assign(new Error("model discovery failed"), {
      code: "MODEL_AVAILABILITY_UNAVAILABLE",
    });
    const runtime = makeRuntime();
    await modelsListCommand({ json: true }, runtime);

    expect(runtime.error).not.toHaveBeenCalled();
    const payload = parseJsonLog(runtime);
    expect(payload.models[0]?.key).toBe("google-antigravity/claude-opus-4-6-thinking");
  });

  it("models list fails fast when configured registry lookup is unavailable", async () => {
    configureGoogleAntigravityModel("claude-opus-4-6-thinking");
    enableGoogleAntigravityAuthProfile();
    modelRegistryState.findError = Object.assign(new Error("model discovery unavailable"), {
      code: "MODEL_DISCOVERY_UNAVAILABLE",
    });
    const runtime = makeRuntime();

    modelRegistryState.models = [];
    modelRegistryState.available = [];
    await modelsListCommand({ json: true }, runtime);

    expectModelRegistryUnavailable(runtime, "model discovery unavailable");
  });

  it("loadModelRegistry throws when model discovery is unavailable", async () => {
    modelRegistryState.getAllError = Object.assign(new Error("model discovery unavailable"), {
      code: "MODEL_DISCOVERY_UNAVAILABLE",
    });
    modelRegistryState.available = [
      makeGoogleAntigravityTemplate("claude-opus-4-6-thinking", "Claude Opus 4.5 Thinking"),
    ];

    await expect(loadModelRegistry({})).rejects.toThrow("model discovery unavailable");
  });

  it("loadModelRegistry does not persist models.json as a side effect", async () => {
    modelRegistryState.models = [OPENAI_MODEL];
    modelRegistryState.available = [OPENAI_MODEL];
    const resolvedConfig = {
      models: { providers: { openai: { apiKey: "sk-resolved-runtime-value" } } }, // pragma: allowlist secret
    };

    await loadModelRegistry(resolvedConfig as never);

    expect(ensureOpenClawModelsJson).not.toHaveBeenCalled();
  });

  it("filters stale spark rows from models list and registry views", async () => {
    shouldSuppressBuiltInModel.mockImplementation(
      ({ provider, id }: { provider?: string | null; id?: string | null }) =>
        id === "gpt-5.3-codex-spark" &&
        (provider === "openai" ||
          provider === "azure-openai-responses" ||
          provider === "openai-codex"),
    );
    setDefaultModel("openai/gpt-5.5");
    modelRegistryState.models = [OPENAI_MODEL, OPENAI_SPARK_MODEL, AZURE_OPENAI_SPARK_MODEL];
    modelRegistryState.available = [OPENAI_MODEL, OPENAI_SPARK_MODEL, AZURE_OPENAI_SPARK_MODEL];
    const runtime = makeRuntime();

    await modelsListCommand({ all: true, json: true }, runtime);

    const payload = parseJsonLog(runtime);
    expect(payload.models.map((model: { key: string }) => model.key)).toEqual([
      "openai/gpt-4.1-mini",
    ]);

    const loaded = await loadModelRegistry({} as never);
    expect(loaded.models.map((model) => `${model.provider}/${model.id}`)).toEqual([
      "openai/gpt-4.1-mini",
    ]);
    expect(Array.from(loaded.availableKeys ?? [])).toEqual(["openai/gpt-4.1-mini"]);
  });

  it("modelsListCommand lists source snapshot provider models without persisting models.json", async () => {
    modelRegistryState.models = [];
    modelRegistryState.available = [];
    const sourceConfig = {
      models: {
        providers: {
          "custom-proxy": {
            api: "openai-responses",
            baseUrl: "https://custom.example/v1",
            apiKey: "$CUSTOM_PROXY_API_KEY",
            models: [
              {
                id: "custom-model",
                name: "Custom Model",
                input: ["text"],
                contextWindow: 128000,
              },
            ],
          },
        },
      },
    };
    const resolvedConfig = {
      models: {
        providers: {
          "custom-proxy": {
            api: "openai-responses",
            baseUrl: "https://custom.example/v1",
            apiKey: "sk-resolved-runtime-value", // pragma: allowlist secret
            models: [
              {
                id: "custom-model",
                name: "Custom Model",
                input: ["text"],
                contextWindow: 128000,
              },
            ],
          },
        },
      },
    };
    readConfigFileSnapshotForWrite.mockResolvedValue({
      snapshot: { valid: true, resolved: resolvedConfig, sourceConfig },
      writeOptions: {},
    });
    getRuntimeConfig.mockReturnValue(resolvedConfig);
    const runtime = makeRuntime();

    await modelsListCommand({ all: true, json: true }, runtime);

    expect(ensureOpenClawModelsJson).not.toHaveBeenCalled();
    const payload = parseJsonLog(runtime);
    expect(payload.models).toEqual([
      expect.objectContaining({
        key: "custom-proxy/custom-model",
        name: "Custom Model",
        missing: false,
      }),
    ]);
  });

  it("toModelRow does not crash without cfg/authStore when availability is undefined", async () => {
    const row = toModelRow({
      model: makeGoogleAntigravityTemplate(
        "claude-opus-4-6-thinking",
        "Claude Opus 4.6 Thinking",
      ) as never,
      key: "google-antigravity/claude-opus-4-6-thinking",
      tags: [],
      availableKeys: undefined,
    });

    expect(row.missing).toBe(false);
    expect(row.available).toBe(false);
  });
});
