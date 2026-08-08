/** Applies mutually exclusive plugin slot selection for memory and context-engine plugins. */
import {
  listAgentEntriesWithSource,
  mutateAuthoredAgentRosterEntries,
} from "../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../config/types.js";
import { MEMORY_PLUGIN_ROLE_SLOT_KEYS } from "./memory-role.contract.js";
import type { PluginKind } from "./plugin-kind.types.js";
import {
  defaultSlotIdForKey,
  MEMORY_PLUGIN_SLOT_KEYS,
  type PluginSlotKey,
} from "./slot-defaults.js";
export {
  defaultSlotIdForKey,
  MEMORY_PLUGIN_SLOT_KEYS,
  normalizeSlotValue,
  type PluginSlotKey,
} from "./slot-defaults.js";

type ExclusivePluginSlotKey = "memory.recall" | "contextEngine";

export const PLUGIN_SLOT_KEYS = [
  ...MEMORY_PLUGIN_SLOT_KEYS,
  "contextEngine",
] as const satisfies readonly PluginSlotKey[];

type SlotPluginRecord = {
  id: string;
  kind?: PluginKind | PluginKind[];
};

const SLOT_BY_KIND: Record<PluginKind, ExclusivePluginSlotKey> = {
  memory: "memory.recall",
  "context-engine": "contextEngine",
};

const PROTECTED_SLOT_KEYS = [
  ...MEMORY_PLUGIN_ROLE_SLOT_KEYS,
  "contextEngine",
] as const satisfies readonly PluginSlotKey[];
const PROTECTED_AGENT_SLOT_KEYS = MEMORY_PLUGIN_ROLE_SLOT_KEYS;

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
function slotKeysForPluginKind(kind?: PluginKind | PluginKind[]): ExclusivePluginSlotKey[] {
  return normalizeKinds(kind)
    .map((k) => SLOT_BY_KIND[k])
    .filter((k): k is ExclusivePluginSlotKey => k != null);
}

function slotValueForOwnership(
  slots: Partial<Record<PluginSlotKey, string | undefined>> | undefined,
  slotKey: PluginSlotKey,
): string | undefined {
  return slots?.[slotKey] ?? defaultSlotIdForKey(slotKey);
}

function pluginOwnsProtectedRootSlot(params: {
  slots: Partial<Record<PluginSlotKey, string | undefined>>;
  pluginId: string;
  ignoredSlotKey: PluginSlotKey;
}): boolean {
  return PROTECTED_SLOT_KEYS.filter((slotKey) => slotKey !== params.ignoredSlotKey).some(
    (slotKey) => slotValueForOwnership(params.slots, slotKey) === params.pluginId,
  );
}

function pluginOwnsProtectedAgentSlot(params: {
  config: OpenClawConfig;
  pluginId: string;
}): boolean {
  for (const { entry: agent } of listAgentEntriesWithSource(params.config)) {
    const slots = agent.plugins?.slots;
    if (!slots) {
      continue;
    }
    for (const slotKey of PROTECTED_AGENT_SLOT_KEYS) {
      if (slots[slotKey] === params.pluginId) {
        return true;
      }
    }
  }
  return false;
}

function pluginOwnsProtectedSlot(params: {
  config: OpenClawConfig;
  slots: Partial<Record<PluginSlotKey, string | undefined>>;
  pluginId: string;
  ignoredSlotKey: PluginSlotKey;
}): boolean {
  return (
    pluginOwnsProtectedRootSlot(params) ||
    pluginOwnsProtectedAgentSlot({
      config: params.config,
      pluginId: params.pluginId,
    })
  );
}

export function resetPluginSlotReferences<
  T extends Partial<Record<PluginSlotKey, string | undefined>>,
>(
  slots: T | undefined,
  pluginId: string,
  slotKeys: readonly PluginSlotKey[] = PLUGIN_SLOT_KEYS,
): { slots: T | undefined; changed: boolean; resetKeys: PluginSlotKey[] } {
  const mutation = mutatePluginSlotReferences(slots, {
    mode: "reset-to-default",
    pluginId,
    slotKeys,
  });
  return { slots: mutation.slots, changed: mutation.changed, resetKeys: mutation.touchedKeys };
}

