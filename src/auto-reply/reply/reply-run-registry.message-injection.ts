import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  replyMessageInjectionTargetOperation,
  type ReplyBackendHandle,
  type ReplyBackendMessageInjection,
  type ReplyBackendQueueMessageOptions,
  type ReplyBackendQueueMessageResult,
  type ReplyMessageInjectionAttempt,
  type ReplyMessageInjectionOptions,
  type ReplyMessageInjectionOutcome,
  type ReplyMessageInjectionTarget,
  type ReplyOperation,
} from "./reply-run-registry.contracts.js";
import {
  getAttachedBackend,
  isReplyRunEvidenceStale,
  replyRunState,
} from "./reply-run-registry.state.js";

type ReplyBackendQueueMessageMismatch =
  | "tool_authority_mismatch"
  | "image_input_unsupported"
  | "source_reply_delivery_mode_mismatch"
  | "task_suggestion_delivery_mode_mismatch";

type ReplyMessageInjectionRejectionReason =
  | "no_active_run"
  | "not_running"
  | "stale_run"
  | "run_mismatch"
  | "injection_unavailable"
  | ReplyBackendQueueMessageMismatch
  | "runtime_rejected";

export function resolveReplyBackendQueueMessageMismatch(
  backend: Pick<
    ReplyBackendHandle,
    | "sourceReplyDeliveryMode"
    | "supportsQueueMessageImages"
    | "taskSuggestionDeliveryMode"
    | "toolAuthorityFingerprint"
  >,
  options?: ReplyBackendQueueMessageOptions,
  authority?: { toolAuthorityFingerprint?: string },
): ReplyBackendQueueMessageMismatch | undefined {
  if (options?.isInboundUserMessage === true) {
    const activeFingerprint = normalizeOptionalString(
      backend.toolAuthorityFingerprint ?? authority?.toolAuthorityFingerprint,
    );
    const incomingFingerprint = normalizeOptionalString(options.toolAuthorityFingerprint);
    if (!activeFingerprint || !incomingFingerprint || activeFingerprint !== incomingFingerprint) {
      return "tool_authority_mismatch";
    }
  }
  if (options?.images?.length && backend.supportsQueueMessageImages !== true) {
    return "image_input_unsupported";
  }
  if (
    options?.sourceReplyDeliveryMode === "message_tool_only" &&
    backend.sourceReplyDeliveryMode !== "message_tool_only"
  ) {
    return "source_reply_delivery_mode_mismatch";
  }
  // User turns carry this own property even when disabled; internal wakeups
  // omit it so they inherit the active run's already-negotiated tool surface.
  if (
    options !== undefined &&
    Object.hasOwn(options, "taskSuggestionDeliveryMode") &&
    options?.taskSuggestionDeliveryMode !== backend.taskSuggestionDeliveryMode
  ) {
    return "task_suggestion_delivery_mode_mismatch";
  }
  return undefined;
}

function resolveReplyBackendMessageInjection(
  backend: ReplyBackendHandle,
): ReplyBackendMessageInjection | undefined {
  if (backend.messageInjection) {
    return backend.messageInjection;
  }
  if (!backend.queueMessage) {
    return undefined;
  }
  return {
    isAvailable: () => {
      if (backend.isStopped) {
        return !backend.isStopped();
      }
      // Legacy handles already expose the only capability that matters here:
      // queueMessage. Let the runtime accept or reject instead of guessing from
      // unrelated token-stream state.
      return true;
    },
    queueMessage: (text, options) =>
      options ? backend.queueMessage!(text, options) : backend.queueMessage!(text),
  };
}

