import { setTimeout as delay } from "node:timers/promises";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { AgentRuntimeIdentity } from "../../../gateway/agent-runtime-identity-token.js";
import { withInProcessAgentRuntimeIdentity } from "../../../gateway/in-process-agent-runtime-identity.js";
import type { GatewayContextResolver } from "../../../gateway/server-methods/types.js";
import { isGatewayRpcUnavailableError } from "../../../gateway/transport-error.js";
import type { WorkerTurnExecutionIdentity } from "../../../gateway/worker-environments/placement-turn-claim-events.js";
import { getActiveAgentRunDelegatedAuthority } from "../../../infra/agent-run-registry.js";
import { getPluginRuntimeGatewayRequestScope } from "../../../plugins/runtime/gateway-request-scope.js";
import { getGatewayToolCallerIdentity } from "../../tools/gateway-caller-context.js";
import { runWithGatewaySessionSpawnContext } from "../../tools/gateway-session-spawn-context.js";
import { runWithGatewaySessionSpawnParentExecutionIdentity } from "../../tools/gateway-session-spawn-execution-identity.js";
import { callGatewayTool } from "../../tools/gateway.js";
import { resolveSubagentRunTimerDelayMs } from "../registry/subagent-run-timeout.js";
import type { SubagentLaunchAuthorization } from "./subagent-launch-authorization.js";
import { applySubagentLaunchAuthorization } from "./subagent-launch-authorization.js";
import { getSubagentSpawnDeps } from "./subagent-spawn-deps.js";
import { readSubagentGatewayExecutionIdentity } from "./subagent-spawn-execution-identity.js";
import {
  ADMIN_SCOPE,
  callGateway,
  resolveLeastPrivilegeOperatorScopesForMethod,
} from "./subagent-spawn.runtime.js";

const DEFAULT_SUBAGENT_AGENT_GATEWAY_TIMEOUT_MS = 60_000;
const MAX_SUBAGENT_AGENT_GATEWAY_TIMEOUT_MS = 300_000;
const SUBAGENT_AGENT_RECONCILE_INTERVAL_MS = 800;
const SUBAGENT_AGENT_RECONCILE_TIMEOUT_MS = 6_400;

type SubagentGatewayResponse = Awaited<ReturnType<typeof callGateway>>;
type SubagentGatewayDispatchMode = "in_process" | "out_of_process";

