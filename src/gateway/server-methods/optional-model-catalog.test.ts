import { describe, expect, it, vi } from "vitest";
import { readPreparedServerMethodModelCatalog } from "./optional-model-catalog.js";
import type { GatewayRequestContext } from "./types.js";

describe("readPreparedServerMethodModelCatalog", () => {
  it("reads published startup facts without starting catalog discovery", async () => {
    const entries = [{ id: "work-only", name: "Work Model", provider: "work-provider" }];
    const loadGatewayModelCatalog = vi.fn();
    const readPreparedGatewayModelCatalog = vi.fn(async () => entries);
    const context = {
      loadGatewayModelCatalog,
      readPreparedGatewayModelCatalog,
    } as unknown as GatewayRequestContext;

    await expect(readPreparedServerMethodModelCatalog(context, { agentId: "work" })).resolves.toBe(
      entries,
    );

    expect(readPreparedGatewayModelCatalog).toHaveBeenCalledWith({ agentId: "work" });
    expect(loadGatewayModelCatalog).not.toHaveBeenCalled();
  });
});
