import { describe, expect, it, vi } from "vitest";
import type { ModelCatalogSnapshot } from "../agents/model-catalog.types.js";
import { PreparedModelCatalogConfigReplacedError } from "../agents/prepared-model-catalog.errors.js";
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

  it("follows a committed config that replaces the catalog owner during a read", async () => {
    const initialConfig = { agents: { defaults: { model: "openai/gpt-5.5" } } };
    const replacementConfig = { agents: { defaults: { model: "openai/gpt-5.6" } } };
    const getConfig = vi.fn().mockReturnValueOnce(initialConfig).mockReturnValue(replacementConfig);
    const loadPreparedModelCatalogSnapshot = vi
      .fn()
      .mockRejectedValueOnce(new PreparedModelCatalogConfigReplacedError("/tmp/gateway-agent"))
      .mockResolvedValueOnce(snapshot);

    await expect(
      loadGatewayModelCatalogSnapshot({
        getConfig,
        loadPreparedModelCatalogSnapshot,
      }),
    ).resolves.toBe(snapshot);
    expect(loadPreparedModelCatalogSnapshot).toHaveBeenNthCalledWith(1, {
      config: initialConfig,
      readOnly: true,
    });
    expect(loadPreparedModelCatalogSnapshot).toHaveBeenNthCalledWith(2, {
      config: replacementConfig,
      readOnly: true,
    });
    expect(getConfig).toHaveBeenCalledTimes(2);
  });

  it("does not loop when the runtime config has not advanced", async () => {
    const config = { agents: { defaults: { model: "openai/gpt-5.5" } } };
    const error = new PreparedModelCatalogConfigReplacedError("/tmp/gateway-agent");
    const loadPreparedModelCatalogSnapshot = vi.fn().mockRejectedValue(error);

    await expect(
      loadGatewayModelCatalogSnapshot({
        getConfig: () => config,
        loadPreparedModelCatalogSnapshot,
      }),
    ).rejects.toBe(error);
    expect(loadPreparedModelCatalogSnapshot).toHaveBeenCalledOnce();
  });
});
