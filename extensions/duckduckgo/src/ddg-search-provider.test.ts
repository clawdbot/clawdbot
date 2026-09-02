// Duckduckgo tests cover ddg search provider plugin behavior.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createStreamingResponse } from "../../test-support/streaming-error-response.js";
import { createDuckDuckGoWebSearchProvider as createDuckDuckGoWebSearchContractProvider } from "../web-search-contract-api.js";
import { resolveDdgRegion, resolveDdgSafeSearch } from "./config.js";

const { runDuckDuckGoSearch } = vi.hoisted(() => ({
  runDuckDuckGoSearch: vi.fn(async (params: Record<string, unknown>) => params),
}));

vi.mock("./ddg-client.js", () => ({
  runDuckDuckGoSearch,
}));

describe("duckduckgo web search provider", () => {
  let createDuckDuckGoWebSearchProvider: typeof import("./ddg-search-provider.js").createDuckDuckGoWebSearchProvider;
  let runActualDuckDuckGoSearch: typeof import("./ddg-client.js").runDuckDuckGoSearch;

  afterAll(() => {
    vi.doUnmock("./ddg-client.js");
    vi.resetModules();
  });

  beforeAll(async () => {
    ({ createDuckDuckGoWebSearchProvider } = await import("./ddg-search-provider.js"));
    ({ runDuckDuckGoSearch: runActualDuckDuckGoSearch } =
      await vi.importActual<typeof import("./ddg-client.js")>("./ddg-client.js"));
    await import("../index.js");
  });

  beforeEach(() => {
    runDuckDuckGoSearch.mockReset();
    runDuckDuckGoSearch.mockImplementation(async (params: Record<string, unknown>) => params);
  });

  async function runHtmlSearch(query: string, html: string) {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(html, {
        headers: { "content-type": "text/html" },
      }),
    );
    try {
      return await runActualDuckDuckGoSearch({ query, cacheTtlMinutes: 0 });
    } finally {
      fetchMock.mockRestore();
    }
  }

  function readSearchResults(payload: Record<string, unknown>) {
    if (!Array.isArray(payload.results)) {
      throw new Error("Expected DuckDuckGo search results");
    }
    return payload.results as Array<{
      title: string;
      url: string;
      snippet: string;
      siteName?: string;
    }>;
  }

  it("exposes keyless metadata and enables the plugin in config", () => {
    const provider = createDuckDuckGoWebSearchProvider();
    if (!provider.applySelectionConfig) {
      throw new Error("Expected applySelectionConfig to be defined");
    }
    const applied = provider.applySelectionConfig({});

    expect(provider.id).toBe("duckduckgo");
    expect(provider.label).toBe("DuckDuckGo Search (experimental)");
    expect(provider.onboardingScopes).toEqual(["text-inference"]);
    expect(createDuckDuckGoWebSearchContractProvider().onboardingScopes).toEqual([
      "text-inference",
    ]);
    expect(provider.requiresCredential).toBe(false);
    expect(provider.credentialPath).toBe("");
    const pluginEntry = applied.plugins?.entries?.duckduckgo;
    if (!pluginEntry) {
      throw new Error("expected DuckDuckGo plugin entry");
    }
    expect(pluginEntry.enabled).toBe(true);
  });

  it("maps generic tool arguments into DuckDuckGo search params", async () => {
    const provider = createDuckDuckGoWebSearchProvider();
    const tool = provider.createTool({
      config: { test: true },
    } as never);
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    const result = await tool.execute({
      query: "openclaw docs",
      count: 4,
      region: "us-en",
      safeSearch: "off",
    });

    expect(runDuckDuckGoSearch).toHaveBeenCalledWith({
      config: { test: true },
      query: "openclaw docs",
      count: 4,
      region: "us-en",
      safeSearch: "off",
    });
    expect(result).toEqual({
      config: { test: true },
      query: "openclaw docs",
      count: 4,
      region: "us-en",
      safeSearch: "off",
    });
  });

  it("rejects fractional and out-of-range counts before searching", async () => {
    const provider = createDuckDuckGoWebSearchProvider();
    const tool = provider.createTool({
      config: { test: true },
    } as never);
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    await expect(tool.execute({ query: "openclaw docs", count: 4.5 })).rejects.toThrow(
      "count must be an integer from 1 to 10.",
    );
    await expect(tool.execute({ query: "openclaw docs", count: 11 })).rejects.toThrow(
      "count must be an integer from 1 to 10.",
    );
    expect(runDuckDuckGoSearch).not.toHaveBeenCalled();
  });

  it("forwards caller cancellation without starting an already canceled search", async () => {
    const tool = createDuckDuckGoWebSearchProvider().createTool({ config: {} });
    if (!tool) {
      throw new Error("Expected tool definition");
    }
    const active = new AbortController();

    await tool.execute({ query: "duckduckgo cancellation forwarding" }, { signal: active.signal });

    expect(runDuckDuckGoSearch).toHaveBeenCalledWith(
      expect.objectContaining({ signal: active.signal }),
    );
    runDuckDuckGoSearch.mockClear();
    const canceled = new AbortController();
    canceled.abort(new Error("DuckDuckGo caller canceled"));

    await expect(
      tool.execute({ query: "duckduckgo pre-canceled" }, { signal: canceled.signal }),
    ).rejects.toThrow("DuckDuckGo caller canceled");
    expect(runDuckDuckGoSearch).not.toHaveBeenCalled();
  });

  it("aborts an in-flight DuckDuckGo request without caching its result", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (_url, init) =>
        await new Promise<Response>((_resolve, reject) => {
          if (!init?.signal) {
            reject(new Error("DuckDuckGo request lost caller cancellation"));
            return;
          }
          init.signal.addEventListener("abort", () => reject(init.signal?.reason as Error), {
            once: true,
          });
        }),
    );
    const controller = new AbortController();
    const result = runActualDuckDuckGoSearch({
      query: "duckduckgo in-flight cancellation",
      signal: controller.signal,
    });

    try {
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
      controller.abort(new Error("DuckDuckGo request canceled in flight"));
      await expect(result).rejects.toThrow("DuckDuckGo request canceled in flight");
      expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
      fetchMock.mockResolvedValueOnce(
        new Response('<a class="result__a" href="https://example.com">Example</a>', {
          headers: { "content-type": "text/html" },
        }),
      );

      await runActualDuckDuckGoSearch({ query: "duckduckgo in-flight cancellation" });

      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("bounds successful DuckDuckGo HTML bodies without using response.text()", async () => {
    const streamed = createStreamingResponse({
      chunkCount: 32,
      chunkSize: 1024 * 1024,
      text: "x",
      headers: { "Content-Type": "text/html" },
    });
    const textSpy = vi.spyOn(streamed.response, "text").mockRejectedValue(new Error("unbounded"));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(streamed.response);

    try {
      await expect(
        runActualDuckDuckGoSearch({
          query: "duckduckgo bounded response",
          cacheTtlMinutes: 0,
        }),
      ).rejects.toThrow("DuckDuckGo search: text response exceeds 16777216 bytes");

      expect(streamed.getReadCount()).toBeLessThan(32);
      expect(streamed.wasCanceled()).toBe(true);
      expect(textSpy).not.toHaveBeenCalled();
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("reads region from plugin config and normalizes empty values away", () => {
    expect(
      resolveDdgRegion({
        plugins: {
          entries: {
            duckduckgo: {
              config: {
                webSearch: {
                  region: "de-de",
                },
              },
            },
          },
        },
      } as never),
    ).toBe("de-de");

    expect(
      resolveDdgRegion({
        plugins: {
          entries: {
            duckduckgo: {
              config: {
                webSearch: {
                  region: "   ",
                },
              },
            },
          },
        },
      } as never),
    ).toBeUndefined();
  });

  it("defaults safeSearch to moderate and accepts strict and off", () => {
    expect(resolveDdgSafeSearch(undefined)).toBe("moderate");

    expect(
      resolveDdgSafeSearch({
        plugins: {
          entries: {
            duckduckgo: {
              config: {
                webSearch: {
                  safeSearch: "strict",
                },
              },
            },
          },
        },
      } as never),
    ).toBe("strict");

    expect(
      resolveDdgSafeSearch({
        plugins: {
          entries: {
            duckduckgo: {
              config: {
                webSearch: {
                  safeSearch: "off",
                },
              },
            },
          },
        },
      } as never),
    ).toBe("off");
  });

  it("keeps invalid numeric entities intact in returned results", async () => {
    const payload = await runHtmlSearch(
      "duckduckgo invalid numeric entities",
      `
        <a class="result__a" href="https://example.com/entities">
          Result &#99999999; Hex &#x110000; Smile &#128512;
        </a>
        <a class="result__snippet">Bad &#55296; &#xD800; &#xDFFF;</a>
      `,
    );
    const [result] = readSearchResults(payload);

    expect(result?.title).toContain("Result &#99999999; Hex &#x110000; Smile 😀");
    // Surrogate-range entities would become lone UTF-16 surrogates; preserve their source text.
    expect(result?.snippet).toContain("Bad &#55296; &#xD800; &#xDFFF;");
  });

  it("does not double-decode escaped entities in returned results", async () => {
    const payload = await runHtmlSearch(
      "duckduckgo escaped entities",
      `
        <a class="result__a" href="https://example.com/escaping">
          How to escape &amp;lt; in HTML
        </a>
        <a class="result__snippet">a&amp;#39;b and a&#x26;amp;b</a>
      `,
    );
    const [result] = readSearchResults(payload);

    // Decoding &amp; first would turn the literal "&lt;" into "<" and corrupt the result.
    expect(result?.title).toContain("How to escape &lt; in HTML");
    expect(result?.title).not.toContain("How to escape < in HTML");
    expect(result?.snippet).toContain("a&#39;b and a&amp;b");
  });

  it("returns results when href appears before class", async () => {
    const payload = await runHtmlSearch(
      "duckduckgo href ordering",
      `
        <a href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com" class="result__a">
          Example &amp; Co
        </a>
        <a class="result__snippet">Fast&nbsp;search &hellip; with details</a>
        <a class="result__a" href="https://example.org/direct">Direct result</a>
        <a class="result__snippet">Second snippet</a>
      `,
    );
    const results = readSearchResults(payload);

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ url: "https://example.com", siteName: "example.com" });
    expect(results[0]?.title).toContain("Example & Co");
    expect(results[0]?.snippet).toContain("Fast search ... with details");
    expect(results[1]).toMatchObject({
      url: "https://example.org/direct",
      siteName: "example.org",
    });
    expect(results[1]?.title).toContain("Direct result");
    expect(results[1]?.snippet).toContain("Second snippet");
  });

  it("keeps inline result markup from splitting returned words", async () => {
    const payload = await runHtmlSearch(
      "duckduckgo inline result markup",
      `
        <a class="result__a" href="https://example.com/cafe">Caf<b>é</b> guide</a>
        <a class="result__snippet">Find the best caf<b>é</b> near you.</a>
      `,
    );
    const [result] = readSearchResults(payload);

    expect(result?.title).toContain("Café guide");
    expect(result?.title).not.toContain("Caf é");
    expect(result?.url).toBe("https://example.com/cafe");
    expect(result?.snippet).toContain("Find the best café near you.");
  });

  it("rejects bot challenge pages without flagging ordinary result snippets", async () => {
    const challengeHtml = `
      <html>
        <body>
          <form>
            <h1>Are you a human?</h1>
            <div class="g-recaptcha">captcha</div>
          </form>
        </body>
      </html>
    `;
    const normalHtml = `
      <a class="result__a" href="https://example.com/challenge">Coding Challenge</a>
      <a class="result__snippet">A fun coding challenge for interview prep.</a>
    `;

    await expect(runHtmlSearch("duckduckgo bot challenge", challengeHtml)).rejects.toThrow(
      "DuckDuckGo returned a bot-detection challenge.",
    );
    const normalPayload = await runHtmlSearch("duckduckgo ordinary challenge result", normalHtml);
    const [result] = readSearchResults(normalPayload);
    expect(result?.url).toBe("https://example.com/challenge");
    expect(result?.title).toContain("Coding Challenge");
    expect(result?.snippet).toContain("A fun coding challenge for interview prep.");
  });
});
