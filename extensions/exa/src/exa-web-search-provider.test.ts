// Exa tests cover exa web search provider plugin behavior.
import { describe, expect, it, vi } from "vitest";
import { testing } from "../test-api.js";
import { createExaWebSearchProvider as createContractExaWebSearchProvider } from "../web-search-contract-api.js";
import { createExaWebSearchProvider } from "./exa-web-search-provider.js";

function cancelTrackedResponse(
  text: string,
  init: ResponseInit,
): {
  response: Response;
  wasCanceled: () => boolean;
} {
  let canceled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
    },
    cancel() {
      canceled = true;
    },
  });
  return {
    response: new Response(stream, init),
    wasCanceled: () => canceled,
  };
}

function streamingJsonResponse(params: { chunkCount: number; chunkSize: number }): {
  response: Response;
  getReadCount: () => number;
} {
  // Streaming fixture proves an oversized success body stops being read before
  // the whole payload is buffered into memory.
  let reads = 0;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (reads >= params.chunkCount) {
        controller.close();
        return;
      }
      reads += 1;
      controller.enqueue(encoder.encode("a".repeat(params.chunkSize)));
    },
  });
  return {
    response: new Response(stream, {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    getReadCount: () => reads,
  };
}

describe("exa web search provider", () => {
  it("exposes the expected metadata and selection wiring", () => {
    const provider = createExaWebSearchProvider();
    if (!provider.applySelectionConfig) {
      throw new Error("Expected applySelectionConfig to be defined");
    }
    const applied = provider.applySelectionConfig({});

    expect(provider.id).toBe("exa");
    expect(provider.onboardingScopes).toEqual(["text-inference"]);
    expect(provider.credentialPath).toBe("plugins.entries.exa.config.webSearch.apiKey");
    const pluginEntry = applied.plugins?.entries?.exa;
    if (!pluginEntry) {
      throw new Error("expected Exa plugin entry");
    }
    expect(pluginEntry.enabled).toBe(true);
  });

  it("keeps the lightweight contract surface aligned with provider metadata", () => {
    const provider = createExaWebSearchProvider();
    const contractProvider = createContractExaWebSearchProvider();
    if (!contractProvider.applySelectionConfig) {
      throw new Error("Expected contract applySelectionConfig to be defined");
    }
    const applied = contractProvider.applySelectionConfig({});

    expect({
      id: contractProvider.id,
      label: contractProvider.label,
      hint: contractProvider.hint,
      onboardingScopes: contractProvider.onboardingScopes,
      credentialLabel: contractProvider.credentialLabel,
      envVars: contractProvider.envVars,
      placeholder: contractProvider.placeholder,
      signupUrl: contractProvider.signupUrl,
      docsUrl: contractProvider.docsUrl,
      autoDetectOrder: contractProvider.autoDetectOrder,
      credentialPath: contractProvider.credentialPath,
    }).toEqual({
      id: provider.id,
      label: provider.label,
      hint: provider.hint,
      onboardingScopes: provider.onboardingScopes,
      credentialLabel: provider.credentialLabel,
      envVars: provider.envVars,
      placeholder: provider.placeholder,
      signupUrl: provider.signupUrl,
      docsUrl: provider.docsUrl,
      autoDetectOrder: provider.autoDetectOrder,
      credentialPath: provider.credentialPath,
    });
    expect(contractProvider.createTool({ config: {}, searchConfig: {} })).toBeNull();
    const pluginEntry = applied.plugins?.entries?.exa;
    if (!pluginEntry) {
      throw new Error("expected contract Exa plugin entry");
    }
    expect(pluginEntry.enabled).toBe(true);
  });

  it("prefers scoped configured api keys over environment fallbacks", () => {
    expect(testing.resolveExaApiKey({ apiKey: "exa-secret" })).toBe("exa-secret");
  });

  it("resolves Exa search base URL overrides", () => {
    expect(testing.resolveExaSearchEndpoint()).toEqual({
      endpoint: "https://api.exa.ai/search",
    });
    expect(testing.resolveExaSearchEndpoint({ baseUrl: "https://proxy.example/exa" })).toEqual({
      endpoint: "https://proxy.example/exa/search",
    });
    expect(testing.resolveExaSearchEndpoint({ baseUrl: "proxy.example/exa/search/" })).toEqual({
      endpoint: "https://proxy.example/exa/search",
    });
    expect(testing.resolveExaSearchEndpoint({ baseUrl: "ftp://proxy.example/exa" })).toEqual({
      docs: "https://docs.openclaw.ai/tools/exa-search",
      error: "invalid_base_url",
      message:
        "plugins.entries.exa.config.webSearch.baseUrl must be a valid http(s) URL. Got: ftp://proxy.example/exa",
    });
  });

  it("partitions Exa cache keys by resolved endpoint", () => {
    const base = {
      type: "auto" as const,
      query: "openclaw",
      count: 5,
    };
    expect(
      testing.buildExaCacheKey({
        ...base,
        endpoint: "https://api.exa.ai/search",
      }),
    ).not.toBe(
      testing.buildExaCacheKey({
        ...base,
        endpoint: "https://proxy.example/exa/search",
      }),
    );
  });

  it("partitions Exa cache keys by effective content options", () => {
    const base = {
      endpoint: "https://api.exa.ai/search",
      type: "auto" as const,
      query: "openclaw",
      count: 5,
    };
    const defaultKey = testing.buildExaCacheKey(base);

    expect(testing.buildExaCacheKey({ ...base, contents: { highlights: true } })).toBe(defaultKey);

    const disabledKeys = [
      testing.buildExaCacheKey({ ...base, contents: { highlights: false } }),
      testing.buildExaCacheKey({ ...base, contents: { text: false } }),
      testing.buildExaCacheKey({ ...base, contents: { summary: false } }),
    ];
    expect(disabledKeys).not.toContain(defaultKey);
    expect(new Set(disabledKeys).size).toBe(disabledKeys.length);
  });

  it("normalizes Exa result descriptions from highlights before text", () => {
    expect(
      testing.resolveExaDescription({
        highlights: ["first", "", "second"],
        text: "full text",
      }),
    ).toBe("first\nsecond");
    expect(testing.resolveExaDescription({ text: "full text" })).toBe("full text");
  });

  it("handles month freshness without date overflow", () => {
    const iso = testing.resolveFreshnessStartDate("month");
    expect(Number.isNaN(Date.parse(iso))).toBe(false);
  });

  it("accepts current Exa contents object options from the docs", () => {
    expect(
      testing.parseExaContents({
        text: { maxCharacters: 1200 },
        highlights: {
          maxCharacters: 4000,
          query: "latest model launches",
          numSentences: 4,
          highlightsPerUrl: 2,
        },
        summary: { query: "launch details" },
      }),
    ).toEqual({
      value: {
        text: { maxCharacters: 1200 },
        highlights: {
          maxCharacters: 4000,
          query: "latest model launches",
          numSentences: 4,
          highlightsPerUrl: 2,
        },
        summary: { query: "launch details" },
      },
    });
  });

  it("rejects invalid Exa contents objects", () => {
    expect(
      testing.parseExaContents({
        highlights: { numSentences: 0 },
      }),
    ).toEqual({
      error: "invalid_contents",
      message: "contents.highlights.numSentences must be a positive integer.",
      docs: "https://docs.openclaw.ai/tools/web",
    });
  });

  it("exposes newer documented Exa search types and count limits", () => {
    const provider = createExaWebSearchProvider();
    const tool = provider.createTool({
      config: {},
      searchConfig: { exa: { apiKey: "exa-secret" } },
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    const parameters = tool.parameters as {
      properties?: {
        count?: { maximum?: number };
        type?: { enum?: string[] };
      };
    };

    expect(parameters.properties?.count?.maximum).toBe(100);
    expect(parameters.properties?.type?.enum).toEqual([
      "auto",
      "neural",
      "fast",
      "deep",
      "deep-reasoning",
      "instant",
    ]);
    expect(testing.resolveExaSearchCount(80, 10)).toBe(80);
    expect(testing.resolveExaSearchCount(120, 10)).toBe(100);
    expect(testing.resolveExaSearchCount("+05", 10)).toBe(5);
    expect(testing.resolveExaSearchCount("0x10", 10)).toBe(10);
    expect(testing.resolveExaSearchCount("1e2", 10)).toBe(10);
    expect(testing.resolveExaSearchCount(1.5, 10)).toBe(10);
  });

  it("returns validation errors for conflicting time filters", async () => {
    const provider = createExaWebSearchProvider();
    const tool = provider.createTool({
      config: {},
      searchConfig: { exa: { apiKey: "exa-secret" } },
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    const result = await tool.execute({
      query: "latest gpu news",
      freshness: "day",
      date_after: "2026-03-01",
    });

    expect(result).toEqual({
      error: "conflicting_time_filters",
      message:
        "freshness cannot be combined with date_after or date_before. Use one time-filter mode.",
      docs: "https://docs.openclaw.ai/tools/web",
    });
  });

  it("returns validation errors for invalid date input", async () => {
    const provider = createExaWebSearchProvider();
    const tool = provider.createTool({
      config: {},
      searchConfig: { exa: { apiKey: "exa-secret" } },
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    const result = await tool.execute({
      query: "latest gpu news",
      date_after: "2026-02-31",
    });

    expect(result).toEqual({
      error: "invalid_date",
      message: "date_after must be YYYY-MM-DD format.",
      docs: "https://docs.openclaw.ai/tools/web",
    });
  });

  it("reports malformed Exa API JSON with a stable provider error", async () => {
    await expect(testing.readExaSearchResults(new Response("{ nope"))).rejects.toThrow(
      "Exa API returned malformed JSON",
    );
  });

  it("parses well-formed Exa search JSON under the byte cap", async () => {
    const response = new Response(
      JSON.stringify({ results: [{ url: "https://example.com", title: "Example" }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

    await expect(testing.readExaSearchResults(response)).resolves.toEqual([
      { url: "https://example.com", title: "Example" },
    ]);
  });

  it("caps oversized Exa search JSON instead of buffering the whole body", async () => {
    const streamed = streamingJsonResponse({ chunkCount: 64, chunkSize: 1024 });

    await expect(
      testing.readExaSearchResults(streamed.response, { maxBytes: 4096 }),
    ).rejects.toThrow(/Exa API response exceeds 4096 bytes/);

    expect(streamed.getReadCount()).toBeLessThan(64);
  });

  it("bounds Exa API error bodies without using response.text()", async () => {
    const tracked = cancelTrackedResponse(`${"exa upstream unavailable ".repeat(1024)}tail`, {
      status: 503,
      headers: { "content-type": "text/plain" },
    });
    const textSpy = vi.spyOn(tracked.response, "text").mockRejectedValue(new Error("unbounded"));

    const detail = await testing.readExaErrorDetail(tracked.response);

    expect(detail).toContain("exa upstream unavailable");
    expect(detail).not.toContain("tail");
    expect(await testing.readExaErrorDetail(new Response("short"))).toBe("short");
    expect(tracked.wasCanceled()).toBe(true);
    expect(textSpy).not.toHaveBeenCalled();
  });
});
