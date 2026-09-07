/**
 * Manages active embedded-agent run handles, queues, aborts, and waiters.
 */
import fs from "node:fs";
import path from "node:path";
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { createMessageInjectionAuthority } from "../../auto-reply/reply/message-injection-authority.js";
import type { ReplyMessageInjectionOptions } from "../../auto-reply/reply/reply-run-registry.contracts.js";
import {
  abortActiveReplyRuns,
  abortReplyRunBySessionId,
  expireStaleReplyRunBySessionId,
  forceClearReplyOperation,
  hasCommittedReplyOperationOutcome,
  hasReplyOperationExecutionStarted,
  isReplyRunEvidenceStaleBySessionId,
  isReplyRunActiveForSessionId,
  isReplyRunAbortableForCompaction,
  listActiveReplyRunSessionIds,
  resolveActiveReplyOperationForSessionId,
  resolveActiveReplyRunSessionId,
  resolveReplyBackendQueueMessageMismatch,
  supersedeReplyRunByRunId,
  type ReplyOperation,
  waitForReplyOperationOwnerSettlement,
  waitForReplyRunEndBySessionId,
} from "../../auto-reply/reply/reply-run-registry.js";
import { getAttachedBackend } from "../../auto-reply/reply/reply-run-registry.state.js";
import { getRuntimeConfig } from "../../config/io.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { loadSessionEntry, updateSessionEntry } from "../../config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import {
  getAgentEventLifecycleGeneration,
  isAgentEventLifecycleGenerationCurrent,
} from "../../infra/agent-events.js";
import {
  getActiveAgentRunDelegatedAuthority,
  getAgentRunContext,
} from "../../infra/agent-run-registry.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  getDiagnosticSessionActivitySnapshot,
  isDiagnosticEmbeddedRunOwnerClosed,
  markDiagnosticEmbeddedRunEnded,
  markDiagnosticEmbeddedRunStarted,
  markDiagnosticRunProgress,
  resolveRunStaleThresholdMs,
} from "../../logging/diagnostic-run-activity.js";
import { logMessageQueuedWithBacklogPolicy } from "../../logging/diagnostic-runtime.js";
import { diagnosticLogger as diag, logSessionStateChange } from "../../logging/diagnostic.js";
import { hasPromptImageInput } from "../../media/prompt-image-input.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { QuestionAnswerUnconfirmedError } from "../harness/gateway-question-dispatch.js";
import { resolveSessionPlacementForcedTerminalSettlement } from "../session-placement-forced-terminal-settlement.js";
import { getGatewayToolCallerIdentity } from "../tools/gateway-caller-context.js";
import {
  ACTIVE_EMBEDDED_RUNS,
  ACTIVE_EMBEDDED_RUNS_BY_RUN_ID,
  ACTIVE_EMBEDDED_RUN_REGISTRATIONS,
  ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_FILE,
  ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY,
  ACTIVE_EMBEDDED_RUN_SNAPSHOTS,
  ABANDONED_EMBEDDED_RUNS_BY_SESSION_ID,
  ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_FILE,
  ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_KEY,
  EMBEDDED_RUN_COMPLETION_CLAIMS,
  EMBEDDED_RUN_FORCED_TERMINAL_SETTLEMENTS,
  EMBEDDED_RUN_WAITERS,
  RETAINED_EMBEDDED_RUN_ABORTABILITY_RUN_IDS,
  setActiveEmbeddedRunLifecycleGeneration,
  resolveActiveEmbeddedRunRecoveryBlocker,
  type ActiveEmbeddedRunSnapshot,
  type AbandonedEmbeddedRun,
  type EmbeddedAgentQueueHandle,
  type EmbeddedAgentQueueMessageOptions,
  type EmbeddedRunCompletionClaim,
  type EmbeddedRunCompletionRegistration,
  type EmbeddedRunRegistration,
  type EmbeddedRunWaiter,
} from "./run-state.js";

export type { EmbeddedAgentQueueHandle, EmbeddedAgentQueueMessageOptions } from "./run-state.js";

type EmbeddedAgentQueueFailureReason =
  | "no_active_run"
  | "not_streaming"
  | "stale_run"
  | "compacting"
  | "tool_authority_mismatch"
  | "image_input_unsupported"
  | "source_reply_delivery_mode_mismatch"
  | "task_suggestion_delivery_mode_mismatch"
  | "transcript_commit_wait_unsupported"
  | "guarded_injection_unsupported"
  | "runtime_rejected";

export type EmbeddedRunTimeoutRecoveryMarker = {
  sessionId: string;
  recoveryToken: symbol;
};

export type EmbeddedAgentQueueMessageOutcome =
  | {
      queued: true;
      sessionId: string;
      target: "embedded_run" | "reply_run";
      gatewayHealth: "live";
      /** Input is non-replayable, but its delivery or commitment could not be confirmed. */
      transcriptCommit?: "unconfirmed";
      errorMessage?: string;
      deliveredAtMs?: number;
      enqueuedAtMs?: number;
    }
  | {
      queued: false;
      sessionId: string;
      reason: EmbeddedAgentQueueFailureReason;
      gatewayHealth: "live";
      errorMessage?: string;
    };

type PreparedEmbeddedAgentQueueMessage =
  | {
      kind: "complete";
      outcome: EmbeddedAgentQueueMessageOutcome;
      pendingInput?: Pick<
        EmbeddedAgentQueueHandle,
        "claimPendingUserInputAnswer" | "cancelPendingUserInput"
      >;
    }
  | {
      kind: "embedded_run";
      queueMessage: EmbeddedAgentQueueHandle["queueMessage"];
      options: EmbeddedAgentQueueMessageOptions;
    };

function createQueueFailureOutcome(
  sessionId: string,
  reason: EmbeddedAgentQueueFailureReason,
  errorMessage?: string,
): EmbeddedAgentQueueMessageOutcome {
  return {
    queued: false,
    sessionId,
    reason,
    gatewayHealth: "live",
    ...(errorMessage ? { errorMessage } : {}),
  };
}

export function formatEmbeddedAgentQueueFailureSummary(
  outcome: EmbeddedAgentQueueMessageOutcome,
): string | undefined {
  if (outcome.queued) {
    return undefined;
  }
  const errorPart = outcome.errorMessage ? ` error=${outcome.errorMessage}` : "";
  return `queue_message_failed reason=${outcome.reason} sessionId=${outcome.sessionId} gatewayHealth=${outcome.gatewayHealth}${errorPart}`;
}
function setActiveRunSessionKey(sessionKey: string | undefined, sessionId: string): void {
  const normalizedSessionKey = sessionKey?.trim();
  if (!normalizedSessionKey) {
    return;
  }
  ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY.set(normalizedSessionKey, sessionId);
}

function clearActiveRunSessionKeys(sessionId: string, sessionKey?: string): void {
  const normalizedSessionKey = sessionKey?.trim();
  if (normalizedSessionKey) {
    if (ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY.get(normalizedSessionKey) === sessionId) {
      ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY.delete(normalizedSessionKey);
    }
    return;
  }
  for (const [key, activeSessionId] of ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY) {
    if (activeSessionId === sessionId) {
      ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY.delete(key);
    }
  }
}

function normalizeSessionFileRegistryKey(sessionFile: string | undefined): string | undefined {
  const normalized = sessionFile?.trim();
  if (!normalized) {
    return undefined;
  }
  if (
    normalized.startsWith("agent:") ||
    normalized.startsWith("sqlite:") ||
    normalized.startsWith("in-memory:")
  ) {
    return normalized;
  }
  const resolved = path.resolve(normalized);
  const parent = path.dirname(resolved);
  try {
    // Canonicalize only the parent so a registry key stays stable when the
    // transcript file itself is created or removed during the active run.
    // Artifact-file symlinks are not runtime session identity after SQLite migration.
    return path.join(fs.realpathSync(parent), path.basename(resolved));
  } catch {
    return resolved;
  }
}

function setActiveRunSessionFile(sessionFile: string | undefined, sessionId: string): void {
  const normalizedSessionFile = normalizeSessionFileRegistryKey(sessionFile);
  if (!normalizedSessionFile) {
    return;
  }
  ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_FILE.set(normalizedSessionFile, sessionId);
}

function clearEmbeddedRunAbandonmentBySessionId(sessionId: string): void {
  const abandonedRun = ABANDONED_EMBEDDED_RUNS_BY_SESSION_ID.get(sessionId);
  if (!abandonedRun) {
    return;
  }
  ABANDONED_EMBEDDED_RUNS_BY_SESSION_ID.delete(sessionId);
  const normalizedSessionKey = abandonedRun.sessionKey?.trim();
  if (
    normalizedSessionKey &&
    ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_KEY.get(normalizedSessionKey) === sessionId
  ) {
    ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_KEY.delete(normalizedSessionKey);
  }
  const normalizedSessionFile = normalizeSessionFileRegistryKey(abandonedRun.sessionFile);
  if (normalizedSessionFile) {
    const sessionFileKey = normalizedSessionFile;
    if (ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_FILE.get(sessionFileKey) === sessionId) {
      ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_FILE.delete(sessionFileKey);
    }
  }
}

