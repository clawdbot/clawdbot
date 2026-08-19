// Command queue serializes and limits process execution for shared command lanes.
import { AsyncLocalStorage } from "node:async_hooks";
import { clampPositiveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { formatErrorMessage, readErrorName } from "../infra/errors.js";
import {
  diagnosticLogger as diag,
  logLaneDequeue,
  logLaneEnqueue,
} from "../logging/diagnostic-runtime.js";
import {
  canAdmitInGroup,
  type CommandLaneBlockReason,
  type CommandLaneGroupSpec,
  drainGroupSiblings,
  getGroupRegistry,
  getLaneGroup,
  getMemberActiveCount,
  installCommandLaneGroup,
  type LaneGroupState,
  resolveLaneBlockReason,
  validateCommandLaneGroupSpec,
} from "./command-queue.capacity-groups.js";
import {
  type CommandLaneTaskMarker,
  getQueueState,
  type LaneState,
  normalizeLane,
  type QueueEntry,
} from "./command-queue.state.js";
import type { CommandQueueEnqueueOptions } from "./command-queue.types.js";
import {
  GatewayDrainingError,
  isGatewaySubordinateWorkAdmissionClosed,
  isGatewayWorkAdmissionClosed,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  runWithGatewayRootWorkReadmission,
} from "./gateway-work-admission.js";
import { CommandLane } from "./lanes.js";
export { GatewayDrainingError } from "./gateway-work-admission.js";
export type { CommandLaneTaskMarker } from "./command-queue.state.js";
/**
 * Dedicated error type thrown when a queued command is rejected because
 * its lane was cleared.  Callers that fire-and-forget enqueued tasks can
 * catch (or ignore) this specific type to avoid unhandled-rejection noise.
 */
export class CommandLaneClearedError extends Error {
  constructor(lane?: string) {
    super(lane ? `Command lane "${lane}" cleared` : "Command lane cleared");
    this.name = "CommandLaneClearedError";
  }
}

/**
 * Dedicated error type thrown when an active command exceeds its caller-owned
 * lane timeout. The underlying task may still be unwinding, but the lane is
 * released so queued work is not blocked forever.
 */
class CommandLaneTaskTimeoutError extends Error {
  constructor(
    lane: string,
    details:
      | { cause: "task-budget"; elapsedMs: number; taskBudgetMs: number }
      | { cause: "progress-idle"; elapsedMs: number; idleMs: number; taskBudgetMs: number }
      | { cause: "abort-grace"; elapsedMs: number; graceMs: number; taskBudgetMs: number }
      | { cause: "release-signal"; elapsedMs: number; taskBudgetMs: number },
  ) {
    const message = (() => {
      switch (details.cause) {
        case "task-budget":
          return `elapsed ${details.elapsedMs}ms reached task budget ${details.taskBudgetMs}ms`;
        case "progress-idle":
          return `no progress for ${details.idleMs}ms (task budget ${details.taskBudgetMs}ms, elapsed ${details.elapsedMs}ms)`;
        case "abort-grace":
          return `abort grace ${details.graceMs}ms elapsed (task budget ${details.taskBudgetMs}ms, elapsed ${details.elapsedMs}ms)`;
        case "release-signal":
          return `lane release requested after ${details.elapsedMs}ms (task budget ${details.taskBudgetMs}ms)`;
        default:
          throw new TypeError("Unsupported command lane timeout cause");
      }
    })();
    super(`Command lane "${lane}" task timed out: ${message}`);
    this.name = "CommandLaneTaskTimeoutError";
  }
}

export function isCommandLaneTaskTimeoutError(err: unknown, lane?: string): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  if (!(err instanceof CommandLaneTaskTimeoutError || err.name === "CommandLaneTaskTimeoutError")) {
    return false;
  }
  return lane === undefined || err.message.includes(`Command lane "${lane}" task timed out`);
}

// Minimal in-process queue to serialize command executions.
// Default lane ("main") preserves the existing behavior. Additional lanes allow
// low-risk parallelism (e.g. cron jobs) without interleaving stdin / logs for
// the main auto-reply workflow.

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

function isExpectedNonErrorLaneFailure(err: unknown): boolean {
  return err instanceof Error && err.name === "LiveSessionModelSwitchError";
}

