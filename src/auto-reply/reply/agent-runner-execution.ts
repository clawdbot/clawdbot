/** Agent-runner execution loop, fallback handling, and user-facing failure mapping. */
import crypto from "node:crypto";
import {
  hasNonEmptyString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { hasOutboundReplyContent } from "openclaw/plugin-sdk/reply-payload";
import type { ChatRunStartupPhase } from "../../../packages/gateway-protocol/src/index.js";
import type {
  AdmittedRunContext,
  PreparedAgentRunAdmission,
} from "../../agents/admitted-run-context.js";
import { peekSessionMcpRuntime } from "../../agents/agent-bundle-mcp-manager-api.js";
import { resolveBootstrapWarningSignaturesSeen } from "../../agents/bootstrap-budget.js";
import {
  classifyFailoverReason,
  isContextOverflowError,
} from "../../agents/embedded-agent-helpers.js";
import type { EmbeddedAgentExecutionPhase } from "../../agents/embedded-agent-runner/execution-phase.js";
import {
  createDeferredEmbeddedRunLifecycleManager,
  type DeferredEmbeddedRunLifecycleManager,
} from "../../agents/embedded-agent-runner/run/deferred-lifecycle-owner.js";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import { runEmbeddedAgent } from "../../agents/embedded-agent.js";
import { renderRateLimitOrOverloadedCopy } from "../../agents/failover/user-copy.js";
import { LiveSessionModelSwitchError } from "../../agents/live-model-switch-error.js";
import { leaseMcpAppModelContextForTurn } from "../../agents/mcp-app-model-context.js";
import { isAgentRunRestartAbortReason } from "../../agents/run-termination.js";
import { createAgentPatchedSessionModelRunGuard } from "../../agents/session-model-auto-revert.js";
import { readChannelContextGatewayContextResolver } from "../../channels/message-access/admission-evidence.js";
import type { SessionEntry } from "../../config/sessions.js";
import { logVerbose } from "../../globals.js";
import {
  captureAgentRunLifecycleGeneration,
  withAgentRunLifecycleGeneration,
} from "../../infra/agent-events.js";
import { clearAgentRunContext, registerAgentRunContext } from "../../infra/agent-run-registry.js";
import { emitAgentRunStatusEvent } from "../../infra/agent-run-status-events.js";
import { isDiagnosticsEnabled } from "../../infra/diagnostic-events.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { logSessionTurnCreated } from "../../logging/diagnostic.js";
import {
  bindGatewayContextResolver,
  getPluginRuntimeGatewayRequestScope,
} from "../../plugins/runtime/gateway-request-scope.js";
import { isInternalMessageChannel } from "../../utils/message-channel.js";
import type { ReplyPayload } from "../types.js";
import {
  clearRecoveredAutoFallbackPrimaryProbeSelection,
  resolveRunAfterAutoFallbackPrimaryProbeRecheck,
} from "./agent-runner-auto-fallback.js";
import {
  cancelOverloadRetryNotice,
  handleAgentExecutionError,
  markOverloadRetryUnsafeToReplay,
  type OverloadRetryState,
} from "./agent-runner-error-handler.js";
import type {
  AgentTurnExecutionResult,
  AgentTurnInternalResult,
  AgentTurnParams,
  RuntimeFallbackAttempt,
} from "./agent-runner-execution.types.js";
import {
  buildTerminalAgentRunFailureReplyPayload,
  markAgentRunFailureReplyPayload,
  resolveExternalRunFailureTextForConversation,
} from "./agent-runner-failure-reply.js";
import {
  executeAgentFallbackCycle,
  type AgentFallbackCycleState,
} from "./agent-runner-fallback-cycle.js";
import { recordMessageToolOnlyRunOutcome } from "./agent-runner-message-tool-outcome.js";
import { createAgentTurnPresentation } from "./agent-runner-presentation.js";
import { createAgentTurnTimingTracker } from "./agent-runner-turn-timing.js";
import { resolveQueuedReplyRuntimeConfig } from "./agent-runner-utils.js";
import { prepareChannelRunAdmission } from "./channel-run-admission.js";
import { shouldNotifyUserAboutCompaction } from "./compaction-notice.js";
import { type CurrentTurnImages, resolveCurrentTurnImages } from "./current-turn-images.js";
import type { FollowupRun } from "./queue.js";
import type { ReplyMediaContext } from "./reply-media-paths.js";
import { createReplyMediaContext } from "./reply-media-paths.runtime.js";
import {
  isReplyOperationRestartAbort,
  isReplyOperationUserAbort,
} from "./reply-operation-abort.js";
import { markReplyOperationExecutionStarted } from "./reply-run-registry.js";
import { isReplyProfilerEnabled } from "./reply-timing-tracker.js";

type InternalFollowupRun = FollowupRun & {
  /** Keep admission state out of the public plugin-facing FollowupRun contract. */
  currentTurnImagesPrepared?: true;
  mediaImageLayout?: CurrentTurnImages["mediaImageLayout"];
};

function resolveRunStartupPhase(
  phase: EmbeddedAgentExecutionPhase,
): ChatRunStartupPhase | undefined {
  switch (phase) {
    case "runner_entered":
    case "workspace":
    case "runtime_plugins":
      return "preparing_workspace";
    case "before_agent_reply":
    case "model_resolution":
    case "auth":
    case "context_engine":
    case "attempt_dispatch":
    case "context_assembled":
      return "preparing_context";
    case "turn_accepted":
    case "process_spawned":
    case "model_call_started":
      return "starting_model";
    case "tool_execution_started":
    case "assistant_output_started":
      return undefined;
  }
  return undefined;
}

async function executeAgentTurnInternalWithRetryState(
  params: AgentTurnParams,
  commitTerminalOutcome: () => void,
  overloadRetryState: OverloadRetryState,
  commitMcpAppModelContext: () => void,
  preparedRunAdmission: PreparedAgentRunAdmission,
  admittedRunContext: { current?: AdmittedRunContext },
  deferredLifecycle: DeferredEmbeddedRunLifecycleManager,
): Promise<AgentTurnInternalResult> {
  const heartbeatState = { didLogStrip: false };
  let autoCompactionCount = 0;
  // Track payloads sent directly (not via pipeline) during tool flush to avoid duplicates.
  const directlySentBlockKeys = new Set<string>();
  const directlySentBlockPayloads: Array<ReplyPayload | undefined> = [];
  const runnableRun = resolveRunAfterAutoFallbackPrimaryProbeRecheck({
    run: params.followupRun.run,
    entry: params.activeSessionStore?.[params.sessionKey ?? ""] ?? params.getActiveSessionEntry(),
    sessionKey: params.sessionKey,
  });
  if (runnableRun !== params.followupRun.run) {
    params.followupRun.run = runnableRun;
  }
  const runtimeConfig = resolveQueuedReplyRuntimeConfig(runnableRun.config);
  const effectiveRun =
    runtimeConfig === runnableRun.config
      ? runnableRun
      : {
          ...runnableRun,
          config: runtimeConfig,
        };
  let liveModelSwitchRuntimeEntry:
    | Pick<SessionEntry, "agentHarnessId" | "agentRuntimeOverride" | "modelSelectionLocked">
    | undefined;
  const applyLiveModelSwitchToRun = (
    run: FollowupRun["run"],
    err: LiveSessionModelSwitchError,
  ): void => {
    run.provider = err.provider;
    run.model = err.model;
    run.authProfileId = err.authProfileId;
    run.authProfileIdSource = err.authProfileId ? err.authProfileIdSource : undefined;
    run.autoFallbackPrimaryProbe = undefined;
    // Keep runtime paired with the error's model/auth winner even if the
    // active in-memory session snapshot lags the persisted directive write.
    liveModelSwitchRuntimeEntry = { agentRuntimeOverride: err.agentRuntimeOverride };
  };

  const runId = params.opts?.runId ?? crypto.randomUUID();
  const agentTurnTiming = createAgentTurnTimingTracker({
    profilerEnabled: isReplyProfilerEnabled({ config: runtimeConfig }),
  });
  const shouldSurfaceToControlUi = isInternalMessageChannel(
    params.followupRun.run.messageProvider ??
      params.sessionCtx.Surface ??
      params.sessionCtx.Provider,
  );
  let lifecycleGeneration = captureAgentRunLifecycleGeneration(runId);
  if (params.sessionKey) {
    registerAgentRunContext(runId, {
      sessionKey: params.sessionKey,
      ...(params.followupRun.run.sessionId ? { sessionId: params.followupRun.run.sessionId } : {}),
      agentId: params.followupRun.run.agentId,
      lifecycleGeneration,
      verboseLevel: params.resolvedVerboseLevel,
      isHeartbeat: params.isHeartbeat,
      isControlUiVisible: shouldSurfaceToControlUi,
    });
  }
  if (isDiagnosticsEnabled(runtimeConfig)) {
    logSessionTurnCreated({
      runId,
      sessionKey: params.sessionKey,
      sessionId: params.followupRun.run.sessionId,
      agentId: params.followupRun.run.agentId,
      channel:
        params.followupRun.run.messageProvider ??
        params.sessionCtx.Surface ??
        params.sessionCtx.Provider,
      trigger: params.isHeartbeat ? "heartbeat" : "user",
    });
  }
  let replyMediaContext: ReplyMediaContext;
  let currentTurnImages: CurrentTurnImages;
  try {
    replyMediaContext =
      params.replyMediaContext ??
      agentTurnTiming.measureSync("reply_media_context", () =>
        createReplyMediaContext({
          cfg: runtimeConfig,
          sessionKey: params.sessionKey,
          workspaceDir: params.followupRun.run.workspaceDir,
          messageProvider: params.followupRun.run.messageProvider,
          accountId:
            params.followupRun.originatingAccountId ?? params.followupRun.run.agentAccountId,
          groupId: params.followupRun.run.groupId,
          groupChannel: params.followupRun.run.groupChannel,
          groupSpace: params.followupRun.run.groupSpace,
          requesterSenderId: params.followupRun.run.senderId,
          requesterSenderName: params.followupRun.run.senderName,
          requesterSenderUsername: params.followupRun.run.senderUsername,
          requesterSenderE164: params.followupRun.run.senderE164,
        }),
      );
    const internalFollowupRun = params.followupRun as InternalFollowupRun;
    const hasQueuedCurrentTurnImages =
      internalFollowupRun.currentTurnImagesPrepared === true ||
      Object.hasOwn(params.followupRun, "images") ||
      Object.hasOwn(params.followupRun, "imageOrder");
    // Queue admission owns current-turn materialization, including empty results.
    // Re-scanning here can resurrect suppressed media or duplicate loaded images.
    currentTurnImages = hasQueuedCurrentTurnImages
      ? {
          images: params.followupRun.images,
          imageOrder: params.followupRun.imageOrder,
          mediaImageLayout: internalFollowupRun.mediaImageLayout,
        }
      : await agentTurnTiming.measure("current_turn_images", () =>
          resolveCurrentTurnImages({
            ctx: params.sessionCtx,
            cfg: runtimeConfig,
            images: params.opts?.images,
            imageOrder: params.opts?.imageOrder,
          }),
        );
  } catch (error) {
    clearAgentRunContext(runId, lifecycleGeneration);
    throw error;
  }
  let didNotifyAgentRunStart = false;
  let lastRunStartupPhase: ReturnType<typeof resolveRunStartupPhase>;
  const notifyAgentRunStart = () => {
    if (didNotifyAgentRunStart) {
      return;
    }
    didNotifyAgentRunStart = true;
    if (params.replyOperation) {
      markReplyOperationExecutionStarted(params.replyOperation);
    }
    params.opts?.onAgentRunStart?.(runId, admittedRunContext.current?.executionIdentityToken);
  };
  const signalExecutionPhaseForTyping = (
    info: Parameters<NonNullable<RunEmbeddedAgentParams["onExecutionPhase"]>>[0],
  ) => {
    const startupPhase = resolveRunStartupPhase(info.phase);
    if (startupPhase && startupPhase !== lastRunStartupPhase) {
      lastRunStartupPhase = startupPhase;
      emitAgentRunStatusEvent({ runId, phase: startupPhase });
    }
    if (info.phase === "model_call_started" || info.phase === "process_spawned") {
      commitMcpAppModelContext();
    }
    if (info.phase === "tool_execution_started" || info.phase === "assistant_output_started") {
      markOverloadRetryUnsafeToReplay(overloadRetryState);
    }
    const isUserVisibleExecutionActivity =
      info.phase === "turn_accepted" ||
      info.phase === "process_spawned" ||
      info.phase === "model_call_started" ||
      info.phase === "tool_execution_started" ||
      info.phase === "assistant_output_started";
    if (!isUserVisibleExecutionActivity) {
      return;
    }
    notifyAgentRunStart();
    void (
      params.typingSignals.signalExecutionActivity?.() ?? params.typingSignals.signalRunStart()
    ).catch((err: unknown) => {
      logVerbose(`execution phase typing signal failed: ${String(err)}`);
    });
  };
  const notifyUserAboutCompaction = shouldNotifyUserAboutCompaction(runtimeConfig);
  let runResult: Awaited<ReturnType<typeof runEmbeddedAgent>>;
  let fallbackProvider = params.followupRun.run.provider;
  let fallbackModel = params.followupRun.run.model;
  let fallbackAttempts: RuntimeFallbackAttempt[] = [];
  let fallbackExhausted = false;
  let terminalRunFailed = false;
  const modelPatch = createAgentPatchedSessionModelRunGuard({
    cfg: runtimeConfig,
    agentId: params.followupRun.run.agentId,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
    onError: (error) =>
      logVerbose(`agent model patch reconciliation failed: ${formatErrorMessage(error)}`),
  });
  let transientHttpRetriesRemaining = 1;
  const consumeTransientHttpRetry = () => transientHttpRetriesRemaining-- > 0;
  let liveModelSwitchRetries = 0;
  const fallbackCycleState: AgentFallbackCycleState = {
    deferredLifecycle,
    lifecycleGeneration,
    autoCompactionCount,
    attemptedRuntimeProvider: fallbackProvider,
    attemptedRuntimeModel: fallbackModel,
    bootstrapPromptWarningSignaturesSeen: resolveBootstrapWarningSignaturesSeen(
      params.getActiveSessionEntry()?.systemPromptReport,
    ),
  };
  const clearRecoveredAutoFallbackPrimaryProbe = async (paramsForClear: {
    provider: string;
    model: string;
  }): Promise<void> =>
    clearRecoveredAutoFallbackPrimaryProbeSelection({
      run: effectiveRun,
      ...paramsForClear,
      sessionKey: params.sessionKey,
      activeSessionStore: params.activeSessionStore,
      getActiveSessionEntry: params.getActiveSessionEntry,
      storePath: params.storePath,
    });

  while (true) {
    try {
      const presentation = createAgentTurnPresentation({
        turn: params,
        replyMediaContext,
        directlySentBlockKeys,
        directlySentBlockPayloads,
        heartbeatState,
      });
      const cycle = await executeAgentFallbackCycle({
        preparedRunAdmission,
        turn: params,
        effectiveRun,
        runtimeConfig,
        liveModelSwitchRuntimeEntry,
        runId,
        runAbortSignal: fallbackCycleState.deferredLifecycle.signal,
        currentTurnImages,
        state: fallbackCycleState,
        presentation,
        directlySentBlockKeys,
        notifyAgentRunStart,
        signalExecutionPhaseForTyping,
        notifyUserAboutCompaction,
        timing: agentTurnTiming,
        modelPatch,
        shouldSurfaceToControlUi,
        commitTerminalOutcome,
        clearRecoveredAutoFallbackPrimaryProbe,
      });
      lifecycleGeneration = fallbackCycleState.lifecycleGeneration;
      autoCompactionCount = fallbackCycleState.autoCompactionCount;
      if (cycle.kind === "final") {
        return {
          ...cycle,
          resolved: {
            provider: fallbackCycleState.attemptedRuntimeProvider,
            model: fallbackCycleState.attemptedRuntimeModel,
          },
        };
      }
      runResult = cycle.runResult;
      fallbackProvider = cycle.fallbackProvider;
      fallbackModel = cycle.fallbackModel;
      fallbackExhausted = cycle.fallbackExhausted;
      fallbackAttempts = cycle.fallbackAttempts;
      terminalRunFailed = cycle.terminalRunFailed;
      break;
    } catch (err) {
      if (isAgentRunRestartAbortReason(err)) {
        throw err;
      }
      if (err instanceof LiveSessionModelSwitchError) {
        liveModelSwitchRetries += 1;
      }
      const action = await handleAgentExecutionError({
        turn: params,
        error: err,
        runtimeConfig,
        runId,
        state: fallbackCycleState,
        liveModelSwitchRetries,
        shouldSurfaceToControlUi,
        timing: agentTurnTiming,
        overloadRetryState,
        consumeTransientHttpRetry,
        modelPatch,
      });
      if (action.kind === "final") {
        return {
          ...action,
          resolved: {
            provider: fallbackCycleState.attemptedRuntimeProvider,
            model: fallbackCycleState.attemptedRuntimeModel,
          },
        };
      }
      if (action.liveModelSwitchError) {
        const switchError = action.liveModelSwitchError;
        applyLiveModelSwitchToRun(params.followupRun.run, switchError);
        if (runnableRun !== params.followupRun.run) {
          applyLiveModelSwitchToRun(runnableRun, switchError);
        }
        if (effectiveRun !== runnableRun && effectiveRun !== params.followupRun.run) {
          applyLiveModelSwitchToRun(effectiveRun, switchError);
        }
      }
      continue;
    }
  }

  // If the run completed but with an embedded context overflow error that
  // wasn't recovered from (e.g. compaction reset already attempted), surface
  // the error to the user instead of silently returning an empty response.
  // See #26905: Slack DM sessions silently swallowed messages when context
  // overflow errors were returned as embedded error payloads.
  const finalEmbeddedError = runResult?.meta?.error;
  const hasPayloadText = runResult?.payloads?.some((p) => normalizeOptionalString(p.text));
  if (finalEmbeddedError && !hasPayloadText) {
    const errorMsg = finalEmbeddedError.message ?? "";
    if (isContextOverflowError(errorMsg)) {
      params.replyOperation?.fail("run_failed", finalEmbeddedError);
      return {
        kind: "final",
        resolved: { provider: fallbackProvider, model: fallbackModel },
        payload: markAgentRunFailureReplyPayload({
          text: "⚠️ Context overflow — this conversation is too large for the model. Use /new to start a fresh session.",
        }),
      };
    }
  }

  // Surface rate limit and overload errors that occur mid-turn (after tool
  // calls) instead of silently returning an empty response. See #36142.
  // Only applies when the assistant produced no valid (non-error) reply text,
  // so tool-level rate-limit messages don't override a successful turn.
  // Prioritize metaErrorMsg (raw upstream error) over errorPayloadText to
  // avoid self-matching on pre-formatted "⚠️" messages from run.ts, and
  // skip already-formatted payloads so tool-specific 429 errors (e.g.
  // browser/search tool failures) are preserved rather than overwritten.
  //
  // Instead of early-returning kind:"final" (which would bypass
  // buildReplyPayloads() filtering and session bookkeeping), inject the
  // error payload into runResult so it flows through the normal
  // kind:"success" path — preserving streaming dedup, message_send
  // suppression, and usage/model metadata updates.
  if (runResult) {
    const hasNonErrorContent = runResult.payloads?.some(
      (p) => !p.isError && !p.isReasoning && hasOutboundReplyContent(p, { trimText: true }),
    );
    if (!hasNonErrorContent) {
      const metaErrorMsg = finalEmbeddedError?.message ?? "";
      const rawErrorPayloadText =
        runResult.payloads?.find(
          (p) => p.isError && hasNonEmptyString(p.text) && !p.text.startsWith("⚠️"),
        )?.text ?? "";
      const errorCandidate = metaErrorMsg || rawErrorPayloadText;
      const candidateReason = errorCandidate ? classifyFailoverReason(errorCandidate) : null;
      const formattedErrorCandidate =
        candidateReason === "rate_limit" || candidateReason === "overloaded"
          ? renderRateLimitOrOverloadedCopy({ reason: candidateReason, raw: errorCandidate })
          : undefined;
      if (formattedErrorCandidate) {
        runResult.payloads = [
          markAgentRunFailureReplyPayload({
            text: resolveExternalRunFailureTextForConversation({
              text: formattedErrorCandidate,
              sessionCtx: params.sessionCtx,
              isGenericRunnerFailure: false,
              cfg: params.followupRun.run.config,
            }),
            isError: true,
          }),
        ];
      }
    }
  }
  const patchedModelNeedsRevert = terminalRunFailed
    ? false
    : (modelPatch.captureFallbackFailure(fallbackAttempts) ?? false);
  await modelPatch.finish(!terminalRunFailed && !patchedModelNeedsRevert);
  const terminalFailurePayload = terminalRunFailed
    ? buildTerminalAgentRunFailureReplyPayload({
        isHeartbeat: params.isHeartbeat,
        visibleReplyDelivered: params.didDeliverVisiblePartialReply?.() === true,
        sessionCtx: params.sessionCtx,
        cfg: params.followupRun.run.config,
      })
    : undefined;

  return {
    kind: "completed",
    result: runResult,
    fallbackProvider,
    fallbackModel,
    ...(fallbackExhausted ? { fallbackExhausted: true as const } : {}),
    fallbackAttempts,
    didLogHeartbeatStrip: heartbeatState.didLogStrip,
    autoCompactionCount,
    directlySentBlockKeys: directlySentBlockKeys.size > 0 ? directlySentBlockKeys : undefined,
    directlySentBlockPayloads: directlySentBlockPayloads.filter(
      (payload): payload is ReplyPayload => payload !== undefined,
    ),
    ...(terminalFailurePayload ? { terminalFailurePayload } : {}),
  };
}

async function executeAgentTurnInternal(
  params: AgentTurnParams,
  commitTerminalOutcome: () => void,
  commitMcpAppModelContext: () => void,
): Promise<AgentTurnInternalResult> {
  const overloadRetryState: OverloadRetryState = {
    retryCount: 0,
    turnStartedAtMs: Date.now(),
    unsafeToReplay: false,
    noticeSent: false,
    completed: false,
  };
  const runId = params.opts?.runId ?? crypto.randomUUID();
  const admittedRunContext: { current?: AdmittedRunContext } = {};
  const gatewayContextResolver =
    readChannelContextGatewayContextResolver(params.sessionCtx) ??
    getPluginRuntimeGatewayRequestScope()?.resolveGatewayContext;
  const preparedRunAdmission = prepareChannelRunAdmission({
    cfg: resolveQueuedReplyRuntimeConfig(params.followupRun.run.config),
    runId,
    agentId: params.followupRun.run.agentId,
    ingressKind: "channel",
    boundary: "auto-reply.agent-runner",
    evidence: params.followupRun.channelAdmissionEvidence,
    onAdmitted: (context) => {
      bindGatewayContextResolver(context, gatewayContextResolver);
      admittedRunContext.current = context;
    },
  });
  const deferredLifecycle = createDeferredEmbeddedRunLifecycleManager({
    runId,
    sessionId: params.followupRun.run.sessionId,
    sessionKey: params.sessionKey,
    sessionFile: params.followupRun.run.sessionFile,
    abortSignal: params.replyOperation?.abortSignal ?? params.opts?.abortSignal,
  });
  try {
    return await executeAgentTurnInternalWithRetryState(
      params,
      commitTerminalOutcome,
      overloadRetryState,
      commitMcpAppModelContext,
      preparedRunAdmission,
      admittedRunContext,
      deferredLifecycle,
    );
  } finally {
    await deferredLifecycle.complete();
    preparedRunAdmission.close();
    await cancelOverloadRetryNotice(overloadRetryState);
  }
}

/** Runs the agent turn with provider/model fallback, retry, and closed settlement. */
async function executeAgentTurnOutcome(params: AgentTurnParams): Promise<AgentTurnExecutionResult> {
  const runId = params.opts?.runId ?? crypto.randomUUID();
  const executionParams =
    params.opts?.runId === runId ? params : { ...params, opts: { ...params.opts, runId } };
  // Gateway writes require exact view identity against this bare session runtime;
  // requester-scoped and combined runtimes cannot cross the App view boundary.
  const runtime = executionParams.isHeartbeat
    ? undefined
    : peekSessionMcpRuntime({
        sessionId: executionParams.followupRun.run.sessionId,
        sessionKey: executionParams.sessionKey ?? executionParams.followupRun.run.sessionKey,
      });
  const modelContextLease = runtime
    ? leaseMcpAppModelContextForTurn({
        runtime,
        prompt: executionParams.commandBody,
        transcriptPrompt: executionParams.transcriptCommandBody,
      })
    : undefined;
  const turnParams = modelContextLease
    ? {
        ...executionParams,
        commandBody: modelContextLease.prompt,
        transcriptCommandBody: modelContextLease.transcriptPrompt,
      }
    : executionParams;
  let terminalOutcomeCommitted = false;
  // Callers invoke this only inside the guarded execution below, including its
  // inner finally, so restart errors from freezeAbort reach the outer catch.
  const commitTerminalOutcome = () => {
    if (terminalOutcomeCommitted) {
      return;
    }
    terminalOutcomeCommitted = true;
    executionParams.replyOperation?.freezeAbort();
  };
  const lifecycleGeneration = captureAgentRunLifecycleGeneration(runId);
  try {
    const internal = await withAgentRunLifecycleGeneration(lifecycleGeneration, async () => {
      try {
        return await executeAgentTurnInternal(
          turnParams,
          commitTerminalOutcome,
          modelContextLease?.commit ?? (() => undefined),
        );
      } finally {
        modelContextLease?.rollback();
        commitTerminalOutcome();
      }
    });
    if (internal.kind === "final") {
      if (isReplyOperationRestartAbort(executionParams.replyOperation)) {
        return { runId, outcome: { kind: "aborted", reason: "restart" } };
      }
      if (isReplyOperationUserAbort(executionParams.replyOperation)) {
        return { runId, outcome: { kind: "aborted", reason: "user" } };
      }
      return {
        runId,
        outcome: {
          kind: "rejected",
          payload: internal.payload,
          resolved: internal.resolved,
        },
      };
    }
    const abortReason = isReplyOperationRestartAbort(executionParams.replyOperation)
      ? "restart"
      : isReplyOperationUserAbort(executionParams.replyOperation)
        ? "user"
        : undefined;
    const provider =
      internal.fallbackProvider ??
      internal.result.meta?.agentMeta?.provider ??
      executionParams.followupRun.run.provider;
    const model =
      internal.fallbackModel ??
      internal.result.meta?.agentMeta?.model ??
      executionParams.followupRun.run.model;
    return {
      runId,
      outcome: {
        kind: "settled",
        status: internal.terminalFailurePayload ? "failed" : "ok",
        ...(abortReason ? { abortReason } : {}),
        result: internal.result,
        resolved: { provider, model },
        fallback: {
          exhausted: internal.fallbackExhausted === true,
          attempts: internal.fallbackAttempts,
        },
        autoCompactionCount: internal.autoCompactionCount,
        didLogHeartbeatStrip: internal.didLogHeartbeatStrip,
        directlySentBlockKeys: internal.directlySentBlockKeys,
        directlySentBlockPayloads: internal.directlySentBlockPayloads,
        terminalFailurePayload: internal.terminalFailurePayload,
      },
    };
  } catch (error) {
    if (
      isReplyOperationRestartAbort(executionParams.replyOperation) ||
      isAgentRunRestartAbortReason(error)
    ) {
      if (executionParams.replyOperation && !executionParams.replyOperation.result) {
        executionParams.replyOperation.complete();
      }
      return { runId, outcome: { kind: "aborted", reason: "restart" } };
    }
    if (isReplyOperationUserAbort(executionParams.replyOperation)) {
      return { runId, outcome: { kind: "aborted", reason: "user" } };
    }
    throw error;
  }
}

/** Runs the agent turn and records its message-tool-only visible-outcome fact once. */
export async function executeAgentTurn(params: AgentTurnParams): Promise<AgentTurnExecutionResult> {
  const runId = params.opts?.runId ?? crypto.randomUUID();
  const executionParams =
    params.opts?.runId === runId ? params : { ...params, opts: { ...params.opts, runId } };
  try {
    const result = await executeAgentTurnOutcome(executionParams);
    const terminalOutcome =
      result.outcome.kind === "aborted" ||
      (result.outcome.kind === "settled" && result.outcome.abortReason)
        ? undefined
        : result.outcome.kind === "rejected" || result.outcome.status === "failed"
          ? "failed"
          : "completed";
    if (terminalOutcome) {
      executionParams.opts?.onAgentRunTerminalOutcome?.(terminalOutcome);
    }
    recordMessageToolOnlyRunOutcome(executionParams, result);
    return result;
  } catch (error) {
    executionParams.opts?.onAgentRunTerminalOutcome?.("failed");
    recordMessageToolOnlyRunOutcome(executionParams, undefined);
    throw error;
  }
}