function clearEmbeddedRunAbandonmentBySessionKey(sessionKey: string | undefined): void {
  const normalizedSessionKey = sessionKey?.trim();
  if (!normalizedSessionKey) {
    return;
  }
  const sessionId = ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_KEY.get(normalizedSessionKey);
  if (sessionId) {
    clearEmbeddedRunAbandonmentBySessionId(sessionId);
  }
}

function clearEmbeddedRunAbandonmentBySessionFile(sessionFile: string | undefined): void {
  const normalizedSessionFile = normalizeSessionFileRegistryKey(sessionFile);
  if (!normalizedSessionFile) {
    return;
  }
  const sessionFileKey = normalizedSessionFile;
  const sessionId = ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_FILE.get(sessionFileKey);
  if (sessionId) {
    clearEmbeddedRunAbandonmentBySessionId(sessionId);
  }
}

function clearEmbeddedRunAbandonment(params: {
  sessionId?: string;
  sessionKey?: string;
  sessionFile?: string;
}): void {
  const normalizedSessionId = params.sessionId?.trim();
  if (normalizedSessionId) {
    clearEmbeddedRunAbandonmentBySessionId(normalizedSessionId);
  }
  clearEmbeddedRunAbandonmentBySessionKey(params.sessionKey);
  clearEmbeddedRunAbandonmentBySessionFile(params.sessionFile);
}

function markEmbeddedRunAbandoned(params: {
  sessionId: string;
  runId?: string;
  sessionKey?: string;
  sessionFile?: string;
  reason: AbandonedEmbeddedRun["reason"];
}): void {
  const sessionId = params.sessionId.trim();
  if (!sessionId) {
    return;
  }
  clearEmbeddedRunAbandonment({
    sessionId,
    sessionKey: params.sessionKey,
    sessionFile: params.sessionFile,
  });
  const normalizedSessionFile = normalizeSessionFileRegistryKey(params.sessionFile);
  const abandonedRun: AbandonedEmbeddedRun = {
    sessionId,
    ...(params.runId?.trim() ? { runId: params.runId.trim() } : {}),
    abandonedAtMs: Date.now(),
    reason: params.reason,
    ...(params.sessionKey?.trim() ? { sessionKey: params.sessionKey.trim() } : {}),
    ...(normalizedSessionFile ? { sessionFile: normalizedSessionFile } : {}),
  };
  ABANDONED_EMBEDDED_RUNS_BY_SESSION_ID.set(sessionId, abandonedRun);
  if (abandonedRun.sessionKey) {
    ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_KEY.set(abandonedRun.sessionKey, sessionId);
  }
  if (abandonedRun.sessionFile) {
    ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_FILE.set(abandonedRun.sessionFile, sessionId);
  }
}

export function markActiveEmbeddedRunAbandoned(params: {
  sessionId: string;
  handle: EmbeddedAgentQueueHandle;
  sessionKey?: string;
  sessionFile?: string;
  reason: AbandonedEmbeddedRun["reason"];
}): boolean {
  const sessionId = params.sessionId.trim();
  if (!sessionId || ACTIVE_EMBEDDED_RUNS.get(sessionId) !== params.handle) {
    return false;
  }
  markEmbeddedRunAbandoned({ ...params, runId: params.handle.runId });
  return true;
}

export function resolveEmbeddedRunAbandonment(params: {
  sessionId?: string;
  sessionKey?: string;
  sessionFile?: string;
}): AbandonedEmbeddedRun["reason"] | undefined {
  const normalizedSessionId = params.sessionId?.trim();
  const normalizedSessionKey = params.sessionKey?.trim();
  const normalizedSessionFile = normalizeSessionFileRegistryKey(params.sessionFile);
  const sessionIds = [
    normalizedSessionId,
    normalizedSessionKey
      ? ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_KEY.get(normalizedSessionKey)
      : undefined,
    normalizedSessionFile
      ? ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_FILE.get(normalizedSessionFile)
      : undefined,
  ];
  const reasons = new Set(
    sessionIds.map((sessionId) =>
      sessionId ? ABANDONED_EMBEDDED_RUNS_BY_SESSION_ID.get(sessionId)?.reason : undefined,
    ),
  );
  return reasons.has("timeout")
    ? "timeout"
    : reasons.has("recovering_timeout")
      ? "recovering_timeout"
      : undefined;
}

/**
 * Temporarily releases terminal-timeout delivery suppression while a timed-out
 * attempt is performing an eligible compaction-and-retry recovery.
 */
export function markEmbeddedRunRecoveringTimeout(params: {
  sessionId: string;
  runId?: string;
}): EmbeddedRunTimeoutRecoveryMarker | undefined {
  const abandoned = ABANDONED_EMBEDDED_RUNS_BY_SESSION_ID.get(params.sessionId.trim());
  if (
    !abandoned ||
    abandoned.reason !== "timeout" ||
    (abandoned.runId && abandoned.runId !== params.runId?.trim())
  ) {
    return undefined;
  }
  const recoveryToken = Symbol("openclaw.embeddedRunTimeoutRecovery");
  abandoned.reason = "recovering_timeout";
  abandoned.recoveryToken = recoveryToken;
  return { sessionId: abandoned.sessionId, recoveryToken };
}

/** Restores terminal-timeout suppression when recovery cannot continue. */
export function restoreEmbeddedRunTimeoutAbandonment(
  marker: EmbeddedRunTimeoutRecoveryMarker,
): boolean {
  const abandoned = ABANDONED_EMBEDDED_RUNS_BY_SESSION_ID.get(marker.sessionId.trim());
  if (
    !abandoned ||
    abandoned.reason !== "recovering_timeout" ||
    abandoned.recoveryToken !== marker.recoveryToken
  ) {
    return false;
  }
  abandoned.reason = "timeout";
  delete abandoned.recoveryToken;
  return true;
}

function clearActiveRunSessionFiles(sessionId: string, sessionFile?: string): void {
  const normalizedSessionFile = normalizeSessionFileRegistryKey(sessionFile);
  if (normalizedSessionFile) {
    if (ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_FILE.get(normalizedSessionFile) === sessionId) {
      ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_FILE.delete(normalizedSessionFile);
    }
  }
  // Always sweep every alias because callers may clear without the same
  // compatibility token used when the active run was registered.
  for (const [sessionFileKey, activeSessionId] of ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_FILE) {
    if (activeSessionId === sessionId) {
      ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_FILE.delete(sessionFileKey);
    }
  }
}

/**
 * @deprecated Prefer queueEmbeddedAgentMessageWithOutcomeAsync when callers need to
 * know whether steering was accepted. This sync helper is fire-and-forget after
 * initial eligibility and only logs later runtime rejection.
 */
export function queueEmbeddedAgentMessageWithOutcome(
  sessionId: string,
  text: string,
  options?: ReplyMessageInjectionOptions,
): EmbeddedAgentQueueMessageOutcome {
  const prepared = prepareEmbeddedAgentQueueMessage(sessionId, options);
  if (prepared.kind === "complete") {
    return prepared.outcome;
  }
  logActiveRunMessageAccepted(sessionId);
  void prepared.queueMessage(text, prepared.options).catch((err: unknown) => {
    const message = `queue message rejected after enqueue: sessionId=${sessionId} err=${formatErrorMessage(err)}`;
    if (err instanceof QuestionAnswerUnconfirmedError) {
      diag.warn(message);
    } else {
      diag.debug(message);
    }
  });
  return {
    queued: true,
    sessionId,
    target: "embedded_run",
    gatewayHealth: "live",
    enqueuedAtMs: Date.now(),
  };
}

function logActiveRunMessageAccepted(sessionId: string): void {
  // Active-run steering is consumed by the current turn, not queued as another
  // turn for the single idle transition to drain. Keep the event and activity.
  logMessageQueuedWithBacklogPolicy(
    {
      sessionId,
      source: "embedded-agent-runner",
    },
    false,
  );
}

