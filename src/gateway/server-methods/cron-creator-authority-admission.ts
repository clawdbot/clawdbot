import type { InputProvenance } from "../../sessions/input-provenance.js";
import { clientHasAdminScope } from "../agent-turn/agent-handler-helpers.js";
import type { AgentRunRequest } from "./agent-request-types.js";
import type { GatewayClient } from "./shared-types.js";

export type GatewayCronCreatorAuthorityAdmission = Readonly<{
  runId: string;
  callerOrigin: { kind: "local" };
}>;

type DirectLocalOperatorAuthorityParams = {
  runId: string;
  resolvedSessionKey?: string;
  spawnedBy?: string;
  client?: GatewayClient | null;
  inputProvenance?: InputProvenance;
  disallowed: boolean;
};

function resolveDirectLocalOperatorAuthority(
  params: DirectLocalOperatorAuthorityParams,
): GatewayCronCreatorAuthorityAdmission | undefined {
  const internal = params.client?.internal;
  const runId = params.runId.trim();
  const isDirectLocalOperator =
    runId.length > 0 &&
    clientHasAdminScope(params.client ?? null) &&
    internal?.isLocalClient === true &&
    Boolean(params.resolvedSessionKey?.trim()) &&
    !params.spawnedBy?.trim() &&
    params.inputProvenance === undefined &&
    !params.disallowed &&
    internal.syntheticClient !== true &&
    internal.senderAttribution === undefined &&
    internal.approvalRuntime !== true &&
    internal.cronRunContinuation !== true &&
    internal.agentRuntimeIdentity === undefined &&
    internal.pluginRuntimeOwnerId === undefined &&
    internal.agentRunTracking === undefined &&
    internal.pluginSubagentRequester === undefined &&
    internal.runtimePluginToolGrant === undefined &&
    internal.delegatedToolPolicyHandoffId === undefined;
  return isDirectLocalOperator
    ? Object.freeze({ runId, callerOrigin: { kind: "local" as const } })
    : undefined;
}

/** Mints fresh cron authority only for an admitted direct local agent RPC turn. */
export function resolveGatewayCronCreatorAuthorityAdmission(params: {
  runId: string;
  resolvedSessionKey?: string;
  spawnedBy?: string;
  client?: GatewayClient | null;
  request: AgentRunRequest;
  inputProvenance?: InputProvenance;
  hasRestoredCronContinuation: boolean;
  isOneShotModelRun: boolean;
  isRestartRecoveryResumeRun: boolean;
}): GatewayCronCreatorAuthorityAdmission | undefined {
  const request = params.request;
  return resolveDirectLocalOperatorAuthority({
    runId: params.runId,
    resolvedSessionKey: params.resolvedSessionKey,
    spawnedBy: params.spawnedBy,
    client: params.client,
    inputProvenance: params.inputProvenance,
    disallowed:
      params.hasRestoredCronContinuation ||
      params.isOneShotModelRun ||
      params.isRestartRecoveryResumeRun ||
      request.modelRun === true ||
      request.acpTurnSource !== undefined ||
      request.internalRuntimeHandoffId !== undefined ||
      request.internalExecutionIdentityRetry === true ||
      request.internalExecutionIdentityRecoveryAttempt !== undefined ||
      request.execApprovalFollowupExpectedSessionId !== undefined ||
      request.internalEvents !== undefined ||
      request.sessionEffects === "internal" ||
      request.suppressPromptPersistence === true ||
      request.swarmCollector === true ||
      request.lane === "subagent",
  });
}

/** Mints the same authority for an admitted ordinary local chat.send turn. */
export function resolveGatewayChatCronCreatorAuthorityAdmission(params: {
  runId: string;
  resolvedSessionKey?: string;
  spawnedBy?: string;
  client?: GatewayClient | null;
  inputProvenance?: InputProvenance;
  hasExplicitOrigin: boolean;
  hasRestoredCronContinuation: boolean;
  isIncognito: boolean;
  isReconnectResume: boolean;
  isSystemGenerated: boolean;
  turnKind: "btw" | "main";
  isDirectExternalUser: boolean;
}): GatewayCronCreatorAuthorityAdmission | undefined {
  return resolveDirectLocalOperatorAuthority({
    runId: params.runId,
    resolvedSessionKey: params.resolvedSessionKey,
    spawnedBy: params.spawnedBy,
    client: params.client,
    inputProvenance: params.inputProvenance,
    disallowed:
      !params.isDirectExternalUser ||
      params.hasExplicitOrigin ||
      params.hasRestoredCronContinuation ||
      params.isIncognito ||
      params.isReconnectResume ||
      params.isSystemGenerated ||
      params.turnKind !== "main",
  });
}
