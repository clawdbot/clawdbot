import crypto from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveContextTokensForModel } from "../../agents/context.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../agents/defaults.js";
import { prepareGitCoauthorAttribution } from "../../agents/git-coauthor-attribution.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { logVerbose } from "../../globals.js";
import { withBeforeAgentReplyObserver } from "../../plugins/before-agent-reply.js";
import { defaultRuntime } from "../../runtime.js";
import { readSessionInputProfileId } from "../../sessions/session-participant-input.js";
import { resolveLiveContinuationRuntimeConfig } from "../continuation/config.js";
import { checkContextPressure } from "../continuation/context-pressure.js";
import { setReplyPayloadMetadata } from "../reply-payload.js";
import type { OriginatingChannelType } from "../templating.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import type { ReplyPayload } from "../types.js";
import type { ReplyContinuationController } from "./agent-runner-continuation.js";
import {
  resolveReplyRunDeliveryContext,
  resolveSourceReplyPolicy,
  type RunReplyAgentParams,
} from "./agent-runner-core.js";
import { executeAgentTurn } from "./agent-runner-execution.js";
import { markPostCompactionModelFailurePayload } from "./agent-runner-failure-reply.js";
import { runMemoryFlushIfNeeded, runSessionCompactionIfNeeded } from "./agent-runner-memory.js";
import { finalizeReplyAgentRun } from "./agent-runner-result.js";
import { buildThreadingToolContext } from "./agent-runner-utils.js";
import type { BlockReplyPipeline } from "./block-reply-pipeline.js";
import type { CompactionNoticePhase } from "./compaction-notice.js";
import { createFollowupRunner } from "./followup-runner.js";
import { evaluateNoOpRearmAdmission, type NoOpRearmWakeClass } from "./no-op-rearm-guard.js";
import {
  buildRecoverablePendingFinalDeliveryText,
  normalizePendingFinalDeliveryPayloads,
} from "./pending-final-delivery.js";
import type { FollowupRun } from "./queue.js";
import type { ReplyMediaContext } from "./reply-media-paths.js";
import { isReplyOperationSuperseded } from "./reply-operation-abort.js";
import { recordReplyOperationAgentTurn } from "./reply-operation-agent-turn-state.js";
import { resolveReplyOperationRunState } from "./reply-operation-run-state.js";
import type { ReplyOperation } from "./reply-run-registry.js";
import { resolveReplyToMode } from "./reply-threading.js";
import { createReplyRestartRecoveryClaimController } from "./restart-recovery-claim.js";
import { resolveRoutedDeliveryThreadId } from "./routed-delivery-thread.js";
import { resolveReplyHookTrigger } from "./run-provenance.js";
import type { TypingSignaler } from "./typing-mode.js";
type ExecutePreparedReplyAgentRunInput = Pick<
  RunReplyAgentParams,
  | "blockReplyChunking"
  | "blockStreamingEnabled"
  | "commandBody"
  | "defaultModel"
  | "followupRun"
  | "opts"
  | "queueKey"
  | "replyThreadingOverride"
  | "resolvedBlockStreamingBreak"
  | "resolvedQueue"
  | "resolvedVerboseLevel"
  | "runtimePolicySessionKey"
  | "sessionCtx"
  | "sessionKey"
  | "shouldInjectGroupIntro"
  | "storePath"
  | "toolProgressDetail"
  | "transcriptCommandBody"
  | "typing"
  | "typingMode"
