import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import type { PluginRuntime } from "./types.js";

const GATEWAY_SUBAGENT_SYMBOL: unique symbol = Symbol.for(
  "openclaw.plugin.gatewaySubagentRuntime",
) as unknown as typeof GATEWAY_SUBAGENT_SYMBOL;

type GatewaySubagentState = {
  subagent: PluginRuntime["subagent"] | undefined;
  nodes: PluginRuntime["nodes"] | undefined;
};

export const gatewaySubagentState = resolveGlobalSingleton<GatewaySubagentState>(
  GATEWAY_SUBAGENT_SYMBOL,
  () => ({
    subagent: undefined,
    nodes: undefined,
  }),
);

/**
 * Set the process-global gateway subagent runtime.
 * Called during gateway startup so that gateway-bindable plugin runtimes can
 * resolve subagent methods dynamically even when their registry was cached
 * before the gateway finished loading plugins.
 */
export function setGatewaySubagentRuntime(subagent: PluginRuntime["subagent"]): void {
  gatewaySubagentState.subagent = subagent;
}

export function setGatewayNodesRuntime(nodes: PluginRuntime["nodes"]): void {
  gatewaySubagentState.nodes = nodes;
}

/**
 * Reset the process-global gateway subagent runtime.
 * Used by tests to avoid leaking gateway state across module reloads.
 */
export function clearGatewaySubagentRuntime(): void {
  gatewaySubagentState.subagent = undefined;
  gatewaySubagentState.nodes = undefined;
}
