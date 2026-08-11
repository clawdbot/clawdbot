import type { AgentTurnPrincipal } from "./types.js";

/** Resolve host-stamped policy that is never accepted from public agent params. */
export function resolvePluginSubagentDisableTools(client: AgentTurnPrincipal | null): boolean {
  return (
    client?.internal?.agentRunTracking === "plugin_subagent" &&
    client.internal.pluginSubagentDisableTools === true
  );
}
