import { resolveGlobalSingleton } from "../shared/global-singleton.js";
// Capacity groups: a shared, hard aggregate budget across several command
// lanes, with per-member reservations. Split out of command-queue.ts to keep
// that file within its size budget; the queue supplies its own `drainLane` so
// this module never has to import the queue runtime.
import {
  getQueueState,
  normalizeLane,
  peekLaneQueue,
  type LaneGroupState,
} from "./command-queue.state.js";
import type { CommandLaneBlockReason, CommandLaneSnapshot } from "./command-queue.types.js";
import { CommandLane } from "./lanes.js";

/** Internal bounded drain contract used by the group arbiter. */
type BoundedDrainLaneFn = (lane: string, maxStarts?: number) => number | void;

/** Declares a group's shared budget and its members' hard reservations. */
export type CommandLaneGroupSpec = {
  /** Hard aggregate cap across all members. */
  budget: number;
  members: readonly string[];
  /**
   * Slots a member may always claim, non-borrowable by siblings.
   *
   * Not validated against the member's own `maxConcurrent`, because lane widths
   * and group definitions are published together and the width may not be
   * applied yet at validation time. A reservation larger than the lane's width
   * is therefore accepted but partly unusable: the excess is withheld from
   * siblings while its owner cannot claim it.
   */
  reservations?: Readonly<Record<string, number>>;
};

/** Shared across fresh module instances so one group cannot re-enter its arbiter. */
const DRAINING_GROUPS = resolveGlobalSingleton(
  Symbol.for("openclaw.commandQueueDrainingGroups"),
  () => new WeakSet<LaneGroupState>(),
);

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

export function getLaneGroup(lane: string): LaneGroupState | undefined {
  const { laneGroups: groups, laneGroupByLane: groupByLane } = getQueueState();
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

type GroupCapacity = { active: number; reserved: number };

// Derive capacity from active task IDs so timeout, reset, and stale completion
// handling share the queue's existing ownership accounting.
function readGroupCapacity(group: LaneGroupState): GroupCapacity {
  let active = 0;
  let reserved = 0;
  for (const member of group.members) {
    const memberActive = getMemberActiveCount(member);
    active += memberActive;
    reserved += Math.max(0, (group.reservations.get(member) ?? 0) - memberActive);
  }
  return { active, reserved };
}

function resolveGroupBlockReason(
  group: LaneGroupState,
  lane: string,
  capacity: GroupCapacity,
): CommandLaneBlockReason {
  if (capacity.active >= group.budget) {
    return "group-budget";
  }
  if (getMemberActiveCount(lane) < (group.reservations.get(lane) ?? 0)) {
    return null;
  }
  // The lane's own reservation is filled, so every unused reservation belongs
  // to a sibling and must remain unavailable for borrowing.
  return capacity.active + capacity.reserved < group.budget ? null : "sibling-reservation";
}

/** Fill a fresh snapshot from one synchronous group-capacity observation. */
export function applyCommandLaneCapacity(snapshot: CommandLaneSnapshot): void {
  const group = getLaneGroup(snapshot.lane);
  const capacity = group ? readGroupCapacity(group) : undefined;
  snapshot.blockedBy =
    snapshot.activeCount >= snapshot.maxConcurrent
      ? "lane"
      : group && capacity
        ? resolveGroupBlockReason(group, snapshot.lane, capacity)
        : null;
  if (group && capacity) {
    snapshot.group = group.group;
    snapshot.groupActive = capacity.active;
    snapshot.groupBudget = group.budget;
    snapshot.reservedForLane = group.reservations.get(snapshot.lane) ?? 0;
  }
}

export function canAdmitInGroup(lane: string): boolean {
  const group = getLaneGroup(lane);
  return !group || resolveGroupBlockReason(group, lane, readGroupCapacity(group)) === null;
}

/**
 * Define or replace a capacity group.
 *
 * Membership is held here, keyed by lane name, and deliberately NOT inside
 * `LaneState`: `setCommandLaneConcurrency` must not be able to detach a lane
 * from its group, or session suspend/resume would silently restore a member to
 * ungoverned concurrency.
 */
export function validateCommandLaneGroupSpec(
  group: string,
  spec: CommandLaneGroupSpec,
): LaneGroupState {
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
  return { group, budget, members: new Set(members), reservations };
}

/** Install a validated group, detaching its members from any previous owner. */
export function installCommandLaneGroup(next: LaneGroupState): void {
  const { laneGroups: groups, laneGroupByLane: groupByLane } = getQueueState();
  const previous = groups.get(next.group);
  if (previous) {
    for (const member of previous.members) {
      groupByLane.delete(member);
    }
  }
  for (const member of next.members) {
    // A lane may belong to at most one group. Without this, the old owner's
    // `members` would still contain the lane and would keep counting its active
    // tasks toward a budget it no longer participates in.
    const owner = groupByLane.get(member);
    if (owner && owner !== next.group) {
      groups.get(owner)?.members.delete(member);
    }
  }
  groups.set(next.group, next);
  for (const member of next.members) {
    groupByLane.set(member, next.group);
  }
}

/**
 * Select the highest-priority, oldest currently admissible member head.
 */
function resolveNextGroupLane(group: LaneGroupState): string | undefined {
  let selected:
    | {
        lane: string;
        priority: number;
        sequence: number;
      }
    | undefined;
  let capacity: GroupCapacity | undefined;
  for (const lane of group.members) {
    const state = getQueueState().lanes.get(lane);
    const head = state ? peekLaneQueue(state.queue) : undefined;
    if (!state || !head || state.draining || state.activeTaskIds.size >= state.maxConcurrent) {
      continue;
    }
    // No callbacks run during selection. Recompute on the next selection after
    // drainLane commits a slot or re-enters publication/reset through onWait.
    capacity ??= readGroupCapacity(group);
    if (resolveGroupBlockReason(group, lane, capacity) !== null) {
      continue;
    }
    if (
      !selected ||
      head.priority > selected.priority ||
      (head.priority === selected.priority &&
        (head.sequence < selected.sequence ||
          (head.sequence === selected.sequence && lane < selected.lane)))
    ) {
      selected = { lane, priority: head.priority, sequence: head.sequence };
    }
  }
  return selected?.lane;
}

/**
 * Drain a capacity group one admission at a time.
 *
 * Per-lane queues already order entries by priority and global sequence. The
 * group applies the same order across member queue heads so a completing lane
 * cannot synchronously reclaim shared capacity ahead of an older sibling.
 */
export function drainCommandLaneGroup(lane: string, drainLane: BoundedDrainLaneFn): void {
  const group = getLaneGroup(lane);
  if (!group || DRAINING_GROUPS.has(group)) {
    return;
  }
  DRAINING_GROUPS.add(group);
  try {
    while (getQueueState().laneGroups.get(group.group) === group) {
      const selectedLane = resolveNextGroupLane(group);
      if (!selectedLane || drainLane(selectedLane, 1) === 0) {
        return;
      }
    }
  } finally {
    DRAINING_GROUPS.delete(group);
  }
}