function resolveEmbeddedInjection(
  sessionId: string,
  handle: EmbeddedAgentQueueHandle,
  sourceCanInject?: () => boolean,
):
  | Pick<
      EmbeddedAgentQueueHandle,
      "queueMessage" | "claimPendingUserInputAnswer" | "cancelPendingUserInput"
    >
  | undefined {
  try {
    const guarded = handle.messageInjectionV2;
    if (guarded?.version === 2) {
      const registration = ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle);
      const operation = resolveActiveReplyOperationForSessionId(sessionId);
      const ownedOperation =
        operation && getAttachedBackend(operation) === handle ? operation : undefined;
      const assertCurrent = createMessageInjectionAuthority(() => {
        if (sourceCanInject && !sourceCanInject()) {
          return false;
        }
        registration?.toolAuthority?.assertActive();
        return (
          ACTIVE_EMBEDDED_RUNS.get(sessionId) === handle &&
          ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle) === registration &&
          (!ownedOperation ||
            (resolveActiveReplyOperationForSessionId(sessionId) === ownedOperation &&
              getAttachedBackend(ownedOperation) === handle))
        );
      });
      const authorityKind = sourceCanInject ? "source-bound" : "run";
      return guarded.isAvailable()
        ? {
            queueMessage: (text, options) =>
              guarded.queueMessage(text, options, assertCurrent, authorityKind),
            claimPendingUserInputAnswer: guarded.claimPendingUserInputAnswer
              ? (text, options) =>
                  guarded.claimPendingUserInputAnswer!(text, options, assertCurrent, authorityKind)
              : undefined,
            cancelPendingUserInput: guarded.cancelPendingUserInput
              ? (resolvedBy) =>
                  guarded.cancelPendingUserInput!(resolvedBy, assertCurrent, authorityKind)
              : undefined,
          }
        : undefined;
    }
    // Shipped v2026.8.1 sinks have no source-lifetime enforcement contract.
    if (sourceCanInject) {
      return undefined;
    }
    const injection = handle.messageInjection;
    if (injection) {
      return injection.isAvailable()
        ? {
            queueMessage: (text, options) => injection.queueMessage(text, options),
            claimPendingUserInputAnswer: handle.claimPendingUserInputAnswer?.bind(handle),
            cancelPendingUserInput: handle.cancelPendingUserInput?.bind(handle),
          }
        : undefined;
    }
    // Legacy handles predate explicit injection capability. Preserve their
    // shipped eligibility probe while modern backends use messageInjection.
    const isAvailable = handle.isStopped ? !handle.isStopped() : handle.isStreaming();
    return isAvailable ? handle : undefined;
  } catch (err) {
    diag.warn(
      `queue message failed: sessionId=${sessionId} reason=injectable_check_failed err=${String(err)}`,
    );
    return undefined;
  }
}

function isEmbeddedRunHandleAbortable(
  sessionId: string,
  handle: EmbeddedAgentQueueHandle,
): boolean {
  try {
    return handle.isAbortable?.() !== false;
  } catch (err) {
    diag.warn(
      `abort failed: sessionId=${sessionId} reason=abortable_check_failed err=${String(err)}`,
    );
    return false;
  }
}

function isEmbeddedRunHandleSupersedable(runId: string, handle: EmbeddedAgentQueueHandle): boolean {
  if (!isEmbeddedRunHandleAbortable(runId, handle)) {
    return false;
  }
  try {
    return handle.isStopped?.() !== true && handle.isAborted?.() !== true;
  } catch (err) {
    diag.warn(`supersede failed: runId=${runId} reason=lifecycle_check_failed err=${String(err)}`);
    return false;
  }
}

export function isEmbeddedAgentRunAbortableForRunId(runId: string): boolean {
  const normalizedRunId = runId.trim();
  if (!normalizedRunId) {
    return true;
  }
  const handle = ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.get(normalizedRunId);
  return handle ? isEmbeddedRunHandleAbortable(normalizedRunId, handle) : true;
}

/** Cancels one exact process-local run after recording its superseded terminal owner. */
export function supersedeEmbeddedAgentRunByRunId(runId: string, beforeCancel: () => void): boolean {
  const normalizedRunId = runId.trim();
  if (!normalizedRunId) {
    return false;
  }
  const handle = ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.get(normalizedRunId);
  if (handle) {
    if (!isEmbeddedRunHandleSupersedable(normalizedRunId, handle)) {
      return false;
    }
    beforeCancel();
    if (handle.cancel) {
      handle.cancel("superseded");
    } else {
      handle.abort();
    }
    return true;
  }
  return supersedeReplyRunByRunId(normalizedRunId, beforeCancel);
}

export function clearEmbeddedAgentRunAbortabilityForRunId(runId: string): void {
  const normalizedRunId = runId.trim();
  if (normalizedRunId) {
    ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.delete(normalizedRunId);
    RETAINED_EMBEDDED_RUN_ABORTABILITY_RUN_IDS.delete(normalizedRunId);
  }
}

export function retainEmbeddedAgentRunAbortabilityForRunId(runId: string): void {
  const normalizedRunId = runId.trim();
  if (normalizedRunId) {
    RETAINED_EMBEDDED_RUN_ABORTABILITY_RUN_IDS.add(normalizedRunId);
  }
}

function clearEmbeddedRunAbortability(
  handle: EmbeddedAgentQueueHandle,
  opts?: { retainFinalizing?: boolean },
): void {
  ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle)?.humanInputWaits?.clear();
  if (!handle.runId || ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.get(handle.runId) !== handle) {
    return;
  }
  if (
    opts?.retainFinalizing &&
    RETAINED_EMBEDDED_RUN_ABORTABILITY_RUN_IDS.has(handle.runId) &&
    !isEmbeddedRunHandleAbortable(handle.runId, handle)
  ) {
    return;
  }
  ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.delete(handle.runId);
}

export async function queueEmbeddedAgentMessageWithOutcomeAsync(
  sessionId: string,
  text: string,
  options?: ReplyMessageInjectionOptions,
): Promise<EmbeddedAgentQueueMessageOutcome> {
  return queueEmbeddedAgentMessageAsync(sessionId, text, options);
}

/** Source-bound callers require an explicitly guarded backend, never a V1 fallback. */
export async function queueGuardedEmbeddedAgentMessageWithOutcomeAsync(
  sessionId: string,
  text: string,
  options: ReplyMessageInjectionOptions | undefined,
  canInject: () => boolean,
): Promise<EmbeddedAgentQueueMessageOutcome> {
  return queueEmbeddedAgentMessageAsync(sessionId, text, options, canInject);
}

async function queueEmbeddedAgentMessageAsync(
  sessionId: string,
  text: string,
  options?: ReplyMessageInjectionOptions,
  canInject?: () => boolean,
): Promise<EmbeddedAgentQueueMessageOutcome> {
  const prepared = prepareEmbeddedAgentQueueMessage(sessionId, options, canInject);
  const enqueuedAtMs = Date.now();
  const unconfirmed = (errorMessage: string): EmbeddedAgentQueueMessageOutcome => {
    diag.warn(
      `queue message accepted without confirmation: sessionId=${sessionId} err=${errorMessage}`,
    );
    logActiveRunMessageAccepted(sessionId);
    return {
      queued: true,
      sessionId,
      target: "embedded_run",
      gatewayHealth: "live",
      transcriptCommit: "unconfirmed",
      errorMessage,
      enqueuedAtMs,
    };
  };
  const failed = (error: unknown): EmbeddedAgentQueueMessageOutcome => {
    if (error instanceof QuestionAnswerUnconfirmedError) {
      throw error;
    }
    const errorMessage = formatErrorMessage(error);
    diag.debug(`queue message rejected: sessionId=${sessionId} err=${errorMessage}`);
    return createQueueFailureOutcome(sessionId, "runtime_rejected", errorMessage);
  };
  if (prepared.kind === "complete") {
    if (
      !prepared.outcome.queued &&
      (prepared.outcome.reason === "tool_authority_mismatch" ||
        prepared.outcome.reason === "image_input_unsupported") &&
      options?.isInboundUserMessage === true &&
      hasPromptImageInput(options) &&
      prepared.pendingInput
    ) {
      try {
        await prepared.pendingInput.cancelPendingUserInput?.("image-reply");
      } catch (err) {
        diag.warn(
          `failed to cancel pending user input before queued image fallback: sessionId=${sessionId} err=${formatErrorMessage(err)}`,
        );
      }
    }
    if (
      !prepared.outcome.queued &&
      prepared.outcome.reason === "tool_authority_mismatch" &&
      options?.isInboundUserMessage === true &&
      !hasPromptImageInput(options) &&
      prepared.pendingInput
    ) {
      const claimPendingUserInputAnswer = prepared.pendingInput.claimPendingUserInputAnswer;
      if (claimPendingUserInputAnswer) {
        try {
          if (await claimPendingUserInputAnswer(text, options)) {
            options.onQueueAccepted?.(true);
            logActiveRunMessageAccepted(sessionId);
            return {
              queued: true,
              sessionId,
              target: "embedded_run",
              gatewayHealth: "live",
              enqueuedAtMs: Date.now(),
            };
          }
        } catch (err) {
          return failed(err);
        }
      }
    }
    return prepared.outcome;
  }
  try {
    const queueResult = await prepared.queueMessage(text, prepared.options);
    if (queueResult?.transcriptCommit === "unconfirmed") {
      return unconfirmed(queueResult.errorMessage);
    }
    const deliveredAtMs = options?.waitForTranscriptCommit ? Date.now() : undefined;
    logActiveRunMessageAccepted(sessionId);
    return {
      queued: true,
      sessionId,
      target: "embedded_run",
      gatewayHealth: "live",
      ...(deliveredAtMs !== undefined ? { deliveredAtMs } : {}),
      enqueuedAtMs,
    };
  } catch (err) {
    return failed(err);
  }
}

