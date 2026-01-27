import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_GEMINI_EMBEDDING_MODEL } from "./embeddings-gemini.js";

vi.mock("../agents/model-auth.js", () => ({
  resolveApiKeyForProvider: vi.fn(),
  requireApiKey: (auth: { apiKey?: string; mode?: string }, provider: string) => {
    if (auth?.apiKey) return auth.apiKey;
    throw new Error(`No API key resolved for provider "${provider}" (auth mode: ${auth?.mode}).`);
  },
}));

const createFetchMock = () =>
  vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: [{ embedding: [1, 2, 3] }] }),
  })) as unknown as typeof fetch;

describe("embedding provider remote overrides", () => {
  afterEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it("uses remote baseUrl/apiKey and merges headers", async () => {
    const fetchMock = createFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const { createEmbeddingProvider } = await import("./embeddings.js");
    const authModule = await import("../agents/model-auth.js");
    vi.mocked(authModule.resolveApiKeyForProvider).mockResolvedValue({
      apiKey: "provider-key",
      mode: "api-key",
      source: "test",
    });

    const cfg = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://provider.example/v1",
            headers: {
              "X-Provider": "p",
              "X-Shared": "provider",
            },
          },
        },
      },
    };

    const result = await createEmbeddingProvider({
      config: cfg as never,
      provider: "openai",
      remote: {
        baseUrl: "https://remote.example/v1",
        apiKey: "  remote-key  ",
        headers: {
          "X-Shared": "remote",
          "X-Remote": "r",
        },
      },
      model: "text-embedding-3-small",
      fallback: "openai",
    });

    await result.provider.embedQuery("hello");

    expect(authModule.resolveApiKeyForProvider).not.toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://remote.example/v1/embeddings");
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer remote-key");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["X-Provider"]).toBe("p");
    expect(headers["X-Shared"]).toBe("remote");
    expect(headers["X-Remote"]).toBe("r");
  });

  it("falls back to resolved api key when remote apiKey is blank", async () => {
    const fetchMock = createFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const { createEmbeddingProvider } = await import("./embeddings.js");
    const authModule = await import("../agents/model-auth.js");
    vi.mocked(authModule.resolveApiKeyForProvider).mockResolvedValue({
      apiKey: "provider-key",
      mode: "api-key",
      source: "test",
    });

    const cfg = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://provider.example/v1",
          },
        },
      },
    };

    const result = await createEmbeddingProvider({
      config: cfg as never,
      provider: "openai",
      remote: {
        baseUrl: "https://remote.example/v1",
        apiKey: "   ",
      },
      model: "text-embedding-3-small",
      fallback: "openai",
    });

    await result.provider.embedQuery("hello");

    expect(authModule.resolveApiKeyForProvider).toHaveBeenCalledTimes(1);
    const headers = (fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>) ?? {};
    expect(headers.Authorization).toBe("Bearer provider-key");
  });

  it("builds Gemini embeddings requests with api key header", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ embedding: { values: [1, 2, 3] } }),
    })) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);

    const { createEmbeddingProvider } = await import("./embeddings.js");
    const authModule = await import("../agents/model-auth.js");
    vi.mocked(authModule.resolveApiKeyForProvider).mockResolvedValue({
      apiKey: "provider-key",
      mode: "api-key",
      source: "test",
    });

    const cfg = {
      models: {
        providers: {
          google: {
            baseUrl: "https://generativelanguage.googleapis.com/v1beta",
          },
        },
      },
    };

    const result = await createEmbeddingProvider({
      config: cfg as never,
      provider: "gemini",
      remote: {
        apiKey: "gemini-key",
      },
      model: "text-embedding-004",
      fallback: "openai",
    });

    await result.provider.embedQuery("hello");

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent",
    );
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers["x-goog-api-key"]).toBe("gemini-key");
    expect(headers["Content-Type"]).toBe("application/json");
  });
});

