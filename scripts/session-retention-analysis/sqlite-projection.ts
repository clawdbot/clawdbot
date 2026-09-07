import { sql } from "kysely";
import { collectSessionStateIdsForEntry } from "../../src/config/sessions/session-accessor.sqlite-lifecycle-state.js";
import type { SessionEntryMaintenancePlan } from "../../src/config/sessions/session-accessor.sqlite-lifecycle-types.js";
import {
  buildSessionMaintenanceOwnershipGroups,
  type SessionMaintenanceOwnershipGroup,
} from "../../src/config/sessions/session-accessor.sqlite-maintenance.js";
import { getSessionKysely } from "../../src/config/sessions/session-accessor.sqlite-scope.js";
import { executeSqliteQuerySync } from "../../src/infra/kysely-sync.js";
import { coerceRequiredSqliteNumber } from "../../src/infra/sqlite-number.js";
import type { OpenClawAgentDatabaseOptions } from "../../src/state/openclaw-agent-db-contract.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../src/state/openclaw-agent-db-readonly.js";
import type { OpenClawAgentDatabase } from "../../src/state/openclaw-agent-db.js";
import type { SessionRetentionGroup } from "./graph-aware-ranking.js";

const SQLITE_PROJECTION_BATCH_SIZE = 250;
const ESTIMATED_NODE_METADATA_BYTES = 512;
const ESTIMATED_WINDOW_METADATA_BYTES = 384;

type ProjectionGroupSeed = {
  groupId: string;
  existingOrder: number;
  sessionKeys: string[];
  sessionIds: string[];
};

export type SessionRetentionProjection = {
  groups: SessionRetentionGroup[];
  queryCount: number;
};

type SessionNodeProjection = {
  session_key: string;
  current_session_id: string;
  parent_session_key: string | null;
  spawned_by: string | null;
  fork_source_session_key: string | null;
  fork_source_session_id: string | null;
  updated_at: number;
  last_read_at: number | null;
  last_interaction_at: number | null;
  last_activity_at: number | null;
};

type SessionWindowProjection = {
  session_id: string;
  session_key: string;
  previous_session_id: string | null;
  parent_session_key: string | null;
  spawned_by: string | null;
};

type TranscriptAggregate = {
  session_id: string;
  event_count: number | bigint;
  event_json_bytes: number | bigint | null;
};

type IdentityAggregate = {
  session_id: string;
  parent_linked_events: number | bigint;
};

function uniqueSorted(values: Iterable<string | null | undefined>): string[] {
  return [
    ...new Set([...values].map((value) => value?.trim()).filter(Boolean) as string[]),
  ].toSorted((left, right) => left.localeCompare(right));
}

