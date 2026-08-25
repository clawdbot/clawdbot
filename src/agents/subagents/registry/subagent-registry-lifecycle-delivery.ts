import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { resolveSessionStorePathCore } from "../../../config/sessions/paths.js";
import {
  loadSessionEntryReadOnly,
  type SessionTranscriptRuntimeTarget,
} from "../../../config/sessions/session-accessor.js";
import { resolveSessionStorePathForScope } from "../../../config/sessions/session-store-path.js";
import { formatErrorMessage, readErrorName } from "../../../infra/errors.js";
import { resolveAgentIdFromSessionKey } from "../../../routing/session-key.js";
import { extractTextFromChatContent } from "../../../shared/chat-content.js";
import type { DetachedTaskFindResult } from "../../../tasks/detached-task-runtime-contract.js";
import {
  completeTaskRunByRunId,
  failTaskRunByRunId,
  setDetachedTaskDeliveryStatusByRunId,
} from "../../../tasks/detached-task-runtime.js";
import { resolveRequiredCompletionDeliveryFailureTerminalResult } from "../../../tasks/task-completion-contract.js";
import type { TaskDeliveryStatus } from "../../../tasks/task-registry.types.js";
import {
  buildAnnounceIdFromChildRun,
  buildAnnounceIdempotencyKey,
} from "../../announce-idempotency.js";
import { isSilentAgentReplyText } from "../../embedded-agent-runner/message-visibility.js";
import type { SubagentAnnounceDeliveryResult } from "../announce/subagent-announce-dispatch.js";
import type { SubagentRunOutcome } from "../announce/subagent-announce-output.js";
import { resolveSubagentCompletionResultText } from "../completion/subagent-completion-result.js";
import {
  clearDeliveryState,
  ensureCompletionState,
  ensureDeliveryState,
} from "./subagent-delivery-state.js";
import type { SubagentLifecycleEndedReason } from "./subagent-lifecycle-events.js";
import { resolveFinalizedSubagentTaskState } from "./subagent-registry-completion.js";
import { capFrozenResultText } from "./subagent-registry-helpers.js";
import type {
  SubagentLifecycleCommonContext,
  SubagentLifecycleOptions,
} from "./subagent-registry-lifecycle-context.js";
import type { PendingFinalDeliveryPayload, SubagentRunRecord } from "./subagent-registry.types.js";
import { compareSubagentRunGeneration } from "./subagent-run-generation.js";
import { hasSubagentRunEnded } from "./subagent-run-liveness.js";

const DELIVERY_MIRROR_HISTORY_MAX_CHARS = 128 * 1024;

export function buildSafeLifecycleErrorMeta(error: unknown): Record<string, string> {
  const message = formatErrorMessage(error);
  const name = readErrorName(error);
  return name ? { name, message } : { message };
}

export function maskLifecycleIdentifier(value: string, kind: "run" | "session"): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "unknown";
  }
  return kind === "session"
    ? `${trimmed.split(":").slice(0, 2).join(":") || "session"}:…`
    : trimmed.length <= 8
      ? "***"
      : `${sliceUtf16Safe(trimmed, 0, 4)}…${sliceUtf16Safe(trimmed, -4)}`;
}

