import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { recordInstalledPluginIndexInstallOwner } from "./installed-plugin-index-install-owner.js";
import type { InstalledPluginIndex, InstalledPluginIndexRecord } from "./installed-plugin-index.js";
import {
  capturePluginPackageUpdateSnapshot,
  pluginPackageUpdateMayMutateConfig,
  reconcilePluginPackageUpdateConfig,
} from "./plugin-package-update.js";

function record(
  pluginId: string,
  rootDir: string,
  contributions: { channels?: string[]; channelConfigs?: string[] } = {},
): InstalledPluginIndexRecord {
  return recordInstalledPluginIndexInstallOwner(
    {
      pluginId,
      manifestPath: `${rootDir}/openclaw.plugin.json`,
      manifestHash: pluginId,
      source: `${rootDir}/${pluginId.split("/").at(-1)}.js`,
      rootDir,
      origin: "global",
      enabled: true,
      startup: { sidecar: false, memory: false, agentHarnesses: [] },
      contributions: {
        channels: contributions.channels ?? [],
        channelConfigs: contributions.channelConfigs ?? [],
        providers: [],
        modelCatalogProviders: [],
        modelSupportPrefixes: [],
        modelSupportPatterns: [],
        autoEnableProviderIds: [],
        commandAliases: [],
        contracts: {},
      },
      compat: [],
    },
    "pack",
  );
}

function index(rootDir: string, plugins: InstalledPluginIndexRecord[]): InstalledPluginIndex {
  return {
    version: 1,
    hostContractVersion: "test",
    compatRegistryVersion: "test",
    migrationVersion: 1,
    policyHash: "test",
    generatedAtMs: 1,
    installRecords: {
      pack: { source: "npm", installPath: rootDir, spec: "@openclaw/pack@latest" },
    },
    plugins,
    diagnostics: [],
  };
}

describe("plugin package update policy reconciliation", () => {
  it("removes retired child policy while preserving retained, new, and unrelated state", () => {
    const beforeRoot = "/packages/pack-v1";
    const afterRoot = "/packages/pack-v2";
    const before = index(beforeRoot, [
      record("pack/one", beforeRoot, { channels: ["shared"] }),
      record("pack/two", beforeRoot, { channels: ["two-channel", "shared"] }),
      record("pack/old", beforeRoot, { channelConfigs: ["old-config"] }),
    ]);
    const after = index(afterRoot, [
      record("pack/one", afterRoot, { channels: ["shared"] }),
      record("pack/renamed", afterRoot),
    ]);
    const snapshot = capturePluginPackageUpdateSnapshot({
      index: before,
      installOwners: ["pack"],
    });
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) {
      throw new Error(snapshot.error);
    }
    const config: OpenClawConfig = {
      plugins: {
        allow: ["pack/one", "pack/two", "pack/old", "other"],
        deny: ["pack/two", "pack/old", "other-denied"],
        entries: {
          "pack/one": { enabled: true },
          "pack/two": { enabled: false },
          "pack/old": { enabled: true },
          other: { enabled: true },
        },
        load: {
          paths: [`${beforeRoot}/two.js`, `${beforeRoot}/old.js`, "/plugins/unrelated.js"],
        },
        slots: { memory: "pack/two", contextEngine: "pack/old" },
      },
      channels: {
        "two-channel": { enabled: true },
        "old-config": { enabled: true },
        shared: { enabled: true },
        discord: { enabled: true },
      },
    };

    const result = reconcilePluginPackageUpdateConfig({
      config,
      beforeIndex: before,
      afterIndex: after,
      snapshot: snapshot.value,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error);
    }
    expect(result.config.plugins).toEqual({
      allow: ["pack/one", "other"],
      deny: ["other-denied"],
      entries: { "pack/one": { enabled: true }, other: { enabled: true } },
      load: { paths: ["/plugins/unrelated.js"] },
      slots: { memory: "memory-core", contextEngine: "legacy" },
    });
    expect(result.config.channels).toEqual({
      shared: { enabled: true },
      discord: { enabled: true },
    });
  });

  it("fails closed when the replacement package has no authoritative child rows", () => {
    const before = index("/packages/pack-v1", [record("pack/one", "/packages/pack-v1")]);
    const snapshot = capturePluginPackageUpdateSnapshot({
      index: before,
      installOwners: ["pack"],
    });
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) {
      throw new Error(snapshot.error);
    }
    const result = reconcilePluginPackageUpdateConfig({
      config: { plugins: { entries: { "pack/one": { enabled: true } } } },
      beforeIndex: before,
      afterIndex: index("/packages/pack-v2", []),
      snapshot: snapshot.value,
    });
    expect(result).toMatchObject({ ok: false });
  });

  it("detects exact child load-path cleanup before an update starts", () => {
    const rootDir = "/packages/pack-v1";
    const before = index(rootDir, [record("pack/one", rootDir)]);
    const snapshot = capturePluginPackageUpdateSnapshot({
      index: before,
      installOwners: ["pack"],
    });
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) {
      throw new Error(snapshot.error);
    }
    expect(
      pluginPackageUpdateMayMutateConfig({
        config: { plugins: { load: { paths: [`${rootDir}/one.js`] } } },
        index: before,
        snapshot: snapshot.value,
      }),
    ).toBe(true);
  });
});
