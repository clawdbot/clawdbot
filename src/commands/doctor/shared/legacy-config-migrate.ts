// Validating legacy config migration wrapper used by doctor config flow.
import type { OpenClawConfig } from "../../../config/types.js";
import { validateConfigObjectWithPlugins } from "../../../config/validation.js";
import { applyLegacyDoctorMigrations } from "./legacy-config-compat.js";

/** Apply legacy migrations and validate the resulting OpenClaw config shape when possible. */
export function migrateLegacyConfig(raw: unknown): {
  config: OpenClawConfig | null;
  sourceConfig?: OpenClawConfig;
  changes: string[];
  partiallyValid?: boolean;
} {
  const { next, changes } = applyLegacyDoctorMigrations(raw);
  if (!next) {
    return { config: null, changes: [] };
  }
  const validated = validateConfigObjectWithPlugins(next);
  if (!validated.ok) {
    changes.push("Migration applied; other validation issues remain — run doctor to review.");
    return { config: next as OpenClawConfig, changes, partiallyValid: true };
  }
  return { config: validated.config, sourceConfig: next as OpenClawConfig, changes };
}
