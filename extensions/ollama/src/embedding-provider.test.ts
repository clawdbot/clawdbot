import { coerceErrorMessage } from "openclaw/plugin-sdk/error-runtime";
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
  formatErrorMessage: coerceErrorMessage,
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

  it.each(["ollama", "ollama-private"])(
    "resolves selected %s provider credential and header SecretRefs before ambient cloud auth",
    async (providerId) => {
      vi.stubEnv("OLLAMA_API_KEY", "synthetic-cloud-key");
      vi.stubEnv("OLLAMA_SELECTED_HOST_KEY", "synthetic-selected-host-key");
      vi.stubEnv("OLLAMA_PROXY_KEY", "synthetic-proxy-key");

      const { fetchMock } = await embedTestQuery({
        config: createProviderConfig(
          {
            baseUrl: "https://selected-private-host.invalid/v1",
            apiKey: {
              source: "env",
              provider: "default",
              id: "OLLAMA_SELECTED_HOST_KEY",
            },
            headers: {
              "X-Proxy-Auth": {
                source: "env",
                provider: "default",
                id: "OLLAMA_PROXY_KEY",
              },
            },
            models: [],
          },
          providerId,
        ),
        provider: providerId,
      });

      expectEmbeddingFetch(fetchMock, "https://selected-private-host.invalid/api/embed", {
        input: "search_query: hello",
        headers: {
          "Content-Type": "application/json",
          "X-Proxy-Auth": "synthetic-proxy-key",
          Authorization: "Bearer synthetic-selected-host-key",
        },
      });
    },
  );

  it.each([
    { providerId: "ollama", surface: "apiKey", source: "env" },
    { providerId: "ollama-private", surface: "apiKey", source: "env" },
    { providerId: "ollama", surface: "headers", source: "env" },
    { providerId: "ollama-private", surface: "headers", source: "env" },
    { providerId: "ollama", surface: "apiKey", source: "file" },
    { providerId: "ollama", surface: "headers", source: "file" },
    { providerId: "ollama-private", surface: "apiKey", source: "exec" },
    { providerId: "ollama-private", surface: "headers", source: "exec" },
  ])(
    "fails closed before any request for unresolved $providerId $surface $source SecretRefs",
    async ({ providerId, surface, source }) => {
      vi.stubEnv("OLLAMA_API_KEY", "synthetic-cloud-key");
      vi.stubEnv("OLLAMA_SELECTED_HOST_KEY", "synthetic-selected-host-key");
      vi.stubEnv("OLLAMA_MISSING_SELECTED_SECRET", "");
      const fetchMock = mockEmbeddingFetch([1, 0]);
      const unavailableSecret = {
        source,
        provider: "default" as const,
        id:
          source === "file"
            ? "/synthetic/missing-ollama-secret"
            : source === "exec"
              ? "synthetic-missing-ollama-secret"
              : "OLLAMA_MISSING_SELECTED_SECRET",
      };
      const selectedHostKey = {
        source: "env" as const,
        provider: "default" as const,
        id: "OLLAMA_SELECTED_HOST_KEY",
      };

      await expect(
        createEmbeddingProvider({
          config: createProviderConfig(
            {
              baseUrl: "https://selected-private-host.invalid/v1",
              apiKey: surface === "apiKey" ? unavailableSecret : selectedHostKey,
              ...(surface === "headers"
                ? {
                    headers: {
                      "X-Proxy-Auth": unavailableSecret,
                    },
                  }
                : {}),
              models: [],
            },
            providerId,
          ),
          provider: providerId,
        }),
      ).rejects.toThrow(
        `models.providers.${providerId}.${
          surface === "headers" ? "headers.X-Proxy-Auth" : "apiKey"
        }`,
      );
      expect(fetchMock).not.toHaveBeenCalled();
      expect(fetchConfiguredLocalOriginWithSsrFGuardMock).not.toHaveBeenCalled();
    },
  );

  it.each(["OLLAMA_API_KEY", "ollama-local"])(
    "keeps explicit selected-host SecretRef value %s opaque",
    async (resolvedSecret) => {
      vi.stubEnv("OLLAMA_API_KEY", "synthetic-cloud-key");
      vi.stubEnv("OLLAMA_SELECTED_HOST_KEY", resolvedSecret);

      const { fetchMock } = await embedTestQuery({
        config: createProviderConfig({
          baseUrl: "https://selected-private-host.invalid/v1",
          apiKey: {
            source: "env",
            provider: "default",
            id: "OLLAMA_SELECTED_HOST_KEY",
          },
          models: [],
        }),
      });

      expectEmbeddingFetch(fetchMock, "https://selected-private-host.invalid/api/embed", {
        input: "search_query: hello",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${resolvedSecret}`,
        },
      });
    },
  );

  it.each(["$OLLAMA_SELECTED_HOST_KEY", "${OLLAMA_SELECTED_HOST_KEY}"])(
    "resolves selected-host env shorthand SecretRef %s before ambient cloud auth",
    async (apiKey) => {
      vi.stubEnv("OLLAMA_API_KEY", "synthetic-cloud-key");
      vi.stubEnv("OLLAMA_SELECTED_HOST_KEY", "synthetic-selected-host-key");

      const { fetchMock } = await embedTestQuery({
        config: createProviderConfig({
          baseUrl: "https://selected-private-host.invalid/v1",
          apiKey,
          models: [],
        }),
      });

      expectEmbeddingFetch(fetchMock, "https://selected-private-host.invalid/api/embed", {
        input: "search_query: hello",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer synthetic-selected-host-key",
        },
      });
    },
  );

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

  it.each([
    {
      name: "bare qwen",
      model: "qwen3-embedding:0.6b",
      query: "怀孕",
      expected:
        "Instruct: Given a user query, retrieve relevant memory notes and documents\nQuery:怀孕",
    },
    {
      name: "namespaced qwen",
      model: "library/qwen3-embedding:0.6b",
      query: "怀孕",
      expected:
        "Instruct: Given a user query, retrieve relevant memory notes and documents\nQuery:怀孕",
    },
    {
      name: "registry-qualified qwen",
      model: "registry.ollama.ai/library/qwen3-embedding:0.6b",
      query: "怀孕",
      expected:
        "Instruct: Given a user query, retrieve relevant memory notes and documents\nQuery:怀孕",
    },
    {
      name: "bare nomic",
      model: "nomic-embed-text",
      query: "What does $& mean?",
      expected: "search_query: What does $& mean?",
    },
    {
      name: "namespaced nomic",
      model: "library/nomic-embed-text:latest",
      query: "What does $& mean?",
      expected: "search_query: What does $& mean?",
    },
    {
      name: "bare mixedbread",
      model: "mxbai-embed-large:latest",
      query: "capital of Australia",
      expected: "Represent this sentence for searching relevant passages: capital of Australia",
    },
    {
      name: "namespaced mixedbread",
      model: "mixedbread/mxbai-embed-large:latest",
      query: "capital of Australia",
      expected: "Represent this sentence for searching relevant passages: capital of Australia",
    },
    {
      name: "unknown namespaced model",
      model: "custom/unknown-embedder:latest",
      query: "unmodified query",
      expected: "unmodified query",
    },
  ])("uses the correct retrieval query for $name", async ({ model, query, expected }) => {
    const { fetchMock } = await embedTestQuery({ model }, query);

    expectEmbeddingFetch(fetchMock, "http://127.0.0.1:11434/api/embed", {
      model,
      input: expected,
    });
  });

  it.each(["qwen3-embedding:0.6b", "library/qwen3-embedding:0.6b"])(
    "keeps document batch embeddings raw for %s",
    async (model) => {
      const { inputs } = mockBatchEmbeddingFetch(2);
      const { provider } = await createEmbeddingProvider({ model });

      await expect(provider.embedBatch(["doc one", "doc two"])).resolves.toHaveLength(2);
      expect(inputs).toEqual([["doc one", "doc two"]]);
    },
  );

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

  it.each(["Authorization", "authorization", "AUTHORIZATION"])(
    "keeps explicit remote %s header ahead of ambient Ollama Cloud credentials",
    async (headerName) => {
      vi.stubEnv("OLLAMA_API_KEY", "synthetic-cloud-tenant-b");

      const { fetchMock } = await embedTestQuery({
        remote: {
          baseUrl: "https://ollama.com",
          headers: { [headerName]: "Bearer synthetic-explicit-tenant-a" },
        },
      });

      expectEmbeddingFetch(fetchMock, "https://ollama.com/api/embed", {
        input: "search_query: hello",
        headers: {
          "Content-Type": "application/json",
          [headerName]: "Bearer synthetic-explicit-tenant-a",
        },
      });
    },
  );

  it("uses explicit header auth without resolving an inactive selected-host apiKey SecretRef", async () => {
    vi.stubEnv("OLLAMA_API_KEY", "synthetic-cloud-key");
    vi.stubEnv("OLLAMA_MISSING_SELECTED_SECRET", "");

    const { fetchMock } = await embedTestQuery({
      config: createProviderConfig({
        baseUrl: "https://selected-private-host.invalid/v1",
        apiKey: {
          source: "env",
          provider: "default",
          id: "OLLAMA_MISSING_SELECTED_SECRET",
        },
        models: [],
      }),
      remote: {
        baseUrl: "https://selected-private-host.invalid",
        headers: { authorization: "Bearer synthetic-explicit-tenant-a" },
      },
    });

    expectEmbeddingFetch(fetchMock, "https://selected-private-host.invalid/api/embed", {
      input: "search_query: hello",
      headers: {
        "Content-Type": "application/json",
        authorization: "Bearer synthetic-explicit-tenant-a",
      },
    });
  });

  it("skips a selected-host SecretRef header overridden case-insensitively by remote auth", async () => {
    vi.stubEnv("OLLAMA_API_KEY", "synthetic-cloud-key");
    vi.stubEnv("OLLAMA_SELECTED_HOST_KEY", "synthetic-selected-host-key");
    vi.stubEnv("OLLAMA_MISSING_SELECTED_SECRET", "");

    const { fetchMock } = await embedTestQuery({
      config: createProviderConfig({
        baseUrl: "https://selected-private-host.invalid/v1",
        apiKey: {
          source: "env",
          provider: "default",
          id: "OLLAMA_SELECTED_HOST_KEY",
        },
        headers: {
          "X-Proxy-Auth": {
            source: "env",
            provider: "default",
            id: "OLLAMA_MISSING_SELECTED_SECRET",
          },
        },
        models: [],
      }),
      remote: {
        baseUrl: "https://selected-private-host.invalid",
        headers: { "x-proxy-auth": "synthetic-remote-header" },
      },
    });

    expectEmbeddingFetch(fetchMock, "https://selected-private-host.invalid/api/embed", {
      input: "search_query: hello",
      headers: {
        "Content-Type": "application/json",
        "x-proxy-auth": "synthetic-remote-header",
        Authorization: "Bearer synthetic-selected-host-key",
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

  it("does not forward selected-host SecretRefs to a different remote embedding host", async () => {
    vi.stubEnv("OLLAMA_API_KEY", "synthetic-cloud-key");
    vi.stubEnv("OLLAMA_SELECTED_HOST_KEY", "synthetic-selected-host-key");
    vi.stubEnv("OLLAMA_SELECTED_PROXY_KEY", "synthetic-selected-proxy-key");

    const { fetchMock } = await embedTestQuery({
      config: createProviderConfig({
        baseUrl: "https://selected-private-host.invalid/v1",
        apiKey: {
          source: "env",
          provider: "default",
          id: "OLLAMA_SELECTED_HOST_KEY",
        },
        headers: {
          "X-Selected-Host-Auth": {
            source: "env",
            provider: "default",
            id: "OLLAMA_SELECTED_PROXY_KEY",
          },
        },
        models: [],
      }),
      remote: {
        baseUrl: "https://remote-embedding-host.invalid",
        apiKey: "synthetic-remote-key",
        headers: { "X-Remote-Auth": "synthetic-remote-header" },
      },
    });

    expectEmbeddingFetch(fetchMock, "https://remote-embedding-host.invalid/api/embed", {
      input: "search_query: hello",
      headers: {
        "Content-Type": "application/json",
        "X-Remote-Auth": "synthetic-remote-header",
        Authorization: "Bearer synthetic-remote-key",
      },
    });
  });

  it("ignores an inactive selected-host SecretRef when remote credentials own another host", async () => {
    vi.stubEnv("OLLAMA_API_KEY", "synthetic-cloud-key");
    vi.stubEnv("OLLAMA_MISSING_SELECTED_SECRET", "");

    const { fetchMock } = await embedTestQuery({
      config: createProviderConfig({
        baseUrl: "https://selected-private-host.invalid/v1",
        apiKey: {
          source: "env",
          provider: "default",
          id: "OLLAMA_MISSING_SELECTED_SECRET",
        },
        models: [],
      }),
      remote: {
        baseUrl: "https://remote-embedding-host.invalid",
        apiKey: "synthetic-remote-key",
      },
    });

    expectEmbeddingFetch(fetchMock, "https://remote-embedding-host.invalid/api/embed", {
      input: "search_query: hello",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer synthetic-remote-key",
      },
    });
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

  it("keys memory cache identity by resolved tenant SecretRefs without exposing their values", async () => {
    vi.stubEnv("OLLAMA_SELECTED_HOST_KEY", "synthetic-selected-host-key");
    vi.stubEnv("OLLAMA_SELECTED_TENANT", "synthetic-tenant-a");
    const options = {
      config: createProviderConfig(
        {
          api: "ollama",
          baseUrl: "https://selected-private-host.invalid",
          apiKey: {
            source: "env",
            provider: "default",
            id: "OLLAMA_SELECTED_HOST_KEY",
          },
          headers: {
            "X-Ollama-Tenant": {
              source: "env",
              provider: "default",
              id: "OLLAMA_SELECTED_TENANT",
            },
          },
          models: [],
        },
        "ollama-private",
      ),
      provider: "ollama-private",
      model: "qwen3-embedding:4b",
    };

    const firstTenant = await createMemoryEmbeddingProvider(options);
    vi.stubEnv("OLLAMA_SELECTED_TENANT", "synthetic-tenant-b");
    const secondTenant = await createMemoryEmbeddingProvider(options);

    expect(firstTenant.runtime?.cacheKeyData).not.toEqual(secondTenant.runtime?.cacheKeyData);
    expect(JSON.stringify(firstTenant.runtime?.cacheKeyData)).not.toContain("synthetic-tenant-a");
    expect(JSON.stringify(firstTenant.runtime?.cacheKeyData)).not.toContain(
      "synthetic-selected-host-key",
    );
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
