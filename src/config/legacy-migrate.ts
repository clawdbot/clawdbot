import { applyLegacyMigrations } from "./legacy.js";
import type { MoltbotConfig } from "./types.js";
import { validateConfigObjectWithPlugins } from "./validation.js";

export function migrateLegacyConfig(raw: unknown): {
  config: MoltbotConfig | null;
  changes: string[];
} {
  const { next, changes } = applyLegacyMigrations(raw);
  if (!next) return { config: null, changes: [] };
  const validated = validateConfigObjectWithPlugins(next);
  if (!validated.ok) {
    changes.push("Migration applied, but config still invalid; fix remaining issues manually.");
    return { config: null, changes };
  }
  return { config: validated.config, changes };
}
