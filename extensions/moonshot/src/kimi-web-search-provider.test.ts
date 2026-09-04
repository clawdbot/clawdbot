import { withEnvAsync } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createKimiWebSearchProvider } from "./kimi-web-search-provider.js";

const globalBaseUrl = "https://api.moonshot.ai/v1";
const cnBaseUrl = "https://api.moonshot.cn/v1";
const explicitBaseUrl = "https://kimi.example/v1";
const explicitWebSearch = { baseUrl: `${explicitBaseUrl}/`, model: "kimi-k2" };

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

async function executeKimiSearch(
  query: string,
  cacheTtlMinutes?: number,
): Promise<Record<string, unknown>> {
  const provider = createKimiWebSearchProvider();
  const tool = provider.createTool({ config: {}, searchConfig: { cacheTtlMinutes } });
  if (!tool) {
    throw new Error("Expected tool definition");
  }
  return await tool.execute({ query });
}

function expectStringFieldContains(result: Record<string, unknown>, field: string, text: string) {
  const value = result[field];
  expect(typeof value).toBe("string");
  expect(value).toContain(text);
}

describe("kimi web search provider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("points missing-key users to fetch/browser alternatives", async () => {
    await withEnvAsync({ KIMI_API_KEY: undefined, MOONSHOT_API_KEY: undefined }, async () => {
      const provider = createKimiWebSearchProvider();
      const tool = provider.createTool({ config: {}, searchConfig: {} });
      if (!tool) {
        throw new Error("Expected tool definition");
      }

      const result = await tool.execute({ query: "OpenClaw docs" });

      expect(result.error).toBe("missing_kimi_api_key");
      expectStringFieldContains(
        result,
        "message",
        "use web_fetch for a specific URL or the browser tool",
      );
    });
  });

  it.each([
    ["defaults", undefined, {}, globalBaseUrl, "kimi-k2.6"],
    ["inherits native CN", `${cnBaseUrl}/`, {}, cnBaseUrl, "kimi-k2.6"],
    ["rejects proxy inheritance", "https://proxy.example/v1", {}, globalBaseUrl, "kimi-k2.6"],
    ["prefers explicit Kimi config", cnBaseUrl, explicitWebSearch, explicitBaseUrl, "kimi-k2"],
  ])(
    "applies %s configuration at the tool boundary",
    async (name, chatBaseUrl, webSearch, baseUrl, model) => {
      const fetchMock = vi.fn().mockResolvedValue(
        jsonResponse({
          search_results: [{ url: "https://a.test" }],
          choices: [{ finish_reason: "stop", message: { content: "Grounded answer" } }],
        }),
      );
      vi.stubGlobal("fetch", fetchMock);
      const tool = createKimiWebSearchProvider().createTool({
        config: {
          ...(chatBaseUrl
            ? { models: { providers: { moonshot: { baseUrl: chatBaseUrl, models: [] } } } }
            : {}),
          plugins: {
            entries: {
              moonshot: {
                config: {
                  webSearch: {
                    apiKey: "kimi-config-key",
                    ...webSearch,
                  },
                },
              },
            },
          },
        },
        searchConfig: {},
      } as never);
      if (!tool) {
        throw new Error("Expected tool definition");
      }

      await tool.execute({ query: `Kimi boundary ${name}` });
      expect(fetchMock.mock.calls[0]?.[0]).toBe(`${baseUrl}/chat/completions`);
      const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
      expect(headers.get("Authorization")).toBe("Bearer kimi-config-key");
      expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
        model,
      });
    },
  );

  it("returns a structured failure for ungrounded chat-only responses", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        choices: [
          {
            finish_reason: "stop",
            message: { content: "I cannot browse the internet." },
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await withEnvAsync({ KIMI_API_KEY: "kimi-test-key" }, async () => {
      const result = await executeKimiSearch("kimi ungrounded chat fallback");

      expect(result.error).toBe("kimi_web_search_ungrounded");
      expect(result.provider).toBe("kimi");
      expectStringFieldContains(result, "message", "without native web-search grounding");
    });
  });

  it("reports malformed Kimi API JSON with a stable provider error", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{ nope"));
    vi.stubGlobal("fetch", fetchMock);

    await withEnvAsync({ KIMI_API_KEY: "kimi-test-key" }, async () => {
      await expect(executeKimiSearch("kimi malformed response")).rejects.toThrow(
        "Kimi API error: malformed JSON response",
      );
    });
  });

  it("rejects wrong-root Kimi success JSON with a stable provider error", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([]));
    vi.stubGlobal("fetch", fetchMock);

    await withEnvAsync({ KIMI_API_KEY: "kimi-test-key" }, async () => {
      await expect(executeKimiSearch("kimi wrong root response")).rejects.toThrow(
        "Kimi API error: malformed JSON response",
      );
    });
  });

  it("rejects Kimi success JSON without a final message", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ choices: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await withEnvAsync({ KIMI_API_KEY: "kimi-test-key" }, async () => {
      await expect(executeKimiSearch("kimi missing final message")).rejects.toThrow(
        "Kimi API error: malformed JSON response",
      );
    });
  });

  it("accepts final responses backed by Kimi web search tool replay", async () => {
    const toolArguments = JSON.stringify({
      query: "OpenClaw GitHub repository",
      search_results: [{ url: "https://github.com/openclaw/openclaw" }],
      usage: { total_tokens: 1200 },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                content: "",
                tool_calls: [
                  {
                    id: "call-1",
                    function: {
                      name: "$web_search",
                      arguments: toolArguments,
                    },
                  },
                ],
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          choices: [
            {
              finish_reason: "stop",
              message: { content: "OpenClaw is available on GitHub." },
            },
          ],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await withEnvAsync({ KIMI_API_KEY: "kimi-test-key" }, async () => {
      const result = await executeKimiSearch("kimi grounded tool replay");

      expect(result.provider).toBe("kimi");
      expectStringFieldContains(result, "content", "OpenClaw is available on GitHub.");
      expect(result.citations).toEqual(["https://github.com/openclaw/openclaw"]);
      expect(result).not.toHaveProperty("error");
    });
  });

  it("rejects exhausted web search rounds without caching a fabricated answer", async () => {
    const query = "unique Kimi exhausted search rounds cache regression";
    const toolCallResponse = (id: string) =>
      jsonResponse({
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              content: "",
              tool_calls: [
                {
                  id,
                  function: {
                    name: "$web_search",
                    arguments: JSON.stringify({ query }),
                  },
                },
              ],
            },
          },
        ],
      });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(toolCallResponse("call-1"))
      .mockResolvedValueOnce(toolCallResponse("call-2"))
      .mockResolvedValueOnce(toolCallResponse("call-3"))
      .mockResolvedValueOnce(
        jsonResponse({
          search_results: [{ title: "OpenClaw", url: "https://github.com/openclaw/openclaw" }],
          choices: [
            {
              finish_reason: "stop",
              message: { content: "OpenClaw is available on GitHub." },
            },
          ],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await withEnvAsync({ KIMI_API_KEY: "kimi-test-key" }, async () => {
      await expect(executeKimiSearch(query)).rejects.toThrow(
        "exhausted its tool-call rounds without producing a final answer",
      );

      const result = await executeKimiSearch(query);
      expectStringFieldContains(result, "content", "OpenClaw is available on GitHub.");
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });
  });

  it("accepts final responses with search result citations", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        search_results: [{ title: "OpenClaw", url: "https://github.com/openclaw/openclaw" }],
        choices: [
          {
            finish_reason: "stop",
            message: { content: "OpenClaw is on GitHub." },
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await withEnvAsync({ KIMI_API_KEY: "kimi-test-key" }, async () => {
      const result = await executeKimiSearch("kimi grounded citation");

      expect(result.provider).toBe("kimi");
      expectStringFieldContains(result, "content", "OpenClaw is on GitHub.");
      expect(result.citations).toEqual(["https://github.com/openclaw/openclaw"]);
      expect(result).not.toHaveProperty("error");
    });
  });

  it("reuses cached Kimi answers across ignored result counts while rejecting invalid counts", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        jsonResponse({
          search_results: [{ title: "OpenClaw", url: "https://github.com/openclaw/openclaw" }],
          choices: [
            {
              finish_reason: "stop",
              message: { content: "OpenClaw is on GitHub." },
            },
          ],
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await withEnvAsync({ KIMI_API_KEY: "kimi-test-key" }, async () => {
      const tool = createKimiWebSearchProvider().createTool({ config: {}, searchConfig: {} });
      if (!tool) {
        throw new Error("Expected tool definition");
      }
      const query = "unique Kimi ignored result count cache regression";

      await tool.execute({ query, count: 1 });
      await tool.execute({ query, count: 10 });
      await tool.execute({ query });

      await expect(tool.execute({ query, count: 0 })).rejects.toThrow(
        "count must be an integer from 1 to 10.",
      );
      expect(fetchMock).toHaveBeenCalledOnce();
    });
  });

  it.each([0, 1])("honors the current Kimi cache TTL of %s minutes", async (cacheTtlMinutes) => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    let content = "Original grounded answer";
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        search_results: [{ url: "https://example.com/kimi" }],
        choices: [{ finish_reason: "stop", message: { content } }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await withEnvAsync({ KIMI_API_KEY: "kimi-test-key" }, async () => {
      const query = `Kimi current request cache TTL ${cacheTtlMinutes}`;
      await executeKimiSearch(query, 15);
      await expect(executeKimiSearch(query, 15)).resolves.toMatchObject({
        cached: true,
        content: expect.stringContaining("Original grounded answer"),
      });
      expect(fetchMock).toHaveBeenCalledOnce();

      now.mockReturnValue(1_060_000);
      content = "Fresh grounded answer";
      const fresh = await executeKimiSearch(query, cacheTtlMinutes);
      expect(fresh).not.toHaveProperty("cached");
      expectStringFieldContains(fresh, "content", "Fresh grounded answer");
      expect(fetchMock).toHaveBeenCalledTimes(2);

      if (cacheTtlMinutes === 0) {
        await expect(executeKimiSearch(query, 0)).resolves.not.toHaveProperty("cached");
        expect(fetchMock).toHaveBeenCalledTimes(3);
        await expect(executeKimiSearch(query, 15)).resolves.toMatchObject({
          cached: true,
          content: expect.stringContaining("Original grounded answer"),
        });
        expect(fetchMock).toHaveBeenCalledTimes(3);
      } else {
        await expect(executeKimiSearch(query, cacheTtlMinutes)).resolves.toEqual({
          ...fresh,
          cached: true,
        });
        expect(fetchMock).toHaveBeenCalledTimes(2);
      }
    });
  });

  it("forwards the execution abort signal to an in-flight Kimi search", async () => {
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new Error(String(init.signal?.reason ?? "Aborted"))),
            {
              once: true,
            },
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await withEnvAsync({ KIMI_API_KEY: "kimi-test-key" }, async () => {
      const controller = new AbortController();
      const tool = createKimiWebSearchProvider().createTool({ config: {}, searchConfig: {} });
      if (!tool) {
        throw new Error("Expected tool definition");
      }

      const search = tool.execute(
        { query: "unique Kimi abort regression" },
        {
          signal: controller.signal,
        },
      );
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
      controller.abort(new Error("Kimi search cancelled"));

      await expect(search).rejects.toThrow("Kimi search cancelled");
      expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    });
  });

  it("does not cache a grounded Kimi result completed after caller cancellation", async () => {
    const controller = new AbortController();
    const reason = new Error("Kimi search cancelled after response");
    const grounded = {
      search_results: [{ title: "OpenClaw", url: "https://github.com/openclaw/openclaw" }],
      choices: [{ finish_reason: "stop", message: { content: "OpenClaw is on GitHub." } }],
    };
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () => {
        controller.abort(reason);
        return jsonResponse(grounded);
      })
      .mockResolvedValueOnce(jsonResponse(grounded));
    vi.stubGlobal("fetch", fetchMock);

    await withEnvAsync({ KIMI_API_KEY: "kimi-test-key" }, async () => {
      const tool = createKimiWebSearchProvider().createTool({ config: {}, searchConfig: {} });
      if (!tool) {
        throw new Error("Expected tool definition");
      }
      const query = "unique Kimi late-cancel cache regression";

      await expect(tool.execute({ query }, { signal: controller.signal })).rejects.toBe(reason);
      await tool.execute({ query });

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });
});