function prepareEmbeddedAgentQueueMessage(
  sessionId: string,
  options?: ReplyMessageInjectionOptions,
  sourceCanInject?: () => boolean,
): PreparedEmbeddedAgentQueueMessage {
  const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
  if (!handle) {
    // A stale reply-backed run must produce the same closed reason as the
    // embedded gate so announce delivery falls through to direct instead of
    // reading the wedged op as active and dropping the handoff.
    if (isReplyRunEvidenceStaleBySessionId(sessionId)) {
      diag.debug(`queue message failed: sessionId=${sessionId} reason=stale_run`);
      return { kind: "complete", outcome: createQueueFailureOutcome(sessionId, "stale_run") };
    }
    if (options?.waitForTranscriptCommit === true) {
      diag.debug(
        `queue message failed: sessionId=${sessionId} reason=transcript_commit_wait_unsupported`,
      );
      return {
        kind: "complete",
        outcome: createQueueFailureOutcome(sessionId, "transcript_commit_wait_unsupported"),
      };
    }
    return { kind: "complete", outcome: createQueueFailureOutcome(sessionId, "no_active_run") };
  }
  const registration = ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle);
  if (sourceCanInject && handle.messageInjectionV2?.version !== 2) {
    return {
      kind: "complete",
      outcome: createQueueFailureOutcome(sessionId, "guarded_injection_unsupported"),
    };
  }
  const injection = resolveEmbeddedInjection(sessionId, handle, sourceCanInject);
  if (!injection) {
    diag.debug(`queue message failed: sessionId=${sessionId} reason=not_streaming`);
    return { kind: "complete", outcome: createQueueFailureOutcome(sessionId, "not_streaming") };
  }
  const recoveryBlocker = resolveActiveEmbeddedRunRecoveryBlocker(sessionId, handle);
  if (ACTIVE_EMBEDDED_RUNS.get(sessionId) !== handle) {
    return { kind: "complete", outcome: createQueueFailureOutcome(sessionId, "no_active_run") };
  }
  const activity = getDiagnosticSessionActivitySnapshot({ sessionId });
  if (
    typeof activity.lastProgressAgeMs === "number" &&
    activity.lastProgressAgeMs > resolveRunStaleThresholdMs(activity) &&
    !recoveryBlocker
  ) {
    diag.debug(`queue message failed: sessionId=${sessionId} reason=stale_run`);
    return { kind: "complete", outcome: createQueueFailureOutcome(sessionId, "stale_run") };
  }
  if (handle.isCompacting()) {
    diag.debug(`queue message failed: sessionId=${sessionId} reason=compacting`);
    return { kind: "complete", outcome: createQueueFailureOutcome(sessionId, "compacting") };
  }
  if (options?.waitForTranscriptCommit === true && handle.supportsTranscriptCommitWait !== true) {
    diag.debug(
      `queue message failed: sessionId=${sessionId} reason=transcript_commit_wait_unsupported`,
    );
    return {
      kind: "complete",
      outcome: createQueueFailureOutcome(sessionId, "transcript_commit_wait_unsupported"),
    };
  }
  const operation = resolveActiveReplyOperationForSessionId(sessionId);
  const ownedOperation =
    operation && getAttachedBackend(operation) === handle ? operation : undefined;
  const { toolAuthorityOverlay, ...backendOptions } = options ?? { steeringMode: "all" as const };
  if (toolAuthorityOverlay) {
    // An overlay is caller evidence; a supplied raw hash cannot override it.
    try {
      backendOptions.toolAuthorityFingerprint = registration?.toolAuthority
        ? registration.toolAuthority.project(toolAuthorityOverlay)
        : ownedOperation?.projectToolAuthorityFingerprint(toolAuthorityOverlay);
    } catch {
      backendOptions.toolAuthorityFingerprint = undefined;
    }
    if (!backendOptions.toolAuthorityFingerprint) {
      return {
        kind: "complete",
        outcome: createQueueFailureOutcome(sessionId, "tool_authority_mismatch"),
      };
    }
  }
  const deliveryModeMismatch = resolveReplyBackendQueueMessageMismatch(
    handle,
    backendOptions,
    ownedOperation,
  );
  if (deliveryModeMismatch) {
    const activeFingerprint = normalizeOptionalString(handle.toolAuthorityFingerprint);
    // Only the captured backend may claim a route-mismatched question answer.
    const pendingInputAuthorityProven =
      !toolAuthorityOverlay &&
      activeFingerprint &&
      (normalizeOptionalString(options?.toolAuthorityFingerprint) === activeFingerprint ||
        normalizeOptionalString(options?.pendingInputAuthorityFingerprint) === activeFingerprint);
    diag.debug(`queue message failed: sessionId=${sessionId} reason=${deliveryModeMismatch}`);
    return {
      kind: "complete",
      outcome: createQueueFailureOutcome(sessionId, deliveryModeMismatch),
      ...(pendingInputAuthorityProven ? { pendingInput: injection } : {}),
    };
  }
  try {
    registration?.toolAuthority?.assertActive();
  } catch {
    return {
      kind: "complete",
      outcome: createQueueFailureOutcome(sessionId, "tool_authority_mismatch"),
    };
  }
  if (
    ACTIVE_EMBEDDED_RUNS.get(sessionId) !== handle ||
    ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle) !== registration ||
    (ownedOperation &&
      (resolveActiveReplyOperationForSessionId(sessionId) !== ownedOperation ||
        getAttachedBackend(ownedOperation) !== handle))
  ) {
    return { kind: "complete", outcome: createQueueFailureOutcome(sessionId, "no_active_run") };
  }
  return { kind: "embedded_run", queueMessage: injection.queueMessage, options: backendOptions };
}

function revokeCompletionClaim(sessionId: string, runId?: string): void {
  const claim = EMBEDDED_RUN_COMPLETION_CLAIMS.get(sessionId);
  if (claim && (runId === undefined || claim.runId === runId)) {
    claim.settleRegistration(undefined);
    EMBEDDED_RUN_COMPLETION_CLAIMS.delete(sessionId);
  }
}

/**
 * Abort embedded OpenClaw runs.
 *
 * - With a sessionId, aborts that single run.
 * - With no sessionId, supports targeted abort modes (for example, compacting runs only).
 */
export function abortEmbeddedAgentRun(sessionId: string): boolean;
export function abortEmbeddedAgentRun(
  sessionId: undefined,
  opts: { mode: "all" | "compacting"; reason?: "restart" },
): boolean;
export function abortEmbeddedAgentRun(
  sessionId?: string,
  opts?: { mode?: "all" | "compacting"; reason?: "restart" },
): boolean {
  if (typeof sessionId === "string" && sessionId.length > 0) {
    const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
    if (!handle) {
      if (abortReplyRunBySessionId(sessionId)) {
        return true;
      }
      diag.debug(`abort failed: sessionId=${sessionId} reason=no_active_run`);
      return false;
    }
    if (!isEmbeddedRunHandleAbortable(sessionId, handle)) {
      diag.debug(`abort failed: sessionId=${sessionId} reason=not_abortable`);
      return false;
    }
    diag.debug(`aborting run: sessionId=${sessionId}`);
    try {
      handle.abort(opts?.reason);
    } catch (err) {
      diag.warn(`abort failed: sessionId=${sessionId} err=${String(err)}`);
      return false;
    }
    revokeCompletionClaim(sessionId, handle.runId);
    return true;
  }

  const abortActiveEmbeddedRunHandles = (params: {
    shouldAbort: (handle: EmbeddedAgentQueueHandle) => boolean;
    formatDebugMessage: (sessionId: string) => string;
    skipSessionIds?: ReadonlySet<string>;
  }): boolean => {
    let aborted = false;
    for (const [id, handle] of ACTIVE_EMBEDDED_RUNS) {
      if (params.skipSessionIds?.has(id)) {
        continue;
      }
      if (!params.shouldAbort(handle)) {
        continue;
      }
      if (!isEmbeddedRunHandleAbortable(id, handle)) {
        continue;
      }
      diag.debug(params.formatDebugMessage(id));
      try {
        handle.abort(opts?.reason);
        revokeCompletionClaim(id, handle.runId);
        aborted = true;
      } catch (err) {
        diag.warn(`abort failed: sessionId=${id} err=${String(err)}`);
      }
    }
    return aborted;
  };

  const mode = opts?.mode;
  if (mode === "compacting") {
    const replyOwnedSessionIds = new Set(listActiveReplyRunSessionIds());
    const replyAborted = abortActiveReplyRuns({
      mode,
      onAbortError: (id, err) =>
        diag.warn(`abort failed: sessionId=${id} owner=reply_run err=${String(err)}`),
    });
    const aborted = abortActiveEmbeddedRunHandles({
      shouldAbort: (handle) => handle.isCompacting(),
      formatDebugMessage: (id) => `aborting compacting run: sessionId=${id}`,
      skipSessionIds: replyOwnedSessionIds,
    });
    return replyAborted || aborted;
  }

  if (mode === "all") {
    const replyOwnedSessionIds = new Set(listActiveReplyRunSessionIds());
    const replyAborted = abortActiveReplyRuns({
      mode,
      onAbortError: (id, err) =>
        diag.warn(`abort failed: sessionId=${id} owner=reply_run err=${String(err)}`),
    });
    const aborted = abortActiveEmbeddedRunHandles({
      shouldAbort: () => true,
      formatDebugMessage: (id) => `aborting run: sessionId=${id}`,
      skipSessionIds: replyOwnedSessionIds,
    });
    return replyAborted || aborted;
  }

  return false;
}

