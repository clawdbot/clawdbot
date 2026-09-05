import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentWaitParams } from "../../packages/gateway-protocol/src/index.js";
import type { SubagentCompletionToolHandoffRegistration } from "../agents/subagents/announce/subagent-announce-handoff.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../plugins/runtime/gateway-request-scope.js";
import type { PluginSubagentRequesterContext } from "../plugins/runtime/subagent-requester-context.js";
import type { RuntimePluginToolGrant } from "../plugins/runtime/tool-grant.js";
import { readInProcessAgentRuntimeIdentity } from "./in-process-agent-runtime-identity.js";
import { authorizeGatewaySessionCreation } from "./operator-role-policy.js";
import { ADMIN_SCOPE, WRITE_SCOPE } from "./operator-scopes.js";
import {
  dispatchGatewayRequestInProcessRaw,
  type GatewayMethodDispatchResponse,
  unwrapGatewayMethodDispatchResponse,
} from "./server-in-process-dispatch.js";
import type { AgentRunRequest } from "./server-methods/agent-request-types.js";
import type { TrustedSessionCreation } from "./server-methods/session-creation-provenance.js";
import type { GatewayOperatorRoleActor } from "./server-methods/shared-types.js";
import type {
  GatewayAgentRunTaskOwner,
  GatewayContextResolver,
  GatewayNodeInvokeStream,
  GatewayRequestContext,
  GatewayRequestOptions,
  TrustedAgentToolCaller,
} from "./server-methods/types.js";
import {
  createSyntheticPluginRuntimeClient,
  mergePluginRuntimeClientInternal,
} from "./server-plugin-runtime-client.js";
import {
  cancelSubagentCompletionToolHandoff,
  registerSubagentCompletionToolHandoff,
} from "./subagent-completion-tool-handoff.js";

type OperatorToolGatewayAuthority = {
  authenticatedUserProfile: NonNullable<
    NonNullable<GatewayRequestOptions["client"]>["authenticatedUserProfile"]
  >;
  scopes: readonly string[];
  operatorRoleActor?: GatewayOperatorRoleActor;
  signal: AbortSignal;
};

const operatorToolGatewayAuthority = new AsyncLocalStorage<OperatorToolGatewayAuthority>();

/** Retains operator attribution and authority only for the awaited tool invocation. */
export async function withOperatorToolGatewayAuthority<T>(
  authority: Omit<OperatorToolGatewayAuthority, "signal">,
  run: () => Promise<T>,
): Promise<T> {
  const lifetime = new AbortController();
  try {
    return await operatorToolGatewayAuthority.run({ ...authority, signal: lifetime.signal }, run);
  } finally {
    lifetime.abort(new Error("operator tool invocation authority expired"));
  }
}

/** Transfer bounded cleanup without retaining the finished operator invocation. */
export function runWithOperatorToolGatewayCleanupContext<T>(run: () => T): T {
  const authority = operatorToolGatewayAuthority.getStore();
  if (!authority) {
    return run();
  }
  authority.signal.throwIfAborted();
  const scope = getPluginRuntimeGatewayRequestScope();
  // Retain the effective actor and scopes after releasing the invocation;
  // profile attribution alone does not establish authority.
  const client = createSyntheticPluginRuntimeClient({
    authenticatedUserProfile: authority.authenticatedUserProfile,
    scopes: [...authority.scopes],
    operatorRoleActor: authority.operatorRoleActor ??
      scope?.client?.internal?.operatorRoleActor ?? {
        kind: "operator",
        profileId: authority.authenticatedUserProfile.profileId,
      },
  });
  return operatorToolGatewayAuthority.exit(() =>
    withPluginRuntimeGatewayRequestScope(
      { ...scope, client, isWebchatConnect: scope?.isWebchatConnect ?? (() => false) },
      run,
    ),
  );
}

