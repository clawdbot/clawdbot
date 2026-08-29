// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  getPreparedModelRuntimeMocks,
  resetPreparedModelRuntimeHarness,
} from "./prepared-model-runtime.test-harness.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  acquireAgentRunPreparedModelRuntime,
  loadPublishedGatewayReplyDispatchRuntime,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";

const mocks = getPreparedModelRuntimeMocks();

describe("prepared model runtime selected route generation", () => {
  beforeEach(() => {
    resetPreparedModelRuntimeHarness();
  });

  it("coalesces a selected Codex route outside a Grok-primary generation and rejects it after reload", async () => {
    // This mirrors run-orchestrator's production shape: the gateway publishes its Grok-primary
    // generation, then a Worker turn explicitly selects Sol with no configured fallback route.
    mocks.configuredAgentIds = ["worker"];
    const config = {
      agents: {
        defaults: {
          model: "xai/grok-4.6",
          models: {
            "openai/gpt-5.6-sol": { agentRuntime: { id: "codex" } },
          },
        },
        entries: { worker: { model: "xai/grok-4.6", fallbackModels: [] } },
      },
    };
    mocks.loadAgentRuntimePluginRegistryHandle.mockImplementation(() =>
      createEmptyPluginRegistry(),
    );
    await refreshPreparedModelRuntimeSnapshots(config, {
      allowGatewaySubagentBinding: true,
      catalogMode: "static",
      gatewayLifecycle: true,
    });
    const admitted = await loadPublishedGatewayReplyDispatchRuntime({ agentId: "worker" });
    expect(admitted?.pluginGeneration).toBeDefined();
    const registryLoadsBeforeSelectedTurn =
      mocks.loadAgentRuntimePluginRegistryHandle.mock.calls.length;
    const staticCatalogBuildsBeforeSelectedTurn =
      mocks.prepareStaticCatalog.mock.calls.length;
    const selectedSolInput = {
      agentId: "worker",
      agentDir: "/tmp/configured-worker",
      allowGatewaySubagentBinding: true,
      config,
      // The exact subscription route that model resolution needs to materialize.
      runtimePluginSelections: [
        {
          provider: "openai",
          modelId: "gpt-5.6-sol",
          runtime: "codex",
          agentId: "worker",
        },
      ],
      workspaceDir: "/tmp/workspace-worker",
    };
    let releaseSelectedCatalog!: () => void;
    const selectedCatalogGate = new Promise<void>((resolve) => {
      releaseSelectedCatalog = resolve;
    });
    mocks.prepareStaticCatalog.mockImplementationOnce(async () => {
      await selectedCatalogGate;
      return { entries: [], routeVariants: [] };
    });
    const pendingSelected = acquireAgentRunPreparedModelRuntime(selectedSolInput, {
      catalogMode: "static",
      pluginGeneration: admitted!.pluginGeneration,
    });
    await vi.waitFor(() =>
      expect(mocks.prepareStaticCatalog).toHaveBeenCalledTimes(
        staticCatalogBuildsBeforeSelectedTurn + 1,
      ),
    );
    const matchingPendingSelected = acquireAgentRunPreparedModelRuntime(selectedSolInput, {
      catalogMode: "static",
      pluginGeneration: admitted!.pluginGeneration,
    });
    releaseSelectedCatalog();
    const [selected, matchingSelected] = await Promise.all([
      pendingSelected,
      matchingPendingSelected,
    ]);
    expect(selected.snapshot.metadataSnapshot).toBe(
      admitted!.pluginGeneration.pluginMetadataSnapshot,
    );
    expect(matchingSelected.snapshot).toBe(selected.snapshot);
    expect(selected.snapshot.pluginRegistry).not.toBe(admitted!.pluginGeneration.pluginRegistry);
    expect(mocks.loadAgentRuntimePluginRegistryHandle).toHaveBeenCalledTimes(
      registryLoadsBeforeSelectedTurn + 1,
    );
    expect(
      mocks.loadAgentRuntimePluginRegistryHandle.mock.calls.map(
        ([params]) => params.selections,
      ),
    ).toContainEqual([
      { provider: "openai", modelId: "gpt-5.6-sol", runtime: "codex" },
    ]);
    expect(
      mocks.loadAgentRuntimePluginRegistryHandle.mock.calls.at(-1)?.[0].metadataSnapshot,
    ).toBe(admitted!.pluginGeneration.pluginMetadataSnapshot);
    selected.release();
    matchingSelected.release();

    const repeatedSelected = await acquireAgentRunPreparedModelRuntime(selectedSolInput, {
      catalogMode: "static",
      pluginGeneration: admitted!.pluginGeneration,
    });
    expect(repeatedSelected.snapshot).toBe(selected.snapshot);
    expect(mocks.loadAgentRuntimePluginRegistryHandle).toHaveBeenCalledTimes(
      registryLoadsBeforeSelectedTurn + 1,
    );
    repeatedSelected.release();

    const refreshedConfig = { ...config, messages: { responsePrefix: "reloaded" } };
    await refreshPreparedModelRuntimeSnapshots(refreshedConfig, {
      allowGatewaySubagentBinding: true,
      catalogMode: "static",
      gatewayLifecycle: true,
    });
    await expect(
      acquireAgentRunPreparedModelRuntime(selectedSolInput, {
        catalogMode: "static",
        pluginGeneration: admitted!.pluginGeneration,
      }),
    ).rejects.toThrow("plugin generation was superseded");
  });
});
