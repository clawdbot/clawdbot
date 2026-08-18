import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { isNodeCommandAllowed, resolveNodeCommandAllowlist } from "./node-command-policy.js";
import type { GatewayContextResolver, GatewayRequestContext } from "./server-methods/types.js";

export function hasInProcessGatewayContext(
  resolveGatewayContext?: GatewayContextResolver,
): boolean {
  return Boolean(getPluginRuntimeGatewayRequestScope()?.context ?? resolveGatewayContext?.());
}

export function projectGatewayRuntimeNodes(
  nodes: unknown[],
  context: GatewayRequestContext | undefined,
): unknown[] {
  return nodes.map((node) => {
    if (
      !node ||
      typeof node !== "object" ||
      Array.isArray(node) ||
      !context?.nodeRegistry?.get ||
      !context.getRuntimeConfig
    ) {
      return node;
    }
    const nodeRecord = node as Record<string, unknown>;
    const nodeId = typeof nodeRecord.nodeId === "string" ? nodeRecord.nodeId : "";
    const liveNode = nodeId ? context.nodeRegistry.get(nodeId) : undefined;
    if (!liveNode) {
      return node;
    }
    const allowlist = resolveNodeCommandAllowlist(context.getRuntimeConfig(), {
      ...liveNode,
      approvedCommands: liveNode.commands,
    });
    const invocableCommands = liveNode.commands.filter(
      (command) =>
        isNodeCommandAllowed({
          command,
          declaredCommands: liveNode.commands,
          allowlist,
        }).ok,
    );
    return Object.assign({}, nodeRecord, { invocableCommands });
  });
}
