// Command queue serializes and limits process execution for shared command lanes.
import {
  diagnosticLogger as diag,
  logLaneDequeue,
  logLaneEnqueue,
} from "../logging/diagnostic-runtime.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { clampPositiveTimerTimeoutMs } from "../shared/number-coercion.js";
import type { CommandQueueEnqueueOptions } from "./command-queue.types.js";
import {
  GatewayDrainingError,
  isGatewaySubordinateWorkAdmissionClosed,
  isGatewayWorkAdmissionClosed,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "./gateway-work-admission.js";
export { GatewayDrainingError } from "./gateway-work-admission.js";
import { CommandLane } from "./lanes.js";
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

export type CommandLaneTaskMarker = Readonly<{
  lane: string;
  taskId: number;
  generation: number;
}>;

type QueueEntry = {
  task: (marker: CommandLaneTaskMarker) => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  enqueuedAt: number;
  sequence: number;
  priority: number;
  warnAfterMs: number;
  queuedAheadAtEnqueue: number;
  activeAheadAtEnqueue: number;
  taskTimeoutMs?: number;
  taskTimeoutProgressAtMs?: () => number | undefined;
  taskTimeoutAbortSignal?: AbortSignal;
  taskTimeoutAbortGraceMs?: number;
  taskTimeoutReleaseSignal?: AbortSignal;
  onWait?: (waitMs: number, queuedAhead: number) => void;
};

type LaneState = {
  lane: string;
  queue: QueueEntry[];
  activeTaskIds: Set<number>;
  maxConcurrent: number;
  draining: boolean;
  generation: number;
};

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

/** Why a lane cannot admit, from the narrowest cause outward. */
export type CommandLaneBlockReason = "lane" | "group-budget" | "sibling-reservation" | null;

/** Declares a group's shared budget and its members' hard reservations. */
export type CommandLaneGroupSpec = {
  /** Hard aggregate cap across all members. */
  budget: number;
  members: readonly string[];
  /** Slots a member may always claim, non-borrowable by siblings. */
  reservations?: Readonly<Record<string, number>>;
};

type LaneGroupState = {
  group: string;
  budget: number;
  members: Set<string>;
  reservations: Map<string, number>;
};

/**
 * Lanes that must never join a group, because a group member can be made to
 * wait for a sibling and these lanes can be synchronously awaited by other
 * lanes — which would turn a wait into a deadlock.
 *
 * Known wait edges at this base: outer `cron` -> `cron-nested`
 * (`server-cron.ts` passes lane "cron"; `agents/lanes.ts` remaps inner work),
 * and `session:<key>` -> global lane (embedded-agent-runner run + compaction).
 */
const GROUP_INELIGIBLE_LANES: ReadonlySet<string> = new Set<string>([
  CommandLane.Cron,
  CommandLane.Main,
  CommandLane.Subagent,
  CommandLane.Nested,
]);

const GROUP_INELIGIBLE_PREFIXES = ["session:", "nested:", "context-engine-turn-maintenance:"];

function assertGroupEligibleLane(lane: string): void {
  if (GROUP_INELIGIBLE_LANES.has(lane)) {
    throw new Error(
      `command lane "${lane}" cannot join a capacity group: it can be synchronously awaited by another lane`,
    );
  }
  for (const prefix of GROUP_INELIGIBLE_PREFIXES) {
    if (lane.startsWith(prefix)) {
      throw new Error(
        `command lane "${lane}" cannot join a capacity group: "${prefix}*" lanes can be synchronously awaited`,
      );
    }
  }
}

type ActiveTaskWaiter = {
  activeTaskIds: Set<number>;
  resolve: (value: { drained: boolean }) => void;
  timeout?: ReturnType<typeof setTimeout>;
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

/**
 * Keep queue runtime state on globalThis so every bundled entry/chunk shares
 * the same lanes, counters, and draining flag in production builds.
 */
const COMMAND_QUEUE_STATE_KEY = Symbol.for("openclaw.commandQueueState");

function getQueueState() {
  const state = resolveGlobalSingleton(COMMAND_QUEUE_STATE_KEY, () => ({
    lanes: new Map<string, LaneState>(),
    activeTaskWaiters: new Set<ActiveTaskWaiter>(),
    nextTaskId: 1,
    nextQueueSequence: 1,
  }));
  // Schema migration: the singleton may have been created by an older code
  // version (e.g. v2026.4.2) that did not include `activeTaskWaiters`.  After
  // a SIGUSR1 in-process restart the new code inherits the stale object via
  // `resolveGlobalSingleton` because the Symbol key already exists on
  // globalThis.  Patch the missing field so all downstream consumers see a
  // valid Set instead of `undefined`.
  if (!state.activeTaskWaiters) {
    state.activeTaskWaiters = new Set<ActiveTaskWaiter>();
  }
  if (!state.nextQueueSequence) {
    state.nextQueueSequence = 1;
  }
  let maxQueueSequence = state.nextQueueSequence - 1;
  for (const lane of state.lanes.values()) {
    for (const [index, entry] of (
      lane.queue as Array<
        QueueEntry & {
          activeAheadAtEnqueue?: number;
          priority?: number;
          queuedAheadAtEnqueue?: number;
          sequence?: number;
        }
      >
    ).entries()) {
      if (typeof entry.priority !== "number") {
        entry.priority = 0;
      }
      if (typeof entry.sequence !== "number") {
        entry.sequence = state.nextQueueSequence++;
      } else {
        maxQueueSequence = Math.max(maxQueueSequence, entry.sequence);
      }
      if (typeof entry.queuedAheadAtEnqueue !== "number") {
        entry.queuedAheadAtEnqueue = index;
      }
      if (typeof entry.activeAheadAtEnqueue !== "number") {
        entry.activeAheadAtEnqueue = lane.activeTaskIds.size;
      }
    }
  }
  if (state.nextQueueSequence <= maxQueueSequence) {
    state.nextQueueSequence = maxQueueSequence + 1;
  }
  return state;
}

function normalizeLane(lane: string): string {
  return lane.trim() || CommandLane.Main;
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

function hasPendingActiveTasks(taskIds: Set<number>): boolean {
  const queueState = getQueueState();
  for (const state of queueState.lanes.values()) {
    for (const taskId of state.activeTaskIds) {
      if (taskIds.has(taskId)) {
        return true;
      }
    }
  }
  return false;
}

function resolveActiveTaskWaiter(waiter: ActiveTaskWaiter, result: { drained: boolean }): void {
  const queueState = getQueueState();
  if (!queueState.activeTaskWaiters.delete(waiter)) {
    return;
  }
  if (waiter.timeout) {
    clearTimeout(waiter.timeout);
  }
  waiter.resolve(result);
}

function notifyActiveTaskWaiters(): void {
  const queueState = getQueueState();
  for (const waiter of Array.from(queueState.activeTaskWaiters)) {
    if (waiter.activeTaskIds.size === 0 || !hasPendingActiveTasks(waiter.activeTaskIds)) {
      resolveActiveTaskWaiter(waiter, { drained: true });
    }
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

/** Group registry, keyed by group id and by member lane name. */
function getGroupRegistry(): {
  groups: Map<string, LaneGroupState>;
  groupByLane: Map<string, string>;
} {
  const state = getQueueState() as unknown as {
    laneGroups?: Map<string, LaneGroupState>;
    laneGroupByLane?: Map<string, string>;
  };
  // Migration: an older singleton (pre-upgrade, inherited via globalThis after
  // a SIGUSR1 in-process restart) has neither field. Active counts are derived,
  // so a late-initialized registry cannot desynchronize from lane state.
  if (!state.laneGroups) {
    state.laneGroups = new Map<string, LaneGroupState>();
  }
  if (!state.laneGroupByLane) {
    state.laneGroupByLane = new Map<string, string>();
  }
  return { groups: state.laneGroups, groupByLane: state.laneGroupByLane };
}

function getLaneGroup(lane: string): LaneGroupState | undefined {
  const { groups, groupByLane } = getGroupRegistry();
  const groupId = groupByLane.get(lane);
  return groupId ? groups.get(groupId) : undefined;
}

/**
 * Active task count for a group member WITHOUT creating the lane. Creating it
 * here would resurrect lanes that `retireIdleScopedCommandLane` just removed.
 */
function getMemberActiveCount(lane: string): number {
  return getQueueState().lanes.get(lane)?.activeTaskIds.size ?? 0;
}

/**
 * Why `lane` cannot admit another task, or null if it can.
 *
 * Group capacity is always DERIVED from members' `activeTaskIds`, never tracked
 * in a separate counter. That is what makes timeout, abort, clear, reset and
 * stale-generation completion release capacity for free: they all remove the
 * task id, so the next admission decision simply sees a smaller number. The
 * only remaining obligation is that those paths re-drain the group.
 */
function resolveLaneBlockReason(lane: string): CommandLaneBlockReason {
  const state = getQueueState().lanes.get(lane);
  if (state && state.activeTaskIds.size >= state.maxConcurrent) {
    return "lane";
  }
  const group = getLaneGroup(lane);
  if (!group) {
    return null;
  }
  let groupActive = 0;
  let siblingReserveHeld = 0;
  for (const member of group.members) {
    const active = getMemberActiveCount(member);
    groupActive += active;
    if (member !== lane) {
      // Unused portion of a sibling's reservation. Held back even while that
      // sibling is idle — a hard reservation that siblings can borrow is not a
      // reservation at all.
      siblingReserveHeld += Math.max(0, (group.reservations.get(member) ?? 0) - active);
    }
  }
  if (groupActive >= group.budget) {
    return "group-budget";
  }
  // Own reservation still unfilled: admit regardless of what siblings hold.
  if (getMemberActiveCount(lane) < (group.reservations.get(lane) ?? 0)) {
    return null;
  }
  // Otherwise this task would be borrowing unreserved capacity, which must not
  // eat into what siblings are guaranteed.
  return groupActive + siblingReserveHeld < group.budget ? null : "sibling-reservation";
}

function canAdmitInGroup(lane: string): boolean {
  const reason = resolveLaneBlockReason(lane);
  return reason === null || reason === "lane";
}

/**
 * Re-drain every OTHER member of `lane`'s group. Capacity that a completion
 * frees belongs to the group, not to the lane that freed it, so a lane-local
 * pump would leave siblings queued behind capacity that is already available.
 */
function drainGroupSiblings(lane: string): void {
  const group = getLaneGroup(lane);
  if (!group) {
    return;
  }
  for (const member of group.members) {
    if (member === lane) {
      continue;
    }
    const state = getQueueState().lanes.get(member);
    if (state && state.queue.length > 0 && !state.draining) {
      drainLane(member);
    }
  }
}

/**
 * Define or replace a capacity group.
 *
 * Membership is held here, keyed by lane name, and deliberately NOT inside
 * `LaneState`: `setCommandLaneConcurrency` must not be able to detach a lane
 * from its group, or session suspend/resume would silently restore a member to
 * ungoverned concurrency.
 */
export function setCommandLaneGroup(group: string, spec: CommandLaneGroupSpec): void {
  const members = spec.members.map((member) => normalizeLane(member));
  for (const member of members) {
    assertGroupEligibleLane(member);
  }
  const reservations = new Map<string, number>();
  let reservedTotal = 0;
  for (const [rawLane, count] of Object.entries(spec.reservations ?? {})) {
    const member = normalizeLane(rawLane);
    if (!members.includes(member)) {
      throw new Error(`command lane group "${group}" reserves for non-member lane "${member}"`);
    }
    const reserved = Math.max(0, Math.floor(count));
    reservations.set(member, reserved);
    reservedTotal += reserved;
  }
  const budget = Math.max(0, Math.floor(spec.budget));
  if (reservedTotal > budget) {
    // Silent starvation otherwise: reservations that cannot all be honoured
    // would permanently withhold capacity no member is able to claim.
    throw new Error(
      `command lane group "${group}" reserves ${reservedTotal} slots but its budget is ${budget}`,
    );
  }
  const { groups, groupByLane } = getGroupRegistry();
  const previous = groups.get(group);
  if (previous) {
    for (const member of previous.members) {
      groupByLane.delete(member);
    }
  }
  groups.set(group, { group, budget, members: new Set(members), reservations });
  for (const member of members) {
    groupByLane.set(member, group);
  }
}

/** Remove a group and release its members back to lane-local admission. */
export function clearCommandLaneGroup(group: string): void {
  const { groups, groupByLane } = getGroupRegistry();
  const existing = groups.get(group);
  if (!existing) {
    return;
  }
  for (const member of existing.members) {
    groupByLane.delete(member);
  }
  groups.delete(group);
  for (const member of existing.members) {
    const state = getQueueState().lanes.get(member);
    if (state && state.queue.length > 0 && !state.draining) {
      drainLane(member);
    }
  }
}

/** Drain every member of a group. Used after a configuration publish. */
export function drainCommandLaneGroup(group: string): void {
  const { groups } = getGroupRegistry();
  const existing = groups.get(group);
  if (!existing) {
    return;
  }
  for (const member of existing.members) {
    const state = getQueueState().lanes.get(member);
    if (state && state.queue.length > 0 && !state.draining) {
      drainLane(member);
    }
  }
}

function drainLane(lane: string) {
  const state = getLaneState(lane);
  if (state.draining) {
    if (state.activeTaskIds.size === 0 && state.queue.length > 0) {
      diag.warn(
        `drainLane blocked: lane=${lane} draining=true active=0 queue=${state.queue.length}`,
      );
    }
    return;
  }
  state.draining = true;

  const pump = () => {
    try {
      while (
        state.activeTaskIds.size < state.maxConcurrent &&
        state.queue.length > 0 &&
        canAdmitInGroup(lane)
      ) {
        const entry = state.queue.shift() as QueueEntry;
        const waitedMs = Date.now() - entry.enqueuedAt;
        if (waitedMs >= entry.warnAfterMs) {
          try {
            entry.onWait?.(waitedMs, entry.queuedAheadAtEnqueue);
          } catch (err) {
            diag.error(`lane onWait callback failed: lane=${lane} error="${String(err)}"`);
          }
          diag.warn(
            `lane wait exceeded: lane=${lane} waitedMs=${waitedMs} queueAhead=${entry.queuedAheadAtEnqueue} ` +
              `activeAhead=${entry.activeAheadAtEnqueue} activeNow=${state.activeTaskIds.size} queueBehind=${state.queue.length}`,
          );
        }
        logLaneDequeue(lane, waitedMs, state.queue.length);
        const taskId = getQueueState().nextTaskId++;
        const taskGeneration = state.generation;
        state.activeTaskIds.add(taskId);
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
              notifyActiveTaskWaiters();
              diag.debug(
                `lane task done: lane=${lane} durationMs=${Date.now() - startTime} active=${state.activeTaskIds.size} queued=${state.queue.length}`,
              );
              pump();
              // Freed capacity belongs to the group, not to this lane.
              drainGroupSiblings(lane);
            }
            entry.resolve(result);
          } catch (err) {
            const completedCurrentGeneration = completeTask(state, taskId, taskGeneration);
            const isProbeLane = isQuietProbeLane(lane);
            if (!isProbeLane && !isExpectedNonErrorLaneFailure(err)) {
              diag.error(
                `lane task error: lane=${lane} durationMs=${Date.now() - startTime} error="${String(err)}"`,
              );
            } else if (!isProbeLane) {
              diag.debug(
                `lane task interrupted: lane=${lane} durationMs=${Date.now() - startTime} reason="${String(err)}"`,
              );
            }
            if (completedCurrentGeneration) {
              notifyActiveTaskWaiters();
              pump();
              // A failed task releases group capacity exactly like a successful
              // one; siblings must be woken on both paths.
              drainGroupSiblings(lane);
            }
            entry.reject(err);
          }
        })();
      }
    } finally {
      state.draining = false;
      retireIdleScopedCommandLane(state);
    }
  };

  pump();
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

export function setCommandLaneConcurrency(lane: string, maxConcurrent: number) {
  const cleaned = normalizeLane(lane);
  const state = getLaneState(cleaned);
  const isProbeLane = isQuietProbeLane(cleaned);
  const minConcurrent = isProbeLane ? 1 : 0;
  state.maxConcurrent = Math.max(minConcurrent, Math.floor(maxConcurrent));
  if (state.maxConcurrent > 0) {
    drainLane(cleaned);
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
  const cleaned = normalizeLane(lane);
  const warnAfterMs = opts?.warnAfterMs ?? 2_000;
  const state = getLaneState(cleaned);
  return new Promise<T>((resolve, reject) => {
    enqueueLaneEntry(state, {
      task: (marker) => task(marker),
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
    drainLane(cleaned);
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
  if (state.queue.length > 0) {
    drainLane(cleaned);
  }
  // Clearing activeTaskIds released group capacity; siblings may now admit.
  drainGroupSiblings(cleaned);
  notifyActiveTaskWaiters();
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
    drainLane(lane);
  }
  notifyActiveTaskWaiters();
}

/**
 * Returns the total number of actively executing tasks across all lanes
 * (excludes queued-but-not-started entries).
 */
export function getActiveTaskCount(): number {
  const queueState = getQueueState();
  let total = 0;
  for (const s of queueState.lanes.values()) {
    total += s.activeTaskIds.size;
  }
  return total;
}

/**
 * Wait for all currently active tasks across all lanes to finish.
 * Polls at a short interval; resolves when no tasks are active or
 * when `timeoutMs` elapses (whichever comes first). If no timeout is passed,
 * waits indefinitely for the active set captured at call time.
 *
 * New tasks enqueued after this call are ignored — only tasks that are
 * already executing are waited on.
 */
export function waitForActiveTasks(timeoutMs?: number): Promise<{ drained: boolean }> {
  const queueState = getQueueState();
  const activeAtStart = new Set<number>();
  for (const state of queueState.lanes.values()) {
    for (const taskId of state.activeTaskIds) {
      activeAtStart.add(taskId);
    }
  }

  if (activeAtStart.size === 0) {
    return Promise.resolve({ drained: true });
  }
  if (timeoutMs !== undefined && timeoutMs <= 0) {
    return Promise.resolve({ drained: false });
  }

  return new Promise((resolve) => {
    const waiter: ActiveTaskWaiter = {
      activeTaskIds: activeAtStart,
      resolve,
    };
    if (timeoutMs !== undefined) {
      waiter.timeout = setTimeout(() => {
        resolveActiveTaskWaiter(waiter, { drained: false });
      }, timeoutMs);
    }
    queueState.activeTaskWaiters.add(waiter);
    notifyActiveTaskWaiters();
  });
}
