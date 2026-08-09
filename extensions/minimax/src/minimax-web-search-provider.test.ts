// Minimax tests cover minimax web search provider plugin behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { minimaxWebSearchTesting } from "../test-api.js";
import { createMiniMaxWebSearchProvider } from "./minimax-web-search-provider.js";

const {
  MINIMAX_SEARCH_ENDPOINT_GLOBAL,
  MINIMAX_SEARCH_ENDPOINT_CN,
  resolveMiniMaxApiKey,
  resolveMiniMaxEndpoint,
  resolveMiniMaxRegion,
  readMiniMaxSearchJsonResponse,
} = minimaxWebSearchTesting;

function restoreEnvValue(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

describe("minimax web search provider", () => {
  const originalApiHost = process.env.MINIMAX_API_HOST;
  const originalCodePlanKey = process.env.MINIMAX_CODE_PLAN_KEY;
  const originalCodingApiKey = process.env.MINIMAX_CODING_API_KEY;
  const originalOauthToken = process.env.MINIMAX_OAUTH_TOKEN;
  const originalApiKey = process.env.MINIMAX_API_KEY;

  beforeEach(() => {
    delete process.env.MINIMAX_API_HOST;
    delete process.env.MINIMAX_CODE_PLAN_KEY;
    delete process.env.MINIMAX_CODING_API_KEY;
    delete process.env.MINIMAX_OAUTH_TOKEN;
    delete process.env.MINIMAX_API_KEY;
  });

  afterEach(() => {
    restoreEnvValue("MINIMAX_API_HOST", originalApiHost);
    restoreEnvValue("MINIMAX_CODE_PLAN_KEY", originalCodePlanKey);
    restoreEnvValue("MINIMAX_CODING_API_KEY", originalCodingApiKey);
    restoreEnvValue("MINIMAX_OAUTH_TOKEN", originalOauthToken);
    restoreEnvValue("MINIMAX_API_KEY", originalApiKey);
  });

  it("does not send an already canceled MiniMax search", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ organic: [], base_resp: { status_code: 0 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const tool = createMiniMaxWebSearchProvider().createTool({
      config: {
        plugins: {
          entries: { minimax: { config: { webSearch: { apiKey: "minimax-test-key" } } } },
        },
      },
      searchConfig: {},
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }
    const controller = new AbortController();
    controller.abort(new Error("MiniMax caller canceled"));

    try {
      await expect(
        tool.execute({ query: "minimax pre-canceled" }, { signal: controller.signal }),
      ).rejects.toThrow("MiniMax caller canceled");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("aborts the guarded MiniMax request with the caller's reason", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (_url, init) =>
        await new Promise<Response>((_resolve, reject) => {
          if (!init?.signal) {
            reject(new Error("MiniMax request lost caller cancellation"));
            return;
          }
          init.signal.addEventListener("abort", () => reject(init.signal?.reason as Error), {
            once: true,
          });
        }),
    );
    const tool = createMiniMaxWebSearchProvider().createTool({
      config: {
        plugins: {
          entries: { minimax: { config: { webSearch: { apiKey: "minimax-test-key" } } } },
        },
      },
      searchConfig: {},
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }
    const controller = new AbortController();
    const result = tool.execute(
      { query: "minimax in-flight cancellation" },
      { signal: controller.signal },
    );

    try {
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
      controller.abort(new Error("MiniMax request canceled in flight"));
      await expect(result).rejects.toThrow("MiniMax request canceled in flight");
      expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    } finally {
      fetchMock.mockRestore();
    }
  });

  describe("resolveMiniMaxRegion", () => {
    it("returns global by default", () => {
      expect(resolveMiniMaxRegion()).toBe("global");
      expect(resolveMiniMaxRegion({})).toBe("global");
    });

    it("returns cn when explicit region is cn", () => {
      expect(resolveMiniMaxRegion({ minimax: { region: "cn" } })).toBe("cn");
    });

    it("returns global when explicit region is not cn", () => {
      expect(resolveMiniMaxRegion({ minimax: { region: "global" } })).toBe("global");
      expect(resolveMiniMaxRegion({ minimax: { region: "us" } })).toBe("global");
    });

    it("infers cn from MINIMAX_API_HOST", () => {
      process.env.MINIMAX_API_HOST = "https://api.minimaxi.com/anthropic";
      expect(resolveMiniMaxRegion()).toBe("cn");
    });

    it("infers cn from model provider base URL", () => {
      const cnConfig = {
        models: {
          providers: {
            minimax: { baseUrl: "https://api.minimaxi.com/anthropic" },
          },
        },
      };
      expect(resolveMiniMaxRegion({}, cnConfig)).toBe("cn");
    });

    it("infers cn from minimax-portal base URL (OAuth CN path)", () => {
      const cnPortalConfig = {
        models: {
          providers: {
            "minimax-portal": { baseUrl: "https://api.minimaxi.com/anthropic" },
          },
        },
      };
      expect(resolveMiniMaxRegion({}, cnPortalConfig)).toBe("cn");
    });

    it("returns global when model provider base URL is global", () => {
      const globalConfig = {
        models: {
          providers: {
            minimax: { baseUrl: "https://api.minimax.io/anthropic" },
          },
        },
      };
      expect(resolveMiniMaxRegion({}, globalConfig)).toBe("global");
    });

    it("explicit search config region takes priority over base URL", () => {
      const cnConfig = {
        models: {
          providers: {
            minimax: { baseUrl: "https://api.minimaxi.com/anthropic" },
          },
        },
      };
      // Explicit global region overrides CN base URL
      expect(resolveMiniMaxRegion({ minimax: { region: "global" } }, cnConfig)).toBe("global");
    });

    it("handles non-object minimax search config gracefully", () => {
      expect(resolveMiniMaxRegion({ minimax: "invalid" })).toBe("global");
      expect(resolveMiniMaxRegion({ minimax: null })).toBe("global");
      expect(resolveMiniMaxRegion({ minimax: [1, 2] })).toBe("global");
    });
  });

  describe("resolveMiniMaxEndpoint", () => {
    it("returns global endpoint by default", () => {
      expect(resolveMiniMaxEndpoint()).toBe(MINIMAX_SEARCH_ENDPOINT_GLOBAL);
    });

    it("returns CN endpoint when region is cn", () => {
      expect(resolveMiniMaxEndpoint({ minimax: { region: "cn" } })).toBe(
        MINIMAX_SEARCH_ENDPOINT_CN,
      );
    });

    it("returns CN endpoint when inferred from model provider base URL", () => {
      const cnConfig = {
        models: {
          providers: {
            minimax: { baseUrl: "https://api.minimaxi.com/anthropic" },
          },
        },
      };
      expect(resolveMiniMaxEndpoint({}, cnConfig)).toBe(MINIMAX_SEARCH_ENDPOINT_CN);
    });
  });

  describe("resolveMiniMaxApiKey", () => {
    it("prefers configured apiKey over env vars", () => {
      process.env.MINIMAX_CODE_PLAN_KEY = "env-key";
      expect(resolveMiniMaxApiKey({ apiKey: "configured-key" })).toBe("configured-key");
    });

    it("accepts MINIMAX_CODING_API_KEY as a token-plan alias", () => {
      process.env.MINIMAX_CODING_API_KEY = "coding-key";
      expect(resolveMiniMaxApiKey()).toBe("coding-key");
    });

    it("falls back to MINIMAX_API_KEY last", () => {
      process.env.MINIMAX_API_KEY = "plain-key";
      expect(resolveMiniMaxApiKey()).toBe("plain-key");
    });

    it("accepts MINIMAX_OAUTH_TOKEN before the legacy API-key fallback", () => {
      process.env.MINIMAX_OAUTH_TOKEN = "oauth-token";
      process.env.MINIMAX_API_KEY = "plain-key";
      expect(resolveMiniMaxApiKey()).toBe("oauth-token");
    });
  });

  describe("endpoint constants", () => {
    it("uses correct global endpoint", () => {
      expect(MINIMAX_SEARCH_ENDPOINT_GLOBAL).toBe("https://api.minimax.io/v1/coding_plan/search");
    });

    it("uses correct CN endpoint", () => {
      expect(MINIMAX_SEARCH_ENDPOINT_CN).toBe("https://api.minimaxi.com/v1/coding_plan/search");
    });
  });

  it("reports malformed Search API JSON with a stable provider error", async () => {
    await expect(
      readMiniMaxSearchJsonResponse(new Response("{ nope"), "MiniMax Search API error"),
    ).rejects.toThrow("MiniMax Search API error: malformed JSON response");
  });
});
