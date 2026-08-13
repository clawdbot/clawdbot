import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { tryResolveLegacyCompatibilityAgentId } from "../../agents/agent-scope.js";
import { parseExecApprovalFollowupApprovalId } from "../../agents/bash-tools.exec-approval-followup-state.js";
import { normalizeSpawnedRunMetadata } from "../../agents/spawned-context.js";
import {
  findAuthorizedSwarmCollectorRequest,
  findSwarmCollectorSession,
} from "../../agents/subagents/registry/subagent-registry-memory.js";
import { resolveSwarmConfig } from "../../agents/subagents/swarm/swarm-config.js";
import { validateStructuredOutputSchema } from "../../agents/subagents/swarm/swarm-output-schema.js";
import { resolveSessionStorePathCore } from "../../config/sessions.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import {
  isMainSessionRestartRecoveryInputProvenance,
  normalizeInputProvenance,
  shouldPreserveUserFacingSessionStateForInputProvenance,
} from "../../sessions/input-provenance.js";
import { isSubagentSessionKey } from "../../sessions/session-key-utils.js";
import {
  resolveExpectedExistingSessionConstraint,
  type ExpectedExistingSessionConstraint,
} from "../server-methods/agent-expected-session.js";
import type { AgentRunRequest } from "../server-methods/agent-request-types.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { readGatewayDedupeEntry, resolveAgentDedupeKeys } from "./agent-dedupe.js";
import {
  resolveAllowModelOverrideFromClient,
  resolveCanUseCronRunContinuation,
  resolveCanUseInternalRuntimeHandoff,
} from "./agent-handler-helpers.js";
import type { AgentTurnContext, AgentTurnIo, AgentTurnPrincipal } from "./types.js";

export type AgentRequestPreflight = {
  request: AgentRunRequest;
  cfg: ReturnType<AgentTurnContext["getRuntimeConfig"]>;
  runId: string;
  allowModelOverride: boolean;
  canUseInternalRuntimeHandoff: boolean;
  canUseCronRunContinuation: boolean;
  expectedSession?: ExpectedExistingSessionConstraint;
  expectedExistingSessionId?: string;
  providerOverride?: string;
  modelOverride?: string;
  execApprovalFollowupApprovalId?: string;
  normalizedSpawned: ReturnType<typeof normalizeSpawnedRunMetadata>;
  inputProvenance: ReturnType<typeof normalizeInputProvenance>;
  isRestartRecoveryResumeRun: boolean;
  preserveUserFacingSessionModelState: boolean;
  sessionEffects?: "visible" | "internal";
  suppressVisibleSessionEffects: boolean;
  requestedPromptPersistenceSuppression: boolean;
  isOneShotModelRun: boolean;
  isRawModelRun: boolean;
  agentDedupeKeys: string[];
};

