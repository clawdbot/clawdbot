// Senseaudio tests cover web search provider plugin behavior.
import type { LookupFn } from "openclaw/plugin-sdk/ssrf-runtime";
import { withEnvAsync } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testing } from "../test-api.js";
import { createSenseAudioWebSearchProvider } from "./senseaudio-web-search-provider.js";

function createLookupFn(addresses: Array<{ address: string; family: number }>): LookupFn {
  return vi.fn(async (_hostname: string, options?: unknown) => {
    if (typeof options === "number" || !options || !(options as { all?: boolean }).all) {
      return addresses[0];
    }
    return addresses;
  }) as unknown as LookupFn;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function searchCallItem(sources: string[]) {
  return {
    type: "web_search_call",
    status: "completed",
    action: {
      type: "search",
      query: "query",
      sources: sources.map((url) => ({ type: "url", url })),
    },
  };
}

function messageItem(text: string, annotations: unknown[] = []) {
  return {
    type: "message",
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text, annotations }],
  };
}

function completedResponse(output: unknown[]) {
  return { status: "completed", error: null, incomplete_details: null, output };
}

async function executeSenseAudioSearch(
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const provider = createSenseAudioWebSearchProvider();
  const tool = provider.createTool({ config: {}, searchConfig: {} });
  if (!tool) {
    throw new Error("Expected tool definition");
  }
  return await tool.execute(args);
}

function readFetchJsonBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const [, init] = fetchMock.mock.calls[0] as [unknown, RequestInit | undefined];
  if (typeof init?.body !== "string") {
    throw new Error("Expected captured fetch request body");
  }
  return JSON.parse(init.body) as Record<string, unknown>;
}

function expectStringFieldContains(result: Record<string, unknown>, field: string, text: string) {
  const value = result[field];
  expect(typeof value).toBe("string");
  expect(value).toContain(text);
}