function isQuietProbeLane(lane: string): boolean {
  // setup-inference.ts retains its temp session key, so its derived session lane
  // needs the same expected-failure treatment as the explicit probe lane.
  return (
    lane.startsWith("auth-probe:") ||
    lane.startsWith("session:probe-") ||
    lane.startsWith("session:temp:setup-inference:probe-setup-inference-")
  );
}

function getLaneDepth(state: LaneState): number {
  return state.queue.length + state.activeTaskIds.size;
}

function createCommandLaneSnapshot(state: LaneState): CommandLaneSnapshot {
  const snapshot: CommandLaneSnapshot = {
    lane: state.lane,
    queuedCount: state.queue.length,
    activeCount: state.activeTaskIds.size,
    maxConcurrent: state.maxConcurrent,
    draining: state.draining,
    generation: state.generation,
    blockedBy: resolveLaneBlockReason(state.lane),
  };
  const group = getLaneGroup(state.lane);
  if (group) {
    let groupActive = 0;
    for (const member of group.members) {
      groupActive += getMemberActiveCount(member);
    }
    snapshot.group = group.group;
    snapshot.groupActive = groupActive;
    snapshot.groupBudget = group.budget;
    snapshot.reservedForLane = group.reservations.get(state.lane) ?? 0;
  }
  return snapshot;
}

function getLaneState(lane: string): LaneState {
  const queueState = getQueueState();
  const existing = queueState.lanes.get(lane);
  if (existing) {
    return existing;
  }
  const created: LaneState = {
    lane,
    queue: [],
    activeTaskIds: new Set(),
    maxConcurrent: 1,
    draining: false,
    generation: 0,
  };
  queueState.lanes.set(lane, created);
  return created;
}

function completeTask(state: LaneState, taskId: number, taskGeneration: number): boolean {
  if (taskGeneration !== state.generation) {
    return false;
  }
  state.activeTaskIds.delete(taskId);
  return true;
}

function retireIdleScopedCommandLane(state: LaneState): void {
  if (
    state.draining ||
    state.activeTaskIds.size > 0 ||
    state.queue.length > 0 ||
    state.maxConcurrent !== 1 ||
    (!state.lane.startsWith("session:") &&
      !state.lane.startsWith("nested:") &&
      !state.lane.startsWith("context-engine-turn-maintenance:"))
  ) {
    return;
  }

  const lanes = getQueueState().lanes;
  // A completed generation may race a recreated lane. Only retire the exact
  // idle scoped state after its pump has released the draining guard.
  if (lanes.get(state.lane) === state) {
    lanes.delete(state.lane);
  }
}

function normalizeTaskTimeoutMs(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return clampPositiveTimerTimeoutMs(value);
}

function resolveQueuePriority(priority: CommandQueueEnqueueOptions["priority"]): number {
  switch (priority) {
    case "foreground":
      return 1;
    case "background":
      return -1;
    default:
      return 0;
  }
}

function enqueueLaneEntry(state: LaneState, entry: QueueEntry): void {
  const insertAt = state.queue.findIndex(
    (queued) =>
      queued.priority < entry.priority ||
      (queued.priority === entry.priority && queued.sequence > entry.sequence),
  );
  entry.queuedAheadAtEnqueue = insertAt < 0 ? state.queue.length : insertAt;
  entry.activeAheadAtEnqueue = state.activeTaskIds.size;
  if (insertAt < 0) {
    state.queue.push(entry);
    return;
  }
  state.queue.splice(insertAt, 0, entry);
}