function toFiniteTimestamp(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const number = coerceRequiredSqliteNumber(value as number | bigint);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function maxTimestamp(values: Iterable<unknown>): number | null {
  let maximum: number | null = null;
  for (const value of values) {
    const timestamp = toFiniteTimestamp(value);
    if (timestamp !== null && (maximum === null || timestamp > maximum)) {
      maximum = timestamp;
    }
  }
  return maximum;
}

function sumFinite(values: Iterable<number>): number {
  let total = 0;
  for (const value of values) {
    if (Number.isFinite(value) && value > 0) {
      total += value;
    }
  }
  return total;
}

function toCount(value: number | bigint | null | undefined): number {
  const count = Number(value ?? 0);
  return Number.isSafeInteger(count) && count > 0 ? count : 0;
}

function groupIdForSeed(sessionKeys: readonly string[], sessionIds: readonly string[]): string {
  const firstKey = sessionKeys[0];
  if (firstKey) {
    return `key:${firstKey}`;
  }
  return `session:${sessionIds[0] ?? "empty"}`;
}

function seedFromOwnershipGroup(group: SessionMaintenanceOwnershipGroup): ProjectionGroupSeed {
  const sessionKeys = uniqueSorted(group.entryRemovals.map((removal) => removal.sessionKey));
  const entrySessionIds = group.entryRemovals.flatMap((removal) =>
    removal.expectedEntry ? collectSessionStateIdsForEntry(removal.expectedEntry) : [],
  );
  const sessionIds = uniqueSorted([
    ...entrySessionIds,
    ...group.stateDeletePlans.map((plan) => plan.sessionId),
  ]);
  return {
    groupId: groupIdForSeed(sessionKeys, sessionIds),
    existingOrder: group.order,
    sessionKeys,
    sessionIds,
  };
}

export function buildRetentionOwnershipGroups(
  plans: readonly SessionEntryMaintenancePlan[],
): SessionMaintenanceOwnershipGroup[] {
  return buildSessionMaintenanceOwnershipGroups({
    archiveBytesBySessionId: new Map(),
    entryRemovals: plans.flatMap((plan) => plan.entryRemovals),
    stateDeletePlans: plans.flatMap((plan) => plan.stateDeletePlans),
  });
}

function batches<T>(values: readonly T[]): T[][] {
  const output: T[][] = [];
  for (let offset = 0; offset < values.length; offset += SQLITE_PROJECTION_BATCH_SIZE) {
    output.push(values.slice(offset, offset + SQLITE_PROJECTION_BATCH_SIZE));
  }
  return output;
}

function readProjectionRows(
  database: OpenClawAgentDatabase,
  seeds: readonly ProjectionGroupSeed[],
): {
  nodes: SessionNodeProjection[];
  windows: SessionWindowProjection[];
  transcriptAggregates: TranscriptAggregate[];
  identityAggregates: IdentityAggregate[];
  queryCount: number;
} {
  const db = getSessionKysely(database.db);
  const sessionKeys = uniqueSorted(seeds.flatMap((seed) => seed.sessionKeys));
  const sessionIds = uniqueSorted(seeds.flatMap((seed) => seed.sessionIds));
  const nodes: SessionNodeProjection[] = [];
  const windows: SessionWindowProjection[] = [];
  const transcriptAggregates: TranscriptAggregate[] = [];
  const identityAggregates: IdentityAggregate[] = [];
  let queryCount = 0;
  for (const batch of batches(sessionKeys)) {
    queryCount += 1;
    nodes.push(
      ...executeSqliteQuerySync(
        database.db,
        db
          .selectFrom("session_nodes")
          .select([
            "session_key",
            "current_session_id",
            "parent_session_key",
            "spawned_by",
            "fork_source_session_key",
            "fork_source_session_id",
            "updated_at",
            "last_read_at",
            "last_interaction_at",
            "last_activity_at",
          ])
          .where("session_key", "in", batch),
      ).rows,
    );
  }
  for (const batch of batches(sessionIds)) {
    queryCount += 1;
    windows.push(
      ...executeSqliteQuerySync(
        database.db,
        db
          .selectFrom("session_windows")
          .select([
            "session_id",
            "session_key",
            "previous_session_id",
            "parent_session_key",
            "spawned_by",
          ])
          .where("session_id", "in", batch),
      ).rows,
    );
    queryCount += 1;
    transcriptAggregates.push(
      ...executeSqliteQuerySync(
        database.db,
        db
          .selectFrom("transcript_events")
          .select([
            "session_id",
            (eb) => eb.fn.countAll<number | bigint>().as("event_count"),
            /* kysely-allow-raw: aggregate JSON bytes without materializing event payloads. */
            sql<number | bigint>`COALESCE(SUM(LENGTH(CAST(event_json AS BLOB))), 0)`.as(
              "event_json_bytes",
            ),
          ])
          .where("session_id", "in", batch)
          .groupBy("session_id"),
      ).rows,
    );
    queryCount += 1;
    identityAggregates.push(
      ...executeSqliteQuerySync(
        database.db,
        db
          .selectFrom("transcript_event_identities")
          .select([
            "session_id",
            (eb) => eb.fn.countAll<number | bigint>().as("parent_linked_events"),
          ])
          .where("session_id", "in", batch)
          .where("parent_id", "is not", null)
          .groupBy("session_id"),
      ).rows,
    );
  }
  return { nodes, windows, transcriptAggregates, identityAggregates, queryCount };
}

function addDifferentGroup(
  target: Set<string>,
  candidate: string | undefined,
  currentGroupId: string,
): void {
  if (candidate && candidate !== currentGroupId) {
    target.add(candidate);
  }
}

function calculateDescendantCounts(groups: SessionRetentionGroup[]): void {
  const byId = new Map(groups.map((group) => [group.groupId, group]));
  for (const group of groups) {
    const seen = new Set<string>();
    const stack = [...group.childGroupIds];
    while (stack.length > 0) {
      const descendantId = stack.pop();
      if (!descendantId || descendantId === group.groupId || seen.has(descendantId)) {
        continue;
      }
      seen.add(descendantId);
      const descendant = byId.get(descendantId);
      if (descendant) {
        stack.push(...descendant.childGroupIds);
      }
    }
    group.descendantCount = seen.size;
  }
}

function buildRetentionGroups(params: {
  seeds: readonly ProjectionGroupSeed[];
  nodes: readonly SessionNodeProjection[];
  windows: readonly SessionWindowProjection[];
  transcriptAggregates: readonly TranscriptAggregate[];
  identityAggregates: readonly IdentityAggregate[];
}): SessionRetentionGroup[] {
  const groupIdBySessionKey = new Map<string, string>();
  const groupIdBySessionId = new Map<string, string>();
  for (const seed of params.seeds) {
    for (const sessionKey of seed.sessionKeys) {
      groupIdBySessionKey.set(sessionKey, seed.groupId);
    }
    for (const sessionId of seed.sessionIds) {
      groupIdBySessionId.set(sessionId, seed.groupId);
    }
  }
  const nodesByGroup = new Map<string, SessionNodeProjection[]>();
  for (const node of params.nodes) {
    const groupId = groupIdBySessionKey.get(node.session_key);
    if (groupId) {
      const rows = nodesByGroup.get(groupId) ?? [];
      rows.push(node);
      nodesByGroup.set(groupId, rows);
    }
  }
  const windowsByGroup = new Map<string, SessionWindowProjection[]>();
  for (const window of params.windows) {
    const groupId =
      groupIdBySessionId.get(window.session_id) ?? groupIdBySessionKey.get(window.session_key);
    if (groupId) {
      const rows = windowsByGroup.get(groupId) ?? [];
      rows.push(window);
      windowsByGroup.set(groupId, rows);
    }
  }
  const transcriptBySessionId = new Map(
    params.transcriptAggregates.map((aggregate) => [aggregate.session_id, aggregate]),
  );
  const identitiesBySessionId = new Map(
    params.identityAggregates.map((aggregate) => [aggregate.session_id, aggregate]),
  );
  const groups = params.seeds.map((seed): SessionRetentionGroup => {
    const nodes = nodesByGroup.get(seed.groupId) ?? [];
    const windows = windowsByGroup.get(seed.groupId) ?? [];
    const parentGroupIds = new Set<string>();
    const previousGenerationGroupIds = new Set<string>();
    const forkSourceGroupIds = new Set<string>();
    let generationLinkCount = 0;
    for (const node of nodes) {
      addDifferentGroup(
        parentGroupIds,
        groupIdBySessionKey.get(node.parent_session_key ?? ""),
        seed.groupId,
      );
      addDifferentGroup(
        parentGroupIds,
        groupIdBySessionKey.get(node.spawned_by ?? ""),
        seed.groupId,
      );
      addDifferentGroup(
        forkSourceGroupIds,
        groupIdBySessionKey.get(node.fork_source_session_key ?? "") ??
          groupIdBySessionId.get(node.fork_source_session_id ?? ""),
        seed.groupId,
      );
    }
    for (const window of windows) {
      if (window.previous_session_id) {
        generationLinkCount += 1;
      }
      addDifferentGroup(
        previousGenerationGroupIds,
        groupIdBySessionId.get(window.previous_session_id ?? ""),
        seed.groupId,
      );
      addDifferentGroup(
        parentGroupIds,
        groupIdBySessionKey.get(window.parent_session_key ?? ""),
        seed.groupId,
      );
      addDifferentGroup(
        parentGroupIds,
        groupIdBySessionKey.get(window.spawned_by ?? ""),
        seed.groupId,
      );
    }
    const transcriptEventCount = sumFinite(
      seed.sessionIds.map((sessionId) =>
        toCount(transcriptBySessionId.get(sessionId)?.event_count),
      ),
    );
    const transcriptBytes = sumFinite(
      seed.sessionIds.map((sessionId) =>
        toCount(transcriptBySessionId.get(sessionId)?.event_json_bytes),
      ),
    );
    const parentLinkedEventCount = sumFinite(
      seed.sessionIds.map((sessionId) =>
        toCount(identitiesBySessionId.get(sessionId)?.parent_linked_events),
      ),
    );
    const accessTimestamps = nodes.flatMap((node) => [
      node.last_read_at,
      node.last_interaction_at,
      node.last_activity_at,
    ]);
    const hasLineageMetadata =
      parentGroupIds.size > 0 ||
      previousGenerationGroupIds.size > 0 ||
      forkSourceGroupIds.size > 0 ||
      generationLinkCount > 0;
    return {
      groupId: seed.groupId,
      sessionKeys: seed.sessionKeys,
      sessionIds: seed.sessionIds,
      existingOrder: seed.existingOrder,
      reclaimableBytes:
        transcriptBytes +
        transcriptEventCount +
        nodes.length * ESTIMATED_NODE_METADATA_BYTES +
        windows.length * ESTIMATED_WINDOW_METADATA_BYTES,
      transcriptEventCount,
      parentLinkedEventCount,
      generationCount: windows.length,
      generationLinkCount,
      updatedAt: maxTimestamp(nodes.map((node) => node.updated_at)),
      lastReadAt: maxTimestamp(nodes.map((node) => node.last_read_at)),
      lastInteractionAt: maxTimestamp(nodes.map((node) => node.last_interaction_at)),
      lastActivityAt: maxTimestamp(nodes.map((node) => node.last_activity_at)),
      parentGroupIds: uniqueSorted(parentGroupIds),
      childGroupIds: [],
      previousGenerationGroupIds: uniqueSorted(previousGenerationGroupIds),
      forkSourceGroupIds: uniqueSorted(forkSourceGroupIds),
      directChildCount: 0,
      descendantCount: 0,
      forkFanout: 0,
      protected: false,
      protectionReasons: [],
      evidence: {
        hasAccessMetadata: accessTimestamps.some((timestamp) => timestamp !== null),
        hasLineageMetadata,
        hasSizeMetadata: windows.length > 0 || transcriptEventCount > 0,
      },
    };
  });
  const byId = new Map(groups.map((group) => [group.groupId, group]));
  for (const group of groups) {
    for (const parentGroupId of group.parentGroupIds) {
      const parent = byId.get(parentGroupId);
      if (parent && !parent.childGroupIds.includes(group.groupId)) {
        parent.childGroupIds.push(group.groupId);
      }
    }
    for (const forkSourceGroupId of group.forkSourceGroupIds) {
      const source = byId.get(forkSourceGroupId);
      if (source) {
        source.forkFanout += 1;
      }
    }
  }
  for (const group of groups) {
    group.childGroupIds.sort((left, right) => left.localeCompare(right));
    group.directChildCount = group.childGroupIds.length;
  }
  calculateDescendantCounts(groups);
  return groups.toSorted((left, right) => left.existingOrder - right.existingOrder);
}

export function projectSessionRetentionGroups(params: {
  database: OpenClawAgentDatabaseOptions;
  ownershipGroups: readonly SessionMaintenanceOwnershipGroup[];
}): SessionRetentionProjection {
  const seeds = params.ownershipGroups.map(seedFromOwnershipGroup);
  const opened = withOpenClawAgentDatabaseReadOnly((database) => {
    const rows = readProjectionRows(database as OpenClawAgentDatabase, seeds);
    return {
      groups: buildRetentionGroups({ seeds, ...rows }),
      queryCount: rows.queryCount,
    };
  }, params.database);
  if (!opened.found) {
    throw new Error(`Cannot project session retention metadata: ${opened.reason}`);
  }
  return opened.value;
}
