import fs from "node:fs/promises";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "../../agents/model-catalog.types.js";
import * as providerModelNormalizationRuntime from "../../agents/provider-model-normalization.runtime.js";
import { createPluginMetadataSnapshot } from "../../config/plugin-auto-enable.test-helpers.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withPluginMetadataSnapshotScope } from "../../plugins/current-plugin-metadata-snapshot.js";
import { createPluginMetadataOwner } from "../../plugins/plugin-metadata-collection.js";
import { clearPluginMetadataLifecycleCaches } from "../../plugins/plugin-metadata-lifecycle.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  rollbackStagedPluginRegistry,
  stageActivePluginRegistry,
} from "../../plugins/runtime.js";
import {
  createColdPluginConfig,
  createColdPluginFixture,
} from "../../plugins/test-helpers/cold-plugin-fixtures.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  buildModelsListResult,
  createGatewayAgentModelCatalogProjector,
} from "./models-list-result.js";
import type { GatewayRequestContext } from "./types.js";

const mocks = vi.hoisted(() => ({
  prepareHarnessCatalog:
    vi.fn<typeof import("./models-list-harness-catalog.js").prepareModelsListHarnessCatalog>(),
}));

vi.mock("./models-list-harness-catalog.js", () => ({
  prepareModelsListHarnessCatalog: mocks.prepareHarnessCatalog,
}));

function catalogEntry(id: string): ModelCatalogEntry {
  return { id, name: id, provider: "custom", api: "openai-responses" };
}

function preparedMetadataSnapshot() {
  return createPluginMetadataSnapshot({
    manifestRegistry: {
      plugins: [
        {
          id: "custom",
          origin: "config",
          rootDir: "/test/custom",
          source: "/test/custom/index.js",
          manifestPath: "/test/custom/openclaw.plugin.json",
          channels: [],
          providers: ["custom"],
          cliBackends: [],
          skills: [],
          hooks: [],
          modelIdNormalization: {
            providers: {
              custom: {
                aliases: {
                  legacy: "modern",
                },
              },
            },
          },
        },
      ],
      diagnostics: [],
    },
  });
}

