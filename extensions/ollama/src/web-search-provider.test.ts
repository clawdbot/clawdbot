// Ollama tests cover web search provider plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { SecretInput } from "openclaw/plugin-sdk/secret-input";
import { withEnvAsync } from "openclaw/plugin-sdk/test-env";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createStreamingResponse } from "../../test-support/streaming-error-response.js";
import { createOllamaWebSearchProvider as createContractOllamaWebSearchProvider } from "../web-search-contract-api.js";
import { createLazyOllamaWebSearchProvider } from "./web-search-provider-registration.js";
import { createOllamaWebSearchProvider } from "./web-search-provider.js";

const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

type OllamaProviderConfigOverride = Partial<{
  api: "ollama";
  apiKey: SecretInput;
  baseUrl: string;
  baseURL: string;
  models: NonNullable<
    NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]>[string]
  >["models"];
}>;

function createOllamaConfig(provider: OllamaProviderConfigOverride = {}): OpenClawConfig {
  return {
    models: {
      providers: {
        ollama: {
          baseUrl: "http://ollama.local:11434/v1",
          api: "ollama",
          models: [],
          ...provider,
        },
      },
    },
  };
}

async function runOllamaWebSearchSetup(
  config: OpenClawConfig,
  provider = createOllamaWebSearchProvider(),
) {
  if (!provider.runSetup) {
    throw new Error("Expected Ollama web search setup");
  }
  const notes: Array<{ title?: string; message: string }> = [];
  const next = await provider.runSetup({
    config,
    prompter: {
      note: async (message: string, title?: string) => {
        notes.push({ title, message });
      },
    },
  } as never);
  return { next, notes };
}

function guardedResponse(
  body: string | object,
  init: ResponseInit = {},
  release: () => Promise<void> = vi.fn(async () => {}),
) {
  const json = typeof body !== "string";
  return {
    response: new Response(json ? JSON.stringify(body) : body, {
      ...(json ? { status: 200, headers: { "Content-Type": "application/json" } } : {}),
      ...init,
    }),
    release,
  };
}

const DEFAULT_SEARCH_RESULT = { title: "Cloud", url: "https://example.com", content: "result" };
const LOCAL_THEN_CLOUD_URLS = [
  "http://ollama.local:11434/api/experimental/web_search",
  "http://ollama.local:11434/api/web_search",
  "https://ollama.com/api/web_search",
];

function searchResponse(
  result: Partial<typeof DEFAULT_SEARCH_RESULT> = {},
  release?: () => Promise<void>,
) {
  return guardedResponse({ results: [{ ...DEFAULT_SEARCH_RESULT, ...result }] }, {}, release);
}

function mockLocalMissesThenCloudSearch() {
  fetchWithSsrFGuardMock
    .mockResolvedValueOnce(guardedResponse("not found", { status: 404 }))
    .mockResolvedValueOnce(guardedResponse("not found", { status: 404 }))
    .mockResolvedValueOnce(searchResponse());
}

function mockSuccessfulSearchResponse() {
  fetchWithSsrFGuardMock.mockResolvedValue(guardedResponse({ results: [] }));
}

async function runOllamaWebSearch(
  config: OpenClawConfig,
  query = "openclaw",
  count?: number,
): Promise<Record<string, unknown>> {
  const tool = createOllamaWebSearchProvider().createTool({
    config,
  } as never);
  if (!tool) {
    throw new Error("Expected Ollama web search tool");
  }
  return await tool.execute({
    query,
    ...(count === undefined ? {} : { count }),
  });
}

type GuardedRequest = {
  url: string;
  signal?: AbortSignal;
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  };
  timeoutMs?: number;
  policy: Record<string, unknown>;
  auditContext: string;
};

function fetchRequest(index = 0): GuardedRequest {
  const request = fetchWithSsrFGuardMock.mock.calls.at(index)?.at(0);
  if (!request || typeof request !== "object") {
    throw new Error(`expected guarded fetch request ${index}`);
  }
  return request as GuardedRequest;
}

function expectOllamaWebSearchRequest(params: {
  url: string;
  query?: string;
  maxResults?: number;
  headers?: Record<string, string>;
  policy: Record<string, unknown>;
}) {
  const request = fetchRequest();
  expect(request).toEqual({
    url: params.url,
    init: {
      method: "POST",
      headers: params.headers ?? { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: params.query ?? "openclaw",
        max_results: params.maxResults ?? 5,
      }),
    },
    timeoutMs: 15_000,
    policy: params.policy,
    auditContext: "ollama-web-search.search",
  });
  // The deadline must be guard-owned so it also bounds DNS/proxy preflight.
  expect(request.init.signal).toBeUndefined();
}

