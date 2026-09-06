import type { JsonSchema } from "../../lib/config-form-utils.ts";

export const SETUP_CONSENT_DEFAULTS = { accessMode: "full", appRecommendations: true } as const;
export const SETUP_HISTORY_KEYS = [
  "lastRunAt",
  "lastRunVersion",
  "lastRunCommit",
  "lastRunCommand",
  "lastRunMode",
] as const;

// Search and the curated view expose the same fields. Projection never changes
// the draft: onboarding-owned acknowledgement/model state must survive edits.
export function setupVisibleSchema(schema: JsonSchema): JsonSchema {
  return {
    ...schema,
    properties: Object.fromEntries(
      Object.entries(schema.properties ?? {}).filter(
        ([key]) =>
          Object.hasOwn(SETUP_CONSENT_DEFAULTS, key) ||
          SETUP_HISTORY_KEYS.some((historyKey) => historyKey === key),
      ),
    ),
  };
}
