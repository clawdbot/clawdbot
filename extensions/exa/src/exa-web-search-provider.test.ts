import { describe, expect, it, vi } from "vitest";
import {
  cancelTrackedTextResponse,
  createStreamingResponse,
} from "../../test-support/streaming-error-response.js";
import { createExaWebSearchProvider as createContractExaWebSearchProvider } from "../web-search-contract-api.js";
import { createExaWebSearchProvider } from "./exa-web-search-provider.js";

type JsonRecord = Record<string, unknown>;

function requireExaTool(webSearch: JsonRecord, searchConfig: JsonRecord = {}) {
  const tool = createExaWebSearchProvider().createTool({
    config: { plugins: { entries: { exa: { config: { webSearch } } } } },
    searchConfig,
  } as never);
  if (!tool) {
    throw new Error("Expected Exa tool definition");
  }
  return tool;
}

describe("exa web search provider", () => {
  it("does not send or cache an already canceled search", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const tool = createExaWebSearchProvider().createTool({
      config: {
        plugins: { entries: { exa: { config: { webSearch: { apiKey: "exa-test-key" } } } } },
      },
      searchConfig: {},
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }
    const controller = new AbortController();
    controller.abort(new Error("Exa caller canceled"));

    try {
      await expect(
        tool.execute({ query: "exa pre-canceled" }, { signal: controller.signal }),
      ).rejects.toThrow("Exa caller canceled");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("aborts the guarded Exa request without losing the caller's reason", async ({
    onTestFinished,
  }) => {
    const tool = requireExaTool({ apiKey: "exa-test-key" });
    const controller = new AbortController();
    const reason = new Error("Exa request canceled in flight");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (_url, init) =>
        await new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) {
            reject(new Error("Exa request lost caller cancellation"));
            return;
          }
          const rejectAbort = () => {
            const abortReason: unknown = signal.reason;
            reject(
              abortReason instanceof Error
                ? abortReason
                : new Error("Exa request lost caller cancellation reason"),
            );
          };
          if (signal.aborted) {
            rejectAbort();
            return;
          }
          signal.addEventListener("abort", rejectAbort, { once: true });
          // Cancel at transport entry, after cold runtime loading has completed.
          controller.abort(reason);
          expect(signal.aborted).toBe(true);
        }),
    );
    const result = tool.execute(
      { query: "exa in-flight cancellation" },
      { signal: controller.signal },
    );
    onTestFinished(async () => {
      controller.abort(reason);
      await result.catch(() => {});
      fetchMock.mockRestore();
    });

    await expect(result).rejects.toBe(reason);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

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

  it("keeps the contract export aligned with provider metadata", () => {
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
    const fetchMock = vi.spyOn(globalThis, "fetch");
    try {
      expect(contractProvider.createTool({ config: {}, searchConfig: {} })).not.toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      fetchMock.mockRestore();
    }
    const pluginEntry = applied.plugins?.entries?.exa;
    if (!pluginEntry) {
      throw new Error("expected contract Exa plugin entry");
    }
    expect(pluginEntry.enabled).toBe(true);
  });

  it("applies scoped auth, endpoint, contents, freshness, and result normalization at the tool boundary", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            results: [
              {
                url: "https://example.test/highlights",
                highlights: ["first", "", "second"],
                text: "ignored",
              },
              { url: "https://example.test/text", text: "text fallback" },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const tool = requireExaTool(
      { apiKey: "exa-config-key", baseUrl: "https://proxy.example/exa/" },
      { maxResults: 120 },
    );

    try {
      const args = {
        query: "Exa boundary",
        freshness: "month",
        contents: {
          text: { maxCharacters: 1200 },
          highlights: {
            maxCharacters: 4000,
            query: "latest model launches",
            numSentences: 4,
            highlightsPerUrl: 2,
          },
          summary: { query: "launch details" },
        },
      };
      const result = await tool.execute(args);
      const descriptions = (result.results as Array<{ description: string }>).map(
        (entry) => entry.description,
      );
      expect(descriptions[0]?.split("\n---\n")[1]?.split("\n<<<END")[0]).toBe("first\nsecond");
      expect(descriptions[1]?.split("\n---\n")[1]?.split("\n<<<END")[0]).toBe("text fallback");
      expect(fetchMock.mock.calls[0]?.[0]).toBe("https://proxy.example/exa/search");
      expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
        "x-api-key": "exa-config-key",
      });
      const bodyAt = (index: number) => {
        const body = fetchMock.mock.calls[index]?.[1]?.body;
        if (typeof body !== "string") {
          throw new Error("Expected Exa JSON request body");
        }
        return JSON.parse(body);
      };
      expect(bodyAt(0)).toMatchObject({
        query: "Exa boundary",
        numResults: 100,
        contents: args.contents,
      });
      expect(Date.parse(bodyAt(0).startPublishedDate)).not.toBeNaN();

      await tool.execute({ query: "cache partitions" });
      await tool.execute({ query: "cache partitions", contents: { highlights: true } });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await tool.execute({ query: "cache partitions", contents: { highlights: false } });
      await tool.execute({ query: "cache partitions", contents: { text: false } });
      await tool.execute({ query: "cache partitions", contents: { summary: false } });
      const defaultTool = requireExaTool({ apiKey: "exa-config-key" }, { maxResults: 120 });
      await defaultTool.execute(args);
      await requireExaTool(
        { apiKey: "exa-config-key", baseUrl: "proxy.example/exa/search/" },
        { maxResults: 120 },
      ).execute({ ...args, query: "bare endpoint" });
      expect(fetchMock.mock.calls[5]?.[0]).toBe("https://api.exa.ai/search");
      expect(fetchMock.mock.calls[6]?.[0]).toBe("https://proxy.example/exa/search");

      for (const [count, expected] of [
        ["+05", 5],
        ["2e1", 20],
      ] as const) {
        await defaultTool.execute({ query: `count ${count}`, count });
        expect(bodyAt(fetchMock.mock.calls.length - 1).numResults).toBe(expected);
      }
      for (const count of ["0x10", 1.5]) {
        await expect(defaultTool.execute({ query: `count ${count}`, count })).rejects.toThrow(
          "count must be an integer from 1 to 100",
        );
      }
      const inheritedText = { maxCharacters: 1 };
      const inheritedPrototype = Object.defineProperty({}, "query", {
        get: () => {
          throw new Error("read");
        },
      });
      Object.setPrototypeOf(inheritedText, inheritedPrototype);
      await defaultTool.execute({ query: "inherited", contents: { text: inheritedText } });
      expect(bodyAt(fetchMock.mock.calls.length - 1).contents).toEqual({
        text: { maxCharacters: 1 },
      });
    } finally {
      clock.mockRestore();
      fetchMock.mockRestore();
    }
  });

  it.each([
    [
      { baseUrl: "ftp://proxy.example/exa" },
      { query: "invalid endpoint" },
      "invalid_base_url",
      "plugins.entries.exa.config.webSearch.baseUrl must be a valid http(s) URL. Got: ftp://proxy.example/exa",
    ],
    [
      {},
      { query: "invalid contents", contents: { highlights: { numSentences: 0 } } },
      "invalid_contents",
      "contents.highlights.numSentences must be a positive integer.",
    ],
    [
      {},
      { query: "latest gpu news", freshness: "day", date_after: "2026-03-01" },
      "conflicting_time_filters",
      "freshness cannot be combined with date_after or date_before. Use one time-filter mode.",
    ],
    [
      {},
      { query: "latest gpu news", date_after: "2026-02-31" },
      "invalid_date",
      "date_after must be YYYY-MM-DD format.",
    ],
  ])("returns public validation errors", async (webSearch, args, error, message) => {
    await expect(
      requireExaTool({ apiKey: "exa-test-key", ...webSearch }).execute(args),
    ).resolves.toEqual({
      error,
      message,
      docs: `https://docs.openclaw.ai/tools/${error === "invalid_base_url" ? "exa-search" : "web"}`,
    });
  });

  it.each([0, 1])("honors the current cache TTL %s", async (cacheTtlMinutes) => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    let requestCount = 0;
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(
        async () =>
          new Response(
            JSON.stringify({ results: [{ url: `https://example.com/result-${++requestCount}` }] }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      );
    const provider = createExaWebSearchProvider();
    const config = {
      plugins: { entries: { exa: { config: { webSearch: { apiKey: "exa-test-key" } } } } },
    };
    const cachedTool = provider.createTool({ config, searchConfig: { cacheTtlMinutes: 15 } });
    const currentTool = provider.createTool({ config, searchConfig: { cacheTtlMinutes } });
    const args = { query: `exa cache TTL ${cacheTtlMinutes}` };

    try {
      if (!cachedTool || !currentTool) {
        throw new Error("Expected tool definitions");
      }
      const original = await cachedTool.execute(args);
      expect(original).toMatchObject({ results: [{ url: "https://example.com/result-1" }] });
      expect(await cachedTool.execute(args)).toEqual({ ...original, cached: true });
      expect(fetchMock).toHaveBeenCalledTimes(1);

      clock.mockReturnValue(now + 60_000);
      const fresh = await currentTool.execute(args);
      expect(fresh).toMatchObject({ results: [{ url: "https://example.com/result-2" }] });
      expect(fresh).not.toHaveProperty("cached");
      expect(fetchMock).toHaveBeenCalledTimes(2);

      if (cacheTtlMinutes === 0) {
        expect(await currentTool.execute(args)).toMatchObject({
          results: [{ url: "https://example.com/result-3" }],
        });
        expect(await cachedTool.execute(args)).toEqual({ ...original, cached: true });
        expect(fetchMock).toHaveBeenCalledTimes(3);
      } else {
        expect(await currentTool.execute(args)).toEqual({ ...fresh, cached: true });
        expect(fetchMock).toHaveBeenCalledTimes(2);
      }
    } finally {
      clock.mockRestore();
      fetchMock.mockRestore();
    }
  });

  it("exposes newer documented Exa search types and count limits", () => {
    const tool = requireExaTool({ apiKey: "exa-secret" });

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
  });

  it("reports malformed Exa API JSON with a stable provider error", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{ nope"));
    const tool = requireExaTool({ apiKey: "exa-test-key" }, { cacheTtlMinutes: 0 });

    try {
      await expect(tool.execute({ query: "malformed Exa JSON" })).rejects.toThrow(
        "Exa API returned malformed JSON",
      );
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("rejects invalid UTF-8 in Exa search JSON", async () => {
    const prefix = new TextEncoder().encode(
      '{"results":[{"url":"https://example.com","title":"bad',
    );
    const suffix = new TextEncoder().encode('"}]}');
    const body = new Uint8Array(prefix.length + 1 + suffix.length);
    body.set(prefix);
    body[prefix.length] = 0xff;
    body.set(suffix, prefix.length + 1);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body));
    const tool = requireExaTool({ apiKey: "exa-test-key" }, { cacheTtlMinutes: 0 });

    try {
      await expect(tool.execute({ query: "invalid UTF-8 Exa JSON" })).rejects.toThrow(
        "Exa API returned malformed JSON",
      );
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("parses well-formed Exa search JSON under the byte cap", async () => {
    const response = new Response(
      JSON.stringify({ results: [{ url: "https://example.com", title: "Example" }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
    const tool = requireExaTool({ apiKey: "exa-test-key" }, { cacheTtlMinutes: 0 });

    try {
      const result = await tool.execute({ query: "well-formed Exa JSON" });
      const rows = result.results as Array<{ url: string; title: string }>;
      expect(result.count).toBe(1);
      expect(
        rows.map((entry) => ({
          url: entry.url,
          title: entry.title.split("\n---\n")[1]?.split("\n<<<END")[0],
        })),
      ).toEqual([{ url: "https://example.com", title: "Example" }]);
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("caps oversized Exa search JSON instead of buffering the whole body", async () => {
    const streamed = createStreamingResponse({
      chunkCount: 32,
      chunkSize: 1024 * 1024,
      text: "a",
      headers: { "content-type": "application/json" },
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(streamed.response);
    const tool = requireExaTool({ apiKey: "exa-test-key" }, { cacheTtlMinutes: 0 });

    try {
      await expect(tool.execute({ query: "oversized Exa JSON" })).rejects.toThrow(
        "Exa API response exceeds 16777216 bytes",
      );
      expect(streamed.getReadCount()).toBeLessThan(32);
      expect(streamed.wasCanceled()).toBe(true);
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("bounds Exa API error bodies without using response.text()", async () => {
    const tracked = cancelTrackedTextResponse(`${"exa upstream unavailable ".repeat(1024)}tail`, {
      status: 503,
      headers: { "content-type": "text/plain" },
    });
    const textSpy = vi.spyOn(tracked.response, "text").mockRejectedValue(new Error("unbounded"));
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(tracked.response)
      .mockResolvedValueOnce(new Response("short", { status: 503 }));
    const tool = requireExaTool({ apiKey: "exa-test-key" }, { cacheTtlMinutes: 0 });

    try {
      const failure = tool.execute({ query: "bounded Exa error" });
      await expect(failure).rejects.toThrow("exa upstream unavailable");
      await expect(failure).rejects.not.toThrow("tail");
      await expect(tool.execute({ query: "short Exa error" })).rejects.toEqual(
        new Error("Exa API error (503): short"),
      );
      expect(tracked.wasCanceled()).toBe(true);
      expect(textSpy).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      fetchMock.mockRestore();
      textSpy.mockRestore();
    }
  });
});
