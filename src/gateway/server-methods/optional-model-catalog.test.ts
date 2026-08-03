import { describe, expect, it, vi } from "vitest";
import {
  loadOptionalServerMethodModelCatalog,
  readPreparedServerMethodModelCatalog,
} from "./optional-model-catalog.js";
import type { GatewayRequestContext } from "./types.js";

const getPreparedModelCatalogSnapshot = vi.hoisted(() => vi.fn());

vi.mock("../../agents/prepared-model-catalog.js", () => ({
  getPreparedModelCatalogSnapshot,
}));

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

describe("readPreparedServerMethodModelCatalog", () => {
  it("reads published startup facts without starting catalog discovery", async () => {
    const entries = [{ id: "work-only", name: "Work Model", provider: "work-provider" }];
    getPreparedModelCatalogSnapshot.mockReturnValue({ entries, routeVariants: [] });
    const loadGatewayModelCatalog = vi.fn();
    const config = { agents: { list: [{ id: "work", default: true }] } };
    const context = {
      getRuntimeConfig: () => config,
      loadGatewayModelCatalog,
    } as unknown as GatewayRequestContext;

    await expect(readPreparedServerMethodModelCatalog(context, { agentId: "work" })).resolves.toBe(
      entries,
    );

    expect(getPreparedModelCatalogSnapshot).toHaveBeenCalledWith({
      agentId: "work",
      config,
      readOnly: true,
    });
    expect(loadGatewayModelCatalog).not.toHaveBeenCalled();
  });
});
