import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginKind } from "./plugin-kind.types.js";
import { loadPluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";
import { applyExclusiveSlotSelection } from "./slots.js";
import { buildPluginDiagnosticsReport } from "./status.js";

type SlotSelectionPlugin = {
  id: string;
  kind?: PluginKind | PluginKind[];
};

type SlotSelectionRegistry = {
  plugins: SlotSelectionPlugin[];
};

function mergeRuntimeKinds(
  report: SlotSelectionRegistry,
  runtimeReport: SlotSelectionRegistry,
): SlotSelectionRegistry {
  const runtimeKinds = new Map(
    runtimeReport.plugins
      .filter((plugin) => plugin.kind)
      .map((plugin) => [plugin.id, plugin.kind] as const),
  );
  return {
    plugins: report.plugins.map((plugin) => {
      if (plugin.kind) {
        return plugin;
      }
      const runtimeKind = runtimeKinds.get(plugin.id);
      return runtimeKind ? { ...plugin, kind: runtimeKind } : plugin;
    }),
  };
}

function loadRuntimeKindReportForPlugins(config: OpenClawConfig, pluginIds: readonly string[]) {
  return buildPluginDiagnosticsReport({
    config,
    onlyPluginIds: [...pluginIds],
  });
}

function buildSlotSelectionRegistry(
  config: OpenClawConfig,
  pluginId: string,
): SlotSelectionRegistry {
  const plugins = loadPluginMetadataSnapshot({
    config,
    env: process.env,
  }).plugins.filter((plugin) => plugin.id === pluginId);
  return {
    plugins: plugins.map((plugin) => ({
      id: plugin.id,
      kind: plugin.kind,
    })),
  };
}

export function applySlotSelectionForPlugin(
  config: OpenClawConfig,
  pluginId: string,
): { config: OpenClawConfig; warnings: string[] } {
  // Static metadata is preferred; runtime diagnostics fill in kind for older manifests.
  const report = buildSlotSelectionRegistry(config, pluginId);
  const plugin = report.plugins.find((entry) => entry.id === pluginId);
  if (!plugin) {
    return { config, warnings: [] };
  }
  if (!plugin.kind) {
    const runtimeReport = loadRuntimeKindReportForPlugins(config, [plugin.id]);
    const runtimePlugin = runtimeReport.plugins.find((entry) => entry.id === plugin.id);
    if (runtimePlugin?.kind) {
      const result = applyExclusiveSlotSelection({
        config,
        selectedId: runtimePlugin.id,
        selectedKind: runtimePlugin.kind,
        registry: mergeRuntimeKinds(report, runtimeReport),
      });
      return { config: result.config, warnings: result.warnings };
    }
  }
  const result = applyExclusiveSlotSelection({
    config,
    selectedId: plugin.id,
    selectedKind: plugin.kind,
    registry: report,
  });
  return { config: result.config, warnings: result.warnings };
}
