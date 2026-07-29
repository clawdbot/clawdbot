// Qqbot plugin module implements state behavior.
import type { ApproveRuntimeGetter, CommandsPort } from "../../adapter/commands.port.js";

let resolveVersionGetter: () => string = () => "unknown";
let approveRuntimeGetter: ApproveRuntimeGetter | null = null;
let PLUGIN_VERSION = "unknown";

/**
 * Initialize command dependencies from the EngineAdapters.commands port.
 * Called once by the bridge layer during startup.
 */
export function initSlashCommandDeps(port: CommandsPort): void {
  resolveVersionGetter = port.resolveVersion;
  PLUGIN_VERSION = port.pluginVersion;
  approveRuntimeGetter = port.approveRuntimeGetter ?? null;
}

export function resolveRuntimeServiceVersion(): string {
  return resolveVersionGetter();
}

export function getPluginVersionString(): string {
  return PLUGIN_VERSION;
}

export function getFrameworkVersionString(): string {
  return resolveVersionGetter();
}

export function getApproveRuntimeGetter(): ApproveRuntimeGetter | null {
  return approveRuntimeGetter;
}
