/** In-process Gateway calls for built-in agent tools. */
import type { CallGatewayOptions } from "../../gateway/call.js";
import { resolveLeastPrivilegeOperatorScopesForMethod } from "../../gateway/method-scopes.js";
import type { TrustedSessionCreation } from "../../gateway/server-methods/session-creation-provenance.js";
import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";
import {
  dispatchGatewayMethodInProcess,
  getInProcessGatewayRequestContext,
  hasInProcessGatewayContext,
} from "../../gateway/server-plugins.js";
import { isNoAgentRunApprovalHost, type AgentRunApprovalHost } from "../agent-run-approval.js";
import { callGatewayTool } from "./gateway.js";

export type InProcessGatewayCaller = <T = Record<string, unknown>>(
  method: string,
  params: Record<string, unknown>,
) => Promise<T>;

type GatewayCaller = <T = Record<string, unknown>>(opts: CallGatewayOptions) => Promise<T>;

export function hasInProcessGatewayToolContext(): boolean {
  return hasInProcessGatewayContext();
}

export function getInProcessGatewayToolContext(): GatewayRequestContext | undefined {
  return getInProcessGatewayRequestContext();
}

export const callInProcessGatewayTool: InProcessGatewayCaller = async <T>(
  method: string,
  params: Record<string, unknown>,
): Promise<T> => {
  const scopes = resolveLeastPrivilegeOperatorScopesForMethod(method, params);
  if (hasInProcessGatewayContext()) {
    return await dispatchGatewayMethodInProcess<T>(method, params, {
      forceSyntheticClient: true,
      syntheticScopes: scopes,
    });
  }
  return await callGatewayTool<T>(method, {}, params, { scopes });
};

export async function callInProcessGatewayToolWithCreation<T = Record<string, unknown>>(
  method: string,
  params: Record<string, unknown>,
  creation: TrustedSessionCreation,
): Promise<T> {
  const scopes = resolveLeastPrivilegeOperatorScopesForMethod(method, params);
  if (hasInProcessGatewayContext()) {
    return await dispatchGatewayMethodInProcess<T>(method, params, {
      forceSyntheticClient: true,
      sessionCreation: creation,
      syntheticScopes: scopes,
    });
  }
  // The fallback is a real Gateway request; trusted creation metadata never crosses the wire.
  return await callGatewayTool<T>(method, {}, params, { scopes });
}

export async function callAgentGatewayWithApprovalHost<T = Record<string, unknown>>(params: {
  request: CallGatewayOptions & { method: "agent"; params: Record<string, unknown> };
  callGateway: GatewayCaller;
  approvalHost?: AgentRunApprovalHost;
}): Promise<T> {
  const hasLiveApprovalHost =
    params.approvalHost !== undefined && !isNoAgentRunApprovalHost(params.approvalHost);
  const requestParams = hasLiveApprovalHost
    ? params.request.params
    : { ...params.request.params, approvalHostMode: "none" as const };
  const scopes =
    params.request.scopes ??
    resolveLeastPrivilegeOperatorScopesForMethod(params.request.method, requestParams);

  if (hasInProcessGatewayContext()) {
    return await dispatchGatewayMethodInProcess<T>(params.request.method, requestParams, {
      ...(hasLiveApprovalHost ? { agentRunApprovalHost: params.approvalHost } : {}),
      ...(params.request.expectFinal !== undefined
        ? { expectFinal: params.request.expectFinal }
        : {}),
      forceSyntheticClient: true,
      ...(params.request.onAccepted ? { onAccepted: params.request.onAccepted } : {}),
      ...(params.request.signal ? { signal: params.request.signal } : {}),
      syntheticScopes: scopes,
      ...(typeof params.request.timeoutMs === "number"
        ? { timeoutMs: params.request.timeoutMs }
        : {}),
    });
  }
  if (hasLiveApprovalHost) {
    throw new Error("Process-local approval hosts cannot cross the Gateway transport.");
  }
  return await params.callGateway<T>({
    ...params.request,
    params: requestParams,
    scopes,
  });
}
