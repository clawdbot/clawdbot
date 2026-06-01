import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import type { cleanupBrowserSessionsForLifecycleEnd } from "../browser-lifecycle-cleanup.js";
import type { callGateway as defaultCallGateway } from "../gateway/call.js";
import { formatErrorMessage, readErrorName } from "../infra/errors.js";
import { defaultRuntime } from "../runtime.js";
import { emitSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import { extractTextFromChatContent } from "../shared/chat-content.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import {
  completeTaskRunByRunId,
  failTaskRunByRunId,
  setDetachedTaskDeliveryStatusByRunId,
} from "../tasks/detached-task-runtime.js";
import {
  resolveRequiredCompletionDeliveryFailureTerminalResult,
  resolveRequiredCompletionTerminalResult,
} from "../tasks/task-completion-contract.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.shared.js";
import { retireSessionMcpRuntimeForSessionKey } from "./agent-bundle-mcp-tools.js";
import {
  buildAnnounceIdFromChildRun,
  buildAnnounceIdempotencyKey,
} from "./announce-idempotency.js";
import { removeInternalSessionEffectsTranscript } from "./internal-session-effects.js";
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
  type SubagentLifecycleEndedReason,
} from "./subagent-lifecycle-events.js";
import {
  resolveCleanupCompletionReason,
  resolveDeferredCleanupDecision,
} from "./subagent-registry-cleanup.js";
import { shouldUpdateRunOutcome } from "./subagent-registry-completion.js";
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
import type { PendingFinalDeliveryPayload, SubagentRunRecord } from "./subagent-registry.types.js";
import { resolveSubagentRunDeadlineMs } from "./subagent-run-timeout.js";
import { deleteSubagentSessionForCleanup } from "./subagent-session-cleanup.js";

type CaptureSubagentCompletionReply =
  (typeof import("./subagent-announce.js"))["captureSubagentCompletionReply"];
type RunSubagentAnnounceFlow = (typeof import("./subagent-announce.js"))["runSubagentAnnounceFlow"];
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
  nextOutcome: SubagentRunOutcome;
  nextEndedAt: number;
  observedStartedAt?: number;
}): number | undefined {
  const deadlineMs = resolveSubagentRunDeadlineMs(params.entry, params.observedStartedAt);
  return deadlineMs !== undefined && params.nextEndedAt > deadlineMs ? deadlineMs : undefined;
}

