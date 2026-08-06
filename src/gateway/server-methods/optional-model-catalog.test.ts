import { describe, expect, it, vi } from "vitest";
import {
  loadOptionalServerMethodModelCatalogSnapshot,
  readPreparedServerMethodModelCatalog,
} from "./optional-model-catalog.js";
import type { GatewayRequestContext } from "./types.js";

const preparedSnapshot = {
  agentId: "work",
  agentDir: "/tmp/work-agent",
  workspaceDir: "/tmp/work",
  config: {},
  entries: [{ id: "work-only", name: "Work Model", provider: "work-provider" }],
  routeVariants: [],
};

describe("readPreparedServerMethodModelCatalog", () => {
  it("reads published startup facts without starting catalog discovery", async () => {
    const loadGatewayModelCatalog = vi.fn();
    const readPreparedGatewayModelCatalogSnapshot = vi.fn(async () => preparedSnapshot);
    const context = {
      loadGatewayModelCatalog,
      readPreparedGatewayModelCatalogSnapshot,
    } as unknown as GatewayRequestContext;

    await expect(
      readPreparedServerMethodModelCatalog(context, { agentId: "work" }),
    ).resolves.toEqual(preparedSnapshot.entries);

    expect(readPreparedGatewayModelCatalogSnapshot).toHaveBeenCalledWith({ agentId: "work" });
    expect(loadGatewayModelCatalog).not.toHaveBeenCalled();
  });

  it("reports no catalog when the context cannot read prepared startup facts", async () => {
    const context = { loadGatewayModelCatalog: vi.fn() } as unknown as GatewayRequestContext;

    await expect(readPreparedServerMethodModelCatalog(context)).resolves.toBeUndefined();
  });
});

describe("loadOptionalServerMethodModelCatalogSnapshot", () => {
  it("serves the published snapshot without starting provider discovery", async () => {
    const loadGatewayModelCatalogSnapshot = vi.fn();
    const context = {
      loadGatewayModelCatalogSnapshot,
      readPreparedGatewayModelCatalogSnapshot: vi.fn(async () => preparedSnapshot),
      logGateway: { debug: vi.fn() },
    } as unknown as GatewayRequestContext;

    await expect(
      loadOptionalServerMethodModelCatalogSnapshot(context, "chat.startup", {
        loadParams: { agentId: "work" },
        timeoutMs: 25,
      }),
    ).resolves.toEqual(preparedSnapshot);

    expect(loadGatewayModelCatalogSnapshot).not.toHaveBeenCalled();
  });

  it("falls back to the catalog load when no prepared catalog is published", async () => {
    const coldSnapshot = {
      agentId: "main",
      agentDir: "/tmp/main-agent",
      workspaceDir: "/tmp/main",
      config: {},
      entries: [{ id: "cold", name: "Cold Model", provider: "cold-provider" }],
      routeVariants: [],
    };
    const loadGatewayModelCatalogSnapshot = vi.fn(async () => coldSnapshot);
    const context = {
      loadGatewayModelCatalogSnapshot,
      readPreparedGatewayModelCatalogSnapshot: vi.fn(async () => undefined),
      logGateway: { debug: vi.fn() },
    } as unknown as GatewayRequestContext;

    // The cold load publishes the generation that capability checks read, so skipping
    // it makes image support resolve as unsupported on later requests.
    await expect(
      loadOptionalServerMethodModelCatalogSnapshot(context, "chat.startup", {
        loadParams: { agentId: "main" },
      }),
    ).resolves.toEqual(coldSnapshot);

    expect(loadGatewayModelCatalogSnapshot).toHaveBeenCalledWith({ agentId: "main" });
  });
});
