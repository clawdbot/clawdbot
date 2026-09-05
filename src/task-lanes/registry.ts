/** Task-lane provider registry with collision rejection and isolated loading. */

import type {
  TaskLane,
  TaskLaneItem,
  TaskLaneProvider,
  TaskLaneProviderDiagnostic,
  TaskLaneSnapshot,
} from "./types.js";
import { normalizeTaskLaneItemState } from "./types.js";

export type TaskLaneRegistry = {
  providers: Map<string, TaskLaneProvider>;
};

const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9._-]{1,63}$/;

export function createTaskLaneRegistry(): TaskLaneRegistry {
  return { providers: new Map() };
}

/** Registers a provider; duplicate ids are rejected to keep ownership unambiguous. */
export function registerTaskLaneProvider(
  registry: TaskLaneRegistry,
  provider: TaskLaneProvider,
): void {
  const id = provider.id;
  if (!PROVIDER_ID_PATTERN.test(id)) {
    throw new Error(`invalid task lane provider id: ${id}`);
  }
  if (registry.providers.has(id)) {
    throw new Error(`task lane provider already registered: ${id}`);
  }
  registry.providers.set(id, provider);
}

/** Sorted provider ids keep snapshot ordering deterministic. */
function listTaskLaneProviderIds(registry: TaskLaneRegistry): string[] {
  return [...registry.providers.keys()].toSorted();
}

function laneItemSortKey(item: TaskLaneItem): number {
  return typeof item.startedAtMs === "number" ? item.startedAtMs : 0;
}

/**
 * Loads lane data independently per provider: one provider failing produces a
 * failed diagnostic and never degrades the rest of the snapshot.
 */
export async function loadTaskLaneSnapshot(
  registry: TaskLaneRegistry,
  options?: { providerId?: string; limit?: number; offset?: number },
): Promise<TaskLaneSnapshot> {
  const limit = Math.min(Math.max(options?.limit ?? 50, 1), 200);
  const offset = Math.max(options?.offset ?? 0, 0);
  const providerIds = options?.providerId
    ? [options.providerId]
    : listTaskLaneProviderIds(registry);
  const lanes: Array<TaskLane & { providerId: string }> = [];
  const diagnostics: TaskLaneProviderDiagnostic[] = [];
  const flat: Array<{ item: TaskLaneItem; laneId: string; laneProviderId: string }> = [];
  const totalItemsByLane = new Map<string, number>();
  for (const providerId of providerIds) {
    const provider = registry.providers.get(providerId);
    if (!provider) {
      diagnostics.push({ providerId, ok: false, error: "unknown provider" });
      continue;
    }
    try {
      const {
        lanes: providerLanes,
        omittedLanes: providerOmittedLanes,
        omittedItems: providerOmittedItems,
      } = await provider.load();
      let itemCount = 0;
      for (const lane of providerLanes) {
        // Lane ids are only unique within a provider; item-to-lane assignment
        // must therefore match on both, or duplicate lane ids across providers
        // would cross-assign items. The same composite key tracks each lane's
        // unpaged item total so an off-page lane reads as omitted, not empty.
        const laneKey = `${providerId} ${lane.id}`;
        lanes.push({ ...lane, providerId });
        totalItemsByLane.set(laneKey, (totalItemsByLane.get(laneKey) ?? 0) + lane.items.length);
        itemCount += lane.items.length;
        for (const item of lane.items) {
          flat.push({ item, laneId: lane.id, laneProviderId: providerId });
        }
      }
      // Propagate source-level omissions reported by the provider (lanes or
      // items dropped at the provider's count caps) so the snapshot can
      // surface a truncation notice instead of presenting a capped set as
      // the full picture. Only attach when non-zero; older providers that
      // omit these fields keep a zero default.
      const omittedLanes = providerOmittedLanes ?? 0;
      const omittedItems = providerOmittedItems ?? 0;
      diagnostics.push({
        providerId,
        ok: true,
        laneCount: providerLanes.length,
        itemCount,
        ...(omittedLanes > 0 ? { omittedLanes } : {}),
        ...(omittedItems > 0 ? { omittedItems } : {}),
      });
    } catch (error) {
      diagnostics.push({
        providerId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  lanes.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  flat.sort((left, right) => laneItemSortKey(right.item) - laneItemSortKey(left.item));
  const itemsByLane = new Map<string, TaskLaneItem[]>();
  const page = flat.slice(offset, offset + limit);
  for (const { item, laneId, laneProviderId } of page) {
    const key = `${laneProviderId} ${laneId}`;
    let laneItems = itemsByLane.get(key);
    if (!laneItems) {
      laneItems = [];
      itemsByLane.set(key, laneItems);
    }
    laneItems.push({ ...item, state: normalizeTaskLaneItemState(item.state) });
  }
  return {
    // Lane identity is provider-scoped (two providers may share a lane id), so
    // every returned lane keeps its provider id instead of flattening it away.
    lanes: lanes.map(({ providerId, id, label }) => {
      const items = itemsByLane.get(`${providerId} ${id}`) ?? [];
      const totalItems = totalItemsByLane.get(`${providerId} ${id}`) ?? items.length;
      return {
        providerId,
        id,
        label,
        items,
        totalItems,
        omittedItems: Math.max(totalItems - items.length, 0),
      };
    }),
    diagnostics,
    paging: {
      offset,
      limit,
      totalItems: flat.length,
      returnedItems: page.length,
    },
  };
}
