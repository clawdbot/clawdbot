import { describe, expect, it, vi } from "vitest";
import { loadOptionalServerMethodModelCatalog } from "./optional-model-catalog.js";
import type { GatewayRequestContext } from "./types.js";

describe("loadOptionalServerMethodModelCatalog", () => {
  it("forwards the requested agent to the catalog owner", async () => {
    const entries = [{ id: "work-only", name: "Work Model", provider: "work-provider" }];
    const loadGatewayModelCatalog = vi.fn(async () => entries);
    const context = {
      loadGatewayModelCatalog,
      logGateway: { debug: vi.fn() },
    } as unknown as GatewayRequestContext;

    await expect(
      loadOptionalServerMethodModelCatalog(context, "sessions.list", {
        loadParams: { agentId: "work" },
      }),
    ).resolves.toEqual(entries);

    expect(loadGatewayModelCatalog).toHaveBeenCalledWith({ agentId: "work" });
  });
});
