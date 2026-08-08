// Browser-safe plugin slot default and normalization helpers.
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { PluginSlotsConfig } from "../config/types.plugins.js";
import {
  MEMORY_PLUGIN_ROLE_SLOT_KEYS,
  MEMORY_PLUGIN_ROLES,
  type MemoryPluginRoleSlotKey,
} from "./memory-role.contract.js";

export type PluginSlotKey = keyof PluginSlotsConfig;

export const MEMORY_PLUGIN_SLOT_KEYS = [
  "memory",
  ...MEMORY_PLUGIN_ROLE_SLOT_KEYS,
] as const satisfies readonly PluginSlotKey[];

const DEFAULT_MEMORY_ROLE_SLOT_BY_KEY = Object.fromEntries(
  MEMORY_PLUGIN_ROLES.map((role) => [
    `memory.${role}` satisfies MemoryPluginRoleSlotKey,
    role === "recall" ? "memory-core" : "none",
  ]),
) as Record<MemoryPluginRoleSlotKey, string>;

const DEFAULT_SLOT_BY_KEY: Record<PluginSlotKey, string> = {
  memory: "memory-core",
  ...DEFAULT_MEMORY_ROLE_SLOT_BY_KEY,
  contextEngine: "legacy",
};

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
