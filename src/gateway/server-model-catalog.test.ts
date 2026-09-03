import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelCatalogSnapshot } from "../agents/model-catalog.types.js";
import {
  preparePublishedModelCatalogOwnerIdentity,
  resolvePublishedModelCatalogOwner,
} from "../agents/prepared-model-catalog-owner.js";
import * as preparedModelCatalog from "../agents/prepared-model-catalog.js";
import type { PublishedModelCatalogOwnerCandidate } from "../agents/prepared-model-catalog.types.js";
import { setPreparedModelRuntimeAuthLoader } from "../agents/prepared-model-runtime-auth.js";
import { PreparedModelRuntimePublicationSupersededError } from "../agents/prepared-model-runtime.errors.js";
import { markPreparedModelCatalogFull } from "../agents/prepared-model-runtime.full-catalog.js";
import { resolvePreparedOAuthRefreshProviderIds } from "../agents/prepared-model-runtime.oauth-refresh.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import {
  loadDeferredCatalog,
  registerGatewayModelCatalogPrivateAccess,
} from "./server-model-catalog-auth.js";
import {
  loadGatewayModelCatalog,
  loadGatewayModelCatalogSnapshot,
  loadPreparedGatewayModelCatalogSnapshot,
  type GatewayModelCatalogSnapshot,
} from "./server-model-catalog.js";

// The Gateway reaches the published owner through a lazy import, so the spy must target the
// live module namespace rather than a hoisted module mock.
let loadPublishedPreparedModelCatalogOwnerSnapshot: ReturnType<
  typeof vi.spyOn<typeof preparedModelCatalog, "loadPublishedPreparedModelCatalogOwnerSnapshot">
>;
beforeEach(() => {
  loadPublishedPreparedModelCatalogOwnerSnapshot = vi.spyOn(
    preparedModelCatalog,
    "loadPublishedPreparedModelCatalogOwnerSnapshot",
  );
});
afterEach(() => {
  vi.restoreAllMocks();
});

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
    catalogOwner: preparePublishedModelCatalogOwnerIdentity({
      config,
      agentId,
      agentDir: "/tmp/gateway-agent",
    }),
    ...(agentId ? { agentId } : {}),
    agentDir: "/tmp/gateway-agent",
    config,
    providerAuth: {},
    oauthRefreshProviderIds: [],
    authStore: { version: 1, profiles: {} },
    metadataSnapshot: { index: { plugins: [] }, plugins: [] } as never,
    modelCatalog,
  };
}