async function runQueueEntryTask(
  lane: string,
  entry: QueueEntry,
  marker: CommandLaneTaskMarker,
): Promise<unknown> {
  const taskPromise = Promise.resolve().then(() => entry.task(marker));
  const taskTimeoutMs = normalizeTaskTimeoutMs(entry.taskTimeoutMs);
  if (taskTimeoutMs === undefined) {
    return await taskPromise;
  }

  const taskTimeoutAbortGraceMs =
    normalizeTaskTimeoutMs(entry.taskTimeoutAbortGraceMs) ?? taskTimeoutMs;
  const startedAtMs = Date.now();
  const readLastProgressAtMs = () => {
    let value: number | undefined;
    try {
      value = entry.taskTimeoutProgressAtMs?.();
    } catch (err) {
      diag.warn(`lane task timeout progress callback failed: lane=${lane} error="${String(err)}"`);
    }
    return typeof value === "number" && Number.isFinite(value) && value > 0
      ? Math.max(startedAtMs, Math.floor(value))
      : startedAtMs;
  };
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener: (() => void) | undefined;
  let removeReleaseListener: (() => void) | undefined;
  let timedOut = false;
  const timeoutPromise = new Promise<never>((_, reject) => {
    const elapsedSinceStartMs = () => Math.max(0, Date.now() - startedAtMs);
    const rejectForTimeout = (
      details:
        | { cause: "task-budget" }
        | { cause: "progress-idle"; idleMs: number }
        | { cause: "abort-grace"; graceMs: number }
        | { cause: "release-signal" },
    ) => {
      timedOut = true;
      reject(
        new CommandLaneTaskTimeoutError(lane, {
          ...details,
          elapsedMs: elapsedSinceStartMs(),
          taskBudgetMs: taskTimeoutMs,
        }),
      );
    };
    const armTimer = (delayMs: number, onTimeout: () => void) => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      if (delayMs <= 0) {
        onTimeout();
        return;
      }
      timeoutHandle = setTimeout(onTimeout, delayMs);
      timeoutHandle.unref?.();
    };
    const armProgressTimeout = () => {
      const elapsedMs = Math.max(0, Date.now() - readLastProgressAtMs());
      const remainingMs = taskTimeoutMs - elapsedMs;
      if (remainingMs <= 0) {
        rejectForTimeout(
          entry.taskTimeoutProgressAtMs
            ? { cause: "progress-idle", idleMs: elapsedMs }
            : { cause: "task-budget" },
        );
        return;
      }
      armTimer(remainingMs, armProgressTimeout);
    };
    const armAbortTimeout = () => {
      const abortStartedAtMs = Date.now();
      armTimer(taskTimeoutAbortGraceMs, () =>
        rejectForTimeout({
          cause: "abort-grace",
          graceMs: Math.max(0, Date.now() - abortStartedAtMs),
        }),
      );
    };
    const abortSignal = entry.taskTimeoutAbortSignal;
    const releaseSignal = entry.taskTimeoutReleaseSignal;
    const onRelease = () => {
      removeReleaseListener?.();
      rejectForTimeout({ cause: "release-signal" });
    };
    if (releaseSignal?.aborted) {
      onRelease();
      return;
    }
    if (abortSignal?.aborted) {
      armAbortTimeout();
      return;
    }
    armProgressTimeout();
    if (abortSignal) {
      const onAbort = () => {
        removeAbortListener?.();
        armAbortTimeout();
      };
      abortSignal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => abortSignal.removeEventListener("abort", onAbort);
    }
    if (releaseSignal) {
      releaseSignal.addEventListener("abort", onRelease, { once: true });
      removeReleaseListener = () => releaseSignal.removeEventListener("abort", onRelease);
    }
  });

  try {
    return await Promise.race([taskPromise, timeoutPromise]);
  } catch (err) {
    if (timedOut) {
      void taskPromise.catch((lateErr: unknown) => {
        diag.warn(
          `lane task rejected after timeout: lane=${lane} timeoutMs=${taskTimeoutMs} error="${String(lateErr)}"`,
        );
      });
    }
    throw err;
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
    removeAbortListener?.();
    removeReleaseListener?.();
  }
}