type DispatchGatewayMethodInProcessOptions = {
  allowSyntheticModelOverride?: boolean;
  allowSyntheticCronRunContinuation?: boolean;
  agentToolCaller?: TrustedAgentToolCaller;
  agentRunTracking?: GatewayAgentRunTaskOwner;
  cancelOnDeadline?: boolean;
  disableSyntheticClient?: boolean;
  expectFinal?: boolean;
  forceSyntheticClient?: boolean;
  internalDeliveryMediaUrls?: string[];
  internalDeliverySuppressText?: boolean;
  nodeInvokeStream?: GatewayNodeInvokeStream;
  nodeInvokeApprovalSessionKey?: string;
  onAccepted?: (payload: unknown) => void;
  onExecutionStarted?: () => void;
  onSignalAbort?: () => Promise<void> | void;
  operatorRoleActor?: GatewayOperatorRoleActor;
  pluginRuntimeOwnerId?: string;
  pluginSubagentRequester?: PluginSubagentRequesterContext;
  runtimePluginToolGrant?: RuntimePluginToolGrant;
  pluginSubagentToolsAllow?: string[];
  delegatedToolPolicyHandoff?: SubagentCompletionToolHandoffRegistration;
  sessionCreation?: TrustedSessionCreation;
  requireScopedClient?: boolean;
  syntheticScopes?: string[];
  timeoutMs?: number;
  signal?: AbortSignal;
  resolveGatewayContext?: GatewayContextResolver;
  sessionMutationCommitGuard?: () => void;
};

type ResolvedInProcessGatewayDispatch = {
  assertContextCurrent: () => void;
  client: NonNullable<GatewayRequestOptions["client"]>;
  context: GatewayRequestContext;
  delegatedToolPolicyHandoffId?: string;
  isWebchatConnect: NonNullable<GatewayRequestOptions["isWebchatConnect"]>;
};

