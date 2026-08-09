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

type EmbeddingProviderOptions = Parameters<typeof createOllamaEmbeddingProvider>[0];
type MemoryEmbeddingOptions = Parameters<typeof ollamaMemoryEmbeddingProviderAdapter.create>[0];

function createProviderConfig(
  provider: Record<string, unknown>,
  providerId = "ollama",
): OpenClawConfig {
  return { models: { providers: { [providerId]: provider } } } as unknown as OpenClawConfig;
}

function embeddingOptions<T extends EmbeddingProviderOptions | MemoryEmbeddingOptions>(
  overrides: Partial<T> = {},
): T {
  return {
    config: {} as OpenClawConfig,
    provider: "ollama",
    model: "nomic-embed-text",
    fallback: "none",
    ...(overrides.config ? {} : { remote: { baseUrl: "http://127.0.0.1:11434" } }),
    ...overrides,
  } as T;
}

async function createEmbeddingProvider(overrides: Partial<EmbeddingProviderOptions> = {}) {
  return await createOllamaEmbeddingProvider(embeddingOptions(overrides));
}

async function createMemoryEmbeddingProvider(overrides: Partial<MemoryEmbeddingOptions> = {}) {
  return await ollamaMemoryEmbeddingProviderAdapter.create(embeddingOptions(overrides));
}