type EmbeddedHeartbeatPreemptionResult = "not-heartbeat" | "drained" | "timed-out";

export async function preemptAndDrainEmbeddedHeartbeatRun(
  sessionId: string,
  timeoutMs: number,
): Promise<EmbeddedHeartbeatPreemptionResult> {
  const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
  if (!handle?.preemptByVisibleTurn) {
    return "not-heartbeat";
  }
  const drainPromise = waitForCurrentEmbeddedAgentRunEnd(sessionId, timeoutMs, handle);
  try {
    handle.preemptByVisibleTurn();
  } catch (err) {
    diag.warn(`heartbeat preemption failed: sessionId=${sessionId} err=${String(err)}`);
  }
  return (await drainPromise) ? "drained" : "timed-out";
}

export function isEmbeddedAgentRunActive(sessionId: string): boolean {
  const active = ACTIVE_EMBEDDED_RUNS.has(sessionId) || isReplyRunActiveForSessionId(sessionId);
  if (active) {
    diag.debug(`run active check: sessionId=${sessionId} active=true`);
  }
  return active;
}

export function prepareEmbeddedAgentRunCompletionClaim(
  sessionId: string,
  runId: string,
): {
  bindOperationalRunInstance: (
    instance: NonNullable<EmbeddedRunRegistration["operationalRunInstance"]>,
  ) => boolean;
  claimCompletion: () => boolean;
  claimFailure: () => boolean;
  resolveCurrentRegistration: () => EmbeddedRunCompletionRegistration | undefined;
  registered: Promise<EmbeddedRunCompletionRegistration | undefined>;
} {
  let registrationSettled = false;
  let settleRegistration!: (registration: EmbeddedRunCompletionRegistration | undefined) => void;
  const registered = new Promise<EmbeddedRunCompletionRegistration | undefined>((resolve) => {
    settleRegistration = (registration) => {
      if (registrationSettled) {
        return;
      }
      registrationSettled = true;
      resolve(registration);
    };
  });
  const claim: EmbeddedRunCompletionClaim = {
    runId,
    lifecycleGeneration: getAgentEventLifecycleGeneration(),
    promoted: false,
    settleRegistration,
  };
  revokeCompletionClaim(sessionId);
  EMBEDDED_RUN_COMPLETION_CLAIMS.set(sessionId, claim);
  const consume = (allowUnregistered: boolean): boolean => {
    if (EMBEDDED_RUN_COMPLETION_CLAIMS.get(sessionId) !== claim) {
      return false;
    }
    EMBEDDED_RUN_COMPLETION_CLAIMS.delete(sessionId);
    if (!claim.promoted) {
      claim.settleRegistration(undefined);
    }
    return (
      (allowUnregistered || claim.promoted) &&
      isAgentEventLifecycleGenerationCurrent(claim.lifecycleGeneration)
    );
  };
  const bindOperationalRunInstance = (
    instance: NonNullable<EmbeddedRunRegistration["operationalRunInstance"]>,
  ): boolean => {
    if (
      EMBEDDED_RUN_COMPLETION_CLAIMS.get(sessionId) !== claim ||
      !isAgentEventLifecycleGenerationCurrent(claim.lifecycleGeneration) ||
      instance.runId !== runId ||
      (claim.operationalRunInstance !== undefined && claim.operationalRunInstance !== instance)
    ) {
      return false;
    }
    claim.operationalRunInstance = instance;
    return true;
  };
  const resolveCurrentRegistration = (): EmbeddedRunCompletionRegistration | undefined => {
    if (
      EMBEDDED_RUN_COMPLETION_CLAIMS.get(sessionId) !== claim ||
      !isAgentEventLifecycleGenerationCurrent(claim.lifecycleGeneration)
    ) {
      return undefined;
    }
    const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
    const registration = handle ? ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle) : undefined;
    const toolAuthority = registration?.toolAuthority;
    if (
      !handle ||
      handle.runId !== runId ||
      !toolAuthority ||
      !claim.operationalRunInstance ||
      registration.operationalRunInstance !== claim.operationalRunInstance
    ) {
      return undefined;
    }
    try {
      toolAuthority.assertActive();
    } catch {
      return undefined;
    }
    return EMBEDDED_RUN_COMPLETION_CLAIMS.get(sessionId) === claim &&
      ACTIVE_EMBEDDED_RUNS.get(sessionId) === handle &&
      ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle) === registration &&
      isAgentEventLifecycleGenerationCurrent(claim.lifecycleGeneration)
      ? { toolAuthority }
      : undefined;
  };
  return {
    bindOperationalRunInstance,
    claimCompletion: () => consume(false),
    claimFailure: () => consume(true),
    resolveCurrentRegistration,
    registered,
  };
}

/** Operational progress includes maintenance, including permission changes and cancellation. */
export function resolveEmbeddedAgentRunProgressState(
  sessionId: string,
): "queued" | "running" | undefined {
  return resolveEmbeddedRunProgressState(sessionId, "operational");
}

type SessionProgressOwner = { agentId?: string; defaultAgentId?: string };

function matchesSessionProgressOwner(
  owner: SessionProgressOwner,
  recorded: { agentId?: string; sessionKey?: string },
): boolean {
  const requestedAgentId = owner.agentId ?? owner.defaultAgentId;
  const recordedAgentId =
    recorded.agentId ?? parseAgentSessionKey(recorded.sessionKey)?.agentId ?? owner.defaultAgentId;
  return Boolean(
    requestedAgentId &&
    recordedAgentId &&
    normalizeAgentId(requestedAgentId) === normalizeAgentId(recordedAgentId),
  );
}

/** Session presentation uses the retained run owner, even after its context is released. */
export function resolveEmbeddedAgentSessionProgressState(
  sessionId: string,
  owner: SessionProgressOwner,
): "queued" | "running" | undefined {
  return resolveEmbeddedRunProgressState(sessionId, owner);
}

function resolveEmbeddedRunProgressState(
  sessionId: string,
  scope: "operational" | SessionProgressOwner,
): "queued" | "running" | undefined {
  const replyOperation = resolveActiveReplyOperationForSessionId(sessionId);
  const replyPhase = replyOperation?.phase;
  const replyInProgress =
    replyPhase !== undefined &&
    replyPhase !== "completed" &&
    replyPhase !== "failed" &&
    replyPhase !== "aborted" &&
    (scope === "operational" ||
      (replyOperation &&
        matchesSessionProgressOwner(scope, {
          agentId: replyOperation.agentId,
          sessionKey: replyOperation.key,
        })));
  const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
  const registration = handle && ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle);
  const handleInProgress =
    isEmbeddedRunHandleInProgress(handle) &&
    (scope === "operational" ||
      (registration &&
        registration.projectSessionActive !== false &&
        matchesSessionProgressOwner(scope, registration)));
  // Reply operations and embedded handles are independent lifecycle owners.
  // A retained terminal owner must not hide a newer live owner for the session.
  if (
    handleInProgress ||
    (replyInProgress &&
      replyOperation &&
      replyPhase !== "waiting_for_global_lane" &&
      hasReplyOperationExecutionStarted(replyOperation))
  ) {
    return "running";
  }
  return replyInProgress ? "queued" : undefined;
}