> & {
  activeSessionStore: Record<string, SessionEntry> | undefined;
  admitUserTurn: ReturnType<typeof createReplyRestartRecoveryClaimController>["admitUserTurn"];
  applyReplyToMode: (payload: ReplyPayload) => ReplyPayload;
  beginBeforeAgentReply: ReturnType<
    typeof createReplyRestartRecoveryClaimController
  >["beginBeforeAgentReply"];
  blockReplyPipeline: BlockReplyPipeline | null;
  cfg: OpenClawConfig;
  checkpointBeforeAgentReply: ReturnType<
    typeof createReplyRestartRecoveryClaimController
  >["checkpointBeforeAgentReply"];
  continuation: ReplyContinuationController;
  resolveVisibleReplyDelivery: () => Promise<boolean>;
  getActiveIsNewSession: () => boolean;
  getActiveSessionEntry: () => SessionEntry | undefined;
  hookTrigger: ReturnType<typeof resolveReplyHookTrigger>;
  isContinuationWake: boolean;
  isHeartbeat: boolean;
  isRestartRecoveryArmed: () => boolean;
  pendingToolTasks: Set<Promise<void>>;
  replyMediaContext: ReplyMediaContext;
  replyOperation: ReplyOperation;
  replyRouteThreadId: ReturnType<typeof resolveRoutedDeliveryThreadId>;
  replyToChannel: OriginatingChannelType | undefined;
  replyToMode: ReturnType<typeof resolveReplyToMode>;
  resetSessionAfterRoleOrderingConflict: (reason: string) => Promise<boolean>;
  returnWithQueuedFollowupDrain: <T>(value: T) => T;
  runFollowupTurn: (queued: FollowupRun) => Promise<void>;
  sendDirectCompactionNotice: ((phase: CompactionNoticePhase) => Promise<void>) | undefined;
  setRunFollowupTurn: (runner: (queued: FollowupRun) => Promise<void>) => void;
  setActiveSessionEntry: (entry: SessionEntry | undefined) => void;
  shouldEmitToolOutput: () => boolean;
  shouldEmitToolResult: () => boolean;
  traceAgentPhase: <T>(name: string, run: () => Promise<T> | T) => Promise<T>;
  turnAdoptionLifecycle: NonNullable<RunReplyAgentParams["opts"]>["turnAdoptionLifecycle"];
  typingSignals: TypingSignaler;
};

function markPostCompactionFailureResult(
  result: ReplyPayload | ReplyPayload[] | undefined,
  postCompactionModelFailure: true | undefined,
): ReplyPayload | ReplyPayload[] | undefined {
  if (Array.isArray(result)) {
    return result.map((payload) =>
      markPostCompactionModelFailurePayload(postCompactionModelFailure, payload),
    );
  }
  return result
    ? markPostCompactionModelFailurePayload(postCompactionModelFailure, result)
    : result;
}

