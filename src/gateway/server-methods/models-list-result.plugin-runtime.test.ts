import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentHarnessV2 } from "../../agents/harness/types.js";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "../../agents/model-catalog.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { registerGatewayModelCatalogPrivateAccess } from "../server-model-catalog-auth.js";
import {
  buildModelsListResult,
  createGatewayAgentModelCatalogProjector,
} from "./models-list-result.js";
import { modelsHandlers } from "./models.js";
import type { GatewayRequestContext } from "./types.js";

type PrepareHarnessCatalog =
  (typeof import("./models-list-harness-catalog.js"))["prepareModelsListHarnessCatalog"];

const mocks = vi.hoisted(() => ({
  prepareHarnessCatalog: vi.fn<PrepareHarnessCatalog>(async (params) => ({
    snapshot: params.snapshot,
    defaultModel: undefined,
    catalog: params.snapshot.entries,
  })),
}));

vi.mock("./models-list-harness-catalog.js", () => ({
  prepareModelsListHarnessCatalog: mocks.prepareHarnessCatalog,
}));

function catalogEntry(id: string): ModelCatalogEntry {
  return { id, name: id, provider: "custom", api: "openai-responses" };
}

function preparedMetadataSnapshot() {
  return createPluginMetadataSnapshotFixture({
    plugins: [
      {
        id: "custom",
        syntheticAuthRefs: ["custom"],
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
  });
}

describe("models.list plugin metadata handoff", () => {
  beforeEach(() => {
    mocks.prepareHarnessCatalog.mockClear();
  });

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

  it("keeps harness discovery off ordinary configured picker reads", async () => {
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
      expect.objectContaining({ allowHarnessDiscovery: false, agentId: "main", snapshot }),
    );
  });

  it.each([
    {
      name: "uses the prepared generation registry in the normal models.list handler",
      supersedeDuringDiscovery: false,
      expectedAvailable: true,
    },
    {
      name: "fails closed when harness discovery supersedes the prepared generation",
      supersedeDuringDiscovery: true,
      expectedAvailable: false,
    },
  ])("$name", async ({ supersedeDuringDiscovery, expectedAvailable }) => {
    const actualHarnessCatalog = await vi.importActual<
      typeof import("./models-list-harness-catalog.js")
    >("./models-list-harness-catalog.js");
    mocks.prepareHarnessCatalog.mockImplementationOnce(
      actualHarnessCatalog.prepareModelsListHarnessCatalog,
    );
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-models-list-prepared-registry-",
        agentEnv: "main",
      },
      async (state) => {
        const runtimeId = "prepared-native";
        const cfg = {
          agents: {
            defaults: {
              workspace: state.workspaceDir,
              model: "custom/native-model",
              models: {
                "custom/native-model": { agentRuntime: { id: runtimeId } },
              },
              modelPolicy: { allow: ["custom/native-model"] },
            },
          },
        } as OpenClawConfig;
        const entry: ModelCatalogEntry = {
          id: "native-model",
          name: "Native Model",
          provider: "custom",
          nativeRuntime: runtimeId,
        };
        const snapshot: ModelCatalogSnapshot = {
          entries: [entry],
          routeVariants: [entry],
        };
        let generationCurrent = true;
        const loadPreparedCatalog = vi.fn(async () => {
          if (supersedeDuringDiscovery) {
            generationCurrent = false;
          }
          return [entry];
        });
        const harness: AgentHarnessV2 = {
          id: runtimeId,
          label: "Prepared native harness",
          authBootstrap: "harness",
          supports: () => ({ supported: true }),
          runAttempt: vi.fn(),
          loadModelCatalog: loadPreparedCatalog,
          readModelCatalogReadiness: () => ({ accountType: "chatgpt" }),
        };
        const preparedRegistry = createEmptyPluginRegistry();
        preparedRegistry.agentHarnesses.push({ pluginId: runtimeId, source: "test", harness });
        const loadActiveCatalog = vi.fn(async () => [entry]);
        const unrelatedActiveRegistry = createEmptyPluginRegistry();
        unrelatedActiveRegistry.agentHarnesses.push({
          pluginId: runtimeId,
          source: "test",
          harness: { ...harness, loadModelCatalog: loadActiveCatalog },
        });
        const previousRegistry = captureActivePluginRegistrySnapshot();
        setActivePluginRegistry(unrelatedActiveRegistry);
        try {
          const preparedSnapshot = {
            ...snapshot,
            agentId: "main",
            agentDir: state.agentDir("main"),
            workspaceDir: state.workspaceDir,
            config: cfg,
            observationConfig: cfg,
            catalogComplete: true,
            authModes: {},
            authStore: { version: 1, profiles: {} },
            metadataSnapshot: preparedMetadataSnapshot(),
            authMaterializations: [],
            pluginRegistry: preparedRegistry,
            isCurrent: () => generationCurrent,
          };
          const loadGatewayModelCatalogSnapshot = vi.fn(async () => preparedSnapshot);
          registerGatewayModelCatalogPrivateAccess(loadGatewayModelCatalogSnapshot, {
            loadDeferred: async () => preparedSnapshot,
            readPrepared: async () => preparedSnapshot,
          });
          const respond = vi.fn();
          const handler = modelsHandlers["models.list"];
          if (!handler) {
            throw new Error("models.list handler missing");
          }

          await handler({
            req: {
              type: "req",
              id: "prepared-registry-models-list",
              method: "models.list",
              params: { agentId: "main", view: "configured" },
            },
            params: { agentId: "main", view: "configured" },
            respond,
            client: null,
            isWebchatConnect: () => false,
            context: {
              getRuntimeConfig: () => cfg,
              loadGatewayModelCatalogSnapshot,
              logGateway: { debug: vi.fn(), warn: vi.fn() },
            } as never,
          });

          expect(preparedRegistry).not.toBe(unrelatedActiveRegistry);
          expect(loadPreparedCatalog).toHaveBeenCalledOnce();
          expect(loadActiveCatalog).not.toHaveBeenCalled();
          expect(respond).toHaveBeenCalledWith(
            true,
            expect.objectContaining({
              models: [
                expect.objectContaining({
                  provider: "custom",
                  id: "native-model",
                  available: expectedAvailable,
                }),
              ],
            }),
            undefined,
          );
        } finally {
          restoreActivePluginRegistrySnapshot(previousRegistry);
        }
      },
    );
  });
});
