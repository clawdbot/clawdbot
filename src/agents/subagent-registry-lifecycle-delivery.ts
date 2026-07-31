import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { resolveStorePath } from "../config/sessions/paths.js";
import {
  loadSessionEntryReadOnly,
  type SessionTranscriptRuntimeTarget,
} from "../config/sessions/session-accessor.js";
import { resolveSessionStorePathForScope } from "../config/sessions/session-store-path.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { extractTextFromChatContent } from "../shared/chat-content.js";
import type { DetachedTaskFindResult } from "../tasks/detached-task-runtime-contract.js";
import {
  completeTaskRunByRunId,
  failTaskRunByRunId,
  setDetachedTaskDeliveryStatusByRunId,
} from "../tasks/detached-task-runtime.js";
import { resolveRequiredCompletionDeliveryFailureTerminalResult } from "../tasks/task-completion-contract.js";
import {
  buildAnnounceIdFromChildRun,
  buildAnnounceIdempotencyKey,
} from "./announce-idempotency.js";
import { isSilentAgentReplyText } from "./embedded-agent-runner/message-visibility.js";
import type { SubagentAnnounceDeliveryResult } from "./subagent-announce-dispatch.js";
import type { SubagentRunOutcome } from "./subagent-announce-output.js";
import {
  clearDeliveryState,
  ensureCompletionState,
  ensureDeliveryState,
} from "./subagent-delivery-state.js";
import type { SubagentLifecycleEndedReason } from "./subagent-lifecycle-events.js";
import { resolveFinalizedSubagentTaskState } from "./subagent-registry-completion.js";
import { capFrozenResultText } from "./subagent-registry-helpers.js";
import type { createSubagentRegistryLifecycleCommon } from "./subagent-registry-lifecycle-common.js";
import type {
  SubagentRegistryLifecycleParams,
  SubagentRegistryLifecycleState,
} from "./subagent-registry-lifecycle-contracts.js";
import type { PendingFinalDeliveryPayload, SubagentRunRecord } from "./subagent-registry.types.js";

const DELIVERY_MIRROR_HISTORY_MAX_CHARS = 128 * 1024;

export function createSubagentRegistryLifecycleDelivery(
  params: SubagentRegistryLifecycleParams,
  _state: SubagentRegistryLifecycleState,
  common: ReturnType<typeof createSubagentRegistryLifecycleCommon>,
) {
  const { newerGenerationOwnsSession, buildSafeLifecycleErrorMeta, maskRunId, maskSessionKey } =
    common;

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
      const transcriptTarget = entry.execution?.transcriptTarget;
      const agentId =
        transcriptTarget?.agentId ?? resolveAgentIdFromSessionKey(entry.childSessionKey);
      const sessionKey = transcriptTarget?.sessionKey ?? entry.childSessionKey;
      const configuredStorePath = agentId
        ? (transcriptTarget?.storePath ??
          resolveStorePath(params.getRuntimeConfig().session?.store, { agentId }))
        : undefined;
      const storePath = configuredStorePath
        ? resolveSessionStorePathForScope({
            agentId,
            sessionKey,
            storePath: configuredStorePath,
          })
        : undefined;
      const sessionId =
        transcriptTarget?.sessionId ??
        (agentId && storePath
          ? loadSessionEntryReadOnly({ agentId, sessionKey, storePath })?.sessionId
          : undefined);
      const sessionTarget: SessionTranscriptRuntimeTarget | undefined =
        agentId && sessionId && storePath
          ? { agentId, sessionId, sessionKey, storePath }
          : undefined;
      const captured = await params.captureSubagentCompletionReply(entry.childSessionKey, {
        waitForReply: entry.expectsCompletionMessage === true,
        outcome,
        ...(sessionTarget ? { sessionTarget } : {}),
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
    if (!trimmed || isSilentAgentReplyText(trimmed)) {
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
      params.persist(...candidates.map((entry) => entry.runId));
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

  return {
    clearPendingFinalDelivery,
    emitCompletionEndedHookIfNeeded,
    formatAnnounceDeliveryError,
    freezeRunResultAtCompletion,
    hasPriorRequesterDeliveryMirror,
    loadPendingFinalDeliveryPayload,
    markPendingFinalDelivery,
    recordAnnounceDeliveryResult,
    refreshFrozenResultFromSession,
    refreshPendingFinalDeliveryPayload,
    safeFinalizeSubagentTaskRun,
    safeMarkRequiredCompletionDeliveryBlocked,
    safeSetSubagentTaskDeliveryStatus,
  };
}
