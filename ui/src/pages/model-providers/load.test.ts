import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { loadModelProvidersData } from "./load.ts";

describe("loadModelProvidersData", () => {
  it("keeps selected-agent provider models separate from global default models", async () => {
    const globalModels = [{ id: "main-default", name: "Main Default", provider: "openai" }];
    const workerModels = [{ id: "worker-private", name: "Worker Private", provider: "anthropic" }];
    const request = vi.fn(async (method: string, _params?: unknown) => {
      switch (method) {
        case "models.authStatus":
          return { ts: 1, providers: [] };
        case "chat.metadata":
          return { models: workerModels };
        case "models.list":
          return { models: globalModels };
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
    expect(request).toHaveBeenCalledWith("chat.metadata", { agentId: "writer" });
    expect(result.models).toEqual(globalModels);
    expect(result.agentModels).toEqual(workerModels);
    expect(request).toHaveBeenCalledWith("usage.status");
    const sessionUsageCall = request.mock.calls.find(([method]) => method === "sessions.usage");
    expect(sessionUsageCall?.[1]).not.toHaveProperty("agentId");
    expect(sessionUsageCall?.[1]).toHaveProperty("agentScope", "all");
  });

  it("never substitutes another agent's catalog when selected-agent metadata fails", async () => {
    const globalModels = [{ id: "main-default", name: "Main Default", provider: "openai" }];
    const request = vi.fn(async (method: string) => {
      switch (method) {
        case "chat.metadata":
          throw new Error("worker metadata unavailable");
        case "models.authStatus":
          return { ts: 1, providers: [] };
        case "models.list":
          return { models: globalModels };
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

    const result = await loadModelProvidersData({ request } as unknown as GatewayBrowserClient, {
      agentId: "writer",
    });

    expect(result.models).toEqual(globalModels);
    expect(result.agentModels).toBeNull();
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

    const result = await loadModelProvidersData(client);

    expect(result.authStatus).toBeNull();
    expect(result.models).toEqual([]);
    expect(result.agentModels).toEqual([]);
    expect(result.catalogModels).toEqual([]);
    expect(result.config).toEqual({});
    expect(result.providerUsage).toEqual({ updatedAt: 1, providers: [] });
    expect(result.costByProvider).toEqual([]);
    expect(result.error).toBeNull();
  });
});
