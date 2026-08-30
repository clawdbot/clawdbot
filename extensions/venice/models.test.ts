// Venice tests cover models plugin behavior.
import {
  buildOpenAICompatibleLiveModelProviderConfig,
  clearLiveCatalogCacheForTests,
} from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VENICE_BASE_URL, VENICE_MODEL_CATALOG, VENICE_MODEL_DISCOVERY_OPTIONS } from "./models.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_VITEST = process.env.VITEST;

function restoreDiscoveryEnv(): void {
  if (ORIGINAL_NODE_ENV === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  }

  if (ORIGINAL_VITEST === undefined) {
    delete process.env.VITEST;
  } else {
    process.env.VITEST = ORIGINAL_VITEST;
  }
}

async function runWithDiscoveryEnabled<T>(operation: () => Promise<T>): Promise<T> {
  process.env.NODE_ENV = "development";
  delete process.env.VITEST;
  try {
    return await operation();
  } finally {
    restoreDiscoveryEnv();
  }
}

function makeModelsResponse(id: string): Response {
  return new Response(
    JSON.stringify({
      data: [
        {
          id,
          model_spec: {
            name: id,
            privacy: "private",
            availableContextTokens: 131072,
            maxCompletionTokens: 4096,
            capabilities: {
              supportsReasoning: false,
              supportsVision: false,
              supportsFunctionCalling: true,
            },
          },
        },
      ],
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
}

type ModelSpecOverride = {
  id: string;
  availableContextTokens?: number;
  maxCompletionTokens?: number;
  capabilities?: {
    supportsReasoning?: boolean;
    supportsVision?: boolean;
    supportsFunctionCalling?: boolean;
  };
  includeModelSpec?: boolean;
};

function makeModelRow(params: ModelSpecOverride) {
  if (params.includeModelSpec === false) {
    return { id: params.id };
  }
  return {
    id: params.id,
    model_spec: {
      name: params.id,
      privacy: "private",
      ...(params.availableContextTokens === undefined
        ? {}
        : { availableContextTokens: params.availableContextTokens }),
      ...(params.maxCompletionTokens === undefined
        ? {}
        : { maxCompletionTokens: params.maxCompletionTokens }),
      ...(params.capabilities === undefined ? {} : { capabilities: params.capabilities }),
    },
  };
}

function stubVeniceModelsFetch(rows: ModelSpecOverride[]) {
  const fetchMock = vi.fn(
    async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          data: rows.map((row) => makeModelRow(row)),
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
  );
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
  return fetchMock;
}

async function discoverVeniceModels() {
  const provider = await buildOpenAICompatibleLiveModelProviderConfig({
    providerId: "venice",
    providerConfig: {
      baseUrl: VENICE_BASE_URL,
      api: "openai-completions",
      models: structuredClone(VENICE_MODEL_CATALOG),
    },
    modelDiscovery: VENICE_MODEL_DISCOVERY_OPTIONS,
  });
  return provider.models;
}

describe("venice-models", () => {
  afterEach(() => {
    clearLiveCatalogCacheForTests();
    vi.unstubAllGlobals();
    restoreDiscoveryEnv();
  });

  it("excludes stale models from the static fallback catalog", () => {
    const catalogIds = new Set(VENICE_MODEL_CATALOG.map((model) => model.id));
    for (const staleId of [
      "claude-opus-4-6",
      "gemini-3-pro-preview",
      "gemini-3-1-pro-preview",
      "gemini-3-flash-preview",
      "grok-41-fast",
      "hermes-3-llama-3.1-405b",
      "kimi-k2-thinking",
      "llama-3.2-3b",
      "llama-3.3-70b",
      "minimax-m21",
      "minimax-m25",
      "mistral-31-24b",
      "nvidia-nemotron-3-nano-30b-a3b",
      "openai-gpt-4o-2024-11-20",
      "openai-gpt-4o-mini-2024-07-18",
      "openai-gpt-52",
      "openai-gpt-52-codex",
      "openai-gpt-53-codex",
      "openai-gpt-54",
      "openai-gpt-oss-120b",
      "qwen3-4b",
      "qwen3-5-35b-a3b",
      "qwen3-235b-a22b-instruct-2507",
      "qwen3-coder-480b-a35b-instruct",
      "qwen3-next-80b",
      "venice-uncensored",
      "zai-org-glm-4.7-flash",
      "zai-org-glm-5",
    ]) {
      expect(catalogIds.has(staleId)).toBe(false);
    }
  });

  it("keeps only immediate predecessors as deprecated compatibility rows", () => {
    // Lifecycle metadata lives on the manifest rows; the runtime provider-config
    // bridge (ModelDefinitionConfig) intentionally carries no status fields.
    const manifestRows = manifest.modelCatalog.providers.venice.models as Array<
      Record<string, unknown>
    >;
    for (const [id, replacedBy] of [
      ["zai-org-glm-4.6", "zai-org-glm-4.7"],
      ["google-gemma-3-27b-it", "google-gemma-4-31b-it"],
      ["kimi-k2-5", "kimi-k2-6"],
    ]) {
      expect(manifestRows.find((model) => model.id === id)).toMatchObject({
        status: "deprecated",
        replacedBy,
      });
    }
  });

  it("preserves authoritative manifest pricing in every bundled Venice model", () => {
    expect(
      VENICE_MODEL_CATALOG.map(({ id, cost, compat }) => ({
        id,
        cost,
        supportsUsageInStreaming: compat?.supportsUsageInStreaming,
      })),
    ).toEqual(
      manifest.modelCatalog.providers.venice.models.map(({ id, cost }) => ({
        id,
        cost,
        supportsUsageInStreaming: false,
      })),
    );
  });

  it("retains bundled prices for known live models without pricing unknown models", async () => {
    stubVeniceModelsFetch([
      { id: "zai-org-glm-4.7" },
      { id: "claude-opus-5" },
      { id: "unknown-model-without-pricing" },
    ]);
    const manifestCosts = new Map(
      manifest.modelCatalog.providers.venice.models.map(({ id, cost }) => [id, cost]),
    );

    const models = await runWithDiscoveryEnabled(() => discoverVeniceModels());

    expect(models.map(({ id, cost }) => ({ id, cost }))).toEqual([
      { id: "zai-org-glm-4.7", cost: manifestCosts.get("zai-org-glm-4.7") },
      { id: "claude-opus-5", cost: manifestCosts.get("claude-opus-5") },
      {
        id: "unknown-model-without-pricing",
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ]);
  });

  it("uses the shared fallback after a transient fetch failure", async () => {
    let attempts = 0;
    const fetchMock = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw Object.assign(new TypeError("fetch failed"), {
          cause: { code: "ECONNRESET", message: "socket hang up" },
        });
      }
      return makeModelsResponse("zai-org-glm-4.7");
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const models = await runWithDiscoveryEnabled(() => discoverVeniceModels());
    expect(attempts).toBe(1);
    expect(models.map((m) => m.id)).toEqual(VENICE_MODEL_CATALOG.map((m) => m.id));
  });

  it("uses API maxCompletionTokens for catalog models when present", async () => {
    const fetchMock = stubVeniceModelsFetch([
      {
        id: "zai-org-glm-4.7",
        availableContextTokens: 131072,
        maxCompletionTokens: 2048,
        capabilities: {
          supportsReasoning: false,
          supportsVision: false,
          supportsFunctionCalling: true,
        },
      },
    ]);

    const models = await runWithDiscoveryEnabled(() => discoverVeniceModels());
    const glm = models.find((m) => m.id === "zai-org-glm-4.7");
    expect(glm?.maxTokens).toBe(2048);
    const [input, init] = fetchMock.mock.calls[0] ?? [];
    const headers = input instanceof Request ? input.headers : new Headers(init?.headers);
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("authorization")).toBeNull();
  });

  it("retains catalog maxTokens when the API omits maxCompletionTokens", async () => {
    stubVeniceModelsFetch([
      {
        id: "qwen3-235b-a22b-thinking-2507",
        availableContextTokens: 131072,
        capabilities: {
          supportsReasoning: false,
          supportsVision: false,
          supportsFunctionCalling: true,
        },
      },
    ]);

    const models = await runWithDiscoveryEnabled(() => discoverVeniceModels());
    const qwen = models.find((m) => m.id === "qwen3-235b-a22b-thinking-2507");
    expect(qwen?.maxTokens).toBe(16384);
  });

  it("keeps tools enabled for DeepSeek V3.2", () => {
    const model = VENICE_MODEL_CATALOG.find((entry) => entry.id === "deepseek-v3.2")!;
    expect(model.compat?.supportsTools).toBeUndefined();
  });

  it("uses a conservative bounded maxTokens value for new models", async () => {
    stubVeniceModelsFetch([
      {
        id: "new-model-2026",
        availableContextTokens: 50_000,
        maxCompletionTokens: 200_000,
        capabilities: {
          supportsReasoning: false,
          supportsVision: false,
          supportsFunctionCalling: false,
        },
      },
    ]);

    const models = await runWithDiscoveryEnabled(() => discoverVeniceModels());
    const newModel = models.find((m) => m.id === "new-model-2026");
    expect(newModel?.maxTokens).toBe(50000);
    expect(newModel?.maxTokens).toBeLessThanOrEqual(newModel?.contextWindow ?? Infinity);
    expect(newModel?.compat?.supportsTools).toBe(false);
  });

  it("caps new-model maxTokens to the fallback context window when API context is missing", async () => {
    stubVeniceModelsFetch([
      {
        id: "new-model-without-context",
        maxCompletionTokens: 200_000,
        capabilities: {
          supportsReasoning: false,
          supportsVision: false,
          supportsFunctionCalling: true,
        },
      },
    ]);

    const models = await runWithDiscoveryEnabled(() => discoverVeniceModels());
    const newModel = models.find((m) => m.id === "new-model-without-context");
    expect(newModel?.contextWindow).toBe(128000);
    expect(newModel?.maxTokens).toBe(128000);
  });

  it("ignores missing capabilities on partial metadata instead of aborting discovery", async () => {
    stubVeniceModelsFetch([
      {
        id: "zai-org-glm-4.7",
        availableContextTokens: 131072,
        maxCompletionTokens: 2048,
      },
      {
        id: "new-model-partial",
        maxCompletionTokens: 2048,
      },
    ]);

    const models = await runWithDiscoveryEnabled(() => discoverVeniceModels());
    const knownModel = models.find((m) => m.id === "zai-org-glm-4.7");
    const partialModel = models.find((m) => m.id === "new-model-partial");
    expect(models).not.toHaveLength(VENICE_MODEL_CATALOG.length);
    expect(knownModel?.maxTokens).toBe(2048);
    expect(partialModel?.contextWindow).toBe(128000);
    expect(partialModel?.maxTokens).toBe(2048);
    expect(partialModel?.compat?.supportsTools).toBeUndefined();
  });

  it("keeps known models discoverable when a row omits model_spec", async () => {
    stubVeniceModelsFetch([
      { id: "qwen3-coder-480b-a35b-instruct-turbo", includeModelSpec: false },
      {
        id: "new-model-valid",
        availableContextTokens: 32_000,
        maxCompletionTokens: 2_048,
        capabilities: {
          supportsReasoning: false,
          supportsVision: false,
          supportsFunctionCalling: true,
        },
      },
    ]);

    const models = await runWithDiscoveryEnabled(() => discoverVeniceModels());
    const knownModel = models.find((m) => m.id === "qwen3-coder-480b-a35b-instruct-turbo");
    const newModel = models.find((m) => m.id === "new-model-valid");
    expect(models).not.toHaveLength(VENICE_MODEL_CATALOG.length);
    expect(knownModel?.maxTokens).toBe(65536);
    expect(newModel?.contextWindow).toBe(32000);
    expect(newModel?.maxTokens).toBe(2048);
  });

  it("falls back to static catalog after a discovery failure", async () => {
    const fetchMock = vi.fn(async () => {
      throw Object.assign(new TypeError("fetch failed"), {
        cause: { code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND api.venice.ai" },
      });
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const models = await runWithDiscoveryEnabled(() => discoverVeniceModels());
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(models).toHaveLength(VENICE_MODEL_CATALOG.length);
    expect(models.map((m) => m.id)).toEqual(VENICE_MODEL_CATALOG.map((m) => m.id));
  });
});
