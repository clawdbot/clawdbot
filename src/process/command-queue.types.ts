/** Why a lane cannot admit, from the narrowest cause outward. */
export type CommandLaneBlockReason = "lane" | "group-budget" | "sibling-reservation" | null;

export type CommandLaneSnapshot = {
  lane: string;
  queuedCount: number;
  activeCount: number;
  maxConcurrent: number;
  draining: boolean;
  generation: number;
  /** Group this lane belongs to, if any. */
  group?: string;
  /** Sum of active tasks across every member of the group. Always derived. */
  groupActive?: number;
  /** Hard aggregate cap shared by the group's members. */
  groupBudget?: number;
  /** Slots within the budget this lane may always claim. */
  reservedForLane?: number;
  /**
   * Why this lane cannot start more work right now, or null if it can.
   * `lane` is the lane's own maxConcurrent; the other two are group-imposed and
   * are invisible to a lane-local view — see `noteLaneWaitIfBusy`.
   */
  blockedBy?: CommandLaneBlockReason;
};

/**
 * Public enqueue knobs shared by command-lane callers and narrower injection
 * points that should not import the full queue implementation.
 */
export type CommandQueueTaskDeadline =
  | { kind: "bounded"; deadlineAtMs: number }
  | { kind: "unlimited" };

export type CommandQueueEnqueueOptions = {
  /** Cancels queued admission; the task owns cancellation after it starts. */
  abortSignal?: AbortSignal;
  /** Called only when this entry remains queued after immediate lane admission. */
  onQueued?: () => void;
  warnAfterMs?: number;
  onWait?: (waitMs: number, queuedAhead: number) => void;
  taskTimeoutMs?: number;
  taskTimeoutProgressAtMs?: () => number | undefined;
  /** Replaces idle timing with an owner deadline; undefined restores idle timing. */
  taskTimeoutSubscribe?: (
    onDeadline: (deadline: CommandQueueTaskDeadline | undefined) => void,
  ) => () => void;
  taskTimeoutAbortSignal?: AbortSignal;
  taskTimeoutAbortGraceMs?: number;
  /** Ends the task after a caller-owned timeout cleanup grace has already elapsed. */
  taskTimeoutReleaseSignal?: AbortSignal;
  priority?: "foreground" | "normal" | "background";
};

/** Minimal queue function contract used by code that only needs to schedule work. */
export type CommandQueueEnqueueFn = <T>(
  task: () => Promise<T>,
  opts?: CommandQueueEnqueueOptions,
) => Promise<T>;
