/** Provides plugin CLI node APIs by forwarding calls to the Gateway. */
import { randomUUID } from "node:crypto";
import { addTimerTimeoutGraceMs } from "@openclaw/normalization-core/number-coercion";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { callGateway } from "../gateway/call.js";
import type { PluginRuntime } from "./runtime/types.js";

/** Adds Gateway timer grace for plugin CLI node invoke calls. */
export function resolvePluginCliNodeInvokeGatewayTimeoutMs(
  timeoutMs: number | undefined,
): number | undefined {
  return typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? addTimerTimeoutGraceMs(timeoutMs)
    : undefined;
}

/** Creates the `runtime.nodes` implementation exposed to CLI plugin code. */
export function createPluginCliGatewayNodesRuntime(): PluginRuntime["nodes"] {
  return {
    async list(params) {
      const payload = await callGateway({
        method: "node.list",
        params: {},
        clientName: GATEWAY_CLIENT_NAMES.CLI,
        mode: GATEWAY_CLIENT_MODES.CLI,
      });
      const nodes = Array.isArray(payload?.nodes) ? payload.nodes : [];
      const filteredNodes =
        params?.connected === true
          ? nodes.filter(
              (node) =>
                node !== null &&
                typeof node === "object" &&
                (node as { connected?: unknown }).connected === true,
            )
          : nodes;
      return {
        nodes: filteredNodes as Awaited<ReturnType<PluginRuntime["nodes"]["list"]>>["nodes"],
      };
    },
    async invoke(params) {
      return await callGateway({
        method: "node.invoke",
        params: {
          nodeId: params.nodeId,
          command: params.command,
          ...(params.params !== undefined && { params: params.params }),
          timeoutMs: params.timeoutMs,
          idempotencyKey: params.idempotencyKey || randomUUID(),
        },
        timeoutMs: resolvePluginCliNodeInvokeGatewayTimeoutMs(params.timeoutMs),
        clientName: GATEWAY_CLIENT_NAMES.CLI,
        mode: GATEWAY_CLIENT_MODES.CLI,
      });
    },
  };
}
