import crypto from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { isLikelyContextOverflowError } from "../../agents/embedded-agent-helpers/errors.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { logVerbose } from "../../globals.js";
import { withBeforeAgentReplyObserver } from "../../plugins/before-agent-reply.js";
import { setReplyPayloadMetadata } from "../reply-payload.js";
import type { OriginatingChannelType } from "../templating.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import type { ReplyPayload } from "../types.js";
import {
  resolveReplyRunDeliveryContext,
  resolveSourceReplyPolicy,
  type RunReplyAgentParams,
} from "./agent-runner-core.js";
import { runAgentTurnWithFallback } from "./agent-runner-execution.js";
import { runMemoryFlushIfNeeded, runPreflightCompactionIfNeeded } from "./agent-runner-memory.js";
import { finalizeReplyAgentRun } from "./agent-runner-result.js";
import { buildThreadingToolContext } from "./agent-runner-utils.js";
import type { BlockReplyPipeline } from "./block-reply-pipeline.js";
import type { CompactionNoticePhase } from "./compaction-notice.js";
import { createFollowupRunner } from "./followup-runner.js";
import {
  buildRecoverablePendingFinalDeliveryText,
  normalizePendingFinalDeliveryPayloads,
} from "./pending-final-delivery.js";
import type { FollowupRun } from "./queue.js";
import type { ReplyMediaContext } from "./reply-media-paths.js";
import type { ReplyOperation } from "./reply-run-registry.js";
import { resolveReplyToMode } from "./reply-threading.js";
import { createReplyRestartRecoveryClaimController } from "./restart-recovery-claim.js";
import { resolveRoutedDeliveryThreadId } from "./routed-delivery-thread.js";
import type { TypingSignaler } from "./typing-mode.js";
type SessionResetOptions = {
  failureLabel: string;
  buildLogMessage: (nextSessionId: string) => string;
  cleanupTranscripts?: boolean;
};

type ExecutePreparedReplyAgentRunInput = Pick<
  RunReplyAgentParams,
  | "agentCfgContextTokens"
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
  beforeAgentReplyDispatchedForSteer: boolean;
  beginBeforeAgentReply: ReturnType<
    typeof createReplyRestartRecoveryClaimController
  >["beginBeforeAgentReply"];
  blockReplyPipeline: BlockReplyPipeline | null;
  cfg: OpenClawConfig;
  checkpointBeforeAgentReply: ReturnType<
    typeof createReplyRestartRecoveryClaimController
  >["checkpointBeforeAgentReply"];
  getActiveIsNewSession: () => boolean;
  getActiveSessionEntry: () => SessionEntry | undefined;
  isHeartbeat: boolean;
  isRestartRecoveryArmed: () => boolean;
  pendingToolTasks: Set<Promise<void>>;
  performSessionReset: (options: SessionResetOptions) => Promise<boolean>;
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

