/**
 * Subagent registry lifecycle transitions.
 *
 * Completes/fails task runs, clears delivery state, emits lifecycle events, and cleans attached resources.
 */
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import type { cleanupBrowserSessionsForLifecycleEnd } from "../browser-lifecycle-cleanup.js";
import { formatSqliteSessionFileMarker } from "../config/sessions/sqlite-marker.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { callGateway as defaultCallGateway } from "../gateway/call.js";
import { formatErrorMessage, readErrorName } from "../infra/errors.js";
import {
  isGatewayRestartDraining,
  runWithGatewayIndependentRootWorkAdmission,
  runWithGatewayIndependentRootWorkContinuation,
} from "../process/gateway-work-admission.js";
import { defaultRuntime } from "../runtime.js";
import { emitSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import { recordSubagentTerminalState } from "../sessions/session-state-events.js";
import { extractTextFromChatContent } from "../shared/chat-content.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import type { DetachedTaskFindResult } from "../tasks/detached-task-runtime-contract.js";
import {
  completeTaskRunByRunId,
  failTaskRunByRunId,
  setDetachedTaskDeliveryStatusByRunId,
} from "../tasks/detached-task-runtime.js";
import { isProvisionalSubagentKillTask } from "../tasks/task-cancellation-state.js";
import { resolveRequiredCompletionDeliveryFailureTerminalResult } from "../tasks/task-completion-contract.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.shared.js";
import type { AcceptedSessionSpawn } from "./accepted-session-spawn.js";
import { retireSessionMcpRuntimeForSessionKey } from "./agent-bundle-mcp-tools.js";
import {
  buildAnnounceIdFromChildRun,
  buildAnnounceIdempotencyKey,
} from "./announce-idempotency.js";
import { removeInternalSessionEffectsSession } from "./internal-session-effects.js";
import type { SubagentAnnounceDeliveryResult } from "./subagent-announce-dispatch.js";
import { type SubagentRunOutcome, withSubagentOutcomeTiming } from "./subagent-announce-output.js";
import {
  clearDeliveryState,
  ensureCompletionState,
  ensureDeliveryState,
  getDeliveryLastError,
  isDeliverySuspended,
} from "./subagent-delivery-state.js";
import {
  SUBAGENT_ENDED_REASON_COMPLETE,
  SUBAGENT_ENDED_REASON_ERROR,
  SUBAGENT_ENDED_REASON_KILLED,
  type SubagentLifecycleEndedReason,
} from "./subagent-lifecycle-events.js";
import {
  resolveCleanupCompletionReason,
  resolveDeferredCleanupDecision,
} from "./subagent-registry-cleanup.js";
import {
  resolveKilledSubagentTaskEndedAt,
  resolveFinalizedSubagentTaskState,
  shouldUpdateRunOutcome,
} from "./subagent-registry-completion.js";
import {
  ANNOUNCE_COMPLETION_HARD_EXPIRY_MS,
  ANNOUNCE_EXPIRY_MS,
  capFrozenResultText,
  logAnnounceGiveUp,
  MAX_ANNOUNCE_RETRY_COUNT,
  MIN_ANNOUNCE_RETRY_DELAY_MS,
  persistSubagentSessionTiming,
  resolveAnnounceRetryDelayMs,
  safeRemoveAttachmentsDir,
} from "./subagent-registry-helpers.js";
import { settleRequesterTurnAfterSessionSpawns } from "./subagent-registry-requester-yield.js";
import type {
  PendingFinalDeliveryPayload,
  RequesterSettleWakeState,
  SubagentCompletionRequest,
  SubagentRunRecord,
} from "./subagent-registry.types.js";
import { compareSubagentRunGeneration } from "./subagent-run-generation.js";
import {
  resolveSubagentRunDeadlineMs,
  resolveSubagentRunEffectiveEndedAt,
} from "./subagent-run-timeout.js";
import { deleteSubagentSessionForCleanup } from "./subagent-session-cleanup.js";
import { updateSwarmCollectorCompletion } from "./swarm-collector.js";
import { releaseSwarmRun } from "./swarm-scheduler.js";
import { peekSwarmStructuredOutput } from "./tools/structured-output-tool.js";

type CaptureSubagentCompletionReply =
  (typeof import("./subagent-announce.js"))["captureSubagentCompletionReply"];
type RunSubagentAnnounceFlow = (typeof import("./subagent-announce.js"))["runSubagentAnnounceFlow"];
type MaybeWakeRequesterAfterAllChildrenSettled =
  (typeof import("./subagent-announce.requester-settle-wake.js"))["maybeWakeRequesterAfterAllChildrenSettled"];
type RequesterSettleWakeBatchState =
  import("./subagent-announce.requester-settle-wake.js").RequesterSettleWakeBatchState;
type BrowserCleanupModule = Pick<
  typeof import("../browser-lifecycle-cleanup.js"),
  "cleanupBrowserSessionsForLifecycleEnd"
>;

const DELIVERY_MIRROR_HISTORY_MAX_CHARS = 128 * 1024;

const browserCleanupLoader = createLazyImportLoader<BrowserCleanupModule>(
  () => import("../browser-lifecycle-cleanup.js"),
);

async function loadCleanupBrowserSessionsForLifecycleEnd(): Promise<
  BrowserCleanupModule["cleanupBrowserSessionsForLifecycleEnd"]
> {
  return (await browserCleanupLoader.load()).cleanupBrowserSessionsForLifecycleEnd;
}

function shouldPreservePublishedExplicitRunTimeout(params: { entry: SubagentRunRecord }): boolean {
  if (
    typeof params.entry.runTimeoutSeconds !== "number" ||
    !Number.isFinite(params.entry.runTimeoutSeconds) ||
    params.entry.runTimeoutSeconds <= 0 ||
    params.entry.outcome?.status !== "timeout" ||
    typeof params.entry.endedAt !== "number"
  ) {
    return false;
  }
  const deadlineMs = resolveSubagentRunDeadlineMs(params.entry);
  if (deadlineMs === undefined || params.entry.endedAt < deadlineMs) {
    return false;
  }
  if (
    params.entry.cleanupHandled ||
    typeof params.entry.cleanupCompletedAt === "number" ||
    typeof params.entry.endedHookEmittedAt === "number" ||
    params.entry.delivery?.status === "delivered" ||
    typeof params.entry.delivery?.announcedAt === "number"
  ) {
    return true;
  }
  return false;
}

function resolveExpiredExplicitRunDeadlineMs(params: {
  entry: SubagentRunRecord;
  nextEndedAt: number;
  observedStartedAt?: number;
}): number | undefined {
  const effectiveEndedAt = resolveSubagentRunEffectiveEndedAt(
    params.entry,
    params.nextEndedAt,
    params.observedStartedAt,
  );
  return effectiveEndedAt < params.nextEndedAt ? effectiveEndedAt : undefined;
}

function isOlderEquivalentTerminalCallback(params: {
  entry: SubagentRunRecord;
  endedAt: number;
  outcome: SubagentRunOutcome;
  reason: SubagentLifecycleEndedReason;
}): boolean {
  const current = params.entry.outcome;
  if (
    typeof params.entry.endedAt !== "number" ||
    params.endedAt >= params.entry.endedAt ||
    params.entry.endedReason !== params.reason ||
    current?.status !== params.outcome.status
  ) {
    return false;
  }
  return (
    current.status !== "error" ||
    params.outcome.status !== "error" ||
    current.error === params.outcome.error
  );
}

export function createSubagentRegistryLifecycleController(params: {
  runs: Map<string, SubagentRunRecord>;
  resumedRuns: Set<string>;
  subagentAnnounceTimeoutMs: number;
  getRuntimeConfig(): OpenClawConfig;
  persist(): void;
  persistOrThrow(): void;
  clearPendingLifecycleError(runId: string): void;
  countPendingDescendantRuns(rootSessionKey: string): number;
  suppressAnnounceForSteerRestart(entry?: SubagentRunRecord): boolean;
  resolveSubagentTask(entry: SubagentRunRecord): DetachedTaskFindResult;
  shouldEmitEndedHookForRun(args: {
    entry: SubagentRunRecord;
    reason: SubagentLifecycleEndedReason;
  }): boolean;
  emitSubagentEndedHookForRun(args: {
    entry: SubagentRunRecord;
    reason?: SubagentLifecycleEndedReason;
    sendFarewell?: boolean;
    accountId?: string;
    isCurrent?: () => boolean;
  }): Promise<void>;
  emitSubagentProgressEndedForRun(entry: SubagentRunRecord): Promise<void>;
  notifyContextEngineSubagentEnded(args: {
    childSessionKey: string;
    reason: "completed" | "deleted";
    agentDir?: string;
    workspaceDir?: string;
  }): Promise<void>;
  retireSupersededRun(runId: string, entry: SubagentRunRecord): Promise<void>;
  resumeSubagentRun(runId: string): void;
  callGateway: typeof defaultCallGateway;
  captureSubagentCompletionReply: CaptureSubagentCompletionReply;
  cleanupBrowserSessionsForLifecycleEnd?: typeof cleanupBrowserSessionsForLifecycleEnd;
  runSubagentAnnounceFlow: RunSubagentAnnounceFlow;
  maybeWakeRequesterAfterAllChildrenSettled: MaybeWakeRequesterAfterAllChildrenSettled;
  warn(message: string, meta?: Record<string, unknown>): void;
}) {
  const scheduledResumeTimers = new Set<ReturnType<typeof setTimeout>>();
  const pendingRequesterSettleWakeRearms = new Set<string>();
  const scheduledRequesterSettleWakeRuns = new Set<string>();
  const scheduledRequesterSettleWakeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const terminalCompletionLocks = new Map<string, Promise<void>>();
  const terminalGenerations = new WeakMap<SubagentRunRecord, number>();
  const cleanupGenerations = new WeakMap<SubagentRunRecord, number>();
  // Presentation is transient, so dedupe only this record's competing terminal callbacks.
  // Persisted lifecycle truth stays limited to durable completion and delivery state.
  const progressEndedEntries = new WeakSet<SubagentRunRecord>();

  const newerGenerationOwnsSession = (entry: SubagentRunRecord): boolean =>
    entry.killReconciliation?.supersededAt !== undefined ||
    Array.from(params.runs.values()).some(
      (candidate) =>
        candidate.runId !== entry.runId &&
        candidate.childSessionKey === entry.childSessionKey &&
        compareSubagentRunGeneration(candidate, entry) > 0,
    );

  const acquireTerminalCompletionLock = async (runId: string): Promise<() => void> => {
    const previous = terminalCompletionLocks.get(runId) ?? Promise.resolve();
    let releaseLock = () => {};
    const current = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    terminalCompletionLocks.set(runId, current);
    await previous;
    return () => {
      releaseLock();
      if (terminalCompletionLocks.get(runId) === current) {
        terminalCompletionLocks.delete(runId);
      }
    };
  };

  const scheduleResumeSubagentRun = (
    runId: string,
    entry: SubagentRunRecord,
    delayMs: number,
    cleanupGeneration?: number,
  ) => {
    const timer = setTimeout(() => {
      scheduledResumeTimers.delete(timer);
      void runWithGatewayIndependentRootWorkAdmission(async () => {
        if (params.runs.get(runId) !== entry) {
          return;
        }
        if (cleanupGeneration !== undefined) {
          if (!isCleanupAttemptCurrent(runId, entry, cleanupGeneration)) {
            return;
          }
          entry.cleanupHandled = false;
          params.persist();
        }
        params.resumedRuns.delete(runId);
        params.resumeSubagentRun(runId);
      }).catch((err: unknown) => {
        defaultRuntime.log(`[warn] subagent cleanup resume failed (${runId}): ${String(err)}`);
        const current = params.runs.get(runId);
        if (
          isGatewayRestartDraining() &&
          current === entry &&
          typeof current.cleanupCompletedAt !== "number"
        ) {
          scheduleResumeSubagentRun(
            runId,
            entry,
            Math.max(delayMs, MIN_ANNOUNCE_RETRY_DELAY_MS),
            cleanupGeneration,
          );
        }
      });
    }, delayMs);
    timer.unref?.();
    scheduledResumeTimers.add(timer);
  };

  const clearScheduledResumeTimers = () => {
    for (const timer of scheduledResumeTimers) {
      clearTimeout(timer);
    }
    scheduledResumeTimers.clear();
    for (const timer of scheduledRequesterSettleWakeTimers.values()) {
      clearTimeout(timer);
    }
    scheduledRequesterSettleWakeTimers.clear();
    pendingRequesterSettleWakeRearms.clear();
  };

  const runDetachedCleanupAttempt = (args: {
    runId: string;
    entry: SubagentRunRecord;
    cleanupGeneration: number;
    run: () => Promise<void>;
  }) => {
    // Completion makes the task projection non-blocking before delivery and
    // cleanup finish. This independent lease bridges that handoff and owns the
    // full detached attempt, including its final durable registry write.
    void runWithGatewayIndependentRootWorkAdmission(async () => {
      try {
        await args.run();
      } catch (err) {
        defaultRuntime.log(
          `[warn] subagent cleanup finalize failed (${args.runId}): ${String(err)}`,
        );
        const current = params.runs.get(args.runId);
        if (
          !current ||
          current.cleanupCompletedAt ||
          !isCleanupAttemptCurrent(args.runId, args.entry, args.cleanupGeneration)
        ) {
          return;
        }
        current.cleanupHandled = false;
        params.resumedRuns.delete(args.runId);
        params.persist();
      }
    }).catch((err: unknown) => {
      defaultRuntime.log(
        `[warn] subagent cleanup admission failed (${args.runId}): ${String(err)}`,
      );
      if (isGatewayRestartDraining()) {
        scheduleResumeSubagentRun(
          args.runId,
          args.entry,
          MIN_ANNOUNCE_RETRY_DELAY_MS,
          args.cleanupGeneration,
        );
      }
    });
  };

  const maskRunId = (runId: string): string => {
    const trimmed = runId.trim();
    if (!trimmed) {
      return "unknown";
    }
    if (trimmed.length <= 8) {
      return "***";
    }
    return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
  };

  const maskSessionKey = (sessionKey: string): string => {
    const trimmed = sessionKey.trim();
    if (!trimmed) {
      return "unknown";
    }
    const prefix = trimmed.split(":").slice(0, 2).join(":") || "session";
    return `${prefix}:…`;
  };

  const buildSafeLifecycleErrorMeta = (err: unknown): Record<string, string> => {
    const message = formatErrorMessage(err);
    const name = readErrorName(err);
    return name ? { name, message } : { message };
  };

  const formatAnnounceDeliveryError = (delivery: SubagentAnnounceDeliveryResult): string => {
    const errors = [
      delivery.error,
      ...(delivery.phases ?? []).map((phase) =>
        phase.error ? `${phase.phase}: ${phase.error}` : undefined,
      ),
    ]
      .map((value) => value?.trim())
      .filter((value): value is string => Boolean(value));
    return errors.length > 0
      ? uniqueStrings(errors).join("; ")
      : `delivery path ${delivery.path} did not complete`;
  };

  const recordAnnounceDeliveryResult = (
    entry: SubagentRunRecord,
    delivery: SubagentAnnounceDeliveryResult,
  ) => {
    const deliveryState = ensureDeliveryState(entry);
    if (typeof delivery.enqueuedAt === "number") {
      deliveryState.enqueuedAt ??= delivery.enqueuedAt;
    }
    if (delivery.delivered) {
      const deliveredAt =
        typeof delivery.deliveredAt === "number" ? delivery.deliveredAt : Date.now();
      deliveryState.deliveredAt = deliveredAt;
      deliveryState.lastDropReason = undefined;
    }
  };

  const hasPriorRequesterDeliveryMirror = async (entry: SubagentRunRecord): Promise<boolean> => {
    const completion = ensureCompletionState(entry);
    const expectedText = extractTextFromChatContent(completion.resultText, { joinWith: "" });
    if (entry.expectsCompletionMessage !== true || expectedText == null) {
      return false;
    }
    const mirrorNotBefore = entry.startedAt ?? entry.createdAt;
    const mirrorNotAfter = Date.now() + 30_000;
    const expectedIdempotencyKey = buildAnnounceIdempotencyKey(
      buildAnnounceIdFromChildRun({
        childSessionKey: entry.childSessionKey,
        childRunId: entry.runId,
      }),
    );
    const isExpectedMirrorIdempotencyKey = (value: unknown): boolean =>
      typeof value === "string" &&
      (value === expectedIdempotencyKey ||
        value.startsWith(`${expectedIdempotencyKey}:internal-source-reply:`) ||
        value.startsWith(`${expectedIdempotencyKey}:message-tool:internal-source-reply:`) ||
        value.startsWith(`${entry.runId}:message-tool:`) ||
        value.startsWith(`${entry.runId}:internal-source-reply:`));
    try {
      const history = await params.callGateway<{
        messages?: unknown[];
      }>({
        method: "chat.history",
        params: {
          sessionKey: entry.requesterSessionKey,
          limit: 25,
          maxChars: DELIVERY_MIRROR_HISTORY_MAX_CHARS,
        },
        timeoutMs: 5_000,
      });
      const mirror = history.messages?.find((message) => {
        if (!message || typeof message !== "object") {
          return false;
        }
        const record = message as Record<string, unknown>;
        const timestamp = record.timestamp;
        if (
          typeof timestamp !== "number" ||
          !Number.isFinite(timestamp) ||
          timestamp < mirrorNotBefore ||
          timestamp > mirrorNotAfter ||
          !isExpectedMirrorIdempotencyKey(record.idempotencyKey)
        ) {
          return false;
        }
        const text = extractTextFromChatContent(record.content, { joinWith: "" });
        return (
          record.role === "assistant" &&
          record.provider === "openclaw" &&
          record.model === "delivery-mirror" &&
          text === expectedText
        );
      });
      if (mirror) {
        ensureDeliveryState(entry).deliveredAt = (mirror as { timestamp: number }).timestamp;
      }
      return Boolean(mirror);
    } catch {
      return false;
    }
  };

  const resolveSubagentTaskTarget = (
    entry: SubagentRunRecord,
    resolution = params.resolveSubagentTask(entry),
  ) => {
    const durableTaskRunId = entry.taskRunId ?? entry.runId;
    return {
      runId:
        resolution.lookup === "available"
          ? (resolution.task?.runId ?? durableTaskRunId)
          : durableTaskRunId,
      sessionKey:
        resolution.lookup === "available"
          ? (resolution.task?.childSessionKey ?? entry.childSessionKey)
          : entry.childSessionKey,
    };
  };

  const safeSetSubagentTaskDeliveryStatus = (args: {
    entry: SubagentRunRecord;
    deliveryStatus: "delivered" | "failed";
    deliveryError?: string;
  }) => {
    const target = resolveSubagentTaskTarget(args.entry);
    try {
      setDetachedTaskDeliveryStatusByRunId({
        runId: target.runId,
        runtime: "subagent",
        sessionKey: target.sessionKey,
        deliveryStatus: args.deliveryStatus,
        error: args.deliveryStatus === "failed" ? args.deliveryError : undefined,
      });
    } catch (err) {
      params.warn("failed to update subagent background task delivery state", {
        error: buildSafeLifecycleErrorMeta(err),
        runId: maskRunId(target.runId),
        childSessionKey: maskSessionKey(target.sessionKey),
        deliveryStatus: args.deliveryStatus,
      });
    }
  };

  const safeFinalizeSubagentTaskRun = (args: {
    entry: SubagentRunRecord;
    outcome: SubagentRunOutcome;
    taskResolution?: DetachedTaskFindResult;
  }): ReturnType<typeof completeTaskRunByRunId> => {
    const terminal = resolveFinalizedSubagentTaskState(args.entry);
    if (!terminal) {
      return [];
    }
    const target = resolveSubagentTaskTarget(args.entry, args.taskResolution);
    const { status, error, terminalOutcome, ...details } = terminal;
    const suppressDelivery = args.entry.suppressCompletionDelivery === true;
    try {
      if (status === "succeeded") {
        return completeTaskRunByRunId({
          runId: target.runId,
          runtime: "subagent",
          sessionKey: target.sessionKey,
          ...details,
          terminalOutcome,
          suppressDelivery,
        });
      }
      return failTaskRunByRunId({
        runId: target.runId,
        runtime: "subagent",
        sessionKey: target.sessionKey,
        ...details,
        status,
        error,
        suppressDelivery,
      });
    } catch (err) {
      params.warn("failed to finalize subagent background task state", {
        error: buildSafeLifecycleErrorMeta(err),
        runId: maskRunId(args.entry.runId),
        childSessionKey: maskSessionKey(args.entry.childSessionKey),
        outcomeStatus: args.outcome.status,
      });
      return [];
    }
  };

  const safeMarkRequiredCompletionDeliveryBlocked = (args: {
    entry: SubagentRunRecord;
    reason?: string;
  }) => {
    if (args.entry.expectsCompletionMessage !== true || args.entry.outcome?.status !== "ok") {
      return;
    }
    const endedAt = args.entry.endedAt ?? Date.now();
    const terminalResult = resolveRequiredCompletionDeliveryFailureTerminalResult(args.reason);
    const target = resolveSubagentTaskTarget(args.entry);
    try {
      completeTaskRunByRunId({
        runId: target.runId,
        runtime: "subagent",
        sessionKey: target.sessionKey,
        endedAt,
        lastEventAt: Date.now(),
        progressSummary: ensureCompletionState(args.entry).resultText ?? undefined,
        terminalSummary: terminalResult.terminalSummary,
        terminalOutcome: terminalResult.terminalOutcome,
      });
    } catch (err) {
      params.warn("failed to mark subagent completion delivery blocked", {
        error: buildSafeLifecycleErrorMeta(err),
        runId: maskRunId(args.entry.runId),
        childSessionKey: maskSessionKey(args.entry.childSessionKey),
      });
    }
  };

  const freezeRunResultAtCompletion = async (
    entry: SubagentRunRecord,
    outcome: SubagentRunOutcome,
  ): Promise<boolean> => {
    if (ensureCompletionState(entry).resultText !== undefined) {
      return false;
    }
    if (outcome.status === "error") {
      const completion = ensureCompletionState(entry);
      completion.resultText = null;
      completion.capturedAt = Date.now();
      return true;
    }
    let resultText: string | null;
    try {
      const captured = await params.captureSubagentCompletionReply(entry.childSessionKey, {
        waitForReply: entry.expectsCompletionMessage === true,
        outcome,
        sessionFile: entry.execution?.transcriptTarget?.storePath
          ? formatSqliteSessionFileMarker({
              agentId: entry.execution.transcriptTarget.agentId ?? "",
              sessionId: entry.execution.transcriptTarget.sessionId ?? "",
              storePath: entry.execution.transcriptTarget.storePath,
            })
          : undefined,
      });
      resultText = captured?.trim() ? capFrozenResultText(captured) : null;
    } catch {
      resultText = null;
    }
    const liveEntry = params.runs.get(entry.runId);
    if (
      entry.pauseReason === "sessions_yield" ||
      liveEntry?.pauseReason === "sessions_yield" ||
      newerGenerationOwnsSession(entry)
    ) {
      return false;
    }
    const completion = ensureCompletionState(entry);
    if (completion.resultText !== undefined) {
      return false;
    }
    completion.resultText = resultText;
    completion.capturedAt = Date.now();
    return true;
  };

  const listPendingCompletionRunsForSession = (sessionKey: string): SubagentRunRecord[] => {
    const key = sessionKey.trim();
    if (!key) {
      return [];
    }
    const out: SubagentRunRecord[] = [];
    for (const entry of params.runs.values()) {
      if (entry.childSessionKey !== key) {
        continue;
      }
      if (entry.expectsCompletionMessage !== true) {
        continue;
      }
      if (typeof entry.endedAt !== "number") {
        continue;
      }
      if (typeof entry.cleanupCompletedAt === "number") {
        continue;
      }
      out.push(entry);
    }
    return out;
  };

  const refreshFrozenResultFromSession = async (sessionKey: string): Promise<boolean> => {
    const candidates = listPendingCompletionRunsForSession(sessionKey).filter(
      (entry) => entry.outcome?.status !== "error",
    );
    if (candidates.length === 0) {
      return false;
    }

    let captured: string | undefined;
    try {
      captured = await params.captureSubagentCompletionReply(sessionKey);
    } catch {
      return false;
    }
    const trimmed = captured?.trim();
    if (!trimmed || isSilentReplyText(trimmed, SILENT_REPLY_TOKEN)) {
      return false;
    }

    const nextFrozen = capFrozenResultText(trimmed);
    const capturedAt = Date.now();
    let changed = false;
    for (const entry of candidates) {
      const completion = ensureCompletionState(entry);
      if (completion.resultText === nextFrozen) {
        continue;
      }
      completion.resultText = nextFrozen;
      completion.capturedAt = capturedAt;
      const delivery = entry.delivery;
      if (delivery?.payload) {
        delivery.payload = {
          ...delivery.payload,
          frozenResultText: nextFrozen,
        };
      }
      changed = true;
    }
    if (changed) {
      params.persist();
    }
    return changed;
  };

  const emitCompletionEndedHookIfNeeded = async (
    entry: SubagentRunRecord,
    reason: SubagentLifecycleEndedReason,
    isCurrent?: () => boolean,
  ) => {
    if (params.shouldEmitEndedHookForRun({ entry, reason })) {
      await params.emitSubagentEndedHookForRun({
        entry,
        reason,
        sendFarewell: true,
        isCurrent,
      });
    }
  };

  const clearPendingFinalDelivery = (entry: SubagentRunRecord) => {
    const delivery = ensureDeliveryState(entry);
    delivery.payload = undefined;
    delivery.createdAt = undefined;
    delivery.lastAttemptAt = undefined;
    delivery.attemptCount = undefined;
    delivery.lastError = undefined;
    delivery.suspendedAt = undefined;
    delivery.suspendedReason = undefined;
    if (delivery.status !== "delivered" && delivery.status !== "failed") {
      clearDeliveryState(entry);
    }
  };

  const loadPendingFinalDeliveryPayload = (
    entry: SubagentRunRecord,
  ): PendingFinalDeliveryPayload => {
    return {
      requesterSessionKey:
        entry.delivery?.payload?.requesterSessionKey ?? entry.requesterSessionKey,
      requesterOrigin: entry.delivery?.payload?.requesterOrigin ?? entry.requesterOrigin,
      requesterDisplayKey:
        entry.delivery?.payload?.requesterDisplayKey ?? entry.requesterDisplayKey,
      childSessionKey: entry.delivery?.payload?.childSessionKey ?? entry.childSessionKey,
      childRunId: entry.delivery?.payload?.childRunId ?? entry.runId,
      task: entry.delivery?.payload?.task ?? entry.task,
      label: entry.delivery?.payload?.label ?? entry.label,
      startedAt: entry.delivery?.payload?.startedAt ?? entry.startedAt,
      endedAt: entry.delivery?.payload?.endedAt ?? entry.endedAt,
      outcome: entry.delivery?.payload?.outcome ?? entry.outcome,
      expectsCompletionMessage:
        entry.delivery?.payload?.expectsCompletionMessage ?? entry.expectsCompletionMessage,
      spawnMode: entry.delivery?.payload?.spawnMode ?? entry.spawnMode,
      frozenResultText: entry.delivery?.payload?.frozenResultText ?? entry.completion?.resultText,
      fallbackFrozenResultText:
        entry.delivery?.payload?.fallbackFrozenResultText ?? entry.completion?.fallbackResultText,
      wakeOnDescendantSettle:
        entry.delivery?.payload?.wakeOnDescendantSettle ?? entry.wakeOnDescendantSettle,
    };
  };

  const markPendingFinalDelivery = (args: { entry: SubagentRunRecord; error?: string }) => {
    const now = Date.now();
    const payload: PendingFinalDeliveryPayload = loadPendingFinalDeliveryPayload(args.entry);

    const delivery = ensureDeliveryState(args.entry);
    delivery.status = "pending";
    delivery.createdAt ??= now;
    delivery.lastAttemptAt = now;
    delivery.attemptCount = (delivery.attemptCount ?? 0) + 1;
    delivery.lastError = args.error ?? null;
    delivery.payload = payload;
  };

  const refreshPendingFinalDeliveryPayload = (entry: SubagentRunRecord): boolean => {
    const delivery = entry.delivery;
    if (
      !delivery?.payload ||
      delivery.status === "delivered" ||
      typeof delivery.announcedAt === "number"
    ) {
      return false;
    }
    delivery.payload = {
      ...delivery.payload,
      startedAt: entry.startedAt,
      endedAt: entry.endedAt,
      outcome: entry.outcome,
      frozenResultText: entry.completion?.resultText,
      fallbackFrozenResultText: entry.completion?.fallbackResultText,
    };
    return true;
  };

  const transitionRequesterSettleWakeBatch = (
    runIds: readonly string[],
    state: RequesterSettleWakeBatchState,
  ) => {
    const entries = runIds
      .map((runId) => params.runs.get(runId))
      .filter(
        (entry): entry is SubagentRunRecord =>
          Boolean(entry?.requesterSettleWake) &&
          entry?.requesterSettleWake?.rearmGeneration === state.rearmGeneration,
      );
    const previousStates = entries.map((entry) => structuredClone(entry.requesterSettleWake));
    for (const entry of entries) {
      entry.requesterSettleWake = {
        ...state,
        ...(entry.requesterSettleWake?.retireAfterSettle === true
          ? { retireAfterSettle: true }
          : {}),
      };
    }
    try {
      params.persistOrThrow();
    } catch (error) {
      entries.forEach((entry, index) => {
        entry.requesterSettleWake = previousStates[index];
      });
      throw error;
    }
  };

  const completeRequesterSettleWakeBatch = (
    runIds: readonly string[],
    rearmGeneration?: number,
  ) => {
    const entries = runIds
      .map((runId) => [runId, params.runs.get(runId)] as const)
      .filter(
        (pair): pair is readonly [string, SubagentRunRecord] =>
          Boolean(pair[1]?.requesterSettleWake) &&
          pair[1]?.requesterSettleWake?.rearmGeneration === rearmGeneration,
      );
    const requesterSessionKeys = new Set(entries.map(([, entry]) => entry.requesterSessionKey));
    const previousStates = entries.map(([, entry]) => ({
      requesterSettleWake: structuredClone(entry.requesterSettleWake),
      retireAfterRequesterTurn: entry.retireAfterRequesterTurn,
    }));
    for (const [runId, entry] of entries) {
      if (entry.requesterTurnRunId) {
        entry.retireAfterRequesterTurn =
          entry.retireAfterRequesterTurn === true ||
          entry.requesterSettleWake?.retireAfterSettle === true
            ? true
            : undefined;
        entry.requesterSettleWake = undefined;
      } else if (entry.requesterSettleWake?.retireAfterSettle === true) {
        params.runs.delete(runId);
      } else {
        entry.requesterSettleWake = undefined;
      }
    }
    try {
      params.persistOrThrow();
    } catch (error) {
      entries.forEach(([runId, entry], index) => {
        const previous = previousStates[index];
        params.runs.set(runId, entry);
        entry.requesterSettleWake = previous?.requesterSettleWake;
        entry.retireAfterRequesterTurn = previous?.retireAfterRequesterTurn;
      });
      throw error;
    }
    for (const [runId, entry] of entries) {
      const retryTimer = scheduledRequesterSettleWakeTimers.get(runId);
      if (retryTimer) {
        clearTimeout(retryTimer);
        scheduledRequesterSettleWakeTimers.delete(runId);
      }
      if (entry.requesterSettleWake === undefined || !params.runs.has(runId)) {
        params.resumedRuns.delete(runId);
        params.clearPendingLifecycleError(runId);
      }
    }
    for (const [runId, entry] of params.runs) {
      if (entry.requesterSettleWake && requesterSessionKeys.has(entry.requesterSessionKey)) {
        scheduleRequesterSettleWake(runId, entry);
      }
    }
  };

  const markRequesterSettleWakePending = (
    entry: SubagentRunRecord,
    options?: { retireAfterSettle?: boolean },
  ) => {
    const existing = entry.requesterSettleWake;
    entry.requesterSettleWake = {
      status: existing?.status ?? "pending",
      attemptCount: existing?.attemptCount ?? 0,
      ...(existing?.replayCount !== undefined ? { replayCount: existing.replayCount } : {}),
      ...(existing?.nextAttemptAt !== undefined ? { nextAttemptAt: existing.nextAttemptAt } : {}),
      ...(existing?.batchRunIds ? { batchRunIds: [...existing.batchRunIds] } : {}),
      ...(existing?.requesterYieldBatch === true ? { requesterYieldBatch: true } : {}),
      ...(existing?.afterRequesterYield === true ? { afterRequesterYield: true } : {}),
      ...(existing?.rearmGeneration !== undefined
        ? { rearmGeneration: existing.rearmGeneration }
        : {}),
      ...(existing?.lastError !== undefined ? { lastError: existing.lastError } : {}),
      ...(existing?.retireAfterSettle === true || options?.retireAfterSettle === true
        ? { retireAfterSettle: true }
        : {}),
    } satisfies RequesterSettleWakeState;
  };

  const persistRequesterSettleWakePending = (
    entry: SubagentRunRecord,
    options?: { cleanupCompletedAt?: number; retireAfterSettle?: boolean },
  ) => {
    const previousCleanupCompletedAt = entry.cleanupCompletedAt;
    const previousWake = structuredClone(entry.requesterSettleWake);
    if (options?.cleanupCompletedAt !== undefined) {
      entry.cleanupCompletedAt = options.cleanupCompletedAt;
    }
    markRequesterSettleWakePending(entry, options);
    try {
      params.persistOrThrow();
    } catch (error) {
      entry.cleanupCompletedAt = previousCleanupCompletedAt;
      entry.requesterSettleWake = previousWake;
      throw error;
    }
  };

  // Once a child reaches a terminal settle, let the announce layer decide
  // whether its requester's batch has fully drained and, if so, wake the
  // registry-less top-level requester to synthesize. Settle bookkeeping never
  // blocks on the wake, but the wake must run as tracked root work: a live
  // cleanup parent reserves the root synchronously, so restart or suspend
  // cannot reach quiescence between scheduling and the wake's gateway turn.
  // Failures are logged only.
  function scheduleRequesterSettleWakeRetry(runId: string, entry: SubagentRunRecord): void {
    const nextAttemptAt = entry.requesterSettleWake?.nextAttemptAt;
    if (
      nextAttemptAt === undefined ||
      nextAttemptAt <= Date.now() ||
      scheduledRequesterSettleWakeTimers.has(runId)
    ) {
      return;
    }
    const timer = setTimeout(
      () => {
        scheduledRequesterSettleWakeTimers.delete(runId);
        const current = params.runs.get(runId);
        if (current === entry && current.requesterSettleWake) {
          scheduleRequesterSettleWake(runId, current);
        }
      },
      Math.max(0, nextAttemptAt - Date.now()),
    );
    timer.unref?.();
    scheduledRequesterSettleWakeTimers.set(runId, timer);
  }

  function scheduleRequesterSettleWake(runId: string, entry: SubagentRunRecord): void {
    const requesterSessionKey = entry.requesterSessionKey?.trim();
    if (
      entry.collect ||
      !requesterSessionKey ||
      scheduledRequesterSettleWakeRuns.has(runId) ||
      scheduledRequesterSettleWakeTimers.has(runId)
    ) {
      return;
    }
    if ((entry.requesterSettleWake?.nextAttemptAt ?? 0) > Date.now()) {
      scheduleRequesterSettleWakeRetry(runId, entry);
      return;
    }
    scheduledRequesterSettleWakeRuns.add(runId);
    void runWithGatewayIndependentRootWorkContinuation(() =>
      params.maybeWakeRequesterAfterAllChildrenSettled({
        requesterSessionKey,
        requesterOrigin: entry.requesterOrigin,
        settledEntry: entry,
        transitionBatch: transitionRequesterSettleWakeBatch,
        completeBatch: completeRequesterSettleWakeBatch,
      }),
    )
      .catch((error: unknown) => {
        params.warn("requester settle wake failed", {
          error: buildSafeLifecycleErrorMeta(error),
          runId: maskRunId(runId),
          requesterSessionKey: maskSessionKey(requesterSessionKey),
        });
      })
      .finally(() => {
        scheduledRequesterSettleWakeRuns.delete(runId);
        const wasRearmedWhileRunning = pendingRequesterSettleWakeRearms.delete(runId);
        const current = params.runs.get(runId);
        if (current === entry && current.requesterSettleWake) {
          if (wasRearmedWhileRunning) {
            // A requester yield can freeze a delivered batch while this run is
            // resolving its earlier no-wake decision. Admit that durable update now.
            scheduleRequesterSettleWake(runId, current);
          } else {
            scheduleRequesterSettleWakeRetry(runId, current);
          }
        }
      });
  }

  const suspendPendingFinalDelivery = (args: {
    runId: string;
    entry: SubagentRunRecord;
    reason: "retry-limit" | "expiry";
    error?: string;
  }) => {
    const previousEntry = structuredClone(args.entry);
    markPendingFinalDelivery({
      entry: args.entry,
      error: args.error ?? getDeliveryLastError(args.entry) ?? args.reason,
    });
    const now = Date.now();
    const delivery = ensureDeliveryState(args.entry);
    delivery.status = "suspended";
    delivery.suspendedAt ??= now;
    delivery.suspendedReason = args.reason;
    args.entry.cleanupHandled = false;
    args.entry.wakeOnDescendantSettle = undefined;
    const completion = ensureCompletionState(args.entry);
    completion.fallbackResultText = undefined;
    completion.fallbackCapturedAt = undefined;
    params.resumedRuns.delete(args.runId);
    safeSetSubagentTaskDeliveryStatus({
      entry: args.entry,
      deliveryStatus: "failed",
      deliveryError: getDeliveryLastError(args.entry) ?? args.reason,
    });
    safeMarkRequiredCompletionDeliveryBlocked({
      entry: args.entry,
      reason: getDeliveryLastError(args.entry) ?? args.reason,
    });
    logAnnounceGiveUp(args.entry, args.reason);
    markRequesterSettleWakePending(args.entry);
    try {
      params.persistOrThrow();
    } catch (error) {
      const mutableEntry = args.entry as unknown as Record<string, unknown>;
      for (const key of Object.keys(mutableEntry)) {
        delete mutableEntry[key];
      }
      Object.assign(args.entry, previousEntry);
      throw error;
    }
    // Suspension is terminal for automatic retries, so it settles this child
    // for requester-drain purposes even though cleanup stays incomplete.
    scheduleRequesterSettleWake(args.runId, args.entry);
  };

  const shouldSuspendPendingFinalDelivery = (entry: SubagentRunRecord) =>
    entry.expectsCompletionMessage === true &&
    entry.cleanup === "keep" &&
    entry.endedReason === SUBAGENT_ENDED_REASON_COMPLETE &&
    entry.outcome?.status === "ok";

  const finalizeResumedAnnounceGiveUp = async (giveUpParams: {
    runId: string;
    entry: SubagentRunRecord;
    reason: "retry-limit" | "expiry";
  }) => {
    if (shouldSuspendPendingFinalDelivery(giveUpParams.entry)) {
      suspendPendingFinalDelivery({
        runId: giveUpParams.runId,
        entry: giveUpParams.entry,
        reason: giveUpParams.reason,
        error: getDeliveryLastError(giveUpParams.entry),
      });
      return;
    }
    const deliveryError = getDeliveryLastError(giveUpParams.entry) ?? giveUpParams.reason;
    clearPendingFinalDelivery(giveUpParams.entry);
    const failedDelivery = ensureDeliveryState(giveUpParams.entry);
    failedDelivery.status = "failed";
    failedDelivery.lastError = deliveryError;
    safeSetSubagentTaskDeliveryStatus({
      entry: giveUpParams.entry,
      deliveryStatus: "failed",
      deliveryError,
    });
    safeMarkRequiredCompletionDeliveryBlocked({
      entry: giveUpParams.entry,
      reason: deliveryError,
    });
    giveUpParams.entry.wakeOnDescendantSettle = undefined;
    const completion = ensureCompletionState(giveUpParams.entry);
    completion.fallbackResultText = undefined;
    completion.fallbackCapturedAt = undefined;
    const shouldDeleteAttachments =
      giveUpParams.entry.cleanup === "delete" || !giveUpParams.entry.retainAttachmentsOnKeep;
    if (shouldDeleteAttachments) {
      await safeRemoveAttachmentsDir(giveUpParams.entry);
    }
    const completionReason = resolveCleanupCompletionReason(giveUpParams.entry);
    logAnnounceGiveUp(giveUpParams.entry, giveUpParams.reason);
    // Retry-limit / expiry give-up should not leave cleanup stuck behind the
    // best-effort ended hook. Mark the run cleaned first, then fire the hook.
    completeCleanupBookkeeping({
      runId: giveUpParams.runId,
      entry: giveUpParams.entry,
      cleanup: giveUpParams.entry.cleanup,
      completedAt: Date.now(),
    });
    await emitCompletionEndedHookIfNeeded(giveUpParams.entry, completionReason, () =>
      isEndedHookOwnerCurrent(giveUpParams.runId, giveUpParams.entry),
    );
  };

  const beginSubagentCleanup = (runId: string) => {
    const entry = params.runs.get(runId);
    if (!entry) {
      return false;
    }
    if (entry.cleanupCompletedAt || entry.cleanupHandled) {
      return false;
    }
    entry.cleanupHandled = true;
    cleanupGenerations.set(entry, (cleanupGenerations.get(entry) ?? 0) + 1);
    params.persist();
    return true;
  };

  const isCleanupAttemptCurrent = (
    runId: string,
    entry: SubagentRunRecord,
    generation: number,
  ): boolean =>
    params.runs.get(runId) === entry &&
    entry.cleanupHandled === true &&
    entry.pauseReason !== "sessions_yield" &&
    cleanupGenerations.get(entry) === generation &&
    !newerGenerationOwnsSession(entry);

  const retireSupersededCleanupIfNeeded = async (
    runId: string,
    entry: SubagentRunRecord,
    generation: number,
  ): Promise<boolean> => {
    if (
      params.runs.get(runId) !== entry ||
      cleanupGenerations.get(entry) !== generation ||
      !newerGenerationOwnsSession(entry)
    ) {
      return false;
    }
    // Cleanup can yield to attachment, mirror, or announce work. A successor
    // registered while it was suspended owns every session-scoped side effect.
    await params.retireSupersededRun(runId, entry);
    params.persist();
    return true;
  };

  const retireSupersededCleanupInBackground = (
    runId: string,
    entry: SubagentRunRecord,
    generation: number,
  ) => {
    // Delivery callbacks are synchronous and may arrive after their announce
    // attempt returns. Give the async retirement tail its own snapshot blocker.
    void runWithGatewayIndependentRootWorkAdmission(async () => {
      await retireSupersededCleanupIfNeeded(runId, entry, generation);
    }).catch((error: unknown) => {
      defaultRuntime.log(
        `[warn] subagent superseded cleanup retirement failed (${runId}): ${String(error)}`,
      );
    });
  };

  const isTerminalCallbackCurrent = (
    runId: string,
    entry: SubagentRunRecord,
    generation: number,
  ): boolean =>
    params.runs.get(runId) === entry &&
    entry.pauseReason !== "sessions_yield" &&
    terminalGenerations.get(entry) === generation;

  const isEndedHookOwnerCurrent = (runId: string, entry: SubagentRunRecord): boolean => {
    const current = params.runs.get(runId);
    return (current === undefined || current === entry) && !newerGenerationOwnsSession(entry);
  };

  const retryDeferredCompletedAnnounces = (excludeRunId?: string) => {
    const now = Date.now();
    for (const [runId, entry] of params.runs.entries()) {
      if (excludeRunId && runId === excludeRunId) {
        continue;
      }
      if (typeof entry.endedAt !== "number") {
        continue;
      }
      if (entry.cleanupCompletedAt || entry.cleanupHandled) {
        continue;
      }
      if (isDeliverySuspended(entry)) {
        continue;
      }
      if (params.suppressAnnounceForSteerRestart(entry)) {
        continue;
      }
      const endedAgo = now - (entry.endedAt ?? now);
      if (entry.expectsCompletionMessage !== true && endedAgo > ANNOUNCE_EXPIRY_MS) {
        if (!beginSubagentCleanup(runId)) {
          continue;
        }
        runDetachedCleanupAttempt({
          runId,
          entry,
          cleanupGeneration: cleanupGenerations.get(entry)!,
          run: async () => {
            await finalizeResumedAnnounceGiveUp({
              runId,
              entry,
              reason: "expiry",
            });
          },
        });
        continue;
      }
      params.resumedRuns.delete(runId);
      params.resumeSubagentRun(runId);
    }
  };

  const completeCleanupBookkeeping = (cleanupParams: {
    runId: string;
    entry: SubagentRunRecord;
    cleanup: "delete" | "keep";
    completedAt: number;
    preserveTranscript?: boolean;
    provisionalKill?: boolean;
    // Set by the suspended-delivery discard path: the settle wake already ran
    // when the delivery was suspended, so a discard hours later must not
    // re-evaluate the requester drain.
    skipRequesterSettleWake?: boolean;
  }) => {
    const runCleanupTail = (label: string, run: () => Promise<unknown>) => {
      // These best-effort tails can outlive the durable registry transition,
      // but they still mutate session-owned resources and must block snapshots.
      void runWithGatewayIndependentRootWorkAdmission(run).catch((error: unknown) => {
        defaultRuntime.log(
          `[warn] subagent ${label} failed (${cleanupParams.runId}): ${String(error)}`,
        );
      });
    };
    if (!cleanupParams.preserveTranscript) {
      runCleanupTail("session cleanup", async () => {
        await removeInternalSessionEffectsSession(cleanupParams.entry.execution?.transcriptTarget);
      });
    }
    if (cleanupParams.entry.spawnMode !== "session") {
      runCleanupTail("bundle MCP cleanup", async () => {
        await retireSessionMcpRuntimeForSessionKey({
          sessionKey: cleanupParams.entry.childSessionKey,
          reason: "subagent-run-cleanup",
          preserveActiveLeases: true,
          onError: (error, sessionId) => {
            params.warn("failed to retire subagent bundle MCP runtime", {
              error: buildSafeLifecycleErrorMeta(error),
              sessionId,
              runId: maskRunId(cleanupParams.runId),
              childSessionKey: maskSessionKey(cleanupParams.entry.childSessionKey),
            });
          },
        });
      });
    }
    if (cleanupParams.provisionalKill) {
      // The provider result or bounded kill reconciliation owns terminal settle.
      // Waking here could tell the requester to finalize while the child still runs.
      return;
    }
    if (cleanupParams.entry.collect) {
      // Delete-mode session cleanup already ran before this durable bookkeeping.
      // Preserve only the collector result tombstone for waits and group caps.
      if (cleanupParams.cleanup === "delete") {
        params.clearPendingLifecycleError(cleanupParams.runId);
        runCleanupTail("context-engine cleanup", async () => {
          await params.notifyContextEngineSubagentEnded({
            childSessionKey: cleanupParams.entry.childSessionKey,
            reason: "deleted",
            agentDir: cleanupParams.entry.agentDir,
            workspaceDir: cleanupParams.entry.workspaceDir,
          });
        });
      }
      cleanupParams.entry.cleanupCompletedAt = cleanupParams.completedAt;
      cleanupParams.entry.requesterSettleWake = undefined;
      params.persist();
      retryDeferredCompletedAnnounces(cleanupParams.runId);
      return;
    }
    if (cleanupParams.cleanup === "delete") {
      params.clearPendingLifecycleError(cleanupParams.runId);
      runCleanupTail("context-engine cleanup", async () => {
        await params.notifyContextEngineSubagentEnded({
          childSessionKey: cleanupParams.entry.childSessionKey,
          reason: "deleted",
          agentDir: cleanupParams.entry.agentDir,
          workspaceDir: cleanupParams.entry.workspaceDir,
        });
      });
      if (cleanupParams.skipRequesterSettleWake) {
        params.runs.delete(cleanupParams.runId);
        params.persist();
        retryDeferredCompletedAnnounces(cleanupParams.runId);
        return;
      }
      persistRequesterSettleWakePending(cleanupParams.entry, {
        cleanupCompletedAt: cleanupParams.completedAt,
        retireAfterSettle: true,
      });
      retryDeferredCompletedAnnounces(cleanupParams.runId);
      scheduleRequesterSettleWake(cleanupParams.runId, cleanupParams.entry);
      return;
    }
    runCleanupTail("context-engine cleanup", async () => {
      await params.notifyContextEngineSubagentEnded({
        childSessionKey: cleanupParams.entry.childSessionKey,
        reason: "completed",
        agentDir: cleanupParams.entry.agentDir,
        workspaceDir: cleanupParams.entry.workspaceDir,
      });
    });
    if (
      cleanupParams.entry.endedReason === SUBAGENT_ENDED_REASON_KILLED &&
      cleanupParams.entry.suppressAnnounceReason !== "killed"
    ) {
      // A reconciled killed row has served its tombstone purpose. Retire only
      // the registry record; keep-mode still preserves the child session.
      params.clearPendingLifecycleError(cleanupParams.runId);
      if (cleanupParams.skipRequesterSettleWake) {
        params.runs.delete(cleanupParams.runId);
        params.persist();
        retryDeferredCompletedAnnounces(cleanupParams.runId);
        return;
      }
      persistRequesterSettleWakePending(cleanupParams.entry, {
        cleanupCompletedAt: cleanupParams.completedAt,
        retireAfterSettle: true,
      });
      retryDeferredCompletedAnnounces(cleanupParams.runId);
      scheduleRequesterSettleWake(cleanupParams.runId, cleanupParams.entry);
      return;
    }
    if (!cleanupParams.skipRequesterSettleWake) {
      persistRequesterSettleWakePending(cleanupParams.entry, {
        cleanupCompletedAt: cleanupParams.completedAt,
      });
    } else {
      cleanupParams.entry.cleanupCompletedAt = cleanupParams.completedAt;
      params.persist();
    }
    retryDeferredCompletedAnnounces(cleanupParams.runId);
    if (!cleanupParams.skipRequesterSettleWake) {
      scheduleRequesterSettleWake(cleanupParams.runId, cleanupParams.entry);
    }
  };

  const retireRunModeBundleMcpRuntime = async (cleanupParams: {
    runId: string;
    entry: SubagentRunRecord;
    reason: string;
  }) => {
    if (cleanupParams.entry.spawnMode === "session") {
      return;
    }
    await retireSessionMcpRuntimeForSessionKey({
      sessionKey: cleanupParams.entry.childSessionKey,
      reason: cleanupParams.reason,
      preserveActiveLeases: true,
      onError: (error, sessionId) => {
        params.warn("failed to retire subagent bundle MCP runtime", {
          error: buildSafeLifecycleErrorMeta(error),
          sessionId,
          runId: maskRunId(cleanupParams.runId),
          childSessionKey: maskSessionKey(cleanupParams.entry.childSessionKey),
        });
      },
    });
  };

  const finalizeSubagentCleanup = async (
    runId: string,
    cleanup: "delete" | "keep",
    didAnnounce: boolean,
    cleanupGeneration: number,
    options?: {
      skipAnnounce?: boolean;
      skipDeliveryStatus?: boolean;
      skipRequesterDelivery?: boolean;
    },
  ) => {
    const entry = params.runs.get(runId);
    if (!entry) {
      return;
    }
    if (!isCleanupAttemptCurrent(runId, entry, cleanupGeneration)) {
      await retireSupersededCleanupIfNeeded(runId, entry, cleanupGeneration);
      return;
    }
    if (entry.expectsCompletionMessage === false || options?.skipRequesterDelivery) {
      clearPendingFinalDelivery(entry);
      if (options?.skipRequesterDelivery) {
        ensureDeliveryState(entry).status = "not_required";
        entry.suppressCompletionDelivery = undefined;
      }
      entry.wakeOnDescendantSettle = undefined;
      const shouldDeleteAttachments = cleanup === "delete" || !entry.retainAttachmentsOnKeep;
      if (shouldDeleteAttachments) {
        await safeRemoveAttachmentsDir(entry);
      }
      if (!isCleanupAttemptCurrent(runId, entry, cleanupGeneration)) {
        await retireSupersededCleanupIfNeeded(runId, entry, cleanupGeneration);
        return;
      }
      completeCleanupBookkeeping({
        runId,
        entry,
        cleanup,
        completedAt: Date.now(),
      });
      await emitCompletionEndedHookIfNeeded(entry, resolveCleanupCompletionReason(entry), () =>
        isEndedHookOwnerCurrent(runId, entry),
      );
      return;
    }
    if (didAnnounce) {
      const delivery = ensureDeliveryState(entry);
      const shouldCreditDelivery =
        !options?.skipAnnounce ||
        delivery.status === "delivered" ||
        typeof delivery.announcedAt === "number";
      if (shouldCreditDelivery) {
        const deliveredAt = delivery.deliveredAt ?? delivery.announcedAt ?? Date.now();
        delivery.status = "delivered";
        delivery.deliveredAt = deliveredAt;
        delivery.announcedAt = delivery.announcedAt ?? deliveredAt;
        if (!options?.skipAnnounce) {
          delivery.announcedAt = deliveredAt;
          params.persist();
        }
      }
      clearPendingFinalDelivery(entry);
      const finalDelivery = ensureDeliveryState(entry);
      if (shouldCreditDelivery) {
        finalDelivery.status = "delivered";
        finalDelivery.suspendedAt = undefined;
        finalDelivery.suspendedReason = undefined;
      }
      if (shouldCreditDelivery && !options?.skipDeliveryStatus) {
        safeSetSubagentTaskDeliveryStatus({
          entry,
          deliveryStatus: "delivered",
        });
      }
      finalDelivery.lastError = undefined;
      finalDelivery.lastDropReason = undefined;
      entry.wakeOnDescendantSettle = undefined;
      const completion = ensureCompletionState(entry);
      completion.fallbackResultText = undefined;
      completion.fallbackCapturedAt = undefined;
      const completionReason = resolveCleanupCompletionReason(entry);
      const shouldDeleteAttachments = cleanup === "delete" || !entry.retainAttachmentsOnKeep;
      if (shouldDeleteAttachments) {
        await safeRemoveAttachmentsDir(entry);
      }
      if (!isCleanupAttemptCurrent(runId, entry, cleanupGeneration)) {
        await retireSupersededCleanupIfNeeded(runId, entry, cleanupGeneration);
        return;
      }
      completeCleanupBookkeeping({
        runId,
        entry,
        cleanup,
        completedAt: Date.now(),
      });
      // Hook loading is best-effort; durable delivery and cleanup must already
      // be terminal before plugin code can fail or stall.
      await emitCompletionEndedHookIfNeeded(entry, completionReason, () =>
        isEndedHookOwnerCurrent(runId, entry),
      );
      return;
    }

    const now = Date.now();
    const deferredDecision = resolveDeferredCleanupDecision({
      entry,
      now,
      activeDescendantRuns: Math.max(0, params.countPendingDescendantRuns(entry.childSessionKey)),
      announceExpiryMs: ANNOUNCE_EXPIRY_MS,
      announceCompletionHardExpiryMs: ANNOUNCE_COMPLETION_HARD_EXPIRY_MS,
      maxAnnounceRetryCount: MAX_ANNOUNCE_RETRY_COUNT,
      deferDescendantDelayMs: MIN_ANNOUNCE_RETRY_DELAY_MS,
      resolveAnnounceRetryDelayMs,
    });

    if (deferredDecision.kind === "defer-descendants") {
      ensureDeliveryState(entry).lastAttemptAt = now;
      entry.wakeOnDescendantSettle = true;
      entry.cleanupHandled = false;
      params.resumedRuns.delete(runId);
      params.persist();
      scheduleResumeSubagentRun(runId, entry, deferredDecision.delayMs);
      return;
    }

    if (deferredDecision.kind === "give-up") {
      if (shouldSuspendPendingFinalDelivery(entry)) {
        suspendPendingFinalDelivery({
          runId,
          entry,
          reason: deferredDecision.reason,
          error: getDeliveryLastError(entry),
        });
        return;
      }
      const deliveryError = getDeliveryLastError(entry) ?? deferredDecision.reason;
      clearPendingFinalDelivery(entry);
      const failedDelivery = ensureDeliveryState(entry);
      failedDelivery.status = "failed";
      failedDelivery.lastError = deliveryError;
      if (deferredDecision.retryCount != null) {
        failedDelivery.attemptCount = deferredDecision.retryCount;
        failedDelivery.lastAttemptAt = now;
      }
      safeSetSubagentTaskDeliveryStatus({
        entry,
        deliveryStatus: "failed",
        deliveryError,
      });
      safeMarkRequiredCompletionDeliveryBlocked({
        entry,
        reason: deliveryError,
      });
      entry.wakeOnDescendantSettle = undefined;
      const completion = ensureCompletionState(entry);
      completion.fallbackResultText = undefined;
      completion.fallbackCapturedAt = undefined;
      const shouldDeleteAttachments = cleanup === "delete" || !entry.retainAttachmentsOnKeep;
      if (shouldDeleteAttachments) {
        await safeRemoveAttachmentsDir(entry);
      }
      if (!isCleanupAttemptCurrent(runId, entry, cleanupGeneration)) {
        await retireSupersededCleanupIfNeeded(runId, entry, cleanupGeneration);
        return;
      }
      const completionReason = resolveCleanupCompletionReason(entry);
      logAnnounceGiveUp(entry, deferredDecision.reason);
      // Giving up on announce delivery is terminal for cleanup even if the
      // best-effort hook is still resolving.
      completeCleanupBookkeeping({
        runId,
        entry,
        cleanup,
        completedAt: now,
      });
      await emitCompletionEndedHookIfNeeded(entry, completionReason, () =>
        isEndedHookOwnerCurrent(runId, entry),
      );
      return;
    }

    markPendingFinalDelivery({
      entry,
      error: didAnnounce ? undefined : "announce deferred or direct delivery failed",
    });
    entry.cleanupHandled = false;
    params.resumedRuns.delete(runId);
    params.persist();
    if (deferredDecision.resumeDelayMs == null) {
      return;
    }
    scheduleResumeSubagentRun(runId, entry, deferredDecision.resumeDelayMs);
  };

  const startSubagentAnnounceCleanupFlow = (runId: string, entry: SubagentRunRecord): boolean => {
    if (entry.killReconciliation) {
      // Restores and unrelated cleanup retries must not publish a provisional
      // kill. The sweeper re-enters here after durable reconciliation.
      return false;
    }
    const cleanup = entry.cleanup;
    if (typeof entry.delivery?.announcedAt === "number" || entry.delivery?.status === "delivered") {
      if (!beginSubagentCleanup(runId)) {
        return false;
      }
      const cleanupGeneration = cleanupGenerations.get(entry)!;
      runDetachedCleanupAttempt({
        runId,
        entry,
        cleanupGeneration,
        run: async () => {
          await finalizeSubagentCleanup(runId, cleanup, true, cleanupGeneration, {
            skipAnnounce: true,
          });
        },
      });
      return true;
    }
    if (!beginSubagentCleanup(runId)) {
      return false;
    }
    const cleanupGeneration = cleanupGenerations.get(entry)!;
    const skipRequesterDelivery = entry.suppressCompletionDelivery === true;
    if (entry.expectsCompletionMessage === false || skipRequesterDelivery) {
      runDetachedCleanupAttempt({
        runId,
        entry,
        cleanupGeneration,
        run: async () => {
          // This driver is detached. Yield once so synchronous successor
          // registration can invalidate it before sessions.delete is submitted.
          await Promise.resolve();
          if (!isCleanupAttemptCurrent(runId, entry, cleanupGeneration)) {
            await retireSupersededCleanupIfNeeded(runId, entry, cleanupGeneration);
            return;
          }
          if (cleanup === "delete") {
            // This durable boundary prevents a late yield from reviving a run
            // after deletion may already have reached the gateway.
            entry.deleteCleanupDispatchedAt ??= Date.now();
            params.persist();
            await deleteSubagentSessionForCleanup({
              callGateway: params.callGateway,
              childSessionKey: entry.childSessionKey,
              spawnMode: entry.spawnMode,
              onError: (error) =>
                params.warn("sessions.delete failed during subagent cleanup", {
                  error: buildSafeLifecycleErrorMeta(error),
                  runId: maskRunId(runId),
                  childSessionKey: maskSessionKey(entry.childSessionKey),
                }),
            });
          }
          if (!isCleanupAttemptCurrent(runId, entry, cleanupGeneration)) {
            await retireSupersededCleanupIfNeeded(runId, entry, cleanupGeneration);
            return;
          }
          await finalizeSubagentCleanup(runId, cleanup, true, cleanupGeneration, {
            skipAnnounce: true,
            skipDeliveryStatus: true,
            skipRequesterDelivery,
          });
        },
      });
      return true;
    }
    const pendingPayload = loadPendingFinalDeliveryPayload(entry);
    const requesterOrigin = normalizeDeliveryContext(pendingPayload.requesterOrigin);
    let latestDeliveryError = getDeliveryLastError(entry);
    const finalizeAnnounceCleanup = async (didAnnounce: boolean) => {
      if (!isCleanupAttemptCurrent(runId, entry, cleanupGeneration)) {
        await retireSupersededCleanupIfNeeded(runId, entry, cleanupGeneration);
        return;
      }
      const shouldCreditPriorDelivery =
        !didAnnounce && (await hasPriorRequesterDeliveryMirror(entry));
      if (!isCleanupAttemptCurrent(runId, entry, cleanupGeneration)) {
        await retireSupersededCleanupIfNeeded(runId, entry, cleanupGeneration);
        return;
      }
      if (shouldCreditPriorDelivery) {
        latestDeliveryError = undefined;
      }
      if (!didAnnounce && latestDeliveryError) {
        ensureDeliveryState(entry).lastError = latestDeliveryError;
      }
      await finalizeSubagentCleanup(
        runId,
        cleanup,
        didAnnounce || shouldCreditPriorDelivery,
        cleanupGeneration,
      );
    };

    const announceParams: Parameters<RunSubagentAnnounceFlow>[0] = {
      childSessionKey: pendingPayload.childSessionKey,
      childRunId: pendingPayload.childRunId,
      requesterSessionKey: pendingPayload.requesterSessionKey,
      requesterOrigin,
      requesterDisplayKey: pendingPayload.requesterDisplayKey,
      task: pendingPayload.task,
      timeoutMs: params.subagentAnnounceTimeoutMs,
      cleanup,
      roundOneReply: pendingPayload.frozenResultText ?? undefined,
      fallbackReply: pendingPayload.fallbackFrozenResultText ?? undefined,
      waitForCompletion: false,
      startedAt: pendingPayload.startedAt,
      endedAt: pendingPayload.endedAt,
      label: pendingPayload.label,
      outcome: pendingPayload.outcome,
      spawnMode: pendingPayload.spawnMode,
      expectsCompletionMessage: pendingPayload.expectsCompletionMessage,
      wakeOnDescendantSettle: pendingPayload.wakeOnDescendantSettle === true,
      onBeforeDeleteChildSession:
        cleanup === "delete"
          ? () => {
              if (!isCleanupAttemptCurrent(runId, entry, cleanupGeneration)) {
                return false;
              }
              // Announce owns delete submission; fence late yields at the
              // exact handoff instead of when cleanup merely starts.
              entry.deleteCleanupDispatchedAt ??= Date.now();
              params.persist();
              return true;
            }
          : undefined,
      onDeliveryResult: (delivery) => {
        if (!isCleanupAttemptCurrent(runId, entry, cleanupGeneration)) {
          retireSupersededCleanupInBackground(runId, entry, cleanupGeneration);
          return;
        }
        recordAnnounceDeliveryResult(entry, delivery);
        if (delivery.delivered) {
          const deliveryState = ensureDeliveryState(entry);
          if (deliveryState.lastError !== undefined) {
            deliveryState.lastError = undefined;
            params.persist();
          }
          latestDeliveryError = undefined;
          return;
        }
        if (delivery.path === "none") {
          ensureDeliveryState(entry).lastDropReason = "sink_unavailable";
        }
        latestDeliveryError = formatAnnounceDeliveryError(delivery);
        if (ensureDeliveryState(entry).lastError !== latestDeliveryError) {
          ensureDeliveryState(entry).lastError = latestDeliveryError;
          params.persist();
        }
      },
    };
    runDetachedCleanupAttempt({
      runId,
      entry,
      cleanupGeneration,
      run: async () => {
        let didAnnounce = false;
        try {
          didAnnounce = await params.runSubagentAnnounceFlow(announceParams);
        } catch (error) {
          defaultRuntime.log(
            `[warn] Subagent announce flow failed during cleanup for run ${runId}: ${String(error)}`,
          );
        }
        await finalizeAnnounceCleanup(didAnnounce);
      },
    });
    return true;
  };

  const completeSubagentRunAttempt = async (completeParams: SubagentCompletionRequest) => {
    const releaseCompletionLock = await acquireTerminalCompletionLock(completeParams.runId);
    let entry: SubagentRunRecord | undefined;
    let terminalGeneration = 0;
    let mutated = false;
    let completionReason = completeParams.reason;
    let sessionSuperseded = false;
    let suppressTaskFinalization: boolean;
    let provisionalKillSnapshot: SubagentRunRecord | undefined;
    let postCaptureTaskResolution: DetachedTaskFindResult | undefined;
    let entrySnapshot: SubagentRunRecord | undefined;
    try {
      params.clearPendingLifecycleError(completeParams.runId);
      entry = params.runs.get(completeParams.runId);
      if (!entry) {
        return;
      }
      const currentEntry = entry;
      entrySnapshot = structuredClone(entry);
      const restoreEntrySnapshot = (snapshot?: SubagentRunRecord) => {
        if (!snapshot) {
          return;
        }
        const target = currentEntry as unknown as Record<string, unknown>;
        for (const key of Object.keys(target)) {
          delete target[key];
        }
        Object.assign(target, snapshot);
      };
      const recoveryRequested = completeParams.recoverInterrupted === true;
      if (!recoveryRequested && entry.terminalOwner === "interrupted-recovery") {
        // Restart recovery already persisted the terminal winner for this exact
        // run. Late provider/lifecycle callbacks cannot reopen that decision.
        return;
      }
      if (recoveryRequested) {
        const ownsInterruptedRecovery = entry.terminalOwner === "interrupted-recovery";
        // Mismatched partial terminal evidence is an existing winner and must
        // not be overwritten. Exact normalized evidence may be the same recovery
        // request deferred by restart admission, so drain it.
        const hasTerminalEvidence =
          typeof entry.endedAt === "number" ||
          entry.outcome !== undefined ||
          entry.endedReason !== undefined ||
          entry.execution?.status === "terminal";
        const expectedElapsedMs =
          typeof currentEntry.startedAt === "number" && typeof completeParams.endedAt === "number"
            ? Math.max(0, completeParams.endedAt - currentEntry.startedAt)
            : undefined;
        const outcomeMatchesInterruptedRecovery = (outcome: SubagentRunOutcome | undefined) =>
          completeParams.outcome.status === "error" &&
          outcome?.status === "error" &&
          outcome.error === completeParams.outcome.error &&
          (outcome.startedAt === undefined || outcome.startedAt === currentEntry.startedAt) &&
          (outcome.endedAt === undefined || outcome.endedAt === completeParams.endedAt) &&
          (outcome.elapsedMs === undefined || outcome.elapsedMs === expectedElapsedMs);
        const executionMatchesInterruptedRecovery =
          entry.execution?.status !== "terminal" ||
          (entry.execution.endedAt === completeParams.endedAt &&
            (entry.execution.startedAt === undefined ||
              entry.execution.startedAt === currentEntry.startedAt) &&
            outcomeMatchesInterruptedRecovery(entry.execution.outcome));
        const matchesRequestedInterruptedTerminal =
          typeof completeParams.endedAt === "number" &&
          entry.endedAt === completeParams.endedAt &&
          outcomeMatchesInterruptedRecovery(entry.outcome) &&
          entry.endedReason === SUBAGENT_ENDED_REASON_ERROR &&
          executionMatchesInterruptedRecovery;
        if (
          !ownsInterruptedRecovery &&
          (entry.killReconciliation !== undefined ||
            entry.endedReason === SUBAGENT_ENDED_REASON_KILLED ||
            entry.pauseReason === "sessions_yield" ||
            typeof entry.cleanupCompletedAt === "number" ||
            (hasTerminalEvidence && !matchesRequestedInterruptedTerminal))
        ) {
          return;
        }
        if (!ownsInterruptedRecovery) {
          const endedAt =
            typeof completeParams.endedAt === "number" ? completeParams.endedAt : Date.now();
          const outcome = withSubagentOutcomeTiming(
            { status: "error", error: completeParams.outcome.error },
            { startedAt: entry.startedAt, endedAt },
          );
          entry.endedAt = endedAt;
          entry.outcome = outcome;
          entry.endedReason = SUBAGENT_ENDED_REASON_ERROR;
          entry.pauseReason = undefined;
          entry.execution = {
            ...entry.execution,
            status: "terminal",
            startedAt: entry.startedAt,
            endedAt,
            outcome,
            interruptedAt: undefined,
            interruptionReason: undefined,
          };
          entry.completion = {
            ...ensureCompletionState(entry),
            resultText: null,
            capturedAt: endedAt,
          };
          entry.cleanupHandled = false;
          entry.terminalOwner = "interrupted-recovery";
          mutated = true;
          try {
            params.persistOrThrow();
          } catch (error) {
            restoreEntrySnapshot(entrySnapshot);
            throw error;
          }
          // Any later delivery-payload write rolls back to this durable owner,
          // never to the pre-recovery running row.
          entrySnapshot = structuredClone(entry);
          mutated = false;
        }
      }
      sessionSuperseded = newerGenerationOwnsSession(currentEntry);
      if (
        completeParams.reason === SUBAGENT_ENDED_REASON_KILLED &&
        entry.endedReason !== undefined &&
        entry.endedReason !== SUBAGENT_ENDED_REASON_KILLED &&
        entry.outcome !== undefined
      ) {
        // Any finalized provider outcome is canonical. A delayed abort listener
        // must not replace success, failure, or timeout with a killed marker.
        return;
      }
      let requestedEndedAt =
        typeof completeParams.endedAt === "number" ? completeParams.endedAt : Date.now();
      if (
        shouldPreservePublishedExplicitRunTimeout({
          entry,
        })
      ) {
        return;
      }
      const shouldDrainExistingTerminal =
        recoveryRequested ||
        isOlderEquivalentTerminalCallback({
          entry,
          endedAt: requestedEndedAt,
          outcome: completeParams.outcome,
          reason: completeParams.reason,
        });
      if (shouldDrainExistingTerminal) {
        // Preserve the newer canonical timing while allowing this duplicate
        // caller to rescue a stalled cleanup and delivery tail.
        requestedEndedAt = entry.endedAt!;
        completionReason = entry.endedReason ?? completeParams.reason;
      }
      let endedAt = requestedEndedAt;
      let completionOutcome =
        shouldDrainExistingTerminal && entry.outcome ? entry.outcome : completeParams.outcome;
      const liveStructuredOutput = entry.collect
        ? (entry.structuredOutput ??
          peekSwarmStructuredOutput(entry.runId) ??
          (entry.swarmRunId ? peekSwarmStructuredOutput(entry.swarmRunId) : undefined))
        : undefined;
      if (!entry.structuredOutput && liveStructuredOutput) {
        entry.structuredOutput = liveStructuredOutput;
        mutated = true;
      }
      if (
        liveStructuredOutput?.structured !== undefined &&
        completionOutcome.status === "error" &&
        completionOutcome.error === "completed"
      ) {
        // Tool-only collector turns use this runner sentinel after the result is
        // durably recorded. Normalize before every task/session/hook projection.
        completionOutcome = { status: "ok" };
        completionReason = SUBAGENT_ENDED_REASON_COMPLETE;
      }
      const observedStartedAt =
        !shouldDrainExistingTerminal &&
        typeof completeParams.startedAt === "number" &&
        Number.isFinite(completeParams.startedAt)
          ? completeParams.startedAt
          : undefined;
      const expiredDeadlineMs = recoveryRequested
        ? undefined
        : resolveExpiredExplicitRunDeadlineMs({
            entry,
            nextEndedAt: endedAt,
            observedStartedAt,
          });
      if (expiredDeadlineMs !== undefined) {
        endedAt = expiredDeadlineMs;
        completionOutcome = { status: "timeout" };
        completionReason = SUBAGENT_ENDED_REASON_COMPLETE;
      }
      if (
        completionReason !== SUBAGENT_ENDED_REASON_KILLED &&
        entry.endedReason === SUBAGENT_ENDED_REASON_KILLED &&
        entry.killReconciliation === undefined
      ) {
        // Only current-version provisional kills carry reconciliation state.
        // Legacy or already-stabilized killed rows are terminal cancellation.
        return;
      }
      const isSteerRestartKill =
        completeParams.reason === SUBAGENT_ENDED_REASON_KILLED &&
        entry.suppressAnnounceReason === "steer-restart";
      suppressTaskFinalization = isSteerRestartKill;
      if (completionReason === SUBAGENT_ENDED_REASON_KILLED && !isSteerRestartKill) {
        entry.suppressAnnounceReason = "killed";
        entry.killReconciliation ??= {
          killedAt: requestedEndedAt,
        };
        mutated = true;
      }

      if (
        completionReason !== SUBAGENT_ENDED_REASON_KILLED &&
        entry.endedReason === SUBAGENT_ENDED_REASON_KILLED &&
        entry.killReconciliation !== undefined
      ) {
        const killReconciliation = entry.killReconciliation;
        const taskResolution = params.resolveSubagentTask(entry);
        const stableTaskCancellation =
          taskResolution.lookup === "available" &&
          taskResolution.task?.status === "cancelled" &&
          !isProvisionalSubagentKillTask(taskResolution.task);
        const cancellationEndedAt = resolveKilledSubagentTaskEndedAt(entry);
        const completionPredatesCancellation =
          typeof cancellationEndedAt === "number" && endedAt < cancellationEndedAt;
        if (stableTaskCancellation && !completionPredatesCancellation) {
          // tasks.cancel promotes the provisional marker to durable operator
          // intent. Only an already-durable earlier completion may reopen it.
          return;
        }
        provisionalKillSnapshot = structuredClone(currentEntry);
        // The sweeper uses marker identity to reject a concurrently replaced
        // kill generation. A completion rollback must retain the same marker.
        provisionalKillSnapshot.killReconciliation = killReconciliation;
        // Completion capture yields. Stage the provider result off-registry so
        // an unrelated persistence write cannot publish a tentative winner.
        entry = structuredClone(currentEntry);
        entry.suppressCompletionDelivery =
          killReconciliation.suppressTaskDelivery === true ? true : undefined;
        entry.suppressAnnounceReason = undefined;
        entry.killReconciliation = undefined;
        entry.cleanupHandled = false;
        entry.cleanupCompletedAt = undefined;
        clearDeliveryState(entry);
        mutated = true;
      }

      if (observedStartedAt !== undefined && entry.startedAt !== observedStartedAt) {
        entry.startedAt = observedStartedAt;
        if (typeof entry.sessionStartedAt !== "number") {
          entry.sessionStartedAt = observedStartedAt;
        }
        mutated = true;
      }

      if (
        completionReason === SUBAGENT_ENDED_REASON_COMPLETE &&
        completionOutcome.status !== "error" &&
        provisionalKillSnapshot !== undefined
      ) {
        // A killed lifecycle may freeze an empty result before the canonical end
        // wins. Preserve any reply already captured by an earlier successful callback.
        const completion = ensureCompletionState(entry);
        const hasCapturedReply =
          typeof completion.resultText === "string" && completion.resultText.trim().length > 0;
        if (
          !hasCapturedReply &&
          (completion.resultText !== undefined || completion.capturedAt !== undefined)
        ) {
          completion.resultText = undefined;
          completion.capturedAt = undefined;
          mutated = true;
        }
      }
      if (entry.endedAt !== endedAt) {
        entry.endedAt = endedAt;
        entry.execution = {
          ...entry.execution,
          status: "terminal",
          startedAt: entry.startedAt,
          endedAt,
        };
        mutated = true;
      }
      const outcome =
        recoveryRequested && entry.outcome
          ? entry.outcome
          : withSubagentOutcomeTiming(completionOutcome, {
              startedAt: entry.startedAt,
              endedAt,
            });
      if (shouldUpdateRunOutcome(entry.outcome, outcome)) {
        entry.outcome = outcome;
        mutated = true;
      }
      if (
        entry.execution?.status !== "terminal" ||
        entry.execution.endedAt !== endedAt ||
        entry.execution.outcome !== outcome
      ) {
        entry.execution = {
          ...entry.execution,
          status: "terminal",
          startedAt: entry.startedAt,
          endedAt,
          outcome,
        };
        mutated = true;
      }
      if (entry.endedReason !== completionReason) {
        entry.endedReason = completionReason;
        mutated = true;
      }
      if (entry.pauseReason !== undefined) {
        entry.pauseReason = undefined;
        mutated = true;
      }

      if (completeParams.completionSnapshot) {
        const completion = ensureCompletionState(entry);
        if (
          completion.resultText !== completeParams.completionSnapshot.resultText ||
          completion.capturedAt !== completeParams.completionSnapshot.capturedAt
        ) {
          completion.resultText = completeParams.completionSnapshot.resultText;
          completion.capturedAt = completeParams.completionSnapshot.capturedAt;
          mutated = true;
        }
      }

      // A newer generation may share the session key. Its transcript/reply is
      // not evidence for this older run, so reconcile only the terminal task state.
      if (recoveryRequested || sessionSuperseded) {
        const completion = ensureCompletionState(entry);
        if (completion.resultText === undefined) {
          completion.resultText = null;
          completion.capturedAt = Date.now();
          mutated = true;
        }
      } else {
        const didFreezeResult = await freezeRunResultAtCompletion(entry, outcome);
        sessionSuperseded = newerGenerationOwnsSession(entry);
        if (sessionSuperseded) {
          const completion = ensureCompletionState(entry);
          completion.resultText = null;
          completion.capturedAt = Date.now();
          mutated = true;
        } else if (didFreezeResult) {
          mutated = true;
        }
      }
      if (updateSwarmCollectorCompletion(entry, params.getRuntimeConfig())) {
        mutated = true;
      }
      if (provisionalKillSnapshot) {
        // Keep the tombstone's superseded generation boundary through task
        // commit. Clearing it on the canonical registry row must not let a
        // late old-run result select a newer task sharing the session key.
        const taskResolution = params.resolveSubagentTask(provisionalKillSnapshot);
        postCaptureTaskResolution = taskResolution;
        const stableTaskCancellation =
          taskResolution.lookup === "available" &&
          taskResolution.task?.status === "cancelled" &&
          !isProvisionalSubagentKillTask(taskResolution.task);
        const cancellationEndedAt = resolveKilledSubagentTaskEndedAt(provisionalKillSnapshot);
        const completionPredatesCancellation =
          typeof cancellationEndedAt === "number" && endedAt < cancellationEndedAt;
        if (stableTaskCancellation && !completionPredatesCancellation) {
          // Cancellation can become durable while completion capture yields.
          // The provider transition is staged, so the live tombstone is intact.
          return;
        }
      }
      if (refreshPendingFinalDeliveryPayload(entry)) {
        mutated = true;
      }

      const opaqueTaskArbitration =
        provisionalKillSnapshot !== undefined &&
        postCaptureTaskResolution?.lookup === "unavailable";
      // A steer abort ends one agent run but continues the same detached task.
      // The successor must remain able to publish its eventual terminal state.
      if (provisionalKillSnapshot) {
        const finalizedTasks = safeFinalizeSubagentTaskRun({
          entry,
          outcome,
          taskResolution: postCaptureTaskResolution,
        });
        const taskWasAbsent =
          postCaptureTaskResolution?.lookup === "available" &&
          postCaptureTaskResolution.task === undefined;
        if ((!finalizedTasks || finalizedTasks.length === 0) && !taskWasAbsent) {
          if (opaqueTaskArbitration) {
            // The optional lookup cannot prove cancellation. Let the legacy
            // runtime's own finalizer decide whether provider completion won.
            return;
          }
          const latestTaskResolution = params.resolveSubagentTask(provisionalKillSnapshot);
          const latestTask = latestTaskResolution.task;
          const stableTaskCancellation =
            latestTask?.status === "cancelled" && !isProvisionalSubagentKillTask(latestTask);
          const cancellationEndedAt = resolveKilledSubagentTaskEndedAt(provisionalKillSnapshot);
          const completionPredatesCancellation =
            typeof cancellationEndedAt === "number" && endedAt < cancellationEndedAt;
          if (stableTaskCancellation && !completionPredatesCancellation) {
            return;
          }
          throw new Error("subagent task projection did not finalize");
        }

        // Task results do not auto-publish for subagents. Commit that durable,
        // idempotent projection first: after a crash the persisted kill marker
        // can replay it, while the inverse ordering could strand a provisional task.
        entry.browserCleanupDispatchedAt ??= currentEntry.browserCleanupDispatchedAt;
        if (currentEntry.killReconciliation?.suppressTaskDelivery === true) {
          entry.suppressCompletionDelivery = true;
        }
        const liveBeforeCommit = structuredClone(currentEntry);
        restoreEntrySnapshot(entry);
        entry = currentEntry;
        try {
          params.persistOrThrow();
        } catch (error) {
          restoreEntrySnapshot(liveBeforeCommit);
          throw error;
        }
        // A provider result supersedes provisional cleanup only after both
        // durable owners accept it. Rejected callbacks leave the kill tail live.
        cleanupGenerations.set(entry, (cleanupGenerations.get(entry) ?? 0) + 1);
      } else {
        try {
          if (mutated) {
            params.persistOrThrow();
          }
        } catch (error) {
          restoreEntrySnapshot(entrySnapshot);
          throw error;
        }
        if (!suppressTaskFinalization) {
          safeFinalizeSubagentTaskRun({ entry, outcome });
        }
      }
      terminalGeneration = (terminalGenerations.get(entry) ?? 0) + 1;
      terminalGenerations.set(entry, terminalGeneration);
    } finally {
      // Only the canonical state/capture transition is serialized. Cleanup
      // remains re-entrant so a stalled browser close cannot strand a duplicate callback.
      releaseCompletionLock();
    }

    if (!entry) {
      return;
    }
    if (!isTerminalCallbackCurrent(completeParams.runId, entry, terminalGeneration)) {
      return;
    }
    const retireSupersededSession = async (currentEntry: SubagentRunRecord) => {
      if (completionReason !== SUBAGENT_ENDED_REASON_KILLED) {
        await params.retireSupersededRun(completeParams.runId, currentEntry);
        params.persist();
      }
    };
    sessionSuperseded = sessionSuperseded || newerGenerationOwnsSession(entry);
    if (sessionSuperseded) {
      // This callback belongs to an older run that shared the session key.
      // Update only its task projection; the newer generation owns all session effects.
      await retireSupersededSession(entry);
      return;
    }
    if (entry.collect) {
      releaseSwarmRun(entry.schedulerSlotId ?? entry.runId);
    }
    const isProvisionalKill = entry.killReconciliation !== undefined;
    // Record only the current, non-superseded callback with a committed outcome; the
    // run-terminal dedupe key is first-write-wins, so a provisional/stale status here
    // would permanently mislabel the signal-log terminal kind.
    if (!isProvisionalKill && entry.outcome?.status && entry.outcome.status !== "unknown") {
      recordSubagentTerminalState({
        childSessionKey: entry.childSessionKey,
        runId: entry.runId,
        requesterSessionKey: entry.requesterSessionKey,
        outcomeStatus: entry.outcome.status,
      });
    }

    if (!completeParams.suppressSessionEffects) {
      try {
        await persistSubagentSessionTiming(entry, {
          // Recheck while patchSessionEntry owns its write lock so this old
          // completion cannot commit after a synchronous ownership transfer.
          isCurrentGeneration: () =>
            isTerminalCallbackCurrent(completeParams.runId, entry, terminalGeneration) &&
            !newerGenerationOwnsSession(entry),
        });
      } catch (err) {
        params.warn("failed to persist subagent session timing", {
          err,
          runId: entry.runId,
          childSessionKey: entry.childSessionKey,
        });
      }
    }
    if (!isTerminalCallbackCurrent(completeParams.runId, entry, terminalGeneration)) {
      return;
    }
    if (newerGenerationOwnsSession(entry)) {
      await retireSupersededSession(entry);
      return;
    }

    const suppressedForSteerRestart = params.suppressAnnounceForSteerRestart(entry);
    if (mutated && !suppressedForSteerRestart && !completeParams.suppressSessionEffects) {
      emitSessionLifecycleEvent({
        sessionKey: entry.childSessionKey,
        reason: "subagent-status",
        parentSessionKey: entry.requesterSessionKey,
        label: entry.label,
      });
      // The enclosing steer/session-effects guard admits only the real terminal generation.
      if (!isProvisionalKill && !progressEndedEntries.has(entry)) {
        progressEndedEntries.add(entry);
        await params.emitSubagentProgressEndedForRun(entry);
        if (!isTerminalCallbackCurrent(completeParams.runId, entry, terminalGeneration)) {
          return;
        }
      }
    }
    const shouldEmitEndedHook =
      !suppressedForSteerRestart &&
      !isProvisionalKill &&
      !completeParams.suppressSessionEffects &&
      params.shouldEmitEndedHookForRun({
        entry,
        reason: completionReason,
      });
    const shouldDeferEndedHook =
      shouldEmitEndedHook &&
      completeParams.triggerCleanup &&
      entry.expectsCompletionMessage === true &&
      !suppressedForSteerRestart;
    if (!shouldDeferEndedHook && shouldEmitEndedHook) {
      await params.emitSubagentEndedHookForRun({
        entry,
        reason: completionReason,
        sendFarewell: completeParams.sendFarewell,
        accountId: completeParams.accountId,
        isCurrent: () =>
          isTerminalCallbackCurrent(completeParams.runId, entry, terminalGeneration) &&
          !newerGenerationOwnsSession(entry),
      });
      if (!isTerminalCallbackCurrent(completeParams.runId, entry, terminalGeneration)) {
        return;
      }
      if (newerGenerationOwnsSession(entry)) {
        await retireSupersededSession(entry);
        return;
      }
    }

    if (!completeParams.triggerCleanup || suppressedForSteerRestart) {
      return;
    }

    // registerSubagentRun fires both an in-process listener and a gateway
    // waitForSubagentCompletion RPC; both can reach this point for the same
    // runId in embedded mode. Dedupe only the browser driver tab-close IPC
    // with a sync check-then-set. The retire + announce tail below must still
    // run for every caller, so a slow or held first browser cleanup cannot
    // strand a duplicate caller's completion behind it.
    if (entry.browserCleanupDispatchedAt === undefined) {
      entry.browserCleanupDispatchedAt = Date.now();
      try {
        const cleanupBrowserSessions =
          params.cleanupBrowserSessionsForLifecycleEnd ??
          (await loadCleanupBrowserSessionsForLifecycleEnd());
        await cleanupBrowserSessions({
          sessionKeys: [entry.childSessionKey],
          onWarn: (msg) => params.warn(msg, { runId: entry.runId }),
        });
      } catch (error) {
        params.warn("failed to cleanup browser sessions for completed subagent", {
          error: buildSafeLifecycleErrorMeta(error),
          runId: maskRunId(completeParams.runId),
          childSessionKey: maskSessionKey(entry.childSessionKey),
        });
      }
      if (!isTerminalCallbackCurrent(completeParams.runId, entry, terminalGeneration)) {
        return;
      }
      if (newerGenerationOwnsSession(entry)) {
        await retireSupersededSession(entry);
        return;
      }
    }

    try {
      await retireRunModeBundleMcpRuntime({
        runId: completeParams.runId,
        entry,
        reason: "subagent-run-complete",
      });
    } catch (error) {
      params.warn("failed to retire subagent bundle MCP runtime after completion", {
        error: buildSafeLifecycleErrorMeta(error),
        runId: maskRunId(completeParams.runId),
        childSessionKey: maskSessionKey(entry.childSessionKey),
      });
    }
    if (!isTerminalCallbackCurrent(completeParams.runId, entry, terminalGeneration)) {
      return;
    }
    if (newerGenerationOwnsSession(entry)) {
      await retireSupersededSession(entry);
      return;
    }

    if (isProvisionalKill) {
      // Browser and MCP resources can close immediately, but completion delivery
      // waits for the provider result or the killed tombstone reconciliation.
      return;
    }

    startSubagentAnnounceCleanupFlow(completeParams.runId, entry);
  };

  const completeSubagentRun = async (completeParams: SubagentCompletionRequest) => {
    // Task finalization can make the run disappear from suspension blockers
    // before browser/MCP retirement and cleanup delivery hand off. Own this
    // entire transition as an independent root so that boundary stays atomic.
    // Callers can detach while retaining parent ALS, so nesting is intentional.
    await runWithGatewayIndependentRootWorkAdmission(async () => {
      await completeSubagentRunAttempt(completeParams);
    });
  };

  return {
    clearScheduledResumeTimers,
    completeCleanupBookkeeping,
    completeSubagentRun,
    finalizeResumedAnnounceGiveUp,
    refreshFrozenResultFromSession,
    settleRequesterTurnAfterSessionSpawns: (args: {
      requesterSessionKey: string;
      requesterTurnRunId: string;
      requesterYielded: boolean;
      acceptedSessionSpawns: readonly AcceptedSessionSpawn[];
    }) =>
      settleRequesterTurnAfterSessionSpawns({
        ...args,
        runs: params.runs,
        persistOrThrow: () => params.persistOrThrow(),
        schedule: (runId, entry) => {
          if (scheduledRequesterSettleWakeRuns.has(runId)) {
            pendingRequesterSettleWakeRearms.add(runId);
            return;
          }
          scheduleRequesterSettleWake(runId, entry);
        },
      }),
    resumeRequesterSettleWake: scheduleRequesterSettleWake,
    startSubagentAnnounceCleanupFlow,
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
