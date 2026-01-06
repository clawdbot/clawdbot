import {
  applyIdentityDefaults,
  applyModelDefaults,
  applySessionDefaults,
} from "./defaults.js";
import { findLegacyConfigIssues } from "./legacy.js";
import type { ClawdbotConfig, ConfigValidationIssue } from "./types.js";
import { ClawdbotSchema } from "./zod-schema.js";

export function validateConfigObject(
  raw: unknown,
):
  | { ok: true; config: ClawdbotConfig }
  | { ok: false; issues: ConfigValidationIssue[] } {
  const legacyIssues = findLegacyConfigIssues(raw);
  if (legacyIssues.length > 0) {
    return {
      ok: false,
      issues: legacyIssues.map((iss) => ({
        path: iss.path,
        message: iss.message,
      })),
    };
  }
  const validated = ClawdbotSchema.safeParse(raw);
  if (!validated.success) {
    return {
      ok: false,
      issues: validated.error.issues.map((iss) => ({
        path: iss.path.join("."),
        message: iss.message,
      })),
    };
  }
  return {
    ok: true,
    config: applyModelDefaults(
      applySessionDefaults(
        applyIdentityDefaults(validated.data as ClawdbotConfig),
      ),
    ),
  };
}
