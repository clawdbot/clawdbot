import { normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import {
  defaultSlotIdForKey,
  resolveSlotSelection,
} from "../../../../../src/plugins/slot-defaults.ts";

export type DreamingConfigResolution = {
  pluginId: string;
  enabled: boolean;
  overridden: boolean;
  engineOff: boolean;
};

function normalizeTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function findConfiguredAgentEntry(
  configValue: Record<string, unknown> | null,
  agentId: string,
): Record<string, unknown> | null {
  const agents = asRecord(configValue?.agents);
  if (!agents) {
    return null;
  }
  const normalizedAgentId = normalizeAgentId(agentId);
  const entries = asRecord(agents.entries);
  if (entries) {
    const entryKey = Object.keys(entries).find(
      (key) => normalizeAgentId(key) === normalizedAgentId,
    );
    return entryKey ? asRecord(entries[entryKey]) : null;
  }
  const list = Array.isArray(agents.list) ? agents.list : [];
  return (
    list
      .map((entry) => asRecord(entry))
      .find((entry) => normalizeAgentId(normalizeTrimmedString(entry?.id)) === normalizedAgentId) ??
    null
  );
}

function resolveConfiguredSlotValue(
  configValue: Record<string, unknown> | null,
  slotKey: "memory.dreaming" | "memory.recall",
  agentId?: string | null,
): { configured: boolean; value: unknown } {
  const globalSlots = asRecord(asRecord(configValue?.plugins)?.slots);
  if (agentId) {
    const agentSlots = asRecord(
      asRecord(findConfiguredAgentEntry(configValue, agentId)?.plugins)?.slots,
    );
    if (agentSlots && Object.hasOwn(agentSlots, slotKey)) {
      return { configured: true, value: agentSlots[slotKey] };
    }
  }
  return globalSlots && Object.hasOwn(globalSlots, slotKey)
    ? { configured: true, value: globalSlots[slotKey] }
    : { configured: false, value: undefined };
}

export function resolveConfiguredDreamingFromConfig(
  configValue: Record<string, unknown> | null,
  options: { agentId?: string | null } = {},
): DreamingConfigResolution {
  const dreamingSlot = resolveConfiguredSlotValue(configValue, "memory.dreaming", options.agentId);
  let pluginId = defaultSlotIdForKey("memory.recall");
  let disabledBySlot = false;
  if (dreamingSlot.configured) {
    const selection = resolveSlotSelection("memory.dreaming", dreamingSlot.value);
    if (selection.kind === "off") {
      disabledBySlot = true;
    } else {
      pluginId = selection.pluginId;
    }
  } else {
    const recallSlot = resolveConfiguredSlotValue(configValue, "memory.recall", options.agentId);
    if (recallSlot.configured) {
      const selection = resolveSlotSelection("memory.recall", recallSlot.value);
      if (selection.kind !== "off") {
        pluginId = selection.pluginId;
      }
    }
  }
  const entries = asRecord(asRecord(configValue?.plugins)?.entries);
  const dreaming = asRecord(asRecord(asRecord(entries?.[pluginId])?.config)?.dreaming);
  return {
    pluginId,
    enabled: !disabledBySlot && dreaming?.enabled !== false,
    overridden: typeof dreaming?.enabled === "boolean",
    engineOff: disabledBySlot,
  };
}
