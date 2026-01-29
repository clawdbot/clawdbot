import { afterEach, describe, expect, it, vi } from "vitest";

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
    json: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] }),
  })) as unknown as typeof fetch;

describe("voyage embedding provider", () => {
  afterEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it("configures client with correct defaults and headers", async () => {
    const fetchMock = createFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const { createVoyageEmbeddingProvider } = await import("./embeddings-voyage.js");
    const authModule = await import("../agents/model-auth.js");

    vi.mocked(authModule.resolveApiKeyForProvider).mockResolvedValue({
      apiKey: "voyage-key-123",
      mode: "api-key",
      source: "test",
    });

    const result = await createVoyageEmbeddingProvider({
      config: {} as never,
      provider: "voyage",
      model: "voyage-4-large",
      fallback: "none",
    });

    await result.provider.embedQuery("test query");

    expect(authModule.resolveApiKeyForProvider).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "voyage" }),
    );

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://api.voyageai.com/v1/embeddings");

    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer voyage-key-123");
    expect(headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(init?.body as string);
    expect(body).toEqual({
      model: "voyage-4-large",
      input: ["test query"],
    });
  });

  it("respects remote overrides for baseUrl and apiKey", async () => {
    const fetchMock = createFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const { createVoyageEmbeddingProvider } = await import("./embeddings-voyage.js");

    const result = await createVoyageEmbeddingProvider({
      config: {} as never,
      provider: "voyage",
      model: "voyage-4-lite",
      fallback: "none",
      remote: {
        baseUrl: "https://proxy.example.com",
        apiKey: "remote-override-key",
        headers: { "X-Custom": "123" },
      },
    });

    await result.provider.embedQuery("test");

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://proxy.example.com/embeddings");

    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer remote-override-key");
    expect(headers["X-Custom"]).toBe("123");
  });

  it("normalizes model names", async () => {
    const { normalizeVoyageModel } = await import("./embeddings-voyage.js");
    expect(normalizeVoyageModel("voyage/voyage-large-2")).toBe("voyage-large-2");
    expect(normalizeVoyageModel("voyage-4-large")).toBe("voyage-4-large");
    expect(normalizeVoyageModel("  voyage-lite  ")).toBe("voyage-lite");
    expect(normalizeVoyageModel("")).toBe("voyage-4-large"); // Default
  });
});