describe("embedding provider auto selection", () => {
  afterEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it("prefers openai when a key resolves", async () => {
    const { createEmbeddingProvider } = await import("./embeddings.js");
    const authModule = await import("../agents/model-auth.js");
    vi.mocked(authModule.resolveApiKeyForProvider).mockImplementation(async ({ provider }) => {
      if (provider === "openai") {
        return { apiKey: "openai-key", source: "env: OPENAI_API_KEY", mode: "api-key" };
      }
      throw new Error(`No API key found for provider "${provider}".`);
    });

    const result = await createEmbeddingProvider({
      config: {} as never,
      provider: "auto",
      model: "",
      fallback: "none",
    });

    expect(result.requestedProvider).toBe("auto");
    expect(result.provider.id).toBe("openai");
  });

  it("uses gemini when openai is missing", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ embedding: { values: [1, 2, 3] } }),
    })) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);

    const { createEmbeddingProvider } = await import("./embeddings.js");
    const authModule = await import("../agents/model-auth.js");
    vi.mocked(authModule.resolveApiKeyForProvider).mockImplementation(async ({ provider }) => {
      if (provider === "openai") {
        throw new Error('No API key found for provider "openai".');
      }
      if (provider === "google") {
        return { apiKey: "gemini-key", source: "env: GEMINI_API_KEY", mode: "api-key" };
      }
      throw new Error(`Unexpected provider ${provider}`);
    });

    const result = await createEmbeddingProvider({
      config: {} as never,
      provider: "auto",
      model: "",
      fallback: "none",
    });

    expect(result.requestedProvider).toBe("auto");
    expect(result.provider.id).toBe("gemini");
    await result.provider.embedQuery("hello");
    const [url] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(
      `https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_GEMINI_EMBEDDING_MODEL}:embedContent`,
    );
  });

  it("keeps explicit model when openai is selected", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ embedding: [1, 2, 3] }] }),
    })) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);

    const { createEmbeddingProvider } = await import("./embeddings.js");
    const authModule = await import("../agents/model-auth.js");
    vi.mocked(authModule.resolveApiKeyForProvider).mockImplementation(async ({ provider }) => {
      if (provider === "openai") {
        return { apiKey: "openai-key", source: "env: OPENAI_API_KEY", mode: "api-key" };
      }
      throw new Error(`Unexpected provider ${provider}`);
    });

    const result = await createEmbeddingProvider({
      config: {} as never,
      provider: "auto",
      model: "text-embedding-3-small",
      fallback: "none",
    });

    expect(result.requestedProvider).toBe("auto");
    expect(result.provider.id).toBe("openai");
    await result.provider.embedQuery("hello");
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://api.openai.com/v1/embeddings");
    const payload = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
    expect(payload.model).toBe("text-embedding-3-small");
  });
});

describe("embedding provider local fallback", () => {
  afterEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.doUnmock("./node-llama.js");
  });

  it("falls back to openai when node-llama-cpp is missing", async () => {
    vi.doMock("./node-llama.js", () => ({
      importNodeLlamaCpp: async () => {
        throw Object.assign(new Error("Cannot find package 'node-llama-cpp'"), {
          code: "ERR_MODULE_NOT_FOUND",
        });
      },
    }));

    const fetchMock = createFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const { createEmbeddingProvider } = await import("./embeddings.js");
    const authModule = await import("../agents/model-auth.js");
    vi.mocked(authModule.resolveApiKeyForProvider).mockResolvedValue({
      apiKey: "provider-key",
      mode: "api-key",
      source: "test",
    });

    const result = await createEmbeddingProvider({
      config: {} as never,
      provider: "local",
      model: "text-embedding-3-small",
      fallback: "openai",
    });

    expect(result.provider.id).toBe("openai");
    expect(result.fallbackFrom).toBe("local");
    expect(result.fallbackReason).toContain("node-llama-cpp");
  });

  it("throws a helpful error when local is requested and fallback is none", async () => {
    vi.doMock("./node-llama.js", () => ({
      importNodeLlamaCpp: async () => {
        throw Object.assign(new Error("Cannot find package 'node-llama-cpp'"), {
          code: "ERR_MODULE_NOT_FOUND",
        });
      },
    }));

    const { createEmbeddingProvider } = await import("./embeddings.js");

    await expect(
      createEmbeddingProvider({
        config: {} as never,
        provider: "local",
        model: "text-embedding-3-small",
        fallback: "none",
      }),
    ).rejects.toThrow(/optional dependency node-llama-cpp/i);
  });
});
