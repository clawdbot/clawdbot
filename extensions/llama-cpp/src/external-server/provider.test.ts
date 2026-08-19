import type {
  ProviderCatalogContext,
  ProviderPrepareDynamicModelContext,
  UnifiedModelCatalogProviderContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  discoverLlamaServerProvider,
  listLlamaServerCatalog,
  prepareLlamaServerDynamicModels,
  resolveLlamaServerDynamicModel,
} from "./provider.js";

const discoverMock = vi.hoisted(() => vi.fn());
const runtimeApiKeyMock = vi.hoisted(() => vi.fn());

vi.mock("./discovery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./discovery.js")>()),
  discoverLlamaServer: discoverMock,
}));

vi.mock("./auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./auth.js")>()),
  resolveLlamaServerRuntimeApiKey: runtimeApiKeyMock,
}));

function model() {
  return {
    config: {
      id: "org/model:Q4",
      name: "org/model:Q4",
      reasoning: false,
      input: ["text" as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 16384,
      contextTokens: 16384,
      maxTokens: 4096,
      compat: { supportsTools: true },
    },
    status: "sleeping" as const,
    failed: false,
    buildInfo: "b10000-test",
    totalSlots: 2,
  };
}

function success() {
  return {
    kind: "success" as const,
    endpoint: {
      origin: "http://localhost:8080",
      inferenceBaseUrl: "http://localhost:8080/v1",
    },
    health: "ready" as const,
    models: [model()],
    fetchedAt: 1000,
  };
}

function catalogContext(): ProviderCatalogContext {
  return {
    config: {},
    env: {},
    resolveProviderApiKey: vi.fn(() => ({ apiKey: undefined })),
    resolveProviderAuth: vi.fn(() => ({
      apiKey: undefined,
      mode: "none" as const,
      source: "none" as const,
    })),
  };
}

describe("llama-server provider catalog", () => {
  beforeEach(() => {
    discoverMock.mockReset();
    runtimeApiKeyMock.mockReset();
    runtimeApiKeyMock.mockResolvedValue(undefined);
  });

  it("builds the legacy runtime provider from live discovery", async () => {
    discoverMock.mockResolvedValue(success());

    await expect(discoverLlamaServerProvider(catalogContext())).resolves.toMatchObject({
      provider: {
        baseUrl: "http://localhost:8080/v1",
        api: "openai-completions",
        models: [expect.objectContaining({ id: "org/model:Q4" })],
      },
    });
  });

  it("prefers configured Authorization over ambient API-key discovery auth", async () => {
    discoverMock.mockResolvedValue(success());
    const ctx = catalogContext();
    ctx.config.models = {
      providers: {
        "llama-cpp": {
          baseUrl: "http://localhost:8080/v1",
          headers: { Authorization: "Bearer proxy-key" },
          models: [],
        },
      },
    };
    ctx.resolveProviderApiKey = vi.fn(() => ({
      apiKey: "LLAMA_SERVER_API_KEY",
      discoveryApiKey: "ambient-key",
    }));

    await discoverLlamaServerProvider(ctx);

    expect(discoverMock).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: undefined,
        headers: { Authorization: "Bearer proxy-key" },
      }),
    );
  });

  it("preserves explicit models when the server is unavailable", async () => {
    discoverMock.mockResolvedValue({
      kind: "unreachable",
      endpoint: { origin: "http://localhost:8080", inferenceBaseUrl: "http://localhost:8080/v1" },
      error: new Error("offline"),
    });
    const ctx = catalogContext();
    ctx.config.models = {
      providers: {
        "llama-cpp": {
          baseUrl: "http://localhost:8080/v1",
          models: [model().config],
        },
      },
    };

    await expect(discoverLlamaServerProvider(ctx)).resolves.toMatchObject({
      provider: { models: [expect.objectContaining({ id: "org/model:Q4" })] },
    });
  });

  it("projects router state into unified catalog warnings", async () => {
    discoverMock.mockResolvedValue(success());
    const ctx = {
      ...catalogContext(),
      includeLive: true,
    } as UnifiedModelCatalogProviderContext;

    await expect(listLlamaServerCatalog(ctx)).resolves.toEqual([
      expect.objectContaining({
        kind: "text",
        provider: "llama-cpp",
        model: "org/model:Q4",
        source: "live",
        warnings: ["llama-server model is sleeping"],
        capabilities: expect.objectContaining({
          contextWindow: 16384,
          status: "sleeping",
          buildInfo: "b10000-test",
          totalSlots: 2,
        }),
      }),
    ]);
  });

  it("scopes dynamic catalogs by agent runtime and auth profile", async () => {
    const first = success();
    const second = {
      ...success(),
      models: [
        {
          ...model(),
          config: { ...model().config, name: "second scope" },
        },
      ],
    };
    discoverMock.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const base = {
      config: {},
      provider: "llama-cpp",
      modelId: "org/model:Q4",
      modelRegistry: {},
      providerConfig: {
        baseUrl: "http://localhost:8080/v1",
        api: "openai-completions",
      },
    };
    const firstCtx = {
      ...base,
      agentRuntimeId: "runtime-one",
      authProfileId: "profile-one",
    } as unknown as ProviderPrepareDynamicModelContext;
    const secondCtx = {
      ...base,
      agentRuntimeId: "runtime-two",
      authProfileId: "profile-two",
    } as unknown as ProviderPrepareDynamicModelContext;

    await prepareLlamaServerDynamicModels(firstCtx);
    await prepareLlamaServerDynamicModels(secondCtx);

    expect(runtimeApiKeyMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ profileId: "profile-one" }),
    );
    expect(runtimeApiKeyMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ profileId: "profile-two" }),
    );
    expect(resolveLlamaServerDynamicModel(firstCtx)?.name).toBe("org/model:Q4");
    expect(resolveLlamaServerDynamicModel(secondCtx)?.name).toBe("second scope");
  });

  it("bounds dynamic model snapshots by scope", async () => {
    discoverMock.mockResolvedValue(success());
    const contexts = Array.from(
      { length: 101 },
      (_, index) =>
        ({
          config: {},
          provider: "llama-cpp",
          modelId: "org/model:Q4",
          modelRegistry: {},
          agentRuntimeId: `runtime-${index}`,
          providerConfig: {
            baseUrl: "http://localhost:8080/v1",
            api: "openai-completions",
          },
        }) as unknown as ProviderPrepareDynamicModelContext,
    );

    for (const ctx of contexts) {
      await prepareLlamaServerDynamicModels(ctx);
    }

    expect(resolveLlamaServerDynamicModel(contexts[0]!)).toBeUndefined();
    expect(resolveLlamaServerDynamicModel(contexts.at(-1)!)).toMatchObject({
      id: "org/model:Q4",
    });
  });

  it("moves a refreshed dynamic scope to the newest eviction position", async () => {
    discoverMock.mockResolvedValue(success());
    const contexts = Array.from(
      { length: 101 },
      (_, index) =>
        ({
          config: {},
          provider: "llama-server",
          modelId: "org/model:Q4",
          modelRegistry: {},
          agentRuntimeId: `refresh-runtime-${index}`,
          providerConfig: {
            baseUrl: "http://localhost:8080/v1",
            api: "openai-completions",
          },
        }) as unknown as ProviderPrepareDynamicModelContext,
    );

    for (const ctx of contexts.slice(0, 100)) {
      await prepareLlamaServerDynamicModels(ctx);
    }
    await prepareLlamaServerDynamicModels(contexts[0]!);
    await prepareLlamaServerDynamicModels(contexts[100]!);

    expect(resolveLlamaServerDynamicModel(contexts[0]!)).toMatchObject({ id: "org/model:Q4" });
    expect(resolveLlamaServerDynamicModel(contexts[1]!)).toBeUndefined();
  });

  it("keeps dynamic snapshots separate when only the endpoint changes", async () => {
    discoverMock.mockResolvedValueOnce(success()).mockResolvedValueOnce({
      ...success(),
      models: [{ ...model(), config: { ...model().config, name: "second endpoint" } }],
    });
    const base = {
      config: {},
      provider: "llama-server",
      modelId: "org/model:Q4",
      modelRegistry: {},
      agentRuntimeId: "endpoint-runtime",
      authProfileId: "endpoint-profile",
    };
    const first = {
      ...base,
      providerConfig: { baseUrl: "http://localhost:8080/v1", api: "openai-completions" },
    } as unknown as ProviderPrepareDynamicModelContext;
    const second = {
      ...base,
      providerConfig: { baseUrl: "http://localhost:8081/v1", api: "openai-completions" },
    } as unknown as ProviderPrepareDynamicModelContext;

    await prepareLlamaServerDynamicModels(first);
    await prepareLlamaServerDynamicModels(second);

    expect(resolveLlamaServerDynamicModel(first)?.name).toBe("org/model:Q4");
    expect(resolveLlamaServerDynamicModel(second)?.name).toBe("second endpoint");
  });

  it("clears a scope snapshot when its refresh cannot discover the server", async () => {
    discoverMock.mockResolvedValueOnce(success()).mockResolvedValueOnce({
      kind: "unreachable",
      endpoint: { origin: "http://localhost:8080", inferenceBaseUrl: "http://localhost:8080/v1" },
      error: new Error("offline"),
    });
    const ctx = {
      config: {},
      provider: "llama-server",
      modelId: "org/model:Q4",
      modelRegistry: {},
      agentRuntimeId: "failed-refresh-runtime",
      providerConfig: {
        baseUrl: "http://localhost:8080/v1",
        api: "openai-completions",
      },
    } as unknown as ProviderPrepareDynamicModelContext;

    await prepareLlamaServerDynamicModels(ctx);
    expect(resolveLlamaServerDynamicModel(ctx)).toMatchObject({ id: "org/model:Q4" });
    await prepareLlamaServerDynamicModels(ctx);
    expect(resolveLlamaServerDynamicModel(ctx)).toBeUndefined();
  });

  it("refreshes and resolves dynamic model ids containing slashes", async () => {
    discoverMock.mockResolvedValue(success());
    const ctx = {
      config: {},
      provider: "llama-cpp",
      modelId: "org/model:Q4",
      modelRegistry: {},
      providerConfig: {
        baseUrl: "http://localhost:8080/v1",
        api: "openai-completions",
      },
    } as unknown as ProviderPrepareDynamicModelContext;

    await prepareLlamaServerDynamicModels(ctx);

    expect(resolveLlamaServerDynamicModel(ctx)).toMatchObject({
      provider: "llama-cpp",
      id: "org/model:Q4",
      baseUrl: "http://localhost:8080/v1",
      api: "openai-completions",
    });
  });
});
