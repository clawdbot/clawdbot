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
        expect(prepareOwnedPluginLoadContext(input, process.env, registry, gatewaySnapshot)).toBe(
          gatewaySnapshot,
        );
        expect(getPreparedPluginRuntimeLoadContext(registry)?.metadataSnapshot).toBe(
          gatewaySnapshot,
        );
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
      .spyOn(pluginMetadata, "loadPluginMetadataSnapshot")
      .mockReturnValue(directSnapshot);

    try {
      expect(
        prepareOwnedPluginLoadContext(
          {
            agentDir: "/tmp/direct-agent",
            config,
            workspaceDir,
          },
          process.env,
          undefined,
        ),
      ).toBe(directSnapshot);
      expect(resolveMetadata).toHaveBeenCalledWith({
        config,
        env: process.env,
        workspaceDir,
      });
    } finally {
      resolveMetadata.mockRestore();
    }
  });
});
