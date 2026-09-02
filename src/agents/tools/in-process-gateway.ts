import type { AgentRuntimeIdentity } from "../../gateway/agent-runtime-identity-token.js";
/** In-process Gateway calls for built-in agent tools. */
import type { CallGatewayOptions } from "../../gateway/call.js";
import { withInProcessAgentRuntimeIdentity } from "../../gateway/in-process-agent-runtime-identity.js";
import { resolveLeastPrivilegeOperatorScopesForMethod } from "../../gateway/method-scopes.js";
import type { TrustedSessionCreation } from "../../gateway/server-methods/session-creation-provenance.js";
import type {
  GatewayAgentRunTaskOwner,
  GatewayContextResolver,
  GatewayRequestContext,
  TrustedAgentToolCaller,
} from "../../gateway/server-methods/types.js";
import {
  dispatchGatewayMethodInProcess,
  getInProcessGatewayRequestContext,
  hasInProcessGatewayContext,
} from "../../gateway/server-plugins.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { getGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import { runWithGatewaySessionSpawnContext } from "./gateway-session-spawn-context.js";
import { callGatewayTool } from "./gateway.js";

type InProcessGatewayCallOptions = {
  resolveGatewayContext?: GatewayContextResolver;
  sessionMutationCommitGuard?: () => void;
};

