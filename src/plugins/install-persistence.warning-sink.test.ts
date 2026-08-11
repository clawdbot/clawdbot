import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyExclusiveSlotSelection,
  applyPluginUninstallDirectoryRemoval,
  buildPluginSnapshotReport,
  loadPluginManifestRegistry,
  planPluginUninstall,
  refreshPluginRegistry,
  resetPluginsCliTestState,
  pluginsCliRuntimeLogs,
  setInstalledPluginIndexInstallRecords,
} from "../cli/plugins-cli-test-helpers.js";

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

describe("plugin install persistence warning audiences", () => {
  beforeEach(() => {
    resetPluginsCliTestState();
  });

  it("reports missing required configuration without forwarding informational logs", async () => {
    const { persistPluginInstall } = await import("./install-persistence.js");
    const warn = vi.fn();
    loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "workboard",
          manifestPath: "/tmp/workboard/openclaw.plugin.json",
          configSchema: {
            type: "object",
            required: ["token"],
            properties: { token: { type: "string" } },
          },
        },
      ],
      diagnostics: [],
    });

    const next = await persistPluginInstall({
      snapshot,
      pluginId: "workboard",
      install,
      persistenceLogger: { warn },
    });

    expect(next.plugins?.entries?.workboard).toEqual({ enabled: false });
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      'Installed plugin "workboard" without enabling it because it requires configuration first. Configure it, then run `openclaw plugins enable workboard`.',
    );
    expect(pluginsCliRuntimeLogs).toEqual([
      "Installed plugin: workboard",
      "Restart the gateway to load plugins.",
    ]);
  });

  it("preserves owner-authored exclusive-slot warnings verbatim", async () => {
    const { persistPluginInstall } = await import("./install-persistence.js");
    const warn = vi.fn();
    const warning = 'Exclusive slot "memory" switched from "memory-core" to "workboard".';
    loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "workboard",
          kind: "memory",
          channels: [],
          providers: [],
          cliBackends: [],
          skills: [],
          hooks: [],
          origin: "config",
          rootDir: "/tmp/workboard",
          source: "/tmp/workboard/index.js",
          manifestPath: "/tmp/workboard/openclaw.plugin.json",
        },
      ],
      diagnostics: [],
    });
    applyExclusiveSlotSelection.mockReturnValue({ config: {}, warnings: [warning], changed: true });

    await persistPluginInstall({
      snapshot,
      pluginId: "workboard",
      install,
      persistenceLogger: { warn },
    });

    expect(warn).toHaveBeenCalledExactlyOnceWith(warning);
  });

  it.each(["management", "terminal"] as const)(
    "keeps sensitive install details appropriate for the %s audience",
    async (audience) => {
      const { persistPluginInstall } = await import("./install-persistence.js");
      const warn = vi.fn();
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
      planPluginUninstall.mockReturnValueOnce({
        ok: true,
        config: {},
        pluginId: "workboard",
        actions: {},
        directoryRemoval: { target: "/private/previous-source/workboard" },
      });
      applyPluginUninstallDirectoryRemoval.mockResolvedValueOnce({
        directoryRemoved: false,
        warnings: [cleanupDetail],
      });
      refreshPluginRegistry.mockRejectedValueOnce(new Error(refreshDetail));
      buildPluginSnapshotReport.mockReturnValue({
        plugins: [{ id: "workboard", origin: "config", source: configuredSource }],
        diagnostics: [],
      });

      await persistPluginInstall({
        snapshot,
        pluginId: "workboard",
        install,
        ...(audience === "management" ? { persistenceLogger: { warn } } : {}),
      });

      if (audience === "terminal") {
        expect(warn).not.toHaveBeenCalled();
        expect(pluginsCliRuntimeLogs.join("\n")).toContain(cleanupDetail);
        expect(pluginsCliRuntimeLogs.join("\n")).toContain(refreshDetail);
        expect(pluginsCliRuntimeLogs.join("\n")).toContain(configuredSource);
        expect(pluginsCliRuntimeLogs.join("\n")).toContain(install.installPath);
        return;
      }

      const warnings = warn.mock.calls.map(([message]) => String(message));
      expect(warnings).toHaveLength(3);
      expect(warnings.join("\n")).toContain("previous plugin installation");
      expect(warnings.join("\n")).toContain("registry");
      expect(warnings.join("\n")).toContain("shadowed");
      expect(warnings.join("\n")).not.toContain("/private/");
      expect(warnings.join("\n")).not.toContain("PRIVATE_NPM_MARKER");
      expect(warnings.join("\n")).not.toContain("PRIVATE_REFRESH_MARKER");
      expect(pluginsCliRuntimeLogs).toEqual([
        "Installed plugin: workboard",
        "Restart the gateway to load plugins.",
      ]);
    },
  );
});
