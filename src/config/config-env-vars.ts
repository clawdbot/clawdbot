// Defines environment-variable config metadata and preservation rules.
import {
  isDangerousHostEnvOverrideVarName,
  isDangerousHostEnvVarName,
  normalizeEnvVarKey,
} from "../infra/host-env-security.js";
import { containsEnvVarReference } from "./env-substitution.js";
import type { OpenClawConfig } from "./types.js";

function isBlockedConfigEnvVar(key: string): boolean {
  return isDangerousHostEnvVarName(key) || isDangerousHostEnvOverrideVarName(key);
}

function collectConfigEnvVarsByTarget(cfg?: OpenClawConfig): Record<string, string> {
  const envConfig = cfg?.env;
  if (!envConfig) {
    return {};
  }

  const entries: Record<string, string> = {};

  if (envConfig.vars) {
    for (const [rawKey, value] of Object.entries(envConfig.vars)) {
      if (typeof value !== "string" || !value.trim()) {
        continue;
      }
      const key = normalizeEnvVarKey(rawKey, { portable: true });
      if (!key) {
        continue;
      }
      if (isBlockedConfigEnvVar(key)) {
        continue;
      }
      if (containsEnvVarReference(value)) {
        continue;
      }
      entries[key] = value;
    }
  }

  for (const [rawKey, value] of Object.entries(envConfig)) {
    if (rawKey === "shellEnv" || rawKey === "vars") {
      continue;
    }
    if (typeof value !== "string" || !value.trim()) {
      continue;
    }
    const key = normalizeEnvVarKey(rawKey, { portable: true });
    if (!key) {
      continue;
    }
    if (isBlockedConfigEnvVar(key)) {
      continue;
    }
    if (containsEnvVarReference(value)) {
      continue;
    }
    entries[key] = value;
  }

  return entries;
}

/** Collects config env vars safe to inject into runtime process environments. */
export function collectConfigRuntimeEnvVars(cfg?: OpenClawConfig): Record<string, string> {
  return collectConfigEnvVarsByTarget(cfg);
}

/** Collects config env vars safe to persist into managed service environments. */
export function collectConfigServiceEnvVars(cfg?: OpenClawConfig): Record<string, string> {
  // Runtime and service envs intentionally share filtering until a target-specific contract exists.
  return collectConfigEnvVarsByTarget(cfg);
}

/** Builds a cloned environment with config env vars applied without mutating the base env. */
export function createConfigRuntimeEnv(
  cfg: OpenClawConfig,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = { ...baseEnv };
  applyConfigEnvVars(cfg, env);
  return env;
}

/** Applies config env vars to an environment without overwriting existing non-empty values. */
export function applyConfigEnvVars(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const entries = collectConfigRuntimeEnvVars(cfg);
  for (const [key, value] of Object.entries(entries)) {
    if (env[key]?.trim()) {
      continue;
    }
    // Skip values containing unresolved ${VAR} references — applyConfigEnvVars runs
    // before env substitution, so these would pollute process.env with literal placeholders
    // (e.g. process.env.OPENCLAW_GATEWAY_TOKEN = "${VAULT_TOKEN}") which downstream auth
    // resolution would accept as valid credentials.
    if (containsEnvVarReference(value)) {
      continue;
    }
    env[key] = value;
  }
}
