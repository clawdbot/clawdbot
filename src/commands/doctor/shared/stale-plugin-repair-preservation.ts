import { normalizePluginId } from "../../../plugins/config-state.js";

export type StalePluginSurface =
  | "allow"
  | "deny"
  | "entries"
  | "slot"
  | "channel"
  | "heartbeat"
  | "modelByChannel";

type StalePluginHit = {
  pluginId: string;
  surface: StalePluginSurface;
};

function normalizeIds(ids: Iterable<string> | undefined): Set<string> {
  return new Set(
    [...(ids ?? [])].map((id) => normalizePluginId(id)).filter((id): id is string => Boolean(id)),
  );
}

export function filterRepairableStalePluginHits<T extends StalePluginHit>(params: {
  hits: readonly T[];
  preservePluginIds?: Iterable<string>;
  surfacePreservePluginIds?: Partial<Record<StalePluginSurface, Iterable<string>>>;
}): T[] {
  const preserveIds = normalizeIds(params.preservePluginIds);
  const surfacePreserveIds = Object.fromEntries(
    Object.entries(params.surfacePreservePluginIds ?? {}).map(([surface, ids]) => [
      surface,
      normalizeIds(ids),
    ]),
  ) as Partial<Record<StalePluginSurface, Set<string>>>;
  return params.hits.filter((hit) => {
    const id = normalizePluginId(hit.pluginId);
    return !preserveIds.has(id) && !surfacePreserveIds[hit.surface]?.has(id);
  });
}
