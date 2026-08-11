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
import { runWithGatewaySessionSpawnContext } from "./gateway-session-spawn-context.js";
import { callGatewayTool } from "./gateway.js";

export type InProcessGatewayCaller = <T = Record<string, unknown>>(
  method: string,
  params: Record<string, unknown>,
) => Promise<T>;

type AgentToolGatewayRequest = Pick<
  CallGatewayOptions,
  | "config"
  | "expectFinal"
  | "method"
  | "onAccepted"
  | "onSignalAbort"
  | "params"
  | "signal"
  | "scopes"
  | "timeoutMs"
>;

export type AgentToolGatewayRequestCaller = <T = Record<string, unknown>>(
  request: AgentToolGatewayRequest,
) => Promise<T>;

const DEFAULT_IN_PROCESS_GATEWAY_REQUEST_TIMEOUT_MS = 10_000;

export function hasInProcessGatewayToolContext(): boolean {
  return hasInProcessGatewayContext();
}

export function getInProcessGatewayToolContext(): GatewayRequestContext | undefined {
  return getInProcessGatewayRequestContext();
}

/**
 * Dispatches a request-shaped built-in tool call through the local Gateway
 * router without opening a loopback transport. Outside a Gateway process, the
 * same request falls back to the ordinary Gateway client.
 */
export const callAgentToolGatewayRequest: AgentToolGatewayRequestCaller = async <T>(
  request: AgentToolGatewayRequest,
): Promise<T> => {
  if (!hasInProcessGatewayContext()) {
    const { callGateway } = await import("../../gateway/call.js");
    return await callGateway<T>(request);
  }
  const scopes =
    request.scopes ?? resolveLeastPrivilegeOperatorScopesForMethod(request.method, request.params);
  const timeoutMs =
    request.timeoutMs === null
      ? undefined
      : (request.timeoutMs ?? DEFAULT_IN_PROCESS_GATEWAY_REQUEST_TIMEOUT_MS);
  const dispatchOptions = {
    forceSyntheticClient: true,
    syntheticScopes: scopes,
    ...(request.expectFinal !== undefined ? { expectFinal: request.expectFinal } : {}),
    ...(request.onAccepted ? { onAccepted: request.onAccepted } : {}),
    ...(request.onSignalAbort
      ? {
          onSignalAbort: () =>
            request.onSignalAbort?.((method, params, options) =>
              callAgentToolGatewayRequest({ method, params, ...options }),
            ),
        }
      : {}),
    ...(request.signal ? { signal: request.signal } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
  return await dispatchGatewayMethodInProcess<T>(
    request.method,
    (request.params ?? {}) as Record<string, unknown>,
    dispatchOptions,
  );
};

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