export const formatAnnounceDeliveryError = (delivery: SubagentAnnounceDeliveryResult): string => {
  const errors = [
    delivery.error,
    delivery.reason,
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

export const recordAnnounceDeliveryResult = (
  entry: SubagentRunRecord,
  delivery: SubagentAnnounceDeliveryResult,
  runs?: ReadonlyMap<string, SubagentRunRecord>,
) => {
  const deliveryState = ensureDeliveryState(entry);
  if (typeof delivery.enqueuedAt === "number") {
    deliveryState.enqueuedAt ??= delivery.enqueuedAt;
  }
  if (!delivery.delivered && delivery.disposition !== "intentional_non_delivery") {
    if (
      delivery.reason === "steer_dropped" ||
      delivery.phases?.some((phase) => phase.reason === "steer_dropped")
    ) {
      deliveryState.lastDropReason = "steer_dropped";
    } else if (delivery.path === "none") {
      deliveryState.lastDropReason = "sink_unavailable";
    }
  }
  if (delivery.delivered) {
    const deliveredAt =
      typeof delivery.deliveredAt === "number" ? delivery.deliveredAt : Date.now();
    deliveryState.deliveredAt = deliveredAt;
    deliveryState.lastDropReason = undefined;
    const requesterTurnRunId = entry.requesterTurnRunId?.trim();
    if (
      delivery.path === "direct" &&
      delivery.requesterVisibleFinalDelivered &&
      requesterTurnRunId
    ) {
      const siblings = [...(runs?.values() ?? [])].filter(
        (sibling) =>
          sibling.requesterSessionKey === entry.requesterSessionKey &&
          sibling.requesterTurnRunId === requesterTurnRunId &&
          sibling.expectsCompletionMessage === true,
      );
      if (
        siblings.some((sibling) => sibling === entry) &&
        siblings.every(
          (sibling) =>
            sibling.execution.status === "terminal" &&
            hasSubagentRunEnded(sibling) &&
            (sibling === entry || sibling.delivery?.status === "delivered"),
        )
      ) {
        // Bind final evidence before yielding; direct delivery is fenced once a yield is frozen.
        deliveryState.requesterVisibleFinal = {
          requesterTurnRunId,
          batchRunIds: siblings.map((sibling) => sibling.runId).toSorted(),
        };
      }
    }
  }
  deliveryState.disposition =
    delivery.disposition ?? (delivery.delivered ? "delivered" : "retryable");
};

export const hasPriorRequesterDeliveryMirror = async (
  params: SubagentLifecycleOptions,
  entry: SubagentRunRecord,
): Promise<boolean> => {
  const completion = ensureCompletionState(entry);
  const expectedText = extractTextFromChatContent(completion.resultText, { joinWith: "" });
  if (entry.expectsCompletionMessage !== true || expectedText == null) {
    return false;
  }
  const mirrorNotBefore = entry.execution.startedAt ?? entry.createdAt;
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
  params: SubagentLifecycleOptions,
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

export const safeSetSubagentTaskDeliveryStatus = (
  params: SubagentLifecycleOptions,
  args: {
    entry: SubagentRunRecord;
    deliveryStatus: Extract<TaskDeliveryStatus, "pending" | "delivered" | "failed">;
    deliveryError?: string;
  },
) => {
  const target = resolveSubagentTaskTarget(params, args.entry);
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
      runId: maskLifecycleIdentifier(target.runId, "run"),
      childSessionKey: maskLifecycleIdentifier(target.sessionKey, "session"),
      deliveryStatus: args.deliveryStatus,
    });
  }
};

export const safeFinalizeSubagentTaskRun = (
  params: SubagentLifecycleOptions,
  args: {
    entry: SubagentRunRecord;
    outcome: SubagentRunOutcome;
    taskResolution?: DetachedTaskFindResult;
  },
): ReturnType<typeof completeTaskRunByRunId> => {
  const terminal = resolveFinalizedSubagentTaskState(args.entry);
  if (!terminal) {
    return [];
  }
  const target = resolveSubagentTaskTarget(params, args.entry, args.taskResolution);
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
      runId: maskLifecycleIdentifier(args.entry.runId, "run"),
      childSessionKey: maskLifecycleIdentifier(args.entry.childSessionKey, "session"),
      outcomeStatus: args.outcome.status,
    });
    return [];
  }
};

export const safeMarkRequiredCompletionDeliveryBlocked = (
  params: SubagentLifecycleOptions,
  args: {
    entry: SubagentRunRecord;
    reason?: string;
  },
) => {
  if (
    args.entry.expectsCompletionMessage !== true ||
    args.entry.execution.outcome?.status !== "ok"
  ) {
    return;
  }
  const endedAt = args.entry.execution.endedAt ?? Date.now();
  const terminalResult = resolveRequiredCompletionDeliveryFailureTerminalResult(args.reason);
  const target = resolveSubagentTaskTarget(params, args.entry);
  try {
    completeTaskRunByRunId({
      runId: target.runId,
      runtime: "subagent",
      sessionKey: target.sessionKey,
      endedAt,
      lastEventAt: Date.now(),
      progressSummary: resolveSubagentCompletionResultText(args.entry),
      terminalSummary: terminalResult.terminalSummary,
      terminalOutcome: terminalResult.terminalOutcome,
    });
  } catch (err) {
    params.warn("failed to mark subagent completion delivery blocked", {
      error: buildSafeLifecycleErrorMeta(err),
      runId: maskLifecycleIdentifier(args.entry.runId, "run"),
      childSessionKey: maskLifecycleIdentifier(args.entry.childSessionKey, "session"),
    });
  }
};