function resolveInProcessGatewayDispatch(
  method: string,
  options?: DispatchGatewayMethodInProcessOptions,
): ResolvedInProcessGatewayDispatch {
  const inheritedOperatorAuthority = operatorToolGatewayAuthority.getStore();
  inheritedOperatorAuthority?.signal.throwIfAborted();
  const scope = getPluginRuntimeGatewayRequestScope();
  const scopedOperatorProfile = scope?.client?.authenticatedUserProfile;
  const scopedRoleActor = scope?.client?.internal?.operatorRoleActor;
  const explicitSystemActor =
    !scope?.client && !inheritedOperatorAuthority ? options?.operatorRoleActor : undefined;
  const verifiedOperatorAuthority =
    inheritedOperatorAuthority ??
    (scopedOperatorProfile?.profileId
      ? {
          authenticatedUserProfile: scopedOperatorProfile,
          scopes: scope?.client?.connect.scopes ?? [],
        }
      : undefined);
  // Subagent launch ownership stays with the host after its target was checked;
  // retain the verified role actor separately so target policy remains enforced.
  const isHostOwnedAgentRun = method === "agent" && Boolean(options?.agentRunTracking);
  const operatorAuthority = isHostOwnedAgentRun ? undefined : verifiedOperatorAuthority;
  const operatorRoleActor: GatewayOperatorRoleActor | undefined =
    inheritedOperatorAuthority?.operatorRoleActor ??
    (isHostOwnedAgentRun
      ? inheritedOperatorAuthority
        ? {
            kind: "operator",
            profileId: inheritedOperatorAuthority.authenticatedUserProfile.profileId,
          }
        : (scopedRoleActor ??
          (scopedOperatorProfile?.profileId
            ? { kind: "operator", profileId: scopedOperatorProfile.profileId }
            : scope?.client
              ? undefined
              : (explicitSystemActor ?? { kind: "system" })))
      : (scopedRoleActor ?? explicitSystemActor));
  // The router installs a nested scope; retain the admitted resolver for later commit checks.
  const resolveGatewayContext = options?.resolveGatewayContext ?? scope?.resolveGatewayContext;
  const context = getInProcessGatewayRequestContext(resolveGatewayContext);
  const isWebchatConnect = scope?.isWebchatConnect ?? (() => false);
  if (!context) {
    throw new Error(
      `In-process gateway dispatch requires a gateway request scope or instance binding (method: ${method}).`,
    );
  }
  if (options?.requireScopedClient === true && !scope?.client) {
    throw new Error(
      `In-process gateway dispatch requires an authenticated plugin request scope (method: ${method}).`,
    );
  }

  const pluginRuntimeOwnerId =
    typeof options?.pluginRuntimeOwnerId === "string" && options.pluginRuntimeOwnerId.trim()
      ? options.pluginRuntimeOwnerId.trim()
      : undefined;
  const pluginRecord = pluginRuntimeOwnerId
    ? getActivePluginRegistry()?.plugins.find((entry) => entry.id === pluginRuntimeOwnerId)
    : undefined;
  const nodeInvokeApprovalSessionKey =
    method === "node.invoke" &&
    scope?.pluginId?.trim() === pluginRuntimeOwnerId &&
    (scope?.pluginOrigin === "bundled" ||
      scope?.pluginTrustedOfficialInstall === true ||
      pluginRecord?.origin === "bundled" ||
      pluginRecord?.trustedOfficialInstall === true)
      ? options?.nodeInvokeApprovalSessionKey
      : undefined;
  if (
    options?.nodeInvokeStream &&
    (method !== "node.invoke" || !pluginRuntimeOwnerId || options.forceSyntheticClient !== true)
  ) {
    throw new Error("Node invoke streaming requires an owner-bound trusted synthetic client.");
  }
  const delegatedToolPolicyHandoffId = options?.delegatedToolPolicyHandoff
    ? registerSubagentCompletionToolHandoff(options.delegatedToolPolicyHandoff)
    : undefined;
  const requestedSyntheticScopes = options?.syntheticScopes ?? [WRITE_SCOPE];
  const operatorScopes =
    operatorAuthority?.scopes ??
    (operatorRoleActor?.kind === "operator"
      ? (verifiedOperatorAuthority?.scopes ?? scope?.client?.connect.scopes ?? [])
      : undefined);
  const syntheticScopes = operatorScopes
    ? requestedSyntheticScopes.filter((requestedScope) => operatorScopes.includes(requestedScope))
    : options?.syntheticScopes;
  if (operatorScopes?.includes(ADMIN_SCOPE) && !syntheticScopes?.includes(ADMIN_SCOPE)) {
    syntheticScopes?.push(ADMIN_SCOPE);
  }
  const baseSyntheticClient = createSyntheticPluginRuntimeClient({
    ...(operatorAuthority
      ? { authenticatedUserProfile: operatorAuthority.authenticatedUserProfile }
      : {}),
    allowModelOverride: options?.allowSyntheticModelOverride === true,
    agentToolCaller: options?.agentToolCaller,
    agentRunTracking: options?.agentRunTracking,
    ...(operatorRoleActor ? { operatorRoleActor } : {}),
    cronRunContinuation: options?.allowSyntheticCronRunContinuation === true,
    internalDeliveryMediaUrls: options?.internalDeliveryMediaUrls,
    internalDeliverySuppressText: options?.internalDeliverySuppressText,
    ...(pluginRuntimeOwnerId ? { pluginRuntimeOwnerId } : {}),
    ...(nodeInvokeApprovalSessionKey ? { nodeInvokeApprovalSessionKey } : {}),
    ...(options?.pluginSubagentRequester
      ? { pluginSubagentRequester: options.pluginSubagentRequester }
      : {}),
    ...(options?.runtimePluginToolGrant
      ? { runtimePluginToolGrant: options.runtimePluginToolGrant }
      : {}),
    ...(options?.pluginSubagentToolsAllow
      ? { pluginSubagentToolsAllow: options.pluginSubagentToolsAllow }
      : {}),
    delegatedToolPolicyHandoffId,
    ...(options?.sessionCreation ? { sessionCreation: options.sessionCreation } : {}),
    scopes: syntheticScopes,
  });
  const scopedStreamClient = options?.nodeInvokeStream ? scope?.client : undefined;
  const agentRuntimeIdentity =
    scopedStreamClient?.internal?.agentRuntimeIdentity ??
    readInProcessAgentRuntimeIdentity(options);
  const syntheticClient =
    agentRuntimeIdentity || options?.nodeInvokeStream
      ? {
          ...(scopedStreamClient ?? baseSyntheticClient),
          ...(scopedStreamClient
            ? {
                connect: {
                  ...scopedStreamClient.connect,
                  scopes: baseSyntheticClient.connect.scopes,
                },
              }
            : {}),
          internal: {
            ...scopedStreamClient?.internal,
            ...baseSyntheticClient.internal,
            ...(agentRuntimeIdentity ? { agentRuntimeIdentity } : {}),
            ...(options?.nodeInvokeStream ? { nodeInvokeStream: options.nodeInvokeStream } : {}),
          },
        }
      : baseSyntheticClient;
  const scopedClient = mergePluginRuntimeClientInternal(
    scope?.client,
    pluginRuntimeOwnerId ||
      options?.agentRunTracking ||
      options?.pluginSubagentRequester ||
      options?.runtimePluginToolGrant ||
      options?.pluginSubagentToolsAllow ||
      options?.delegatedToolPolicyHandoff ||
      scope?.client?.internal?.delegatedToolPolicyHandoffId
      ? {
          ...(options?.agentRunTracking ? { agentRunTracking: options.agentRunTracking } : {}),
          ...(pluginRuntimeOwnerId ? { pluginRuntimeOwnerId } : {}),
          ...(options?.pluginSubagentRequester
            ? { pluginSubagentRequester: options.pluginSubagentRequester }
            : {}),
          runtimePluginToolGrant: options?.runtimePluginToolGrant,
          pluginSubagentToolsAllow: options?.pluginSubagentToolsAllow,
          delegatedToolPolicyHandoffId,
        }
      : undefined,
  );
  if (options?.disableSyntheticClient === true && !scopedClient) {
    cancelSubagentCompletionToolHandoff(delegatedToolPolicyHandoffId);
    throw new Error(`In-process gateway dispatch requires a scoped client (method: ${method}).`);
  }
  return {
    assertContextCurrent: () => {
      if ((resolveGatewayContext ? resolveGatewayContext() : scope?.context) !== context) {
        throw new Error(
          `In-process gateway dispatch requires a current gateway instance binding (method: ${method}).`,
        );
      }
    },
    client:
      options?.forceSyntheticClient === true ? syntheticClient : (scopedClient ?? syntheticClient),
    context,
    delegatedToolPolicyHandoffId,
    isWebchatConnect,
  };
}