async function callSubagentGatewayWithDispatchMode(
  params: Parameters<typeof callGateway>[0],
  authorization?: SubagentLaunchAuthorization,
  options?: {
    agentRunTracking?: "native_subagent";
    gatewayContextResolver?: GatewayContextResolver;
  },
): Promise<{ response: SubagentGatewayResponse; dispatchMode: SubagentGatewayDispatchMode }> {
  const { sessionSpawnContext, parentExecutionIdentityToken } =
    readSubagentGatewayExecutionIdentity(params) ?? {};
  // Subagent lifecycle requires methods spanning multiple scope tiers
  // (sessions.delete → admin, agent → write). When each call
  // independently negotiates least-privilege scopes the first connection pairs
  // at a lower tier and every subsequent higher-tier call triggers a
  // scope-upgrade handshake that headless gateway-client connections cannot
  // complete interactively, causing close(1008) "pairing required" (#59428).
  //
  // Only admin-requiring calls are pinned to ADMIN_SCOPE; other methods (e.g.
  // "agent" -> write) keep their least-privilege scope. Apply the trusted
  // launch authorization before resolving the request's required scope.
  const authorizedParams =
    params.params != null && typeof params.params === "object" && !Array.isArray(params.params)
      ? applySubagentLaunchAuthorization(params.params as Record<string, unknown>, authorization)
      : params.params;
  const leastPrivilegeScopes = resolveLeastPrivilegeOperatorScopesForMethod(
    params.method,
    authorizedParams,
  );
  const allowModelOverride = authorization !== undefined;
  const deps = getSubagentSpawnDeps();
  const gatewayCaller = getGatewayToolCallerIdentity();
  const gatewayContextResolver =
    options?.gatewayContextResolver ??
    gatewayCaller?.gatewayContextResolver ??
    getPluginRuntimeGatewayRequestScope()?.resolveGatewayContext;
  // A closed owner still requires in-process rejection, never a new socket route.
  const hasInProcessGateway =
    gatewayContextResolver !== undefined || deps.hasInProcessGatewayContext();
  const needsOutOfProcessModelOverrideAuth = allowModelOverride && !hasInProcessGateway;
  const scopes =
    params.scopes ??
    (leastPrivilegeScopes.includes(ADMIN_SCOPE) || needsOutOfProcessModelOverrideAuth
      ? [ADMIN_SCOPE]
      : undefined);
  const request = {
    ...params,
    params: authorizedParams,
    ...(scopes != null ? { scopes } : {}),
  };
  if (
    hasInProcessGateway &&
    request.params != null &&
    typeof request.params === "object" &&
    !Array.isArray(request.params)
  ) {
    // Spawn is already running in the gateway process for channel/tool calls.
    // Direct dispatch avoids self-connecting over WS while the same event loop is busy.
    // Agent launches are host-owned even when the parent request came from CLI/HTTP.
    // Reusing that external identity makes collector preflight treat the launch as spoofed.
    const isChildRunLaunch = request.method === "agent";
    const forceSyntheticClient = isChildRunLaunch || scopes != null;
    const dispatch = async (workerIdentity?: WorkerTurnExecutionIdentity) => {
      const operationalRunInstance = gatewayCaller?.workerTurnClaim
        ? workerIdentity?.operationalRunInstance
        : gatewayCaller?.operationalRunInstance;
      const activeAuthority = operationalRunInstance
        ? (workerIdentity?.delegatedAuthority ??
          getActiveAgentRunDelegatedAuthority(operationalRunInstance))
        : undefined;
      const agentRuntimeIdentity: AgentRuntimeIdentity | undefined =
        sessionSpawnContext && gatewayCaller && operationalRunInstance && activeAuthority
          ? {
              kind: "agentRuntime",
              agentId: workerIdentity?.agentId ?? gatewayCaller.agentId,
              sessionKey: workerIdentity?.sessionKey ?? gatewayCaller.sessionKey,
              operationalRunInstance,
              delegatedAuthority: workerIdentity
                ? { kind: "worker", ...activeAuthority, turnClaim: workerIdentity.turnClaim }
                : { kind: "local", ...activeAuthority },
              ...(parentExecutionIdentityToken
                ? { executionIdentity: parentExecutionIdentityToken }
                : {}),
              sessionSpawnContext,
            }
          : undefined;
      return await deps.dispatchGatewayMethodInProcess(
        request.method,
        request.params as Record<string, unknown>,
        withInProcessAgentRuntimeIdentity(
          {
            expectFinal: request.expectFinal,
            ...(allowModelOverride ? { allowSyntheticModelOverride: true } : {}),
            ...(options?.agentRunTracking ? { agentRunTracking: options.agentRunTracking } : {}),
            ...(gatewayContextResolver ? { resolveGatewayContext: gatewayContextResolver } : {}),
            ...(forceSyntheticClient ? { forceSyntheticClient: true } : {}),
            ...(typeof request.timeoutMs === "number" ? { timeoutMs: request.timeoutMs } : {}),
            ...(scopes != null ? { syntheticScopes: scopes } : {}),
          },
          agentRuntimeIdentity,
        ),
      );
    };
    const workerCapability = gatewayCaller?.workerTurnExecutionIdentityCapability;
    const response = workerCapability
      ? await workerCapability.run(async (identity) => {
          if (
            gatewayCaller?.agentId !== identity.agentId ||
            gatewayCaller.sessionKey !== identity.sessionKey ||
            gatewayCaller.operationalRunInstance !== identity.operationalRunInstance ||
            gatewayCaller.executionIdentityToken !== identity.executionIdentityToken ||
            gatewayCaller.workerTurnClaim !== identity.turnClaim ||
            parentExecutionIdentityToken !== identity.executionIdentityToken
          ) {
            throw new Error("worker child admission identity changed");
          }
          return await dispatch(identity);
        })
      : await dispatch();
    return { response, dispatchMode: "in_process" };
  }
  const dispatchAgentRequest = (timeoutMs?: number | null) =>
    sessionSpawnContext && gatewayCaller?.operationalRunInstance
      ? runWithGatewaySessionSpawnContext(sessionSpawnContext, () =>
          runWithGatewaySessionSpawnParentExecutionIdentity(parentExecutionIdentityToken, () =>
            callGatewayTool(
              request.method,
              typeof timeoutMs === "number" ? { timeoutMs } : {},
              request.params,
              {
                expectFinal: request.expectFinal,
                scopes,
                requireAgentRuntimeIdentity: true,
              },
            ),
          ),
        )
      : deps.callGateway(typeof timeoutMs === "number" ? { ...request, timeoutMs } : request);
  // Only agent launches have an idempotency key backed by authoritative Gateway state.
  // Other methods must not repeat after a transport-ambiguous failure.
  const response =
    request.method === "agent"
      ? await reconcileSubagentAgentDispatch(dispatchAgentRequest, request.timeoutMs)
      : await dispatchAgentRequest(request.timeoutMs);
  return { response, dispatchMode: "out_of_process" };
}

