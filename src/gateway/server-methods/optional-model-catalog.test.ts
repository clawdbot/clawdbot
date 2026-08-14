import { describe, expect, it, vi } from "vitest";
import { registerGatewayModelCatalogPrivateAccess } from "../server-model-catalog-auth.js";
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
  it("uses a prepared snapshot before cold discovery", async () => {
    const snapshot = {
      agentId: "work",
      agentDir: "/tmp/work-agent",
      catalogComplete: true,
      workspaceDir: "/tmp/work",
      config: {},
      entries: [],
      routeVariants: [],
      authModes: {},
      authStore: { version: 1, profiles: {} },
      authMaterializations: [],
      metadataSnapshot: { index: { plugins: [] }, plugins: [] } as never,
    };
    const loadGatewayModelCatalogSnapshot = vi.fn();
    const context = {
      loadGatewayModelCatalogSnapshot,
      logGateway: { debug: vi.fn() },
    } as unknown as GatewayRequestContext;
    const readPrepared = vi.fn(async () => snapshot);
    registerGatewayModelCatalogPrivateAccess(loadGatewayModelCatalogSnapshot, {
      loadDeferred: vi.fn(),
      readPrepared,
    });

    await expect(
      loadOptionalServerMethodModelCatalogSnapshot(context, "chat.startup", {
        loadParams: { agentId: "work" },
      }),
    ).resolves.toBe(snapshot);
    expect(loadGatewayModelCatalogSnapshot).not.toHaveBeenCalled();
  });
});