export function prepareAgentRequestPreflight(params: {
  request: AgentRunRequest;
  context: AgentTurnContext;
  client: AgentTurnPrincipal | null;
  io: AgentTurnIo;
}): AgentRequestPreflight | undefined {
  const { request } = params;
  const cfg = params.context.getRuntimeConfig();
  const canUseInternalRuntimeHandoff = resolveCanUseInternalRuntimeHandoff(params.client);
  const requestSessionKey = request.sessionKey?.trim();
  const parsedRequestSessionKey = requestSessionKey
    ? parseAgentSessionKey(requestSessionKey)
    : undefined;
  const bareSessionAgent =
    requestSessionKey && !parsedRequestSessionKey
      ? resolveRequestedSessionAgentId(cfg, requestSessionKey, request.agentId)
      : undefined;
  if (bareSessionAgent && !bareSessionAgent.ok) {
    params.io.emitAcceptance([false, undefined, bareSessionAgent.error]);
    return undefined;
  }
  const selectedAgentId = requestSessionKey
    ? (parsedRequestSessionKey?.agentId ??
      bareSessionAgent?.agentId ??
      normalizeOptionalString(request.agentId) ??
      tryResolveLegacyCompatibilityAgentId(cfg))
    : (normalizeOptionalString(request.agentId) ?? tryResolveLegacyCompatibilityAgentId(cfg));
  const collectorSession = findSwarmCollectorSession(requestSessionKey);
  // Collector children always use subagent session keys, so ordinary traffic
  // must never pay the persisted-store read. The store fallback only covers a
  // freshly restarted gateway whose in-memory registry has not reloaded yet.
  const persistedCollectorSession =
    !collectorSession && requestSessionKey && isSubagentSessionKey(requestSessionKey)
      ? loadSessionEntry({
          ...(selectedAgentId ? { agentId: selectedAgentId } : {}),
          storePath: resolveSessionStorePathCore(cfg.session?.store, {
            agentId: selectedAgentId,
          }),
          sessionKey: requestSessionKey,
        })?.swarmCollector === true
      : false;
  if (
    collectorSession ||
    persistedCollectorSession ||
    request.swarmCollector === true ||
    request.swarmOutputSchema !== undefined
  ) {
    const schemaError = request.swarmOutputSchema
      ? validateStructuredOutputSchema(request.swarmOutputSchema)
      : undefined;
    if (request.swarmCollector !== true || schemaError) {
      params.io.emitAcceptance([
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          schemaError ?? "active swarm collector sessions require swarmCollector=true",
        ),
      ]);
      return undefined;
    }
    const registeredCollector = findAuthorizedSwarmCollectorRequest({
      childSessionKey: request.sessionKey,
      idempotencyKey: request.idempotencyKey,
      outputSchema: request.swarmOutputSchema,
    });
    const collectorDedupe = readGatewayDedupeEntry({
      dedupe: params.context.dedupe,
      keys: resolveAgentDedupeKeys({ idempotencyKey: request.idempotencyKey }),
    });
    const swarmRequesterSessionKey =
      registeredCollector?.swarmRequesterSessionKey ?? registeredCollector?.requesterSessionKey;
    const swarmEnabled = resolveSwarmConfig(
      cfg,
      registeredCollector?.requesterAgentId ??
        (swarmRequesterSessionKey
          ? (parseAgentSessionKey(swarmRequesterSessionKey)?.agentId ?? selectedAgentId)
          : selectedAgentId),
    ).enabled;
    const pendingCollectorLaunch =
      registeredCollector?.swarmLaunchPending === true &&
      !registeredCollector.collectorCompletion &&
      typeof registeredCollector.execution.endedAt !== "number";
    if (
      (!swarmEnabled && !collectorDedupe) ||
      !canUseInternalRuntimeHandoff ||
      request.lane !== "subagent" ||
      !registeredCollector ||
      (!pendingCollectorLaunch && !collectorDedupe)
    ) {
      params.io.emitAcceptance([
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "swarm collector fields require an enabled, host-registered collector run",
        ),
      ]);
      return undefined;
    }
  }
  if (request.cwd && !path.isAbsolute(request.cwd)) {
    params.io.emitAcceptance([
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "cwd must be absolute"),
    ]);
    return undefined;
  }
  if (request.cwd && !normalizeOptionalString(params.client?.internal?.pluginRuntimeOwnerId)) {
    params.io.emitAcceptance([
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "cwd is reserved for plugin-owned subagent runs"),
    ]);
    return undefined;
  }
  const allowModelOverride = resolveAllowModelOverrideFromClient(params.client);
  const canUseCronRunContinuation = resolveCanUseCronRunContinuation(params.client);
  const expectedSessionResult = resolveExpectedExistingSessionConstraint({
    canUseInternalRuntimeHandoff,
    expectedExistingSessionId: request.expectedExistingSessionId,
    internalRuntimeHandoffId: request.internalRuntimeHandoffId,
  });
  if (!expectedSessionResult.ok) {
    params.io.emitAcceptance([
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, expectedSessionResult.error),
    ]);
    return undefined;
  }
  const requestedPromptPersistenceSuppression = request.suppressPromptPersistence === true;
  const requestedInternalSessionEffects = request.sessionEffects === "internal";
  const requestedModelOverride = Boolean(request.provider || request.model);
  const isOneShotModelRun = request.modelRun === true;
  const isRawModelRun = isOneShotModelRun || request.promptMode === "none";
  if (request.promptMode === "none" && !isOneShotModelRun) {
    params.io.emitAcceptance([
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        'promptMode="none" requires modelRun=true so the run cannot mutate a durable session.',
      ),
    ]);
    return undefined;
  }
  if (requestedModelOverride && !allowModelOverride) {
    params.io.emitAcceptance([
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "provider/model overrides are not authorized for this caller.",
      ),
    ]);
    return undefined;
  }
  if (
    (requestedInternalSessionEffects || requestedPromptPersistenceSuppression) &&
    !canUseInternalRuntimeHandoff
  ) {
    params.io.emitAcceptance([
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "internal session-effect controls are reserved for backend callers.",
      ),
    ]);
    return undefined;
  }
  const runId = request.idempotencyKey;
  const execApprovalFollowupApprovalId = parseExecApprovalFollowupApprovalId(runId);
  if (execApprovalFollowupApprovalId && !canUseInternalRuntimeHandoff) {
    params.io.emitAcceptance([
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "exec approval followup idempotency keys are reserved for backend callers.",
      ),
    ]);
    return undefined;
  }
  const inputProvenance = normalizeInputProvenance(request.inputProvenance);
  const isRestartRecoveryResumeRun =
    canUseInternalRuntimeHandoff && isMainSessionRestartRecoveryInputProvenance(inputProvenance);
  if (
    (request.internalExecutionIdentityRetry !== undefined ||
      request.internalExecutionIdentityRecoveryAttempt !== undefined) &&
    !isRestartRecoveryResumeRun
  ) {
    params.io.emitAcceptance([
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "internal execution identity recovery fields are reserved for main-session restart recovery.",
      ),
    ]);
    return undefined;
  }
  if (request.forceCodeModeTools === true && !isRestartRecoveryResumeRun) {
    params.io.emitAcceptance([
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "forceCodeModeTools is reserved for main-session restart recovery.",
      ),
    ]);
    return undefined;
  }
  const sessionEffects =
    isOneShotModelRun || requestedInternalSessionEffects ? "internal" : request.sessionEffects;
  const agentDedupeKeys = resolveAgentDedupeKeys({
    idempotencyKey: runId,
    execApprovalFollowupApprovalId,
  });
  return {
    request,
    cfg,
    runId,
    allowModelOverride,
    canUseInternalRuntimeHandoff,
    canUseCronRunContinuation,
    expectedSession: expectedSessionResult.constraint,
    expectedExistingSessionId: expectedSessionResult.constraint?.sessionId,
    providerOverride: allowModelOverride ? request.provider : undefined,
    modelOverride: allowModelOverride ? request.model : undefined,
    execApprovalFollowupApprovalId,
    normalizedSpawned: normalizeSpawnedRunMetadata({
      groupId: request.groupId,
      groupChannel: request.groupChannel,
      groupSpace: request.groupSpace,
    }),
    inputProvenance,
    isRestartRecoveryResumeRun,
    preserveUserFacingSessionModelState:
      canUseInternalRuntimeHandoff &&
      shouldPreserveUserFacingSessionStateForInputProvenance(inputProvenance),
    sessionEffects,
    suppressVisibleSessionEffects: sessionEffects === "internal",
    requestedPromptPersistenceSuppression,
    isOneShotModelRun,
    isRawModelRun,
    agentDedupeKeys,
  };
}
