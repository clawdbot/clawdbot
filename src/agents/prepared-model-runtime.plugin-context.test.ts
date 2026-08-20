import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPluginMetadataSnapshot,
  makeRegistry,
} from "../config/plugin-auto-enable.test-helpers.js";
import * as currentPluginMetadata from "../plugins/current-plugin-metadata-snapshot.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import * as pluginMetadata from "../plugins/plugin-metadata-snapshot.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  getPreparedPluginRuntimeLoadContext,
  prepareOwnedPluginLoadContext,
} from "./prepared-model-runtime.plugin-context.js";
import { withPreparedPluginGenerationScope } from "./prepared-model-runtime.plugin-generation.js";

describe("prepared model runtime plugin metadata ownership", () => {
  afterEach(() => {
    clearPluginMetadataLifecycleCaches();
  });

  it("uses one explicit Gateway metadata generation across agent workspaces", () => {
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
    const resolveMetadata = vi.spyOn(pluginMetadata, "loadPluginMetadataSnapshot");
    const getCurrentMetadata = vi.spyOn(currentPluginMetadata, "getCurrentPluginMetadataSnapshot");

    try {
      for (const input of inputs) {
        const registry = createEmptyPluginRegistry();
        expect(
          prepareOwnedPluginLoadContext(input, process.env, registry, gatewaySnapshot, true),
        ).toBe(gatewaySnapshot);
        expect(getPreparedPluginRuntimeLoadContext(registry)).toMatchObject({
          metadataSnapshot: gatewaySnapshot,
          preferBuiltPluginArtifacts: true,
        });
        expect(
          withPreparedPluginGenerationScope({ input, pluginGeneration }, (snapshot) => snapshot),
        ).toBe(gatewaySnapshot);
      }
      expect(getCurrentMetadata).not.toHaveBeenCalled();
      expect(resolveMetadata).not.toHaveBeenCalled();
    } finally {
      getCurrentMetadata.mockRestore();
      resolveMetadata.mockRestore();
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
    const resolveMetadata = vi
      .spyOn(pluginMetadata, "resolvePluginMetadataSnapshot")
      .mockReturnValue(directSnapshot);
    const registry = createEmptyPluginRegistry();

    try {
      expect(
        prepareOwnedPluginLoadContext(
          {
            agentDir: "/tmp/direct-agent",
            config,
            workspaceDir,
          },
          process.env,
          registry,
        ),
      ).toBe(directSnapshot);
      expect(getPreparedPluginRuntimeLoadContext(registry)).toMatchObject({
        metadataSnapshot: directSnapshot,
        preferBuiltPluginArtifacts: false,
      });
      expect(resolveMetadata).toHaveBeenCalledWith({
        config,
        env: process.env,
        workspaceDir,
        allowWorkspaceScopedCurrent: true,
      });
    } finally {
      resolveMetadata.mockRestore();
    }
  });

  it("requests selected-runtime metadata for executable prepared probes", () => {
    const config = { plugins: { slots: { memory: "none" as const } } };
    const workspaceDir = "/tmp/selected-runtime-workspace";
    const directSnapshot = createPluginMetadataSnapshot({
      config,
      manifestRegistry: makeRegistry([{ id: "selected", channels: [] }]),
      workspaceDir,
    });
    const resolveMetadata = vi
      .spyOn(pluginMetadata, "resolvePluginMetadataSnapshot")
      .mockReturnValue(directSnapshot);

    try {
      prepareOwnedPluginLoadContext(
        {
          agentDir: "/tmp/selected-runtime-agent",
          config,
          loadRuntimePlugins: true,
          runtimePluginSelections: [{ provider: "selected", modelId: "model" }],
          workspaceDir,
        },
        process.env,
        undefined,
      );

      expect(resolveMetadata).toHaveBeenCalledWith({
        config,
        env: process.env,
        workspaceDir,
        allowWorkspaceScopedCurrent: true,
        pluginIdScope: expect.objectContaining({ key: expect.any(String) }),
      });
    } finally {
      resolveMetadata.mockRestore();
    }
  });
});
