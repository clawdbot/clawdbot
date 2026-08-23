// Capacity groups: a shared, hard aggregate budget across several command
// lanes, with per-member reservations. Split out of command-queue.ts to keep
// that file within its size budget; the queue supplies its own `drainLane` so
// this module never has to import back into it.
import { getQueueState, normalizeLane } from "./command-queue.state.js";
import { CommandLane } from "./lanes.js";

/** Drains a single lane. Supplied by command-queue.ts to avoid a cycle. */
type DrainLaneFn = (lane: string) => void;

/** Why a lane cannot admit, from the narrowest cause outward. */
export type CommandLaneBlockReason = "lane" | "group-budget" | "sibling-reservation" | null;

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

export type LaneGroupState = {
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

/** Group registry, keyed by group id and by member lane name. */
export function getGroupRegistry(): {
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

export function getLaneGroup(lane: string): LaneGroupState | undefined {
  const { groups, groupByLane } = getGroupRegistry();
  const groupId = groupByLane.get(lane);
  return groupId ? groups.get(groupId) : undefined;
}

/**
 * Active task count for a group member WITHOUT creating the lane. Creating it
 * here would resurrect lanes that `retireIdleScopedCommandLane` just removed.
 */
export function getMemberActiveCount(lane: string): number {
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
export function resolveLaneBlockReason(lane: string): CommandLaneBlockReason {
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

export function canAdmitInGroup(lane: string): boolean {
  const reason = resolveLaneBlockReason(lane);
  return reason === null || reason === "lane";
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
  const { groups, groupByLane } = getGroupRegistry();
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
 * Drain the given member lanes.
 *
 * Never creates a lane: `drainLane` calls `getLaneState`, which would resurrect
 * a scoped lane that `retireIdleScopedCommandLane` had just removed. A lane
 * whose width is 0 admits nothing when pumped, so no width check is needed
 * here — it would only skip a call that is already a no-op.
 */
function drainMembers(lanes: Iterable<string>, drainLane: DrainLaneFn): void {
  for (const lane of lanes) {
    const state = getQueueState().lanes.get(lane);
    if (state && state.queue.length > 0 && !state.draining) {
      drainLane(lane);
    }
  }
}

/**
 * Re-drain every OTHER member of `lane`'s group. Capacity that a completion
 * frees belongs to the group, not to the lane that freed it, so a lane-local
 * pump would leave siblings queued behind capacity that is already available.
 */
export function drainGroupSiblings(lane: string, drainLane: DrainLaneFn): void {
  const group = getLaneGroup(lane);
  if (!group) {
    return;
  }
  drainMembers(
    [...group.members].filter((member) => member !== lane),
    drainLane,
  );
}
