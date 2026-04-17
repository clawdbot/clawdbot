import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-auth";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(async ({ init, url }: { init?: RequestInit; url: string }) => ({
    response: await fetch(url, init),
    release: async () => {},
  })),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
  formatErrorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

let createOllamaEmbeddingProvider: typeof import("./embedding-provider.js").createOllamaEmbeddingProvider;

beforeAll(async () => {
  ({ createOllamaEmbeddingProvider } = await import("./embedding-provider.js"));
});

beforeEach(() => {
  fetchWithSsrFGuardMock.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function mockEmbeddingFetch(embedding: number[]) {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify({ embedding }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("ollama embedding provider", () => {
  it("calls /api/embeddings and returns normalized vectors", async () => {
    const fetchMock = mockEmbeddingFetch([3, 4]);

    const { provider } = await createOllamaEmbeddingProvider({
      config: {} as OpenClawConfig,
      provider: "ollama",
      model: "nomic-embed-text",
      fallback: "none",
      remote: { baseUrl: "http://127.0.0.1:11434" },
    });

    const vector = await provider.embedQuery("hi");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vector[0]).toBeCloseTo(0.6, 5);
    expect(vector[1]).toBeCloseTo(0.8, 5);
  });

  it("resolves configured base URL, API key, and headers", async () => {
    const fetchMock = mockEmbeddingFetch([1, 0]);

    const { provider } = await createOllamaEmbeddingProvider({
      config: {
        models: {
          providers: {
            ollama: {
              baseUrl: "http://127.0.0.1:11434/v1",
              apiKey: "ollama-\nlocal\r\n", // pragma: allowlist secret
              headers: {
                "X-Provider-Header": "provider",
              },
            },
          },
        },
      } as unknown as OpenClawConfig,
      provider: "ollama",
      model: "",
      fallback: "none",
    });

    await provider.embedQuery("hello");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:11434/api/embeddings",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          Authorization: "Bearer ollama-local",
          "X-Provider-Header": "provider",
        }),
      }),
    );
  });

  it("fails fast when memory-search remote apiKey is an unresolved SecretRef", async () => {
    await expect(
      createOllamaEmbeddingProvider({
        config: {} as OpenClawConfig,
        provider: "ollama",
        model: "nomic-embed-text",
        fallback: "none",
        remote: {
          baseUrl: "http://127.0.0.1:11434",
          apiKey: { source: "env", provider: "default", id: "OLLAMA_API_KEY" },
        },
      }),
    ).rejects.toThrow(/agents\.\*\.memorySearch\.remote\.apiKey: unresolved SecretRef/i);
  });

  it("falls back to env key when provider apiKey is an unresolved SecretRef", async () => {
    const fetchMock = mockEmbeddingFetch([1, 0]);
    vi.stubEnv("OLLAMA_API_KEY", "ollama-env");

    const { provider } = await createOllamaEmbeddingProvider({
      config: {
        models: {
          providers: {
            ollama: {
              baseUrl: "http://127.0.0.1:11434/v1",
              apiKey: { source: "env", provider: "default", id: "OLLAMA_API_KEY" },
              models: [],
            },
          },
        },
      } as unknown as OpenClawConfig,
      provider: "ollama",
      model: "nomic-embed-text",
      fallback: "none",
    });

    await provider.embedQuery("hello");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:11434/api/embeddings",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer ollama-env",
        }),
      }),
    );
  });
});
