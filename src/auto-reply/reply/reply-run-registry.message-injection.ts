import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { QuestionAnswerUnconfirmedError } from "../../agents/harness/gateway-question-dispatch.js";
import { hasPromptImageInput } from "../../media/prompt-image-input.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createMessageInjectionAuthority } from "./message-injection-authority.js";
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
  if (hasPromptImageInput(options) && backend.supportsQueueMessageImages !== true) {
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
  canInject: () => boolean,
):
  | (ReplyBackendMessageInjection &
      Pick<ReplyBackendHandle, "claimPendingUserInputAnswer" | "cancelPendingUserInput">)
  | undefined {
  const guarded = backend.messageInjectionV2;
  if (guarded?.version === 2) {
    const assertCurrent = createMessageInjectionAuthority(canInject);
    return {
      isAvailable: () => guarded.isAvailable(),
      queueMessage: (text, options) => guarded.queueMessage(text, options, assertCurrent, "run"),
      claimPendingUserInputAnswer: guarded.claimPendingUserInputAnswer
        ? (text, options) =>
            guarded.claimPendingUserInputAnswer!(text, options, assertCurrent, "run")
        : undefined,
      cancelPendingUserInput: guarded.cancelPendingUserInput
        ? (resolvedBy) => guarded.cancelPendingUserInput!(resolvedBy, assertCurrent, "run")
        : undefined,
    };
  }
  if (backend.messageInjection) {
    const injection = backend.messageInjection;
    return {
      isAvailable: () => injection.isAvailable(),
      queueMessage: (text, options) => injection.queueMessage(text, options),
      claimPendingUserInputAnswer: backend.claimPendingUserInputAnswer?.bind(backend),
      cancelPendingUserInput: backend.cancelPendingUserInput?.bind(backend),
    };
  }
  if (!backend.queueMessage) {
    return undefined;
  }
  return {
    claimPendingUserInputAnswer: backend.claimPendingUserInputAnswer?.bind(backend),
    cancelPendingUserInput: backend.cancelPendingUserInput?.bind(backend),
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
  options?: ReplyBackendQueueMessageOptions;
}):
  | {
      reason: ReplyMessageInjectionRejectionReason;
      errorMessage?: string;
      backend?: ReplyBackendHandle;
      cancelPendingUserInput?: ReplyBackendHandle["cancelPendingUserInput"];
    }
  | { backend: ReplyBackendHandle; injection: ReplyBackendMessageInjection } {
  const { operation } = params;
  if (!operation || replyRunState.activeRunsByKey.get(operation.key) !== operation) {
    return { reason: "no_active_run" };
  }
  if (operation.result || operation.phase !== "running") {
    return { reason: "not_running" };
  }
  if (isReplyRunEvidenceStale(operation)) {
    return { reason: "stale_run" };
  }
  const backend = getAttachedBackend(operation);
  const canInject = () =>
    replyRunState.activeRunsByKey.get(operation.key) === operation &&
    !operation.result &&
    operation.phase === "running" &&
    getAttachedBackend(operation) === backend;
  const injection = backend ? resolveReplyBackendMessageInjection(backend, canInject) : undefined;
  if (!backend || !injection) {
    return { reason: "injection_unavailable" };
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
    !hasPromptImageInput(params.options) &&
    injection.claimPendingUserInputAnswer
  ) {
    return {
      backend,
      injection: {
        isAvailable: () => true,
        queueMessage: async (text, options) => {
          if (!(await injection.claimPendingUserInputAnswer?.(text, options))) {
            throw new Error("pending user input was not accepted");
          }
        },
      },
    };
  }
  return mismatch
    ? { reason: mismatch, backend, cancelPendingUserInput: injection.cancelPendingUserInput }
    : { backend, injection };
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
      hasPromptImageInput(options) &&
      (resolved.reason === "tool_authority_mismatch" ||
        resolved.reason === "image_input_unsupported")
        ? resolved.cancelPendingUserInput
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
    queueOptions?.onQueueAccepted?.(accepted);
  };
  const runtimeQueueOptions: ReplyBackendQueueMessageOptions = {
    ...queueOptions,
    onQueueAccepted: (accepted) => {
      // Rejection is provisional until the outcome rules out an uncertain question
      // dispatch. Forwarding false early would release the parked input for replay.
      if (accepted) {
        settleAcceptance(true);
      }
    },
  };
  const failed = (error: unknown): ReplyMessageInjectionOutcome => {
    if (error instanceof QuestionAnswerUnconfirmedError) {
      settleAcceptance(true);
      return { status: "indeterminate", errorMessage: error.message };
    }
    settleAcceptance(false);
    return { status: "rejected", reason: "runtime_rejected", errorMessage: String(error) };
  };
  let queued: Promise<void | ReplyBackendQueueMessageResult>;
  try {
    queued = resolved.injection.queueMessage(text, runtimeQueueOptions);
  } catch (error) {
    return {
      targetRunId,
      acceptance: acceptance.promise,
      outcome: Promise.resolve(failed(error)),
    };
  }
  const outcome = queued.then(async (result): Promise<ReplyMessageInjectionOutcome> => {
    settleAcceptance(true);
    if (
      targetRunId &&
      queueOptions?.waitForTranscriptCommit === true &&
      result?.transcriptCommit !== "unconfirmed"
    ) {
      await userTurnTranscriptRecorder?.confirmSteerTargetRunIdForPersistence?.(targetRunId);
    }
    return result ? { status: "accepted", result } : { status: "accepted" };
  }, failed);
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
  onOutcome?: (outcome: "accepted" | "indeterminate") => void;
  onAdopted?: () => void | Promise<void>;
  shouldAbortOnAdoptionError?: (error: unknown) => boolean;
}) {
  const outcome = await params.attempt.outcome;
  if (outcome.status === "rejected") {
    return { status: "rejected" as const, outcome, targetRunId: params.attempt.targetRunId };
  }
  // Retained input custody must be visible before fallible source adoption.
  params.onOutcome?.(outcome.status);
  if (outcome.status === "indeterminate") {
    let adoptionError: unknown;
    try {
      await params.onAdopted?.();
    } catch (error) {
      adoptionError = error;
    }
    // Unknown input retains custody but has no authority to abort independent
    // backing work, including when the source's later adoption fails.
    return {
      status: "indeterminate" as const,
      outcome,
      targetRunId: params.attempt.targetRunId,
      adoptionError,
    };
  }
  recordAcceptedReplyMessageInjectionTarget(params.target, {
    inboundAudio: params.inboundAudio,
  });
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
