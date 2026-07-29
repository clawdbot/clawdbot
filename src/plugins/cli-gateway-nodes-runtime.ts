/** Provides plugin CLI node APIs by forwarding calls to the Gateway. */
import { randomUUID } from "node:crypto";
import { addTimerTimeoutGraceMs } from "@openclaw/normalization-core/number-coercion";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { normalizeOperatorScopeList } from "../gateway/operator-scopes.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import { getPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";
import type { PluginRuntime } from "./runtime/types.js";

// Help builds plugin CLI registrations but never calls runtime.nodes. Keep the
// live Gateway/TLS graph behind the first node RPC so one-shot help stays inert.
const gatewayCallModuleLoader = createLazyImportLoader(() => import("../gateway/call.js"));

/** Adds Gateway timer grace for plugin CLI node invoke calls. */
function resolvePluginCliNodeInvokeGatewayTimeoutMs(
  timeoutMs: number | undefined,
): number | undefined {
  return typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? addTimerTimeoutGraceMs(timeoutMs)
    : undefined;
}

function canPluginCliRuntimeRequestScopes(): boolean {
  const scope = getPluginRuntimeGatewayRequestScope();
  return Boolean(
    scope?.pluginId &&
    (scope.pluginOrigin === "bundled" || scope.pluginTrustedOfficialInstall === true),
  );
}

function resolvePluginCliRuntimeNodeInvokeScopes(scopes: string[] | undefined) {
  const normalizedScopes = normalizeOperatorScopeList(scopes);
  return normalizedScopes && canPluginCliRuntimeRequestScopes() ? normalizedScopes : undefined;
}

/** Creates the `runtime.nodes` implementation exposed to CLI plugin code. */
export function createPluginCliGatewayNodesRuntime(): PluginRuntime["nodes"] {
  return {
    async list(params) {
      const { callGateway } = await gatewayCallModuleLoader.load();
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
      const { callGateway } = await gatewayCallModuleLoader.load();
      const scopes = resolvePluginCliRuntimeNodeInvokeScopes(params.scopes);
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
        ...(scopes ? { scopes } : {}),
      });
    },
  };
}