function mockEmbeddingResponse(response: Response) {
  const fetchMock = vi.fn(async () => response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function mockEmbeddingFetch(embedding: number[]) {
  return mockEmbeddingResponse(
    new Response(JSON.stringify({ embeddings: [embedding] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
}

function mockBatchEmbeddingFetch(count: number) {
  const inputs: unknown[] = [];
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    inputs.push(readEmbeddingRequestBody(init).input);
    return new Response(
      JSON.stringify({ embeddings: Array.from({ length: count }, () => [1, 0]) }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, inputs };
}

async function embedTestQuery(overrides: Partial<EmbeddingProviderOptions> = {}, query = "hello") {
  const fetchMock = mockEmbeddingFetch([1, 0]);
  const { provider } = await createEmbeddingProvider(overrides);
  await provider.embedQuery(query);
  return { fetchMock, provider };
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

    const { provider } = await createEmbeddingProvider({ model: "unknown-embedder" });

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

    const { provider } = await createEmbeddingProvider({
      model: "unknown-embedder",
      outputDimensionality: 2,
    });

    const vector = await provider.embedQuery("hi");

    expect(vector).toHaveLength(2);
    expect(vector[0]).toBeCloseTo(0.6, 5);
    expect(vector[1]).toBeCloseTo(0.8, 5);
  });

  it("marks the configured Ollama origin for managed-proxy direct routing", async () => {
    const { fetchMock } = await embedTestQuery({
      remote: { baseUrl: "http://127.0.0.1:11434/v1" },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(firstGuardedFetchCall()).toMatchObject({
      url: "http://127.0.0.1:11434/api/embed",
      policy: { allowedOrigins: ["http://127.0.0.1:11434"] },
      configuredLocalOriginBaseUrl: "http://127.0.0.1:11434",
      auditContext: "ollama-memory-embedding",
    });
  });

  it("passes cloud Ollama origins through the guarded fetch contract", async () => {
    const { fetchMock } = await embedTestQuery({ remote: { baseUrl: "https://ollama.com" } });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(firstGuardedFetchCall()).toMatchObject({
      url: "https://ollama.com/api/embed",
      policy: { allowedOrigins: ["https://ollama.com"] },
      configuredLocalOriginBaseUrl: "https://ollama.com",
      auditContext: "ollama-memory-embedding",
    });
  });

  it("resolves configured base URL and headers without sending local marker auth", async () => {
    const { fetchMock } = await embedTestQuery({
      config: createProviderConfig({
        baseUrl: "http://127.0.0.1:11434/v1",
        apiKey: "ollama-\nlocal\r\n", // pragma: allowlist secret
        headers: { "X-Provider-Header": "provider" },
      }),
      model: "",
    });

    expectEmbeddingFetch(fetchMock, "http://127.0.0.1:11434/api/embed", {
      input: "search_query: hello",
      headers: {
        "Content-Type": "application/json",
        "X-Provider-Header": "provider",
      },
    });
  });

  it("resolves configured baseURL alias", async () => {
    const { fetchMock } = await embedTestQuery({
      config: createProviderConfig({ baseURL: "http://remote-ollama:11434/v1", models: [] }),
    });

    expectEmbeddingFetch(fetchMock, "http://remote-ollama:11434/api/embed", {
      model: "nomic-embed-text",
      input: "search_query: hello",
    });
  });

  it("fails fast when memory-search remote apiKey is an unresolved SecretRef", async () => {
    await expect(
      createEmbeddingProvider({
        remote: {
          baseUrl: "http://127.0.0.1:11434",
          apiKey: { source: "env", provider: "default", id: "OLLAMA_API_KEY" },
        },
      }),
    ).rejects.toThrow(/memory\.search\.remote\.apiKey: unresolved SecretRef/i);
  });

  it("falls back to env key when provider apiKey is an unresolved SecretRef", async () => {
    vi.stubEnv("OLLAMA_API_KEY", "ollama-env");

    const { fetchMock } = await embedTestQuery({
      config: createProviderConfig({
        baseUrl: "http://127.0.0.1:11434/v1",
        apiKey: { source: "env", provider: "default", id: "OLLAMA_API_KEY" },
        models: [],
      }),
    });

    expectEmbeddingFetch(fetchMock, "http://127.0.0.1:11434/api/embed", {
      input: "search_query: hello",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer ollama-env",
      },
    });
  });

  it("sends batch embeddings in one Ollama request", async () => {
    const { fetchMock, inputs } = mockBatchEmbeddingFetch(3);

    const { provider } = await createEmbeddingProvider();

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
    const tracked = createStreamingResponse({
      status: 503,
      chunkCount: 32,
      chunkSize: 1,
      text: `${"ollama embed unavailable ".repeat(1024)}tail`,
      headers: { "content-type": "text/plain" },
    });
    const textSpy = vi.spyOn(tracked.response, "text").mockRejectedValue(new Error("unbounded"));
    mockEmbeddingResponse(tracked.response);

    const { provider } = await createEmbeddingProvider();

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
    mockEmbeddingResponse(
      new Response("{not json", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const { provider } = await createEmbeddingProvider();

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
    mockEmbeddingResponse(streamed.response);

    const { provider } = await createEmbeddingProvider();

    await expect(provider.embedQuery("hello")).rejects.toThrow(
      "Ollama embed response: JSON response exceeds 16777216 bytes",
    );

    expect(streamed.getReadCount()).toBeLessThan(32);
    expect(streamed.wasCanceled()).toBe(true);
    expect(jsonSpy).not.toHaveBeenCalled();
  });

  it("rejects non-number embedding values instead of zeroing them", async () => {
    mockEmbeddingResponse(
      new Response(JSON.stringify({ embeddings: [["0.1", 0.2]] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const { provider } = await createEmbeddingProvider();

    await expect(provider.embedQuery("hello")).rejects.toThrow(
      "Ollama embed response contains a non-number embedding value",
    );
  });

  it("uses a retrieval query prefix for qwen3 embedding queries", async () => {
    const { fetchMock } = await embedTestQuery({ model: "qwen3-embedding:0.6b" }, "怀孕");

    expect(readFirstEmbeddingInput(fetchMock)).toBe(
      "Instruct: Given a user query, retrieve relevant memory notes and documents\nQuery:怀孕",
    );
  });

  it("uses the nomic search_query prefix for query embeddings", async () => {
    const { fetchMock } = await embedTestQuery({}, "What does $& mean?");

    expect(readFirstEmbeddingInput(fetchMock)).toBe("search_query: What does $& mean?");
  });

  it("uses the mixedbread retrieval prompt for query embeddings", async () => {
    const { fetchMock } = await embedTestQuery(
      { model: "mxbai-embed-large:latest" },
      "capital of Australia",
    );

    expect(readFirstEmbeddingInput(fetchMock)).toBe(
      "Represent this sentence for searching relevant passages: capital of Australia",
    );
  });

  it("keeps document batch embeddings raw", async () => {
    const { inputs } = mockBatchEmbeddingFetch(2);

    const { provider } = await createEmbeddingProvider({ model: "qwen3-embedding:0.6b" });

    await expect(provider.embedBatch(["doc one", "doc two"])).resolves.toHaveLength(2);
    expect(inputs).toEqual([["doc one", "doc two"]]);
  });

  it("uses custom Ollama provider config and strips that provider prefix", async () => {
    const release = vi.fn();
    const acquireLocalService = vi.fn(async (_target: unknown) => ({ release }));
    const service = {
      command: "/usr/bin/ollama-spark",
      args: ["serve"],
      idleStopMs: 10,
    };

    const { fetchMock, provider } = await embedTestQuery({
      config: createProviderConfig(
        {
          baseUrl: "http://spark.local:11434/v1",
          apiKey: "spark-key",
          headers: { "X-Custom-Ollama": "spark" },
          localService: service,
          models: [],
        },
        "ollama-spark",
      ),
      provider: "ollama-spark",
      model: "ollama-spark/qwen3-embedding:4b",
      acquireLocalService,
    });

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
    const { provider } = await createEmbeddingProvider({
      config: createProviderConfig(
        {
          baseUrl: "http://spark.local:11434/v1",
          localService: { command: process.execPath },
          models: [],
        },
        "ollama-spark",
      ),
      provider: "ollama-spark",
      remote: { baseUrl: "http://memory.local:11434" },
      acquireLocalService,
    });

    await expect(provider.embedQuery("hello")).resolves.toEqual([1, 0]);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(acquireLocalService).not.toHaveBeenCalled();
  });

  it("does not attach pure env OLLAMA_API_KEY to a local host", async () => {
    vi.stubEnv("OLLAMA_API_KEY", "ollama-cloud-key");

    const { fetchMock } = await embedTestQuery();

    const init = firstFetchInit(fetchMock);
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.Authorization).toBeUndefined();
  });

  it("attaches pure env OLLAMA_API_KEY to Ollama Cloud", async () => {
    vi.stubEnv("OLLAMA_API_KEY", "ollama-cloud-key");

    const { fetchMock } = await embedTestQuery({ remote: { baseUrl: "https://ollama.com" } });

    expectEmbeddingFetch(fetchMock, "https://ollama.com/api/embed", {
      input: "search_query: hello",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer ollama-cloud-key",
      },
    });
  });

  it("does not attach provider apiKey to a different remote embedding host", async () => {
    const { fetchMock } = await embedTestQuery({
      config: createProviderConfig({
        baseUrl: "http://127.0.0.1:11434",
        apiKey: "provider-host-key",
        models: [],
      }),
      remote: { baseUrl: "https://memory.example.com" },
    });

    const init = firstFetchInit(fetchMock);
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.Authorization).toBeUndefined();
  });

  it("attaches remote apiKey to a remote embedding host", async () => {
    const { fetchMock } = await embedTestQuery({
      remote: { baseUrl: "https://memory.example.com", apiKey: "remote-host-key" },
    });

    expectEmbeddingFetch(fetchMock, "https://memory.example.com/api/embed", {
      input: "search_query: hello",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer remote-host-key",
      },
    });
  });

  it("honors remote local marker as an explicit no-auth opt-out", async () => {
    const { fetchMock } = await embedTestQuery({
      config: createProviderConfig({
        baseUrl: "http://127.0.0.1:11434",
        apiKey: "provider-host-key",
        models: [],
      }),
      remote: { apiKey: "ollama-local" }, // pragma: allowlist secret
    });

    const init = firstFetchInit(fetchMock);
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.Authorization).toBeUndefined();
  });

  it("preserves the legacy identity only for the default Ollama endpoint", async () => {
    const defaultEndpoint = await createMemoryEmbeddingProvider({ outputDimensionality: 2 });
    const customEndpoint = await createMemoryEmbeddingProvider({
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

    const result = await createMemoryEmbeddingProvider({
      config: createProviderConfig(
        {
          api: "ollama",
          baseUrl: "https://ollama-cpu.home.lab",
          headers: {
            "X-Ollama-Tenant": "tenant-a",
            "X-Api-Key": "super-secret", // pragma: allowlist secret
          },
          models: [],
        },
        "ollama-cpu",
      ),
      provider: "ollama-cpu",
      model: "qwen3-embedding:4b",
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

    const otherTenant = await createMemoryEmbeddingProvider({
      config: createProviderConfig(
        {
          api: "ollama",
          baseUrl: "https://ollama-cpu.home.lab",
          headers: { "X-Ollama-Tenant": "tenant-b" },
          models: [],
        },
        "ollama-cpu",
      ),
      provider: "ollama-cpu",
      model: "qwen3-embedding:4b",
    });
    expect(otherTenant.runtime?.cacheKeyData).not.toEqual(result.runtime?.cacheKeyData);
  });

  it("preserves configured provider aliases in the memory adapter", async () => {
    const result = await createMemoryEmbeddingProvider({
      config: createProviderConfig(
        { baseUrl: "http://spark.local:11434/v1", models: [] },
        "ollama-spark",
      ),
      provider: "ollama-spark",
      model: "ollama-spark/nomic-embed-text",
    });

    expect(result.runtime?.cacheKeyData).toMatchObject({
      provider: "ollama-spark",
      model: "nomic-embed-text",
    });
  });

  it("marks inline memory batches as local-server timeout work", async () => {
    const result = await createMemoryEmbeddingProvider();

    expect(result.runtime?.inlineBatchTimeoutMs).toBe(600_000);
  });
});