export async function executePreparedReplyAgentRun(
  context: ExecutePreparedReplyAgentRunInput,
): Promise<ReplyPayload | ReplyPayload[] | undefined> {
  const {
    activeSessionStore,
    admitUserTurn: admitUserTurnWithRecovery,
    applyReplyToMode,
    beginBeforeAgentReply: beginBeforeAgentReplyWithRecovery,
    blockReplyChunking,
    blockReplyPipeline,
    blockStreamingEnabled,
    cfg,
    checkpointBeforeAgentReply: checkpointBeforeAgentReplyWithRecovery,
    commandBody,
    continuation,
    defaultModel,
    followupRun,
    getActiveIsNewSession,
    getActiveSessionEntry,
    hookTrigger,
    isContinuationWake,
    isHeartbeat,
    isRestartRecoveryArmed,
    opts,
    pendingToolTasks,
    queueKey,
    replyMediaContext,
    replyOperation,
    replyRouteThreadId,
    replyThreadingOverride,
    replyToChannel,
    replyToMode,
    resetSessionAfterRoleOrderingConflict,
    resolvedBlockStreamingBreak,
    resolvedQueue,
    resolvedVerboseLevel,
    returnWithQueuedFollowupDrain,
    runtimePolicySessionKey,
    sendDirectCompactionNotice,
    sessionCtx,
    sessionKey,
    setActiveSessionEntry,
    setRunFollowupTurn,
    shouldEmitToolOutput,
    shouldEmitToolResult,
    shouldInjectGroupIntro,
    storePath,
    toolProgressDetail,
    traceAgentPhase,
    transcriptCommandBody,
    turnAdoptionLifecycle,
    typing,
    typingMode,
    typingSignals,
  } = context;
  let activeSessionEntry = getActiveSessionEntry();
  const admitUserTurn = async (
    ...args: Parameters<typeof admitUserTurnWithRecovery>
  ): ReturnType<typeof admitUserTurnWithRecovery> => {
    const result = await admitUserTurnWithRecovery(...args);
    activeSessionEntry = getActiveSessionEntry();
    return result;
  };
  const beginBeforeAgentReply = async (
    ...args: Parameters<typeof beginBeforeAgentReplyWithRecovery>
  ): ReturnType<typeof beginBeforeAgentReplyWithRecovery> => {
    const result = await beginBeforeAgentReplyWithRecovery(...args);
    activeSessionEntry = getActiveSessionEntry();
    return result;
  };
  const checkpointBeforeAgentReply = async (
    ...args: Parameters<typeof checkpointBeforeAgentReplyWithRecovery>
  ): ReturnType<typeof checkpointBeforeAgentReplyWithRecovery> => {
    const result = await checkpointBeforeAgentReplyWithRecovery(...args);
    activeSessionEntry = getActiveSessionEntry();
    return result;
  };

  await typingSignals.signalRunStart();

  // Preserve the one-flush-per-compaction-cycle gate: an earlier same-cycle
  // flush is the checkpoint for this upcoming compaction, not a reason to rerun maintenance.
  const memoryFlushResult = await traceAgentPhase("reply.memory_flush", () =>
    runMemoryFlushIfNeeded({
      cfg,
      followupRun,
      promptForEstimate: followupRun.prompt,
      sessionCtx,
      opts,
      defaultModel,
      resolvedVerboseLevel,
      sessionEntry: activeSessionEntry,
      sessionStore: activeSessionStore,
      sessionKey,
      runtimePolicySessionKey,
      storePath,
      isHeartbeat,
      replyOperation,
      onVisibleErrorPayloads: (payloads) => {
        logVerbose(
          `memory flush produced ${payloads.length} visible maintenance error payload(s); continuing user reply`,
        );
      },
    }),
  );
  activeSessionEntry = memoryFlushResult.sessionEntry;
  setActiveSessionEntry(activeSessionEntry);

  if (replyOperation.result?.kind === "aborted") {
    throw replyOperation.abortSignal.reason ?? new Error("reply operation aborted");
  }

  const prePreflightCompactionCount = activeSessionEntry?.compactionCount ?? 0;
  activeSessionEntry = await traceAgentPhase("reply.preflight_compaction", () =>
    runSessionCompactionIfNeeded({
      cfg,
      followupRun,
      promptForEstimate: followupRun.prompt,
      defaultModel,
      sessionEntry: activeSessionEntry,
      sessionStore: activeSessionStore,
      sessionKey,
      runtimePolicySessionKey,
      storePath,
      isHeartbeat,
      abortSignal: replyOperation.abortSignal,
      onCompactionStart: () => replyOperation.setPhase("preflight_compacting"),
      onSessionIdChanged: (sessionId) => replyOperation.updateSessionId(sessionId),
      onCompactionNotice: sendDirectCompactionNotice,
    }),
  );
  setActiveSessionEntry(activeSessionEntry);
  const preflightCompactionApplied =
    (activeSessionEntry?.compactionCount ?? 0) > prePreflightCompactionCount;

  // Optional memory maintenance cannot justify discarding conversation history.
  // Required compaction failures surface above; otherwise optionally notify and continue.
  if (memoryFlushResult.outcome === "exhausted") {
    await sendDirectCompactionNotice?.("memory_flush_degraded");
  }

  const runFollowupTurn = createFollowupRunner({
    opts,
    typing,
    typingMode,
    sessionEntry: activeSessionEntry,
    sessionStore: activeSessionStore,
    sessionKey,
    storePath,
    defaultModel,
    toolProgressDetail,
  });
  setRunFollowupTurn(runFollowupTurn);

  replyOperation.setPhase("running");
  const replySessionKey = sessionKey ?? followupRun.run.sessionKey;
  // Evaluate continuation context pressure and persist the early-warning band
  // before the provider request. Must run for every turn (not only continuation
  // wakes) so the next turn's pre-provider gate sees an up-to-date band.
  activeSessionEntry = getActiveSessionEntry() ?? activeSessionEntry;
  if (activeSessionEntry && sessionKey) {
    const { contextPressureThreshold, earlyWarningBand } =
      resolveLiveContinuationRuntimeConfig(cfg);
    const contextWindowTokens =
      resolveContextTokensForModel({
        cfg,
        provider: followupRun.run.provider,
        model: defaultModel,
        fallbackContextTokens: activeSessionEntry.contextTokens ?? DEFAULT_CONTEXT_TOKENS,
        allowAsyncLoad: false,
      }) ?? DEFAULT_CONTEXT_TOKENS;
    const pressureResult = checkContextPressure({
      sessionEntry: activeSessionEntry,
      sessionKey,
      contextPressureThreshold,
      contextWindowTokens,
      earlyWarningBand,
      postCompaction: preflightCompactionApplied,
    });
    if (pressureResult.fired && storePath) {
      try {
        await patchSessionEntryCore(
          { storePath, sessionKey },
          () => ({ lastContextPressureBand: pressureResult.band }),
          // Band bookkeeping must not count as activity; keep updatedAt stable.
          { preserveActivity: true },
        );
      } catch (err) {
        defaultRuntime.log(`context-pressure band persistence failed (non-fatal): ${String(err)}`);
      }
    }
  }

  await continuation.resetContinuationChainForFreshTurn();
  activeSessionEntry = getActiveSessionEntry() ?? activeSessionEntry;

  const runStartedAt = Date.now();
  const userTurnAdmission = await admitUserTurn(followupRun.userTurnTranscriptRecorder);
  if (userTurnAdmission === "duplicate-source") {
    return returnWithQueuedFollowupDrain(undefined);
  }

  // Pre-provider no-op replay guard. This is the visible-turn and
  // continuation (getReplyFromConfig) provider path; suppress a self-rearm wake
  // before buying the turn when the per-session no-op streak is tripped. The
  // finally block completes the reply operation and typing on the early return.
  let noOpRearmWakeClass: NoOpRearmWakeClass | undefined;
  if (replySessionKey) {
    const admission = evaluateNoOpRearmAdmission({
      sessionKey: replySessionKey,
      provenance: followupRun.run.inputProvenance,
      inboundEventKind: followupRun.currentInboundEventKind,
      messageId: followupRun.messageId,
      eventTimestampMs: followupRun.currentInboundEventTimestampMs,
      isHeartbeat,
      isContinuationWake,
    });
    noOpRearmWakeClass = admission.wake;
    if (!admission.admit) {
      if (admission.diagnostic) {
        defaultRuntime.log?.(admission.diagnostic.message);
      }
      // Silent suppression: no provider turn, no visible reply. The finally block
      // completes the reply operation and typing, identical to a NO_REPLY turn.
      return returnWithQueuedFollowupDrain(undefined);
    }
  }
  // Adoption marks run start and must never be spool-replayed (would re-run tools).
  // Suppressed delivery persists only the user transcript; crashed suppressed runs die
  // silently. Deliverable turns atomically persist transcript plus recovery ownership.
  await turnAdoptionLifecycle?.onAdopted();
  const runOutcome = await withBeforeAgentReplyObserver(
    {
      beforeDispatch: async () => {
        return await beginBeforeAgentReply();
      },
      afterDispatch: async (hookResult) => {
        if (!hookResult?.handled) {
          await checkpointBeforeAgentReply({ state: undefined });
          return hookResult;
        }
        const hookReply = hookResult.reply ?? { text: SILENT_REPLY_TOKEN };
        const hookFinalDeliveryText = buildRecoverablePendingFinalDeliveryText([hookReply]);
        const normalizedHookReplies = normalizePendingFinalDeliveryPayloads([hookReply]);
        let hookCheckpoint: Parameters<typeof checkpointBeforeAgentReply>[0] = {
          state: normalizedHookReplies.length === 0 ? "handled-silent" : "pending",
        };
        if (sessionKey && storePath && normalizedHookReplies.length > 0) {
          const sourceReplyPolicy = resolveSourceReplyPolicy({
            cfg,
            sessionCtx,
            sessionEntry: activeSessionEntry,
            sessionKey,
            runtimePolicySessionKey,
            opts,
          });
          if (!sourceReplyPolicy.suppressDelivery) {
            const pendingFinalDeliveryIntentId = crypto.randomUUID();
            const pendingFinalDeliveryDeliveryId = crypto.randomUUID();
            setReplyPayloadMetadata(hookReply, {
              pendingFinalDeliveryCompletion: {
                deliveryId: pendingFinalDeliveryDeliveryId,
                intentId: pendingFinalDeliveryIntentId,
                ...(activeSessionEntry?.restartRecoveryDeliveryRunId
                  ? { recoveryRunId: activeSessionEntry.restartRecoveryDeliveryRunId }
                  : {}),
                sessionId: replyOperation.sessionId,
                sessionKey,
                storePath,
              },
            });
            hookCheckpoint = {
              state: "handled-reply",
              pendingFinalDelivery: {
                text: hookFinalDeliveryText ?? "",
                intentId: pendingFinalDeliveryIntentId,
                deliveries: [{ id: pendingFinalDeliveryDeliveryId, state: "prepared" }],
                context: resolveReplyRunDeliveryContext({
                  cfg,
                  sessionCtx,
                  sessionEntry: activeSessionEntry,
                  sessionKey,
                  runtimePolicySessionKey,
                  opts,
                }),
              },
            };
          } else {
            // dispatch-from-config owns source visibility for every returned payload.
            // This checkpoint records that recovery owes no delivery; the outer gate drops the reply.
            hookCheckpoint = { state: "handled-silent" };
          }
        }
        await checkpointBeforeAgentReply(hookCheckpoint);
        return { ...hookResult, reply: hookReply };
      },
    },
    () => {
      const gitCoauthorAttribution = prepareGitCoauthorAttribution({
        agentId: followupRun.run.agentId,
        config: cfg,
        currentProfileId: readSessionInputProfileId(sessionCtx),
        sessionKey,
        storePath,
      });
      const agentTurnOpts = gitCoauthorAttribution ? { ...opts, gitCoauthorAttribution } : opts;
      return traceAgentPhase("reply.run_agent_turn", () =>
        executeAgentTurn({
          commandBody,
          transcriptCommandBody,
          followupRun,
          sessionCtx,
          replyThreading: replyThreadingOverride ?? sessionCtx.ReplyThreading,
          replyOperation,
          opts: agentTurnOpts,
          resolveVisibleReplyDelivery: context.resolveVisibleReplyDelivery,
          typingSignals,
          blockReplyPipeline,
          blockStreamingEnabled,
          blockReplyChunking,
          resolvedBlockStreamingBreak,
          applyReplyToMode,
          shouldEmitToolResult,
          shouldEmitToolOutput,
          pendingToolTasks,
          resetSessionAfterRoleOrderingConflict,
          isHeartbeat,
          hookTrigger,
          sessionKey,
          runtimePolicySessionKey,
          getActiveSessionEntry,
          activeSessionStore,
          storePath,
          resolvedVerboseLevel,
          toolProgressDetail,
          replyMediaContext,
          isRestartRecoveryArmed,
        }),
      );
    },
  );
  const operationSuperseded = isReplyOperationSuperseded(replyOperation);
  recordReplyOperationAgentTurn(
    resolveReplyOperationRunState(opts),
    operationSuperseded
      ? "superseded"
      : runOutcome.outcome.kind === "rejected"
        ? "failed"
        : runOutcome.outcome.kind === "aborted" || runOutcome.outcome.abortReason
          ? "cancelled"
          : runOutcome.outcome.status,
    replyOperation,
  );
  activeSessionEntry = getActiveSessionEntry();
  const activeIsNewSession = getActiveIsNewSession();

  if (operationSuperseded) {
    return { text: SILENT_REPLY_TOKEN };
  }
  if (runOutcome.outcome.kind !== "settled") {
    if (runOutcome.outcome.kind === "rejected" && !replyOperation.result) {
      replyOperation.fail("run_failed", new Error("reply operation exited with final payload"));
    }
    return returnWithQueuedFollowupDrain(
      runOutcome.outcome.kind === "rejected"
        ? markPostCompactionModelFailurePayload(
            runOutcome.outcome.postCompactionModelFailure,
            runOutcome.outcome.payload,
          )
        : { text: SILENT_REPLY_TOKEN },
    );
  }

  const result = await finalizeReplyAgentRun({
    activeIsNewSession,
    activeSessionEntry,
    activeSessionStore,
    blockReplyPipeline,
    blockStreamingEnabled,
    cfg,
    commandBody,
    continuation,
    defaultModel,
    followupRun,
    getActiveSessionEntry,
    isHeartbeat,
    noOpRearmWakeClass,
    opts,
    pendingToolTasks,
    preflightCompactionApplied,
    queueKey,
    replyMediaContext,
    replyOperation,
    replyRouteThreadId,
    replySessionKey,
    replyThreadingOverride,
    replyToChannel,
    replyToMode,
    resolvedBlockStreamingBreak,
    resolvedQueue,
    resolvedVerboseLevel,
    returnWithQueuedFollowupDrain,
    runFollowupTurn,
    execution: runOutcome.outcome,
    runId: runOutcome.runId,
    runStartedAt,
    runtimePolicySessionKey,
    sessionCtx,
    sessionKey,
    setActiveSessionEntry,
    shouldInjectGroupIntro,
    storePath,
    typingSignals,
  });
  return markPostCompactionFailureResult(result, runOutcome.outcome.postCompactionModelFailure);
}