export function resolveReplyMessageInjectionRejection(params: {
  operation: ReplyOperation | undefined;
  expectedRunId?: string;
  options?: ReplyBackendQueueMessageOptions;
}):
  | {
      reason: ReplyMessageInjectionRejectionReason;
      errorMessage?: string;
      backend?: ReplyBackendHandle;
    }
  | { backend: ReplyBackendHandle; injection: ReplyBackendMessageInjection } {
  const { operation } = params;
  if (!operation || replyRunState.activeRunsByKey.get(operation.key) !== operation) {
    return { reason: "no_active_run" };
  }
  if (operation.result || operation.phase !== "running") {
    return { reason: "not_running" };
  }
  const expectedRunId = normalizeOptionalString(params.expectedRunId);
  // Exact run identity supersedes the operation's immutable origin leaf. The
  // same run advances its transcript leaf during ordinary tool/output progress.
  if (isReplyRunEvidenceStale(operation)) {
    return { reason: "stale_run" };
  }
  const backend = getAttachedBackend(operation);
  const injection = backend ? resolveReplyBackendMessageInjection(backend) : undefined;
  if (!backend || !injection) {
    return { reason: "injection_unavailable" };
  }
  if (expectedRunId && normalizeOptionalString(backend.runId) !== expectedRunId) {
    return { reason: "run_mismatch" };
  }
  try {
    if (!injection.isAvailable()) {
      return { reason: "injection_unavailable" };
    }
  } catch (error) {
    return { reason: "injection_unavailable", errorMessage: String(error) };
  }
  const mismatch = resolveReplyBackendQueueMessageMismatch(backend, params.options, operation);
  const activeFingerprint = normalizeOptionalString(
    backend.toolAuthorityFingerprint ?? operation.toolAuthorityFingerprint,
  );
  const pendingInputAuthorityProven =
    activeFingerprint !== undefined &&
    normalizeOptionalString(params.options?.pendingInputAuthorityFingerprint) === activeFingerprint;
  if (
    mismatch === "tool_authority_mismatch" &&
    pendingInputAuthorityProven &&
    !params.options?.images?.length &&
    backend.claimPendingUserInputAnswer
  ) {
    return {
      backend,
      injection: {
        isAvailable: () => true,
        queueMessage: async (text, options) => {
          if (!(await backend.claimPendingUserInputAnswer?.(text, options))) {
            throw new Error("pending user input was not accepted");
          }
        },
      },
    };
  }
  return mismatch ? { reason: mismatch, backend } : { backend, injection };
}

export function beginReplyMessageInjectionTarget(
  target: ReplyMessageInjectionTarget,
  text: string,
  options?: ReplyMessageInjectionOptions,
): ReplyMessageInjectionAttempt {
  const operation = target[replyMessageInjectionTargetOperation];
  const { toolAuthorityOverlay, ...backendOptions } = options ?? {};
  const projectedToolAuthorityFingerprint = toolAuthorityOverlay
    ? operation.projectToolAuthorityFingerprint(toolAuthorityOverlay)
    : backendOptions.toolAuthorityFingerprint;
  const queueOptions: ReplyBackendQueueMessageOptions | undefined = options
    ? {
        ...backendOptions,
        ...(toolAuthorityOverlay
          ? { toolAuthorityFingerprint: projectedToolAuthorityFingerprint }
          : {}),
      }
    : undefined;
  const resolved = resolveReplyMessageInjectionRejection({
    operation,
    expectedRunId: target.identity === "run" ? target.runId : undefined,
    options: queueOptions,
  });
  if (!("injection" in resolved)) {
    const immediateRejection = {
      status: "rejected" as const,
      reason: resolved.reason,
      ...(resolved.errorMessage ? { errorMessage: resolved.errorMessage } : {}),
    };
    const cancelPendingImage =
      options?.isInboundUserMessage === true &&
      Boolean(options.images?.length) &&
      (resolved.reason === "tool_authority_mismatch" ||
        resolved.reason === "image_input_unsupported")
        ? resolved.backend?.cancelPendingUserInput
        : undefined;
    return {
      targetRunId: target.runId,
      acceptance: Promise.resolve(false),
      outcome: cancelPendingImage
        ? Promise.resolve(cancelPendingImage("image-reply")).then(() => immediateRejection)
        : Promise.resolve(immediateRejection),
    };
  }
  const targetRunId = normalizeOptionalString(resolved.backend.runId);
  const userTurnTranscriptRecorder = queueOptions?.userTurnTranscriptRecorder;
  // The backend selected at the final admission check owns steering identity.
  // Durable provenance is confirmed only after this exact queue operation proves
  // transcript commitment; acceptance alone is insufficient.
  // Injection is user input, not run evidence: stamping activity here would let
  // sub-10-minute user messages re-arm a wedged run's staleness window forever.
  // Invoke before the first await. The capability owns the final synchronous
  // admission check, matching Codex's active-turn lock boundary.
  const acceptance = createDeferredCore<boolean>();
  let acceptanceSettled = false;
  const settleAcceptance = (accepted: boolean) => {
    if (acceptanceSettled) {
      return;
    }
    acceptanceSettled = true;
    acceptance.resolve(accepted);
  };
  const callerOnQueueAccepted = queueOptions?.onQueueAccepted;
  const runtimeQueueOptions: ReplyBackendQueueMessageOptions = {
    ...queueOptions,
    onQueueAccepted: (accepted) => {
      settleAcceptance(accepted);
      callerOnQueueAccepted?.(accepted);
    },
  };
  let queued: Promise<void | ReplyBackendQueueMessageResult>;
  try {
    queued = resolved.injection.queueMessage(text, runtimeQueueOptions);
  } catch (error) {
    settleAcceptance(false);
    const immediateRejection = {
      status: "rejected" as const,
      reason: "runtime_rejected" as const,
      errorMessage: String(error),
    };
    return {
      targetRunId,
      acceptance: acceptance.promise,
      outcome: Promise.resolve(immediateRejection),
    };
  }
  const outcome = queued.then(
    async (result): Promise<ReplyMessageInjectionOutcome> => {
      settleAcceptance(true);
      if (
        targetRunId &&
        queueOptions?.waitForTranscriptCommit === true &&
        result?.transcriptCommit !== "unconfirmed"
      ) {
        await userTurnTranscriptRecorder?.confirmSteerTargetRunIdForPersistence?.(targetRunId);
      }
      return result ? { status: "accepted", result } : { status: "accepted" };
    },
    (error: unknown): ReplyMessageInjectionOutcome => {
      settleAcceptance(false);
      return {
        status: "rejected",
        reason: "runtime_rejected",
        errorMessage: String(error),
      };
    },
  );
  return {
    targetRunId,
    acceptance: acceptance.promise,
    outcome,
  };
}