export const freezeRunResultAtCompletion = async (
  context: SubagentLifecycleCommonContext,
  entry: SubagentRunRecord,
  outcome: SubagentRunOutcome,
): Promise<boolean> => {
  const params = context.options;
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
    const transcriptTarget = entry.execution.transcriptTarget;
    const agentId =
      transcriptTarget?.agentId ?? resolveAgentIdFromSessionKey(entry.childSessionKey);
    const sessionKey = transcriptTarget?.sessionKey ?? entry.childSessionKey;
    const configuredStorePath = agentId
      ? (transcriptTarget?.storePath ??
        resolveSessionStorePathCore(params.getRuntimeConfig().session?.store, { agentId }))
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
      agentId && sessionId && storePath ? { agentId, sessionId, sessionKey, storePath } : undefined;
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
    context.newerGenerationOwnsSession(entry)
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

const listPendingCompletionRunsForSession = (
  params: SubagentLifecycleOptions,
  sessionKey: string,
): SubagentRunRecord[] => {
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
    if (typeof entry.execution.endedAt !== "number") {
      continue;
    }
    if (typeof entry.cleanupCompletedAt === "number") {
      continue;
    }
    // A paused row's result was deliberately cleared when it yielded; the text
    // now in its session belongs to whatever turn runs next, not to the paused
    // work. Refreezing it here would announce a stranger's output as this run's
    // completion once the row finally settles.
    if (entry.pauseReason === "sessions_yield") {
      continue;
    }
    out.push(entry);
  }
  return out;
};

export const refreshFrozenResultFromSession = async (
  context: SubagentLifecycleCommonContext,
  sessionKey: string,
): Promise<boolean> => {
  const params = context.options;
  const candidates = listPendingCompletionRunsForSession(params, sessionKey).filter(
    (entry) => entry.execution.outcome?.status !== "error",
  );
  const entry = candidates.toSorted(compareSubagentRunGeneration).at(-1);
  if (!entry || context.newerGenerationOwnsSession(entry)) {
    return false;
  }
  const generation = entry.generation;

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
  // Reply capture yields while registration can transfer session ownership.
  // Only the exact row and generation that started capture may commit its text.
  if (
    params.runs.get(entry.runId) !== entry ||
    entry.generation !== generation ||
    context.newerGenerationOwnsSession(entry)
  ) {
    return false;
  }

  const nextFrozen = capFrozenResultText(trimmed);
  const completion = ensureCompletionState(entry);
  if (completion.resultText === nextFrozen) {
    return false;
  }
  completion.resultText = nextFrozen;
  completion.capturedAt = Date.now();
  params.persist(entry.runId);
  return true;
};

export const emitCompletionEndedHookIfNeeded = async (
  params: SubagentLifecycleOptions,
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

export const clearSubagentPendingDelivery = (entry: SubagentRunRecord) => {
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

export const loadPendingFinalDeliveryPayload = (
  entry: SubagentRunRecord,
): PendingFinalDeliveryPayload => {
  return {
    requesterSessionKey: entry.delivery?.payload?.requesterSessionKey ?? entry.requesterSessionKey,
    requesterOrigin: entry.delivery?.payload?.requesterOrigin ?? entry.requesterOrigin,
    requesterDisplayKey: entry.delivery?.payload?.requesterDisplayKey ?? entry.requesterDisplayKey,
    childSessionKey: entry.delivery?.payload?.childSessionKey ?? entry.childSessionKey,
    childRunId: entry.delivery?.payload?.childRunId ?? entry.runId,
    task: entry.delivery?.payload?.task ?? entry.task,
    label: entry.delivery?.payload?.label ?? entry.label,
    startedAt: entry.delivery?.payload?.startedAt ?? entry.execution.startedAt,
    endedAt: entry.delivery?.payload?.endedAt ?? entry.execution.endedAt,
    outcome: entry.delivery?.payload?.outcome ?? entry.execution.outcome,
    expectsCompletionMessage:
      entry.delivery?.payload?.expectsCompletionMessage ?? entry.expectsCompletionMessage,
    spawnMode: entry.delivery?.payload?.spawnMode ?? entry.spawnMode,
    wakeOnDescendantSettle:
      entry.delivery?.payload?.wakeOnDescendantSettle ?? entry.wakeOnDescendantSettle,
    terminalReply: entry.delivery?.payload?.terminalReply ?? entry.completion?.terminalReply,
  };
};

export const markPendingFinalDelivery = (args: { entry: SubagentRunRecord; error?: string }) => {
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

export const refreshPendingFinalDeliveryPayload = (entry: SubagentRunRecord): boolean => {
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
    startedAt: entry.execution.startedAt,
    endedAt: entry.execution.endedAt,
    outcome: entry.execution.outcome,
    terminalReply: entry.completion?.terminalReply,
  };
  return true;
};
