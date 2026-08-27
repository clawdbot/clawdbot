import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentWaitParams } from "../../packages/gateway-protocol/src/index.js";
import type { SubagentCompletionToolHandoffRegistration } from "../agents/subagents/announce/subagent-announce-handoff.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import type { PluginSubagentRequesterContext } from "../plugins/runtime/subagent-requester-context.js";
import type { RuntimePluginToolGrant } from "../plugins/runtime/tool-grant.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { readInProcessAgentRuntimeIdentity } from "./in-process-agent-runtime-identity.js";
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

const loadInternalAgentTurnFacade = createLazyRuntimeModule(
  () => import("./agent-turn/internal-facade.runtime.js"),
);

type OperatorToolGatewayAuthority = {
  authenticatedUserProfile: NonNullable<
    NonNullable<GatewayRequestOptions["client"]>["authenticatedUserProfile"]
  >;
  scopes: readonly string[];
  active: boolean;
};

const operatorToolGatewayAuthority = new AsyncLocalStorage<OperatorToolGatewayAuthority>();

/** Retains one verified operator identity only for its awaited tool invocation. */
export async function withOperatorToolGatewayAuthority<T>(
  authority: Omit<OperatorToolGatewayAuthority, "active">,
  run: () => Promise<T>,
): Promise<T> {
  const activeAuthority = { ...authority, active: true };
  try {
    return await operatorToolGatewayAuthority.run(activeAuthority, run);
  } finally {
    activeAuthority.active = false;
  }
}

type DispatchGatewayMethodInProcessOptions = {
  allowSyntheticModelOverride?: boolean;
  allowSyntheticCronRunContinuation?: boolean;
  agentToolCaller?: TrustedAgentToolCaller;
  agentRunTracking?: GatewayAgentRunTaskOwner;
  disableSyntheticClient?: boolean;
  expectFinal?: boolean;
  forceSyntheticClient?: boolean;
  internalDeliveryMediaUrls?: string[];
  internalDeliverySuppressText?: boolean;
  nodeInvokeStream?: GatewayNodeInvokeStream;
  onAccepted?: (payload: unknown) => void;
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
};

type ResolvedInProcessGatewayDispatch = {
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
  if (inheritedOperatorAuthority && !inheritedOperatorAuthority.active) {
    throw new Error("operator tool invocation authority expired");
  }
  const scope = getPluginRuntimeGatewayRequestScope();
  const scopedOperatorProfile = scope?.client?.authenticatedUserProfile;
  const scopedRoleActor = scope?.client?.internal?.operatorRoleActor;
  const explicitSystemActor = !scope?.client ? options?.operatorRoleActor : undefined;
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
  const operatorRoleActor: GatewayOperatorRoleActor | undefined = isHostOwnedAgentRun
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
    : (scopedRoleActor ?? explicitSystemActor);
  const context = getInProcessGatewayRequestContext(options?.resolveGatewayContext);
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
    client:
      options?.forceSyntheticClient === true ? syntheticClient : (scopedClient ?? syntheticClient),
    context,
    delegatedToolPolicyHandoffId,
    isWebchatConnect,
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
  return await withInProcessGatewayDispatch(
    method,
    options,
    async (resolved) =>
      await dispatchGatewayRequestInProcessRaw(method, params, {
        client: resolved.client,
        context: resolved.context,
        expectFinal: options?.expectFinal,
        isWebchatConnect: resolved.isWebchatConnect,
        methodRegistry: resolved.context.getGatewayMethodRegistry?.(),
        onAccepted: options?.onAccepted,
        onSignalAbort: options?.onSignalAbort,
        requestIdPrefix: "plugin-subagent",
        timeoutMs: options?.timeoutMs,
        ...(options?.signal ? { signal: options.signal } : {}),
      }),
  );
}

/** Live request context for trusted built-in tools that need direct runtime state. */
export function getInProcessGatewayRequestContext(
  resolveGatewayContext?: GatewayContextResolver,
): GatewayRequestContext | undefined {
  if (resolveGatewayContext) {
    return resolveGatewayContext();
  }
  const scope = getPluginRuntimeGatewayRequestScope();
  return scope?.resolveGatewayContext?.() ?? scope?.context;
}

export async function dispatchGatewayMethodInProcess<T>(
  method: string,
  params: Record<string, unknown>,
  options?: DispatchGatewayMethodInProcessOptions,
): Promise<T> {
  if (method === "agent" || method === "agent.wait") {
    return await withInProcessGatewayDispatch(method, options, async (resolved) => {
      const { createInternalAgentTurnFacade } = await loadInternalAgentTurnFacade();
      const assertContextCurrent = () => {
        if (
          getInProcessGatewayRequestContext(options?.resolveGatewayContext) !== resolved.context
        ) {
          throw new Error(
            `In-process gateway dispatch requires a current gateway instance binding (method: ${method}).`,
          );
        }
      };
      const facade = createInternalAgentTurnFacade({
        assertContextCurrent,
        client: resolved.client,
        getContext: () => {
          assertContextCurrent();
          return resolved.context;
        },
        ...(resolved.context.getGatewayMethodRegistry
          ? { getMethodRegistry: resolved.context.getGatewayMethodRegistry }
          : {}),
        isWebchatConnect: resolved.isWebchatConnect,
      });
      return method === "agent"
        ? await facade.dispatch<T>(params as AgentRunRequest, {
            expectFinal: options?.expectFinal,
            onAccepted: options?.onAccepted,
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
