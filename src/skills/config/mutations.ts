// Skill config mutation helpers update persisted skill settings through config retries.
import { mutateConfigFileWithRetry } from "../../config/config.js";
import { REDACTED_SENTINEL } from "../../config/redact-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeSecretInput } from "../../utils/normalize-secret-input.js";

export function patchSkillConfigEntry(
  cfg: OpenClawConfig,
  skillKey: string,
  patch: { enabled?: boolean; apiKey?: string; env?: Record<string, string> },
): OpenClawConfig {
  const entries = { ...cfg.skills?.entries };
  const current = entries[skillKey] ? { ...entries[skillKey] } : {};
  if (typeof patch.enabled === "boolean") {
    current.enabled = patch.enabled;
  }
  if (typeof patch.apiKey === "string") {
    const trimmed = normalizeSecretInput(patch.apiKey);
    if (trimmed === REDACTED_SENTINEL) {
      // Keep the stored secret when a client round-trips a redacted response value.
    } else if (trimmed) {
      current.apiKey = trimmed;
    } else {
      delete current.apiKey;
    }
  }
  if (patch.env && typeof patch.env === "object") {
    const nextEnv = current.env ? { ...current.env } : {};
    for (const [key, value] of Object.entries(patch.env)) {
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
  entries[skillKey] = current;
  return {
    ...cfg,
    skills: {
      ...cfg.skills,
      entries,
    },
  };
}

export async function updateSkillConfigEntry(params: {
  skillKey: string;
  enabled?: boolean;
  apiKey?: string;
  env?: Record<string, string>;
}): Promise<Record<string, unknown>> {
  const committed = await mutateConfigFileWithRetry<Record<string, unknown>>({
    afterWrite: { mode: "auto" },
    mutate: (draft) => {
      const next = patchSkillConfigEntry(draft, params.skillKey, params);
      Object.assign(draft, next);
      return next.skills?.entries?.[params.skillKey] ?? {};
    },
  });
  return committed.result ?? {};
}
