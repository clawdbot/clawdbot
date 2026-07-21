import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { loadModelProvidersData } from "./load.ts";

describe("loadModelProvidersData", () => {
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

    await loadModelProvidersData(client, { refresh: true, agentId: "writer" });

    expect(request).toHaveBeenCalledWith("models.authStatus", {
      refresh: true,
      agentId: "writer",
    });
    expect(request).toHaveBeenCalledWith("usage.status");
    const sessionUsageCall = request.mock.calls.find(([method]) => method === "sessions.usage");
    expect(sessionUsageCall?.[1]).not.toHaveProperty("agentId");
    expect(sessionUsageCall?.[1]).toHaveProperty("agentScope", "all");
  });
});
