import { isAgentEventLifecycleGenerationCurrent } from "../../infra/agent-events.js";
import { resolveFollowupReplyDeliveryTargetKey } from "./queue/delivery-target.js";
import type { FollowupRun } from "./queue/types.js";
import type { ReplyOperation } from "./reply-run-registry.js";

/** Immutable process-local fact minted by the owner that completed a source reply. */
export type ReplyCompletionHandoff = Readonly<{
  kind: "completed_source_reply";
  ownerKey: string;
  ownerSessionId: string;
  ownerLifecycleGeneration: string;
  deliveryTargetKey: string;
}>;

type ReplyCompletionQueueClaim = {
  handoff: ReplyCompletionHandoff;
};

type ReplyCompletionQueueOwner = object & {
  abortController?: AbortController;
};

const completionHandoffsByOperation = new WeakMap<ReplyOperation, ReplyCompletionHandoff>();
const claimedCompletionUpdatesByOperation = new WeakSet<ReplyOperation>();
const completionClaimsByQueueOwner = new WeakMap<object, ReplyCompletionQueueClaim>();
const queuedCompletionClaim = Symbol("openclaw.queuedReplyCompletionClaim");

type QueuedCompletionCarrier = FollowupRun & {
  [queuedCompletionClaim]?: {
    claim: ReplyCompletionQueueClaim;
    owner: ReplyCompletionQueueOwner;
  };
};

function clearReplyCompletionQueueClaim(owner: ReplyCompletionQueueOwner): void {
  completionClaimsByQueueOwner.delete(owner);
}

/** Records the completed delivery before execution can return to owner cleanup. */
export function recordReplyOperationCompletedSourceReply(
  operation: ReplyOperation,
  source: FollowupRun,
): void {
  const lifecycleGeneration = operation.lifecycleGeneration;
  if (
    operation.result ||
    !lifecycleGeneration ||
    !isAgentEventLifecycleGenerationCurrent(lifecycleGeneration)
  ) {
    return;
  }
  completionHandoffsByOperation.set(
    operation,
    Object.freeze({
      kind: "completed_source_reply",
      ownerKey: operation.key,
      ownerSessionId: operation.sessionId,
      ownerLifecycleGeneration: lifecycleGeneration,
      deliveryTargetKey: resolveFollowupReplyDeliveryTargetKey(source),
    }),
  );
}

type ReplyCompletionHandoffTake =
  | { kind: "claimed"; handoff?: ReplyCompletionHandoff }
  | { kind: "ignored" };

/**
 * Claims the exact operation's one queue-owner update after clear.
 * Duplicate callbacks are no-ops; the canonical no-delivery callback still
 * returns `claimed` so it can explicitly clear any predecessor state.
 */
export function takeReplyOperationCompletionHandoff(params: {
  operation: ReplyOperation;
  queueKey: string;
  admissionSessionId: string;
}): ReplyCompletionHandoffTake {
  const handoff = completionHandoffsByOperation.get(params.operation);
  if (
    claimedCompletionUpdatesByOperation.has(params.operation) ||
    params.operation.key !== params.queueKey ||
    params.operation.sessionId !== params.admissionSessionId
  ) {
    return { kind: "ignored" };
  }
  claimedCompletionUpdatesByOperation.add(params.operation);
  completionHandoffsByOperation.delete(params.operation);
  if (
    params.operation.result?.kind !== "completed" ||
    !handoff ||
    params.operation.key !== handoff.ownerKey ||
    params.operation.sessionId !== handoff.ownerSessionId ||
    !isAgentEventLifecycleGenerationCurrent(handoff.ownerLifecycleGeneration)
  ) {
    return { kind: "claimed" };
  }
  return { kind: "claimed", handoff };
}

/** Replaces the queue owner's predecessor fact, including replacement by no delivery. */
export function replaceReplyCompletionQueuePredecessor(
  owner: ReplyCompletionQueueOwner,
  handoff: ReplyCompletionHandoff | undefined,
): void {
  clearReplyCompletionQueueClaim(owner);
  if (handoff) {
    completionClaimsByQueueOwner.set(owner, { handoff });
  }
}

/**
 * Binds the queue owner's predecessor fact to the exact selected candidate.
 * A deferred candidate retains this claim; mismatches discard it without changing the run.
 */
export function bindReplyCompletionHandoffToQueuedRun(params: {
  owner: ReplyCompletionQueueOwner;
  queueKey: string;
  queued: FollowupRun;
}): void {
  const claim = completionClaimsByQueueOwner.get(params.owner);
  if (!claim) {
    return;
  }
  if (params.owner.abortController?.signal.aborted) {
    clearReplyCompletionQueueClaim(params.owner);
    return;
  }
  // Dropped/aborted queue entries never become a successor. Preserve the fact
  // for the first non-aborted item that actually reaches reply admission.
  if (params.queued.abortSignal?.aborted || params.queued.queueAbortSignal?.aborted) {
    return;
  }
  const handoff = claim.handoff;
  const eligible =
    isAgentEventLifecycleGenerationCurrent(handoff.ownerLifecycleGeneration) &&
    params.queueKey === handoff.ownerKey &&
    params.queued.run.sessionKey === handoff.ownerKey &&
    (params.queued.admissionSessionId ?? params.queued.run.sessionId) === handoff.ownerSessionId &&
    params.queued.currentInboundEventKind !== "room_event" &&
    handoff.deliveryTargetKey === resolveFollowupReplyDeliveryTargetKey(params.queued);
  if (!eligible) {
    clearReplyCompletionQueueClaim(params.owner);
    return;
  }
  Object.defineProperty(params.queued, queuedCompletionClaim, {
    configurable: true,
    value: { claim, owner: params.owner },
  });
}

/** Consumes the candidate-bound fact only after its ReplyOperation admission succeeds. */
export function consumeQueuedReplyCompletionHandoff(
  queued: FollowupRun,
  operation: ReplyOperation,
): ReplyCompletionHandoff | undefined {
  // SAFETY: the optional symbol is written only by bindReplyCompletionHandoffToQueuedRun.
  const carrier = queued as QueuedCompletionCarrier;
  const binding = carrier[queuedCompletionClaim];
  if (!binding) {
    return undefined;
  }
  delete carrier[queuedCompletionClaim];
  if (completionClaimsByQueueOwner.get(binding.owner) !== binding.claim) {
    return undefined;
  }
  if (binding.owner.abortController?.signal.aborted) {
    clearReplyCompletionQueueClaim(binding.owner);
    return undefined;
  }
  clearReplyCompletionQueueClaim(binding.owner);
  const handoff = binding.claim.handoff;
  return !operation.result &&
    operation.key === handoff.ownerKey &&
    operation.sessionId === handoff.ownerSessionId &&
    operation.lifecycleGeneration === handoff.ownerLifecycleGeneration &&
    isAgentEventLifecycleGenerationCurrent(handoff.ownerLifecycleGeneration) &&
    queued.run.sessionKey === handoff.ownerKey &&
    (queued.admissionSessionId ?? queued.run.sessionId) === handoff.ownerSessionId &&
    queued.currentInboundEventKind !== "room_event" &&
    handoff.deliveryTargetKey === resolveFollowupReplyDeliveryTargetKey(queued)
    ? handoff
    : undefined;
}
