import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
// Deepinfra tests cover provider models plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";

const isProviderApiKeyConfiguredMock = vi.hoisted(() => vi.fn<(p: unknown) => boolean>());
vi.mock("openclaw/plugin-sdk/provider-auth", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/provider-auth")>(
    "openclaw/plugin-sdk/provider-auth",
  );
  return {
    ...actual,
    isProviderApiKeyConfigured: isProviderApiKeyConfiguredMock,
  };
});

import {
  DEEPINFRA_DEFAULT_MODEL_REF,
  DEEPINFRA_MODEL_CATALOG,
  discoverDeepInfraModels,
  discoverDeepInfraSurfaces,
  hasDeepInfraApiKey,
} from "./provider-models.js";

const DEEPINFRA_MODELS_URL =
  "https://api.deepinfra.com/v1/openai/models?sort_by=openclaw&filter=with_meta";

beforeEach(() => {
  clearLiveCatalogCacheForTests();
  isProviderApiKeyConfiguredMock.mockReset();
  isProviderApiKeyConfiguredMock.mockReturnValue(false);
});

function makeAgentModelEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: "openai/gpt-oss-120b",
    object: "model",
    owned_by: "deepinfra",
    metadata: {
      description: "gpt-oss-120b",
      context_length: 131072,
      max_tokens: 65536,
      pricing: {
        input_tokens: 3,
        output_tokens: 15,
        cache_read_tokens: 0.3,
      },
      tags: ["chat", "vlm", "vision", "reasoning_effort", "prompt_cache", "reasoning"],
    },
    ...overrides,
  };
}

function jsonResponse(payload: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function expectedStaticChatCatalog() {
  return DEEPINFRA_MODEL_CATALOG.map((model) => {
    const compat = Object.assign({}, model.compat, {
      supportsUsageInStreaming: model.compat?.supportsUsageInStreaming ?? true,
    });
    return Object.assign({}, model, { compat });
  });
}

function expectedLiveChatCatalog(liveModels: ReturnType<typeof expectedStaticChatCatalog>) {
  const liveIds = new Set(liveModels.map((model) => model.id));
  return [...liveModels, ...expectedStaticChatCatalog().filter((model) => !liveIds.has(model.id))];
}

async function withFetchPathTest(
  mockFetch: ReturnType<typeof vi.fn>,
  envOverrides: Record<string, string | undefined>,
  runAssertions: () => Promise<void>,
) {
  const env = { ...process.env };
  delete process.env.NODE_ENV;
  delete process.env.VITEST;
  for (const [key, value] of Object.entries(envOverrides)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      Reflect.set(process.env, key, value);
    }
  }
  vi.stubGlobal("fetch", mockFetch);

  try {
    await runAssertions();
  } finally {
    for (const key of Object.keys(envOverrides)) {
      if (env[key] === undefined) {
        delete process.env[key];
      } else {
        Reflect.set(process.env, key, env[key]);
      }
    }
    if (env.NODE_ENV !== undefined) {
      process.env.NODE_ENV = env.NODE_ENV;
    }
    if (env.VITEST !== undefined) {
      process.env.VITEST = env.VITEST;
    }
    vi.unstubAllGlobals();
  }
}

function requireFirstFetchCall(mockFetch: ReturnType<typeof vi.fn>): [unknown, unknown] {
  const [call] = mockFetch.mock.calls;
  if (!call) {
    throw new Error("expected DeepInfra models fetch call");
  }
  return call as [unknown, unknown];
}

describe("DEEPINFRA_MODELS_URL", () => {
  it("points at /v1/openai/models with the openclaw sort + filter=with_meta gate", () => {
    expect(DEEPINFRA_MODELS_URL).toBe(
      "https://api.deepinfra.com/v1/openai/models?sort_by=openclaw&filter=with_meta",
    );
  });
});

