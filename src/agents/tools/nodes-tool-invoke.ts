import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { listConnectedNodePluginTools } from "../../gateway/node-plugin-tool-snapshot.js";
import { NODE_MCP_TOOLS_CALL_COMMAND } from "../../infra/node-commands.js";
import type { GatewayCallOptions } from "./gateway.js";
import { callGatewayTool } from "./gateway.js";

const DEDICATED_TOOL_INVOKE_COMMANDS = new Map([
  ["computer.act", "computer"],
  ["mobile.ui.observe", "mobile_ui"],
  ["mobile.ui.act", "mobile_ui"],
]);

export async function callNodesToolNodeInvoke<T = Record<string, unknown>>(
  gatewayOpts: GatewayCallOptions,
  params: {
    nodeId: string;
    command: string;
    params?: unknown;
    timeoutMs?: number;
    idempotencyKey: string;
    sessionKey?: string;
  },
  options?: { rawInvoke?: boolean },
): Promise<T> {
  const command = normalizeLowercaseStringOrEmpty(params.command);
  // Node-published agent tools own their model policy. Every Nodes action must
  // stay out of commands omitted from this agent's materialized tool set.
  const dedicatedTool = DEDICATED_TOOL_INVOKE_COMMANDS.get(command);
  const nodePublishedTool = listConnectedNodePluginTools().some(
    (entry) =>
      entry.nodeId === params.nodeId &&
      normalizeLowercaseStringOrEmpty(entry.descriptor.command) === command,
  );
  if (dedicatedTool || command === NODE_MCP_TOOLS_CALL_COMMAND || nodePublishedTool) {
    const guidance = dedicatedTool
      ? `use the dedicated ${dedicatedTool} tool if available; otherwise this command is disabled by tool policy`
      : "use the matching dedicated agent tool if available; otherwise this command is disabled by tool policy";
    throw new Error(
      options?.rawInvoke
        ? `invokeCommand "${params.command}" cannot be invoked through the generic nodes surface; ${guidance}`
        : `node command "${params.command}" cannot be invoked through the Nodes tool; ${guidance}`,
    );
  }
  return await callGatewayTool<T>("node.invoke", gatewayOpts, params);
}
