import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isBundledManifestOwner } from "./manifest-owner-policy.js";
import type { PluginKind } from "./plugin-kind.types.js";
import {
  loadPluginMetadataSnapshot,
  type PluginMetadataSnapshot,
} from "./plugin-metadata-snapshot.js";
import { applyExclusiveSlotSelection } from "./slots.js";

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

export async function applySlotSelectionForPlugin(
  config: OpenClawConfig,
  pluginId: string,
  preparedMetadata?: PluginMetadataSnapshot,
  beforeRuntimeInspection?: () => void,
): Promise<{ config: OpenClawConfig; warnings: string[] }> {
  // Selection inspects the install candidate, never the running Gateway's inventory.
  const metadataSnapshot =
    preparedMetadata ??
    loadPluginMetadataSnapshot({
      allowCurrent: false,
      config,
      env: process.env,
    });
  const plugin = metadataSnapshot.plugins.find((entry) => entry.id === pluginId);
  if (!plugin) {
    return { config, warnings: [] };
  }
  const report: SlotSelectionRegistry = { plugins: [plugin] };
  if (!plugin.kind && !isBundledManifestOwner(plugin)) {
    // Bundled manifests own slot declarations. Only legacy external plugins need
    // runtime kind inspection; enabling a bundled non-slot plugin must not execute its module.
    const { buildPluginDiagnosticsReport } = await import("./status.js");
    // Importing diagnostics yields; recheck the install owner before plugin code executes.
    beforeRuntimeInspection?.();
    const runtimeReport = buildPluginDiagnosticsReport({
      config,
      onlyPluginIds: [plugin.id],
      metadataSnapshot,
    });
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