export function isEmbeddedAgentRunInProgress(sessionId: string): boolean {
  return resolveEmbeddedAgentRunProgressState(sessionId) !== undefined;
}

export type EmbeddedReplyActivity = Pick<ReplyOperation, "phase" | "lastActivityAtMs"> & {
  /** Terminal outcome committed; only delivery/finalization remains. */
  terminalOutcomeCommitted: boolean;
};

export function resolveEmbeddedReplyActivity(sessionId: string): EmbeddedReplyActivity | undefined {
  const operation = resolveActiveReplyOperationForSessionId(sessionId);
  return operation
    ? {
        phase: operation.phase,
        lastActivityAtMs: operation.lastActivityAtMs,
        terminalOutcomeCommitted: hasCommittedReplyOperationOutcome(operation),
      }
    : undefined;
}

export function isEmbeddedAgentRunHandleActive(sessionId: string): boolean {
  const active = ACTIVE_EMBEDDED_RUNS.has(sessionId);
  if (active) {
    diag.debug(`run handle active check: sessionId=${sessionId} active=true`);
  }
  return active;
}

export function isEmbeddedAgentRunAbortableForCompaction(sessionId: string): boolean {
  const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
  const active = handle ? true : isReplyRunAbortableForCompaction(sessionId);
  if (active) {
    diag.debug(`run compact coordination check: sessionId=${sessionId} active=true`);
  }
  return active;
}

export function isEmbeddedAgentRunStreaming(sessionId: string): boolean {
  const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
  return handle?.isStreaming() ?? false;
}

export function resolveActiveEmbeddedRunHandleSessionId(sessionKey: string): string | undefined {
  const normalizedSessionKey = sessionKey.trim();
  if (!normalizedSessionKey) {
    return undefined;
  }
  return ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY.get(normalizedSessionKey);
}

function isEmbeddedRunHandleInProgress(
  handle: EmbeddedAgentQueueHandle | undefined,
): handle is EmbeddedAgentQueueHandle {
  if (!handle) {
    return false;
  }
  if (handle.isAborted) {
    try {
      if (handle.isAborted()) {
        return false;
      }
    } catch {
      // A failed optional status probe cannot prove that live work has ended.
    }
  }
  return true;
}

export type ActiveEmbeddedRunOwner = {
  runId: string;
  sessionId: string;
  sessionKey?: string;
  startedAtMs?: number;
  abort: () => boolean;
};

function projectActiveEmbeddedRunOwner(
  registration: { sessionId: string; sessionKey?: string },
  handle: EmbeddedAgentQueueHandle,
): ActiveEmbeddedRunOwner | undefined {
  const runId = handle.runId;
  if (!runId || !isEmbeddedRunHandleInProgress(handle)) {
    return undefined;
  }
  return {
    runId,
    sessionId: registration.sessionId,
    ...(registration.sessionKey ? { sessionKey: registration.sessionKey } : {}),
    ...(handle.startedAtMs === undefined ? {} : { startedAtMs: handle.startedAtMs }),
    // A recovered run ID is correlation only. Recheck the captured owner before
    // Stop so a stale UI action cannot abort replacement work in the session.
    abort: () => {
      if (
        ACTIVE_EMBEDDED_RUNS.get(registration.sessionId) !== handle ||
        ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.get(runId) !== handle ||
        !isEmbeddedRunHandleAbortable(runId, handle)
      ) {
        return false;
      }
      try {
        if (handle.cancel) {
          handle.cancel("user_abort");
        } else {
          handle.abort();
        }
        revokeCompletionClaim(registration.sessionId, runId);
        return true;
      } catch {
        return false;
      }
    },
  };
}

export function resolveActiveEmbeddedRunOwner(
  sessionId: string,
): ActiveEmbeddedRunOwner | undefined {
  const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
  const registration = handle ? ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle) : undefined;
  return handle && registration ? projectActiveEmbeddedRunOwner(registration, handle) : undefined;
}

export function resolveActiveEmbeddedRunOwnerByRunId(
  runId: string,
): ActiveEmbeddedRunOwner | undefined {
  const normalizedRunId = runId.trim();
  const handle = normalizedRunId ? ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.get(normalizedRunId) : undefined;
  if (!handle) {
    return undefined;
  }
  const registration = ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle);
  return registration && ACTIVE_EMBEDDED_RUNS.get(registration.sessionId) === handle
    ? projectActiveEmbeddedRunOwner(registration, handle)
    : undefined;
}

export function isActiveEmbeddedRunId(runId: string): boolean {
  const normalizedRunId = runId.trim();
  const handle = normalizedRunId ? ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.get(normalizedRunId) : undefined;
  const registration = handle ? ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle) : undefined;
  return Boolean(
    handle &&
    registration &&
    ACTIVE_EMBEDDED_RUNS.get(registration.sessionId) === handle &&
    isEmbeddedRunHandleInProgress(handle),
  );
}

export function resolveActiveEmbeddedRunHandleSessionIdBySessionFile(
  sessionFile: string,
): string | undefined {
  const normalizedSessionFile = normalizeSessionFileRegistryKey(sessionFile);
  if (!normalizedSessionFile) {
    return undefined;
  }
  return ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_FILE.get(normalizedSessionFile);
}

export function resolveActiveEmbeddedRunSessionIdBySessionFile(
  sessionFile: string,
): string | undefined {
  return resolveActiveEmbeddedRunHandleSessionIdBySessionFile(sessionFile);
}

export function getActiveEmbeddedRunSnapshot(
  sessionId: string,
): ActiveEmbeddedRunSnapshot | undefined {
  return ACTIVE_EMBEDDED_RUN_SNAPSHOTS.get(sessionId);
}

function waitForCurrentEmbeddedAgentRunEnd(
  sessionId: string,
  timeoutMs: number | null,
  handle?: EmbeddedAgentQueueHandle,
): Promise<boolean> {
  const isHandleActive = () =>
    handle ? ACTIVE_EMBEDDED_RUNS.get(sessionId) === handle : ACTIVE_EMBEDDED_RUNS.has(sessionId);
  if (!isHandleActive()) {
    if (handle) {
      return Promise.resolve(true);
    }
    return waitForReplyRunEndBySessionId(sessionId, timeoutMs);
  }
  const timeoutLabel = timeoutMs === null ? "none" : String(timeoutMs);
  diag.debug(`waiting for run end: sessionId=${sessionId} timeoutMs=${timeoutLabel}`);
  return new Promise((resolve) => {
    const waiters = EMBEDDED_RUN_WAITERS.get(sessionId) ?? new Set();
    const waiter: EmbeddedRunWaiter = {
      resolve,
      handle,
    };
    if (timeoutMs !== null) {
      waiter.timer = setTimeout(
        () => {
          waiters.delete(waiter);
          if (waiters.size === 0) {
            EMBEDDED_RUN_WAITERS.delete(sessionId);
          }
          diag.warn(`wait timeout: sessionId=${sessionId} timeoutMs=${timeoutMs}`);
          resolve(false);
        },
        resolveTimerTimeoutMs(timeoutMs, 100, 100),
      );
    }
    waiters.add(waiter);
    EMBEDDED_RUN_WAITERS.set(sessionId, waiters);
    if (!isHandleActive()) {
      waiters.delete(waiter);
      if (waiters.size === 0) {
        EMBEDDED_RUN_WAITERS.delete(sessionId);
      }
      if (waiter.timer) {
        clearTimeout(waiter.timer);
      }
      resolve(true);
    }
  });
}

export async function waitForEmbeddedAgentRunEnd(
  sessionId: string,
  timeoutMs: number | null = 15_000,
): Promise<boolean> {
  if (!sessionId) {
    return true;
  }
  const deadline = timeoutMs === null ? undefined : Date.now() + timeoutMs;
  while (isEmbeddedAgentRunActive(sessionId)) {
    const remainingMs = deadline === undefined ? null : deadline - Date.now();
    if (remainingMs !== null && remainingMs <= 0) {
      return false;
    }
    if (!(await waitForCurrentEmbeddedAgentRunEnd(sessionId, remainingMs))) {
      return false;
    }
  }
  return true;
}

export type AbortAndDrainEmbeddedAgentRunResult = {
  aborted: boolean;
  drained: boolean;
  forceCleared: boolean;
};

