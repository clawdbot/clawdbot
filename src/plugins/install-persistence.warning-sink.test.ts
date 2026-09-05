import { beforeEach, describe, expect, it } from "vitest";
import {
  applyExclusiveSlotSelectionMock,
  applyPluginUninstallDirectoryRemovalMock,
  buildPluginSnapshotReportMock,
  loadPluginManifestRegistryMock,
  planPluginUninstallMock,
  refreshPluginRegistryMock,
  resetPluginsCliTestState,
  pluginsCliRuntimeLogs,
  setInstalledPluginIndexInstallRecords,
} from "../cli/plugins-cli-test-helpers.js";
import { recordPluginManifestInstallOwner } from "./manifest-install-owner.js";

const snapshot = {
  config: {},
  baseHash: "config-1",
  writeOptions: { expectedConfigPath: "/tmp/openclaw.json" },
};

const install = {
  source: "npm" as const,
  spec: "workboard@1.0.0",
  installPath: "/private/managed-source/workboard",
};

describe("plugin install persistence warnings", () => {
  beforeEach(() => {
    resetPluginsCliTestState();
  });

  it("reports missing required configuration without forwarding informational logs", async () => {
    const { persistPluginInstall } = await import("./install-persistence.js");
    loadPluginManifestRegistryMock.mockReturnValue({
      plugins: [
        recordPluginManifestInstallOwner(
          {
            id: "workboard",
            manifestPath: `${install.installPath}/openclaw.plugin.json`,
            configSchema: {
              type: "object",
              required: ["token"],
              properties: { token: { type: "string" } },
            },
          },
          "workboard",
        ),
      ],
      diagnostics: [],
    });

    const { config: next, warnings } = await persistPluginInstall({
      snapshot,
      pluginId: "workboard",
      install,
    });

    expect(next.plugins?.entries?.workboard).toEqual({ enabled: false });
    expect(warnings).toEqual([
      'Installed plugin "workboard" without enabling it because it requires configuration first. Configure it, then run `openclaw plugins enable workboard`.',
    ]);
    expect(pluginsCliRuntimeLogs).toEqual([]);
  });

  it("preserves owner-authored exclusive-slot warnings verbatim", async () => {
    const { persistPluginInstall } = await import("./install-persistence.js");
    const warning = 'Exclusive slot "memory" switched from "memory-core" to "workboard".';
    loadPluginManifestRegistryMock.mockReturnValue({
      plugins: [
        recordPluginManifestInstallOwner(
          {
            id: "workboard",
            kind: "memory",
            channels: [],
            providers: [],
            cliBackends: [],
            skills: [],
            hooks: [],
            origin: "config",
            rootDir: install.installPath,
            source: `${install.installPath}/index.js`,
            manifestPath: `${install.installPath}/openclaw.plugin.json`,
          },
          "workboard",
        ),
      ],
      diagnostics: [],
    });
    applyExclusiveSlotSelectionMock.mockReturnValue({
      config: {},
      warnings: [warning],
      changed: true,
    });

    const { warnings } = await persistPluginInstall({
      snapshot,
      pluginId: "workboard",
      install,
    });

    expect(warnings).toEqual([warning]);
  });

  it("returns actionable warnings without exposing private install diagnostics", async () => {
    const { persistPluginInstall } = await import("./install-persistence.js");
    const cleanupDetail = "npm stderr PRIVATE_NPM_MARKER /private/previous-source/workboard";
    const refreshDetail = "PRIVATE_REFRESH_MARKER /private/registry-source/workboard";
    const configuredSource = "/private/configured-source/workboard/index.js";
    setInstalledPluginIndexInstallRecords({
      workboard: {
        source: "clawhub",
        spec: "clawhub:community/workboard",
        installPath: "/private/previous-source/workboard",
      },
    });
    planPluginUninstallMock.mockReturnValueOnce({
      ok: true,
      config: {},
      pluginId: "workboard",
      actions: {},
      directoryRemoval: { target: "/private/previous-source/workboard" },
    });
    applyPluginUninstallDirectoryRemovalMock.mockResolvedValueOnce({
      directoryRemoved: false,
      warnings: [cleanupDetail],
    });
    refreshPluginRegistryMock.mockRejectedValueOnce(new Error(refreshDetail));
    buildPluginSnapshotReportMock.mockReturnValue({
      plugins: [{ id: "workboard", origin: "config", source: configuredSource }],
      diagnostics: [],
    });

    const { warnings } = await persistPluginInstall({
      snapshot,
      pluginId: "workboard",
      install,
    });

    expect(warnings).toEqual([
      "A previous plugin installation could not be fully cleaned up. Run `openclaw plugins doctor`.",
      "Plugin registry refresh failed. Run `openclaw plugins registry --refresh`.",
      'Installed plugin "workboard" is shadowed by a configured plugin source. Run `openclaw plugins doctor`.',
    ]);
    expect(pluginsCliRuntimeLogs).toEqual([]);
  });
});
