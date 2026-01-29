import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createWebFetchTool, createWebSearchTool } from "./web-tools.js";
import { __testing as webSearchTesting } from "./web-search.js";

describe("web tools defaults", () => {
  it("enables web_fetch by default (non-sandbox)", () => {
    const tool = createWebFetchTool({ config: {}, sandboxed: false });
    expect(tool?.name).toBe("web_fetch");
  });

  it("disables web_fetch when explicitly disabled", () => {
    const tool = createWebFetchTool({
      config: { tools: { web: { fetch: { enabled: false } } } },
      sandboxed: false,
    });
    expect(tool).toBeNull();
  });

  it("enables web_search by default", () => {
    const tool = createWebSearchTool({ config: {}, sandboxed: false });
    expect(tool?.name).toBe("web_search");
  });
});

describe("web_search country and language parameters", () => {
  const priorFetch = global.fetch;

  beforeEach(() => {
    vi.stubEnv("BRAVE_API_KEY", "test-key");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    // @ts-expect-error global fetch cleanup
    global.fetch = priorFetch;
  });

  it("should pass country parameter to Brave API", async () => {
    const mockFetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ web: { results: [] } }),
      } as Response),
    );
    // @ts-expect-error mock fetch
    global.fetch = mockFetch;

    const tool = createWebSearchTool({ config: undefined, sandboxed: true });
    expect(tool).not.toBeNull();

    await tool?.execute?.(1, { query: "test", country: "DE" });

    expect(mockFetch).toHaveBeenCalled();
    const url = new URL(mockFetch.mock.calls[0][0] as string);
    expect(url.searchParams.get("country")).toBe("DE");
  });

  it("should pass language parameter to Brave API as search_lang", async () => {
    const mockFetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ web: { results: [] } }),
      } as Response),
    );
    // @ts-expect-error mock fetch
    global.fetch = mockFetch;

    const tool = createWebSearchTool({ config: undefined, sandboxed: true });
    await tool?.execute?.(1, { query: "test", language: "de" });

    const url = new URL(mockFetch.mock.calls[0][0] as string);
    expect(url.searchParams.get("search_lang")).toBe("de");
  });

  it("should pass ui_lang parameter to Brave API", async () => {
    const mockFetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ web: { results: [] } }),
      } as Response),
    );
    // @ts-expect-error mock fetch
    global.fetch = mockFetch;

    const tool = createWebSearchTool({ config: undefined, sandboxed: true });
    await tool?.execute?.(1, { query: "test", ui_lang: "de" });

    const url = new URL(mockFetch.mock.calls[0][0] as string);
    expect(url.searchParams.get("ui_lang")).toBe("de");
  });

  it("should pass freshness parameter to Brave API", async () => {
    const mockFetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ web: { results: [] } }),
      } as Response),
    );
    // @ts-expect-error mock fetch
    global.fetch = mockFetch;

    const tool = createWebSearchTool({ config: undefined, sandboxed: true });
    await tool?.execute?.(1, { query: "test", freshness: "pw" });

    const url = new URL(mockFetch.mock.calls[0][0] as string);
    expect(url.searchParams.get("freshness")).toBe("pw");
  });

  it("rejects invalid freshness values", async () => {
    const mockFetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ web: { results: [] } }),
      } as Response),
    );
    // @ts-expect-error mock fetch
    global.fetch = mockFetch;

    const tool = createWebSearchTool({ config: undefined, sandboxed: true });
    const result = await tool?.execute?.(1, { query: "test", freshness: "yesterday" });

    expect(mockFetch).not.toHaveBeenCalled();
    expect(result?.details).toMatchObject({ error: "invalid_freshness" });
  });
});

