import { describe, expect, it, vi } from "vitest";
import type { ModelCatalogSnapshot } from "../agents/model-catalog.types.js";
import type { PublishedModelCatalogOwnerCandidate } from "../agents/prepared-model-catalog.types.js";
import { setPreparedModelRuntimeAuthStoreLoader } from "../agents/prepared-model-runtime-auth.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveDeferredAuthStore } from "./server-model-catalog-auth.js";
import {
  loadGatewayModelCatalog,
  loadGatewayModelCatalogSnapshot,
  type GatewayModelCatalogSnapshot,
} from "./server-model-catalog.js";

const snapshot: ModelCatalogSnapshot = {
  entries: [{ provider: "openai", id: "gpt-5.5", name: "GPT-5.5" }],
  routeVariants: [],
};

function ownerConfig(agentId = "main", extra: OpenClawConfig = {}): OpenClawConfig {
  return {
    ...extra,
    agents: {
      ...extra.agents,
      list: [
        {
          id: agentId,
          default: true,
          agentDir: "/tmp/gateway-agent",
          workspace: "/tmp/gateway-workspace",
        },
      ],
    },
  };
}

function ownerSnapshot(
  config: OpenClawConfig,
  modelCatalog: ModelCatalogSnapshot = snapshot,
  agentId?: string,
): PublishedModelCatalogOwnerCandidate {
  return {
    ...(agentId ? { agentId } : {}),
    agentDir: "/tmp/gateway-agent",
    config,
    authModes: {},
    authStore: { version: 1, profiles: {} },
    metadataSnapshot: { index: { plugins: [] }, plugins: [] } as never,
    modelCatalog,
  };
}