function drainLane(
  lane: string,
  maxStarts = Number.POSITIVE_INFINITY,
  state = getLaneState(lane),
): number {
  if (state.draining) {
    if (state.activeTaskIds.size === 0 && state.queue.length > 0) {
      diag.warn(
        `drainLane blocked: lane=${lane} draining=true active=0 queue=${state.queue.length}`,
      );
    }
    return 0;
  }
  state.draining = true;
  let started = 0;
  try {
    while (
      started < maxStarts &&
      state.activeTaskIds.size < state.maxConcurrent &&
      state.queue.length > 0 &&
      canAdmitInGroup(lane)
    ) {
      const entry = state.queue.shift() as QueueEntry;
      const waitedMs = Date.now() - entry.enqueuedAt;
      const activeBeforeStart = state.activeTaskIds.size;
      const taskId = getQueueState().nextTaskId++;
      const taskGeneration = state.generation;
      // Commit the admission before invoking callbacks or logging. Both can
      // synchronously re-enter the queue, and the shared budget must already
      // account for this task when that nested admission is evaluated.
      state.activeTaskIds.add(taskId);
      started += 1;
      if (waitedMs >= entry.warnAfterMs) {
        try {
          entry.onWait?.(waitedMs, entry.queuedAheadAtEnqueue);
        } catch (err) {
          diag.error(`lane onWait callback failed: lane=${lane} error="${String(err)}"`);
        }
        diag.warn(
          `lane wait exceeded: lane=${lane} waitedMs=${waitedMs} queueAhead=${entry.queuedAheadAtEnqueue} ` +
            `activeAhead=${entry.activeAheadAtEnqueue} activeNow=${activeBeforeStart} queueBehind=${state.queue.length}`,
        );
      }
      logLaneDequeue(lane, waitedMs, state.queue.length);
      void (async () => {
        const startTime = Date.now();
        try {
          const result = await runQueueEntryTask(lane, entry, {
            lane,
            taskId,
            generation: taskGeneration,
          });
          const completedCurrentGeneration = completeTask(state, taskId, taskGeneration);
          if (completedCurrentGeneration) {
            diag.debug(
              `lane task done: lane=${lane} durationMs=${Date.now() - startTime} active=${state.activeTaskIds.size} queued=${state.queue.length}`,
            );
            drainReadyCommandLane(lane, state);
          }
          entry.resolve(result);
        } catch (err) {
          const completedCurrentGeneration = completeTask(state, taskId, taskGeneration);
          const isProbeLane = isQuietProbeLane(lane);
          if (!isProbeLane && !isExpectedNonErrorLaneFailure(err)) {
            diag.error(
              `lane task error: lane=${lane} durationMs=${Date.now() - startTime} error="${formatErrorMessage(err)}"`,
              { errorName: readErrorName(err) || undefined },
            );
          } else if (!isProbeLane) {
            diag.debug(
              `lane task interrupted: lane=${lane} durationMs=${Date.now() - startTime} reason="${String(err)}"`,
            );
          }
          if (completedCurrentGeneration) {
            drainReadyCommandLane(lane, state);
          }
          entry.reject(err);
        }
      })();
    }
  } finally {
    state.draining = false;
    retireIdleScopedCommandLane(state);
  }
  return started;
}

function drainReadyCommandLane(lane: string, completedState?: LaneState): void {
  if (getLaneGroup(lane)) {
    drainGroupSiblings(lane, drainLane);
    return;
  }
  // An idle scoped lane may have been retired and recreated while an older
  // task was finishing. Preserve the completion's captured state so its drain
  // cannot retire a newer registry entry that it never owned.
  drainLane(lane, Number.POSITIVE_INFINITY, completedState);
}

/**
 * Mark gateway as draining for restart so new enqueues fail fast with
 * `GatewayDrainingError` instead of being silently killed on shutdown.
 */
export function markGatewayDraining(): void {
  markGatewayRestartDraining();
}

export function isGatewayDraining(): boolean {
  return isGatewayWorkAdmissionClosed();
}

/**
 * Apply lane concurrencies and group definitions as ONE transaction.
 *
 * `setCommandLaneConcurrency` drains the instant a lane goes positive, and
 * gateway publication is sequential — so applying lanes one at a time can widen
 * a member and let it dispatch BEFORE its group exists, admitting work above
 * the budget the group was meant to enforce. Suppressing drains until every
 * lane max and every group definition is installed closes that window; a single
 * commit-time drain pass then dispatches under the final configuration.
 *
 * Callers must route grouped lanes through here rather than the per-lane
 * setter, which cannot know about a group that does not exist yet.
 */