/** Authorizes a sessionless agent execution against its captured Gateway and caller. */
export function prepareInProcessAgentExecution(params: {
  agentId: string;
  pluginRuntimeOwnerId: string;
  resolveGatewayContext?: GatewayContextResolver;
}) {
  const inheritedAuthority = operatorToolGatewayAuthority.getStore();
  const resolved = resolveInProcessGatewayDispatch("agent", {
    agentRunTracking: "plugin_subagent",
    pluginRuntimeOwnerId: params.pluginRuntimeOwnerId,
    resolveGatewayContext: params.resolveGatewayContext,
  });
  // Profile verification updates the original connection. Sessionless work needs
  // that live principal, not the dispatch copy carrying session tracking metadata.
  const client = getPluginRuntimeGatewayRequestScope()?.client ?? resolved.client;
  const assertLifetime = () => {
    resolved.assertContextCurrent();
    inheritedAuthority?.signal.throwIfAborted();
  };
  const assertCurrent = () => {
    assertLifetime();
    const error = authorizeGatewaySessionCreation({
      cfg: resolved.context.getRuntimeConfig(),
      agentId: params.agentId,
      client,
    });
    if (error) {
      unwrapGatewayMethodDispatchResponse("agent", { ok: false, error });
    }
  };
  return {
    context: resolved.context,
    signal: inheritedAuthority?.signal,
    assertCurrent,
    async authorize() {
      assertLifetime();
      const { authorizeGatewayRequestPreDispatch, createRequestGatewayMethodRegistry } =
        await import("./server-methods.js");
      assertLifetime();
      const { error } = await authorizeGatewayRequestPreDispatch({
        method: "agent",
        requestParams: { agentId: params.agentId },
        client,
        context: resolved.context,
        methodRegistry:
          resolved.context.getGatewayMethodRegistry?.() ?? createRequestGatewayMethodRegistry(),
      });
      assertLifetime();
      if (error) {
        unwrapGatewayMethodDispatchResponse("agent", { ok: false, error });
      }
      assertCurrent();
    },
    run<T>(run: () => Promise<T>): Promise<T> {
      assertCurrent();
      return operatorToolGatewayAuthority.exit(run);
    },
  };
}

