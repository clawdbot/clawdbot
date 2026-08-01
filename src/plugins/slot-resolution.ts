import { listAgentEntries, resolveAgentConfig } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginSlotsConfig } from "../config/types.plugins.js";
import { isMemoryRoleSelectedSlotActivationAllowed } from "./config-activation-shared.js";
import { normalizePluginsConfig } from "./config-state.js";
import {
  MEMORY_PLUGIN_ROLE_SLOT_KEYS,
  MEMORY_PLUGIN_ROLES,
  type MemoryPluginRole,
  type MemoryPluginRoleSlotKey,
} from "./memory-role.contract.js";

function memoryRoleToSlotKey(role: MemoryPluginRole): MemoryPluginRoleSlotKey {
  return `memory.${role}`;
}

function hasOwnSlot(slots: unknown, slotKey: string): boolean {
  return Boolean(slots && typeof slots === "object" && Object.hasOwn(slots, slotKey));
}

export function hasConfiguredPluginSlot(params: {
  cfg: OpenClawConfig;
  slotKey: keyof PluginSlotsConfig;
  agentId?: string;
}): boolean {
  if (hasOwnSlot(params.cfg.plugins?.slots, params.slotKey)) {
    return true;
  }
  const agentSlots = params.agentId
    ? resolveAgentConfig(params.cfg, params.agentId)?.plugins?.slots
    : undefined;
  return hasOwnSlot(agentSlots, params.slotKey);
}

export function resolvePluginSlot(params: {
  cfg: OpenClawConfig;
  slotKey: keyof PluginSlotsConfig;
  agentId?: string;
}): string | null | undefined {
  const globalPlugins = normalizePluginsConfig(params.cfg.plugins);
  const slot = params.slotKey === "memory" ? undefined : globalPlugins.slots[params.slotKey];

  const agentSlots = params.agentId
    ? resolveAgentConfig(params.cfg, params.agentId)?.plugins?.slots
    : undefined;
  if (!hasOwnSlot(agentSlots, params.slotKey)) {
    return slot;
  }

  const agentPlugins = normalizePluginsConfig({ slots: agentSlots });
  return params.slotKey === "memory" ? undefined : agentPlugins.slots[params.slotKey];
}

type ResolveMemoryRoleSlotParams = {
  cfg: OpenClawConfig;
  role: MemoryPluginRole;
  agentId?: string;
  /** When true, also applies plugin enabled/deny/entry-disabled selection policy. */
  applySelectionPolicy?: boolean;
};

export function resolveMemoryRoleSlot(
  params: ResolveMemoryRoleSlotParams,
): string | null | undefined {
  const slot = resolvePluginSlot({
    cfg: params.cfg,
    slotKey: memoryRoleToSlotKey(params.role),
    agentId: params.agentId,
  });
  if (params.applySelectionPolicy !== true) {
    return slot;
  }
  return selectedMemoryRolePluginIdFromSlot({ cfg: params.cfg, slot });
}

export type MemoryRoleSlotSelection = {
  role: MemoryPluginRole;
  slotKey: MemoryPluginRoleSlotKey;
  pluginId: string;
  agentId?: string;
  disabled?: boolean;
};

function addMemoryRoleSlotSelection(
  selections: MemoryRoleSlotSelection[],
  params: {
    role: MemoryPluginRole;
    pluginId: string | null | undefined;
    agentId?: string;
  },
): void {
  const pluginId = typeof params.pluginId === "string" ? params.pluginId.trim() : "";
  if (!pluginId || pluginId.toLowerCase() === "none") {
    if (params.agentId) {
      selections.push({
        role: params.role,
        slotKey: memoryRoleToSlotKey(params.role),
        pluginId: "none",
        agentId: params.agentId,
        disabled: true,
      });
    }
    return;
  }
  selections.push({
    role: params.role,
    slotKey: memoryRoleToSlotKey(params.role),
    pluginId,
    ...(params.agentId ? { agentId: params.agentId } : {}),
  });
}

function addConfiguredMemoryRoleSlotSelections(
  selections: MemoryRoleSlotSelection[],
  params: {
    cfg: OpenClawConfig;
    slots: unknown;
    agentId?: string;
  },
): void {
  for (const role of MEMORY_PLUGIN_ROLES) {
    const slotKey = memoryRoleToSlotKey(role);
    const hasCanonicalSlot = hasOwnSlot(params.slots, slotKey);
    if (!hasCanonicalSlot) {
      continue;
    }
    addMemoryRoleSlotSelection(selections, {
      role,
      pluginId: resolveMemoryRoleSlot({
        cfg: params.cfg,
        role,
        agentId: params.agentId,
      }),
      agentId: params.agentId,
    });
  }
}

