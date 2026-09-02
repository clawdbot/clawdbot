// Gateway request scope tracks request-local plugin runtime context across async work.
import { AsyncLocalStorage } from "node:async_hooks";
import type {
  GatewayContextResolver,
  GatewayRequestContext,
  GatewayRequestOptions,
} from "../../gateway/server-methods/types.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import type { PluginOrigin } from "../plugin-origin.types.js";
import type { PluginRegistry } from "../registry-types.js";
import type { OpenClawPluginNodeWorkspace } from "../types.node-host.js";

type PluginRuntimeGatewayRequestScope = {
  /** Exact placement owner captured before the local harness begins. */
  assertNodeExecutionCurrent?: (request: {
    runId: string;
    agentId: string;
    nodeId: string;
    workspace: OpenClawPluginNodeWorkspace;
  }) => void;
  /** In-process admitted owner only; never projected into RPC parameters. */
  invokeWithSessionNodeAuthority?: <T>(
    request: {
      pluginId: string;
      command: string;
      source: "session-full" | "human-approved";
      nodeId: string;
      workspace: OpenClawPluginNodeWorkspace;
    },
    invoke: (assertCurrent: () => void, signal: AbortSignal) => Promise<T>,
  ) => Promise<T | undefined>;
  /** Closure-bound admitted owner used to validate placement grant bindings. */
  nodePlacementGrantAuthority?: {
    agentId: string;
    sessionKey: string;
    runId: string;
    assertCurrent: (request: {
      pluginId: string;
      command: string;
      nodeId: string;
      workspace: OpenClawPluginNodeWorkspace;
    }) => void;
  };
  context?: GatewayRequestContext;
  resolveGatewayContext?: GatewayContextResolver;
  client?: GatewayRequestOptions["client"];
  isWebchatConnect: GatewayRequestOptions["isWebchatConnect"];
  pluginId?: string;
  pluginSource?: string;
  pluginOrigin?: PluginOrigin;
  pluginTrustedOfficialInstall?: boolean;
  gatewayMethodDispatchAllowed?: boolean;
  pluginRegistry?: PluginRegistry;
};

type PluginRuntimePluginScope = {
  pluginId: string;
  pluginSource?: string;
  pluginOrigin?: PluginOrigin;
  pluginTrustedOfficialInstall?: boolean;
};

const PLUGIN_RUNTIME_GATEWAY_REQUEST_SCOPE_KEY: unique symbol = Symbol.for(
  "openclaw.pluginRuntimeGatewayRequestScope",
);
const GATEWAY_CONTEXT_RESOLVERS_KEY: unique symbol = Symbol.for("openclaw.gatewayContextResolvers");

const pluginRuntimeGatewayRequestScope = resolveGlobalSingleton<
  AsyncLocalStorage<PluginRuntimeGatewayRequestScope>
>(
  PLUGIN_RUNTIME_GATEWAY_REQUEST_SCOPE_KEY,
  () => new AsyncLocalStorage<PluginRuntimeGatewayRequestScope>(),
);
// Built plugin chunks and source Gateway code must redeem the same host-issued owner bindings.
const gatewayContextResolvers = resolveGlobalSingleton<WeakMap<object, GatewayContextResolver>>(
  GATEWAY_CONTEXT_RESOLVERS_KEY,
  () => new WeakMap(),
);

export function bindGatewayContextResolver(
  owner: object,
  resolver: GatewayContextResolver | undefined,
): void {
  if (resolver) {
    gatewayContextResolvers.set(owner, resolver);
  }
}

export const getGatewayContextResolver = (owner: object) => gatewayContextResolvers.get(owner);

export const clearGatewayContextResolver = (owner: object) => gatewayContextResolvers.delete(owner);