async function withInProcessGatewayDispatch<T>(
  method: string,
  options: DispatchGatewayMethodInProcessOptions | undefined,
  run: (resolved: ResolvedInProcessGatewayDispatch) => Promise<T>,
): Promise<T> {
  const resolved = resolveInProcessGatewayDispatch(method, options);
  try {
    // A launched agent is autonomous; retaining tool-call AsyncLocalStorage would
    // leak the human authority into later model-selected work after closure.
    return method === "agent" && operatorToolGatewayAuthority.getStore()
      ? await operatorToolGatewayAuthority.exit(() => run(resolved))
      : await run(resolved);
  } finally {
    cancelSubagentCompletionToolHandoff(resolved.delegatedToolPolicyHandoffId);
  }
}

export type { GatewayMethodDispatchResponse } from "./server-in-process-dispatch.js";

export async function dispatchGatewayMethodInProcessRaw(
  method: string,
  params: unknown,
  options?: DispatchGatewayMethodInProcessOptions,
): Promise<GatewayMethodDispatchResponse> {
  return await withInProcessGatewayDispatch(method, options, async (resolved) => {
    return await dispatchGatewayRequestInProcessRaw(method, params, {
      client: resolved.client,
      context: resolved.context,
      expectFinal: options?.expectFinal,
      isWebchatConnect: resolved.isWebchatConnect,
      methodRegistry: resolved.context.getGatewayMethodRegistry?.(),
      onAccepted: options?.onAccepted,
      onSignalAbort: options?.onSignalAbort,
      requestIdPrefix: "plugin-subagent",
      sessionMutationCommitGuard: () => {
        resolved.assertContextCurrent();
        options?.sessionMutationCommitGuard?.();
      },
      timeoutMs: options?.timeoutMs,
      ...(options?.signal ? { signal: options.signal } : {}),
    });
  });
}

/** Live request context for trusted built-in tools that need direct runtime state. */
export function getInProcessGatewayRequestContext(
  resolveGatewayContext?: GatewayContextResolver,
): GatewayRequestContext | undefined {
  if (resolveGatewayContext) {
    return resolveGatewayContext();
  }
  const scope = getPluginRuntimeGatewayRequestScope();
  return scope?.resolveGatewayContext ? scope.resolveGatewayContext() : scope?.context;
}

export async function dispatchGatewayMethodInProcess<T>(
  method: string,
  params: Record<string, unknown>,
  options?: DispatchGatewayMethodInProcessOptions,
): Promise<T> {
  if (method === "agent" || method === "agent.wait") {
    return await withInProcessGatewayDispatch(method, options, async (resolved) => {
      const createAgentTurnFacade = resolved.context.createAgentTurnFacade;
      if (!createAgentTurnFacade) {
        throw new Error(`Gateway instance agent turn facade unavailable for ${method}`);
      }
      // Plugins may load through another source/bundle graph. Only the captured host can
      // create turns against its published runtime; a local import creates a second owner.
      const facade = await createAgentTurnFacade({
        assertContextCurrent: resolved.assertContextCurrent,
        client: resolved.client,
        isWebchatConnect: resolved.isWebchatConnect,
      });
      return method === "agent"
        ? await facade.dispatch<T>(params as AgentRunRequest, {
            assertAdmissionCurrent: options?.sessionMutationCommitGuard,
            cancelOnDeadline: options?.cancelOnDeadline,
            expectFinal: options?.expectFinal,
            onAccepted: options?.onAccepted,
            onExecutionStarted: options?.onExecutionStarted,
            onSignalAbort: options?.onSignalAbort,
            signal: options?.signal,
            timeoutMs: options?.timeoutMs,
          })
        : await facade.wait<T>(
            params as AgentWaitParams,
            options?.timeoutMs,
            options?.signal,
            options?.onSignalAbort,
          );
    });
  }
  const response = await dispatchGatewayMethodInProcessRaw(method, params, options);
  return unwrapGatewayMethodDispatchResponse(method, response) as T;
}