export function listConfiguredMemoryRoleSlotSelections(params: {
  cfg: OpenClawConfig;
}): MemoryRoleSlotSelection[] {
  const selections: MemoryRoleSlotSelection[] = [];
  addConfiguredMemoryRoleSlotSelections(selections, {
    cfg: params.cfg,
    slots: params.cfg.plugins?.slots,
  });
  for (const agent of listAgentEntries(params.cfg)) {
    const agentId = agent.id?.trim();
    if (!agentId || !agent.plugins?.slots) {
      continue;
    }
    addConfiguredMemoryRoleSlotSelections(selections, {
      cfg: params.cfg,
      slots: agent.plugins.slots,
      agentId,
    });
  }
  return selections;
}

export function listConfiguredMemoryRolePluginIds(params: { cfg: OpenClawConfig }): string[] {
  return [
    ...new Set(
      listConfiguredMemoryRoleSlotSelections(params)
        .filter((selection) => !selection.disabled)
        .map((selection) => selection.pluginId),
    ),
  ].toSorted((left, right) => left.localeCompare(right));
}

type NormalizedMemoryRoleSlots = {
  slots: Partial<Record<MemoryPluginRoleSlotKey, string | null | undefined>>;
};

function listNormalizedMemoryRoleSlotValues(
  plugins: NormalizedMemoryRoleSlots,
): (string | null | undefined)[] {
  return MEMORY_PLUGIN_ROLE_SLOT_KEYS.map((slotKey) => plugins.slots[slotKey]);
}

function listMemoryRoleSlotDecisionValues(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  includeConfiguredAgentSlots?: boolean;
  slotValues?: Iterable<string | null | undefined>;
  normalizedPlugins?: NormalizedMemoryRoleSlots;
}): (string | null | undefined)[] {
  return [
    ...new Set([
      ...(params.slotValues ??
        (params.normalizedPlugins
          ? listNormalizedMemoryRoleSlotValues(params.normalizedPlugins)
          : MEMORY_PLUGIN_ROLES.map((role) =>
              resolveMemoryRoleSlot({ cfg: params.cfg, agentId: params.agentId, role }),
            ))),
      ...(params.includeConfiguredAgentSlots
        ? listConfiguredMemoryRolePluginIds({ cfg: params.cfg })
        : []),
    ]),
  ];
}

type MemoryRoleLoadScope = {
  selectedMemoryRolePluginIds: ReadonlySet<string>;
  memorySlots: ReadonlyArray<string | null | undefined>;
  memorySlot: string | null | undefined;
};

export function resolveMemoryRoleLoadScope(params: {
  cfg: OpenClawConfig;
  selectionCfg?: OpenClawConfig;
  slotValues?: Iterable<string | null | undefined>;
  normalizedPlugins?: NormalizedMemoryRoleSlots;
}): MemoryRoleLoadScope {
  return {
    selectedMemoryRolePluginIds: new Set(
      listConfiguredMemoryRolePluginIds({ cfg: params.selectionCfg ?? params.cfg }),
    ),
    memorySlots: listMemoryRoleSlotDecisionValues({
      cfg: params.cfg,
      slotValues: params.slotValues,
      normalizedPlugins: params.normalizedPlugins,
      includeConfiguredAgentSlots: true,
    }),
    memorySlot: resolveMemoryRoleSlot({ cfg: params.cfg, role: "recall" }),
  };
}

type MemorySelectionRecord = {
  id: string;
  memorySlotSelected?: boolean;
  memoryRoleSelections?: MemoryRoleSlotSelection[];
};

export function applyMemoryRoleSelectionMetadata(params: {
  cfg: OpenClawConfig;
  record: MemorySelectionRecord;
}): void {
  params.record.memorySlotSelected = true;
  params.record.memoryRoleSelections = listConfiguredMemoryRoleSlotSelections({
    cfg: params.cfg,
  }).filter((selection) => selection.pluginId === params.record.id || selection.disabled);
}

function selectedMemoryRolePluginIdFromSlot(params: {
  cfg: OpenClawConfig;
  slot: string | null | undefined;
}): string | undefined {
  if (typeof params.slot !== "string") {
    return undefined;
  }
  const pluginId = params.slot.trim();
  if (!pluginId || pluginId.toLowerCase() === "none") {
    return undefined;
  }
  return isMemoryRoleSelectedSlotActivationAllowed({
    pluginId,
    config: normalizePluginsConfig(params.cfg.plugins),
  })
    ? pluginId
    : undefined;
}

export function resolveSelectedMemoryRolePluginId(params: {
  cfg: OpenClawConfig;
  role: MemoryPluginRole;
  agentId?: string;
}): string | undefined {
  return selectedMemoryRolePluginIdFromSlot({
    cfg: params.cfg,
    slot: resolveMemoryRoleSlot(params),
  });
}

export function listSelectedMemoryRolePluginIds(params: {
  cfg: OpenClawConfig;
  agentId?: string;
}): string[] {
  const ids = new Set<string>();
  for (const role of MEMORY_PLUGIN_ROLES) {
    const pluginId = resolveSelectedMemoryRolePluginId({ ...params, role });
    if (pluginId) {
      ids.add(pluginId);
    }
  }
  return [...ids].toSorted((left, right) => left.localeCompare(right));
}