export async function abortAndDrainEmbeddedAgentRun(params: {
  sessionId: string;
  sessionKey?: string;
  settleMs?: number;
  forceClear?: boolean;
  reason?: string;
}): Promise<AbortAndDrainEmbeddedAgentRunResult> {
  const settleMs = params.settleMs ?? 15_000;
  const settleDeadline = Date.now() + settleMs;
  const embeddedRunHandle = ACTIVE_EMBEDDED_RUNS.get(params.sessionId);
  // Capture the exact handle's session owner before cancellation can replace the run.
  const agentId = embeddedRunHandle
    ? ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(embeddedRunHandle)?.agentId
    : undefined;
  const replyOperation = resolveActiveReplyOperationForSessionId(params.sessionId);
  if (
    params.reason === "stuck_recovery" &&
    replyOperation &&
    hasCommittedReplyOperationOutcome(replyOperation)
  ) {
    return { aborted: false, drained: false, forceCleared: false };
  }
  let releaseStaleExpiryBarrier: (() => void) | undefined;
  const staleExpiryBarrier =
    params.reason === "stuck_recovery"
      ? new Promise<void>((resolve) => {
          releaseStaleExpiryBarrier = resolve;
        })
      : undefined;
  // Recovery is a staleness expiry: stamp run_stalled on the reply operation
  // BEFORE any handle abort, or the run loop's abort handler re-enters
  // abortByUser and misattributes the watchdog kill to the user.
  const expiredReplyRun =
    params.reason === "stuck_recovery" &&
    expireStaleReplyRunBySessionId(params.sessionId, "stuck_recovery", {
      afterClearBarrier: staleExpiryBarrier,
      followupAdmissionBarrierTimeout: settleMs + 1_000,
    });
  const stampedStaleReplyRun =
    params.reason === "stuck_recovery" && replyOperation?.staleExpiryReason === "stuck_recovery";
  const waitForExpiredOwnerSettlement = async () => {
    if (!stampedStaleReplyRun || !replyOperation) {
      return true;
    }
    const settled = await waitForReplyOperationOwnerSettlement(
      replyOperation,
      Math.max(100, settleDeadline - Date.now()),
    );
    if (!settled) {
      diag.warn(
        `stuck recovery: reply owner settlement timed out sessionId=${params.sessionId} settleMs=${settleMs}`,
      );
    }
    return settled;
  };
  try {
    if (expiredReplyRun && !ACTIVE_EMBEDDED_RUNS.has(params.sessionId)) {
      // Let the command lane observe synchronous reply completion before recovery
      // decides whether to reset it, but keep all owners on the shared drain path.
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    }
    let aborted = abortEmbeddedAgentRun(params.sessionId) || expiredReplyRun;
    const embeddedDrained =
      aborted || stampedStaleReplyRun
        ? await waitForEmbeddedAgentRunEnd(params.sessionId, settleMs)
        : false;
    const ownerSettled = await waitForExpiredOwnerSettlement();
    const drained = embeddedDrained && ownerSettled;
    // A retained cancel request can complete asynchronously after expire()
    // returns. Count that exact owner settlement as the accepted abort.
    if (!aborted && stampedStaleReplyRun && drained) {
      aborted = true;
    }
    const persistenceSnapshot =
      params.forceClear === true && params.sessionKey
        ? tryLoadForceClearSessionSnapshot(params.sessionKey, agentId)
        : undefined;
    const forceCleared =
      params.forceClear === true &&
      ((!expiredReplyRun && stampedStaleReplyRun && !ownerSettled) || !aborted || !drained)
        ? await forceClearEmbeddedAgentRun(
            params.sessionId,
            embeddedRunHandle,
            replyOperation,
            params.sessionKey,
            params.reason,
          )
        : false;
    if (forceCleared && params.sessionKey && persistenceSnapshot) {
      await persistForceClearedEmbeddedRunTerminalState({
        ...persistenceSnapshot,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
      });
    }
    return { aborted, drained, forceCleared };
  } finally {
    // Queue drains registered on the stale owner must not start while its
    // backend can still claim the same session and requeue the adopted turn.
    releaseStaleExpiryBarrier?.();
  }
}

type ForceClearSessionSnapshot = {
  agentId: string;
  startedAt?: number;
  storePath: string;
  updatedAt: number;
};

function tryLoadForceClearSessionSnapshot(
  sessionKey: string,
  preparedAgentId?: string,
): ForceClearSessionSnapshot | undefined {
  try {
    const cfg = getRuntimeConfig();
    const agentId = resolveSessionAgentId({ config: cfg, sessionKey, agentId: preparedAgentId });
    const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId });
    const entry = loadSessionEntry({ agentId, sessionKey, storePath });
    if (!entry || entry.status !== "running") {
      return undefined;
    }
    return {
      agentId,
      ...(entry.startedAt === undefined ? {} : { startedAt: entry.startedAt }),
      storePath,
      updatedAt: entry.updatedAt,
    };
  } catch (err) {
    diag.warn(
      `load force-clear session snapshot failed: sessionKey=${sessionKey} error=${String(err)}`,
    );
    return undefined;
  }
}

/** Persists terminal state when a forced registry clear cannot emit normal lifecycle. */
async function persistForceClearedEmbeddedRunTerminalState(params: {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  startedAt?: number;
  storePath: string;
  updatedAt: number;
}): Promise<void> {
  try {
    await updateSessionEntry(
      {
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        storePath: params.storePath,
      },
      (storedEntry) => {
        const entry = storedEntry as InternalSessionEntry;
        // A replacement can reuse the session id; bind this patch to both owners' exact snapshot.
        if (
          ACTIVE_EMBEDDED_RUNS.has(params.sessionId) ||
          ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY.has(params.sessionKey) ||
          isReplyRunActiveForSessionId(params.sessionId) ||
          resolveActiveReplyRunSessionId(params.sessionKey) !== undefined ||
          entry.sessionId !== params.sessionId ||
          entry.status !== "running" ||
          entry.updatedAt !== params.updatedAt ||
          entry.startedAt !== params.startedAt
        ) {
          return null;
        }
        const endedAt = Date.now();
        return {
          status: "killed",
          abortedLastRun: true,
          lifecycleRunId: undefined,
          endedAt,
          updatedAt: endedAt,
        };
      },
      {
        skipMaintenance: true,
        takeCacheOwnership: true,
        requireWriteSuccess: false,
      },
    );
  } catch (err) {
    // Registry ownership is already gone; preserve the completed recovery result.
    diag.warn(
      `persist force-cleared terminal state failed: sessionKey=${params.sessionKey} error=${String(err)}`,
    );
  }
}

function notifyEmbeddedRunEnded(sessionId: string, endedHandle: EmbeddedAgentQueueHandle) {
  const waiters = EMBEDDED_RUN_WAITERS.get(sessionId);
  if (!waiters || waiters.size === 0) {
    return;
  }
  const sessionIdle = !ACTIVE_EMBEDDED_RUNS.has(sessionId);
  diag.debug(`notifying waiters: sessionId=${sessionId} waiterCount=${waiters.size}`);
  for (const waiter of waiters) {
    if (waiter.handle ? waiter.handle !== endedHandle : !sessionIdle) {
      continue;
    }
    waiters.delete(waiter);
    if (waiter.timer) {
      clearTimeout(waiter.timer);
    }
    waiter.resolve(true);
  }
  if (waiters.size === 0) {
    EMBEDDED_RUN_WAITERS.delete(sessionId);
  }
}