export async function executePreparedReplyAgentRun(
  context: ExecutePreparedReplyAgentRunInput,
): Promise<ReplyPayload | ReplyPayload[] | undefined> {
  const {
    activeSessionStore,
    admitUserTurn: admitUserTurnWithRecovery,
    agentCfgContextTokens,
    applyReplyToMode,
    beforeAgentReplyDispatchedForSteer,
    beginBeforeAgentReply: beginBeforeAgentReplyWithRecovery,
    blockReplyChunking,
    blockReplyPipeline,
    blockStreamingEnabled,
    cfg,
    checkpointBeforeAgentReply: checkpointBeforeAgentReplyWithRecovery,
    commandBody,
    defaultModel,
    followupRun,
    getActiveIsNewSession,
    getActiveSessionEntry,
    isHeartbeat,
    isRestartRecoveryArmed,
    opts,
    pendingToolTasks,
    performSessionReset,
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
  let activeIsNewSession: boolean;
  let preflightCompactionApplied: boolean | undefined;
  const resetSession = async (options: SessionResetOptions): Promise<boolean> => {
    const reset = await performSessionReset(options);
    activeSessionEntry = getActiveSessionEntry();
    activeIsNewSession = getActiveIsNewSession();
    return reset;
  };
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
      agentCfgContextTokens,
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
  try {
    activeSessionEntry = await traceAgentPhase("reply.preflight_compaction", () =>
      runPreflightCompactionIfNeeded({
        cfg,
        followupRun,
        promptForEstimate: followupRun.prompt,
        defaultModel,
        agentCfgContextTokens,
        sessionEntry: activeSessionEntry,
        sessionStore: activeSessionStore,
        sessionKey,
        runtimePolicySessionKey,
        storePath,
        isHeartbeat,
        replyOperation,
        onCompactionNotice: sendDirectCompactionNotice,
      }),
    );
    setActiveSessionEntry(activeSessionEntry);
    preflightCompactionApplied =
      (activeSessionEntry?.compactionCount ?? 0) > prePreflightCompactionCount;
  } catch (err) {
    const canRotateAfterPreflightFailure =
      memoryFlushResult.outcome === "exhausted" &&
      !replyOperation.abortSignal.aborted &&
      isLikelyContextOverflowError(String(err));
    if (!canRotateAfterPreflightFailure) {
      throw err;
    }
    logVerbose(`Preflight compaction could not recover exhausted memory flush: ${String(err)}`);
  }

  if (memoryFlushResult.outcome === "exhausted" && !preflightCompactionApplied) {
    await resetSession({
      failureLabel: "memory flush exhaustion",
      buildLogMessage: (nextSessionId) =>
        `Memory flush exhausted. Rotating bloated session ${sessionKey} -> ${nextSessionId}.`,
      // Rotate only when compaction could not recover the bloated context.
      cleanupTranscripts: false,
    });
    if (activeSessionEntry?.sessionId) {
      replyOperation.updateSessionId(activeSessionEntry.sessionId);
    }
  }

  // Exhausted background maintenance is non-terminal: optionally notify, then reply normally.
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
    agentCfgContextTokens,
    toolProgressDetail,
  });
  setRunFollowupTurn(runFollowupTurn);

  replyOperation.setPhase("running");
  const runStartedAt = Date.now();
  const userTurnAdmission = await admitUserTurn(followupRun.userTurnTranscriptRecorder);
  if (userTurnAdmission === "duplicate-source") {
    return returnWithQueuedFollowupDrain(undefined);
  }
  // Adoption marks run start and must never be spool-replayed (would re-run tools).
  // Suppressed delivery persists only the user transcript; crashed suppressed runs die
  // silently. Deliverable turns atomically persist transcript plus recovery ownership.
  await turnAdoptionLifecycle?.onAdopted();
  const runOutcome = await withBeforeAgentReplyObserver(
    {
      beforeDispatch: async () => {
        const shouldDispatch = await beginBeforeAgentReply();
        if (!shouldDispatch || !beforeAgentReplyDispatchedForSteer) {
          return shouldDispatch;
        }
        // The same source fell through from steering. Advance recovery while
        // preserving the hook decision made before the attempted injection.
        await checkpointBeforeAgentReply({ state: "continue" });
        return false;
      },
      afterDispatch: async (hookResult) => {
        if (!hookResult?.handled) {
          await checkpointBeforeAgentReply({ state: "continue" });
          return hookResult;
        }
        const hookReply = hookResult.reply ?? { text: SILENT_REPLY_TOKEN };
        const hookFinalDeliveryText = buildRecoverablePendingFinalDeliveryText([hookReply]);
        const normalizedHookReplies = normalizePendingFinalDeliveryPayloads([hookReply]);
        let hookCheckpoint: Parameters<typeof checkpointBeforeAgentReply>[0] = {
          state: normalizedHookReplies.length === 0 ? "handled-silent" : "handled-unrecoverable",
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
            setReplyPayloadMetadata(hookReply, {
              pendingFinalDeliveryIntentId,
              pendingFinalDeliveryRetryText: hookFinalDeliveryText,
            });
            hookCheckpoint = {
              state: hookFinalDeliveryText ? "handled-reply" : "handled-unrecoverable",
              pendingFinalDelivery: {
                text: hookFinalDeliveryText ?? "",
                intentId: pendingFinalDeliveryIntentId,
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
    () =>
      traceAgentPhase("reply.run_agent_turn", () =>
        runAgentTurnWithFallback({
          commandBody,
          transcriptCommandBody,
          followupRun,
          sessionCtx,
          replyThreading: replyThreadingOverride ?? sessionCtx.ReplyThreading,
          replyOperation,
          opts,
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
      ),
  );
  activeSessionEntry = getActiveSessionEntry();
  activeIsNewSession = getActiveIsNewSession();

  if (runOutcome.kind === "final") {
    if (!replyOperation.result) {
      replyOperation.fail("run_failed", new Error("reply operation exited with final payload"));
    }
    return returnWithQueuedFollowupDrain(runOutcome.payload);
  }

  return await finalizeReplyAgentRun({
    activeIsNewSession,
    activeSessionEntry,
    activeSessionStore,
    agentCfgContextTokens,
    blockReplyPipeline,
    blockStreamingEnabled,
    cfg,
    commandBody,
    defaultModel,
    followupRun,
    isHeartbeat,
    opts,
    pendingToolTasks,
    preflightCompactionApplied,
    queueKey,
    replyMediaContext,
    replyOperation,
    replyRouteThreadId,
    replyThreadingOverride,
    replyToChannel,
    replyToMode,
    resolvedBlockStreamingBreak,
    resolvedQueue,
    resolvedVerboseLevel,
    returnWithQueuedFollowupDrain,
    runFollowupTurn,
    runOutcome,
    runStartedAt,
    runtimePolicySessionKey,
    sessionCtx,
    sessionKey,
    shouldInjectGroupIntro,
    storePath,
    typingSignals,
  });
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
    beforeAgentReplyState: "admitted",
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
