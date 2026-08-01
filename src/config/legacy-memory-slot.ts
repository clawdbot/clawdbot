// Shared scanner and mutator for legacy memory plugin slot compatibility.
import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";

export type LegacyMemorySlotHit = {
  location:
    | { scope: "root" }
    | { scope: "agent"; roster: "entries"; key: string }
    | { scope: "agent"; roster: "list"; index: number };
  pathLabel: string;
  legacyValue: string;
  recallValue?: string;
  conflict: boolean;
};

type LegacyMemorySlotMigrationResult =
  | "migrated"
  | "removed-redundant"
  | "removed-conflicting"
  | "removed-empty"
  | "unchanged";

type LegacyMemorySlotMutation = {
  hit: LegacyMemorySlotHit;
  result: Exclude<LegacyMemorySlotMigrationResult, "unchanged">;
};

type LegacyMemorySlotSurface = {
  location: LegacyMemorySlotHit["location"];
  pathLabel: string;
  slots: Record<string, unknown>;
};

function ownSlot(slots: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(slots, key);
}

function normalizeSlotText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function collectSlotHit(params: {
  location: LegacyMemorySlotHit["location"];
  slots: Record<string, unknown>;
  pathLabel: string;
}): LegacyMemorySlotHit | undefined {
  if (!ownSlot(params.slots, "memory")) {
    return undefined;
  }
  const legacyValue = normalizeSlotText(params.slots.memory);
  if (!legacyValue) {
    return {
      location: params.location,
      pathLabel: `${params.pathLabel}.memory`,
      legacyValue: "",
      conflict: false,
    };
  }
  const recallValue = ownSlot(params.slots, "memory.recall")
    ? (normalizeSlotText(params.slots["memory.recall"]) ?? "")
    : undefined;
  return {
    location: params.location,
    pathLabel: `${params.pathLabel}.memory`,
    legacyValue,
    recallValue,
    conflict: recallValue !== undefined && recallValue !== legacyValue,
  };
}

function pluginSlots(host: unknown): Record<string, unknown> | null {
  return asRecord(asRecord(asRecord(host)?.plugins)?.slots);
}

function visitLegacyMemorySlotSurfaces(
  cfg: unknown,
  visitor: (surface: LegacyMemorySlotSurface) => void,
): void {
  const root = asRecord(cfg);
  if (!root) {
    return;
  }

  const visit = (
    location: LegacyMemorySlotHit["location"],
    pathLabel: string,
    slots: Record<string, unknown>,
  ) => {
    visitor({ location, pathLabel, slots });
  };

  const globalSlots = pluginSlots(root);
  if (globalSlots) {
    visit({ scope: "root" }, "plugins.slots", globalSlots);
  }

  const agents = asRecord(root.agents);
  if (!agents) {
    return;
  }
  if (Object.hasOwn(agents, "entries")) {
    const entries = asRecord(agents.entries);
    if (!entries) {
      return;
    }
    for (const [key, entry] of Object.entries(entries)) {
      const slots = pluginSlots(entry);
      if (slots) {
        visit(
          { scope: "agent", roster: "entries", key },
          `agents.entries.${key}.plugins.slots`,
          slots,
        );
      }
    }
    return;
  }
  if (!Array.isArray(agents.list)) {
    return;
  }
  for (const [index, agent] of agents.list.entries()) {
    const slots = pluginSlots(agent);
    if (slots) {
      visit({ scope: "agent", roster: "list", index }, `agents.list.${index}.plugins.slots`, slots);
    }
  }
}

/**
 * Find authored legacy memory slot selectors. If keyed `agents.entries` is present,
 * it is authoritative and `agents.list` is treated as a materialized alias, so this
 * scanner does not double-report or double-mutate both shapes.
 */
export function scanLegacyMemorySlotConfig(cfg: unknown): LegacyMemorySlotHit[] {
  const hits: LegacyMemorySlotHit[] = [];
  visitLegacyMemorySlotSurfaces(cfg, (surface) => {
    const hit = collectSlotHit(surface);
    if (hit) {
      hits.push(hit);
    }
  });
  return hits;
}

function migrateSlots(params: {
  slots: Record<string, unknown>;
  hit: LegacyMemorySlotHit;
}): LegacyMemorySlotMigrationResult {
  if (!ownSlot(params.slots, "memory")) {
    return "unchanged";
  }
  if (params.hit.legacyValue) {
    if (params.hit.recallValue !== undefined && params.hit.recallValue !== params.hit.legacyValue) {
      delete params.slots.memory;
      return "removed-conflicting";
    }
    if (params.hit.recallValue === params.hit.legacyValue) {
      delete params.slots.memory;
      return "removed-redundant";
    }
    params.slots["memory.recall"] = params.hit.legacyValue;
    delete params.slots.memory;
    return "migrated";
  }
  delete params.slots.memory;
  return "removed-empty";
}

/** Mutates `raw` in place, applying the same legacy-slot policy used by Doctor. */
export function migrateLegacyMemorySlotsInPlace(raw: unknown): LegacyMemorySlotMutation[] {
  const mutations: LegacyMemorySlotMutation[] = [];
  visitLegacyMemorySlotSurfaces(raw, (surface) => {
    const hit = collectSlotHit(surface);
    if (!hit) {
      return;
    }
    const result = migrateSlots({ slots: surface.slots, hit });
    if (result !== "unchanged") {
      mutations.push({ hit, result });
    }
  });
  return mutations;
}

export function formatLegacyMemorySlotMigrationChange(
  mutation: LegacyMemorySlotMutation,
  format: "doctor" | "migration",
): string {
  const { hit } = mutation;
  if (format === "doctor") {
    if (mutation.result === "migrated") {
      return `- ${hit.pathLabel}: moved legacy memory slot to memory.recall (${hit.legacyValue}) and removed the legacy selector.`;
    }
    if (mutation.result === "removed-redundant") {
      return `- ${hit.pathLabel}: removed redundant legacy memory slot selector already covered by memory.recall (${hit.legacyValue}).`;
    }
    if (mutation.result === "removed-conflicting") {
      return `- ${hit.pathLabel}: removed legacy memory slot selector (${hit.legacyValue}) and preserved existing memory.recall (${hit.recallValue}).`;
    }
    return `- ${hit.pathLabel}: removed empty legacy memory slot selector.`;
  }
  if (mutation.result === "migrated") {
    return hit.location.scope === "root"
      ? 'Moved plugins.slots.memory → plugins.slots["memory.recall"].'
      : `Moved ${hit.pathLabel} → memory.recall.`;
  }
  if (mutation.result === "removed-conflicting") {
    return hit.location.scope === "root"
      ? 'Removed plugins.slots.memory; plugins.slots["memory.recall"] is already set.'
      : `Removed ${hit.pathLabel}; same-scope memory.recall is already set.`;
  }
  if (mutation.result === "removed-redundant") {
    return hit.location.scope === "root"
      ? 'Removed plugins.slots.memory; plugins.slots["memory.recall"] is already set.'
      : `Removed redundant ${hit.pathLabel}; same-scope memory.recall is already set.`;
  }
  return hit.location.scope === "root"
    ? "Removed plugins.slots.memory."
    : `Removed ${hit.pathLabel}.`;
}