describe("hasDeepInfraApiKey", () => {
  it("returns true via env var, false on missing / blank", () => {
    expect(hasDeepInfraApiKey({ env: { DEEPINFRA_API_KEY: "sk-x" } })).toBe(true);
    expect(hasDeepInfraApiKey({ env: { DEEPINFRA_API_KEY: "" } })).toBe(false);
    expect(hasDeepInfraApiKey({ env: { DEEPINFRA_API_KEY: "   " } })).toBe(false);
    expect(hasDeepInfraApiKey({ env: {} })).toBe(false);
  });

  it("falls back to the auth-profile store when no env var is set", () => {
    isProviderApiKeyConfiguredMock.mockReturnValue(true);

    expect(hasDeepInfraApiKey({ env: {}, agentDir: "/tmp/openclaw-agent" })).toBe(true);

    expect(isProviderApiKeyConfiguredMock).toHaveBeenCalledTimes(1);
    expect(isProviderApiKeyConfiguredMock).toHaveBeenCalledWith({
      provider: "deepinfra",
      agentDir: "/tmp/openclaw-agent",
    });
  });

  it("accepts config-backed provider API keys before probing the profile store", () => {
    expect(
      hasDeepInfraApiKey({
        env: {},
        agentDir: "/tmp/openclaw-agent",
        config: {
          models: {
            providers: {
              deepinfra: {
                apiKey: { source: "env", provider: "default", id: "CUSTOM_DEEPINFRA_KEY" },
              },
            },
          },
        },
      }),
    ).toBe(true);

    expect(isProviderApiKeyConfiguredMock).not.toHaveBeenCalled();
  });

  it("short-circuits on env var and skips the profile-store probe", () => {
    isProviderApiKeyConfiguredMock.mockReturnValue(true);

    expect(
      hasDeepInfraApiKey({
        env: { DEEPINFRA_API_KEY: "sk-x" },
        agentDir: "/tmp/openclaw-agent",
      }),
    ).toBe(true);

    expect(isProviderApiKeyConfiguredMock).not.toHaveBeenCalled();
  });

  it("returns false when env is empty and the auth-profile store has no deepinfra profile", () => {
    isProviderApiKeyConfiguredMock.mockReturnValue(false);

    expect(hasDeepInfraApiKey({ env: {}, agentDir: "/tmp/openclaw-agent" })).toBe(false);

    expect(isProviderApiKeyConfiguredMock).toHaveBeenCalledWith({
      provider: "deepinfra",
      agentDir: "/tmp/openclaw-agent",
    });
  });
});

