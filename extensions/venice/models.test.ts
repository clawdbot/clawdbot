import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildVeniceModelDefinition,
  discoverVeniceModels,
  VENICE_MODEL_CATALOG,
} from "./models.js";

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
    async () =>
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

describe("venice-models", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    restoreDiscoveryEnv();
  });

  it("buildVeniceModelDefinition returns config with required fields", () => {
    const entry = VENICE_MODEL_CATALOG[0];
    const def = buildVeniceModelDefinition(entry);
    expect(def.id).toBe(entry.id);
    expect(def.name).toBe(entry.name);
    expect(def.reasoning).toBe(entry.reasoning);
    expect(def.input).toEqual(entry.input);
    expect(def.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(def.contextWindow).toBe(entry.contextWindow);
    expect(def.maxTokens).toBe(entry.maxTokens);
  });

  it("retries transient fetch failures before succeeding", async () => {
    let attempts = 0;
    const fetchMock = vi.fn(async () => {
      attempts += 1;
      if (attempts < 3) {
        throw Object.assign(new TypeError("fetch failed"), {
          cause: { code: "ECONNRESET", message: "socket hang up" },
        });
      }
      return makeModelsResponse("llama-3.3-70b");
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const models = await runWithDiscoveryEnabled(() => discoverVeniceModels({ retryDelayMs: 0 }));
    expect(attempts).toBe(3);
    expect(models.map((m) => m.id)).toContain("llama-3.3-70b");
  });

  it("uses API maxCompletionTokens for catalog models when present", async () => {
    stubVeniceModelsFetch([
      {
        id: "llama-3.3-70b",
        availableContextTokens: 131072,
        maxCompletionTokens: 2048,
        capabilities: {
          supportsReasoning: false,
          supportsVision: false,
          supportsFunctionCalling: true,
        },
      },
    ]);

    const models = await runWithDiscoveryEnabled(() => discoverVeniceModels({ retryDelayMs: 0 }));
    const llama = models.find((m) => m.id === "llama-3.3-70b");
    expect(llama?.maxTokens).toBe(2048);
  });

  it("retains catalog maxTokens when the API omits maxCompletionTokens", async () => {
    stubVeniceModelsFetch([
      {
        id: "qwen3-235b-a22b-instruct-2507",
        availableContextTokens: 131072,
        capabilities: {
          supportsReasoning: false,
          supportsVision: false,
          supportsFunctionCalling: true,
        },
      },
    ]);

    const models = await runWithDiscoveryEnabled(() => discoverVeniceModels({ retryDelayMs: 0 }));
    const qwen = models.find((m) => m.id === "qwen3-235b-a22b-instruct-2507");
    expect(qwen?.maxTokens).toBe(16384);
  });

  it("disables tools for catalog models that do not support function calling", () => {
    const model = buildVeniceModelDefinition(
      VENICE_MODEL_CATALOG.find((entry) => entry.id === "deepseek-v3.2")!,
    );
    expect(model.compat?.supportsTools).toBe(false);
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

    const models = await runWithDiscoveryEnabled(() => discoverVeniceModels({ retryDelayMs: 0 }));
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
        id: "llama-3.3-70b",
        availableContextTokens: 131072,
        maxCompletionTokens: 2048,
      },
      {
        id: "new-model-partial",
        maxCompletionTokens: 2048,
      },
    ]);

    const models = await runWithDiscoveryEnabled(() => discoverVeniceModels());
    const knownModel = models.find((m) => m.id === "llama-3.3-70b");
    const partialModel = models.find((m) => m.id === "new-model-partial");
    expect(models).not.toHaveLength(VENICE_MODEL_CATALOG.length);
    expect(knownModel?.maxTokens).toBe(2048);
    expect(partialModel?.contextWindow).toBe(128000);
    expect(partialModel?.maxTokens).toBe(2048);
    expect(partialModel?.compat?.supportsTools).toBeUndefined();
  });

  it("keeps known models discoverable when a row omits model_spec", async () => {
    stubVeniceModelsFetch([
      { id: "llama-3.3-70b", includeModelSpec: false },
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
    const knownModel = models.find((m) => m.id === "llama-3.3-70b");
    const newModel = models.find((m) => m.id === "new-model-valid");
    expect(models).not.toHaveLength(VENICE_MODEL_CATALOG.length);
    expect(knownModel?.maxTokens).toBe(4096);
    expect(newModel?.contextWindow).toBe(32000);
    expect(newModel?.maxTokens).toBe(2048);
  });

  it("falls back to static catalog after retry budget is exhausted", async () => {
    const fetchMock = vi.fn(async () => {
      throw Object.assign(new TypeError("fetch failed"), {
        cause: { code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND api.venice.ai" },
      });
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const models = await runWithDiscoveryEnabled(() => discoverVeniceModels({ retryDelayMs: 0 }));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(models).toHaveLength(VENICE_MODEL_CATALOG.length);
    expect(models.map((m) => m.id)).toEqual(VENICE_MODEL_CATALOG.map((m) => m.id));
  });
});
