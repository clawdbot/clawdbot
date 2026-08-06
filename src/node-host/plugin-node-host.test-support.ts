import type { PluginRegistry } from "../plugins/registry-types.js";
import "./plugin-node-host.js";

type NodeHostPluginTestApi = {
  getNodeHostPluginRegistry(): PluginRegistry | undefined;
  resetNodeHostPluginRegistry(): void;
};

function getTestApi(): NodeHostPluginTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.nodeHostPluginTestApi")
  ] as NodeHostPluginTestApi;
}

export function getNodeHostPluginRegistry(): PluginRegistry | undefined {
  return getTestApi().getNodeHostPluginRegistry();
}

export function resetNodeHostPluginRegistry(): void {
  getTestApi().resetNodeHostPluginRegistry();
}
