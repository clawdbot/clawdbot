import { beforeEach, describe, expect, it, vi } from "vitest";
import { discoverOpenAICompatibleLocalModels } from "./provider-self-hosted-discovery.js";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

beforeEach(() => {
  vi.clearAllMocks();
});

function guarded(response: Response) {
  return {
    response,
    finalUrl: "http://127.0.0.1:8080",
    release: vi.fn(async () => undefined),
  };
}

describe("discoverOpenAICompatibleLocalModels raw discovery", () => {
  it("preserves health and falls back from root /models to /v1/models", async () => {
    fetchWithSsrFGuardMock
      .mockResolvedValueOnce(guarded(new Response(null, { status: 503 })))
      .mockResolvedValueOnce(guarded(new Response(null, { status: 404 })))
      .mockResolvedValueOnce(
        guarded(
          new Response(JSON.stringify({ data: [{ id: "model", object: "model" }] }), {
            status: 200,
          }),
        ),
      )
      .mockResolvedValueOnce(guarded(new Response(JSON.stringify({ n_ctx: 8192 }))));

    await expect(
      discoverOpenAICompatibleLocalModels({
        baseUrl: "http://127.0.0.1:8080/v1",
        serverBaseUrl: "http://127.0.0.1:8080",
        label: "llama-server",
        healthPath: "/health",
        modelsPathOrder: "server-first",
        routerModelProps: true,
        rawResult: true,
      }),
    ).resolves.toMatchObject({
      kind: "success",
      health: "loading",
      rows: [{ model: { id: "model" }, props: { n_ctx: 8192 } }],
    });
    expect(fetchWithSsrFGuardMock.mock.calls.map(([call]) => call.url)).toEqual([
      "http://127.0.0.1:8080/health",
      "http://127.0.0.1:8080/models",
      "http://127.0.0.1:8080/v1/models",
      "http://127.0.0.1:8080/props",
    ]);
  });

  it("separates transport, HTTP, and invalid model-list responses", async () => {
    fetchWithSsrFGuardMock.mockRejectedValueOnce(new Error("connection refused"));
    await expect(
      discoverOpenAICompatibleLocalModels({
        baseUrl: "http://127.0.0.1:8080/v1",
        label: "llama-server",
        healthPath: "/health",
        rawResult: true,
      }),
    ).resolves.toMatchObject({ kind: "unreachable" });

    fetchWithSsrFGuardMock.mockResolvedValueOnce(guarded(new Response(null, { status: 401 })));
    await expect(
      discoverOpenAICompatibleLocalModels({
        baseUrl: "http://127.0.0.1:8080/v1",
        label: "llama-server",
        healthPath: "/health",
        rawResult: true,
      }),
    ).resolves.toEqual({ kind: "http-error", path: "/health", status: 401 });

    fetchWithSsrFGuardMock
      .mockResolvedValueOnce(guarded(new Response(null, { status: 200 })))
      .mockResolvedValueOnce(guarded(new Response("{", { status: 200 })));
    await expect(
      discoverOpenAICompatibleLocalModels({
        baseUrl: "http://127.0.0.1:8080/v1",
        label: "llama-server",
        healthPath: "/health",
        modelsPathOrder: "server-first",
        rawResult: true,
      }),
    ).resolves.toMatchObject({ kind: "invalid-response", path: "/models" });
  });

  it("probes only available router models without autoloading", async () => {
    fetchWithSsrFGuardMock
      .mockResolvedValueOnce(guarded(new Response(null, { status: 200 })))
      .mockResolvedValueOnce(
        guarded(
          new Response(
            JSON.stringify({
              data: [
                { id: "loaded/model", status: { value: "loaded" } },
                { id: "unloaded/model", status: { value: "unloaded" } },
              ],
            }),
          ),
        ),
      )
      .mockResolvedValueOnce(guarded(new Response(JSON.stringify({ n_ctx: 16_384 }))));

    const result = await discoverOpenAICompatibleLocalModels({
      baseUrl: "http://127.0.0.1:8080/v1",
      label: "llama-server",
      healthPath: "/health",
      modelsPathOrder: "server-first",
      routerModelProps: true,
      rawResult: true,
    });

    expect(result).toMatchObject({
      kind: "success",
      rows: [
        { model: { id: "loaded/model" }, props: { n_ctx: 16_384 } },
        { model: { id: "unloaded/model" } },
      ],
    });
    expect(fetchWithSsrFGuardMock.mock.calls.map(([call]) => call.url)).toEqual([
      "http://127.0.0.1:8080/health",
      "http://127.0.0.1:8080/models",
      "http://127.0.0.1:8080/props?model=loaded%2Fmodel&autoload=false",
    ]);
  });

  it("stops scheduling router property probes after the shared deadline", async () => {
    const models = Array.from({ length: 17 }, (_, index) => ({
      id: `model-${index}`,
      status: { value: "loaded" },
    }));
    fetchWithSsrFGuardMock.mockImplementation(async ({ url }: { url: string }) => {
      if (url.endsWith("/health")) {
        return guarded(new Response(null, { status: 200 }));
      }
      if (url.endsWith("/models")) {
        return guarded(new Response(JSON.stringify({ data: models })));
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 20);
      });
      return guarded(new Response(JSON.stringify({ n_ctx: 8192 })));
    });

    const result = await discoverOpenAICompatibleLocalModels({
      baseUrl: "http://127.0.0.1:8080/v1",
      label: "llama-server",
      healthPath: "/health",
      modelsPathOrder: "server-first",
      routerModelProps: true,
      timeoutMs: 10,
      rawResult: true,
    });

    expect(result.kind === "success" ? result.rows : []).toHaveLength(17);
    expect(
      fetchWithSsrFGuardMock.mock.calls.filter(([call]) => call.url.includes("/props?")).length,
    ).toBe(8);
  });

  it("bounds concurrent property probes and keeps results associated by model", async () => {
    const models = Array.from({ length: 10 }, (_, index) => ({
      id: `model-${index}`,
      status: { value: "loaded" },
    }));
    let active = 0;
    let maxActive = 0;
    fetchWithSsrFGuardMock.mockImplementation(async ({ url }: { url: string }) => {
      if (url.endsWith("/health")) {
        return guarded(new Response(null, { status: 200 }));
      }
      if (url.endsWith("/models")) {
        return guarded(new Response(JSON.stringify({ data: models })));
      }
      const modelId = new URL(url).searchParams.get("model");
      const index = Number(modelId?.replace("model-", ""));
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 10 - index);
      });
      active -= 1;
      return guarded(new Response(JSON.stringify({ n_ctx: 8_000 + index })));
    });

    const result = await discoverOpenAICompatibleLocalModels({
      baseUrl: "http://127.0.0.1:8080/v1",
      label: "llama-server",
      healthPath: "/health",
      modelsPathOrder: "server-first",
      routerModelProps: true,
      rawResult: true,
    });

    expect(maxActive).toBe(8);
    expect(result.kind === "success" ? result.rows.map((row) => row.props?.n_ctx) : []).toEqual(
      models.map((_, index) => 8_000 + index),
    );
  });

  it("caps property probes at 200 models", async () => {
    const models = Array.from({ length: 201 }, (_, index) => ({
      id: `model-${index}`,
      status: { value: "loaded" },
    }));
    fetchWithSsrFGuardMock.mockImplementation(async ({ url }: { url: string }) => {
      if (url.endsWith("/health")) {
        return guarded(new Response(null, { status: 200 }));
      }
      if (url.endsWith("/models")) {
        return guarded(new Response(JSON.stringify({ data: models })));
      }
      return guarded(new Response(JSON.stringify({ n_ctx: 8192 })));
    });

    const result = await discoverOpenAICompatibleLocalModels({
      baseUrl: "http://127.0.0.1:8080/v1",
      label: "llama-server",
      healthPath: "/health",
      modelsPathOrder: "server-first",
      routerModelProps: true,
      rawResult: true,
    });

    expect(result.kind === "success" ? result.rows : []).toHaveLength(201);
    expect(
      fetchWithSsrFGuardMock.mock.calls.filter(([call]) => call.url.includes("/props?")).length,
    ).toBe(200);
  });

  it("keeps explicit Authorization ahead of ambient API-key discovery", async () => {
    fetchWithSsrFGuardMock
      .mockResolvedValueOnce(guarded(new Response(null, { status: 200 })))
      .mockResolvedValueOnce(guarded(new Response(JSON.stringify({ data: [] }))));

    await discoverOpenAICompatibleLocalModels({
      baseUrl: "http://127.0.0.1:8080/v1",
      apiKey: "ambient-key",
      headers: { Authorization: "Bearer explicit-key" },
      label: "llama-server",
      healthPath: "/health",
      modelsPathOrder: "server-first",
      rawResult: true,
    });

    for (const [call] of fetchWithSsrFGuardMock.mock.calls) {
      expect(call.init.headers).toMatchObject({
        Accept: "application/json",
        Authorization: "Bearer explicit-key",
      });
    }
  });
});
