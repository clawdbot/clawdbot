import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PluginMetadataSnapshot,
  PluginMetadataSnapshotOwnerMaps,
} from "../../plugins/plugin-metadata-snapshot.types.js";

const mocks = vi.hoisted(() => ({
  loadAuthStore: vi.fn(() => ({ version: 1, profiles: {} })),
  loadMetadata: vi.fn(),
  loadOwner: vi.fn(),
  resolveImplicitProviders: vi.fn(),
}));

vi.mock("../../agents/auth-profiles/store.js", () => ({
  loadAuthProfileStoreForSecretsRuntime: mocks.loadAuthStore,
}));

vi.mock("../../agents/models-config.providers.implicit.js", () => ({
  resolveImplicitProviders: mocks.resolveImplicitProviders,
}));

vi.mock("../../agents/prepared-model-catalog.js", () => ({
  loadPreparedModelCatalogOwnerSnapshot: mocks.loadOwner,
}));

vi.mock("../../plugins/manifest-contract-eligibility.js", () => ({
  loadManifestMetadataSnapshot: mocks.loadMetadata,
}));

import {
  hasProviderRuntimeCatalogForFilter,
  hasProviderStaticCatalogForFilter,
  loadProviderCatalogModelsForList,
} from "./list.provider-catalog.js";

const emptyOwners: PluginMetadataSnapshotOwnerMaps = {
  channels: new Map(),
  channelConfigs: new Map(),
  providers: new Map(),
  modelCatalogProviders: new Map(),
  cliBackends: new Map(),
  setupProviders: new Map(),
  commandAliases: new Map(),
  contracts: new Map(),
};

const emptyMetadataSnapshot = {
  manifestRegistry: { plugins: [] },
  owners: emptyOwners,
} as unknown as PluginMetadataSnapshot;

function metadataWithCatalogOwner(provider: string, pluginId: string): PluginMetadataSnapshot {
  return {
    ...emptyMetadataSnapshot,
    owners: {
      ...emptyOwners,
      modelCatalogProviders: new Map([[provider, [pluginId]]]),
    },
  };
}

function ownerSnapshot(modelCatalog: unknown, metadataSnapshot = emptyMetadataSnapshot) {
  return {
    agentDir: "/tmp/agent",
    metadataSnapshot,
    modelCatalog,
  };
}