/** Finalize adoption and cleanup on the captured operation without rediscovery. */
export async function finalizeReplyMessageInjectionAttempt(params: {
  attempt: ReplyMessageInjectionAttempt;
  target: ReplyMessageInjectionTarget;
  inboundAudio?: boolean;
  onAccepted?: () => void;
  onAdopted?: () => void | Promise<void>;
  shouldAbortOnAdoptionError?: (error: unknown) => boolean;
}) {
  const outcome = await params.attempt.outcome;
  if (outcome.status === "rejected") {
    return { status: "rejected" as const, outcome, targetRunId: params.attempt.targetRunId };
  }
  recordAcceptedReplyMessageInjectionTarget(params.target, {
    inboundAudio: params.inboundAudio,
  });
  params.onAccepted?.();
  let aborted = outcome.result?.transcriptCommit === "unconfirmed";
  if (aborted) {
    abortReplyMessageInjectionTarget(params.target);
  }
  let adoptionError: unknown;
  try {
    await params.onAdopted?.();
  } catch (error) {
    adoptionError = error;
    if (params.shouldAbortOnAdoptionError?.(error)) {
      abortReplyMessageInjectionTarget(params.target);
      aborted = true;
    }
  }
  return {
    status: "accepted" as const,
    outcome,
    targetRunId: params.attempt.targetRunId,
    aborted,
    ...(adoptionError === undefined ? {} : { adoptionError }),
  };
}

/** Abort only the operation captured by this target; never a same-key successor. */
function abortReplyMessageInjectionTarget(target: ReplyMessageInjectionTarget): boolean {
  return target[replyMessageInjectionTargetOperation].abortByUser();
}

/** Record accepted input on the exact operation without rediscovering its session slot. */
function recordAcceptedReplyMessageInjectionTarget(
  target: ReplyMessageInjectionTarget,
  options?: { inboundAudio?: boolean },
): void {
  const operation = target[replyMessageInjectionTargetOperation];
  operation.recordActivity();
  if (options?.inboundAudio === true) {
    operation.markAcceptedSteeredInboundAudio();
  }
}
