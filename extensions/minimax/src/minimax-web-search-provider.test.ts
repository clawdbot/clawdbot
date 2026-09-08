import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { captureEnv } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMiniMaxWebSearchProvider } from "./minimax-web-search-provider.js";

describe("minimax web search provider", () => {
  const envSnapshot = captureEnv([
    "MINIMAX_API_HOST",
    "MINIMAX_CODE_PLAN_KEY",
    "MINIMAX_CODING_API_KEY",
    "MINIMAX_OAUTH_TOKEN",
    "MINIMAX_API_KEY",
  ]);

  beforeEach(() => {
    delete process.env.MINIMAX_API_HOST;
    delete process.env.MINIMAX_CODE_PLAN_KEY;
    delete process.env.MINIMAX_CODING_API_KEY;
    delete process.env.MINIMAX_OAUTH_TOKEN;
    delete process.env.MINIMAX_API_KEY;
  });

  afterEach(() => {
    envSnapshot.restore();
  });

  it.each([0, 1])(
    "applies the current cache TTL of %i minutes to existing results",
    async (ttl) => {
      const now = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
      const fetchMock = vi.spyOn(globalThis, "fetch");
      for (const result of ["initial", "fresh", "uncached"]) {
        fetchMock.mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              organic: [{ title: result, link: `https://example.test/${result}` }],
              base_resp: { status_code: 0 },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      }
      const createTool = (cacheTtlMinutes: number) => {
        const tool = createMiniMaxWebSearchProvider().createTool({
          config: {
            plugins: {
              entries: { minimax: { config: { webSearch: { apiKey: "minimax-test-key" } } } },
            },
          },
          searchConfig: { cacheTtlMinutes },
        });
        if (!tool) {
          throw new Error("Expected tool definition");
        }
        return tool;
      };

      try {
        const args = { query: `minimax current cache TTL ${ttl}` };
        const originalTool = createTool(15);
        const initial = await originalTool.execute(args);
        expect(await originalTool.execute(args)).toEqual({ ...initial, cached: true });
        expect(fetchMock).toHaveBeenCalledOnce();

        now.mockReturnValue(1_700_000_060_000);
        const currentTool = createTool(ttl);
        const fresh = await currentTool.execute(args);
        expect(fresh.cached).toBeUndefined();
        expect(fresh.results).toEqual([
          expect.objectContaining({ url: "https://example.test/fresh" }),
        ]);
        expect(fetchMock).toHaveBeenCalledTimes(2);

        const repeated = await currentTool.execute(args);
        expect(repeated.cached).toBe(ttl === 0 ? undefined : true);
        expect(fetchMock).toHaveBeenCalledTimes(ttl === 0 ? 3 : 2);
        if (ttl === 0) {
          expect(await originalTool.execute(args)).toEqual({ ...initial, cached: true });
        }
      } finally {
        fetchMock.mockRestore();
        now.mockRestore();
      }
    },
  );

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

  const globalEndpoint = "https://api.minimax.io/v1/coding_plan/search";
  const cnEndpoint = "https://api.minimaxi.com/v1/coding_plan/search";
  const codePlanEnv = { MINIMAX_CODE_PLAN_KEY: "cn-key" };
  const cnProvider = {
    models: { providers: { minimax: { baseUrl: "https://api.minimaxi.com/v1", models: [] } } },
  } satisfies OpenClawConfig;
  const cnPortal = {
    models: {
      providers: { "minimax-portal": { baseUrl: "https://api.minimaxi.com/v1", models: [] } },
    },
  } satisfies OpenClawConfig;
  const cases = [
    {
      name: "configured global over CN provider",
      endpoint: globalEndpoint,
      key: "configured-key",
      config: cnProvider,
      region: "global",
      env: { MINIMAX_CODE_PLAN_KEY: "ignored-env-key" },
    },
    { name: "explicit CN", endpoint: cnEndpoint, key: "cn-key", region: "cn", env: codePlanEnv },
    { name: "CN model provider", endpoint: cnEndpoint, key: "model-key", config: cnProvider },
    { name: "CN portal provider", endpoint: cnEndpoint, key: "portal-key", config: cnPortal },
    {
      name: "shared CN host with coding key",
      endpoint: cnEndpoint,
      key: "coding-key",
      env: {
        MINIMAX_API_HOST: "https://api.minimaxi.com/anthropic",
        MINIMAX_CODING_API_KEY: "coding-key",
      },
    },
    {
      name: "OAuth before legacy key",
      endpoint: globalEndpoint,
      key: "oauth-key",
      env: { MINIMAX_OAUTH_TOKEN: "oauth-key", MINIMAX_API_KEY: "ignored-legacy-key" },
    },
    {
      name: "legacy API key",
      endpoint: globalEndpoint,
      key: "legacy-key",
      env: { MINIMAX_API_KEY: "legacy-key" },
    },
  ];
  it.each(cases)("routes $name searches through the public tool boundary", async (entry) => {
    const env = "env" in entry ? (entry.env ?? {}) : {};
    const config = "config" in entry ? entry.config : {};
    const region = "region" in entry ? entry.region : undefined;
    Object.assign(process.env, env);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ organic: [], base_resp: { status_code: 0 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const tool = createMiniMaxWebSearchProvider().createTool({
      config: {
        ...config,
        plugins: {
          entries: {
            minimax: {
              config: {
                webSearch: {
                  apiKey: Object.values(env).includes(entry.key) ? undefined : entry.key,
                  ...(region ? { region } : {}),
                },
              },
            },
          },
        },
      },
      searchConfig: {},
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    try {
      await tool.execute({ query: `MiniMax ${entry.key}` });
      expect(fetchMock.mock.calls[0]?.[0]).toBe(entry.endpoint);
      expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
        Authorization: `Bearer ${entry.key}`,
      });
    } finally {
      fetchMock.mockRestore();
    }
  });
});