export type InProcessGatewayCaller = <T = Record<string, unknown>>(
  method: string,
  params: Record<string, unknown>,
  options?: InProcessGatewayCallOptions,
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
> & {
  agentRunTracking?: GatewayAgentRunTaskOwner;
  agentToolCaller?: TrustedAgentToolCaller;
};

const agentToolGatewayRuntimeIdentities = new WeakMap<object, AgentRuntimeIdentity>();

/** Carry trusted runtime identity without making it enumerable or transportable. */
export function withAgentToolGatewayRuntimeIdentity<T extends object>(
  request: T,
  identity: AgentRuntimeIdentity | undefined,
): T {
  if (!identity) {
    return request;
  }
  const carried = { ...request };
  agentToolGatewayRuntimeIdentities.set(carried, identity);
  return carried;
}

export type AgentToolGatewayRequestCaller = <T = Record<string, unknown>>(
  request: AgentToolGatewayRequest,
) => Promise<T>;

const DEFAULT_IN_PROCESS_GATEWAY_REQUEST_TIMEOUT_MS = 10_000;

function callerGatewayContextResolver(
  explicit?: GatewayContextResolver,
): GatewayContextResolver | undefined {
  return explicit ?? getGatewayToolCallerIdentity()?.gatewayContextResolver;
}

function bindInProcessGatewayContext(
  method: string,
  resolveGatewayContext: GatewayContextResolver,
): { assertCurrent: () => void; resolve: GatewayContextResolver } {
  const admittedContext = resolveGatewayContext();
  if (!admittedContext) {
    throw new Error(`Gateway instance unavailable for ${method}`);
  }
  const assertCurrent = () => {
    if (resolveGatewayContext() !== admittedContext) {
      throw new Error(`Gateway instance unavailable for ${method}`);
    }
  };
  return {
    assertCurrent,
    resolve: () => {
      assertCurrent();
      return admittedContext;
    },
  };
}

async function runBoundInProcessGatewayCall<T>(
  boundGateway: ReturnType<typeof bindInProcessGatewayContext> | undefined,
  run: (resolveGatewayContext?: GatewayContextResolver) => Promise<T>,
): Promise<T> {
  try {
    const result = await run(boundGateway?.resolve);
    boundGateway?.assertCurrent();
    return result;
  } catch (error) {
    boundGateway?.assertCurrent();
    throw error;
  }
}

export function hasInProcessGatewayToolContext(): boolean {
  const resolveGatewayContext = callerGatewayContextResolver();
  return resolveGatewayContext ? Boolean(resolveGatewayContext()) : hasInProcessGatewayContext();
}

/** Whether Gateway routing belongs to this caller or the hosting process. */
export function hasGatewayToolRoutingContext(): boolean {
  const resolver =
    callerGatewayContextResolver() ?? getPluginRuntimeGatewayRequestScope()?.resolveGatewayContext;
  const context = getInProcessGatewayRequestContext(resolver);
  // A retired binding still owns routing: dispatch must reject it instead of
  // letting optional Gateway-backed tools switch to standalone host execution.
  return context?.localEmbedded !== true && Boolean(resolver || context);
}

export function getInProcessGatewayToolContext(
  explicitResolver?: GatewayContextResolver,
): GatewayRequestContext | undefined {
  const resolveGatewayContext = callerGatewayContextResolver(explicitResolver);
  return resolveGatewayContext ? resolveGatewayContext() : getInProcessGatewayRequestContext();
}

/**
 * Dispatches a request-shaped built-in tool call through the local Gateway
 * router without opening a loopback transport. Outside a Gateway process, the
 * same request falls back to the ordinary Gateway client.
 */
async function callAgentToolGatewayRequestBound<T>(
  request: AgentToolGatewayRequest,
  resolveGatewayContext: GatewayContextResolver | undefined,
  runtimeIdentity: AgentRuntimeIdentity | undefined,
): Promise<T> {
  const boundGateway = resolveGatewayContext
    ? bindInProcessGatewayContext(request.method, resolveGatewayContext)
    : undefined;
  if (!hasInProcessGatewayContext(boundGateway?.resolve)) {
    if (runtimeIdentity) {
      throw new Error("trusted agent runtime identity requires in-process Gateway dispatch");
    }
    if (boundGateway) {
      throw new Error(`Gateway instance unavailable for ${request.method}`);
    }
    const { callGateway } = await import("../../gateway/call.js");
    const {
      agentRunTracking: _agentRunTracking,
      agentToolCaller: _agentToolCaller,
      ...wireRequest
    } = request;
    return await callGateway<T>(wireRequest);
  }
  const scopes =
    request.scopes ?? resolveLeastPrivilegeOperatorScopesForMethod(request.method, request.params);
  const timeoutMs =
    request.timeoutMs === null
      ? undefined
      : (request.timeoutMs ?? DEFAULT_IN_PROCESS_GATEWAY_REQUEST_TIMEOUT_MS);
  const dispatchOptions = {
    forceSyntheticClient: true,
    ...(request.agentRunTracking ? { agentRunTracking: request.agentRunTracking } : {}),
    ...(request.agentToolCaller ? { agentToolCaller: request.agentToolCaller } : {}),
    syntheticScopes: scopes,
    ...(request.expectFinal !== undefined ? { expectFinal: request.expectFinal } : {}),
    ...(request.onAccepted ? { onAccepted: request.onAccepted } : {}),
    ...(request.onSignalAbort
      ? {
          onSignalAbort: () =>
            request.onSignalAbort?.((method, params, options) =>
              callAgentToolGatewayRequestBound(
                { method, params, ...options },
                boundGateway?.resolve ?? resolveGatewayContext,
                runtimeIdentity,
              ),
            ),
        }
      : {}),
    ...(request.signal ? { signal: request.signal } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(boundGateway ? { resolveGatewayContext: boundGateway.resolve } : {}),
  };
  return await runBoundInProcessGatewayCall(
    boundGateway,
    async () =>
      await dispatchGatewayMethodInProcess<T>(
        request.method,
        (request.params ?? {}) as Record<string, unknown>,
        withInProcessAgentRuntimeIdentity(dispatchOptions, runtimeIdentity),
      ),
  );
}

export const callAgentToolGatewayRequest: AgentToolGatewayRequestCaller = async <T>(
  request: AgentToolGatewayRequest,
): Promise<T> => {
  return await callAgentToolGatewayRequestBound(
    request,
    callerGatewayContextResolver(),
    agentToolGatewayRuntimeIdentities.get(request),
  );
};

async function callInProcessGatewayToolBound<T>(
  method: string,
  params: Record<string, unknown>,
  options: InProcessGatewayCallOptions & {
    sessionCreation?: TrustedSessionCreation;
    signal?: AbortSignal;
    timeoutMs?: number | null;
  },
  fallback: (scopes: ReturnType<typeof resolveLeastPrivilegeOperatorScopesForMethod>) => Promise<T>,
): Promise<T> {
  const scopes = resolveLeastPrivilegeOperatorScopesForMethod(method, params);
  const resolveGatewayContext = callerGatewayContextResolver(options.resolveGatewayContext);
  const boundGateway = resolveGatewayContext
    ? bindInProcessGatewayContext(method, resolveGatewayContext)
    : undefined;
  if (hasInProcessGatewayContext(boundGateway?.resolve)) {
    return await runBoundInProcessGatewayCall(
      boundGateway,
      async (boundResolver) =>
        await dispatchGatewayMethodInProcess<T>(method, params, {
          forceSyntheticClient: true,
          syntheticScopes: scopes,
          ...(options.sessionCreation ? { sessionCreation: options.sessionCreation } : {}),
          ...(options.sessionMutationCommitGuard
            ? { sessionMutationCommitGuard: options.sessionMutationCommitGuard }
            : {}),
          ...(options.signal ? { signal: options.signal } : {}),
          ...(options.timeoutMs !== undefined && options.timeoutMs !== null
            ? { timeoutMs: options.timeoutMs }
            : {}),
          ...(boundResolver ? { resolveGatewayContext: boundResolver } : {}),
        }),
    );
  }
  if (boundGateway) {
    throw new Error(`Gateway instance unavailable for ${method}`);
  }
  return await fallback(scopes);
}

export const callInProcessGatewayTool: InProcessGatewayCaller = async <T>(
  method: string,
  params: Record<string, unknown>,
  options: InProcessGatewayCallOptions = {},
): Promise<T> => {
  return await callInProcessGatewayToolBound(method, params, options, async (scopes) =>
    callGatewayTool<T>(method, {}, params, { scopes }),
  );
};

export async function callInProcessGatewayToolWithCreation<T = Record<string, unknown>>(
  method: string,
  params: Record<string, unknown>,
  creation: TrustedSessionCreation,
  options: {
    resolveGatewayContext?: GatewayContextResolver;
    sessionMutationCommitGuard?: () => void;
    signal?: AbortSignal;
    timeoutMs?: number | null;
  } = {},
): Promise<T> {
  return await callInProcessGatewayToolBound(
    method,
    params,
    { ...options, sessionCreation: creation },
    async (scopes) => {
      // The fallback is a real local Gateway request. Carry spawn policy only in
      // the signed agent-runtime identity token, never in model-authored params.
      if (creation.via !== "spawn" || !creation.inheritedToolPolicy) {
        return await callGatewayTool<T>(method, {}, params, {
          scopes,
          ...(options.signal ? { signal: options.signal } : {}),
          ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        });
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
            ...(options.signal ? { signal: options.signal } : {}),
            ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
          }),
      );
    },
  );
}
