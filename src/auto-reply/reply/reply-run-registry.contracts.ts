import type { ImageContent } from "../../llm/types.js";
import type { MediaFact } from "../../media/media-facts.js";
import type { PromptImageOrderEntry } from "../../media/prompt-image-order.js";
import type { UserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.types.js";
import type {
  SourceReplyDeliveryMode,
  TaskSuggestionDeliveryMode,
} from "../get-reply-options.types.js";
import type { ReplyFollowupAdmissionBarrierTimeoutPolicy } from "./reply-dispatcher.types.js";
import * as replyRunSettle from "./reply-run-finalization-lease.js";

type ReplyRunKey = string;

type ReplyBackendKind = "embedded" | "cli";

type ReplyBackendCancelReason = "user_abort" | "restart" | "superseded";

export type ReplyBackendQueueMessageOptions = {
  steeringMode?: "all";
  /** True when this queue item came from the channel's current user turn. */
  isInboundUserMessage?: boolean;
  debounceMs?: number;
  /** Ordered current-turn images to inject with the steering text. */
  images?: ImageContent[];
  imageOrder?: PromptImageOrderEntry[];
  /** Ordered facts represented by attachment text in this steering prompt. */
  media?: MediaFact[];
  deliveryTimeoutMs?: number;
  waitForTranscriptCommit?: boolean;
  /** Stable source identity for exact queued-message commit/cancellation matching. */
  queueIdentity?: string;
  abortSignal?: AbortSignal;
  /** Releases arrival ordering once the runtime has actually accepted this queue item. */
  onQueueAccepted?: (accepted: boolean) => void;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  taskSuggestionDeliveryMode?: TaskSuggestionDeliveryMode;
  /** Prepared channel turn to merge only at transcript persistence. */
  userTurnTranscriptRecorder?: UserTurnTranscriptRecorder;
};

export type ReplyBackendQueueMessageResult = {
  /** Acceptance was irreversible, but the harness could not prove transcript commitment. */
  transcriptCommit: "unconfirmed";
  errorMessage: string;
};

export type ReplyBackendMessageInjection = {
  /** Runtime-owned admission state; independent from token streaming. */
  isAvailable(): boolean;
  queueMessage(
    text: string,
    options?: ReplyBackendQueueMessageOptions,
  ): Promise<void | ReplyBackendQueueMessageResult>;
};

export type ReplyBackendHandle = {
  readonly kind: ReplyBackendKind;
  readonly runId?: string;
  readonly sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  readonly taskSuggestionDeliveryMode?: TaskSuggestionDeliveryMode;
  /** True only when queueMessage preserves images supplied in its options. */
  readonly supportsQueueMessageImages?: boolean;
  cancel(reason?: ReplyBackendCancelReason): void;
  readonly messageInjection?: ReplyBackendMessageInjection;
  /** @deprecated Compatibility for shipped embedded handles. Use messageInjection. */
  isStreaming?: () => boolean;
  isStopped?: () => boolean;
  isAbortable?: () => boolean;
  /** @deprecated Compatibility for shipped embedded handles. Use messageInjection. */
  queueMessage?: (
    text: string,
    options?: ReplyBackendQueueMessageOptions,
  ) => Promise<void | ReplyBackendQueueMessageResult>;
  /**
   * Compatibility-only hook so legacy "abort compacting runs" paths can still
   * find embedded runs that are compacting during the main run phase.
   */
  isCompacting?: () => boolean;
};

export const replyMessageInjectionTargetOperation = Symbol("replyMessageInjectionTargetOperation");
export type ReplyMessageInjectionTarget = {
  readonly [replyMessageInjectionTargetOperation]: ReplyOperation;
  /** Legacy targets stay leaf-bound even when their backend exposes a run id. */
  readonly identity: "leaf" | "run";
  readonly runId?: string;
  readonly originatingLeafEntryId: string | null | undefined;
};

type ReplyMessageInjectionRejectionReason =
  | "no_active_run"
  | "not_running"
  | "stale_run"
  | "leaf_mismatch"
  | "run_mismatch"
  | "injection_unavailable"
  | ReplyBackendQueueMessageMismatch
  | "runtime_rejected";

export type ReplyMessageInjectionOutcome =
  | { status: "accepted"; result?: ReplyBackendQueueMessageResult }
  | { status: "rejected"; reason: ReplyMessageInjectionRejectionReason; errorMessage?: string };

export type ReplyMessageInjectionAttempt = {
  /** Native run identity captured with the opaque operation target. */
  targetRunId: string | undefined;
  /** Leaf-bound compatibility must reject before ACK instead of falling through. */
  rejectBeforeAck?: true;
  /** Settles once the runtime accepts or rejects ownership of this exact message. */
  acceptance: Promise<boolean>;
  /** Settles after the backend confirms or rejects this exact injection. */
  outcome: Promise<ReplyMessageInjectionOutcome>;
};

type ReplyBackendQueueMessageMismatch =
  | "image_input_unsupported"
  | "source_reply_delivery_mode_mismatch"
  | "task_suggestion_delivery_mode_mismatch";

/** Prevents steering a turn into a run that cannot preserve its model-facing input. */

export type ReplyOperationPhase =
  | "queued"
  | "waiting_for_deferred_maintenance"
  | "waiting_for_global_lane"
  | "preflight_compacting"
  | "memory_flushing"
  | "running"
  | "completed"
  | "failed"
  | "aborted";

type ReplyOperationFailureCode =
  | "gateway_draining"
  | "command_lane_cleared"
  | "aborted_by_user"
  | "session_corruption_reset"
  | "run_stalled"
  | "run_failed";

type ReplyOperationAbortCode = "aborted_by_user" | "aborted_for_restart";

type ReplyOperationResult =
  | { kind: "completed" }
  | { kind: "failed"; code: ReplyOperationFailureCode; cause?: unknown }
  | { kind: "aborted"; code: ReplyOperationAbortCode };

export type ReplyOperation = {
  readonly key: ReplyRunKey;
  readonly sessionId: string;
  /** Gateway lifecycle that admitted this process-local owner. */
  readonly lifecycleGeneration?: string;
  readonly routeThreadId?: string | number;
  /** Transcript branch leaf from which this operation was admitted. */
  readonly originatingLeafEntryId?: string | null;
  readonly abortSignal: AbortSignal;
  readonly resetTriggered: boolean;
  /**
   * True when this operation was admitted to recover a terminal session (a
   * leftover failed/timeout/killed run). Concurrent visible turns reading the
   * same terminal store snapshot must NOT force-clear such an operation: it is a
   * sibling recovery already in flight, not the proven stale leftover.
   */
  readonly terminalRecovery: boolean;
  /**
   * Sticky fact for audio accepted into this operation after its originating turn.
   * Final delivery reads it because the original dispatch context cannot change.
   */
  readonly acceptedSteeredInboundAudio: boolean;
  readonly phase: ReplyOperationPhase;
  readonly result: ReplyOperationResult | null;
  /** Set when a stale-watchdog expiry forced this operation's run_stalled result. */
  readonly staleExpiryReason?: ReplyOperationStaleReason;
  readonly startedAtMs: number;
  readonly lastActivityAtMs: number;
  /** True when this operation has owned the supplied session ID. */
  hasOwnedSessionId(sessionId: string): boolean;
  recordActivity(): void;
  setPhase(
    next:
      | "queued"
      | "waiting_for_deferred_maintenance"
      | "waiting_for_global_lane"
      | "preflight_compacting"
      | "memory_flushing"
      | "running",
  ): void;
  /** Mark this operation as waiting on prior same-session maintenance. */
  markWaitingForDeferredMaintenance(): void;
  /** Return a maintenance-waiting operation to queued if the run has not started. */
  markDeferredMaintenanceWaitEnded(): void;
  /** Mark this operation as waiting for process-global run capacity. */
  markWaitingForGlobalLane(): void;
  /** Return a global-lane-waiting operation to queued once capacity is granted. */
  markGlobalLaneWaitEnded(): void;
  /** Mark this operation as an in-flight terminal-session recovery. */
  markTerminalRecovery(): void;
  markAcceptedSteeredInboundAudio(): void;
  updateSessionId(nextSessionId: string): void;
  /**
   * Move this queued operation to another session key's run slot. Native command
   * turns admit under the slash SOURCE key; when the command continues into a full
   * agent turn it must own the TARGET session's slot so concurrent target inbounds
   * queue/steer instead of double-admitting. Throws ReplyRunAlreadyActiveError when
   * the target slot is owned.
   */
  updateSessionKey(nextSessionKey: string): void;
  attachBackend(handle: ReplyBackendHandle): void;
  detachBackend(handle: ReplyBackendHandle): void;
  /** Reject later aborts after the backend has committed its terminal outcome. */
  freezeAbort(): void;
  /**
   * Keep a failed operation active until complete() releases the session lane.
   * Dispatch uses this while a user-visible failure payload still needs delivery.
   */
  retainFailureUntilComplete(): void;
  /** Settles after the lifecycle owner's final delivery/persistence barrier. */
  readonly ownerSettlement?: Promise<void>;
  complete(): void;
  /**
   * Complete the operation, clear active-run state, then run follow-up work.
   * Use when the follow-up can create another ReplyOperation for this session.
   */
  completeThen(afterClear: () => void): void;
  /**
   * Clear active-run state immediately, but delay registered after-clear work
   * until delivery or another external barrier settles.
   */
  completeWithAfterClearBarrier(
    barrier: PromiseLike<unknown>,
    timeout?: number | ReplyFollowupAdmissionBarrierTimeoutPolicy,
  ): void;
  fail(code: Exclude<ReplyOperationFailureCode, "aborted_by_user">, cause?: unknown): void;
  abortByUser(): boolean;
  abortForRestart(): boolean;
};

export type ReplyRunRegistry = {
  begin(params: {
    sessionKey: string;
    sessionId: string;
    resetTriggered: boolean;
    routeThreadId?: string | number;
    originatingLeafEntryId?: string | null;
    upstreamAbortSignal?: AbortSignal;
  }): ReplyOperation;
  get(sessionKey: string): ReplyOperation | undefined;
  isActive(sessionKey: string): boolean;
  resolveMessageInjectionTarget(params: {
    sessionKey: string;
    originatingLeafEntryId: string | null | undefined;
    expectedRunId?: string;
  }): ReplyMessageInjectionTarget | undefined;
  abort(sessionKey: string): boolean;
  waitForIdle(
    sessionKey: string,
    timeoutMs?: number | null,
    opts?: { signal?: AbortSignal },
  ): Promise<boolean>;
  resolveSessionId(sessionKey: string): string | undefined;
};

export const REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS = 15_000;
// Terminal results must release the lane even if the owner never resumes.
// Without this, abort/failure can leave the session wedged until process restart.
export const REPLY_RUN_TERMINAL_SETTLE_TIMEOUT_MS = 60_000;

type ReplyOperationStaleReason = replyRunSettle.ReplyOperationStaleReason;

export class ReplyRunAlreadyActiveError extends Error {
  constructor(sessionKey: string) {
    super(`Reply run already active for ${sessionKey}`);
    this.name = "ReplyRunAlreadyActiveError";
  }
}

export class ReplyRunFollowupAdmissionBlockedError extends Error {
  constructor(sessionKey: string) {
    super(`Reply follow-up admission is blocked for ${sessionKey}`);
    this.name = "ReplyRunFollowupAdmissionBlockedError";
  }
}

export class ReplyRunSuccessorAdmissionBlockedError extends Error {
  constructor(sessionKey: string) {
    super(`Reply successor admission is blocked for ${sessionKey}`);
    this.name = "ReplyRunSuccessorAdmissionBlockedError";
  }
}
