// Config facts about the `memory` section, with no rendering imports.
//
// The Memory page is behind the lazy `import("./config-page.ts")` route, but
// settings search runs from app-host at startup. Both need the same answers
// about which `memory.*` children are reachable and where a match lives, so
// those answers live here rather than in the view module — importing the view
// from search would pull lit, hub-tabs, and settings-ui into the startup chunk.
import { asNullableRecord as asConfigRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveSlotSelection } from "../../../../src/plugins/slots.ts";

export type MemoryTab = "overview" | "search" | "dreaming";

export type MemoryBackend = "builtin" | "qmd";

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

/** Scroll target for `memory.backend`, which Overview curates out of the editor. */
export const MEMORY_BACKEND_ANCHOR_ID = "memory-backend";

const MEMORY_TABS: readonly MemoryTab[] = ["overview", "search", "dreaming"];

/** Reads a `?tab=` value from a settings-search destination or a shared link. */
export function normalizeMemoryTab(value: string | null | undefined): MemoryTab | null {
  return MEMORY_TABS.find((tab) => tab === value) ?? null;
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
export function resolveMemoryBackend(configObject: Record<string, unknown>): MemoryBackend | null {
  if (selectedEngineId(resolveMemoryEngineSelection(configObject)) !== MEMORY_CORE_PLUGIN_ID) {
    return null;
  }
  return asConfigRecord(configObject.memory)?.backend === "qmd" ? "qmd" : "builtin";
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
 * The `memory.*` children only the Search tab renders; every other child of the
 * section belongs to Overview. Settings search routes deep links through this so
 * a match cannot land on a tab whose editor omits the field it matched.
 */
export const MEMORY_SEARCH_TAB_SCHEMA_KEYS: readonly string[] = ["search"];

/**
 * The `memory.*` children Overview renders as curated rows instead of through
 * the embedded editor. They have no `#config-section-*` id, so settings search
 * routes their deep links to MEMORY_BACKEND_ANCHOR_ID.
 */
export const MEMORY_CURATED_SCHEMA_KEYS: readonly string[] = ["backend"];

/** Which `memory.*` children the embedded editor shows for a tab. */
export function memorySchemaKeysForTab(
  tab: MemoryTab,
  backend: MemoryBackend | null,
): readonly string[] {
  if (tab === "search") {
    return MEMORY_SEARCH_TAB_SCHEMA_KEYS;
  }
  // `backend` is a curated row above the editor; qmd's sub-config only matters
  // once qmd is the selected backend.
  return backend === "qmd" ? ["citations", "qmd"] : ["citations"];
}

/**
 * Every `memory.*` child the page surfaces for a config: both editor slices plus
 * `backend`, which Overview renders as a curated row rather than through the
 * editor. `qmd` and `backend` disappear with the backend/engine choice, so
 * settings search filters the section through this before matching — otherwise a
 * `memory.qmd` hit routes to an Overview whose editor omits it.
 */
export function memoryVisibleSchemaKeys(backend: MemoryBackend | null): readonly string[] {
  const editor = [...MEMORY_SEARCH_TAB_SCHEMA_KEYS, ...memorySchemaKeysForTab("overview", backend)];
  return backend === null ? editor : [...editor, "backend"];
}
