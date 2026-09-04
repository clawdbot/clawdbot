import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  ErrorCodes,
  errorShape,
  missingScopeErrorShape,
  type ErrorShape,
} from "../../packages/gateway-protocol/src/index.js";
import {
  GATEWAY_RESTART_UNAVAILABLE_REASON,
  GATEWAY_SUSPEND_UNAVAILABLE_REASON,
} from "../../packages/gateway-protocol/src/restart-unavailable.js";
import {
  gatewayStartupUnavailableDetails,
  GATEWAY_STARTUP_RETRY_AFTER_MS,
} from "../../packages/gateway-protocol/src/startup-unavailable.js";
import { getActivePluginHttpRouteRegistry, getActivePluginRegistry } from "../plugins/runtime.js";
import {
  getPluginRuntimeGatewayRequestScope,
  getPluginRuntimeGatewayNodeAuthorities,
  withPluginRuntimeGatewayRequestScope,
} from "../plugins/runtime/gateway-request-scope.js";
import {
  getGatewaySuspendAdmissionPhase,
  isGatewayRestartDraining,
  tryBeginGatewayPreparedRestartRootWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import { formatControlPlaneActor, resolveControlPlaneActor } from "./control-plane-audit.js";
import {
  consumeControlPlaneWriteBudget,
  CONTROL_PLANE_RATE_LIMIT_MAX_REQUESTS,
  CONTROL_PLANE_RATE_LIMIT_WINDOW_MS,
} from "./control-plane-rate-limit.js";
import {
  ADMIN_SCOPE,
  authorizeOperatorScopesForMethod,
  authorizeOperatorScopesForRequiredScope,
  resolveLeastPrivilegeOperatorScopesForMethod,
} from "./method-scopes.js";
import {
  createCoreGatewayMethodDescriptors,
  createGatewayMethodDescriptorsFromHandlers,
  createGatewayMethodRegistry,
  createPluginGatewayMethodDescriptors,
  isCoreGatewayMethodClassified,
  type GatewayMethodRegistry,
} from "./methods/registry.js";
import { isOperatorScope } from "./operator-scopes.js";
import { isRoleAuthorizedForMethod, parseGatewayRole } from "./role-policy.js";
import { coreGatewayHandlers } from "./server-methods/core-handlers.js";
import { authenticatedProfileUnavailableError } from "./server-methods/gateway-client-identity.js";
import { prepareGatewayRequestHandler } from "./server-methods/lazy-core-handlers.js";
import { isTargetedNonSafeGatewayRestartRequest } from "./server-methods/restart-request.js";
import { withSessionMutationCommitGuard } from "./server-methods/session-mutation-guards.js";
import type {
  GatewayRequestContext,
  GatewayRequestHandler,
  GatewayRequestHandlers,
  GatewayRequestOptions,
  SessionMutationAuthorization,
} from "./server-methods/types.js";
import type { GatewayRequestEntry } from "./server-request-entry.js";
import type { GatewayRpcDiagnostics } from "./server/ws-connection/request-diagnostics.js";
import { sessionMutationTargetFields } from "./session-method-policy.js";
import { resolveDirectIncognitoTargets } from "./session-sharing-target-input.js";
import {
  resolveSessionMutationAuthorization,
  SessionMutationAuthorizationChangedError,
} from "./session-sharing.js";
import { classifyGatewayStaleInstall } from "./stale-install.js";

export { coreGatewayHandlers };

function authorizeGatewayMethod(
  method: string,
  client: GatewayRequestOptions["client"],
  params: unknown,
  methodRegistry: GatewayMethodRegistry,
) {
  // Pre-connect and health requests are allowed through; role/scope checks require the
  // authenticated connect metadata established by the gateway handshake.
  if (!client?.connect || method === "health") {
    return null;
  }
  const roleRaw = client.connect.role ?? "operator";
  const role = parseGatewayRole(roleRaw);
  if (!role) {
    return errorShape(ErrorCodes.INVALID_REQUEST, `unauthorized role: ${roleRaw}`);
  }
  const scopes = client.connect.scopes ?? [];
  if (!isRoleAuthorizedForMethod(role, method)) {
    return errorShape(ErrorCodes.INVALID_REQUEST, `unauthorized role: ${role}`);
  }
  if (role === "node") {
    return null;
  }
  if (method === "device.scopes.requestUpgrade" || method === "device.scopes.waitUpgrade") {
    // Scope recovery must remain reachable from a paired operator whose grant is empty;
    // the handlers bind both calls to the connection's exact device identity.
    return null;
  }
  if (scopes.includes(ADMIN_SCOPE)) {
    return null;
  }
  const registeredScope = methodRegistry.getScope(method);
  const scopeAuth = isOperatorScope(registeredScope)
    ? authorizeOperatorScopesForRequiredScope(registeredScope, scopes)
    : authorizeOperatorScopesForMethod(method, scopes, params);
  if (!scopeAuth.allowed) {
    const resolvedRequiredScopes = isOperatorScope(registeredScope)
      ? [registeredScope]
      : resolveLeastPrivilegeOperatorScopesForMethod(method, params);
    return missingScopeErrorShape({
      missingScope: scopeAuth.missingScope,
      requiredScopes:
        resolvedRequiredScopes.length > 0 ? resolvedRequiredScopes : [scopeAuth.missingScope],
    });
  }
  return null;
}

const SUSPEND_CONTROL_METHODS = new Set([
  "gateway.suspend.prepare",
  "gateway.suspend.status",
  "gateway.suspend.resume",
]);

function runGatewayPendingWorkContinuation<T>(params: {
  method: string;
  client: GatewayRequestOptions["client"];
  requestParams: unknown;
  context: GatewayRequestContext;
  run: () => Promise<T>;
}): Promise<T> | null {
  if (!isRecord(params.requestParams)) {
    return null;
  }
  const request = params.requestParams;
  if (params.client?.connect.role === "node") {
    if (getGatewaySuspendAdmissionPhase() !== "draining" && !isGatewayRestartDraining()) {
      return null;
    }
    const invokeId =
      params.method === "node.invoke.progress"
        ? request.invokeId
        : params.method === "node.invoke.result"
          ? request.id
          : undefined;
    if (typeof invokeId !== "string" || typeof request.nodeId !== "string") {
      return null;
    }
    return params.context.nodeRegistry.runPendingInvokeContinuation({
      invokeId,
      nodeId: request.nodeId,
      connId: params.client.connId,
      run: params.run,
    });
  }
  if (
    getGatewaySuspendAdmissionPhase() !== "draining" ||
    params.client?.connect.role !== "operator" ||
    typeof request.id !== "string"
  ) {
    return null;
  }
  if (params.method === "question.resolve" || params.method === "question.get") {
    return params.context.questionManager?.runPendingContinuation(request.id, params.run) ?? null;
  }
  const manager =
    params.method === "exec.approval.resolve"
      ? params.context.execApprovalManager
      : params.method === "plugin.approval.resolve"
        ? params.context.pluginApprovalManager
        : params.method === "approval.resolve"
          ? request.kind === "exec"
            ? params.context.execApprovalManager
            : request.kind === "plugin"
              ? params.context.pluginApprovalManager
              : request.kind === "system-agent"
                ? params.context.systemAgentApprovalManager
                : undefined
          : undefined;
  return manager?.runPendingContinuation(request.id, params.run) ?? null;
}

async function authorizeAuthenticatedProfileForMethod(params: {
  client: GatewayRequestOptions["client"];
  method: string;
  requestParams: unknown;
  methodRegistry: GatewayMethodRegistry;
  context: GatewayRequestContext;
}): Promise<ErrorShape | null> {
  const sync = params.client?.authenticatedGitHubIdentitySync;
  if (!sync || params.client?.authenticatedUserProfile?.profileId.trim()) {
    return null;
  }
  const requiresProfile =
    params.methodRegistry.requiresAuthenticatedProfile(params.method) ||
    resolveDirectIncognitoTargets(params.method, params.requestParams).length > 0 ||
    (sessionMutationTargetFields(params.method).length > 0 &&
      params.context.getRuntimeConfig().gateway?.roles !== undefined);
  if (!requiresProfile) {
    return null;
  }
  try {
    await sync();
  } catch {
    return authenticatedProfileUnavailableError();
  }
  return params.client?.authenticatedUserProfile?.profileId.trim()
    ? null
    : authenticatedProfileUnavailableError();
}

/** Builds the per-request method registry from core, plugin, and explicit extra handlers. */
export function createRequestGatewayMethodRegistry(
  extraHandlers?: GatewayRequestHandlers,
): GatewayMethodRegistry {
  // Attached gateway methods must not be shadowed by agent-scoped registry loads.
  const gatewayPluginRegistry = getActivePluginHttpRouteRegistry();
  const gatewayPluginHandlers = gatewayPluginRegistry?.gatewayHandlers ?? {};
  const extraHandlerEntries = Object.entries(extraHandlers ?? {});
  const pluginMethodNames = new Set(Object.keys(gatewayPluginHandlers));
  const coreDescriptorHandlers = { ...coreGatewayHandlers };
  for (const [method, extraHandler] of extraHandlerEntries) {
    // Tests and local harnesses can override classified core methods, but plugin-provided
    // methods win so a loaded plugin cannot be shadowed by a caller-local extra handler.
    if (!pluginMethodNames.has(method) && isCoreGatewayMethodClassified(method)) {
      coreDescriptorHandlers[method] = extraHandler;
    }
  }
  const auxHandlers = Object.fromEntries(
    extraHandlerEntries.filter(
      ([method]) => !pluginMethodNames.has(method) && !isCoreGatewayMethodClassified(method),
    ),
  );
  return createGatewayMethodRegistry(
    [
      ...createCoreGatewayMethodDescriptors(coreDescriptorHandlers),
      ...(gatewayPluginRegistry ? createPluginGatewayMethodDescriptors(gatewayPluginRegistry) : []),
      ...createGatewayMethodDescriptorsFromHandlers({
        handlers: auxHandlers,
        owner: { kind: "aux", area: "gateway-extra" },
        defaultScope: ADMIN_SCOPE,
      }),
    ],
    gatewayPluginRegistry ?? undefined,
  );
}

/** Applies the router-owned authorization fence before any transport or typed dispatch. */
export async function authorizeGatewayRequestPreDispatch(params: {
  method: string;
  requestParams: unknown;
  client: GatewayRequestOptions["client"];
  context: GatewayRequestContext;
  methodRegistry: GatewayMethodRegistry;
}): Promise<{
  error: ErrorShape | null;
  sessionMutationAuthorization?: SessionMutationAuthorization;
}> {
  const authError = authorizeGatewayMethod(
    params.method,
    params.client,
    params.requestParams,
    params.methodRegistry,
  );
  if (authError) {
    return { error: authError };
  }
  // GitHub-backed connections receive hello before remote account resolution. Profile-owned
  // methods must cross this single router fence before session authorization or handler work.
  const profileError = await authorizeAuthenticatedProfileForMethod(params);
  if (profileError) {
    return { error: profileError };
  }
  // Startup gating precedes session authorization: session stores are not loaded yet,
  // so an authorization read here would deny with a misleading non-retryable error.
  if (params.context.unavailableGatewayMethods?.has(params.method)) {
    return {
      error: errorShape(
        ErrorCodes.UNAVAILABLE,
        `${params.method} unavailable during gateway startup`,
        {
          retryable: true,
          retryAfterMs: GATEWAY_STARTUP_RETRY_AFTER_MS,
          details: { ...gatewayStartupUnavailableDetails(), method: params.method },
        },
      ),
    };
  }
  const sessionMutation = resolveSessionMutationAuthorization({
    client: params.client ?? null,
    method: params.method,
    requestParams: params.requestParams,
    context: params.context,
  });
  if (sessionMutation.error) {
    return { error: sessionMutation.error };
  }
  if (
    params.client?.connect.role === "node" &&
    (!params.client.connId ||
      !(await params.context.nodeRegistry.isConnectionCurrentPairingState(params.client.connId)))
  ) {
    return {
      error: errorShape(ErrorCodes.UNAVAILABLE, "node pairing changed before request dispatch", {
        retryable: true,
        details: { code: "PAIRING_CHANGED" },
      }),
    };
  }
  return {
    error: null,
    ...(sessionMutation.authorization
      ? { sessionMutationAuthorization: sessionMutation.authorization }
      : {}),
  };
}

type GatewayRequestEnvelopeOptions<T> = Pick<
  GatewayRequestOptions,
  "context" | "isWebchatConnect"
> & {
  methodRegistry: GatewayMethodRegistry;
  requestParams?: unknown;
  reject: (error: ReturnType<typeof errorShape>) => T | Promise<T>;
};

/** Runs admitted Gateway work inside the shared root and plugin request scopes. */
export async function runWithGatewayRequestEnvelope<T>(
  method: string,
  client: GatewayRequestOptions["client"],
  fn: () => T | Promise<T>,
  options: GatewayRequestEnvelopeOptions<T>,
): Promise<T> {
  const rejectRateLimitedControlPlaneWrite = (): ReturnType<typeof errorShape> | undefined => {
    if (!options.methodRegistry.isControlPlaneWrite(method)) {
      return undefined;
    }
    const budget = consumeControlPlaneWriteBudget({ client, method });
    if (budget.allowed) {
      return undefined;
    }
    const actor = resolveControlPlaneActor(client);
    options.context.logGateway.warn(
      `control-plane write rate-limited method=${method} ${formatControlPlaneActor(actor)} retryAfterMs=${budget.retryAfterMs} key=${budget.key}`,
    );
    return errorShape(
      ErrorCodes.UNAVAILABLE,
      `rate limit exceeded for ${method}; retry after ${Math.ceil(budget.retryAfterMs / 1000)}s`,
      {
        retryable: true,
        retryAfterMs: budget.retryAfterMs,
        details: {
          method,
          limit: `${CONTROL_PLANE_RATE_LIMIT_MAX_REQUESTS} per ${CONTROL_PLANE_RATE_LIMIT_WINDOW_MS / 1000}s`,
        },
      },
    );
  };
  const isSuspendPrepare = method === "gateway.suspend.prepare";
  const preAdmissionRateLimitError = isSuspendPrepare
    ? rejectRateLimitedControlPlaneWrite()
    : undefined;
  if (preAdmissionRateLimitError) {
    // Preparation must stay protected even before it owns the root admission that it closes.
    return await options.reject(preAdmissionRateLimitError);
  }
  const rootWorkAdmission =
    tryBeginGatewayRootWorkAdmission(`ws:${method}`) ??
    (method === "gateway.restart.request" &&
    isTargetedNonSafeGatewayRestartRequest(options.requestParams)
      ? tryBeginGatewayPreparedRestartRootWorkAdmission()
      : null);
  if (!rootWorkAdmission) {
    // Completion frames arrive on separate socket chains. Their exact pending owner
    // may settle them without admitting a new root, including rootless shutdown cleanup.
    const continuation = runGatewayPendingWorkContinuation({
      method,
      client,
      requestParams: options.requestParams,
      context: options.context,
      run: invokeWithRequestScope,
    });
    if (continuation) {
      return await continuation;
    }
  }
  if (isSuspendPrepare && rootWorkAdmission && !rootWorkAdmission.ownsRoot) {
    return await options.reject(
      errorShape(ErrorCodes.UNAVAILABLE, "gateway suspension cannot begin from a nested request", {
        retryable: true,
        retryAfterMs: 1_000,
        details: { method, reason: "nested-gateway-request" },
      }),
    );
  }
  if (!rootWorkAdmission && !SUSPEND_CONTROL_METHODS.has(method)) {
    const restartDraining = isGatewayRestartDraining();
    return await options.reject(
      errorShape(
        ErrorCodes.UNAVAILABLE,
        `${method} unavailable during gateway ${restartDraining ? "restart" : "suspension"}`,
        {
          retryable: true,
          retryAfterMs: 1_000,
          details: {
            method,
            reason: restartDraining
              ? GATEWAY_RESTART_UNAVAILABLE_REASON
              : GATEWAY_SUSPEND_UNAVAILABLE_REASON,
            phase: getGatewaySuspendAdmissionPhase(),
          },
        },
      ),
    );
  }
  async function invokeWithRequestScope() {
    const postAdmissionRateLimitError = isSuspendPrepare
      ? undefined
      : rejectRateLimitedControlPlaneWrite();
    // A closed admission must reject first so refused writes do not exhaust the controller's
    // budget and strand it behind rate limiting after suspension resumes.
    if (postAdmissionRateLimitError) {
      return await options.reject(postAdmissionRateLimitError);
    }
    try {
      const pluginRegistry =
        (options.methodRegistry.pluginRegistry as
          | NonNullable<ReturnType<typeof getActivePluginRegistry>>
          | undefined) ??
        getPluginRuntimeGatewayRequestScope()?.pluginRegistry ??
        getActivePluginRegistry() ??
        undefined;
      return await withPluginRuntimeGatewayRequestScope(
        {
          context: options.context,
          // Detached turn admission needs the live instance resolver, not a captured request context.
          resolveGatewayContext: options.context.resolveGatewayContext,
          client,
          isWebchatConnect: options.isWebchatConnect,
          // Only an owner-bound in-process stream may retain admitted Full authority.
          ...(client?.internal?.nodeInvokeStream ? getPluginRuntimeGatewayNodeAuthorities() : {}),
          ...(pluginRegistry ? { pluginRegistry } : {}),
        },
        fn,
      );
    } catch (error) {
      if (error instanceof SessionMutationAuthorizationChangedError) {
        return await options.reject(error.error);
      }
      const staleInstall = classifyGatewayStaleInstall(error);
      if (staleInstall) {
        return await options.reject(staleInstall.error);
      }
      throw error;
    }
  }
  if (!rootWorkAdmission) {
    return await invokeWithRequestScope();
  }
  try {
    return await rootWorkAdmission.run(invokeWithRequestScope);
  } finally {
    rootWorkAdmission.release();
  }
}

/** Authorizes and dispatches one gateway JSON-RPC-style request. */
export async function handleGatewayRequest(
  opts: GatewayRequestOptions & {
    extraHandlers?: GatewayRequestHandlers;
    requestEntry?: GatewayRequestEntry;
  },
  diagnostics?: GatewayRpcDiagnostics,
): Promise<void> {
  const { req, respond, client, isWebchatConnect, context, signal } = opts;
  const entry = opts.requestEntry ?? context.requestEntryLifetime?.enter(opts);
  try {
    entry?.assertOpen();
    // Prefer the caller-attached registry when it owns the requested method so plugin dispatch
    // metadata newer than global runtime state still authorizes and dispatches correctly. When the
    // attached snapshot does not own the method, rebuild from the process-root registry so late
    // methods remain reachable (#94127).
    const methodRegistry =
      opts.methodRegistry?.getHandler(req.method) !== undefined
        ? opts.methodRegistry
        : createRequestGatewayMethodRegistry(opts.extraHandlers);
    const authorization = await authorizeGatewayRequestPreDispatch({
      method: req.method,
      requestParams: req.params,
      client,
      context,
      methodRegistry,
    });
    entry?.assertOpen();
    if (authorization.error) {
      respond(false, undefined, authorization.error);
      return;
    }
    const handler = methodRegistry.getHandler(req.method) as GatewayRequestHandler | undefined;
    if (!handler) {
      const error = errorShape(ErrorCodes.INVALID_REQUEST, `unknown method: ${req.method}`);
      respond(false, undefined, error);
      return;
    }
    // Every session mutation owner uses these pre-commit assertions. Compose the
    // host lifetime here so individual handlers cannot lose it across an await.
    const sessionMutationAuthorization = withSessionMutationCommitGuard(
      authorization.sessionMutationAuthorization,
      opts.sessionMutationCommitGuard,
    );
    const invokeHandler = async () => {
      const preparedHandler = await prepareGatewayRequestHandler(handler, entry);
      const handlerOptions = {
        req,
        params: (req.params ?? {}) as Record<string, unknown>,
        client,
        isWebchatConnect,
        respond,
        context,
        signal,
        sessionMutationCommitGuard: opts.sessionMutationCommitGuard,
        sessionMutationAuthorization,
      };
      opts.sessionMutationCommitGuard?.();
      entry?.assertOpen();
      if (signal?.aborted) {
        return;
      }
      // No await between the final fence, ownership handoff, and actual invocation.
      // Long polls and shutdown initiators must never remain preparation leases.
      entry?.release();
      return diagnostics
        ? diagnostics.runHandler(() => preparedHandler(handlerOptions))
        : preparedHandler(handlerOptions);
    };
    await runWithGatewayRequestEnvelope(req.method, client, invokeHandler, {
      context,
      isWebchatConnect,
      methodRegistry,
      requestParams: req.params,
      reject: (error) => respond(false, undefined, error),
    });
  } finally {
    // Transport/import owners retain failures through their response and logging paths.
    if (!opts.requestEntry) {
      entry?.release();
    }
  }
}