export function createSubagentRegistryLifecycleController(params: {
  runs: Map<string, SubagentRunRecord>;
  resumedRuns: Set<string>;
  subagentAnnounceTimeoutMs: number;
  persist(): void;
  clearPendingLifecycleError(runId: string): void;
  countPendingDescendantRuns(rootSessionKey: string): number;
  suppressAnnounceForSteerRestart(entry?: SubagentRunRecord): boolean;
  shouldEmitEndedHookForRun(args: {
    entry: SubagentRunRecord;
    reason: SubagentLifecycleEndedReason;
  }): boolean;
  emitSubagentEndedHookForRun(args: {
    entry: SubagentRunRecord;
    reason?: SubagentLifecycleEndedReason;
    sendFarewell?: boolean;
    accountId?: string;
  }): Promise<void>;
  notifyContextEngineSubagentEnded(args: {
    childSessionKey: string;
    reason: "completed" | "deleted";
    agentDir?: string;
    workspaceDir?: string;
  }): Promise<void>;
  resumeSubagentRun(runId: string): void;
  callGateway: typeof defaultCallGateway;
  captureSubagentCompletionReply: CaptureSubagentCompletionReply;
  cleanupBrowserSessionsForLifecycleEnd?: typeof cleanupBrowserSessionsForLifecycleEnd;
  runSubagentAnnounceFlow: RunSubagentAnnounceFlow;
  warn(message: string, meta?: Record<string, unknown>): void;
}) {
  const scheduledResumeTimers = new Set<ReturnType<typeof setTimeout>>();

  const scheduleResumeSubagentRun = (runId: string, entry: SubagentRunRecord, delayMs: number) => {
    const timer = setTimeout(() => {
      scheduledResumeTimers.delete(timer);
      if (params.runs.get(runId) !== entry) {
        return;
      }
      params.resumeSubagentRun(runId);
    }, delayMs);
    timer.unref?.();
    scheduledResumeTimers.add(timer);
  };

  const clearScheduledResumeTimers = () => {
    for (const timer of scheduledResumeTimers) {
      clearTimeout(timer);
    }
    scheduledResumeTimers.clear();
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

  const safeSetSubagentTaskDeliveryStatus = (args: {
    runId: string;
    childSessionKey: string;
    deliveryStatus: "delivered" | "failed";
    deliveryError?: string;
  }) => {
    try {
      setDetachedTaskDeliveryStatusByRunId({
        runId: args.runId,
        runtime: "subagent",
        sessionKey: args.childSessionKey,
        deliveryStatus: args.deliveryStatus,
        error: args.deliveryStatus === "failed" ? args.deliveryError : undefined,
      });
    } catch (err) {
      params.warn("failed to update subagent background task delivery state", {
        error: buildSafeLifecycleErrorMeta(err),
        runId: maskRunId(args.runId),
        childSessionKey: maskSessionKey(args.childSessionKey),
        deliveryStatus: args.deliveryStatus,
      });
    }
  };

  const safeFinalizeSubagentTaskRun = (args: {
    entry: SubagentRunRecord;
    outcome: SubagentRunOutcome;
  }) => {
    const endedAt = args.entry.endedAt ?? Date.now();
    const lastEventAt = endedAt;
    try {
      if (args.outcome.status === "ok") {
        const completion = ensureCompletionState(args.entry);
        const terminalResult =
          args.entry.expectsCompletionMessage === true
            ? resolveRequiredCompletionTerminalResult(completion.resultText)
            : {};
        completeTaskRunByRunId({
          runId: args.entry.runId,
          runtime: "subagent",
          sessionKey: args.entry.childSessionKey,
          endedAt,
          lastEventAt,
          progressSummary: completion.resultText ?? undefined,
          terminalSummary: terminalResult.terminalSummary ?? null,
          terminalOutcome: terminalResult.terminalOutcome,
        });
        return;
      }
      failTaskRunByRunId({
        runId: args.entry.runId,
        runtime: "subagent",
        sessionKey: args.entry.childSessionKey,
        status: args.outcome.status === "timeout" ? "timed_out" : "failed",
        endedAt,
        lastEventAt,
        error: args.outcome.status === "error" ? args.outcome.error : undefined,
        progressSummary: ensureCompletionState(args.entry).resultText ?? undefined,
        terminalSummary: null,
      });
    } catch (err) {
      params.warn("failed to finalize subagent background task state", {
        error: buildSafeLifecycleErrorMeta(err),
        runId: maskRunId(args.entry.runId),
        childSessionKey: maskSessionKey(args.entry.childSessionKey),
        outcomeStatus: args.outcome.status,
      });
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
    try {
      completeTaskRunByRunId({
        runId: args.entry.runId,
        runtime: "subagent",
        sessionKey: args.entry.childSessionKey,
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
    const completion = ensureCompletionState(entry);
    if (completion.resultText !== undefined) {
      return false;
    }
    if (outcome.status === "error") {
      completion.resultText = null;
      completion.capturedAt = Date.now();
      return true;
    }
    try {
      const captured = await params.captureSubagentCompletionReply(entry.childSessionKey, {
        waitForReply: entry.expectsCompletionMessage === true,
        outcome,
        sessionFile: entry.execution?.transcriptFile,
      });
      completion.resultText = captured?.trim() ? capFrozenResultText(captured) : null;
    } catch {
      completion.resultText = null;
    }
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
  ) => {
    if (
      entry.expectsCompletionMessage === true &&
      params.shouldEmitEndedHookForRun({
        entry,
        reason,
      })
    ) {
      await params.emitSubagentEndedHookForRun({
        entry,
        reason,
        sendFarewell: true,
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

  const suspendPendingFinalDelivery = (args: {
    runId: string;
    entry: SubagentRunRecord;
    reason: "retry-limit" | "expiry";
    error?: string;
  }) => {
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
      runId: args.runId,
      childSessionKey: args.entry.childSessionKey,
      deliveryStatus: "failed",
      deliveryError: getDeliveryLastError(args.entry) ?? args.reason,
    });
    safeMarkRequiredCompletionDeliveryBlocked({
      entry: args.entry,
      reason: getDeliveryLastError(args.entry) ?? args.reason,
    });
    logAnnounceGiveUp(args.entry, args.reason);
    params.persist();
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
      runId: giveUpParams.runId,
      childSessionKey: giveUpParams.entry.childSessionKey,
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
    await emitCompletionEndedHookIfNeeded(giveUpParams.entry, completionReason);
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
    params.persist();
    return true;
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
        void finalizeResumedAnnounceGiveUp({
          runId,
          entry,
          reason: "expiry",
        }).catch((error: unknown) => {
          defaultRuntime.log(
            `[warn] Subagent expiry finalize failed during deferred retry for run ${runId}: ${String(error)}`,
          );
          const current = params.runs.get(runId);
          if (!current || current.cleanupCompletedAt) {
            return;
          }
          current.cleanupHandled = false;
          params.persist();
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
  }) => {
    void removeInternalSessionEffectsTranscript(cleanupParams.entry.execution?.transcriptFile);
    if (cleanupParams.entry.spawnMode !== "session") {
      void retireSessionMcpRuntimeForSessionKey({
        sessionKey: cleanupParams.entry.childSessionKey,
        reason: "subagent-run-cleanup",
        onError: (error, sessionId) => {
          params.warn("failed to retire subagent bundle MCP runtime", {
            error: buildSafeLifecycleErrorMeta(error),
            sessionId,
            runId: maskRunId(cleanupParams.runId),
            childSessionKey: maskSessionKey(cleanupParams.entry.childSessionKey),
          });
        },
      });
    }
    if (cleanupParams.cleanup === "delete") {
      params.clearPendingLifecycleError(cleanupParams.runId);
      void params.notifyContextEngineSubagentEnded({
        childSessionKey: cleanupParams.entry.childSessionKey,
        reason: "deleted",
        agentDir: cleanupParams.entry.agentDir,
        workspaceDir: cleanupParams.entry.workspaceDir,
      });
      params.runs.delete(cleanupParams.runId);
      params.persist();
      retryDeferredCompletedAnnounces(cleanupParams.runId);
      return;
    }
    void params.notifyContextEngineSubagentEnded({
      childSessionKey: cleanupParams.entry.childSessionKey,
      reason: "completed",
      agentDir: cleanupParams.entry.agentDir,
      workspaceDir: cleanupParams.entry.workspaceDir,
    });
    cleanupParams.entry.cleanupCompletedAt = cleanupParams.completedAt;
    params.persist();
    retryDeferredCompletedAnnounces(cleanupParams.runId);
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
    options?: {
      skipAnnounce?: boolean;
      skipDeliveryStatus?: boolean;
    },
  ) => {
    const entry = params.runs.get(runId);
    if (!entry) {
      return;
    }
    if (entry.expectsCompletionMessage === false) {
      clearPendingFinalDelivery(entry);
      entry.wakeOnDescendantSettle = undefined;
      const shouldDeleteAttachments = cleanup === "delete" || !entry.retainAttachmentsOnKeep;
      if (shouldDeleteAttachments) {
        await safeRemoveAttachmentsDir(entry);
      }
      completeCleanupBookkeeping({
        runId,
        entry,
        cleanup,
        completedAt: Date.now(),
      });
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
          runId,
          childSessionKey: entry.childSessionKey,
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
      await emitCompletionEndedHookIfNeeded(entry, completionReason);
      const shouldDeleteAttachments = cleanup === "delete" || !entry.retainAttachmentsOnKeep;
      if (shouldDeleteAttachments) {
        await safeRemoveAttachmentsDir(entry);
      }
      if (cleanup === "delete") {
        completion.resultText = undefined;
        completion.capturedAt = undefined;
      }
      completeCleanupBookkeeping({
        runId,
        entry,
        cleanup,
        completedAt: Date.now(),
      });
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
        runId,
        childSessionKey: entry.childSessionKey,
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
      await emitCompletionEndedHookIfNeeded(entry, completionReason);
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
    if (typeof entry.delivery?.announcedAt === "number" || entry.delivery?.status === "delivered") {
      if (!beginSubagentCleanup(runId)) {
        return false;
      }
      void finalizeSubagentCleanup(runId, entry.cleanup, true, {
        skipAnnounce: true,
      }).catch((err: unknown) => {
        defaultRuntime.log(`[warn] subagent cleanup finalize failed (${runId}): ${String(err)}`);
        const current = params.runs.get(runId);
        if (!current || current.cleanupCompletedAt) {
          return;
        }
        current.cleanupHandled = false;
        params.persist();
      });
      return true;
    }
    if (!beginSubagentCleanup(runId)) {
      return false;
    }
    if (entry.expectsCompletionMessage === false) {
      void (async () => {
        if (entry.cleanup === "delete") {
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
        await finalizeSubagentCleanup(runId, entry.cleanup, true, {
          skipAnnounce: true,
          skipDeliveryStatus: true,
        });
      })().catch((err: unknown) => {
        defaultRuntime.log(`[warn] subagent cleanup finalize failed (${runId}): ${String(err)}`);
        const current = params.runs.get(runId);
        if (!current || current.cleanupCompletedAt) {
          return;
        }
        current.cleanupHandled = false;
        params.persist();
      });
      return true;
    }
    const pendingPayload = loadPendingFinalDeliveryPayload(entry);
    const requesterOrigin = normalizeDeliveryContext(pendingPayload.requesterOrigin);
    let latestDeliveryError = getDeliveryLastError(entry);
    const finalizeAnnounceCleanup = async (didAnnounce: boolean) => {
      const shouldCreditPriorDelivery =
        !didAnnounce && (await hasPriorRequesterDeliveryMirror(entry));
      if (shouldCreditPriorDelivery) {
        latestDeliveryError = undefined;
      }
      if (!didAnnounce && latestDeliveryError) {
        ensureDeliveryState(entry).lastError = latestDeliveryError;
      }
      void finalizeSubagentCleanup(
        runId,
        entry.cleanup,
        didAnnounce || shouldCreditPriorDelivery,
      ).catch((err: unknown) => {
        defaultRuntime.log(`[warn] subagent cleanup finalize failed (${runId}): ${String(err)}`);
        const current = params.runs.get(runId);
        if (!current || current.cleanupCompletedAt) {
          return;
        }
        current.cleanupHandled = false;
        params.persist();
      });
    };

    void params
      .runSubagentAnnounceFlow({
        childSessionKey: pendingPayload.childSessionKey,
        childRunId: pendingPayload.childRunId,
        requesterSessionKey: pendingPayload.requesterSessionKey,
        requesterOrigin,
        requesterDisplayKey: pendingPayload.requesterDisplayKey,
        task: pendingPayload.task,
        timeoutMs: params.subagentAnnounceTimeoutMs,
        cleanup: entry.cleanup,
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
        onDeliveryResult: (delivery) => {
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
      })
      .then((didAnnounce) => {
        void finalizeAnnounceCleanup(didAnnounce);
      })
      .catch((error: unknown) => {
        defaultRuntime.log(
          `[warn] Subagent announce flow failed during cleanup for run ${runId}: ${String(error)}`,
        );
        void finalizeAnnounceCleanup(false);
      });
    return true;
  };

  const completeSubagentRun = async (completeParams: {
    runId: string;
    endedAt?: number;
    outcome: SubagentRunOutcome;
    reason: SubagentLifecycleEndedReason;
    sendFarewell?: boolean;
    accountId?: string;
    triggerCleanup: boolean;
    startedAt?: number;
  }) => {
    params.clearPendingLifecycleError(completeParams.runId);
    const entry = params.runs.get(completeParams.runId);
    if (!entry) {
      return;
    }

    let mutated = false;
    if (
      completeParams.reason === SUBAGENT_ENDED_REASON_COMPLETE &&
      entry.suppressAnnounceReason === "killed" &&
      (entry.cleanupHandled || typeof entry.cleanupCompletedAt === "number")
    ) {
      entry.suppressAnnounceReason = undefined;
      entry.cleanupHandled = false;
      entry.cleanupCompletedAt = undefined;
      ensureDeliveryState(entry).announcedAt = undefined;
      mutated = true;
    }

    let endedAt = typeof completeParams.endedAt === "number" ? completeParams.endedAt : Date.now();
    let completionOutcome = completeParams.outcome;
    let completionReason = completeParams.reason;
    if (
      shouldPreservePublishedExplicitRunTimeout({
        entry,
      })
    ) {
      return;
    }

    const observedStartedAt =
      typeof completeParams.startedAt === "number" && Number.isFinite(completeParams.startedAt)
        ? completeParams.startedAt
        : undefined;
    if (observedStartedAt !== undefined && entry.startedAt !== observedStartedAt) {
      entry.startedAt = observedStartedAt;
      if (typeof entry.sessionStartedAt !== "number") {
        entry.sessionStartedAt = observedStartedAt;
      }
      mutated = true;
    }

    const expiredDeadlineMs = resolveExpiredExplicitRunDeadlineMs({
      entry,
      nextOutcome: completionOutcome,
      nextEndedAt: endedAt,
      observedStartedAt,
    });
    if (expiredDeadlineMs !== undefined) {
      endedAt = expiredDeadlineMs;
      completionOutcome = { status: "timeout" };
      completionReason = SUBAGENT_ENDED_REASON_COMPLETE;
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
    const outcome = withSubagentOutcomeTiming(completionOutcome, {
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

    if (await freezeRunResultAtCompletion(entry, outcome)) {
      mutated = true;
    }
    if (refreshPendingFinalDeliveryPayload(entry)) {
      mutated = true;
    }

    if (mutated) {
      params.persist();
    }
    safeFinalizeSubagentTaskRun({
      entry,
      outcome,
    });

    try {
      await persistSubagentSessionTiming(entry);
    } catch (err) {
      params.warn("failed to persist subagent session timing", {
        err,
        runId: entry.runId,
        childSessionKey: entry.childSessionKey,
      });
    }

    const suppressedForSteerRestart = params.suppressAnnounceForSteerRestart(entry);
    if (mutated && !suppressedForSteerRestart) {
      emitSessionLifecycleEvent({
        sessionKey: entry.childSessionKey,
        reason: "subagent-status",
        parentSessionKey: entry.requesterSessionKey,
        label: entry.label,
      });
    }
    const shouldEmitEndedHook =
      !suppressedForSteerRestart &&
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
      });
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

    startSubagentAnnounceCleanupFlow(completeParams.runId, entry);
  };

  return {
    clearScheduledResumeTimers,
    completeCleanupBookkeeping,
    completeSubagentRun,
    finalizeResumedAnnounceGiveUp,
    refreshFrozenResultFromSession,
    startSubagentAnnounceCleanupFlow,
  };
}