describe("discoverDeepInfraModels (chat-only shim)", () => {
  it("returns static catalog in test environment", async () => {
    const models = await discoverDeepInfraModels();
    const modelIds = models.map((m) => m.id);
    const streamingUsageIncompatibleModelIds = models
      .filter((m) => !m.compat?.supportsUsageInStreaming)
      .map((m) => m.id);

    expect(DEEPINFRA_DEFAULT_MODEL_REF).toBe("deepinfra/deepseek-ai/DeepSeek-V4-Flash");
    expect(models).toStrictEqual(expectedStaticChatCatalog());
    expect(modelIds).toStrictEqual(expectedStaticChatCatalog().map((model) => model.id));
    expect(streamingUsageIncompatibleModelIds).toStrictEqual([]);
  });

  it("fetches the openclaw-projection endpoint and parses chat-surface entries when an API key is configured", async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse({ data: [makeAgentModelEntry()] }));

    await withFetchPathTest(mockFetch, { DEEPINFRA_API_KEY: "sk-test" }, async () => {
      const models = await discoverDeepInfraModels();
      expect(mockFetch).toHaveBeenCalledOnce();
      const [fetchUrl, fetchInit] = requireFirstFetchCall(mockFetch);
      const fetchSignal = Reflect.get(fetchInit ?? {}, "signal");
      const fetchHeaders = Reflect.get(fetchInit ?? {}, "headers");
      expect(fetchUrl).toBe(DEEPINFRA_MODELS_URL);
      expect(fetchSignal).toBeInstanceOf(AbortSignal);
      expect(fetchHeaders).toBeInstanceOf(Headers);
      expect((fetchHeaders as Headers).get("Accept")).toBe("application/json");
      expect(models).toEqual(
        expectedLiveChatCatalog([
          {
            id: "openai/gpt-oss-120b",
            name: "openai/gpt-oss-120b",
            reasoning: true,
            input: ["text", "image"],
            contextWindow: 131072,
            maxTokens: 65536,
            cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
            compat: { supportsUsageInStreaming: true },
          },
        ]),
      );
    });
  });

  it("skips entries with no metadata or no surface tag, and deduplicates ids", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      jsonResponse({
        data: [
          { id: "BAAI/bge-m3", object: "model", metadata: null },
          makeAgentModelEntry({
            id: "untagged/model",
            metadata: { context_length: 1, max_tokens: 1, pricing: {}, tags: [] },
          }),
          makeAgentModelEntry(),
          makeAgentModelEntry(),
        ],
      }),
    );

    await withFetchPathTest(mockFetch, { DEEPINFRA_API_KEY: "sk-test" }, async () => {
      const models = await discoverDeepInfraModels();
      expect(models.map((m) => m.id)).toEqual(
        expectedLiveChatCatalog([
          {
            id: "openai/gpt-oss-120b",
            name: "openai/gpt-oss-120b",
            reasoning: true,
            input: ["text", "image"],
            contextWindow: 131072,
            maxTokens: 65536,
            cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
            compat: { supportsUsageInStreaming: true },
          },
        ]).map((model) => model.id),
      );
    });
  });

  it("falls back to the static catalog when no API key is configured (skips network entirely)", async () => {
    const mockFetch = vi.fn();

    await withFetchPathTest(mockFetch, { DEEPINFRA_API_KEY: undefined }, async () => {
      const models = await discoverDeepInfraModels();
      expect(mockFetch).not.toHaveBeenCalled();
      expect(models.map((m) => m.id)).toEqual(expectedStaticChatCatalog().map((model) => model.id));
    });
  });

  it("falls back to the static catalog on network errors", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("network error"));

    await withFetchPathTest(mockFetch, { DEEPINFRA_API_KEY: "sk-test" }, async () => {
      const models = await discoverDeepInfraModels();
      expect(models.map((m) => m.id)).toEqual(expectedStaticChatCatalog().map((model) => model.id));
    });
  });

  it("falls back to the static catalog on non-2xx HTTP responses", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("", { status: 503 }));

    await withFetchPathTest(mockFetch, { DEEPINFRA_API_KEY: "sk-test" }, async () => {
      const models = await discoverDeepInfraModels();
      expect(models.map((m) => m.id)).toEqual(expectedStaticChatCatalog().map((model) => model.id));
    });
  });

  it("falls back without caching malformed successful model list payloads", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: {} }))
      .mockResolvedValueOnce(
        jsonResponse({ data: [makeAgentModelEntry({ id: "recovered/model" })] }),
      );

    await withFetchPathTest(mockFetch, { DEEPINFRA_API_KEY: "sk-test" }, async () => {
      expect((await discoverDeepInfraModels()).map((m) => m.id)).toEqual(
        expectedStaticChatCatalog().map((model) => model.id),
      );
      expect((await discoverDeepInfraModels()).map((m) => m.id)).toEqual(
        expectedLiveChatCatalog([
          {
            id: "recovered/model",
            name: "recovered/model",
            reasoning: true,
            input: ["text", "image"],
            contextWindow: 131072,
            maxTokens: 65536,
            cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
            compat: { supportsUsageInStreaming: true },
          },
        ]).map((model) => model.id),
      );
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  it("caches successful discovery responses only", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: [makeAgentModelEntry({ id: "first/model" })] }))
      .mockResolvedValueOnce(jsonResponse({ data: [makeAgentModelEntry({ id: "second/model" })] }));

    await withFetchPathTest(mockFetch, { DEEPINFRA_API_KEY: "sk-test" }, async () => {
      const expectedIds = expectedLiveChatCatalog([
        {
          id: "first/model",
          name: "first/model",
          reasoning: true,
          input: ["text", "image"],
          contextWindow: 131072,
          maxTokens: 65536,
          cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
          compat: { supportsUsageInStreaming: true },
        },
      ]).map((model) => model.id);
      expect((await discoverDeepInfraModels()).map((m) => m.id)).toEqual(expectedIds);
      expect((await discoverDeepInfraModels()).map((m) => m.id)).toEqual(expectedIds);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  it("does not cache successful responses that produce no live catalog rows", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: [] }))
      .mockResolvedValueOnce(
        jsonResponse({ data: [makeAgentModelEntry({ id: "recovered/model" })] }),
      );

    await withFetchPathTest(mockFetch, { DEEPINFRA_API_KEY: "sk-test" }, async () => {
      expect((await discoverDeepInfraModels()).map((m) => m.id)).toEqual(
        expectedStaticChatCatalog().map((model) => model.id),
      );
      expect((await discoverDeepInfraModels()).map((m) => m.id)).toEqual(
        expectedLiveChatCatalog([
          {
            id: "recovered/model",
            name: "recovered/model",
            reasoning: true,
            input: ["text", "image"],
            contextWindow: 131072,
            maxTokens: 65536,
            cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
            compat: { supportsUsageInStreaming: true },
          },
        ]).map((model) => model.id),
      );
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });
});