describe("models.list plugin metadata handoff", () => {
  beforeEach(() => {
    mocks.prepareHarnessCatalog.mockReset().mockImplementation(async ({ snapshot }) => ({
      snapshot,
      defaultModel: undefined,
      catalog: snapshot.entries,
    }));
  });

  it.each(["entries", "staticEntries", "harness"] as const)(
    "keeps captured workspace runtime aliases in configured %s",
    async (catalogSource) => {
      const { prepareModelsListHarnessCatalog } = await vi.importActual<
        typeof import("./models-list-harness-catalog.js")
      >("./models-list-harness-catalog.js");
      mocks.prepareHarnessCatalog.mockImplementationOnce(prepareModelsListHarnessCatalog);
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const configs = new Map<string, OpenClawConfig>();
        for (const name of ["captured", "ambient"]) {
          const pluginDir = state.path(`${name}-normalizer`);
          await fs.mkdir(pluginDir);
          const fixture = createColdPluginFixture({
            rootDir: pluginDir,
            pluginId: `${name}-normalizer`,
            manifest: {
              channels: [],
              channelConfigs: {},
              providers: ["custom"],
              providerAuthChoices: [],
              modelIdNormalization: {
                providers: { custom: { aliases: { legacy: `${name}-manifest` } } },
              },
            },
          });
          configs.set(name, {
            ...createColdPluginConfig(pluginDir, fixture.pluginId),
            meta: { migrations: { modelPolicyAllowlist: true } },
            agents: {
              defaults: {
                workspace: state.path(`${name}-workspace`),
                model: { primary: "custom/legacy" },
                models: {
                  "custom/legacy": { alias: "friendly" },
                  ...(catalogSource === "harness"
                    ? { "custom/captured-runtime": { agentRuntime: { id: "workspace-catalog" } } }
                    : {}),
                },
                modelPolicy: { allow: ["custom/legacy"] },
              },
            },
          });
        }
        const cfg = configs.get("captured")!;
        const ambientConfig = configs.get("ambient")!;
        const owner = createPluginMetadataOwner();
        const previousRegistry =
          catalogSource === "harness" ? captureActivePluginRegistrySnapshot() : undefined;
        try {
          const captured = owner.prepare({ config: cfg }).selectedSnapshot;
          const ambient = owner.prepare({ config: ambientConfig }).selectedSnapshot;
          const registry = catalogSource === "harness" ? createEmptyPluginRegistry() : undefined;
          if (registry) {
            registry.agentHarnesses.push({
              pluginId: "workspace-catalog",
              source: "test",
              harness: {
                id: "workspace-catalog",
                label: "Workspace catalog",
                supports: () => ({ supported: true }),
                runAttempt: async () => {
                  throw new Error("catalog fixture must not execute a turn");
                },
                loadModelCatalog: async () => [
                  { ...catalogEntry("captured-runtime"), name: "Captured harness model" },
                ],
              },
            });
            stageActivePluginRegistry(registry, null, "default", ambient.workspaceDir);
          }
          const normalize = vi
            .spyOn(providerModelNormalizationRuntime, "normalizeProviderModelIdWithRuntime")
            .mockImplementation((params) => {
              if (!params.context.modelId.endsWith("-manifest")) {
                return undefined;
              }
              return params.pluginMetadataSnapshot === captured &&
                params.workspaceDir === captured.workspaceDir &&
                params.config === cfg
                ? "captured-runtime"
                : "ambient-runtime";
            });
          onTestFinished(() => normalize.mockRestore());
          const entries = [catalogEntry("captured-runtime"), catalogEntry("ambient-runtime")];
          const snapshot: ModelCatalogSnapshot = {
            entries: catalogSource === "staticEntries" ? [] : entries,
            routeVariants: [],
            ...(catalogSource === "staticEntries" ? { staticEntries: entries } : {}),
          };
          const projector = createGatewayAgentModelCatalogProjector({
            cfg,
            agentId: "main",
            snapshot,
            metadataSnapshot: captured,
            pluginRegistry: registry,
            preparedAuthStore: { version: 1, profiles: {} },
          });
          const context = {
            getRuntimeConfig: () => cfg,
            loadGatewayModelCatalogSnapshot: vi.fn(),
            logGateway: { debug: vi.fn() },
          } as unknown as GatewayRequestContext;
          const result = await withPluginMetadataSnapshotScope(
            ambient,
            () =>
              buildModelsListResult({
                context,
                agentId: "main",
                params: { view: "configured" },
                preloadedCatalog: { agentId: "main", config: cfg, snapshot },
                preloadedOnly: catalogSource !== "harness",
                catalogProjector: projector,
              }),
            { config: ambientConfig, workspaceDir: ambient.workspaceDir },
          );
          expect(result.models.map(({ id, alias }) => ({ id, alias }))).toEqual([
            { id: "captured-runtime", alias: "friendly" },
          ]);
          if (catalogSource === "harness") {
            expect(result.models[0]?.name).toBe("Captured harness model");
          }
        } finally {
          if (previousRegistry) {
            rollbackStagedPluginRegistry(previousRegistry);
          }
          owner.dispose();
          clearPluginMetadataLifecycleCaches();
        }
      });
    },
  );

  it("reuses one Gateway-owned metadata snapshot across startup projection and browse", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-models-list-plugin-runtime-",
        agentEnv: "main",
      },
      async (state) => {
        const cfg = {
          agents: {
            defaults: {
              workspace: state.workspaceDir,
              model: { primary: "custom/legacy" },
              models: {
                "custom/legacy": {},
                "custom/another": {},
              },
            },
          },
        } as OpenClawConfig;
        const snapshot: ModelCatalogSnapshot = {
          entries: [catalogEntry("modern"), catalogEntry("another")],
          routeVariants: [],
        };
        const projector = createGatewayAgentModelCatalogProjector({
          cfg,
          agentId: "main",
          snapshot,
          metadataSnapshot: preparedMetadataSnapshot(),
          pluginRegistry: undefined,
          preparedAuthStore: { version: 1, profiles: {} },
        });
        await projector.projectCatalog();

        const context = {
          getRuntimeConfig: () => cfg,
          loadGatewayModelCatalogSnapshot: vi.fn(),
          logGateway: { debug: vi.fn() },
        } as unknown as GatewayRequestContext;
        await buildModelsListResult({
          context,
          agentId: "main",
          params: { view: "configured" },
          preloadedCatalog: { agentId: "main", config: cfg, snapshot },
          preloadedOnly: true,
          catalogProjector: projector,
        });
        expect(mocks.prepareHarnessCatalog).toHaveBeenCalledWith(
          expect.objectContaining({ allowHarnessDiscovery: false }),
        );
      },
    );
  });

  it("keeps prepared owner facts when preloaded-only browse requires full discovery", async () => {
    const cfg = {
      agents: { defaults: { models: { "custom/*": {} } } },
    } as OpenClawConfig;
    const snapshot: ModelCatalogSnapshot = { entries: [], routeVariants: [] };
    const loadGatewayModelCatalogSnapshot = vi.fn();
    const context = {
      getRuntimeConfig: () => cfg,
      loadGatewayModelCatalogSnapshot,
      logGateway: { debug: vi.fn() },
    } as unknown as GatewayRequestContext;
    const projector = createGatewayAgentModelCatalogProjector({
      cfg,
      agentId: "main",
      snapshot,
      metadataSnapshot: preparedMetadataSnapshot(),
      pluginRegistry: undefined,
      preparedAuthStore: { version: 1, profiles: {} },
    });

    await buildModelsListResult({
      context,
      params: { view: "configured" },
      preloadedCatalog: { agentId: "main", config: cfg, snapshot },
      preloadedOnly: true,
      catalogProjector: projector,
    });

    expect(loadGatewayModelCatalogSnapshot).not.toHaveBeenCalled();
    expect(mocks.prepareHarnessCatalog).toHaveBeenCalledWith(
      expect.objectContaining({ allowHarnessDiscovery: false }),
    );
  });

  it("discovers a harness catalog for an explicit configured picker read", async () => {
    const cfg = { agents: { defaults: { model: "custom/modern" } } } as OpenClawConfig;
    const snapshot: ModelCatalogSnapshot = {
      entries: [catalogEntry("modern")],
      routeVariants: [],
    };
    const projector = createGatewayAgentModelCatalogProjector({
      cfg,
      agentId: "main",
      snapshot,
      metadataSnapshot: preparedMetadataSnapshot(),
      pluginRegistry: undefined,
      preparedAuthStore: { version: 1, profiles: {} },
    });
    const context = {
      getRuntimeConfig: () => cfg,
      loadGatewayModelCatalogSnapshot: vi.fn(),
      logGateway: { debug: vi.fn() },
    } as unknown as GatewayRequestContext;

    await buildModelsListResult({
      context,
      params: { view: "configured" },
      preloadedCatalog: { agentId: "main", config: cfg, snapshot },
      catalogProjector: projector,
    });

    expect(mocks.prepareHarnessCatalog).toHaveBeenCalledWith(
      expect.objectContaining({ allowHarnessDiscovery: true, agentId: "main", snapshot }),
    );
  });
});
