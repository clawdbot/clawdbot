import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPluginMetadataSnapshot,
  makeRegistry,
} from "../config/plugin-auto-enable.test-helpers.js";
import * as currentPluginMetadata from "../plugins/current-plugin-metadata-snapshot.js";
import * as pluginMetadata from "../plugins/plugin-metadata-collection.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import * as pluginMetadataSnapshot from "../plugins/plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { createPreparedPluginMetadataFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { getPluginRuntimeGenerationRegistry } from "../plugins/runtime/generation-state.js";
import { getPluginRuntimeLoadContext } from "../plugins/runtime/load-context.js";
import { buildPreparedModelCatalogSnapshot } from "./model-catalog.js";
import { prepareOwnedPluginLoadContext } from "./prepared-model-runtime.plugin-context.js";
import { buildPreparedPluginModelCatalog } from "./prepared-model-runtime.plugin-generation.js";
import { AuthStorage, ModelRegistry } from "./sessions/index.js";

vi.mock("./model-catalog.js", { spy: true });

function operationMetadata(
  snapshot: PluginMetadataSnapshot,
): pluginMetadata.PreparedPluginMetadata {
  return createPreparedPluginMetadataFixture({
    unionSnapshot: snapshot,
    agentWorkspaceDirs: new Map(snapshot.workspaceDir ? [["main", snapshot.workspaceDir]] : []),
  });
}

describe("prepared model runtime plugin metadata ownership", () => {
  afterEach(() => {
    clearPluginMetadataLifecycleCaches();
  });

  it("keeps Gateway metadata authoritative across explicit and inherited workspace preparation", async () => {
    const config = { plugins: { allow: ["synthetic"] } };
    const gatewayWorkspace = "/tmp/gateway-plugin-workspace";
    const gatewaySnapshot = createPluginMetadataSnapshot({
      config,
      manifestRegistry: makeRegistry([{ id: "synthetic", channels: [] }]),
      workspaceDir: gatewayWorkspace,
    });
    const inputs = ["first", "second"].map((name) => ({
      agentDir: `/tmp/${name}-agent`,
      config,
      workspaceDir: `/tmp/${name}-workspace`,
    }));
    const pluginGeneration = {
      configuredCatalogEntries: [],
      inlineProviderModels: [],
      pluginMetadataSnapshot: gatewaySnapshot,
    };
    const modelRegistry = ModelRegistry.inMemory(AuthStorage.inMemory({}));
    const prepareMetadata = vi.spyOn(pluginMetadata, "preparePluginMetadata");
    const resolveMetadata = vi.spyOn(pluginMetadataSnapshot, "resolvePluginMetadataSnapshot");
    const getCurrentMetadata = vi.spyOn(currentPluginMetadata, "getCurrentPluginMetadataSnapshot");
    let selectedRegistry = createEmptyPluginRegistry();
    const buildCatalog = vi
      .mocked(buildPreparedModelCatalogSnapshot)
      .mockImplementation(async ({ metadataSnapshot }) => {
        expect(metadataSnapshot).toBe(gatewaySnapshot);
        expect(getPluginRuntimeGenerationRegistry() === selectedRegistry).toBe(true);
        return { entries: [], routeVariants: [] };
      });

    try {
      for (const input of inputs) {
        const registry = createEmptyPluginRegistry();
        selectedRegistry = registry;
        expect(
          prepareOwnedPluginLoadContext(input, process.env, registry, gatewaySnapshot, true),
        ).toBe(gatewaySnapshot);
        expect(getPluginRuntimeLoadContext(registry)).toMatchObject({
          metadataSnapshot: gatewaySnapshot,
          preferBuiltPluginArtifacts: true,
        });
        await buildPreparedPluginModelCatalog({
          agentFacts: { input, credentials: {} },
          catalogMode: "static",
          modelRegistry,
          pluginGeneration: { ...pluginGeneration, pluginRegistry: registry },
        });
      }
      expect(getCurrentMetadata).not.toHaveBeenCalled();
      expect(resolveMetadata).not.toHaveBeenCalled();
      // Nested preparation intentionally reads the inherited scope; the explicit paths above do not.
      for (const input of inputs) {
        expect(
          withPluginRuntimeGenerationScope({ config, metadataSnapshot: gatewaySnapshot }, () =>
            prepareOwnedPluginLoadContext(input, process.env),
          ),
        ).toBe(gatewaySnapshot);
      }
      expect(prepareMetadata).not.toHaveBeenCalled();
    } finally {
      getCurrentMetadata.mockRestore();
      resolveMetadata.mockRestore();
      prepareMetadata.mockRestore();
      buildCatalog.mockRestore();
    }
  });

  it("keeps direct no-current preparation on the requested workspace", () => {
    const config = { plugins: { allow: ["synthetic"] } };
    const workspaceDir = "/tmp/direct-plugin-workspace";
    const directSnapshot = createPluginMetadataSnapshot({
      config,
      manifestRegistry: makeRegistry([{ id: "synthetic", channels: [] }]),
      workspaceDir,
    });
    const prepareMetadata = vi
      .spyOn(pluginMetadata, "preparePluginMetadata")
      .mockReturnValue(operationMetadata(directSnapshot));
    const registry = createEmptyPluginRegistry();

    try {
      expect(
        prepareOwnedPluginLoadContext(
          {
            config,
            workspaceDir,
          },
          process.env,
          registry,
        ),
      ).toBe(directSnapshot);
      expect(getPluginRuntimeLoadContext(registry)).toMatchObject({
        metadataSnapshot: directSnapshot,
        preferBuiltPluginArtifacts: false,
      });
      expect(prepareMetadata).toHaveBeenCalledWith({
        config,
        env: process.env,
        workspaceDir,
      });
    } finally {
      prepareMetadata.mockRestore();
    }
  });

  it("requests selected-runtime metadata for executable prepared probes", () => {
    const config = { plugins: { slots: { memory: "none" as const } } };
    const workspaceDir = "/tmp/selected-runtime-workspace";
    const directSnapshot = createPluginMetadataSnapshot({
      config,
      manifestRegistry: makeRegistry([
        { id: "selected", channels: [] },
        { id: "unrelated", channels: [] },
      ]),
      workspaceDir,
    });
    directSnapshot.index.plugins = directSnapshot.plugins.map((plugin) => ({
      pluginId: plugin.id,
      rootDir: plugin.rootDir,
      manifestPath: plugin.manifestPath,
      manifestHash: "fixture",
      origin: "global",
      enabled: true,
      startup: { sidecar: false, memory: false, agentHarnesses: [] },
      compat: [],
    }));
    const prepareMetadata = vi
      .spyOn(pluginMetadata, "preparePluginMetadata")
      .mockReturnValue(operationMetadata(directSnapshot));

    try {
      const prepared = prepareOwnedPluginLoadContext(
        {
          config,
          loadRuntimePlugins: true,
          runtimePluginSelections: [
            { provider: "selected", modelId: "model", runtime: "openclaw" },
          ],
          workspaceDir,
        },
        process.env,
        undefined,
      );

      expect(prepared.index).toBe(directSnapshot.index);
      expect(prepared.plugins.map((plugin) => plugin.id)).toEqual(["selected"]);
      expect(prepared.pluginIds).toEqual(["selected"]);
    } finally {
      prepareMetadata.mockRestore();
    }
  });
});
