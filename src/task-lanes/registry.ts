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

export function getTaskLaneProvider(
  registry: TaskLaneRegistry,
  providerId: string,
): TaskLaneProvider | undefined {
  return registry.providers.get(providerId);
}

/** Sorted provider ids keep snapshot ordering deterministic. */
export function listTaskLaneProviderIds(registry: TaskLaneRegistry): string[] {
  return [...registry.providers.keys()].sort();
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
  const lanes: TaskLane[] = [];
  const diagnostics: TaskLaneProviderDiagnostic[] = [];
  const flat: TaskLaneItem[] = [];
  for (const providerId of providerIds) {
    const provider = registry.providers.get(providerId);
    if (!provider) {
      diagnostics.push({ providerId, ok: false, error: "unknown provider" });
      continue;
    }
    try {
      const { lanes: providerLanes } = await provider.load();
      let itemCount = 0;
      for (const lane of providerLanes) {
        lanes.push(lane);
        itemCount += lane.items.length;
        flat.push(...lane.items.map((item) => ({ ...item, laneId: lane.id })));
      }
      diagnostics.push({
        providerId,
        ok: true,
        laneCount: providerLanes.length,
        itemCount,
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
  flat.sort((left, right) => laneItemSortKey(right) - laneItemSortKey(left));
  const paged = flat.slice(offset, offset + limit).map((item) => ({
    ...item,
    state: normalizeTaskLaneItemState(item.state),
  }));
  return {
    lanes: lanes.map((lane) => ({
      ...lane,
      items: paged.filter((item) => item.laneId === lane.id),
    })),
    diagnostics,
  };
}