describe("discoverDeepInfraSurfaces (per-surface bucketing)", () => {
  it("buckets dynamic entries by short-alias surface tag", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      jsonResponse({
        data: [
          makeAgentModelEntry({
            id: "anthropic/claude-sonnet-4-6",
            metadata: {
              description: "claude sonnet 4.6",
              context_length: 200000,
              max_tokens: 8192,
              pricing: { input_tokens: 3, output_tokens: 15 },
              tags: ["chat", "vlm", "vision", "prompt_cache"],
            },
          }),
          makeAgentModelEntry({
            id: "BAAI/bge-m3",
            metadata: {
              description: "bge-m3",
              pricing: { input_tokens: 0.01 },
              tags: ["embed"],
            },
          }),
          makeAgentModelEntry({
            id: "black-forest-labs/FLUX-1-schnell",
            metadata: {
              description: "FLUX schnell",
              pricing: { per_image_unit: 0.003 },
              tags: ["image-gen"],
              default_width: 1024,
              default_height: 1024,
              default_iterations: 4,
            },
          }),
          makeAgentModelEntry({
            id: "Wan-AI/Wan2.6-T2V",
            metadata: {
              description: "Wan T2V",
              pricing: { output_seconds: 0.05 },
              tags: ["video-gen"],
            },
          }),
          makeAgentModelEntry({
            id: "Qwen/Qwen3-TTS",
            metadata: {
              description: "Qwen3 TTS",
              pricing: { input_characters: 0.65 },
              tags: ["tts"],
            },
          }),
          makeAgentModelEntry({
            id: "openai/whisper-large-v3-turbo",
            metadata: {
              description: "whisper",
              pricing: { input_seconds: 0.00004 },
              tags: ["stt"],
            },
          }),
        ],
      }),
    );

    await withFetchPathTest(mockFetch, { DEEPINFRA_API_KEY: "sk-test" }, async () => {
      const catalog = await discoverDeepInfraSurfaces();
      expect(catalog.live).toBe(true);
      expect(catalog.chat.map((m) => m.id)).toEqual(["anthropic/claude-sonnet-4-6"]);
      expect(catalog.vlm.map((m) => m.id)).toEqual(["anthropic/claude-sonnet-4-6"]);
      expect(catalog.embed.map((m) => m.id)).toEqual(["BAAI/bge-m3"]);
      expect(catalog.imageGen.map((m) => m.id)).toEqual(["black-forest-labs/FLUX-1-schnell"]);
      expect(catalog.imageGen[0]?.defaultWidth).toBe(1024);
      expect(catalog.imageGen[0]?.pricing.per_image_unit).toBe(0.003);
      expect(catalog.videoGen.map((m) => m.id)).toEqual(["Wan-AI/Wan2.6-T2V"]);
      expect(catalog.tts.map((m) => m.id)).toEqual(["Qwen/Qwen3-TTS"]);
      expect(catalog.stt.map((m) => m.id)).toEqual(["openai/whisper-large-v3-turbo"]);
    });
  });

  it("drops malformed live numeric metadata", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      jsonResponse({
        data: [
          makeAgentModelEntry({
            id: "bad/chat",
            metadata: {
              description: "bad chat",
              context_length: -1,
              max_tokens: 1.5,
              pricing: { input_tokens: 3, output_tokens: 15 },
              tags: ["chat"],
            },
          }),
          makeAgentModelEntry({
            id: "bad/image",
            metadata: {
              description: "bad image",
              pricing: { per_image_unit: 0.003 },
              tags: ["image-gen"],
              default_width: Number.POSITIVE_INFINITY,
              default_height: 1024.5,
              default_iterations: 0,
            },
          }),
        ],
      }),
    );

    await withFetchPathTest(mockFetch, { DEEPINFRA_API_KEY: "sk-test" }, async () => {
      const catalog = await discoverDeepInfraSurfaces();

      expect(catalog.chat[0]).toMatchObject({ id: "bad/chat" });
      expect(catalog.chat[0]?.contextWindow).toBeUndefined();
      expect(catalog.chat[0]?.maxTokens).toBeUndefined();
      expect(catalog.imageGen[0]).toMatchObject({ id: "bad/image" });
      expect(catalog.imageGen[0]?.defaultWidth).toBeUndefined();
      expect(catalog.imageGen[0]?.defaultHeight).toBeUndefined();
      expect(catalog.imageGen[0]?.defaultIterations).toBeUndefined();
    });
  });

  it("returns the manifest static fallback (live=false) when no API key is configured", async () => {
    const mockFetch = vi.fn();

    await withFetchPathTest(mockFetch, { DEEPINFRA_API_KEY: undefined }, async () => {
      const catalog = await discoverDeepInfraSurfaces();
      expect(catalog.live).toBe(false);
      expect(catalog.chat.length).toBeGreaterThan(0);
      // Non-chat surfaces in the static fallback live in TS constants because
      // the manifest schema only validates chat-shaped rows.
      expect(catalog.imageGen.map((m) => m.id)).toContain("black-forest-labs/FLUX-1-schnell");
      expect(catalog.tts.map((m) => m.id)).toContain("Qwen/Qwen3-TTS");
      expect(catalog.stt.map((m) => m.id)).toContain("openai/whisper-large-v3-turbo");
      // No static video-gen fallback — live discovery picks up text-to-video
      // models when the backend tags them. The live-discovery test above
      // covers the video-gen bucketing path.
      expect(catalog.videoGen).toEqual([]);
      expect(catalog.embed.map((m) => m.id)).toContain("BAAI/bge-m3");
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});
