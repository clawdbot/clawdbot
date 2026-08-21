import type { AgentWaitParams } from "../../packages/gateway-protocol/src/index.js";
import type { SubagentCompletionToolHandoffRegistration } from "../agents/subagents/announce/subagent-announce-handoff.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import type { PluginSubagentRequesterContext } from "../plugins/runtime/subagent-requester-context.js";
import type { RuntimePluginToolGrant } from "../plugins/runtime/tool-grant.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { readInProcessAgentRuntimeIdentity } from "./in-process-agent-runtime-identity.js";
import {
  dispatchGatewayRequestInProcessRaw,
  type GatewayMethodDispatchResponse,
  unwrapGatewayMethodDispatchResponse,
} from "./server-in-process-dispatch.js";
import type { AgentRunRequest } from "./server-methods/agent-request-types.js";
import type { TrustedSessionCreation } from "./server-methods/session-creation-provenance.js";
import type {
  GatewayAgentRunTaskOwner,
  GatewayContextResolver,
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
  onAccepted?: (payload: unknown) => void;
  onSignalAbort?: () => Promise<void> | void;
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
  const scope = getPluginRuntimeGatewayRequestScope();
  const context =
    options?.resolveGatewayContext?.() ?? scope?.resolveGatewayContext?.() ?? scope?.context;
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
  const delegatedToolPolicyHandoffId = options?.delegatedToolPolicyHandoff
    ? registerSubagentCompletionToolHandoff(options.delegatedToolPolicyHandoff)
    : undefined;
  const baseSyntheticClient = createSyntheticPluginRuntimeClient({
    allowModelOverride: options?.allowSyntheticModelOverride === true,
    agentToolCaller: options?.agentToolCaller,
    agentRunTracking: options?.agentRunTracking,
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
    scopes: options?.syntheticScopes,
  });
  const agentRuntimeIdentity = readInProcessAgentRuntimeIdentity(options);
  const syntheticClient = agentRuntimeIdentity
    ? {
        ...baseSyntheticClient,
        internal: { ...baseSyntheticClient.internal, agentRuntimeIdentity },
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
    return await run(resolved);
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
  const scope = getPluginRuntimeGatewayRequestScope();
  return resolveGatewayContext?.() ?? scope?.resolveGatewayContext?.() ?? scope?.context;
}

export async function dispatchGatewayMethodInProcess<T>(
  method: string,
  params: Record<string, unknown>,
  options?: DispatchGatewayMethodInProcessOptions,
): Promise<T> {
  if (method === "agent" || method === "agent.wait") {
    return await withInProcessGatewayDispatch(method, options, async (resolved) => {
      const { createInternalAgentTurnFacade } = await loadInternalAgentTurnFacade();
      const facade = createInternalAgentTurnFacade({
        client: resolved.client,
        getContext: () => resolved.context,
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
