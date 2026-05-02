import type { LookupFn } from "openclaw/plugin-sdk/ssrf-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

const endpointMockState = vi.hoisted(() => ({
  calls: [] as Array<{ url: string; timeoutSeconds: number; init: RequestInit }>,
  responses: [] as Response[],
}));

vi.mock("openclaw/plugin-sdk/provider-web-search", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/provider-web-search")>();
  const runEndpoint = async (
    params: { url: string; timeoutSeconds: number; init: RequestInit },
    run: (response: Response) => Promise<unknown>,
  ) => {
    endpointMockState.calls.push(params);
    const response = endpointMockState.responses.shift();
    if (!response) {
      throw new Error("Missing mocked SearXNG response.");
    }
    return await run(response);
  };
  return {
    ...actual,
    withSelfHostedWebSearchEndpoint: vi.fn(runEndpoint),
    withTrustedWebSearchEndpoint: vi.fn(runEndpoint),
  };
});

import { __testing, runSearxngSearch } from "./searxng-client.js";

function createLookupFn(addresses: Array<{ address: string; family: number }>): LookupFn {
  return vi.fn(async (_hostname: string, options?: unknown) => {
    if (typeof options === "number" || !options || !(options as { all?: boolean }).all) {
      return addresses[0];
    }
    return addresses;
  }) as unknown as LookupFn;
}

describe("searxng client", () => {
  beforeEach(() => {
    endpointMockState.calls = [];
    endpointMockState.responses = [];
    __testing.SEARXNG_SEARCH_CACHE.clear();
  });

  it("preserves a configured base-path prefix when building the search URL", () => {
    expect(
      __testing.buildSearxngSearchUrl({
        baseUrl: "https://search.example.com/searxng",
        query: "openclaw",
        categories: "general,news",
        language: "en",
      }),
    ).toBe(
      "https://search.example.com/searxng/search?q=openclaw&format=json&categories=general%2Cnews&language=en",
    );
  });

  it("parses SearXNG JSON results and applies the requested count cap", () => {
    expect(
      __testing.parseSearxngResponseText(
        JSON.stringify({
          results: [
            { title: "One", url: "https://example.com/1", content: "A" },
            { title: "Two", url: "https://example.com/2", content: "B" },
          ],
        }),
        1,
      ),
    ).toEqual([{ title: "One", url: "https://example.com/1", content: "A" }]);
  });

  it("retries an empty category search with general results", async () => {
    endpointMockState.responses.push(
      new Response(JSON.stringify({ results: [] }), { status: 200 }),
      new Response(
        JSON.stringify({
          results: [
            {
              title: "Beijing hourly weather",
              url: "https://example.com/weather",
              content: "Hourly forecast",
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const result = await runSearxngSearch({
      baseUrl: "http://127.0.0.1:8888",
      query: "beijing hourly weather",
      categories: "weather",
      count: 5,
    });

    expect(endpointMockState.calls).toHaveLength(2);
    expect(new URL(endpointMockState.calls[0].url).searchParams.get("categories")).toBe("weather");
    expect(new URL(endpointMockState.calls[1].url).searchParams.get("categories")).toBe("general");
    expect(result).toMatchObject({
      provider: "searxng",
      count: 1,
      results: [
        expect.objectContaining({
          url: "https://example.com/weather",
        }),
      ],
    });
  });

  it("does not retry empty general category searches", async () => {
    endpointMockState.responses.push(
      new Response(JSON.stringify({ results: [] }), { status: 200 }),
    );

    const result = await runSearxngSearch({
      baseUrl: "http://127.0.0.1:8888",
      query: "openclaw",
      categories: "general",
      count: 5,
    });

    expect(endpointMockState.calls).toHaveLength(1);
    expect(result).toMatchObject({
      provider: "searxng",
      count: 0,
      results: [],
    });
  });

  it("detects category searches that should retry with general", () => {
    expect(__testing.shouldRetryEmptyCategorySearchWithGeneral("weather")).toBe(true);
    expect(__testing.shouldRetryEmptyCategorySearchWithGeneral("weather,news")).toBe(true);
    expect(__testing.shouldRetryEmptyCategorySearchWithGeneral("general")).toBe(false);
    expect(__testing.shouldRetryEmptyCategorySearchWithGeneral("general,news")).toBe(false);
    expect(__testing.shouldRetryEmptyCategorySearchWithGeneral(undefined)).toBe(false);
  });

  it("preserves img_src from image search results", () => {
    expect(
      __testing.parseSearxngResponseText(
        JSON.stringify({
          results: [
            {
              title: "Kitten",
              url: "https://example.com/kitten",
              content: "A cute kitten",
              img_src: "https://cdn.example.com/kitten.jpg",
            },
            {
              title: "No Image",
              url: "https://example.com/text",
              content: "Text only",
            },
            {
              title: "Bad Image",
              url: "https://example.com/bad",
              img_src: { url: "https://cdn.example.com/bad.jpg" },
            },
          ],
        }),
        10,
      ),
    ).toEqual([
      {
        title: "Kitten",
        url: "https://example.com/kitten",
        content: "A cute kitten",
        img_src: "https://cdn.example.com/kitten.jpg",
      },
      {
        title: "No Image",
        url: "https://example.com/text",
        content: "Text only",
        img_src: undefined,
      },
      {
        title: "Bad Image",
        url: "https://example.com/bad",
        content: undefined,
        img_src: undefined,
      },
    ]);
  });

  it("drops malformed result rows instead of failing the whole response", () => {
    expect(
      __testing.parseSearxngResponseText(
        JSON.stringify({
          results: [
            { title: "One", url: "https://example.com/1", content: "A" },
            { title: { text: "bad" }, url: "https://example.com/2" },
            { title: "Three", url: 3, content: "bad-url" },
            { title: "Four", url: "https://example.com/4", content: { text: "bad" } },
          ],
        }),
        10,
      ),
    ).toEqual([
      { title: "One", url: "https://example.com/1", content: "A" },
      { title: "Four", url: "https://example.com/4", content: undefined },
    ]);
  });

  it("rejects invalid JSON bodies", () => {
    expect(() => __testing.parseSearxngResponseText("{", 5)).toThrow(
      "SearXNG returned invalid JSON.",
    );
  });

  it("allows https public hosts", async () => {
    await expect(
      __testing.validateSearxngBaseUrl(
        "https://search.example.com/searxng",
        createLookupFn([{ address: "93.184.216.34", family: 4 }]),
      ),
    ).resolves.toBe("strict");
  });

  it("allows cleartext private-network hosts", async () => {
    await expect(
      __testing.validateSearxngBaseUrl(
        "http://matrix-synapse:8080",
        createLookupFn([{ address: "10.0.0.5", family: 4 }]),
      ),
    ).resolves.toBe("selfHosted");
  });

  it("routes https private-network hosts through the self-hosted guard", async () => {
    await expect(
      __testing.validateSearxngBaseUrl(
        "https://search.internal/searxng",
        createLookupFn([{ address: "10.0.0.5", family: 4 }]),
      ),
    ).resolves.toBe("selfHosted");
  });

  it("rejects cleartext public hosts", async () => {
    await expect(
      __testing.validateSearxngBaseUrl(
        "http://search.example.com:8080",
        createLookupFn([{ address: "93.184.216.34", family: 4 }]),
      ),
    ).rejects.toThrow(
      "SearXNG HTTP base URL must target a trusted private or loopback host. Use https:// for public hosts.",
    );
  });
});
