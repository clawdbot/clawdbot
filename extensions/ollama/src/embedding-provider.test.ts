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
  ssrfPolicyFromHttpBaseUrlAllowedHostname: (baseUrl: string) => {
    const parsed = new URL(baseUrl);
    return { allowedHostnames: [parsed.hostname] };
  },
}));

let createOllamaEmbeddingProvider: typeof import("./embedding-provider.js").createOllamaEmbeddingProvider;
let ollamaMemoryEmbeddingProviderAdapter: typeof import("./memory-embedding-adapter.js").ollamaMemoryEmbeddingProviderAdapter;

beforeAll(async () => {
  ({ createOllamaEmbeddingProvider } = await import("./embedding-provider.js"));
  ({ ollamaMemoryEmbeddingProviderAdapter } = await import("./memory-embedding-adapter.js"));
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
      new Response(JSON.stringify({ embeddings: [embedding] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function readEmbeddingRequestBody(init: RequestInit | undefined): { input?: unknown } {
  if (typeof init?.body !== "string") {
    throw new Error("expected JSON string request body");
  }
  return JSON.parse(init.body) as { input?: unknown };
}

function readFirstEmbeddingInput(fetchMock: ReturnType<typeof mockEmbeddingFetch>): unknown {
  const [, init] = (fetchMock.mock.calls[0] ?? []) as unknown as [string, RequestInit | undefined];
  const body = readEmbeddingRequestBody(init);
  return body.input;
}

describe("ollama embedding provider", () => {
  it("calls /api/embed and returns normalized vectors", async () => {
    const fetchMock = mockEmbeddingFetch([3, 4]);

    const { provider } = await createOllamaEmbeddingProvider({
      config: {} as OpenClawConfig,
      provider: "ollama",
      model: "unknown-embedder",
      fallback: "none",
      remote: { baseUrl: "http://127.0.0.1:11434" },
    });

    const vector = await provider.embedQuery("hi");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:11434/api/embed",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ model: "unknown-embedder", input: "hi" }),
      }),
    );
    expect(vector[0]).toBeCloseTo(0.6, 5);
    expect(vector[1]).toBeCloseTo(0.8, 5);
  });

  it("resolves configured base URL and headers without sending local marker auth", async () => {
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
      "http://127.0.0.1:11434/api/embed",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          "X-Provider-Header": "provider",
        }),
      }),
    );
    const [, init] = (fetchMock.mock.calls[0] ?? []) as unknown as [
      string,
      RequestInit | undefined,
    ];
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.Authorization).toBeUndefined();
  });

  it("resolves configured baseURL alias", async () => {
    const fetchMock = mockEmbeddingFetch([1, 0]);

    const { provider } = await createOllamaEmbeddingProvider({
      config: {
        models: {
          providers: {
            ollama: {
              baseURL: "http://remote-ollama:11434/v1",
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
      "http://remote-ollama:11434/api/embed",
      expect.objectContaining({ method: "POST" }),
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
      "http://127.0.0.1:11434/api/embed",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer ollama-env",
        }),
      }),
    );
  });

  it("sends batch embeddings in one Ollama request", async () => {
    const inputs: unknown[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const rawBody = typeof init?.body === "string" ? init.body : "{}";
      const body = JSON.parse(rawBody) as { input?: unknown };
      inputs.push(body.input);
      return new Response(
        JSON.stringify({
          embeddings: [
            [1, 0],
            [1, 0],
            [1, 0],
          ],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const { provider } = await createOllamaEmbeddingProvider({
      config: {} as OpenClawConfig,
      provider: "ollama",
      model: "nomic-embed-text",
      fallback: "none",
      remote: { baseUrl: "http://127.0.0.1:11434" },
    });

    await expect(provider.embedBatch(["a", "bb", "ccc"])).resolves.toHaveLength(3);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(inputs).toEqual([["a", "bb", "ccc"]]);
  });

  it("uses a retrieval query prefix for qwen3 embedding queries", async () => {
    const fetchMock = mockEmbeddingFetch([1, 0]);

    const { provider } = await createOllamaEmbeddingProvider({
      config: {} as OpenClawConfig,
      provider: "ollama",
      model: "qwen3-embedding:0.6b",
      fallback: "none",
      remote: { baseUrl: "http://127.0.0.1:11434" },
    });

    await provider.embedQuery("怀孕");

    expect(readFirstEmbeddingInput(fetchMock)).toBe(
      "Instruct: Given a user query, retrieve relevant memory notes and documents\nQuery:怀孕",
    );
  });

  it("uses the nomic search_query prefix for query embeddings", async () => {
    const fetchMock = mockEmbeddingFetch([1, 0]);

    const { provider } = await createOllamaEmbeddingProvider({
      config: {} as OpenClawConfig,
      provider: "ollama",
      model: "nomic-embed-text",
      fallback: "none",
      remote: { baseUrl: "http://127.0.0.1:11434" },
    });

    await provider.embedQuery("What does $& mean?");

    expect(readFirstEmbeddingInput(fetchMock)).toBe("search_query: What does $& mean?");
  });

  it("uses the mixedbread retrieval prompt for query embeddings", async () => {
    const fetchMock = mockEmbeddingFetch([1, 0]);

    const { provider } = await createOllamaEmbeddingProvider({
      config: {} as OpenClawConfig,
      provider: "ollama",
      model: "mxbai-embed-large:latest",
      fallback: "none",
      remote: { baseUrl: "http://127.0.0.1:11434" },
    });

    await provider.embedQuery("capital of Australia");

    expect(readFirstEmbeddingInput(fetchMock)).toBe(
      "Represent this sentence for searching relevant passages: capital of Australia",
    );
  });

  it("keeps document batch embeddings raw", async () => {
    const inputs: unknown[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = readEmbeddingRequestBody(init);
      inputs.push(body.input);
      return new Response(
        JSON.stringify({
          embeddings: [
            [1, 0],
            [1, 0],
          ],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const { provider } = await createOllamaEmbeddingProvider({
      config: {} as OpenClawConfig,
      provider: "ollama",
      model: "qwen3-embedding:0.6b",
      fallback: "none",
      remote: { baseUrl: "http://127.0.0.1:11434" },
    });

    await expect(provider.embedBatch(["doc one", "doc two"])).resolves.toHaveLength(2);
    expect(inputs).toEqual([["doc one", "doc two"]]);
  });

  it("uses custom Ollama provider config and strips that provider prefix", async () => {
    const fetchMock = mockEmbeddingFetch([1, 0]);

    const { provider } = await createOllamaEmbeddingProvider({
      config: {
        models: {
          providers: {
            "ollama-spark": {
              baseUrl: "http://spark.local:11434/v1",
              apiKey: "spark-key",
              headers: {
                "X-Custom-Ollama": "spark",
              },
              models: [],
            },
          },
        },
      } as unknown as OpenClawConfig,
      provider: "ollama-spark",
      model: "ollama-spark/qwen3-embedding:4b",
      fallback: "none",
    });

    await provider.embedQuery("hello");

    expect(provider.model).toBe("qwen3-embedding:4b");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://spark.local:11434/api/embed",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer spark-key",
          "X-Custom-Ollama": "spark",
        }),
      }),
    );
  });

  it("does not attach pure env OLLAMA_API_KEY to a local host", async () => {
    const fetchMock = mockEmbeddingFetch([1, 0]);
    vi.stubEnv("OLLAMA_API_KEY", "ollama-cloud-key");

    const { provider } = await createOllamaEmbeddingProvider({
      config: {} as OpenClawConfig,
      provider: "ollama",
      model: "nomic-embed-text",
      fallback: "none",
      remote: { baseUrl: "http://127.0.0.1:11434" },
    });

    await provider.embedQuery("hello");

    const [, init] = (fetchMock.mock.calls[0] ?? []) as unknown as [
      string,
      RequestInit | undefined,
    ];
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.Authorization).toBeUndefined();
  });

  it("attaches pure env OLLAMA_API_KEY to Ollama Cloud", async () => {
    const fetchMock = mockEmbeddingFetch([1, 0]);
    vi.stubEnv("OLLAMA_API_KEY", "ollama-cloud-key");

    const { provider } = await createOllamaEmbeddingProvider({
      config: {} as OpenClawConfig,
      provider: "ollama",
      model: "nomic-embed-text",
      fallback: "none",
      remote: { baseUrl: "https://ollama.com" },
    });

    await provider.embedQuery("hello");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://ollama.com/api/embed",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer ollama-cloud-key",
        }),
      }),
    );
  });

  it("does not attach provider apiKey to a different remote embedding host", async () => {
    const fetchMock = mockEmbeddingFetch([1, 0]);

    const { provider } = await createOllamaEmbeddingProvider({
      config: {
        models: {
          providers: {
            ollama: {
              baseUrl: "http://127.0.0.1:11434",
              apiKey: "provider-host-key",
              models: [],
            },
          },
        },
      } as unknown as OpenClawConfig,
      provider: "ollama",
      model: "nomic-embed-text",
      fallback: "none",
      remote: { baseUrl: "https://memory.example.com" },
    });

    await provider.embedQuery("hello");

    const [, init] = (fetchMock.mock.calls[0] ?? []) as unknown as [
      string,
      RequestInit | undefined,
    ];
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.Authorization).toBeUndefined();
  });

  it("attaches remote apiKey to a remote embedding host", async () => {
    const fetchMock = mockEmbeddingFetch([1, 0]);

    const { provider } = await createOllamaEmbeddingProvider({
      config: {} as OpenClawConfig,
      provider: "ollama",
      model: "nomic-embed-text",
      fallback: "none",
      remote: { baseUrl: "https://memory.example.com", apiKey: "remote-host-key" },
    });

    await provider.embedQuery("hello");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://memory.example.com/api/embed",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer remote-host-key",
        }),
      }),
    );
  });

  it("honors remote local marker as an explicit no-auth opt-out", async () => {
    const fetchMock = mockEmbeddingFetch([1, 0]);

    const { provider } = await createOllamaEmbeddingProvider({
      config: {
        models: {
          providers: {
            ollama: {
              baseUrl: "http://127.0.0.1:11434",
              apiKey: "provider-host-key",
              models: [],
            },
          },
        },
      } as unknown as OpenClawConfig,
      provider: "ollama",
      model: "nomic-embed-text",
      fallback: "none",
      remote: { apiKey: "ollama-local" }, // pragma: allowlist secret
    });

    await provider.embedQuery("hello");

    const [, init] = (fetchMock.mock.calls[0] ?? []) as unknown as [
      string,
      RequestInit | undefined,
    ];
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.Authorization).toBeUndefined();
  });

  it("marks inline memory batches as local-server timeout work", async () => {
    const result = await ollamaMemoryEmbeddingProviderAdapter.create({
      config: {} as OpenClawConfig,
      provider: "ollama",
      model: "nomic-embed-text",
      fallback: "none",
      remote: { baseUrl: "http://127.0.0.1:11434" },
    });

    expect(result.runtime?.inlineBatchTimeoutMs).toBe(600_000);
  });
});
