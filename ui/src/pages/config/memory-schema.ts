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

export type MemoryBackend = "builtin" | "qmd";
export type MemoryBackendSelection =
  | { kind: "default"; backend: "builtin" }
  | { kind: "pinned"; backend: MemoryBackend }
  | { kind: "invalid"; backend: null; value: unknown };

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

/** Scroll target for `memory.backend`, which Settings curates out of the editor. */
export const MEMORY_BACKEND_ANCHOR_ID = "memory-backend";

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
  if (
    route.section === "memory" ||
    target === MEMORY_BACKEND_ANCHOR_ID ||
    target.startsWith("config-section-memory")
  ) {
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

// memory-core is the only plugin registering the memory runtime that resolves
// `memory.backend`, so any other engine hides the backend row. This is a
// runtime-ownership fact, not the slot default; the slot comes from
// resolveSlotSelection.
const MEMORY_CORE_PLUGIN_ID = "memory-core";

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

/**
 * The retrieval backend the page shows, or null when the slot owner runs its own
 * retrieval and `memory.backend` would save a value nothing consumes. Settings
 * search resolves it from the same config so both agree on what is visible.
 */
export function resolveMemoryBackendSelection(
  configObject: Record<string, unknown>,
): MemoryBackendSelection | null {
  if (selectedEngineId(resolveMemoryEngineSelection(configObject)) !== MEMORY_CORE_PLUGIN_ID) {
    return null;
  }
  const memory = asConfigRecord(configObject.memory);
  if (!memory || !Object.hasOwn(memory, "backend")) {
    return { kind: "default", backend: "builtin" };
  }
  const backend = memory.backend;
  return backend === "builtin" || backend === "qmd"
    ? { kind: "pinned", backend }
    : { kind: "invalid", backend: null, value: backend };
}

export function resolveMemoryBackend(configObject: Record<string, unknown>): MemoryBackend | null {
  return resolveMemoryBackendSelection(configObject)?.backend ?? null;
}

type JsonRecord = Record<string, unknown>;

function asJsonRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

// One narrowed schema object per (source schema, key set): the config view caches
// its schema analysis by object identity, so a fresh clone per render would
// re-analyze the whole tree on every update.
const narrowedMemorySchemas = new WeakMap<JsonRecord, Map<string, unknown>>();

/**
 * Restrict the root config schema to `memory` with only `keys` retained, so one
 * page can host several tabs over disjoint slices of the same schema section.
 */
export function narrowMemorySchema(schema: unknown, keys: readonly string[]): unknown {
  const root = asJsonRecord(schema);
  const memorySchema = asJsonRecord(asJsonRecord(root?.properties)?.memory);
  const memoryProperties = asJsonRecord(memorySchema?.properties);
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

/**
 * The `memory.*` children Settings renders as curated rows instead of through
 * the embedded editor. They have no `#config-section-*` id, so settings search
 * routes their deep links to MEMORY_BACKEND_ANCHOR_ID.
 */
export const MEMORY_CURATED_SCHEMA_KEYS: readonly string[] = ["backend"];

/** Which `memory.*` children the embedded editor shows for a tab. */
export function memorySchemaKeysForTab(
  tab: MemoryTab,
  backend: MemoryBackend | null,
): readonly string[] {
  if (tab !== "settings") {
    return [];
  }
  // Keep the old Overview fields before the old Search slice while rendering
  // one editor, which in turn keeps one autosave status and apply banner.
  return backend === "qmd" ? ["citations", "qmd", "search"] : ["citations", "search"];
}

/**
 * Every `memory.*` child the page surfaces for a config: the merged editor plus
 * `backend`, which Settings renders as a curated row rather than through the
 * editor. `qmd` and `backend` disappear with the backend/engine choice, so
 * settings search filters the section through this before matching — otherwise a
 * `memory.qmd` hit routes to Settings while its editor omits the matched field.
 */
export function memoryVisibleSchemaKeys(backend: MemoryBackend | null): readonly string[] {
  const editor = memorySchemaKeysForTab("settings", backend);
  return backend === null ? editor : [...editor, "backend"];
}
