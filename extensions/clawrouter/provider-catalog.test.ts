import { expectDefined } from "@openclaw/normalization-core";
import type { ProviderRuntimeModel } from "openclaw/plugin-sdk/plugin-entry";
import {
  clearLiveCatalogCacheForTests,
  type LiveModelCatalogFetchGuard,
} from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { beforeEach, describe, expect, it, vi, type MockedFunction } from "vitest";
import {
  buildClawRouterProviderConfig,
  normalizeClawRouterResolvedModel,
  prepareClawRouterRequestModel,
} from "./provider-catalog.js";

const PRICING = {
  inputMicrosPerMillion: 3_000_000,
  outputMicrosPerMillion: 15_000_000,
  cachedInputMicrosPerMillion: 300_000,
  cacheWrite5mInputMicrosPerMillion: 3_750_000,
  maxInputTokens: 1_000_000,
  defaultMaxOutputTokens: 64_000,
};

const CATALOG = {
  version: "clawrouter.client-catalog.v1",
  providers: [
    {
      id: "openai",
      displayName: "OpenAI",
      openaiCompatible: true,
      nativeBaseUrl: "/v1/native/openai",
      routes: [
        {
          path: "/v1/responses",
          methods: ["POST"],
          requestFormat: "openai.responses",
        },
      ],
      models: [
        {
          id: "openai/gpt-5.5",
          upstream: "gpt-5.5",
          capabilities: ["llm.responses", "llm.chat"],
          pricing: PRICING,
        },
      ],
    },
    {
      id: "deepseek",
      displayName: "DeepSeek",
      openaiCompatible: true,
      nativeBaseUrl: "/v1/native/deepseek",
      routes: [],
      models: [
        {
          id: "deepseek/deepseek-v4-flash",
          upstream: "deepseek-v4-flash",
          capabilities: ["llm.chat"],
        },
      ],
    },
    {
      id: "anthropic",
      displayName: "Anthropic",
      openaiCompatible: false,
      nativeBaseUrl: "/v1/native/anthropic",
      routes: [
        {
          path: "/v1/messages",
          methods: ["POST"],
          requestFormat: "anthropic.messages",
        },
      ],
      models: [
        {
          id: "anthropic/claude-sonnet-4-6",
          upstream: "claude-sonnet-4-6",
          capabilities: ["llm.messages"],
          pricing: PRICING,
        },
      ],
    },
    {
      id: "google-gemini",
      displayName: "Google Gemini",
      openaiCompatible: false,
      nativeBaseUrl: "/v1/native/google-gemini",
      routes: [
        {
          path: "/v1beta/models/${model}:generateContent",
          methods: ["POST"],
          requestFormat: "google.generate_content",
        },
        {
          path: "/v1beta/models/${model}:streamGenerateContent",
          methods: ["POST"],
          requestFormat: "google.generate_content",
        },
      ],
      models: [
        {
          id: "google/gemini-3.5-flash",
          upstream: "gemini-3.5-flash",
          capabilities: ["llm.generate", "llm.stream"],
        },
      ],
    },
    {
      id: "cohere",
      displayName: "Cohere",
      openaiCompatible: false,
      nativeBaseUrl: "/v1/native/cohere",
      routes: [
        {
          path: "/v2/chat",
          methods: ["POST"],
          requestFormat: "cohere.chat",
        },
      ],
      models: [
        {
          id: "cohere/command-a-plus-05-2026",
          upstream: "command-a-plus-05-2026",
          capabilities: ["llm.chat"],
        },
      ],
    },
  ],
};

function buildFetchGuard(catalog: unknown = CATALOG): {
  fetchGuard: LiveModelCatalogFetchGuard;
  fetchGuardMock: MockedFunction<LiveModelCatalogFetchGuard>;
} {
  const fetchGuardMock: MockedFunction<LiveModelCatalogFetchGuard> = vi.fn(async () => ({
    response: new Response(JSON.stringify(catalog)),
    finalUrl: "https://clawrouter.example/v1/catalog",
    release: async () => undefined,
  }));
  return { fetchGuard: fetchGuardMock, fetchGuardMock };
}