describe("web_search perplexity Search API", () => {
  const priorFetch = global.fetch;

  afterEach(() => {
    vi.unstubAllEnvs();
    // @ts-expect-error global fetch cleanup
    global.fetch = priorFetch;
    // Clear search cache to prevent test pollution
    webSearchTesting.SEARCH_CACHE.clear();
  });

  it("uses Perplexity Search API when PERPLEXITY_API_KEY is set", async () => {
    vi.stubEnv("PERPLEXITY_API_KEY", "pplx-test");
    const mockFetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            results: [
              {
                title: "Test",
                url: "https://example.com",
                snippet: "Test snippet",
                date: "2024-01-01",
              },
            ],
          }),
      } as Response),
    );
    // @ts-expect-error mock fetch
    global.fetch = mockFetch;

    const tool = createWebSearchTool({
      config: { tools: { web: { search: { provider: "perplexity" } } } },
      sandboxed: true,
    });
    const result = await tool?.execute?.(1, { query: "test" });

    expect(mockFetch).toHaveBeenCalled();
    expect(mockFetch.mock.calls[0]?.[0]).toBe("https://api.perplexity.ai/search");
    expect(mockFetch.mock.calls[0]?.[1]?.method).toBe("POST");
    const body = JSON.parse(mockFetch.mock.calls[0]?.[1]?.body as string);
    expect(body.query).toBe("test");
    expect(result?.details).toMatchObject({
      provider: "perplexity",
      results: expect.arrayContaining([
        expect.objectContaining({ title: "Test", url: "https://example.com" }),
      ]),
    });
  });

  it("does not include freshness parameter for Perplexity provider", async () => {
    vi.stubEnv("PERPLEXITY_API_KEY", "pplx-test");
    const mockFetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            results: [
              {
                title: "Test",
                url: "https://example.com",
                snippet: "Test snippet",
                date: "2024-01-01",
              },
            ],
          }),
      } as Response),
    );
    // @ts-expect-error mock fetch
    global.fetch = mockFetch;

    const tool = createWebSearchTool({
      config: { tools: { web: { search: { provider: "perplexity" } } } },
      sandboxed: true,
    });
    const result = await tool?.execute?.(1, { query: "test" });

    expect(mockFetch).toHaveBeenCalled();
    expect(result?.details).toMatchObject({ provider: "perplexity", count: 1 });
  });

  it("passes country parameter to Perplexity Search API", async () => {
    vi.stubEnv("PERPLEXITY_API_KEY", "pplx-test");
    const mockFetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ results: [] }),
      } as Response),
    );
    // @ts-expect-error mock fetch
    global.fetch = mockFetch;

    const tool = createWebSearchTool({
      config: { tools: { web: { search: { provider: "perplexity" } } } },
      sandboxed: true,
    });
    await tool?.execute?.(1, { query: "test", country: "DE" });

    expect(mockFetch).toHaveBeenCalled();
    const body = JSON.parse(mockFetch.mock.calls[0]?.[1]?.body as string);
    expect(body.country).toBe("DE");
  });

  it("uses config API key when provided", async () => {
    const mockFetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ results: [] }),
      } as Response),
    );
    // @ts-expect-error mock fetch
    global.fetch = mockFetch;

    const tool = createWebSearchTool({
      config: {
        tools: {
          web: {
            search: {
              provider: "perplexity",
              perplexity: { apiKey: "pplx-config" },
            },
          },
        },
      },
      sandboxed: true,
    });
    await tool?.execute?.(1, { query: "test" });

    expect(mockFetch).toHaveBeenCalled();
    const headers = mockFetch.mock.calls[0]?.[1]?.headers;
    const authHeader =
      typeof headers?.get === "function" ? headers.get("Authorization") : headers?.Authorization;
    expect(authHeader).toBe("Bearer pplx-config");
  });

  it("passes freshness filter to Perplexity Search API", async () => {
    vi.stubEnv("PERPLEXITY_API_KEY", "pplx-test");
    const mockFetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ results: [] }),
      } as Response),
    );
    // @ts-expect-error mock fetch
    global.fetch = mockFetch;

    const tool = createWebSearchTool({
      config: { tools: { web: { search: { provider: "perplexity" } } } },
      sandboxed: true,
    });
    await tool?.execute?.(1, { query: "test", freshness: "week" });

    expect(mockFetch).toHaveBeenCalled();
    const body = JSON.parse(mockFetch.mock.calls[0]?.[1]?.body as string);
    expect(body.search_recency_filter).toBe("week");
  });

  it("accepts all valid freshness values for Perplexity", async () => {
    vi.stubEnv("PERPLEXITY_API_KEY", "pplx-test");
    const mockFetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ results: [] }),
      } as Response),
    );
    // @ts-expect-error mock fetch
    global.fetch = mockFetch;

    const tool = createWebSearchTool({
      config: { tools: { web: { search: { provider: "perplexity" } } } },
      sandboxed: true,
    });

    for (const freshness of ["day", "week", "month", "year"]) {
      webSearchTesting.SEARCH_CACHE.clear();
      await tool?.execute?.(1, { query: `test-${freshness}`, freshness });
      const body = JSON.parse(mockFetch.mock.calls.at(-1)?.[1]?.body as string);
      expect(body.search_recency_filter).toBe(freshness);
    }
  });

  it("rejects invalid freshness values", async () => {
    vi.stubEnv("PERPLEXITY_API_KEY", "pplx-test");
    const mockFetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ results: [] }),
      } as Response),
    );
    // @ts-expect-error mock fetch
    global.fetch = mockFetch;

    const tool = createWebSearchTool({
      config: { tools: { web: { search: { provider: "perplexity" } } } },
      sandboxed: true,
    });
    const result = await tool?.execute?.(1, { query: "test", freshness: "yesterday" });

    expect(mockFetch).not.toHaveBeenCalled();
    expect(result?.details).toMatchObject({ error: "invalid_freshness" });
  });

  it("passes domain filter to Perplexity Search API", async () => {
    vi.stubEnv("PERPLEXITY_API_KEY", "pplx-test");
    const mockFetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ results: [] }),
      } as Response),
    );
    // @ts-expect-error mock fetch
    global.fetch = mockFetch;

    const tool = createWebSearchTool({
      config: { tools: { web: { search: { provider: "perplexity" } } } },
      sandboxed: true,
    });
    await tool?.execute?.(1, {
      query: "test",
      domain_filter: ["nature.com", "science.org"],
    });

    expect(mockFetch).toHaveBeenCalled();
    const body = JSON.parse(mockFetch.mock.calls[0]?.[1]?.body as string);
    expect(body.search_domain_filter).toEqual(["nature.com", "science.org"]);
  });

  it("passes denylist domain filter to Perplexity Search API", async () => {
    vi.stubEnv("PERPLEXITY_API_KEY", "pplx-test");
    const mockFetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ results: [] }),
      } as Response),
    );
    // @ts-expect-error mock fetch
    global.fetch = mockFetch;

    const tool = createWebSearchTool({
      config: { tools: { web: { search: { provider: "perplexity" } } } },
      sandboxed: true,
    });
    await tool?.execute?.(1, {
      query: "test",
      domain_filter: ["-reddit.com", "-pinterest.com"],
    });

    expect(mockFetch).toHaveBeenCalled();
    const body = JSON.parse(mockFetch.mock.calls[0]?.[1]?.body as string);
    expect(body.search_domain_filter).toEqual(["-reddit.com", "-pinterest.com"]);
  });

  it("passes language to Perplexity Search API as search_language_filter array", async () => {
    vi.stubEnv("PERPLEXITY_API_KEY", "pplx-test");
    const mockFetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ results: [] }),
      } as Response),
    );
    // @ts-expect-error mock fetch
    global.fetch = mockFetch;

    const tool = createWebSearchTool({
      config: { tools: { web: { search: { provider: "perplexity" } } } },
      sandboxed: true,
    });
    await tool?.execute?.(1, {
      query: "test",
      language: "en",
    });

    expect(mockFetch).toHaveBeenCalled();
    const body = JSON.parse(mockFetch.mock.calls[0]?.[1]?.body as string);
    expect(body.search_language_filter).toEqual(["en"]);
  });

  it("passes multiple filters together to Perplexity Search API", async () => {
    vi.stubEnv("PERPLEXITY_API_KEY", "pplx-test");
    const mockFetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ results: [] }),
      } as Response),
    );
    // @ts-expect-error mock fetch
    global.fetch = mockFetch;

    const tool = createWebSearchTool({
      config: { tools: { web: { search: { provider: "perplexity" } } } },
      sandboxed: true,
    });
    await tool?.execute?.(1, {
      query: "climate research",
      country: "US",
      freshness: "month",
      domain_filter: ["nature.com", ".gov"],
      language: "en",
    });

    expect(mockFetch).toHaveBeenCalled();
    const body = JSON.parse(mockFetch.mock.calls[0]?.[1]?.body as string);
    expect(body.query).toBe("climate research");
    expect(body.country).toBe("US");
    expect(body.search_recency_filter).toBe("month");
    expect(body.search_domain_filter).toEqual(["nature.com", ".gov"]);
    expect(body.search_language_filter).toEqual(["en"]);
  });
});
