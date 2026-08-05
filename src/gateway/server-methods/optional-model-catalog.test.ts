import { describe, expect, it, vi } from "vitest";
import {
  loadOptionalServerMethodModelCatalogSnapshot,
  readPreparedServerMethodModelCatalog,
} from "./optional-model-catalog.js";
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

describe("loadOptionalServerMethodModelCatalogSnapshot", () => {
  it("does not start provider discovery when no prepared catalog is published", async () => {
    const loadGatewayModelCatalogSnapshot = vi.fn(async () => ({
      agentId: "main",
      agentDir: "/tmp/main-agent",
      config: {},
      entries: [],
      routeVariants: [],
    }));
    const context = {
      loadGatewayModelCatalogSnapshot,
      readPreparedGatewayModelCatalog: vi.fn(async () => undefined),
      logGateway: { debug: vi.fn() },
    } as unknown as GatewayRequestContext;

    await expect(
      loadOptionalServerMethodModelCatalogSnapshot(context, "chat.startup", {
        loadParams: { agentId: "main" },
        timeoutMs: 25,
      }),
    ).resolves.toBeUndefined();

    expect(loadGatewayModelCatalogSnapshot).not.toHaveBeenCalled();
  });
});