describe("gateway prepared model catalog", () => {
  it("reads the published read-only generation directly", async () => {
    const config = ownerConfig();
    const loadPublishedPreparedModelCatalogOwnerSnapshot = vi.fn(async () => ownerSnapshot(config));

    await expect(
      loadGatewayModelCatalog({
        getConfig: () => config,
        loadPublishedPreparedModelCatalogOwnerSnapshot,
      }),
    ).resolves.toBe(snapshot.entries);
    expect(loadPublishedPreparedModelCatalogOwnerSnapshot).toHaveBeenCalledWith({
      config,
      readOnly: true,
    });
  });

  it("forwards the requested agent lifecycle owner", async () => {
    const config = ownerConfig("worker");
    const loadPublishedPreparedModelCatalogOwnerSnapshot = vi.fn(async () => ({
      ...ownerSnapshot(config, snapshot, "worker"),
      workspaceDir: "/tmp/gateway-workspace",
    }));

    await expect(
      loadGatewayModelCatalogSnapshot({
        agentId: "worker",
        agentDir: "/tmp/gateway-agent",
        getConfig: () => config,
        loadPublishedPreparedModelCatalogOwnerSnapshot,
        workspaceDir: "/tmp/gateway-workspace",
      }),
    ).resolves.toMatchObject({
      agentId: "worker",
      agentDir: "/tmp/gateway-agent",
      config,
      workspaceDir: "/tmp/gateway-workspace",
    } satisfies Partial<GatewayModelCatalogSnapshot>);

    expect(loadPublishedPreparedModelCatalogOwnerSnapshot).toHaveBeenCalledWith({
      agentId: "worker",
      agentDir: "/tmp/gateway-agent",
      config,
      readOnly: true,
      workspaceDir: "/tmp/gateway-workspace",
    });
  });

  it("refreshes auth only for the explicit deferred projection", async () => {
    const config = ownerConfig();
    const candidate = ownerSnapshot(config);
    const loadAuthStore = vi.fn(async () => ({
      version: 1 as const,
      profiles: {
        "openai:refreshed": { type: "api_key" as const, provider: "openai", key: "refreshed" },
      },
    }));
    setPreparedModelRuntimeAuthStoreLoader(candidate, loadAuthStore);
    const loadPublishedPreparedModelCatalogOwnerSnapshot = vi.fn(async () => candidate);

    const prepared = await loadGatewayModelCatalogSnapshot({
      getConfig: () => config,
      loadPublishedPreparedModelCatalogOwnerSnapshot,
    });
    expect(prepared.authStore).toEqual(candidate.authStore);
    expect(loadAuthStore).not.toHaveBeenCalled();

    const deferred = await loadGatewayModelCatalogSnapshot({
      deferAuthRefresh: true,
      getConfig: () => config,
      loadPublishedPreparedModelCatalogOwnerSnapshot,
    });
    await expect(resolveDeferredAuthStore(deferred)).resolves.toEqual(
      expect.objectContaining({ profiles: { "openai:refreshed": expect.any(Object) } }),
    );
    expect(loadAuthStore).toHaveBeenCalledWith(["openai"]);
  });

  it("rejects an ambiguous owner without an authoritative agent identity", async () => {
    const config = {
      agents: {
        list: [
          {
            id: "main",
            default: true,
            agentDir: "/tmp/gateway-agent",
            workspace: "/tmp/main-workspace",
          },
          {
            id: "worker",
            agentDir: "/tmp/gateway-agent",
            workspace: "/tmp/worker-workspace",
          },
        ],
      },
    } as OpenClawConfig;
    const loadPublishedPreparedModelCatalogOwnerSnapshot = vi.fn(async () => ownerSnapshot(config));

    await expect(
      loadGatewayModelCatalogSnapshot({
        agentId: "worker",
        getConfig: () => config,
        loadPublishedPreparedModelCatalogOwnerSnapshot,
      }),
    ).rejects.toThrow("did not identify one configured agent");
  });

  it("returns an equivalent replacement owner without repeating discovery", async () => {
    const initialConfig = ownerConfig("main", { logging: { level: "info" as const } });
    const latestConfig = ownerConfig("main", { logging: { level: "info" as const } });
    const latestSnapshot: ModelCatalogSnapshot = {
      entries: [{ provider: "openai", id: "latest", name: "Latest" }],
      routeVariants: [],
    };
    const loadPublishedPreparedModelCatalogOwnerSnapshot = vi.fn(async () =>
      ownerSnapshot(latestConfig, latestSnapshot),
    );

    await expect(
      loadGatewayModelCatalogSnapshot({
        getConfig: () => initialConfig,
        loadPublishedPreparedModelCatalogOwnerSnapshot,
      }),
    ).resolves.toMatchObject({ config: latestConfig, entries: latestSnapshot.entries });
    expect(loadPublishedPreparedModelCatalogOwnerSnapshot).toHaveBeenCalledOnce();
  });

  it("selects the full prepared owner when requested", async () => {
    const config = ownerConfig();
    const loadPublishedPreparedModelCatalogOwnerSnapshot = vi.fn(async () => ownerSnapshot(config));

    await expect(
      loadGatewayModelCatalogSnapshot({
        getConfig: () => config,
        loadPublishedPreparedModelCatalogOwnerSnapshot,
        readOnly: false,
      }),
    ).resolves.toMatchObject(snapshot);
    expect(loadPublishedPreparedModelCatalogOwnerSnapshot).toHaveBeenCalledWith({
      config,
      readOnly: false,
    });
  });

  it("carries provider outcomes through the gateway owner projection", async () => {
    const config = ownerConfig();
    const modelCatalog: ModelCatalogSnapshot = {
      entries: [],
      routeVariants: [],
      providerOutcomes: [{ provider: "openai", status: "auth-rejected" }],
    };
    const loadPublishedPreparedModelCatalogOwnerSnapshot = vi.fn(async () =>
      ownerSnapshot(config, modelCatalog),
    );

    await expect(
      loadGatewayModelCatalogSnapshot({
        getConfig: () => config,
        loadPublishedPreparedModelCatalogOwnerSnapshot,
        readOnly: false,
      }),
    ).resolves.toMatchObject({ providerOutcomes: modelCatalog.providerOutcomes });
  });

  it("does not hide lifecycle publication failures behind stale data", async () => {
    const error = new Error("generation failed");
    const loadPublishedPreparedModelCatalogOwnerSnapshot = vi.fn(async () => {
      throw error;
    });

    await expect(
      loadGatewayModelCatalogSnapshot({ loadPublishedPreparedModelCatalogOwnerSnapshot }),
    ).rejects.toBe(error);
  });
});
