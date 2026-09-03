import { describe, expect, it, vi } from "vitest";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { loadModelCatalog } from "./model-catalog-store.ts";

describe("loadModelCatalog", () => {
  it("forwards ordinary and explicit refresh reads without a UI cache", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ models: [{ id: "fast", name: "Fast", provider: "test" }] })
      .mockResolvedValueOnce({
        models: [{ id: "discovered", name: "Discovered", provider: "test" }],
      });
    const client = createTestGatewayClient(request);

    await expect(loadModelCatalog(client, { agentId: "main" })).resolves.toEqual({
      models: [{ id: "fast", name: "Fast", provider: "test" }],
    });
    await expect(loadModelCatalog(client, { agentId: "main", refresh: true })).resolves.toEqual({
      models: [{ id: "discovered", name: "Discovered", provider: "test" }],
    });
    expect(request.mock.calls).toEqual([
      ["models.list", { view: "configured", agentId: "main" }],
      ["models.list", { view: "configured", agentId: "main", refresh: true }],
    ]);
  });

  it("rejects a failed catalog read", async () => {
    const request = vi.fn().mockRejectedValue(new Error("catalog unavailable"));
    const client = createTestGatewayClient(request);

    await expect(loadModelCatalog(client, { agentId: "main" })).rejects.toThrow(
      "catalog unavailable",
    );
  });
});
