// Perplexity tests cover perplexity web search provider plugin behavior.
import { withEnv, withEnvAsync } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";

const withTrustedWebSearchEndpointMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/provider-web-search", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/provider-web-search")>();
  return {
    ...actual,
    withTrustedWebSearchEndpoint: withTrustedWebSearchEndpointMock,
  };
});

import { createPerplexityWebSearchProvider } from "./perplexity-web-search-provider.js";
import { testing } from "./perplexity-web-search-provider.runtime.js";

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

function createConfiguredPerplexityTool(structured: boolean) {
  const webSearch = {
    apiKey: directPerplexityApiKey,
    ...(structured ? {} : { baseUrl: "https://api.perplexity.ai" }),
  };
  const tool = createPerplexityWebSearchProvider().createTool({
    config: { plugins: { entries: { perplexity: { config: { webSearch } } } } },
    searchConfig: {},
  });
  if (!tool) {
    throw new Error("Expected tool definition");
  }
  return tool;
}

describe("perplexity web search provider", () => {
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
    { name: "native Search API", webSearch: { apiKey: "pplx-test" } },
    {
      name: "chat completions",
      webSearch: { apiKey: "pplx-test", baseUrl: "https://api.perplexity.ai" },
    },
  ])("does not start an already canceled $name request", async ({ webSearch }) => {
    withTrustedWebSearchEndpointMock.mockReset();
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
    { name: "missing choices", response: {} },
    { name: "empty choices", response: { choices: [] } },
    { name: "missing message", response: { choices: [{}] } },
    { name: "missing content", response: { choices: [{ message: {} }] } },
    { name: "null content", response: { choices: [{ message: { content: null } }] } },
    { name: "empty content", response: { choices: [{ message: { content: "" } }] } },
    { name: "whitespace content", response: { choices: [{ message: { content: " \n " } }] } },
    {
      name: "citations without an answer",
      response: {
        choices: [{ message: { content: null } }],
        citations: ["https://example.test/source"],
      },
    },
    {
      name: "tool calls without an answer",
      response: {
        choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [] } }],
      },
    },
    {
      name: "audio without an answer",
      response: { choices: [{ message: { content: null, audio: { id: "audio-response" } } }] },
    },
  ])("rejects and does not cache chat-completions $name", async ({ name, response }) => {
    withTrustedWebSearchEndpointMock.mockReset();
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
      withTrustedWebSearchEndpointMock.mockReset();
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
    withTrustedWebSearchEndpointMock.mockReset();
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
    withTrustedWebSearchEndpointMock.mockReset();
  });

  it("infers provider routing from api key prefixes", () => {
    expect(testing.inferPerplexityBaseUrlFromApiKey("pplx-abc")).toBe("direct");
    expect(testing.inferPerplexityBaseUrlFromApiKey("sk-or-v1-abc")).toBe("openrouter");
    expect(testing.inferPerplexityBaseUrlFromApiKey("unknown")).toBeUndefined();
  });

  it("resolves base url from auth source and request model by transport", () => {
    expect(testing.resolvePerplexityBaseUrl(undefined, "perplexity_env")).toBe(
      "https://api.perplexity.ai",
    );
    expect(testing.resolvePerplexityBaseUrl(undefined, "openrouter_env")).toBe(
      "https://openrouter.ai/api/v1",
    );
    expect(
      testing.resolvePerplexityRequestModel("https://api.perplexity.ai", "perplexity/sonar-pro"),
    ).toBe("sonar-pro");
    expect(
      testing.resolvePerplexityRequestModel("https://openrouter.ai/api/v1", "perplexity/sonar-pro"),
    ).toBe("perplexity/sonar-pro");
  });

  it("chooses direct search_api transport only for direct base urls without legacy overrides", () => {
    expect(
      testing.resolvePerplexityTransport({
        baseUrl: "https://api.perplexity.ai",
      }).transport,
    ).toBe("chat_completions");

    expect(
      testing.resolvePerplexityTransport({
        apiKey: "pplx-secret",
      }).transport,
    ).toBe("search_api");
  });

  it("prefers explicit baseUrl over key-based defaults", () => {
    expect(
      testing.resolvePerplexityBaseUrl({ baseUrl: "https://example.com" }, "config", "pplx-123"),
    ).toBe("https://example.com");
  });

  it("resolves OpenRouter env auth and transport", () => {
    withEnv(
      { [perplexityApiKeyEnv]: undefined, [openRouterApiKeyEnv]: openRouterPerplexityApiKey },
      () => {
        expect(testing.resolvePerplexityApiKey(undefined)).toEqual({
          apiKey: openRouterPerplexityApiKey,
          source: "openrouter_env",
        });
        expect(testing.resolvePerplexityTransport(undefined)).toEqual({
          apiKey: openRouterPerplexityApiKey,
          source: "openrouter_env",
          baseUrl: "https://openrouter.ai/api/v1",
          model: "perplexity/sonar-pro",
          transport: "chat_completions",
        });
      },
    );
  });

  it("uses native Search API for direct Perplexity when no legacy overrides exist", () => {
    withEnv(
      { [perplexityApiKeyEnv]: directPerplexityApiKey, [openRouterApiKeyEnv]: undefined },
      () => {
        expect(testing.resolvePerplexityTransport(undefined)).toEqual({
          apiKey: directPerplexityApiKey,
          source: "perplexity_env",
          baseUrl: "https://api.perplexity.ai",
          model: "perplexity/sonar-pro",
          transport: "search_api",
        });
      },
    );
  });

  it("switches direct Perplexity to chat completions when model override is configured", () => {
    expect(testing.resolvePerplexityModel({ model: "perplexity/sonar-reasoning-pro" })).toBe(
      "perplexity/sonar-reasoning-pro",
    );
    expect(
      testing.resolvePerplexityTransport({
        apiKey: directPerplexityApiKey,
        model: "perplexity/sonar-reasoning-pro",
      }),
    ).toEqual({
      apiKey: directPerplexityApiKey,
      source: "config",
      baseUrl: "https://api.perplexity.ai",
      model: "perplexity/sonar-reasoning-pro",
      transport: "chat_completions",
    });
  });

  it("treats unrecognized configured keys as direct Perplexity by default", () => {
    expect(
      testing.resolvePerplexityTransport({
        apiKey: enterprisePerplexityApiKey,
      }),
    ).toEqual({
      apiKey: enterprisePerplexityApiKey,
      source: "config",
      baseUrl: "https://api.perplexity.ai",
      model: "perplexity/sonar-pro",
      transport: "search_api",
    });
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
