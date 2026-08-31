import { applyLegacyDoctorMigrations } from "../../../commands/doctor/shared/legacy-config-compat.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { validateConfigObject } from "../../../config/validation.js";

/**
 * Apply the same compatibility owner as CLI startup without writing the
 * launcher-bound config. The test gateway consumes the validated projection;
 * the original tracked bytes remain available for independent attestation.
 */
export function prepareReturnCovenantGatewayConfig(raw: unknown): OpenClawConfig {
  const migration = applyLegacyDoctorMigrations(raw, undefined, {
    pluginContracts: false,
  });
  const validated = validateConfigObject(migration.next ?? raw, {
    sourceRaw: raw,
  });
  if (!validated.ok) {
    const details = validated.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
    throw new Error(`return-covenant gateway config is invalid: ${details}`);
  }
  return validated.config;
}
