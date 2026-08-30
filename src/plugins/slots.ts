/** Applies mutually exclusive plugin slot selection for memory and context-engine plugins. */
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.js";
import type { PluginSlotsConfig } from "../config/types.plugins.js";
import type { PluginKind } from "./plugin-kind.types.js";

export type PluginSlotKey = keyof PluginSlotsConfig;

type SlotPluginRecord = {
  id: string;
  kind?: PluginKind | PluginKind[];
};

const SLOT_BY_KIND: Record<PluginKind, PluginSlotKey> = {
  memory: "memory",
  "context-engine": "contextEngine",
};

const DEFAULT_SLOT_BY_KEY: Record<PluginSlotKey, string> = {
  memory: "memory-core",
  contextEngine: "legacy",
};

const PLUGIN_SLOT_KEYS = Object.keys(DEFAULT_SLOT_BY_KEY) as PluginSlotKey[];

/** Normalize a kind field to an array for uniform iteration. */
function normalizeKinds(kind?: PluginKind | PluginKind[]): PluginKind[] {
  if (!kind) {
    return [];
  }
  return Array.isArray(kind) ? kind : [kind];
}

/** Check whether a plugin's kind field includes a specific kind. */
export function hasKind(kind: PluginKind | PluginKind[] | undefined, target: PluginKind): boolean {
  if (!kind) {
    return false;
  }
  return Array.isArray(kind) ? kind.includes(target) : kind === target;
}

/** Order-insensitive equality check for two kind values (string or array). */
export function kindsEqual(
  a: PluginKind | PluginKind[] | undefined,
  b: PluginKind | PluginKind[] | undefined,
): boolean {
  const aN = normalizeKinds(a).toSorted();
  const bN = normalizeKinds(b).toSorted();
  return aN.length === bN.length && aN.every((k, i) => k === bN[i]);
}

/** Return all slot keys that a plugin's kind field maps to. */
function slotKeysForPluginKind(kind?: PluginKind | PluginKind[]): PluginSlotKey[] {
  return normalizeKinds(kind)
    .map((k) => SLOT_BY_KIND[k])
    .filter((k): k is PluginSlotKey => k != null);
}

/** Returns the implicit plugin id that owns a slot before config overrides it. */
export function defaultSlotIdForKey(slotKey: PluginSlotKey): string {
  return DEFAULT_SLOT_BY_KEY[slotKey];
}

/** Raw `plugins.slots[key]`: `none` turns the slot off, blank leaves it unset. */
export function normalizeSlotValue(value: unknown): string | null | undefined {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return undefined;
  }
  if (normalizeOptionalLowercaseString(trimmed) === "none") {
    return null;
  }
  return trimmed;
}

/**
 * How a configured slot reads. The single owner of the rule: an unset slot is
 * the implicit default owner, never "whichever plugin happens to be enabled".
 * Config normalization and the Control UI both resolve slots through this.
 */
type SlotSelection =
  | { kind: "default"; pluginId: string }
  | { kind: "off" }
  | { kind: "pinned"; pluginId: string };

export function resolveSlotSelection(slotKey: PluginSlotKey, value: unknown): SlotSelection {
  const normalized = normalizeSlotValue(value);
  if (normalized === undefined) {
    return { kind: "default", pluginId: defaultSlotIdForKey(slotKey) };
  }
  return normalized === null ? { kind: "off" } : { kind: "pinned", pluginId: normalized };
}

/** Resets every slot currently owned by a plugin to its implicit default. */
export function resetPluginSlotsToDefaults(
  slots: PluginSlotsConfig | undefined,
  pluginId: string,
): PluginSlotsConfig | undefined {
  if (!slots) {
    return slots;
  }
  const next = { ...slots };
  let changed = false;
  for (const slotKey of PLUGIN_SLOT_KEYS) {
    if (slots[slotKey] !== pluginId) {
      continue;
    }
    delete next[slotKey];
    changed = true;
  }
  return changed ? (Object.keys(next).length === 0 ? undefined : next) : slots;
}

type SlotSelectionResult = {
  config: OpenClawConfig;
  warnings: string[];
  changed: boolean;
};

/** Updates config so the selected plugin owns all slots implied by its kind. */
export function applyExclusiveSlotSelection(params: {
  config: OpenClawConfig;
  selectedId: string;
  selectedKind?: PluginKind | PluginKind[];
  registry?: { plugins: SlotPluginRecord[] };
}): SlotSelectionResult {
  const slotKeys = slotKeysForPluginKind(params.selectedKind);
  if (slotKeys.length === 0) {
    return { config: params.config, warnings: [], changed: false };
  }

  const warnings: string[] = [];
  const pluginsConfig = params.config.plugins ?? {};
  let anyChanged = false;
  const entries = { ...pluginsConfig.entries };
  const slots = { ...pluginsConfig.slots };

  for (const slotKey of slotKeys) {
    const prevSlot = slots[slotKey];
    const nextSlot =
      params.selectedId === defaultSlotIdForKey(slotKey) ? undefined : params.selectedId;
    if (nextSlot === undefined) {
      delete slots[slotKey];
    } else {
      slots[slotKey] = nextSlot;
    }

    const inferredPrevSlot = prevSlot ?? defaultSlotIdForKey(slotKey);
    if (inferredPrevSlot && inferredPrevSlot !== params.selectedId) {
      warnings.push(
        `Exclusive slot "${slotKey}" switched from "${inferredPrevSlot}" to "${params.selectedId}".`,
      );
    }

    const disabledIds: string[] = [];
    if (params.registry) {
      for (const plugin of params.registry.plugins) {
        if (plugin.id === params.selectedId) {
          continue;
        }
        const kindForSlot = (Object.keys(SLOT_BY_KIND) as PluginKind[]).find(
          (k) => SLOT_BY_KIND[k] === slotKey,
        );
        if (!kindForSlot || !hasKind(plugin.kind, kindForSlot)) {
          continue;
        }
        // Don't disable a plugin that still owns another slot (explicit or default).
        const stillOwnsOtherSlot = (Object.keys(SLOT_BY_KIND) as PluginKind[])
          .map((k) => SLOT_BY_KIND[k])
          .filter((sk) => sk !== slotKey)
          .some((sk) => (slots[sk] ?? defaultSlotIdForKey(sk)) === plugin.id);
        if (stillOwnsOtherSlot) {
          continue;
        }
        const entry = entries[plugin.id];
        if (!entry || entry.enabled !== false) {
          entries[plugin.id] = { ...entry, enabled: false };
          disabledIds.push(plugin.id);
        }
      }
    }

    if (disabledIds.length > 0) {
      warnings.push(
        `Disabled other "${slotKey}" slot plugins: ${disabledIds.toSorted().join(", ")}.`,
      );
    }

    if (prevSlot !== nextSlot || disabledIds.length > 0) {
      anyChanged = true;
    }
  }

  if (!anyChanged) {
    return { config: params.config, warnings: [], changed: false };
  }

  const { slots: _previousSlots, ...pluginsWithoutSlots } = pluginsConfig;

  return {
    config: {
      ...params.config,
      plugins: {
        ...pluginsWithoutSlots,
        ...(Object.keys(slots).length > 0 ? { slots } : {}),
        entries,
      },
    },
    warnings,
    changed: true,
  };
}
