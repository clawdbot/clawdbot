// SearXNG contracts are exercised through the public search boundary.
import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const endpointMockState = vi.hoisted(() => ({
  calls: [] as Array<{
    mode: "selfHosted" | "strict";
    url: string;
    timeoutSeconds: number;
    init: RequestInit;
    signal?: AbortSignal;
  }>,
  responses: [] as Response[],
}));
const ssrfMockState = vi.hoisted(() => ({ addresses: [] as string[] }));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    assertHttpUrlTargetsPrivateNetwork: vi.fn(async () => {
      if (!ssrfMockState.addresses.every((address) => actual.isPrivateIpAddress(address))) {
        throw new Error(
          "SearXNG HTTP base URL must target a trusted private or loopback host. Use https:// for public hosts.",
        );
      }
    }),
    resolvePinnedHostnameWithPolicy: vi.fn(async () => ({ addresses: ssrfMockState.addresses })),
  };
});

vi.mock("openclaw/plugin-sdk/provider-web-search", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/provider-web-search")>();
  const runEndpoint = async (
    mode: "selfHosted" | "strict",
    params: { url: string; timeoutSeconds: number; init: RequestInit; signal?: AbortSignal },
    run: (response: Response) => Promise<unknown>,
  ) => {
    endpointMockState.calls.push({ mode, ...params });
    const response = endpointMockState.responses.shift();
    if (!response) {
      throw new Error("Missing mocked SearXNG response.");
    }
    return await run(response);
  };
  return {
    ...actual,
    withSelfHostedWebSearchEndpoint: vi.fn((params, run) => runEndpoint("selfHosted", params, run)),
    withTrustedWebSearchEndpoint: vi.fn((params, run) => runEndpoint("strict", params, run)),
  };
});

import { runSearxngSearch, testing } from "./searxng-client.js";

