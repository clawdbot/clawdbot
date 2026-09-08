import type {
  ProviderCatalogContext,
  ProviderPrepareDynamicModelContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { discoverLlamaServerProvider, prepareLlamaServerDynamicModel } from "./provider.js";

const discoverMock = vi.hoisted(() => vi.fn());
const runtimeApiKeyMock = vi.hoisted(() => vi.fn());
const catalogSdk = vi.hoisted((): { available: boolean; calls: number; failure?: Error } => ({
  available: true,
  calls: 0,
}));

vi.mock("openclaw/plugin-sdk/provider-catalog-live-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/provider-catalog-live-runtime")>();
  const run = (params: Parameters<typeof actual.runLiveProviderCatalog>[0]) => {
    catalogSdk.calls += 1;
    if (catalogSdk.failure) {
      throw catalogSdk.failure;
    }
    return actual.runLiveProviderCatalog(params);
  };
  return {
    ...actual,
    get runLiveProviderCatalog() {
      return catalogSdk.available ? run : undefined;
    },
  };
});

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
      origin: "http://127.0.0.1:8080",
      inferenceBaseUrl: "http://127.0.0.1:8080/v1",
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
    catalogSdk.available = true;
    catalogSdk.calls = 0;
    catalogSdk.failure = undefined;
  });

  describe.each([true, false])("catalog SDK helper available=%s", (available) => {
    beforeEach(() => {
      catalogSdk.available = available;
    });

    it("publishes live discovery with the profile that supplied its credential", async () => {
      discoverMock.mockResolvedValue(success());
      const ctx = catalogContext();
      ctx.resolveProviderApiKey = () => ({
        apiKey: "LLAMA_SERVER_API_KEY",
        discoveryApiKey: "profile-key",
        profileId: "llama-cpp:default",
      });

      await expect(discoverLlamaServerProvider(ctx)).resolves.toMatchObject({
        provider: {
          baseUrl: "http://127.0.0.1:8080/v1",
          api: "openai-completions",
          models: [expect.objectContaining({ id: "org/model:Q4" })],
        },
        outcomes: [{ provider: "llama-cpp", profileId: "llama-cpp:default", status: "ready" }],
      });
      expect(discoverMock).toHaveBeenCalledWith(
        expect.objectContaining({ apiKey: "profile-key", cacheTtlMs: 0 }),
      );
      expect(catalogSdk.calls).toBe(available ? 1 : 0);
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
        profileId: "llama-cpp:ambient",
      }));

      const result = await discoverLlamaServerProvider(ctx);
      expect(result?.outcomes).toEqual([{ provider: "llama-cpp", status: "ready" }]);

      expect(discoverMock).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKey: undefined,
          headers: { Authorization: "Bearer proxy-key" },
        }),
      );
    });

    it.each([
      { failure: { kind: "http-error", status: 401 }, status: "auth-rejected" },
      { failure: { kind: "http-error", status: 403 }, status: "auth-rejected" },
      { failure: { kind: "http-error", status: 503 }, status: "unavailable" },
      { failure: { kind: "unreachable", error: new Error("offline") }, status: "unavailable" },
      {
        failure: { kind: "invalid-response", error: new Error("malformed") },
        status: "unavailable",
      },
    ])(
      "reports $failure as $status instead of publishing empty discovery",
      async ({ failure, status }) => {
        discoverMock.mockResolvedValue({
          ...failure,
          endpoint: {
            origin: "http://localhost:8080",
            inferenceBaseUrl: "http://localhost:8080/v1",
          },
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

        await expect(discoverLlamaServerProvider(ctx)).resolves.toEqual({
          providers: {},
          outcomes: [
            {
              provider: "llama-cpp",
              status,
              ...(status === "auth-rejected" ? { rejectionScope: "catalog" } : {}),
            },
          ],
        });
      },
    );

    it.each([undefined, "custom-local"])(
      "keeps unconfigured probes quiet with marker %s",
      async (apiKey) => {
        discoverMock.mockResolvedValue({ kind: "unreachable", error: new Error("offline") });
        const ctx = catalogContext();
        ctx.resolveProviderApiKey = () => ({ apiKey });
        await expect(discoverLlamaServerProvider(ctx)).resolves.toBeNull();
      },
    );
  });

  it("preserves errors thrown by an available catalog helper", async () => {
    const failure = new Error("current SDK helper failed");
    catalogSdk.failure = failure;
    await expect(discoverLlamaServerProvider(catalogContext())).rejects.toBe(failure);
    expect(discoverMock).not.toHaveBeenCalled();
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
