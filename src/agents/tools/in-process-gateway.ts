/** In-process Gateway calls for built-in agent tools. */
import { resolveLeastPrivilegeOperatorScopesForMethod } from "../../gateway/method-scopes.js";
import type { TrustedSessionCreation } from "../../gateway/server-methods/session-creation-provenance.js";
import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";
import {
  dispatchGatewayMethodInProcess,
  getInProcessGatewayRequestContext,
  hasInProcessGatewayContext,
} from "../../gateway/server-plugins.js";
import { runWithGatewaySessionSpawnContext } from "./gateway-session-spawn-context.js";
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
  // The fallback is a real local Gateway request. Carry spawn policy only in
  // the signed agent-runtime identity token, never in model-authored params.
  if (creation.via !== "spawn" || !creation.inheritedToolPolicy) {
    return await callGatewayTool<T>(method, {}, params, { scopes });
  }
  return await runWithGatewaySessionSpawnContext(
    {
      ...(creation.completionOwnerSessionKey
        ? { completionOwnerSessionKey: creation.completionOwnerSessionKey }
        : {}),
      inheritedToolPolicy: creation.inheritedToolPolicy,
    },
    () =>
      callGatewayTool<T>(method, {}, params, {
        scopes,
        requireAgentRuntimeIdentity: true,
      }),
  );
}
