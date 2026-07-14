// Gateway pending node-work queue.
// Stores short-lived per-node prompts until connected nodes drain them.
import { randomUUID } from "node:crypto";
import {
  asDateTimestampMs,
  isFutureDateTimestampMs,
  resolveDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "@openclaw/normalization-core/number-coercion";

// Pending node work is an in-memory per-node queue for gateway prompts such as
// status/location requests. Nodes drain it opportunistically after reconnecting.
const NODE_PENDING_WORK_TYPES = ["status.request", "location.request"] as const;
/** Work item types that connected nodes understand today. */
export type NodePendingWorkType = (typeof NODE_PENDING_WORK_TYPES)[number];

const NODE_PENDING_WORK_PRIORITIES = ["default", "normal", "high"] as const;
/** Priority labels used for pending work drain ordering. */
export type NodePendingWorkPriority = (typeof NODE_PENDING_WORK_PRIORITIES)[number];

type NodePendingWorkItem = {
  id: string;
  type: NodePendingWorkType;
  priority: NodePendingWorkPriority;
  createdAtMs: number;
  expiresAtMs: number | null;
  payload?: Record<string, unknown>;
};

type NodePendingWorkState = {
  revision: number;
  itemsById: Map<string, NodePendingWorkItem>;
};

type DrainOptions = {
  maxItems?: number;
  includeDefaultStatus?: boolean;
  nowMs?: number;
};

type DrainResult = {
  revision: number;
  items: NodePendingWorkItem[];
  hasMore: boolean;
};

const DEFAULT_STATUS_ITEM_ID = "baseline-status";
const DEFAULT_STATUS_PRIORITY: NodePendingWorkPriority = "default";
const DEFAULT_PRIORITY: NodePendingWorkPriority = "normal";
const DEFAULT_PENDING_WORK_TTL_MS = 24 * 60 * 60_000;
const DEFAULT_MAX_ITEMS = 4;
const MAX_ITEMS = 10;
const PRIORITY_RANK: Record<NodePendingWorkPriority, number> = {
  high: 3,
  normal: 2,
  default: 1,
};

const stateByNodeId = new Map<string, NodePendingWorkState>();

function getOrCreateState(nodeId: string): NodePendingWorkState {
  let state = stateByNodeId.get(nodeId);
  if (!state) {
    state = {
      revision: 0,
      itemsById: new Map(),
    };
    stateByNodeId.set(nodeId, state);
  }
  return state;
}

function pruneExpired(state: NodePendingWorkState, nowMs: number): boolean {
  // Expiry pruning bumps revision so polling nodes can observe that work changed.
  const validNowMs = asDateTimestampMs(nowMs);
  if (validNowMs === undefined) {
    return false;
  }
  let changed = false;
  for (const [id, item] of state.itemsById) {
    if (
      item.expiresAtMs !== null &&
      !isFutureDateTimestampMs(item.expiresAtMs, { nowMs: validNowMs })
    ) {
      state.itemsById.delete(id);
      changed = true;
    }
  }
  if (changed) {
    state.revision += 1;
  }
  return changed;
}

function pruneStateIfEmpty(nodeId: string, state: NodePendingWorkState) {
  if (state.itemsById.size === 0) {
    stateByNodeId.delete(nodeId);
  }
}

function sortedItems(state: NodePendingWorkState): NodePendingWorkItem[] {
  // Higher priority wins, then older work, then id for deterministic paging.
  return [...state.itemsById.values()].toSorted((a, b) => {
    const priorityDelta = PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority];
    if (priorityDelta !== 0) {
      return priorityDelta;
    }
    if (a.createdAtMs !== b.createdAtMs) {
      return a.createdAtMs - b.createdAtMs;
    }
    return a.id.localeCompare(b.id);
  });
}