describe("model-list provider catalog", () => {
  beforeEach(() => {
    mocks.loadAuthStore.mockClear();
    mocks.loadMetadata.mockReset();
    mocks.loadMetadata.mockReturnValue(emptyMetadataSnapshot);
    mocks.loadOwner.mockReset();
    mocks.resolveImplicitProviders.mockReset();
  });

  it("projects a filtered provider through targeted plugin discovery", async () => {
    mocks.resolveImplicitProviders.mockResolvedValue({
      moonshot: {
        baseUrl: "https://api.moonshot.ai",
        api: "openai-completions",
        models: [{ id: "kimi-k2.6", name: "Kimi K2.6", contextWindow: 262_144 }],
      },
    });

    await expect(
      loadProviderCatalogModelsForList({
        cfg: {},
        agentDir: "/tmp/agent",
        providerFilter: "moonshot",
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        provider: "moonshot",
        id: "kimi-k2.6",
        name: "Kimi K2.6",
        contextWindow: 262_144,
        maxTokens: 200_000,
      }),
    ]);
    expect(mocks.resolveImplicitProviders).toHaveBeenCalledWith(
      expect.objectContaining({
        authStore: { version: 1, profiles: {} },
        providerDiscoveryProviderIds: ["moonshot"],
      }),
    );
    expect(mocks.loadAuthStore).toHaveBeenCalledWith("/tmp/agent", {
      config: {},
      externalCliProviderIds: ["moonshot"],
    });
    expect(mocks.loadOwner).not.toHaveBeenCalled();
  });

  it("resolves the effective agent context for filtered discovery", async () => {
    const cfg = {
      agents: {
        list: [
          {
            id: "worker",
            agentDir: "/tmp/model-list-worker-agent",
            workspace: "/tmp/model-list-worker-workspace",
          },
        ],
      },
    };
    mocks.resolveImplicitProviders.mockResolvedValue({ moonshot: { models: [] } });

    await loadProviderCatalogModelsForList({
      cfg,
      agentId: "worker",
      providerFilter: "moonshot",
    });

    expect(mocks.loadMetadata).toHaveBeenCalledWith(
      expect.objectContaining({
        config: cfg,
        workspaceDir: "/tmp/model-list-worker-workspace",
      }),
    );
    expect(mocks.loadAuthStore).toHaveBeenCalledWith("/tmp/model-list-worker-agent", {
      config: cfg,
      externalCliProviderIds: ["moonshot"],
    });
    expect(mocks.resolveImplicitProviders).toHaveBeenCalledWith(
      expect.objectContaining({ agentDir: "/tmp/model-list-worker-agent" }),
    );
  });

  it("keeps unfiltered runtime output on the lifecycle owner", async () => {
    mocks.loadOwner.mockResolvedValue(
      ownerSnapshot({
        entries: [
          { provider: "moonshot", id: "kimi-k2.6", name: "Kimi K2.6" },
          { provider: "ollama", id: "local-model", name: "Local Model" },
        ],
        routeVariants: [],
      }),
    );

    await expect(
      loadProviderCatalogModelsForList({
        cfg: {},
        agentDir: "/tmp/agent",
      }),
    ).resolves.not.toContainEqual(expect.objectContaining({ provider: "ollama" }));
  });

  it("keeps static provider-hook rows separate from runtime ownership", async () => {
    mocks.loadOwner.mockResolvedValue(
      ownerSnapshot({
        entries: [{ provider: "moonshot", id: "kimi-runtime", name: "Kimi Runtime" }],
        staticEntries: [{ provider: "nvidia", id: "nemotron-static", name: "Nemotron Static" }],
        routeVariants: [],
      }),
    );

    await expect(
      hasProviderRuntimeCatalogForFilter({
        cfg: {},
        agentId: "worker",
        agentDir: "/tmp/agent",
        providerFilter: "nvidia",
      }),
    ).resolves.toBe(false);
    await expect(
      hasProviderStaticCatalogForFilter({
        cfg: {},
        agentDir: "/tmp/agent",
        providerFilter: "nvidia",
      }),
    ).resolves.toBe(true);
    await expect(
      hasProviderStaticCatalogForFilter({
        cfg: {},
        agentDir: "/tmp/agent",
      }),
    ).resolves.toBe(true);
    await expect(
      loadProviderCatalogModelsForList({
        cfg: {},
        agentDir: "/tmp/agent",
        staticOnly: true,
      }),
    ).resolves.toEqual([{ provider: "nvidia", id: "nemotron-static", name: "Nemotron Static" }]);
    expect(mocks.loadOwner).toHaveBeenCalledWith(expect.objectContaining({ readOnly: true }));
  });

  it("uses model-catalog manifest ownership without activating a prepared runtime", async () => {
    const env = { OPENCLAW_STATE_DIR: "/tmp/model-list-state" };
    mocks.loadMetadata.mockReturnValue(metadataWithCatalogOwner("moonshot", "moonshot"));

    await expect(
      hasProviderRuntimeCatalogForFilter({
        cfg: {},
        agentId: "worker",
        agentDir: "/tmp/agent",
        env,
        providerFilter: "moonshot",
      }),
    ).resolves.toBe(true);
    expect(mocks.loadOwner).not.toHaveBeenCalled();
  });

  it("does not treat generic provider ownership as runtime catalog ownership", async () => {
    mocks.loadMetadata.mockReturnValue({
      ...emptyMetadataSnapshot,
      owners: {
        ...emptyMetadataSnapshot.owners,
        providers: new Map([["auth-only", ["auth-only"]]]),
        cliBackends: new Map([["auth-only", ["auth-only"]]]),
      },
    });

    await expect(
      hasProviderRuntimeCatalogForFilter({
        cfg: {},
        agentDir: "/tmp/agent",
        providerFilter: "auth-only",
      }),
    ).resolves.toBe(false);
  });

  it("derives the matching directory for an explicit agent", async () => {
    const cfg = {
      agents: {
        list: [{ id: "worker", agentDir: "/tmp/model-list-worker-agent" }],
      },
    };
    mocks.loadOwner.mockResolvedValue(
      ownerSnapshot({
        entries: [],
        staticEntries: [{ provider: "nvidia", id: "worker-model", name: "Worker Model" }],
        routeVariants: [],
      }),
    );

    await expect(
      hasProviderStaticCatalogForFilter({
        cfg,
        agentId: "worker",
        providerFilter: "nvidia",
      }),
    ).resolves.toBe(true);
    expect(mocks.loadOwner).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "worker",
        agentDir: "/tmp/model-list-worker-agent",
      }),
    );
  });

  it("resolves provider aliases without a caller-supplied metadata snapshot", async () => {
    mocks.loadMetadata.mockReturnValue({
      manifestRegistry: {
        plugins: [
          {
            id: "moonshot",
            modelCatalog: {
              aliases: { kimi: { provider: "moonshot" } },
            },
          },
        ],
      },
    });
    mocks.resolveImplicitProviders.mockResolvedValue({
      moonshot: {
        baseUrl: "https://api.moonshot.ai",
        api: "openai-completions",
        models: [{ id: "kimi-k2.6", name: "Kimi K2.6" }],
      },
    });

    await loadProviderCatalogModelsForList({
      cfg: {},
      agentDir: "/tmp/agent",
      providerFilter: "kimi",
    });

    expect(mocks.resolveImplicitProviders).toHaveBeenCalledWith(
      expect.objectContaining({ providerDiscoveryProviderIds: ["moonshot"] }),
    );
  });

  it("matches provider aliases from the captured metadata generation", async () => {
    const metadataSnapshot = {
      manifestRegistry: {
        plugins: [
          {
            id: "moonshot",
            modelCatalog: {
              aliases: { kimi: { provider: "moonshot" } },
            },
          },
        ],
      },
    } as never;
    mocks.resolveImplicitProviders.mockResolvedValue({
      moonshot: {
        baseUrl: "https://api.moonshot.ai",
        api: "openai-completions",
        models: [{ id: "kimi-k2.6", name: "Kimi K2.6" }],
      },
    });

    await expect(
      loadProviderCatalogModelsForList({
        cfg: {},
        agentDir: "/tmp/agent",
        providerFilter: "kimi",
        metadataSnapshot,
      }),
    ).resolves.toEqual([
      expect.objectContaining({ provider: "moonshot", id: "kimi-k2.6", name: "Kimi K2.6" }),
    ]);
    expect(mocks.resolveImplicitProviders).toHaveBeenCalledWith(
      expect.objectContaining({ providerDiscoveryProviderIds: ["moonshot"] }),
    );
  });
});
