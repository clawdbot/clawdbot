import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { createDeferred } from "../../shared/deferred.js";
import {
  replyMessageInjectionTargetOperation,
  type ReplyBackendHandle,
  type ReplyBackendMessageInjection,
  type ReplyBackendQueueMessageOptions,
  type ReplyBackendQueueMessageResult,
  type ReplyMessageInjectionAttempt,
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
  | "image_input_unsupported"
  | "source_reply_delivery_mode_mismatch"
  | "task_suggestion_delivery_mode_mismatch";

type ReplyMessageInjectionRejectionReason =
  | "no_active_run"
  | "not_running"
  | "stale_run"
  | "leaf_mismatch"
  | "run_mismatch"
  | "injection_unavailable"
  | ReplyBackendQueueMessageMismatch
  | "runtime_rejected";

export function resolveReplyBackendQueueMessageMismatch(
  backend: Pick<
    ReplyBackendHandle,
    "sourceReplyDeliveryMode" | "supportsQueueMessageImages" | "taskSuggestionDeliveryMode"
  >,
  options?: ReplyBackendQueueMessageOptions,
): ReplyBackendQueueMessageMismatch | undefined {
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
  originatingLeafEntryId: string | null | undefined;
  expectedRunId?: string;
  options?: ReplyBackendQueueMessageOptions;
}):
  | { reason: ReplyMessageInjectionRejectionReason; errorMessage?: string }
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
  if (!expectedRunId && operation.originatingLeafEntryId !== params.originatingLeafEntryId) {
    return { reason: "leaf_mismatch" };
  }
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
  const mismatch = resolveReplyBackendQueueMessageMismatch(backend, params.options);
  return mismatch ? { reason: mismatch } : { backend, injection };
}

export function beginReplyMessageInjectionTarget(
  target: ReplyMessageInjectionTarget,
  text: string,
  options?: ReplyBackendQueueMessageOptions,
): ReplyMessageInjectionAttempt {
  const resolved = resolveReplyMessageInjectionRejection({
    operation: target[replyMessageInjectionTargetOperation],
    originatingLeafEntryId: target.originatingLeafEntryId,
    expectedRunId: target.identity === "run" ? target.runId : undefined,
    options,
  });
  if (!("injection" in resolved)) {
    const immediateRejection = { status: "rejected" as const, ...resolved };
    return {
      targetRunId: target.runId,
      ...(target.identity === "leaf" ? { rejectBeforeAck: true as const } : {}),
      acceptance: Promise.resolve(false),
      outcome: Promise.resolve(immediateRejection),
    };
  }
  // Injection is user input, not run evidence: stamping activity here would let
  // sub-10-minute user messages re-arm a wedged run's staleness window forever.
  // Invoke before the first await. The capability owns the final synchronous
  // admission check, matching Codex's active-turn lock boundary.
  const acceptance = createDeferred<boolean>();
  let acceptanceSettled = false;
  const settleAcceptance = (accepted: boolean) => {
    if (acceptanceSettled) {
      return;
    }
    acceptanceSettled = true;
    acceptance.resolve(accepted);
  };
  const callerOnQueueAccepted = options?.onQueueAccepted;
  const queueOptions: ReplyBackendQueueMessageOptions = {
    ...options,
    onQueueAccepted: (accepted) => {
      settleAcceptance(accepted);
      callerOnQueueAccepted?.(accepted);
    },
  };
  let queued: Promise<void | ReplyBackendQueueMessageResult>;
  try {
    queued = resolved.injection.queueMessage(text, queueOptions);
  } catch (error) {
    settleAcceptance(false);
    const immediateRejection = {
      status: "rejected" as const,
      reason: "runtime_rejected" as const,
      errorMessage: String(error),
    };
    return {
      targetRunId: target.runId,
      acceptance: acceptance.promise,
      outcome: Promise.resolve(immediateRejection),
    };
  }
  const outcome = queued.then(
    (result): ReplyMessageInjectionOutcome => {
      settleAcceptance(true);
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
    targetRunId: target.runId,
    acceptance: acceptance.promise,
    outcome,
  };
}

/** Abort only the operation captured by this target; never a same-key successor. */
export function abortReplyMessageInjectionTarget(target: ReplyMessageInjectionTarget): boolean {
  return target[replyMessageInjectionTargetOperation].abortByUser();
}

/** Record accepted input on the exact operation without rediscovering its session slot. */
export function recordAcceptedReplyMessageInjectionTarget(
  target: ReplyMessageInjectionTarget,
  options?: { inboundAudio?: boolean },
): void {
  const operation = target[replyMessageInjectionTargetOperation];
  operation.recordActivity();
  if (options?.inboundAudio === true) {
    operation.markAcceptedSteeredInboundAudio();
  }
}
