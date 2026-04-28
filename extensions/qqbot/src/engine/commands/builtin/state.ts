import type { ApproveRuntimeGetter, CommandsPort } from "../../adapter/commands.port.js";

let _resolveVersion: () => string = () => "unknown";
let _approveRuntimeGetter: ApproveRuntimeGetter | null = null;
let PLUGIN_VERSION = "unknown";

/**
 * Initialize command dependencies from the EngineAdapters.commands port.
 * Called once by the bridge layer during startup.
 */
export function initSlashCommandDeps(port: CommandsPort): void {
  _resolveVersion = port.resolveVersion;
  PLUGIN_VERSION = port.pluginVersion;
  _approveRuntimeGetter = port.approveRuntimeGetter ?? null;
}

export function resolveRuntimeServiceVersion(): string {
  return _resolveVersion();
}

export function getPluginVersionString(): string {
  return PLUGIN_VERSION;
}

export function getFrameworkVersionString(): string {
  return _resolveVersion();
}

export function getApproveRuntimeGetter(): ApproveRuntimeGetter | null {
  return _approveRuntimeGetter;
}
