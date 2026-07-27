import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  buildCachedAgentResultErrorDetails,
  errorShape,
  validateAgentParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { parseExecApprovalFollowupApprovalId } from "../../agents/bash-tools.exec-approval-followup-state.js";
import { normalizeSpawnedRunMetadata } from "../../agents/spawned-context.js";
import {
  findAuthorizedSwarmCollectorRequest,
  findSwarmCollectorSession,
} from "../../agents/subagent-registry-memory.js";
import { resolveSwarmConfig } from "../../agents/swarm-config.js";
import { validateStructuredOutputSchema } from "../../agents/swarm-output-schema.js";
import { resolveAgentIdFromSessionKey, resolveStorePath } from "../../config/sessions.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import {
  isMainSessionRestartRecoveryInputProvenance,
  normalizeInputProvenance,
  shouldPreserveUserFacingSessionStateForInputProvenance,
} from "../../sessions/input-provenance.js";
import { isSubagentSessionKey } from "../../sessions/session-key-utils.js";
import {
  isAcceptedAgentDedupePayload,
  readGatewayDedupeEntry,
  resolveAgentDedupeKeys,
} from "./agent-dedupe.js";
import {
  resolveExpectedExistingSessionConstraint,
  type ExpectedExistingSessionConstraint,
} from "./agent-expected-session.js";
import {
  resolveAllowModelOverrideFromClient,
  resolveCanUseCronRunContinuation,
  resolveCanUseInternalRuntimeHandoff,
} from "./agent-handler-helpers.js";
import { readAgentRunRecoveryEntry } from "./agent-job.js";
import type { AgentRunRequest } from "./agent-request-types.js";
import type { GatewayRequestHandlerOptions } from "./types.js";
import { assertValidParams } from "./validation.js";

type AgentRequestPreflight = {
  request: AgentRunRequest;
  cfg: ReturnType<GatewayRequestHandlerOptions["context"]["getRuntimeConfig"]>;
  runId: string;
  lifecycleGeneration: string;
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

function readCachedAgentRunId(payload: unknown, fallbackRunId: string): string {
  if (payload && typeof payload === "object") {
    const runId = (payload as { runId?: unknown }).runId;
    if (typeof runId === "string" && runId.trim()) {
      return runId.trim();
    }
  }
  return fallbackRunId;
}

function respondWithAgentReplayForbidden(respond: GatewayRequestHandlerOptions["respond"]): void {
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.FORBIDDEN, "agent run replay requires its recovery token"),
  );
}

function respondWithCachedAgentRequest(params: {
  respond: GatewayRequestHandlerOptions["respond"];
  cached: NonNullable<ReturnType<typeof readGatewayDedupeEntry>>;
  runId: string;
  replayOnly: boolean;
}): void {
  const { cached, replayOnly, respond, runId } = params;
  const cachedRunId = readCachedAgentRunId(cached.payload, runId);
  if (cached.ok && isAcceptedAgentDedupePayload(cached.payload)) {
    const cachedSessionKey =
      typeof cached.payload.sessionKey === "string" && cached.payload.sessionKey.trim()
        ? cached.payload.sessionKey.trim()
        : undefined;
    const cachedAgentId =
      cachedSessionKey === "global" &&
      typeof cached.payload.agentId === "string" &&
      cached.payload.agentId.trim()
        ? cached.payload.agentId.trim()
        : undefined;
    respond(
      true,
      {
        runId: cachedRunId,
        status: "in_flight" as const,
        ...(cachedSessionKey ? { sessionKey: cachedSessionKey } : {}),
        ...(cachedAgentId ? { agentId: cachedAgentId } : {}),
      },
      undefined,
      { cached: true, runId: cachedRunId },
    );
    return;
  }

  const cachedError =
    cached.error ?? errorShape(ErrorCodes.UNAVAILABLE, `Cached agent run ${cachedRunId} failed.`);
  // Preserve the original failure while marking its cached provenance. Recovery clients
  // must surface this terminal result instead of treating the replay RPC as unavailable.
  respond(
    cached.ok,
    cached.payload,
    replayOnly && !cached.ok
      ? {
          ...cachedError,
          details: buildCachedAgentResultErrorDetails({
            runId: cachedRunId,
            ...(cachedRunId === runId ? {} : { requestedRunId: runId }),
            originalDetails: cachedError.details,
          }),
        }
      : cached.error,
    { cached: true },
  );
}

