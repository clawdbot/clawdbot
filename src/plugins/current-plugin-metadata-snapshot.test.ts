// Covers current plugin metadata snapshot generation.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  captureCurrentPluginMetadataSnapshotState,
  clearCurrentPluginMetadataSnapshot,
  getCurrentPluginMetadataSnapshot,
  restoreCurrentPluginMetadataSnapshotState,
  setCurrentPluginMetadataSnapshot,
} from "./current-plugin-metadata-snapshot.js";
import { resolveInstalledPluginIndexPolicyHash } from "./installed-plugin-index-policy.js";
import { writePersistedInstalledPluginIndexSync } from "./installed-plugin-index-store.js";
import type { PluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";

function createSnapshot(
  params: {
    config?: Parameters<typeof resolveInstalledPluginIndexPolicyHash>[0];
    pluginIds?: readonly string[];
    registrySource?: PluginMetadataSnapshot["registrySource"];
    workspaceDir?: string;
  } = {},
): PluginMetadataSnapshot {
  return {
    policyHash: resolveInstalledPluginIndexPolicyHash(params.config),
    ...(params.pluginIds !== undefined ? { pluginIds: params.pluginIds } : {}),
    ...(params.registrySource ? { registrySource: params.registrySource } : {}),
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

  it("can opt into reusing the stored workspace scope for unscoped control-plane readers", () => {
    const config = { plugins: { allow: ["demo"] } };
    const snapshot = createSnapshot({ config, workspaceDir: "/workspace/a" });
    setCurrentPluginMetadataSnapshot(snapshot, { config });

    expect(
      getCurrentPluginMetadataSnapshot({
        config,
        allowWorkspaceScopedSnapshot: true,
      }),
    ).toBe(snapshot);
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

  it("rejects configless default-discovery reuse for snapshots created with load paths", () => {
    const config = { plugins: { allow: ["demo"], load: { paths: ["/plugins/one"] } } };
    const snapshot = createSnapshot({ config });
    setCurrentPluginMetadataSnapshot(snapshot, { config });

    expect(
      getCurrentPluginMetadataSnapshot({
        allowWorkspaceScopedSnapshot: true,
        requireDefaultDiscoveryContext: true,
      }),
    ).toBeUndefined();
  });

  it("accepts configless default-discovery reuse for snapshots created without load paths", () => {
    const config = { plugins: { allow: ["demo"] } };
    const snapshot = createSnapshot({ config });
    setCurrentPluginMetadataSnapshot(snapshot, { config });

    expect(
      getCurrentPluginMetadataSnapshot({
        allowWorkspaceScopedSnapshot: true,
        requireDefaultDiscoveryContext: true,
      }),
    ).toBe(snapshot);
  });

  it("rejects configless default-discovery reuse for scoped snapshots", () => {
    const config = { plugins: { allow: ["demo"] } };
    const snapshot = createSnapshot({ config, pluginIds: ["demo"] });
    setCurrentPluginMetadataSnapshot(snapshot, { config });

    expect(getCurrentPluginMetadataSnapshot({ config })).toBeUndefined();
    expect(
      getCurrentPluginMetadataSnapshot({
        allowWorkspaceScopedSnapshot: true,
      }),
    ).toBeUndefined();
  });

  it("requires exact plugin scope when the caller requests scoped reuse", () => {
    const config = { plugins: { allow: ["demo", "other"] } };
    const unscoped = createSnapshot({ config });
    setCurrentPluginMetadataSnapshot(unscoped, { config });

    expect(getCurrentPluginMetadataSnapshot({ config, pluginIds: ["demo"] })).toBeUndefined();

    const scoped = createSnapshot({ config, pluginIds: ["other", "demo"] });
    setCurrentPluginMetadataSnapshot(scoped, { config });

    expect(getCurrentPluginMetadataSnapshot({ config })).toBeUndefined();
    expect(getCurrentPluginMetadataSnapshot({ config, allowScopedSnapshot: true })).toBe(scoped);
    expect(getCurrentPluginMetadataSnapshot({ config, pluginIds: ["demo", "other"] })).toBe(scoped);
    expect(getCurrentPluginMetadataSnapshot({ config, pluginIds: ["demo"] })).toBeUndefined();
  });

  it("requires exact plugin scope when the caller derives scope from the current index", () => {
    const config = { plugins: { allow: ["demo", "other"] } };
    const pluginIdScope = {
      key: "test-scope",
      resolve: () => ["demo", "other"],
    };
    const unscoped = createSnapshot({ config });
    setCurrentPluginMetadataSnapshot(unscoped, { config });

    expect(getCurrentPluginMetadataSnapshot({ config, pluginIdScope })).toBeUndefined();

    const scoped = createSnapshot({ config, pluginIds: ["other", "demo"] });
    setCurrentPluginMetadataSnapshot(scoped, { config });

    expect(getCurrentPluginMetadataSnapshot({ config, pluginIdScope })).toBe(scoped);
  });

  it("reuses exact cached config when env-resolved plugin load paths change before reload", () => {
    const config = { plugins: { load: { paths: ["~/plugins"] } } };
    const snapshot = createSnapshot({ config });
    const snapshotEnv = {
      HOME: "/home/snapshot",
      OPENCLAW_HOME: undefined,
    } as NodeJS.ProcessEnv;
    const requestedEnv = {
      HOME: "/home/requested",
      OPENCLAW_HOME: undefined,
    } as NodeJS.ProcessEnv;
    setCurrentPluginMetadataSnapshot(snapshot, { config, env: snapshotEnv });

    expect(getCurrentPluginMetadataSnapshot({ config, env: snapshotEnv })).toBe(snapshot);
    expect(getCurrentPluginMetadataSnapshot({ config, env: requestedEnv })).toBe(snapshot);
  });

  it("reuses exact cached config when env-resolved plugin roots change before reload", () => {
    const config = {};
    const snapshot = createSnapshot({ config });
    const snapshotEnv = {
      HOME: "/home/snapshot",
      OPENCLAW_HOME: undefined,
    } as NodeJS.ProcessEnv;
    const requestedEnv = {
      HOME: "/home/requested",
      OPENCLAW_HOME: undefined,
    } as NodeJS.ProcessEnv;
    setCurrentPluginMetadataSnapshot(snapshot, { config, env: snapshotEnv });

    expect(getCurrentPluginMetadataSnapshot({ config, env: snapshotEnv })).toBe(snapshot);
    expect(getCurrentPluginMetadataSnapshot({ config, env: requestedEnv })).toBe(snapshot);
  });

  it("reuses exact cached config after in-place policy changes before reload", () => {
    const config = { plugins: { allow: ["demo"] } };
    const snapshot = createSnapshot({ config });
    setCurrentPluginMetadataSnapshot(snapshot, { config });

    expect(getCurrentPluginMetadataSnapshot({ config })).toBe(snapshot);

    config.plugins.allow = ["other"];

    expect(getCurrentPluginMetadataSnapshot({ config })).toBe(snapshot);
  });

  it("reuses exact cached config after in-place load path changes before reload", () => {
    const config = { plugins: { load: { paths: ["/plugins/one"] } } };
    const snapshot = createSnapshot({ config });
    setCurrentPluginMetadataSnapshot(snapshot, { config });

    expect(getCurrentPluginMetadataSnapshot({ config })).toBe(snapshot);

    config.plugins.load.paths.push("/plugins/two");

    expect(getCurrentPluginMetadataSnapshot({ config })).toBe(snapshot);
  });

  it("reuses exact cached config after in-place env root changes before reload", () => {
    const config = {};
    const snapshot = createSnapshot({ config });
    const env = {
      HOME: "/home/snapshot",
      OPENCLAW_HOME: undefined,
    } as NodeJS.ProcessEnv;
    setCurrentPluginMetadataSnapshot(snapshot, { config, env });

    expect(getCurrentPluginMetadataSnapshot({ config, env })).toBe(snapshot);

    env.HOME = "/home/requested";

    expect(getCurrentPluginMetadataSnapshot({ config, env })).toBe(snapshot);
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

  it("accepts explicit compatible configs for gateway runtime reuse", () => {
    const sourceConfig = { channels: { telegram: { botToken: "token" } } };
    const runtimeConfig = {
      ...sourceConfig,
      plugins: { allow: ["telegram"] },
    };
    const snapshot = createSnapshot({ config: sourceConfig, workspaceDir: "/workspace" });
    setCurrentPluginMetadataSnapshot(snapshot, {
      config: sourceConfig,
      compatibleConfigs: [runtimeConfig],
      workspaceDir: "/workspace",
    });

    expect(
      getCurrentPluginMetadataSnapshot({ config: sourceConfig, workspaceDir: "/workspace" }),
    ).toBe(snapshot);
    expect(
      getCurrentPluginMetadataSnapshot({ config: runtimeConfig, workspaceDir: "/workspace" }),
    ).toBe(snapshot);
  });

  it("clears the current snapshot", () => {
    setCurrentPluginMetadataSnapshot(createSnapshot());
    clearCurrentPluginMetadataSnapshot();

    expect(getCurrentPluginMetadataSnapshot()).toBeUndefined();
  });

  it("keeps derived registry snapshots as the current process snapshot", () => {
    const persisted = createSnapshot({ registrySource: "persisted" });
    const derived = createSnapshot({ registrySource: "derived" });
    setCurrentPluginMetadataSnapshot(persisted);
    setCurrentPluginMetadataSnapshot(derived);

    expect(getCurrentPluginMetadataSnapshot()).toBe(derived);
  });

  it("restores a captured current snapshot state", () => {
    const firstConfig = { plugins: { allow: ["first"] } };
    const secondConfig = { plugins: { allow: ["second"] } };
    const first = createSnapshot({ config: firstConfig });
    const second = createSnapshot({ config: secondConfig });
    setCurrentPluginMetadataSnapshot(first, { config: firstConfig });
    const captured = captureCurrentPluginMetadataSnapshotState();

    setCurrentPluginMetadataSnapshot(second, { config: secondConfig });
    restoreCurrentPluginMetadataSnapshotState(captured);

    expect(getCurrentPluginMetadataSnapshot({ config: firstConfig })).toBe(first);
    expect(getCurrentPluginMetadataSnapshot({ config: secondConfig })).toBeUndefined();
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