async function reconcileSubagentAgentDispatch(
  dispatch: (timeoutMs?: number | null) => Promise<SubagentGatewayResponse>,
  timeoutMs?: number | null,
): Promise<SubagentGatewayResponse> {
  try {
    return await dispatch(timeoutMs);
  } catch (error) {
    if (!isGatewayRpcUnavailableError(error)) {
      throw error;
    }
    const deadline = Date.now() + SUBAGENT_AGENT_RECONCILE_TIMEOUT_MS;
    while (true) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw error;
      }
      // Only an explicit provisional replay gets another attempt. Transport failures
      // and Gateway rejections remain terminal, so an unreachable Gateway pays at
      // most one short reconciliation call instead of a second launch timeout.
      const response = await dispatch(Math.min(SUBAGENT_AGENT_RECONCILE_INTERVAL_MS, remainingMs));
      const replay = asOptionalRecord(response);
      if (
        replay?.admissionPending !== true &&
        (replay?.status === "accepted" || replay?.status === "in_flight") &&
        readGatewayRunId(response)
      ) {
        return response;
      }
      if (replay?.admissionPending !== true) {
        throw new Error(
          `Gateway found no active subagent run (status: ${String(replay?.status)}). Retry the spawn.`,
          { cause: error },
        );
      }
      await delay(
        Math.min(SUBAGENT_AGENT_RECONCILE_INTERVAL_MS, Math.max(0, deadline - Date.now())),
      );
    }
  }
}

export async function callSubagentGateway(
  params: Parameters<typeof callGateway>[0],
  authorization?: SubagentLaunchAuthorization,
): Promise<SubagentGatewayResponse> {
  return (await callSubagentGatewayWithDispatchMode(params, authorization)).response;
}

export async function callNativeSubagentGateway(
  params: Parameters<typeof callGateway>[0],
  authorization?: SubagentLaunchAuthorization,
  gatewayContextResolver?: GatewayContextResolver,
): Promise<{
  response: SubagentGatewayResponse;
  taskRowOwnership: "required" | "gateway_best_effort";
}> {
  const result = await callSubagentGatewayWithDispatchMode(params, authorization, {
    agentRunTracking: "native_subagent",
    gatewayContextResolver,
  });
  return {
    response: result.response,
    // The trusted marker exists only on direct dispatch. A WebSocket fallback keeps the
    // ordinary Gateway CLI policy: tracking is best-effort and never rejects an accepted run.
    taskRowOwnership: result.dispatchMode === "in_process" ? "required" : "gateway_best_effort",
  };
}

export function readGatewayRunId(
  response: Awaited<ReturnType<typeof callGateway>>,
): string | undefined {
  if (!response || typeof response !== "object") {
    return undefined;
  }
  const { runId } = response as { runId?: unknown };
  return typeof runId === "string" && runId.trim() ? runId.trim() : undefined;
}

export function resolveSubagentAgentGatewayTimeoutMs(runTimeoutSeconds: number): number {
  const runTimeoutMs = resolveSubagentRunTimerDelayMs(runTimeoutSeconds) ?? 0;
  if (runTimeoutMs <= 0) {
    return DEFAULT_SUBAGENT_AGENT_GATEWAY_TIMEOUT_MS;
  }
  return Math.min(
    MAX_SUBAGENT_AGENT_GATEWAY_TIMEOUT_MS,
    Math.max(DEFAULT_SUBAGENT_AGENT_GATEWAY_TIMEOUT_MS, runTimeoutMs + 5_000),
  );
}
