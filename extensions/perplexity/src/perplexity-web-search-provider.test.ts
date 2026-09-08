// Perplexity tests cover perplexity web search provider plugin behavior.
import { withEnvAsync } from "openclaw/plugin-sdk/test-env";
import { beforeEach, describe, expect, it, vi } from "vitest";

const withTrustedWebSearchEndpointMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/provider-web-search", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/provider-web-search")>();
  return {
    ...actual,
    withTrustedWebSearchEndpoint: withTrustedWebSearchEndpointMock,
  };
});

import { createPerplexityWebSearchProvider } from "./perplexity-web-search-provider.js";

const openRouterApiKeyEnv = ["OPENROUTER_API", "KEY"].join("_");
const perplexityApiKeyEnv = ["PERPLEXITY_API", "KEY"].join("_");
const openRouterPerplexityApiKey = ["sk", "or", "v1", "test"].join("-");
const directPerplexityApiKey = ["pplx", "test"].join("-");
const enterprisePerplexityApiKey = ["enterprise", "perplexity", "test"].join("-");

function mockPerplexityResponseOnce(body: unknown): void {
  withTrustedWebSearchEndpointMock.mockImplementationOnce(
    async (_params: { init: RequestInit }, run: (response: Response) => Promise<unknown>) =>
      await run(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
  );
}

function createConfiguredPerplexityTool(
  structured: boolean,
  apiKey = directPerplexityApiKey,
  cacheTtlMinutes?: number,
) {
  const webSearch = {
    apiKey,
    ...(structured ? {} : { baseUrl: "https://api.perplexity.ai" }),
  };
  const tool = createPerplexityWebSearchProvider().createTool({
    config: { plugins: { entries: { perplexity: { config: { webSearch } } } } },
    searchConfig: { cacheTtlMinutes },
  });
  if (!tool) {
    throw new Error("Expected tool definition");
  }
  return tool;
}

describe("perplexity web search provider", () => {
  beforeEach(() => {
    withTrustedWebSearchEndpointMock.mockReset();
  });

  it.each([true, false])(
    "redacts reflected request credentials (native=%s)",
    async (structured) => {
      withTrustedWebSearchEndpointMock.mockImplementationOnce(
        async (_params: unknown, run: (response: Response) => Promise<unknown>) =>
          run(new Response("rejected s7Key", { status: 401 })),
      );
      const label = structured ? "Perplexity Search" : "Perplexity";
      await expect(
        createConfiguredPerplexityTool(structured, "s7Key").execute({ query: "redaction" }),
      ).rejects.toThrow(`${label} API error (401): rejected ***`);
    },
  );

  it("points missing-key users to fetch/browser alternatives", async () => {
    await withEnvAsync(
      { [perplexityApiKeyEnv]: undefined, [openRouterApiKeyEnv]: undefined },
      async () => {
        const provider = createPerplexityWebSearchProvider();
        const tool = provider.createTool({ config: {}, searchConfig: {} });
        if (!tool) {
          throw new Error("Expected tool definition");
        }

        await expect(tool.execute({ query: "OpenClaw docs" })).resolves.toEqual({
          error: "missing_perplexity_api_key",
          message:
            "web_search (perplexity) needs an API key. Set PERPLEXITY_API_KEY or OPENROUTER_API_KEY in the Gateway environment, or configure plugins.entries.perplexity.config.webSearch.apiKey. If you do not want to configure a search API key, use web_fetch for a specific URL or the browser tool for interactive pages.",
          docs: "https://docs.openclaw.ai/tools/web",
        });
      },
    );
  });

  it.each([
    {
      name: "country before every other unsupported chat option",
      structured: false,
      args: {
        country: "US",
        language: "en",
        date_after: "2024-01-01",
        domain_filter: ["a.test"],
        max_tokens: 1,
      },
      error: "unsupported_country",
      message:
        "country filtering is only supported by the native Perplexity Search API path. Remove Perplexity baseUrl/model overrides or use a direct PERPLEXITY_API_KEY to enable it.",
    },
    {
      name: "language before unsupported chat dates, domains, and budget",
      structured: false,
      args: { language: "en", date_after: "2024-01-01", domain_filter: ["a.test"], max_tokens: 1 },
      error: "unsupported_language",
      message:
        "language filtering is only supported by the native Perplexity Search API path. Remove Perplexity baseUrl/model overrides or use a direct PERPLEXITY_API_KEY to enable it.",
    },
    {
      name: "date before unsupported chat domains and budget",
      structured: false,
      args: { date_after: "2024-01-01", domain_filter: ["a.test"], max_tokens: 1 },
      error: "unsupported_date_filter",
      message:
        "date_after/date_before are only supported by the native Perplexity Search API path. Remove Perplexity baseUrl/model overrides or use a direct PERPLEXITY_API_KEY to enable them.",
    },
    {
      name: "unsupported chat language before language validation and dates",
      structured: false,
      args: { language: "invalid", date_after: "2024-01-01" },
      error: "unsupported_language",
      message:
        "language filtering is only supported by the native Perplexity Search API path. Remove Perplexity baseUrl/model overrides or use a direct PERPLEXITY_API_KEY to enable it.",
    },
    {
      name: "unsupported chat date before a valid freshness conflict",
      structured: false,
      args: { freshness: "day", date_after: "2024-01-01" },
      error: "unsupported_date_filter",
      message:
        "date_after/date_before are only supported by the native Perplexity Search API path. Remove Perplexity baseUrl/model overrides or use a direct PERPLEXITY_API_KEY to enable them.",
    },
    {
      name: "domain before unsupported chat content budget",
      structured: false,
      args: { domain_filter: ["a.test"], max_tokens: 1 },
      error: "unsupported_domain_filter",
      message:
        "domain_filter is only supported by the native Perplexity Search API path. Remove Perplexity baseUrl/model overrides or use a direct PERPLEXITY_API_KEY to enable it.",
    },
    {
      name: "unsupported chat content budget",
      structured: false,
      args: { max_tokens_per_page: 1 },
      error: "unsupported_content_budget",
      message:
        "max_tokens and max_tokens_per_page are only supported by the native Perplexity Search API path. Remove Perplexity baseUrl/model overrides or use a direct PERPLEXITY_API_KEY to enable them.",
    },
    {
      name: "invalid freshness before reading an invalid native budget",
      structured: true,
      args: { freshness: "invalid", max_tokens: 0 },
      error: "invalid_freshness",
      message: "freshness must be day, week, month, or year.",
    },
    {
      name: "invalid freshness before reading an invalid chat budget",
      structured: false,
      args: { freshness: "invalid", country: "US", max_tokens: 0 },
      error: "invalid_freshness",
      message: "freshness must be day, week, month, or year.",
    },
    {
      name: "invalid native language before conflicting date filters",
      structured: true,
      args: { language: "invalid", freshness: "day", date_after: "invalid" },
      error: "invalid_language",
      message: "language must be a 2-letter ISO 639-1 code like 'en', 'de', or 'fr'.",
    },
    {
      name: "conflicting freshness before invalid date format",
      structured: true,
      args: { freshness: "day", date_after: "invalid" },
      error: "conflicting_time_filters",
      message:
        "freshness and date_after/date_before cannot be used together. Use either freshness (day/week/month/year) or a date range (date_after/date_before), not both.",
    },
    {
      name: "invalid date_after before invalid date_before",
      structured: true,
      args: { date_after: "invalid", date_before: "also-invalid" },
      error: "invalid_date",
      message: "date_after must be YYYY-MM-DD format.",
    },
    {
      name: "invalid date_before after valid date_after",
      structured: true,
      args: { date_after: "2024-01-01", date_before: "invalid" },
      error: "invalid_date",
      message: "date_before must be YYYY-MM-DD format.",
    },
    {
      name: "invalid chronological date range",
      structured: true,
      args: { date_after: "2024-06-01", date_before: "2024-01-01" },
      error: "invalid_date_range",
      message: "date_after must be before date_before.",
    },
    {
      name: "invalid date before mixed native domain filters",
      structured: true,
      args: { date_after: "invalid", domain_filter: ["allowed.test", "-denied.test"] },
      error: "invalid_date",
      message: "date_after must be YYYY-MM-DD format.",
    },
  ])(
    "preserves provider validation precedence: $name",
    async ({ structured, args, error, message }) => {
      await expect(
        createConfiguredPerplexityTool(structured).execute({ query: "validation", ...args }),
      ).resolves.toEqual({
        error,
        message,
        docs: "https://docs.openclaw.ai/tools/web",
      });
    },
  );

  it("validates chat token budgets before unsupported country precedence", async () => {
    await expect(
      createConfiguredPerplexityTool(false).execute({
        query: "validation",
        country: "US",
        max_tokens: 0,
      }),
    ).rejects.toThrow("max_tokens must be a positive integer.");
  });

  it.each([
    { name: "native Search API", webSearch: { apiKey: "pplx-test" } },
    {
      name: "chat completions",
      webSearch: { apiKey: "pplx-test", baseUrl: "https://api.perplexity.ai" },
    },
  ])("does not start an already canceled $name request", async ({ webSearch }) => {
    withTrustedWebSearchEndpointMock.mockResolvedValue({ results: [] });
    const tool = createPerplexityWebSearchProvider().createTool({
      config: { plugins: { entries: { perplexity: { config: { webSearch } } } } },
      searchConfig: {},
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }
    const controller = new AbortController();
    controller.abort(new Error("Perplexity caller canceled"));

    await expect(
      tool.execute({ query: "perplexity pre-canceled" }, { signal: controller.signal }),
    ).rejects.toThrow("Perplexity caller canceled");
    expect(withTrustedWebSearchEndpointMock).not.toHaveBeenCalled();
  });

  it.each([
    { name: "native Search API", structured: true, ttl: 0 },
    { name: "native Search API", structured: true, ttl: 1 },
    { name: "chat completions", structured: false, ttl: 0 },
    { name: "chat completions", structured: false, ttl: 1 },
  ])(
    "applies the current cache TTL of $ttl minutes to $name results",
    async ({ name, structured, ttl }) => {
      const now = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
      for (const result of ["initial", "fresh", "uncached"]) {
        mockPerplexityResponseOnce(
          structured
            ? { results: [{ title: result, url: `https://example.test/${result}` }] }
            : {
                choices: [{ message: { content: result } }],
                citations: [`https://example.test/${result}`],
              },
        );
      }

      try {
        const args = { query: `perplexity current cache TTL ${name} ${ttl}` };
        const originalTool = createConfiguredPerplexityTool(structured, undefined, 15);
        const initial = await originalTool.execute(args);
        expect(await originalTool.execute(args)).toEqual({ ...initial, cached: true });
        expect(withTrustedWebSearchEndpointMock).toHaveBeenCalledOnce();

        now.mockReturnValue(1_700_000_060_000);
        const currentTool = createConfiguredPerplexityTool(structured, undefined, ttl);
        const fresh = await currentTool.execute(args);
        expect(fresh.cached).toBeUndefined();
        expect(fresh).toMatchObject(
          structured
            ? { results: [expect.objectContaining({ url: "https://example.test/fresh" })] }
            : { citations: ["https://example.test/fresh"] },
        );
        expect(withTrustedWebSearchEndpointMock).toHaveBeenCalledTimes(2);

        const repeated = await currentTool.execute(args);
        expect(repeated.cached).toBe(ttl === 0 ? undefined : true);
        expect(withTrustedWebSearchEndpointMock).toHaveBeenCalledTimes(ttl === 0 ? 3 : 2);
        if (ttl === 0) {
          expect(await originalTool.execute(args)).toEqual({ ...initial, cached: true });
        }
      } finally {
        now.mockRestore();
      }
    },
  );

  it.each([
    { name: "missing choices", response: {} },
    { name: "whitespace content", response: { choices: [{ message: { content: " \n " } }] } },
  ])("rejects and does not cache chat-completions $name", async ({ name, response }) => {
    mockPerplexityResponseOnce(response);
    mockPerplexityResponseOnce({
      choices: [{ message: { content: "  Recovered grounded answer  " } }],
      citations: ["https://example.test/recovered"],
    });

    const tool = createConfiguredPerplexityTool(false);
    const args = { query: `perplexity empty answer ${name}` };
    await expect(tool.execute(args)).rejects.toThrow(
      "Perplexity search returned no final answer. Retry the query or choose another search provider.",
    );

    const recovered = await tool.execute(args);
    expect(recovered.content).toContain("  Recovered grounded answer  ");
    expect(recovered.citations).toEqual(["https://example.test/recovered"]);
    expect(withTrustedWebSearchEndpointMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    { name: "chat completions", structured: false, expectedRequests: 1 },
    { name: "native Search API", structured: true, expectedRequests: 2 },
  ])(
    "uses count as a cache dimension only when $name sends it upstream",
    async ({ name, structured, expectedRequests }) => {
      const response = structured
        ? { results: [] }
        : {
            choices: [
              {
                message: {
                  content: "Grounded answer",
                  annotations: [
                    {
                      type: "url_citation",
                      url_citation: { url: "https://example.test/citation" },
                    },
                  ],
                },
              },
            ],
          };
      mockPerplexityResponseOnce(response);
      if (structured) {
        mockPerplexityResponseOnce(response);
      }

      const tool = createConfiguredPerplexityTool(structured);
      const query = `perplexity cache count ${name}`;
      const first = await tool.execute({ query, count: 1 });
      const second = await tool.execute({ query, count: 7 });
      const third = await tool.execute({ query, count: 1 });

      expect(first.cached).toBeUndefined();
      expect(second.cached).toBe(structured ? undefined : true);
      expect(third.cached).toBe(true);
      expect(withTrustedWebSearchEndpointMock).toHaveBeenCalledTimes(expectedRequests);
      if (structured) {
        expect(first.results).toEqual([]);
        expect(first.count).toBe(0);
      } else {
        expect(first.content).toContain("Grounded answer");
        expect(first.citations).toEqual(["https://example.test/citation"]);
      }
    },
  );

  it.each([
    { name: "native Search API", webSearch: { apiKey: "pplx-test" } },
    {
      name: "chat completions",
      webSearch: { apiKey: "pplx-test", baseUrl: "https://api.perplexity.ai" },
    },
  ])("cancels an in-flight $name request", async ({ name, webSearch }) => {
    withTrustedWebSearchEndpointMock.mockImplementation(
      async (params: { signal?: AbortSignal }) =>
        await new Promise<never>((_resolve, reject) => {
          if (!params.signal) {
            reject(new Error("Perplexity request lost caller cancellation"));
            return;
          }
          params.signal.addEventListener("abort", () => reject(params.signal?.reason as Error), {
            once: true,
          });
        }),
    );
    const tool = createPerplexityWebSearchProvider().createTool({
      config: { plugins: { entries: { perplexity: { config: { webSearch } } } } },
      searchConfig: {},
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }
    const controller = new AbortController();
    const result = tool.execute(
      { query: `perplexity in-flight cancellation ${name}` },
      { signal: controller.signal },
    );

    await vi.waitFor(() => expect(withTrustedWebSearchEndpointMock).toHaveBeenCalledOnce());
    controller.abort(new Error("Perplexity request canceled in flight"));

    await expect(result).rejects.toThrow("Perplexity request canceled in flight");
    expect(withTrustedWebSearchEndpointMock.mock.calls[0]?.[0]?.signal).toBe(controller.signal);
  });

  it.each([
    {
      name: "configured direct key",
      key: directPerplexityApiKey,
      source: "config",
      url: "https://api.perplexity.ai/search",
    },
    {
      name: "configured OpenRouter key",
      key: openRouterPerplexityApiKey,
      source: "config",
      url: "https://openrouter.ai/api/v1/chat/completions",
      model: "perplexity/sonar-pro",
    },
    {
      name: "unrecognized configured key",
      key: enterprisePerplexityApiKey,
      source: "config",
      url: "https://api.perplexity.ai/search",
    },
    {
      name: "configured key ahead of native environment key",
      key: openRouterPerplexityApiKey,
      source: "config",
      fallbackEnvVar: "PERPLEXITY_API_KEY",
      url: "https://openrouter.ai/api/v1/chat/completions",
      model: "perplexity/sonar-pro",
    },
    {
      name: "native environment source ahead of key prefix",
      key: openRouterPerplexityApiKey,
      source: "env",
      fallbackEnvVar: "PERPLEXITY_API_KEY",
      url: "https://api.perplexity.ai/search",
    },
    {
      name: "OpenRouter environment source ahead of key prefix",
      key: directPerplexityApiKey,
      source: "env",
      fallbackEnvVar: "OPENROUTER_API_KEY",
      url: "https://openrouter.ai/api/v1/chat/completions",
      model: "perplexity/sonar-pro",
    },
    {
      name: "resolved direct SecretRef",
      key: directPerplexityApiKey,
      source: "secretRef",
      url: "https://api.perplexity.ai/search",
    },
    {
      name: "resolved OpenRouter SecretRef",
      key: openRouterPerplexityApiKey,
      source: "secretRef",
      url: "https://openrouter.ai/api/v1/chat/completions",
      model: "perplexity/sonar-pro",
    },
    {
      name: "explicit direct base URL",
      key: directPerplexityApiKey,
      source: "config",
      overrides: { baseUrl: " https://api.perplexity.ai/ " },
      url: "https://api.perplexity.ai/chat/completions",
      model: "sonar-pro",
    },
    {
      name: "explicit remote base URL",
      key: directPerplexityApiKey,
      source: "config",
      overrides: { baseUrl: "https://search.example/v1/" },
      url: "https://search.example/v1/chat/completions",
      model: "perplexity/sonar-pro",
    },
    {
      name: "explicit model",
      key: directPerplexityApiKey,
      source: "config",
      overrides: { model: " perplexity/sonar-reasoning-pro " },
      url: "https://api.perplexity.ai/chat/completions",
      model: "sonar-reasoning-pro",
    },
    {
      name: "blank overrides",
      key: directPerplexityApiKey,
      source: "config",
      overrides: { baseUrl: " ", model: " " },
      url: "https://api.perplexity.ai/search",
    },
  ] as const)("routes $name consistently through metadata, schema and execution", async (entry) => {
    const { key, source, url } = entry;
    const fallbackEnvVar = "fallbackEnvVar" in entry ? entry.fallbackEnvVar : undefined;
    await withEnvAsync(
      {
        [perplexityApiKeyEnv]: undefined,
        [openRouterApiKeyEnv]: undefined,
        ...(fallbackEnvVar
          ? { [fallbackEnvVar]: source === "env" ? key : directPerplexityApiKey }
          : {}),
      },
      async () => {
        const provider = createPerplexityWebSearchProvider();
        const config = {
          plugins: {
            entries: {
              perplexity: {
                config: {
                  webSearch: {
                    ...(source === "config" ? { apiKey: key } : {}),
                    ...(source === "secretRef"
                      ? {
                          apiKey: { source: "env", provider: "default", id: "PERPLEXITY_TEST_REF" },
                        }
                      : {}),
                    ...("overrides" in entry ? entry.overrides : {}),
                  },
                },
              },
            },
          },
        };
        const metadata = await provider.resolveRuntimeMetadata?.({
          config,
          resolvedCredential: { value: key, source, fallbackEnvVar },
        });
        const chat = "model" in entry;
        expect(metadata).toEqual({ perplexityTransport: chat ? "chat_completions" : "search_api" });
        if (source === "secretRef") {
          provider.setConfiguredCredentialValue?.(config, key);
        }
        const tool = provider.createTool({
          config,
          runtimeMetadata: { providerSource: "configured", diagnostics: [], ...metadata },
        });
        if (!tool) {
          throw new Error("Expected Perplexity tool");
        }
        if (chat) {
          expect(tool.parameters).not.toHaveProperty("properties.country");
        } else {
          expect(tool.parameters).toHaveProperty("properties.country");
        }
        mockPerplexityResponseOnce(
          chat ? { choices: [{ message: { content: "Grounded answer" } }] } : { results: [] },
        );
        const query = `routing ${entry.name}`;
        await tool.execute({ query });
        expect(withTrustedWebSearchEndpointMock).toHaveBeenCalledOnce();
        const [request] = withTrustedWebSearchEndpointMock.mock.calls[0] as [
          { url: string; init: RequestInit },
        ];
        expect(request.url).toBe(url);
        expect(new Headers(request.init.headers).get("authorization")).toBe(`Bearer ${key}`);
        expect(JSON.parse(request.init.body as string)).toEqual(
          chat
            ? { model: entry.model, messages: [{ role: "user", content: query }] }
            : { query, max_results: 5 },
        );
      },
    );
  });

  it("sends official date filter fields in the Search API request body", async () => {
    mockPerplexityResponseOnce({ results: [] });

    await withEnvAsync(
      { [perplexityApiKeyEnv]: directPerplexityApiKey, [openRouterApiKeyEnv]: undefined },
      async () => {
        const provider = createPerplexityWebSearchProvider();
        const tool = provider.createTool({ config: {}, searchConfig: {} });
        if (!tool) {
          throw new Error("Expected tool definition");
        }

        await tool.execute({
          query: "OpenClaw releases",
          date_after: "2024-01-01",
          date_before: "2024-06-30",
        });
      },
    );

    expect(withTrustedWebSearchEndpointMock).toHaveBeenCalledOnce();
    const [request] = withTrustedWebSearchEndpointMock.mock.calls[0] as [{ init: RequestInit }];
    expect(JSON.parse(request.init.body as string)).toEqual({
      query: "OpenClaw releases",
      max_results: 5,
      search_after_date_filter: "1/1/2024",
      search_before_date_filter: "6/30/2024",
    });
  });

  it.each([
    ["max_tokens", 0, "max_tokens must be a positive integer."],
    ["max_tokens", 1.5, "max_tokens must be a positive integer."],
    ["max_tokens", 1_000_001, "max_tokens must be a positive integer."],
    ["max_tokens_per_page", 1.5, "max_tokens_per_page must be a positive integer."],
  ])("rejects invalid native token budget %s=%s", async (key, value, message) => {
    await withEnvAsync(
      { [perplexityApiKeyEnv]: directPerplexityApiKey, [openRouterApiKeyEnv]: undefined },
      async () => {
        const provider = createPerplexityWebSearchProvider();
        const tool = provider.createTool({ config: {}, searchConfig: {} });
        if (!tool) {
          throw new Error("Expected tool definition");
        }

        await expect(tool.execute({ query: "OpenClaw docs", [key]: value })).rejects.toThrow(
          message,
        );
      },
    );
  });
});
