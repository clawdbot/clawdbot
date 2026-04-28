import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  clearCurrentPluginMetadataSnapshot,
  getCurrentPluginMetadataSnapshot,
  setCurrentPluginMetadataSnapshot,
} from "./current-plugin-metadata-snapshot.js";
import { resolveInstalledPluginIndexPolicyHash } from "./installed-plugin-index-policy.js";
import { writePersistedInstalledPluginIndexSync } from "./installed-plugin-index-store.js";
import type { PluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";

function createSnapshot(
  params: {
    config?: Parameters<typeof resolveInstalledPluginIndexPolicyHash>[0];
    workspaceDir?: string;
  } = {},
): PluginMetadataSnapshot {
  return {
    policyHash: resolveInstalledPluginIndexPolicyHash(params.config),
    ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
    index: {
      version: 1,
      hostContractVersion: "test",
      compatRegistryVersion: "test",
      migrationVersion: 1,
      policyHash: resolveInstalledPluginIndexPolicyHash(params.config),
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
  };
}

describe("current plugin metadata snapshot", () => {
  it("returns the current snapshot only for matching config policy and workspace", () => {
    const config = { plugins: { allow: ["demo"] } };
    const snapshot = createSnapshot({ config, workspaceDir: "/workspace/a" });
    setCurrentPluginMetadataSnapshot(snapshot, { config });

    expect(getCurrentPluginMetadataSnapshot({ config, workspaceDir: "/workspace/a" })).toBe(
      snapshot,
    );
    expect(getCurrentPluginMetadataSnapshot({ config })).toBeUndefined();
    expect(
      getCurrentPluginMetadataSnapshot({
        config: { plugins: { allow: ["other"] } },
        workspaceDir: "/workspace/a",
      }),
    ).toBeUndefined();
    expect(
      getCurrentPluginMetadataSnapshot({ config, workspaceDir: "/workspace/b" }),
    ).toBeUndefined();
  });

  it("rejects a workspace-scoped snapshot when the caller does not provide workspace scope", () => {
    const config = { plugins: { allow: ["demo"] } };
    const snapshot = createSnapshot({ config, workspaceDir: "/workspace/a" });
    setCurrentPluginMetadataSnapshot(snapshot, { config });

    expect(getCurrentPluginMetadataSnapshot({ config })).toBeUndefined();
  });

  it("rejects a current snapshot when plugin load paths change", () => {
    const config = { plugins: { load: { paths: ["/plugins/one"] } } };
    const snapshot = createSnapshot({ config });
    setCurrentPluginMetadataSnapshot(snapshot, { config });

    expect(getCurrentPluginMetadataSnapshot({ config })).toBe(snapshot);
    expect(
      getCurrentPluginMetadataSnapshot({
        config: { plugins: { load: { paths: ["/plugins/two"] } } },
      }),
    ).toBeUndefined();
  });

  it("keeps source-policy compatibility when storing an auto-enabled runtime config", () => {
    const sourceConfig = { channels: { telegram: { botToken: "token" } } };
    const autoEnabledConfig = {
      ...sourceConfig,
      plugins: { allow: ["telegram"] },
    };
    const snapshot = createSnapshot({ config: sourceConfig });
    setCurrentPluginMetadataSnapshot(snapshot, { config: autoEnabledConfig });

    expect(getCurrentPluginMetadataSnapshot({ config: sourceConfig })).toBe(snapshot);
    expect(getCurrentPluginMetadataSnapshot({ config: autoEnabledConfig })).toBeUndefined();
  });

  it("clears the current snapshot", () => {
    setCurrentPluginMetadataSnapshot(createSnapshot());
    clearCurrentPluginMetadataSnapshot();

    expect(getCurrentPluginMetadataSnapshot()).toBeUndefined();
  });

  it("clears the current snapshot when the persisted installed index changes", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-metadata-"));
    try {
      setCurrentPluginMetadataSnapshot(createSnapshot());

      writePersistedInstalledPluginIndexSync(createSnapshot().index, { stateDir: tempDir });

      expect(getCurrentPluginMetadataSnapshot()).toBeUndefined();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
