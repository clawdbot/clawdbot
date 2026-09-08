// Text formatter for plugin list rows and verbose plugin details.
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import type { PluginBundleFormat } from "../plugins/manifest-types.js";
import type { PluginRecord } from "../plugins/registry.js";
import { shortenHomeInString } from "../utils.js";

export function formatPluginBundleFormat(bundleFormat: PluginBundleFormat): string {
  return bundleFormat === "agent" ? "agent (Agent Plugins)" : bundleFormat;
}

/** Snapshot status describes enablement; only explicit runtime inspection reports loading. */
export function formatPluginStatus(
  plugin: Pick<PluginRecord, "enabled" | "status">,
  runtimeInspection = false,
): string {
  if (plugin.status === "error") {
    return theme.error("error");
  }
  const enabled = runtimeInspection ? plugin.status === "loaded" : plugin.enabled;
  return enabled ? theme.success(runtimeInspection ? "loaded" : "enabled") : theme.warn("disabled");
}

export function formatPluginLine(plugin: PluginRecord): string {
  const name = theme.command(plugin.name || plugin.id);
  const idSuffix = plugin.name && plugin.name !== plugin.id ? theme.muted(` (${plugin.id})`) : "";
  const format = plugin.format ?? "openclaw";

  const parts = [
    `${name}${idSuffix} ${formatPluginStatus(plugin)}`,
    `  format: ${format}`,
    `  source: ${theme.muted(shortenHomeInString(plugin.source))}`,
    `  origin: ${plugin.origin}`,
  ];
  if (plugin.bundleFormat) {
    parts.push(`  bundle format: ${formatPluginBundleFormat(plugin.bundleFormat)}`);
  }
  if (plugin.bundleCapabilities?.length) {
    parts.push(`  bundle capabilities: ${plugin.bundleCapabilities.join(", ")}`);
  }
  if (plugin.version) {
    parts.push(`  version: ${plugin.version}`);
  }
  if (plugin.activated !== undefined) {
    parts.push(`  activated: ${plugin.activated ? "yes" : "no"}`);
  }
  if (plugin.imported !== undefined) {
    parts.push(`  imported: ${plugin.imported ? "yes" : "no"}`);
  }
  if (plugin.explicitlyEnabled !== undefined) {
    parts.push(`  explicitly enabled: ${plugin.explicitlyEnabled ? "yes" : "no"}`);
  }
  if (plugin.activationSource) {
    parts.push(`  activation source: ${plugin.activationSource}`);
  }
  if (plugin.activationReason) {
    parts.push(`  activation reason: ${sanitizeTerminalText(plugin.activationReason)}`);
  }
  if (plugin.providerIds.length > 0) {
    parts.push(`  providers: ${plugin.providerIds.join(", ")}`);
  }
  if (plugin.activated !== undefined || plugin.activationSource || plugin.activationReason) {
    const activationSummary =
      plugin.activated === false
        ? "inactive"
        : (plugin.activationSource ?? (plugin.activated ? "active" : "inactive"));
    parts.push(`  activation: ${activationSummary}`);
  }
  if (plugin.status === "error" && plugin.error) {
    parts.push(theme.error(`  error: ${plugin.error}`));
  }
  return parts.join("\n");
}
