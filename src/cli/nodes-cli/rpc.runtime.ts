// Runtime gateway RPC helpers for node host and node pairing CLI commands.
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import { callGateway } from "../../gateway/call.js";
import type { OperatorScope } from "../../gateway/method-scopes.js";
import { parseTimeoutMsWithFallback } from "../parse-timeout.js";
import { withProgress } from "../progress.js";
import type { NodesRpcOpts } from "./types.js";

const NODE_PAIR_APPROVAL_GATEWAY_METHODS = new Set<string>(["node.pair.list", "node.pair.approve"]);
const DEFAULT_NODES_RPC_TIMEOUT_MS = 10_000;

function resolveNodesTransportTimeoutMs(opts: NodesRpcOpts, overrideMs?: number): number {
  return overrideMs ?? parseTimeoutMsWithFallback(opts.timeout, DEFAULT_NODES_RPC_TIMEOUT_MS);
}

export async function callGatewayCliRuntime(
  method: string,
  opts: NodesRpcOpts,
  params?: unknown,
  callOpts?: { transportTimeoutMs?: number },
) {
  // Progress is suppressed for JSON callers so stdout remains structured.
  return await withProgress(
    {
      label: `Nodes ${method}`,
      indeterminate: true,
      enabled: opts.json !== true,
    },
    async () =>
      await callGateway({
        url: opts.url,
        token: opts.token,
        method,
        params,
        timeoutMs: resolveNodesTransportTimeoutMs(opts, callOpts?.transportTimeoutMs),
        clientName: GATEWAY_CLIENT_NAMES.CLI,
        mode: GATEWAY_CLIENT_MODES.CLI,
      }),
  );
}

export async function callNodePairApprovalGatewayCliRuntime(
  method: "node.pair.list" | "node.pair.approve",
  opts: NodesRpcOpts,
  params: unknown,
  callOpts: { scopes: OperatorScope[]; transportTimeoutMs?: number },
) {
  if (!NODE_PAIR_APPROVAL_GATEWAY_METHODS.has(method)) {
    throw new Error(`unsupported node pair approval gateway method: ${method}`);
  }
  // Node approval may need the local gateway's backend shared-auth authority
  // before the CLI device has been granted the node's required operator scopes.
  return await withProgress(
    {
      label: `Nodes ${method}`,
      indeterminate: true,
      enabled: opts.json !== true,
    },
    async () =>
      await callGateway({
        url: opts.url,
        token: opts.token,
        method,
        params,
        timeoutMs: resolveNodesTransportTimeoutMs(opts, callOpts.transportTimeoutMs),
        clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
        mode: GATEWAY_CLIENT_MODES.BACKEND,
        scopes: callOpts.scopes,
      }),
  );
}