export function publishLaneConfiguration(config: {
  lanes?: Readonly<Record<string, number>>;
  groups?: Readonly<Record<string, CommandLaneGroupSpec>>;
  /** Groups to remove as part of the same transaction. */
  clearGroups?: readonly string[];
}): void {
  // Phase 0 — validate EVERYTHING before mutating anything. Validating inside
  // the install loop would leave already-widened lanes behind on a throw:
  // governed by no group, and dispatching their preserved queue on the next
  // unrelated drain trigger. Rejection must be a no-op, not a partial apply.
  const validated: LaneGroupState[] = [];
  for (const [group, spec] of Object.entries(config.groups ?? {})) {
    validated.push(validateCommandLaneGroupSpec(group, spec));
  }

  const touched = new Set<string>();
  // Phase 1 — install state with dispatch suppressed. Nothing may start here.
  for (const [rawLane, maxConcurrent] of Object.entries(config.lanes ?? {})) {
    const lane = normalizeLane(rawLane);
    const state = getLaneState(lane);
    const minConcurrent = isQuietProbeLane(lane) ? 1 : 0;
    state.maxConcurrent = Math.max(minConcurrent, Math.floor(maxConcurrent));
    touched.add(lane);
  }
  for (const group of config.clearGroups ?? []) {
    const { groups, groupByLane } = getGroupRegistry();
    const existing = groups.get(group);
    if (existing) {
      for (const member of existing.members) {
        groupByLane.delete(member);
        touched.add(member);
      }
      groups.delete(group);
    }
  }
  for (const next of validated) {
    const { groups, groupByLane } = getGroupRegistry();
    const previous = groups.get(next.group);
    for (const member of previous?.members ?? []) {
      touched.add(member);
    }
    for (const member of next.members) {
      const previousOwner = groupByLane.get(member);
      for (const previousSibling of groups.get(previousOwner ?? "")?.members ?? []) {
        touched.add(previousSibling);
      }
    }
    installCommandLaneGroup(next);
    for (const member of next.members) {
      touched.add(member);
    }
  }
  // Phase 2 — commit. Group membership and budgets are now final, so every
  // admission decision in this pass sees the configuration the caller intended.
  for (const lane of touched) {
    const state = getQueueState().lanes.get(lane);
    if (state && state.maxConcurrent > 0 && state.queue.length > 0 && !state.draining) {
      drainReadyCommandLane(lane);
    }
  }
}

export function setCommandLaneConcurrency(lane: string, maxConcurrent: number) {
  const cleaned = normalizeLane(lane);
  const state = getLaneState(cleaned);
  const isProbeLane = isQuietProbeLane(cleaned);
  const minConcurrent = isProbeLane ? 1 : 0;
  state.maxConcurrent = Math.max(minConcurrent, Math.floor(maxConcurrent));
  if (state.maxConcurrent > 0) {
    drainReadyCommandLane(cleaned);
  }
}

export function enqueueCommandInLane<T>(
  lane: string,
  task: (marker: CommandLaneTaskMarker) => Promise<T>,
  opts?: CommandQueueEnqueueOptions,
): Promise<T> {
  const queueState = getQueueState();
  if (isGatewaySubordinateWorkAdmissionClosed()) {
    return Promise.reject(new GatewayDrainingError());
  }
  const runInAsyncContext = AsyncLocalStorage.snapshot();
  const cleaned = normalizeLane(lane);
  const warnAfterMs = opts?.warnAfterMs ?? 2_000;
  const state = getLaneState(cleaned);
  return new Promise<T>((resolve, reject) => {
    enqueueLaneEntry(state, {
      task: (marker) => runInAsyncContext(runWithGatewayRootWorkReadmission, () => task(marker)),
      resolve: (value) => resolve(value as T),
      reject,
      enqueuedAt: Date.now(),
      sequence: queueState.nextQueueSequence++,
      priority: resolveQueuePriority(opts?.priority),
      warnAfterMs,
      queuedAheadAtEnqueue: 0,
      activeAheadAtEnqueue: 0,
      taskTimeoutMs: normalizeTaskTimeoutMs(opts?.taskTimeoutMs),
      taskTimeoutProgressAtMs: opts?.taskTimeoutProgressAtMs,
      taskTimeoutAbortSignal: opts?.taskTimeoutAbortSignal,
      taskTimeoutAbortGraceMs: normalizeTaskTimeoutMs(opts?.taskTimeoutAbortGraceMs),
      taskTimeoutReleaseSignal: opts?.taskTimeoutReleaseSignal,
      onWait: opts?.onWait,
    });
    logLaneEnqueue(cleaned, getLaneDepth(state));
    drainReadyCommandLane(cleaned);
  });
}

export function getQueueSize(lane: string = CommandLane.Main) {
  const resolved = normalizeLane(lane);
  const state = getQueueState().lanes.get(resolved);
  if (!state) {
    return 0;
  }
  return getLaneDepth(state);
}