export function setActiveEmbeddedRun(
  sessionId: string,
  handle: EmbeddedAgentQueueHandle,
  sessionKey?: string,
  sessionFile?: string,
  agentId?: string,
) {
  const currentLifecycleGeneration = getAgentEventLifecycleGeneration();
  const incomingLifecycleGeneration = setActiveEmbeddedRunLifecycleGeneration(
    handle,
    currentLifecycleGeneration,
  );
  // The immutable handle generation rejects delayed stale registration even
  // when rotation left no replacement owner in the session slot.
  if (!isAgentEventLifecycleGenerationCurrent(incomingLifecycleGeneration)) {
    revokeCompletionClaim(sessionId, handle.runId);
    try {
      handle.abort("restart");
    } catch (error) {
      diag.warn(`stale run registration abort failed: sessionId=${sessionId} err=${String(error)}`);
      throw error;
    }
    return;
  }
  if (handle.diagnosticOwner && isDiagnosticEmbeddedRunOwnerClosed(handle.diagnosticOwner)) {
    revokeCompletionClaim(sessionId, handle.runId);
    handle.abort("restart");
    return;
  }
  const caller = getGatewayToolCallerIdentity();
  let toolAuthority: EmbeddedRunRegistration["toolAuthority"];
  try {
    toolAuthority = caller?.embeddedRunToolAuthorityBinding?.({
      sessionId,
      sessionKey,
      sessionFile,
      agentId,
      handle,
    });
  } catch (error) {
    revokeCompletionClaim(sessionId, handle.runId);
    throw error;
  }
  const previousHandle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
  const wasActive = previousHandle !== undefined;
  if (previousHandle) {
    previousHandle.closeDiagnostics?.();
    clearEmbeddedRunAbortability(previousHandle, { retainFinalizing: true });
    EMBEDDED_RUN_FORCED_TERMINAL_SETTLEMENTS.delete(previousHandle);
  }
  try {
    toolAuthority?.assertActive();
  } catch (error) {
    revokeCompletionClaim(sessionId, handle.runId);
    throw error;
  }
  clearEmbeddedRunAbandonment({ sessionId, sessionKey, sessionFile });
  ACTIVE_EMBEDDED_RUNS.set(sessionId, handle);
  // The dispatch scope carries the admitted instance across both core and
  // plugin attempts. A handle's public runId alone cannot confer wait authority.
  const operationalRunInstance = caller?.operationalRunInstance;
  const runContext = handle.runId ? getAgentRunContext(handle.runId) : undefined;
  ACTIVE_EMBEDDED_RUN_REGISTRATIONS.set(handle, {
    projectSessionActive:
      runContext?.lifecycleGeneration === incomingLifecycleGeneration
        ? runContext.projectSessionActive
        : undefined,
    toolAuthority,
    operationalRunInstance,
    sessionId,
    // Legacy SDK callers may omit this; a matching live binding proves the captured owner.
    agentId: agentId ?? (toolAuthority ? caller?.agentId : undefined),
    ...(sessionKey ? { sessionKey } : {}),
    delegatedAuthority:
      operationalRunInstance?.runId === handle.runId && operationalRunInstance
        ? getActiveAgentRunDelegatedAuthority(operationalRunInstance)
        : undefined,
    onHumanInputResolved: () => {
      const operation = resolveActiveReplyOperationForSessionId(sessionId);
      if (operation && getAttachedBackend(operation) === handle) {
        operation.recordActivity();
      }
      markDiagnosticRunProgress({ sessionId, sessionKey, reason: "human_input:resolved" });
      // A real resolution resumes work and invalidates recovery queued before it.
      // This does not refresh progress while waiting or extend any run deadline.
      logSessionStateChange({
        sessionId,
        sessionKey,
        sessionFile,
        state: "processing",
        reason: "human_input_resolved",
      });
    },
  });
  const forcedTerminalSettlement = resolveSessionPlacementForcedTerminalSettlement();
  if (forcedTerminalSettlement) {
    EMBEDDED_RUN_FORCED_TERMINAL_SETTLEMENTS.set(handle, forcedTerminalSettlement);
  }
  if (handle.runId) {
    ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.set(handle.runId, handle);
  }
  clearActiveRunSessionKeys(sessionId);
  setActiveRunSessionKey(sessionKey, sessionId);
  clearActiveRunSessionFiles(sessionId);
  setActiveRunSessionFile(sessionFile, sessionId);
  logSessionStateChange({
    sessionId,
    sessionKey,
    sessionFile,
    state: "processing",
    reason: wasActive ? "run_replaced" : "run_started",
  });
  markDiagnosticEmbeddedRunStarted({
    sessionId,
    sessionKey,
    runId: handle.runId,
    owner: handle.diagnosticOwner,
  });
  if (!sessionId.startsWith("probe-")) {
    diag.debug(`run registered: sessionId=${sessionId} totalActive=${ACTIVE_EMBEDDED_RUNS.size}`);
  }
  const completionClaim = EMBEDDED_RUN_COMPLETION_CLAIMS.get(sessionId);
  if (
    completionClaim &&
    completionClaim.runId === handle.runId &&
    completionClaim.lifecycleGeneration === incomingLifecycleGeneration &&
    (completionClaim.operationalRunInstance === undefined ||
      completionClaim.operationalRunInstance === operationalRunInstance)
  ) {
    completionClaim.promoted = true;
    completionClaim.settleRegistration(toolAuthority ? { toolAuthority } : undefined);
  } else if (completionClaim) {
    revokeCompletionClaim(sessionId);
  }
}

export function updateActiveEmbeddedRunSnapshot(
  sessionId: string,
  snapshot: ActiveEmbeddedRunSnapshot,
) {
  if (!ACTIVE_EMBEDDED_RUNS.has(sessionId)) {
    return;
  }
  ACTIVE_EMBEDDED_RUN_SNAPSHOTS.set(sessionId, snapshot);
}

export function clearActiveEmbeddedRun(
  sessionId: string,
  handle: EmbeddedAgentQueueHandle,
  sessionKey?: string,
  sessionFile?: string,
  reason = "run_completed",
) {
  const activeHandle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
  if (activeHandle === handle) {
    handle.closeDiagnostics?.();
    ACTIVE_EMBEDDED_RUNS.delete(sessionId);
    clearEmbeddedRunAbortability(handle, { retainFinalizing: true });
    ACTIVE_EMBEDDED_RUN_SNAPSHOTS.delete(sessionId);
    clearActiveRunSessionKeys(sessionId, sessionKey);
    clearActiveRunSessionFiles(sessionId, sessionFile);
    logSessionStateChange({
      sessionId,
      sessionKey,
      sessionFile,
      state: "idle",
      reason,
    });
    if (!handle.diagnosticOwner) {
      markDiagnosticEmbeddedRunEnded({ sessionId, sessionKey });
    }
    if (!sessionId.startsWith("probe-")) {
      diag.debug(`run cleared: sessionId=${sessionId} totalActive=${ACTIVE_EMBEDDED_RUNS.size}`);
    }
  } else if (activeHandle !== undefined) {
    diag.debug(`run clear skipped: sessionId=${sessionId} reason=handle_mismatch`);
  }
  EMBEDDED_RUN_FORCED_TERMINAL_SETTLEMENTS.delete(handle);
  // Exact-handle waiters own teardown even after another run takes the session slot.
  notifyEmbeddedRunEnded(sessionId, handle);
}

async function forceClearEmbeddedAgentRun(
  sessionId: string,
  expectedHandle: EmbeddedAgentQueueHandle | undefined,
  expectedReplyOperation: ReplyOperation | undefined,
  sessionKey?: string,
  reason = "stuck_recovery",
): Promise<boolean> {
  let cleared = false;
  let forcedTerminalSettlement: (() => Promise<void>) | undefined;
  const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
  if (handle && handle === expectedHandle) {
    forcedTerminalSettlement = EMBEDDED_RUN_FORCED_TERMINAL_SETTLEMENTS.get(handle);
    EMBEDDED_RUN_FORCED_TERMINAL_SETTLEMENTS.delete(handle);
    handle.closeDiagnostics?.();
    ACTIVE_EMBEDDED_RUNS.delete(sessionId);
    clearEmbeddedRunAbortability(handle);
    ACTIVE_EMBEDDED_RUN_SNAPSHOTS.delete(sessionId);
    clearActiveRunSessionKeys(sessionId, sessionKey);
    clearActiveRunSessionFiles(sessionId);
    logSessionStateChange({ sessionId, sessionKey, state: "idle", reason });
    if (!handle.diagnosticOwner) {
      markDiagnosticEmbeddedRunEnded({ sessionId, sessionKey });
    }
    notifyEmbeddedRunEnded(sessionId, handle);
    cleared = true;
  }
  const cause = new Error(`Embedded run force-cleared by ${reason}`);
  try {
    return (
      (expectedReplyOperation ? forceClearReplyOperation(expectedReplyOperation, cause) : false) ||
      cleared
    );
  } finally {
    await forcedTerminalSettlement?.();
  }
}

const testing = {
  persistForceClearedEmbeddedRunTerminalState,
  resetActiveEmbeddedRuns() {
    for (const handle of ACTIVE_EMBEDDED_RUNS.values()) {
      EMBEDDED_RUN_FORCED_TERMINAL_SETTLEMENTS.delete(handle);
    }
    for (const waiters of EMBEDDED_RUN_WAITERS.values()) {
      for (const waiter of waiters) {
        if (waiter.timer) {
          clearTimeout(waiter.timer);
        }
        waiter.resolve(!waiter.handle);
      }
    }
    EMBEDDED_RUN_WAITERS.clear();
    ACTIVE_EMBEDDED_RUNS.clear();
    ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.clear();
    for (const claim of EMBEDDED_RUN_COMPLETION_CLAIMS.values()) {
      claim.settleRegistration(undefined);
    }
    EMBEDDED_RUN_COMPLETION_CLAIMS.clear();
    RETAINED_EMBEDDED_RUN_ABORTABILITY_RUN_IDS.clear();
    ACTIVE_EMBEDDED_RUN_SNAPSHOTS.clear();
    ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY.clear();
    ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_FILE.clear();
    ABANDONED_EMBEDDED_RUNS_BY_SESSION_ID.clear();
    ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_KEY.clear();
    ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_FILE.clear();
  },
};

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.embeddedRunsTestApi")] =
    testing;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
