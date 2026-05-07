import { afterEach, describe, expect, it, vi } from "vitest";
import { makeRegistry } from "../config/plugin-auto-enable.test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  clearCurrentPluginMetadataSnapshot,
  setCurrentPluginMetadataSnapshot,
} from "./current-plugin-metadata-snapshot.js";
import { resolveInstalledPluginIndexPolicyHash } from "./installed-plugin-index-policy.js";
import type { PluginManifestRegistry } from "./manifest-registry.js";
import type { PluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";

const applyPluginAutoEnableMock = vi.hoisted(() =>
  vi.fn((params: { config?: OpenClawConfig }) => ({
    config: params.config,
    changes: [],
    autoEnabledReasons: {},
  })),
);

vi.mock("../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: applyPluginAutoEnableMock,
}));

import { resolveBundledPluginCompatibleActivationInputs } from "./activation-context.js";

function createPluginMetadataSnapshot(params: {
  config?: OpenClawConfig;
  manifestRegistry: PluginManifestRegistry;
  workspaceDir?: string;
}): PluginMetadataSnapshot {
  const policyHash = resolveInstalledPluginIndexPolicyHash(params.config);
  return {
    policyHash,
    ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
    index: {
      version: 1,
      hostContractVersion: "test",
      compatRegistryVersion: "test",
      migrationVersion: 1,
      policyHash,
      generatedAtMs: 1,
      installRecords: {},
      plugins: [],
      diagnostics: [],
    },
    registryDiagnostics: [],
    manifestRegistry: params.manifestRegistry,
    plugins: params.manifestRegistry.plugins,
    diagnostics: params.manifestRegistry.diagnostics,
    byPluginId: new Map(params.manifestRegistry.plugins.map((plugin) => [plugin.id, plugin])),
    normalizePluginId: (pluginId) => pluginId,
    owners: {
      channels: new Map(),
      channelConfigs: new Map(),
      providers: new Map(),
      modelCatalogProviders: new Map(),
      cliBackends: new Map(),
      setupProviders: new Map(),
      commandAliases: new Map(),
      contracts: new Map(),
    },
    metrics: {
      registrySnapshotMs: 0,
      manifestRegistryMs: 0,
      ownerMapsMs: 0,
      totalMs: 0,
      indexPluginCount: 0,
      manifestPluginCount: params.manifestRegistry.plugins.length,
    },
  };
}

afterEach(() => {
  clearCurrentPluginMetadataSnapshot();
  applyPluginAutoEnableMock.mockClear();
});

describe("resolveBundledPluginCompatibleActivationInputs", () => {
  it("passes the current manifest registry into activation auto-enable", () => {
    const manifestRegistry = makeRegistry([{ id: "openai", channels: [], providers: ["openai"] }]);
    const workspaceDir = "/tmp/openclaw-activation-workspace";
    setCurrentPluginMetadataSnapshot(
      createPluginMetadataSnapshot({
        config: {},
        manifestRegistry,
        workspaceDir,
      }),
      {
        config: {},
        workspaceDir,
      },
    );

    resolveBundledPluginCompatibleActivationInputs({
      rawConfig: { plugins: { allow: ["openai"] } },
      workspaceDir,
      applyAutoEnable: true,
      compatMode: {},
      resolveCompatPluginIds: () => [],
    });

    expect(applyPluginAutoEnableMock).toHaveBeenCalledWith({
      config: { plugins: { allow: ["openai"] } },
      env: process.env,
      manifestRegistry,
    });
  });
});
