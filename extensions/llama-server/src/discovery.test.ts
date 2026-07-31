import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearLlamaServerDiscoveryCacheForTests,
  discoverLlamaServer,
  type LlamaServerFetchGuard,
} from "./discovery.js";

type RouteValue = Response | Error | (() => Response);

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
    const response = typeof route === "function" ? route() : route;
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
    clearLlamaServerDiscoveryCacheForTests();
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

    const result = await discoverLlamaServer({
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

    const result = await discoverLlamaServer({
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

  it("reuses only successful cached discovery", async () => {
    const { guard } = createFetchGuard({
      "http://localhost:8080/health": json({ status: "ok" }),
      "http://localhost:8080/models": json({ data: [] }),
    });

    await discoverLlamaServer({ baseUrl: "http://localhost:8080", fetchGuard: guard });
    await discoverLlamaServer({ baseUrl: "http://localhost:8080", fetchGuard: guard });
    expect(guard).toHaveBeenCalledTimes(2);
  });
});
