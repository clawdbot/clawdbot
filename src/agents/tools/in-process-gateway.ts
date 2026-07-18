/** In-process Gateway calls for built-in agent tools. */
import { resolveLeastPrivilegeOperatorScopesForMethod } from "../../gateway/method-scopes.js";
import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";
import {
  dispatchGatewayMethodInProcess,
  getInProcessGatewayRequestContext,
  hasInProcessGatewayContext,
} from "../../gateway/server-plugins.js";
import { callGatewayTool } from "./gateway.js";

export type InProcessGatewayCaller = <T = Record<string, unknown>>(
  method: string,
  params: Record<string, unknown>,
) => Promise<T>;

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