export function getCommandLaneSnapshot(lane: string = CommandLane.Main): CommandLaneSnapshot {
  const resolved = normalizeLane(lane);
  const state = getQueueState().lanes.get(resolved);
  if (!state) {
    // The lane may not exist yet (first enqueue) or may have been retired while
    // idle, but it can still be a configured group member — and a caller asking
    // "can this lane start work?" needs the group answer, not a bare default.
    const group = getLaneGroup(resolved);
    const empty: CommandLaneSnapshot = {
      lane: resolved,
      queuedCount: 0,
      activeCount: 0,
      maxConcurrent: 1,
      draining: false,
      generation: 0,
      blockedBy: resolveLaneBlockReason(resolved),
    };
    if (group) {
      let groupActive = 0;
      for (const member of group.members) {
        groupActive += getMemberActiveCount(member);
      }
      empty.group = group.group;
      empty.groupActive = groupActive;
      empty.groupBudget = group.budget;
      empty.reservedForLane = group.reservations.get(resolved) ?? 0;
    }
    return empty;
  }
  return createCommandLaneSnapshot(state);
}

/** Per-lane work totals for every live lane; diagnostics composition lives in command-lane-diagnostics.ts. */
export function listCommandLaneTotals(): Array<{
  lane: string;
  activeCount: number;
  queuedCount: number;
}> {
  return [...getQueueState().lanes.values()].map((state) => ({
    lane: state.lane,
    activeCount: state.activeTaskIds.size,
    queuedCount: state.queue.length,
  }));
}

/**
 * Active task ids for a lane. Ids are process-monotonic, so recovery can
 * detect a turn that started after a point in time it captured earlier.
 */
export function getCommandLaneActiveTaskIds(lane: string = CommandLane.Main): number[] {
  const state = getQueueState().lanes.get(normalizeLane(lane));
  return state ? [...state.activeTaskIds] : [];
}

/** Return whether this exact lane task still owns an active queue slot. */
export function isCommandLaneTaskMarkerCurrent(marker: CommandLaneTaskMarker | undefined): boolean {
  if (!marker) {
    return false;
  }
  const state = getQueueState().lanes.get(normalizeLane(marker.lane));
  return state?.generation === marker.generation && state.activeTaskIds.has(marker.taskId);
}

export function getTotalQueueSize() {
  let total = 0;
  for (const s of getQueueState().lanes.values()) {
    total += getLaneDepth(s);
  }
  return total;
}

export function clearCommandLane(lane: string = CommandLane.Main) {
  const cleaned = normalizeLane(lane);
  const state = getQueueState().lanes.get(cleaned);
  if (!state) {
    return 0;
  }
  const removed = state.queue.length;
  const pending = state.queue.splice(0);
  for (const entry of pending) {
    entry.reject(new CommandLaneClearedError(cleaned));
  }
  return removed;
}

/**
 * Force a single lane back to idle and immediately pump any queued entries.
 * Used only by recovery paths after the owner has already attempted to abort
 * the active work; stale completions from the previous generation are ignored.
 */
export function resetCommandLane(lane: string = CommandLane.Main): number {
  const cleaned = normalizeLane(lane);
  const state = getQueueState().lanes.get(cleaned);
  if (!state) {
    return 0;
  }
  const released = state.activeTaskIds.size;
  state.generation += 1;
  state.activeTaskIds.clear();
  state.draining = false;
  // Clearing activeTaskIds may release multiple shared slots. Re-arbitrate the
  // whole group so the reset lane cannot reclaim them ahead of older siblings.
  drainReadyCommandLane(cleaned);
  return released;
}

/**
 * Reset all lane runtime state to idle. Used after SIGUSR1 in-process
 * restarts where interrupted tasks' finally blocks may not run, leaving
 * stale active task IDs that permanently block new work from draining.
 *
 * Bumps lane generation and clears execution counters so stale completions
 * from old in-flight tasks are ignored. Queued entries are intentionally
 * preserved — they represent pending user work that should still execute
 * after restart.
 *
 * After resetting, drains any lanes that still have queued entries so
 * preserved work is pumped immediately rather than waiting for a future
 * `enqueueCommandInLane()` call (which may never come).
 */
export function resetAllLanes(): void {
  const queueState = getQueueState();
  resetGatewayWorkAdmission();
  const lanesToDrain: string[] = [];
  for (const state of queueState.lanes.values()) {
    state.generation += 1;
    state.activeTaskIds.clear();
    state.draining = false;
    if (state.queue.length > 0) {
      lanesToDrain.push(state.lane);
    }
  }
  // Drain after the full reset pass so all lanes are in a clean state first.
  for (const lane of lanesToDrain) {
    drainReadyCommandLane(lane);
  }
}
