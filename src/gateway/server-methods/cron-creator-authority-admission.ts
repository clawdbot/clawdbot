import type { InputProvenance } from "../../sessions/input-provenance.js";
import { clientHasAdminScope } from "../agent-turn/agent-handler-helpers.js";
import type { AgentRunRequest } from "./agent-request-types.js";
import type { GatewayClient } from "./shared-types.js";

export type GatewayCronCreatorAuthorityAdmission = Readonly<{
  runId: string;
  callerOrigin: { kind: "local" } | { kind: "unknown" };
  controlUiAdmin?: true;
}>;

type DirectOperatorAuthorityParams = {
  runId: string;
  resolvedSessionKey?: string;
  spawnedBy?: string;
  client?: GatewayClient | null;
  inputProvenance?: InputProvenance;
  disallowed: boolean;
};

function resolveDirectOperatorAuthority(
  params: DirectOperatorAuthorityParams,
): GatewayCronCreatorAuthorityAdmission | undefined {
  const internal = params.client?.internal;
  const runId = params.runId.trim();
  const isDirectOperator =
    runId.length > 0 &&
    clientHasAdminScope(params.client ?? null) &&
    (internal?.isLocalClient === true || internal?.controlUiAdmin === true) &&
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
  return isDirectOperator
    ? Object.freeze({
        runId,
        // Remote management admission does not confer the direct-local creator/operator capability.
        callerOrigin:
          internal?.isLocalClient === true
            ? { kind: "local" as const }
            : { kind: "unknown" as const },
        ...(internal?.controlUiAdmin === true ? { controlUiAdmin: true as const } : {}),
      })
    : undefined;
}

/** Mints cron authority for an admitted local operator or authenticated Control UI admin turn. */
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
  return resolveDirectOperatorAuthority({
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

/** Mints the same authority for an admitted ordinary operator chat.send turn. */
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
  return resolveDirectOperatorAuthority({
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
