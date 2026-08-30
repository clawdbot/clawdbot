// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  cleanupPreparedModelRuntimeHarness,
  getPreparedModelRuntimeMocks,
  resetPreparedModelRuntimeHarness,
} from "./prepared-model-runtime.test-harness.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { retainLegacyDefaultAgentId } from "../config/legacy.default-agent-owner.js";
import { createPluginMetadataSnapshot } from "../config/plugin-auto-enable.test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  withPluginMetadataCollectionScope,
  type PreparedPluginMetadata,
} from "../plugins/plugin-metadata-collection.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { createPreparedPluginMetadataFixture } from "../plugins/plugin-metadata.test-support.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "./defaults.js";
import { getPreparedModelRuntimeAuthStore } from "./prepared-model-runtime-auth.js";
import {
  getPreparedModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";
import * as providerModelNormalization from "./provider-model-normalization.runtime.js";

const mocks = getPreparedModelRuntimeMocks();
let state: OpenClawTestState;

function createNormalizerSnapshot(
  config: OpenClawConfig,
  workspaceDir: string,
  normalizedModel: string,
): PluginMetadataSnapshot {
  return createPluginMetadataSnapshot({
    config,
    workspaceDir,
    manifestRegistry: {
      diagnostics: [],
      plugins: [
        {
          id: "fixture-normalizer",
          channels: [],
          providers: ["fixture"],
          cliBackends: [],
          skills: [],
          hooks: [],
          origin: "workspace",
          rootDir: workspaceDir,
          source: `${workspaceDir}/index.js`,
          manifestPath: `${workspaceDir}/openclaw.plugin.json`,
          modelIdNormalization: {
            providers: { fixture: { aliases: { latest: normalizedModel } } },
          },
        },
      ],
    },
  });
}

describe("prepared model runtime scoped refresh", () => {
  beforeEach(async () => {
    state = await createOpenClawTestState({ label: "prepared-model-runtime" });
    resetPreparedModelRuntimeHarness(state);
  });

  it.each([
    { mode: "direct", selectionSource: "primary" },
    { mode: "async candidate", selectionSource: "primary" },
    { mode: "direct", selectionSource: "fallback only" },
    { mode: "async candidate", selectionSource: "fallback only" },
  ] as const)(
    "plans a $mode refresh with a $selectionSource model from its supplied metadata",
    async ({ mode, selectionSource }) => {
      mocks.configuredAgentIds = ["pro"];
      const workspaceDir = "/tmp/candidate-workspace";
      mocks.configuredWorkspaces.set("pro", workspaceDir);
      const model =
        selectionSource === "primary" ? "fixture/latest" : { fallbacks: ["fixture/latest"] };
      const config = {
        agents: {
          defaults: { model },
          entries: { pro: { workspace: workspaceDir } },
        },
      } satisfies OpenClawConfig;
      const ambientConfig = {
        agents: {
          defaults: { model },
          entries: { pro: { workspace: "/tmp/ambient-workspace" } },
        },
      } satisfies OpenClawConfig;
      const metadata = (
        fixtureConfig: OpenClawConfig,
        fixtureWorkspaceDir: string,
        normalizedModel: string,
      ): PreparedPluginMetadata => {
        const snapshot = createNormalizerSnapshot(
          fixtureConfig,
          fixtureWorkspaceDir,
          normalizedModel,
        );
        return createPreparedPluginMetadataFixture({
          unionSnapshot: snapshot,
          agentWorkspaceDirs: new Map([["pro", fixtureWorkspaceDir]]),
        });
      };
      const ambient = metadata(ambientConfig, "/tmp/ambient-workspace", "ambient-model");
      const candidate = metadata(config, workspaceDir, "candidate-model");

      await withPluginMetadataCollectionScope(
        ambient,
        () =>
          mode === "direct"
            ? refreshPreparedModelRuntimeSnapshots(config, {
                gatewayLifecycle: true,
                agentIds: new Set(["pro"]),
                pluginMetadata: candidate,
              })
            : refreshPreparedModelRuntimeSnapshots(
                async () => ({ config, pluginMetadata: candidate }),
                { gatewayLifecycle: true },
              ),
        { config: ambientConfig },
      );

      const plannedRegistries = mocks.loadAgentRuntimePluginRegistryHandle.mock.calls.map(
        ([{ workspaceDir: plannedWorkspaceDir, metadataSnapshot, selections }]) => ({
          workspaceDir: plannedWorkspaceDir,
          metadataSnapshot,
          selections: selections?.map(({ provider, modelId }) => ({ provider, modelId })),
        }),
      );
      expect(plannedRegistries).toContainEqual(
        expect.objectContaining({
          workspaceDir,
          metadataSnapshot: candidate.selectedSnapshot,
          selections: [
            { provider: "fixture", modelId: "candidate-model" },
            ...(selectionSource === "fallback only"
              ? [{ provider: DEFAULT_PROVIDER, modelId: DEFAULT_MODEL }]
              : []),
          ],
        }),
      );
      expect(
        getPreparedModelRuntimeSnapshot({
          config,
          agentId: "pro",
          agentDir: state.agentDir("pro"),
          inheritedAuthDir: state.agentDir("default"),
          workspaceDir,
        })?.metadataSnapshot,
      ).toBe(candidate.selectedSnapshot);
    },
  );

  it("plans manifest aliases without provider hooks before registry construction", async () => {
    mocks.configuredAgentIds = ["pro"];
    const workspaceDir = "/tmp/manifest-planning-workspace";
    mocks.configuredWorkspaces.set("pro", workspaceDir);
    const config = {
      agents: {
        defaults: {
          model: { primary: "fixture/latest", fallbacks: ["standby"] },
          models: { "fixture/backup": { alias: "standby" } },
        },
        entries: { pro: { workspace: workspaceDir } },
      },
    } satisfies OpenClawConfig;
    const snapshot = createNormalizerSnapshot(config, workspaceDir, "prepared-model");
    const normalization = vi
      .spyOn(providerModelNormalization, "normalizeProviderModelIdWithRuntime")
      .mockReturnValue(undefined);
    try {
      await refreshPreparedModelRuntimeSnapshots(config, {
        gatewayLifecycle: true,
        catalogMode: "static",
        pluginMetadata: createPreparedPluginMetadataFixture({
          unionSnapshot: snapshot,
          agentWorkspaceDirs: new Map([["pro", workspaceDir]]),
        }),
      });

      expect(
        mocks.loadAgentRuntimePluginRegistryHandle.mock.calls.flatMap(([{ selections }]) =>
          (selections ?? []).map(({ provider, modelId }) => ({ provider, modelId })),
        ),
      ).toEqual([
        { provider: "fixture", modelId: "backup" },
        { provider: "fixture", modelId: "prepared-model" },
      ]);
      const firstRegistryLoad =
        mocks.loadAgentRuntimePluginRegistryHandle.mock.invocationCallOrder[0];
      expect(firstRegistryLoad).toBeDefined();
      expect(
        normalization.mock.invocationCallOrder.filter((order) => order < firstRegistryLoad!),
      ).toEqual([]);
    } finally {
      normalization.mockRestore();
    }
  });

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

  it("normalizes refreshed model selections in the retained startup workspace", async () => {
    mocks.configuredAgentIds = ["default"];
    const configuredWorkspaceDir = "/tmp/configured-alias-workspace";
    const startupWorkspaceDir = "/tmp/startup-alias-workspace";
    mocks.configuredWorkspaces.set("default", configuredWorkspaceDir);
    const config = retainLegacyDefaultAgentId(
      {
        agents: {
          defaults: { model: "fixture/latest" },
          entries: { default: { workspace: configuredWorkspaceDir } },
        },
      },
      "default",
    );
    const configuredSnapshot = createNormalizerSnapshot(
      config,
      configuredWorkspaceDir,
      "configured-model",
    );
    const startupSnapshot = createNormalizerSnapshot(config, startupWorkspaceDir, "startup-model");
    const pluginMetadata = createPreparedPluginMetadataFixture({
      unionSnapshot: configuredSnapshot,
      selectedSnapshot: startupSnapshot,
      configWorkspaceDirs: [configuredWorkspaceDir],
      agentWorkspaceDirs: new Map([["default", configuredWorkspaceDir]]),
      workspaces: new Map([
        [configuredWorkspaceDir, configuredSnapshot],
        [startupWorkspaceDir, startupSnapshot],
      ]),
    });
    await refreshPreparedModelRuntimeSnapshots(config, {
      gatewayLifecycle: true,
      defaultWorkspaceDir: startupWorkspaceDir,
      pluginMetadata,
    });
    mocks.loadAgentRuntimePluginRegistryHandle.mockClear();

    await refreshPreparedModelRuntimeSnapshots(config, { gatewayLifecycle: true, pluginMetadata });

    expect(
      mocks.loadAgentRuntimePluginRegistryHandle.mock.calls
        .filter(([{ selections }]) => selections !== undefined)
        .map(([{ workspaceDir, selections }]) => ({
          workspaceDir,
          selections: selections?.map(({ provider, modelId }) => ({ provider, modelId })),
        })),
    ).toEqual([
      {
        workspaceDir: startupWorkspaceDir,
        selections: [{ provider: "fixture", modelId: "startup-model" }],
      },
    ]);
    expect(
      getPreparedModelRuntimeSnapshot({
        config,
        agentId: "default",
        agentDir: state.agentDir("default"),
        inheritedAuthDir: state.agentDir("default"),
        workspaceDir: startupWorkspaceDir,
      })?.metadataSnapshot,
    ).toBe(startupSnapshot);
  });

  it.each([
    { metadataState: "unchanged", replaceMetadata: false, refreshedAgents: 1 },
    { metadataState: "replaced", replaceMetadata: true, refreshedAgents: 2 },
  ])(
    "checks $metadataState workspace metadata before retaining unaffected configured owners",
    async ({ replaceMetadata, refreshedAgents }) => {
      mocks.configuredAgentIds = ["pro", "free"];
      const initialConfig = {
        agents: {
          entries: {
            pro: { model: "openai/gpt-5.6" },
            free: { model: "openai/gpt-5.5" },
          },
        },
      } satisfies OpenClawConfig;
      const nextConfig = {
        agents: {
          entries: {
            pro: { model: "openai/gpt-5.4" },
            free: { model: "openai/gpt-5.5" },
          },
        },
      } satisfies OpenClawConfig;
      const buildCounts: number[] = [];
      const freeInput = {
        config: initialConfig,
        agentId: "free",
        agentDir: state.agentDir("free"),
        inheritedAuthDir: state.agentDir("default"),
        workspaceDir: "/tmp/workspace-free",
      };
      const proMetadata = createPluginMetadataSnapshot({
        config: initialConfig,
        workspaceDir: "/tmp/workspace-pro",
        manifestRegistry: { plugins: [], diagnostics: [] },
      });
      const freeMetadata = createPluginMetadataSnapshot({
        config: initialConfig,
        workspaceDir: freeInput.workspaceDir,
        manifestRegistry: { plugins: [], diagnostics: [] },
      });
      const nextFreeMetadata = replaceMetadata
        ? createPluginMetadataSnapshot({
            config: nextConfig,
            workspaceDir: freeInput.workspaceDir,
            manifestRegistry: { plugins: [], diagnostics: [] },
          })
        : freeMetadata;
      const unionSnapshot = createPluginMetadataSnapshot({
        config: initialConfig,
        manifestRegistry: { plugins: [], diagnostics: [] },
      });
      const metadata = (freeSnapshot: PluginMetadataSnapshot) =>
        createPreparedPluginMetadataFixture({
          unionSnapshot,
          selectedSnapshot: proMetadata,
          workspaces: new Map([
            [proMetadata.workspaceDir, proMetadata],
            [freeSnapshot.workspaceDir, freeSnapshot],
          ]),
          agentWorkspaceDirs: new Map([
            ["pro", "/tmp/workspace-pro"],
            ["free", freeInput.workspaceDir],
          ]),
        });

      await refreshPreparedModelRuntimeSnapshots(initialConfig, {
        gatewayLifecycle: true,
        pluginMetadata: metadata(freeMetadata),
        onBuildStats: (stats) => buildCounts.push(stats.agentCount),
      });
      const retainedReader = getPreparedModelRuntimeSnapshot(freeInput)!;
      const retainedAuthStore = getPreparedModelRuntimeAuthStore(retainedReader);

      await refreshPreparedModelRuntimeSnapshots(nextConfig, {
        gatewayLifecycle: true,
        agentIds: new Set(["pro"]),
        pluginMetadata: metadata(nextFreeMetadata),
        onBuildStats: (stats) => buildCounts.push(stats.agentCount),
      });

      const retained = getPreparedModelRuntimeSnapshot({ ...freeInput, config: nextConfig });
      expect(buildCounts).toEqual([2, refreshedAgents]);
      expect(retained).toMatchObject({ agentId: "free", config: nextConfig });
      expect(retained).not.toBe(retainedReader);
      expect(retainedReader.config).toBe(initialConfig);
      expect(retainedReader.metadataSnapshot).toBe(freeMetadata);
      expect(retained?.metadataSnapshot).toBe(nextFreeMetadata);
      if (!replaceMetadata) {
        expect(retained?.modelCatalog).toBe(retainedReader.modelCatalog);
        expect(getPreparedModelRuntimeAuthStore(retained!)).toBe(retainedAuthStore);
      }
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
