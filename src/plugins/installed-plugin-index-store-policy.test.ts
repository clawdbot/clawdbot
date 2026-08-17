import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { recordInstalledPluginIndexInstallOwner } from "./installed-plugin-index-install-owner.js";
import {
  refreshPersistedInstalledPluginIndex,
  writePersistedInstalledPluginIndex,
} from "./installed-plugin-index-store.js";
import type { InstalledPluginIndex } from "./installed-plugin-index.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const tempDirs: string[] = [];
const env = {
  OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
  OPENCLAW_VERSION: "2026.4.25",
  VITEST: "true",
};

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  cleanupTrackedTempDirs(tempDirs);
});

function createIndex(
  installRecords: InstalledPluginIndex["installRecords"] = {},
  plugins: InstalledPluginIndex["plugins"] = [
    {
      pluginId: "demo",
      manifestPath: "/plugins/demo/openclaw.plugin.json",
      manifestHash: "manifest-hash",
      rootDir: "/plugins/demo",
      origin: "global",
      enabled: true,
      startup: { sidecar: false, memory: false, agentHarnesses: [] },
      compat: [],
    },
  ],
): InstalledPluginIndex {
  return {
    version: 1,
    hostContractVersion: "2026.4.25",
    compatRegistryVersion: "compat-v1",
    migrationVersion: 1,
    policyHash: "policy-v1",
    generatedAtMs: 1777118400000,
    installRecords,
    plugins,
    diagnostics: [],
  };
}

describe("installed plugin index policy refresh", () => {
  it("keeps multi-entry installed packages on the policy refresh fast path", async () => {
    const stateDir = makeTrackedTempDir("openclaw-installed-plugin-policy", tempDirs);
    const packageDir = path.join(stateDir, "plugins", "pack");
    fs.mkdirSync(packageDir, { recursive: true });
    const createPackagePlugin = (pluginId: string) =>
      recordInstalledPluginIndexInstallOwner(
        {
          ...createIndex().plugins[0]!,
          pluginId,
          manifestPath: path.join(packageDir, `${pluginId}.json`),
          rootDir: packageDir,
        },
        "pack",
      );
    const installRecords = {
      pack: { source: "git", installPath: packageDir },
    } satisfies InstalledPluginIndex["installRecords"];
    const plugins = [createPackagePlugin("pack/one"), createPackagePlugin("pack/two")];
    await writePersistedInstalledPluginIndex(createIndex(installRecords, plugins), { stateDir });
    const refreshed = await refreshPersistedInstalledPluginIndex({
      reason: "policy-changed",
      stateDir,
      candidates: [],
      installRecords,
      env,
    });
    expect(refreshed.plugins.map((plugin) => plugin.pluginId)).toEqual(["pack/one", "pack/two"]);
  });

  it("keeps orphan install records on the policy refresh fast path", async () => {
    const stateDir = makeTrackedTempDir("openclaw-installed-plugin-policy", tempDirs);
    const orphanPath = path.join(stateDir, "plugins", "removed-orphan");
    const installRecords = {
      orphaned: { source: "path", sourcePath: orphanPath, installPath: orphanPath },
    } satisfies InstalledPluginIndex["installRecords"];
    await writePersistedInstalledPluginIndex(createIndex(installRecords), { stateDir });
    const refreshed = await refreshPersistedInstalledPluginIndex({
      reason: "policy-changed",
      stateDir,
      candidates: [],
      installRecords,
      env,
    });
    expect(refreshed.plugins.map((plugin) => plugin.pluginId)).toEqual(["demo"]);
  });
});
