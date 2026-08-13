import { resolveSubagentRunTimerDelayMs } from "../registry/subagent-run-timeout.js";
import type { SubagentLaunchAuthorization } from "./subagent-launch-authorization.js";
import { applySubagentLaunchAuthorization } from "./subagent-launch-authorization.js";
import { getSubagentSpawnDeps } from "./subagent-spawn-deps.js";
import {
  ADMIN_SCOPE,
  callGateway,
  resolveLeastPrivilegeOperatorScopesForMethod,
} from "./subagent-spawn.runtime.js";

const DEFAULT_SUBAGENT_AGENT_GATEWAY_TIMEOUT_MS = 60_000;
const MAX_SUBAGENT_AGENT_GATEWAY_TIMEOUT_MS = 300_000;

type SubagentGatewayResponse = Awaited<ReturnType<typeof callGateway>>;
type SubagentGatewayDispatchMode = "in_process" | "out_of_process";

async function callSubagentGatewayWithDispatchMode(
  params: Parameters<typeof callGateway>[0],
  authorization?: SubagentLaunchAuthorization,
  options?: { agentRunTracking?: "native_subagent" },
): Promise<{ response: SubagentGatewayResponse; dispatchMode: SubagentGatewayDispatchMode }> {
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
  const hasInProcessGateway = deps.hasInProcessGatewayContext();
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
    const response = await deps.dispatchGatewayMethodInProcess(
      request.method,
      request.params as Record<string, unknown>,
      {
        expectFinal: request.expectFinal,
        ...(allowModelOverride ? { allowSyntheticModelOverride: true } : {}),
        ...(options?.agentRunTracking ? { agentRunTracking: options.agentRunTracking } : {}),
        ...(forceSyntheticClient ? { forceSyntheticClient: true } : {}),
        ...(typeof request.timeoutMs === "number" ? { timeoutMs: request.timeoutMs } : {}),
        ...(scopes != null ? { syntheticScopes: scopes } : {}),
      },
    );
    return { response, dispatchMode: "in_process" };
  }
  return { response: await deps.callGateway(request), dispatchMode: "out_of_process" };
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
): Promise<{
  response: SubagentGatewayResponse;
  taskRowOwnership: "required" | "gateway_best_effort";
}> {
  const result = await callSubagentGatewayWithDispatchMode(params, authorization, {
    agentRunTracking: "native_subagent",
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
