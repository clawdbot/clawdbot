// Ollama tests cover embedding provider plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-auth";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createStreamingResponse } from "../../test-support/streaming-error-response.js";

const { fetchConfiguredLocalOriginWithSsrFGuardMock } = vi.hoisted(() => ({
  fetchConfiguredLocalOriginWithSsrFGuardMock: vi.fn(
    async ({ init, url }: { init?: RequestInit; url: string }) => ({
      response: await fetch(url, init),
      release: async () => {},
    }),
  ),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: vi.fn(),
  formatErrorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
  ssrfPolicyFromHttpBaseUrlAllowedOrigin: (baseUrl: string) => {
    const parsed = new URL(baseUrl);
    return { allowedOrigins: [parsed.origin] };
  },
}));

// Import-resolution gating for this private helper is covered in sdk-alias.test.ts.
vi.mock("openclaw/plugin-sdk/ssrf-runtime-internal", () => ({
  fetchConfiguredLocalOriginWithSsrFGuard: fetchConfiguredLocalOriginWithSsrFGuardMock,
}));

let createOllamaEmbeddingProvider: typeof import("./embedding-provider.js").createOllamaEmbeddingProvider;
let ollamaMemoryEmbeddingProviderAdapter: typeof import("./memory-embedding-adapter.js").ollamaMemoryEmbeddingProviderAdapter;

beforeAll(async () => {
  ({ createOllamaEmbeddingProvider } = await import("./embedding-provider.js"));
  ({ ollamaMemoryEmbeddingProviderAdapter } = await import("./memory-embedding-adapter.js"));
});

beforeEach(() => {
  fetchConfiguredLocalOriginWithSsrFGuardMock.mockClear();
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

function firstFetchInit(fetchMock: ReturnType<typeof mockEmbeddingFetch>): RequestInit | undefined {
  const call = fetchMock.mock.calls[0] as unknown[] | undefined;
  if (!call) {
    throw new Error("expected embedding fetch call");
  }
  return call[1] as RequestInit | undefined;
}

function readEmbeddingRequestBody(init: RequestInit | undefined): { input?: unknown } {
  if (typeof init?.body !== "string") {
    throw new Error("expected JSON string request body");
  }
  return JSON.parse(init.body) as { input?: unknown };
}

function readFirstEmbeddingInput(fetchMock: ReturnType<typeof mockEmbeddingFetch>): unknown {
  const init = firstFetchInit(fetchMock);
  const body = readEmbeddingRequestBody(init);
  return body.input;
}

function firstGuardedFetchCall(): Record<string, unknown> {
  const call = fetchConfiguredLocalOriginWithSsrFGuardMock.mock.calls[0]?.[0];
  if (!call || typeof call !== "object") {
    throw new Error("expected guarded fetch call");
  }
  return call as Record<string, unknown>;
}

function cancelTrackedResponse(
  text: string,
  init: ResponseInit,
): {
  response: Response;
  wasCanceled: () => boolean;
} {
  let canceled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
    },
    cancel() {
      canceled = true;
    },
  });
  return {
    response: new Response(stream, init),
    wasCanceled: () => canceled,
  };
}

