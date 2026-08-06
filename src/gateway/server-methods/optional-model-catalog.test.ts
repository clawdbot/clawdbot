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
      readPreparedGatewayModelCatalogSnapshot: vi.fn(async () => undefined),
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
