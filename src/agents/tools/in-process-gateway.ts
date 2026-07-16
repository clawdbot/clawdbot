/** In-process Gateway calls for built-in agent tools. */
import { resolveLeastPrivilegeOperatorScopesForMethod } from "../../gateway/method-scopes.js";
import {
  dispatchGatewayMethodInProcess,
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