describe("ClawRouter provider catalog", () => {
  beforeEach(() => {
    clearLiveCatalogCacheForTests();
  });

  it("maps every supported catalog protocol to its OpenClaw transport", async () => {
    const { fetchGuard, fetchGuardMock } = buildFetchGuard();
    const provider = await buildClawRouterProviderConfig({
      apiKey: "clawrouter-test-key",
      baseUrl: "https://clawrouter.example/v1",
      fetchGuard,
    });

    expect(fetchGuardMock).toHaveBeenCalledOnce();
    expect(provider.models.map((model) => model.id)).toEqual([
      "anthropic/claude-sonnet-4-6",
      "deepseek/deepseek-v4-flash",
      "google/gemini-3.5-flash",
      "openai/gpt-5.5",
    ]);
    expect(provider.models.find((model) => model.id === "openai/gpt-5.5")).toMatchObject({
      api: "openai-responses",
      baseUrl: "https://clawrouter.example/v1",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      contextWindow: 1_000_000,
      maxTokens: 64_000,
    });
    expect(
      provider.models.find((model) => model.id === "deepseek/deepseek-v4-flash"),
    ).toMatchObject({ api: "openai-completions" });
    expect(
      provider.models.find((model) => model.id === "anthropic/claude-sonnet-4-6"),
    ).toMatchObject({
      api: "anthropic-messages",
      baseUrl: "https://clawrouter.example/v1/native/anthropic",
    });
    expect(provider.models.find((model) => model.id === "google/gemini-3.5-flash")).toMatchObject({
      api: "google-generative-ai",
      baseUrl: "https://clawrouter.example/v1/native/google-gemini/v1beta",
    });
    expect(provider.models.map((model) => model.id)).not.toContain("cohere/command-a-plus-05-2026");
  });

  it("rewrites only native protocol model ids at the request boundary", async () => {
    const provider = await buildClawRouterProviderConfig({
      apiKey: "clawrouter-test-key",
      baseUrl: "https://clawrouter.example",
      fetchGuard: buildFetchGuard().fetchGuard,
    });
    const anthropic = provider.models.find((model) => model.id === "anthropic/claude-sonnet-4-6");
    const normalized = normalizeClawRouterResolvedModel({
      ...anthropic,
      baseUrl: provider.baseUrl,
      provider: "clawrouter",
    } as ProviderRuntimeModel);

    expect(normalized).toMatchObject({
      id: "anthropic/claude-sonnet-4-6",
      api: "anthropic-messages",
    });
    expect(prepareClawRouterRequestModel(normalized as ProviderRuntimeModel)).toMatchObject({
      id: "claude-sonnet-4-6",
      params: undefined,
    });

    const openai = provider.models.find((model) => model.id === "openai/gpt-5.5");
    const normalizedOpenAi = normalizeClawRouterResolvedModel({
      ...openai,
      baseUrl: provider.baseUrl,
      provider: "clawrouter",
    } as ProviderRuntimeModel);
    expect(prepareClawRouterRequestModel(normalizedOpenAi as ProviderRuntimeModel).id).toBe(
      "openai/gpt-5.5",
    );
  });

  it("caches catalog rows per credential scope", async () => {
    const { fetchGuard, fetchGuardMock } = buildFetchGuard();
    const params = {
      apiKey: "clawrouter-test-key",
      baseUrl: "https://clawrouter.example",
      fetchGuard,
    };

    await buildClawRouterProviderConfig(params);
    await buildClawRouterProviderConfig(params);

    expect(fetchGuardMock).toHaveBeenCalledOnce();
    const headers = fetchGuardMock.mock.calls[0]?.[0].init?.headers;
    expect(headers).toBeInstanceOf(Headers);
    expect((headers as Headers).get("authorization")).toBe("Bearer clawrouter-test-key");
  });

  it("does not advertise Gemini without a streaming route", async () => {
    const catalog = structuredClone(CATALOG);
    const geminiProvider = expectDefined(catalog.providers[3], "Gemini ClawRouter provider");
    geminiProvider.routes = geminiProvider.routes.filter(
      (route) => !route.path.includes(":streamGenerateContent"),
    );
    expectDefined(geminiProvider.models[0], "Gemini ClawRouter model").capabilities = [
      "llm.generate",
    ];
    const provider = await buildClawRouterProviderConfig({
      apiKey: "clawrouter-test-key",
      fetchGuard: buildFetchGuard(catalog).fetchGuard,
    });

    expect(provider.models.map((model) => model.id)).not.toContain("google/gemini-3.5-flash");
  });
});
