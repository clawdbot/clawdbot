import { describe, expect, it, vi } from "vitest";
import { GatewayPendingRequests } from "../../../../packages/gateway-client/src/pending-request.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { loadModelProviderCost, loadModelProvidersData, loadModelProviderUsage } from "./load.ts";

describe("loadModelProvidersData", () => {
  it("keeps full catalog discovery out of the initial page load", async () => {
    const request = vi.fn(async (method: string, _params?: unknown) => {
      switch (method) {
        case "models.authStatus":
          return { ts: 1, providers: [], providerCapabilities: [] };
        case "models.list":
          return { models: [] };
        case "config.get":
          return { config: {}, hash: "hash" };
        case "usage.status":
          return { updatedAt: 1, providers: [] };
        case "sessions.usage":
          return { aggregates: { byProvider: [] } };
        default:
          return {};
      }
    });
    const client = { request } as unknown as GatewayBrowserClient;

    const result = await loadModelProvidersData(client, { agentId: "writer" });

    expect(request).toHaveBeenCalledWith("models.list", {
      view: "configured",
      agentId: "writer",
      preparedOnly: true,
    });
    expect(
      request.mock.calls.filter(
        ([method, params]) =>
          method === "models.list" && (params as { view?: string } | undefined)?.view === "all",
      ),
    ).toHaveLength(0);
    expect(request.mock.calls.some(([method]) => method === "usage.status")).toBe(false);
    expect(request.mock.calls.some(([method]) => method === "sessions.usage")).toBe(false);
    expect(result.providerUsage).toBeNull();
    expect(result.costByProvider).toBeNull();
  });

  it("scopes only credential status to the selected agent", async () => {
    const request = vi.fn(async (method: string, _params?: unknown) => {
      switch (method) {
        case "models.authStatus":
          return { ts: 1, providers: [] };
        case "models.list":
          return { models: [] };
        case "config.get":
          return { config: {}, hash: "hash" };
        case "usage.status":
          return { updatedAt: 1, providers: [] };
        case "sessions.usage":
          return { aggregates: { byProvider: [] } };
        default:
          return {};
      }
    });
    const client = { request } as unknown as GatewayBrowserClient;

    const result = await loadModelProvidersData(client, { refresh: true, agentId: "writer" });

    expect(request).toHaveBeenCalledWith("models.authStatus", {
      refresh: true,
      agentId: "writer",
    });
    expect(request.mock.calls.filter(([method]) => method === "models.list")).toEqual([
      ["models.list", { view: "configured", agentId: "writer", refresh: true }],
    ]);
    expect(result.providerOutcomes).toEqual([]);
    expect(request.mock.calls.some(([method]) => method === "usage.status")).toBe(false);
    expect(request.mock.calls.some(([method]) => method === "sessions.usage")).toBe(false);
  });

  it("does not send a configured refresh for an already-retired page task", async () => {
    const request = vi.fn(async (method: string) => {
      switch (method) {
        case "models.authStatus":
          return { ts: 1, providers: [], providerCapabilities: [] };
        case "config.get":
          return { config: {}, hash: "hash" };
        case "usage.status":
          return { updatedAt: 1, providers: [] };
        case "sessions.usage":
          return { aggregates: { byProvider: [] } };
        default:
          return {};
      }
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const controller = new AbortController();
    controller.abort(new DOMException("page retired", "AbortError"));

    await loadModelProvidersData(client, {
      agentId: "writer",
      refresh: true,
      signal: controller.signal,
    });

    expect(request.mock.calls.filter(([method]) => method === "models.list")).toEqual([]);
  });

  it.each([
    { label: "the initial prepared catalog", refresh: false },
    { label: "the configured catalog after discovery", refresh: true },
  ])("surfaces a failure loading $label without discarding provider data", async ({ refresh }) => {
    const request = vi.fn(async (method: string, _params?: unknown) => {
      switch (method) {
        case "models.authStatus":
          return {
            ts: 1,
            providers: [{ provider: "openai", displayName: "OpenAI", status: "ok", profiles: [] }],
          };
        case "models.list":
          throw new Error("configured catalog unavailable: OPENAI_API_KEY=sk-1234567890abcdef");
        case "config.get":
          return {
            config: { agents: { defaults: { model: "openai/gpt-5.5" } } },
            hash: "hash",
          };
        case "usage.status":
          return { updatedAt: 1, providers: [] };
        case "sessions.usage":
          return { aggregates: { byProvider: [] } };
        default:
          return {};
      }
    });
    const client = { request } as unknown as GatewayBrowserClient;

    const result = await loadModelProvidersData(client, { agentId: "main", refresh });

    expect(result.models).toBeNull();
    expect(result.catalogError).toBe(
      "configured catalog unavailable: OPENAI_API_KEY=sk-123...cdef",
    );
    expect(result.authStatus?.providers).toHaveLength(1);
    expect(result.config).toEqual({ agents: { defaults: { model: "openai/gpt-5.5" } } });
    expect(result.error).toBeNull();
  });

  it("surfaces unavailable auth preparation without discarding configured models", async () => {
    const unavailable = {
      code: "PREPARED_MODEL_AUTH_UNAVAILABLE",
      message: "Model authentication status is unavailable. Refresh Models after setup finishes.",
    };
    const request = vi.fn(async (method: string) => {
      switch (method) {
        case "models.authStatus":
          return { ts: 1, providers: [], unavailable };
        case "models.list":
          return { models: [{ id: "configured", name: "Configured", provider: "test-provider" }] };
        case "config.get":
          return { config: {}, hash: "hash" };
        default:
          throw new Error(`Unexpected request: ${method}`);
      }
    });

    const result = await loadModelProvidersData({ request } as unknown as GatewayBrowserClient, {
      agentId: "main",
    });

    expect(result.error).toBe(unavailable.message);
    expect(result.authStatus).toMatchObject({ unavailable });
    expect(result.models).toEqual([
      { id: "configured", name: "Configured", provider: "test-provider" },
    ]);
  });

  it("degrades an invalid auth-status response without discarding other provider data", async () => {
    const request = vi.fn(async (method: string) => {
      switch (method) {
        case "models.authStatus":
          return {};
        case "models.list":
          return { models: [] };
        case "config.get":
          return { config: {}, hash: "hash" };
        case "usage.status":
          return { updatedAt: 1, providers: [] };
        case "sessions.usage":
          return { aggregates: { byProvider: [] } };
        default:
          return {};
      }
    });
    const client = { request } as unknown as GatewayBrowserClient;

    const result = await loadModelProvidersData(client, { agentId: "main" });

    expect(result.authStatus).toBeNull();
    expect(result.models).toEqual([]);
    expect(result.providerOutcomes).toEqual([]);
    expect(result.catalogError).toBeNull();
    expect(result.config).toEqual({});
    expect(result.providerUsage).toBeNull();
    expect(result.costByProvider).toBeNull();
    expect(result.error).toBeNull();
  });

  it("records a usage.status failure instead of reducing it to no data", async () => {
    const request = vi.fn(async (method: string) => {
      switch (method) {
        case "models.authStatus":
          return { ts: 1, providers: [] };
        case "models.list":
          return { models: [] };
        case "config.get":
          return { config: {}, hash: "hash" };
        case "usage.status":
          throw new Error("usage.status failed");
        case "sessions.usage":
          return { aggregates: { byProvider: [] } };
        default:
          return {};
      }
    });
    const client = { request } as unknown as GatewayBrowserClient;

    const result = await loadModelProviderUsage(client, new AbortController().signal);

    expect(result).toEqual({
      ok: false,
      error: { kind: "request-failed" },
    });
  });

  it("keeps provider-scoped usage errors as data instead of a global request failure", async () => {
    const request = vi.fn(async (method: string) => {
      switch (method) {
        case "models.authStatus":
          return { ts: 1, providers: [] };
        case "models.list":
          return { models: [] };
        case "config.get":
          return { config: {}, hash: "hash" };
        case "usage.status":
          return {
            updatedAt: 1,
            providers: [
              {
                provider: "openai",
                displayName: "OpenAI",
                windows: [],
                error: "provider API unavailable",
              },
            ],
          };
        case "sessions.usage":
          return { aggregates: { byProvider: [] } };
        default:
          return {};
      }
    });
    const client = { request } as unknown as GatewayBrowserClient;

    const result = await loadModelProviderUsage(client, new AbortController().signal);

    expect(result).toMatchObject({
      ok: true,
      value: { providers: [{ error: "provider API unavailable" }] },
    });
  });

  it.each(["before dispatch", "while pending"] as const)(
    "retires both supplemental requests when aborted %s",
    async (when) => {
      const pending = new GatewayPendingRequests({
        createRequestId: () => "models-test",
        nowMs: () => 0,
      });
      const sent: Array<{ method: string; params?: Record<string, unknown> }> = [];
      const sender = {
        send(frame: string) {
          sent.push(JSON.parse(frame));
        },
      };
      const client = {
        request: <T>(...args: Parameters<GatewayBrowserClient["request"]>) =>
          pending.request<T>(sender, ...args),
      } as GatewayBrowserClient;
      const controller = new AbortController();
      if (when === "before dispatch") {
        controller.abort();
      }
      const loading = Promise.allSettled([
        loadModelProviderUsage(client, controller.signal),
        loadModelProviderCost(client, controller.signal),
      ]);
      try {
        if (when === "while pending") {
          expect(sent.map(({ method }) => method)).toEqual(["usage.status", "sessions.usage"]);
          expect(sent[0]?.params).toBeUndefined();
          expect(sent[1]?.params).toMatchObject({ agentScope: "all", groupBy: "family" });
          expect(sent[1]?.params).not.toHaveProperty("agentId");
          expect(pending.hasPending).toBe(true);
          controller.abort();
        } else {
          expect(sent).toEqual([]);
        }
        expect(pending.hasPending).toBe(false);
        expect(await loading).toMatchObject([{ status: "rejected" }, { status: "rejected" }]);
      } finally {
        // Release any leaked wait if a cancellation regression makes the assertion fail.
        pending.flush(new Error("test cleanup"));
        await loading;
      }
    },
  );

  it("surfaces an explicit catalog refresh failure while retaining cached configured models", async () => {
    const request = vi.fn(async (method: string, params?: unknown) => {
      switch (method) {
        case "models.authStatus":
          return { ts: 1, providers: [], providerCapabilities: [] };
        case "models.list":
          if ((params as { refresh?: boolean } | undefined)?.refresh === true) {
            throw new Error("catalog refresh failed: OPENAI_API_KEY=sk-1234567890abcdef");
          }
          if ((params as { preparedOnly?: boolean } | undefined)?.preparedOnly === true) {
            return {
              models: [{ id: "cached", name: "Cached", provider: "openai" }],
            };
          }
          throw new Error("full catalog projection ran after refresh failure");
        case "config.get":
          return { config: {}, hash: "hash" };
        case "usage.status":
          return { updatedAt: 1, providers: [] };
        case "sessions.usage":
          return { aggregates: { byProvider: [] } };
        default:
          return {};
      }
    });
    const client = { request } as unknown as GatewayBrowserClient;
    await loadModelProvidersData(client, { agentId: "writer" });
    request.mockClear();

    const result = await loadModelProvidersData(client, { refresh: true, agentId: "writer" });

    expect(result.catalogError).toBe("catalog refresh failed: OPENAI_API_KEY=sk-123...cdef");
    expect(result.models).toEqual([{ id: "cached", name: "Cached", provider: "openai" }]);
    expect(request.mock.calls.filter(([method]) => method === "models.list")).toEqual([
      ["models.list", { view: "configured", agentId: "writer", refresh: true }],
    ]);
  });
});