function expectSingleSearchResultUrl(results: unknown, url: string) {
  if (!Array.isArray(results)) {
    throw new Error("Expected search results array");
  }
  expect(results).toHaveLength(1);
  const [result] = results;
  if (!result || typeof result !== "object") {
    throw new Error("Expected search result object");
  }
  expect((result as { url?: unknown }).url).toBe(url);
}

function expectHostedRequest(apiKey: string) {
  expectOllamaWebSearchRequest({
    url: "https://ollama.com/api/web_search",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    policy: {
      allowPrivateNetwork: true,
      hostnameAllowlist: ["ollama.com"],
    },
  });
}

async function expectConfiguredRefFailure(input: SecretInput, message: string) {
  await expect(runOllamaWebSearch(createOllamaConfig({ apiKey: input }))).rejects.toThrow(message);
  expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
}

async function expectSetupNote(config: OpenClawConfig, message: string) {
  const { next, notes } = await runOllamaWebSearchSetup(config);
  expect(next).toBe(config);
  expect(notes).toEqual([{ title: "Ollama Web Search", message }]);
}

describe("ollama web search provider", () => {
  beforeEach(() => {
    fetchWithSsrFGuardMock.mockReset();
  });

  it("registers a keyless web search provider", () => {
    const provider = createContractOllamaWebSearchProvider();

    expect(provider.id).toBe("ollama");
    expect(provider.label).toBe("Ollama Web Search");
    expect(provider.requiresCredential).toBe(false);
    expect(provider.envVars).toEqual([]);
  });

  it("uses the configured Ollama host and enables the plugin in config", async () => {
    const provider = createOllamaWebSearchProvider();
    if (!provider.applySelectionConfig) {
      throw new Error("Expected applySelectionConfig to be defined");
    }

    const applied = provider.applySelectionConfig({});

    expect(provider.credentialPath).toBe("");
    expect(applied.plugins?.entries?.ollama?.enabled).toBe(true);
    mockSuccessfulSearchResponse();
    await runOllamaWebSearch(createOllamaConfig());
    expect(fetchRequest().url).toBe("http://ollama.local:11434/api/experimental/web_search");
  });

  it("passes caller cancellation to the guard without replacing its owned timeout", async () => {
    mockSuccessfulSearchResponse();
    const tool = createOllamaWebSearchProvider().createTool({ config: createOllamaConfig() });
    if (!tool) {
      throw new Error("Expected tool definition");
    }
    const controller = new AbortController();

    await tool.execute({ query: "ollama active cancellation" }, { signal: controller.signal });

    expect(fetchRequest().signal).toBe(controller.signal);
    expect(fetchRequest().init.signal).toBeUndefined();
  });

  it("does not start fallback attempts after caller cancellation", async () => {
    mockSuccessfulSearchResponse();
    const tool = createOllamaWebSearchProvider().createTool({ config: createOllamaConfig() });
    if (!tool) {
      throw new Error("Expected tool definition");
    }
    const controller = new AbortController();
    controller.abort(new Error("Ollama caller canceled"));

    await expect(
      tool.execute({ query: "ollama pre-canceled" }, { signal: controller.signal }),
    ).rejects.toThrow("Ollama caller canceled");
    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
  });

  it.each<[string, () => OpenClawConfig, string]>([
    [
      "prefers the plugin web search base URL over the model provider host",
      () => ({
        ...createOllamaConfig(),
        plugins: {
          entries: {
            ollama: { config: { webSearch: { baseUrl: "http://localhost:11434/v1" } } },
          },
        },
      }),
      "http://localhost:11434/api/experimental/web_search",
    ],
    [
      "uses the configured Ollama Cloud host for web search",
      () => createOllamaConfig({ baseUrl: "https://ollama.com" }),
      "https://ollama.com/api/web_search",
    ],
    [
      "uses the model provider baseURL alias for web search",
      () =>
        createOllamaConfig({
          baseUrl: undefined,
          baseURL: "http://remote-ollama:11434/v1",
        } as OllamaProviderConfigOverride),
      "http://remote-ollama:11434/api/experimental/web_search",
    ],
  ])("%s", async (_title, createConfig, expectedUrl) => {
    mockSuccessfulSearchResponse();
    await runOllamaWebSearch(createConfig());
    expect(fetchRequest().url).toBe(expectedUrl);
  });

  it("maps generic search args into the local Ollama proxy endpoint", async () => {
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValue(
      searchResponse(
        {
          title: "OpenClaw",
          url: "https://openclaw.ai/docs",
          content: "Gateway docs and setup details",
        },
        release,
      ),
    );

    const result = await runOllamaWebSearch(createOllamaConfig(), "openclaw docs", 3);

    expectOllamaWebSearchRequest({
      url: "http://ollama.local:11434/api/experimental/web_search",
      query: "openclaw docs",
      maxResults: 3,
      policy: {
        allowPrivateNetwork: true,
        hostnameAllowlist: ["ollama.local"],
      },
    });
    expect(result.query).toBe("openclaw docs");
    expect(result.provider).toBe("ollama");
    expect(result.count).toBe(1);
    expectSingleSearchResultUrl(result.results, "https://openclaw.ai/docs");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("tries the future local direct endpoint when the local proxy endpoint is missing", async () => {
    fetchWithSsrFGuardMock
      .mockResolvedValueOnce(guardedResponse("not found", { status: 404 }))
      .mockResolvedValueOnce(searchResponse({ title: "Legacy" }));

    const result = await runOllamaWebSearch(createOllamaConfig());

    expect(result.count).toBe(1);
    expectSingleSearchResultUrl(result.results, "https://example.com");

    expect(fetchWithSsrFGuardMock.mock.calls.map((call) => call[0].url)).toEqual([
      "http://ollama.local:11434/api/experimental/web_search",
      "http://ollama.local:11434/api/web_search",
    ]);
  });

  it("uses only the hosted endpoint for Ollama Cloud base URLs", async () => {
    fetchWithSsrFGuardMock.mockResolvedValueOnce(searchResponse());

    const result = await runOllamaWebSearch(
      createOllamaConfig({
        baseUrl: "https://ollama.com",
        apiKey: "cloud-config-secret",
      }),
    );

    expect(result.count).toBe(1);
    expect(fetchWithSsrFGuardMock.mock.calls).toHaveLength(1);
    expect(fetchRequest().url).toBe("https://ollama.com/api/web_search");
    expectHostedRequest("cloud-config-secret");
  });

  it("uses an env Ollama key only for the cloud fallback from a local host", async () => {
    await withEnvAsync({ OLLAMA_API_KEY: "cloud-secret" }, async () => {
      mockLocalMissesThenCloudSearch();

      const result = await runOllamaWebSearch(createOllamaConfig());

      expect(result.count).toBe(1);
      const firstHeaders = fetchRequest().init?.headers;
      const cloudHeaders = fetchRequest(2).init?.headers;
      expect(firstHeaders?.Authorization).toBeUndefined();
      expect(cloudHeaders?.Authorization).toBe("Bearer cloud-secret");
      expect(fetchWithSsrFGuardMock.mock.calls.map((call) => call[0].url)).toEqual(
        LOCAL_THEN_CLOUD_URLS,
      );
      expect(fetchRequest(2).url).toBe("https://ollama.com/api/web_search");
    });
  });

  it.each<SecretInput>([
    {
      source: "env",
      provider: "default",
      id: "OLLAMA_WEB_SEARCH_REF",
    },
    "$OLLAMA_WEB_SEARCH_REF",
    "${OLLAMA_WEB_SEARCH_REF}",
  ])("resolves provider apiKey env SecretRef %# for web search requests", async (apiKey) => {
    const refEnvVar = "OLLAMA_WEB_SEARCH_REF";
    const resolvedKey = "resolved-ref-value";
    await withEnvAsync({ [refEnvVar]: resolvedKey }, async () => {
      fetchWithSsrFGuardMock.mockResolvedValueOnce(searchResponse());

      const result = await runOllamaWebSearch(
        createOllamaConfig({
          baseUrl: "https://ollama.com",
          apiKey,
        }),
      );

      expect(result.count).toBe(1);
      expectHostedRequest(resolvedKey);
    });
  });

  it("keeps the ambient cloud fallback when a configured selected-host key is also set", async () => {
    // Regression guard (mixed credentials): a configured selected-host key must not suppress the
    // separate ambient OLLAMA_API_KEY used for the final Ollama Cloud attempt after the two
    // selected-host attempts fail.
    const ambientEnvVar = ["OLLAMA_API", "KEY"].join("_");
    await withEnvAsync({ [ambientEnvVar]: "ambient-cloud-key" }, async () => {
      mockLocalMissesThenCloudSearch();

      const result = await runOllamaWebSearch(
        createOllamaConfig({ apiKey: "configured-host-key" }),
      );

      expect(result.count).toBe(1);
      expect(fetchWithSsrFGuardMock.mock.calls.map((call) => call[0].url)).toEqual(
        LOCAL_THEN_CLOUD_URLS,
      );
      // Selected-host attempts carry the configured key; the cloud fallback carries the ambient key.
      expect(fetchRequest(0).init?.headers?.Authorization).toBe("Bearer configured-host-key");
      expect(fetchRequest(1).init?.headers?.Authorization).toBe("Bearer configured-host-key");
      expect(fetchRequest(2).init?.headers?.Authorization).toBe("Bearer ambient-cloud-key");
    });
  });

  it.each<[string, SecretInput, string]>([
    [
      "does not use ambient env fallback when a configured apiKey SecretRef is unavailable",
      { source: "env", provider: "default", id: "OLLAMA_WEB_SEARCH_REF" },
      "models.providers.ollama.apiKey env SecretRef OLLAMA_WEB_SEARCH_REF is not available",
    ],
    [
      "does not use ambient env fallback when configured apiKey SecretRef shorthand $OLLAMA_WEB_SEARCH_REF is unavailable",
      "$OLLAMA_WEB_SEARCH_REF",
      "models.providers.ollama.apiKey env SecretRef OLLAMA_WEB_SEARCH_REF is not available",
    ],
    [
      "does not use ambient env fallback when configured apiKey SecretRef shorthand ${OLLAMA_WEB_SEARCH_REF} is unavailable",
      "${OLLAMA_WEB_SEARCH_REF}",
      "models.providers.ollama.apiKey env SecretRef OLLAMA_WEB_SEARCH_REF is not available",
    ],
    [
      "does not use ambient env fallback for non-env apiKey SecretRefs",
      { source: "file", provider: "vault", id: "/providers/ollama/web-search" },
      "models.providers.ollama.apiKey SecretRef cannot be resolved by Ollama web search",
    ],
  ])("%s", async (_title, apiKey, error) => {
    const ambientEnvVar = ["OLLAMA_API", "KEY"].join("_");
    const ambientKey = ["ambient", "cloud", "value"].join("-");
    await withEnvAsync(
      { OLLAMA_WEB_SEARCH_REF: undefined, [ambientEnvVar]: ambientKey },
      async () => {
        await expectConfiguredRefFailure(apiKey, error);
      },
    );
  });

  it("surfaces Ollama signin guidance for 401 responses", async () => {
    fetchWithSsrFGuardMock.mockResolvedValue(guardedResponse("", { status: 401 }));

    await expect(runOllamaWebSearch({}, "latest openclaw release")).rejects.toThrow(
      "ollama signin",
    );
  });

  it("surfaces API-key guidance for hosted Ollama 401 responses", async () => {
    fetchWithSsrFGuardMock.mockResolvedValue(guardedResponse("", { status: 401 }));

    await expect(
      runOllamaWebSearch(createOllamaConfig({ baseUrl: "https://ollama.com" })),
    ).rejects.toThrow("Set OLLAMA_API_KEY or configure models.providers.ollama.apiKey");
  });

  it("reports malformed Ollama web search JSON with a stable provider error", async () => {
    fetchWithSsrFGuardMock.mockResolvedValueOnce(guardedResponse("{ nope"));

    await expect(runOllamaWebSearch(createOllamaConfig())).rejects.toThrow(
      "Ollama web search: malformed JSON response",
    );
  });

  it("bounds successful Ollama web search JSON bodies before parsing", async () => {
    const streamed = createStreamingResponse({
      chunkCount: 32,
      chunkSize: 1024 * 1024,
      text: "x",
      headers: { "content-type": "application/json" },
    });
    const jsonSpy = vi.spyOn(streamed.response, "json").mockRejectedValue(new Error("unbounded"));
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: streamed.response,
      release: vi.fn(async () => {}),
    });

    await expect(runOllamaWebSearch(createOllamaConfig())).rejects.toThrow(
      "Ollama web search: JSON response exceeds 16777216 bytes",
    );

    expect(streamed.getReadCount()).toBeLessThan(32);
    expect(streamed.wasCanceled()).toBe(true);
    expect(jsonSpy).not.toHaveBeenCalled();
  });

  it("warns when Ollama is not reachable during setup without cancelling", async () => {
    fetchWithSsrFGuardMock.mockRejectedValueOnce(new Error("connect failed"));

    await expectSetupNote(
      createOllamaConfig(),
      [
        "Ollama Web Search requires Ollama to be running.",
        "Expected host: http://ollama.local:11434",
        "Start Ollama before using this provider.",
      ].join("\n"),
    );
  });

  it.each([
    {
      name: "the configured model provider",
      config: createOllamaConfig({ baseUrl: "https://ollama.com", apiKey: "hosted-test-key" }),
    },
    {
      name: "the plugin's higher-priority web search override",
      config: {
        ...createOllamaConfig({ apiKey: "hosted-test-key" }),
        plugins: {
          entries: {
            ollama: { config: { webSearch: { baseUrl: "https://ollama.com/v1" } } },
          },
        },
      },
    },
  ])("does not require a local daemon when $name selects hosted search", async ({ config }) => {
    fetchWithSsrFGuardMock
      .mockResolvedValueOnce(guardedResponse({ models: [] }))
      .mockResolvedValueOnce(guardedResponse({ error: "not signed in" }, { status: 401 }));

    const { next, notes } = await runOllamaWebSearchSetup(
      config,
      createLazyOllamaWebSearchProvider(),
    );

    expect(next).toBe(config);
    expect(notes).toEqual([]);
    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "the configured model provider",
      config: createOllamaConfig({ baseUrl: "https://ollama.com" }),
    },
    {
      name: "the plugin's higher-priority web search override",
      config: {
        ...createOllamaConfig(),
        plugins: {
          entries: {
            ollama: { config: { webSearch: { baseUrl: "https://ollama.com/v1" } } },
          },
        },
      },
    },
  ])("warns when $name selects hosted search without an API key", async ({ config }) => {
    await withEnvAsync({ OLLAMA_API_KEY: undefined }, async () => {
      const { next, notes } = await runOllamaWebSearchSetup(
        config,
        createLazyOllamaWebSearchProvider(),
      );

      expect(next).toBe(config);
      expect(notes).toEqual([
        {
          title: "Ollama Web Search",
          message:
            "Hosted Ollama Web Search requires an API key. Set OLLAMA_API_KEY or configure models.providers.ollama.apiKey.",
        },
      ]);
      expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
    });
  });

  it("accepts the ambient API key for hosted Ollama search setup", async () => {
    await withEnvAsync({ OLLAMA_API_KEY: "hosted-env-key" }, async () => {
      const config = createOllamaConfig({
        baseUrl: "https://ollama.com",
        apiKey: "OLLAMA_API_KEY",
      });
      const { next, notes } = await runOllamaWebSearchSetup(
        config,
        createLazyOllamaWebSearchProvider(),
      );

      expect(next).toBe(config);
      expect(notes).toEqual([]);
      expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
    });
  });

  it("resolves env var when config apiKey is a marker string", async () => {
    await withEnvAsync({ OLLAMA_API_KEY: "real-secret-from-env" }, async () => {
      mockSuccessfulSearchResponse();
      await runOllamaWebSearch(
        createOllamaConfig({
          apiKey: "OLLAMA_API_KEY",
          baseUrl: "https://ollama.com",
        }),
      );
      expect(fetchRequest().init?.headers?.Authorization).toBe("Bearer real-secret-from-env");
    });
  });

  it("warns when ollama signin is missing during setup without cancelling", async () => {
    fetchWithSsrFGuardMock
      .mockResolvedValueOnce(guardedResponse({ models: [] }))
      .mockResolvedValueOnce(
        guardedResponse(
          { error: "not signed in", signin_url: "https://ollama.com/signin" },
          { status: 401 },
        ),
      );

    await expectSetupNote(
      createOllamaConfig(),
      "Ollama Web Search requires `ollama signin`.\nhttps://ollama.com/signin",
    );
  });
});
