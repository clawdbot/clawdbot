import { describe, expect, it, vi } from "vitest";
import type { ModelCatalogSnapshot } from "../agents/model-catalog.types.js";
import {
  loadGatewayModelCatalog,
  loadGatewayModelCatalogSnapshot,
} from "./server-model-catalog.js";

const snapshot: ModelCatalogSnapshot = {
  entries: [{ provider: "openai", id: "gpt-5.5", name: "GPT-5.5" }],
  routeVariants: [],
};

describe("gateway prepared model catalog", () => {
  it("reads the published read-only generation directly", async () => {
    const config = {};
    const loadPreparedModelCatalogSnapshot = vi.fn(async () => snapshot);

    await expect(
      loadGatewayModelCatalog({
        getConfig: () => config,
        loadPreparedModelCatalogSnapshot,
      }),
    ).resolves.toBe(snapshot.entries);
    expect(loadPreparedModelCatalogSnapshot).toHaveBeenCalledWith({
      config,
      readOnly: true,
    });
  });

  it("forwards the requested agent lifecycle owner", async () => {
    const config = {};
    const loadPreparedModelCatalogSnapshot = vi.fn(async () => snapshot);

    await loadGatewayModelCatalogSnapshot({
      agentDir: "/tmp/gateway-agent",
      getConfig: () => config,
      loadPreparedModelCatalogSnapshot,
      workspaceDir: "/tmp/gateway-workspace",
    });

    expect(loadPreparedModelCatalogSnapshot).toHaveBeenCalledWith({
      agentDir: "/tmp/gateway-agent",
      config,
      readOnly: true,
      workspaceDir: "/tmp/gateway-workspace",
    });
  });

  it("selects the full prepared owner when requested", async () => {
    const config = {};
    const loadPreparedModelCatalogSnapshot = vi.fn(async () => snapshot);

    await expect(
      loadGatewayModelCatalogSnapshot({
        getConfig: () => config,
        loadPreparedModelCatalogSnapshot,
        readOnly: false,
      }),
    ).resolves.toBe(snapshot);
    expect(loadPreparedModelCatalogSnapshot).toHaveBeenCalledWith({
      config,
      readOnly: false,
    });
  });

  it("does not hide lifecycle publication failures behind stale data", async () => {
    const error = new Error("generation failed");
    const loadPreparedModelCatalogSnapshot = vi.fn(async () => {
      throw error;
    });

    await expect(
      loadGatewayModelCatalogSnapshot({ loadPreparedModelCatalogSnapshot }),
    ).rejects.toBe(error);
  });
});
