// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  cleanupPreparedModelRuntimeHarness,
  getPreparedModelRuntimeMocks,
  resetPreparedModelRuntimeHarness,
} from "./prepared-model-runtime.test-harness.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadPreparedGatewayModelCatalogSnapshot } from "../gateway/server-model-catalog.js";
import { refreshModelRuntimeAfterHotReload } from "../gateway/server-reload-model-runtime-scope.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  getPreparedModelRuntimeAuthStore,
  setPreparedModelFullCatalogAuth,
} from "./prepared-model-runtime-auth.js";
import { markPreparedModelCatalogFull } from "./prepared-model-runtime.full-catalog.js";
import {
  getPreparedModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";

const mocks = getPreparedModelRuntimeMocks();
let state: OpenClawTestState;

describe("prepared model runtime scoped refresh", () => {
  beforeEach(async () => {
    state = await createOpenClawTestState({ label: "prepared-model-runtime" });
    resetPreparedModelRuntimeHarness(state);
  });

  it.each([undefined, new Set(["pro"])])(
    "carries completed discovery across hot reload without rediscovery (scope: %j)",
    async (agentIds) => {
      mocks.configuredAgentIds = ["pro"];
      const config: OpenClawConfig = {
        agents: { entries: { pro: {} } },
        plugins: { entries: { fixture: { enabled: true } } },
      };
      const discovered = {
        provider: "discovered-provider",
        id: "discovered-model",
        name: "Discovered",
      };
      const catalog = markPreparedModelCatalogFull({
        entries: [discovered],
        routeVariants: [discovered],
      });
      const auth = {
        authModes: { "discovered-provider": "api_key" as const },
        authStore: { version: 1 as const, profiles: {} },
      };
      setPreparedModelFullCatalogAuth(catalog, auth);
      mocks.runPreparedModelCatalogWorker.mockResolvedValueOnce(catalog);
      await refreshPreparedModelRuntimeSnapshots(config, {
        gatewayLifecycle: true,
        catalogMode: "static",
        allowGatewaySubagentBinding: true,
      });
      const input = { agentId: "pro", agentDir: state.agentDir("pro"), config };
      const original = getPreparedModelRuntimeSnapshot(input)!;
      await original.loadFullModelCatalog!();
      expect(
        await loadPreparedGatewayModelCatalogSnapshot({ agentId: "pro", getConfig: () => config }),
      ).toMatchObject({ entries: [discovered], authModes: auth.authModes });

      let currentConfig = config;
      for (const alias of ["First alias", "Second alias"]) {
        mocks.mutationListener?.({ affectsInheritedStores: true, profileSetChanged: false });
        const nextConfig: OpenClawConfig = {
          meta: { lastTouchedVersion: alias },
          plugins: { entries: { fixture: { enabled: true, config: {} } } },
          agents: {
            ...config.agents,
            defaults: {
              model: alias === "First alias" ? undefined : "discovered-provider/discovered-model",
              models: { "custom/configured": { alias } },
            },
          },
        };
        await refreshModelRuntimeAfterHotReload({
          config: nextConfig,
          agentIds,
          pluginMetadataSnapshot: undefined,
        });
        currentConfig = nextConfig;
        expect(
          await loadPreparedGatewayModelCatalogSnapshot({
            agentId: "pro",
            getConfig: () => nextConfig,
          }),
        ).toMatchObject({ config: nextConfig, entries: [discovered], authModes: auth.authModes });
        expect(mocks.runPreparedModelCatalogWorker).toHaveBeenCalledOnce();
      }
      expect(() => original.readFullModelCatalog!()).toThrow("superseded");
      await expect(original.loadFullModelCatalog!()).rejects.toThrow("superseded");
      const replacement = getPreparedModelRuntimeSnapshot(input)!;
      const refreshed = markPreparedModelCatalogFull({ entries: [], routeVariants: [] });
      setPreparedModelFullCatalogAuth(refreshed, auth);
      mocks.runPreparedModelCatalogWorker.mockResolvedValueOnce(refreshed);
      const refreshedCatalog = await replacement.loadFullModelCatalog!({ refresh: true });
      expect(refreshedCatalog).toMatchObject(refreshed);
      expect(replacement.readFullModelCatalog!()).toBe(refreshedCatalog);
      expect(mocks.runPreparedModelCatalogWorker).toHaveBeenCalledTimes(2);
      mocks.credentialsRevision += 1;
      mocks.mutationListener?.({ agentDir: input.agentDir, affectsInheritedStores: false });
      const afterAuth = await loadPreparedGatewayModelCatalogSnapshot({
        agentId: "pro",
        getConfig: () => currentConfig,
      });
      expect(afterAuth.entries).not.toContainEqual(discovered);
      expect(afterAuth.authModes).not.toHaveProperty("discovered-provider");
      expect(mocks.runPreparedModelCatalogWorker).toHaveBeenCalledTimes(2);
    },
  );

  it.each([false, true])(
    "retains catalog callbacks across scoped exec reloads (warmed: %s)",
    async (warmed) => {
      mocks.configuredAgentIds = ["pro", "free"];
      const initialConfig = {
        agents: {
          defaults: { model: "openai/gpt-5.6-luna" },
          entries: {
            pro: { tools: { exec: { security: "full", ask: "off" } } },
            free: {},
          },
        },
      } satisfies OpenClawConfig;
      const buildCounts: number[] = [];
      const options = {
        gatewayLifecycle: true,
        catalogMode: "static" as const,
        onBuildStats: (stats: { agentCount: number }) => buildCounts.push(stats.agentCount),
      };
      const freeInput = {
        config: initialConfig,
        agentId: "free",
        agentDir: state.agentDir("free"),
        inheritedAuthDir: state.agentDir("default"),
        workspaceDir: "/tmp/workspace-free",
      };
      const proInput = {
        ...freeInput,
        agentId: "pro",
        agentDir: state.agentDir("pro"),
        workspaceDir: "/tmp/workspace-pro",
      };
      // The harness stubs discovery, not the snapshot's catalog guards. Real worker retirement
      // and auth liveness are covered by prepared-model-catalog-worker.integration.test.ts.
      mocks.runPreparedModelCatalogWorker.mockImplementation(async () => ({
        entries: [],
        routeVariants: [],
      }));
      await refreshPreparedModelRuntimeSnapshots(initialConfig, options);
      const retainedReader = getPreparedModelRuntimeSnapshot(freeInput)!;
      const retainedAuthStore = getPreparedModelRuntimeAuthStore(retainedReader);
      let catalog = warmed ? await retainedReader.loadFullModelCatalog!() : undefined;

      for (const ask of ["always", "off"] as const) {
        const previousPro = getPreparedModelRuntimeSnapshot(proInput)!;
        const nextConfig = {
          agents: {
            ...initialConfig.agents,
            entries: {
              ...initialConfig.agents.entries,
              pro: { tools: { exec: { security: "full", ask } } },
            },
          },
        } satisfies OpenClawConfig;
        await refreshPreparedModelRuntimeSnapshots(nextConfig, {
          ...options,
          agentIds: new Set(["pro"]),
        });

        const retained = getPreparedModelRuntimeSnapshot({ ...freeInput, config: nextConfig })!;
        expect(retained).toMatchObject({ agentId: "free", config: nextConfig });
        expect(retained).not.toBe(retainedReader);
        expect(retainedReader.config).toBe(initialConfig);
        expect(retained.metadataSnapshot).toBe(retainedReader.metadataSnapshot);
        expect(retained.modelCatalog).toBe(retainedReader.modelCatalog);
        expect(getPreparedModelRuntimeAuthStore(retained)).toBe(retainedAuthStore);
        expect(retained.readFullModelCatalog!()).toBe(catalog);
        expect(retainedReader.readFullModelCatalog!()).toBe(catalog);
        const refreshed = await retained.loadFullModelCatalog!({ refresh: true });
        expect(refreshed).not.toBe(catalog);
        expect(retainedReader.readFullModelCatalog!()).toBe(refreshed);
        catalog = refreshed;
        expect(() => previousPro.readFullModelCatalog!()).toThrow("superseded");
        await expect(previousPro.loadFullModelCatalog!()).rejects.toThrow("superseded");
      }
      expect(buildCounts).toEqual([2, 1, 1]);
    },
  );

  it("reprojects retained discovery when a runtime override is added and removed", async () => {
    mocks.configuredAgentIds = ["pro"];
    mocks.resolveStaticCatalogModel.mockImplementation(({ provider, modelId }) => ({
      provider,
      id: modelId,
      name: modelId,
      api: "openai-responses",
      baseUrl: "https://synthetic.invalid/v1",
      reasoning: provider === "fixture-runtime",
      input: ["text"],
      contextWindow: 32000,
      maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: { supportsTools: provider === "fixture-runtime" },
    }));
    const discovered = {
      provider: "custom",
      id: "discovered-model",
      name: "Discovered",
      reasoning: false,
    };
    const catalog = markPreparedModelCatalogFull({
      entries: [discovered],
      routeVariants: [discovered],
    });
    setPreparedModelFullCatalogAuth(catalog, {
      authModes: { custom: "api_key" },
      authStore: { version: 1, profiles: {} },
    });
    mocks.runPreparedModelCatalogWorker.mockResolvedValueOnce(catalog);
    const input = { agentId: "pro", agentDir: state.agentDir("pro"), config: {} };
    for (const runtime of ["openclaw", "fixture-runtime", "openclaw"]) {
      const config: OpenClawConfig = {
        agents: {
          defaults: {
            model: "custom/discovered-model",
            models: { "custom/discovered-model": { agentRuntime: { id: runtime } } },
          },
          entries: { pro: {} },
        },
      };
      await refreshModelRuntimeAfterHotReload({
        config,
        agentIds: undefined,
        pluginMetadataSnapshot: undefined,
      });
      const snapshot = getPreparedModelRuntimeSnapshot(input)!;
      if (!snapshot.readFullModelCatalog!()) {
        await snapshot.loadFullModelCatalog!();
      }
      const projected = await loadPreparedGatewayModelCatalogSnapshot({
        agentId: "pro",
        getConfig: () => config,
      });
      expect(projected.entries).toMatchObject([
        {
          provider: "custom",
          id: "discovered-model",
          reasoning: runtime === "fixture-runtime",
        },
      ]);
      expect(projected.entries[0]?.compat?.supportsTools).toBe(
        runtime === "fixture-runtime" ? true : undefined,
      );
      expect(projected.authModes).toEqual({ custom: "api_key" });
      expect(projected.catalogComplete).toBe(true);
      expect(mocks.runPreparedModelCatalogWorker).toHaveBeenCalledOnce();
    }
  });

  it("falls back to full refresh when an out-of-scope owner dependency changes", async () => {
    mocks.configuredAgentIds = ["pro", "free"];
    const initialConfig = {
      agents: {
        defaults: { model: "openai/gpt-5.6" },
        entries: { pro: {}, free: {} },
      },
    } satisfies OpenClawConfig;
    const nextConfig = {
      agents: {
        defaults: { model: "openai/gpt-5.5" },
        entries: { pro: {}, free: {} },
      },
    } satisfies OpenClawConfig;
    const buildCounts: number[] = [];

    await refreshPreparedModelRuntimeSnapshots(initialConfig, {
      gatewayLifecycle: true,
      onBuildStats: (stats) => buildCounts.push(stats.agentCount),
    });
    await refreshPreparedModelRuntimeSnapshots(nextConfig, {
      gatewayLifecycle: true,
      agentIds: new Set(["pro"]),
      onBuildStats: (stats) => buildCounts.push(stats.agentCount),
    });

    expect(buildCounts).toEqual([2, 2]);
  });

  it("builds only a newly added non-default agent", async () => {
    mocks.configuredAgentIds = ["free"];
    const initialConfig = {
      agents: { entries: { free: { model: "openai/gpt-5.5" } } },
    } satisfies OpenClawConfig;
    const nextConfig = {
      agents: {
        entries: {
          free: { model: "openai/gpt-5.5" },
          pro: { model: "openai/gpt-5.6" },
        },
      },
    } satisfies OpenClawConfig;
    const buildCounts: number[] = [];

    await refreshPreparedModelRuntimeSnapshots(initialConfig, {
      gatewayLifecycle: true,
      onBuildStats: (stats) => buildCounts.push(stats.agentCount),
    });
    mocks.configuredAgentIds = ["free", "pro"];
    await refreshPreparedModelRuntimeSnapshots(nextConfig, {
      gatewayLifecycle: true,
      agentIds: new Set(["pro"]),
      onBuildStats: (stats) => buildCounts.push(stats.agentCount),
    });

    expect(buildCounts).toEqual([1, 1]);
    expect(
      getPreparedModelRuntimeSnapshot({
        config: nextConfig,
        agentId: "pro",
        agentDir: state.agentDir("pro"),
        inheritedAuthDir: state.agentDir("default"),
        workspaceDir: "/tmp/workspace-pro",
      }),
    ).toMatchObject({ agentId: "pro", config: nextConfig });
  });
});

afterEach(async ({ task }) => {
  await cleanupPreparedModelRuntimeHarness(state, task.result?.state === "fail");
});
