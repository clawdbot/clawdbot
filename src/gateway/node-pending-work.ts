import { randomUUID } from "node:crypto";

const NODE_PENDING_WORK_TYPES = ["status.request", "location.request"] as const;
export type NodePendingWorkType = (typeof NODE_PENDING_WORK_TYPES)[number];

const NODE_PENDING_WORK_PRIORITIES = ["default", "normal", "high"] as const;
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
  let changed = false;
  for (const [id, item] of state.itemsById) {
    if (item.expiresAtMs !== null && item.expiresAtMs <= nowMs) {
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
    createdAtMs: nowMs,
    expiresAtMs: null,
  };
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
  const nowMs = Date.now();
  const state = getOrCreateState(nodeId);
  pruneExpired(state, nowMs);
  const existing = [...state.itemsById.values()].find((item) => item.type === params.type);
  if (existing) {
    return { revision: state.revision, item: existing, deduped: true };
  }
  const item: NodePendingWorkItem = {
    id: randomUUID(),
    type: params.type,
    priority: params.priority ?? DEFAULT_PRIORITY,
    createdAtMs: nowMs,
    expiresAtMs:
      typeof params.expiresInMs === "number" && Number.isFinite(params.expiresInMs)
        ? nowMs + Math.max(1_000, Math.trunc(params.expiresInMs))
        : null,
    ...(params.payload ? { payload: params.payload } : {}),
  };
  state.itemsById.set(item.id, item);
  state.revision += 1;
  return { revision: state.revision, item, deduped: false };
}

export function drainNodePendingWork(nodeId: string, opts: DrainOptions = {}): DrainResult {
  const normalizedNodeId = nodeId.trim();
  if (!normalizedNodeId) {
    return { revision: 0, items: [], hasMore: false };
  }
  const nowMs = opts.nowMs ?? Date.now();
  const state = stateByNodeId.get(normalizedNodeId);
  const revision = state?.revision ?? 0;
  if (state) {
    pruneExpired(state, nowMs);
    pruneStateIfEmpty(normalizedNodeId, state);
  }
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
  return {
    revision,
    items,
    hasMore: explicitItems.length > explicitReturnedCount || (includeBaseline && !baselineIncluded),
  };
}

export function acknowledgeNodePendingWork(params: { nodeId: string; itemIds: string[] }): {
  revision: number;
  removedItemIds: string[];
} {
  const nodeId = params.nodeId.trim();
  if (!nodeId) {
    return { revision: 0, removedItemIds: [] };
  }
  const state = stateByNodeId.get(nodeId);
  if (!state) {
    return { revision: 0, removedItemIds: [] };
  }
  const removedItemIds: string[] = [];
  for (const itemId of params.itemIds) {
    const trimmedId = itemId.trim();
    if (!trimmedId || trimmedId === DEFAULT_STATUS_ITEM_ID) {
      continue;
    }
    if (state.itemsById.delete(trimmedId)) {
      removedItemIds.push(trimmedId);
    }
  }
  if (removedItemIds.length > 0) {
    state.revision += 1;
  }
  pruneStateIfEmpty(nodeId, state);
  return { revision: state.revision, removedItemIds };
}

export function resetNodePendingWorkForTests() {
  stateByNodeId.clear();
}

export function getNodePendingWorkStateCountForTests(): number {
  return stateByNodeId.size;
}