function expectEmbeddingFetch(
  fetchMock: ReturnType<typeof mockEmbeddingFetch>,
  url: string,
  params: {
    model?: string;
    input?: unknown;
    headers?: Record<string, string>;
  } = {},
) {
  expect(fetchMock).toHaveBeenCalledWith(url, {
    method: "POST",
    headers: params.headers ?? { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: params.model ?? "nomic-embed-text",
      input: params.input ?? "hello",
    }),
  });
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
    expectEmbeddingFetch(fetchMock, "http://127.0.0.1:11434/api/embed", {
      model: "unknown-embedder",
      input: "hi",
    });
    expect(vector[0]).toBeCloseTo(0.6, 5);
    expect(vector[1]).toBeCloseTo(0.8, 5);
  });

  it("applies outputDimensionality before normalizing vectors", async () => {
    mockEmbeddingFetch([3, 4, 12]);

    const { provider } = await createOllamaEmbeddingProvider({
      config: {} as OpenClawConfig,
      provider: "ollama",
      model: "unknown-embedder",
      fallback: "none",
      remote: { baseUrl: "http://127.0.0.1:11434" },
      outputDimensionality: 2,
    });

    const vector = await provider.embedQuery("hi");

    expect(vector).toHaveLength(2);
    expect(vector[0]).toBeCloseTo(0.6, 5);
    expect(vector[1]).toBeCloseTo(0.8, 5);
  });

  it("marks the configured Ollama origin for managed-proxy direct routing", async () => {
    const fetchMock = mockEmbeddingFetch([1, 0]);

    const { provider } = await createOllamaEmbeddingProvider({
      config: {} as OpenClawConfig,
      provider: "ollama",
      model: "nomic-embed-text",
      fallback: "none",
      remote: { baseUrl: "http://127.0.0.1:11434/v1" },
    });

    await provider.embedQuery("hello");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(firstGuardedFetchCall()).toMatchObject({
      url: "http://127.0.0.1:11434/api/embed",
      policy: { allowedOrigins: ["http://127.0.0.1:11434"] },
      configuredLocalOriginBaseUrl: "http://127.0.0.1:11434",
      auditContext: "ollama-memory-embedding",
    });
  });

  it("passes cloud Ollama origins through the guarded fetch contract", async () => {
    const fetchMock = mockEmbeddingFetch([1, 0]);

    const { provider } = await createOllamaEmbeddingProvider({
      config: {} as OpenClawConfig,
      provider: "ollama",
      model: "nomic-embed-text",
      fallback: "none",
      remote: { baseUrl: "https://ollama.com" },
    });

    await provider.embedQuery("hello");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(firstGuardedFetchCall()).toMatchObject({
      url: "https://ollama.com/api/embed",
      policy: { allowedOrigins: ["https://ollama.com"] },
      configuredLocalOriginBaseUrl: "https://ollama.com",
      auditContext: "ollama-memory-embedding",
    });
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

    expectEmbeddingFetch(fetchMock, "http://127.0.0.1:11434/api/embed", {
      input: "search_query: hello",
      headers: {
        "Content-Type": "application/json",
        "X-Provider-Header": "provider",
      },
    });
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

    expectEmbeddingFetch(fetchMock, "http://remote-ollama:11434/api/embed", {
      model: "nomic-embed-text",
      input: "search_query: hello",
    });
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

    expectEmbeddingFetch(fetchMock, "http://127.0.0.1:11434/api/embed", {
      input: "search_query: hello",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer ollama-env",
      },
    });
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
    expect(firstGuardedFetchCall()).toMatchObject({
      url: "http://127.0.0.1:11434/api/embed",
      policy: { allowedOrigins: ["http://127.0.0.1:11434"] },
      configuredLocalOriginBaseUrl: "http://127.0.0.1:11434",
      auditContext: "ollama-memory-embedding",
    });
  });

  it("bounds embed error bodies without using response.text()", async () => {
    const tracked = cancelTrackedResponse(`${"ollama embed unavailable ".repeat(1024)}tail`, {
      status: 503,
      headers: { "content-type": "text/plain" },
    });
    const textSpy = vi.spyOn(tracked.response, "text").mockRejectedValue(new Error("unbounded"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => tracked.response),
    );

    const { provider } = await createOllamaEmbeddingProvider({
      config: {} as OpenClawConfig,
      provider: "ollama",
      model: "nomic-embed-text",
      fallback: "none",
      remote: { baseUrl: "http://127.0.0.1:11434" },
    });

    let error: unknown;
    try {
      await provider.embedQuery("hello");
    } catch (err) {
      error = err;
    }

    expect(String(error)).toContain("Ollama embed HTTP 503");
    expect(String(error)).toContain("ollama embed unavailable");
    expect(String(error)).not.toContain("tail");
    expect(tracked.wasCanceled()).toBe(true);
    expect(textSpy).not.toHaveBeenCalled();
  });

  it("reports malformed embed JSON with a provider-owned error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("{not json", {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    const { provider } = await createOllamaEmbeddingProvider({
      config: {} as OpenClawConfig,
      provider: "ollama",
      model: "nomic-embed-text",
      fallback: "none",
      remote: { baseUrl: "http://127.0.0.1:11434" },
    });

    await expect(provider.embedQuery("hello")).rejects.toThrow(
      "Ollama embed response: malformed JSON response",
    );
  });

  it("bounds successful embed JSON bodies before parsing", async () => {
    const streamed = createStreamingResponse({
      chunkCount: 32,
      chunkSize: 1024 * 1024,
      text: "x",
      headers: { "content-type": "application/json" },
    });
    const jsonSpy = vi.spyOn(streamed.response, "json").mockRejectedValue(new Error("unbounded"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => streamed.response),
    );

    const { provider } = await createOllamaEmbeddingProvider({
      config: {} as OpenClawConfig,
      provider: "ollama",
      model: "nomic-embed-text",
      fallback: "none",
      remote: { baseUrl: "http://127.0.0.1:11434" },
    });

    await expect(provider.embedQuery("hello")).rejects.toThrow(
      "Ollama embed response: JSON response exceeds 16777216 bytes",
    );

    expect(streamed.getReadCount()).toBeLessThan(32);
    expect(streamed.wasCanceled()).toBe(true);
    expect(jsonSpy).not.toHaveBeenCalled();
  });

  it("rejects non-number embedding values instead of zeroing them", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ embeddings: [["0.1", 0.2]] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    const { provider } = await createOllamaEmbeddingProvider({
      config: {} as OpenClawConfig,
      provider: "ollama",
      model: "nomic-embed-text",
      fallback: "none",
      remote: { baseUrl: "http://127.0.0.1:11434" },
    });

    await expect(provider.embedQuery("hello")).rejects.toThrow(
      "Ollama embed response contains a non-number embedding value",
    );
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
    const release = vi.fn();
    const acquireLocalService = vi.fn(async (_target: unknown) => ({ release }));
    const service = {
      command: "/usr/bin/ollama-spark",
      args: ["serve"],
      idleStopMs: 10,
    };

    const options = {
      config: {
        models: {
          providers: {
            "ollama-spark": {
              baseUrl: "http://spark.local:11434/v1",
              apiKey: "spark-key",
              headers: {
                "X-Custom-Ollama": "spark",
              },
              localService: service,
              models: [],
            },
          },
        },
      } as unknown as OpenClawConfig,
      provider: "ollama-spark",
      model: "ollama-spark/qwen3-embedding:4b",
      fallback: "none",
      acquireLocalService,
    };
    const { provider } = await createOllamaEmbeddingProvider(options);

    await provider.embedQuery("hello");

    expect(provider.model).toBe("qwen3-embedding:4b");
    expectEmbeddingFetch(fetchMock, "http://spark.local:11434/api/embed", {
      model: "qwen3-embedding:4b",
      input:
        "Instruct: Given a user query, retrieve relevant memory notes and documents\nQuery:hello",
      headers: {
        "Content-Type": "application/json",
        "X-Custom-Ollama": "spark",
        Authorization: "Bearer spark-key",
      },
    });
    expect(acquireLocalService).toHaveBeenCalledWith(
      {
        providerId: "ollama-spark",
        baseUrl: "http://spark.local:11434/v1",
        headers: {
          "Content-Type": "application/json",
          "X-Custom-Ollama": "spark",
          Authorization: "Bearer spark-key",
        },
      },
      undefined,
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it("does not lease a configured local service for a remote endpoint override", async () => {
    const fetchMock = mockEmbeddingFetch([1, 0]);
    const acquireLocalService = vi.fn(async () => ({ release: vi.fn() }));
    const { provider } = await createOllamaEmbeddingProvider({
      config: {
        models: {
          providers: {
            "ollama-spark": {
              baseUrl: "http://spark.local:11434/v1",
              localService: { command: process.execPath },
              models: [],
            },
          },
        },
      } as unknown as OpenClawConfig,
      provider: "ollama-spark",
      model: "nomic-embed-text",
      fallback: "none",
      remote: { baseUrl: "http://memory.local:11434" },
      acquireLocalService,
    });

    await expect(provider.embedQuery("hello")).resolves.toEqual([1, 0]);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(acquireLocalService).not.toHaveBeenCalled();
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

    const init = firstFetchInit(fetchMock);
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

    expectEmbeddingFetch(fetchMock, "https://ollama.com/api/embed", {
      input: "search_query: hello",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer ollama-cloud-key",
      },
    });
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

    const init = firstFetchInit(fetchMock);
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

    expectEmbeddingFetch(fetchMock, "https://memory.example.com/api/embed", {
      input: "search_query: hello",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer remote-host-key",
      },
    });
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

    const init = firstFetchInit(fetchMock);
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.Authorization).toBeUndefined();
  });

  it("preserves the legacy identity only for the default Ollama endpoint", async () => {
    const defaultEndpoint = await ollamaMemoryEmbeddingProviderAdapter.create({
      config: {} as OpenClawConfig,
      provider: "ollama",
      model: "nomic-embed-text",
      fallback: "none",
      remote: { baseUrl: "http://127.0.0.1:11434" },
      outputDimensionality: 2,
    });
    const customEndpoint = await ollamaMemoryEmbeddingProviderAdapter.create({
      config: {} as OpenClawConfig,
      provider: "ollama",
      model: "nomic-embed-text",
      fallback: "none",
      remote: { baseUrl: "http://10.0.0.5:11434" },
      outputDimensionality: 2,
    });

    expect(defaultEndpoint.runtime?.cacheKeyData).toEqual({
      provider: "ollama",
      model: "nomic-embed-text",
      outputDimensionality: 2,
    });
    expect(customEndpoint.runtime?.cacheKeyData).toEqual({
      provider: "ollama",
      baseUrl: "http://10.0.0.5:11434",
      model: "nomic-embed-text",
      outputDimensionality: 2,
    });
  });

  it("keys custom endpoints by non-secret headers while excluding credentials", async () => {
    const fetchMock = mockEmbeddingFetch([1, 0]);

    const result = await ollamaMemoryEmbeddingProviderAdapter.create({
      config: {
        models: {
          providers: {
            "ollama-cpu": {
              api: "ollama",
              baseUrl: "https://ollama-cpu.home.lab",
              headers: {
                "X-Ollama-Tenant": "tenant-a",
                "X-Api-Key": "super-secret", // pragma: allowlist secret
              },
              models: [],
            },
          },
        },
      } as unknown as OpenClawConfig,
      provider: "ollama-cpu",
      model: "qwen3-embedding:4b",
      fallback: "none",
    });

    await result.provider!.embedQuery("hello");
    expectEmbeddingFetch(fetchMock, "https://ollama-cpu.home.lab/api/embed", {
      model: "qwen3-embedding:4b",
      input:
        "Instruct: Given a user query, retrieve relevant memory notes and documents\nQuery:hello",
      headers: {
        "Content-Type": "application/json",
        "X-Ollama-Tenant": "tenant-a",
        "X-Api-Key": "super-secret", // pragma: allowlist secret
      },
    });
    expect(result.runtime?.cacheKeyData).toMatchObject({
      provider: "ollama-cpu",
      baseUrl: "https://ollama-cpu.home.lab",
      model: "qwen3-embedding:4b",
      headersHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(JSON.stringify(result.runtime?.cacheKeyData)).not.toContain("tenant-a");
    expect(JSON.stringify(result.runtime?.cacheKeyData)).not.toContain("super-secret");

    const otherTenant = await ollamaMemoryEmbeddingProviderAdapter.create({
      config: {
        models: {
          providers: {
            "ollama-cpu": {
              api: "ollama",
              baseUrl: "https://ollama-cpu.home.lab",
              headers: { "X-Ollama-Tenant": "tenant-b" },
              models: [],
            },
          },
        },
      } as unknown as OpenClawConfig,
      provider: "ollama-cpu",
      model: "qwen3-embedding:4b",
      fallback: "none",
    });
    expect(otherTenant.runtime?.cacheKeyData).not.toEqual(result.runtime?.cacheKeyData);
  });

  it("preserves configured provider aliases in the memory adapter", async () => {
    const result = await ollamaMemoryEmbeddingProviderAdapter.create({
      config: {
        models: {
          providers: {
            "ollama-spark": {
              baseUrl: "http://spark.local:11434/v1",
              models: [],
            },
          },
        },
      } as unknown as OpenClawConfig,
      provider: "ollama-spark",
      model: "ollama-spark/nomic-embed-text",
      fallback: "none",
    });

    expect(result.runtime?.cacheKeyData).toMatchObject({
      provider: "ollama-spark",
      model: "nomic-embed-text",
    });
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