export function createReplyAgentRestartRecoveryController(
  context: Pick<
    RunReplyAgentParams,
    "followupRun" | "opts" | "runtimePolicySessionKey" | "sessionCtx" | "sessionKey" | "storePath"
  > & {
    activeSessionStore: Record<string, SessionEntry> | undefined;
    cfg: OpenClawConfig;
    getActiveSessionEntry: () => SessionEntry | undefined;
    replyOperation: ReplyOperation;
    restartRecoverySourceTurnId: string | undefined;
    setActiveSessionEntry: (entry: SessionEntry) => void;
  },
) {
  const {
    activeSessionStore,
    cfg,
    followupRun,
    getActiveSessionEntry,
    opts,
    replyOperation,
    restartRecoverySourceTurnId,
    runtimePolicySessionKey,
    sessionCtx,
    sessionKey,
    setActiveSessionEntry,
    storePath,
  } = context;

  const restartRecoverySameChannelThreadRequired = restartRecoverySourceTurnId
    ? buildThreadingToolContext({
        sessionCtx,
        config: cfg,
        hasRepliedRef: undefined,
      }).sameChannelThreadRequired
    : undefined;
  const {
    admitUserTurn,
    beginBeforeAgentReply,
    checkpointBeforeAgentReply,
    clear: clearRestartRecoveryDeliveryClaim,
    isArmed: isRestartRecoveryArmed,
  } = createReplyRestartRecoveryClaimController({
    admissionRunId:
      normalizeOptionalString(sessionCtx.MessageSid) ??
      normalizeOptionalString(sessionCtx.MessageSidFull),
    getEntry: () =>
      sessionKey
        ? (activeSessionStore?.[sessionKey] ?? getActiveSessionEntry())
        : getActiveSessionEntry(),
    getSessionId: () => replyOperation.sessionId,
    isRestartAbort: () =>
      replyOperation.result?.kind === "aborted" &&
      replyOperation.result.code === "aborted_for_restart",
    resolveDeliveryContext: (entry) =>
      sessionKey
        ? resolveReplyRunDeliveryContext({
            cfg,
            sessionCtx,
            sessionEntry: entry,
            sessionKey,
            runtimePolicySessionKey,
            opts,
          })
        : undefined,
    requesterAccountId:
      followupRun.originatingAccountId ?? sessionCtx.AccountId ?? followupRun.run.agentAccountId,
    requesterSenderId: sessionCtx.SenderId,
    resolveUserTurnTarget: ({
      entry,
      sessionId,
      sessionKey: targetSessionKey,
      storePath: targetStorePath,
    }) => ({
      sessionId,
      sessionKey: targetSessionKey,
      sessionEntry: entry,
      ...(activeSessionStore ? { sessionStore: activeSessionStore } : {}),
      storePath: targetStorePath,
      agentId: followupRun.run.agentId,
      cwd: followupRun.run.workspaceDir,
      config: cfg,
    }),
    ...(sessionKey ? { sessionKey } : {}),
    setEntry: (entry) => {
      setActiveSessionEntry(entry);
      if (activeSessionStore && sessionKey) {
        activeSessionStore[sessionKey] = entry;
      }
    },
    sameChannelThreadRequired: restartRecoverySameChannelThreadRequired,
    sourceTurnId: restartRecoverySourceTurnId,
    sourceReplyDeliveryMode: sessionKey
      ? resolveSourceReplyPolicy({
          cfg,
          sessionCtx,
          sessionEntry: getActiveSessionEntry(),
          sessionKey,
          runtimePolicySessionKey,
          opts,
        }).sourceReplyDeliveryMode
      : opts?.sourceReplyDeliveryMode,
    ...(storePath ? { storePath } : {}),
  });
  return {
    admitUserTurn,
    beginBeforeAgentReply,
    checkpointBeforeAgentReply,
    clear: clearRestartRecoveryDeliveryClaim,
    isArmed: isRestartRecoveryArmed,
  };
}
