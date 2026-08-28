import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  getCurrentPluginMetadataSnapshot,
  setGatewayPluginMetadataSnapshot,
} from "../current-plugin-metadata-snapshot.js";
import { getGatewayPluginMetadataSnapshot } from "../current-plugin-metadata-state.js";
import { resolveInstalledPluginIndexPolicyHash } from "../installed-plugin-index-policy.js";
import { clearPluginMetadataLifecycleCaches } from "../plugin-metadata-lifecycle.js";
import type { PluginMetadataSnapshot } from "../plugin-metadata-snapshot.types.js";
import { resolvePluginRuntimeLoadContext } from "./load-context.js";

const resolvePluginMetadataSnapshotMock = vi.hoisted(() => vi.fn());

vi.mock("../plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugin-metadata-snapshot.js")>()),
  resolvePluginMetadataSnapshot: resolvePluginMetadataSnapshotMock,
}));

function createSnapshot(params: {
  config: OpenClawConfig;
  workspaceDir: string;
}): PluginMetadataSnapshot {
  const policyHash = resolveInstalledPluginIndexPolicyHash(params.config);
  return {
    policyHash,
    workspaceDir: params.workspaceDir,
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
    manifestRegistry: { plugins: [], diagnostics: [] },
    plugins: [],
    diagnostics: [],
    byPluginId: new Map(),
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
      manifestPluginCount: 0,
    },
    discovery: { candidates: [], diagnostics: [] },
  };
}

describe("plugin runtime load context current snapshot ownership", () => {
  afterEach(() => {
    resolvePluginMetadataSnapshotMock.mockReset();
    clearPluginMetadataLifecycleCaches();
  });

  it("keeps explicit operation metadata from replacing the Gateway startup inventory", () => {
    const lifecycleConfig = { plugins: { allow: ["lifecycle"] } };
    const operationConfig = { plugins: { allow: ["operation"] } };
    const lifecycleWorkspace = "/workspace/lifecycle";
    const operationWorkspace = "/workspace/operation";
    const lifecycleSnapshot = createSnapshot({
      config: lifecycleConfig,
      workspaceDir: lifecycleWorkspace,
    });
    const operationSnapshot = createSnapshot({
      config: operationConfig,
      workspaceDir: operationWorkspace,
    });
    setGatewayPluginMetadataSnapshot(lifecycleSnapshot, {
      config: lifecycleConfig,
      workspaceDir: lifecycleWorkspace,
    });
    const context = resolvePluginRuntimeLoadContext({
      config: operationConfig,
      workspaceDir: operationWorkspace,
      metadataSnapshot: operationSnapshot,
    });

    expect(context.metadataSnapshot).toBe(operationSnapshot);
    expect(resolvePluginMetadataSnapshotMock).not.toHaveBeenCalled();
    expect(getGatewayPluginMetadataSnapshot()).toBe(lifecycleSnapshot);
    expect(
      getCurrentPluginMetadataSnapshot({
        config: lifecycleConfig,
        workspaceDir: lifecycleWorkspace,
      }),
    ).toBe(lifecycleSnapshot);
    expect(
      getCurrentPluginMetadataSnapshot({
        config: operationConfig,
        workspaceDir: operationWorkspace,
      }),
    ).toBe(lifecycleSnapshot);
  });
});