describe("senseaudio web search provider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("points missing-key users to fetch/browser alternatives", async () => {
    await withEnvAsync({ SENSEAUDIO_API_KEY: undefined }, async () => {
      const result = await executeSenseAudioSearch({ query: "senseaudio missing key" });

      expect(result.error).toBe("missing_senseaudio_api_key");
      expectStringFieldContains(
        result,
        "message",
        "use web_fetch for a specific URL or the browser tool",
      );
    });
  });

  it("uses configured model and base url overrides with sane defaults", () => {
    expect(testing.resolveSenseAudioModel()).toBe("senseaudio-s2");
    expect(testing.resolveSenseAudioModel({ model: "senseaudio-s3" })).toBe("senseaudio-s3");
    expect(testing.resolveSenseAudioBaseUrl()).toBe("https://api.senseaudio.cn/v1");
    expect(testing.resolveSenseAudioBaseUrl({ baseUrl: "https://sense.example/v1/" })).toBe(
      "https://sense.example/v1",
    );
  });

  it("uses config apiKey and falls back to env apiKey", async () => {
    expect(testing.resolveSenseAudioApiKey({ apiKey: "sense-test-key" })).toBe("sense-test-key");
    await withEnvAsync({ SENSEAUDIO_API_KEY: "sense-env-key" }, async () => {
      expect(testing.resolveSenseAudioApiKey({})).toBe("sense-env-key");
    });
  });

  it("sends a forced non-streaming web_search request and returns grounded payloads", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(
          completedResponse([
            searchCallItem(["https://a.test"]),
            { type: "reasoning" },
            searchCallItem(["https://b.test", "https://a.test"]),
            messageItem("SenseAudio grounded answer.", [
              { type: "url_citation", url: "https://c.test" },
            ]),
          ]),
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    await withEnvAsync({ SENSEAUDIO_API_KEY: "sense-test-key" }, async () => {
      const result = await executeSenseAudioSearch({ query: "senseaudio grounded citations" });

      const body = readFetchJsonBody(fetchMock);
      expect(body.model).toBe("senseaudio-s2");
      expect(body.tools).toEqual([{ type: "web_search" }]);
      expect(body.tool_choice).toEqual({ type: "web_search" });
      expect(body.include).toEqual(["web_search_call.action.sources"]);
      expect(body.stream).toBe(false);
      expect(body.store).toBe(false);

      expect(result.provider).toBe("senseaudio");
      expectStringFieldContains(result, "content", "SenseAudio grounded answer.");
      expect(result.citations).toEqual(["https://a.test", "https://b.test", "https://c.test"]);
      expect(result).not.toHaveProperty("error");
    });
  });

  it("returns a structured failure for ungrounded responses", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(completedResponse([messageItem("Chat-only answer.")])));
    vi.stubGlobal("fetch", fetchMock);

    await withEnvAsync({ SENSEAUDIO_API_KEY: "sense-test-key" }, async () => {
      const result = await executeSenseAudioSearch({
        query: "senseaudio ungrounded chat fallback",
      });

      expect(result.error).toBe("senseaudio_web_search_ungrounded");
      expect(result.provider).toBe("senseaudio");
      expectStringFieldContains(result, "message", "without native web-search grounding");
    });
  });

  it("treats failed search calls without citations as ungrounded", async () => {
    const failedCall = {
      type: "web_search_call",
      status: "failed",
      action: { type: "search", query: "query", sources: [] },
    };
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse(completedResponse([failedCall, messageItem("Parametric answer.")])),
        ),
    );

    await withEnvAsync({ SENSEAUDIO_API_KEY: "sense-test-key" }, async () => {
      const result = await executeSenseAudioSearch({ query: "senseaudio failed search call" });

      expect(result.error).toBe("senseaudio_web_search_ungrounded");
    });
  });

  it("rejects unsupported search filters before calling the API", async () => {
    const result = await executeSenseAudioSearch({
      query: "senseaudio filters",
      freshness: "week",
    });

    expect(result.error).toBe("unsupported_freshness");
  });

  it("keeps the default endpoint on the strict trusted policy", async () => {
    await expect(
      testing.resolveSenseAudioEndpointMode("https://api.senseaudio.cn/v1"),
    ).resolves.toBe("strict");
  });

  it("routes loopback and private base URLs through the self-hosted guard", async () => {
    const privateLookup = createLookupFn([{ address: "10.0.0.5", family: 4 }]);

    await expect(
      testing.resolveSenseAudioEndpointMode(
        "http://localhost:3210/v1",
        createLookupFn([{ address: "127.0.0.1", family: 4 }]),
      ),
    ).resolves.toBe("selfHosted");
    await expect(testing.resolveSenseAudioEndpointMode("http://127.0.0.1:3210/v1")).resolves.toBe(
      "selfHosted",
    );
    await expect(testing.resolveSenseAudioEndpointMode("https://192.168.1.10/v1")).resolves.toBe(
      "selfHosted",
    );
    await expect(
      testing.resolveSenseAudioEndpointMode("https://sense-gateway.example/v1", privateLookup),
    ).resolves.toBe("selfHosted");
  });

  it("keeps public https overrides strict and rejects public http overrides", async () => {
    const publicLookup = createLookupFn([{ address: "93.184.216.34", family: 4 }]);

    await expect(
      testing.resolveSenseAudioEndpointMode("https://sense.example.com/v1", publicLookup),
    ).resolves.toBe("strict");
    await expect(
      testing.resolveSenseAudioEndpointMode("http://sense.example.com/v1", publicLookup),
    ).rejects.toThrow(
      "SenseAudio HTTP base URL must target a trusted private or loopback host. Use https:// for public hosts.",
    );
    await expect(testing.resolveSenseAudioEndpointMode("not-a-url")).rejects.toThrow(
      "SenseAudio base URL must be a valid http:// or https:// URL.",
    );
  });

  it("executes against an explicitly configured loopback endpoint", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(
          completedResponse([
            searchCallItem(["https://a.test"]),
            messageItem("Local gateway answer."),
          ]),
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const provider = createSenseAudioWebSearchProvider();
    const tool = provider.createTool({
      config: {},
      searchConfig: {
        senseaudio: { apiKey: "sense-test-key", baseUrl: "http://127.0.0.1:3210/v1" },
      },
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    const result = await tool.execute({ query: "senseaudio loopback endpoint" });

    expect(result).not.toHaveProperty("error");
    expectStringFieldContains(result, "content", "Local gateway answer.");
    const [url] = fetchMock.mock.calls[0] as [unknown];
    expect(String(url)).toBe("http://127.0.0.1:3210/v1/responses");
  });

  it("forwards the execution abort signal into the search request", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(
          completedResponse([searchCallItem(["https://a.test"]), messageItem("Aborted answer.")]),
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    await withEnvAsync({ SENSEAUDIO_API_KEY: "sense-test-key" }, async () => {
      const provider = createSenseAudioWebSearchProvider();
      const tool = provider.createTool({ config: {}, searchConfig: {} });
      if (!tool) {
        throw new Error("Expected tool definition");
      }
      const controller = new AbortController();
      controller.abort();

      // The mocked fetch ignores abort, so tolerate either outcome and assert
      // the aborted caller signal reached the dispatched request instead.
      await tool
        .execute({ query: "senseaudio abort signal" }, { signal: controller.signal })
        .catch(() => undefined);

      const [, init] = fetchMock.mock.calls[0] as [unknown, RequestInit | undefined];
      expect(init?.signal?.aborted).toBe(true);
    });
  });

  it("reports malformed SenseAudio JSON with a stable provider error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{ nope")));

    await withEnvAsync({ SENSEAUDIO_API_KEY: "sense-test-key" }, async () => {
      await expect(
        executeSenseAudioSearch({ query: "senseaudio malformed response" }),
      ).rejects.toThrow("SenseAudio API error: malformed JSON response");
    });
  });

  it("rejects wrong-root SenseAudio success JSON with a stable provider error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([])));

    await withEnvAsync({ SENSEAUDIO_API_KEY: "sense-test-key" }, async () => {
      await expect(
        executeSenseAudioSearch({ query: "senseaudio wrong root response" }),
      ).rejects.toThrow("SenseAudio API error: malformed JSON response");
    });
  });

  it("rejects responses without final message text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(completedResponse([searchCallItem([])]))),
    );

    await withEnvAsync({ SENSEAUDIO_API_KEY: "sense-test-key" }, async () => {
      await expect(
        executeSenseAudioSearch({ query: "senseaudio missing final message" }),
      ).rejects.toThrow("SenseAudio API error: malformed JSON response");
    });
  });

  it("surfaces API error objects and non-completed statuses", () => {
    expect(() =>
      testing.parseSenseAudioSearchResponse({ error: { message: "quota exceeded" } }),
    ).toThrow("SenseAudio API error: quota exceeded");
    expect(() =>
      testing.parseSenseAudioSearchResponse({
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
      }),
    ).toThrow('SenseAudio API error: response status "incomplete" (max_output_tokens)');
  });
});
