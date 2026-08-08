import type { InputProvenance } from "../../sessions/input-provenance.js";
import { clientHasAdminScope } from "./agent-handler-helpers.js";
import type { AgentRunRequest } from "./agent-request-types.js";
import type { GatewayClient } from "./shared-types.js";

export type GatewayCronCreatorAuthorityAdmission = Readonly<{ runId: string }>;

/** Mints fresh cron authority only for an admitted direct local operator turn. */
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
  const internal = params.client?.internal;
  const request = params.request;
  const isDirectLocalOperator =
    clientHasAdminScope(params.client ?? null) &&
    internal?.isLocalClient === true &&
    Boolean(params.resolvedSessionKey?.trim()) &&
    !params.spawnedBy?.trim() &&
    params.inputProvenance === undefined &&
    !params.hasRestoredCronContinuation &&
    !params.isOneShotModelRun &&
    !params.isRestartRecoveryResumeRun &&
    request.modelRun !== true &&
    request.acpTurnSource === undefined &&
    request.internalRuntimeHandoffId === undefined &&
    request.internalExecutionIdentityRetry !== true &&
    request.execApprovalFollowupExpectedSessionId === undefined &&
    request.internalEvents === undefined &&
    request.sessionEffects !== "internal" &&
    request.suppressPromptPersistence !== true &&
    request.swarmCollector !== true &&
    request.lane !== "subagent" &&
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
  return isDirectLocalOperator && params.runId.trim()
    ? Object.freeze({ runId: params.runId.trim() })
    : undefined;
}
