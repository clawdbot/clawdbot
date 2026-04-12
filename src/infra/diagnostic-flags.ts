import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";

const DIAGNOSTICS_ENV = "OPENCLAW_DIAGNOSTICS";

function parseEnvFlags(raw?: string): string[] {
  if (!raw) {
    return [];
  }
  const trimmed = raw.trim();
  const lowered = normalizeLowercaseStringOrEmpty(trimmed);
  if (!lowered) {
    return [];
  }
  if (["0", "false", "off", "none"].includes(lowered)) {
    return [];
  }
  if (["1", "true", "all", "*"].includes(lowered)) {
    return ["*"];
  }
  return trimmed
    .split(/[,\s]+/)
    .map((value) => normalizeLowercaseStringOrEmpty(value))
    .filter(Boolean);
}

function uniqueFlags(flags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const flag of flags) {
    const normalized = normalizeLowercaseStringOrEmpty(flag);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

export function resolveDiagnosticFlags(
  cfg?: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const configFlags = Array.isArray(cfg?.diagnostics?.flags) ? cfg?.diagnostics?.flags : [];
  const envFlags = parseEnvFlags(env[DIAGNOSTICS_ENV]);
  return uniqueFlags([...configFlags, ...envFlags]);
}

export function matchesDiagnosticFlag(flag: string, enabledFlags: string[]): boolean {
  const target = normalizeLowercaseStringOrEmpty(flag);
  if (!target) {
    return false;
  }
  for (const raw of enabledFlags) {
    const enabled = normalizeLowercaseStringOrEmpty(raw);
    if (!enabled) {
      continue;
    }
    if (enabled === "*" || enabled === "all") {
      return true;
    }
    if (enabled.endsWith(".*")) {
      const prefix = enabled.slice(0, -2);
      if (target === prefix || target.startsWith(`${prefix}.`)) {
        return true;
      }
    }
    if (enabled.endsWith("*")) {
      const prefix = enabled.slice(0, -1);
      if (target.startsWith(prefix)) {
        return true;
      }
    }
    if (enabled === target) {
      return true;
    }
  }
  return false;
}

export function isDiagnosticFlagEnabled(
  flag: string,
  cfg?: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const flags = resolveDiagnosticFlags(cfg, env);
  return matchesDiagnosticFlag(flag, flags);
}
