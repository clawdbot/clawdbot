// Config facts about the `memory` section, with no rendering imports.
//
// The Memory page is behind the lazy `import("./config-page.ts")` route, but
// settings search runs from app-host at startup. Both need the same answers
// about which `memory.*` children are reachable and where a match lives, so
// those answers live here rather than in the view module — importing the view
// from search would pull lit, hub-tabs, and settings-ui into the startup chunk.
import { asNullableRecord as asConfigRecord } from "@openclaw/normalization-core/record-coerce";
import type { RouteLocation } from "@openclaw/uirouter";
import { defaultSlotIdForKey, resolveSlotSelection } from "../../../../src/plugins/slots.ts";
import { memoryTabFromPath, pathForMemoryTab, type MemoryRouteTab } from "../../app-route-paths.ts";

export type MemoryTab = MemoryRouteTab;

/**
 * How `plugins.slots.memory` reads today, mirroring resolveSlotSelection in
 * src/plugins/slots.ts. `off` is the explicit `none` sentinel; `auto` is an
 * unset slot, which always resolves to the slot's default owner rather than to
 * whichever memory plugin happens to be enabled.
 */
export type MemoryEngineSelection =
  | { kind: "auto"; engineId: string }
  | { kind: "off" }
  | { kind: "pinned"; engineId: string };

export const DEFAULT_MEMORY_ENGINE_ID = defaultSlotIdForKey("memory");

const MEMORY_TABS: readonly MemoryTab[] = ["overview", "memories", "dreams", "settings"];

/** Reads a `?tab=` value from a settings-search destination or a shared link. */
function normalizeMemoryTab(value: string | null | undefined): MemoryTab | null {
  if (value === "search") {
    return "settings";
  }
  if (value === "dreaming") {
    return "dreams";
  }
  return MEMORY_TABS.find((tab) => tab === value) ?? null;
}

/** Old settings-search URLs had a memory section/hash but no tab. */
export function memoryTabForRoute(
  route: {
    pathname?: string;
    tab?: string | null;
    section?: string | null;
    targetBlockId?: string | null;
  },
  basePath = "",
): MemoryTab | null {
  const pathTab = route.pathname ? memoryTabFromPath(route.pathname, basePath) : null;
  if (pathTab && pathTab !== "overview") {
    return pathTab;
  }
  const tab = normalizeMemoryTab(route.tab);
  if (tab) {
    return tab;
  }
  const target = route.targetBlockId ?? "";
  if (route.section === "memory" || target.startsWith("config-section-memory")) {
    return "settings";
  }
  return pathTab;
}

export function canonicalMemoryRouteLocation(
  route: {
    pathname: string;
    search: string;
    hash: string;
    tab?: string | null;
    section?: string | null;
    targetBlockId?: string | null;
    advanced?: boolean;
  },
  basePath = "",
): RouteLocation | null {
  const params = new URLSearchParams(route.search);
  const hadLegacyTab = params.has("tab");
  const hadLegacySection = route.section === "memory" && params.has("section");
  params.delete("tab");
  if (hadLegacySection) {
    params.delete("section");
    params.delete("advanced");
  }
  const search = params.toString();
  const canonical: RouteLocation = {
    pathname: pathForMemoryTab(memoryTabForRoute(route, basePath) ?? "overview", basePath),
    search: search ? `?${search}` : "",
    hash: route.hash,
  };
  return hadLegacyTab || hadLegacySection || canonical.pathname !== route.pathname
    ? canonical
    : null;
}

/** The plugin that currently owns the slot, or null when nothing does. */
export function selectedEngineId(selection: MemoryEngineSelection): string | null {
  return selection.kind === "off" ? null : selection.engineId;
}

/**
 * Mirrors the runtime exactly: resolveSlotSelection owns the rule, so an unset
 * slot reports the slot's default owner instead of guessing from the catalog.
 */
export function resolveMemoryEngineSelection(
  configObject: Record<string, unknown>,
): MemoryEngineSelection {
  const slots = asConfigRecord(asConfigRecord(configObject.plugins)?.slots);
  const selection = resolveSlotSelection("memory", slots?.memory);
  switch (selection.kind) {
    case "off":
      return { kind: "off" };
    case "pinned":
      return { kind: "pinned", engineId: selection.pluginId };
    default:
      return { kind: "auto", engineId: selection.pluginId };
  }
}

type JsonRecord = Record<string, unknown>;

// One narrowed schema object per (source schema, key set): the config view caches
// its schema analysis by object identity, so a fresh clone per render would
// re-analyze the whole tree on every update.
const narrowedMemorySchemas = new WeakMap<JsonRecord, Map<string, unknown>>();

/**
 * Restrict the root config schema to `memory` with only `keys` retained, so one
 * page can host several tabs over disjoint slices of the same schema section.
 */
export function narrowMemorySchema(schema: unknown, keys: readonly string[]): unknown {
  const root = asConfigRecord(schema);
  const memorySchema = asConfigRecord(asConfigRecord(root?.properties)?.memory);
  const memoryProperties = asConfigRecord(memorySchema?.properties);
  if (!root || !memorySchema || !memoryProperties) {
    return schema;
  }
  const cacheKey = keys.join("");
  const bucket = narrowedMemorySchemas.get(root) ?? new Map<string, unknown>();
  const hit = bucket.get(cacheKey);
  if (hit !== undefined) {
    return hit;
  }
  const retained = Object.fromEntries(
    keys.filter((key) => key in memoryProperties).map((key) => [key, memoryProperties[key]]),
  );
  const narrowed = {
    ...root,
    properties: { memory: { ...memorySchema, properties: retained } },
  };
  bucket.set(cacheKey, narrowed);
  narrowedMemorySchemas.set(root, bucket);
  return narrowed;
}

/** Which `memory.*` children the embedded editor shows for a tab. */
export function memorySchemaKeysForTab(tab: MemoryTab): readonly string[] {
  if (tab !== "settings") {
    return [];
  }
  // Keep the old Overview fields before the old Search slice while rendering
  // one editor, which in turn keeps one autosave status and apply banner.
  return ["citations", "search"];
}

/** Every `memory.*` child the Settings editor surfaces. */
export function memoryVisibleSchemaKeys(): readonly string[] {
  return memorySchemaKeysForTab("settings");
}