export function prepareAgentRequestPreflight(
  params: Pick<GatewayRequestHandlerOptions, "params" | "respond" | "context" | "client">,
): AgentRequestPreflight | undefined {
  if (!assertValidParams(params.params, validateAgentParams, "agent", params.respond)) {
    return undefined;
  }
  const request = params.params as AgentRunRequest;
  const canUseInternalRuntimeHandoff = resolveCanUseInternalRuntimeHandoff(params.client);
  const runId = request.idempotencyKey;
  const execApprovalFollowupApprovalId = parseExecApprovalFollowupApprovalId(runId);
  if (execApprovalFollowupApprovalId && !canUseInternalRuntimeHandoff) {
    params.respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "exec approval followup idempotency keys are reserved for backend callers.",
      ),
    );
    return undefined;
  }
  const agentDedupeKeys = resolveAgentDedupeKeys({
    idempotencyKey: runId,
    execApprovalFollowupApprovalId,
  });
  if (request.replayOnly === true) {
    const dedupeEntry = readGatewayDedupeEntry({
      dedupe: params.context.dedupe,
      keys: agentDedupeKeys,
    });
    const cached = dedupeEntry ?? readAgentRunRecoveryEntry(runId);
    if (cached) {
      if (
        !cached.agentReplayCapability ||
        request.replayCapability !== cached.agentReplayCapability
      ) {
        respondWithAgentReplayForbidden(params.respond);
        return undefined;
      }
      respondWithCachedAgentRequest({
        respond: params.respond,
        cached,
        runId,
        replayOnly: true,
      });
      return undefined;
    }
    params.respond(
      false,
      {
        runId,
        status: "unavailable" as const,
      },
      errorShape(
        ErrorCodes.AGENT_RESULT_NOT_FOUND,
        `No cached agent result is available for run ${runId}; replay-only recovery did not start a new run.`,
      ),
      { runId },
    );
    return undefined;
  }

  const cfg = params.context.getRuntimeConfig();
  const requestSessionKey = request.sessionKey?.trim();
  const collectorSession = findSwarmCollectorSession(requestSessionKey);
  // Collector children always use subagent session keys, so ordinary traffic
  // must never pay the persisted-store read. The store fallback only covers a
  // freshly restarted gateway whose in-memory registry has not reloaded yet.
  const persistedCollectorSession =
    !collectorSession && requestSessionKey && isSubagentSessionKey(requestSessionKey)
      ? loadSessionEntry({
          storePath: resolveStorePath(cfg.session?.store, {
            agentId: resolveAgentIdFromSessionKey(requestSessionKey, resolveDefaultAgentId(cfg)),
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
      params.respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          schemaError ?? "active swarm collector sessions require swarmCollector=true",
        ),
      );
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
          ? resolveAgentIdFromSessionKey(swarmRequesterSessionKey, resolveDefaultAgentId(cfg))
          : undefined),
    ).enabled;
    const pendingCollectorLaunch =
      registeredCollector?.swarmLaunchPending === true &&
      !registeredCollector.collectorCompletion &&
      typeof registeredCollector.endedAt !== "number";
    if (
      (!swarmEnabled && !collectorDedupe) ||
      !canUseInternalRuntimeHandoff ||
      request.lane !== "subagent" ||
      !registeredCollector ||
      (!pendingCollectorLaunch && !collectorDedupe)
    ) {
      params.respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "swarm collector fields require an enabled, host-registered collector run",
        ),
      );
      return undefined;
    }
  }
  if (request.cwd && !path.isAbsolute(request.cwd)) {
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "cwd must be absolute"),
    );
    return undefined;
  }
  if (request.cwd && !normalizeOptionalString(params.client?.internal?.pluginRuntimeOwnerId)) {
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "cwd is reserved for plugin-owned subagent runs"),
    );
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
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, expectedSessionResult.error),
    );
    return undefined;
  }
  const requestedPromptPersistenceSuppression = request.suppressPromptPersistence === true;
  const requestedInternalSessionEffects = request.sessionEffects === "internal";
  const requestedModelOverride = Boolean(request.provider || request.model);
  const isOneShotModelRun = request.modelRun === true;
  const isRawModelRun = isOneShotModelRun || request.promptMode === "none";
  if (request.promptMode === "none" && !isOneShotModelRun) {
    params.respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        'promptMode="none" requires modelRun=true so the run cannot mutate a durable session.',
      ),
    );
    return undefined;
  }
  if (requestedModelOverride && !allowModelOverride) {
    params.respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "provider/model overrides are not authorized for this caller.",
      ),
    );
    return undefined;
  }
  if (
    (requestedInternalSessionEffects || requestedPromptPersistenceSuppression) &&
    !canUseInternalRuntimeHandoff
  ) {
    params.respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "internal session-effect controls are reserved for backend callers.",
      ),
    );
    return undefined;
  }
  const inputProvenance = normalizeInputProvenance(request.inputProvenance);
  const sessionEffects =
    isOneShotModelRun || requestedInternalSessionEffects ? "internal" : request.sessionEffects;
  const cached = readGatewayDedupeEntry({ dedupe: params.context.dedupe, keys: agentDedupeKeys });
  if (cached) {
    if (cached.agentReplayCapability && request.replayCapability !== cached.agentReplayCapability) {
      respondWithAgentReplayForbidden(params.respond);
      return undefined;
    }
    respondWithCachedAgentRequest({
      respond: params.respond,
      cached,
      runId,
      replayOnly: false,
    });
    return undefined;
  }
  return {
    request,
    cfg,
    runId,
    lifecycleGeneration: getAgentEventLifecycleGeneration(),
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
    isRestartRecoveryResumeRun:
      canUseInternalRuntimeHandoff && isMainSessionRestartRecoveryInputProvenance(inputProvenance),
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
