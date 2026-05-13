import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Capture every call to postTrustedWebToolsJson so we can assert on extraHeaders.
const postTrustedWebToolsJson = vi.fn();

vi.mock("openclaw/plugin-sdk/provider-web-search", () => ({
  DEFAULT_CACHE_TTL_MINUTES: 5,
  normalizeCacheKey: (k: string) => k,
  postTrustedWebToolsJson,
  readCache: () => undefined,
  resolveCacheTtlMs: () => 300_000,
  writeCache: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/security-runtime", () => ({
  wrapExternalContent: (v: string) => v,
  wrapWebContent: (v: string) => v,
}));

vi.mock("./config.js", () => ({
  DEFAULT_TAVILY_BASE_URL: "https://api.tavily.com",
  resolveTavilyApiKey: () => "test-key",
  resolveTavilyBaseUrl: () => "https://api.tavily.com",
  resolveTavilySearchTimeoutSeconds: () => 30,
  resolveTavilyExtractTimeoutSeconds: () => 60,
}));

describe("tavily client X-Client-Source header", () => {
  let runTavilySearch: typeof import("./tavily-client.js").runTavilySearch;
  let runTavilyExtract: typeof import("./tavily-client.js").runTavilyExtract;

  beforeAll(async () => {
    ({ runTavilySearch, runTavilyExtract } = await import("./tavily-client.js"));
  });

  beforeEach(() => {
    postTrustedWebToolsJson.mockReset();
    postTrustedWebToolsJson.mockImplementation(
      async (_params: unknown, parse: (r: Response) => Promise<unknown>) =>
        parse(Response.json({ results: [] })),
    );
  });

  it("runTavilySearch sends X-Client-Source: openclaw", async () => {
    await runTavilySearch({ query: "test query" });

    expect(postTrustedWebToolsJson).toHaveBeenCalledOnce();
    const params = postTrustedWebToolsJson.mock.calls[0]?.[0];
    expect(params.extraHeaders).toEqual({ "X-Client-Source": "openclaw" });
  });

  it("runTavilyExtract sends X-Client-Source: openclaw", async () => {
    await runTavilyExtract({ urls: ["https://example.com"] });

    expect(postTrustedWebToolsJson).toHaveBeenCalledOnce();
    const params = postTrustedWebToolsJson.mock.calls[0]?.[0];
    expect(params.extraHeaders).toEqual({ "X-Client-Source": "openclaw" });
  });
});
