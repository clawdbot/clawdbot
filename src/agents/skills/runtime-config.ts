import { getRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { coerceSecretRef } from "../../config/types.secrets.js";

function hasConfiguredSkillApiKeyRef(config?: OpenClawConfig): boolean {
  const entries = config?.skills?.entries;
  if (!entries || typeof entries !== "object") {
    return false;
  }
  for (const skillConfig of Object.values(entries)) {
    if (!skillConfig || typeof skillConfig !== "object") {
      continue;
    }
    if (coerceSecretRef(skillConfig.apiKey) !== null) {
      return true;
    }
  }
  return false;
}

export function resolveSkillRuntimeConfig(config?: OpenClawConfig): OpenClawConfig | undefined {
  const runtimeConfig = getRuntimeConfigSnapshot();
  if (!runtimeConfig) {
    return config;
  }
  if (!config) {
    return runtimeConfig;
  }
  const runtimeHasRawSkillSecretRefs = hasConfiguredSkillApiKeyRef(runtimeConfig);
  const configHasRawSkillSecretRefs = hasConfiguredSkillApiKeyRef(config);
  if (runtimeHasRawSkillSecretRefs && !configHasRawSkillSecretRefs) {
    return config;
  }
  return runtimeConfig;
}
