import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-shared";
import type { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { discoverLlamaServer } from "./discovery.js";

type LlamaServerFetchGuard = typeof fetchWithSsrFGuard;
type DiscoveryParams = Parameters<typeof discoverLlamaServer>[0];

async function discoverTest(params: DiscoveryParams) {
  return await discoverLlamaServer({ cacheTtlMs: 0, ...params });
}

type RouteValue = Response | Error | (() => Response | Promise<Response>);

function createFetchGuard(routes: Record<string, RouteValue>) {
  const requests: string[] = [];
  const guard = vi.fn(async (params: Parameters<LlamaServerFetchGuard>[0]) => {
    requests.push(params.url);
    const route = routes[params.url];
    if (!route) {
      throw new Error(`unexpected request: ${params.url}`);
    }
    if (route instanceof Error) {
      throw route;
    }
    const response = typeof route === "function" ? await route() : route;
    return {
      response,
      finalUrl: params.url,
      release: async () => undefined,
    };
  }) as unknown as LlamaServerFetchGuard;
  return { guard, requests };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("llama-server discovery", () => {
  beforeEach(() => {
    clearLiveCatalogCacheForTests();
  });

  it("discovers a single model and reads runtime properties", async () => {
    const { guard, requests } = createFetchGuard({
      "http://localhost:8080/health": json({ status: "ok" }),
      "http://localhost:8080/models": json({
        object: "list",
        data: [{ id: "qwen/model:Q4_K_M", object: "model", owned_by: "llamacpp" }],
      }),
      "http://localhost:8080/props": json({
        default_generation_settings: { n_ctx: 32768 },
        chat_template_caps: { supports_tools: true, supports_tool_calls: true },
      }),
    });

    const result = await discoverTest({
      baseUrl: "http://localhost:8080/v1",
      apiKey: "server-key",
      fetchGuard: guard,
      cacheTtlMs: 0,
    });

    expect(result).toMatchObject({
      kind: "success",
      health: "ready",
      models: [
        {
          status: "unknown",
          config: {
            id: "qwen/model:Q4_K_M",
            contextWindow: 32768,
            compat: { supportsTools: true },
          },
        },
      ],
    });
    expect(requests).toEqual([
      "http://localhost:8080/health",
      "http://localhost:8080/models",
      "http://localhost:8080/props",
    ]);
    expect(guard).toHaveBeenCalledWith(
      expect.objectContaining({
        init: {
          headers: {
            Accept: "application/json",
            Authorization: "Bearer server-key",
          },
        },
      }),
    );
  });

  it("lists router models without loading an unloaded model", async () => {
    const { guard, requests } = createFetchGuard({
      "http://localhost:8080/health": json({ status: "ok" }),
      "http://localhost:8080/models": json({
        data: [
          { id: "loaded/model", object: "model", status: { value: "loaded" } },
          { id: "sleeping:model", object: "model", status: { value: "sleeping" } },
          { id: "unloaded/model", object: "model", status: { value: "unloaded" } },
        ],
      }),
      "http://localhost:8080/props?model=loaded%2Fmodel&autoload=false": json({
        default_generation_settings: { n_ctx: 16384 },
      }),
      "http://localhost:8080/props?model=sleeping%3Amodel&autoload=false": json({
        default_generation_settings: { n_ctx: 8192 },
        is_sleeping: true,
      }),
    });

    const result = await discoverTest({
      baseUrl: "http://localhost:8080",
      fetchGuard: guard,
      cacheTtlMs: 0,
    });

    expect(result.kind).toBe("success");
    if (result.kind !== "success") {
      throw new Error("expected successful discovery");
    }
    expect(result.models.map((model) => [model.config.id, model.status])).toEqual([
      ["loaded/model", "loaded"],
      ["sleeping:model", "sleeping"],
      ["unloaded/model", "unloaded"],
    ]);
    expect(requests).not.toContain(
      "http://localhost:8080/props?model=unloaded%2Fmodel&autoload=false",
    );
    expect(requests.every((url) => !url.includes("reload=1"))).toBe(true);
  });

  it("bounds concurrent router property probes", async () => {
    const rows = Array.from({ length: 17 }, (_, index) => ({
      id: `loaded/model-${index}`,
      object: "model",
      status: { value: "loaded" },
    }));
    let active = 0;
    let maximumActive = 0;
    const routes: Record<string, RouteValue> = {
      "http://localhost:8080/health": json({ status: "ok" }),
      "http://localhost:8080/models": json({ data: rows }),
    };
    for (const row of rows) {
      routes[`http://localhost:8080/props?model=${encodeURIComponent(row.id)}&autoload=false`] =
        async () => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          await new Promise((resolve) => {
            setTimeout(resolve, 5);
          });
          active -= 1;
          return json({ default_generation_settings: { n_ctx: 8192 } });
        };
    }
    const { guard } = createFetchGuard(routes);

    const result = await discoverTest({
      baseUrl: "http://localhost:8080",
      fetchGuard: guard,
      cacheTtlMs: 0,
    });

    expect(result).toMatchObject({ kind: "success", models: expect.any(Array) });
    expect(result.kind === "success" ? result.models : []).toHaveLength(17);
    expect(maximumActive).toBeGreaterThan(1);
    expect(maximumActive).toBeLessThanOrEqual(8);
  });

  it("stops scheduling router property probes after the total budget", async () => {
    const rows = Array.from({ length: 17 }, (_, index) => ({
      id: `loaded/model-${index}`,
      object: "model",
      status: { value: "loaded" },
    }));
    const routes: Record<string, RouteValue> = {
      "http://localhost:8080/health": json({ status: "ok" }),
      "http://localhost:8080/models": json({ data: rows }),
    };
    for (const row of rows) {
      routes[`http://localhost:8080/props?model=${encodeURIComponent(row.id)}&autoload=false`] =
        async () => {
          await new Promise((resolve) => {
            setTimeout(resolve, 20);
          });
          return json({ default_generation_settings: { n_ctx: 8192 } });
        };
    }
    const { guard, requests } = createFetchGuard(routes);

    const result = await discoverTest({
      baseUrl: "http://localhost:8080",
      fetchGuard: guard,
      cacheTtlMs: 0,
      timeoutMs: 10,
    });

    expect(result.kind === "success" ? result.models : []).toHaveLength(17);
    expect(requests.filter((url) => url.includes("/props?"))).toHaveLength(8);
  });

  it("keeps router properties associated with their model when probes finish out of order", async () => {
    const rows = [0, 1, 2].map((index) => ({
      id: `model-${index}`,
      object: "model",
      status: { value: "loaded" },
    }));
    const routes: Record<string, RouteValue> = {
      "http://localhost:8080/health": json({ status: "ok" }),
      "http://localhost:8080/models": json({ data: rows }),
    };
    for (const [index, row] of rows.entries()) {
      routes[`http://localhost:8080/props?model=${row.id}&autoload=false`] = async () => {
        await new Promise((resolve) => {
          setTimeout(resolve, (2 - index) * 5);
        });
        return json({ default_generation_settings: { n_ctx: 8_000 + index } });
      };
    }
    const { guard } = createFetchGuard(routes);

    const result = await discoverTest({
      baseUrl: "http://localhost:8080",
      fetchGuard: guard,
    });

    expect(
      result.kind === "success" ? result.models.map((model) => model.config.contextWindow) : [],
    ).toEqual([8_000, 8_001, 8_002]);
  });

  it("caps router property probes at 200 models", async () => {
    const rows = Array.from({ length: 205 }, (_, index) => ({
      id: `model-${index}`,
      object: "model",
      status: { value: "loaded" },
    }));
    const routes: Record<string, RouteValue> = {
      "http://localhost:8080/health": json({ status: "ok" }),
      "http://localhost:8080/models": json({ data: rows }),
    };
    for (const row of rows.slice(0, 200)) {
      routes[`http://localhost:8080/props?model=${row.id}&autoload=false`] = json({});
    }
    const { guard, requests } = createFetchGuard(routes);

    const result = await discoverTest({
      baseUrl: "http://localhost:8080",
      fetchGuard: guard,
    });

    expect(result.kind === "success" ? result.models : []).toHaveLength(205);
    expect(requests.filter((url) => url.includes("/props?"))).toHaveLength(200);
  });

  it("falls back to /v1/models for an older compatible server", async () => {
    const { guard } = createFetchGuard({
      "http://localhost:8080/health": json({ status: "ok" }),
      "http://localhost:8080/models": json({ error: "missing" }, 404),
      "http://localhost:8080/v1/models": json({
        data: [{ id: "model", object: "model" }],
      }),
      "http://localhost:8080/props": json({}),
    });

    await expect(
      discoverLlamaServer({ baseUrl: "http://localhost:8080", fetchGuard: guard, cacheTtlMs: 0 }),
    ).resolves.toMatchObject({ kind: "success", models: [{ config: { id: "model" } }] });
  });

  it("keeps a loading health state while listing available models", async () => {
    const { guard } = createFetchGuard({
      "http://localhost:8080/health": json({ error: "loading" }, 503),
      "http://localhost:8080/models": json({ data: [] }),
    });

    await expect(
      discoverLlamaServer({ baseUrl: "http://localhost:8080", fetchGuard: guard, cacheTtlMs: 0 }),
    ).resolves.toMatchObject({ kind: "success", health: "loading", models: [] });
  });

  it("separates transport, HTTP, and malformed-response failures", async () => {
    const unreachable = createFetchGuard({
      "http://localhost:8080/health": new Error("connection refused"),
    });
    await expect(
      discoverLlamaServer({
        baseUrl: "http://localhost:8080",
        fetchGuard: unreachable.guard,
        cacheTtlMs: 0,
      }),
    ).resolves.toMatchObject({ kind: "unreachable" });

    const unauthorized = createFetchGuard({
      "http://localhost:8080/health": json({ error: "unauthorized" }, 401),
    });
    await expect(
      discoverLlamaServer({
        baseUrl: "http://localhost:8080",
        fetchGuard: unauthorized.guard,
        cacheTtlMs: 0,
      }),
    ).resolves.toMatchObject({ kind: "http-error", status: 401, path: "/health" });

    const malformed = createFetchGuard({
      "http://localhost:8080/health": json({ status: "ok" }),
      "http://localhost:8080/models": new Response("{", { status: 200 }),
    });
    await expect(
      discoverLlamaServer({
        baseUrl: "http://localhost:8080",
        fetchGuard: malformed.guard,
        cacheTtlMs: 0,
      }),
    ).resolves.toMatchObject({ kind: "invalid-response", path: "/models" });
  });

  it("forwards configured headers and bypasses the shared cache for credentialed discovery", async () => {
    const { guard } = createFetchGuard({
      "http://localhost:8080/health": () => json({ status: "ok" }),
      "http://localhost:8080/models": () => json({ data: [] }),
    });

    for (let index = 0; index < 2; index += 1) {
      await discoverTest({
        baseUrl: "http://localhost:8080",
        headers: { "X-Proxy-Key": "proxy-token" },
        fetchGuard: guard,
      });
    }

    expect(guard).toHaveBeenCalledTimes(4);
    for (const call of vi.mocked(guard).mock.calls) {
      expect(call[0]).toEqual(
        expect.objectContaining({
          init: {
            headers: {
              Accept: "application/json",
              "X-Proxy-Key": "proxy-token",
            },
          },
        }),
      );
    }
  });

  it("reuses only successful cached discovery", async () => {
    const { guard } = createFetchGuard({
      "http://localhost:8080/health": json({ status: "ok" }),
      "http://localhost:8080/models": json({ data: [] }),
    });

    await discoverTest({
      baseUrl: "http://localhost:8080",
      apiKey: "custom-local",
      fetchGuard: guard,
      cacheTtlMs: 30_000,
    });
    await discoverTest({
      baseUrl: "http://localhost:8080",
      apiKey: "custom-local",
      fetchGuard: guard,
      cacheTtlMs: 30_000,
    });
    expect(guard).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent discovery for the same uncredentialed endpoint", async () => {
    let releaseHealth: ((response: Response) => void) | undefined;
    const { guard } = createFetchGuard({
      "http://localhost:8080/health": () =>
        new Promise<Response>((resolve) => {
          releaseHealth = resolve;
        }),
      "http://localhost:8080/models": () => json({ data: [] }),
    });

    const first = discoverTest({
      baseUrl: "http://localhost:8080",
      apiKey: "custom-local",
      fetchGuard: guard,
      cacheTtlMs: 30_000,
    });
    const second = discoverTest({
      baseUrl: "http://localhost:8080",
      apiKey: "custom-local",
      fetchGuard: guard,
      cacheTtlMs: 30_000,
    });

    expect(releaseHealth).toBeDefined();
    expect(guard).toHaveBeenCalledTimes(1);
    releaseHealth?.(json({ status: "ok" }));
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ kind: "success" }),
      expect.objectContaining({ kind: "success" }),
    ]);
    expect(guard).toHaveBeenCalledTimes(2);
  });

  it("reloads cached discovery after its configured TTL", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const { guard } = createFetchGuard({
        "http://localhost:8080/health": () => json({ status: "ok" }),
        "http://localhost:8080/models": () => json({ data: [] }),
      });

      await discoverTest({
        baseUrl: "http://localhost:8080",
        apiKey: "custom-local",
        fetchGuard: guard,
        cacheTtlMs: 100,
      });
      vi.setSystemTime(1_101);
      await discoverTest({
        baseUrl: "http://localhost:8080",
        apiKey: "custom-local",
        fetchGuard: guard,
        cacheTtlMs: 100,
      });

      expect(guard).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retain unsuccessful discovery results", async () => {
    const { guard } = createFetchGuard({
      "http://localhost:8080/health": () => json({ error: "unauthorized" }, 401),
    });

    for (let index = 0; index < 2; index += 1) {
      await discoverTest({
        baseUrl: "http://localhost:8080",
        apiKey: "custom-local",
        fetchGuard: guard,
        cacheTtlMs: 30_000,
      });
    }

    expect(guard).toHaveBeenCalledTimes(2);
  });

  it("bypasses an existing endpoint cache when a real API key is supplied", async () => {
    const { guard } = createFetchGuard({
      "http://localhost:8080/health": () => json({ status: "ok" }),
      "http://localhost:8080/models": () => json({ data: [] }),
    });

    await discoverTest({
      baseUrl: "http://localhost:8080",
      apiKey: "custom-local",
      fetchGuard: guard,
      cacheTtlMs: 30_000,
    });
    await discoverTest({
      baseUrl: "http://localhost:8080",
      apiKey: "real-secret",
      fetchGuard: guard,
      cacheTtlMs: 30_000,
    });

    expect(guard).toHaveBeenCalledTimes(4);
  });

  it("keeps uncredentialed discovery caches isolated by endpoint", async () => {
    const { guard } = createFetchGuard({
      "http://localhost:8080/health": json({ status: "ok" }),
      "http://localhost:8080/models": json({ data: [] }),
      "http://localhost:8081/health": json({ status: "ok" }),
      "http://localhost:8081/models": json({ data: [] }),
    });

    await discoverTest({
      baseUrl: "http://localhost:8080",
      apiKey: "custom-local",
      fetchGuard: guard,
      cacheTtlMs: 30_000,
    });
    await discoverTest({
      baseUrl: "http://localhost:8081",
      apiKey: "custom-local",
      fetchGuard: guard,
      cacheTtlMs: 30_000,
    });

    expect(guard).toHaveBeenCalledTimes(4);
  });

  it("bounds cached endpoint discovery", async () => {
    const guard = vi.fn(async (params: Parameters<LlamaServerFetchGuard>[0]) => ({
      response: params.url.endsWith("/health") ? json({ status: "ok" }) : json({ data: [] }),
      finalUrl: params.url,
      release: async () => undefined,
    })) as unknown as LlamaServerFetchGuard;

    for (let index = 0; index <= 100; index += 1) {
      await discoverTest({
        baseUrl: `http://localhost:${10_000 + index}`,
        apiKey: "custom-local",
        fetchGuard: guard,
        cacheTtlMs: 30_000,
      });
    }
    expect(guard).toHaveBeenCalledTimes(202);

    await discoverTest({
      baseUrl: "http://localhost:10100",
      apiKey: "custom-local",
      fetchGuard: guard,
      cacheTtlMs: 30_000,
    });
    expect(guard).toHaveBeenCalledTimes(202);

    await discoverTest({
      baseUrl: "http://localhost:10000",
      apiKey: "custom-local",
      fetchGuard: guard,
      cacheTtlMs: 30_000,
    });
    expect(guard).toHaveBeenCalledTimes(204);
  });
});
