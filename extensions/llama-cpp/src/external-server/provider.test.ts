import type {
  ProviderCatalogContext,
  ProviderPrepareDynamicModelContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { discoverLlamaServerProvider, prepareLlamaServerDynamicModel } from "./provider.js";

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
  };
}

function success() {
  return {
    kind: "success" as const,
    endpoint: {
      origin: "http://localhost:8080",
      inferenceBaseUrl: "http://localhost:8080/v1",
    },
    models: [model()],
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

function dynamicContext(
  overrides: Partial<ProviderPrepareDynamicModelContext> = {},
): ProviderPrepareDynamicModelContext {
  return {
    config: {},
    provider: "llama-cpp",
    modelId: "org/model:Q4",
    modelRegistry: {} as never,
    providerConfig: {
      baseUrl: "http://localhost:8080/v1",
      api: "openai-completions",
    },
    ...overrides,
  };
}

describe("llama-server provider discovery", () => {
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

  it("returns only the requested discovered model directly to its preparation owner", async () => {
    discoverMock.mockResolvedValue({
      ...success(),
      models: [
        model(),
        {
          ...model(),
          config: { ...model().config, id: "org/requested:Q8", name: "Requested model" },
        },
      ],
    });
    await expect(
      prepareLlamaServerDynamicModel(dynamicContext({ modelId: "org/requested:Q8" })),
    ).resolves.toMatchObject({
      provider: "llama-cpp",
      id: "org/requested:Q8",
      name: "Requested model",
      baseUrl: "http://localhost:8080/v1",
      api: "openai-completions",
    });
  });

  it("keeps requested models and API keys isolated by agent runtime and auth profile", async () => {
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
    runtimeApiKeyMock
      .mockResolvedValueOnce("first-profile-key")
      .mockResolvedValueOnce("second-profile-key");
    const firstCtx = dynamicContext({
      agentRuntimeId: "runtime-one",
      authProfileId: "profile-one",
    });
    const secondCtx = dynamicContext({
      agentRuntimeId: "runtime-two",
      authProfileId: "profile-two",
    });

    const firstModel = await prepareLlamaServerDynamicModel(firstCtx);
    const secondModel = await prepareLlamaServerDynamicModel(secondCtx);

    expect(runtimeApiKeyMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ profileId: "profile-one" }),
    );
    expect(runtimeApiKeyMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ profileId: "profile-two" }),
    );
    expect(discoverMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ apiKey: "first-profile-key" }),
    );
    expect(discoverMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ apiKey: "second-profile-key" }),
    );
    expect(firstModel?.name).toBe("org/model:Q4");
    expect(secondModel?.name).toBe("second scope");
  });

  it("keeps requested models separate when only the endpoint changes", async () => {
    discoverMock.mockResolvedValueOnce(success()).mockResolvedValueOnce({
      ...success(),
      models: [{ ...model(), config: { ...model().config, name: "second endpoint" } }],
    });
    const base = {
      agentRuntimeId: "endpoint-runtime",
      authProfileId: "endpoint-profile",
    };
    const first = dynamicContext({
      ...base,
      providerConfig: { baseUrl: "http://localhost:8080/v1", api: "openai-completions" },
    });
    const second = dynamicContext({
      ...base,
      providerConfig: { baseUrl: "http://localhost:8081/v1", api: "openai-completions" },
    });

    const firstModel = await prepareLlamaServerDynamicModel(first);
    const secondModel = await prepareLlamaServerDynamicModel(second);

    expect(firstModel).toMatchObject({
      name: "org/model:Q4",
      baseUrl: "http://localhost:8080/v1",
    });
    expect(secondModel).toMatchObject({
      name: "second endpoint",
      baseUrl: "http://localhost:8081/v1",
    });
  });

  it("prefers explicit Authorization over the profile API key during model preparation", async () => {
    runtimeApiKeyMock.mockResolvedValue("profile-key");
    discoverMock.mockResolvedValue(success());
    const headers = { Authorization: "Bearer endpoint-key" };

    await prepareLlamaServerDynamicModel(
      dynamicContext({
        providerConfig: { baseUrl: "http://localhost:8080/v1", headers },
      }),
    );

    expect(discoverMock).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: undefined, headers, cacheTtlMs: 0 }),
    );
  });

  it.each([
    {
      label: "the server is unavailable",
      discovery: {
        kind: "unreachable" as const,
        endpoint: { origin: "http://localhost:8080", inferenceBaseUrl: "http://localhost:8080/v1" },
        error: new Error("offline"),
      },
    },
    {
      label: "the requested model disappears",
      discovery: { ...success(), models: [] },
    },
  ])("returns no stale model when $label", async ({ discovery }) => {
    discoverMock.mockResolvedValueOnce(success()).mockResolvedValueOnce(discovery);
    const ctx = dynamicContext({
      agentRuntimeId: "failed-refresh-runtime",
    });

    await expect(prepareLlamaServerDynamicModel(ctx)).resolves.toMatchObject({
      id: "org/model:Q4",
    });
    await expect(prepareLlamaServerDynamicModel(ctx)).resolves.toBeUndefined();
  });
});
