import { mutateConfigFileWithRetry } from "../../config/config.js";
import { REDACTED_SENTINEL } from "../../config/redact-snapshot.js";
import { normalizeSecretInput } from "../../utils/normalize-secret-input.js";

export async function updateSkillConfigEntry(params: {
  skillKey: string;
  enabled?: boolean;
  apiKey?: string;
  env?: Record<string, string>;
}): Promise<Record<string, unknown>> {
  const committed = await mutateConfigFileWithRetry<Record<string, unknown>>({
    afterWrite: { mode: "auto" },
    mutate: (draft) => {
      const skills = draft.skills ? { ...draft.skills } : {};
      const entries = skills.entries ? { ...skills.entries } : {};
      const current = entries[params.skillKey] ? { ...entries[params.skillKey] } : {};
      if (typeof params.enabled === "boolean") {
        current.enabled = params.enabled;
      }
      if (typeof params.apiKey === "string") {
        const trimmed = normalizeSecretInput(params.apiKey);
        if (trimmed === REDACTED_SENTINEL) {
          // Keep the stored secret when a client round-trips a redacted response value.
        } else if (trimmed) {
          current.apiKey = trimmed;
        } else {
          delete current.apiKey;
        }
      }
      if (params.env && typeof params.env === "object") {
        const nextEnv = current.env ? { ...current.env } : {};
        for (const [key, value] of Object.entries(params.env)) {
          const trimmedKey = key.trim();
          if (!trimmedKey) {
            continue;
          }
          const trimmedVal = value.trim();
          if (trimmedVal === REDACTED_SENTINEL) {
            continue;
          }
          if (!trimmedVal) {
            delete nextEnv[trimmedKey];
          } else {
            nextEnv[trimmedKey] = trimmedVal;
          }
        }
        current.env = nextEnv;
      }
      entries[params.skillKey] = current;
      skills.entries = entries;
      draft.skills = skills;
      return current;
    },
  });
  return committed.result ?? {};
}
