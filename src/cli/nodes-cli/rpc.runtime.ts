import { callGateway } from "../../gateway/call.js";
import type { OperatorScope } from "../../gateway/method-scopes.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../gateway/protocol/client-info.js";
import { withProgress } from "../progress.js";
import type { NodesRpcOpts } from "./types.js";

const NODE_PAIR_APPROVAL_GATEWAY_METHODS = new Set<string>(["node.pair.list", "node.pair.approve"]);

export async function callGatewayCliRuntime(
  method: string,
  opts: NodesRpcOpts,
  params?: unknown,
  callOpts?: { transportTimeoutMs?: number },
) {
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
        timeoutMs: callOpts?.transportTimeoutMs ?? Number(opts.timeout ?? 10_000),
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
        timeoutMs: callOpts.transportTimeoutMs ?? Number(opts.timeout ?? 10_000),
        clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
        mode: GATEWAY_CLIENT_MODES.BACKEND,
        scopes: callOpts.scopes,
      }),
  );
}