type PluginSlotReferenceMutation =
  | {
      mode: "replace";
      fromPluginId: string;
      toPluginId: string;
      slotKeys?: readonly PluginSlotKey[];
    }
  | {
      mode: "reset-to-default";
      pluginId: string;
      slotKeys?: readonly PluginSlotKey[];
    }
  | {
      mode: "delete-override";
      pluginId: string;
      slotKeys?: readonly PluginSlotKey[];
      pruneEmpty?: boolean;
    };

function matchesSlotMutation(value: string | undefined, mutation: PluginSlotReferenceMutation) {
  return mutation.mode === "replace"
    ? value === mutation.fromPluginId
    : value === mutation.pluginId;
}

function replacementSlotValue(
  slotKey: PluginSlotKey,
  mutation: Exclude<PluginSlotReferenceMutation, { mode: "delete-override" }>,
): string {
  return mutation.mode === "replace" ? mutation.toPluginId : defaultSlotIdForKey(slotKey);
}

export function mutatePluginSlotReferences<
  T extends Partial<Record<PluginSlotKey, string | undefined>>,
>(
  slots: T | undefined,
  mutation: PluginSlotReferenceMutation,
): { slots: T | undefined; changed: boolean; touchedKeys: PluginSlotKey[] } {
  if (!slots) {
    return { slots, changed: false, touchedKeys: [] };
  }
  let next: T | undefined;
  const touchedKeys: PluginSlotKey[] = [];
  for (const slotKey of mutation.slotKeys ?? PLUGIN_SLOT_KEYS) {
    if (!matchesSlotMutation(slots[slotKey], mutation)) {
      continue;
    }
    next ??= { ...slots };
    if (mutation.mode === "delete-override") {
      delete next[slotKey];
    } else {
      Object.assign(next, { [slotKey]: replacementSlotValue(slotKey, mutation) });
    }
    touchedKeys.push(slotKey);
  }
  if (!next) {
    return { slots, changed: false, touchedKeys };
  }
  return {
    slots:
      mutation.mode === "delete-override" && mutation.pruneEmpty !== false
        ? Object.keys(next).length > 0
          ? next
          : undefined
        : next,
    changed: true,
    touchedKeys,
  };
}

export function mutateAgentMemoryPluginSlotReferences(
  agents: OpenClawConfig["agents"],
  mutation: PluginSlotReferenceMutation,
): { agents: OpenClawConfig["agents"]; changed: boolean } {
  const result = mutateAuthoredAgentRosterEntries(agents, (agent) => {
    const slotsMutation = mutatePluginSlotReferences(agent?.plugins?.slots, {
      ...mutation,
      slotKeys: mutation.slotKeys ?? MEMORY_PLUGIN_SLOT_KEYS,
    });
    if (!slotsMutation.changed) {
      return undefined;
    }
    const plugins =
      agent.plugins &&
      (slotsMutation.slots || Object.keys(agent.plugins).some((key) => key !== "slots"))
        ? {
            ...agent.plugins,
            slots: slotsMutation.slots,
          }
        : undefined;
    if (plugins?.slots === undefined) {
      delete plugins?.slots;
    }
    const nextAgent = {
      ...agent,
      plugins,
    };
    if (nextAgent.plugins === undefined) {
      delete nextAgent.plugins;
    }
    return nextAgent;
  });

  return { agents: result.agents, changed: result.changed };
}

export function resetAgentMemoryPluginSlotReferences(
  agents: OpenClawConfig["agents"],
  pluginId: string,
): { agents: OpenClawConfig["agents"]; changed: boolean } {
  return mutateAgentMemoryPluginSlotReferences(agents, {
    mode: "delete-override",
    pluginId,
  });
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
    slots[slotKey] = params.selectedId;
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
        if (
          pluginOwnsProtectedSlot({
            config: params.config,
            slots,
            pluginId: plugin.id,
            ignoredSlotKey: slotKey,
          })
        ) {
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

    if (prevSlot !== params.selectedId || disabledIds.length > 0) {
      anyChanged = true;
    }
  }

  if (!anyChanged) {
    return { config: params.config, warnings: [], changed: false };
  }

  return {
    config: {
      ...params.config,
      plugins: {
        ...pluginsConfig,
        slots,
        entries,
      },
    },
    warnings,
    changed: true,
  };
}