function makeBaselineStatusItem(nowMs: number): NodePendingWorkItem {
  return {
    id: DEFAULT_STATUS_ITEM_ID,
    type: "status.request",
    priority: DEFAULT_STATUS_PRIORITY,
    createdAtMs: resolveDateTimestampMs(nowMs),
    expiresAtMs: null,
  };
}

function resolvePendingWorkExpiresAtMs(expiresInMs: unknown, nowMs: number): number {
  const ttlMs =
    typeof expiresInMs === "number" && Number.isFinite(expiresInMs)
      ? Math.max(1_000, Math.trunc(expiresInMs))
      : DEFAULT_PENDING_WORK_TTL_MS;
  return resolveExpiresAtMsFromDurationMs(ttlMs, { nowMs }) ?? 0;
}

export function enqueueNodePendingWork(params: {
  nodeId: string;
  type: NodePendingWorkType;
  priority?: NodePendingWorkPriority;
  expiresInMs?: number;
  payload?: Record<string, unknown>;
}): { revision: number; item: NodePendingWorkItem; deduped: boolean } {
  const nodeId = params.nodeId.trim();
  if (!nodeId) {
    throw new Error("nodeId required");
  }
  const rawNowMs = Date.now();
  const nowMs = resolveDateTimestampMs(rawNowMs);
  const state = getOrCreateState(nodeId);
  pruneExpired(state, nowMs);
  // Keep one outstanding item per type so repeated status/location requests
  // collapse until the node has a chance to drain them.
  const existing = [...state.itemsById.values()].find((item) => item.type === params.type);
  if (existing) {
    return { revision: state.revision, item: existing, deduped: true };
  }
  const item: NodePendingWorkItem = {
    id: randomUUID(),
    type: params.type,
    priority: params.priority ?? DEFAULT_PRIORITY,
    createdAtMs: nowMs,
    expiresAtMs: resolvePendingWorkExpiresAtMs(params.expiresInMs, rawNowMs),
    ...(params.payload ? { payload: params.payload } : {}),
  };
  state.itemsById.set(item.id, item);
  state.revision += 1;
  return { revision: state.revision, item, deduped: false };
}

/** Drains pending work for a node, including a baseline status request unless disabled. */
export function drainNodePendingWork(nodeId: string, opts: DrainOptions = {}): DrainResult {
  const normalizedNodeId = nodeId.trim();
  if (!normalizedNodeId) {
    return { revision: 0, items: [], hasMore: false };
  }
  const nowMs = resolveDateTimestampMs(opts.nowMs ?? Date.now());
  const state = stateByNodeId.get(normalizedNodeId);
  if (state) {
    pruneExpired(state, nowMs);
    pruneStateIfEmpty(normalizedNodeId, state);
  }
  const revision = state?.revision ?? 0;
  const maxItems = Math.min(MAX_ITEMS, Math.max(1, Math.trunc(opts.maxItems ?? DEFAULT_MAX_ITEMS)));
  const explicitItems = state ? sortedItems(state) : [];
  const items = explicitItems.slice(0, maxItems);
  const hasExplicitStatus = explicitItems.some((item) => item.type === "status.request");
  const includeBaseline = opts.includeDefaultStatus !== false && !hasExplicitStatus;
  if (includeBaseline && items.length < maxItems) {
    items.push(makeBaselineStatusItem(nowMs));
  }
  const explicitReturnedCount = items.filter((item) => item.id !== DEFAULT_STATUS_ITEM_ID).length;
  const baselineIncluded = items.some((item) => item.id === DEFAULT_STATUS_ITEM_ID);
  if (state && explicitReturnedCount > 0) {
    for (const item of items) {
      if (item.id !== DEFAULT_STATUS_ITEM_ID) {
        state.itemsById.delete(item.id);
      }
    }
    state.revision += 1;
    pruneStateIfEmpty(normalizedNodeId, state);
  }
  return {
    revision: state?.revision ?? revision,
    items,
    hasMore: explicitItems.length > explicitReturnedCount || (includeBaseline && !baselineIncluded),
  };
}