/** Carry only closure-bound node authorities into a nested request scope. */
export function getPluginRuntimeGatewayNodeAuthorities() {
  const scope = pluginRuntimeGatewayRequestScope.getStore();
  return {
    invokeWithSessionNodeAuthority: scope?.invokeWithSessionNodeAuthority,
    nodePlacementGrantAuthority: scope?.nodePlacementGrantAuthority,
  };
}

export function getSharedGatewayContextResolver(
  owners: readonly object[],
): GatewayContextResolver | undefined {
  const first = owners[0] ? gatewayContextResolvers.get(owners[0]) : undefined;
  // Absence permits ambient routing; incompatible owners must retain a rejecting binding.
  return owners.every((owner) => gatewayContextResolvers.get(owner) === first)
    ? first
    : () => undefined;
}

/**
 * Runs plugin gateway handlers with request-scoped context that runtime helpers can read.
 */
export function withPluginRuntimeGatewayRequestScope<T>(
  scope: PluginRuntimeGatewayRequestScope,
  run: () => T,
): T {
  return pluginRuntimeGatewayRequestScope.run(scope, run);
}

/** Runs detached plugin work against one lifecycle-fenced Gateway instance. */
export function withPluginRuntimeGatewayContextResolver<T>(
  resolveGatewayContext: GatewayContextResolver,
  run: () => T,
  options?: { inheritRequestScope?: boolean },
): T {
  // Scheduler-owned work must not retain the request-local client or context
  // that happened to exist when its timer was armed.
  const current =
    options?.inheritRequestScope === false
      ? undefined
      : pluginRuntimeGatewayRequestScope.getStore();
  const scoped: PluginRuntimeGatewayRequestScope = {
    ...current,
    isWebchatConnect: current?.isWebchatConnect ?? (() => false),
    resolveGatewayContext,
  };
  delete scoped.context;
  return pluginRuntimeGatewayRequestScope.run(scoped, run);
}

/** Runs work against an owned registry handle while preserving any gateway request facts. */
export function withPluginRuntimeRegistryScope<T>(
  registry: PluginRegistry | undefined,
  run: () => T,
): T {
  if (!registry) {
    return run();
  }
  const current = pluginRuntimeGatewayRequestScope.getStore();
  return pluginRuntimeGatewayRequestScope.run(
    { isWebchatConnect: () => false, ...current, pluginRegistry: registry },
    run,
  );
}

/**
 * Runs work under the current gateway request scope while attaching plugin identity.
 */
export function withPluginRuntimePluginScope<T>(scope: PluginRuntimePluginScope, run: () => T): T {
  const current = pluginRuntimeGatewayRequestScope.getStore();
  const scoped: PluginRuntimeGatewayRequestScope = current
    ? { ...current, pluginId: scope.pluginId }
    : {
        pluginId: scope.pluginId,
        isWebchatConnect: () => false,
      };
  if (scope.pluginSource !== undefined) {
    scoped.pluginSource = scope.pluginSource;
  } else {
    delete scoped.pluginSource;
  }
  if (scope.pluginOrigin !== undefined) {
    scoped.pluginOrigin = scope.pluginOrigin;
  } else {
    delete scoped.pluginOrigin;
  }
  if (scope.pluginTrustedOfficialInstall !== undefined) {
    scoped.pluginTrustedOfficialInstall = scope.pluginTrustedOfficialInstall;
  } else {
    delete scoped.pluginTrustedOfficialInstall;
  }
  return pluginRuntimeGatewayRequestScope.run(scoped, run);
}

/**
 * Runs work under the current gateway request scope while attaching plugin identity.
 */
export function withPluginRuntimePluginIdScope<T>(pluginId: string, run: () => T): T {
  return withPluginRuntimePluginScope({ pluginId }, run);
}

/**
 * Returns the current plugin gateway request scope when called from a plugin request handler.
 */
export function getPluginRuntimeGatewayRequestScope():
  | PluginRuntimeGatewayRequestScope
  | undefined {
  return pluginRuntimeGatewayRequestScope.getStore();
}
