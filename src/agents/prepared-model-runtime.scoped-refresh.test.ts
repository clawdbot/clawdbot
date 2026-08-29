// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  getPreparedModelRuntimeMocks,
  resetPreparedModelRuntimeHarness,
} from "./prepared-model-runtime.test-harness.js";
import { beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getPreparedModelRuntimeAuthStore } from "./prepared-model-runtime-auth.js";
import {
  getPreparedModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";

const mocks = getPreparedModelRuntimeMocks();

describe("prepared model runtime scoped refresh", () => {
  beforeEach(() => resetPreparedModelRuntimeHarness());

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
        agentDir: "/tmp/configured-free",
        inheritedAuthDir: "/tmp/unused-agent",
        workspaceDir: "/tmp/workspace-free",
      };
      const proInput = {
        ...freeInput,
        agentId: "pro",
        agentDir: "/tmp/configured-pro",
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
        agentDir: "/tmp/configured-pro",
        inheritedAuthDir: "/tmp/unused-agent",
        workspaceDir: "/tmp/workspace-pro",
      }),
    ).toMatchObject({ agentId: "pro", config: nextConfig });
  });
});
