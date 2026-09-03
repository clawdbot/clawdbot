import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { attachPluginInstallOwnerMigrations } from "./install-transaction.js";
import { recordInstalledPluginIndexInstallOwner } from "./installed-plugin-index-install-owner.js";
import type { InstalledPluginIndex, InstalledPluginIndexRecord } from "./installed-plugin-index.js";

const syncPluginsForUpdateChannelMock = vi.fn();
const updateNpmInstalledPluginsMock = vi.fn();
const loadInstalledPluginIndexMock = vi.fn();
const collectMissingPluginInstallPayloadsMock = vi.fn();

vi.mock("./update.js", () => ({
  syncPluginsForUpdateChannel: (...args: unknown[]) => syncPluginsForUpdateChannelMock(...args),
  updateNpmInstalledPlugins: (...args: unknown[]) => updateNpmInstalledPluginsMock(...args),
}));

vi.mock("./installed-plugin-index.js", () => ({
  loadInstalledPluginIndex: (...args: unknown[]) => loadInstalledPluginIndexMock(...args),
}));

vi.mock("./payload-verification.js", () => ({
  collectMissingPluginInstallPayloads: (...args: unknown[]) =>
    collectMissingPluginInstallPayloadsMock(...args),
}));

const { convergePluginReleaseCohort } = await import("./update-cohort.js");

function pluginRecord(params: {
  pluginId: string;
  installOwner: string;
  rootDir: string;
}): InstalledPluginIndexRecord {
  return recordInstalledPluginIndexInstallOwner(
    {
      pluginId: params.pluginId,
      manifestPath: `${params.rootDir}/openclaw.plugin.json`,
      manifestHash: params.pluginId,
      source: `${params.rootDir}/index.js`,
      rootDir: params.rootDir,
      origin: "global",
      enabled: true,
      startup: { sidecar: false, memory: false, agentHarnesses: [] },
      contributions: {
        channels: ["qqbot"],
        channelConfigs: [],
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
    params.installOwner,
  );
}

function installedIndex(params: {
  records: Record<string, PluginInstallRecord>;
  plugin: InstalledPluginIndexRecord;
}): InstalledPluginIndex {
  return {
    version: 1,
    hostContractVersion: "test",
    compatRegistryVersion: "test",
    migrationVersion: 1,
    policyHash: "test",
    generatedAtMs: 1,
    installRecords: params.records,
    plugins: [params.plugin],
    diagnostics: [],
  };
}

describe("plugin release cohort package reconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    collectMissingPluginInstallPayloadsMock.mockResolvedValue([]);
    syncPluginsForUpdateChannelMock.mockImplementation(async ({ config }) => ({
      config,
      changed: false,
      summary: {
        switchedToBundled: [],
        switchedToClawHub: [],
        switchedToNpm: [],
        warnings: [],
        errors: [],
      },
    }));
  });

  it("removes the legacy load path after a successful post-core owner migration", async () => {
    const legacyRoot = "/plugins/qqbot-legacy";
    const canonicalRoot = "/plugins/openclaw-qqbot";
    const legacyRecords = {
      qqbot: {
        source: "npm",
        spec: "@openclaw/qqbot@1.9.0",
        installPath: legacyRoot,
      },
      "openclaw-qqbot": {
        source: "npm",
        spec: "@tencent-connect/openclaw-qqbot@2.0.1",
        installPath: canonicalRoot,
      },
    } satisfies Record<string, PluginInstallRecord>;
    const canonicalRecords = {
      "openclaw-qqbot": {
        source: "npm",
        spec: "@tencent-connect/openclaw-qqbot@2.0.3",
        installPath: canonicalRoot,
      },
    } satisfies Record<string, PluginInstallRecord>;
    const config = {
      channels: { qqbot: { enabled: true, appId: "app", clientSecret: "secret" } },
      plugins: {
        load: { paths: [legacyRoot, `${legacyRoot}/index.js`, "/plugins/unrelated.js"] },
        installs: legacyRecords,
      },
    } satisfies OpenClawConfig;
    const updatedConfig = {
      ...config,
      plugins: { ...config.plugins, installs: canonicalRecords },
    } satisfies OpenClawConfig;
    loadInstalledPluginIndexMock
      .mockReturnValueOnce(
        installedIndex({
          records: legacyRecords,
          plugin: pluginRecord({ pluginId: "qqbot", installOwner: "qqbot", rootDir: legacyRoot }),
        }),
      )
      .mockReturnValueOnce(
        installedIndex({
          records: canonicalRecords,
          plugin: pluginRecord({
            pluginId: "openclaw-qqbot",
            installOwner: "openclaw-qqbot",
            rootDir: canonicalRoot,
          }),
        }),
      );
    updateNpmInstalledPluginsMock.mockResolvedValueOnce(
      attachPluginInstallOwnerMigrations(
        { config: updatedConfig, changed: true, outcomes: [] },
        { qqbot: "openclaw-qqbot" },
      ),
    );

    const result = await convergePluginReleaseCohort({
      config,
      installRecords: legacyRecords,
      channel: "stable",
      timeoutMs: 60_000,
    });

    expect(result.changed).toBe(true);
    expect(result.config.channels?.qqbot).toEqual(config.channels.qqbot);
    expect(result.config.plugins?.installs).toEqual(canonicalRecords);
    expect(result.config.plugins?.load?.paths).toEqual(["/plugins/unrelated.js"]);
  });
});
