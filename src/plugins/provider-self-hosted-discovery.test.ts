import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
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
    const started = createDeferred();
    const release = createDeferred();
    const now = vi.spyOn(Date, "now").mockReturnValue(0);
    let active = 0;
    fetchWithSsrFGuardMock.mockImplementation(async ({ url }: { url: string }) => {
      if (url.endsWith("/health")) {
        return guarded(new Response(null, { status: 200 }));
      }
      if (url.endsWith("/models")) {
        return guarded(new Response(JSON.stringify({ data: models })));
      }
      active += 1;
      if (active === 8) {
        started.resolve();
      }
      await release.promise;
      return guarded(new Response(JSON.stringify({ n_ctx: 8192 })));
    });

    const resultPromise = discoverOpenAICompatibleLocalModels({
      baseUrl: "http://127.0.0.1:8080/v1",
      label: "llama-server",
      healthPath: "/health",
      modelsPathOrder: "server-first",
      routerModelProps: true,
      timeoutMs: 10,
      rawResult: true,
    });

    try {
      await withTestTimeout(started.promise, 1_000, "initial eight property probes did not start");
      // Expire the budget only after the first wave starts, independent of runner load.
      now.mockReturnValue(20);
      release.resolve();
      const result = await withTestTimeout(resultPromise, 1_000, "discovery did not finish");

      expect(result.kind === "success" ? result.rows : []).toHaveLength(17);
      expect(
        fetchWithSsrFGuardMock.mock.calls.filter(([call]) => call.url.includes("/props?")).length,
      ).toBe(8);
    } finally {
      release.resolve();
      now.mockRestore();
      await withTestTimeout(resultPromise, 1_000, "property probes did not settle during cleanup");
    }
  });

  it("bounds concurrent property probes and keeps results associated by model", async () => {
    const models = Array.from({ length: 10 }, (_, index) => ({
      id: `model-${index}`,
      status: { value: "loaded" },
    }));
    const started = models.map(() => createDeferred());
    const releases = models.map(() => createDeferred());
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
      started[index]!.resolve();
      await releases[index]!.promise;
      active -= 1;
      return guarded(new Response(JSON.stringify({ n_ctx: 8_000 + index })));
    });

    const resultPromise = discoverOpenAICompatibleLocalModels({
      baseUrl: "http://127.0.0.1:8080/v1",
      label: "llama-server",
      healthPath: "/health",
      modelsPathOrder: "server-first",
      routerModelProps: true,
      rawResult: true,
    });

    try {
      await withTestTimeout(
        started[7]!.promise,
        1_000,
        "initial eight property probes did not start",
      );
      // Finish later models first so completion order cannot stand in for model identity.
      releases[7]!.resolve();
      await withTestTimeout(
        started[8]!.promise,
        1_000,
        "model-8 probe did not start after model-7",
      );
      releases[6]!.resolve();
      await withTestTimeout(
        started[9]!.promise,
        1_000,
        "model-9 probe did not start after model-6",
      );
      for (const release of releases.toReversed()) {
        release.resolve();
      }
      const result = await withTestTimeout(resultPromise, 1_000, "discovery did not finish");

      expect(maxActive).toBe(8);
      expect(result.kind === "success" ? result.rows.map((row) => row.props?.n_ctx) : []).toEqual(
        models.map((_, index) => 8_000 + index),
      );
    } finally {
      for (const release of releases) {
        release.resolve();
      }
      await withTestTimeout(resultPromise, 1_000, "property probes did not settle during cleanup");
    }
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