describe("gateway prepared model catalog", () => {
  it("projects OAuth refresh owners from the active provider generation", async () => {
    const config = ownerConfig();
    const pluginRegistry = createEmptyPluginRegistry();
    pluginRegistry.providers.push(
      {
        pluginId: "xai",
        source: "test",
        provider: {
          id: "xai",
          label: "xAI",
          aliases: ["grok"],
          hookAliases: ["x-ai"],
          auth: [],
          refreshOAuth: async (credential) => credential,
        },
      },
      {
        pluginId: "minimax",
        source: "test",
        provider: { id: "minimax-portal", label: "MiniMax", auth: [] },
      },
    );

    loadPublishedPreparedModelCatalogOwnerSnapshot.mockImplementation(async () => ({
      ...ownerSnapshot(config),
      oauthRefreshProviderIds: resolvePreparedOAuthRefreshProviderIds({
        oauthProviders: [{ id: "anthropic" }],
        providerRegistrations: pluginRegistry.providers,
      }),
    }));
    const prepared = await loadPreparedGatewayModelCatalogSnapshot({ getConfig: () => config });

    expect(prepared.oauthRefreshProviderIds).toEqual(["anthropic", "grok", "x-ai", "xai"]);
    expect(prepared.oauthRefreshProviderIds).not.toContain("minimax-portal");
  });

  it("keeps raw pre-roster input distinct from an explicitly empty roster", () => {
    const input = {
      config: {},
      agentDir: "/tmp/raw-catalog-state/agents/main/agent",
      env: { OPENCLAW_STATE_DIR: "/tmp/raw-catalog-state", OPENCLAW_HOME: "/tmp/raw-catalog-home" },
    };
    expect(preparePublishedModelCatalogOwnerIdentity(input)).toMatchObject({ agentId: "main" });
    expect(
      preparePublishedModelCatalogOwnerIdentity({ ...input, config: { agents: { entries: {} } } }),
    ).toBeUndefined();
  });

  it.each([
    { name: "wrong directory", agentId: "main", agentDir: "/tmp/wrong-agent", bound: false },
    {
      name: "unknown explicit id",
      agentId: "missing",
      agentDir: "/tmp/gateway-agent",
      bound: false,
    },
    {
      name: "explicit empty roster",
      agentId: "main",
      agentDir: "/tmp/gateway-agent",
      empty: true,
      bound: false,
    },
    {
      name: "shared directory without id",
      agentDir: "/tmp/gateway-agent",
      shared: true,
      bound: false,
    },
    {
      name: "explicit shared-directory id",
      agentId: "WORKER",
      agentDir: "/tmp/gateway-agent",
      shared: true,
      bound: true,
    },
    { name: "unique directory without id", agentDir: "/tmp/gateway-agent", bound: true },
  ])(
    "preserves prepared binding validation: $name",
    async ({ agentId, agentDir, empty, shared, bound }) => {
      const config = ownerConfig();
      if (empty) {
        config.agents = { entries: {} };
      } else if (shared) {
        config.agents!.list!.push({ id: "worker", agentDir, workspace: "/tmp/worker-workspace" });
      }
      const input = { config, agentId, agentDir };
      const candidate = {
        ...ownerSnapshot(config),
        ...input,
        catalogOwner: preparePublishedModelCatalogOwnerIdentity(input),
      };
      loadPublishedPreparedModelCatalogOwnerSnapshot.mockImplementation(async () => candidate);
      const project = loadGatewayModelCatalogSnapshot({
        getConfig: () => config,
      });
      if (!bound) {
        await expect(project).rejects.toMatchObject({
          name: "PublishedModelCatalogOwnerResolutionError",
        });
        return;
      }
      const expected = {
        agentId: shared ? "worker" : "main",
        workspaceDir: shared ? "/tmp/worker-workspace" : "/tmp/gateway-workspace",
      };
      await expect(project).resolves.toMatchObject(expected);
      const resolved = resolvePublishedModelCatalogOwner(candidate);
      expect(
        resolvePublishedModelCatalogOwner({
          ...resolved,
          catalogOwner: { ...resolved.catalogOwner },
        }),
      ).toEqual(resolved);
    },
  );

  it("rejects a bound catalog without prepared auth", async () => {
    const config = ownerConfig();
    const candidate = { ...ownerSnapshot(config), authStore: undefined };
    loadPublishedPreparedModelCatalogOwnerSnapshot.mockImplementation(async () => candidate);
    await expect(
      loadGatewayModelCatalogSnapshot({
        getConfig: () => config,
      }),
    ).rejects.toThrow("missing prepared auth state");
  });

  it("reads the published read-only generation directly", async () => {
    const config = ownerConfig();
    loadPublishedPreparedModelCatalogOwnerSnapshot.mockImplementation(async () =>
      ownerSnapshot(config),
    );

    await expect(
      loadGatewayModelCatalog({
        getConfig: () => config,
      }),
    ).resolves.toBe(snapshot.entries);
    expect(loadPublishedPreparedModelCatalogOwnerSnapshot).toHaveBeenCalledWith({
      config,
      readOnly: true,
    });
  });

  it("forwards the requested agent lifecycle owner", async () => {
    const config = ownerConfig("worker");
    loadPublishedPreparedModelCatalogOwnerSnapshot.mockImplementation(async () => ({
      ...ownerSnapshot(config, snapshot, "worker"),
      workspaceDir: "/tmp/gateway-workspace",
    }));

    const projected = await loadGatewayModelCatalogSnapshot({
      agentId: "worker",
      agentDir: "/tmp/gateway-agent",
      getConfig: () => config,
      workspaceDir: "/tmp/gateway-workspace",
    });
    expect(projected).toMatchObject({
      agentId: "worker",
      agentDir: "/tmp/gateway-agent",
      config,
      workspaceDir: "/tmp/gateway-workspace",
    } satisfies Partial<GatewayModelCatalogSnapshot>);
    expect(projected).not.toHaveProperty("authStore");
    expect(projected).not.toHaveProperty("metadataSnapshot");

    expect(loadPublishedPreparedModelCatalogOwnerSnapshot).toHaveBeenCalledWith({
      agentId: "worker",
      agentDir: "/tmp/gateway-agent",
      config,
      readOnly: true,
      workspaceDir: "/tmp/gateway-workspace",
    });
  });

  it("projects whether the published owner already contains a full catalog", async () => {
    const config = ownerConfig();
    const fullCatalog = markPreparedModelCatalogFull({
      entries: [{ provider: "openai", id: "text-only", name: "Text only", input: ["text"] }],
      routeVariants: [],
    });

    loadPublishedPreparedModelCatalogOwnerSnapshot.mockImplementation(async () =>
      ownerSnapshot(config, fullCatalog),
    );
    await expect(
      loadGatewayModelCatalogSnapshot({ getConfig: () => config }),
    ).resolves.toMatchObject({ catalogComplete: true });
  });

  it("refreshes auth only for the explicit deferred projection", async () => {
    const config = ownerConfig();
    const candidate = ownerSnapshot(config);
    const loadAuth = vi.fn(async () => ({
      authStore: {
        version: 1 as const,
        profiles: {
          "openai:refreshed": {
            type: "api_key" as const,
            provider: "openai",
            key: "refreshed",
          },
        },
      },
      providerAuth: { openai: { mode: "api_key" } },
    }));
    setPreparedModelRuntimeAuthLoader(candidate, loadAuth);
    loadPublishedPreparedModelCatalogOwnerSnapshot.mockImplementation(async () => candidate);

    const prepared = await loadPreparedGatewayModelCatalogSnapshot({
      getConfig: () => config,
    });
    expect(prepared.authStore).toEqual(candidate.authStore);
    expect(loadAuth).not.toHaveBeenCalled();

    const publicLoader = vi.fn(async () =>
      loadGatewayModelCatalogSnapshot({
        getConfig: () => config,
      }),
    );
    registerGatewayModelCatalogPrivateAccess(publicLoader, {
      loadDeferred: (params) =>
        loadPreparedGatewayModelCatalogSnapshot({
          ...params,
          getConfig: () => config,
        }),
      readPrepared: async () => undefined,
    });
    const loaded = await loadDeferredCatalog(
      { loadGatewayModelCatalogSnapshot: publicLoader },
      "main",
      {
        readOnly: true,
        authScope: {
          providerIds: ["openai"],
          profileIds: ["openai:refreshed"],
        },
        refreshAuth: true,
      },
    );
    expect(loaded.authStore).toEqual(
      expect.objectContaining({ profiles: { "openai:refreshed": expect.any(Object) } }),
    );
    expect(loaded.providerAuth).toEqual({ openai: { mode: "api_key" } });
    expect(loadAuth).toHaveBeenCalledWith({
      providerIds: ["openai"],
      profileIds: ["openai:refreshed"],
    });
  });

  it("removes stale prepared provider auth when deferred auth observes logout", async () => {
    const config = ownerConfig();
    const candidate = {
      ...ownerSnapshot(config),
      providerAuth: { openai: { mode: "oauth" } },
    };
    setPreparedModelRuntimeAuthLoader(candidate, async () => ({
      authStore: { version: 1, profiles: {} },
      providerAuth: {},
    }));

    loadPublishedPreparedModelCatalogOwnerSnapshot.mockImplementation(async () => candidate);

    const publicLoader = vi.fn(async () =>
      loadGatewayModelCatalogSnapshot({
        getConfig: () => config,
      }),
    );
    registerGatewayModelCatalogPrivateAccess(publicLoader, {
      loadDeferred: (params) =>
        loadPreparedGatewayModelCatalogSnapshot({
          ...params,
          getConfig: () => config,
        }),
      readPrepared: async () => undefined,
    });
    const loaded = await loadDeferredCatalog(
      { loadGatewayModelCatalogSnapshot: publicLoader },
      "main",
      { readOnly: true, refreshAuth: true },
    );

    expect(loaded.authStore?.profiles).toEqual({});
    expect(loaded.providerAuth).toEqual({});
  });

  it("retries the whole owner projection when deferred auth supersedes its generation", async () => {
    const staleConfig = ownerConfig("main", { logging: { level: "info" } });
    const currentConfig = ownerConfig("main", { logging: { level: "debug" } });
    const staleCatalog: ModelCatalogSnapshot = {
      entries: [{ provider: "openai", id: "stale", name: "Stale" }],
      routeVariants: [],
    };
    const currentCatalog: ModelCatalogSnapshot = {
      entries: [{ provider: "openai", id: "current", name: "Current" }],
      routeVariants: [],
    };
    const stale = {
      ...ownerSnapshot(staleConfig, staleCatalog),
      providerAuth: { openai: { mode: "oauth" } },
      authStore: {
        version: 1 as const,
        profiles: {
          "openai:stale": {
            type: "token" as const,
            provider: "openai",
            token: "stale-token-not-real",
          },
        },
      },
    };
    const current = {
      ...ownerSnapshot(currentConfig, currentCatalog),
      providerAuth: { openai: { mode: "api_key" } },
      authStore: {
        version: 1 as const,
        profiles: {
          "openai:current": {
            type: "api_key" as const,
            provider: "openai",
            key: "current-key-not-real",
          },
        },
      },
    };
    setPreparedModelRuntimeAuthLoader(stale, async () => {
      throw new PreparedModelRuntimePublicationSupersededError("superseded");
    });
    loadPublishedPreparedModelCatalogOwnerSnapshot
      .mockResolvedValueOnce(stale)
      .mockResolvedValueOnce(current);

    await expect(
      loadPreparedGatewayModelCatalogSnapshot({
        getConfig: () => staleConfig,
        refreshAuth: true,
      }),
    ).resolves.toMatchObject({
      config: currentConfig,
      entries: currentCatalog.entries,
      providerAuth: { openai: { mode: "api_key" } },
      authStore: {
        profiles: { "openai:current": expect.any(Object) },
      },
    });
    expect(loadPublishedPreparedModelCatalogOwnerSnapshot).toHaveBeenCalledTimes(2);
  });

  it("retries owner acquisition when a cached catalog generation is superseded", async () => {
    const config = ownerConfig();
    const currentCatalog: ModelCatalogSnapshot = {
      entries: [{ provider: "openai", id: "current", name: "Current" }],
      routeVariants: [],
    };
    loadPublishedPreparedModelCatalogOwnerSnapshot
      .mockRejectedValueOnce(new PreparedModelRuntimePublicationSupersededError("superseded"))
      .mockResolvedValueOnce(ownerSnapshot(config, currentCatalog));

    await expect(
      loadGatewayModelCatalog({
        getConfig: () => config,
      }),
    ).resolves.toEqual(currentCatalog.entries);
    expect(loadPublishedPreparedModelCatalogOwnerSnapshot).toHaveBeenCalledTimes(2);
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
    loadPublishedPreparedModelCatalogOwnerSnapshot.mockImplementation(async () =>
      ownerSnapshot(config),
    );

    await expect(
      loadGatewayModelCatalogSnapshot({
        agentId: "worker",
        getConfig: () => config,
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
    loadPublishedPreparedModelCatalogOwnerSnapshot.mockImplementation(async () =>
      ownerSnapshot(latestConfig, latestSnapshot),
    );

    await expect(
      loadGatewayModelCatalogSnapshot({
        getConfig: () => initialConfig,
      }),
    ).resolves.toMatchObject({ config: latestConfig, entries: latestSnapshot.entries });
    expect(loadPublishedPreparedModelCatalogOwnerSnapshot).toHaveBeenCalledOnce();
  });

  it("selects the full prepared owner when requested", async () => {
    const config = ownerConfig();
    loadPublishedPreparedModelCatalogOwnerSnapshot.mockImplementation(async () =>
      ownerSnapshot(config),
    );

    await expect(
      loadGatewayModelCatalogSnapshot({
        getConfig: () => config,
        readOnly: false,
        refreshFullCatalog: true,
      }),
    ).resolves.toMatchObject(snapshot);
    expect(loadPublishedPreparedModelCatalogOwnerSnapshot).toHaveBeenCalledWith({
      config,
      readOnly: false,
      refreshFullCatalog: true,
    });
  });

  it("carries provider outcomes through the gateway owner projection", async () => {
    const config = ownerConfig();
    const modelCatalog: ModelCatalogSnapshot = {
      entries: [],
      routeVariants: [],
      providerOutcomes: [{ provider: "openai", status: "auth-rejected" }],
    };
    loadPublishedPreparedModelCatalogOwnerSnapshot.mockImplementation(async () =>
      ownerSnapshot(config, modelCatalog),
    );

    await expect(
      loadGatewayModelCatalogSnapshot({
        getConfig: () => config,
        readOnly: false,
      }),
    ).resolves.toMatchObject({ providerOutcomes: modelCatalog.providerOutcomes });
  });

  it("does not hide lifecycle publication failures behind stale data", async () => {
    const error = new Error("generation failed");
    loadPublishedPreparedModelCatalogOwnerSnapshot.mockImplementation(async () => {
      throw error;
    });

    await expect(loadGatewayModelCatalogSnapshot()).rejects.toBe(error);
  });
});
