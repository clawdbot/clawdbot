import type { SessionRow } from "../../packages/gateway-protocol/src/schema/sessions-row.js";
import type { SubagentRunReadRecord } from "../agents/subagents/registry/subagent-registry.types.js";

const MAX_ACTIVE_GROUPS = 4;
type SwarmSummary = NonNullable<SessionRow["swarm"]>;
type Member = NonNullable<SwarmSummary["groups"][number]["children"]>[number];
const STATUS_RANK = { running: 0, queued: 1, failed: 2, done: 3 } as const;

/** Counts requester-owned operations, including tombstones whose child sessions were deleted. */
export function buildSessionSwarmSummary(
  runs: readonly SubagentRunReadRecord[],
  sessionKey: string,
  agentId: string,
  options: { includeChildren?: boolean } = {},
): SwarmSummary | undefined {
  const groups = new Map<string, SwarmSummary["groups"][number]>();
  const members = options.includeChildren
    ? new Map<string, Array<Member & { createdAt: number }>>()
    : undefined;
  for (const run of runs) {
    const requester = run.swarmRequesterSessionKey;
    if (
      !run.collect ||
      !run.groupId ||
      requester !== sessionKey ||
      run.requesterAgentId !== agentId
    ) {
      continue;
    }
    const group = groups.get(run.groupId) ?? {
      groupId: run.groupId,
      createdAt: run.createdAt,
      queued: 0,
      running: 0,
      done: 0,
      failed: 0,
    };
    group.createdAt = Math.min(group.createdAt, run.createdAt);
    // Completion is frozen by the collector owner only after its result settles.
    // A provider terminal event alone must not claim the collector has finished.
    const completion = run.collectorCompletion?.status;
    const status = completion
      ? completion === "done"
        ? "done"
        : "failed"
      : run.execution.status === "queued"
        ? "queued"
        : "running";
    group[status] += 1;
    groups.set(run.groupId, group);
    if (members) {
      const children = members.get(run.groupId) ?? [];
      children.push({ sessionKey: run.childSessionKey, status, createdAt: run.createdAt });
      members.set(run.groupId, children);
    }
  }
  if (groups.size === 0) {
    return undefined;
  }
  const ordered = [...groups.values()].toSorted(
    (left, right) => right.createdAt - left.createdAt || left.groupId.localeCompare(right.groupId),
  );
  const active = ordered.filter((group) => group.queued + group.running > 0);
  const terminal = ordered.find((group) => group.queued + group.running === 0);
  const selected = [...active.slice(0, MAX_ACTIVE_GROUPS), ...(terminal ? [terminal] : [])];
  if (members) {
    // Only a selected-parent read carries member detail; ordinary rosters stay compact.
    for (const group of selected) {
      group.children = (members.get(group.groupId) ?? [])
        .toSorted(
          (left, right) =>
            STATUS_RANK[left.status] - STATUS_RANK[right.status] ||
            left.createdAt - right.createdAt ||
            left.sessionKey.localeCompare(right.sessionKey),
        )
        .slice(0, 64)
        .map(({ sessionKey: childKey, status }) => ({ sessionKey: childKey, status }));
    }
  }
  return {
    groups: selected,
    otherActiveGroups: Math.max(0, active.length - MAX_ACTIVE_GROUPS),
  };
}
