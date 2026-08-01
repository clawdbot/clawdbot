import { sanitizeForLog } from "../../../../packages/terminal-core/src/ansi.js";
import {
  formatLegacyMemorySlotMigrationChange,
  migrateLegacyMemorySlotsInPlace,
  scanLegacyMemorySlotConfig,
  type LegacyMemorySlotHit,
} from "../../../config/legacy-memory-slot.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";

export { scanLegacyMemorySlotConfig };

export function collectLegacyMemorySlotWarnings(params: {
  hits: readonly LegacyMemorySlotHit[];
  doctorFixCommand: string;
}): string[] {
  if (params.hits.length === 0) {
    return [];
  }
  const sample = sanitizeForLog(params.hits[0]?.pathLabel ?? "plugins.slots.memory");
  const warnings = [
    `- Found ${params.hits.length} legacy memory slot selector${params.hits.length === 1 ? "" : "s"} (for example ${sample}).`,
    '- `plugins.slots.memory` is removed from runtime routing; use `plugins.slots["memory.recall"]` for factual recall provider selection.',
    "- Doctor migrates legacy-only selectors to memory.recall, removes the old memory key, and preserves an existing canonical memory.recall value when both are present.",
    `- Run "${params.doctorFixCommand}" before normal runtime to migrate/remove ${params.hits.length} legacy memory slot${params.hits.length === 1 ? "" : "s"}.`,
  ];
  return warnings;
}

export function maybeRepairLegacyMemorySlotConfig(cfg: OpenClawConfig): {
  config: OpenClawConfig;
  changes: string[];
  warnings?: string[];
} {
  if (scanLegacyMemorySlotConfig(cfg).length === 0) {
    return { config: cfg, changes: [] };
  }

  const next = structuredClone(cfg);
  const changes = migrateLegacyMemorySlotsInPlace(next).map((mutation) =>
    formatLegacyMemorySlotMigrationChange(mutation, "doctor"),
  );

  return {
    config: changes.length > 0 ? next : cfg,
    changes: changes.map((change) => sanitizeForLog(change)),
  };
}