describe("searxng client", () => {
  beforeEach(() => {
    endpointMockState.calls = [];
    endpointMockState.responses = [];
    ssrfMockState.addresses = ["127.0.0.1"];
    testing.SEARXNG_SEARCH_CACHE.clear();
  });

  it.each([
    [
      "http://127.0.0.1:8888/searxng",
      "http://127.0.0.1:8888/searxng/search?q=openclaw&format=json&categories=general%2Cnews&language=en",
    ],
    [
      "http://127.0.0.1:8888/search/",
      "http://127.0.0.1:8888/search?q=openclaw&format=json&categories=general%2Cnews&language=en",
    ],
    [
      "http://127.0.0.1:8888/search",
      "http://127.0.0.1:8888/search?q=openclaw&format=json&categories=general%2Cnews&language=en",
    ],
  ])("builds the public request URL from %s", async (baseUrl, expectedUrl) => {
    endpointMockState.responses.push(Response.json({ results: [] }));

    await runSearxngSearch({
      baseUrl,
      query: "openclaw",
      categories: "general,news",
      language: "en",
    });

    expect(endpointMockState.calls[0]?.url).toBe(expectedUrl);
  });

  it("normalizes, filters, and caps provider result rows", async () => {
    endpointMockState.responses.push(
      Response.json({
        results: [
          {
            title: "Kitten",
            url: "https://example.com/kitten",
            content: "A cute kitten",
            img_src: "https://cdn.example.com/kitten.jpg",
          },
          { title: { text: "bad" }, url: "https://example.com/bad-title" },
          { title: "bad URL", url: 3 },
          { title: "No snippet", url: "https://example.com/text", content: { text: "bad" } },
          { title: "Capped", url: "https://example.com/capped" },
        ],
      }),
    );

    const result = await runSearxngSearch({
      baseUrl: "http://127.0.0.1:8888",
      query: "kittens",
      count: 2,
    });

    expect(result.count).toBe(2);
    const rows = result.results as Array<Record<string, unknown>>;
    expect(rows.map((row) => row.url)).toEqual([
      "https://example.com/kitten",
      "https://example.com/text",
    ]);
    expect(String(rows[0]?.title)).toContain("Kitten");
    expect(String(rows[0]?.snippet)).toContain("A cute kitten");
    expect(rows[0]?.img_src).toBe("https://cdn.example.com/kitten.jpg");
  });

  it.each(["weather", "weather,news"])(
    "retries an empty category search with general results (%s)",
    async (categories) => {
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
        categories,
        count: 5,
      });

      expect(endpointMockState.calls).toHaveLength(2);
      const firstCall = expectDefined(endpointMockState.calls[0], "first SearXNG endpoint call");
      const secondCall = expectDefined(endpointMockState.calls[1], "second SearXNG endpoint call");
      expect(new URL(firstCall.url).searchParams.get("categories")).toBe(categories);
      expect(new URL(secondCall.url).searchParams.get("categories")).toBe("general");
      expect(result.provider).toBe("searxng");
      expect(result.query).toBe("beijing hourly weather");
      expect(result.count).toBe(1);
      const results = result.results as Array<{
        url?: string;
        siteName?: string;
        title?: string;
        snippet?: string;
      }>;
      expect(results).toHaveLength(1);
      expect(results[0]?.url).toBe("https://example.com/weather");
      expect(results[0]?.siteName).toBe("example.com");
      expect(results[0]?.title).toContain("Beijing hourly weather");
      expect(results[0]?.snippet).toContain("Hourly forecast");
      expect(result.externalContent).toEqual({
        provider: "searxng",
        source: "web_search",
        untrusted: true,
        wrapped: true,
      });
    },
  );

  it.each(["general", "general,news", undefined])(
    "does not retry empty category searches containing general or no category (%s)",
    async (categories) => {
      endpointMockState.responses.push(
        new Response(JSON.stringify({ results: [] }), { status: 200 }),
      );

      const result = await runSearxngSearch({
        baseUrl: "http://127.0.0.1:8888",
        query: "openclaw",
        categories,
        count: 5,
      });

      expect(endpointMockState.calls).toHaveLength(1);
      const firstCall = expectDefined(endpointMockState.calls[0], "first SearXNG endpoint call");
      expect(new URL(firstCall.url).searchParams.get("categories")).toBe(categories ?? null);
      const { tookMs, ...stableResult } = result;
      expect(typeof tookMs).toBe("number");
      expect(stableResult).toEqual({
        query: "openclaw",
        provider: "searxng",
        count: 0,
        externalContent: {
          provider: "searxng",
          source: "web_search",
          untrusted: true,
          wrapped: true,
        },
        results: [],
      });
    },
  );

  it("forwards the abort signal to the guarded endpoint", async () => {
    endpointMockState.responses.push(
      new Response(JSON.stringify({ results: [] }), { status: 200 }),
    );
    const controller = new AbortController();

    const result = await runSearxngSearch({
      baseUrl: "http://127.0.0.1:8888",
      query: "openclaw",
      categories: "general",
      signal: controller.signal,
    });

    expect(endpointMockState.calls).toHaveLength(1);
    expect(endpointMockState.calls[0]?.signal).toBe(controller.signal);
    expect(result.results).toEqual([]);
  });

  it("rejects invalid and incomplete response bodies", async () => {
    endpointMockState.responses.push(new Response("{", { status: 200 }));
    await expect(
      runSearxngSearch({
        baseUrl: "http://127.0.0.1:8888",
        query: "invalid",
      }),
    ).rejects.toThrow("SearXNG returned invalid JSON.");

    const chunk = new TextEncoder().encode("partial");
    let sentChunk = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sentChunk) {
          sentChunk = true;
          controller.enqueue(chunk);
          return;
        }
        controller.error(new Error("stream reset"));
      },
    });
    endpointMockState.responses.push(new Response(stream, { status: 200 }));
    await expect(
      runSearxngSearch({
        baseUrl: "http://127.0.0.1:8888",
        query: "partial",
      }),
    ).rejects.toThrow("SearXNG response incomplete after 7 bytes.");
  });

  it.each([
    ["https://search.example.com/searxng", "93.184.216.34", "strict"],
    ["http://matrix-synapse:8080", "10.0.0.5", "selfHosted"],
    ["https://search.internal/searxng", "10.0.0.5", "selfHosted"],
  ] as const)("classifies %s as %s routing", async (baseUrl, address, expected) => {
    ssrfMockState.addresses = [address];
    endpointMockState.responses.push(Response.json({ results: [] }));

    await runSearxngSearch({ baseUrl, query: "routing" });

    expect(endpointMockState.calls[0]?.mode).toBe(expected);
  });

  it("rejects cleartext public hosts", async () => {
    ssrfMockState.addresses = ["93.184.216.34"];
    await expect(
      runSearxngSearch({ baseUrl: "http://search.example.com:8080", query: "routing" }),
    ).rejects.toThrow(
      "SearXNG HTTP base URL must target a trusted private or loopback host. Use https:// for public hosts.",
    );
  });
});
